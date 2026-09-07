# M2 conformance — n8n's execution-engine suite under the PetriScheduler

Produced by `scripts/run-conformance.sh` on the pinned n8n clone (`441970b`, patches 0001 and
0002 applied). Raw artefacts stay in the gitignored `conformance-results/`
(`<engine>.junit.xml`, `<engine>.matrix.md`, `<engine>.test.log`).

## Reporting rule

From [`CLAUDE.md`](../CLAUDE.md), as it read at M2:

> Reporting rule: of n8n's ~146 execution-engine cases only ~19 drive the loop. Headline
> numbers are loop-driving cases passed; pure-helper cases are stated separately.

The suite is larger than that prose figure (the filter `src/execution-engine` collects 1657
cases in 75 files); the classifier in `typescript/src/conformance/classify.ts` selected **36**
of them as loop-driving by describe-block name, and those 36 are this report's headline. (M4
widened it to 44 — see [`conformance-final.md`](conformance-final.md).) The remaining
1621 are pure helpers (`runNode`, `assignPairedItems`, `checkReadyForExecution`, error
reporting, execution contexts, request helpers, …), which this report states separately as a
regression guard, not as evidence that the engine works. The pinned per-pattern counts live
in `typescript/tests/conformance/classify.test.ts`.

## Headline

| engine | loop-driving | helpers | regressions vs baseline |
|---|---|---|---|
| legacy (`StackScheduler` behind the seam) | **36 / 36** | 1621 / 1621 | 0 — case set and outcomes *identical* to the unpatched baseline |
| libpetri (`PetriScheduler`) | **26 / 36** | 1619 / 1621 | 12 |

libpetri by pattern: execution-order 15/19, hook-order 6/6, branch-order 0/0, waiting 3/9,
partial 2/2.

The 12 regressions are 10 loop-driving cases plus 2 helpers. Nothing the baseline fails
passes here, and no case is missing or new — the two runs cover the same 1657 cases.

Timings on an idle machine (load average 1.5–4.2): legacy 7 s, libpetri 10 s, whole script
17 s wall. The suite is load-sensitive (an earlier run took 507 s at load average > 20 and
hit a 5 s vitest timeout), so run it idle.

## Classification

Every failing case, with its root cause. This pass fixed the `defect-fixed` cases and pinned
each with a `FakeHost` test that first failed against the pre-fix code.

