# Verification — what `verify(workflow)` proves, and what it costs

Milestones M4 (the surface) and M5 (the routes inverted). The design decisions are in
[ADR 0007](adr/0007-verification.md); this file is the honest measurement: what each property
establishes, where it stops working, and at which workflow shape.

`verify()` runs against **the net the scheduler executes** — `compile(workflow).net`, actions
bound, the same object `PetriScheduler` hands to `PrecompiledNetExecutor`. There is no
verification net (README "Principles", rule 1).

> **What changed in M5, in one table.** M4 asked every question of libpetri's `SmtVerifier`
> and the headline one — *can this workflow strand a branch?* — never closed. M5 routes it to
> libpetri's **state-class graph** (VER-010) first and keeps the solver as the fallback,
> which is the order NU-053 prescribes.
>
> | workflow | M4: `joinedOrDeadLettered` per place, z3 | M5: state-class graph |
> |---|---|---|
> | `linear` (4 nodes) | `unknown` at 60 s from the 2nd edge on | **`proven`, 11 ms** |
> | `diamond` (6 nodes) | `unknown` at 30 s, 60 s **and** 600 s | **`proven`, 10 ms** |
> | `chooseBranch` (4 nodes) | `unknown` at 30 s | **`proven`, 1 ms** |
> | `multiProducer` (4 nodes) | `unknown` at 30 s on the join input; the one `violated` edge was a paused witness, downgraded | **`proven`, 4 ms** |
> | `ifBothOutputs` (5 nodes) | `unknown` at 30 s | **`violated`, 25 ms** — strands `Merge/ready_0` |
> | `loopOverItems` (4 nodes, cyclic) | `unknown` at 30 s | **`bounded`, 4.0 s** — no stranding within 21 runs of its cyclic nodes (10 complete passes of the loop body) |
> | generated, 21 nodes | `unknown` at 33 s | **`proven`, 2.2 s** |
> | generated, 49 nodes | never reached the solver — the P-invariant pipeline exhausted a 4 GB heap after ~3 min, aborting the process | truncated at 200 000 classes, 20 s — and the pipeline is no longer started on a net that size |
>
> The M4 column for `diamond`, `multiProducer` and the two generated sizes is the previous
> revision of this document's own sweep; `linear`, `chooseBranch` and `ifBothOutputs` were
> re-measured for the comparison. The `ifBothOutputs` violation is the already-registered
> divergence #2. The property catches exactly what it exists to catch.
>
> `bounded` is a **fourth verdict**, added because a cyclic workflow's reachable state space
> is unbounded and so `proven` is out of reach at every class cap: it says the property holds
> for every run in which the workflow's cyclic nodes run at most `k` times *in total*, which
> the explored prefix closes exactly. That is runs of cyclic nodes, not passes of the loop
> body — a two-node loop spends two per pass — and the report prints both. It is sound, it is
> not a proof, and nothing counts it as one.

```ts
import { verify } from 'n8n-libpetri/verify';

// Every measured table below is budget 1, which is the default; k is a real cost axis
// ("Where the class count comes from" below), so raise it deliberately.
const report = await verify(description, { budget: 2, maxClasses: 200_000 });
console.log(report.counts);      // { proven, violated, bounded, unknown }
console.log(report.stateSpace);  // { classes, complete, expanded, quiescent, terminal,
                                 //   truncation, boundedCyclicRuns, loopSteps, … }
for (const check of report.checks) console.log(check.name, check.verdict, check.query.route);
```

```
n8n-libpetri verify my-workflow.json --budget 2 --property proper-completion --max-classes 200000
```

**Four verdicts, and only one of them is a proof.**

| verdict | means |
|---|---|
| `proven` | the desirable property holds on every reachable marking |
| `violated` | it does not, and the check carries the node path and the stuck marking |
| `bounded` | it holds on every run in which the workflow's cyclic nodes run at most `k` times *in total* (`floor(k / loopSteps)` complete passes of the loop body), and the state space beyond that was not explored. Sound, exact, **not a proof** ("The cyclic case gets a bounded verdict" below) |
| `unknown` | undecided, with the reason |

`bounded` exists because a cyclic workflow's reachable state space is unbounded, so `proven`
is out of reach at every class cap and `unknown` says less than is known. It is never counted
among the proofs, gets its own section of the report, and `--strict` fails on it.

Exit codes, which are the whole of the CI contract:

| code | meaning |
|---|---|
| 0 | nothing came back `violated` (and, under `--strict`, everything came back `proven`) |
| 1 | a finding — or, under `--strict`, a check that is `unknown` or `bounded` |
| 2 | usage or input error |
| 3 | **no usable z3 resolved, so the SMT fallback never ran** (VER-013) |

Since M5, **1 outranks 3**: the solver-free route decides the reachability-safety families
with no solver at all, so a stranding it found is reported as a finding whether or not z3
resolved. A missing tool must never mask a defect. Exit 3 still exists for the case where
nothing came back `violated` and the solver-backed part of the run was skipped, because a run
whose fallbacks never ran must not be indistinguishable from a clean one at the exit code,
which is the only thing a CI job reads.

Without `--strict` neither `unknown` nor `bounded` fails the run — neither is a finding — but
each gets its own section of the table, because a truncated graph must not read as a clean
bill of health.

Two more things the report carries, because they change what a verdict is *about*:

- **Guessed node shapes.** A workflow JSON export has no node type descriptions, so the CLI
  resolves port counts from `--node-types`, a short built-in table, and finally the
  connections (ADR 0007 §8). Every guess is a warning on stderr **and** a `shapeWarnings`
  entry in the JSON, because a guessed port count changes which net was verified.
- **The state space.** `report.stateSpace` says how many classes were explored, whether the
  enumeration **closed**, and — when it did not — which of the two shapes stopped it. The
  header prints it. `complete: false` is the difference between a proof and a bounded
  observation, and no verdict is allowed to hide it.

---

## The two routes

Every question here is **reachability-safety**: does any reachable marking do this? There are
two engines in libpetri that decide such a question, and which one leads is the whole of M5.

### The solver-free route (VER-010) — primary

`StateClassGraph.build(net, M0, maxClasses)` enumerates reachable `(marking, firing-domain)`
pairs by BFS (Berthomieu-Diaz, VER-010/VER-011). `src/verify/state-class.ts` builds **one**
graph per report and every family reads it. When the graph is complete it decides exactly:

| question | read off the graph as |
|---|---|
| can a branch strand? | the quiescent classes, classified (below) |
| is `X` dead? | is `X/running` marked in any class |
| can `X` run twice? | peak token count on `X/running` |
| does `_budget` stay within k? | peak token count on `_budget` |
| is the retry bound kept? | peak token count on `X/tries` |
| can `A` and `B` overlap? | one pass: which `running` places are ever co-marked |

Three facts make reading it this way sound rather than merely fast.

1. **It is priority-blind, so its marking set is a superset of the executor's.** Every
   base-enabled transition is expanded and every `xor` output branch is a separate virtual
   transition (VER-010 AC3). Priority can only *remove* behaviour, so a `proven` over a
   complete graph transfers to the priority-ordered executor. Its consumption model is the
   executor's own `consumptionCount` (IO-007), which VER-012 names as the exactness
   precondition: an `all()` input drains its place in the graph exactly as at run time.
