# n8n integration patches

Four `git format-patch` files apply to n8n master `944afe5`
(`944afe5c889f130ac07c1831dd88fa7c7103a5c1`, set in `scripts/n8n-pin.sh`). 0001 and 0002 add a
scheduler seam to the default engine. 0003 adds a settlement seam to engine v2, and 0004 lets a
host choose the policy behind it. They do not add Petri-net code to n8n and do not modify
existing tests. 0003 adds one test file of its own. 0004 adds four cases to an existing test
file and changes none of its cases.

| Patch | Change | Intended behaviour change |
|---|---|---|
| `0001-extract-scheduler-loop.patch` | Moves the existing execution loop into `StackScheduler` behind `WorkflowScheduler`. | None |
| `0002-scheduler-registry.patch` | Adds a scheduler factory registry and makes `WorkflowExecute` ask it for one scheduler per execution. | None until another scheduler is registered |
| `0003-settlement-policy.patch` | Moves engine v2's two settlement decisions in `StepSettledHandler` behind a `SettlementPolicy`. | None: no caller passes a policy |
| `0004-settlement-policy-registry.patch` | Adds a settlement policy registry and a `settlementPolicy` option to `createEngineRuntime`. | None until another policy is registered or passed |

0001 and 0002 are the complete n8n-side integration for the default engine. `n8n-libpetri`
registers `PetriScheduler` from outside the n8n tree. 0003 and 0004 are the same for engine v2:
0003 is the seam, and 0004 is how a policy from outside the n8n tree reaches it. No cli patch is
needed, because every engine v2 host builds its engine through `createEngineRuntime`.

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

## Patch 3: settlement policy

Files under `packages/@n8n/engine/src/`:

- `execution/settlement-policy.ts`, new: `SettlementReader`, `SettlementPolicy`,
  `defaultSettlementPolicy`, `settlementReaderFor` and `terminalIterationsOf`;
- `execution/step-settled-handler.ts`, takes the policy as an optional seventh constructor
  argument and delegates to it;
- `execution/index.ts` and `index.ts`, export the seam, `StepSummary` and `SuccessorDecisions`;
- `execution/__tests__/settlement-policy.test.ts`, new.

A policy answers two questions. `decideSuccessors(graph, settled, reader)` returns the
successor steps that the settlement of `settled` decides, as n8n's `decideSuccessors` returns
them. `isFinished(graph, reader)` says whether every step the execution owes has settled. The
`SettlementReader` is bound to one execution and has only the three planning reads
(`loadLatestStepSummaries`, `loadStepSummariesByKeys`, `countSettledSteps`). It has no write
method. `settlementReaderFor` passes each read through to the `StepStore`, with no cache.

`defaultSettlementPolicy` is the code that was in the handler, with the same store reads in the
same order. The handler passes its `StepRecord` as `settled`, as it passed it to `decisionKeys`
before. The failure branch, `hasFailedSteps`, `createSteps`, the announcements and
`cancelPendingSteps` stay in the handler, so a failed execution never asks the policy.

`settlement.ts`, `completion.ts`, `loop-ledger.ts`, `iteration-mapping.ts` and `graph/loops.ts`
do not change, so their dist hashes in the settlement golden's stamp hold.
`step-settled-handler.js` does change. Its hash with 0003 applied is pinned in
`GOLDEN_SEAM_PATCHED_DIST` (`typescript/src/conformance/v2/golden.ts`). The local stamp check
accepts that hash or n8n's own, and nothing else.

0003 is written against master. It does not apply to the 2.40.x `stable` and `beta` refs, whose
`step-settled-handler.ts` predates the pin's, so `check-n8n-drift.sh` reports them as drift.
The newest release tag and master take it.

## Patch 4: settlement policy registry

Files under `packages/@n8n/engine/src/`:

- `execution/settlement-policy-registry.ts`, new registry;
- `runtime/create-engine-runtime.ts`, takes an optional `settlementPolicy` and hands the
  handler `settlementPolicy ?? getSettlementPolicy()`;
- `execution/index.ts` and `index.ts`, export the registry;
- `runtime/__tests__/create-engine-runtime.test.ts`, four new cases.

The registry exports:

```text
setSettlementPolicy()
getSettlementPolicy()
resetSettlementPolicy()
```

