# n8n-libpetri

n8n-libpetri replaces n8n's intra-workflow scheduler with a coloured time Petri net.
n8n still owns the editor, workflow format, credentials, nodes, persistence, webhooks,
hooks and queue mode. This project replaces the roughly 490-line execution loop that
pops `nodeExecutionStack`, calls `runNode()` and coordinates multi-input joins.

The execution model is a Petri net. Concurrency, cycles, joins, retries, resource limits and
terminal states therefore have explicit semantics. The scheduler executes that net. The
verifier analyses the same net.

![An n8n diamond workflow above three frames of its compiled net running. IF routes data to A
and an empty token to B. B never runs, but its skip still delivers an empty to Merge, so both
of Merge's input slots are claimed and it starts.](docs/img/empty-token-light.svg)

*The `diamond` fixture and its compiled net. `IF` takes one branch, so `B` never runs. The branch
it did not take still emits an `empty` token, `B`'s skip passes that empty on, and `Merge` starts:
both slots claimed, one holding data. n8n needs a stuck-join fallback here. This run never has two
nodes in flight — the guarantee is about semantics, not throughput.*

The integration targets n8n commit
`441970b211d13a3ce547916b2b8ee93677b620e9`. The pinned checkout lives in the ignored
`.n8n/` directory and receives two small, rebasable patches. This repository carries no n8n fork.

## What changes

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

The net decides what may run. There is no second dispatch queue or host-side permit system.
Enablement follows from tokens, guards, inhibitors, read arcs, priorities and timed
transitions.

### Edges and empty output

An explicit `empty` token means an acyclic edge produced no data for this activation.
That information matters at joins: every required input eventually contributes data or
empty, so an acyclic AND-join can complete or skip without n8n's stuck-join fallback.

Cycles need different rules because an empty token must not circulate forever. The compiler
first finds strongly connected components, then emits:

| Edge | Producer returned data | Producer skipped |
|---|---|---|
| Acyclic edge | `data` or `empty` | `empty` |
| Edge leaving a cyclic producer | `data` or local `nil` | `empty` |
| Edge inside a cycle | `data` or local `nil` | nothing |

A local sink consumes `nil`. It records that an output was not selected without
inventing traffic on a cycle.

### Node lifecycle

The normal path is:

```text
input + idle + budget -> running -> routed -> done + budget
```

![One n8n node and the Petri net gadget it compiles to: in, idle, running, routed and done
places, start, run and done transitions, a shared budget place and a halt place that inhibits
the start.](docs/img/workflow-to-net-light.svg)

*Every node on the canvas becomes this gadget. Nothing consumes `_halt`, so it inhibits every
start; `X_done` refunds `_budget` one scheduling cycle after the edge tokens.*

`start` acquires one `_budget` token. `run` calls n8n's existing `runNode()` and routes the
result. `done` refunds the token one scheduler cycle later. The split models duration and
makes the budget a structural property of the net:

```text
_budget + running + retry + in-flight routing = k
```

Each node also has an `idle` token, giving the invariant `idle + running = 1`. Retries hold
the budget while waiting, as n8n's retry loop does. A fatal error deposits `_halt`; all new
starts and routing transitions inhibit on it. In-flight actions may finish; the marking codec then
writes pending activations back to n8n's resumable state. Wait and destination-node
stops use `_pause` in the same way.

Nodes with up to three connected outputs route directly from `run`. Wider fan-outs use one
routing transition per output. This avoids the `2^k` flattening cost of an `and` containing
many `xor` branches.

### Joins and OR-inputs

A join has a `free` and a `ready` place for each input, and one `hasdata` place for the node.
An arriving edge claims its input slot. The node starts after all required slots are ready and
at least one contains data; otherwise it skips and propagates empty output. The places make
slot allocation and mutual exclusion explicit.

Several producers targeting one input are an OR-input, not an AND-join. Each data arrival
may activate the node. Empty-capable producers close a delivery round together, preventing
one empty edge from prematurely skipping downstream work. The current round model is
positional. Interleaved arrivals can expose the known FIFO/LIFO divergence documented in
[`docs/divergences.md`](docs/divergences.md).

### Expressions

References such as `$('Y')` become read arcs on `Y/done` when `Y` is a valid upstream
dependency. A skipped or unreachable dependency produces n8n's unexecuted-node error under
the node's configured error policy. Self-, downstream- and loop-back references remain
runtime expression errors.

### Concurrency

The initial `_budget` marking is the maximum number of node actions that may be in flight.
Independent enabled transitions can therefore run concurrently. This is a consequence of
the model, not the model's main claim.

The compiler currently lowers the effective budget to one when a workflow contains a cycle
or several producers for one input index. Those shapes need activation lineage before their
tokens can be paired safely at `k > 1`. The budget-equivalence tests preserve run data at
budgets 1, 2, 4 and 8 for k-safe workflows without completion-order-sensitive stop
behaviour. Completion order may change above one, by design.

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
measurements.

## Build and test

The TypeScript package requires Node 24 or newer.

```bash
cd typescript
npm ci
npm run check
npm test
npm run build
```

To test against the pinned n8n checkout:

```bash
scripts/bootstrap-n8n.sh
scripts/run-conformance.sh --engines=legacy,libpetri
scripts/verify-patch.sh
```

Use `scripts/run-conformance.sh --engines=libpetri --budget=2` for a wider budget. The
script records cases whose workflow shape forced the effective budget back to one.

## Current evidence

| Surface | Result |
|---|---|
| n8n execution-engine suite | Legacy: 1,657/1,657. Petri k=1: 1,646/1,657, all 11 regressions classified. |
| n8n core suite | Legacy: 2,124/2,124. Petri: 2,113/2,124, the same 11 regressions. |
| n8n workflow package | 9,603 cases pass; the scheduler never runs there. |
| n8n CLI package | 20,328 cases pass; the scheduler is registered but never runs there. |
| Differential sweep | 23 fixtures at k=1,2,4: 49 pass, 20 registered divergences, 0 failures. |
| Broader n8n run | 32,055 cases with no new failure class. |

Eight of the 11 execution-engine regressions exercise AI-agent `EngineRequest` dispatch,
which is outside the current scheduler scope. The other three are documented semantic
differences: stuck-join handling and OR/join ordering. The exact cases and evidence are in
[`docs/conformance-final.md`](docs/conformance-final.md).

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
