# ADR 0007 — The verification surface: what the property table proves, and what it cannot

Status: accepted (2026-09-06). Milestone M4. Builds on
[ADR 0004](0004-two-phase-budget.md) (the two-phase gadget is what makes the budget and the
exclusion questions expressible at all) and on the README's "The model".

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
   `timeout`, and the properties in `smt-property.ts`. Nothing is added to libpetri here.
3. **`unknown` is a first-class verdict.** Without z3 every verdict is `unknown` with a
   reason naming `PATH` and `LIBPETRI_Z3` (VER-013), never a throw — and with z3, a query
   the solver cannot close is `unknown` too, reported in its own section of the table
   rather than folded into "no findings".

## Decision

### 1. Six property families, each a named check with its own verdict

| Family | libpetri property | Desirable answer |
|---|---|---|
| proper completion | `joinedOrDeadLettered(p)` per join-input `ready_i` and per edge data place, sinks `_pause`, `_halted`; plus `placeBound(ready_i, capacity)` per join input | no reachable quiescent marking holds a token there; no more arrivals pile up than the gadget can pair |
| dead nodes | `unreachable({X/running})` per node | *no verdict* — the check reports `violated` when libpetri proves the unreachability, and `unknown` otherwise (§5) |
| no double activation | `placeBound(X/running, 1)` per node | proven |
| budget | `placeBound(_budget, k)` plus the two-phase P-semiflow | proven, and the semiflow is among the validated invariants |
| retry bound | `placeBound(X/tries, maxTries − 1)` per retrying node, **plus** a structural check that no transition produces `X/tries` | both proven — the place bound alone does not entail the attempt bound (§5a) |
| mutual exclusion | `mutualExclusion(A/running, B/running)` per caller-supplied pair | proven (at k = 1, for every pair) |

### 2. Proper completion uses `joinedOrDeadLettered`, not `deadlockFree`, and declares exactly two sinks

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

### 3. The declared sinks are inert on `joinedOrDeadLettered`, so a paused witness is downgraded

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

### 4. The subject of a proper-completion query is the `ready_i` place, not only the edge place

ADR 0003's arm transition drains an edge place into `ready_i` as soon as the input's slot is
free. So an arrival that will never be consumed does not sit on the edge — the edge is always
drained — it sits one place downstream, on `ready_i`. `tests/spikes/verification.test.ts`
pinned that in M1 on a hand-written join: the unbalanced shape is `violated` on `ready_0` and
`proven` on the edge place feeding it. Both are queried, and the M1 spike is why.

### 5. The dead-nodes check reports one direction only, and the report says so

`unreachable({X/running})` *proven* means the node can never run — the finding. The check
therefore reports `violated`, and `PropertyCheck.query` carries libpetri's own verdict
alongside, so the inversion is visible rather than implied.

The other direction is **not** a verdict. libpetri's `violated` is a firing sequence in an
abstraction that is untimed, priority-blind and value-blind, where every `xor` branch of a
router is available whatever the data (VER-004 AC2) — on `Trigger → IF → A` the solver
reaches `A` through a branch a real run may never take. VER-004 AC3 licenses the proof
direction only, so a node the solver reaches is reported `unknown` with that reason, never
`proven`, and it is not counted among the proofs. The report says "produced a firing
sequence" only when `counterexampleConfirmed === true`.

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

- **Order.** The SMT encoding does not model priority (VER-004), so nothing about n8n's
  depth-first walk, `executionIndex`, or any ordering row of `docs/divergences.md` is
  provable here. The divergence register's ordering claims rest on the differ
  (`docs/differential.md`), not on this.
- **Values.** The encoding is value-blind. Every `xor` branch of a routing transition is
  explored, so "the IF sends data left" and "the IF sends data right" are both reachable —
  which is sound (it over-approximates) and is why mutual exclusion of two IF branches is
  *violated* at k ≥ 2 even though a real run only takes one.
- **Timing.** Ignored, which strengthens a proof: timing can restrict behaviour, never add
  it.
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

## Consequences

**What closes, and what does not.** The measurements are in
[`docs/verification.md`](../verification.md); the shape of the result is:

- Every **reachability-safety** query whose answer is *proven* — `placeBound` (the budget,
  the running mutex, the retry bound, the arrival bound), `mutualExclusion` at k = 1,
  `unreachable` on a node that really is dead — closes in a few hundred milliseconds on a
  small workflow.
- Every query whose answer is a **SAT witness** — a reachable node, a violated exclusion — is
  a search, and it closes only for shallow shapes: under a second for a node one hop from the
  trigger, `unknown` at 30–60 s for anything behind a join. And where it does close, the
  answer is about the abstraction (§5), so the dead-nodes family reports it as `unknown`.
- Every **quiescence** query on a join-input `ready_i` place is `unknown`, on a workflow with
  a stranding and on one without, up to 600 s. The property is right and the encoding does
  not answer it at this net size. Removing `_halt_reap`'s reset arcs — which is what drops
  `free_i + ready_i = 1` through the H1 guard — recovers every invariant (13 found, 0
  dropped) and the query still does not close, so the missing law is not the whole story: the
  net is not structurally bounded either way, because `X/done`, `X/skipped` and the other
  markers are produced and never consumed.