2. **Quiescence is priority-independent.** Priority orders *enabled* transitions; it never
   enables one. "Nothing is enabled here" is therefore true or false whatever the scheduler
   does — which is why the stranding question survives the abstraction intact where an
   ordering question would not.
3. **Truncation is visible, and graded.** The BFS stops at `maxClasses` and reports
   `isComplete()`. Only a complete graph carries a `proven` — but a truncated one is not
   silent. A violation it found is a full finding (a class of the explored prefix is
   quiescent and reachable however the BFS ended); on a cyclic workflow the prefix also
   closes an exact number of runs of the workflow's cyclic nodes, which is the `bounded`
   verdict; and the remaining cases — heavy independent parallelism, or a cap set too low —
   are `unknown`. The cap the enumeration *runs* with is lowered when the V8 heap cannot hold
   that many classes ("The class cap" below), because a heap exhaustion aborts the process
   rather than truncating anything.

### The SMT route (VER-001, VER-013) — fallback

libpetri's `SmtVerifier`: IC3/PDR through the `z3` executable over SMT-LIB2 text. It runs per
family only where the graph truncated or failed to build. For proper completion the fallback
is **one whole-net `deadlockFree` query** with the structural rest set declared as sinks —
since the VER-002 split, `deadlockFree`'s error condition is *quiescent ∧ some marked place is
not a declared sink*, which is literally workflow-net proper completion. That is one query per
workflow, not M4's one per place, which is what made the family cost (places × timeout).

**Measured, the fallback splits in two, and the split is the whole answer to "is it
decorative?"**

- the **bound** fallbacks — `placeBound`, `unreachable`, `mutualExclusion` — decide plenty.
  On `switch20`, whose graph truncates and whose per-node questions the graph therefore
  cannot answer, z3 proves `placeBound(_budget, 1)` and all 22 `placeBound(X/running, 1)`:
  23 of the report's 24 proofs. That is the case the fallback exists for, and it works;
- the **proper-completion** fallback decides **nothing** on any fixture (table below), and
  the reason is structural rather than a solver budget. VER-002's error condition is
  *quiescent ∧ some marked place is not a declared sink*, and the sinks declared are exactly
  the structural rest set. So on any net with a reachable quiescent marking outside that set
  — a paused run holding an arrival, i.e. every workflow with a second branch in flight — the
  property is **false by construction** and `proven` cannot come back however long z3 runs.

That last point is not a complaint, it is a route decision. The graph counts those classes
(`StateSpace.outsideSinkClasses`), and where the count is non-zero **the query is not asked
at all**: its `proven` is unreachable, and a `violated` would name one of the same designed
terminals the graph has already classified. Measured on `loopOverItems` that is 30 s of the
report's wall clock saved for an answer that was already known. Where the count is zero the
question is real — `switch20`'s six quiescent classes are all inside the rest set — and the
query runs.

If the query does come back `violated` with a witness the pause filter does not excuse, it is
reported as a finding (on the whole-net row, and on any per-place row whose place the witness
marks). No fixture has ever produced that, which is exactly why the branch is pinned with a
fake solver in `tests/verify/smt-fallback-violation.test.ts` rather than by measurement.

### The SMT route is refused above a measured size, because its failure mode is an abort

Before z3 sees anything, libpetri runs flatten, the structural pre-check, and the P-invariant
and semiflow enumeration. On a big **branchy** net that pipeline exhausts the V8 heap, and a
heap exhaustion is not an exception `verify()` can catch and turn into an `unknown` — the
process aborts with SIGABRT: no report, no exit code, nothing. So the route is not started at
all above a measured ceiling, and the check comes back `unknown` naming the ceiling.

The cost driver is **join count**, not node count ("The pipeline before z3" below has the
numbers): a 41-node chain runs the pipeline in 1.8 s at 214 MB, while diamonds in series cost
0.4 s at 6 join inputs, 2.8 s at 10, 15 s at 12, 118 s and 2.4 GB at 14, over 7 minutes at 16
and abort the process at 18. The ceilings are therefore `SMT_MAX_JOIN_INPUTS = 12` and, as a
second guard for a shape whose blow-up is not joins, `SMT_MAX_FLAT_PLACES = 450` (the heap
died at 452 places on that family). Both are conservative proxies and neither can bound what
the Farkas enumeration will do on an unmeasured shape; `--smt-fallback force`
(`smtFallback: 'force'`) lifts them, and `--smt-fallback off` refuses the route outright.
`tests/verify/smt-route.test.ts` pins the ceiling behaviourally — a 49-node generated
workflow *verifies* instead of aborting the process — which is the regression it exists for.

Every row of the report says which route answered it.

---

## The six properties

| family | question | route | desirable answer |
|---|---|---|---|
| proper completion | can a branch be left stranded? one whole-net row plus one per join input and per edge place, plus an arrival bound per input | graph → `deadlockFree` (only where the graph has not refuted it) → bound | proven |
| dead nodes | is `X/running` reachable? | graph → `unreachable({X/running})` | *no verdict* — `violated` when the route proves the unreachability, `unknown` otherwise |
| no double activation | `X/running` never holds two tokens | graph → `placeBound` → bound | proven |
| budget | `_budget` never exceeds k, **plus** the two-phase P-semiflow | graph → `placeBound` → bound; the semiflow is structural | proven, and the semiflow is among the validated invariants |
| retry bound | `X/tries` bounded, **plus** a structural check that nothing produces it | graph → `placeBound` → bound; the producer half is structural | both proven |
| mutual exclusion | `A/running` and `B/running` never co-marked | graph → `mutualExclusion` → bound | proven at k = 1 |

"graph → X → bound" is the route order: the state-class graph first (NU-053), the named SMT
query only where the graph did not decide *and* the question is still open (for proper
completion the graph can refute the query itself — see above), and the `bound` after that, on
a cyclic workflow whose prefix closes at least one whole cyclic-node run. **Dead nodes has no
bounded arm on purpose**: "the node did not run within `k` cyclic-node runs" is not evidence
that it is dead, and the family's finding *is* deadness, so a bounded arm there would send a
reader after a non-bug.

The SMT column is also subject to the size ceiling above: on a net past it no query in any
family is started, and every row that would have used one is `unknown` with the ceiling as its
reason.

### What counts as a stranding

A quiescent marking of a compiled workflow is full of tokens on purpose. The question "did
anything get left behind" is therefore about **which** places hold them, and `PlaceRole`
answers it structurally:

- **rest** — `idle`, `done`, `skipped`, `free`, `tries`, `budget`, `halted`, `pause`,
  `waiting`, `stopped`, `ran`, `nil`. A token here is residue of a finished run: the gadget's
  own resources handed back, the markers nothing consumes, the designed terminals.
- **pending work** — everything else: `in-data`, `in-empty`, `edge-data`, `edge-empty`,
  `ready`, `hasdata`, `ok`, `routed`, `running`, `retry`, `halt`. A delivered activation that
  was never consumed, or an outcome that was never routed.

A quiescent class holding pending work is a **stranding**, and it is reported with the marking
decoded through `NetMap` into node + input and the firing sequence that reaches it.

### The pause filter, which is what makes the verdict correct rather than merely fast

