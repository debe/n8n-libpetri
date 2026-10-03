# Plan: engine v2 seam (patches 0003/0004), net-backed SettlementPolicy, live v2 testbed

ADR 0013 decisions 4(b) to 4(d). Synthesized 2026-10-02 by a design workflow: two independent designs (upstreamable seam, evidence first) and a judge who checked the disputed claims against master `944afe5`. The judge's text follows unchanged. Step 1 (4(a)) landed in `3a562a3`. Deviations made during implementation are recorded at the end.

## Scores

| | Design A (seam + reader port) | Design B (success conditions first) |
|---|---:|---:|
| Correctness against master `944afe5` | 7 | 7 |
| Neutrality-gate realism | 8 | 7 |
| Patch surface / drift cost | 6 | 8 |
| Evidence ordering | 6 | 9 |
| Postgres analysis | 7 | 8 |
| **Overall** | **7** | **8** |

I checked the disputed claims against the read-only source in `.n8n/`.

**Claims that hold:**
- `StartExecutionService` takes `validateGraph` as its 4th parameter, and `createEngineRuntime` passes only 3 (`start-execution.service.ts:40-45`, `create-engine-runtime.ts:125`).
- The neutrality pins are at `step-settled-handler.test.ts:236` and `:252`. The tests build the handler with 6 positional arguments (`:160`).
- `engine-v2.runtime.test.ts:174` uses `expect.objectContaining`.
- `engine-v2.module.ts:31` refuses queue mode.
- Both the in-process mode and the `n8n engine` command (`commands/engine.ts:51-53`) go through `EngineV2Runtime.initEngine`, which calls `createEngineRuntime`. `serve.ts:30` is a third caller. So B is right that no cli patch is needed.
- `cli/node_modules/@n8n/engine` and the compat package's copy both symlink to `packages/@n8n/engine`, so they resolve to one CJS instance.
- Docker.app is installed but the daemon is down. brew is present with no Postgres installed. `embedded-postgres` on npm is at `18.4.0-beta.17`, and `@embedded-postgres/darwin-arm64` exists. `postgresVersions.primary` is `postgres:18.4-alpine`, and m1 uses `postgres:18-alpine`.

**Claims that are wrong or incomplete:**
- **Integration files.** There are 6 engine integration files, not 5 (B left out `testing/__tests__/start-engine-server.integration.test.ts`). It is 1 case and needs no Postgres. The 5 Postgres files each use only `new PostgreSqlContainer(img).start()`, `.getConnectionUri()` and `.stop()`, so the shim both designs propose works.
- **Repeated keys.** A says n8n's answer "may repeat keys that already have a row". It cannot: `decideSuccessors` drops any target with an existing row (`settlement.ts:89`). Repeats can only come from snapshot skew.
- **Successor filter.** Both designs filter R(S) by successor **node id**. n8n decides per **key**:
  - the target is `targetKey(edge, class, settled)`;
  - edges are walked in `graph.edges` order, and a target reached by two edges is decided once;
  - a batch row decides one side only, through `batchStepDecides`.

  A filter by node id can include another iteration's key.
- **The test-module instance.** B's engine-side registry has to be set on the right module instance. The engine's own integration tests import `../../runtime` from `src`. The compat tests resolve `@n8n/engine` to `dist`, because `main` is `dist/index.js` and the vitest config has no alias. A handles this. B does not.
- **Cancel-on-request.** Neither design covers it. `CancelExecutionService.cancel` calls `cancelPendingSteps` with no failed row. Our decoder throws on cancelled rows with no failure (`step-rows.ts:184`). A settlement that loaded the execution as live before the cancel committed then hits a `CodecError` in the policy. In that race n8n plans and creates rows: `createSteps` refuses only after a failure (`typeorm-step-store.ts` ~96-102), and `StepReadyHandler` later cancels those rows.
- **4(a) is not "to do".** It is already in the uncommitted working tree:
  - `waiting` decodes as in flight;
  - `cancelled` counts as the start only;
  - `V2_STEP_STATUSES` is pinned to master.

  The v2 decoder and conformance tests pass: 6 files, 261 tests. The differential and the exhaustive spike also have uncommitted edits.

## Decisions

1. **The seam is `decideSuccessors` + `isFinished` (B), not `expectedSettledSteps` (A).**
   - A's net policy has to return `rows.length` as a stand-in count, which is a boolean in disguise.
   - With `isFinished`, the default keeps n8n's store-call order: `loadLatestStepSummaries` (through `loadTerminalIterations`), then `countSettledSteps` only when the expected count is defined. The handler then calls `hasFailedSteps`.
   - `reachableNodeIds` and its `UnexpectedError` move into the default.
2. **The reader is an execution-bound, read-only port (A's shape) and includes `countSettledSteps`.**
   - It is a plain pass-through, with no prefetch and no cache. Tests `:236` and `:252` would catch anything else.
   - The policy gets no write method, so "a pure function of rows" is enforced by its type.
3. **`settled` is a `StepKey`, as in n8n.** `decideSuccessors` takes a `StepKey` and reads the settled row from `steps` through `decisionKeys`.
4. **Five things stay in the handler or are not touched.**
   - The failure branch, `hasFailedSteps`, `createSteps`, the announcements and `cancelPendingSteps` stay in the handler.
   - Input gathering stays in `StepReadyHandler`. That is data plumbing, divergence row 32.
   - `validateGraph` is not touched. 0004 gets no `validateGraph` hook. n8n's converter never emits wait or subworkflow steps (row 33), and refusing at start where n8n accepts would be a new divergence. A compile refusal at run time throws and is counted.
   - `settlement.ts`, `completion.ts`, `loop-ledger.ts`, `iteration-mapping.ts` and `graph/loops.ts` stay byte-identical, so the six golden dist hashes hold. A three-line `terminalIterationsOf` lives in the new file.
5. **Injection is `EngineRuntimeOptions.settlementPolicy` plus an engine-side registry (B).** `setSettlementPolicy`, `getSettlementPolicy` and `resetSettlementPolicy` live in `execution/settlement-policy-registry.ts`.
   - The registry is read **only** in `createEngineRuntime`, never as the handler's constructor default, so the handler unit tests never run our policy.
   - There is no cli patch. The cli scope is then neutral by construction, but it is still run.
   - This is the same shape as patch 0002, and it needs one drift surface, not two.
6. **The net policy reports by key, in n8n's order.**
   - The net gives the fates: R(S) comes from `decodeStepRows` + `planFromMarking`.
   - The candidate list and order come from our port of `classifyEdge` / `targetKey` / `batchStepDecides`. It walks the settled node's out-edges in graph order, dedupes, and skips keys that already have a row.
   - The candidate list is structure, not scheduling, so it does not break the "net decides what runs" rule.
7. **`isFinished` (net) means every row is settled and R(S) is empty.** Its equality with `countSettled ≥ countExpected` must be measured before the patch, in decision 13's leg.
8. **There is no fallback to n8n's planner.** A decode or compile error throws, is logged, and the execution stays `running`, which is visible. Two cases are named and decided rather than thrown:
   - **Failed rows:** the plan is ∅, because `_halt` inhibits every start and skip.
   - **Cancelled rows with no failed row:** a cancel on request. Return ∅ and `isFinished = false`, because the cancel path ends the execution. Record it as a divergence row, since n8n would create rows that later get cancelled.
9. **The snapshot is two existing queries: `loadLatestStepSummaries`, then `loadStepSummariesByKeys` over `0..latest` per node.**
   - There is no `StepStore` change. Iterations are contiguous per node, and a missing key is simply absent.
   - Skew between the two reads is monotone, because statuses only progress. Shadow mode measures it.
10. **The compile cache is a pure memo of the graph.**
    - The key is sha256 of the canonical `{nodes, edges in order}`.
    - It is a bounded LRU, and a refusal is cached as a refusal.
    - It holds no per-execution state, which reconciliation needs.
11. **The Postgres providers are, in order:**
    - (a) Docker, if the user starts it: testcontainers runs unmodified, with the highest fidelity.
    - (b) `embedded-postgres@18.4.0-beta.17` in the gitignored `.testbed/pg/`: no sudo, a version that matches `primary`, and it ports to CI. Its tag is beta.
    - (c) `brew install postgresql@18`, which is not installed today.

    For (b) and (c), a generated vitest config aliases `@testcontainers/postgresql` to a shim that creates and drops a database per container. It is listed in `.n8n/.git/info/exclude`, as the v1 shim is, and it stamps the real server version. PGlite is rejected: it is a single session, and the store relies on pooled transactions that lock the execution row and on `FOR UPDATE SKIP LOCKED`.
12. **Reporting keeps four kinds of result apart:**
    - neutrality legs, comparing patched-with-nothing-registered against the unpatched baseline;
    - "policy-entering cases passed", counted per case by an entered counter, never a raw pass count;
    - the testbed, which is an integration result only;
    - golden and differential results, which are settlement evidence, not conformance numbers.
13. **The differential legs come before any patch (B).** They decide whether the decision 6 and 7 shapes hold.

## Implementation steps (one agent each)

1. **Land 4(a).** The changes are in the working tree: `codec/v2/step-rows.ts`, `conformance/v2/{binder,reference}.ts`, and the tests in `tests/codec/v2-step-rows.test.ts` and `tests/conformance/v2/*`.
   - Rerun `tasks/v2-differential.mts` (20 × 20) and `tasks/spike-v2-exhaustive.mts`.
   - Update divergence rows 31 (`cancelPendingSteps`, waiting) and 33, and `docs/conformance-master.md`.
   - Done when: `npm test` and `npm run check` are green, both scripts show 0 disagreements, and the work is committed.
2. **Differential legs (a″) and (a‴).**
   - New `src/settlement/scope.ts`, with `candidateKeys(graph, settled, rows)` porting `classifyEdge`, `targetKey`, `batchStepDecides`, the edge-order dedupe and the existing-row skip. Also `scopePlan(plan, candidates)`.
   - In `v2-differential.mts`, the exhaustive spike and `reference.ts`: at every reached (S, s), compare `scopePlan(R(S))` with n8n's `decideSuccessors(s)` as an ordered queue/skip sequence. Compare `netFinished(S)` with `countSettled ≥ countExpectedSettledSteps` over all S, failed sets included.
   - Tests go in `tests/settlement/scope.test.ts`.
   - Done when: 0 disagreements over 83,600 runs and 123,142 row sets. Any disagreement stops the plan, and the falsifiers below say what to change.
3. **No-Postgres baselines.**
   - Add the scopes `engine` (`pnpm --filter @n8n/engine test`), `compat` (unit) and `cli-v2` (`n8n test src/modules/engine-v2 src/services/engine-v2-dispatcher`) to `run-conformance.sh` and `bootstrap-n8n.sh --scope=…`.
   - Done when: baseline junit is recorded at 944afe5 and two runs are identical per case, which is the flake check.
4. **Patch 0003.**
   - New `.n8n/packages/@n8n/engine/src/execution/settlement-policy.ts` holding `SettlementReader`, `SettlementPolicy`, `defaultSettlementPolicy`, `settlementReaderFor` and `terminalIterationsOf`.
   - `step-settled-handler.ts` gets the 7th constructor parameter. `planSuccessors` and `finishExecutionIfDone` delegate to the policy.
   - Exports go in `execution/index.ts` and `src/index.ts`.
   - New upstream-style `__tests__/settlement-policy.test.ts`: the default policy equals direct calls, and an injected policy is used.
   - Add `packages/@n8n/engine/src` to `PATCH_SCOPE` in `verify-patch.sh`. Add the engine and compat packages to `--typecheck`/`--build`, and add `--lint` (oxlint plus `biome ci src`).
   - Done when: the patch is written to `patches/n8n/0003-*.patch`; existing n8n tests pass unedited; junit for the `engine`, `compat` and `cli-v2` scopes is identical to the baseline; tsc, oxlint and biome are clean; and the decision-core files are byte-identical.
5. **Patch 0004.**
   - `execution/settlement-policy-registry.ts`.
   - `EngineRuntimeOptions.settlementPolicy`, with `settlementPolicy ?? getSettlementPolicy()` passed only in `createEngineRuntime`.
   - Exports, plus a `create-engine-runtime.test.ts` case for the option and the registry.
   - Done when: the step 4 gate is rerun identical, and the patch is in `patches/n8n/0004-*.patch`.
6. **Our policy (no `.n8n`).**
   - `src/n8n/v2-host.ts` holds structural mirrors of the 0003 types.
   - Move `graphToDescription` to `src/n8n/v2-graph.ts`, with a re-export left in `conformance/v2/graph.ts`.
   - `src/settlement/{compile-cache,rows,policy,shadow,register}.ts`. `createSettlementPolicy({onDiagnostic})` covers decisions 6–10, with the diagnostics `settlement policy registered` and `settlement policy entered`.
   - Add a tsup entry `n8n-v2`.
   - Tests in `tests/settlement/{policy,cache,shadow}.test.ts`:
     - cold equals warm;
     - 20 reader permutations give one answer;
     - interleaved executions;
     - ∅ on failed rows and on cancelled-without-failure rows;
     - a reader call budget of 3, including `countSettledSteps`;
     - a doctored candidate is caught by shadow, and a candidate throw is contained.
   - Done when: the suite and `check` are green.
7. **Golden v2 extension.**
   - The recorder in `conformance/v2/golden.ts` and `tests/fixtures/v2/` adds per settlement `(S, s, decideSuccessors(s) in order, countExpected, finished)`, taken from n8n's dist.
   - The replay drives `createSettlementPolicy` through an in-memory reader.
   - Done when: CI replays with 0 findings. A failing replay is never fixed by re-recording.
8. **Leg (d), handler level (local, no Postgres).**
   - In `tasks/v2-differential.mts`, import the patched dist `StepSettledHandler` and `StepReadyHandler`.
   - Write in-memory `StepStore`/`ExecutionStore` that emulate dedupe, the CAS and refuse-after-fail.
   - Run the default policy against ours on the corpus behaviours and compare per-settlement answers and final rows.
   - Done when: 0 disagreements. The stores' semantics are ours, which must be stated.
9. **Postgres provider and the neutrality legs N2.** Blocked on the user's choice of provider.
   - `scripts/testbed/pg.sh` for embedded-postgres, brew, Docker or `LIBPETRI_PG_URL`.
   - The generated testcontainers shim config.
   - The scopes `engine-int` (6 files; 5 need Postgres) and `compat-int` (m1, 16 cases), each with an unpatched baseline.
   - Done when: patched-with-nothing-registered is junit-identical to the baseline, and the stamp records the server version.
10. **The libpetri engine leg.**
    - A setup shim calls `setSettlementPolicy(createSettlementPolicy(...))` on the `src` registry module for the engine's tests and on `@n8n/engine` (dist) for compat.
    - A per-case entered counter supports the report "policy-entering cases passed". Cases that never enter are labelled.
    - Done when: the leg is reported separately from neutrality, and every regression is triaged into a fix or a divergence row.
11. **Testbed `--v2`.**
    - `n8n-testbed.sh --v2 --settlement=off|shadow|primary` sets `N8N_ENABLED_MODULES=engine-v2`, `N8N_ENGINE_MODE=in-process` and `N8N_ENGINE_DATABASE_URL` from `pg.sh`.
    - It rebuilds `@n8n/engine` dist when that is stale.
    - `preload.mjs` gets a branch that resolves `@n8n/engine` through `createRequire(cli/package.json)` and refuses to boot without `setSettlementPolicy`.
    - `seed.mjs` sets `settings.engineType: 'v2'`. First verify that the REST path accepts it.
    - Seed the converter-accepted testbed workflows, plus new ones: Loop Over Items (1,000 items at batch size 1), an If/Switch diamond into Merge, and a Stop and Error beside a long sibling.
    - Done when: the boot gates on `registered`, and the first run logs `entered`.
12. **`diff-engines-v2.sh` and `tests/testbed/compare-v2.ts`.**
    - Legs: `off`, `primary`, and `shadow` in both directions, read over SQL.
    - Compare execution status, the fate multiset, filled slots, normalised outputs, the row count and the `ended` response's `lastStep`. Also check that policy calls are at least the number of settled non-failed rows, and that the shadow JSONL has 0 disagreements, with the named races excluded and counted.
    - Record per-leg latency in `docs/testbed.md` as an integration result.
    - Done when: the results are written up and no wall clock is presented as a conformance number.
13. **ADR 0014 and bookkeeping.**
    - The ADR covers the seam shape (key-scoped successors, `isFinished`, the engine registry, what was left out) and the measured results.
    - Add divergence rows for the cancel race, the fail race and refusals at run time, and update `tasks/todo.md` §9.
    - Done when: the docs match the measurements.
14. **Only if F4 fires: the local frontier decode.**
    - Read the `decisionKeys` rows plus the latest batch rows.
    - Done when: local equals global on every differential state.

## Blockers needing the user

1. **The Postgres provider for N2, the engine leg and the testbed.** Pick one:
   - start Docker Desktop (`open -a Docker`), the most faithful option;
   - allow `npm install embedded-postgres@18.4.0-beta.17` into `.testbed/pg/`, which needs network and is a beta tag;
   - or `brew install postgresql@18`, a global side effect.

   Steps 1–8 do not need it.
2. **Committing 4(a).** The uncommitted edits to `step-rows.ts`, `binder.ts`, `reference.ts`, both task scripts and their tests are pre-existing working-tree changes. Please confirm they are the 4(a) work to commit.
3. **Upstream intent.** If 0003 is to be offered to n8n, decide whether 0004's process-global registry is acceptable there or should become a cli DI registry (A's 0004b). This changes the patch surface but not our policy.
4. **Seeding.** Check that setting `settings.engineType: 'v2'` through the owner-session REST path works. It is not yet verified.

## Falsifiers

- **F1, neutrality.** Patch 0003 or 0004 needs an edit to any existing n8n test, or a patched-with-nothing-registered junit differs from its baseline in `engine`, `compat`, `cli-v2`, `engine-int` or `compat-int`.
- **F2, decision equality.** At some reached (S, s), the key-scoped net plan differs from `decideSuccessors(s)` in keys, queue/skip split or order. This applies in the differential, the golden replay, leg (d) or live shadow. Named races are excluded and counted:
  - a failure lands after `hasFailedSteps`: ours is ∅, n8n's is refused by `createSteps`;
  - a cancel on request lands after the execution was loaded.
- **F3, completion.** `netFinished(S)` differs from `countSettled ≥ countExpected` at a reached S, or an execution stays `running` under `primary` where `off` completes.
- **F4, I/O.** Under the Loop Over Items with 1,000 passes, the policy goes past 3 round trips per settlement, or its p95 is more than 2× n8n's handler p95. Then build step 14.
- **F5, wrong instance.** `registered` is logged without `entered`, or the leg's entered counter is 0. That means the wrong module instance, either `src` vs `dist` or the preload against the cli.
- **F6, snapshot skew.** A `CodecError` on live rows that the offline legs never produce means the two-query snapshot is not monotone-safe. Then a single-transaction read is needed, which is a `StepStore` change.
- **F7, run-time compile refusal.** A compile refusal at run time on a graph n8n accepted. Today 209 of 209 compile.
- **F8, drift.** Any engine commit that touches `step-settled-handler.ts` or the decision core shows up in `check-n8n-drift.sh`, and the golden's dist stamps move.

### Decision 7, amended after F3 fired at step 2 (2026-10-03, orchestrator)

Step 2 measured leg (a‴) and blocked on F3. On every failed row set (S, s), `isFinished` as first
defined ("every row settled, R(S) empty") said true where n8n's
`countSettled >= countExpectedSettledSteps` said false. On row sets without a failed row there were
0 disagreements. Leg (a″), the decision itself, had 0 disagreements everywhere.

Amendment: **`isFinished(S)` is false whenever S holds a failed row.** Otherwise it is "every row
settled and R(S) empty". Why:
- In n8n a failed row set never reaches `finishExecutionIfDone`. The failed step's own
  `step:settled` goes to `failExecution`, and every other settlement checks `hasFailedSteps` first
  and fails the execution.
- A failed S reaches completion only in the race where a failure lands between the planning read
  and `hasFailedSteps`. That race already has its name under F2.
- In that race the failure's own settlement ends the execution as `failed`. So returning false
  hands the ending to the path that owns it, and the end status is `failed` either way.

F3 is therefore measured on row sets without a failed row, and failed row sets are counted as the
named race, not compared. Leg (d) adds a check: every run whose behaviour fails a step ends with
execution status `failed` under both policies.


### F7 at step 10: configless v1-nodes are opaque steps (2026-10-03, orchestrator)

Step 10 blocked on F7. engine-int's `step-execution.integration.test.ts` builds graphs whose
`v1-node` steps carry no config (`{id, name, type: 'v1-node'}`). Engine v2 accepts them, because
`config` is optional and the engine never inspects it. `graphToDescription` mirrors the
converter's `isV1NodeStepConfig` and refused them, so the policy threw and 9 cases timed out
with the execution `running`.

