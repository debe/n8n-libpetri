# ADR 0007 — The verification surface: what the property table proves, and what it cannot

Status: accepted (2026-09-06), **amended 2026-09-06 (M5): the routes are inverted**.
Milestone M4, amended by M5. Builds on [ADR 0004](0004-two-phase-budget.md) (the two-phase
gadget is what makes the budget and the exclusion questions expressible at all) and on the
README's "The model".

> **M5 amendment, in one paragraph.** M4 asked every question of libpetri's `SmtVerifier`
> and measured the headline one — proper completion — as `unknown` at 30 s, 60 s and 600 s,
> on a workflow with a stranding *and* on one without. M5 inverts the routing: the primary
> decision procedure is libpetri's **state-class graph** (VER-010), enumerated once per
> report and solver-free, with the SMT encoding kept as the **fallback** for a graph that
> truncates. That is the order NU-053 prescribes, and it turns the headline property from
> `unknown` everywhere into `proven` in 1–111 ms on every acyclic fixture and `violated`
> with a firing path on the one that really strands. A cyclic workflow, whose state space is
> unbounded and which therefore cannot be `proven` at any cap, gets a fourth verdict —
> **`bounded`**, *no branch strands in any run where the cyclic nodes run at most `k` times*,
> which the explored prefix closes exactly (§11). §§2–4 below are M4's reasoning and are
> **superseded**; §§9–12 are the M5 decision. Everything else — the polarity rules (§5),
> the retry pair (§5a), the counterexample shape (§6), the initial-marking scope (§6a), what
> is deliberately not claimed (§7) — stands unchanged, because none of it was about which
> engine answered.

## Context

The second reason the project exists (README "Why") is analysability: once a workflow *is* a
net, `SmtVerifier` should prove properties of it before activation and hand back
counterexamples that are literal node paths through the same semantics production runs.
M4 turns that claim into a measured surface.

Three constraints were fixed before any code:

1. **One net.** The verifier reads `compile(workflow).net` — the very object
   `PetriScheduler` executes, actions bound. No verification net, no relaxation, no
   "structural view". A proof that does not apply to the running net is not a proof.
2. **libpetri's public verification API only.** `SmtVerifier.forNet(net)` with
   `initialMarking`, `property`, `sinkPlaces`, `semiflowInvariants`, `budgetPlaces` and
   `timeout`, and the properties in `smt-property.ts` — and, since M5, `StateClassGraph.build`
   from the same `libpetri/verification` entry. Nothing is added to libpetri here.
3. **`unknown` is a first-class verdict.** A question no route closed is `unknown`, reported
   in its own section of the table rather than folded into "no findings": a query the solver
   cannot close, a graph that truncated, and — before M5, for everything; since M5, only for
   the fallbacks — a run with no usable z3, whose reason names `PATH` and `LIBPETRI_Z3`
   (VER-013). Nothing here throws on a solver problem. M5 adds one more first-class verdict,
   `bounded` (§11), for the case where something exact *is* known and it is not a proof; it
   is never counted among the proofs.

## Decision

### 1. Six property families, each a named check with its own verdict

| Family | libpetri property | Desirable answer |
|---|---|---|
| proper completion | M4: `joinedOrDeadLettered(p)` per join-input `ready_i` and per edge data place, sinks `_pause`, `_halted`; plus `placeBound(ready_i, capacity)` per join input. **M5: the quiescent classes of the state-class graph, classified (§§9–10); the SMT form is one whole-net `deadlockFree`** | no reachable quiescent marking holds a token there; no more arrivals pile up than the gadget can pair |
| dead nodes | `unreachable({X/running})` per node | *no verdict* — the check reports `violated` when libpetri proves the unreachability, and `unknown` otherwise (§5) |
| no double activation | `placeBound(X/running, 1)` per node | proven |
| budget | `placeBound(_budget, k)` plus the two-phase P-semiflow | proven, and the semiflow is among the validated invariants |
| retry bound | `placeBound(X/tries, maxTries − 1)` per retrying node, **plus** a structural check that no transition produces `X/tries` | both proven — the place bound alone does not entail the attempt bound (§5a) |
| mutual exclusion | `mutualExclusion(A/running, B/running)` per caller-supplied pair | proven (at k = 1, for every pair) |

### 2. Proper completion uses `joinedOrDeadLettered`, not `deadlockFree`, and declares exactly two sinks — **superseded by §9**

`joinedOrDeadLettered(p)` encodes "reachable ∧ quiescent ∧ M(p) ≥ 1" for **any** place; the
ν-net framing in NU-040 is about the intent, not about the encoding, and nothing in it is
ν-specific. That is exactly workflow-net proper completion for `p`.

The whole-net properties — `deadlockFree`, and the `terminatesAtSink` VER-002 added
alongside it — are the wrong question on **this** net, for a reason that does not depend on
how libpetri words them. A completed execution of a compiled workflow quiesces holding a
great many tokens on purpose: every `X/idle`, every `X/done` and `X/skipped` marker, the
refunded `_budget` units, every unspent `X/tries`, every `empty` token on an edge whose
consumer already skipped. A whole-net "nothing was left behind" question is therefore
violated by every *successful* run, and making it hold would mean declaring most of the net's
places sinks — which drains the question of content. And a run that strands one branch while
another finishes is not a deadlock at all: the net quiesces, which is how every execution
ends. The question has to be asked **per place**: *did anything get left behind here?*

