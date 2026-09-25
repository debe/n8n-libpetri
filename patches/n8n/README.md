# n8n integration patches

Two `git format-patch` files add a scheduler seam to the n8n release `n8n@2.41.3`
(`7f7a8ac25b87db6c30e2b3651bb8c5d3b21cdb85`, set in `scripts/n8n-pin.sh`). They do not add Petri-net code to n8n and do
not modify tests.

| Patch | Change | Intended behaviour change |
|---|---|---|
| `0001-extract-scheduler-loop.patch` | Moves the existing execution loop into `StackScheduler` behind `WorkflowScheduler`. | None |
| `0002-scheduler-registry.patch` | Adds a scheduler factory registry and makes `WorkflowExecute` ask it for one scheduler per execution. | None until another scheduler is registered |

The patches are the complete n8n-side integration. `n8n-libpetri` registers
`PetriScheduler` from outside the n8n tree.

## Patch 1: scheduler seam

Files under `packages/core/src/execution-engine/`:

- `workflow-scheduler.ts`, new interface;
- `stack-scheduler.ts`, n8n's extracted loop;
- `workflow-execute.ts`, delegates the loop;
- `index.ts`, exports the seam.

`WorkflowScheduler.run()` receives a `SchedulerHost`, the workflow, run state and hooks. It
exposes the two values the existing completion path reads after execution:
`executionError` and `closeFunction`.

`SchedulerHost` is a `Pick<WorkflowExecute, ...>` containing the fields and methods touched
by the moved loop. The extraction changes `this.` references to `host.`, passes
`runExecutionData` explicitly, and stores the two loop-scoped result values on the scheduler.
The scheduling logic, including the stuck-join fallback, remains n8n's existing code.

Several formerly private `WorkflowExecute` methods become public because the extracted class
must call them through the interface. `runExecutionData` stays private; tests intentionally
exercise that boundary.

## Patch 2: registry

Files under `packages/core/src/execution-engine/`:

- `scheduler-registry.ts`, new registry;
- `workflow-execute.ts`, obtains the scheduler factory once per execution;
- `index.ts`, exports the registry.

The registry exports:

```text
setWorkflowSchedulerFactory()
getWorkflowSchedulerFactory()
resetWorkflowSchedulerFactory()
```

Its default factory returns `StackScheduler`, so patched n8n behaves like the pinned
unpatched commit. n8n does not read `N8N_EXECUTION_ENGINE`; the external bootstrap or test
setup decides whether to register another factory.

## Apply and verify

First create the reference checkout and baseline:

```bash
scripts/bootstrap-n8n.sh
```

Then apply the patches:

```bash
scripts/verify-patch.sh
scripts/verify-patch.sh --typecheck --build
```

`verify-patch.sh` resets `.n8n/packages/core/src` to the pinned commit before applying the
patches. Manual edits in that scope are lost. By default the tree remains patched; add
`--restore` to return it to the pristine commit after verification.

Run the unchanged scheduler through n8n's suite:

```bash
scripts/run-conformance.sh --skip-patch --engines=legacy
```

The recorded verification result is identical to the unpatched baseline: 75 files and
1,715 execution-engine cases pass in both runs. The comparison normalises timestamps,
durations, host names, captured absolute paths and parallel suite completion order. It still
compares every suite name, case name and outcome.

For the full legacy/Petri matrix, build the TypeScript package and run:

```bash
cd typescript
npm run build
cd ..
scripts/run-conformance.sh --skip-patch --engines=legacy,libpetri
```

## Regenerate

Work in `.n8n/` and keep one commit per patch:

```bash
cd .n8n

git add packages/core/src/execution-engine/workflow-scheduler.ts \
        packages/core/src/execution-engine/stack-scheduler.ts \
        packages/core/src/execution-engine/workflow-execute.ts \
        packages/core/src/execution-engine/index.ts
git commit

git add packages/core/src/execution-engine/scheduler-registry.ts \
        packages/core/src/execution-engine/workflow-execute.ts \
        packages/core/src/execution-engine/index.ts
git commit

git format-patch -2 -o ../patches/n8n
git reset 7f7a8ac25b87db6c30e2b3651bb8c5d3b21cdb85   # N8N_COMMIT from scripts/n8n-pin.sh
cd ..
```

Verify the exported result immediately:

```bash
scripts/verify-patch.sh --typecheck --build
scripts/run-conformance.sh --skip-patch --engines=legacy
```

Keep the `0001-` and `0002-` ordering. Do not edit generated patches by hand. If one stops
applying, rebase the source commits on the new pin and export them again.

## Re-pin

`scripts/check-n8n-drift.sh` says whether a candidate ref still takes the patches. To move:

```bash
cd .n8n
git checkout -- packages/core/src && git clean -fd -- packages/core/src
git checkout -b regen <old pin>
git am ../patches/n8n/0001-*.patch ../patches/n8n/0002-*.patch
git rebase <new pin>
git format-patch -2 -o ../patches/n8n   # then rename back to the 0001-/0002- names
git checkout --detach <new pin> && git branch -D regen
```

Then update `scripts/n8n-pin.sh` and run `scripts/bootstrap-n8n.sh`, which builds and takes a
new baseline. After that, `verify-patch.sh --typecheck --build` and the conformance legs. A
clean rebase shows only that the text applies. Check that no upstream change fell inside the
extracted loop: `stack-scheduler.ts` must still match what upstream's `workflow-execute.ts`
has in its loop at the new pin.

History: the patches were first written against master `441970b` (2026-09-04). On 2026-09-25
they moved to `n8n@2.41.3`, and the rebase changed only offsets.
