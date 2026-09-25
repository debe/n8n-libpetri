# Conformance at the n8n@2.41.3 pin

On 2026-09-25 the pin moved from master `441970b` (2026-09-04) to the release `n8n@2.41.3`
(`7f7a8ac`). This report records what the move changed and what it did not. The milestone
reports ([`conformance-m2.md`](conformance-m2.md), [`conformance-m3.md`](conformance-m3.md),
[`conformance-final.md`](conformance-final.md)) were measured at `441970b` and stand as
written.

Produced by `scripts/run-conformance.sh` on the pinned clone, with patches 0001 and 0002
applied, against baselines regenerated on the **unpatched** tree by
`scripts/bootstrap-n8n.sh --scope=NAME`. libpetri was 6.0.0 from the registry, not a linked
tree. Machine: macOS, Node 26. Raw artefacts are in the gitignored `conformance-results/`, and
the previous pin's artefacts are under `conformance-results/pin-441970b/`.

## Why the pin could move

Every release from `n8n@2.39.0` on contains `441970b`, so the reason for pinning master ("the
release tag predates n8n's helper extraction") no longer applies. Release tags live on release
branches, so `n8n@2.41.3` is not an ancestor of master. `scripts/check-n8n-drift.sh` checks the
patches against both.

## What changed upstream, as far as the seam is concerned

- **The patches.** Both rebase onto `n8n@2.41.3` with offset-only changes, and the extracted
  `stack-scheduler.ts` is byte-identical. The patched `workflow-execute.ts` has one change that
  matters, plus two dropped casts outside the loop.
- **#38348, "Run tool nodes of an AI Agent upstream of the destination node".** The
  `runNodeFilter` prelude in `WorkflowExecute.run()` now also adds the non-main parents of every
  main ancestor of the destination, not only the destination's own. It runs before a scheduler
  is constructed, and the net reads the filter through `host.isNodeFilteredOut`, so nothing on
  our side needed mirroring.
- **#38348's loop-driving test case.** The upstream change came with a case that runs
  trigger → agent → merge, with a tool on the agent and destination `merge`, and asserts that the
  tool ran and that the agent's last run carries its result. That is an `ai_tool` round
  (ADR 0008) under a run-node filter, so it is loop-driving. The classifier's new pattern
  `destination-tools` selects it by title. The other case in its block asserts only on the
  prelude's filter, so it stays a helper case.
- **Case counts.** The execution-engine suite grew from 1,657 to 1,715 cases. Apart from the
  #38348 cases, the growth is helper cases: routing-node 29 → 42, execution-context,
  request helpers.

## Results

Headline = loop-driving cases passed (CLAUDE.md, reporting rule). Loop-driving cases: **45**
(was 44).

| scope | cases | legacy | libpetri k = 1 | loop-driving, libpetri | kind of result |
|---|---:|---|---|---|---|
| execution-engine | 1,715 | identical to baseline | 1,711/1,715 | **41/45** | engine |
| core | 2,198 | identical to baseline | 2,194/2,198 | **41/45** | engine |
| workflow | 9,783 (2 skipped in the baseline) | identical to baseline | not applicable | n/a | patch neutrality |
| cli | 23,108 (was 20,328) | see below | identical to baseline | n/a | patch neutrality |

**The cli legacy leg was not identical in either full run, and neither failure reproduces.**
- Run 1: three `*.controller.api.test.ts` files (MCP settings, OAuth clients, OAuth consent; 74
  cases) failed in `setupTestServer`'s `beforeAll` with "Hook timed out in 10000ms". Run on
  their own, on the same patched tree, all 74 cases pass.
- Run 2, on an otherwise idle machine: those files passed. One case failed instead:
  `webhook-form-data > createMultiFormDataParser > should reject with a 413 error when a single
  file exceeds the limit`, which checks that a temp file was removed. It passed 5/5 when run
  alone.

Neither file reaches `WorkflowExecute`, and the libpetri leg of the same suite was identical to
the baseline. So the patch-neutrality statement for cli is "no case fails reproducibly". It is
not "identical in one run", which is what `441970b` recorded.

The engine was never entered by the cli suite (0 `engine entered` lines), as before. Two files
cannot be instrumented, and they stay on `StackScheduler`:
- `agent-sse-stream.test.ts`, as before;
- new: `src/__tests__/crash-journal.test.ts`, whose `n8n-core` mock does not export
  `setWorkflowSchedulerFactory`.

The four libpetri regressions are **the same four cases as at `441970b`**, with the same
classification (see `conformance-final.md`):

- three `v1 execution order` cases: stuck-join handling and OR/join ordering;
- `waiting tools > resets responses between different node executions`: divergence #22, an
  `EngineRequest` naming a node that has no `ai_tool` connection to its agent.

Pure-helper cases: 1,670/1,670 (execution-engine) and 2,153/2,153 (core). The new
`destination-tools` case **passes** under the net.

Budget legs, compared with the k = 1 libpetri leg as the script does, not with the baseline:

| budget | loop-driving | regressions against k = 1 |
|---|---|---|
| k = 2 | 38/45 | 3, the same three as the archived k = 2 leg |
| k = 4 | 39/45 | 3, the same three as the archived k = 4 leg |

The budget restrictions (`libpetri-k*.budget.txt`) are byte-identical to the archived ones.
The archived k > 1 matrices predate M7's agent dispatch (their `waiting` column reads 3/9), so
compare only their regression sets with these, not their headlines.

Diagnostics at k = 1 keep the same nine classes as before. There is one more "agent without a
static `maxIterations`" line, and it comes from the new #38348 case.

## Node-type catalogue

`scripts/node-types/extract.mjs` on the new dist passes every anchor assertion. The result is
1,732 keys, up from 1,718. The 14 additions are new node versions and tool variants
(Databricks, Microsoft Dataverse, Confluence tool, MiniMax, Alibaba Cloud chat, and newer
`executeWorkflow` and `editImage` versions). No existing entry changed, and `canWait` is
identical.

## Live testbed (an integration result, not a conformance number)

`scripts/testbed/diff-engines.sh` on the rebuilt server. It runs one server per leg, a single
run per workflow, with the stub LLM instant:

| workflow | legacy | libpetri k = 1 | libpetri k = 4 | data | happens-before |
|---|---:|---:|---:|---|---|
| Concurrency Showcase | 10,184 ms | 10,273 ms | 2,728 ms | identical | 14 edges ok |
| Agent · Two Tools | 654 ms | 633 ms | 674 ms | identical | 2 edges ok |
| Agent · Nested Agents | 909 ms | 913 ms | 585 ms | identical | 2 edges ok |

The orders match what [`testbed.md`](testbed.md) recorded at the old pin. That includes Nested
Agents being reordered at k = 1: `Calculator#0` runs before `Inner Calculator#0`, the same
sequence as before.

Queue mode (`n8n-testbed.sh --queue --daemon`, Redis on 6399): the worker logged
`scheduler registered`, and the engine was entered in the worker. Concurrency Showcase
(2,748 ms) and Agent · Nested Agents (1,162 ms) both have data identical to the legacy
single-process run, with no happens-before edge inverted. These are single runs, so the wall
clocks are indications, not benchmarks.

## Template survey

`node scripts/templates/survey.mjs` (k = 4, 45 s per workflow, 4 at a time), with the new
catalogue and libpetri 6.0.0: **200/200 compiled and verified, 0 refused, 0 timed out**.
101 workflows would run at k > 1, and 27 carry a `violated` check.

The comparison is against the archived rows from the 2026-09-17 run (libpetri 6.0.0, old
catalogue). Every one of the 200 workflows has the same outcome, the same structural hash, the
same budget and the same verdict on every check. The 14 new catalogue keys changed no compiled
net. Shapes guessed from connections: 235 of about 5,133 nodes, previously 236.

A `violated` here is a witness in the priority- and value-blind abstraction (VER-004), not a
proof about n8n.

## libpetri 7.0.0 on the same pin

The bump was measured separately from the re-pin, so the two effects stay apart. Registry
7.0.0, same machine, compared with the 6.0.0 numbers above:

- Suite 1075/1075, and typecheck clean.
- Conformance at k = 1, 2 and 4, execution-engine and core: the same headlines and the same
  regression sets.
- Survey: 200/200. Outcome, structural hash, budget, and every verdict and reason are identical
  once the timings in the explanation text are stripped.
- A first survey run showed 3 timeouts. It overlapped another project's z3-heavy test run
  (5-minute load average 68). Run alone, the three affected workflows take the same time and
  peak memory on 6.0.0 and 7.0.0 (for example 19.6 s / 900 MB against 19.7 s / 899 MB). The
  rerun on a quiet machine had no timeouts. **Survey timeouts depend on load; check the load
  before believing one.**
- Forced SMT fallback on the 11 testbed workflows: 279 checks identical in verdict, route and
  method. See [`verification.md`](verification.md), "SMT fallback".

