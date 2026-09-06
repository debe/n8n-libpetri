# M4 conformance — every scope, every budget, and what this engine actually reproduces

The final gate. [`docs/conformance-m2.md`](conformance-m2.md) reported n8n's
`packages/core/src/execution-engine` suite at k = 1 and
[`docs/conformance-m3.md`](conformance-m3.md) reported it per budget; both stand as written,
with one arithmetic caveat: their headlines are out of 36 loop-driving cases, and M4 widened
the classifier to 44 (below), so the denominators here and there differ by the eight
`webhook-respond-branch-order.test.ts` cases and by nothing else.
This report does three things they could not:

1. it widens the run past the filtered execution-engine set to **all of `packages/core`** —
   2124 cases, and the only scope whose tests actually construct this engine — plus **all of
   `packages/workflow`** and **all of `packages/cli`'s unit suite** as *patch-neutrality*
   legs: 29 931 further cases that run with the engine registered and never entered. That
   distinction is measured, not assumed, and it is spelled out below;
2. it records the one **model change** of M4 — the `_budget` refund moved off `X_route` onto
   `X_done` — and the n8n case that change makes pass;
3. it states, in one paragraph a reader can trust, what this engine reproduces and what it
   does not.

Produced by `scripts/run-conformance.sh` on the pinned n8n clone (`441970b`, patches 0001 and
0002 applied). Every headline number below was **re-measured at final integration**
and reproduced exactly: `execution-engine` legacy and libpetri at k = 1, the k = 2 budget leg,
and the widest scope, `cli`, both legs. Raw artefacts stay in the gitignored `conformance-results/`
(`<label>.junit.xml`, `<label>.matrix.md`, `<label>.test.log`, `<label>.diagnostics.txt`).

## Scopes

`scripts/run-conformance.sh --scope=execution-engine|core|workflow|cli|all` (default
`execution-engine`, so every earlier command still means what it meant). Each scope has its
own baseline, regenerated on the **unpatched** tree by
`scripts/bootstrap-n8n.sh --scope=NAME`, and its own artefact names. `--scope=all` runs
`execution-engine`, `core` and `workflow`; `cli` is deliberately not in it, because it needs
an install and a build the other three do not (below) and it costs minutes rather than
seconds.

| scope | package | filter | test files | cases | baseline |
|---|---|---|---|---|---|
| `execution-engine` | `n8n-core` | `src/execution-engine` | 75 | 1657 | `baseline.junit.xml` |
| `core` | `n8n-core` | whole package | 102 | 2124 | `baseline-core.junit.xml` |
| `workflow` | `n8n-workflow` | whole package | 85 (255 suites, one per vitest project) | 9603 | `baseline-workflow.junit.xml` |
| `cli` | `n8n` | whole package | 1104 — the unit config's include set (`src/**` plus `test/unit/**`, minus `*.integration.test.ts`) | 20328 | `baseline-cli.junit.xml` |

Of the 1501 `*.test.ts` files on disk in `packages/cli`, the unit config collects 1104 — 1102
under `src/` plus the 2 under `test/unit/`. The 397 it does not collect are **94**
`*.integration.test.ts` under `src/`, **250** under `test/integration/` and **53** under
`test/migration/`: they are excluded by the include set and by the `*.integration.test.ts`
exclusion, they need a live database, and none of them was run.

### Registered is not entered

A leg's junit says which cases passed. It does **not** say whether the engine was involved.
The scheduler seam is `getWorkflowSchedulerFactory()()` in
`packages/core/src/execution-engine/workflow-execute.ts` (patch 0002), so a test that never
reaches `processRunExecutionData` — or that mocks `n8n-core` before it gets there — runs with
the PetriScheduler registered and never constructed.

Since M4 the registered factory emits one diagnostic the first time it is actually called in a
module instance (`ENGINE_ENTERED_DIAGNOSTIC`, `src/scheduler/register.ts`), so
`scripts/run-conformance.sh` counts the test **files that entered the engine** into
`<label>.diagnostics.txt` and prints it per leg — loudly when it is zero:

| leg | files in the leg | files that entered the engine |
|---|---|---|
| `libpetri` (execution-engine) | 75 | **5** |
| `libpetri-cli` | 1104 | **0** — `WARNING — the engine was REGISTERED BUT NEVER ENTERED` |
| `libpetri-workflow` | — | not run: `n8n-workflow` does not depend on `n8n-core`, so the seam is not reachable |

The 5 are exactly the five `packages/core` test files that call `WorkflowExecute.run()` /
`processRunExecutionData` — `workflow-execute.test.ts`,
`workflow-execute-run-node.test.ts`, `workflow-execute-node-error-reporting.test.ts`,
`workflow-execute-process-process-run-execution-data.test.ts` and
`webhook-respond-branch-order.test.ts` — which is an independent check that the count means
what it says. Everything the engine is measured on comes from those files; the other 70 files
of the scope, and all 1104 of `packages/cli`, are the cases that must not change *around* it.


The `workflow` scope's 85 files are collected three times, once per vitest project the
package declares, so its junit has 255 suites. That has one measured consequence, and it is
the only known soft spot in this report's method. Cases pair positionally between two reports
(`caseKeys` numbers repeats `…#2`, `…#3`), because the junit records the file name and not the
project name — vitest does not write one. For a case that behaves the same in all three
projects the pairing is exact. **One case does not**: `test/expression.test.ts >
Expression > getParameterValue() > should keep global objects isolate-local under the vm
engine` runs in one project and is skipped in the other two, and vitest lists suites in
completion order under parallel forks. So the `pass` lands in slot 1 on one run and slot 2 on
the next, and the matrix reports exactly one spurious `regression` plus one spurious `fixed`.
Observed both ways across two runs of the *same* leg (`pass, skipped, skipped` in the
baseline, `skipped, pass, skipped` in a later one). Nothing else in 9603 cases is affected,
and no other scope has duplicate suites at all — but it means the `workflow` scope's exit
status is not a reliable gate as it stands. The fix is in `caseKeys`
(`src/conformance/junit.ts`): pair a duplicate group by status multiset rather than by
document order. Recorded as open work, not done here.

## Headline

Loop-driving cases (the classifier, below) passed, then pure-helper cases, then the case-set
comparison. Every leg covers its scope's whole case set: 0 new, 0 missing everywhere.

| scope | leg | reference | loop-driving | helpers | outcome |
|---|---|---|---|---|---|
| execution-engine | legacy | baseline | **44 / 44** | 1613 / 1613 | *identical* to the unpatched baseline (1657 cases) |
| execution-engine | libpetri k = 1 | baseline | **35 / 44** | 1611 / 1613 | 11 regressions |
| execution-engine | libpetri k = 2 | libpetri k = 1 | 32 / 44 | 1611 / 1613 | 3 regressions |
| execution-engine | libpetri k = 4 | libpetri k = 1 | 33 / 44 | 1611 / 1613 | 3 regressions, 1 "fixed" |
| core | legacy | baseline-core | **44 / 44** | 2080 / 2080 | *identical* to the unpatched baseline (2124 cases) |
| core | libpetri k = 1 | baseline-core | **35 / 44** | 2078 / 2080 | 11 regressions |
| workflow | legacy | baseline-workflow | 0 / 0 | 9601 / 9603 (2 skipped) | same case set, same status multisets as the unpatched baseline; the matrix reports **1 spurious regression + 1 spurious fixed** from the positional-pairing artefact, so this leg's exit status is not a gate — see Scopes |
| workflow | libpetri | — | — | — | **not applicable**, see below |
| cli | legacy | baseline-cli | 0 / 0 | 20328 / 20328 | *identical* to the unpatched baseline (20328 cases) |
| cli | libpetri k = 1 (engine **never entered**) | baseline-cli | 0 / 0 | **20328 / 20328** | 0 regressions — and 0 factory constructions: this is patch neutrality, not an engine result |

**Widening the scope found no new failure anywhere.** The core scope's 11 regressions are the
execution-engine scope's 11 regressions: the 27 files of `packages/core` outside
`src/execution-engine` — errors, binary data, instance settings, node loading, the SSH tunnel,
the request helpers — produce 467 further cases and not one difference.

