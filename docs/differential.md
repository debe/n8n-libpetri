# The differential harness and the concurrency benchmark

Milestone M3, track H. Two things live here: a **differ** that runs one workflow through
both engines in one process and compares them, and a **benchmark** that measures what the
budget `k` actually buys. The differ has a gate; the benchmark has none — it is the evidence
for the claim in [`README.md`](../README.md) that *two independent 500 ms HTTP calls should
take ~500 ms, not ~1 s*.

- Differ: `typescript/src/conformance/differ.ts`, CLI `differ-cli.ts`,
  reference engine `stack-reference.ts`, shared host `harness.ts`.
- Fixtures: `typescript/tests/conformance/differ-fixtures.ts`.
- Tests: `typescript/tests/conformance/differ.test.ts`.
- Benchmark: `typescript/tests/benchmark/concurrency.bench.ts` (`npm run bench`).

This is not the conformance run. `scripts/run-conformance.sh` drives n8n's own execution-engine
suite against the real `WorkflowExecute` and is the authority on conformance
([`conformance-m2.md`](conformance-m2.md)); the differ is an in-process microscope over the
project's own fixtures, which the conformance suite cannot give — it can compare *both*
engines' `runData` node by node, and it can see the concurrency, which n8n's assertions cannot
express.

## The differ's contract

### Both engines, one host

Both legs run against the same `FakeHost` — the structural mirror of `WorkflowExecute` at the
pinned commit `441970b` that the scheduler suite already uses (moved from
`tests/scheduler/support.ts` to `src/conformance/harness.ts` in this milestone;
`tests/scheduler/support.ts` re-exports it unchanged). Every node's behaviour is a script, a
pure function of `(executionData, runIndex)`, so both engines see identical node outputs and
any difference in the result is a difference between the two *schedulers*.

- **candidate** — `PetriScheduler` at budget `k`. Its host's `addNodeToBeExecuted` is left
  fatal ("must never be called"), so a scheduler that reached for n8n's dispatch queue would
  fail the run rather than pass quietly. That is the "the net decides what runs" rule, enforced.
- **reference** — `StackReferenceScheduler`, a port of n8n's
  `packages/core/src/execution-engine/stack-scheduler.ts` plus the one `WorkflowExecute` member
  it drives, `addNodeToBeExecuted` (`workflow-execute.ts:445-851`). Line numbers of the original
  are carried in the comments so the port can be diffed against n8n.