`_pause` and `_halted` are declared as the only sinks (VER-002) because they are the two
**designed** terminal markings (README "Retries, halt, cancellation"): a Wait node or a
destination stop deposits `_pause`, and a fatal error deposits `_halt`, which `_halt_reap`
turns into `_halted` after clearing the edge, `in`, `ready` and `hasdata` places. A marking
holding either is terminal on purpose, and a token still sitting on a `ready_i` place there
is the codec's business, not a defect. Declaring them leaves exactly the genuinely stuck runs.

### 3. The declared sinks are inert on `joinedOrDeadLettered`, so a paused witness is downgraded — **superseded by §10**

Measured in M4, and the single most consequential fact about this surface:
`joinedOrDeadLettered` carries **no sink clause by design** (NU-040 AC4 in libpetri's
encoder — *"a declared sink must not excuse a stranded group"*). Only `deadlockFree` and
`terminatesAtSink` read `sinkPlaces`. The declaration above therefore records intent and
excludes nothing.

Since every node's `X_run` offers the `waiting` and `stopped` outcomes, every fan-out has a
reachable quiescent marking where one sibling paused the execution and the other's arrival is
still on its `in` place — a *designed* terminal marking the codec writes back (ADR 0005), and
the query calls it a stranding. On the three-way `fanOut` fixture all three edges come back
`violated` in 1.3–2.7 s with a confirmed witness and `_pause` in the marking.

So `verify()` downgrades a violation whose witness marking holds `_pause`, `_halt` or
`_halted` to `unknown` with that reason, keeping the witness as evidence. It is not a proof
either — Spacer returns one witness, and a real stranding could hide behind it. Closing the
gap needs a per-place quiescence property that honours declared sinks: `deadlockFree` honours
them but asks about the whole net, and on this net that is violated by every clean run. Both
halves are upstream findings, not something this milestone can work around.

### 4. The subject of a proper-completion query is the `ready_i` place, not only the edge place — **amended by §9** (still asked per place, plus a whole-net row)

ADR 0003's arm transition drains an edge place into `ready_i` as soon as the input's slot is
free. So an arrival that will never be consumed does not sit on the edge — the edge is always
drained — it sits one place downstream, on `ready_i`. `tests/spikes/verification.test.ts`
pinned that in M1 on a hand-written join: the unbalanced shape is `violated` on `ready_0` and
`proven` on the edge place feeding it. Both are queried, and the M1 spike is why.

### 5. The dead-nodes check reports one direction only, and the report says so

`unreachable({X/running})` *proven* means the node can never run — the finding. The check
therefore reports `violated`, and `PropertyCheck.query` carries libpetri's own verdict
alongside, so the inversion is visible rather than implied.

The other direction is **not** a verdict. Whichever route answers, a `violated` here is a
firing sequence in an abstraction that is priority-blind and value-blind, where every `xor`
branch of a router is available whatever the data (VER-004 AC2) — on `Trigger → IF → A` the
route reaches `A` through a branch a real run may never take. VER-004 AC3 licenses the proof
direction only, so a node the route reaches is reported `unknown` with that reason, never
`proven`, and it is not counted among the proofs. **M5 makes this sharper, not weaker**: the
state-class graph finds that witness in milliseconds where Spacer took 30 s or timed out, and
the verdict is the same — the reason it was `unknown` was never the solver's speed. (For the
SMT route the report still says "produced a firing sequence" only when
`counterexampleConfirmed === true`; a graph path is a firing sequence by construction.)

Two nodes that are dead for a reason that is not a defect are `unknown` too: an **alternative
entry point** (a node whose shape declares no input and which is not the start node this net
was compiled with) and anything reachable only from one. n8n runs one trigger per execution
and `initialMarking` seeds only the start node's input, so `unreachable(Webhook/running)` is
genuinely `proven` on a Manual-plus-Webhook workflow — and reporting an ordinary two-trigger
workflow as broken would make the CLI's exit code useless. The reason names the entry point
and points at `--start`. A node with no incoming connection whose shape *has* an input is an
orphan, not an entry point, and stays a finding.

### 5a. The retry bound is two checks, because one does not entail the claim

`placeBound(X/tries, maxTries − 1)` is true in the initial marking — the place is seeded with
exactly that many tokens — and a net that refunded a try token would keep satisfying it while
`X_retry_wait` fired without limit (measured on a two-place net; `docs/verification.md`). The
attempt bound needs the structural fact that **nothing produces `X/tries`**, which is read off
the flattened net with no solver and reported as its own check. Only the conjunction supports
"at most `maxTries` attempts", and the structural half is the one a compiler change would
break.

### 6. Counterexamples are node paths

A violation's flat transition names (`id:<uuid>/route_1_b0`) are stripped of the flattener's
`_b<k>` XOR-branch suffix and looked up in `NetMap`, which yields the owning node, the role,
the port and the arm variant. The report prints the node path and the violating marking in
node terms (`Merge port 0 ready (id:Merge/ready_0)`), never place names alone.
`Counterexample.ordered` is true only when libpetri's abstract replay confirmed a firing
sequence; otherwise the steps are an order-free derivation set and the renderer says so
rather than implying a sequence that was never established.