Every node's `X_run` offers the `waiting` and `stopped` outcomes (README "Retries, halt,
cancellation"), so **every** workflow has reachable quiescent markings holding `_pause` — a
Wait node or a destination stop — or `_halted`. In any workflow with a second branch in
flight such a marking also holds an unconsumed arrival on an `in` / `ready` / `hasdata`
place, and that arrival is not stranded at all: it is exactly what the marking codec writes
back into n8n's `nodeExecutionStack` and `waitingExecution` (ADR 0005). (On an unbranched
workflow — `linear`, `chooseBranch`, `chain40`, `ifHalf`, `retry` — the designed terminals
hold nothing but residue, measured; the filter is then inert rather than wrong.)

M4 could not say so. `joinedOrDeadLettered` carries no sink clause by design (NU-040 AC4), and
even `deadlockFree`'s sink clause cannot express it: a sink set that admitted the arrival
would also excuse a genuine stranding on the same place, which is the whole question. So M4
downgraded such a witness to `unknown` — on the three-way `fanOut` that meant three `violated`
rows downgraded and nothing said.

Enumeration classifies the class instead of posing a query about it. In a class holding a
designed terminal the rest set **widens** — and it widens to exactly what `encodeMarking`
accepts *in the mode the scheduler encodes that terminal with*, which is why there are two
widened sets rather than one:

| the class holds | codec mode (`petri-scheduler.ts`) | rest set widens by | why those |
|---|---|---|---|
| `_pause`, `X/waiting`, `X/stopped` | `pause` | `in-data`, `ready`, `hasdata`, `retry` | the arrivals `encodeMarking` pushes onto the stack and into `waitingExecution`, plus the retry unit `X_retry_wait` is pause-inhibited on |
| `_halt`, `_halted` | `cancelled` | the four above **plus** `in-empty`, `edge-data`, `edge-empty` | `cancelled` is the one mode that legitimately sees an undrained marking: it drops the empty with a diagnostic ("n8n never enqueues an empty") and writes the edge arrivals back through `joinQueue` |

The split is not decoration, and getting it wrong is the one thing here that could **hide** a
defect. `X_skip` and the `arm` transitions inhibit on `_halt` / `_halted` and **not** on
`_pause` (`gadget.ts`), so under a pause those places drain on their own and a token resting
on one is real pending work — and `encodeMarking` in mode `pause` throws a `CodecError` on
exactly `X/in_empty` and an OR input's edge places rather than writing them back. A single
widened set called "the codec's write-back surface" was wrong about that, in the direction
that classifies as residue a marking the codec refuses to encode.

Anything outside the class's own set is still reported: an unrouted `X/ok`, a `_halt` no
`_halt_reap` consumed.

#### What actually rests in a designed terminal

Measured over every fixture plus three shapes built to probe the corners, at k = 1 and k = 2
(`REST_ROLES` members omitted — they are residue everywhere):

| role | occurs under | in | in that terminal's rest set? |
|---|---|---|---|
| `in-data` | `_pause`, `X/waiting`, `X/stopped`, `_halted` | 13 of 19 workflows | yes |
| `ready` | `_pause`, `X/waiting`, `X/stopped` | 8 | yes |
| `hasdata` | `_pause`, `X/waiting`, `X/stopped` | 6 | yes |
| `retry` | `_pause`, `X/waiting`, `X/stopped`, `_halted` | 1, at k = 2 (a retrying node beside a second branch) | yes |
| `in-empty` | `_halted` only | 5, all at k = 2 | yes (halt set) |
| `edge-data`, `edge-empty` | `_halted` only | 3, all at k = 2 | yes (halt set) |

The last three rows are why the sweep had to be run at k = 2: with one budget unit a second
branch is never in flight when the halt lands or when a node sits in its retry wait, so those
places never come to rest and a k = 1 sweep sees only `in-data`, `ready` and `hasdata` — which
is exactly the list the first draft of this document generalised from. Every role that occurs is in the set
its own terminal widens to, so the split changes no verdict on any fixture — what it changes
is the argument, from "these are the roles a sweep happened to see" to "these are the roles
the codec path for this terminal accepts".

### Why a *live* node is `unknown` and never `proven`

`unreachable({X/running})` *proven* means the node can never run, which is the finding, so the
check reports `violated` and `PropertyCheck.query` carries the route's own verdict alongside.
The other direction is **not** a verdict. Both routes explore an abstraction that is
priority-blind and value-blind — every `xor` branch of a router is available whatever the data
(VER-004 AC2) — so on `Trigger → IF → A` the route reaches `A` through a branch a real run may
never take. VER-004 AC3 licenses the proof direction only.

M4 measured this question as *slow*: `unknown` at 30 s behind a join, because the witness was
a SAT search. The graph finds the witness in milliseconds — and the verdict is still
`unknown`, which is the point. The reason it is `unknown` was never the solver.

### A second trigger is an entry point, not a dead node

n8n runs one trigger per execution and `initialMarking` seeds only the start node's own input,
so `unreachable(Webhook/running)` is genuinely proven on a Manual-plus-Webhook workflow.
Reporting an ordinary two-trigger workflow as broken would make the CLI's exit code useless,
so an alternative entry point — a node whose shape declares no input and which is not this
net's start node — and anything reachable only from one is `unknown` with a reason naming the
entry point and `--start`. A node with no incoming connection whose shape *has* an input is an
orphan, not an entry point, and stays a finding.

### Why the retry bound is two checks

`placeBound(X/tries, maxTries − 1)` is true in the initial marking — the place is seeded with
exactly that many tokens — and a net that *refunded* a try token would keep satisfying it
while `X_retry_wait` fired without limit. The attempt bound needs the structural fact that
**nothing produces `X/tries`**, which is read off the flattened net with no route at all and
reported as its own check. Only the conjunction supports "at most `maxTries` attempts", and
the structural half is the one a compiler change would break.

### The arrival bound, and which of its two forms is a detector

`placeBound(ready_i, capacity)` asks how many arrivals can queue on one input:

- a **join slot** (capacity 1) cannot be violated on a net this compiler produces — every arm
  consumes `free_i` and only `X_start` / `X_skip` refund it, so `free_i + ready_i ≤ 1` holds
  by construction. The check re-verifies the gadget against the built net; it is not a
  detector for anything;
- an **OR round** (capacity `n`) is the form with a reachable violation, i.e. the query
  `docs/divergences.md` row #8 names. M4 measured it `unknown` at 30 s on the smallest OR
  shape a compiled workflow can have, so the family had no working detector for the
  arrival-count class. The graph decides it exactly: `C input 0 queues at most 2 arrivals per
  round` is `proven` off `multiProducer`'s complete 245-class graph, with no solver at all.

### Why the `ready_i` place and not only the edge place

ADR 0003's arm transition drains an edge place into `ready_i` as soon as the input's slot is
free. So an arrival that will never be consumed does not sit on the edge — the edge is always
drained — it sits one place downstream, on `ready_i`. Both are reported, and so is the
whole-net row, which covers the places neither names: a token left on `X/hasdata`, on `X/ok`,
on an unreaped `_halt`.

---

## What no verdict can say

- **Order.** Both routes are priority-blind, so nothing about n8n's depth-first walk,
  `executionIndex`, or any ordering row of `docs/divergences.md` is provable here. The
  divergence register's ordering claims rest on the differ (`docs/differential.md`).
- **Values.** Both are value-blind. Every `xor` branch of a routing transition is explored, so
  "the IF sends data left" and "the IF sends data right" are both reachable — which is sound
  (it over-approximates), is why mutual exclusion of two IF branches is *violated* at k ≥ 2
  even though a real run only takes one, and is the right reading for a stranding: a data
  outcome really does decide an IF, so "there is an outcome under which this strands" is the
  finding a workflow author wants.
