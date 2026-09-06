# State of the project

The four-milestone plan is finished, and M5 has since inverted the verifier's routing so the
headline property actually closes. This document is the one-page answer to "what is this,
what has it been measured to do, what does it deliberately not do, and what would come next".
Everything in it is measured; where a number is an upper bound it says so, and every claim
points at the report that carries the evidence.

Read [`README.md`](../README.md) first for the model — it is the normative description of the
net. This document is about the *state*, not the design.

---

## What exists

One npm package, `typescript/`, multi-entry ESM, plus a pinned n8n clone and two patches.

| Piece | Entry | What it is |
|---|---|---|
| Compiler | `n8n-libpetri/compiler` | `compile(description)` → one libpetri Coloured Time Petri Net, a cached `PrecompiledNet`, a `NetMap` (transition ↔ node, place ↔ (node, port)), the initial marking, the effective budget and diagnostics. No n8n dependency: it takes a structural description. |
| Scheduler | `n8n-libpetri` | `PetriScheduler`, a drop-in `WorkflowScheduler` for n8n's execution engine, plus `registerPetriScheduler`. The action runs the node and routes the result; there is no host-side dispatch queue. |
| Marking codec | `n8n-libpetri` (`codec.ts`) | `decodeExecutionData` / `encodeMarking`: a saved `IRunExecutionData` ↔ a marking, for Wait nodes, destination stops, halts and cancellation. |
| Verifier | `n8n-libpetri/verify` | `verify(workflow)` and the `n8n-libpetri verify` CLI: six property families over `compile(workflow).net` — the same net the scheduler executes. Primary route is libpetri's solver-free state-class graph (VER-010), one per report; the `SmtVerifier` (IC3/PDR through z3) is the fallback where the graph truncates. |
| Conformance harness | `n8n-libpetri/conformance` | junit reader, loop-driving classifier, matrix/report, the differential harness and a faithful port of n8n's own loop to differ against. |
| n8n integration | `patches/n8n/`, `scripts/` | `0001-extract-scheduler-loop` (n8n's `executionLoop` moved verbatim behind a `WorkflowScheduler` interface) and `0002-scheduler-registry` (`setWorkflowSchedulerFactory`). Both rebasable and upstream-quality; `scripts/verify-patch.sh` fails on drift. n8n itself is never committed here. |

Pinned n8n commit `441970b`. Gates: `npm run check`, `npm test`, `npm run build`,
`scripts/verify-patch.sh`.

---

## What it is measured to do

### Conformance against n8n's own suite

`scripts/run-conformance.sh --scope=execution-engine|core|workflow|cli|all` runs n8n's tests
twice — once with n8n's own loop behind the seam (`legacy`), once with the net (`libpetri`) —
and compares both to an unpatched baseline. Full matrix and method:
[`docs/conformance-final.md`](conformance-final.md), with the earlier per-milestone reports in
[`conformance-m2.md`](conformance-m2.md) and [`conformance-m3.md`](conformance-m3.md).

| scope | cases | legacy | libpetri k = 1 | k = 2 |
|---|---|---|---|---|
| execution-engine | 1657 | 44/44 loop-driving, 1613/1613 helpers — *identical* to the unpatched baseline | 35/44, 1611/1613, **11 regressions** | 32/44, 1611/1613, **3 regressions against k = 1** |
| core (whole `packages/core`) | 2124 | 44/44, 2080/2080 — identical | 35/44, 2078/2080, the *same* 11 regressions | — |
| workflow (whole `packages/workflow`) | 9603 | same case set and status multisets as the baseline | not applicable — the package never constructs a scheduler | — |
| cli (`packages/cli` unit suite) | 20328 | identical to the baseline | 20328/20328, 0 regressions — engine **registered and never entered** | — |

Two things that matter more than the totals:

- **Registered is not entered.** The registered factory emits a diagnostic the first time n8n
  actually constructs a scheduler through it, and the script counts the test *files* that did.
  The engine is entered in **5 of the 75** execution-engine files — the five `packages/core`
  files that call `WorkflowExecute.run()` / `processRunExecutionData` — and in **0 of the 1104**
  `packages/cli` files. So `cli` and `workflow` are *patch-neutrality* legs (29 931 further
  cases that must not change around the seam), not engine results, and the report says so.
- **The 11 regressions contain no defect.** Eight are the AI-agent `EngineRequest` /
  `EngineResponse` tool dispatch, declared out of scope in M2; the other three are registered
  divergences (#2, #11, #12). Widening the scope from 1657 to 32 055 cases found no new failure
  anywhere.

The legacy leg being byte-identical to the unpatched baseline in every scope is the statement
that the patched seam is a pure refactor.

### Differential harness

A faithful port of n8n's `stack-scheduler` loop runs each fixture under the *same host* as the
net, and the two are compared on data (per `(node, runIndex)`: payloads, source, status,
metadata, error, plus the resumable state and the scheduler contract), on happens-before, and
on ordering, where every moved activation must be attributed to a numbered divergence row.
23 fixtures × k ∈ {1, 2, 4} = 69 runs: **49 pass, 20 divergent, 0 fail, 0 unattributed, 0 novel
mechanisms**. [`docs/differential.md`](differential.md).

### Concurrency benchmark

`npm run bench`. Numbers are upper bounds (measured at load average ~4; the *ratios* reproduce
under load, the absolutes inflate 3–5×).

- Fan-out of *width* × 500 ms nodes is `ceil(width / k) × 500 ms` in every cell: two independent
  500 ms branches take **1006 ms under n8n and 507 ms under the net at k ≥ 2**. That is the claim
  the project exists for.
- A deep 8 × 500 ms chain, where there is no parallelism to win, is within **0.2 %** at every
  budget: raising `k` costs nothing when there is nothing to gain.
- Scheduling overhead over n8n's own loop on a 100-node chain of 0 ms actions: **≈ 16 µs per
  node** warm (≈ 79 µs if every execution recompiles), against 80 ms for an HTTP node. That is
  the number behind "the win is concurrency, not scheduler speed" — and the reason a Rust
  backend would buy nothing.
- A 185-node workflow compiles in **under 9 ms**, then caches on its structural hash.

### Data equivalence above k = 1

For every workflow the compiler leaves above k = 1, the `IRunExecutionData` at k ∈ {1, 2, 4, 8}
is identical — payloads, `pairedItem`, `source`, `executionStatus`, `metadata`, error shape, the
resumable state and the scheduler contract. Only *ordering* moves, and every field that can move
has a register row. Measured three ways (n8n's suite per budget, the differ, and
`tests/conformance/budget-equivalence.test.ts` as a committed gate). The one exception is a
*halting* execution, where nodes already in flight still finish (divergence #17).

### Verification

`verify(workflow)` runs six property families over the compiled net. Since **M5** the primary
decision procedure is solver-free: libpetri's state-class graph (VER-010), enumerated once per
report, with the SMT encoding kept as the fallback for a graph that truncates — the order NU-053
prescribes, and the inverse of M4's. What it is measured to do:
[`docs/verification.md`](verification.md); the design and its limits:
[ADR 0007](adr/0007-verification.md).

**Closes, on any workflow whose state-class graph closes** — every acyclic fixture, a 41-node
chain, an 8-wide fan-out, a 21-node five-diamond workflow, at the default budget of 1 (the
budget is a real cost axis: the same 41-node chain is 31 448 classes at k = 2 and truncates at
k = 4):

- **proper completion**, the headline question — *can this workflow strand a branch?* —
  `proven` in 1–111 ms on the fixtures here (4 to 41 nodes) and in 2.2 s on a 21-node
  five-diamond workflow, or `violated` with the stranded node and input and the firing
  sequence that reaches the stuck marking. M4 measured this
  `unknown` at 30 s, 60 s *and* 600 s, on a workflow with a stranding and on one without; that
  is the one claim of the project that has changed since M4. On `ifBothOutputs` it comes back
  `violated` in 25 ms and names `Merge/ready_0` — the already-registered divergence #2;
- **dead nodes** — every node of the workflow decided in the one graph pass; a node no
  execution can reach is reported by name. A real class of n8n bug (an all-required Merge with
  an unwired input, a branch left disconnected on the canvas);
- the **structural family** — the budget bound and its two-phase P-semiflow, the per-node
  `X/running` mutex, the retry bound (both halves), the join-slot discipline, and the OR-round
  arrival bound that M4 could not decide (divergence #8's query);
- **mutual exclusion**, `--all-pairs` included: one pass over the classes covers every pair, so
  210 pairs at 21 nodes cost what one pair costs.

**Does not close — and says exactly how far it got.** Two shapes truncate the graph, and they
get different answers because different things are true of them:

- a workflow with a **cycle** has an unbounded state space, so no class cap can complete the
  graph and `proven` is out of reach at every cap. What the explored prefix *does* close is a
  whole number of **runs of the workflow's cyclic nodes**, exactly, and that is the fourth
  verdict: **`bounded`** — *no branch strands in any run where this workflow's cyclic nodes run
  at most `k` times*. Measured, `k = 21` on `loopOverItems` (a two-node loop, so at least ten
  complete passes of the body) and `k = 135` on a plain user cycle at the default 200 000-class
  cap; raising the cap raises `k`. It is sound, it is not a proof, it is counted apart from the
  proofs and `--strict` fails on it. A stranding found inside the prefix is still a full
  finding — truncation costs the proof, not the detection;
- **heavy independent parallelism** blows the class count up combinatorially (the graph has no
  partial-order reduction, NU-053). There is nothing to count, so the answer is `unknown` with
  the cap, the classes explored and the cause. Nothing borrows the cyclic case's bound. The
  cause is reported from evidence: a cap set below what an unbranched workflow needs is
  reported as a cap, not as parallelism it does not have.

Nor does **liveness** close, and it is reported `unknown` by design because a reached node is
reached in a priority- and value-blind abstraction (VER-004) — the route now finds that witness
instantly, and the verdict is the same, because the reason was never the solver.

The **SMT fallback** was measured rather than assumed, and it splits: the *proper-completion*
fallback (one whole-net `deadlockFree` with the structural rest set as sinks) decides nothing —
nought for ten at 30 s — while the *bound* fallbacks decide plenty, proving 23 of `switch20`'s
24 checks where the graph truncated. The document says both, rather than keeping a decorative
query or dropping a working one. The proper-completion query is now not even *asked* where the
graph has already refuted it: VER-002's condition is *quiescent ∧ some marked place is not a
declared sink*, so one reachable paused marking holding an arrival makes it false on that net
and its `proven` unreachable.

The size wall moved and changed character. M4's was libpetri's P-invariant enumeration, which
exhausted a 4 GB heap at 49 nodes and was re-paid per query; M5 pays it once, lazily, and only
for the budget semiflow, so a 41-node workflow verifies end to end. Because a heap exhaustion
**aborts the process** rather than returning an `unknown`, the SMT route is also refused
outright above a measured size (12 join inputs or 450 flat places, `--smt-fallback force` to
override): those rows come back `unknown` naming the ceiling, and everything the graph decides
is unaffected. The new limit is the class count, and it is about **shape**, at k = 1: depth is
nearly free (2048 classes at 41 nodes), independent width is not (6151 at 9 nodes), a cycle is
unbounded — and the budget is a third axis (the same 41-node chain is 31 448 classes at k = 2
and truncates at k = 4).

Every one of those limits is pinned by a test — including, at three caps on both truncating
fixtures, that a **false `proven` is impossible** — so an improvement in libpetri breaks the
suite and forces the document to be re-measured. The CLI exits **3** when no usable z3 resolved
and the solver-backed part of the run was skipped; a finding outranks it, because the
solver-free route decides without z3 and a missing tool must never mask a defect.

---

## What it deliberately does not do

[`docs/divergences.md`](divergences.md) is the register: 21 rows, each classified *abandoned*
(n8n's behaviour is an artifact of its loop and is not reproduced), *replaced* (the net answers
the same question differently), *positional* (the same activations, a different order or index),
or *out of scope*. Nineteen are `designed` — observed and deliberate — one (#18) is `proposed`
because no harness here can measure it, and one (#20) is `fixed`. In prose:

- **n8n's total execution order is not reproduced above k = 1, by design** (#21, #5). That is the
  point: two branches with no dependency either way run at once, so `executionIndex` records the
  order nodes *started*. At k = 1 the net is n8n-sequential, and since M4's model change it is
  depth-first again, which n8n's own `depth-first & the most top-left one first` case pins.
- **The execution-global fields n8n's loop owns become properties of completion order** above
  k = 1: `lastNodeExecuted` (#16), `waitTill` (#15), `executionError` (#19) — the last of which
  is split into a write-once halt error and a completion-ordered leftover, so a sibling's caught
  error can never erase a halt the net already took.
- **A failure no longer suppresses a ready sibling** above k = 1 (#17). The net cannot un-start
  an action, so a node already in flight when the execution halts finishes and is recorded. This
  is the one k > 1 behaviour change a user can see: a `responseMode: responseNode` webhook answers
  the caller where n8n's `break` would have left it unanswered. Keep k = 1 where a failure must
  suppress a sibling, and where dynamically-resolved credentials are used (#18).
- **n8n's stuck-join fallback is gone, cause and all** (#1, #2). Explicit empty tokens make an
  AND-join always complete in the acyclic case, so the partial-fire heuristic has nothing to fire
  on. Where a token really is stranded, it is reported as a stranding rather than papered over.
- **Arrival order within one input is FIFO, where n8n's is LIFO** (#11): n8n `unshift`s onto a
  stack it `shift`s from, so the most recent arrival runs first. The node runs the same number of
  times with the same payloads; which `runIndex` holds which is reversed.
- **v0 workflows are not handled** (#3): they route to the injected legacy scheduler. So does
  anything else the net declines.
- **The AI-agent `EngineRequest` / `EngineResponse` tool protocol is not implemented**: such a
  node fails with an explicit `NodeOperationError` naming the limitation rather than behaving
  unpredictably. Eight of the 11 conformance regressions are this.
- **The verifier claims nothing about order, values or timing.** The SMT encoding models none of
  them, so no ordering row of the register is provable there — the ordering claims rest on the
  differ, not on the solver.

---

## Honest next steps

**1. n8n's workflow JSON cannot express what the net can, and that is the blocker.** The engine
is strictly more expressive than the format that feeds it. A net can carry guards, real cycles
with bounded iteration tokens, a declared concurrency budget, and correlation ids (libpetri's
ν-lineage) that pair a fork with its join by identity rather than by position. n8n's JSON has
nodes, typed connections and per-node parameters — and nothing to say any of that. So today:

- the budget is a *registration* parameter, not a workflow property, and the compiler silently
  lowers it on a workflow it cannot prove k-safe;
- a guard is a node (an IF), which means a routing decision costs an activation and is invisible
  to the verifier, which is value-blind anyway;
- a cycle is whatever the canvas happens to contain, with no iteration bound to prove against;
- multi-firing pairing is positional, which is exactly why k-safety is restricted to acyclic
  single-producer workflows. ν-lineage is the real fix and is deferred for want of anywhere to
  put a correlation id.

Surfacing any of this in the editor needs a workflow-format extension — a per-node or per-workflow
annotation block n8n round-trips and ignores would be enough to start — and that is a conversation
with upstream, not a change in this repository. Until it happens the net's extra expressiveness is
reachable only by hand-building a description, and the honest framing of the project is "n8n's
scheduler, made concurrent and analysable", not "n8n, made expressive".

**2. Widen what the verifier can enumerate.** Proper completion now closes (M5), so the ask has
moved: it is the *shape* ceiling, not the property. In order of value, and all upstream in
libpetri: **partial-order reduction** in the state-class graph, which NU-053 names as its missing
piece, which is what independent workflow branches need, and which is the only one of these the
`bounded` verdict does not already soften; a **coverability route** for cycles (Karp-Miller
style, or a cutoff argument showing the loop's residue repeats), which would turn today's
`bounded` into a `proven` — note that a compiler-side loop cap is *not* the answer, since it
would change the executing net and prove a property of the capped net rather than of the
workflow; **interning the marking key**, since a 200 000-class exploration spends much of its
time building strings and about 12 kB of heap per class — which is what raises `k` and what
forces the class cap to be lowered on a small heap; and a **sparse incidence pipeline**, which
now blocks only the budget semiflow and the per-node fallbacks rather than the whole report. On
that last one, a pipeline that returned an error instead of exhausting the heap and aborting
the process would be worth having even without the sparsity: the abort is the reason the SMT
route has a size ceiling at all.

**3. Close the k > 1 residuals that a user can see.** The `waitTill` claim residual (#15) needs a
write barrier plus `AsyncLocalStorage` around `runNode` — designed in ADR 0006, not built. Divergence
#18 cannot be fixed from the scheduler at all: it needs a per-activation scope inside n8n's own
credential layer.

**4. Relax k-safety for self-serialising loops.** The canonical Loop Over Items is a single-entry
simple-cycle SCC with one single-firing tree producer and one cycle producer, and it is provably
safe above k = 1. Specified with its proof obligations in ADR 0006; not implemented, and it is what
would let the most common cyclic workflow in n8n use the budget at all.

**5. Fix the harness soft spots before trusting a wider gate.** `caseKeys` pairs duplicate
`(file, name)` cases positionally, which makes `--scope=workflow` report one spurious regression
and `--scope=all` exit 1. `packages/cli`'s integration suite (397 of its 1501 files) needs a live
database and has never been run.

The full list, prioritised, is in [`tasks/todo.md`](../tasks/todo.md).
