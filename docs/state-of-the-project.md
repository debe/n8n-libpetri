# State of the project

The four-milestone plan is finished. This document is the one-page answer to "what is this,
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
| Verifier | `n8n-libpetri/verify` | `verify(workflow)` and the `n8n-libpetri verify` CLI: six property families over `compile(workflow).net` — the same net the scheduler executes. |
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

`verify(workflow)` runs six property families over the compiled net. What it is measured to do,
with per-query wall clocks: [`docs/verification.md`](verification.md); the design and its limits:
[ADR 0007](adr/0007-verification.md).

**Closes, on a workflow up to roughly 25 nodes:**

- the **structural family** — the concurrency budget bound and its two-phase P-semiflow, the
  per-node `X/running` mutex, the retry bound (both halves), the join-slot discipline — 90–300 ms
  per query at 4–6 nodes, 5–7 s at 21;
- **dead nodes** — a node no execution can reach is proven unreachable in ~90 ms and reported by
  name. This is the one *finding* the surface produces reliably, and it is a real class of n8n
  bug (an all-required Merge with an unwired input, a branch left disconnected on the canvas);
- **mutual exclusion** at k = 1, and proper completion on a workflow with no join and no XOR
  router.

**Does not close:** the headline proper-completion question on a compiled net (`unknown` at 30 s,
60 s *and* 600 s, on a workflow with a stranding and on one without); the arrival bound in the
only form where it could fail; and liveness, which is reported `unknown` by design because the
witness would be a witness in a priority- and value-blind abstraction (VER-004). The wall is the
**pipeline, not z3**: libpetri's P-invariant enumeration exhausts a 4 GB V8 heap at 49 nodes.

Every one of those limits is pinned by a test, so an improvement in libpetri or z3 breaks the
suite and forces the document to be re-measured. The CLI exits **3** when no usable z3 resolved,
so a run that verified nothing never looks like a clean one.

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

**2. Make the verifier answer the question it exists for.** Proper completion is the property a
workflow author would actually want, and it does not close. The ordered asks, all upstream in
libpetri: a per-place quiescence property that honours declared sinks (one query per workflow
instead of one per place); a sparse incidence pipeline, which is the single change that would take
the verifier from small workflows to real ones; boundedness for the marker places; and a bounded
model checker for the SAT direction, so liveness and overlap questions stop being `unknown`.

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