**The engine is measured where n8n's own tests run a workflow: the five `packages/core` files
that construct a scheduler — and it differs on 11 of their cases**, all registered or
declared. `packages/core`'s 2124 cases are the right *scope* to quote, because that is the
package the seam lives in and every difference is inside it; but the 11 come from those five
files, and so would any others.

Everything else is patch neutrality, and worth having as exactly that: the rest of
`packages/core`, `packages/workflow`'s 9603 cases and `packages/cli`'s 20328 all run with the
patches applied and the engine registered, and are byte-identical to their unpatched
baselines. The construction counter was run on two of those legs and found the engine
**entered in 5 of the execution-engine scope's 75 files and in 0 of `packages/cli`'s 1104**;
the 27 `packages/core` files outside `src/execution-engine` were not re-run with the counter,
but the classifier finds no loop-driving case in them either. That is evidence that patches
0001 and 0002 change nothing around the seam, across tens of thousands of cases. It is not
evidence about the scheduler, and this report does not count it as such.

Excluding the AI-agent `EngineRequest` / `EngineResponse` tool dispatch that is out of scope
by decision (6 loop-driving + 2 helper cases, unchanged since M2), the k = 1 legs read
**35 / 38 loop-driving, 1611 / 1611 helpers**.

### `libpetri` on the `workflow` scope: not applicable, not skipped

`n8n-workflow` holds the data structures the engine writes — `Workflow`,
`WorkflowDataProxy`, expressions, `NodeHelpers` — and never constructs a
`WorkflowScheduler`. It does not even depend on `n8n-core`, so the seam is not reachable from
it and there is nothing for the shim to register into. A "libpetri" run on this scope would be
the legacy code path under another name, so the script prints *not applicable* and does not
run it — which is the honest version of what `packages/cli`'s leg does implicitly (it
registers and is never entered, below). The legacy leg is still the point of the scope: it
proves the 9603 cases that describe what the engine has to write are untouched by the patches.

### `cli`: it runs, once its own chain is built — and it passes

`packages/cli` is the third scope and the one the brief expected to fail. It does not, but
getting there needed two things the bootstrap did not do, and the first attempt failed
outright, so both are recorded.

**Attempt 1 — `Test Files 0`.** With `packages/cli/node_modules` installed
(`pnpm install --frozen-lockfile --filter 'n8n...'`; the default install is the closure of
`n8n-nodes-base`, which does not contain cli) the run still exited 1 with **zero test files
collected** and a junit of `tests="0"`, dying before any test:

```
SyntaxError: [vite] The requested module 'libphonenumber-js' does not provide an export
named 'parsePhoneNumberFromString'
  ❯ class-validator@0.14.0/node_modules/src/decorator/string/IsPhoneNumber.ts:3:1
```

The chain, read out of `packages/cli/vitest.config.base.ts`: `test.globalSetup` is
`./test/global-setup.ts`, which imports `@n8n/backend-test-utils`, `@n8n/config`, `@n8n/di`
and `@n8n/typeorm`. The `workspaceDistExternals()` plugin forces every workspace package to
resolve to its **built `dist/`** and marks it external, precisely so vite never transforms the
TypeORM entity sources. Those dists did not exist — `packages/@n8n/db/dist` was missing,
because the bootstrap builds the `n8n-nodes-base` turbo chain and the cli chain is not in it —
so the plugin's `require.resolve` fell through, vite inlined the TypeScript sources, and the
entity decorators dragged in `class-validator`'s own sources, whose `IsPhoneNumber.ts` takes a
named export from `libphonenumber-js` that vite 8's module runner cannot produce across the
CJS boundary. `globalSetup` threw, discovery yielded nothing, the run ended.

So the blocker was a **missing build**, not a missing database or redis — worth having chased,
because "it needs infrastructure" would have been the easy and wrong answer. `packages/cli`'s
own test script sets `DB_TYPE=sqlite` and its unit config excludes `*.integration.test.ts`; no
external service is involved.