### 6a. Every verdict is scoped to the fresh initial marking

Each query starts from `compiled.initialMarking(...)`, so a `proven` means "on every marking
reachable from M₀". The scheduler does not always start there: on resume, and on n8n's "Retry
execution", the marking is rebuilt by the codec from `nodeExecutionStack` /
`waitingExecution` (ADR 0005) — user-editable state that need not be reachable from M₀ — so
none of these verdicts transfers to such a run. The report header states it. A cheap guard
would be to check a decoded marking against the validated P-invariants at resume time, which
is the property the proofs rest on; that is not implemented.

### 7. What is deliberately not claimed

- **Order.** Neither route models priority (VER-004): the SMT encoding has none, and the
  state-class graph expands every base-enabled transition (its only priority mode is
  `'none'`). So nothing about n8n's depth-first walk, `executionIndex`, or any ordering row of
  `docs/divergences.md` is provable here. The divergence register's ordering claims rest on
  the differ (`docs/differential.md`), not on this.
- **Values.** Both routes are value-blind. Every `xor` branch of a routing transition is
  explored, so "the IF sends data left" and "the IF sends data right" are both reachable —
  which is sound (it over-approximates), is why mutual exclusion of two IF branches is
  *violated* at k ≥ 2 even though a real run only takes one, and is the right reading for a
  stranding: a data outcome really does decide an IF.
- **Timing.** Ignored by the SMT encoding, which strengthens an SMT proof (timing can restrict
  behaviour, never add it), and modelled *exactly* by the state-class graph (VER-011 zones),
  which is neither stronger nor weaker — it is the executor's own semantics.
- **Action duration.** Both routes model a firing as atomic; the executor consumes at fire
  time and produces when the action settles. See §12.
- **The budget bound alone means little.** A net whose `_budget` were consumed and refunded
  by one transition has a zero incidence column for it, so the verifier never sees the place
  move and `placeBound(_budget, k)` is trivially true (pinned in the M1 spike). The
  two-phase gadget is what makes the bound informative, and the check that carries the
  content is the P-semiflow, not the bound.

### 8. The CLI reads a workflow JSON export, and says what it had to guess

`src/n8n/adapter.ts` needs a live `Workflow` object because `NodeHelpers` evaluates each node
type's `inputs` / `outputs` expressions against the node's parameters. A JSON export carries
no node type descriptions at all, so `src/verify/workflow-json.ts` resolves shapes from, in
order: a `--node-types` file (by node name, then `type@version`, then `type`), a short
built-in table for the core types whose miscount would change the model (If, Filter, Merge
including `numberInputs` and `chooseBranch`, Loop Over Items, Compare Datasets), and finally
the connections themselves. Every node that reaches the last step is named in a warning the
CLI prints above the table **and carries into the report as `shapeWarnings`**, so a stored
`--json` artefact is self-describing: a guessed input or output count decides the join versus
the direct form, so this is the one place where the CLI's answer can be about a net that is
not quite the workflow, and neither the terminal output nor the JSON is silent about it.

The exit codes are the CI contract, and there are four rather than three: 0 clean, 1 a
finding, 2 usage — and **3 when no usable z3 resolved**, because a run in which no query ran
must not be indistinguishable from a clean one at the exit code, which is the only thing a CI
job reads. `--strict` additionally turns any `unknown` into exit 1, for a gate that wants the
proofs to stay proofs; without it an `unknown` is reported in its own section and does not
fail the run.

### 9. M5: the state-class graph decides, the SMT encoding falls back (NU-053)

`SmtVerifier` is not the only way to decide a reachability-safety question on a libpetri
net. VER-010 builds the **state class graph** — the Berthomieu-Diaz enumeration of reachable
`(marking, firing-domain)` pairs — with no solver at all, and NU-053 says which of the two
to ask first, in libpetri's own words: *"the verifier routes a bounded quiescence query to
Route B first; when Route B truncates (`Unknown`), it defers to \[the SMT encoding] rather
than returning `Unknown`."* M4 read that as a note about ν-nets and asked z3 directly. It is
not ν-specific: it is a statement about which engine answers a quiescence question.

So M5 inverts the order. `StateSpace.explore()` (`src/verify/state-class.ts`) builds one
graph per report, bounded by `maxClasses`, and **every** family reads it:

| family | from the graph | fallback | then |
|---|---|---|---|
| proper completion | the quiescent classes, classified (§10) | one whole-net `deadlockFree`, structural rest set as sinks — **only where the graph has not already refuted that query** | `bounded` (§11) |
| dead nodes | is `X/running` marked in any class | `unreachable({X/running})` per node | — |
| no double activation | peak token count on `X/running` | `placeBound(X/running, 1)` per node | `bounded` |
| budget | peak token count on `_budget` | `placeBound(_budget, k)` | `bounded` |
| retry bound | peak token count on `X/tries` | `placeBound(X/tries, maxTries − 1)` | `bounded` |
| mutual exclusion | one pass: which `running` places are ever co-marked | `mutualExclusion(A, B)` per pair | `bounded` |

