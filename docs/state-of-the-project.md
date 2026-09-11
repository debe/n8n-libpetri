# Project state

This document is the current engineering snapshot. Architecture belongs in the
[README](../README.md), decisions in [`adr/`](adr/), compatibility evidence in the
conformance reports, and history in the [changelog](../CHANGELOG.md).

## Status

Every scheduler milestone is complete:

- n8n workflows compile to libpetri Coloured Time Petri Nets.
- `PetriScheduler` implements n8n's `WorkflowScheduler` interface for execution order v1.
- Markings encode and restore n8n resumable execution state.
- A concurrency budget limits in-flight node actions structurally.
- AI Agent `ai_tool` dispatch compiles to a round in the net, bounded by the agent's own
  `options.maxIterations` and by a per-agent tool-call budget the graph explores up to.
- The verifier analyses the production net through a state-class graph, with an optional
  Z3/Spacer fallback.
- Differential and patched-n8n conformance harnesses classify known divergences.
- A node may declare an execution policy in workflow JSON (ADR 0009): an attempt-indexed
  `onFailure` chain of `retry` / `route` / `stop` / `continue` steps, and a per-attempt
  `timeoutMs` that arms libpetri's output timeout. A policy-free node compiles unchanged.
- An agent used as another agent's tool compiles, runs and verifies. Each level spends its own
  call budget, and one conservation law covers both.
- The live testbed boots the real editor with the scheduler installed, in `regular` mode and in
  queue mode, where a separate worker process executes and the marking round-trips through the
  database between jobs.

The implementation requires libpetri 5.1.0 or later (`^5.1.0`, and the lock pins 5.1.0). Node
outcomes route directly from `X_run` for up to three connected outputs. Wider fan-outs split routing per output to avoid exponential output
spec flattening. `_halt` is a terminal marker; the old halt-reap phase and `_halted` place no
longer exist.

## Components

| Component | Location | Role |
|---|---|---|
| Compiler | `typescript/src/compiler/` | Analyses workflow shape and builds one net per execution. |
| Scheduler | `typescript/src/scheduler/` | Binds actions, runs the precompiled net and implements n8n's scheduler interface. |
| Codec | `typescript/src/codec.ts` | Converts n8n execution state to and from a marking. |
| Verifier | `typescript/src/verify/` | Checks structural and reachability properties on the production net. |
| Differential harness | `typescript/src/conformance/` | Runs a faithful stack reference and the Petri scheduler against one fake host. |
| n8n integration | `patches/n8n/` | Adds a scheduler seam and registry to the pinned n8n commit. |
| Node-type catalogue | `scripts/node-types/` | Reads port counts and `canWait` from n8n's own generated types, so the verify CLI does not guess them. |
| Live testbed | `scripts/testbed/` | Boots the real n8n server with the scheduler installed, seeds demo workflows, and compares both engines on data and order. |

## Evidence

### Local package

The normal gate is:

```bash
cd typescript
npm run check
npm test
npm run build
```

### Pinned n8n

Commit: `441970b211d13a3ce547916b2b8ee93677b620e9`.

| Surface | Legacy | Petri | Interpretation |
|---|---:|---:|---|
| execution-engine | 1,657/1,657 | 1,653/1,657 | 4 classified regressions |
| core | 2,124/2,124 | 2,120/2,124 | Same 4 regressions |
| workflow | 9,603/9,603 | Patch-neutral | Scheduler is not entered |
| cli | 20,328/20,328 | 20,328/20,328 | Registered, never entered |