**Attempt 2 — it runs.** `pnpm exec turbo run build --filter=n8n` (about 80 s warm, a few
minutes cold) and the suite runs: **1104 files, 20328 cases, 0 failures** on the unpatched
tree. `scripts/bootstrap-n8n.sh --scope=cli` now switches `BUILD_TARGET` to `n8n` so the
baseline is reproducible in one command, and `scripts/run-conformance.sh --scope=cli` rebuilds
that chain itself before each leg — turbo caches on content, so it is a replay when nothing
changed, and it removes the foot-gun of comparing a patched source tree against a dist built
from the unpatched one.

**The registration is real; the engine is never entered.** Because cli loads `n8n-core` from
its dist, the shim cannot use n8n-core's `@/` alias — that is a different module instance
there and registering into it would do nothing. It imports `setWorkflowSchedulerFactory` and
`StackScheduler` from the `n8n-core` **package entry** instead, which is exactly the
externalised dist cli's own code holds, and which carries patch 0002 once the patched tree is
built. The script picks the specifier per scope, and it now checks the **call site** rather
than the added file — `grep getWorkflowSchedulerFactory` in the built `workflow-execute.js`,
because `scheduler-registry.js` is a file patch 0002 *adds* and a stale one survives a rebuild
of the unpatched tree, which would label a legacy run `libpetri`.

But registering is not entering, and here it does not: **the factory is constructed zero
times in 1104 files.** `packages/cli` has five production call sites
(`manual-execution.service.ts`, `workflow-runner.ts`, `workflow-execute-additional-data.ts`,
`scaling/job-processor.ts`), and every cli test that reaches them mocks `n8n-core`'s
`WorkflowExecute` first (`vi.mock('n8n-core')`, `vi.spyOn(WorkflowExecute.prototype, …)`);
nothing in `packages/cli` references the registry itself. The same instrumentation counts the
constructions in `packages/core`, where they are in the hundreds and all under
`src/execution-engine/__tests__`. So:

| leg | result |
|---|---|
| `legacy-cli` | **identical** to the unpatched baseline: 20328 / 20328, same case set, same outcomes |
| `libpetri-cli` | 20328 / 20328, 0 regressions, 0 new, 0 missing — with **0 engine constructions**: what this leg proves is that registering the engine into the built dist perturbs nothing, across 20328 cases |

Three caveats, stated rather than buried:

- **This leg is not an engine measurement.** It is the strongest available statement of patch
  neutrality on the layer around the engine — webhooks, waiting forms, executions, the agents
  module, the public API — and nothing more. Every number about the scheduler in this report
  comes from `packages/core`.

- **One file could not be instrumented**, and the shim says so. `src/modules/agents/__tests__/agent-sse-stream.test.ts`
  does `vi.mock('n8n-workflow')` without `NodeHelpers`, so the shim's dynamic import throws.
  On the first run that took the whole file down (24 cases `pass → skip` plus a file-level
  failure) — a harness artefact reported as 24 regressions. The shim now catches it, leaves
  that file on the injected `StackScheduler` (it runs no workflow) and writes
  `[n8n-libpetri] shim: seam not resolvable in this file, engine not registered (…)` to
  stderr, where the diagnostics collector counts it: **1 file, in 1104**. This is the one
  place where a "libpetri" case is really a legacy case, and the count is the whole of it.
- **One case is flaky under full-suite parallelism.**
  `src/utils/__tests__/form-trigger-completion-template.test.ts > … attribution footer …`
  failed once on a `legacy-cli` run and passed in isolation and on the re-run. It renders a
  handlebars template through an express view engine and has nothing to do with the
  scheduler; both legs above are from the clean re-run.

**The classifier finds 0 loop-driving cases in 20328, and that is right** — and the engine
construction count says the same thing from the other side. `packages/cli` has
one file whose *name* matches the loop-driving file rule —
`src/__tests__/workflow-execute-additional-data.test.ts`, 96 cases — but it builds
`IWorkflowExecuteAdditionalData` (hooks, static data, credentials plumbing) and never runs a
workflow, so no describe block matches a pattern and the file contributes nothing to the
headline. The cli scope's value is not a loop headline: it is 20328 cases of the layer *around*
the engine — webhooks, waiting forms, executions, the agents module, the public API — none of
which changes under the PetriScheduler.