The third column is the bound of §11, taken only after the solver has had its turn (a `proven`
from it is a real proof and outranks any bound) and only on a cyclic workflow. **Dead nodes has
no bounded arm on purpose**: its finding *is* deadness, and "the node did not run within `k`
cyclic-node runs" is not evidence of that, so a bounded arm there would report a non-bug.

Two things gate the fallback column, and both are decisions this ADR owns.

**The proper-completion query is not asked when the graph has refuted it.** VER-002's error
condition is *quiescent ∧ some marked place is not a declared sink*, and the declared sinks are
exactly the structural rest set. So one reachable quiescent marking outside that set — a paused
run holding an arrival, which is every workflow with a second branch in flight — makes the
query **false on that net**, and its `proven` unreachable however long z3 runs. The graph
counts those classes (`StateSpace.outsideSinkClasses`) and, where the count is non-zero, the
query is skipped with that as the reason. It is not a blanket "never ask": on `switch20`, whose
six quiescent classes are all inside the rest set, the question is genuinely open and the query
runs. Skipping can only weaken a verdict (`unknown` or `bounded` instead of a `violated` the
query has never once produced), never strengthen one.

**No SMT query at all above a measured net size.** libpetri runs flatten, the structural
pre-check and the P-invariant/semiflow enumeration before z3 sees a script, and on a big
branchy net that pipeline exhausts the V8 heap. A heap exhaustion is **not catchable**: node
aborts with SIGABRT, `verify()` returns nothing and the CLI's exit-code contract does not
happen. Measured on `layers` diamonds in series, the pipeline costs 2.8 s at 10 join inputs,
15 s at 12, 118 s and 2.4 GB at 14, over 7 minutes at 16, and aborts at 18 (37 nodes, 452
places). So `verify()` refuses to construct an `SmtVerifier` above `SMT_MAX_JOIN_INPUTS = 12`
or `SMT_MAX_FLAT_PLACES = 450` and reports `unknown` naming the ceiling. Both numbers are
proxies for a cost the shape decides, not a bound anyone can prove; `--smt-fallback force`
lifts them and `--smt-fallback off` refuses the route outright. The alternative designs —
running the pipeline in a child process, or bounding its memory — need either a serialisable
net (there is none: `verifyCompiled` takes a live `CompiledWorkflow`) or a V8 flag that cannot
be set mid-process.

Three things make this sound rather than merely fast.

**A complete graph decides exactly.** The BFS expands every base-enabled transition and
every `xor` output branch as a virtual transition (VER-010 AC3), and its consumption model is
the executor's own `consumptionCount` (IO-007, VER-012's exactness precondition). It is
priority-blind, so its reachable marking set is a **superset** of what the priority-ordered
executor can reach: a `proven` over a complete graph transfers to the executor, which is the
direction that matters. Timing is modelled exactly (VER-011 zones) rather than ignored.

**Quiescence is priority-independent.** Priority orders *enabled* transitions; it never
enables one. So "no transition is enabled here" is true or false whatever the scheduler does,
which is why the stranding question survives the priority-blind abstraction intact where an
ordering question would not.

**Truncation is not a pass.** The graph stops at `maxClasses` and says so. Only a complete
graph carries a `proven`; a stranding found *before* truncation is still real (a quiescent
class of the explored prefix is quiescent and reachable), so it is reported, and its absence
is not. The same asymmetry holds for a place bound exceeded and for two `running` places
co-marked, so all three violations are decided from a truncated graph — which also stops a
big workflow from paying one hopeless per-node solver query for them.

One subtlety that is easy to get wrong and would produce a false *finding*: the frontier
classes of a truncated graph have no computed successors, so "no successors" stops being
evidence of quiescence there. `StateSpace` reads `enabledTransitions` — decisive whatever the
BFS did — and only adds successor-free classes inside the **expanded prefix** (`§11`), where
one with enabled transitions and no successor is a genuine time-dead deadlock rather than an
unexplored frontier class. Tracking where that prefix ends is also what makes the bounded
verdict computable, so the two uses share one number.

The fallback is **one** whole-net `deadlockFree` query per report, not M4's one
`joinedOrDeadLettered` per place: since the VER-002 split, `deadlockFree`'s error condition
is *quiescent ∧ some marked place is not a declared sink*, which is literally workflow-net
proper completion. §2's objection to it — "a successful run quiesces holding a great many
tokens, so the whole-net question is violated by every clean run" — was right about the
*symptom* and wrong about the conclusion: the tokens a clean run holds are exactly the
places whose `PlaceRole` is residue, and that set is derivable, so declaring it is not
"draining the question of content", it is *stating* the question. What actually defeats the
SMT form is §10.

### 10. The pause filter is a classification, not a query — and it widens by codec mode

