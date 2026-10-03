# ADR 0014: The engine v2 settlement seam, and the net behind it

Status: **accepted as built** (2026-10-03). It records ADR 0013 decisions 4(b) to 4(d) as
`tasks/v2-seam-plan.md` built them (steps 2–14), at n8n master `944afe5`. One question stays
open: whether 0004's process-global registry is the shape to offer upstream (plan, blocker 3).

## Context

ADR 0012 showed that the engineV2 net plans like n8n's `decideSuccessors` on every row set reached.
ADR 0013 then made engine v2 the primary target and asked for three things:
- a seam in n8n's engine that changes nothing while nothing is registered;
- a policy behind it that answers from the net;
- a live server running on that policy.

The plan was synthesized from two competing designs and checked against the pinned source. It
fixed 14 steps and 8 falsifiers (F1–F8) before any code. Three falsifiers fired during the work,
and each one changed the design (see "What the falsifiers changed").

## Decision

### 1. The seam is `decideSuccessors` and `isFinished`, keyed by `StepKey`

Patch `0003-settlement-policy.patch` extracts the settlement decision from
`StepSettledHandler` into `execution/settlement-policy.ts`:

```ts
interface SettlementPolicy {
  decideSuccessors(graph, settled: StepKey, reader: SettlementReader): Promise<SuccessorDecisions>;
  isFinished(graph, reader: SettlementReader): Promise<boolean>;
}
interface SettlementReader {   // bound to one execution, read-only
  executionId;
  loadLatestStepSummaries(nodeIds);
  loadStepSummariesByKeys(keys);
  countSettledSteps();
}
```

- `defaultSettlementPolicy` is n8n's code, moved: `decideSuccessors` with `decisionKeys`, and the
  count test of `completion.ts`. It makes the same store calls in the same order. The handler's
  7th constructor parameter defaults to it.
- The handler keeps everything else: the failure branch, `hasFailedSteps`, `createSteps`, the
  announcements and `cancelPendingSteps`. `StepReadyHandler` still gathers inputs.
- The reader has no write method, so a policy cannot create rows. Its type enforces "a pure
  function of the rows read".
- The decision core is byte-identical to the pin: `settlement.ts`, `completion.ts`,
  `loop-ledger.ts`, `iteration-mapping.ts` and `graph/loops.ts`.
- The seam is `isFinished`, not an expected count. A policy that had to return a count would be
  returning a boolean in disguise.

### 2. Injection: an engine-side registry, read in one place

Patch `0004-settlement-policy-registry.patch` adds `setSettlementPolicy`, `getSettlementPolicy`
and `resetSettlementPolicy`, plus `EngineRuntimeOptions.settlementPolicy`.
- `createEngineRuntime` passes `settlementPolicy ?? getSettlementPolicy()` to the handler. That is
  the only read of the registry. A handler built directly, as n8n's unit tests build it, never sees
  a registered policy.
- There is no cli patch. The in-process mode, the `n8n engine` command and `serve.ts` all build
  their runtime through `createEngineRuntime`.
- It has the shape of patch 0002, the v1 scheduler registry.

### 3. The net-backed policy (`typescript/src/settlement/`)

`createSettlementPolicy()` is exported from the `n8n-v2` entry, and `registerSettlementPolicy`
registers it.
- **Compile once per graph.** The memo key is the sha256 of the canonical `{nodes, edges}`. The
  memo is a bounded LRU, a refusal is cached as a refusal, and it holds nothing per execution.
- **Fates come from the net.** R(S) is `decodeFrontier` followed by `planFromMarking`.
- **Keys and order come from n8n's structure.** `candidateKeys` ports `classifyEdge`, `targetKey`
  and `batchStepDecides`. It walks the settled node's out-edges in graph order, dedupes, and skips
  keys that already have a row. The answer is R(S) narrowed to those keys, in that order. n8n
  decides per key, not per node id, so a filter by node id could take another iteration's key.
  The candidate list is structure, not scheduling: the net still decides what runs.
- **`isFinished(S)`** is false whenever S holds a failed row. Otherwise it is true when every row
  is settled and R(S) is empty (decision 7 as amended, below).