- **Action duration.** Both routes model a firing as **atomic**: consume and produce in one
  step. The executor consumes at fire time and produces when the action's `Promise` settles,
  so a marking in which one node's action is in flight while another transition fires is not a
  state either route visits. It matters only for a transition whose *inhibitor* place an
  action can produce — in this net, `_halt` and `_pause`, and nothing else — so the difference
  is confined to the halt/pause window. A `proven` here is a proof about the compiled net
  under standard Petri-net firing. This is not new in M5; M4's surface had the same scope and
  did not state it.
- **Timing.** Modelled exactly by the state-class graph (VER-011 zones) and ignored by the SMT
  encoding, which only strengthens an SMT proof — timing can restrict behaviour, never add it.
- **A resumed or retried execution.** Every verdict is about markings reachable from
  `compiled.initialMarking(...)`. On resume, and on n8n's "Retry execution", the marking is
  rebuilt by the codec from `nodeExecutionStack` / `waitingExecution` (ADR 0005) —
  user-editable state that need not be reachable from M₀ — so none of these verdicts transfers
  to such a run. The report header says it.

---

## Measurements

Machine: Apple silicon, Node 26 (default V8 heap limit **4.4 GB** — it decides where
`effectiveMaxClasses` starts lowering the cap), z3 4.13.0, `LIBPETRI_Z3` unset, budget 1
unless a table says otherwise. **The absolute numbers are upper bounds**: they were taken
while another workload was on the machine, as [`docs/differential.md`](differential.md)'s
were. The ratios and — more importantly — the verdicts reproduce; the state-class graph is
deterministic, so the *class counts* are exact and `tests/verify/state-class.test.ts` pins
them.

### Proper completion, solver-free (VER-010)

Budget 1 (the default); `peak RSS` is the whole process, so ~90 MB of it is node itself.

| workflow      | nodes | classes | complete         | quiescent | paused/halted | verdict        | wall clock | peak RSS | stranded                            |
|---------------|-------|---------|------------------|-----------|---------------|----------------|------------|----------|-------------------------------------|
| linear        | 4     | 50      | yes              | 16        | 12            | PROVEN         | 11 ms      | 92 MB    |                                     |
| diamond       | 6     | 393     | yes              | 60        | 49            | PROVEN         | 10 ms      | 104 MB   |                                     |
| fanOut        | 4     | 99      | yes              | 36        | 34            | PROVEN         | 1 ms       | 104 MB   |                                     |
| multiProducer | 4     | 245     | yes              | 44        | 40            | PROVEN         | 4 ms       | 104 MB   |                                     |
| chooseBranch  | 4     | 108     | yes              | 16        | 12            | PROVEN         | 1 ms       | 105 MB   |                                     |
| ifBothOutputs | 5     | 889     | yes              | 80        | 71            | VIOLATED       | 25 ms      | 116 MB   | id:Merge/hasdata + id:Merge/ready_0 |
| chain40       | 41    | 2048    | yes              | 164       | 123           | PROVEN         | 110 ms     | 180 MB   |                                     |
| wide8         | 9     | 6151    | yes              | 2308      | 2306          | PROVEN         | 98 ms      | 209 MB   |                                     |
| switch20      | 22    | 200006  | no (parallelism) | 6         | 6             | TRUNCATED      | 32.3 s     | 2531 MB  |                                     |
| loopOverItems | 4     | 200001  | no (cycle)       | 5647      | 5472          | BOUNDED (k=21) | 4.0 s      | 3293 MB  |                                     |

`chain40` is a 40-node chain behind a trigger; `wide8` is a trigger fanning out to 8
independent siblings (`generateChain` / `generateFanOut` in `tests/verify/support.ts`). The
other eight are the fixtures in `tests/fixtures/workflows.ts`.