**The reference engine is v1 only, and that is not a shortcut.** The whole ancestor-forcing
block of `addNodeToBeExecuted` (`workflow-execute.ts:610-778`) ends every iteration of its inner
loop at `if (!this.isLegacyExecutionOrder(workflow)) continue;` before it can touch any state, so
under v1 the block is observably a no-op and is not ported. v0 is out of scope for the project
(divergence #3). `enqueueFn` is therefore always `unshift`. The port adds one thing n8n does not
have: a 10 000-activation safety valve, because n8n's own loop spins forever on a cycle that
keeps producing (its endless-loop guard only catches the deferred `ensureInputData` case) and a
hung differ is worse than a loud one.

### The three comparisons, in order

**1. Data equivalence — the gate.** Three things, all of them the gate:

- **`resultData.runData`** — for every node and run index: `data` (including `pairedItem`),
  `source` (`previousNode` / `previousNodeOutput` / `previousNodeRun`), `executionStatus`,
  `metadata`, and the error shape (`name`, `message`; not the stack). Not compared:
  `startTime`, `executionTime`, `executionIndex`, `hints` — timing and ordering, which are the
  next two sections' business. Also not compared, and listed here rather than left implicit:
  `inputOverride`, `redactedError`, and `usedDynamicCredentials` / `attemptedDynamicCredentials`
  (divergence #18's observable, which no scheduler can scope above k = 1).
- **the resumable state** — `IRunExecutionData.executionData` (`nodeExecutionStack` entry by
  entry, `waitingExecution`, `waitingExecutionSource`, `contextData`) and `waitTill`. This is
  what n8n persists with a paused, waiting or failed execution and what "Retry execution" and
  a Wait resume replay, and producing it is the marking codec's whole job. Two engines that
  agree on every `ITaskData` and leave a different stack behind have not produced the same
  execution — `chooseBranch` and `ifBothOutputs` do exactly that.
- **the `WorkflowScheduler` contract values** — `executionError` and whether a `closeFunction`
  was registered. Neither is part of `IRunExecutionData`; `processRunExecutionData` reads them
  off the scheduler after `run()` and persists the execution as a success or a failure by the
  first (`workflow-execute.ts:2250-2255`). A scheduler that lost the halting error would
  otherwise pass every check here.

The first difference is reported with a path (`runData.C[0].data.main[0][0].json.i`).

The walk itself compares `Date`s by instant, `Buffer`s byte by byte, `Error`s by name and
message, and treats a `Map`, a `Set` or any other class instance as different unless it is
literally the same object. (Anything whose `Object.keys` is empty used to compare *equal* to
anything else of the same kind, so two different `Date`s — which n8n node output carries
routinely — passed silently.)

`resultData.lastNodeExecuted` is deliberately *not* part of the data gate: it records which
node ran **last**, a fact about the total order and nothing about any node's result, so it is
checked in the ordering section instead — and only counts as attributable when both names
belong to nodes that actually ran in both engines (row #16 at `k > 1`, row #5 at `k = 1`).

**2. Happens-before.** Each engine's `runNode` trace gives a partial order over activations
(one `start` and one `finish` per `(node, runIndex)`, folded across retries). The realised data
dependencies are read off each `ITaskData.source`, so they name exact activations, not just
nodes. Two checks:

- inside each engine, every realised dependency is respected: `finish(producer) < start(consumer)`;
- the net's partial order is a **weakening** of n8n's total order: every dependency n8n realised
  is ordered the same way under the net. Independent pairs may be unordered — that is the
  concurrency, and it is not a violation.

The weakening check runs over the *intersection* of the two realised dependency graphs. When
the data gate passes the two graphs are identical by construction; only under a data difference
can they differ, and then comparing the orders of two different graphs would say nothing. The
count of n8n edges the net never realised is reported (`unmatchedEdges`), and every report
states it — an edge the check did not compare is never invisible.

An edge whose producer or consumer left **no `runNode` observation** (the activation is in
`runData` but not in the trace, which happens when a pinned output short-circuits the run) is
counted as `absentEdges` and is a **violation**: an edge the harness cannot observe is an edge
it cannot clear. It used to be counted as checked and then dropped.

**3. Ordering report — not a gate.** The `executionIndex` sequences side by side, and every
activation whose rank differs, attributed:

| attribution | when |
|---|---|
| `concurrency` | `k > 1` and the activation has no dependency either way with the ones it passed |
| divergence **#11** `or-input-lifo` | the node's runs are a permutation: n8n delivers the most recent arrival first (`unshift`/`shift`), the net's `hasdata` place is FIFO |
| divergence **#12** `join-unshift` | a multi-input join moved: n8n `unshift`s a completed join entry so it runs after every queued sibling |
| divergence **#20** `or-input-arm` | an OR-input node moved: its `arm` transition costs a scheduling cycle and a shallower sibling takes the budget unit in it |
| divergence **#2** `stranded-join` | the net stranded an arrival and said so, so the join and its descendants ran a different number of times |
| divergence **#1** `starved-join` | n8n left the join in `waitingExecution` and never ran it; the net's explicit empty token completes it |
| divergence **#13** `destination-stop` | an activation n8n ran after the destination node, while the net had already deposited `_pause` |
| divergence **#17** `halt-window` | an activation only the net ran, because the execution halted, paused or was cancelled while it was in flight (or it started inside that window) |
| divergence **#16** `last-node-executed` | `resultData.lastNodeExecuted` moved at `k > 1`: the field records the last node to *complete*, which is its definition under concurrency. At `k = 1` the same difference is row #5 |
| divergence **#5** `unnamed` | order only — data equal, happens-before intact — so it is the LIFO artifact row #5 abandons, but no registered row names *this* mechanism. Flagged `novel`, which the CLI exits non-zero on |
| `unattributed` | anything else. **A finding, never a pass.** |

An activation that exists in **one engine only** never gets `concurrency`: it did not move,
it exists once, and "no dependency either way with the activations it passed" is vacuously
true over an empty list. Such an activation is matched against rows #2, #1, #13 and #17, in
that order, and is `unattributed` if none of them applies.

Row #5 as the umbrella and the mechanism named separately is exactly how
[`conformance-m2.md`](conformance-m2.md) classifies its two order failures.

Data differences are attributed too, but only by the registered rows that abandon an n8n
*behaviour* rather than change a node's result: **#11** (a permutation of a node's runs),
**#2** (a stranded join, plus everything downstream of it, read out of the engine's own
diagnostic), **#1** (a join n8n left starved in `waitingExecution`), **#13** (the
destination-node stop) and **#17** (the halt / pause window). Everything else is unattributed
and fails.