- The **scaling wall is the pipeline, not z3.** Phases 1–3 (flatten, structural pre-check,
  P-invariants and semiflows) cost 26–73 ms at 4–6 nodes, 2.9 s at 21 nodes, and at 49 nodes
  exhaust the default 4 GB V8 heap after ~3 minutes without reaching the solver at all. Every
  query pays them again; they are not cached across queries.
- **VER-007 carries the budget checks.** With `semiflowInvariants(false)`,
  `placeBound(_budget, k)` and `mutualExclusion` go from `proven` in ~220 ms to `unknown` at
  30 s, on the 6-node diamond and on a 21-node workflow alike. `placeBound(X/running, 1)`
  survives, because `X/idle + X/running = 1` is in the null-space basis. Semiflows are on by
  default and turning them off is not a speed/precision trade — it is a loss.

So the honest characterisation of this milestone's verifier is: **it proves the structural
invariants of the model, it bounds how far a join input can fill, and it finds dead nodes —
on workflows up to roughly 25 nodes.** It does not, today, decide the headline
proper-completion question on a real compiled workflow. Both halves are in the table, and the
`unknown` section is what keeps the difference visible.

**A weaker question beside the right one — and it closes only where it cannot fail.** Since
the quiescence query on `ready_i` is `unknown` either way, the proper-completion family also
asks `placeBound(ready_i, capacity)` — how many arrivals can queue on that input. Measured,
the two forms behave oppositely:

- a **join slot** (capacity 1) is `proven` in ~300 ms, and cannot be violated on a net this
  compiler produces: every `arm` consumes `free_i` and only `X_start` / `X_skip` refund it, so
  `free_i + ready_i ≤ 1` holds by construction. The query re-checks the gadget against the
  built net — worth its 300 ms, and not a detector for anything;
- an **OR round** (capacity `n`) is the form with a reachable violation, i.e. the query
  `docs/divergences.md` row #8 names — and it is `unknown` at 30 s on the smallest OR shape a
  compiled workflow can have.

So this family has no working detector for the arrival-count class today. The check's name and
explanation say which of the two questions each row is, and row #8 has been amended.

**A verified proof is worth more than a fast one.** Certificate checking stays on
(libpetri's default): a `proven` verdict on the flat encoding is re-validated against the
unstrengthened step relation in a second z3 run, and a certificate that fails downgrades to
`unknown`. Turning it off would roughly halve the cost of the proofs that do close, and it
is not worth it.

**Semiflows are on by default** (VER-007). The net has reset arcs (`_halt_reap`) and
consume-all inputs (`all(X/hasdata)`), and every null-space basis row whose support touches
one is dropped by libpetri's H1 guard — on the diamond, the two rows dropped are
`free_i + ready_i = 1`, which is precisely the law a join-input query needs. The semiflow
enumeration returns them as minimal laws and they pass the same exact re-validation, so
turning VER-007 off is strictly worse here. Measured: it does not, on its own, make the
join-input query close.

## Evidence

- `tests/spikes/verification.test.ts` (M1): `joinedOrDeadLettered` on a hand-written join is
  `violated` on `ready_0` for the unbalanced shape and `proven` on the edge place; the
  balanced diamond is `proven` on all three; `placeBound(_budget, k)` proven at k ∈ {1, 2},
  `mutualExclusion(A/running, B/running)` proven at k = 1 and violated at k = 2,
  `placeBound(X/running, 1)` proven with the `X/idle` mutex and violated without it, and a
  self-loop budget proven trivially with nothing to state exclusion on.
- `tests/verify/properties.test.ts` (M4): the same six families against the nets `compile()`
  produces, including the pinned limits — the join-input query answering `unknown` on a
  fixture with a stranding *and* on one without, the OR-round arrival bound answering
  `unknown` on the smallest OR shape, and a node behind a join answering `unknown`. Those
  assertions fail if a limit ever moves, which forces `docs/verification.md` to be
  re-measured. It also pins the two verdicts that must never be `proven`: no dead-nodes check
  may be, and a second trigger must not be a finding.
- `tests/verify/no-z3.test.ts`: `LIBPETRI_Z3` pointed at a path that does not exist; every
  verdict `unknown`, every reason naming `PATH` and `LIBPETRI_Z3`, nothing thrown, and the
  structural semiflow check still `proven` because the invariants come from the pipeline and
  not from the solver.
- `tests/verify/measure.ts` → [`docs/verification.md`](../verification.md): per-query wall
  clock at four workflow sizes (including the smallest OR-round shape), with semiflows on and
  off, and the flat transition count of each compiled net. Its `[live]` dead-node sample is
  the last *reachable* node, not the last node — picking the latter reported a deadness proof
  under a liveness label in the first revision of that document.
