# Resync to n8n master `944afe5`

On 2026-10-02 the pin moved from the release `n8n@2.41.3` (`7f7a8ac`) to n8n master `944afe5`
(ADR 0013: engine v2 is primary, v1 is frozen). This report records what the move changed.
Raw artefacts are in the gitignored `conformance-results/`, and the previous pin's are under
`conformance-results/pin-2.41.3/`. libpetri was 7.0.0 from the registry. Machine: macOS,
Node 26.

## The patches

Patches 0001/0002 rebase onto master with offset-only changes. The rebase needs `--onto`,
because a release tag is not an ancestor of master. The extracted `stack-scheduler.ts` is
byte-identical. Upstream's only change in the patched files is three `oxlint-disable` comments,
all outside the extracted loop.

## The frozen v1 path

These are regression checks of the frozen path (ADR 0013), not new engine results. The
headline is still loop-driving cases passed.

| scope | cases | legacy | libpetri k = 1 | loop-driving, libpetri |
|---|---:|---|---|---|
| execution-engine | 1,756 (was 1,715) | identical to baseline | 1,752/1,756 | **41/45** |
| core | 2,258 (was 2,198) | identical to baseline | 2,254/2,258 | **41/45** |
| workflow | 10,662, 2 skipped (was 9,783) | 1 spurious pair, see below | not applicable | n/a |
| cli | 25,297 (was 23,108) | identical to baseline | no regression | n/a |

- **The same regressions.** The four libpetri regressions are the same four cases as at both
  earlier pins. At k = 2 and k = 4, the same three cases regress against k = 1. There are
  still 45 loop-driving cases. The growth is helper cases, routing-node among them (42 → 44).
- **The workflow leg** reports one regression and one fixed case for the same case,
  `Expression > getParameterValue() > should keep global objects isolate-local under the vm
  engine`. It appears three times, once per vitest project in n8n-workflow, and the matrix pairs
  repeated cases by position. That is the known `caseKeys` limit (`tasks/todo.md` §5), not a
  regression.
- **The cli baseline itself** had one hook-timeout flake (`discover.service.test.ts`), and
  neither leg regressed against it.

## Engine v2 at master

The decision core is unchanged between `n8n@2.41.3` and `944afe5`:
- `settlement.ts`, `completion.ts`, `iteration-mapping.ts`, `loop-ledger.ts` and
  `batch-step.ts`;
- `graph/loops.ts` and `validate-executable-graph.ts`;
- the converter, apart from one comment.

The six dist files the golden stamps hash identically.

| check | result at master |
|---|---|
| `tasks/v2-acceptance.mts` | 310 entries, 209 accepted by both; 17,587 mutants; 0 verdict / graph / code disagreements; 38 of 38 throw sites mapped |
| `tasks/v2-differential.mts` (20 × 20) | 83,600 runs, legs (a), (b) and (c): 0 disagreements |
| `tasks/spike-v2-exhaustive.mts` (4 passes, 1M cap, ≤ 14 nodes) | 196 graphs, 123,142 row sets: 0 disagreements |
| CI golden | re-recorded; only the stamp's version label moved (`n8n@2.41.3` → `n8n@2.42.0`, the package version on master), 0 findings |

What master adds around the core, all outside the planner's inputs so far, is the work of
ADR 0013 decision 4(a):
- the `waiting` step status (suspend and resume);
- `cancelPendingSteps`, which cancels queued *and* waiting rows after a failure;
- the execution status `waiting`;
- cancellation on request.

Until that lands, the decoder still refuses a `waiting` row as an unknown status.

`wait` and `subworkflow` steps still have no executor on master: `executorFor` throws before
the step's `try`, "aren't built yet". So divergence row 33 holds as written.