**#2 and #1 excuse a run *count*, never a run's content.** Both rows are about a join and its
descendants running a different number of times, and about the arrival the codec wrote back
instead — so only `runData.<node>` (missing entirely), `runData.<node>.length` and the
`executionData.*` paths are attributable to them. A per-field difference *inside* a run of such
a node stays unattributed, because the project's rule is that a data difference is never a
divergence.

### Verdicts

| verdict | meaning |
|---|---|
| `pass` | nothing differs |
| `divergent` | every difference — data and order — is attributed to a registered `docs/divergences.md` row |
| `fail` | something is unattributed, happens-before broke, or the two `run()` calls rejected differently |

`novelMechanisms` is orthogonal: a `divergent` run can still surface a mechanism the register
does not name, and the test suite pins that set, so a *new* one fails the build.

### Running it

```bash
cd typescript
npm test -- differ                                  # the whole sweep, k = 1, 2, 4
npx tsx src/conformance/differ-cli.ts tests/conformance/differ-fixtures.ts --out report.md
npx tsx src/conformance/differ-cli.ts tests/conformance/differ-fixtures.ts \
    --fixture parallelBranches --budget 2 --title 'concurrency'
```

The CLI takes any module whose default export (or `DIFFER_FIXTURES` export) is an array of
`DifferFixture`, runs each at every `--budget` (default 1, 2 and 4), writes the Markdown
report and exits non-zero on a `fail` **or on any ordering mechanism the register does not
name**. A novel mechanism is not a `fail` verdict — data and happens-before are intact — but
`docs/divergences.md` says nothing is skipped silently, so a CI leg must not go green on one.

### What this harness cannot see

- **Expression semantics.** `FakeHost.runNode` does not evaluate expressions, so the reference
  engine cannot produce n8n's "node is unexecuted" error and divergence **#7** (cross-branch
  `$('Y')`) is not differentiable here. The differ fixtures therefore carry no `$('Y')`
  parameters. It is covered by the conformance run against the real host.