## The classifier, and which cases are loop-driving in the wider scopes

`typescript/src/conformance/classify.ts` selects loop-driving cases by file and describe
block, so the selection is reviewable without reading n8n. M4 changed it once, deliberately,
closing an M1/M2/M3 open item: **`webhook-respond-branch-order.test.ts` is now a loop-driving
file.** All eight of its cases call `workflowExecute.run()` on a two-child fan-out and assert
which child ran first — that is the loop and nothing else — and M2 and M3 reported them in the
helper column, which is why the one k > 1 regression they carry (divergence #17) was reported
outside the headline. Its two describe blocks are matched by `branch-order` (4 cases, the
pattern that had matched nothing until now) and by a new `respond-layout` pattern (4 cases).
The headline denominator moves from 36 to **44**; the pinned per-pattern counts are in
`typescript/tests/conformance/classify.test.ts`.

| pattern | cases | legacy | libpetri k = 1 |
|---|---|---|---|
| `execution-order` | 19 | 19 | 16 |
| `hook-order` | 6 | 6 | 6 |
| `branch-order` | 4 | 4 | 4 |
| `respond-layout` | 4 | 4 | 4 |
| `waiting` | 9 | 9 | 3 (6 are the out-of-scope AI-agent dispatch) |
| `partial` | 2 | 2 | 2 |

**For the wider scopes the loop-driving set does not grow: it is the same 44 cases.** Measured,
not assumed — running the classifier over `baseline-core.junit.xml` (2124 cases) yields 44,
the same per-pattern split, and every one of them is in `src/execution-engine/__tests__`. Over
`baseline-workflow.junit.xml` (9603 cases) it yields **0**: `n8n-workflow` has no scheduler to
drive. Over `baseline-cli.junit.xml` (20328 cases) it also yields 0, and the one file there
whose name matches the file rule is a helper (above). So the headline for `core` is the
execution-engine headline plus 467 helper cases, and the headlines for `workflow` and `cli`
are "9603 / 20328 helper cases, identical" — there is no loop-driving claim to make in those
two scopes, and this report does not make one.

## The one model change in M4: the budget refund moved to `X_done`

M3 registered divergence **#20**: an OR-input node's `arm` transition costs a scheduling
cycle, so a shallower sibling takes the single budget unit in it and the net runs
breadth-first exactly where README's "priority = DAG depth" promises depth-first. M4 fixed it.

**Why the obvious fix does not work.** The suggestion on the table was a priority band —
give every structural transition a priority strictly above every start so they drain first
within a cycle. Implemented and measured: **it changes nothing.** libpetri's executor collects
its ready set from the enablement flags *before* the firing pass, and only
`updateDirtyTransitions()` sets them (`precompiled-net-executor.ts`, `fireReadyGeneral`), so a
transition another firing enables during that pass cannot fire in it at any priority. Priority
orders the snapshot; it does not extend it. The `arm` already fired before the sibling's
`X_start` and the sibling still took the budget.

**What does work.** The problem is a phase mismatch, not an order: `X_route` deposited the edge
tokens *and* refunded `_budget` in one firing, so a direct consumer's `X_start` and a
budget-blocked sibling's `X_start` became evaluable in the same cycle (which is what makes
priority = depth work) while a join / OR consumer's needed one more cycle for its `arm`. Since
M1 the compiler has had a shape that refunds one cycle later — the split routing used above
three connected outputs, where `X_route_o` marks `X/routed_o` and a single `X_done` refunds the
budget. M4 sets `SPLIT_ROUTING_ABOVE` to **0**: every node with a connected output routes per
output, so the refund always lands in the cycle the `arm` fires in and both candidate starts
are in one ready set. A node with *one* connected output keeps the unindexed names `X/ok`,
`X_route`, `X/routed`, so only genuinely multi-output nodes gained an index. A node with no
connected output keeps its single `X_route` — it has no edge token to deposit and no `arm` to
wait for. Cost: one place and one transition per node with an output, and one extra executor
cycle per node completion (synchronous — the loop `continue`s on dirty bits, it does not
await). The flatteners get *cheaper*, not dearer: the `and` of `k` `xor`s that IO-016 expands
into `2^k` virtual transitions is now `k` transitions of one `xor` for every node.