- **Two named races** are decided rather than thrown, and each emits `settlement policy race`:
  - a failed row: the net's `_halt` gives ∅, and `isFinished` is false (divergence row 37);
  - a cancelled row with no failed row: ∅ and not finished, without decoding (row 36).
- **No fallback to n8n's planner.** A compile refusal, a `CodecError` or a malformed store answer
  is reported as `settlement policy error` and thrown. The execution stays `running`, which is
  visible (row 38).
- **Configless `v1-node` steps are opaque.** A `v1-node` whose `config` is absent gets the
  synthetic type `@n8n/engine.v1-node`, with ports read from its edges. This follows the engine's
  contract: it never reads a v1 node's config. A config that is present but malformed is still
  refused.

### 4. What the policy reads: the frontier, one keyed statement, one snapshot per settlement

- **The frontier decode** (`codec/v2/frontier.ts`). The folded marking needs every node's latest
  row. For each loop whose batch node is at pass L, it also needs the loop's rows at passes 0 and
  L − 1. So the frontier holds at most 3 rows per loop node, whatever the pass count. The module
  doc proves that the marking is a function of the frontier. Passes 1 to L − 2 change no place.
- **The scoped read** (`settlement/rows.ts`). `loadLatestStepSummaries` asks for batch nodes only,
  which is the call n8n's default makes. It only picks keys. One `loadStepSummariesByKeys`
  statement then returns every row of the snapshot. For a node outside every loop it asks pass 0.
  For each loop node it asks passes 0, L − 1, L and L + 1, and for the batch node also a probe
  key at L + 2. It also asks for the settled row. So the key count depends on the graph, not on
  the passes. If the probe row exists, the loop ran two passes between the reads, and the policy
  re-reads consistently (`overrun`, 4 reads in that call). Rows never mix two instants, so the
  decoder never sees a row set the engine cannot produce.
- **One snapshot per settlement.** `isFinished` answers from the snapshot its settlement's own
  `decideSuccessors` read, plus the rows that call decided. It reads nothing itself. The snapshot
  is keyed on the graph object the handler passes to both calls, checked against the execution id,
  and consumed once (binding B). The plan proves it safe: a stale snapshot can make `isFinished`
  false too often, never true too early (Lemma P, Corollary D, the theorem and liveness, in
  "Step 12, rerun"). Reuse can move the ending to a later settlement than a fresh read would
  (row 39). This amends decision 2's "no cache" for this one hand-off only. The reader is still a
  pass-through.

### 5. Four kinds of result, never pooled

Decision 12 of the plan, which extends CLAUDE.md's reporting rule to engine v2:
- **neutrality legs:** patched with nothing registered, against the unpatched baseline;
- **policy-entering cases passed:** counted per case by an entered counter, never a raw pass count;
- **settlement evidence:** the golden, the differential and the handler legs, which are not
  conformance numbers;