Decision: **a `v1-node` without config is an opaque step.** It gets a synthetic node type, and its
input and output counts are read from its edges. This follows the engine's contract, not the
converter's:
- v2's settlement rule reads only edges, slots and the step type (`batch` versus the rest), never
  a v1 node's config;
- a workflow converted by `V1WorkflowConverter` always carries config, so nothing it produces
  changes;
- an opaque step is never `n8n-nodes-base.merge`, so the chooseBranch refusal
  (`analysis/engine-v2/nodes.ts`) cannot apply to it, and the engine itself refuses no Merge mode.

The reverted experiment measured `step-execution` at 10/10 passing and 9/9 policy-entering, with
30 of 30 shadow answers agreeing. The step-10 rerun measures every scope again.


## Deviations during implementation

### Step 2: the legs ran, and F3 fired on failed row sets

**What was built.**
- `src/settlement/scope.ts` exports `candidateKeys(graph, settled, rows)`, `scopePlan(plan, candidates)` and `isFinished(rows, plan)`. Decision 7's `netFinished` is named `isFinished`.
- `candidateKeys` reads the converter's `isBackEdge`, as `classifyEdge` does, and does not derive it. Loop membership is `deriveLoops`' SCC rule, computed with the compiler's `tarjan`.
- As in n8n, the batch filter applies only when S holds the settled batch node's own row.

**`reference.ts`.**
- `handlerPlan` is `decideSuccessors(s)` loaded as `planSuccessors` loads it, through `exitSourcesInto`, `latestTerminal` and `decisionKeys`.
- `settledCount` and `referenceFinished` give `finishExecutionIfDone`'s test. `reachableOf` gives the reachable node set.
- `simulate` gets an `onSettled(rows, s)` hook for the reached (S, s), and now plans and finishes through these helpers.
- No run moves: the e133737 digest test still passes, and leg (a) still has 0 disagreements.

**`differential.ts`.** New `compareScoped`, `compareFinished` and `netPlanAt`.

**How leg (a″) answers on a failed S.** n8n's answer is taken as the handler gives it: ∅, because `hasFailedSteps` comes before planning. The raw `decideSuccessors(s)` is kept as `unguarded`. Where it is non-empty, that is F2's named race; it is counted and not compared.

**Coverage beyond the plan.**
- The exhaustive spike also compares every completed or skipped row of every distinct row set (`scopedAll*`), whether or not the handler reaches it.
- That stronger check is what catches a dropped `batchStepDecides`. With the filter removed, reached pairs show 0 disagreements and all pairs show 311. A reversed candidate order gives 103 disagreements on both.

**Leg (a″) results: 0 disagreements.**

| run | reached (S, s) | non-empty | on a failed S (named race) | all (S, s) |
|---|---:|---:|---:|---:|
| differential 20 × 20 (83,600 runs) | 537,950 | 468,897 | 99 (57) | – |
| differential 20 × 20 `--wait 0.2` (83,600 runs) | 538,532 | 468,908 | 96 (54) | – |
| exhaustive (4 passes, 1M cap, ≤ 14 nodes; 196 graphs, 123,142 row sets) | 316,165 | – | 170,742 (37,357) | 946,814 |
| exhaustive `--wait` (3 passes, 2M cap, ≤ 9 nodes; 161 graphs, 36,835 row sets) | 59,644 | – | 28,858 (257) | 161,061 |

In the 20 × 20 run without `--wait`, 33,079 of the reached pairs have two or more keys in one list, so order is exercised.

**Leg (a‴) results: F3 fires.**
- Disagreements: 2,160 of 972,945 states (20 × 20), 2,160 of 1,096,310 states (`--wait 0.2`), 16,124 of 123,142 row sets (exhaustive) and 931 of 36,835 row sets (exhaustive `--wait`).
- Every disagreement is on a row set with a failed row, and every one has the same sign: `isFinished` is true and the count test is false.
- Row sets without a failed row: 0 disagreements.
- n8n's count gives two causes:
  - `countExpectedSettledSteps` is undefined because a loop had not ended (360 / 360 / 947 / 223);
  - the count still owes steps the failure kept from being decided (1,800 / 1,800 / 15,177 / 708).

  The smallest case is `T → A → B` with S = {T completed, A failed}. The net is halted and every row is settled, so `isFinished` is true. n8n counts 2 settled rows against 3 expected.

**Where the gap could be observed.** It is visible only where `finishExecutionIfDone` runs on a failed S. In n8n's handler that is the race in which a failure lands after `hasFailedSteps`. There, our policy would call `finishExecution('failed')` and announce the end with the sibling step as `lastStep`, where n8n's own `failExecution` would win.

**Status.** Per the stop rule, step 3 and later wait for a decision on decision 7. None of these was tried:
- `isFinished` falls back to n8n's count on a failed S;
- F3 names the failed S as a race and excludes it, as F2 does;
- `isFinished` requires no failed row. This would still disagree, the other way, on a failed S where the failed step was the last one owed: there the count test is true.

### Step 2, rerun under decision 7 as amended: 0 disagreements on failure-free row sets

**What changed.**
- `isFinished(rows, plan)` in `src/settlement/scope.ts` returns false whenever a row has failed.
  Otherwise it is unchanged: every row settled and R(S) empty.
- `compareFinished` (`conformance/v2/differential.ts`) compares only on an S without a failed row.
  On a failed S it returns `agree: null`, which means F3's named race, counted and not compared. A
  decoder throw stays a disagreement (`agree: false`), failed S or not.
- Both task scripts report leg (a‴) as two numbers: the S compared, with their disagreements, and
  the failed S counted as the race. For the race they also count where n8n's count test says
  finished, which is where the failed step was the last one owed.
- Tests: `tests/settlement/scope.test.ts` pins `isFinished` false on a failed S, including the
  smallest case `T → A → B` with A failed and the case where the failed step was the last one owed.
  `tests/conformance/v2/differential.test.ts` pins both cases as `agree: null`, and a doctored
  R(S) on a failure-free S and a decoder throw on a failed S as disagreements.

**Leg (a‴) results: 0 disagreements on failure-free S. F3 does not fire.**

| run | S | compared (no failed row) | disagreements | failed S (race, not compared) | race S where n8n's count says finished |
|---|---:|---:|---:|---:|---:|
| differential 20 × 20 (83,600 runs) | 972,945 | 970,157 | 0 | 2,788 | 400 |
| differential 20 × 20 `--wait 0.2` (83,600 runs) | 1,096,310 | 1,093,464 | 0 | 2,846 | 400 |
| exhaustive (4 passes, 1M cap, ≤ 14 nodes; 196 graphs) | 123,142 | 46,204 | 0 | 76,938 | 6,221 |
| exhaustive `--wait` (3 passes, 2M cap, ≤ 9 nodes; 161 graphs) | 36,835 | 16,483 | 0 | 20,352 | 2,939 |

No CodecErrors. In both differential runs, "finished by both" is 81,040, the number of
failure-free pairs.

**Leg (a″) is unchanged: 0 disagreements.**
- 20 × 20: 537,950 reached pairs, 99 on a failed S (57 races).
- `--wait 0.2`: 538,532 pairs, 96 on a failed S (54 races).
- Exhaustive: 316,165 reached and 946,814 overall, 0 disagreements on both.
- Exhaustive `--wait`: 59,644 reached and 161,061 overall, 0 disagreements on both.

Legs (a), (b) and (c) are also 0 in both differential runs. The exhaustive planner check (`dis`) is
0 on both configurations. Truncated graphs are as before: `7154.json`, and with `--wait`
`fixture/switchFanOut`.

**Stamp.** n8n 2.42.0 dist at `944afe5`, with the decision-core hashes as the scripts print them
(`settlement.js 8b7fe1d317aa`, `completion.js 3d3c53f9902c`, `loop-ledger.js affbe650919e`,
`iteration-mapping.js b020437a1dc2`, `loops.js 942db20c8af8`). libpetri 7.0.0 from the registry,
not linked.

**Gate.** `npm run check` is clean, and `npm test` passes 1,943 tests in 99 files. That includes
`v1-identity` with `v1-fingerprint.json` untouched and the golden replays (`v2-planner-golden`,
`port-golden`). These are settlement evidence, not conformance numbers (decision 12).

### Step 3: no-Postgres baselines for `engine`, `compat` and `cli-v2`

These are unpatched baselines and a flake check. They are not conformance numbers and not
neutrality legs for 0003/0004, which do not exist yet (decision 12).

**What was built.**
- `scripts/bootstrap-n8n.sh --scope=` and `scripts/run-conformance.sh --scope=` gained `engine`,
  `compat` and `cli-v2`. They use one table in both scripts, as the other scopes do. `scripts/README.md`
  lists them.
- A scope can now carry several vitest path filters, separated by spaces. Each one is passed as
  its own argument. `N8N_TEST_FILTER` takes the same form.
- The build target is per scope: `@n8n/engine`, `@n8n/node-engine-compatibility` (turbo's `^build`
  also builds its devDeps n8n-core and n8n-nodes-base) and `n8n`. The bootstrap's post-build check
  is per target too. `run-conformance.sh` used to rebuild only for `cli`. It now rebuilds every
  scope that has a build target, because compat and cli-v2 load n8n-core and `@n8n/engine` from
  dist, and step 4 patches `@n8n/engine`.
- None of the three scopes constructs a `WorkflowExecute`, so their `libpetri` leg (the v1
  scheduler) is reported as not applicable. The v2 settlement leg is step 10.

**What "unit only" excludes, and why.** Nothing is excluded beyond what n8n's own config already
leaves out. Each scope runs its package's `test` script, and that script's `vitest.config.ts`
excludes `**/*.integration.test.ts`. That leaves out:
- `engine`: six files from `vitest.integration.config.ts`. Five start Postgres through
  `new PostgreSqlContainer(...)`:
  - `database/__tests__/workflow-execution`
  - `database/__tests__/workflow-step-execution`
  - `execution/__tests__/execution-start`
  - `execution/__tests__/step-execution`
  - `server/__tests__/workflow-executions`

  The sixth, `testing/__tests__/start-engine-server` (1 case), needs no Postgres, but it shares
  that config, so it goes with `engine-int` in step 9.
- `compat`: `m1-acceptance.integration.test.ts`, 16 cases, which needs Postgres through
  testcontainers.
- `cli-v2`: the unit config already excludes `*.integration.test.ts` and `test/integration/`. The
  v2 tests outside the two filters are not in this scope: `src/executions`, `src/webhooks`,
  `src/workflows/triggers` and `test/integration/engine-v2-*`.

**Deviation: the cli-v2 filter.** The plan's filter `src/services/engine-v2-dispatcher` matches
nothing, because vitest path filters are substrings and the test is
`src/services/__tests__/engine-v2-dispatcher.service.test.ts`. The scope uses
`src/services/__tests__/engine-v2-dispatcher`, and that matches only that file. The other two
`engine-v2-*` service tests (payload-files, push-registry) are left out, as the plan's filter
intended.

**Fix in passing.** `run-conformance.sh` exited 1 on any scope whose last leg wrote no matrix (a
not-applicable `libpetri` leg). The cause was a trailing `[ -f … ] && …` under errexit. That
contradicted its own header, which says not-applicable legs do not set the exit status. The same
bug affected `--scope=workflow`. It is now an `if`.

**Procedure.** First `verify-patch.sh --restore`, which leaves a pristine `packages/core/src`. Then
`bootstrap-n8n.sh --scope=X --skip-install` (run 1) and `--skip-install --skip-build` (run 2). The
install was already present for the `n8n...` closure. Turbo restored every dist from its cache:
the unpatched n8n-core dist no longer calls `getWorkflowSchedulerFactory`. Afterwards,
`verify-patch.sh` re-applied 0001/0002, and `turbo run build --filter=n8n` put the patched dists
back (all cache hits). `.n8n` holds no commits and no branches.

**Results at 944afe5.** Each run was compared per case with `conformance/cli.ts --require-identical`
and again with an independent multiset of (file, name, status).

| scope | files | cases | pass | fail | skip | run 1 = run 2 per case |
|---|---:|---:|---:|---:|---:|---|
| `engine` | 27 | 376 | 376 | 0 | 0 | identical |
| `compat` | 8 | 169 | 169 | 0 | 0 | identical |
| `cli-v2` | 22 (21 + 1) | 365 | 365 | 0 | 0 | identical |

`engine` has repeated case names: one `validateExecutableGraph` title appears 3 times, and the
`round trips a execution:started event` title appears twice. The matrix numbers repeats
positionally. All of them pass in both runs.

Artefacts are in `conformance-results/`: `baseline-{engine,compat,cli-v2}.junit.xml` (run 2),
`.run1.junit.xml`, `.summary.txt` and `.flake.matrix.md`.

**Neutrality leg for 0001/0002 (information only).** `run-conformance.sh --skip-patch` was run on
the re-patched tree for each scope. `legacy-engine`, `legacy-compat` and `legacy-cli-v2` are
identical to their baselines, with exit 0. This is the existing v1 seam with nothing registered.
It is not step 4's F1 gate, which needs 0003.

**Stamp.** n8n `944afe5`, with `@n8n/engine` 0.22.0 and `@n8n/node-engine-compatibility` 0.10.0.
vitest 5.0.1, node v26.8.1, pnpm 12.4.2 through corepack 0.36.0.

**Gate.** `npm run check` is clean. `npm test` passes 1,943 tests in 99 files, which includes
`v1-identity`, with `v1-fingerprint.json` untouched, and the golden replays.
`verify-patch.sh --restore` applied both patches cleanly. The engine package is untouched in
`.n8n`, so the decision-core files are byte-identical.

### Step 4: patch 0003, `SettlementPolicy` extracted; F1 does not fire

These are neutrality legs: the patched tree with nothing registered, against the unpatched
step-3 baselines. They are not conformance numbers and not policy-entering cases (decision 12).

**What was built.** `patches/n8n/0003-settlement-policy.patch` (one commit, 5 files, +705 / −60).
It was written in `.n8n` on a temporary branch: 0001 and 0002 were `git am`'d as commits, 0003 was
committed on top, and `git format-patch -1 --start-number 3` exported it. `.n8n` was then put back
at the detached pin, and the branch was deleted. The tree now holds 0001–0003 as applied changes,
with no commits and no branches.
- `execution/settlement-policy.ts` holds `SettlementReader`, `SettlementPolicy`,
  `defaultSettlementPolicy`, `settlementReaderFor` and `terminalIterationsOf`, as decisions 1–3
  ask. The shapes:
  - `decideSuccessors(graph, settled: StepKey, reader): Promise<SuccessorDecisions>`
  - `isFinished(graph, reader): Promise<boolean>`
  - The reader is `{ executionId; loadLatestStepSummaries(nodeIds); loadStepSummariesByKeys(keys);
    countSettledSteps() }`. It is a pass-through with no cache, and it has no write method.
- `step-settled-handler.ts` takes `settlementPolicy: SettlementPolicy = defaultSettlementPolicy`
  as its 7th constructor parameter. `planSuccessors` and `finishExecutionIfDone` delegate to it.
  `reachableNodeIds` and its `UnexpectedError` moved into the default (decision 1). The failure
  branch, `hasFailedSteps`, `createSteps`, the announcements and `cancelPendingSteps` stay in the
  handler (decision 4).
- Exports: the three values and two types from `execution/index.ts` and `src/index.ts`, plus
  `SuccessorDecisions`, and `StepSummary` in `src/index.ts`, which a policy outside the package
  needs.
- `execution/__tests__/settlement-policy.test.ts` has 21 cases in n8n's style:
  - The default policy equals direct calls of `decideSuccessors` (6 cases, loopless and looped)
    and of the count test (4 cases). Each case also pins the expected answer, so the equality
    cannot hold vacuously.
  - It reads exactly as the handler did: no loop-tip read without an exit edge, the tip before
    the decision rows, no count while a reachable loop runs, and no read of an unreachable loop.
  - A triggerless graph throws before any read. `settlementReaderFor` binds the id.
    `terminalIterationsOf` is checked.
  - An injected policy is used: its decisions are written and announced, `isFinished` decides the
    finish, and a failed execution never asks the policy.

**Choices the plan left open.**
- The reader carries `executionId`. The default needs it for n8n's `UnexpectedError` message,
  and a policy can use it in its diagnostics.
- The handler passes its `StepRecord` as `settled`, not a fresh `{nodeId, iteration}`.
  `decisionKeys` puts `settled` itself into the key list it hands to `loadStepSummariesByKeys`,
  so the store gets the same objects as before. With a fresh key, the store would get a
  different object wherever no later key with the same id replaces it. A test that asserts the
  exact keys could see that.
- `terminalIterationsOf` is the loop body of `loadTerminalIterations` (4 lines). The default
  keeps that function's "no read for no loop" short cut in a private helper, so `loop-ledger.ts`
  stays untouched.

**Neutrality legs (F1).** `run-conformance.sh --skip-patch --engines=legacy --scope=…` was run on
the tree with 0001–0003 applied. Each scope's turbo build had exactly one cache miss (engine
9 / 10 cached, compat 29 / 30, n8n 61 / 62). The built `step-settled-handler.js` calls
`settlementPolicy`.