**Measured, before and after, by the differential harness** (`src/conformance/differ-cli.ts`
over `tests/conformance/differ-fixtures.ts`, 23 fixtures × k ∈ {1, 2, 4} = 69 runs). Before:
46 pass, 23 divergent, 0 fail. After: **49 pass, 20 divergent, 0 fail** — three runs stopped
diverging, and no run started:

| fixture | before | after |
|---|---|---|
| `multiProducer` | data equal, **2 moved** (both attributed to #20) at k = 1, 2, 4 | data equal, **order equal** — `Trigger, A, C, B, C`, n8n's own order, at every k |
| `ifBothOutputs` | 6 data differences attributed, **5 moved** (#12 join-unshift, #11 or-input-lifo ×2, #2 ×2) | same 6 data differences, **3 moved** — rows #12 and #11's *ordering* half are gone; the net now runs `Trigger, IF, C#0, Merge#0, End#0, C#1`, n8n's order for as long as the two engines agree on how many times things run — **and one new ordering row**, see below |
| `destinationStop` | 4 data differences, 3 moved | **5** data differences, 2 moved — see below |
| everything else (20 fixtures) | unchanged | unchanged |

**The second honest cost: `lastNodeExecuted` at k = 1.** On `ifBothOutputs` the fix moved
`C#1` behind `End#0`, so the net's last activation is `C` where n8n's is `End` and the differ
adds a `resultData.lastNodeExecuted` row (attributed to divergence #5, the total-order row).
Before the change the net ended on `End#0` and the field matched. This is not a k > 1
casualty: the two engines run **different activation sets** here — the net strands the second
`Merge` arrival (row #2) — and once the sets differ, "the last one to run" differs with them.
`docs/divergences.md` row #16 said this field was stable at k = 1; it is now amended to say
"unless a stranding or a stop row already made the activation sets differ", which is exactly
this fixture. Nothing else in the 69 runs gained a difference.

**and by n8n's own suite**: `v1 execution order > should execute nodes in the correct order,
depth-first & the most top-left one first` — 23 nodes, the case the README's ordering claim is
named after — **fails at k = 1 without the change and passes with it**. The execution-engine
leg goes from 34/44 to 35/44 loop-driving and from 12 regressions to 11. That case had been
attributed to divergence **#12** (n8n's `unshift` of a completed multi-input entry) in M2 and
M3. That attribution was wrong: it was #20. Row #12 is real and still has a witness — `…
multiple Merge-Node have missing data and complex dependency structure`, where n8n runs
`Start, Set1, IF1, IF2, IF3, IF4, Merge1, …` and the net runs `Start, Set1, IF1, Merge1, IF2,
…` because `Merge1` is enabled the moment `IF1` routes — but it has exactly one now, and the
register says so.

**The honest cost.** `destinationStop` gained a data difference. With depth-first restored the
destination node `C` runs *before* its shallower sibling `B`, so `_pause` is deposited first
and `B` never runs at all; n8n keeps popping its stack after the destination and does run it.
Before the change the net happened to run `B` first. That is divergence **#13** doing exactly
what row #13 says it does — an in-filter entry still pending when `_pause` lands never runs —
and the differ attributes it there, but it is a data difference the fix made *reachable* on a
fixture where it had not been, and it belongs in this report and not in a footnote. Row #13 was
amended.

At k > 1 the newly-passing depth-first case fails again, for the reason every total-order case
fails above k = 1: independent branches run at once (divergence #21). That is why the k = 2 and
k = 4 legs read 32/44 and 33/44 against k = 1's 35/44 while the *regression* count against the
k = 1 leg stays at 3.

## Every regression at k = 1, classified

The M2 rules: a **defect** is ours and gets fixed, a **divergence** is a registered
abandonment in [`docs/divergences.md`](divergences.md), **out-of-scope** is a declared
non-goal. A data difference is always a defect, never a divergence — except where a registered
abandonment already covers it, and then the register says so.

| case | class | row |
|---|---|---|
| 8 × `workflow-execute-process-process-run-execution-data.test.ts` AI-agent `EngineRequest` / `EngineResponse` tool dispatch (6 loop-driving `waiting` + 2 helper) | **out of scope** (declared in M2) | — |
| `v1 execution order > should run node twice when it has two input connections` | divergence | **#11** — the two runs carry n8n's two payloads in the other order (n8n `unshift`/`shift` is LIFO, `X/hasdata_i` is FIFO) |
| `v1 execution order > should simply execute the next multi-input-node (totally ignoring the runIndex)` | divergence | **#2** — the net strands the unmatched arrival and reports it where n8n's quiescence fallback re-runs the join with `[]` |
| `v1 execution order > should run complicated multi node workflow where multiple Merge-Node have missing data and complex dependency structure` | divergence | **#12** — n8n `unshift`s a completed multi-input entry so a ready join runs behind every queued sibling |
| — nothing else, in `packages/core`'s 2124 cases (nor in the 29 931 patch-neutrality cases) | | |

No defect was found by widening the scope. Two were found and fixed *inside* the harness. The
two `src/errors/__tests__/error-reporter.test.ts` cases that the first `core` run reported as
regressions were an artefact of the vitest shim, not of the engine — they failed with
`N8N_EXECUTION_ENGINE=legacy` under the same config, i.e. with nothing registered, because a
setup file's top-level `import '@/execution-engine/…'` pulled n8n-core's error reporter and the
real `@sentry/node` into the module registry before the test's own `vi.mock` applied. The shim
now does its imports dynamically inside `beforeAll`, after the test module and its mocks are in
place and still before any test runs. Those two cases pass, and the `core` scope's regression
count went from 13 to 11. The second was the mirror image in `packages/cli`: a file that mocks
`n8n-workflow` without `NodeHelpers` made that same dynamic import throw and took its 24 cases
down with it; the shim now catches it, skips registration for that one file and reports the
skip as a diagnostic (above). Both were the harness perturbing tests it had no business
touching, and in both cases the proof that it was the harness and not the engine is that the
failures reproduce with `N8N_EXECUTION_ENGINE=legacy` under the same config.

## Divergence register, final state

21 rows in [`docs/divergences.md`](divergences.md).

- **1 fixed**: row **#20**, this milestone. It stays in the register with its mechanism
  intact — it is the record of what the model has to keep true, and the differ still names it,
  so a phase regression is reported as row #20 rather than as an unattributed reordering.
- **1 proposed**: row **#18** (`currentNodeUsedDynamicCredentials` not node-scoped above
  k = 1). The write is inside n8n's credential layer and no harness here mirrors it, so it is
  reasoned from the code and not measured. Unchanged since M3.
- **19 designed**: observed, by n8n's suite, by the differ, or by a test that fails without
  the behaviour.
- Amended in M4: **#12** (one witness, not two — the other was #20), **#13** (a
  destination-stop can now leave a sibling unrun where it previously ran), **#21** (a second
  witness, the depth-first case that k > 1 reorders), **#16** (`lastNodeExecuted` can differ at
  k = 1 too, once another row has made the activation sets differ — the second cost of the
  model change), and **#8** (the query it names, `placeBound(ready_i, n)`, was measured in M4
  and does not close on a compiled net; the join-slot form that does close cannot fail).

Of the 21, **7 apply only above k = 1** (#15–#19, #21, and #17's widening) and **1 is v0 only**
(#3). At k = 1 on a v1 workflow the register that can bite is: #2, #5, #8, #9, #10, #11, #12,
#13, #14 — arrival order, join arrival counts and stop semantics, all of them ordering or
join-strandedness, none of them a silent data corruption.

## What this engine reproduces, and what it does not

*One paragraph, no hedging.* Run an n8n v1 workflow under this engine at budget 1 and the
nodes that run, the data they receive, the data they produce, the `pairedItem` lineage, the
`source` records, the error shapes, the resumable `nodeExecutionStack` and `waitingExecution`,
and the value `processRunExecutionData` persists the execution by are what n8n itself would
have produced — measured on the 2124 cases of `packages/core`, the package whose five
workflow-execute test files are the only place n8n's own suite constructs a scheduler, and
where the only differences are three registered ordering rows and one declared non-goal. A
further 29 931 cases (`packages/workflow`, `packages/cli`'s unit suite) run with the patches
applied and the engine registered but never entered, and are byte-identical to their unpatched
baselines: that is patch neutrality around the seam, not a second measurement of the engine. What
it does *not* reproduce is n8n's total execution order in three specific shapes: when one input
receives several arrivals, n8n runs the most recent first and the net runs them in arrival
order, so two runs of that node swap their `runIndex` (their payloads are the same two
payloads); when a join becomes ready while siblings are queued, n8n runs it last and the net
runs it as soon as it is enabled; and when a node's inputs never all arrive, n8n re-runs the
join with `[]` in the gap while the net reports a stranded token instead. Raise the budget
above 1 and you additionally give up total order by design — that is the point of the
project — and with it three things that were only ever well-defined because one node ran at a
time: which node is `lastNodeExecuted`, which continued error survives in `executionError`, and
whether a node that had already started is allowed to finish after a sibling fails. At k = 1
`lastNodeExecuted` moves too, but only where a stranding or a stop already made the two engines
run *different activations* — one fixture does that (`ifBothOutputs`, divergence #16). Nothing
above changes any node's data at any budget; the one exception is a *halting* execution, where
the set of activations differs by whichever siblings were already in flight. Keep k = 1 for a
workflow whose correctness depends on one node's failure suppressing a sibling that was ready
to run, or that resolves credentials dynamically. And the whole claim is about the scheduler
as `packages/core` exercises it — 2124 cases — with `packages/workflow` and `packages/cli`'s
unit suite as 29 931 further cases of patch neutrality around it, and it is not about
`packages/cli`'s integration suite, which needs a live database and was not run.

## Reproducing

```bash
# baselines, on the unpatched tree (scripts/verify-patch.sh --restore first)
scripts/verify-patch.sh --restore
scripts/bootstrap-n8n.sh --skip-install --skip-build --scope=core
scripts/bootstrap-n8n.sh --skip-install --skip-build --scope=workflow
# the cli scope needs its own install and its own build (minutes, once)
(cd .n8n && pnpm install --frozen-lockfile --filter 'n8n...')
scripts/verify-patch.sh --restore
scripts/bootstrap-n8n.sh --skip-install --scope=cli   # BUILD_TARGET switches to n8n

# every scope at k = 1, patches re-applied by the script.
# NOTE: this exits 1 today — not because of the engine, but because the `workflow` leg's
# matrix carries the positional-pairing artefact described under Scopes (1 spurious
# regression + 1 spurious fixed). Read the per-leg lines, or run the scopes separately,
# until `caseKeys` pairs duplicate groups by status multiset.
cd typescript && npm run build && cd ..
scripts/run-conformance.sh --scope=all --budget=1

# the cli scope, both engines (the script rebuilds the n8n chain from the patched tree)
scripts/run-conformance.sh --scope=cli

# the budget legs of the execution-engine scope (k = 1 must exist first)
scripts/run-conformance.sh --skip-patch --engines=libpetri --budget=2
scripts/run-conformance.sh --skip-patch --engines=libpetri --budget=4

# the differential harness, both engines, all fixtures
cd typescript
node_modules/.bin/tsx src/conformance/differ-cli.ts tests/conformance/differ-fixtures.ts
```

The suite is load-sensitive (M3 measured 507 s and a vitest timeout at load average > 20);
these numbers were taken at load average 3–5, where the execution-engine legs take 9–17 s, the
`core` legs 10–14 s, the `workflow` leg 25 s and each `cli` leg 3.5 minutes.
