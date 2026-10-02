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

## Deviations during implementation

(none yet)