| scope | baseline (step 3) | patched, existing cases | new cases | strict comparison |
|---|---:|---:|---:|---|
| `engine` | 376 / 376 pass | 376 / 376 pass | 21 / 21 pass (`settlement-policy.test.ts`) | identical (`--require-identical`, new file's suite removed) |
| `compat` | 169 / 169 pass | 169 / 169 pass | 0 | identical (`--require-identical`) |
| `cli-v2` | 365 / 365 pass | 365 / 365 pass | 0 | identical (`--require-identical`) |

- For `engine`, the script's own leg says "NOT identical" with 0 regressions, 0 missing and
  21 new. `--require-identical` fails on added cases by construction, and the plan requires an
  added test file. The strict comparison ran on a copy of the junit with that file's `testsuite`
  removed (`conformance-results/legacy-engine.existing.{junit.xml,matrix.md}`). A separate
  multiset of (file, name, status) agrees for all three scopes.
- No existing n8n test was edited: the patch's only test path is the new file.
- Each leg ran once. The flake check is step 3's.
- `engine-int` and `compat-int` need Postgres (step 9) and were not run.
- `tsc --noEmit` covers the integration test that builds the handler with 6 arguments
  (`execution-start.integration.test.ts`).

**Decision core.** `settlement.ts`, `completion.ts`, `loop-ledger.ts`, `iteration-mapping.ts` and
`graph/loops.ts` are byte-identical to the pin: same sha256 before and after, and an empty
`git diff 944afe5`. After a full re-emit (`dist/build.tsbuildinfo` removed), their dist hashes are
still step 2's (`8b7fe1d317aa`, `3d3c53f9902c`, `affbe650919e`, `b020437a1dc2`, `942db20c8af8`).
The converter is still `6b2d8ba8518a`.

**Deviation: the golden stamps the handler, and 0003 changes it.** Decision 4 counted six
stamped hashes. Since then the stamp grew to 12 files (`GOLDEN_STAMPED_DIST`), and one of them is
`engine/dist/execution/step-settled-handler.js`, which step 4 has to change.
- With 0003 applied, the local check "matches the pinned checkout's dist, file by file" failed
  on that file alone. CI has no `.n8n` and skips that check.
- The golden was not re-recorded. Instead, `GOLDEN_SEAM_PATCHED_DIST` in
  `src/conformance/v2/golden.ts` pins the hash that file has when built from the pin plus 0003
  (`28762f9eafae…`). Two full builds gave the same hash.
- The check now accepts, per file, n8n's stamp or that pinned hash, and nothing else. A new test
  asserts that the allowance names only stamped files and never the stamp's own hash.
- What `simulate` ports from the handler (`failExecution` and the liveness check) is untouched.
  Step 8's leg (d) runs the patched handler directly.
- This is not F8. F8 is an upstream commit that touches these files. Here the plan's own patch
  changes the file, and the change is pinned, so any other hash still fails.

**Scripts.**
- `verify-patch.sh`: `PATCH_SCOPE` is `packages/core/src packages/@n8n/engine/src`.
  `--typecheck` and `--build` cover `n8n-core`, `@n8n/engine` and
  `@n8n/node-engine-compatibility`, in that order. The new `--lint` runs `@n8n/engine`'s `lint`
  (oxlint) and `format:check` (`biome ci src`). Compat's source is not patched, so it is not
  linted.
- `--restore` resets both scopes, then the re-apply works.
- `check-n8n-drift.sh` lists commits touching `step-settled-handler.ts` and the decision core by
  name, as F8 says it does.
- `patches/n8n/README.md`, `scripts/README.md` and the header of `run-conformance.sh` describe
  three patches.

**Drift on the release-branch refs.** `check-n8n-drift.sh --no-fetch` now exits 1.
- `stable` and `beta` (2.40.7, 2026-09-25) take 0001 and 0002 but not 0003. Their
  `execution/index.ts` and `step-settled-handler.ts` predate the pin's (about 100 lines differ).
- The pin, the newest release `n8n@2.42.2` and master take all three.
- This is the release lag that ADR 0013 decision 1 describes, not a forward drift. The script's
  exit status counts it all the same.

**Tooling.** tsc 6.0.2 typechecks all three packages clean. A deliberate type error in the engine
was caught, so the check is not a no-op. oxlint 1.78.0 (`--quiet`) is clean. `biome ci src`
(1.9.0) is clean over 121 files. Biome's formatter was applied to the two new files only.

**Stamp.** n8n `944afe5`, `@n8n/engine` 0.22.0, `@n8n/node-engine-compatibility` 0.10.0.
vitest 5.0.1, node v26.8.1, pnpm 12.4.2 through corepack. The patch file's sha256 is
`8abe0c4801e9…`. libpetri is not involved in these legs.

**Gate.** `npm run check` is clean. `npm test` passes 1,944 tests in 99 files: step 3's 1,943 plus
the allowance test. That includes `v1-identity` with `v1-fingerprint.json` untouched, and the
golden replays (`v2-planner-golden`, `port-golden`) with `tests/fixtures/` untouched. The dist
check ran against the patched `.n8n`. `verify-patch.sh --typecheck --build --lint` applies all
three patches cleanly.

### Step 5: patch 0004, the settlement policy registry; F1 does not fire

These are neutrality legs: the patched tree (0001–0004) with nothing registered, against the
unpatched step-3 baselines. They are not conformance numbers and not policy-entering cases
(decision 12).

**What was built.** `patches/n8n/0004-settlement-policy-registry.patch` (one commit, 5 files,
+134 / −0, sha256 `828a5ef882f5…`). It was written as 0003 was: 0001–0003 `git am`'d onto a
temporary branch, 0004 committed on top, `git format-patch -1 --start-number 4`, then `.n8n` back
at the detached pin and the branch deleted. 0003's file did not change (`8abe0c4801e9…`). The
tree now holds 0001–0004 as applied changes, with no commits and no branches.
- `execution/settlement-policy-registry.ts`: `setSettlementPolicy`, `getSettlementPolicy` and
  `resetSettlementPolicy`. The default is `defaultSettlementPolicy`, as 0002's default factory is
  `StackScheduler`.
- `EngineRuntimeOptions.settlementPolicy?: SettlementPolicy`. `createEngineRuntime` hands the
  `StepSettledHandler` `settlementPolicy ?? getSettlementPolicy()`. That is the only read of the
  registry. The handler's constructor default stays `defaultSettlementPolicy`, so a handler built
  directly, as the handler tests build it, never sees a registered policy (decision 5).
- Exports: the three functions from `execution/index.ts` and `src/index.ts`.
- `runtime/__tests__/create-engine-runtime.test.ts` gets a second `describe` with four cases: the
  handler gets the default while nothing is registered, the option, the registered policy (and
  the default again after `resetSettlementPolicy`), and the option over the registered policy.
  The patch only adds lines to the file (+90 / −0, one `import type` line and the block).

**Choice the plan left open: how the test sees the handler's policy.** The handler is built inside
`createEngineRuntime` and keeps the policy in a private field. Driving a settlement end to end
needs real stores. The cases therefore use `vi.resetModules()` + `vi.doMock('../../execution')`
with a subclass of `StepSettledHandler` that records its 7th argument, and import the runtime
and the registry from that fresh module graph. `doMock` is not hoisted, so the existing seven
cases of the file run with no mock, as before. The engine package had no module mocking before.
A mutation check: with `settlementPolicy ?? getSettlementPolicy()` replaced by
`settlementPolicy`, 2 cases fail; by `getSettlementPolicy()`, 2 fail; by `undefined`, 4 fail.

**Neutrality legs (F1).** `run-conformance.sh --skip-patch --engines=legacy --scope=…` was run on
the tree with 0001–0004 applied. Each scope's turbo build had exactly one cache miss (engine
9 / 10 cached, compat 29 / 30, n8n 61 / 62). The built `runtime/create-engine-runtime.js` calls
`getSettlementPolicy`.