- **integration results:** the live testbed. Its wall clocks and its data-equivalence results are
  integration results, never conformance numbers (CLAUDE.md's reporting rule).

## What the falsifiers changed

- **F3 at step 2.** "Every row settled and R(S) empty" said finished on failed row sets where n8n's
  count did not: 2,160 of 972,945 states, every one with a failed row. Amendment: `isFinished` is
  false on any failed row. In n8n a failed row set reaches completion only in a race, and there
  the failure path ends the execution `failed` either way. F3 is measured on failure-free row sets.
- **F7 at step 10.** The engine's own `step-execution` integration graphs carry `v1-node` steps
  with no config. The policy refused them, and 9 cases timed out with the execution `running`.
  Fix: opaque steps (§3).
- **F4 at step 12, on its round-trip clause.** One settlement per loop run made 4 round trips: the
  loop's ending, where `decideSuccessors` and `isFinished` each read twice. Also, the latest-row
  query sorted every row of the execution, so the policy's time grew with the passes. Fix: the
  snapshot reuse and the scoped read (§4).
- **Step 14 ran before F4.** The plan made the frontier decode conditional on F4. A review found
  that the full snapshot asked 2 bind parameters per key, which would exceed Postgres's 65,535
  at about 6,550 passes of a 4-node loop body. That finding comes from reading n8n's source and
  was not reproduced against Postgres.

## What was left out

- **No `validateGraph` hook.** Refusing at start where n8n accepts would be a new divergence. n8n's
  converter never emits `wait` or `subworkflow` steps (row 33).
- **No `StepStore` change.** A single-transaction snapshot (F6's remedy) was never needed: no
  `CodecError` appeared on live rows. A `LATERAL` latest-row query was not needed once the read
  was scoped to batch nodes.
- **No cli patch, and no cli DI registry** (the plan's alternative 0004b). Whether upstream would
  accept a process-global registry is open.
- **No fallback, and no `_cancel` place.** Cancellation on request is not modelled (row 35). The
  race it opens is decided as ∅ (row 36).
- **Not exercised:** queue mode (the engine-v2 module refuses it), a multi-worker engine,
  `responseMode: streaming`, and file-parallel integration runs (every `-int` leg ran with
  `--maxWorkers=1` on a 0.95 GB Docker VM). Webhook `runEnd` responses, concurrent executions and
  stops during settlements were added to the testbed later ("Measured results", live phases).
- **No Postgres provider other than Docker.** The embedded-postgres and brew shims the plan named
  were not built. Under Docker, testcontainers runs unmodified.

## Consequences

- With nothing registered, engine v2 runs n8n's own planner, and every leg below says so.
- With the policy registered, the net answers each engine v2 settlement the handler asks about,
  through n8n's handler and stores. It does not run steps, gather inputs, persist, or handle
  failures or cancellations.
- Four behaviours differ from n8n's default, each in a race or a refusal (rows 36–39). Row 39's
  occurred in n8n's own `engine-int` suite on Postgres: in "settles a conditional diamond", once
  in each shadow direction, and the case passed. Row 36's occurred in the testbed's cancel phase,
  in the shadow legs only, with every stopped run ending `cancelled` and no row left pending. Rows
  37 and 38 occurred in no live leg.
- The patches widen the drift surface. `check-n8n-drift.sh` lists commits touching
  `step-settled-handler.ts`, the decision core and `create-engine-runtime.ts` (F8). At the time of
  writing, `stable` and `beta` (2.40.7) stop at 0003, and `n8n@2.42.2` stops at 0004. That is
  release lag behind the master pin, not forward drift.
- The golden stamps the handler's dist. `GOLDEN_SEAM_PATCHED_DIST` accepts exactly the hash that
  0003 gives it and nothing else.

## Measured results, by kind

n8n `944afe5` with 0001–0004, `@n8n/engine` 0.22.0, libpetri 7.0.0 from the registry (not
linked), Node 26.8.1. Postgres 18.4 (`postgres:18.4-alpine`, image id `db676a0ed906`) for the
engine, 18.6 (`postgres:18-alpine`, `d7a8005067f5`) for compat, both in Docker 25.0.2.

**Neutrality legs** (patched, nothing registered, against the unpatched baseline; each baseline
run twice as a flake check). F1 does not fire.

| scope | cases | patched = baseline |
|---|---:|---|
| `engine` (unit) | 376, plus 25 added by 0003/0004 | identical per case |
| `compat` (unit) | 169 | identical |
| `cli-v2` (unit) | 365 | identical |
| `engine-int` (Postgres) | 149 | identical |
| `compat-int` (Postgres, m1 acceptance) | 18 (16 pass, 2 `it.todo`) | identical |

**Policy-entering cases passed** (policy registered, `primary`). F5 and F7 do not fire.

| scope | policy-entering passed | not entering (labelled, not counted) | policy calls | errors |
|---|---:|---:|---:|---:|
| `engine-int` (`src` seam) | **10 / 10** | 139 | 34 | 0 |
| `compat-int` (`dist` seam) | **16 / 16** | 0 (2 `it.todo` unrecorded) | 92 | 0 |

`engine` (401), `compat` (169) and `cli-v2` (365) also pass with the policy registered. No case
there settles a step through a runtime `createEngineRuntime` builds, so those counts are n8n's code,
not a policy result. Both `-int` legs ran twice with identical junit.

**Settlement evidence** (not conformance numbers). F2, F3 and F6 do not fire.
- Key-scoped decision against `decideSuccessors(s)` (leg a″): 537,950 reached (S, s) in the 20 × 20
  differential, and 316,165 reached and 946,814 overall in the exhaustive spike. 0 disagreements.
- Completion on failure-free S (leg a‴): 970,157 states in the differential, and 46,204 in the
  exhaustive spike. 0 disagreements. Failed S are counted as the named race, not compared.
- Golden: 515 recorded settlements replay with 0 findings in CI.
- Handler leg (d): n8n's patched `StepSettledHandler` on our in-memory stores, n8n's default
  against ours. Sequentially, 1,086,514 decisions and 686,920 completions, 0 disagreements. Under
  concurrency, failure and cancel stress, 0 disagreements. The stores' semantics are ours.
- Frontier against the global decoder (leg f): 0 disagreements in every configuration. In the
  7-pass exhaustive run the frontier was smaller than S in 118,234 comparisons, and the deep
  differential reached iteration 13.
- Snapshot reuse (d5, concurrent stress): 136,042 reused `true` answers checked against the live
  rows, 0 safety violations. With binding B broken on purpose, the leg finds 7.
- Live shadow on Postgres, on the as-built policy (after the F4 fix and the shim's `stale`
  tally; plan, "Review after step 13"):
  - `engine-int` `primary-shadowed`: 34 calls, 33 agree, 1 `stale`. `engine-int` `shadow`: 32 calls,
    31 agree, 1 `stale`. Both `stale` verdicts are in "settles a conditional diamond", one in each
    direction (row 39). An earlier `shadow` run on the same code gave 34 of 34 agree, so whether
    the interleaving occurs varies from run to run.
  - `compat-int`, both directions: 92 / 92 agree.
  - 0 disagreements, 0 races and 0 candidate throws in every leg. Step 10's 32 / 32 figures predate
    the reuse.

**Integration results** (the live testbed, `diff-engines-v2.sh`, after the F4 fix; 19 executions
per leg, four legs):
- Every execution under `primary`, `shadow` and `primary-shadowed` equals `off` run 1 on status,
  rows, fates, filled slots, outputs and `lastStep`. None ended `running`.
- Shadow: 6,066 agreements and 0 disagreements in each direction. 0 races, 0 errors.
- F4 does not fire: at most 2 round trips per settlement under `primary` (limit 3). The policy's
  p95 is 4.27 ms against n8n's handler p95 of 13.9 ms under `off`, a ratio of 0.31 (limit 2).
- Over 1,000 loop passes the policy's p50 stays between 2.43 and 2.86 ms. Before the fix it grew
  from 2.75 to 5.41 ms.

**Integration results, the live phases** (`diff-engines-v2.sh` after its sequential runs, two runs,
both under external host load; `docs/testbed.md`, "The live phases"):
- **Webhook** (40 production requests per leg): HTTP status, headers and body, and the rows, were
  equal under every policy. That covers `lastNode` (`runEnd`) on a single sink, on two sinks and
  on a failure, and `responseNode` (`stepResponse`).
- **Concurrent** (48 executions per leg, 16 in flight at once): every field on which `off`'s runs
  agree was equal. Which sink ended a two-sink run varied under `off` itself, so that field is
  judged per run from the ledger instead: under `primary-shadowed` every completed run ended where
  n8n's fresh count, run beside ours, first said true. The shadow checks gave 0 disagreements, 0
  `stale`, 0 crossed snapshots and 0 overruns in these two runs. In-process, `InMemoryWorkQueue`
  runs one settlement handler at a time, so `crossed` and the overrun cannot occur there, and the
  rounds repeat one FIFO schedule: each execution's settlements fall into the same number of
  contiguous blocks in every round of every leg (Loop Over Items: 7 or 8).
- **Cancel** (247 stops per leg through `POST /rest/executions/:id/stop`): every accepted stop
  ended `cancelled`, with no row `queued`, `running` or `waiting`.
  - Row 36's race occurred 13 and 19 times under `shadow`, 2 and 6 times under
    `primary-shadowed`, and 0 times under `primary` (494 stops, 89 inside the window). n8n's answer planned on 13 and 13
    of the cancelled row sets it was asked about; ours answered ∅.
  - Row 36's second clause, n8n's count saying finished on rows the cancel had just cancelled,
    showed as 9 shadow `stale` verdicts inside cancels, each checked on its own settlement.
- **F4.** The first run's sequential phase holds (2 round trips, ratio 0.29). The second run's
  latency ratio, 4.24, compares legs at median host loads of 9.5 and 137, and is not an F4 reading.

## Open

- Binding B rests on `TypeOrmExecutionStore.loadExecution` building a fresh record per call. If n8n
  caches execution records, B breaks silently. The handler leg would show it. The testbed's
  `crossed` count would not: the in-process engine runs one settlement handler at a time
  (`InMemoryWorkQueue`), so two handlers never overlap there. A multi-worker engine is where B is
  exposed, and none is available at the pin.
- The safe direction of reuse (`stale`) occurs in the concurrent handler leg and in `engine-int`'s
  conditional diamond on Postgres. In the testbed's two full runs, the webhook and concurrent phases
  gave 0 in 27,532 shadowed calls. That is those runs' count, not an absence: a reduced rerun gave
  2 in its concurrent phase under `shadow`, on V2 Wide Fan-Out runs that completed, where n8n's fresh
  count said true and ours, reused, said false. The 9 the full runs' cancel phases recorded were
  row 36, each checked on its own settlement. The overrun path occurred in no leg, and in-process it
  cannot occur. Only `tests/settlement/reuse.test.ts` exercises it.
- The effect of reuse on `lastStep` (row 39) is judged per run from the ledger, not against `off`'s
  runs, which are one sample of interleavings. Under `primary-shadowed`, every completed webhook and
  concurrent run of both full runs (75 per run) ended where n8n's fresh count first said true, so no
  moved ending occurred there. Under `primary` no fresh count runs: an earlier reused false went
  unchecked in 20 of 40 webhook runs and 38 and 31 of 48 concurrent runs. A moved ending has not
  been observed live.
- The concurrent phase covers few interleavings. Its rounds repeat one FIFO schedule per leg with
  its waves permuted (`docs/testbed.md`, "The schedule repeats"). A multi-worker engine, or a step
  worker that runs steps in parallel, would vary it.
- Row 36's race is now observed live, but only in the shadow legs: there the second policy's read
  widens the window. Under `primary` it did not occur in 494 stops. The cancel path needs three
  statements to commit inside the handler's one.
- No clean-host latency was obtained for the testbed's live phases. Both runs shared the machine
  with other sessions' suites (1-minute load averages up to 222, sampled in run 2).
- The golden's loops end by pass 2. On the golden the frontier is S itself, so it does not
  exercise the compression. The deep differential, the 7-pass exhaustive run and the deep handler
  legs do.
- `tasks/v2-policy-cost.mts` was not rerun after the scoped read. Its step-14 figures predate it.
- `pg_watch_begin` (`scripts/pg-stamp.sh`) missed the container start events in 2 `engine-int`
  runs. The image id is read separately, so the stamp's server version is unaffected.
- Upstream intent (plan blocker 3), and the order ADR 0012 §4 gives for the offer.

## Evidence

`tasks/v2-seam-plan.md` (decisions, falsifiers, every step's deviations and measurements);
`patches/n8n/0003-settlement-policy.patch`, `patches/n8n/0004-settlement-policy-registry.patch`;
`typescript/src/settlement/`, `typescript/src/codec/v2/frontier.ts`; `tasks/v2-differential.mts`,
`tasks/spike-v2-exhaustive.mts`, `tasks/v2-handler-leg.mts`; `tests/fixtures/v2/` (the golden);
`docs/testbed.md`, "Engine v2: the settlement policy in the live server" and "The live phases";
`scripts/testbed/drive-v2.mjs`, `tests/testbed/compare-v2-live.ts`;
`docs/divergences.md` rows 35–39.