Three exercise recorded semantic differences: stuck-join handling and OR/join ordering. The
fourth is an `EngineRequest` naming a node with no `ai_tool` connection to its agent
(divergence #22), which only a hand-built request can produce. The broader run covered 32,055
cases without finding another failure class.

The exact case matrix is in [`conformance-final.md`](conformance-final.md). Do not infer
full n8n compatibility from the summary table.

The `cli` row still reads "registered, never entered", and that is still true *of that suite*:
`packages/cli`'s tests mock `n8n-core`'s `WorkflowExecute` before they reach a scheduler, so its
junit is evidence of patch neutrality. The engine is nonetheless entered by a cli-shaped
process — just not by that suite. [`testbed.md`](testbed.md) boots the real `packages/cli` with
the scheduler installed and records the run.

### Differential harness

The current sweep runs 25 fixtures at budgets 1, 2 and 4:

| Result | Runs |
|---|---:|
| Exact pass | 55 |
| Registered divergence | 20 |
| Failure | 0 |

For k-safe workflows without completion-order-sensitive stop behaviour, the budget tests
preserve run data at 1, 2, 4 and 8. Increasing the budget changes completion order, which is
expected. Data dependencies still form a valid happens-before relation. See
[`differential.md`](differential.md) for what the harness does and does not compare.

### Verification

The state-class graph closes on the acyclic fixtures, an eight-way fan-out, a 41-node chain
and the generated 21-node five-diamond workflow at budget one. It produces literal node-path
counterexamples for violations. The `ifBothOutputs` fixture, for example, exposes an
improper terminal marking in about 15 ms on the recorded machine.

Productive cycles have an infinite reachability graph. They return a `bounded` verdict
with the exact explored cyclic-node-run prefix unless another property is violated first.
Large independent fan-outs can exhaust the state limit and return `unknown`.

Representative cyclic prefixes at a 200,000-state cap:

| Fixture | Cyclic node runs | Completed passes |
|---|---:|---:|
| `loopOverItems` | 21 | 10 |
| `userCycle` | 138 | 69 |

These are search bounds, not liveness proofs. Full semantics and measurements are in
[`verification.md`](verification.md).

### Net size after the M6 collapse

Removing the routed-outcome indirection (`X/ok` + `X_route` per node, at or below three
connected outputs) and the halt reap (`_halt_reap` + `_halted`) took two places and two
transitions off every node, plus two host places. The state-class graph shrank on every
fixture that closes, which is the point: a smaller net is cheaper to verify, and no verdict
changed.

| Fixture | Places | Transitions | State classes |
|---|---|---|---|
| `linear` | 41 → **37** | 19 → **15** | 50 → **43** |
| `diamond` | 70 → **62** | 34 → **27** | 393 → **330** |
| `fanOut` | 39 → **37** | 17 → **15** | 99 → **90** |
| `multiProducer` | 46 → **42** | 24 → **20** | 245 → **218** |
| `chooseBranch` | 51 → **45** | 26 → **21** | 108 → **77** |
| `ifBothOutputs` | 65 → **58** | 34 → **28** | 889 → **732** |
| `chain40` | 411 → **370** | 204 → **163** | 2,048 → **1,967** |
| `wide8` | 84 → **82** | 37 → **35** | 6,151 → **5,894** |
| `switch20` | 240 → **238** | 109 → **107** | truncated either way |
| `loopOverItems` | 48 → **42** | 25 → **20** | bounded, k = 21 either way |

Every verdict is unchanged: proper completion proven on `linear`, `diamond`, `fanOut`,
`multiProducer`, `chooseBranch`, `chain40` and `wide8`; violated on `ifBothOutputs`
(naming `Merge/hasdata` and `Merge/ready_0`); bounded on `loopOverItems`.

Two later changes moved figures in that table without moving a verdict, so read it as the M6
measurement it is. libpetri's state-class key became canonical on 2026-09-09 — one marking is
now one class, where the clock order used to split it — which lowered the counts on exactly the
fixtures whose branches interleave: `diamond` **306**, `multiProducer` **211**,
`ifBothOutputs` **697**; `linear`, `fanOut`, `chain40` and `wide8` are unchanged. And
`loopOverItems` is `bounded` **on the graph route**, which is what this table measures; the SMT
fallback proves it outright in 0.5 s since the same day, so a full report on it reads `proven`
(ADR 0007 §13).

## Compatibility boundary

The following behaviour is intentional or currently constrained:

- Total execution order is not preserved above budget one.
- `lastNodeExecuted`, `waitTill`, the selected fatal error and similar global fields follow
  completion order under concurrency.
- A sibling already in flight may finish after another node halts or pauses the workflow.
- Acyclic joins receive explicit empty tokens. The scheduler therefore removes the cause of
  n8n's stuck-join fallback and does not reproduce that fallback.
- OR-input delivery is FIFO in the net where n8n's stack can produce LIFO order.
- The compiler lowers cyclic workflows, and workflows with several producers for one input
  index, to an effective budget of one.
- Execution order v0 is outside the current scope.
- An agent's tool calls run concurrently under the budget, where n8n runs them one at a time;
  tool *starts* still follow request order, and run data is identical at every budget.
- The verifier checks control flow. It does not model item values, wall-clock timing, total
  order or arbitrary liveness.

Each known difference has a witness and classification in
[`divergences.md`](divergences.md). New differences fail the differential gate until they are
explained or fixed.

## Remaining work

### Activation identity

Workflow JSON does not express token lineage. Guards, cycles, custom resource places and
ν-generated activation identities currently exist in the compiled net, not as first-class
n8n workflow concepts. Positional pairing is sufficient for sequential cyclic execution but
not for general concurrency through cycles or multi-producer inputs.

The next concurrency step is lineage-aware tokens, not a wider integer passed to the current
model.

### Verification scale

The state graph needs partial-order reduction, a cheaper marking key and sparse incidence
handling. Coverability analysis would give stronger answers for useful unbounded shapes.
The SMT path is deliberately capped at 12 join inputs or 450 flat places because larger
queries can exhaust memory. Forcing the fallback removes the guard, not the underlying cost.

### Concurrent global state

`waitTill`, fatal-error selection and dynamic credential bookkeeping need an explicit
completion barrier or execution-local ownership model before their k>1 semantics can be
claimed as equivalent.

### Test infrastructure

The n8n harness still needs fixes for duplicate case keys and CLI integration setup that
currently depends on external database services. These are harness limits, not scheduler
semantics.

## Commands

```bash
# Install, patch and build the pinned n8n checkout
scripts/bootstrap-n8n.sh

# Run legacy and Petri execution-engine conformance
scripts/run-conformance.sh --engines=legacy,libpetri

# Check that the patch contains only the intended scheduler seam
scripts/verify-patch.sh

# Run the differential sweep
cd typescript
npm test -- differ

# Reproduce verifier measurements
npx tsx tests/verify/measure-graph.ts
```

Use [`../scripts/README.md`](../scripts/README.md) for bootstrap and conformance options,
[`../patches/n8n/README.md`](../patches/n8n/README.md) for patch maintenance, and
[`verification.md`](verification.md) for verifier commands.