§3 is the measured fact M4 could not work around: every workflow has reachable quiescent
markings holding `_pause` (a Wait node or a destination stop) or `_halted`, because every
`X_run` offers those outcomes. In a workflow with a second branch in flight such a marking
also holds an unconsumed arrival on an `in` / `ready` / `hasdata` place, which the marking
codec writes back (ADR 0005) and which is therefore not a stranding. (On an unbranched
workflow the designed terminals hold nothing but residue — measured on `linear`,
`chooseBranch`, `chain40`, `ifHalf`, `retry` — so the filter is inert there rather than
wrong.) No sink declaration can express that: a sink set that admitted the arrival would also
excuse a genuine stranding on the same place, which is the whole question. M4 had to downgrade
such a witness to `unknown`, and on the three-way `fanOut` that meant three `violated` rows
downgraded and nothing said.

Enumeration does not have that problem, because a class is an object to be classified rather
than a query to be posed. `state-class.ts` puts every quiescent class in one of three boxes:

1. **resting** — every token is on a place whose role is in `REST_ROLES` (`idle`, `done`,
   `skipped`, `free`, `tries`, `budget`, `halted`, `pause`, `waiting`, `stopped`, `ran`,
   `nil`). A completed run.
2. **a designed terminal** — it holds `_pause` / `_halt` / `_halted` / `X/waiting` /
   `X/stopped`. Here the rest set widens, and **which** widening applies is decided by the
   codec mode the scheduler encodes that terminal with (`petri-scheduler.ts`):
   - a **paused** class (mode `pause`) widens by `in-data`, `ready`, `hasdata`, `retry` —
     `PAUSE_REST_ROLES`, exactly what `encodeMarking` pushes back onto `nodeExecutionStack`
     and into `waitingExecution`;
   - a **halted** class (mode `cancelled`, the one mode that legitimately sees an undrained
     marking) widens additionally by `in-empty`, `edge-data`, `edge-empty` —
     `HALT_REST_ROLES` — which that mode drops with a diagnostic or writes back through
     `joinQueue`.
3. **a stranding** — anything else. Reported, with the marking decoded through `NetMap` into
   node + input and the firing path that reaches it.

**The two-set split is the correction M5's first draft needed.** A single widened set called
"the codec's write-back surface" included `in-empty` and the `edge` roles — but
`encodeMarking` in mode `pause` puts `X/in_empty` and an OR input's edge places in its
`inFlight` list and **throws** a `CodecError` on them. Classifying as residue a marking the
codec refuses to encode is precisely the direction that hides a defect. The structural reason
the split is also the *right* one: `X_skip` and the `arm` transitions inhibit on `_halt` /
`_halted` and not on `_pause` (`gadget.ts`), so under a pause those places drain on their own
and a token at rest on one is real pending work.

The widening rather than a blanket skip stays deliberate: skipping a paused class outright is
the only move in this design that could *hide* a defect. `halt` is out of both widened sets on
purpose — a quiescent marking still holding `_halt` means `_halt_reap` never fired, which is a
defect — and so are `ok`, `routed` and `running`.

Measured over every fixture plus three probe shapes, at k = 1 **and** k = 2: the roles that
occur in a designed-terminal quiescent class are `in-data`, `ready`, `hasdata` and `retry`
under a pause, and those plus `in-empty`, `edge-data`, `edge-empty` under `_halted`. Four of
those seven appear only at k ≥ 2, where a second branch is in flight when the halt lands or
while a node sits in its retry wait — which is why the earlier k = 1-only sweep concluded
"only `in-data`, `ready` and `hasdata` ever appear" and why that sentence was wrong. Every role that occurs is in the set its own terminal widens
to, so the split changes no verdict on any fixture; what it changes is what the classification
*rests* on.

### 11. Truncation is reported three ways, and the cyclic case gets a real bounded verdict

Two *shapes* cannot close, and NU-053 names both: heavy independent parallelism (the graph has
no partial-order reduction, so `n` independent branches interleave combinatorially) and
cycles (the reachable state space is unbounded, so no cap can close it). `switch20` and
`loopOverItems` are the two fixtures. Neither ever yields a `proven` — that is the one
failure mode this surface must not have, and it is pinned at three caps on both fixtures.

The reported **cause** has two more values, because attributing every acyclic truncation to
NU-053's parallelism was inference rather than measurement: a four-node chain at a 10-class
cap was told it had "independent parallel branches". `TruncationCause` is now `cycle` (the
analysis found one), `parallelism` (no cycle, and some node has ≥ 2 distinct successors),
`cap` (neither — the cap is simply below what the workflow needs) and `off` (`maxClasses = 0`,
the route switched off on purpose).

A third bound sits underneath all of them: the cap the enumeration *runs* with is the
caller's, lowered to what the V8 heap can hold (`effectiveMaxClasses`). A class costs 4.4-12.4
kB of peak RSS across the nets measured — the cost is per class, not per place — so the
default 200 000 is also a ~2.5 GB memory bound, which is fine under a 4.4 GB heap limit and
fatal under a container's 1 GB, where V8 aborts the process exactly as the P-invariant
pipeline does (§9). The report prints both caps when they differ.

What *is* said differs between them, because different things are true of them.

