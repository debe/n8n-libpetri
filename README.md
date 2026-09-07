# n8n-libpetri

[![CI](https://github.com/debe/n8n-libpetri/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/debe/n8n-libpetri/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-5fa04e)](typescript/package.json)
[![libpetri](https://img.shields.io/badge/libpetri-%5E5.0.0-1f6feb)](https://github.com/debe/libpetri)
[![License](https://img.shields.io/badge/license-Apache--2.0-1f6feb)](LICENSE)

n8n executes a workflow by running a scheduling loop over an explicit stack of pending nodes.
The loop is compact and effective, and it carries a complete scheduling model: the states a node
passes through, the condition under which it may run, the number of nodes that may run at once,
and the conditions under which an execution ends. That model is expressed as control flow and as
a small number of execution-global fields. It is legible to a reader of the source and available
to nothing else.

n8n-libpetri restates the same model as a coloured time Petri net. n8n retains the editor, the
workflow format, credentials, node implementations, persistence, webhooks, hooks and queue mode.
The scheduling model becomes an object in its own right.

The execution model is a Petri net. Concurrency, cycles, joins, retries, resource limits and
terminal states therefore have explicit semantics. The scheduler executes that net. The
verifier analyses the same net.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/workflow-to-net-dark.svg" />
  <img alt="A six-node n8n canvas beside the Petri net gadget one of its nodes compiles to:
  in, idle, running, routed and done places, start, run and done transitions, a shared budget
  place and a halt place that inhibits the start." src="docs/img/workflow-to-net-light.svg" />
</picture>

*What the compiler does. Circles are places, bars are transitions, and a token sits in a place.
Four of these six nodes compile to exactly this gadget, wired to the shared `_budget` and `_halt`
places; `Trigger` drops the skip branch, and `Merge` adds the join below. `run` is the only
transition that calls `runNode()`.*

## Contents

1. [The scheduler in n8n today](#the-scheduler-in-n8n-today)
2. [What formalisation provides](#what-formalisation-provides)
3. [Principles](#principles)
4. [Scope](#scope)
5. [Execution model](#execution-model)
6. [Verification](#verification)
7. [Evidence](#evidence)
8. [Known limits](#known-limits)
9. [Building and testing](#building-and-testing)
10. [Repository map](#repository-map)

## The scheduler in n8n today

`WorkflowExecute.processRunExecutionData()` runs a loop of roughly 490 lines over an array of
pending entries, plus a side table holding the partly arrived inputs of multi-input nodes. Each
iteration takes one entry, runs that node, and appends the successors of every output that
produced items, sorted by canvas position.

Two conditions make it work, and the loop satisfies both by construction. A successor is
enqueued only when its output carried data, so a recovery pass completes any node still waiting
once the stack drains. Exactly one node runs at a time, which keeps the execution-global fields
safe.

## What formalisation provides

Restating the model changes nothing about the work n8n performs. It changes what can be said
about that work before it runs. Three conditions the loop holds implicitly become objects in the
net, and analysability follows from having them.

**Waiting becomes a place.** A join in the net holds one slot per input and fires when the last
slot is claimed. An edge with no data for this activation claims its slot with an `empty` token,
so "produced nothing" arrives as a fact. n8n has no such fact to send, so a waiting join needs a
recovery pass after the stack drains; the net needs none.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/empty-token-dark.svg" />
  <img alt="An n8n workflow that splits at IF and rejoins at Merge, above four frames of its
  compiled net running. IF routes data to A and an empty token to B. B never runs, but its skip
  still delivers an empty to Merge, so both of Merge's input slots are claimed and it starts."
  src="docs/img/empty-token-light.svg" />
</picture>

*The same six nodes, now running. `IF` takes one branch, so `B` never runs. The untaken branch
still emits an `empty` token, `B`'s skip passes that empty on, and `Merge` starts with both slots
claimed and one holding data.*

**The bound becomes a number.** One node at a time is what keeps `executionError`, `waitTill`
and `lastNodeExecuted` correct, and nothing declares it. The net declares it as `_budget`, k
tokens in one place, and the `budget` property checks the law that follows. Two independent
500 ms branches take 1,006 ms today and 507 ms at k = 2.

**Execution state becomes data.** Progress is the marking, and `MarkingCodec` writes it into
n8n's own `nodeExecutionStack` and `waitingExecution`. Wait, resume and queue-mode handoff
therefore move a marking with a defined encoding, and nothing new is persisted.

**The model becomes analysable.** Whether a join can be left permanently unsatisfied is a
question about reachable states, which control flow alone cannot answer. `proper-completion`
decides it on the state-class graph: `violated` on `ifBothOutputs` in 15 ms, with the firing
sequence named in nodes.

Petri nets are a standard formalism for concurrent and distributed systems, with an established
body of analysis to draw on. What ships today is one process with a configurable k. Raising k, or
moving an execution between workers, is a change to the budget and the marking.

The costs: about 16 µs of scheduler overhead per node; 9 of the 44 cases that drive the scheduler
regressed, all classified; cyclic and multi-producer-input workflows pinned to k = 1; `bounded` on
cycles and `unknown` on large parallel shapes.

## Principles

1. **Every transition carries a real `Out` spec**, never `null`, never `skipOutputValidation`.
   The executor validates it and the verifier reads it: that is how one net serves both. The
   only null-spec transitions are genuine sinks (libpetri CORE-043 AC4).
2. **The net decides what runs.** Enablement follows from tokens, guards, inhibitors, read arcs,
   priorities and timed transitions. Nothing dispatches from the host: no queue, no permit
   gating, no policy object. Retries, mutual exclusion, concurrency limits and halts are places
   and arcs.
3. **Behaviour that follows from the stack discipline is a candidate for abandonment, not a
   requirement.** The net models the workflow's semantics, and
   [`docs/divergences.md`](docs/divergences.md) records every difference.
4. **Report only the direction the encoding licenses.** The verification abstraction is priority-
   and value-blind, so a witness stays a witness and never becomes a proof. No check claims more
   than its query asks.

## Scope

| n8n keeps | n8n-libpetri provides |
|---|---|
| Workflow JSON and editor | Workflow-to-net compiler |
| Node implementations and `runNode()` | `PetriScheduler` |
| Credentials, expressions and data proxy | Marking codec for resume state |
| Persistence, hooks, webhooks and queue mode | State-class and SMT verification |
| Execution-engine interface | Scheduler registration behind that interface |

n8n-libpetri supports v1 execution order only, and deliberately leaves v0 on n8n's scheduler.

## Execution model

One workflow execution creates one net. Each n8n node becomes a `SubnetDef` with places and
transitions for start, run, completion, skipping, retry and exhaustion. Shared places model
the concurrency budget, halt and pause state.

### Emission rule

An `empty` token on an acyclic edge asserts that the edge produced no data for this activation
of its producer. That assertion is what lets an AND-join complete or skip on its own.

Cycles need a different rule, because an empty token must not circulate forever. A node skipped
on an empty input would emit `empty` on its back edge, re-activating its predecessor's skip,
which emits `empty` again, without end. The compiler therefore decomposes the main-connection
graph into strongly connected components before emitting:

| Edge | Producer returned data | Producer skipped |
|---|---|---|
| Acyclic edge | `data` or `empty` | `empty` |
| Edge leaving a cyclic producer | `data` or local `nil` | `empty` |
| Edge inside a cycle | `data` or local `nil` | nothing |

A local sink consumes `nil`. It records that an output was not selected without inventing
traffic on a cycle. [ADR 0002](docs/adr/0002-emission-rule.md) records the decision.

### Per-node gadget

The normal path is:

```text
input + idle + budget -> running -> routed -> done + budget
```

In the gadget pictured at the top of this file, `start` acquires one `_budget` token. `run` calls
n8n's existing `runNode()` and routes the result. `done` refunds the token one scheduler cycle
later. The split models duration and makes the budget a structural property of the net:

```text
_budget + running + retry + in-flight routing = k
```

Each node also has an `idle` token, giving the invariant `idle + running = 1`.

Nodes with up to three connected outputs route directly from `run`. Wider fan-outs use one
routing transition per output. This avoids flattening an `and` of `n` `xor`s into `2^n`
branches.

Transition priority is DAG depth, so at k = 1 the net walks a workflow depth-first, as n8n's
loop does. [ADR 0004](docs/adr/0004-two-phase-budget.md) records the two-phase split.

### Retries, halt, cancellation

Retries hold the budget while they wait, as n8n's retry loop does. A fatal error deposits
`_halt`, and every new start and routing transition inhibits on it. Actions already in flight
may finish, and the marking codec then writes the pending activations back to n8n's resumable
state. Wait nodes and destination-node stops deposit `_pause` and are handled the same way.

### Join gadget and OR-inputs

A join has a `free` and a `ready` place for each input, and one `hasdata` place for the node.
An arriving edge claims its input slot. The node starts once all required slots are ready and at
least one holds data; otherwise it skips and propagates empty output. The places make slot
allocation and mutual exclusion explicit.

Several producers targeting one input form an OR-input, not an AND-join. Each data arrival may
activate the node. Empty-capable producers close a delivery round together, which keeps one
empty edge from prematurely skipping downstream work. The current round model is positional, and
interleaved arrivals can expose the FIFO/LIFO divergence recorded in
[`docs/divergences.md`](docs/divergences.md). [ADR 0003](docs/adr/0003-join-gadget.md) records
the gadget.

### Expression references

References such as `$('Y')` become read arcs on `Y/done` when `Y` is a valid upstream
dependency. A skipped or unreachable dependency produces n8n's unexecuted-node error under
the node's configured error policy. Self-, downstream- and loop-back references remain
runtime expression errors.

### Concurrency budget and its safety condition

The initial `_budget` marking is the maximum number of node actions that may be in flight. A
retry holds its unit while it waits, so concurrent runs are bounded by the budget and need not
reach it.
Independent enabled transitions can therefore run concurrently. The budget is a declared
invariant first and a throughput control second.

Above k = 1 one rule falls on node authors: **a node's input items are read-only**. n8n already
shares the producer's `INodeExecutionData` objects across every connection, so a node that
mutates its input `json` in place corrupts its sibling's input today. Concurrency makes the
result nondeterministic.

The compiler currently lowers the effective budget to one when a workflow contains a cycle or
several producers for one input index. Those shapes need activation lineage before their tokens
can be paired safely at `k > 1`. The budget-equivalence tests preserve run data at budgets 1, 2,
4 and 8 for k-safe workflows without completion-order-sensitive stop behaviour. Completion order
may change above one, by design. [ADR 0006](docs/adr/0006-concurrency.md) records the condition.

### Initial marking and the marking codec

The initial marking of one execution is `_budget` × k, one `X/idle` per node, one `X/free_i` per
join input whose slot is not pre-filled, `X/tries` per retry node, one `empty` token on the
`ready` place of every join input fed only by nodes unreachable from the start node, `Y/skipped`
for every referenced node unreachable from the start node, and the trigger items on the start
node's `in` place. Seeding unreachable inputs with `empty` performs n8n's recovery substitution
once, at decode time.

A running execution's progress is the marking, and n8n remains the system of record. Nothing of
the net is persisted. `MarkingCodec` encodes a quiescent marking into n8n's own
`nodeExecutionStack`, `waitingExecution` and `waitingExecutionSource`, and decodes them back by
layering them over the execution-independent part of the initial marking:

| n8n | marking |
|---|---|
| Stack entry | the entry on the consumer's `in` place, or on its edge place, in FIFO order |
| `waitingExecution[X][k].main[i]` holding items | a `data` token on `X/ready_i` |
| `waitingExecution[X][k].main[i] = []` | an `empty` token on `X/ready_i` |
| `waitingExecution[X][k].main[i] = null` | nothing; the input has not arrived |
| `runData[Y]` non-empty | `Y/done` |

Encoding runs only at quiescence, so nothing in flight is ever serialised. The encoder omits
`_budget`, `X/idle`, `X/free_i` and `X/tries`; the decoder re-seeds them, and rebuilds the `done`
and `skipped` markers from `runData`. Wait, resume and queue-mode handoff therefore work
with an unmodified `IRunExecutionData`, and the patches never touch persistence.
[ADR 0005](docs/adr/0005-marking-codec.md) records the mapping.

## Verification

The CLI compiles workflow JSON to the same net used by `PetriScheduler`:

```bash
cd typescript
npm ci
npm run build
npx n8n-libpetri verify ../workflow.json --budget 2 --property dead-nodes
```

Available properties:

- `proper-completion`
- `dead-nodes`
- `no-double-activation`
- `budget`
- `retry-bound`
- `mutual-exclusion`

The primary verifier explores libpetri's state-class graph. If that graph truncates, an
optional Z3/Spacer backend can try the remaining query. Results are deliberately narrow:

| Verdict | Meaning |
|---|---|
| `proven` | The explored model proves the property. |
| `violated` | A reachable counterexample exists. |
| `bounded` | No counterexample exists within the exact cyclic-run prefix shown. This is not a proof. |
| `unknown` | The verifier could not decide the property. |

Counterexamples are node paths through the production net. The verifier models control
flow, not item values, timing or total execution order. Independent branches can make the
state space grow combinatorially; productive cycles make it infinite. See
[`docs/verification.md`](docs/verification.md) for the exact guarantees, limits and
measurements, and [ADR 0007](docs/adr/0007-verification.md) for the decision.

## Evidence

| Surface | Result |
|---|---|
| Execution-engine suite, loop-driving | Legacy 44/44. Petri k=1: 35/44, or 35/38 excluding out-of-scope AI-agent dispatch. |
| Execution-engine suite, helpers | Legacy 1,613/1,613. Petri k=1: 1,611/1,613. |
| Core suite | The same 44 loop-driving cases at 35/44, with 2,078/2,080 helpers, across 2,124 cases. |
| n8n workflow package | 9,603 cases, identical to the unpatched baseline; the scheduler never runs there. |
| n8n CLI package | 20,328 cases pass; the scheduler is registered but never runs there. |
| Differential sweep | 23 fixtures at k=1,2,4: 49 pass, 20 registered divergences, 0 failures. |

The classifier marks 44 of the execution-engine suite's 1,657 cases as loop-driving, so those 44
measure the engine; the remaining 1,613 are helpers and guard the seam against perturbation. Of
the eleven regressions,
nine are loop-driving and two are helpers. Six of the nine exercise AI-agent `EngineRequest`
dispatch, which is out of scope by decision; the remaining three are documented semantic
differences in stuck-join handling and OR/join ordering. Widening to `packages/workflow` and
`packages/cli` added 29,931 further cases with no new failure class. The exact cases and
evidence are in [`docs/conformance-final.md`](docs/conformance-final.md).

The benchmark is useful as a cost check, not as an architectural argument. A warm 100-node
zero-work chain adds about 16 µs of scheduler overhead per node over n8n's loop on the
measured machine. A 185-node workflow compiles to a cached `PrecompiledNet` in under 9 ms.
Independent 500 ms branches fill the configured budget as expected. Full methodology and
raw numbers are in [`docs/differential.md`](docs/differential.md).

## Known limits

- AI-agent `EngineRequest` and `EngineResponse` tool dispatch is not implemented.
- Cyclic and multi-producer-input workflows currently run with an effective budget of one.
- OR-input rounds do not yet carry activation lineage.
- Completion-order fields such as `lastNodeExecuted`, `waitTill` and the selected fatal error
  can differ when actions complete concurrently.
- An in-flight sibling may finish after another node halts the execution.
- Verification does not prove general liveness, value properties, timing or order.
- The verifier returns `unknown` on large parallel state spaces, and `bounded` on cyclic
  searches unless another property is violated first.

[`docs/divergences.md`](docs/divergences.md) and
[`docs/state-of-the-project.md`](docs/state-of-the-project.md) track these constraints.

## Building and testing

The integration targets n8n commit `441970b211d13a3ce547916b2b8ee93677b620e9`. The pinned
checkout lives in the ignored `.n8n/` directory and receives two small, rebasable patches. This
repository carries no n8n fork.

The TypeScript package requires Node 24 or newer.

```bash
cd typescript
npm ci
npm run check
npm test
npm run build
```

CI runs those four commands on Node 24, with z3 installed, for every push and pull request to
`main`; the badge above reports that job. The conformance scripts below are not part of it,
because they need the pinned n8n checkout.

To test against the pinned n8n checkout:

```bash
scripts/bootstrap-n8n.sh
scripts/run-conformance.sh --engines=legacy,libpetri
scripts/verify-patch.sh
```

Use `scripts/run-conformance.sh --engines=libpetri --budget=2` for a wider budget. The
script records cases whose workflow shape forced the effective budget back to one.

## Repository map

| Path | Contents |
|---|---|
| `typescript/src/compiler/` | Workflow analysis and net construction |
| `typescript/src/scheduler/` | n8n scheduler, actions and compiled-net cache |
| `typescript/src/verify/` | Verification API, state graph, SMT fallback and CLI |
| `typescript/src/conformance/` | Reference scheduler and differential harness |
| `typescript/src/codec.ts` | Marking to and from n8n execution state |
| `patches/n8n/` | Two rebasable n8n integration patches |
| `spec/` | Executable requirements and traceability |
| `docs/adr/` | Architectural decisions and amendments |
| `docs/conformance-*.md` | Recorded n8n suite evidence |

Start with the [project state](docs/state-of-the-project.md), then use
[verification](docs/verification.md), [differential testing](docs/differential.md),
[patching](patches/n8n/README.md) and [scripts](scripts/README.md) for the relevant task.
Milestone history belongs in [`CHANGELOG.md`](CHANGELOG.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
