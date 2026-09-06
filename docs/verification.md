# Verification — what `verify(workflow)` proves, and what it costs

Milestone M4. The design decisions are in [ADR 0007](adr/0007-verification.md); this file is
the honest measurement: what each property establishes, where it stops working, and at which
workflow size.

`verify()` runs against **the net the scheduler executes** — `compile(workflow).net`, actions
bound, the same object `PetriScheduler` hands to `PrecompiledNetExecutor`. There is no
verification net (README "Principles", rule 1).

```ts
import { verify } from 'n8n-libpetri/verify';

const report = await verify(description, { budget: 2, timeoutMs: 60_000 });
console.log(report.counts);      // { proven, violated, unknown }
for (const check of report.checks) console.log(check.name, check.verdict, check.explanation);
```

```
n8n-libpetri verify my-workflow.json --budget 2 --property proper-completion --timeout 60000
```

Exit codes, which are the whole of the CI contract:

| code | meaning |
|---|---|
| 0 | nothing came back `violated` (and, under `--strict`, nothing came back `unknown`) |
| 1 | a finding — or, under `--strict`, an undecided check |
| 2 | usage or input error |
| 3 | **no usable z3 resolved, so no query ran at all** (VER-013) |

Without `--strict` an `unknown` never fails the run — it is not a finding — but it gets its
own section of the table, because a run whose expensive property did not close must not read
as a clean bill of health. Code 3 exists for the same reason one step further out: a run in
which *nothing* was verified must not be indistinguishable from a clean one at the exit code,
which is the only thing a CI job reads.

Two more things the report carries, because they change what a verdict is *about*:

- **Guessed node shapes.** A workflow JSON export has no node type descriptions, so the CLI
  resolves port counts from `--node-types`, a short built-in table, and finally the
  connections (ADR 0007 §8). Every guess is a warning on stderr **and** a `shapeWarnings`
  entry in the report, printed above the table and present in `--json`: a guessed input or
  output count decides the join versus the direct form, so a guessed net may not be quite the
  workflow.
- **The scope of every verdict: the fresh initial marking.** Each query starts from
  `compiled.initialMarking(...)`, so a `proven` means "on every marking reachable from M₀".
  The scheduler does not always start there — on resume, and on n8n's "Retry execution", the
  marking is rebuilt by the codec from `nodeExecutionStack` / `waitingExecution` (README
  "Initial marking and the marking codec"), which is user-editable state and need not be
  reachable from M₀ at all. No verdict here covers such a run. The report header says so.

---

## The six properties

