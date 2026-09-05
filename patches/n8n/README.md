# n8n patches

Two rebasable patches on top of the pinned n8n commit `441970b211d13a3ce547916b2b8ee93677b620e9`
(master, 2026-09-04). They are `git format-patch` output — one commit each, message included —
so a reviewer reads them as upstream commits and `git apply` consumes them directly.
`scripts/verify-patch.sh` resets `packages/core/src` in `.n8n/` to the pinned commit, applies
them in name order and fails on drift; `scripts/run-conformance.sh` runs the execution-engine
suite on the patched tree and requires it to be identical to the unpatched baseline.

| Patch | Purpose | Behaviour change |
|---|---|---|
| `0001-extract-scheduler-loop.patch` | Move the `executionLoop:` while (incl. the stuck-join fallback that runs when the stack is empty) out of `WorkflowExecute.processRunExecutionData()` into `StackScheduler implements WorkflowScheduler`, behind a `SchedulerHost` interface | none |
| `0002-scheduler-registry.patch` | `setWorkflowSchedulerFactory()` / `getWorkflowSchedulerFactory()` / `resetWorkflowSchedulerFactory()` in `scheduler-registry.ts`; `processRunExecutionData()` asks the registry, so an unmodified `new WorkflowExecute(...)` picks the registered scheduler | none |

No test file is edited by either patch.

## 0001 — the seam

Files: `packages/core/src/execution-engine/{workflow-scheduler.ts (new), stack-scheduler.ts (new),
workflow-execute.ts, index.ts}`.

- `WorkflowScheduler` — `run(host, workflow, runExecutionData, hooks): Promise<void>` plus the
  two values the completion chain reads afterwards: `executionError` and `closeFunction` (the
  latter also on the failure path, where the trigger is deactivated).
- `SchedulerHost = Pick<WorkflowExecute, …>` — exactly the 30 members the moved code touches
  (verified by grepping `host.*` in `stack-scheduler.ts` against the `Pick`): 3 fields/getters
  `additionalData`, `mode`, `abortSignal`, and 27 methods `addNodeToBeExecuted`,
  `addPairedItemLineage`, `assignPairedItems`, `collectSubNodeResults`, `computeRunIndex`,
  `createTaskData`, `createTaskStartedData`, `ensureAlwaysOutputData`, `ensureInputData`,
  `getPinnedOutput`, `getRetryParams`, `handleEngineRequest`, `handleNodeExecutionError`,
  `isExecutionStackNotEmpty`, `isLegacyExecutionOrder`, `isNodeFilteredOut`,
  `normalizeNodeErrors`, `popExecutionStack`, `processNodeOutput`, `pushExecutionStack`,
  `recordDynamicCredentialsUser`, `reportNodeExecutionError`, `resetDynamicCredentialsUsage`,
  `rewireOutputLog`, `runNode`, `shouldStopExecuting`, `upsertTaskData`.
- The loop body is moved verbatim (token-identical after `this.` → `host.`,
  `this.runExecutionData` → the `runExecutionData` parameter, `this.abortController.signal` →
  `host.abortSignal`, and the two loop-scoped locals `executionError` / `closeFunction`
  becoming fields of the scheduler; prettier re-wrapped a few lines for the shallower
  indentation). The `// eslint-disable-next-line complexity` moves with it.
- How privates were reached, the way the rest of `packages/core` does it (no bracket access
  in production code, no `@internal` casts): 22 `private` methods became public, the
  constructor's `additionalData` / `mode` went from `private readonly` to `readonly`, and one
  getter `abortSignal` was added over the private `abortController`. Five members were
  already public (`addNodeToBeExecuted`, `assignPairedItems`, `ensureInputData`,
  `isLegacyExecutionOrder`, `runNode`). `runExecutionData` stays private — seven tests assign
  it under `// @ts-expect-error private data`, which a public field would turn into a
  typecheck error — and is passed to `run()` instead.
- `index.ts` exports `StackScheduler` and `export type * from './workflow-scheduler'`.

## 0002 — the registry

Files: `packages/core/src/execution-engine/{scheduler-registry.ts (new), workflow-execute.ts,
index.ts}`. A module-level factory, `() => WorkflowScheduler`, defaulting to
`() => new StackScheduler()`; `processRunExecutionData()` calls it once per execution, after
`handleWaitingState()` and before the `PCancelable` is created. The three functions and the
`WorkflowSchedulerFactory` type are exported from the package index. The patched n8n reads no
environment variable; whoever registers a scheduler (the conformance run's vitest setup file,
later n8n's own bootstrap) decides.

## Verification (2026-09-05, Darwin 25.5.0 arm64, node v26.8.1, pnpm 11.25.0, vitest 4.1.9)

After each patch, on the patched tree: `pnpm --filter n8n-core typecheck` (tsgo, 21 s cold),
`pnpm --filter n8n-core build` (38 s cold), `eslint --quiet` and `biome ci` on the touched
files (clean), then `CI=true pnpm --filter n8n-core run test src/execution-engine` (7 s) and
the junit compared with `conformance-results/baseline.junit.xml` through
`typescript/src/conformance/cli.ts --require-identical`: same 75 files, same 1657 case names,
same outcome for every case (1657 passed). Independently, every `<testsuite>` is byte-identical
after normalising the `time`/`timestamp`/`hostname` attributes and dropping `<system-out>`
(absolute paths in printed stack traces); only the order in which vitest lists the suites
varies between runs (completion order under parallel forks), so compare per suite name.
The same suite under heavy machine load (load average > 20) once took 507 s and timed one
case out at vitest's 5 s limit; re-run idle, it passed — a load artefact, not a patch effect.

## Regenerating the patches

The patches are commits exported from `.n8n/`; the clone itself stays at the pinned commit
with the patches applied to the working tree (that is what `verify-patch.sh` leaves behind and
what `bootstrap-n8n.sh` refuses to call a baseline without `--allow-dirty`).

```bash
cd .n8n
git add packages/core/src/execution-engine/{workflow-scheduler,stack-scheduler}.ts \
        packages/core/src/execution-engine/{workflow-execute,index}.ts
git commit                                   # message = the text in 0001
git add packages/core/src/execution-engine/scheduler-registry.ts \
        packages/core/src/execution-engine/{workflow-execute,index}.ts
git commit                                   # message = the text in 0002
git format-patch -2 -o ../patches/n8n        # writes 0001-*.patch and 0002-*.patch
git reset 441970b211d13a3ce547916b2b8ee93677b620e9   # HEAD back on the pin, tree still patched
cd .. && scripts/verify-patch.sh --typecheck --build && scripts/run-conformance.sh --skip-patch --engines=legacy
```

Keep the file names: `verify-patch.sh` applies `*.patch` in name order. A patch that stops
applying means the pinned commit changed (rebase and re-export) or the patch was edited by hand
(never do that).