- Everything else `FakeHost` does not mirror at `441970b`: `convertBinaryData`,
  `handleNodeErrorOutput`, the `sendChunk` hook, the AI-tool rewire paths. In particular the
  halt window (row #17) is *narrower* here than in the real host, which awaits `sendChunk` and
  `nodeExecuteAfter` inside `handleNodeExecutionError` before the halt token is written.
- **Divergence #18** — `usedDynamicCredentials` / `attemptedDynamicCredentials` are excluded
  from the comparison rather than checked: the write is inside n8n's credential layer, which
  this host does not mirror.
- **The candidate leg has no timeout.** Cancellation is `close()`-only and
  `executor.run(timeoutMs)` is forbidden, so a net that never quiesces hangs the differ. The
  reference leg has its 10 000-activation valve; the fixtures bound the candidate instead.
- v0 workflows (divergence #3) and `runPartialWorkflow2`.

## Results

21 fixtures — the 16 in `tests/fixtures/workflows.ts`, `parallelBranches` (built to make the
concurrency visible) and the four **stop-surface** fixtures (`haltInFlight`, `waitTill`,
`destinationStop`, `runFilter`) — at k = 1, 2 and 4. Nothing fails at any budget;
happens-before holds everywhere, with no absent and no inverted edge; every ordering mechanism
has a register row.

| k | pass | divergent | fail |
|---|---|---|---|
| 1 | 16 | 5 | 0 |
| 2 | 15 | 6 | 0 |
| 4 | 15 | 6 | 0 |

The divergent runs, with the rows that explain them:

| fixture | k | rows | what differs |
|---|---|---|---|
| `multiProducer` | 1, 2, 4 | #20 | order only. n8n `Trigger, A, C, B, C`; the net `Trigger, A, B, C, C` — the OR-input arm latency. All data equal |
| `userCycle` | 1, 2, 4 | #11, #5 | `Exit`'s two runs are swapped (n8n takes the most recent arrival off the stack first), and the surrounding order moves with them |
| `ifBothOutputs` | 1, 2, 4 | #2, #11, #12 | `C`'s two runs are swapped, and the net strands the second `Merge` arrival (`node 'Merge': stranded token on 'id:Merge/ready_0' input 0`) where n8n's quiescence fallback re-runs `Merge` with `[]`, so `Merge` and `End` run once instead of twice — and the stranded arrival is left in `waitingExecution`, which the resumable-state comparison now sees |
| `parallelBranches` | 2, 4 | #16 | the point of the milestone: n8n `Trigger, A1, A2, B1, B2`, the net `Trigger, A1, B1, B2, A2`, every moved pair independent, data equal; `lastNodeExecuted` moves with the completion order |
| `haltInFlight` | 2, 4 | #17 | `A` fails fatally at 1 ms while `B` is 20 ms into its run. n8n `break`s and never runs `B`; the net cannot un-start it, so `B` completes, is recorded and routes, and `D` (not `B`) is what goes back on the stack. Identical at k = 1 |
| `destinationStop` | 1, 2, 4 | #13, #20 | `multiProducer` with `destinationNode: C`. n8n keeps popping the stack after the destination and runs `C` a second time; the net deposits `_pause` and quiesces, leaving that arrival in `waitingExecution` |
| `runFilter` | 1, 2, 4 | #1 | `diamond` with `B` excluded by the run filter. n8n drops `B`'s entry at `isNodeFilteredOut` with a `continue`, which skips its R6 block, and the loop exits with `Merge` still in `waitingExecution`; the net's explicit empty token completes the join, so `Merge` and `End` run |

`waitTill` is identical at every budget: the node that set the field claims the pause, the
codec writes the same `nodeExecutionStack` back, and the run stops there.

`multiProducer`, `destinationStop`, `ifBothOutputs`, `loopOverItems` and `userCycle` are held at
effective k = 1 by the compiler's k-safety check (cyclic, or an input index with more than one
producer), which the sweep asserts.

### What the sweep is and is not evidence for

Every registered row the differ can reach is now reached by a fixture: #1, #2, #11, #12, #13,
#16, #17, #20 and the `concurrency` attribution. What it still cannot reach is #7 (expressions),
#18 (dynamic credentials), #3 (v0) and #6/#14 (the endless-loop guard), for the reasons under
[What this harness cannot see](#what-this-harness-cannot-see). "Nothing fails at any budget" is
a statement about those 21 workflows and this host — not about `WorkflowExecute`, which is what
`scripts/run-conformance.sh` measures.

## The benchmark

`typescript/tests/benchmark/concurrency.bench.ts`, run with `npm run bench` (vitest's
benchmark mode, which is where a `.bench.ts` file goes — `npm test` does not pick it up).
Real timers throughout; the node behaviour is a `sleep`, so the figures are dominated by the
sleeps exactly as a real workflow is dominated by its HTTP calls.

**Machine.** Apple M1 Pro (10 cores), 32 GB, macOS 26.5.2, Node v26.8.1, vitest 4.1.11.
**Load.** 1-minute load average 4.25 at the start of the run and 3.93 at the end — a
working machine, not an idle one. **Re-measure on an idle machine before quoting the absolute
numbers anywhere they matter**; a later re-run under a load average near 20 reproduced the
fan-out *ratios* but inflated every absolute by 3–5×, with ±30–50 % rme on the sub-millisecond
rows.

**Tolerance.** A sleep-driven measurement on a loaded machine runs long, never short, so read
every number as an upper bound and compare *ratios* between rows rather than absolutes. The
`500 ms` groups run one iteration each (their runtime is seconds); timer jitter on them is a
few milliseconds against node times of hundreds — under 2 %, which the measured overshoot
(1006 ms for a nominal 1000 ms) confirms. The sub-millisecond groups run 20 iterations and
report ±3–6 % rme, except the cold-cache row (±20 %: it allocates a fresh net every iteration
and is at the mercy of the GC).

### 1. Fan-out — the claim

`Trigger` into *width* independent branches, each sleeping 500 ms. Mean of one iteration, ms.

| workflow | n8n | libpetri k=1 | k=2 | k=4 |
|---|---|---|---|---|
| fan-out 2 × 500 ms | 1006.20 | 1019.31 | **507.15** | 507.58 |
| fan-out 4 × 500 ms | 2010.19 | 2018.94 | 1006.97 | **503.84** |
| fan-out 8 × 500 ms | 4021.42 | 4023.16 | 2009.26 | **1005.98** |

The claim holds exactly: *two independent 500 ms branches take 1006 ms under n8n and 507 ms
under the net at k ≥ 2*, and every row is `ceil(width / k) × 500 ms` to within 20 ms. k = 1
tracks n8n to within 1.3 % — the net at budget 1 is n8n-sequential, which is what M2 proved
by conformance and this measures by clock.

### 2. Deep chain — what the budget costs when there is nothing to win

`Trigger → N0 → … → N7`, each sleeping 500 ms. No parallelism is available at any budget.

| engine | mean (ms) |
|---|---|
| n8n | 4031.38 |
| libpetri k=1 | 4024.17 |
| libpetri k=2 | 4028.64 |
| libpetri k=4 | 4028.13 |

Within 0.2 % of each other: raising `k` on a workflow with no concurrency to find costs nothing.

### 3. Scheduling overhead — what the net costs per node

A 100-node chain with 0 ms actions, so the measurement is scheduling and host work only.
20 iterations.

| engine | mean (ms) | per node |
|---|---|---|
| n8n loop | 0.9654 | 9.7 µs |
| libpetri k=1, warm cache | 2.5929 | 25.9 µs |
| libpetri k=4, warm cache | 2.5368 | 25.4 µs |
| libpetri k=1, cold cache (compiles every run) | 8.9005 | 89.0 µs |

**The net costs ≈ 16 µs per node** over n8n's own loop with a warm compiled-workflow cache
(2.59 ms − 0.97 ms over 100 nodes), and ≈ 79 µs per node if every execution recompiles. Both
figures include the whole per-execution path: the n8n `Workflow` adapter, the structural
analysis and hash that form the cache key, the initial marking, the executor, and the ~21
`FakeHost` calls per node that n8n makes anyway.

Against the workloads this scheduler exists for — 80 ms for an HTTP node, 400 ms for an LLM
node — 16 µs is 0.02 % of one node's runtime. This is the number behind the plan's "the win is
concurrency, not scheduler speed", and the reason a Rust backend is unnecessary.

### 4. Compile — a 185-node workflow

46 four-node branches plus a trigger: 185 nodes, the size the plan names. 10 iterations.

| stage | mean (ms) |
|---|---|
| `compile()` — net + `NetMap` | 6.3100 |
| `compile()` + `PrecompiledNet` | 8.7031 |

Under 9 ms for the whole thing, once per `(structural hash, budget)` and then cached
(`CompiledWorkflowCache`, LRU 16). The plan flags n8n's own ~48 s pre-execution validation of a
workflow that size as the comparison point; that figure is n8n's and is not measured here.

## The budget leg of the conformance run

`scripts/run-conformance.sh --budget=N` runs the libpetri engine at concurrency budget `k = N`
by exporting `N8N_LIBPETRI_BUDGET`, which `src/n8n-vitest-setup.ts` reads and passes to
`registerPetriScheduler()`. `k = 1` is the default and keeps the M2 artefact names
(`libpetri.junit.xml` / `libpetri.matrix.md`); every larger budget writes
`libpetri-k<N>.{junit.xml,matrix.md,test.log}`, so the legs never overwrite each other.

```bash
cd typescript && npm run build                       # writes dist/n8n-vitest-setup.js
scripts/run-conformance.sh --engines=libpetri --budget=2
```

Read that matrix for **data equivalence**, not for n8n's total order: above k = 1 several nodes
run at once, so the ordering-only failures (rows #5, #11, #12) multiply. That is the same
reporting rule M2 used, with a wider blast radius.

Which is why a `k > 1` leg is **not compared to the baseline**, and its exit status is not the
baseline's verdict: n8n's own suite asserts its total order, so a concurrent run fails it by
construction and the comparison would say nothing. The leg is compared to the **k = 1 libpetri
leg** (`conformance-results/libpetri.junit.xml`) — same engine, same divergences, only the
budget differs, so a regression there is a real one — and gates on that. If the k = 1 artefact
is missing the matrix is still written against the baseline, but the result is logged as
informational and does not set the exit status.

A `k > 1` leg also runs with `N8N_LIBPETRI_DIAGNOSTICS=1` and collects the compiler's k-safety
restrictions into `conformance-results/<label>.budget.txt`, so it is visible how many of n8n's
own workflows actually ran above k = 1:

```
   1 [n8n-libpetri] budget: k=2 lowered to 1 (multi-producer-input: Set2.0 has 2 producers)
   1 [n8n-libpetri] budget: k=2 lowered to 1 (cyclic: nodes in a cycle: IF, IF1, Set, Set1)
```

(Measured on `workflow-execute.test.ts` alone at k = 2. The diagnostics go through
`process.stderr.write` rather than `console.warn`, because n8n-core's vitest config does not
print captured console output.)

### The benchmark rows check themselves

Both drivers swallow a rejection by design (`execute()` into `Execution.error`, `runLeg` into
`EngineRun.error`), so a workflow neither engine can run returns in a fraction of a millisecond
having run nothing — and `vitest bench` would print that as an enormous win. Every row
therefore asserts, before returning, that the run did not error and that every node ran; the
fan-out rows additionally assert `maxInFlight === min(k, width)`, which is the observable that
separates real concurrency from a short run. A row that fails the check writes
`bench guard — <workflow>: <reason>` to stderr and produces no number.