| # | Property | Query | `proven` means | Cannot say |
|---|---|---|---|---|
| 1 | proper completion | `joinedOrDeadLettered(p)` per join-input `ready_i` and per edge data place, sinks `_pause` + `_halted` | no reachable quiescent marking leaves an arrival waiting there | nothing about *which* branch strands first, or about timing |
| 1b | arrival bound | `placeBound(ready_i, capacity)` per join input — 1 for a join slot, `n` for an OR round | on a **join slot**: the slot discipline of ADR 0003 holds on the compiled net | on a join slot it *cannot* fail (see below); on an **OR round**, the form where it could, it does not close |
| 2 | dead nodes | `unreachable({X/running})` per node | — the check has no `proven`: libpetri's `proven` means the node can never run, which is the *finding*, so the check reports `violated` | that a node **is** live: libpetri's `violated` is a witness in a priority- and value-blind abstraction, so it is reported `unknown` |
| 3 | no double activation | `placeBound(X/running, 1)` per node | two activations of one node can never overlap | nothing about two *different* nodes (that is #6) |
| 4 | budget | `placeBound(_budget, k)` + the two-phase P-semiflow | at most `k` activations hold a unit at once, and the unit is conserved | nothing about *which* `k` nodes; nothing about order |
| 5 | retry bound | `placeBound(X/tries, maxTries − 1)` **and** a structural check that nothing produces `X/tries` | at most `maxTries` attempts — but only the conjunction says that (see below) | nothing about *why* a retry happened (value-blind) |
| 6 | mutual exclusion | `mutualExclusion(A/running, B/running)` per pair | the two nodes never run at once | nothing about which runs first |

### Why proper completion, and not deadlock freedom

`joinedOrDeadLettered(p)` encodes "reachable ∧ quiescent ∧ `M(p) ≥ 1`" for **any** place —
the ν-net wording in NU-040 is about intent, not about the encoding. That is workflow-net
proper completion for `p`: *did anything get left behind when the net stopped?*

The whole-net properties — `deadlockFree`, and the `terminatesAtSink` VER-002 added beside
it — answer a different and, here, useless question. A *successful* execution of a compiled
workflow quiesces holding a great many tokens on purpose: every `X/idle`, every `X/done` and
`X/skipped` marker, the refunded `_budget` units, every unspent `X/tries`, every `empty`
token on an edge whose consumer already skipped. "Nothing was left behind anywhere" is
therefore violated by every clean run, and making it hold would mean declaring most of the
net's places sinks. And a run that strands one branch while another finishes is not a
deadlock at all — the net quiesces, which is how every execution ends.

`_pause` and `_halted` are declared as the **only** sinks (VER-002) because they are the two
*designed* terminal markings (README "Retries, halt, cancellation"). A marking holding either
is terminal on purpose, and a token still on a `ready_i` place there is the marking codec's
business (ADR 0005), not a defect.

### The declared sinks are inert on this property, and what stands in for them

`joinedOrDeadLettered` carries **no sink clause by design** — NU-040 AC4, in libpetri's own
encoder: *"a declared sink must not excuse a stranded group"*. Only `deadlockFree` and
`terminatesAtSink` read `sinkPlaces`. So `sinkPlaces(_pause, _halted)` records the intent and
changes nothing, and every quiescent marking counts — including the two the model designs.

That matters more than it sounds. Every node's `X_run` offers the `waiting` and `stopped`
outcomes, so on **any** fan-out there is a reachable quiescent marking in which one sibling
paused the execution and the other's arrival is still sitting on its `in` place. Measured on
the three-way `fanOut` fixture: all three edges come back `violated` in 1.3–2.7 s with a
confirmed witness `Trigger -> B`, and the witness marking is
`_pause x1, A/in x1, B/waiting x1, C/in x1, …`. That is the pause the marking codec writes
back into `nodeExecutionStack` (ADR 0005), not a stranding.

`verify()` therefore **downgrades a violation whose witness marking holds `_pause`, `_halt`
or `_halted` to `unknown`**, with that reason, keeping the witness attached as the evidence.
It is not a proof either — Spacer returns one witness and a real stranding could hide behind
it — which is exactly what `unknown` means. Closing this needs a per-place quiescence
property that *does* honour declared sinks; `deadlockFree` honours them but asks about the
whole net at once, which on this net is violated by every clean run (see above). That gap is
the first item under "what would move this".

The whole-net alternative fails for the reason above; the per-place one is sink-blind. Both
halves of that sentence are upstream findings, not workarounds available here.

### Why there is a second, weaker question on the same place — and what it is worth

The quiescence query on a join input does not close (see the measurements), so the family
also asks `placeBound(ready_i, capacity)`: how many arrivals can queue there at once — one
for a join slot (`free_i + ready_i = 1`, ADR 0003), `n` for an OR round (README
"OR-inputs"). It is a strictly weaker statement, and the two forms are worth different
things, so the check's name says which one it is.

- **On a join slot it closes and cannot fail.** Every `arm` consumes `free_i` and only
  `X_start` / `X_skip` refund it (`gadget.ts`), so `free_i + ready_i ≤ 1` holds by
  construction on any net this compiler produces, and `placeBound(ready_i, 1)` is `proven` in
  ~300 ms on the diamond — the same verdict on a balanced diamond, on the unbalanced join
  that really does strand, and on a hand-built three-producer join. The query is still worth
  running: it re-checks the gadget against the net that was actually built, and a compiler
  change that broke the slot discipline would show up here. It is **not** a detector for the
  arrival-order class of [`docs/divergences.md`](divergences.md) row #8, and the check's
  explanation says so.
- **On an OR round it could fail, and it does not close.** The OR form has no slot token at
  all — `n` deliveries aggregate into one round — so `placeBound(ready_i, n)` is exactly the
  query row #8 names, with a reachable violation. Measured on the smallest OR shape a
  compiled workflow can have (`multiProducer`: two producers into one input): `unknown` at
  5 s and still `unknown` at 30 s, in both directions (`n` and `n − 1`).

So the arrival-bound half closes precisely where it cannot fail. Row #8 in the register has
been amended to say that.

### Why the retry bound is two checks

`placeBound(X/tries, maxTries − 1)` does **not** entail "at most `maxTries` attempts". The
place is seeded with exactly `maxTries − 1` tokens, so the bound is true in the initial
marking, and a net that *refunded* a try token would still satisfy it while `X_retry_wait`
fired without limit — demonstrated on a two-place net whose
`retry_wait: one(tries), one(go) → and(go, tries)` keeps `placeBound(tries, 2)` proven for
ever (and `placeBound(tries, 1)` violated, so the query is live rather than vacuous).

What turns the bound into an attempt bound is the structural fact that **nothing produces
`X/tries`**: it is seeded, consumed by `X_retry_wait`, and read as an inhibitor by
`X_exhausted`. `verify()` reports that as its own check, read off the flattened net the
encoder sees (`method: structural`, no solver). Only the conjunction of the two supports the
sentence the report prints, and the structural half is the one a future compiler change —
`_halt_reap` already carries reset arcs over a list of places — would break.

### Why a *live* node is `unknown` and never `proven`

`unreachable(P)` is a safety property and only its `proven` direction transfers: VER-004 AC3
says a proof on the untimed net implies the property for all timed executions, and says
nothing about a witness. libpetri's `violated` is a firing sequence in an abstraction that is
untimed, priority-blind and **value-blind**, where every `xor` branch of a router is explored
whatever the data (VER-004 AC2) — so on a `Trigger → IF → A` workflow the solver reaches `A`
through the IF branch that a real run may never take. Reporting that as "the node is live"
would be a claim the encoding cannot support, and it would be counted among the proofs.

So the dead-nodes family has one verdict and one non-verdict: `violated` when the node can
never run (libpetri `proven`, ~90 ms), and `unknown` otherwise, with the reason naming
VER-004 and `query.verdict` carrying libpetri's own answer. The report never says "produced a
firing sequence" unless `counterexampleConfirmed === true`.

### A second trigger is an entry point, not a dead node

`initialMarking` seeds only the start node's own input, because n8n runs **one trigger per
execution**. So on a Manual-plus-Webhook workflow `unreachable(Webhook/running)` really is
`proven` — and reporting that as a finding would fail the exit-code gate on an ordinary
workflow. `verify()` therefore classifies a node whose *shape* declares no input and which is
not the start node — plus everything reachable from it and from no start node — as an
alternative entry point: verdict `unknown`, with the reason naming the entry point and
telling you to re-run with `--start` on it to verify the execution it starts. A node with no
incoming connection whose shape *has* an input is an orphan, not an entry point, and stays a
finding.

### Why the `ready_i` place and not only the edge place

ADR 0003's `arm` transition drains an edge place into `ready_i` as soon as the input's slot is
free, so an arrival that will never be consumed does not sit on the edge — it sits one place
downstream. `tests/spikes/verification.test.ts` pinned this in M1 on a hand-written join: the
unbalanced shape is `violated` on `ready_0` and `proven` on the edge place feeding it. Both
are queried; the M1 spike is why.

### What no verdict can say

The SMT encoding is untimed, **priority-blind** and **value-blind** (VER-004).

- **Order is not provable.** Priority is not in the encoding, so nothing about n8n's
  depth-first walk, `executionIndex` or any ordering row of
  [`docs/divergences.md`](divergences.md) follows from a verdict here. Those claims rest on
  the differ ([`docs/differential.md`](differential.md)).
- **Values are not modelled.** Every `xor` branch of a routing transition is explored, so
  "the IF sent data left" and "the IF sent data right" are both reachable. This
  over-approximates, which keeps `proven` sound — and it is why mutual exclusion of two IF
  branches is *violated* at k ≥ 2 although a real run takes only one. It is also why a
  **witness is not a result**: every `violated` verdict on this surface is a statement about
  the abstraction, and the only one reported as a finding is the one whose direction is sound
  (`unreachable` proven ⇒ the node is dead). See "Why a *live* node is `unknown`".
- **Nothing is said about a resumed execution.** Every query starts from the fresh initial
  marking; a resumed or retried run starts from a codec-decoded marking outside that set.
- **The budget bound alone means little.** A `_budget` consumed and refunded by one
  transition has a zero incidence column, so the verifier never sees it move and
  `placeBound(_budget, k)` is trivially true (pinned in the M1 spike). The two-phase gadget
  (ADR 0004) is what makes the bound informative, and the P-semiflow is the check that
  carries the content.

---

## Measurements

Machine: Apple silicon, Node 26, z3 4.13.0, `LIBPETRI_Z3` unset. **The absolute numbers are
upper bounds**: they were taken while another workload was on the machine, as
[`docs/differential.md`](differential.md)'s were. The ratios and — more importantly — the
verdicts (`proven` / `unknown`) reproduce; a query that closes in 200 ms here does not become
one that does not close on an idle machine, and none of the `unknown`s is a near miss (the
join-input one is still `unknown` at 600 s).

### Net size

| workflow                   | nodes | places | transitions | flat transitions | compile ms | queried |
|----------------------------|-------|--------|-------------|------------------|------------|---------|
| small (6 nodes, one join)  | 6     | 70     | 34          | 58               | 5          | yes     |
| orphan (4 nodes, two dead) | 4     | 38     | 17          | 31               | 1          | yes     |
| or (4 nodes, one OR round) | 4     | 46     | 24          | 39               | 1          | yes     |
| medium (21 nodes, 5 joins) | 21    | 256    | 129         | 217              | 3          | yes     |
| large (49 nodes, 12 joins) | 49    | 599    | 304         | 511              | 6          | no      |
| huge (101 nodes, 25 joins) | 101   | 1236   | 629         | 1057             | 14         | no      |

### Pipeline before z3 (flatten, structural pre-check, P-invariants)

| workflow                   | phases 1-3 (semiflows on) | phases 1-3 (semiflows off) |
|----------------------------|---------------------------|----------------------------|
| small (6 nodes, one join)  | 67 ms                     | 62 ms                      |
| orphan (4 nodes, two dead) | 27 ms                     | 25 ms                      |
| or (4 nodes, one OR round) | 33 ms                     | 31 ms                      |
| medium (21 nodes, 5 joins) | 2920 ms                   | 2423 ms                    |

### Per-query wall clock (timeout 30000 ms)

| workflow                   | family               | query                                                       | queries in the family | semiflows | verdict  | wall clock |
|----------------------------|----------------------|-------------------------------------------------------------|-----------------------|-----------|----------|------------|
| small (6 nodes, one join)  | budget               | placeBound(_budget, k)                                      | 1                     | on        | proven   | 204 ms     |
| small (6 nodes, one join)  | no-double-activation | placeBound(B/running, 1)                                    | 6                     | on        | proven   | 194 ms     |
| small (6 nodes, one join)  | dead-nodes           | unreachable(B/running) [live]                               | 6                     | on        | unknown  | 30.3 s     |
| small (6 nodes, one join)  | mutual-exclusion     | mutualExclusion(A, B)                                       | 15                    | on        | proven   | 208 ms     |
| small (6 nodes, one join)  | proper-completion    | joinedOrDeadLettered(id:A/in) [edge]                        | 9                     | on        | unknown  | 30.3 s     |
| small (6 nodes, one join)  | proper-completion    | joinedOrDeadLettered(id:Merge/ready_0) [join input]         | 9                     | on        | unknown  | 30.3 s     |
| small (6 nodes, one join)  | proper-completion    | placeBound(id:Merge/ready_0, 1) [arrival bound, join slot]  | 2                     | on        | proven   | 342 ms     |
| small (6 nodes, one join)  | budget               | placeBound(_budget, k)                                      | 1                     | off       | unknown  | 30.2 s     |
| small (6 nodes, one join)  | no-double-activation | placeBound(B/running, 1)                                    | 6                     | off       | proven   | 178 ms     |
| small (6 nodes, one join)  | dead-nodes           | unreachable(B/running) [live]                               | 6                     | off       | unknown  | 30.2 s     |
| small (6 nodes, one join)  | mutual-exclusion     | mutualExclusion(A, B)                                       | 15                    | off       | unknown  | 30.3 s     |
| small (6 nodes, one join)  | proper-completion    | joinedOrDeadLettered(id:A/in) [edge]                        | 9                     | off       | unknown  | 30.3 s     |
| small (6 nodes, one join)  | proper-completion    | joinedOrDeadLettered(id:Merge/ready_0) [join input]         | 9                     | off       | unknown  | 30.3 s     |
| small (6 nodes, one join)  | proper-completion    | placeBound(id:Merge/ready_0, 1) [arrival bound, join slot]  | 2                     | off       | proven   | 328 ms     |
| orphan (4 nodes, two dead) | budget               | placeBound(_budget, k)                                      | 1                     | on        | proven   | 88 ms      |
| orphan (4 nodes, two dead) | no-double-activation | placeBound(OrphanChild/running, 1)                          | 4                     | on        | proven   | 96 ms      |
| orphan (4 nodes, two dead) | dead-nodes           | unreachable(Orphan/running) [dead]                          | 4                     | on        | proven   | 96 ms      |
| orphan (4 nodes, two dead) | dead-nodes           | unreachable(A/running) [live]                               | 4                     | on        | violated | 692 ms     |
| orphan (4 nodes, two dead) | mutual-exclusion     | mutualExclusion(Trigger, OrphanChild)                       | 6                     | on        | proven   | 101 ms     |
| orphan (4 nodes, two dead) | proper-completion    | joinedOrDeadLettered(id:Trigger/in) [edge]                  | 4                     | on        | proven   | 833 ms     |
| orphan (4 nodes, two dead) | budget               | placeBound(_budget, k)                                      | 1                     | off       | proven   | 87 ms      |
| orphan (4 nodes, two dead) | no-double-activation | placeBound(OrphanChild/running, 1)                          | 4                     | off       | proven   | 91 ms      |
| orphan (4 nodes, two dead) | dead-nodes           | unreachable(Orphan/running) [dead]                          | 4                     | off       | proven   | 87 ms      |
| orphan (4 nodes, two dead) | dead-nodes           | unreachable(A/running) [live]                               | 4                     | off       | violated | 728 ms     |
| orphan (4 nodes, two dead) | mutual-exclusion     | mutualExclusion(Trigger, OrphanChild)                       | 6                     | off       | proven   | 89 ms      |
| orphan (4 nodes, two dead) | proper-completion    | joinedOrDeadLettered(id:Trigger/in) [edge]                  | 4                     | off       | proven   | 1.0 s      |
| or (4 nodes, one OR round) | budget               | placeBound(_budget, k)                                      | 1                     | on        | proven   | 113 ms     |
| or (4 nodes, one OR round) | no-double-activation | placeBound(B/running, 1)                                    | 4                     | on        | proven   | 116 ms     |
| or (4 nodes, one OR round) | dead-nodes           | unreachable(B/running) [live]                               | 4                     | on        | violated | 1.0 s      |
| or (4 nodes, one OR round) | mutual-exclusion     | mutualExclusion(A, B)                                       | 6                     | on        | proven   | 118 ms     |
| or (4 nodes, one OR round) | proper-completion    | joinedOrDeadLettered(id:A/in) [edge]                        | 6                     | on        | violated | 1.8 s      |
| or (4 nodes, one OR round) | proper-completion    | joinedOrDeadLettered(id:C/ready_0) [join input]             | 6                     | on        | unknown  | 30.2 s     |
| or (4 nodes, one OR round) | proper-completion    | placeBound(id:C/ready_0, 2) [arrival bound, OR round]       | 1                     | on        | unknown  | 30.2 s     |
| or (4 nodes, one OR round) | budget               | placeBound(_budget, k)                                      | 1                     | off       | proven   | 4.3 s      |
| or (4 nodes, one OR round) | no-double-activation | placeBound(B/running, 1)                                    | 4                     | off       | proven   | 112 ms     |
| or (4 nodes, one OR round) | dead-nodes           | unreachable(B/running) [live]                               | 4                     | off       | violated | 1.1 s      |
| or (4 nodes, one OR round) | mutual-exclusion     | mutualExclusion(A, B)                                       | 6                     | off       | unknown  | 30.2 s     |
| or (4 nodes, one OR round) | proper-completion    | joinedOrDeadLettered(id:A/in) [edge]                        | 6                     | off       | violated | 3.3 s      |
| or (4 nodes, one OR round) | proper-completion    | joinedOrDeadLettered(id:C/ready_0) [join input]             | 6                     | off       | unknown  | 30.2 s     |
| or (4 nodes, one OR round) | proper-completion    | placeBound(id:C/ready_0, 2) [arrival bound, OR round]       | 1                     | off       | unknown  | 30.1 s     |
| medium (21 nodes, 5 joins) | budget               | placeBound(_budget, k)                                      | 1                     | on        | proven   | 5.3 s      |
| medium (21 nodes, 5 joins) | no-double-activation | placeBound(B4/running, 1)                                   | 21                    | on        | proven   | 5.8 s      |
| medium (21 nodes, 5 joins) | dead-nodes           | unreachable(B4/running) [live]                              | 21                    | on        | unknown  | 32.8 s     |
| medium (21 nodes, 5 joins) | mutual-exclusion     | mutualExclusion(A0, B4)                                     | 210                   | on        | proven   | 5.2 s      |
| medium (21 nodes, 5 joins) | proper-completion    | joinedOrDeadLettered(id:A0/in) [edge]                       | 36                    | on        | unknown  | 32.8 s     |
| medium (21 nodes, 5 joins) | proper-completion    | joinedOrDeadLettered(id:Merge0/ready_0) [join input]        | 36                    | on        | unknown  | 32.8 s     |
| medium (21 nodes, 5 joins) | proper-completion    | placeBound(id:Merge0/ready_0, 1) [arrival bound, join slot] | 10                    | on        | proven   | 6.7 s      |
| medium (21 nodes, 5 joins) | budget               | placeBound(_budget, k)                                      | 1                     | off       | unknown  | 32.4 s     |
| medium (21 nodes, 5 joins) | no-double-activation | placeBound(B4/running, 1)                                   | 21                    | off       | proven   | 3.9 s      |
| medium (21 nodes, 5 joins) | dead-nodes           | unreachable(B4/running) [live]                              | 21                    | off       | unknown  | 32.5 s     |
| medium (21 nodes, 5 joins) | mutual-exclusion     | mutualExclusion(A0, B4)                                     | 210                   | off       | unknown  | 32.5 s     |
| medium (21 nodes, 5 joins) | proper-completion    | joinedOrDeadLettered(id:A0/in) [edge]                       | 36                    | off       | unknown  | 32.6 s     |
| medium (21 nodes, 5 joins) | proper-completion    | joinedOrDeadLettered(id:Merge0/ready_0) [join input]        | 36                    | off       | unknown  | 32.6 s     |
| medium (21 nodes, 5 joins) | proper-completion    | placeBound(id:Merge0/ready_0, 1) [arrival bound, join slot] | 10                    | off       | proven   | 9.8 s      |

`npx tsx tests/verify/measure.ts --timeout 30000`, verbatim (re-measured 2026-09-06). Four
things to read out of it.

**The net is linear in the workflow.** 11–12 places and ~6 transitions per node, and the
flattener adds under 2× on top (per-output routing keeps the `and`-of-`xor` expansion linear,
IO-016). Compiling and flattening a 101-node workflow costs 14 ms.

**VER-007 is not optional here.** Turn semiflows off and `placeBound(_budget, k)` goes from
`proven` in 204 ms to `unknown` at 30 s, and `mutualExclusion` with it — on the 6-node
diamond *and* on the 21-node generated workflow. `placeBound(X/running, 1)` survives, because
`X/idle + X/running = 1` is in the null-space basis and needs no semiflow. So the two checks
that say something about the *budget* rest entirely on the semiflow strengthening. (The
4-node OR fixture is the exception that shows it is a *strengthening* and not a correctness
knob: small enough that IC3 gets the budget bound without it, in 4.3 s instead of 113 ms.)

**The arrival bound closes only on the form that cannot fail.** `placeBound(ready_i, 1)` on a
join slot: `proven` in 342 ms at 6 nodes, 6.7 s at 21 — and unfalsifiable by construction.
`placeBound(ready_i, 2)` on the OR round, the form divergence #8 lives on: `unknown` at 30 s,
with semiflows on and off, on the smallest OR shape a compiled workflow can have.

**Liveness is cheap where it does not matter.** `unreachable(A/running)` on the `orphan`
fixture — `A` is one hop from the trigger — comes back `violated` in ~700 ms, i.e. the solver
finds a witness fast; two hops behind a join or a router it does not close at all (`unknown`
at 30 s on the diamond and at 33 s on the 21-node workflow). Either way `verify()` reports
`unknown`, because a witness in this encoding is not a liveness proof (VER-004). The *dead*
answer, the one that is a finding, costs ~90 ms.

**The wall is the pipeline, not z3.** Phases 1–3 — flatten, structural pre-check, P-invariant
and semiflow enumeration — cost 27–67 ms at 4–6 nodes and 2.9 s at 21, and every query pays
them again (they are not cached across queries). At 49 nodes the enumeration exhausts the
default 4 GB V8 heap after about three minutes and aborts, so the row is not queried at all;
101 nodes is out of reach for the same reason. That is why the `queried` column exists.

---

## Where the verifier is useful, and where it is not

**Useful today, on a workflow up to roughly 25 nodes.**

- The **structural family** — the budget bound, the two-phase P-semiflow, the `X/running`
  mutex per node, the retry bound (both halves), the join-slot discipline — is `proven` in
  90–300 ms per query at 4–6 nodes and 5–7 s at 21. These are the checks that say the *model*
  holds: at most `k` activations in flight, no node running twice, at most `maxTries`
  attempts, one arrival per join slot.
- **Dead nodes.** A node no execution can reach is `proven` unreachable — and therefore
  reported by name — in ~90 ms. This is the one *finding* the surface produces reliably, and
  it is a real class of n8n bug: an all-required Merge with an unwired lower input, a branch
  left disconnected on the canvas.
- **Mutual exclusion at k = 1**: ~100–230 ms per pair at 4–6 nodes, 5.2 s at 21 — a sanity
  check of the budget model rather than a workflow property. Watch the family size: every
  pair is 210 queries at 21 nodes, so name the pairs you care about rather than `--all-pairs`.
- **Proper completion, on a workflow without a join or an XOR router.** Every edge of the
  4-node `orphan` fixture proves in 0.8–1.0 s, and the first hop of a plain chain in ~34 s.

**Not useful today.**

- **Proper completion on a join input.** `unknown` at 30 s, at 60 s and still at 600 s — on
  the 6-node balanced diamond, which has no stranding, *and* on a 4-node workflow that has
  one. The same shape hand-written without the gadget's marker and pause places closes in
  under a second (`tests/spikes/verification.test.ts`), so it is the size and the shape of
  the compiled net, not the property, that defeats it.
- **Proper completion on an edge fed by a join or an XOR router.** `id:A/in` on the diamond —
  A's input, fed by the IF — is `unknown` at 30 s, and on a plain 4-node chain the second and
  third edges are already `unknown` at 60 s. Only the shallow, router-free cases close.
- **The arrival bound as a detector.** It closes exactly where it cannot fail. On a join slot
  `placeBound(ready_i, 1)` is `proven` in ~300 ms and holds by construction; on the OR round,
  the form where divergence #8 could actually show up, it is `unknown` at 30 s on the smallest
  OR shape there is. Read a `proven` there as "the gadget is intact", never as "this workflow
  has no arrival-order problem".
- **Any violation the sink declaration should have excluded.** See the section above: the
  witness is a paused run, and the property cannot be told to ignore it, so the verdict is
  `unknown` rather than a finding.
- **Liveness, at all.** Even where the search closes — ~700 ms for a node one hop from the
  trigger — the answer is a witness in a value-blind abstraction, so `verify()` reports it as
  `unknown` by design (see "Why a *live* node is `unknown`"); behind a join it does not close
  either (`unknown` at 30 s on the diamond and on the 21-node workflow). Since the same query
  proves *deadness* in ~90 ms, the dead-node family is cheap for the answer that matters and
  worth nothing for the answer that does not.
- **Anything at all with VER-007 turned off.** `--no-semiflows` costs the budget bound and
  mutual exclusion outright (`proven` → `unknown` at 30 s) and buys about 15 % of the
  pipeline time back. Do not.
- **Any workflow above roughly 25 nodes.** The wall is the **pipeline, not z3**: flatten,
  structural pre-check and the P-invariant / semiflow enumeration cost 26–73 ms at 4–6 nodes,
  2.9 s at 21 nodes, and at 49 nodes exhaust the default 4 GB V8 heap after about three
  minutes without ever reaching the solver. A 101-node workflow compiles and flattens in
  15 ms and cannot be verified at all.

**What would move each of them, in order of value.**

1. **A per-place quiescence property that honours declared sinks.** `deadlockFree` honours
   them but asks about the whole net, which on this net is violated by every clean run;
   `joinedOrDeadLettered` is per-place and sink-blind (NU-040 AC4). Either a sink-aware
   variant of the latter, or a `deadlockFree` whose sink set could be "every place that may
   legitimately hold a token at quiescence" — `_pause`, `_halted`, `idle`, `_budget`, `done`,
   `skipped`, `tries`, `free`, `ran`, the `empty` edge places — would ask the right question
   in **one** query per workflow instead of one per place. That set is derivable from
   `PlaceRole`, so this is mostly an upstream ask.
2. **A sparse / bignum incidence pipeline in libpetri.** The Gaussian elimination and the
   Farkas enumeration run on dense `number[][]`; that is what OOMs at 49 nodes. Nothing in
   this repository can fix it, and it is the single change that would take the verifier from
   "small workflows" to "real ones".
3. **Boundedness for the marker places.** `Structurally bounded: NO` on every compiled net,
   because `X/done`, `X/skipped` and the other markers are produced and never consumed, so no
   non-negative invariant covers them. Removing `_halt_reap`'s reset arcs recovers every
   dropped invariant (13 found, 0 dropped, against 8 found / 5 dropped) and the join-input
   query *still* does not close — so the H1 guard is a contributing cause, not the cause. A
   compiler change that consumed the markers, or a verifier option that bounded them, is what
   IC3 is missing.
4. **Bounded model checking for the SAT direction.** Every "is this node live" and "can these
   two overlap" question is a bounded reachability query, and Spacer is the wrong engine for
   it. A BMC front end (unroll to depth `d`, one SAT call) would answer them in milliseconds
   at these sizes. It would not, on its own, make liveness *provable*: a witness in this
   encoding is a witness in a value-blind abstraction whatever engine finds it (VER-004), so
   an honest liveness verdict also needs the routing conditions in the encoding.
5. **Caching, and a per-family budget in `verify()`.** One query per place and per node, each
   paying phases 1–3 again, with no parallelism and no early exit: a 21-node workflow is
   ~100 queries × (2.9 s + up to the timeout). The pipeline cache is upstream; the budget and
   the parallelism are not.

---

## Reproducing

```bash
cd typescript
npx tsx tests/verify/measure.ts                  # 60 s per query, semiflows on and off
npx tsx tests/verify/measure.ts --timeout 30000  # the sweep the tables above came from (~13 min)
npx vitest run tests/verify                      # the committed gate (67 tests)
npx tsx tests/verify/measure.ts --sizes 'large (49'   # watch the pipeline exhaust the heap
```

`measure.ts` samples **one representative query per property family per size** rather than
running whole families: a family costs (queries in the family × per-query cost), the second
factor is what varies with the workflow, and the first is printed alongside so the product is
readable. Sampling is what keeps the sweep to minutes — a 101-node workflow has 101
dead-node queries, and one that does not close costs the full timeout.

Two rules the sampler follows, because getting either wrong reports the opposite of what the
row says: the `[dead]` sample is a node the compiler marks unreachable, and the `[live]` one
is the **last node in canvas order that the start node can reach** — not simply the last node,
which on the `orphan` fixture is `OrphanChild`, i.e. a dead node under a liveness label. The
earlier revision of this document reported that mistake as `proven in 652 ms`; the honest
row is `A`, `violated in 692 ms`.

The generated workflows come from `generateWorkflow(layers)` in `tests/verify/support.ts`:
`layers` diamonds in series (`IF → {A, B} → Merge`), so `4·layers + 1` nodes with one join per
layer. The `or` size is `multiProducer` from `tests/fixtures/workflows.ts` — the smallest
shape whose consumer takes the OR-round form.