**A violation found before truncation is a full finding.** A quiescent class of the explored
prefix is quiescent (its `enabledTransitions` is the real enabled set of its marking,
computed when the class was built) and reachable (it was discovered as a successor), so a
stranding in it is real whatever the BFS did next. Only the *absence* of one needs
completeness. The same holds for a place bound exceeded, for two `running` places co-marked
and for a `running` place *reached* (the dead-nodes family's negative direction), and all
four now report from a truncated graph. Where the prefix happens to contain the witness this
also saves the solver query outright; where it does not — `switch20`'s 200 006 classes mark
only two of its 22 `running` places — the fallback still runs, and on that fixture it earns
its keep.

**A cyclic workflow gets `bounded`, a fourth verdict.** Its reachable state space is
infinite, so `proven` is out of reach at *every* cap and `unknown` is the whole of what M4's
design could offer. But the explored prefix closes an exact number of **runs of the
workflow's cyclic nodes**, and saying so is a fact rather than an extrapolation:

> libpetri's BFS pops in FIFO order and appends each newly discovered class to
> `stateClasses()`, so the classes it **expanded** are a prefix `A` of that array and the
> rest, `B`, is frontier (a class with nothing enabled is in `A` wherever it sits: it has no
> successors to compute). Let `iter(C)` be the fewest firings of a *loop transition* — the
> `X_run` of a node on a cycle — on any path to `C` through recorded edges, and take
> `k = min{ iter(C) : C ∈ B } − 1`. Induct on run length: a run firing at most `k` loop
> transitions only ever reaches classes with `iter ≤ k`, none of which is in `B`, so each is
> in `A` and had all of its successors recorded. Every such run, and every marking it can
> come to rest in, was therefore enumerated and classified.

So `bounded` reads *no branch strands in any run where this workflow's cyclic nodes run at
most `k` times*, with `k` in the verdict. Measured: `k = 21` on `loopOverItems` and `k = 135`
on a plain user cycle at the default 200 000-class cap, and `k` grows with the cap (5 → 11 →
21 at 2 000 → 20 000 → 200 000). `iter` is a 0/1-weight shortest path, so it costs one pass
of Dial's algorithm over the graph, which is free next to the enumeration: 4.05 s to build
the 200 000-class graph, 4.08 s to build it and compute the bound.

**`k` is not an iteration count, and nothing may print it as one.** `loopTransitions` returns
the `X_run` of *every* node on a cycle, each weighted 1, so `loopOverItems` — a two-node loop
(`id:Loop/run`, `id:Body/run`) — spends two of them per pass of the body and `k = 21` is ten
complete passes, not twenty-one. The first draft of this route said "loop iterations" in the
rendered report, in the header line and in the measured tables, advertising the verdict at
about twice its strength. The quantity is now named for what it counts, and
`floor(k / loopSteps)` is printed beside it as the guaranteed number of complete passes.

The verdict is kept scrupulously apart from a proof: its own `CheckVerdict` member, its own
count, its own section of the rendered report, and `--strict` fails on it. `k = 0` is
refused — "nothing goes wrong in runs where the loop never runs" is not a statement about the
loop — so one cyclic-node run is the floor.

The argument leans on one property of libpetri that nothing else here would notice if it
changed: that its exploration is a FIFO BFS appending each newly discovered class, so the
expanded classes really are a prefix of `stateClasses()`. That is asserted directly, against
an independently computed BFS distance, in `state-class.test.ts`.

**Every other truncation gets `unknown`,** because there is nothing to count. Nothing borrows
the cyclic case's bound: `boundedCyclicRuns` is `null` whenever the workflow has no cyclic
node, and the acyclic truncating fixture is pinned to `unknown` with `counts.bounded` zero.

**A compile option bounding loop iterations was considered and rejected**, and the bounded
verdict above is deliberately *not* it. Capping the loop in the compiler would change the net
the scheduler executes, which is README's first principle ("One net serves execution and
verification"), and what it would buy is not what it looks like: a proof about a net whose
loop is capped at *n* iterations is a proof about **that net**, not about the workflow. The
route above caps nothing and changes no net — it reports how much of the *unmodified* net's
behaviour the enumeration covered, which is a statement about the workflow. Analysing the
acyclic condensation was rejected for a related reason: the strandings a loop workflow can
have are mostly *at* the loop, so a verdict about the condensation would be silent about
exactly the question. The sound way to turn `bounded` into `proven` is a cutoff or
coverability argument upstream (Karp-Miller style), not a smaller net.

### 12. What the inversion cost elsewhere

**The P-invariant pipeline is now lazy — and, above a size, refused.** Phases 1–3 (flatten,
structural pre-check, P-invariant and semiflow enumeration) are the expensive half of the SMT
route and the wall M4 measured — 2.9 s at 21 nodes, a 4 GB heap exhausted at 49. Nothing but
the budget semiflow needs them now (a P-invariant is a statement about the incidence matrix,
not about the reachable set, so it is the one claim the graph cannot make), so `verify()` runs
the pipeline once, lazily, and only when the `budget` family is selected. A report that does
not select it never pays.

Laziness alone was not enough, because *every* SMT fallback query runs the same pipeline: on a
net past the ceiling of §9, a truncated graph would send `verify()` straight into the abort it
was supposed to have avoided — and a truncated graph is exactly what a big workflow has. The
first draft of M5 had that bug, and its documentation said the opposite ("run without the
budget family and everything else still answers off the graph"), so the size ceiling gates
`query()` and `collectInvariants()` alike.

**Exit 3 ranks below a finding.** The CLI's exit 3 means "no usable z3, so the SMT fallback
never ran". Since the solver-free route decides the reachability-safety families with no
solver at all, a stranding it found must not be masked by a missing tool, so `runCli` checks
`!report.ok` **first** and returns 1. Exit 3 still exists, and still means a run whose
solver-backed part was skipped is not a clean bill of health.

**One more thing neither route models, stated as scope.** Both encode a firing as **atomic**:
consume and produce in one step. The executor consumes at fire time and produces when the
action's `Promise` settles, so a marking in which one node's action is in flight while
another transition fires is not a state either route visits. It matters only for a transition
whose *inhibitor* place an action can produce — in this net, `_halt` and `_pause`, and
nothing else — so the difference is confined to the halt/pause window. This is not new in M5
(the SMT encoding has the same shape), but M4's ADR did not say it, and a `proven` is a proof
about the net under standard Petri-net firing, which is what "one net serves execution and
verification" buys and where it stops.

## Consequences

The measurements are in [`docs/verification.md`](../verification.md). The shape of the
result, after M5:

**The headline property closes.** Proper completion — *can this workflow strand a branch?* —
is `proven` in 1–111 ms on every acyclic fixture (50 classes for a 4-node chain, 393 for the
diamond, 2048 for a 41-node chain, 6151 for a 9-node fan-out, 47 924 for the 21-node
generated workflow), and `violated` in 25 ms on `ifBothOutputs`, where it strands
`Merge/ready_0` and `Merge/hasdata` — the already-registered divergence #2, caught by the
property that exists to catch it, with the firing path that reaches the stuck marking. M4
measured every one of those as `unknown` at 30 s, 60 s and 600 s.

**The size wall moved, and it is a different wall.** M4's was the P-invariant pipeline,
which OOMed a 4 GB heap at 49 nodes; M5 pays that only for the budget semiflow (§12) and
refuses it above a measured join count (§9), so a 41-node chain verifies end to end and a
49-node branchy one reports `unknown` instead of aborting. The new wall is the class count,
and it is about *shape* rather than size: depth is nearly free (2048 classes at 41 nodes),
independent width is not (6151 at 9 nodes, 200 000+ at 22), and a cycle is unbounded. It is
also a statement about **k = 1**, which is what `verify()` compiles by default: at k = 2 the
same 41-node chain costs 31 448 classes and at k = 4 it truncates.

**A cycle is no longer a blank.** `loopOverItems` — n8n's most common cyclic shape — comes
back `bounded` at `k = 21` cyclic-node runs in 3.9 s (ten complete passes of its two-node
loop body), and `userCycle` at `k = 135` in 2.0 s (§11). That is sound, is not a proof, and is
the useful half of what a truncated cyclic graph knows; the alternative on the table was to
keep reporting `unknown` and call the limit permanent.

**The SMT fallback splits in two, and the document says which half works.** For *proper
completion* it decides nothing: one whole-net `deadlockFree` with the structural rest set as
sinks, 30 s per query, gives `unknown` on `linear`, `diamond`, `chooseBranch`,
`ifBothOutputs`, `chain40`, `wide8`, `loopOverItems` and `switch20`, and `violated` on
`fanOut` (3.8 s) and `multiProducer` (28.7 s) with a witness that is a paused run — §10's
artifact, downgraded by the same rule M4 applied. Nought for ten.

And the reason is structural, which is what M5's first draft got wrong when it kept the query
"because its `proven` direction would transfer if it ever came back". On a net with a
reachable quiescent marking outside the sink set — every workflow with a second branch in
flight — `deadlockFree(sinks = rest set)` is *false by construction*, so that direction cannot
come back at all. The query is therefore asked only where the graph has **not** exhibited such
a class (§9), which on the cyclic fixtures saves a whole 30 s timeout per report, and its
`violated` is a finding when the witness is not a designed terminal. Where it is asked, the
`proven` is genuinely available.

For the *bound* families it earns its place outright. On `switch20`, whose graph truncates
after marking only two of 22 `running` places in 200 006 classes, z3 proves
`placeBound(_budget, 1)` and all 22 `placeBound(X/running, 1)` — 23 of that report's 24
proofs, at about 2.9 s a query. What it cannot do on the same net is the *witness* direction:
`dead-nodes` sends 20 `unreachable` queries and gets 20 timeouts, 11 minutes for nothing,
which is why `--property` exists. So the fallback stays per family rather than being dropped,
and the honest claim is the narrow one: *the proper-completion fallback* decides nothing
measured.

**Every other family got faster and, in two cases, more exact.** Dead nodes, the running
mutex, the retry bound, the budget bound and mutual exclusion are all read off the one graph:
the whole 26-check diamond report decides every row off it and starts a solver process only
for the 1 ms invariant-only run the budget semiflow needs. Two questions M4 could not
decide now close — the OR-round arrival bound (`placeBound(ready_i, n)`, the query
divergence #8 names, `unknown` at 30 s in M4) and the reachability half of dead nodes, which
now answers instantly and is *still* reported `unknown`, because the reason it was `unknown`
was never the solver (§5, VER-004 AC3).

**What is unchanged, and deliberately so.** No verdict says anything about firing order, node
values, or a resumed execution's marking (§§6a, 7). Liveness is still not a verdict. A
witness is still a witness in a priority- and value-blind abstraction — the graph explores
every `xor` branch of a router exactly as the encoder does — so a `violated` means "there is
a data outcome and an interleaving under which this happens", which is the right reading for
a stranding (data really does decide an IF) and the wrong one for a liveness claim.

**What M4 learned that is still true.** VER-007 is not optional *for the budget semiflow*:
with semiflows off, `placeBound(_budget, k)` went from `proven` in 204 ms to `unknown` at
30 s on the SMT route. That no longer affects the budget *bound* (the graph decides it), but
the semiflow check still rests on it. And the net is still not structurally bounded — `X/done`,
`X/skipped` and the other markers are produced and never consumed — which is why the SMT
route never closed the quiescence question and why the graph, which does not care about
structural boundedness, does.

## Evidence

- `tests/verify/state-class.test.ts` (M5): the solver-free route, **with no `describeZ3`
  gate** — the point of the route is that it needs no solver, so the suite runs with z3
  absent. It pins every measured verdict and class count of the table above, the
  `ifBothOutputs` stranding decoded to `Merge` input 0 with its firing path, the pause filter
  (a workflow that can pause is `proven`; the same shape with a real stranding is
  `violated`), the rest sets as constants, truncation reporting for both NU-053 shapes, and —
  the assertion that carries the whole surface — that a *false `proven` is impossible* on a
  truncated graph at any cap. Its `the bounded verdict for a cyclic workflow` block pins §11:
  `loopOverItems` is `bounded` with the bound growing as the cap grows, the acyclic
  truncation stays `unknown` with no bound borrowed, `k = 0` is refused, `loopTransitions`
  names the `run` of the cyclic nodes and nothing else, the `cyclicStranding` fixture —
  a cycle *and* a real stranding — is `violated` rather than `bounded` at every cap, and
  libpetri's discovery order is asserted to be BFS against an independently computed
  distance, which is the upstream property the whole argument rests on. It also pins the two
  rest sets against their codec modes (§10), the k = 2 class counts for `diamond` and
  `chain40` so the budget axis cannot go stale, that a cap set below a chain's class count is
  reported as `cap` rather than as parallelism, and `effectiveMaxClasses` lowering the cap
  under a small heap.
- `tests/verify/smt-route.test.ts` (M5, no solver needed): the size ceiling — a 49-node
  generated workflow **verifies instead of aborting the process**, which is what the first
  draft did — plus `smtRefusalFor`'s three modes and the skipped whole-net query on a
  truncated cyclic graph, with its reason.
- `tests/verify/smt-fallback-violation.test.ts` (M5): the fallback's own `violated`, with a
  fake `SmtVerifier` standing in for a solver that has never produced one. A stranding the
  pause filter does not excuse becomes a finding on the whole-net row and on any per-place row
  the witness marks, and no reason claims the query "did not decide it either".
- `tests/verify/properties.test.ts`: the six families as `verify()` reports them, including
  the two questions the inversion turned from `unknown` into verdicts (the join-input
  quiescence question, `proven` on the balanced diamond and `violated` on the unbalanced
  join; the OR-round arrival bound) and the one it did not (a reached node is `unknown`,
  never `proven`, now that the route finds the witness instantly).
- `tests/verify/no-z3.test.ts`: `LIBPETRI_Z3` pointed at a path that does not exist. The
  whole `retryFour` report still closes off the graph; the only `unknown` left is the
  liveness one, which is `unknown` by design. With `maxClasses: 0` — the route off — every
  verdict is `unknown` again with a reason naming `PATH` and `LIBPETRI_Z3`, which is M4's
  behaviour and the regression guard for it.
- `tests/verify/cli.test.ts`: exit 3 for a missing solver, and exit **1** for a stranding
  found without one — a finding must never be masked by a missing tool.
- `tests/verify/measure-graph.ts` → [`docs/verification.md`](../verification.md): the
  solver-free table, the bound table, the proper-completion fallback table (the
  nought-for-ten measurement above) and the whole-report routing table — the last of which is
  where the `switch20` row shows the *bound* fallbacks proving 23 of that report's 24 checks. `tests/verify/measure.ts` keeps the SMT sampler for the
  fallback and the pipeline cost, with its proper-completion sample switched to the whole-net
  `deadlockFree` the fallback actually asks. Its `[live]` dead-node sample is the last
  *reachable* node, not the last node — picking the latter reported a deadness proof under a
  liveness label in the first revision of that document.
- `tests/spikes/verification.test.ts` (M1): `joinedOrDeadLettered` on a hand-written join is
  `violated` on `ready_0` for the unbalanced shape and `proven` on the edge place; the
  balanced diamond is `proven` on all three; `placeBound(_budget, k)` proven at k ∈ {1, 2},
  `mutualExclusion(A/running, B/running)` proven at k = 1 and violated at k = 2,
  `placeBound(X/running, 1)` proven with the `X/idle` mutex and violated without it, and a
  self-loop budget proven trivially with nothing to state exclusion on.