| scope | baseline (step 3) | patched, existing cases | new cases | strict comparison |
|---|---:|---:|---:|---|
| `engine` | 376 / 376 pass | 376 / 376 pass | 25 / 25 pass (21 from 0003's file, 4 from 0004) | identical (`--require-identical`, new cases removed) |
| `compat` | 169 / 169 pass | 169 / 169 pass | 0 | identical (`--require-identical`) |
| `cli-v2` | 365 / 365 pass | 365 / 365 pass | 0 | identical (`--require-identical`) |

- For `engine` the script's own leg says "NOT identical" with 0 regressions, 0 missing and 25
  new, by construction. The strict comparison ran on a copy of the junit without the
  `settlement-policy.test.ts` `testsuite` and without the four `createEngineRuntime settlement
  policy` `testcase`s (`conformance-results/legacy-engine.existing.{junit.xml,matrix.md}`, now step
  5's). A separate multiset of (file, name, status) agrees for all three scopes, and the added
  cases are in exactly those two files.
- Step 4's leg artefacts were kept as `conformance-results/legacy-{engine,compat,cli-v2}.step4.*`.
- No existing n8n test was edited. Each leg ran once; the flake check is step 3's.
- `engine-int` and `compat-int` need Postgres (step 9) and were not run.

**Decision core and golden.** `settlement.ts`, `completion.ts`, `loop-ledger.ts`,
`iteration-mapping.ts` and `graph/loops.ts` have an empty `git diff 944afe5`. Their dist hashes
are step 2's (`8b7fe1d317aa`, `3d3c53f9902c`, `affbe650919e`, `b020437a1dc2`, `942db20c8af8`).
0004 changes no stamped file: `step-settled-handler.js` is still `28762f9eafae…`, the hash
`GOLDEN_SEAM_PATCHED_DIST` pins, so the local dist check passes against 0001–0004 unchanged. Its
doc comment now says that 0004 changes no stamped file.

**Scripts.** `verify-patch.sh` needed no change: `PATCH_SCOPE` already covers
`packages/@n8n/engine/src`. `check-n8n-drift.sh`'s seam list gained
`runtime/create-engine-runtime.ts`, 0004's one injection point. `patches/n8n/README.md` describes
four patches, has a section for 0004, and its regenerate and re-pin commands cover 0004.

**Deviation: `n8n@2.42.2` does not take 0004.** `check-n8n-drift.sh --no-fetch` exits 1, as it did
after step 4, now with three drifting refs:
- `stable` and `beta` (2.40.7) still stop at 0003, as in step 4.
- `n8n@2.42.2` takes 0001–0003 but stops at 0004 (`create-engine-runtime.ts:10`). The release does
  not have master's cancel-on-request (`681768e0bb`, `56d6e9da2c`), which adds
  `CancelExecutionService` to the same import list and to `createEngineServer`. The tag is not an
  ancestor of the pin.
- The pin and master take all four.

This is release lag, not forward drift, and not F8: F8 is about commits that touch
`step-settled-handler.ts` or the decision core, and no commit since the pin touches the seam list
on master. Step 4's open question, whether release refs older than the pin should only be
reported, now covers the newest release tag too.

**Tooling.** `verify-patch.sh --typecheck --build --lint` applies all four patches cleanly.
tsc typechecks `n8n-core`, `@n8n/engine` and the compat package clean (it did catch the first
version of the test, whose dynamic imports lacked the `.js` extension that `nodenext` requires).
oxlint is clean. `biome ci src` is clean over 122 files.

**Stamp.** n8n `944afe5`, `@n8n/engine` 0.22.0, `@n8n/node-engine-compatibility` 0.10.0, vitest
5.0.1, node v26.8.1, pnpm 12.4.2 through corepack. libpetri is not involved in these legs.

**Gate.** `npm run check` is clean. `npm test` passes 1,944 tests in 99 files. That includes
`v1-identity` with `v1-fingerprint.json` untouched, and the golden replays with
`tests/fixtures/` untouched. The golden's dist check ran against the 0001–0004 tree.

### Step 6: the net-backed policy

Nothing in `.n8n` changed. The cost figures below are offline CPU costs on an in-memory reader:
they are settlement evidence, not conformance numbers, not policy-entering cases and not F4 (F4 is
measured live, steps 11 and 12).

**What was built.**
- `src/n8n/v2-host.ts`: structural mirrors of 0003's `StepKey`, `StepSummary`,
  `SuccessorDecisions`, `SettlementReader` and `SettlementPolicy`, plus `V2SettlementRegistry`
  (0004's three functions and `defaultSettlementPolicy`). Checked once against the patched
  engine's `dist/index.d.ts` with a scratch `tsc` file, outside the repository, in both directions.
  Our policy is accepted by `setSettlementPolicy` and `EngineRuntimeOptions.settlementPolicy`.
  The engine module is accepted as a `V2SettlementRegistry`, and n8n's reader, graph and
  decisions are accepted as ours. A deliberate mismatch was caught.
- `src/n8n/v2-graph.ts` is the moved `conformance/v2/graph.ts`, unchanged apart from its import
  paths and module doc. `conformance/v2/graph.ts` re-exports it, so the tests and the task scripts
  import it as before. `settlement/scope.ts` now imports the graph from `n8n/`. The differential
  still runs through the re-export (smoke run, 15 workflows, 0 findings).
- `src/settlement/compile-cache.ts` (decision 10):
  - The key is the sha256 of the canonical JSON of `{nodes, edges}`. Object keys are sorted, and
    node and edge order are kept. The whole node config is hashed, so a change can only cost a
    miss.
  - The cache is a bounded LRU (default 128). A refusal is cached and is thrown again as a fresh
    `SettlementCompileRefusal` whose `cause` is the first error.
  - Keys are also remembered per graph object, weakly. Each entry keeps the first graph object
    seen with its key, so `scope.ts`'s WeakMap derivation is reused across settlements.
  - An entry holds the key, the graph, the net and a replay rank, and nothing per execution.
- `src/settlement/rows.ts` (decision 9):
  - `loadLatestStepSummaries(all node ids)`, then `loadStepSummariesByKeys(0 .. latest−1)` only
    for nodes whose latest row is past iteration 0. On a loop-free graph, or before a loop's
    second pass, the snapshot is one read.
  - A store answer that does not match the question is a `SettlementSnapshotError`: a row under
    another node's key, an unasked node or key, a duplicate or a bad iteration.
  - A missing key is left absent, and the decoder refuses the gap.
- `src/settlement/policy.ts`: `createSettlementPolicy({ onDiagnostic, cache })`.
  - Compile from the memo (`engineV2`), take the snapshot, then apply a pure function of the
    rows: `decideFromRows` or `finishedFromRows`, both exported.
  - Diagnostics: `settlement policy entered` on every call, before the first read;
    `settlement policy race`; `settlement policy error` before a throw. A listener's throw is
    ignored. There is no fallback.
- `src/settlement/shadow.ts`, `createShadowPolicy({ primary, candidate, onReport })`:
  - The primary answers. The candidate runs after it, on the same reader, through its own
    pass-through recorder.
  - Verdicts are `agree`, `disagree`, `race` (failure or cancel, only where the answers differ)
    and `candidate-threw`.
  - Each report carries both sides' rows, read counts and timings, and a `skew` flag.
- `src/settlement/register.ts`, `registerSettlementPolicy(engine, { mode, onShadowReport, ... })`:
  - Modes are `primary`, `shadow` (n8n answers, ours is compared) and `primary-shadowed` (ours
    answers, n8n's is compared): the two directions of step 12.
  - It checks that `getSettlementPolicy()` returns the policy just set, and only then emits
    `settlement policy registered`.
- `src/n8n-v2.ts`: the tsup entry `n8n-v2` and the package export `./n8n-v2`. `npm run build`
  emits `dist/n8n-v2.js`, and importing it gives the 13 values.
- Tests: `tests/settlement/{policy,cache,shadow}.test.ts` (26 + 10 + 17 cases) and
  `tests/support/settlement-reader.ts`, an in-memory reader with seeded record-order shuffles,
  per-read yields and call counts.

**Choices the plan left open.**
- *Failed rows: the net decides the plan.* `decideFromRows` does not short-circuit a failed row
  set. `_halt` already gives ∅, which is decision 8's own reason, and the decoder still checks
  the rows.
  - A mutation check showed the short-circuit made no difference to any test, so it was
    removed.
  - `isFinished` stays false on a failed row, by decision 7 as amended (`scope.ts`).
  - Only the cancelled-without-failure set is decided without decoding, because the decoder
    refuses it. The plan is ∅ and `isFinished` is false.
- *Row order.* The snapshot sorts rows by iteration, then by each node's rank in a topological
  order of the graph without its back edges. The decoder's answer does not depend on order, but
  its cost does: in graph order a loop replays one pass per sweep, which makes the decode
  quadratic in the passes. The 20-permutation test pins order independence.
- *The call budget.* Read as per policy call: at most 3 reader calls, with `countSettledSteps`
  counted. Measured on every golden state: at most 2 per call, `countSettledSteps` never called,
  and `loadLatestStepSummaries` exactly once.
  - Per settlement that is 2 to 4 calls. 4 happens only when the settlement queues nothing and a
    loop is past its first pass, because the handler then also calls `isFinished`. F4's "3 round
    trips per settlement" can therefore be exceeded on such settlements. That is measured live
    (steps 11 and 12), not here.
- *Shadow races.* A failed or cancelled row in either side's reads excuses a difference as a
  named race. It never turns an agreement into a race, and nothing else is excused.

**Evidence (settlement evidence, decision 12).**
- Golden (n8n's recorded R(S), `tests/fixtures/` untouched):
  - On every failure-free state (more than 500), the union of the policy's `decideSuccessors`
    over the completed and skipped rows is n8n's R(S).
  - On all 456 recorded runs' final rows, `isFinished` is the run's end (414 completed, 42
    failed).
  - Every state with a failed row decides ∅ and is not finished.
- Reference loop on the six loop-free shapes, with the stub: every reached (S, s) is ordered
  equal to `planSuccessors`, and on every failure-free S `isFinished` is the count test.
- Mutation checks: reversed candidates fail 3 cases; a snapshot missing iteration 0 fails 10; a
  cancelled set not decided in `isFinished` fails 1.
- Corpus, through the patched dist's `defaultSettlementPolicy` on the same in-memory reader
  (`tasks/v2-policy-cost.mts`, 4 behaviours × 3 orders, at most 300 settlements per graph):
  15,992 / 15,992 `decideSuccessors` equal in order, 15,992 / 15,992 `isFinished` equal, 0
  throws. That run reached no failed S.

**Cost (offline CPU, in-memory reader).** From `npx tsx tasks/v2-policy-cost.mts`, over 209
accepted graphs, all 209 compiled.

| | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| key hash, fresh graph object (per graph) | 50 µs | 182 µs | 273 µs | 447 µs |
| stage 1 + compile, `engineV2` (per graph) | 0.38 ms | 1.35 ms | 2.04 ms | 6.45 ms |
| cold first call, empty memo (per graph) | 0.38 ms | 1.47 ms | 2.04 ms | 3.32 ms |
| warm `decideSuccessors` (per settlement) | 83 µs | 271 µs | 508 µs | 6.5 ms |
| warm `isFinished` (per settlement) | 21 µs | 65 µs | 104 µs | 2.2 ms |
| warm decide + isFinished (per settlement) | 106 µs | 336 µs | 608 µs | 6.6 ms |
| n8n default, decide + isFinished, same reader | 10 µs | 37 µs | 54 µs | 2.5 ms |

Rows per S: p50 5, p95 19, max 48. Warm, ours costs about 10× n8n's default in CPU, and about
0.1 ms in absolute terms.

**The long loop** (Loop Over Items at batch size 1, settlement of B@k, decide + isFinished, warm):

| k | rows | reads per call | ours p50 / p95 | n8n default p50 / p95 |
|---:|---:|---:|---:|---:|
| 1 | 4 | 2 | 0.04 / 0.05 ms | 0.01 / 0.02 ms |
| 10 | 22 | 2 | 0.15 / 0.30 ms | 0.01 / 0.03 ms |
| 100 | 202 | 2 | 1.74 / 3.10 ms | 0.06 / 0.15 ms |
| 300 | 602 | 2 | 3.85 / 13.75 ms | 0.20 / 0.34 ms |
| 1000 | 2002 | 2 | 13.55 / 14.26 ms | 0.78 / 1.04 ms |

- Our cost grows linearly in the rows. One call at k = 1000 breaks down as: snapshot 2.0 ms
  (mostly the in-memory reader), decode 4.6 ms, plan 0.01 ms, candidates 0.35 ms.
- Over a 1,000-pass run that is O(passes²) in total.
- This is the shape F4 watches. Against a live handler p95 that includes Postgres round trips it
  may or may not exceed 2×. It is reported here and decided in steps 11 and 12. Step 14, the
  local frontier decode, is its remedy.

**Stamp.** n8n 2.42.0 dist at `944afe5` with 0001–0004 (`settlement-policy.js d01a00e31a71`,
`settlement.js 8b7fe1d317aa`, `completion.js 3d3c53f9902c`). libpetri 7.0.0 from the registry,
not linked. Node v26.8.1.

**Gate.**
- `npm run check` is clean. `npm test` passes 1,997 tests in 102 files: step 5's 1,944 plus 53.
- That includes `v1-identity` with `v1-fingerprint.json` untouched, and the golden replays
  (`v2-planner-golden`, `port-golden`) with `tests/fixtures/` untouched.
- `npm run build` emits the `n8n-v2` entry.

### Step 7: the golden records settlements, and the policy replays them with 0 findings

Nothing in `.n8n` changed. These results are settlement evidence (decision 12). They are not
conformance numbers, not policy-entering cases and not a neutrality leg.

**What was built.**
- `src/conformance/v2/golden.ts`, format 2. Each entry gains `settlements` and `settlementCounts`,
  and `parameters` gains `maxSettlementsPerEntry` (default 60). A `GoldenSettlement` holds:
  - `rows`: S, as the handler finds it before `hasFailedSteps`;
  - `settled`: s, a completed or skipped row of S;
  - `decided`: `decideSuccessors(s)` loaded as `planSuccessors` loads it, with no failure check,
    in n8n's order;
  - `expected` and `finished`: `countExpectedSettledSteps` and the count test on S′.

  Keys are `[node index, iteration]`. New helpers: `encodeKey`, `decodeKey`, `encodeDecision`,
  `decisionSequence`, `settlementKey`, `settlementRows` (S and S′), `replaySettlement` and
  `unpatchedStamp`. `asGolden` refuses an entry without `settlements`.
- `replaySettlement(policy, graph, settlement, readerOf)` asks the policy what `StepSettledHandler`
  asks: `decideSuccessors(graph, s, reader over S)` and `isFinished(graph, reader over S′)`.
  - `decideSuccessors` is compared as ordered queue and skip sequences, and `isFinished` with the
    recorded count test.
  - A failed S is F2's and F3's named race: it is counted and not compared, and the verdict carries
    the policy's answers.
  - A throw is a disagreement, race or not.
  - `{ races: 'compare' }` compares races too. Only n8n's own policy can pass that, because it
    returns the raw decision there.
- `tasks/record-v2-golden.mts`:
  - Settlements come from `simulate`'s `onSettled` over the same 12 × 8 runs. They are distinct by
    (row set, s) and capped with `selectStates`, stratified by kind: race, finished, a running
    loop, order, skip, nothing decided, and a later pass.
  - On every distinct settlement, kept or not, the recorder replays `createSettlementPolicy`. It
    also replays the patched dist's `defaultSettlementPolicy` (patch 0003), with races compared.
  - The stamp handling resolves step 4's open item. A stamped file whose local hash is exactly its
    `GOLDEN_SEAM_PATCHED_DIST` hash counts as the recorded hash (`unpatchedStamp`). A build with
    0003 therefore records under n8n's stamp without `--force`.
  - A recorder whose build carries a seam patch, and that has no golden to read n8n's hash from,
    refuses to run.
  - An older format under the same stamp is upgraded in place.
- `tests/conformance/v2-planner-golden.test.ts` (+27 cases):
  - per entry, the (a″, a‴) replay of `createSettlementPolicy` through `memoryReader`, with record
    order seeded per settlement; on a race, the policy must answer ∅ and not finished;
  - coverage of every settlement kind, with more than 400 compared;
  - the counts, and consistency: s is a decided row of S, `finished` is the count test on S′, and
    `decided` names no key that S already has;
  - "the replay catches a disagreement": a swapped order, a queue/skip split, a flipped finish, a
    race counted rather than compared, and a throwing policy on a race and on a non-race;
  - unit cases for `settlementRows` and `unpatchedStamp`.

  The dist check now uses `unpatchedStamp`, with the same semantics as before.

**Choices the plan left open.**
- *S′.* `isFinished` is asked after `createSteps`. So S′ is S plus a `queued` row for each
  `toQueue` key, then a `skipped` row for each `toSkip` key, each key once. On a failed S, S′ is S,
  because `createSteps` refuses after a failure.
- *Where `finished` is recorded.* It is recorded on every S′, not only where the handler asks
  (nothing queued). Each S′ is a reached row set, and F3 is stated over reached S. Of the 515 kept,
  336 are settlements where the handler asks.
- *Format bump.* Format 1 → 2, because the shape changed. Nothing that format 1 held changed.

**Existing content is unchanged.**
- Removing the additions from the new file (both entry fields and the parameter) and setting
  `format` back to 1 gives JSON equal to `HEAD`'s file.
- The textual diff is +594 / −21. The 21 removed lines are `"format": 1`, the
  `maxStatesPerEntry` line (which gains a trailing comma) and the 19 `stateCounts` lines (which also
  gain one).
- The stamp is unchanged. The handler's local hash `28762f9eafae…` is read as n8n's
  `d8bca81fb45e…`.
- A second recorder run reports "unchanged".
- Before any edit, the old recorder had also reproduced `HEAD`'s file except for that one hash.

**Results.**

| | settlements |
|---|---:|
| reached, distinct (19 entries) | 828 |
| kept in the golden | 515 |
| our policy, compared (failure-free S) | 811 |
| `decideSuccessors` disagreements (keys, split, order) | 0 |
| `isFinished` disagreements | 0 |
| failed S (named race, not compared) | 17 |
| of those, n8n's raw decision non-empty / count test finished | 5 / 3 |
| n8n's dist `defaultSettlementPolicy`, races compared | 828, 0 disagreements |

- All 17 races are kept, and on each one the policy answers ∅ and not finished.
- The kept 515 include 29 settlements with two or more keys in one list (order is exercised), 132
  with a skip, 49 at a later pass and 88 while a loop runs.
- The CI replay (all 515) has 0 findings. The recorder exits 0 with 0 findings.

**Mutation checks** (on `src/settlement/scope.ts`, restored afterwards):

| mutation | golden suite cases that fail |
|---|---:|
| reversed candidate order | 8 |
| `isFinished` ignores unsettled rows | 20 |
| `isFinished` true on a failed S | 6 |
| batch filter (`batchStepDecides`) dropped | 0 |

The batch filter cannot be caught at reached settlements. As step 2 measured, n8n never reaches a
pair where the filter matters. `tests/settlement/scope.test.ts` catches the dropped filter
(3 cases). Making the golden catch it would mean recording n8n's decision at unreached pairs (every
decider row of every state), which step 7 did not ask for.

**Stamp.** n8n 2.42.0 dist at `944afe5`, with 0001–0004 applied. The golden stamp is unchanged, and
the handler's patched hash is read through `GOLDEN_SEAM_PATCHED_DIST`. libpetri 7.0.0 from the
registry, not linked. Node v26.8.1.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,024 tests in 102 files (step 6's 1,997 plus 27). That includes
  `v1-identity` with `v1-fingerprint.json` untouched, and `port-golden` and `policy`/`scope`, which
  read the same golden.
- The recorder script was also typechecked separately (it is outside `tsconfig.test.json`).

### Step 8: leg (d), n8n's handlers on in-memory stores, 0 disagreements

Nothing in `.n8n` changed. These results are settlement evidence (decision 12) about n8n's own
handlers running on **our** in-memory stores. They are not conformance numbers, not
policy-entering cases, not a neutrality leg and not an integration result.

**What was built.**
- `tasks/v2-handler-leg.mts`, a new script rather than an extension of `v2-differential.mts` (the
  plan allowed either). It loads the patched dist's `ExecutionStartHandler`, `StepReadyHandler`,
  `StepSettledHandler`, `defaultSettlementPolicy` and `settlementReaderFor`, and n8n's
  `StepNotFoundError` / `ExecutionNotFoundError`. Nothing is ported: input gathering,
  `runBatchStep`, the failure branch and the announcements are n8n's compiled code.
- `typescript/src/conformance/v2/memory-stores.ts`: `MemoryStepStore` and `MemoryExecutionStore`.
  `tests/conformance/v2/memory-stores.test.ts` (19 cases) pins each semantic below. Mutation
  checks: dropping refuse-after-fail in `createSteps`, in `claimStep`, or `waiting` from
  `cancelPendingSteps` each fails one case.
- The dist was rebuilt as the plan asks (`pnpm --filter @n8n/engine build`, pnpm through
  `npx corepack@0.36.0`). tsc's incremental build emitted nothing, and every hash below is the
  hash from steps 4–7.

**The stores' semantics are ours.** They follow `TypeOrmStepStore` and `TypeOrmExecutionStore` at
the pin, but nothing checks them against Postgres:
- Dedupe: `createSteps` inserts a key once. A key that already has a row, or that came earlier in
  the same batch, is skipped and not returned. The rows it returns come in batch order. Postgres
  promises no `RETURNING` order; this order is ours.
- Refuse-after-fail: `createSteps` creates nothing and `claimStep` claims nothing once any row of
  the execution has failed.
- CAS: `claimStep` is `queued → running`. `complete`, `suspend`, `fail` and `cancelStep` are
  `running → …`. `resumeStep` is `waiting → queued`. `cancelPendingSteps` moves `queued` and
  `waiting` rows and leaves `running` ones. `finishExecution` is a CAS on `running` / `waiting`.
- Planning reads: `filledOutputSlots` is per slot "not JSON null". Keyed loads return records in a
  seeded shuffled order, because a store promises no order. `countSettledSteps` counts completed,
  failed, skipped and cancelled rows. `refreshLiveStatus` is the SQL's rule.
- Each call is atomic after an optional seeded yield. `loadExecution` returns a fresh graph object
  every time, as a JSON column does, so our policy pays its key hash on every settlement.

**Choices the plan left open.**
- *Two runs per (graph, b, o).* One run with the default answering and one with ours answering,
  under the same behaviour and the same seeded event order. The driver draws the next event at
  random from a pool that holds both queues and the resumes.
- *Per-settlement comparison (d1).* Every policy call is wrapped. The wrapper snapshots S
  synchronously at call entry, lets the answering policy read the live store, then asks the other
  policy through `settlementReaderFor` on a frozen copy of S. A failed S is the named race
  (F2, and F3 as amended): counted, not compared. Our `isFinished` must still be false on it, and a
  throw from ours is a disagreement, race or not.
- *Run comparison (d2).* In sequential mode the two runs are in lockstep. The leg compares the
  same calls with the same answers, the same final rows (status and outputs), the same execution
  status, the same lifecycle events in order, the same `ended` response (status, `lastStep`,
  outputs), the same handler errors and the same event count.
- *Behaviours.* The differential's seeds, with `pFail` 0.05 on every 4th behaviour and `--wait`.
  `outcome()` drives every `v1-node` step:
  - a failure throws;
  - a suspend returns `{ acceptsResumeRequest: true }` and is resumed by request with its outputs;
  - otherwise each fired slot carries 1–3 items.

  Batch steps are n8n's `runBatchStep` on those items, so the engine decides how many passes a
  loop takes (up to iteration 3 here), and `emptyTerminal` does not apply.
- *Concurrency.* `--concurrency 8` runs up to 8 events at once, and every store call yields 0–3
  ticks first, which is what brings the races out live. The two runs then interleave differently,
  because the policies make different reads, so (d2) is reduced to: the same status, and the same
  final rows when failure-free. A call whose rows changed while it read is "skewed": both policies
  are compared on the frozen S, and the leg counts how often the live answer moved.
- *(d3), amended decision 7's check.* Every run that ends with a failed row must end `failed`
  under both policies. Every run without one must end `completed`. A run left `running` would be
  F3's second clause.

**Results: 0 disagreements, F2, F3 and F6 do not fire.** All 209 accepted graphs, 20 × 20, so
83,600 pairs and 167,200 runs per configuration.

| configuration | `decideSuccessors` compared / disagreements | `isFinished` compared / disagreements | failed S at `isFinished` (race; n8n's count true) | skewed calls (answer moved) | (d2) pairs differing | (d3) failed-row runs not `failed` / failure-free not `completed` |
|---|---:|---:|---:|---:|---:|---:|
| sequential | 1,086,514 / 0 | 686,920 / 0 | 0 | 0 | 0 of 83,600 | 0 of 2,620 / 0 of 80,980 |
| sequential `--wait 0.2` | 1,087,386 / 0 | 687,800 / 0 | 0 | 0 | 0 of 83,600 | 0 of 2,620 / 0 of 80,980 |
| `--concurrency 8 --wait 0.2` | 1,100,712 / 0 | 701,047 / 0 | 107 (8) | 105,475 (10,861) | 0 of 83,600 | 0 of 2,620 / 0 of 80,980 |
| `--concurrency 8 --p-fail 0.3 --wait 0.2` | 998,336 / 0 | 626,841 / 0 | 333 (14) | 93,009 (9,631) | 0 of 83,600 | 0 of 10,100 / 0 of 73,500 |

- The (d3) numbers are the same under both policies: the default and ours.
- In the sequential runs, 949,314 of the compared decisions are non-empty, and 66,184 have two or
  more keys in one list, so order is exercised. 5,812 runs reach a loop past its first pass.
- Neither policy threw, ours logged no `settlement policy error` diagnostic, and the handlers
  raised no errors in any run.
- No `decideSuccessors` call started on a failed S, even under concurrency. The handler calls the
  policy right after `hasFailedSteps` with no await in between, so the failure race lands during
  the policy's own reads (the skewed calls). It reaches `isFinished` with the failed row already
  in S (107 and 333 times). There, ours says not finished, n8n's count says finished on 8 and 14,
  and every such run still ends `failed`.
- With `--wait 0.2`, 83,012 steps suspended and 82,994 resumed. The remainder were cancelled by a
  failure. 14,322 calls were made beside a waiting row.
- The `entered` diagnostic count (1,773,434 sequential) includes the calls where ours is asked as
  the comparison side, so it is not a per-answer count.

**Mutation checks** (`--mutate`, 4 × 2 sequential unless stated; findings are expected):

| fault planted in our policy | (d1) | (d2) | (d3) |
|---|---:|---:|---:|
| both lists reversed | 1,309 | 484 | 0 |
| skips dropped | 6,412 | 938 | 936 runs left `running` |
| `isFinished` always false | 4,531 | 1,620 | 1,620 runs left `running` |
| `isFinished` true on a failed row, sequential | 0 | 0 | 0 |
| the same, `--concurrency 8 --p-fail 0.3`, 4 × 4 | 8 | 0 | 0 |

The last fault is invisible sequentially, because the handler never asks `isFinished` on a failed
S then. Under concurrency, (d1) catches it. (d3) does not, because the handler re-reads
`hasFailedSteps` and ends the run `failed` either way. That is the amendment's own argument: the
end status does not depend on this answer.

**Stamp.** n8n 2.42.0 dist at `944afe5` with 0001–0004: `settlement.js 8b7fe1d317aa`,
`completion.js 3d3c53f9902c`, `loop-ledger.js affbe650919e`, `iteration-mapping.js b020437a1dc2`,
`loops.js 942db20c8af8`, `step-settled-handler.js 28762f9eafae` (the pinned patched hash),
`settlement-policy.js d01a00e31a71`, `step-ready-handler.js 0317e74462fe`,
`execution-start-handler.js 6118d530cc6e`, `batch-step.js 0ea5d46e8844`. libpetri 7.0.0 from the
registry, not linked. Node v26.8.1. Wall clock was 394 s, 407 s, 646 s and 594 s, run as four
processes side by side.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,043 tests in 103 files: step 7's 2,024 plus the 19 store cases. That
  includes `v1-identity` with `v1-fingerprint.json` untouched and the golden replays, with
  `tests/fixtures/` unchanged by this step.
- The task script was typechecked separately.
- `.n8n` is at the detached pin with no branches, and the decision-core files have an empty
  `git diff 944afe5`.

### Review fixes after step 8: the regeneration recipe, and the two named races live

Two review findings, both reproduced. Nothing in `.n8n` changed and no patch was regenerated.

**The regenerate-all recipe in `patches/n8n/README.md`.** It said only 0003 and 0004 share files.
0001 and 0002 also share `packages/core/src/execution-engine/workflow-execute.ts` and
`packages/core/src/execution-engine/index.ts` (their `diff --git` headers), so the recipe's
whole-file `git add` put 0002's registry lookup into the 0001 commit. The recipe now lists both
pairs with full paths and stages the first commit of each pair with `git add -p`.
`tests/scripts/patch-readme.test.ts` reads the four patches' headers and checks that each commit
block stages exactly its patch's files, that a file a later patch also touches is staged with
`git add -p` (and no other file is), and that the prose names every shared file. Against the old
recipe two of its four cases fail.

**The cancel race and the failure race at `isFinished` (decision 8).** Deviation from step 13:
divergence rows 36 (cancel race) and 37 (failure race at `isFinished`) are written now, not at
step 13, so neither race is a silent skip whenever step 10 or 11 registers the policy. Step 13
still owes the row for compile refusals at run time and an update of 36 and 37 with live numbers.
`tests/settlement/policy.test.ts` checks that every race kind the policy emits (`failure`,
`cancel`) has exactly one register row naming `settlement policy race` with that kind. It fails
without the rows.

Leg (d) gains live coverage for both (`tasks/v2-handler-leg.mts`):
- `--p-cancel P` sends n8n's own `CancelExecutionService.cancel` (patched dist) into the event pool
  at a seeded event, in a seeded share P of the runs, the same under both policies. On a cancelled
  row set without a failed row, ours must answer ∅ and not finished, a (d1) finding otherwise. A
  run whose cancel won must end `cancelled` with no row `queued` or `running`, a (d3) finding
  otherwise. A concurrent pair with a cancel in either run is left to (d3), because the cancel lands
  at a different point of each interleaving.
- Every run records whether a `failed` ending was written by `finishExecutionIfDone`, that is in
  the same handled event in which the answering policy's `isFinished` said true (an
  `AsyncLocalStorage` per event, and a wrapper on `finishExecution`). For ours that is a (d3)
  finding. The leg also counts `failed` endings by the `lastStep` status of the `ended` response.
- `--p-cancel` defaults to 0. Without it, the stress configuration reproduces step 8's row exactly
  (998,336 / 0, 626,841 / 0, 333 (14), 93,009 (9,631)).

Results, all 209 accepted graphs, 20 × 20. These are settlement evidence on our stores, as in step
8: not conformance numbers, not policy-entering cases and not an integration result.

| configuration | (d1) disagreements | failure race at `isFinished` (n8n's count true) | ended `failed` through `isFinished`: default / ours | `failed` endings with a sibling `lastStep`: default / ours | cancels sent / won | `decideSuccessors` on a cancelled S (default plans) | `isFinished` on a cancelled S (default true) | runs whose cancel won not `cancelled`, or with rows left `queued` / `running` | findings |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `--concurrency 8 --p-fail 0.3 --wait 0.2` | 0 | 333 (14) | 7 / 0 | 205 / 201 of 10,100 | – | – | – | – | 0 |
| the same, `--p-cancel 0.3` | 0 | 311 (12) | 5 / 0 | 189 / 186 of 9,345 | 10,916 / 10,408 | 42 (26) | 107 (18) | 0 / 0 | 0 |
| sequential `--wait 0.2 --p-cancel 0.3` | 0 | 0 | 0 / 0 | 68 / 68 of 2,426 | 11,441 / 9,252 | 0 | 0 | 0 / 0 | 0 |

- **The finding's `lastStep` claim needs a correction.** A sibling as `lastStep` is not by itself
  the divergence. When `hasFailedSteps` finds a failure, n8n's handler calls
  `failExecution(execution, step, node)` with the settling sibling, under either policy. That
  gives the 68 sibling endings that are identical in lockstep sequentially, and most of the ~200
  under concurrency. The policy-dependent difference is the `finishExecutionIfDone` path: 7 runs
  (5 with cancels) under n8n's policy, 0 under ours. Of n8n's 14 "count says finished" races, the
  other 7 lost the `finishExecution` compare-and-set to `failExecution`. Row 37 records it that way.
- **The cancel race.** It occurs only under concurrency. Sequentially the handler reads the
  execution as ended and returns before planning, and the two runs stay identical in lockstep.
  Rows created after a won cancel: 3,228 in 2,887 runs under n8n's policy and 3,198 in 2,866 under
  ours. Most come from settlements whose row set still read as live, where both policies plan the
  same (row 35). The two concurrent runs interleave differently, so these counts are not paired
  and their difference is not a measurement of row 36.
- No falsifier fires. F2 and F3 exclude the named races and count them, and nothing they compare
  disagrees.

**Gate.** `npm run check` is clean, and `npm test` passes, including the two new regression tests.
The task script was typechecked separately. Wall clocks were 587 s, 557 s and 391 s, run as three
processes side by side.

### Step 14: the local frontier decode, built before F4 was measured

Nothing in `.n8n` changed. Every result below is settlement evidence (decision 12): not a
conformance number, not a policy-entering case count, not a neutrality leg and not an
integration result. The cost figures are offline CPU on an in-memory reader.

**Deviation: step 14 was built without F4 firing.** The plan made step 14 conditional on F4, which
is measured live in steps 11 and 12. The review of steps 2–8 found a defect that F4 would not
catch first. `readSnapshot` asked `loadStepSummariesByKeys` for every key `0 .. latest − 1` of
every node. `TypeOrmStepStore.loadStepSummariesByKeys` binds 2 parameters per key plus the
execution id (`stepKeyFilter`, `database/typeorm-step-store.ts`). So a Loop Over Items at batch
size 1 with a 4-node body asks 5 keys per pass and passes Postgres' 65,535 bind parameters at
about 6,550 passes. The orchestrator ordered step 14 now. This is a reading of n8n's source, not
something reproduced against Postgres.

**What the folded marking needs (the frontier).** S's frontier is every node's latest row plus,
for each loop whose batch node's latest row is at pass L ≥ 3, the rows of the loop's nodes (batch
node and members) at passes 0 and L − 1. With L ≤ 2 the frontier is every row. A node outside a
loop has one row. The frontier holds at most 3 rows per loop node, whatever L is.
`decodeFrontier` drops the other passes and replays passes 0, L − 1 and L as 0, 1 and 2 through
the unchanged `decodeStepRows`. The row counts are each node's latest iteration + 1.

Why the marking is a function of the frontier (the module doc of `codec/v2/frontier.ts` has the
full argument). `validateLoops` and the compiler leave one entry, one return edge K, no exit but
the batch node's done slot, and no nested loops. Every member is therefore an ancestor of K's
source within its pass. A start or skip takes one `arrived` per incoming edge, and only a
completed run or a skip writes its out-edges. So in any row set the global decoder accepts:
- every row below its node's latest is `completed` or `skipped`;
- the body's places are empty whenever the batch node's next pass starts;
- a pass 1 ≤ p ≤ L − 2 starts by `B_start_back` and puts back the `K/arrived` and `B/live` it
  took, so its firings change no place.

Pass 0 stays because it fires the entry pair. Pass L − 1 stays because whether K arrived live
decides how pass L starts. Removing either one is caught (see the mutations below).

The same facts give what the policy reads besides the marking:
- the named race and "every row settled" come from the latest rows;
- a key exists exactly when its iteration is at most its node's latest. `candidateKeys` now
  tests existence that way instead of looking the key up, which gives the same answer on any
  contiguous S;
- the batch filter reads the settled row, which the snapshot adds by key when it is not the
  node's latest row (a late or redelivered settlement).

n8n's `decisionKeys` also names each candidate's source rows and the batch row at the candidate's
pass. The net does not read those rows: the marking stands in for them.

**What was built.**
- `src/codec/v2/frontier.ts`: `frontierKeys(compiled, latest)` (the keys beyond the latest rows,
  at most 2 per loop node, none outside a loop), `frontierOf`, `decodeFrontier` and
  `latestIterations`. A refusal is the global decoder's refusal on the compressed rows, with the
  renumbering named.
- `src/settlement/rows.ts`: `readSnapshot(entry, reader, settled?)` makes the latest-row read,
  then one keyed read over `frontierKeys` plus the settled key when it is not latest. That is at
  most 2 reader calls and at most 2 × loop nodes + 1 keys per call. `readFullSnapshot` is the old
  read, kept for verification. `Snapshot` gains `keys`.
- `src/settlement/policy.ts`: `createSettlementPolicy({ snapshot: 'frontier' | 'full' })`, with
  `frontier` as the default. `decideFromRows` and `finishedFromRows` take the same switch and now
  type their first argument as `DecisionNet` (graph and net). `full` is the global decoder.
- `src/settlement/scope.ts`: `candidateKeys` tests existence by latest iteration.
  `src/n8n-v2.ts` also exports `readFullSnapshot` and `SnapshotScope`.
- `src/conformance/v2/differential.ts`: leg (f), `compareFrontier(compiled, graph, S, s?)`. At S
  it compares the marking and row counts from `frontierOf(S)` with `decodeStepRows(S)` (two
  refusals agree; one refusal does not). It also compares `finishedFromRows` on the frontier with
  the full snapshot, and `decideFromRows` on the frontier plus s's row with the full snapshot.
- `src/conformance/v2/reference.ts`: `Behaviour.maxPasses` is optional. When it is absent the
  value is 3, so every existing draw and every golden run is unchanged.
- Task scripts:
  - `v2-differential.mts`: leg (f) and `--max-passes`;
  - `spike-v2-exhaustive.mts`: leg (f);
  - `v2-handler-leg.mts`: (d4), where at every policy call ours with the frontier and ours with
    the full snapshot are asked on the frozen S and must agree, and the most keys and reads per
    call are measured. Also `--max-items N` (default 3, every run from before);
  - `v2-policy-cost.mts`: the long loop goes to k = 10,000, with keys and the full snapshot
    alongside.
- Tests: `tests/codec/v2-frontier.test.ts` (6 cases):
  - local equals global on every golden state and every settlement's S and S′;
  - random walks of the net's planner on 7 loop shapes up to 14 passes (more than 5,000 distinct
    row sets, more than 1,000 compressed, deepest iteration at least 12), checking the marking,
    row counts, R(S), the named race, "every row settled" and every completed or skipped row's
    candidates;
  - a missing pass L − 1 is refused by both decoders;
  - the key counts.

  The 10,000-pass case is a Loop Over Items at batch size 1 with a 4-node body (50,001 rows). Five
  situations are covered: the return, the terminal pass, mid-pass, a late settlement of pass 17,
  and finished. In each one the frontier policy makes at most 2 reads and asks at most 11 keys
  (the test bound is 15 = 2 × 7 + 1). The full snapshot gives the same answers from more than
  40,000 keys. The frontier's key count is 10 at 10, 100, 1,000 and 10,000 passes.
- Two existing assertions changed their expected message, not their verdict:
  - `policy.test.ts` "throws a CodecError …" and `shadow.test.ts` "a candidate CodecError …" use
    two rows of a node outside every loop. The frontier reads only that node's latest row (A@1),
    so the refusal is the gap below it ("none at iteration 0"), not "outside every loop";
  - the policy test also pins that the full snapshot still refuses with "outside every loop".

  Both still assert a `CodecError` and no fallback.

**What the frontier does not check (stated, not hidden).** Rows outside the frontier are not read.
A row set that the global decoder refuses only for a fault deep in a loop's history (a gap, or an
unsettled or cancelled row at a removed pass) can decode under the frontier. By the argument
above, engine v2 does not produce such a row set. The store contract is iterations contiguous per
node and statuses that only progress. `snapshot: 'full'` keeps the old, stricter check available.

**Mutation checks** (on `frontier.ts`, restored):

| mutation | `v2-frontier.test.ts` cases that fail |
|---|---:|
| drop pass L − 1, replay pass L as 1 | 2 (deep loops; the gap case) |
| `frontierKeys` omits pass L − 1 | 4 (deep loops, key counts, 10,000-pass answers, flat keys) |

**Results: 0 disagreements everywhere. No falsifier fires.**

| leg | configuration | compared | frontier smaller than S | disagreements |
|---|---|---:|---:|---:|
| (f) differential | 20 × 20 (83,600 runs) | 972,945 S + 537,950 (S, s) | 0 | 0 |
| (f) differential | 20 × 20 `--wait 0.2` | 1,096,310 S + 538,532 (S, s) | 0 | 0 |
| (f) differential | 20 × 20 `--max-passes 20` (legs a, a″, a‴, f) | 997,400 S + 548,061 (S, s) | 12,633 | 0 |
| (f) exhaustive | 4 passes, 1M cap, ≤ 14 nodes (196 graphs) | 123,142 S + 316,165 (S, s) | 15,016 | 0 |
| (f) exhaustive | 3 passes, 2M cap, ≤ 9 nodes, `--wait` (161 graphs) | 36,835 S + 59,644 (S, s) | 0 | 0 |
| (f) exhaustive | 7 passes, 1M cap, ≤ 9 nodes (161 graphs) | 35,578 S + 134,753 (S, s) | 118,234 | 0 |
| (d4) handler leg | sequential | 1,086,514 decide + 686,920 finished | – | 0 |
| (d4) handler leg | sequential `--wait 0.2` | 1,087,386 + 687,800 | – | 0 |
| (d4) handler leg | `--concurrency 8 --wait 0.2` | 1,100,712 + 701,154 | – | 0 |
| (d4) handler leg | `--concurrency 8 --p-fail 0.3 --wait 0.2` | 998,336 + 627,174 | – | 0 |
| (d4) handler leg | the same, `--p-cancel 0.3` | 931,817 + 579,431 | – | 0 |
| (d4) handler leg | sequential `--wait 0.2 --p-cancel 0.3` | 1,019,716 + 639,332 | – | 0 |
| (d4) handler leg | sequential `--wait 0.2 --max-items 40` | 1,097,246 + 690,818 | – | 0 |
| (d4) handler leg | `--concurrency 8 --p-fail 0.3 --wait 0.2 --p-cancel 0.3 --max-items 40` | 938,327 + 581,643 | – | 0 |

- **The key-scoped legs reran with 0 disagreements, and every count is the same as before.**
  - (a″) is 537,950 / 538,532 reached pairs in the differential, and 316,165 reached and 946,814
    overall in the exhaustive spike (59,644 and 161,061 with `--wait`).
  - (a‴) is 970,157 / 1,093,464 compared in the differential, and 46,204 (16,483) in the
    exhaustive spike.
  - The differential's legs (a), (b) and (c) are 0, and the exhaustive spike's `dis` is 0.
  - In the deep differential, (a), (a″) and (a‴) are also 0, at iterations up to 13.
- **Leg (d) reran under the frontier policy with 0 findings in every configuration.** The counts of
  step 8 and of the review fixes are reproduced exactly:
  - (d1): 1,086,514 / 0 and 686,920 / 0 sequentially, and 998,336 / 0, 626,841 / 0 and 333 (14)
    under stress;
  - the cancel race: 42 (26) and 107 (18);
  - n8n's policy ended 7 and 5 runs `failed` through `isFinished`, and ours 0;
  - (d2) and (d3) have 0 differences.
- The deep handler legs reach iteration 13. There the frontier asked at most 17 keys per call and
  the full snapshot 37. In the default legs (iterations up to 3) the numbers were 10 and 11. Every
  call made at most 2 reads.
- **Golden.** `v2-frontier.test.ts` checks local = global on every recorded state and every
  settlement's S and S′. `v2-planner-golden.test.ts` replays all 515 settlements through the
  frontier policy with 0 findings. `tests/fixtures/` is untouched and nothing was re-recorded.
  Golden loops end by pass 2, so on the golden the frontier is S itself: the compression is
  exercised by the deep runs above.

**Cost (offline CPU, in-memory reader).** `npx tsx tasks/v2-policy-cost.mts`, run with the machine
otherwise idle. Settlement of B@k, decide + isFinished, warm:

| k | rows | reads | keys: frontier / full | frontier p50 / p95 | full snapshot p50 / p95 | n8n default p50 / p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 2 | 1 / 1 | 0.05 / 0.06 ms | 0.05 / 0.07 ms | 0.01 / 0.02 ms |
| 100 | 202 | 2 | 3 / 199 | 0.11 / 0.19 ms | 1.34 / 3.69 ms | 0.05 / 0.14 ms |
| 1,000 | 2,002 | 2 | 3 / 1,999 | 0.51 / 0.76 ms | 12.54 / 13.36 ms | 0.64 / 0.86 ms |
| 10,000 | 20,002 | 2 | 3 / 19,999 | 5.38 / 6.54 ms | 129.58 / 134.78 ms | 5.00 / 5.52 ms |

- What still grows in the frontier column is the in-memory reader, which scans every row on each
  call. n8n's default grows the same way on the same reader.
- The decision on the frontier rows alone (`decideFromRows` + `finishedFromRows`, 200 reps) is
  flat: p50 54 µs at k = 1, 42 µs at k = 100 and 36 µs at k = 10,000.
- Over a run, the decode is now O(passes), not O(passes²).
- At k = 10,000 the frontier asks 3 keys (7 bind parameters) where the full snapshot asks 19,999
  (39,999 parameters).
- The corpus figures are unchanged within noise: warm decide + isFinished p50 108 µs, p95 323 µs.
  Agreement with n8n's default is 15,992 / 15,992 for both methods.
- None of this is F4, which is still measured live in steps 11 and 12.

**Stamp.** n8n 2.42.0 dist at `944afe5` with 0001–0004: `settlement.js 8b7fe1d317aa`,
`completion.js 3d3c53f9902c`, `loop-ledger.js affbe650919e`, `iteration-mapping.js b020437a1dc2`,
`loops.js 942db20c8af8`, `step-settled-handler.js 28762f9eafae`, `settlement-policy.js
d01a00e31a71`, `typeorm-step-store.js dd904794ec05`. libpetri 7.0.0 from the registry, not linked.
Node v26.8.1. Wall clocks, with up to 8 processes running side by side:
- differential: 310 s, 323 s and 217 s;
- exhaustive: 160 s, 126 s and 130 s;
- handler legs: 641 s to 1,254 s.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,054 tests in 105 files. That includes the 6 new frontier cases,
  `v1-identity` with `v1-fingerprint.json` untouched, and the golden replays with
  `tests/fixtures/` untouched.
- The three changed task scripts typecheck. `v2-policy-cost.mts` has four `TS2352` casts at lines
  190–203 from before this step; they are not touched here.
- `.n8n` is at the detached pin with 0001–0004 applied and no branches, and no file under it
  changed.

### Step 9: Postgres neutrality legs N2; F1 does not fire

These are unpatched baselines with a flake check, and neutrality legs for 0001–0004 with nothing
registered. They are not conformance numbers, not policy-entering cases and not settlement
evidence. No scheduler and no settlement policy is registered in any of these runs. The vitest
durations below are wall clocks of an integration suite, not results.

**Provider.** The user chose Docker (blocker 1). n8n's testcontainers code runs unmodified: each
integration file starts its own Postgres through `new PostgreSqlContainer(...)`, and ryuk reaps it.
Docker Desktop server 25.0.2, with 953,692,160 bytes (~0.95 GB) of VM memory and 10 CPUs.

**What was built.**
- `scripts/bootstrap-n8n.sh --scope=` and `scripts/run-conformance.sh --scope=` gained
  `engine-int` and `compat-int`. Both scripts carry the same table. Each scope runs the package's
  own `test:integration` script (`vitest.integration.config.ts`), and its build target is the same
  as the unit scope's. Three new columns: `SCOPE_SCRIPT` (default `test`), `SCOPE_ARGS` (vitest
  flags after the filters) and `SCOPE_PG`.
- New `scripts/pg-stamp.sh`, sourced by both scripts:
  - `pg_preflight` refuses to start when `docker info` does not answer, so a container failure
    is never reported as a test result;
  - `pg_images` reads the images the scope's `*.integration.test.ts` files pass to
    `PostgreSqlContainer`. A string literal is taken as written. `postgresVersions.<key>` is
    resolved through the package's own `n8n-containers/postgres-versions.json`. Any other
    argument fails the stamp;
  - `pg_watch_begin`/`pg_watch_end` stream Docker's container `start` events while the suite runs;
  - `pg_stamp` writes `<label>.pg-stamp.txt`. It holds the Docker server and its memory, the
    testcontainers version, and each image with its image id, repo digest and `postgres -V`. It
    also lists the containers Docker started during the run.
- `scripts/README.md` lists the scopes and `pg-stamp.sh`.

**Procedure.**
1. `verify-patch.sh --restore` reset the patch scope to the pin.
2. `bootstrap-n8n.sh --scope=X --skip-install` gave run 1, and `--skip-install --skip-build` gave
   run 2. Turbo restored every dist from cache: 10 / 10 for the engine and 30 / 30 for compat,
   with 0 misses. The unpatched engine dist's `step-settled-handler.js` has 0 occurrences of
   `settlementPolicy`.
3. `verify-patch.sh` re-applied 0001–0004.
4. `run-conformance.sh --skip-patch --engines=legacy --scope=X` ran. Its turbo builds were all
   cache hits, and the patched dist has 5 occurrences of `settlementPolicy`.
5. Each comparison was checked twice: per case with `conformance/cli.ts --require-identical`, and
   with an independent multiset of (file, classname, name, status).

**Results at 944afe5.**

| scope | files | cases | pass | todo (skipped) | fail | run 1 = run 2 | patched, nothing registered = baseline |
|---|---:|---:|---:|---:|---:|---|---|
| `engine-int` | 6 | 149 | 149 | 0 | 0 | identical | identical (exit 0) |
| `compat-int` | 1 | 18 | 16 | 2 | 0 | identical | identical (exit 0) |

- `engine-int` per file: `workflow-execution` 22, `workflow-step-execution` 56,
  `execution-start` 2, `step-execution` 10, `workflow-executions` (server) 58, and
  `start-engine-server` 1. `engine-int` has 146 distinct case keys among its 149 cases. The
  repeats are numbered by position, and every one passes in all three runs.
- Patched code is under test in both scopes. `engine-int` loads the engine from `src`.
  `execution-start`, `step-execution` and the server file (through `createEngineRuntime`)
  construct the handler with the patched default policy. `start-engine-server` takes its deps
  injected and does not reach the policy. The two database files test the stores. `compat-int`
  loads the engine from the patched dist through `acceptance-fixtures.ts`.
- **F1 does not fire.** No patch touches an integration test file. The only test files the
  patches touch are `settlement-policy.test.ts` (new) and `create-engine-runtime.test.ts`, which
  gets 4 added cases and no removed lines, as step 5 planned. Both are unit tests, and neither is in these scopes.
- No memory failure occurred with `--maxWorkers=1` at ~0.95 GB. The vitest durations were 11 s
  for `engine-int` and 5 s for `compat-int`. Peak memory was not measured.

**Postgres stamp.** The server version comes from `postgres -V` on the local image the run used.
The streamed events confirm which images started. The baselines and the legs match.

| scope | image as the test names it | server | image id | repo digest | containers started per run |
|---|---|---|---|---|---|
| `engine-int` | `postgres:18.4-alpine` (`postgresVersions.primary`) | PostgreSQL 18.4 | `db676a0ed906` | `sha256:9a8afca54e78…` | 5 Postgres + 1 ryuk |
| `compat-int` | `postgres:18-alpine` (literal) | PostgreSQL 18.6 | `d7a8005067f5` | `sha256:77f585114c32…` | 1 Postgres + 1 ryuk |

**Pulled images.** These were pulled ahead with `docker pull` on 2026-10-03:
- `postgres:18.4-alpine` (`sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`);
- `postgres:18-alpine` (`sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`);
- `testcontainers/ryuk:0.14.0` (`sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0`),
  the reaper image named in testcontainers 11.13.0's `reaper.js`.

**Deviations.**
- **No `scripts/testbed/pg.sh` and no generated testcontainers shim config in this step.** The plan
  listed both for a provider other than Docker: embedded-postgres, brew or `LIBPETRI_PG_URL`.
  Under Docker, testcontainers runs unmodified, so N2 needs neither. Step 11 still needs a
  database URL for `N8N_ENGINE_DATABASE_URL`, so `pg.sh` moves there.
- **`--maxWorkers=1`.** The integration scopes run one file at a time, so at most one Postgres
  runs at once on the 0.95 GB VM. n8n's own CI runs them with its default pool (`maxWorkers: '50%'`
  under `CI=true`). The flag applies to the baseline and the leg alike, so the comparison is like
  for like. It changes scheduling but not the case set. A file that only passes in parallel, or
  only fails in parallel, would not show up here.
- **compat-int is 18 cases, not 16.** 16 pass, and two are `it.todo` (`routes items through an If
  node and consolidates with Merge`, `stops cleanly on a cancel request mid-flight`), which junit
  reports as skipped. The plan's 16 counts the cases that run.
- **Two Postgres versions.** The engine's files pin `postgres:18.4-alpine` through
  `postgres-versions.json`. compat's file names the floating `postgres:18-alpine`, which resolved
  to 18.6 when it was pulled. A later pull can move compat's server, which is why the stamp records
  the image id. Baseline and leg used the same id.
- **The container count is streamed, not queried.** At first the stamp ran `docker events --since`
  after the suite. It reported 2 Postgres starts for a run that started 5. The daemon replays a
  bounded event buffer, and testcontainers' exec probes overflow it. The watcher now streams
  `start` events for the duration of the run. Stopping the watcher needs `pkill -P` on the
  `com.docker.cli` child: Docker Desktop's `docker` shim does not pass SIGTERM on, and a background
  job of a non-interactive shell ignores SIGINT. The first attempt hung on that. It was killed and
  rerun, and the numbers above come from the clean reruns.

**Stamp.** n8n `944afe5`, with `@n8n/engine` 0.22.0 and `@n8n/node-engine-compatibility` 0.10.0.
vitest 5.0.1, node v26.8.1, pnpm 12.4.2 through corepack 0.36.0, and testcontainers 11.13.0.
Artefacts are in `conformance-results/`:
- `baseline-{engine,compat}-int.{junit.xml,summary.txt,pg-stamp.txt,pg-events.txt}` (run 2);
- `.run1.*` and `.flake.matrix.md`;
- `legacy-{engine,compat}-int.{junit.xml,matrix.md,test.log,pg-stamp.txt,pg-events.txt}`;
- `run-{engine,compat}-int.log`.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,054 tests in 105 files. That includes `v1-identity` with
  `v1-fingerprint.json` untouched, and the golden replays with `tests/fixtures/` untouched and
  nothing re-recorded.
- `.n8n` is at the detached pin `944afe5` with 0001–0004 applied (13 paths) and no local branches.

### Step 10: the settlement leg; F5 does not fire, F7 fires on the engine's own test graphs

These results are of three kinds, and they are kept apart (decision 12):
- **Policy-entering cases passed:** the `primary` legs of `engine-int` and `compat-int`. In these
  cases the net-backed policy answered at least once.
- **Neutrality with the policy registered:** the `primary` legs of `engine`, `compat` and `cli-v2`.
  No case there settles a step through a runtime that `createEngineRuntime` builds. Their pass
  counts are n8n's code and are not a policy result.
- **Settlement evidence:** the shadow verdicts and the experiment below. These are not conformance
  numbers.

None of them is an engine v1 conformance number or a testbed result. Vitest durations are not
results either.

**What was built.**
- `typescript/src/n8n-v2-vitest-setup.ts` is a tsup entry and package export,
  `n8n-v2-vitest-setup`. `createSettlementVitestSession()`:
  - registers through `register.ts` only when `N8N_SETTLEMENT_POLICY=libpetri`;
  - takes the mode from `N8N_SETTLEMENT_MODE`;
  - counts the policy's `entered`, `race` and `error` diagnostics, and the shadow verdicts, for
    each case window and for each file outside its cases;
  - appends JSONL records to `N8N_SETTLEMENT_LEDGER`: one per case, one per file (registered or
    not, and why), one per error, and one per shadow report that is not an agreement.
- `typescript/src/conformance/v2/entered.ts` and `entered-cli.ts` join the leg's junit with the
  ledger. The pairing is `caseKeys`', with repeats numbered by position. The output is
  `<label>.entered.md`:
  - the headline is policy-entering cases passed;
  - a case that never entered is labelled and listed, not counted;
  - unrecorded cases (skipped or todo) and orphan records are listed;
  - with `--expect-entering`, a leg with 0 policy calls exits 1. That is F5.
  - In `shadow` mode the headline says that n8n's default answered.
- `scripts/run-conformance.sh`:
  - On the five v2 scopes, `--engines=libpetri` is the settlement leg. It was "not applicable"
    before.
  - A `settlement_table` holds the shim's import seam (`src` or `package`), whether the scope must
    enter (`engine-int`, `compat-int`), and the base config. `bootstrap-n8n.sh`'s scope table is
    unchanged.
  - The generated shim is `<pkg>/.n8n-libpetri-v2-setup.mjs` with
    `<pkg>/vitest.libpetri-v2.config.mts`. Both are listed in `.n8n/.git/info/exclude`.
  - New flag `--settlement-mode=`.
  - Labels are `libpetri-<scope>`, or `libpetri-<scope>-<mode>` for a mode other than `primary`.
- Tests: `tests/settlement/vitest-session.test.ts`, 15 cases.

**Deviations.**
- **The leg does not run the package script as is.** Vitest 5 refuses a second `--config`
  (`cac` throws), and the `test:integration` scripts already pass one. The leg therefore runs the
  script's own command line with its `--config` replaced, or appended when the script has none,
  through `pnpm --filter <pkg> exec sh -c`. The env prefixes of the cli script are kept. The case
  sets equal the baselines' (0 missing, 0 new beyond 0003/0004's 25 in `engine`).
- **The shim hooks take no positional suite.** Vitest 5 passes hooks a fixture context, which must
  be destructured (`FixtureParseError` on `(suite) =>`). The file name is
  `expect.getState().testPath` relative to the package root. Cases use `({ task })`.
- **The shadow modes were run too, which the plan did not ask for here.** `primary-shadowed` ran
  on `compat-int` and `shadow` on `engine-int`. They give live F2 evidence on Postgres one step
  before the testbed. Each leg ran once; there is no flake rerun.

**Results at 944afe5, Docker Postgres, `--maxWorkers=1`.** The Postgres image ids equal step 9's
baselines: `db676a0ed906` (18.4) for `engine-int` and `d7a8005067f5` (18.6) for `compat-int`.

| scope | seam | files registered | cases | policy-entering (passed / total) | not entering | policy calls | errors | against baseline |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `engine` | `src` | 28 / 28 | 401 | 0 / 0 | 401 (all pass) | 0 | 0 | 0 regressions |
| `engine-int` | `src` | 6 / 6 | 149 | **1 / 10** | 139 (all pass) | 11 | 9 | **9 regressions** |
| `compat` | `dist` | 8 / 8 | 169 | 0 / 0 | 169 (all pass) | 0 | 0 | 0 regressions |
| `compat-int` | `dist` | 1 / 1 | 18 | **16 / 16** | 0 (2 `it.todo` unrecorded) | 92 | 0 | 0 regressions |
| `cli-v2` | `dist` | 21 / 22 | 365 | 0 / 0 | 365 (all pass) | 0 | 0 | 0 regressions |

- **F5 does not fire.** Both seams enter.
  - `src`: in `engine-int`, `step-execution` entered in 9 cases and `workflow-executions` in 1
    (the trigger-only `includeSteps` case).
  - `dist`: in `compat-int`, all 16 running cases entered, with 92 calls.
- **Why the three other scopes do not enter.**
  - `engine`: the only unit test that builds a runtime is `create-engine-runtime.test.ts`, and it
    settles no step.
  - `compat`: the unit tests build no runtime.
  - `cli-v2`: `engine-v2.runtime.test.ts` replaces `@n8n/engine` with `vi.mock`. The shim
    records it as not registered, with vitest's reason ("No `setSettlementPolicy` export is
    defined on the mock"). That is the 22nd file.
- **0004's own cases still pass with a policy registered.**
  `create-engine-runtime.test.ts`'s "default policy while none is registered" builds a fresh
  module graph (`vi.resetModules`), so it does not see the shim's registration.

**Shadow verdicts (settlement evidence, live on Postgres).**
- `compat-int`, `primary-shadowed` (ours answers, n8n's default is compared): agree 92,
  disagree 0, race 0, candidate threw 0. 16 / 16 policy-entering cases pass.
- `engine-int`, `shadow` (n8n answers): agree 2, disagree 0, race 0, candidate threw 32. All 32
  throws are the compile refusal below. 149 / 149 cases pass, but that count is n8n's.

**F7 fires.** All 9 `engine-int` regressions are in
`execution/__tests__/step-execution.integration.test.ts`. Each has a `settlement policy error`:
`SettlementCompileRefusal: … graphToDescription: v1 node 'A' has no v1 node config (nodeType,
typeVersion, parameters, continueOnFail)`. There are 5 distinct graphs, among them
`b749d8149fa2`, `7ef5e3d79aac`, `af98923ad5e4`, `1a061ad289ce` and `800dc8a5475d` (the If/Merge
diamond).
- The engine's own test graphs build nodes as `{ id, name, type: 'v1-node' }` with no `config`.
  The engine accepts them: `GraphNode.config` is optional, and "the engine persists it with the
  graph without inspecting it" (`graph/workflow-graph.ts`). The same cases pass under n8n's
  default.
- `graphToDescription` (`src/n8n/v2-graph.ts`) refuses them on purpose: it mirrors
  `isV1NodeStepConfig` because the converter always writes that config.
- So the policy throws at the trigger's settlement, as decision 8 says it must. The execution stays
  `running`, and each case times out at 5 s.
- This is a compile refusal at run time on a graph n8n accepted. Step 10 stops here under the stop
  rule. Nothing was fixed and no divergence row was added.

**Experiment, not landed: configless v1 nodes as opaque steps.** `graphToDescription` was patched
temporarily, behind an env flag, to describe a `v1-node` without config as an opaque node of a
synthetic type (`experiment.opaqueV1`, typeVersion 1, port counts from edges). It was rebuilt and
`step-execution` was run in `primary-shadowed`:
- 10 / 10 cases pass, and 9 / 9 policy-entering cases pass;
- 30 policy calls, agree 30, disagree 0, errors 0.

The patch was then reverted: `src/n8n/v2-graph.ts` has no diff from HEAD, and `dist` was rebuilt.
Artefacts are `conformance-results/experiment-opaque-v1-step-execution.*`.

**Open question for the orchestrator or the user: fix, or divergence row?**
- (a) **Fix.** Accept a `v1-node` without config as an opaque step, which is the engine's
  contract rather than the converter's.
  - Measured above on the one file that has such graphs.
  - Open point: the engineV2 analysis gives `n8n-nodes-base.merge` its own handling
    (`analysis/engine-v2/nodes.ts:50`). A configless node is never a Merge to the engine either,
    but whether a configless fan-in node matches the engine everywhere is shown only for the
    graphs in that file.
- (b) **Divergence row.** Keep the refusal and record it: the net-backed policy refuses a
  `v1-node` the converter cannot have produced, and the execution stays `running`. In
  production every graph reaches the engine through `V1WorkflowConverter`, which always writes
  the config.

Either choice changes F7's reading: "209 of 209 compile" then stands for converter-produced graphs.

**Stamp.** n8n `944afe5` with 0001–0004, `@n8n/engine` 0.22.0, `@n8n/node-engine-compatibility`
0.10.0, vitest 5.0.1 (n8n) and 4.1.11 (ours), node v26.8.1, pnpm 12.4.2, testcontainers 11.13.0,
and libpetri 7.0.0 from the registry, not linked. Artefacts are in `conformance-results/`:
`libpetri-{engine,engine-int,compat,compat-int,cli-v2}.{junit.xml,matrix.md,ledger.jsonl,entered.md,test.log}`,
the `pg-stamp` and `pg-events` files for the `-int` legs, `libpetri-compat-int-primary-shadowed.*`,
`libpetri-engine-int-shadow.*` and `experiment-opaque-v1-step-execution.*`.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,069 tests in 106 files: step 9's 2,054 plus 15. That includes `v1-identity`
  with `v1-fingerprint.json` untouched, and the golden replays with `tests/fixtures/` untouched
  and nothing re-recorded.
- `verify-patch.sh` applies 0001–0004 (13 paths). `.n8n` is at the detached pin with no local
  branches. The generated shims are excluded files.
- Nothing was committed or pushed.

### Step 10, rerun under "F7 at step 10": every regression fixed; F5 and F7 do not fire

These results are of three kinds, kept apart as in the blocked run above (decision 12):
- **Policy-entering cases passed:** the `primary` legs of `engine-int` and `compat-int`.
- **Neutrality with the policy registered:** the `primary` legs of `engine`, `compat` and `cli-v2`.
  No case there settles a step through a runtime that `createEngineRuntime` builds, so their pass
  counts are n8n's code and not a policy result.
- **Settlement evidence:** the shadow verdicts, the golden replay and the differential.

None of them is an engine v1 conformance number, a neutrality leg in step 9's sense or a testbed
result. Vitest durations and the differential's wall clock are not results.

**The fix (the orchestrator's decision above).** `graphToDescription` (`src/n8n/v2-graph.ts`)
describes a `v1-node` whose `config` is absent (`undefined`) as an opaque step:
- its type is `V2_OPAQUE_V1_NODE_TYPE = '@n8n/engine.v1-node'` at typeVersion 1. The
  `@n8n/engine.` prefix is the one `V2_STEP_NODE_TYPES` uses for `wait` and `subworkflow`, so no
  n8n node type collides. In particular it is never the Merge type or Split In Batches;
- its port counts come from its edges, as every other node's do;
- it gets no `onError`. `continueOnFail` is read by the v1 executor from the config, not by the
  engine, and the engine records a step that throws as `failed`.

The experiment's synthetic type was `experiment.opaqueV1`. Only the name changed.

**Deviation: narrower than "without config" might be read.** Only an absent config is opaque. A
config that is present but is not a `V1NodeStepConfig` (`{}`, `null`, a config without
`continueOnFail`) is still refused with a `V2GraphError`. Neither the converter nor the engine's
own tests write such a config, and a partial one may name a node type that the description would
then silently drop. Tests pin both.

**Tests (18 new, 1 refusal case replaced).**
- `tests/conformance/v2/graph.test.ts`:
  - The engine's own graphs from `step-execution.integration.test.ts` (single node, fan-in,
    conditional diamond), with configless trigger and v1 nodes: their type, ports, no
    `onError`/`batch`, and that each analyses under `engineV2`.
  - A configless fan-in node is not refused as a chooseBranch Merge.
  - A configless node sits beside configured nodes and a batch loop.
  - No converter-shaped graph gets the opaque type.
  - The "a v1 node with no config" refusal became "an empty config" and "a null config".
- `tests/settlement/policy.test.ts`:
  - Every golden graph (n8n's converter output) carries config on every v1 node.
  - On every golden state, the policy gives the same answers (`decideSuccessors` per decider and
    `isFinished`) with every v1 node's config removed. That covers the golden's loops and its
    failed and cancelled states.
  - The reference-loop check runs again on configless copies of the six loop-free settlement
    shapes. The check was extracted into `inReferenceLoop` with its body unchanged.

**Converter-produced graphs are unchanged.** The round-trip tests are unedited and green. The
golden replays are green with `tests/fixtures/` untouched. The differential 20 × 20 reran with
every count equal to step 14's: corpus 209 / 209 compiled; (a) 972,945 states; (a″) 537,950
reached (S, s); (a‴) 970,157 compared; (f) 972,945 S and 537,950 (S, s); 0 disagreements and 0
findings in every leg. The m1 acceptance (`compat-int`, below) is 16 / 16 as before. The
exhaustive spike was not rerun: its graphs are converter output, which this branch never reaches.

**Results at 944afe5, Docker Postgres, `--maxWorkers=1`.** The Postgres image ids equal step 9's
baselines: `db676a0ed906` (18.4) for `engine-int` and `d7a8005067f5` (18.6) for `compat-int`.

| scope | seam | files registered | cases | policy-entering (passed / total) | not entering | policy calls | errors | against baseline |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `engine` | `src` | 28 / 28 | 401 | 0 / 0 | 401 (all pass) | 0 | 0 | 0 regressions |
| `engine-int` | `src` | 6 / 6 | 149 | **10 / 10** | 139 (all pass) | 34 | 0 | 0 regressions |
| `compat` | `dist` | 8 / 8 | 169 | 0 / 0 | 169 (all pass) | 0 | 0 | 0 regressions |
| `compat-int` | `dist` | 1 / 1 | 18 | **16 / 16** | 0 (2 `it.todo` unrecorded) | 92 | 0 | 0 regressions |
| `cli-v2` | `dist` | 21 / 22 | 365 | 0 / 0 | 365 (all pass) | 0 | 0 | 0 regressions |

- **Per-case junit.** `engine-int`, `compat-int`, `compat` and `cli-v2` are identical to their
  unpatched baselines. `engine` is identical to the patched `legacy-engine` leg; against the
  baseline it has 0003/0004's 25 own cases beyond it.
- **Flake check.** The two `-int` primary legs ran twice. Junit is identical per case and the
  ledgers are identical apart from timestamps. `engine`, `compat` and `cli-v2` ran once. Their
  junit equals the blocked run's per case, and no case there reaches `graphToDescription`.
- **F5 does not fire.** `src`: in `engine-int`, the 9 `step-execution` cases plus the 1
  `workflow-executions` case enter (24 `decideSuccessors` and 10 `isFinished` calls). `dist`: all
  16 running `compat-int` cases enter. The three other scopes do not enter, for the reasons the
  blocked run lists (`cli-v2`'s 22nd file mocks `@n8n/engine` and is recorded as not registered).
- **F7 does not fire.** There are 0 policy errors in every leg, and so no compile refusal at run
  time. "209 of 209 compile" is about converter-produced graphs. The engine's own configless test
  graphs (5 distinct) now compile as well.
- **Triage.** The blocked run's 9 `engine-int` regressions are fixed by the change above. Nothing
  regressed, so no divergence row was added.

**Shadow verdicts (settlement evidence, live on Postgres).**

| leg | who answers | compared | agree | disagree | race | candidate threw | cases |
|---|---|---:|---:|---:|---:|---:|---|
| `engine-int` `primary-shadowed` | ours | 32 | 32 | 0 | 0 | 0 | 10 / 10 policy-entering pass |
| `engine-int` `shadow` | n8n's default | 32 | 32 | 0 | 0 | 0 | 149 / 149 pass (n8n's count) |
| `compat-int` `primary-shadowed` | ours | 92 | 92 | 0 | 0 | 0 | 16 / 16 policy-entering pass |

Each shadow leg ran once. In the blocked run, `engine-int` `shadow` had 32 candidate throws;
here it has 0. These figures predate the snapshot reuse (step 12's rerun). The as-built policy's
shadow legs are in "Review after step 13".

**Why `engine-int` has 34 calls under `primary` and 32 in both shadowed modes.** The difference
is entirely in "settles a conditional diamond": 6 `decideSuccessors` + 3 `isFinished` under
`primary` (both runs), and 5 + 2 shadowed. `StepSettledHandler.handle` returns before the policy
when the execution is no longer live (`step-settled-handler.ts:65`). C's skip settlement races M's
execution, since M's inputs are all decided once C's skipped row exists. When M's settlement
completes the execution first, C's settlement asks nothing. The shadow wrapper does more work per
call and moves that interleaving. Both orders end `completed` with the same rows, and the case
asserts them. This reading comes from the handler's source and the ledgers. It was not
instrumented further. The count of calls is not a policy result.

**Deviation: the stamp's container capture missed one run.** In `engine-int` `primary` run 1 (and
in the blocked run's `engine-int` `primary`), `pg-events` captured no container start, although
the suite passed its Postgres cases. Run 2 captured 5 × `postgres:18.4-alpine` plus ryuk. An
independent `docker events` watcher started 2 s earlier saw the same 5 starts plus ryuk (and the
stamp's own `postgres -V` container afterwards). The likely cause is that `pg_watch_begin`'s
1-second subscription wait was not enough right after the turbo build. It was not fixed. The
stamp's image id is read separately and is unaffected. The top-level `libpetri-engine-int.*`
artefacts are run 2.

**Artefacts** (`conformance-results/`, gitignored):
- `libpetri-{engine,engine-int,compat,compat-int,cli-v2}.*` (the `-int` ones are run 2);
- `libpetri-engine-int-{primary-shadowed,shadow}.*` and `libpetri-compat-int-primary-shadowed.*`;
- `step10-run1/` (run 1 of every primary leg);
- `step10-f7-blocked/` (the blocked run's artefacts, copied before they were overwritten).

**Stamp.** As in the blocked run: n8n `944afe5` with 0001–0004, `@n8n/engine` 0.22.0,
`@n8n/node-engine-compatibility` 0.10.0, vitest 5.0.1 (n8n) and 4.1.11 (ours), testcontainers
11.13.0, and libpetri 7.0.0 from the registry, not linked.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,087 tests in 106 files: the blocked run's 2,069 plus 18. That includes
  `v1-identity` with `v1-fingerprint.json` untouched, and the golden replays with
  `tests/fixtures/` untouched and nothing re-recorded.
- `verify-patch.sh` applies 0001–0004. `.n8n` is at the detached pin with no local branches, and
  the generated shims are excluded files.
- Nothing was committed or pushed.

### Step 11: the testbed boots engine v2 with the policy; registered, then entered

These are integration results from the live testbed. They are not conformance numbers, not
policy-entering case counts, not neutrality legs and not settlement evidence (decision 12). The
wall clocks below are what `run.mjs` printed for one run each; they are not results, and step 12
owns the comparison of legs and the latency record.

**What was built.**
- `scripts/testbed/pg.sh` (`start`, `stop`, `url`, `status`, `stamp`). It runs a Docker container
  `n8n-libpetri-testbed-pg` from `postgres:18.4-alpine` (`postgresVersions.primary`, the image
  `engine-int` uses) on 127.0.0.1:55432, capped at 384 MB, with an anonymous volume that `stop`
  removes. `LIBPETRI_PG_URL` replaces it, and then no container is managed. `start` waits for a
  query over TCP, not just `pg_isready`, because the image's init-time server answers on the
  socket only.
- `n8n-testbed.sh --v2 --settlement=off|shadow|primary|primary-shadowed --pg-port=N`:
  - It sets `N8N_ENABLED_MODULES=engine-v2`, `N8N_ENGINE_MODE=in-process` and
    `N8N_ENGINE_DATABASE_URL` from `pg.sh`. The engine's servers bind 127.0.0.1 on `--port + 3`
    and `--port + 4` (5681, 5682) instead of 3000/3001, and both ports are preflighted.
  - It rebuilds `packages/@n8n/engine/dist` with the package's own
    `tsc -p tsconfig.build.json` when a non-test source is newer than the last build's marker
    (`dist/.n8n-libpetri-built`, in the gitignored dist), and then requires `setSettlementPolicy`
    in the built index.
  - The gate: after the REST API is up, the log must hold `settlement policy registered: mode=…`
    (or `settlement policy off` for `off`) and `Engine v2 listening on …`, or the launcher stops.
  - The state is `.testbed/v2/`, which has its own sqlite home, logs, `ids.json`, `settlement.jsonl`
    (every policy diagnostic and shadow report) and `pg-stamp.txt`. `--stop` stops both testbeds
    and removes the managed Postgres.
  - `--v2 --queue` and `--settlement` without `--v2` are refused (exit 2).
- `preload.mjs` has a second, independent branch, gated on `N8N_LIBPETRI_SETTLEMENT`:
  - It resolves `@n8n/engine` through `createRequire(packages/cli/package.json)`.
  - It throws, so n8n does not start, when the module lacks `setSettlementPolicy`,
    `getSettlementPolicy`, `resetSettlementPolicy` or `defaultSettlementPolicy`, in every mode,
    `off` included. It also throws when `N8N_ENABLED_MODULES` does not name `engine-v2`, and on an
    unknown mode.
  - Otherwise it calls `registerSettlementPolicy` (`register.ts`). stderr gets `registered`, the
    first `entered` per execution, every `race` and `error`, and every shadow report that is not an
    agreement. An agreeing shadow report is written to the ledger without its rows.
- `seed.mjs`, under `TESTBED_ENGINE_V2=1`, sets `settings.engineType: "v2"` on every workflow it
  seeds and seeds only those engine v2 can start. Each is put through n8n's
  `V1WorkflowConverter` and the engine's `validateExecutableGraph`, both from `packages/cli`'s
  resolution root, and a refusal is skipped with its reason in `ids.json`. Each workflow is read
  back after the write.
- `scripts/testbed/workflows-v2/`: `v2-loop-over-items.json` (Loop Over Items, 1,000 items, batch
  size 1), `v2-if-switch-diamond.json` (If, a Switch on the true branch, a three-input Merge in
  append mode) and `v2-stop-and-error-sibling.json` (Stop and Error beside a four-node sibling
  chain that the stub's `/slow?ms=1500` holds).
- Docs: `docs/testbed.md` gains "Engine v2: the settlement policy in the live server", and
  `scripts/testbed/README.md` lists `pg.sh`, `--v2` and the state.

**The REST path accepts `engineType`.** `workflowSettingsSchema` (`base-workflow.dto.ts`) is
`z.object({customTelemetryTags}).passthrough()`, and `POST /rest/workflows` stored
`settings.engineType: "v2"` for all 10 seeded workflows. The read-back after each write confirmed
it. `EngineV2Dispatcher.handlesWorkflow` routes on that field for `manual`, `webhook` and
`trigger`, and every run below went to the data plane: each execution id is a UUID v7.

**The main database.** sqlite, the testbed's default, is enough. Nothing in `modules/engine-v2`,
the dispatcher or the v2 execution reader checks the main database's type. The module refuses
queue mode only (`engine-v2.module.ts:31`). Only the data plane needs Postgres
(`EngineV2Runtime.initDb`).

**Done when: met.** `--settlement=primary` booted and the gate passed on
`settlement policy registered: mode=primary`. The first run, `V2 If Switch Diamond`, logged
`settlement policy entered: method=decideSuccessors, execution=01a0ff7e-7810-…`. So F5 does not
fire in the testbed. The gate passed the same way under `shadow` and under `off`
(`settlement policy off: patch 0004 is in @n8n/engine, nothing registered`). After the
workflows moved (below), a fresh `primary` boot and the diamond were rerun, with the same result.

**One run per workflow, an integration smoke, not a comparison.** Docker 25.0.2, VM 953,692,160
bytes. Postgres 18.4, image id `db676a0ed906` (the same as `engine-int`'s), from
`.testbed/v2/pg-stamp.txt`. Policy calls are from the ledger.

| workflow | mode | status | `decideSuccessors` | `isFinished` | what ended it |
|---|---|---|---:|---:|---|
| V2 If Switch Diamond | primary | success | 9 | 3 | Merge got 6 items: Small 2, Large 1, Odd 3 |
| V2 Loop Over Items | primary | success | 2,005 | 1 | 1,001 batch passes, 1,000 Process Item, Done got 1,000 items |
| V2 Stop And Error Sibling | primary | error | 1 | 0 | Stop and Error |
| Concurrency Showcase | primary | error | 5 | 1 | "Task runners (Code node) is not supported on Engine v2 yet" |
| Agent · Two Tools, · Nested Agents, · Tool Deadline | primary | error | 1 each | 0 | "A Chat Model sub-node must be connected and enabled" |
| Failure Policy Showcase | primary | error | 1 | 0 | 503 at Flaky Service (engine v2 does not read `executionPolicy`) |
| Parent Waits On Child | primary | error | 1 | 0 | "Sub-workflows (executeWorkflow) is not supported on Engine v2 yet" |
| V2 If Switch Diamond, V2 Stop And Error Sibling, Concurrency Showcase | shadow | as under primary | 15 | 4 | shadow: 19 agree, 0 disagree, 0 race, 0 candidate threw |
| V2 If Switch Diamond | off | success | 0 | 0 | as under primary |

- 0 `settlement policy error` and 0 `race` in every leg. So F7 does not fire on the seeded
  workflows, and no execution stayed `running`.
- F3's second half (an execution that stays `running` under `primary` where `off` completes)
  needs the `off` leg of every workflow, which is step 12. Here `off` ran only the diamond.
- F4 is not measured here. The loop ran once under `primary`, with no reader-call counts and no
  latency. Step 12 owns both.

**Deviations.**
- **"Converter-accepted" became "engine v2 can start it".** OR Round Overflow passes
  `V1WorkflowConverter` but is refused at `StartExecutionService.start` by
  `validateExecutableGraph` ("more than one edge into input slot 0"). `createEngineRuntime` builds
  the service without a 4th argument, so that default applies. Our `compileGraph` refuses the same
  graph. Seeding it would add a workflow every run refuses before its first settlement, so the seed
  applies both checks. This is not F7: n8n does not accept the graph either.
- **Workflows that engine v2 cannot run are still seeded.** Concurrency Showcase, the three
  agents, Parent Waits On Child and Failure Policy Showcase pass both checks and then fail at a
  node, because engine v2 refuses that node (Code, AI sub-nodes, Execute Workflow) or does not read
  `executionPolicy`. These are failure paths through the settlement handler, and that is worth
  keeping for step 12's `off`/`primary` comparison. Nothing was skipped on the basis of a node
  type.
- **No Code nodes in the new workflows.** The first versions generated items in a Code node, and
  the first diamond run failed at it with the task-runner refusal. The items now come from a Set
  expression (`Array.from(...)`) and Split Out, and the sibling's delay is an HTTP Request to the
  stub's `/slow`.
- **The new workflows live in `scripts/testbed/workflows-v2/`, not `workflows/`.**
  `tests/compiler/v1-identity.test.ts` fingerprints every file in `workflows/` under the v1
  profile. With the three files there, the suite failed 4 cases ("has no recorded fingerprint").
  Moving them keeps `v1-fingerprint.json` untouched.
- **The v2 preload branch runs on the main thread only.** The first boot logged
  `settlement policy registered` twice in one pid, 4 s apart: the second came after "Editor is
  now accessible". `--import` also runs in worker threads, which inherit `execArgv`, and each
  thread has its own module graph. There, the registration landed on a second `@n8n/engine`
  instance that no runtime reads. With an `isMainThread` guard it is logged once. That the second
  line came from a worker thread is inferred from the same pid and the fix's effect; the thread
  was not identified. The v1 branch was left as it is.
- **`--engine` defaults to `legacy` under `--v2`.** `V1StepExecutor` calls `nodeType.execute`
  directly and never builds a `WorkflowExecute`, so a v1 scheduler reaches only executions that
  still run on v1 (a sub-workflow). `--engine=libpetri` gives both.
- **The Postgres outlives a foreground run.** The cleanup trap stops n8n and the stub only.
  `--stop` or the next `--fresh` removes the container.

**Not done here.** No test under `typescript/` covers the scripts. They are `.mjs`/`.sh`, outside
`npm run check`. The preload's refusals were checked by hand: with a stand-in `@n8n/engine`
without `setSettlementPolicy`, with `N8N_ENABLED_MODULES=foo`, and with mode `bogus`, it throws,
and with no variables set it is inert. The launcher's flag refusals were checked the same way.

**`.n8n` state.** The engine dist was rebuilt twice by the launcher. All 90 `engine/dist/**/*.js`
files have the same sha256 before and after, including `step-settled-handler.js` at
`28762f9e…` (`GOLDEN_SEAM_PATCHED_DIST`). `verify-patch.sh` applies 0001–0004 (13 paths). `.n8n` is
at the detached pin with no local branches. The only file the testbed adds there is the dist
marker.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,087 tests in 106 files, the same count as step 10's rerun. That includes
  `v1-identity` with `v1-fingerprint.json` untouched, and the golden replays with
  `tests/fixtures/` untouched and nothing re-recorded.
- Nothing was committed or pushed.

### Step 12: `diff-engines-v2.sh`; F4 fires on its round-trip clause

These are integration results from the live testbed (decision 12). They are not conformance
numbers, not policy-entering case counts, not neutrality legs and not settlement evidence. No wall
clock here is a result. The write-up for readers is `docs/testbed.md`, "The four settlement modes
compared". The full report is `.testbed/v2-diff/report.md` (gitignored).

**What was built.**
- `scripts/testbed/diff-engines-v2.sh`: the legs `off`, `primary`, `shadow` and
  `primary-shadowed`. Each leg is its own server with a fresh sqlite file and a fresh Postgres. It
  runs every seeded workflow except Waiting Child (`--repeat`, default 1) and the Loop Over Items
  (`--loop-repeat`, default 3). It dumps the rows over SQL, stops the server, keeps the ledger and
  log, then runs the comparator.
- `scripts/testbed/dump-v2.mjs`: executions and step rows from the data plane, using the engine's
  own `pg`. Filled slots use the store's `FILLED_OUTPUT_SLOTS` expression.
- `typescript/tests/testbed/compare-v2.ts`: the comparator. `compare-v2.test.ts` pins it with 12
  cases on synthetic legs.
- `preload.mjs`: the timing instrument under `N8N_LIBPETRI_SETTLEMENT_TIMING=1`, and a buffered
  ledger. `n8n-testbed.sh`: `--timing` (refused without `--v2`, and the boot gates on
  `settlement timing installed`). Both READMEs and `docs/testbed.md` were updated.

**Deviations.**
- **An instrument the plan did not name.** "Per-leg latency" needs the handler's time and the
  policy's reads per settlement, and the plan named no way to get them. The preload therefore wraps,
  on the engine instance the runtime uses:
  - `StepSettledHandler.prototype.handle` and `announceEnd`, with an `AsyncLocalStorage` context
    per event;
  - every method of `TypeOrmStepStore` and `TypeOrmExecutionStore`;
  - the two methods of the policy the runtime holds.

  It is the same in every leg. In `off` it wraps `defaultSettlementPolicy` in place, so the registry
  stays empty, but n8n's object is wrapped in that leg. The instrument changes no answer and no call
  order, and its own cost was not measured.
- **The ledger is buffered** (flushed every 200 ms and at exit). In step 11 it appended
  synchronously per record, and `entered` is emitted inside every policy call. That write would
  have been timed in every leg except `off`.
- **`lastStep` is captured, not received.** Manual runs carry `responseExpectation.kind` `none`, so
  no `ended` response is sent. The instrument records the `step` that `announceEnd` would report.
- **"Policy calls ≥ settled non-failed rows" was made exact.** Every settlement of a completed or
  skipped row without a `decideSuccessors` call must have a named reason: the execution had already
  ended, or the handler's first `hasFailedSteps` returned true. Anything else is a finding. In every
  leg, calls equalled rows (6,055 = 6,055) and no reason was needed. The step-10 race (a settlement
  arriving after the execution completed) did not occur here.
- **F4's terms, fixed before reading the numbers.** A round trip is a reader call that reaches SQL.
  The empty-argument calls return in the store without a query, so they are not counted. Round
  trips are summed over all policy calls in one settlement, which is the reading step 6 left to the
  live measurement. "n8n's handler p95" is the p95 of `StepSettledHandler.handle` under `off`. Two
  stricter readings are reported and do not decide F4: policy against policy, and handler against
  handler.
- The shadow legs ran without a flake rerun, and every leg ran once (with repeats inside it).

**Results** (`postgres:18.4-alpine`, image id `db676a0ed906` in all four legs, 384 MB cap, Docker
VM 953,692,160 bytes, no memory failure; 19 executions per leg):
- All 19 executions in each of the three other legs equal the `off` leg's first run of their
  workflow on status, row count, fate multiset, filled slots, normalised outputs and `lastStep`.
  The `off` repeats are equal to each other.
- **F3 does not fire.** No execution ended `running` in any leg. Every workflow that completes
  under `off` completes under `primary`, and every one that fails, fails with the same `lastStep`.
- **F2: 0 shadow disagreements.** `shadow` had 6,066 agree; `primary-shadowed` had 6,066 agree.
  Both had 0 disagree, 0 race, 0 candidate threw and 0 skew. No named race occurred, so 0 were
  excluded.
- **F5, F6 and F7 do not fire.** `entered` is 6,066 in each registered leg, with 0
  `settlement policy error` and so 0 `CodecError` and 0 compile refusals.

**F4 fires.** The numbers are over the Loop Over Items, 3 runs and 6,015 settlements per leg:
- **Round trips: 4 in one settlement (limit 3).** It happened once per `primary` run, at Done@0's
  settlement. `decideSuccessors` made 2 round trips: the latest rows, then the frontier keys, which
  are non-empty because the loop is past pass 3. It queued nothing, so the handler called
  `isFinished`, which made 2 more. n8n's default made 3 on the same settlement: `decideSuccessors` 1,
  then `isFinished` 2 (`loadLatestStepSummaries` of the batch node, then `countSettledSteps`).
  Every other `primary` settlement made 2 (5,997) or 1 (15), and no single call made more than 2.
- **Latency: holds.** The policy's p95 per settlement under `primary` is 6.43 ms. n8n's handler p95
  under `off` is 14.2 ms. The ratio is 0.45, against a limit of 2.
- **Stricter readings, which do not decide F4:**
  - Policy p95 against n8n's default policy p95 is 6.43 / 3.04 = **2.11**. It would fire under
    that reading.
  - Handler p95 under `primary` against under `off` is 24.8 / 14.2 = 1.75.

**Why step 14 does not address it.** The plan names step 14 as F4's remedy, and step 14 is already
in this build (`snapshot: 'frontier'` is the default). The frontier bounds reads *per call* at 2
and keeps the decoded rows independent of the passes. The fourth round trip comes from two calls
in one settlement, each reading the snapshot again, because the reader port is a pass-through with
no cache (decision 2).

**A second finding: our policy's time grows with the passes, and n8n's does not.** The policy's p50
per settlement under `primary`, by quarter of the loop (passes 0–249, 250–499, 500–749, 750–999),
is 2.75, 3.54, 4.51 and 5.41 ms. Under `off`, n8n's default is 1.65, 1.68, 1.68 and 1.63 ms. The
handler p50 follows: 9.0 → 11.9 ms under `primary`, flat at about 7.6 ms under `off`. The cause is
SQL, not the decode:
- The snapshot's first read is `loadLatestStepSummaries(every node id of the graph)`. Its
  `DISTINCT ON (node_id) … ORDER BY node_id, iteration DESC` reads and sorts every row of those
  nodes, computing the filled-slots subquery per row.
- `EXPLAIN ANALYZE` on synthetic rows shaped like this loop, in the same image: 504 rows sorted,
  1.4 ms at pass 250; 2,004 rows sorted, 4.4 ms at pass 1,000.
- With the batch node alone, which is the only node n8n's default ever asks this method for, it
  is one backward index step: 0.05 ms.

So step 14 makes the decode constant, but this query is still O(rows of the execution) per
settlement, O(passes²) over a run. Within 1,000 passes the latency clause holds (0.45). Extending
the four quarters linearly, which is an extrapolation and not a measurement, the policy's p95 would
reach 2× n8n's handler p95 (28.4 ms) at roughly 8,000 passes. A fix needs either a per-node
latest-row query (one round trip per node, which worsens the round-trip clause) or a `StepStore`
query that seeks each node's latest row through the unique index (for example a `LATERAL` join).
That is an n8n change and was not made.

**Options for the orchestrator or the user. None was implemented (stop rule).** These cover the
round-trip clause; the growth above needs its own decision.
- (a) **Decide ∅ without reading when the settled node has no out-edges.** The candidate list is
  structurally empty, so nothing depends on the rows. On this workflow Done@0 would drop to 0 + 2.
  It is not a general bound: a settlement that queues nothing because every candidate already has a
  row still reads twice in each call. Such a settlement would be a fan-in reached past a loop's
  third pass.
- (b) **Share one snapshot between `decideSuccessors` and `isFinished` in the same settlement.** The
  policy cannot see that the two calls belong together. Doing this needs either per-settlement
  state in the policy, which breaks "a pure function of the rows read" and decision 2's no-cache
  rule, or a seam change, for example one call that answers both.
- (c) **Amend F4 to count per call** (at most 3 reader calls per call, as step 6's test reads it).
  Measured live, the most was 2 per call. By source reading, n8n's default can itself reach 4 per
  settlement: `decideSuccessors` with a loop exit among the candidates, plus `isFinished` with a
  loop. That was not measured; the most measured here was 3.

**Gate.**
- `npm run check` is clean.
- `npm test` passes 2,099 tests in 107 files: step 11's 2,087 plus 12. That includes `v1-identity`
  with `v1-fingerprint.json` untouched, and the golden replays with `tests/fixtures/` untouched and
  nothing re-recorded.
- `verify-patch.sh` applies 0001–0004 (13 paths), and `.n8n` is at the detached pin `944afe5` with
  no local branches.
- No container is left running.
- Nothing was committed or pushed.

### Step 12, rerun: the F4 fix (orchestrator, 2026-10-03)

The orchestrator chose two fixes and kept F4 as written: (1) `isFinished` reuses the snapshot
`decideSuccessors` read in the same settlement, extended with the rows the policy itself just
decided; (2) the latest-row read is scoped so it no longer sorts every row of the execution. The
safety argument for (1) was written down before any code, as the brief requires.

#### The safety argument for (1), written before the code

**Claim.** A stale but internally consistent snapshot can make `isFinished` false too often, never
true too early. Precisely: if the reused answer is true, then a fresh read at the same moment would
see exactly the reused row set, so it would also say true.

**What the argument rests on** (engine invariants at the pin, and the `engineV2` net's arcs):

- (I1) Keys are unique per execution (`createSteps` deduplicates on `(execution, node, iteration)`).
  Rows are never deleted. A settled row (`completed`, `skipped`, `failed` or `cancelled`) never
  changes again, its filled slots included. `waiting → queued` stays among the unsettled statuses.
- (I2) Rows are created in two places only: `ExecutionStartHandler` creates the trigger before any
  settlement; `StepSettledHandler.planSuccessors` creates `decideSuccessors(c)` for the settlement
  of a completed or skipped row c, as computed by the answering policy from a snapshot S_c read in
  that handler after c settled. These are the only two `createSteps` callers in
  `packages/@n8n/engine/src` at the pin.
- (I3) Under the net-backed policy, `decideSuccessors(c)` is R(S_c) narrowed to c's candidates, so
  every key it decides is in R(S_c), with R's fate.
- (I4) The policy's snapshot T is a subset of the row set U(t) at one instant t that holds U(t)'s
  frontier. So `decodeFrontier(T) = decodeStepRows(U(t))` (step 14), and R, "a row failed" and "a
  row is unsettled" read the same on T as on U(t). Fix (2) below is built to keep this property: the
  only read that returns rows is a single statement.
- (N1) The places a key's start or skip consumes are each incoming edge's `arrived` and the node's
  `live`. No other transition consumes them (`gadget/settlement/node.ts`, `batch.ts`).
- (N2) A start is inhibited only by `_halt`. A skip is inhibited by `_halt` and by the node's `live`.
- (N3) An `arrived` place never holds two tokens in a marking the decoder produces. An edge's source
  row at a given pass settles once (I1), and the next pass's token for a loop edge comes only after
  the consumer fired at this pass (`codec/v2/frontier.ts`, argument 1). A `live` token is written
  only together with an `arrived` token for an edge into the same node (`routing.ts`, the batch
  node's `loop` and `doneData` branches).

**Lemma P (persistence).** Let S ⊑ S′ be row sets of one run, where S′ has the rows of S, more rows,
or later statuses. Let S′ hold no failed row, and let M(S′) be reachable from M(S). If key k is in
R(S) with fate f, and k has no row in S′, then k is in R(S′) with the same fate f.

*Proof.* The path from M(S) to M(S′) fires neither of k's transitions, because k has no row. The
key's iteration is unchanged: k = (n, rowCount_S(n)), and S′ has no row of n at that iteration or
later. By N1, every token k's transitions consumed at M(S) is still in place. `_halt` is unmarked,
because only a failing run writes it and S′ has no failed row.
- If f is queue, the start still has its `arrived` tokens and at least one `live` token.
- If f is skip, n's `live` was empty at M(S). A `live` token at M(S′) would have arrived together
  with a second token on some `arrived` place into n (N3's pairing). That place already held a
  token, which contradicts N3. So the skip is still enabled, and the start is still disabled.
∎

**Corollary D (one fate per key).** Take two snapshots of one run under the net-backed policy that
both put k in R. Then both give k the same fate.

*Proof.* Instantaneous snapshots of one run are ordered by ⊑. Apply P with S′ the later snapshot:
k has no row in S′, since it is in R(S′), and S′ has no failed row, since R(S′) is not ∅. ∎

**Theorem.** Take the handler h of a settlement s:
- h reads T, the snapshot of U(t1);
- it gets D = `decideSuccessors(s)` at T, and `createSteps(D)` has returned by time t_c;
- at t3 > t_c it calls `isFinished`, and the policy answers F = `isFinished(T ∪ D̂)`. Here D̂ adds
  each queue key of D as a `queued` row and each skip key as a `skipped` row.

If F is true, then at t3 the rows are exactly U(t1) ∪ D̂, with the same statuses. That row set has
no failed row, every row in it is settled, and R of it is ∅.

*Proof.* Let V = U(t1) ∪ D̂. F true gives three facts:
- (a) no failed or cancelled row in T ∪ D̂ (decision 8 answers false on a cancelled row);
- (b) every row is settled, so D has no queue key and D̂ is all skips;
- (c) R(T ∪ D̂) = ∅. By I4 applied to V, R(V) = ∅. (T ∪ D̂ ⊆ V and holds V's frontier: the D̂ rows
  are their nodes' new latest rows, and a batch node advanced by D̂ from pass L to L+1 needs passes
  L and 0, which T holds.)

1. Each key of D̂ has a `skipped` row at t3. If h did not create it, `createSteps` found the row
   present, so another planner decided the key from its own snapshot. By D, that planner also
   skipped it. A skipped row never changes (I1).
2. The rows of U(t1) are all settled, by (b) and the frontier fact that rows outside T are
   completed or skipped. By I1 they are unchanged at t3. So U(t3) contains V with the same statuses.
3. Let X = U(t3) \ V, and suppose X is not empty. Let r be the first row of X created (one
   `createSteps` is one atomic insert; take any row of the earliest batch). r is not the trigger,
   which exists before any settlement and so is in U(t1). By I2, a handler h_c of a settled row c
   created r, with r in R(S_c), where S_c is a snapshot of U(t′) for some t′ before r was created.
   - Every row of U(t′) was created before r. By the choice of r it is not in X, so it is in V.
   - M(V) is reachable from M(U(t′)). If t′ ≤ t1, follow the run's own firings to U(t1), then fire
     D's skips, which are enabled at T and so at U(t1) (I4). If t′ > t1, then U(t′) is U(t1) plus
     the D̂ rows created by t′, because U(t1)'s rows were already settled. The remaining skips of D
     are still enabled by P.
   - V has no failed row (a), and r has no row in V. So P gives r ∈ R(V), which contradicts (c).

So X is empty and U(t3) = V. ∎

**Liveness: reuse never loses the ending.** Suppose an execution reaches a final row set U*: every
row settled, none failed or cancelled, and R(U*) = ∅. Let x be the row that settled last (a skipped
row settles when it is created).
- x's handler starts after x settled. By then every row is settled, and no later row is created: a
  queued row would settle after x, and a skipped row would settle when created, after x.
- So both reads of x's snapshot see U*. `hasFailedSteps` is false, D = ∅, and the reused
  `isFinished(U*)` is true.

So the execution ends, at the latest, in the handler of the last row to settle. By the theorem it
never ends earlier than a fresh read would let it. Reuse can move the ending to a later settlement
than a fresh read would. Under concurrency that can change `lastStep`, which the legs compare.

**Binding (B), which the theorem assumes.** The snapshot reused by h's `isFinished` must be the one
h's own `decideSuccessors` stored. The policy keys the stored snapshot on the graph object it is
passed, checks the execution id, and consumes it once. The handler passes the same
`execution.graph` object to both calls. Different handlers get different objects, because
`TypeOrmExecutionStore.loadExecution` builds the record with `getRawOne()`, which parses the jsonb
column on every call. The leg's `MemoryExecutionStore.loadExecution` copies it on every call too. If
B failed, another handler's D̂ might not exist yet at t3, and step 1 would not hold. B is therefore
checked live: the testbed instrument records which handler context stored each snapshot and which
consumed it.

**The safe direction, observed.** When a row settles between t1 and t3, the reused answer can be
false where n8n's fresh count says true. In the shadow legs that is reported as the verdict `stale`
(the side that read nothing said false, the other side said true), counted and not excused as an
agreement. The opposite direction stays `disagree`.

**Falsifier for this argument.** In the handler leg (`--concurrency 8 --p-fail 0.3 --wait 0.2
--p-cancel 0.3`) with an injected stale snapshot: if our `isFinished` says true while the live rows
at that moment are not final, the argument fails, and the step stops and reports blocked with the
counterexample.

#### What was built

- **(1) One snapshot per settlement** (`src/settlement/policy.ts`). `decideSuccessors` stores its rows
  and its decision in a `WeakMap` keyed by the graph object it was passed. `isFinished` on the same
  object, with the same execution id and compile-memo entry, takes the stored snapshot (once) and
  answers `finishedAfterDecision(rows, decided)` = `finishedFromRows(rows ∪ D̂)`. It answers false
  without decoding when D has a queue key. Any other `isFinished` reads afresh. A `decideSuccessors`
  first drops whatever the object had stored, so a throw leaves nothing behind. There is a new option
  `reuseSnapshot` (default `true`) and a new diagnostic kind `snapshot`
  (`stored` / `reused` / `overrun`, with a token pairing `stored` and `reused`).
- **(2) The scoped read** (`src/settlement/rows.ts`, `readSnapshot`):
  1. `loadLatestStepSummaries(batch node ids)`, skipped without a loop. It only picks keys.
  2. One `loadStepSummariesByKeys` for every row of the snapshot: `(node, 0)` outside a loop; for a
     loop whose batch node was at pass L, the members' passes `0, L−1, L, L+1` (all up to L+1 while
     L ≤ 2); the batch node's passes plus the probe `L+2`; and the settled row.

  If the probe row exists, the loop ran two passes between the reads. The snapshot is then re-read
  by `readLatestSnapshot`, the previous default, which is consistent whatever the timing, and the
  call reports `overrun` (4 reads). The previous read is kept as `readLatestSnapshot`, and
  `readFullSnapshot` is unchanged.
- **Shadow** (`src/settlement/shadow.ts`). A side that read nothing in `isFinished` is reported with
  the rows of its `decideSuccessors` (`reused`). Its false against a fresh true is the verdict
  `stale`. Its true against a fresh false stays `disagree`. The named-race check now sees the reused
  side's rows.
- **Testbed.** `preload.mjs` puts the `snapshot` events into the settlement record of the handler
  they were emitted in. `compare-v2.ts` checks binding B (a `reused` token whose `stored` is in
  another handler's record is a finding), counts `stale` verdicts and overruns, and reports the loop's
  latency by quarter of the passes. `n8n-testbed.sh` now rebuilds `typescript/dist` when `src` is
  newer. Before, it built only when the dist was missing, so a stale dist would have run an older
  policy under the current name.
- **Handler leg (d5)** (`tasks/v2-handler-leg.mts`):
  - The answering instance of ours reuses snapshots, as registered. The other side of (d1), every
    re-ask and both (d4) instances read afresh.
  - On every `true` from our answering `isFinished`, the rows at that moment must be final, by our
    fresh full-snapshot answer and by n8n's count.
  - A reused false where n8n's fresh answer is true is counted as `stale`.
  - `--stale` serves our answering `decideSuccessors` the rows as they were when the settled step
    settled. They are taken in a microtask after the store call that settled it, so a `createSteps`
    batch is whole. This is the stalest snapshot a handler can legally read.
  - The mutation `--mutate cross-bind` hands our policy one graph object per execution, which breaks
    binding B on purpose.

#### Deviations

- **(2) is scoped to batch nodes, not to "loop members and batch nodes".** The brief asked for the
  latest-row read to cover the nodes whose latest iteration can exceed 0. That still sorts every row
  of the loop. `EXPLAIN ANALYZE` in `postgres:18.4-alpine` (Docker, the same image as the legs), on
  synthetic rows shaped like the Loop Over Items (T, Make, Split, then B and Body per pass, plus 20
  other 1,000-pass executions in the table), 3 repetitions:

  | query | 250 passes | 1,000 passes |
  |---|---:|---:|
  | latest of every node (the old first read; sorts 503 / 2,003 rows) | 1.23–1.33 ms | 4.16–4.23 ms |
  | latest of B and Body (the brief's scoping; sorts 500 / 2,000 rows) | 1.27–1.29 ms | 3.95–4.07 ms |
  | latest of B alone (the scoped read's first read, and n8n's own; `Limit` over a backward index scan, 1 row) | 0.03–0.05 ms | 0.05–0.06 ms |
  | the scoped read's keyed read (13 keys; `BitmapOr` of 13 index probes) | 0.16–0.21 ms | 0.19–0.20 ms |

  Members' rows are found by key instead. Their latest pass is L−1 or L whenever the batch node is
  at L (`frontier.ts`, argument 1), so the keys are known after the batch read.
- **Every row comes from the second read, and none from the first.** The brief's shape (latest rows
  of the loop nodes in read 1, `(node, 0)` in read 2) mixes two instants for mutable rows: a batch
  row read at t1 and a `Done@0` created at t2 make a row set the decoder refuses, which is F6. Here
  the first read only chooses the keys. The second read is one statement and returns every row,
  including the batch node's latest again. The probe detects the one case where the keys could
  have missed rows.
- **The overrun path makes 4 reads in one call.** That breaks "at most 2 reads per call" in that
  case only. It needs the loop to finish two passes between two consecutive queries of one handler,
  so it cannot happen on a loop alone (each settlement creates the next row). Measured: 0 overruns
  in both full handler legs and in every testbed leg (below). It is counted on every call.
- **A row of a node outside every loop at iteration ≥ 1 is no longer read** unless it is the settled
  row. Engine v2 does not produce such rows (`targetKey`), and the latest-row read used to show one
  to the decoder, which refused it. `tests/settlement/reuse.test.ts` pins the new behaviour.
- **Tests changed with the design**, none of them n8n's:
  - Calls that do not follow the handler's order now pass `reuseSnapshot: false`. These are
    `isFinished` without the settlement's own `decideSuccessors` and `createSteps` before it: the
    pure-function test, the reference-loop tests, the interleaving test and the frontier long loop.
  - The read budget now expects 1 call without a loop and 2 with one, where it expected 1 or 2. The
    long-loop key bound is now 24, where it was 15.
  - Two error tests now name the scoped read's view: a stray `A@1` is now asked as the settled row;
    a key not asked is now `After@1`.
  - The diagnostics tests filter or expect the new `snapshot` kind.
  - In the shadow tests, the CodecError case now uses a gap the scoped read sees, and the skew case
    moves the keyed read.
  - The golden replays (`replaySettlement` calls `isFinished` at S′ after `decideSuccessors` at S,
    with the same graph object) pass unchanged with reuse on, and nothing was re-recorded.

#### Results: the argument against the handler leg (settlement evidence)

`npx tsx tasks/v2-handler-leg.mts --concurrency 8 --p-fail 0.3 --wait 0.2 --p-cancel 0.3` (20 × 20
over 209 accepted entries, 167,200 runs, 83,600 pairs per configuration). n8n 2.42.0 dist at
`944afe5` with 0001–0004 (`settlement-policy.js d01a00e31a71`, `step-settled-handler.js
28762f9eafae`), libpetri 7.0.0 from the registry, Node 26.8.1. Settlement evidence, not a
conformance number:

| configuration | our `isFinished` reused / fresh | reused `true` checked | safety violations | `stale` (reused false, fresh true) | (d1) disagreements | (d2) | (d3) findings | (d4) | overruns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `--stale` (decide from the rows at settlement; 469,171 such decides, 54,501 behind the store) | 292,968 / 0 | 65,613 | **0** | 6,979 | 0 + 0 | 0 | 0 | 0 | 0 |
| natural interleaving | 290,738 / 0 | 70,429 | **0** | 788 | 0 + 0 | 0 | 0 | 0 | 0 |
| `--stale --mutate cross-bind` (mutation check, not a result) | 278,049 / 14,266 | 64,493 | 7 | 5,543 | 0 + 7 | 0 | 0 | 0 | 0 |

- **The argument holds.** With binding B in place, our `isFinished` said true 136,042 times on a
  reused snapshot across the two configurations, and the live rows were final every time.
- **The leg can see what the argument rules out.** With B broken it found 7 trues at rows that were
  not final. Every one has the predicted shape: every live row settled, but another handler's skips
  not yet written, so R is not ∅.
- In every configuration, our runs ended `failed` through `isFinished` 0 times, and every
  failure-free run of ours completed (no stuck `running`).

#### Results: `diff-engines-v2.sh` after the fix (integration results)

`scripts/testbed/diff-engines-v2.sh --repeat=2 --loop-repeat=3`, the same invocation as the first
run. These are integration results from the live testbed. They are not conformance numbers, not
policy-entering case counts, not neutrality legs and not settlement evidence. The write-up is
`docs/testbed.md`, "After the F4 fix".

Setup: `postgres:18.4-alpine` with image id `db676a0ed906` in all four legs, a 384 MB cap, Docker VM
953,692,160 bytes. No memory failure. 19 executions per leg. `typescript/dist` was rebuilt from the
fixed source.
- **All checks from the first run hold.** Every execution in every leg equals `off` run 1 on status,
  rows, fates, slots, outputs and `lastStep`. F3 does not fire (0 ending `running`). Policy calls
  equal settled non-failed rows (6,055 = 6,055). F2 holds: 6,066 shadow agreements and 0
  disagreements in each direction. F5, F6 and F7 do not fire: `entered` is 6,066 per registered
  leg, with 0 `settlement policy error`.
- **Binding B holds live.** Each registered leg stored 6,055 snapshots and reused 11, and 0 crossed
  to another handler. There were 0 `stale` verdicts and 0 overruns.
- **F4 does not fire.**
  - Round trips: at most 2 in one settlement under `primary` (limit 3). On Done@0, `decideSuccessors`
    made 2 and `isFinished` 0, where n8n's default made 1 + 2 = 3. Over every workflow: 6,015
    settlements made 2 round trips and 40 made 1.
  - Latency: the policy's p95 is 4.27 ms against n8n's handler p95 of 13.9 ms under `off`, a ratio of
    0.31 (limit 2).
  - Stricter readings, which do not decide F4: policy against policy 1.39 (2.11 before); handler
    against handler 1.38 (1.75 before).
- **The growth is gone.** The `primary` policy p50 by quarter of the 1,000 passes is 2.43, 2.68, 2.86
  and 2.76 ms (2.75 → 5.41 before), and the p95 is 4.15–4.34 ms. Under `off` the p50 is 1.61–1.75
  ms.

#### Open after this step

- The `stale` direction and the overrun path are exercised only by the concurrent handler leg. The
  testbed's manual runs give them no occasion, so their 0 there is weak evidence. (Corrected in
  "Review after step 13": `stale` also occurs live in `engine-int` on Postgres, and the overrun
  path occurred in no leg, the handler legs included.)
- Binding B rests on `TypeOrmExecutionStore.loadExecution` building a fresh record per call
  (`getRawOne`). A future n8n change that caches execution records would break it silently. The
  testbed's `crossed` count and the handler leg would show it; nothing in the policy can.
- `tasks/v2-policy-cost.mts` still measures the policy as before (its reads now follow the scoped
  read). It was not rerun.

### Review after step 13: the shadow tally drops `stale`; the Postgres legs rerun (orchestrator, 2026-10-03)

A review of steps 9–14 in the working tree reproduced six findings. One is a defect in the
settlement leg's accounting. The other five are documents that claim more than the measurements,
or measurements that were never recorded.

**Defect: the `-int` legs' shadow tally had no `stale` case.** `n8n-v2-vitest-setup.ts`'s
`onShadowReport` counted `agree`, `disagree`, `race` and `candidate-threw`. A `stale` report (step
12's rerun added the verdict) reached the ledger as a record but no counter, so `entered.ts`'s
headline summed to one call fewer than the policy calls and never showed `stale`. The switch had no
exhaustiveness guard, so `tsc` did not catch the new union member. `tests/testbed/compare-v2.ts`
counted it; the `-int` legs did not.
- Fix: `SettlementCounts.stale`, counted in the shim, with `assertNever` on the verdict. `entered.ts`
  reports `stale` in the headline and the report, and `shadowUnaccounted`: in the shadow modes,
  policy calls minus verdicts, minus the errors of a `primary-shadowed` primary (ours threw, no
  report). Nonzero prints `UNACCOUNTED n`. A ledger written before the fix has no `stale` field.
  It reads as 0, and the call then shows as unaccounted instead of vanishing.
- Regression tests (`tests/settlement/vitest-session.test.ts`): a `primary-shadowed` session over
  T → A → B, with B running at the decide read and completed at `isFinished`, writes a case
  record with `stale: 1`, and the report balances 2 calls against 2 verdicts. A hand-built ledger
  balances with an error, and the same ledger without `stale` reports 1 unaccounted. With the
  shim's `stale` arm removed, the first test fails.
- This is not a falsifier. The verdicts and the ledger records were right; only the tally that
  feeds the headline was short.

**The Postgres shadow legs on the as-built policy** (after the F4 fix and this fix; settlement
evidence and policy-entering cases, not conformance numbers). `scripts/run-conformance.sh
--skip-patch --engines=libpetri --scope=S --settlement-mode=M`, one leg at a time, `typescript/dist`
rebuilt. n8n `944afe5` with 0001–0004, libpetri 7.0.0 from the registry; Postgres 18.4
(`postgres:18.4-alpine`, `db676a0ed906`) for `engine-int` and 18.6 (`postgres:18-alpine`,
`d7a8005067f5`) for `compat-int`, Docker 25.0.2, VM 953,692,160 bytes.

| leg | who answers | calls | agree | stale | disagree | race | candidate threw | cases |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `engine-int` `primary-shadowed` | ours | 34 | 33 | 1 | 0 | 0 | 0 | 10 / 10 policy-entering pass |
| `engine-int` `shadow` | n8n's default | 32 | 31 | 1 | 0 | 0 | 0 | 10 / 10 entering, n8n's answers |
| `compat-int` `primary-shadowed` | ours | 92 | 92 | 0 | 0 | 0 | 0 | 16 / 16 policy-entering pass |
| `compat-int` `shadow` | n8n's default | 92 | 92 | 0 | 0 | 0 | 0 | 16 / 16 entering, n8n's answers |

- **Both `stale` verdicts are in "settles a conditional diamond: dead chain skipped, merge runs on
  the live side"**, at `isFinished`, with no skew. In `primary-shadowed` ours reused and said
  false where n8n's fresh count said true. In `shadow` the same, with ours as the candidate. The
  case passed under ours, `completed` with its asserted rows, so the ending moved to a later
  settlement: divergence row 39, in a run of n8n's own suite. The theorem allows exactly this
  direction.
- **It varies from run to run.** Before this fix, a run on the same policy code gave `engine-int`
  `primary-shadowed` 34 calls with 1 `stale` in the ledger (headline: agree 33), and `engine-int`
  `shadow` 34 of 34 agree. The reruns in the table above overwrote those artefacts in
  `conformance-results/`, so the table is the surviving record. The reviewer's own
  `primary-shadowed` run gave 32 calls with 1 `stale` (scratch, `/private/tmp/rev14`). The call count moves with the diamond's interleaving (step 10
  explains why), and so does the occasion for `stale`.
- **0 named races, 0 errors** in every leg. No cancel was sent, so that 0 says nothing about row 36.
- The `primary` legs (`engine-int` 10 / 10 with 34 calls, `compat-int` 16 / 16 with 92) were not
  rerun. The fix changes no shadow-free count, and their artefacts were written on the as-built
  policy and were not overwritten (only the shadow-mode legs were rerun).
- Step 10's shadow table predates the reuse. Its `compat-int` row is `primary-shadowed` only, so
  step 10 never ran `compat-int` `shadow`. The rerun row above, 92 of 92 agree, is its record.

**The handler legs on the as-built policy, rerun** (settlement evidence, our in-memory stores).
`npx tsx tasks/v2-handler-leg.mts`, 20 × 20 over 209 accepted entries, 167,200 runs, the same stamp
as step 12's rerun:
- Sequential (580 s): (d1) 1,086,514 `decideSuccessors` and 686,920 `isFinished`, 0
  disagreements, 0 races; (d2) 83,600 lockstep pairs, 0 differences; (d5) 343,460 reused, 0
  `stale`, 0 safety violations, 0 overruns. 0 findings. Equal to step 8's counts.
- `--concurrency 8 --p-fail 0.3 --wait 0.2 --p-cancel 0.3 --stale` (689 s): 0 disagreements, and
  the named races counted, not compared: `decideSuccessors` cancel race 21 (the default planned on
  13, ours on none); `isFinished` failure race 211 (default true on 6) and cancel race 73 (default
  true on 19). (d5) 292,968 reused, 6,979 `stale`, 65,613 reused trues checked, 0 safety
  violations, 0 overruns. 0 findings. Equal to step 12's rerun.
- So under stress the two policies agree on every compared decision, and differ by design on the
  named races (rows 36 and 37). "Agrees on every decision" was an overclaim.

**Corrected in the documents.**
- ADR 0014: §5 now states CLAUDE.md's rule (testbed wall clocks and data-equivalence results are
  integration results, never conformance numbers); the Postgres shadow figures are the table
  above, not step 10's 32 / 32; "Open" says where `stale` occurs and that the overrun path
  occurred in no leg.
- Open after step 12 said the overrun path is exercised by the concurrent handler leg. Every handler
  leg and every testbed leg counted 0 overruns. Only `tests/settlement/reuse.test.ts` exercises it.
- Divergences: row 39 records the `engine-int` occurrence; row 36 names which shadow legs ran.
- CHANGELOG, state of the project, todo (c)/(d) and the README: the net answers the settlement
  decision only, the testbed is 19 manual in-process executions per leg one at a time, the handler
  leg's stores are ours, the races are counted, not compared, "2 round trips" is a testbed
  measurement with the 4-read overrun path named, and `engine`'s neutrality is per case on the
  baseline's 376 plus 0003/0004's 25.

**Gate.** No gate was recorded after step 12's rerun or step 13. Before this fix `npm test` passed
2,119 tests in 108 files (the reviewer's run). After it:
- `npm run check` is clean.
- `npm test` passes 2,121 tests in 108 files: 2,119 plus the 2 regression tests.
- `.n8n` and Docker were left as found: the generated shims were already present and are excluded
  files; only testcontainers' reaper ran, and it exited.
- Nothing was committed or pushed.

- **Provenance gap, known:** in the rerun `engine-int` `primary-shadowed` leg, `pg-stamp.txt` says
  no container started and `pg-events.txt` is empty, while `test.log` shows the Postgres-backed
  suite ran (149 passed). This is `pg_watch_begin` subscribing to `docker events` late (seen
  before, in 2 runs at step 10). The image id, and with it the server version, is read separately
  and is correct. The container count in that stamp is not.
