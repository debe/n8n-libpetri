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