| case (n8n) | class | root cause |
|---|---|---|
| `workflow-execute.test.ts` → `convertBinaryData integration > should call convertBinaryData with workflow settings during node execution` | **defect-fixed** | The node type is a `mock<INodeType>()`, so `description.requiredInputs` answers with a proxy. The adapter passed it to the compiler unchanged and `structuralHash` spread it: `TypeError: a.shape.requiredInputs is not iterable` before the first node ran, so nothing called `processNodeOutput` and the spy saw no call. `nodeShapeOf` now narrows `requiredInputs` to the two shapes n8n's stuck-join fallback can act on (a count, or an array of indexes) and drops everything else, which is what every branch reading it in `stack-scheduler.ts:395-416` and `444-465` does anyway. `outputNames` is narrowed to strings for the same reason. |
| `workflow-execute.test.ts` → `v1 execution order > should run complicated multi node workflow where multiple Merge-Node have missing data and complex dependency structure` (data) | **defect-fixed** | `Merge7` is wired only on input **1**. `entryForEdge` built `data.main = [null, items]`, mirroring `addNodeToBeExecuted`'s single-input path — but that path is unreachable above input 0 (`numberOfInputs` is `connectionsByDestinationNode[node].main.length` = `inputIndex + 1`), so in n8n such a node is reached by R6's stuck-join fallback, which substitutes `[]` for every input that never arrived and keeps the sources positional (`stack-scheduler.ts:467-491`). `null` there makes `getInputItems` throw `Input index was not set` (`base-execute-context.ts:315-325`), which halted the execution and left `Merge7` with no data. `entryForEdge` now fills `[]` below the arriving index and puts the source at that index with `null` below, matching the shape divergence #9 promises ("run on arrival with the same data"). All node data of this fixture now matches; the case still fails on execution order (row below). |
| `workflow-execute.test.ts` → `v1 execution order > should run complicated multi node workflow where multiple Merge-Node have missing data and complex dependency structure` (order) | **divergence** | Registered row **#5** (total-order `nodeExecutionOrder` assertions, LIFO artifact). Data for every node is equal; only `executionIndex` differs: n8n `… IF1, IF2, IF3, IF4, Merge1, Merge2, Merge4 …`, net `… IF1, IF2, Merge1, Merge2, IF3, Merge4, IF4 …`. Mechanism observed and proposed as row **#12** of [`divergences.md`](divergences.md): n8n `unshift`s a completed multi-input entry onto the front of a stack it also `shift`s from, so a join runs only after every sibling already queued; the net fires it as soon as it is enabled, at priority = depth. |
| `workflow-execute.test.ts` → `v1 execution order > should execute nodes in the correct order, depth-first & the most top-left one first` | **divergence** | Registered row **#5**. Data for all 23 nodes is equal; the assertion that fails is `nodeExecutionOrder` alone (`workflow-execute.test.ts:246`): `Wait3, Wait10, Wait12, Wait11` run before `Merge, Wait14, IF, …` instead of after. Same mechanism as the row above (proposed row #12). |
| `workflow-execute.test.ts` → `v1 execution order > should run node twice when it has two input connections` | **divergence** | Proposed row **#11** of [`divergences.md`](divergences.md). `Set2` has two producers on input 0 (`Start` and `Set1`). Node order is n8n's (`Start, Set1, Set2, Set2`) and the two activations carry exactly n8n's two payloads, but in the other order: the net's OR round delivers in arrival order (the `X/hasdata_i` place is FIFO), n8n's stack delivers the most recently produced first (`enqueueFn` is `unshift`, `popExecutionStack` is `shift`). So `runData.Set2[0]` and `[1]` are swapped. Not fixable from the scheduler: the delivery order is the net's token order, decided by the compiler's OR gadget. |
| `workflow-execute.test.ts` → `v1 execution order > should simply execute the next multi-input-node (totally ignoring the runIndex)` | **divergence** | Registered row **#2** (R6 stuck-join partial fire, arrival-count mismatch — abandoned, defect surfaced). `Merge2` receives two arrivals on input 0 and one on input 1; n8n's quiescence fallback runs it a second time with `[]` on the unmatched input, the net strands the extra arrival and reports it. The engine's own diagnostic names it: `node 'Merge2': stranded token on '…/ready_0' input 0 (divergence #2); written to waitingExecution`. |
| `workflow-execute-process-process-run-execution-data.test.ts` → `waiting tools > run() executes requested ai_tool actions when destination is an agent` | **out-of-scope** | AI-agent `EngineRequest` / `EngineResponse` dispatch (`collectSubNodeResults` / `handleEngineRequest`). The node fails with the declared `NodeOperationError`. |
| … → `waiting tools > handles Request objects with actions correctly` | **out-of-scope** | as above |
| … → `waiting tools > executes requested tools in the order the actions were requested` | **out-of-scope** | as above |
| … → `waiting tools > skips waiting tools processing when parent node cannot be found` | **out-of-scope** | as above |
| … → `waiting tools > resets responses between different node executions` | **out-of-scope** | as above |
| … → `waiting tools > preserves inputOverride and sets error output when AI tool node fails` | **out-of-scope** | as above |
| … → `agent node emits nodeExecuteBefore only once when resuming after tool execution` (helper) | **out-of-scope** | as above; the hook trace ends after the agent instead of running the tool. |
| … → `pairedItem sourceOverwrite handling > preserves sourceOverwrite for tools to enable expression resolution` (helper) | **out-of-scope** | as above |

Six of the eight AI-tool cases sit in the classifier's `waiting` block and therefore count as
loop-driving; two are helpers. They are the whole of the `waiting 3/9` shortfall and the whole
of the helper shortfall. Excluding them, the libpetri engine passes **26 / 30** loop-driving
cases and **1621 / 1621** helpers, and the four remaining failures are the two registered and
two proposed divergence rows above.

Every failure falls in one of three classes: fixed, a registered or proposed abandonment, or
the declared out-of-scope area. None is `defect-open`.

## Reproducing

```bash
cd typescript && npm run build          # writes dist/n8n-vitest-setup.js, the hook
scripts/run-conformance.sh              # both engines; --engines=libpetri for one leg
scripts/run-conformance.sh --engines=libpetri --skip-patch   # iteration loop
```

The generated setup shim (`packages/core/.n8n-libpetri-setup.mjs`) and its vitest config
(`packages/core/vitest.libpetri.config.mts`) are written into the clone and listed in
`.n8n/.git/info/exclude`, so `git -C .n8n status --porcelain` stays limited to the two patched
files plus the three added scheduler files.