Its default is `defaultSettlementPolicy`, so patched n8n behaves like the pinned unpatched
commit. This is the shape of 0002. The registry is read only in `createEngineRuntime`, once
per runtime. It is not the handler's constructor default, so a `StepSettledHandler` built
directly, as n8n's handler tests build it, keeps `defaultSettlementPolicy`. The in-process
module, the `n8n engine` command and `serve.ts` all go through `createEngineRuntime`, so one
injection point covers every host and no cli patch is needed.

The registry is module state. A policy must be registered on the module instance that
`createEngineRuntime` imports: the engine's own tests import `src`, and the compat package and
the cli resolve `@n8n/engine` to `dist`.

The new cases load a fresh module graph with `vi.doMock` and record the policy each
`StepSettledHandler` is built with. They check the default while nothing is registered, the
option, the registered policy, and the option over the registered policy. The mock is scoped to
those cases, so the existing cases of the file run as before.

0004 changes no file in the settlement golden's stamp. It applies to the pin and to master.
It does not apply to `n8n@2.42.2`: that release does not have master's cancel-on-request
change (`681768e0bb`, `56d6e9da2c`), which edits the same lines of `create-engine-runtime.ts`.
That is release lag, not forward drift, but `check-n8n-drift.sh` counts it as drift.

## Apply and verify

First create the reference checkout and baseline:

```bash
scripts/bootstrap-n8n.sh
```

Then apply the patches:

```bash
scripts/verify-patch.sh
scripts/verify-patch.sh --typecheck --build --lint
```

`verify-patch.sh` resets `.n8n/packages/core/src` and `.n8n/packages/@n8n/engine/src` to the
pinned commit before applying the patches. Manual edits in that scope are lost. `--typecheck`
and `--build` cover `n8n-core`, `@n8n/engine` and `@n8n/node-engine-compatibility`. `--lint`
runs `@n8n/engine`'s oxlint and `biome ci src`. By default the tree remains patched; add
`--restore` to return it to the pristine commit after verification.

Run the unchanged scheduler through n8n's suite:

```bash
scripts/run-conformance.sh --skip-patch --engines=legacy
```

The recorded verification result is identical to the unpatched baseline: 75 files and
1,715 execution-engine cases pass in both runs. The comparison normalises timestamps,
durations, host names, captured absolute paths and parallel suite completion order. It still
compares every suite name, case name and outcome.

For 0003 and 0004, run the engine v2 scopes with nothing registered:

```bash
scripts/run-conformance.sh --skip-patch --engines=legacy --scope=engine
scripts/run-conformance.sh --skip-patch --engines=legacy --scope=compat
scripts/run-conformance.sh --skip-patch --engines=legacy --scope=cli-v2
```

`compat` and `cli-v2` must be identical to their baselines. `engine` reports 25 new cases: the
21 of 0003's own test file and 0004's four `createEngineRuntime settlement policy` cases. So
`--require-identical` fails there by construction. Compare that leg without that file's
`testsuite` and without those four `testcase`s instead. The recorded results are in
`tasks/v2-seam-plan.md`, under "Step 4" and "Step 5".

For the full legacy/Petri matrix, build the TypeScript package and run:

```bash
cd typescript
npm run build
cd ..
scripts/run-conformance.sh --skip-patch --engines=legacy,libpetri
```

## Regenerate

Work in `.n8n/` on a temporary branch, with one commit per patch. Afterwards, return `.n8n` to
the detached pin and delete the branch. Leave no commit and no branch in `.n8n`.

To add a patch or change one, start from the existing patches as commits:

```bash
cd .n8n
git checkout -- packages/core/src packages/@n8n/engine/src
git clean -fd -- packages/core/src packages/@n8n/engine/src
git checkout -b regen
git am ../patches/n8n/*.patch
# edit, then commit (a new patch) or rebase the one that changes
git format-patch -1 --start-number <N> -o ../patches/n8n HEAD   # N: the patch number; rename it
git checkout --detach 944afe5c889f130ac07c1831dd88fa7c7103a5c1   # N8N_COMMIT from scripts/n8n-pin.sh
git branch -D regen
cd ..
```

To write all of them again from a patched working tree at the pin, stage each commit with the
files of its patch. Two pairs of patches touch the same files, and a whole-file `git add` would put
the later patch's hunks into the earlier commit:

- 0001 and 0002: `packages/core/src/execution-engine/workflow-execute.ts` and
  `packages/core/src/execution-engine/index.ts`;
- 0003 and 0004: `packages/@n8n/engine/src/execution/index.ts` and
  `packages/@n8n/engine/src/index.ts`.

So the first commit of each pair takes only its own hunks of those files, with `git add -p`
(split with `s`, or edit with `e` where the two patches' changes share a hunk), and the second
commit takes the rest:

```bash
cd .n8n
git checkout -b regen

git add packages/core/src/execution-engine/workflow-scheduler.ts \
        packages/core/src/execution-engine/stack-scheduler.ts
git add -p packages/core/src/execution-engine/workflow-execute.ts \
        packages/core/src/execution-engine/index.ts        # 0001's hunks only
git commit

git add packages/core/src/execution-engine/scheduler-registry.ts \
        packages/core/src/execution-engine/workflow-execute.ts \
        packages/core/src/execution-engine/index.ts
git commit

git add packages/@n8n/engine/src/execution/settlement-policy.ts \
        packages/@n8n/engine/src/execution/__tests__/settlement-policy.test.ts \
        packages/@n8n/engine/src/execution/step-settled-handler.ts
git add -p packages/@n8n/engine/src/execution/index.ts \
        packages/@n8n/engine/src/index.ts                  # 0003's hunks only
git commit

git add packages/@n8n/engine/src/execution/settlement-policy-registry.ts \
        packages/@n8n/engine/src/runtime/create-engine-runtime.ts \
        packages/@n8n/engine/src/runtime/__tests__/create-engine-runtime.test.ts \
        packages/@n8n/engine/src/execution/index.ts \
        packages/@n8n/engine/src/index.ts
git commit

git format-patch -4 -o ../patches/n8n   # then rename to the 0001- to 0004- names
git checkout --detach 944afe5c889f130ac07c1831dd88fa7c7103a5c1
git branch -D regen
cd ..
```

Compare each new patch's `diff --git` headers with the old one's before replacing it.
`tests/scripts/patch-readme.test.ts` checks that the four blocks above stage exactly the files of
the four patches, and that a file shared with a later patch is staged with `git add -p`.

Verify the exported result immediately:

```bash
scripts/verify-patch.sh --typecheck --build --lint
scripts/run-conformance.sh --skip-patch --engines=legacy
```

Keep the `0001-` to `0004-` ordering. Do not edit generated patches by hand. If one
stops applying, rebase the source commits on the new pin and export them again.

## Re-pin

`scripts/check-n8n-drift.sh` says whether a candidate ref still takes the patches. To move:

```bash
cd .n8n
git checkout -- packages/core/src packages/@n8n/engine/src
git clean -fd -- packages/core/src packages/@n8n/engine/src
git checkout -b regen <old pin>
git am ../patches/n8n/0001-*.patch ../patches/n8n/0002-*.patch \
       ../patches/n8n/0003-*.patch ../patches/n8n/0004-*.patch
git rebase <new pin>
git format-patch -4 -o ../patches/n8n   # then rename back to the 0001- to 0004- names
git checkout --detach <new pin> && git branch -D regen
```

Then update `scripts/n8n-pin.sh` and run `scripts/bootstrap-n8n.sh`, which builds and takes a
new baseline. After that, `verify-patch.sh --typecheck --build` and the conformance legs. A
clean rebase shows only that the text applies. Check that no upstream change fell inside the
extracted loop: `stack-scheduler.ts` must still match what upstream's `workflow-execute.ts`
has in its loop at the new pin. For 0003, `defaultSettlementPolicy` must still match what
upstream's `step-settled-handler.ts` does in `planSuccessors` and `finishExecutionIfDone`.
For 0004, `createEngineRuntime` must still be the only place that builds the
`StepSettledHandler` an engine runs.

History: the patches were first written against master `441970b` (2026-09-04). On 2026-09-25
they moved to `n8n@2.41.3`, and on 2026-10-02 to master `944afe5` (ADR 0013). Both rebases
changed only offsets.

**The pin is a master commit, and release tags are not ancestors of master.** To move
between them, rebase only the patch commits: `git rebase --onto <new pin> HEAD~4`. A plain
`git rebase <new pin>` from a release-branch pin replays the release branch's own commits.