`loopOverItems` is the one truncated row that still carries a verdict: its graph cannot close
(a cycle's state space is unbounded), but the 194 725 classes it expanded close every run in
which its two cyclic nodes run at most **21** times in total — ten complete passes of the loop
body — and none of those strands anything. That is `bounded`, and it is not a proof: see "The
cyclic case gets a bounded verdict" below. `switch20` has nothing to count and stays
`unknown`.

The two truncated rows are also where the peak RSS lands: 2.5 GB and 3.3 GB for 200 000
classes each (the second figure includes the report's own decoding). That is the memory the
class cap is really buying, and why the cap the enumeration runs with is lowered when the heap
cannot hold it ("The class cap" below).

Read the `quiescent` column of a **truncated** row carefully: it counts only classes with
nothing enabled, never the BFS frontier (see "Truncation" below), which is why `switch20`
shows 6 quiescent out of 200 006 classes — the enumeration stopped long before the runs it
had started could come to rest. On a complete row it is the real number of markings a run can
end in, and `paused/halted` is how many of those are the designed terminals a Wait node, a
destination stop or a halt produces. On `wide8` that is 2306 of 2308: almost every way an
8-wide fan-out can come to rest is one sibling pausing the execution — which is exactly the
witness M4's query kept returning and could not classify.

### The proper-completion SMT fallback: one whole-net `deadlockFree`, structural rest set as sinks

Asked directly, of every fixture, at a 30 s timeout — including the eight a real report would
not ask at all, so the query itself is measured rather than the routing:

| workflow      | verdict  | wall clock | witness                          | decided what the graph could not? | would a report ask it? |
|---------------|----------|------------|----------------------------------|-----------------------------------|------------------------|
| linear        | unknown  | 30.2 s     |                                  | no                                | no (the graph closed)  |
| diamond       | unknown  | 30.3 s     |                                  | no                                | no (the graph closed)  |
| fanOut        | violated | 3.3 s      | a paused run (designed terminal) | no                                | no (the graph closed)  |
| multiProducer | violated | 25.1 s     | a paused run (designed terminal) | no                                | no (the graph closed)  |
| chooseBranch  | unknown  | 30.3 s     |                                  | no                                | no (the graph closed)  |
| ifBothOutputs | unknown  | 30.2 s     |                                  | no                                | no (the graph closed)  |
| chain40       | unknown  | 31.6 s     |                                  | no                                | no (the graph closed)  |
| wide8         | unknown  | 30.2 s     |                                  | no                                | no (the graph closed)  |
| switch20      | unknown  | 31.0 s     |                                  | no                                | **yes**                |
| loopOverItems | unknown  | 30.2 s     |                                  | no                                | no (the graph refuted it) |

Nought for ten. The two `violated` rows are the pause artifact §"The pause filter" exists for
— a designed terminal marking the sink clause cannot excuse without also excusing a real
stranding — so they are downgraded exactly as M4 downgraded `joinedOrDeadLettered`'s.

The last column is the M5 routing, and it is where the 30 s go or do not. Eight rows never
reach the query because the graph closed. `loopOverItems` does not close, and still does not
reach it: its explored prefix already contains 4564 quiescent classes marking a place outside
the declared sink set, so `deadlockFree(sinks = rest set)` is **false on that net** and its
`proven` — the only direction it could contribute — cannot come back. Skipping it is 30 s off
that report's wall clock for an answer already known. `switch20` is the one row where the
question is genuinely open (all six of its quiescent classes are inside the rest set), and
there the query runs and returns `unknown` at 31 s.

### The whole report, every family (30 s per SMT query, default cap)

| workflow      | checks | graph | z3 | structural | proven | violated | bounded | unknown | wall clock |
|---------------|--------|-------|----|------------|--------|----------|---------|---------|------------|
| linear        | 15     | 14    | 0  | 1          | 11     | 0        | 0       | 4       | 56 ms      |
| diamond       | 26     | 25    | 0  | 1          | 20     | 0        | 0       | 6       | 70 ms      |
| fanOut        | 15     | 14    | 0  | 1          | 11     | 0        | 0       | 4       | 31 ms      |
| multiProducer | 18     | 17    | 0  | 1          | 14     | 0        | 0       | 4       | 38 ms      |
| chooseBranch  | 24     | 23    | 0  | 1          | 20     | 0        | 0       | 4       | 43 ms      |
| ifBothOutputs | 26     | 25    | 0  | 1          | 19     | 2        | 0       | 5       | 75 ms      |
| chain40       | 126    | 125   | 0  | 1          | 85     | 0        | 0       | 41      | 2.0 s      |
| wide8         | 30     | 29    | 0  | 1          | 21     | 0        | 0       | 9       | 196 ms     |
| switch20      | 69     | 2     | 66 | 1          | 24     | 0        | 0       | 45      | 751.0 s    |
| loopOverItems | 18     | 12    | 5  | 1          | 6      | 0        | 8       | 4       | 35.2 s     |

Three things to read out of it.

**A closed graph runs no solver query on any check's route.** Eight of the ten rows show `z3 =
0` in the table, and that column counts *routes*: the whole 26-check diamond report and the
126-check 41-node chain decide every row off the graph. It is not literally zero z3 processes
— measured with a logging wrapper on `LIBPETRI_Z3`, a default `diamond` report starts **three**:
two `--version` probes and the one invariant-only run the budget family's semiflow needs
(`INVARIANT_SOLVER_TIMEOUT_MS`, 1 ms of solving). A report run without `--property budget`
starts none at all. The `unknown` column on those rows is the dead-nodes family's liveness
direction, one per node — `unknown` by design (VER-004 AC3), not by cost.

**A truncated graph is where the report gets expensive**, and the two truncating rows are
expensive for opposite reasons. `loopOverItems` spends 36 s to come back `bounded` on 8 checks
and `proven` on 6: 4 s of graph and five solver queries the bound route only reaches after the
solver has had its turn. (It was 66 s before the whole-net `deadlockFree` query stopped being
asked on a net whose graph has already refuted it — that one skip is 30 s of this row.)
`switch20` spends **12 minutes** on 66 queries, and almost all of that is one family — run
alone against the same truncated graph:

| family | checks | graph | z3 | verdicts | wall clock |
|---|---|---|---|---|---|
| `budget` | 2 | 0 | 1 | 2 proven | 37 s |
| `no-double-activation` | 22 | 0 | 22 | 22 proven | 92 s |
| `proper-completion` | 23 | 0 | 23 | 23 unknown | 64 s |
| `dead-nodes` | 22 | 2 | 20 | 22 unknown | 657 s |

Each row includes the ~31 s graph build. `no-double-activation` is the fallback working: 22
proofs the graph could not reach, at ~2.7 s a query. `proper-completion` is the fallback
failing *cheaply* — its 23 rows share **one** memoised whole-net query, which is the whole
point of the M5 shape; M4's per-place form would have paid 23 timeouts here. (`switch20` is
also the one fixture where that query is still asked at all: its six quiescent classes are
inside the rest set, so the graph has not refuted it.) `dead-nodes` is the fallback failing
slowly: the *reachable* direction is a SAT witness search, it is the direction 20 of these
nodes need, and it times out on each — 11 minutes to return nothing, which is the cost
`--property` exists to avoid.

**On `switch20` the fallback earns its keep — but not on the headline property.** Of its 24
`proven`, 23 come from z3: `placeBound(_budget, 1)` and all 22 `placeBound(X/running, 1)`.
Those are exactly the checks the graph could not decide — its 200 006 classes mark only two of
the 22 `running` places, because the 20 independent routes interleave before any of them runs
— and the solver decided them, quickly: run alone, `--property no-double-activation` on
`switch20` is 22 proofs in 92 s including the graph build, about 2.7 s per query, and
`--property budget` is 2 proofs in 37 s. What stays undecided is the whole-net `deadlockFree`
question (table above) and the dead-nodes witness search. So the honest split is: **the
proper-completion fallback decides nothing measured; the bound fallbacks decide plenty.** That
is why the fallback is kept per family rather than dropped, and why it is skipped per question
rather than per family.

### Where the class count comes from: shape, not size

| workflow | nodes | classes | complete | wall clock |
|---|---|---|---|---|
| chain, 39 nodes | 40 | 1958 | yes | 135 ms |
| chain, 40 nodes | 41 | 2048 | yes | 112 ms |
| fan-out, 7 wide | 8 | 2759 | yes | 44 ms |
| fan-out, 8 wide | 9 | 6151 | yes | 107 ms |
| fan-out, 9 wide | 10 | 13575 | yes | 268 ms |
| generated diamonds, 1 layer | 5 | 346 | yes | 5 ms |
| generated diamonds, 2 layers | 9 | 1481 | yes | 32 ms |
| generated diamonds, 3 layers | 13 | 5007 | yes | 152 ms |
| generated diamonds, 5 layers | 21 | 47924 | yes | 2.2 s |
| generated diamonds, 12 layers | 49 | 200000 | **no** | 20.7 s |

**Depth is nearly free; independent width is not.** A 41-node chain costs 2048 classes; nine
nodes arranged as a fan-out cost three times that, and each extra sibling roughly doubles it.
That is NU-053's statement about the graph exactly: it has no partial-order reduction, so `n`
independent branches interleave combinatorially. It is also why the useful ceiling is a
statement about shape rather than node count — the 21-node generated workflow (five diamonds
in series) closes at 47 924 classes in 2.2 s, and the 49-node one does not close at all.

**Every table above is k = 1**, which is what `verify()` compiles with by default. The budget
is a third axis and it is not a gentle one: a second unit lets independent branches be in
flight together, which is the same combinatorial axis as width.

| workflow | k = 1 | k = 2 | k = 4 |
|---|---|---|---|
| diamond (6 nodes) | 393 | 1551 | 3649 |
| partialRequired (6) | 958 | 4894 | 13 575 |
| fanOut4 (6) | 2531 | 19 872 | 116 705 |
| wide8 (9) | 6151 | 73 923 (2.2 s) | **truncated** (22 s) |
| chain40 (41) | 2048 | 31 448 (2.9 s) | **truncated** (28 s) |
| generated, 3 layers (13) | 5007 | 43 938 (2.1 s) | **truncated** (17 s) |

So "41 nodes closes in ~110 ms" is a k = 1 statement. At k = 2 the same chain still closes, at
15× the classes; at k = 4 it does not, and neither does a 9-node fan-out. `tests/verify/state-class.test.ts`
pins the k = 2 counts for `diamond` and `chain40` so this axis cannot go stale unnoticed.

### The class cap, what it costs to reach it, and what bounds the memory

| cap | `switch20` | `loopOverItems` | `userCycle` |
|---|---|---|---|
| 25 000 | 3.7 s | 0.4 s | 0.2 s |
| 50 000 | 9.6 s | 0.8 s | 0.5 s |
| 100 000 | 16.0 s | 1.8 s | 1.0 s |
| 200 000 (default) | 30.9 s | 3.9 s | 2.3 s |

The default `maxClasses` is **200 000**: three orders of magnitude above every acyclic fixture
without independent parallelism, and a worst measured cost of 31 s — the same order as the
60 s the SMT route spends per *query*, and paid once for the whole report rather than once per
place. `--max-classes 0` turns the route off entirely, which is M4's surface.

**A class cap bounds the class count; only memory bounds the memory.** Peak RSS, measured on
the enumeration alone:

| net | flat places | classes | peak RSS | per class | wall clock |
|---|---|---|---|---|---|
| `loopOverItems` | 48 | 200 001 | 877 MB | 4.4 kB | 3.9 s |
| `switch20` | 240 | 200 006 | 2.48 GB | 12.4 kB | 33.1 s |
| generated, 12 layers | 599 | 50 000 | 701 MB | 14.0 kB | 4.5 s |
| generated, 12 layers | 599 | 100 000 | 1.28 GB | 12.8 kB | 9.0 s |
| generated, 12 layers | 599 | 200 000 | 2.41 GB | 12.1 kB | 19.8 s |

The cost is **per class**, not proportional to the net: a 240-place net at 200 000 classes
costs as much as a 599-place one, and the small cyclic net a third of that. So the default cap
is also a memory bound of about 2.5 GB — comfortable under this machine's 4.4 GB V8 heap limit
and fatal under a 1 GB container's, where V8 would abort the process exactly as the P-invariant
pipeline does. `StateSpace.explore` therefore lowers the cap it runs with to
`0.75 × heapLimit / 12.5 kB` when that is smaller than the one asked for (`effectiveMaxClasses`),
and the report prints both: `TRUNCATED at the 70000-class cap (lowered from 200000 to fit the
heap)`. At the default heap limit here nothing is lowered.

On a **cyclic** workflow the cap buys something the wall clock does not show: the bound, which
grows with it (5 → 11 → 21 cyclic-node runs on `loopOverItems` at 2 000 → 20 000 → 200 000).
The table under "The cyclic case gets a bounded verdict" is the one to read there. Its wall
clocks include the 0/1-weight shortest-path pass that computes the bound, which is inside the
noise of the enumeration itself.

### The pipeline before z3, which is paid once, only for the semiflow, and refused above a size

Flatten, structural pre-check, P-invariant and semiflow enumeration — everything libpetri does
before z3 sees a script. In M4 **every** query paid this again; since M5 a report whose graph
closed pays it once, lazily, and only for the budget family's semiflow check (the one claim the
solver-free route cannot make), and a report that does not select `budget` never touches it.

Measured with the solver budget at 1 ms, so the number is the pipeline and nothing else. The
generated family is `generateWorkflow(layers)`: `layers` diamonds in series, `4·layers + 1`
nodes, two join inputs per layer.

| workflow | nodes | flat places | join inputs | phases 1–3 | peak RSS |
|---|---|---|---|---|---|
| fan-out, 8 wide | 9 | 84 | 0 | 84 ms | 84 MB |
| fan-out, 9 wide | 10 | 93 | 0 | 112 ms | 85 MB |
| generated, 3 layers | 13 | 158 | 6 | 399 ms | 126 MB |
| generated, 5 layers | 21 | 256 | 10 | 2.8 s | 383 MB |
| generated, 6 layers | 25 | 305 | 12 | 15.4 s | 842 MB |
| generated, 7 layers | 29 | 354 | 14 | 118 s | 2.4 GB |
| chain, 41 nodes | 41 | 411 | 0 | 1.8 s | 214 MB |
| generated, 8 layers | 33 | 403 | 16 | **> 7 min** (killed) | — |
| generated, 9 layers | 37 | 452 | 18 | **heap exhausted** | — |
| generated, 12 layers | 49 | 599 | 24 | **heap exhausted** | — |

**The wall is joins, not nodes.** A 41-node chain pays 1.8 s; a 29-node workflow with seven
joins pays 118 s and 2.4 GB, and four more joins abort the process. The growth is roughly ×7
per added diamond layer, which is what an enumeration of minimal conservation laws does.

**And the abort cannot be caught.** `FATAL ERROR: Ineffective mark-compacts near heap limit`
kills node with SIGABRT: `verify()` returns nothing, the CLI prints nothing and exits 134, and
none of the four documented exit codes happens. That is why the route is refused above the
measured ceiling ("The SMT route is refused above a measured size" above) rather than tried
and handled — there is nothing to handle. On a net past the ceiling every row that would have
used a query is `unknown` with the ceiling as its reason, and the solver-free route still
answers everything a closed graph answers.

### M4's per-query SMT table

Kept, because it is the measurement of what the **fallback** costs and of what VER-007 buys:
`npx tsx tests/verify/measure.ts --timeout 30000`. Its findings that still hold:

- **VER-007 is not optional for the semiflow.** With `semiflowInvariants(false)`,
  `placeBound(_budget, k)` goes from `proven` in 204 ms to `unknown` at 30 s, and
  `mutualExclusion` with it, on the 6-node diamond and on the 21-node workflow alike.
  `placeBound(X/running, 1)` survives, because `X/idle + X/running = 1` is in the null-space
  basis. Semiflows are on by default and turning them off is a loss, not a trade.
- **The SAT direction is a search.** A witness closes only for shallow shapes: ~700 ms for a
  node one hop from the trigger, `unknown` at 30 s for anything behind a join — which is why
  the graph, which enumerates rather than searches, answers those instantly *when it closes*.
  On a graph that truncates before reaching a node, neither route finds the witness and the
  row is `unknown` from the solver instead.
- **The proof direction is cheap where it closes,** and stays cheap at the sizes the graph
  cannot. `placeBound` and `unreachable`-proven come back in 90–300 ms at 4–6 nodes, 5–7 s at
  21, and ~2.9 s per query on `switch20`'s 22 nodes — which is the fallback doing exactly the
  job it is kept for.

---

## Where the verifier is useful, and where it is not

**Useful today, on any workflow whose state-class graph closes** — every acyclic fixture here,
a 41-node chain, an 8-wide fan-out, a 21-node five-diamond workflow, all at the default k = 1
(the budget is a real axis: see the k table above):

- **Proper completion.** The headline question, `proven` or `violated`, in 1–111 ms at these
  sizes and 2.2 s at 21 nodes. A violation names the node and the input and carries the firing
  sequence that reaches the stuck marking. This is the check the project exists for, and it
  now works.
- **Dead nodes.** A node no execution can reach is proven unreachable and reported by name,
  for every node of the workflow in one graph pass. A real class of n8n bug: an all-required
  Merge with an unwired lower input, a branch left disconnected on the canvas.
- **The structural family** — the budget bound and its two-phase P-semiflow, the per-node
  `X/running` mutex, the retry bound (both halves), the join-slot discipline, the OR-round
  arrival bound. Free once the graph is built, except the semiflow, which costs the pipeline
  and is therefore refused above the size ceiling (a big branchy net gets `unknown` there and
  keeps everything else).
- **Mutual exclusion**, including `--all-pairs`: one pass over the classes covers every pair,
  so 210 pairs at 21 nodes cost what one pair costs. Under M4 that was 210 separate queries.

**Partly useful, and honest about which part:**

- **A workflow with a cycle.** `loopOverItems` truncates at 200 000 classes in 4.0 s — the
  reachable state space of a loop is unbounded, so no cap can close it and there is no proof
  to be had. What comes back is `bounded`: no branch strands in any run where the workflow's
  cyclic nodes run at most 21 times in total, which for its two-node loop is at least ten
  complete passes of the body (135 runs, 67 passes, on a plain user cycle). A stranding
  *inside* that prefix is still reported as a full `violated` finding. See "The cyclic case
  gets a bounded verdict" below for why it is exact, and why a compiler-side loop cap was
  rejected.

**Not useful today:**

- **Any workflow with heavy independent parallelism.** `switch20` — twenty independent routes
  — truncates at 200 000 classes in ~33 s, has no loop to bound, and comes back `unknown`.
  Raising `--max-classes` may close a borderline case; it will not close this one. This is the
  one limit M5 leaves whole, and NU-053 names its cause: the graph has no partial-order
  reduction.
- **A whole report on a truncated graph, at the default timeout.** The per-node families each
  fall back to one query, and the ones the solver cannot close pay the full timeout: the
  `switch20` report is minutes, not seconds, and most of it is `dead-nodes`, whose witness
  searches return nothing. The proofs it does get are real and quick
  (`no-double-activation`: 22 of them at ~2.9 s a query). Use `--timeout` to bound it, or
  `--property` to run only the families whose fallback closes, or `--smt-fallback off` to
  keep only what the graph decides.
- **The proper-completion SMT fallback.** Nought for ten (table above): `unknown` on eight
  fixtures at 30 s, and `violated` on two with a witness that is a paused run — the artifact
  the pause filter exists to classify and a sink clause cannot. Since M5 it is not even asked
  where the graph has already refuted it, which is most cyclic workflows. Where it *is* asked
  its `proven` would transfer, and it has never come back. The *other* families' fallbacks are
  a different story and do decide: 23 of `switch20`'s 24 proofs are z3's.
- **A big branchy workflow's semiflow and per-node fallbacks.** Above 12 join inputs or 450
  flat places the SMT route is refused outright, because the pipeline that runs before z3
  aborts the process on a heap exhaustion. Those rows come back `unknown` naming the ceiling;
  `--smt-fallback force` runs them anyway, at that risk.
- **Liveness, at all.** The route reaches a node instantly; that is not a proof that a real run
  does (VER-004 AC3), so it is reported `unknown` by design. The *dead* answer, the one that
  is a finding, is free.
- **Anything about order, values, action duration or a resumed marking.** See "What no verdict
  can say".

---

## Truncation is the honest limit — and it is graded, not a blank

A truncated graph never carries a `proven`. What it carries instead depends on *why* it
stopped, and the header says the cap, the classes explored, the classes expanded and the
cause:

```
  state space  200001 classes in 4.0s, 5647 quiescent (5472 paused or halted),
               TRUNCATED at the 200000-class cap — the workflow has a cycle, so its state
               space is unbounded; 194725 classes expanded, closing every run of at most
               21 cyclic-node run(s) across 2 cyclic node(s)
```

**The cause is measured, not inferred.** There are four, and only two of them are NU-053's:

| cause | when | what to do |
|---|---|---|
| `cycle` | the workflow has one, so its state space is unbounded | nothing closes it; read the `bounded` verdict |
| `parallelism` | no cycle, and some node has two or more distinct successors | raise `--max-classes`, or verify a smaller slice |
| `cap` | no cycle and no branching node either | raise `--max-classes`: nothing about the shape explains it |
| `off` | `--max-classes 0` | the solver-free route was switched off on purpose (M4's surface) |

The `cap` and `off` rows exist because the alternative was reporting "independent parallel
branches blow the class count up combinatorially (NU-053)" for a four-node chain at a 10-class
cap, which sends a reader looking for a fan-out the workflow does not have.

Four rules it follows:

1. **A truncated graph never carries a `proven`.** This is asserted at three caps on both
   truncating fixtures in `tests/verify/state-class.test.ts`, because it is the one failure
   mode that would make the surface worthless.
2. **A stranding found before truncation is still real** and *is* reported: a quiescent class
   of the explored prefix is quiescent and reachable. Only its absence proves nothing. The
   same holds for a place bound exceeded, for two `running` places co-marked, and for a
   `running` place *reached*, so a truncated graph decides every violation it sees — and,
   where the witness is in the prefix, saves the solver query outright. Where it is not, the
   fallback still runs: `switch20`'s 200 006 classes mark only two of its 22 `running`
   places, so 20 dead-node queries and 22 bound queries still go to z3.
3. **The frontier is not evidence.** Classes still queued when the BFS stops have no computed
   successors, so "no successors" would falsely read as quiescent. The route reads
   `enabledTransitions` instead, which is decisive whatever the BFS did, and only adds
   successor-free classes inside the **expanded prefix** — where a class with enabled
   transitions and no successor is a genuine time-dead deadlock rather than an unexplored
   frontier class.
4. **What the prefix does close is said exactly.** On a cyclic workflow that is the bound
   below; on an acyclic one there is nothing to count and the verdict stays `unknown`.

### The cyclic case gets a bounded verdict, which is not a proof and does not pretend to be

A cyclic workflow's reachable state space is infinite, so `proven` is out of reach at every
cap. `unknown` is not the whole of what is known, though: the explored prefix closes an exact
number of **runs of the workflow's cyclic nodes**, and `bounded` says so.

> **no branch is ever left stranded — BOUNDED**
> not a proof: the state-class graph truncated at its 200000-class cap (200001 classes,
> 194725 of them expanded, in 3.9s). What *was* established is bounded and exact — every run
> in which this workflow's cyclic nodes run at most 21 time(s) in total (at least 10 complete
> pass(es) of the 2 cyclic node(s) on the cycle, and more of a run that visits only some of
> them) was enumerated in full, together with every marking such a run can come to rest in,
> and none of them breaks this check. A run with more cyclic-node runs than that was not
> explored. The workflow has a cycle, so its reachable state space is unbounded (NU-053) and
> no class cap can close it; raising --max-classes raises the bound rather than reaching a
> proof. The SMT route: the whole-net deadlockFree fallback (VER-002, structural rest set as
> sinks) was not asked: the graph already reached 4564 quiescent marking(s) holding a place
> outside that sink set (a designed terminal whose arrival the marking codec writes back), so
> the query is false on this net and can never return proven — the only direction it could
> add.

**What the number counts, exactly.** The unit is one firing of the `X_run` of a node **on a
cycle**, summed over all of them — not one pass of the loop body. `loopOverItems` compiles two
cyclic nodes (`id:Loop/run` and `id:Body/run`), so one pass of its body spends two, and `k =
21` guarantees **10** complete passes, not 21. The report prints both figures and never calls
the raw count an iteration count; `report.stateSpace.loopSteps` is the divisor.

**Why it is exact.** libpetri's BFS pops in FIFO order and appends each newly discovered class
to `stateClasses()`, so the classes it **expanded** are a prefix `A` of that array and the
rest, `B`, is frontier. Let `iter(C)` be the fewest firings of a *loop transition* — the
`X_run` of a node on a cycle — on any path to `C` through recorded edges, and take
`k = min{ iter(C) : C ∈ B } − 1` (a class with nothing enabled is in `A` wherever it sits: it
has no successors to compute). A run firing at most `k` loop transitions only reaches classes
with `iter ≤ k`; none of those is in `B`, so each is in `A` and had all its successors
recorded. Every such run — and every marking it can come to rest in — was therefore
enumerated and classified. `iter` is a 0/1-weight shortest path, so it is one pass of Dial's
algorithm over the graph, and it is free next to the enumeration: on `loopOverItems` at the
default cap the build alone is 4.05 s and the whole exploration with the bound is 4.08 s,
which is inside the run-to-run noise (`state-class.ts`, `closedCyclicRuns`).

The argument leans on one property of libpetri that nothing else here would notice if it
changed — that its exploration is a FIFO BFS appending each newly discovered class, so the
expanded classes really are a prefix — and `tests/verify/state-class.test.ts` asserts that
directly, against an independently computed BFS distance.

**What it is and is not.** It is a verdict of its own: counted apart from the proofs, printed
in its own section, and failed by `--strict`. It is offered only where the count means
something — a workflow with a cycle, and a prefix that closes at least one whole cyclic-node
run; `k = 0` is refused, because "nothing goes wrong in runs where the loop never runs" is not
a statement about the loop. The **other** truncation shapes have nothing to count and stay
`unknown`; nothing borrows the cyclic case's bound.

| workflow | cap | classes | expanded | cyclic nodes | cyclic-node runs closed | complete passes | verdict | wall clock |
|---|---|---|---|---|---|---|---|---|
| loopOverItems | 2 000 | 2000 | 1834 | 2 | 5 | 2 | BOUNDED | 28 ms |
| loopOverItems | 20 000 | 20002 | 19158 | 2 | 11 | 5 | BOUNDED | 342 ms |
| loopOverItems | 200 000 | 200001 | 194725 | 2 | **21** | **10** | BOUNDED | 4.2 s |
| userCycle | 2 000 | 2000 | 1943 | 2 | 13 | 6 | BOUNDED | 17 ms |
| userCycle | 20 000 | 20000 | 19837 | 2 | 42 | 21 | BOUNDED | 185 ms |
| userCycle | 200 000 | 200001 | 199504 | 2 | **135** | **67** | BOUNDED | 2.0 s |

`loopOverItems` is n8n's most common cyclic shape, and ten complete passes of its body is a
real statement about it. Raising `--max-classes` raises the bound and never reaches a proof.

**A stranding inside the prefix is still a full finding.** A quiescent class of the explored
prefix is quiescent (its enabled set was computed when the class was built) and reachable (it
was discovered as a successor), so it is real whatever the BFS did next. The
`cyclicStranding` fixture — `loopOverItems`' loop with the unbalanced join hanging off its
`done` output — comes back **`violated`** at every cap, naming `M/ready_0`. Truncation costs
the proof, not the detection.

**A compile option bounding loop iterations was considered and rejected**, and the verdict
above is deliberately not it. Capping the loop in the compiler would change the net the
scheduler executes, which is README's first principle, and a result about a net whose loop is
capped at *n* iterations is about **that net**, not about the workflow. The route above caps
nothing and modifies no net: it reports how much of the *unmodified* net's behaviour the
enumeration covered. Analysing the acyclic condensation was rejected for a related reason —
the strandings a loop workflow can have are mostly *at* the loop, so a verdict about the
condensation would be silent about exactly the question. Turning `bounded` into `proven`
needs a cutoff or coverability argument upstream, not a smaller net.

**What would move each limit, in order of value.**

1. **Partial-order reduction in libpetri's state-class graph.** NU-053 names its absence
   outright. Independent branches are exactly what a workflow engine produces, so a stubborn
   or ample-set reduction is the single change that would take the useful ceiling from "8
   independent branches" to "as many as the workflow has". Upstream.
2. **A coverability route for cyclic workflows** — a cutoff or Karp-Miller argument proving
   the loop's residue is the same after `n` and `n + 1` iterations. That would turn today's
   `bounded` into a `proven` on Loop Over Items, n8n's most common cyclic shape, without
   changing the net. Upstream. Until then the cyclic-node-run bound is what is sound to say,
   and it is said.
3. **Interning the marking key.** The graph's dedup key is the marking's string form, so a
   200 000-class exploration of a 22-node net spends much of its 31 s building strings. It is
   also ~12 kB of peak RSS per class, which is what makes the default cap a 2.5 GB memory
   bound and forces `effectiveMaxClasses` to lower it on a small heap. VER-012's
   implementation notes already describe hash-consing for the ν-aware variant. It is also what
   raises the bound on a cyclic workflow, since the bound is a function of how many classes
   fit in the cap. Upstream.
4. **A sparse incidence pipeline in libpetri**, which is what exhausts the heap above 14 join
   inputs. It blocks only the budget semiflow and the per-node fallbacks rather than the whole
   report, so it dropped from first place to fourth — but it is why a big branchy workflow
   cannot have its conservation law validated, and why the SMT route has a size ceiling at
   all. A pipeline that returned an error instead of aborting the process would already be
   worth having, even without the sparsity.

---

## Reproducing

```bash
cd typescript
npx tsx tests/verify/measure-graph.ts                       # the solver-free + bound tables (no z3 needed)
npx tsx tests/verify/measure-graph.ts --smt --timeout 30000 # + the fallback and the routing tables
npx tsx tests/verify/measure.ts --timeout 30000             # the SMT per-query sweep
npx vitest run tests/verify                                 # the committed gate
npx tsx tests/verify/measure.ts --sizes 'large (49'         # watch the pipeline exhaust the heap
```

The last line is the measurement behind the size ceiling, and it really does abort: `measure.ts`
drives `SmtVerifier` directly, so it is not subject to `verify()`'s refusal and node dies with
`FATAL ERROR: Ineffective mark-compacts near heap limit`. Through `verify()` the same workflow
reports `unknown` naming the ceiling in ~120 ms; `--smt-fallback force` reproduces the abort
there too, which is what the flag is for.

The last table `measure-graph.ts` prints — the whole report, every family, end to end — takes
**minutes** on `switch20`, and that is the measurement rather than a defect: a graph that
truncates on an acyclic workflow sends the per-node families to the solver, one query each.
Where the solver closes them it is quick (`no-double-activation`'s 22 `placeBound` proofs cost
96 s including the graph build, so ~2.9 s each); where it cannot — the dead-nodes witness
search and the whole-net quiescence question — each row pays its full timeout.

`measure-graph.ts` runs the graph table with the solver timeout set to 1 ms, so no verdict in
it can come from z3. `measure.ts` samples **one representative query per property family per
size** rather than running whole families: a family costs (queries × per-query cost), the
second factor is what varies with the workflow, and the first is printed alongside so the
product is readable.

Two rules the SMT sampler follows, because getting either wrong reports the opposite of what
the row says: the `[dead]` sample is a node the compiler marks unreachable, and the `[live]`
one is the **last node in canvas order that the start node can reach** — not simply the last
node, which on the `orphan` fixture is `OrphanChild`, i.e. a dead node under a liveness label.

The generated workflows come from `generateWorkflow(layers)` in `tests/verify/support.ts`
(`layers` diamonds in series, `4·layers + 1` nodes with one join per layer), and from
`generateChain(n)` / `generateFanOut(n)`, which isolate depth and width respectively.
