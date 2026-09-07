# Differential testing and benchmarks

The differential harness runs one workflow through two schedulers in one process:

- `StackReferenceScheduler`, a source-traceable port of n8n's v1 stack scheduler at commit
  `441970b`;
- `PetriScheduler`, with a requested budget of 1, 2 or 4.

Both use the same `FakeHost` and the same scripted node behaviour. A difference therefore
comes from scheduling semantics, not credentials, network calls or node implementations.
This is a focused scheduler microscope. The patched n8n conformance run remains the authority
for integration with the real `WorkflowExecute` host.

## Contract

The harness compares three things in order.

### 1. Data

The data gate compares:

- `runData`, including sources and paired-item metadata;
- resumable `executionData`;
- scheduler outcome and errors;
- the observable scheduler contract.

Objects are compared structurally without treating unrelated class instances as equal.
`lastNodeExecuted` is excluded from the data gate because it describes total completion
order. It is reported with ordering differences.

Any data difference must match a registered semantic divergence. A row about run count may
explain a missing run or downstream activation, but never different fields inside a run.

### 2. Happens-before

Each `runNode` call emits start and finish events for one `(node, runIndex)` activation.
Realised dependencies come from `ITaskData.source`.

The harness checks:

1. every producer finishes before its consumer starts in each engine;
2. every dependency realised by both engines has the same direction under the Petri net.

Independent activations may overlap or swap order. That is not a violation. An edge with no
observable start or finish event is a failure because the harness cannot prove its order.

### 3. Total order

The two `executionIndex` sequences are reported side by side. Order is diagnostic, not a
gate, when data and happens-before remain valid. Known mechanisms include:

| Mechanism | Meaning |
|---|---|
| concurrency | Independent activations moved at k>1. |
| `or-input-lifo` | n8n's stack delivers the newest arrival first; the net's place is FIFO. |
| `join-unshift` | n8n queues a completed join behind existing siblings. |
| `stranded-join` | The net exposes a pending join token rather than invoking n8n's fallback. |
| `starved-join` | n8n leaves a join in `waitingExecution`; explicit empty tokens complete it in the net. |
| `destination-stop` | The net deposits `_pause` before an activation n8n still runs. |
| `halt-window` | An action was already in flight when another action halted or paused execution. |
| `last-node-executed` | Completion order changed the global last-node field. |

An unrecognised mechanism is `unattributed` and fails the run. A known divergence can still
surface a new mechanism; that also fails until the register names it. Nothing becomes green
because it merely looks concurrent.

## Verdicts

| Verdict | Meaning |
|---|---|
| `pass` | Data, dependencies and relevant order are equal. |
| `divergent` | Every difference matches a registered semantic divergence. |
| `fail` | Data is unexplained, happens-before broke, an edge was unobservable, or execution rejected differently. |

The divergence register is [`divergences.md`](divergences.md).

## Run the differ

```bash
cd typescript

# Full fixture sweep at k=1,2,4
npm test -- differ

# Markdown report
npx tsx src/conformance/differ-cli.ts \
  tests/conformance/differ-fixtures.ts \
  --out report.md

# One fixture and budget
npx tsx src/conformance/differ-cli.ts \
  tests/conformance/differ-fixtures.ts \
  --fixture parallelBranches \
  --budget 2 \
  --title concurrency
```

A fixture module exports `DifferFixture[]` as its default export or as
`DIFFER_FIXTURES`. The CLI exits non-zero on `fail`, `unattributed`, or a novel ordering
mechanism.

## Current result

The sweep contains 23 workflows and runs each at budgets 1, 2 and 4.

| Budget | Pass | Registered divergence | Fail |
|---:|---:|---:|---:|
| 1 | 19 | 4 | 0 |
| 2 | 15 | 8 | 0 |
| 4 | 15 | 8 | 0 |
| **Total** | **49** | **20** | **0** |

The divergent fixtures exercise these cases:

| Fixture | Budgets | Main cause |
|---|---|---|
| `userCycle` | 1,2,4 | OR-input FIFO/LIFO order |
| `ifBothOutputs` | 1,2,4 | Stranded join and downstream run count |
| `destinationStop` | 1,2,4 | Earlier pause in the net |
| `runFilter` | 1,2,4 | Explicit empty completes a join n8n leaves waiting |
| `parallelBranches` | 2,4 | Independent completion order and `lastNodeExecuted` |
| `complicatedMulti` | 2,4 | Independent activations moved |
| `haltInFlight` | 2,4 | Sibling completed inside the halt window |
| `webhookRespond` | 2,4 | Respond node was already in flight |

`multiProducer`, `destinationStop`, `ifBothOutputs`, `loopOverItems` and `userCycle` are
lowered to an effective budget of one by the compiler's current k-safety rule. Their presence
in wider-budget legs checks that the lowering remains stable.

The result is evidence for these fixtures and this host. It is not a compatibility claim for
all of `WorkflowExecute`.

## Harness limits

`FakeHost` does not evaluate expressions, load credentials, convert binary data, send chunks
or execute AI-tool rewiring. It therefore cannot cover:

- cross-branch `$('Y')` behaviour;
- dynamic credential bookkeeping;
- the full real-host halt window;
- `EngineRequest` and `EngineResponse` dispatch;
- execution order v0 or `runPartialWorkflow2`.

The candidate leg intentionally has no timeout. Closing the executor is the cancellation
mechanism; a timeout inside `executor.run()` would change semantics. Fixtures must therefore
bound productive cycles themselves.

## Benchmarks

Run:

```bash
cd typescript
npm run bench
```

The benchmark answers two practical questions: does the budget permit real overlap, and what
does the scheduler cost when node work is zero? It is not evidence that Petri nets matter
because several timers can run at once.

Recorded on an Apple M1 Pro, Node 26.8.1:

### Independent 500 ms branches

| Shape | n8n | Petri k=1 | Petri k=2 | Petri k=4 |
|---|---:|---:|---:|---:|
| 2 branches | 1006 ms | 1019 ms | 507 ms | 508 ms |
| 4 branches | 2010 ms | 2019 ms | 1007 ms | 504 ms |
| 8 branches | 4021 ms | 4023 ms | 2009 ms | 1006 ms |

The useful assertion is `maxInFlight === min(k, width)`. Wall-clock time merely confirms
that the actions actually overlap.

### Scheduler cost

A 100-node zero-work chain measured:

| Engine | Total | Per node |
|---|---:|---:|
| n8n stack loop | 0.97 ms | 9.7 µs |
| Petri k=1, warm cache | 2.59 ms | 25.9 µs |
| Petri k=4, warm cache | 2.54 ms | 25.4 µs |
| Petri k=1, cold cache | 8.90 ms | 89.0 µs |

The warm scheduling delta is about 16 µs per node. Compiling a 185-node workflow plus
`PrecompiledNet` took 8.7 ms and is cached by structural hash and budget in a 16-entry LRU.

Absolute timings depend on machine load. The benchmark guards reject errored or incomplete
runs before recording a number. Re-measure before quoting the absolute values elsewhere.

## Real n8n budget legs

The patched conformance runner can execute n8n's suite with a larger budget:

```bash
cd typescript && npm run build
cd ..
scripts/run-conformance.sh --engines=libpetri --budget=2
```

A k>1 leg compares against the Petri k=1 leg, not the legacy baseline. n8n's own tests assert
total order, so comparing concurrent completion order directly to legacy would manufacture
failures. Budget restrictions are written to
`conformance-results/<label>.budget.txt`; engine-entry diagnostics distinguish a registered
scheduler from one the selected test suite actually constructed.
