# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Repository scaffold: TypeScript package skeleton, docs, spec and task layout, CI.
- Architecture and model in `README.md`; net-native modelling principles in ADR 0001.
- `compile(workflow)` (`n8n-libpetri/compiler`): turns an n8n workflow description into one
  libpetri Coloured Time Petri Net that serves both execution and verification, plus a cached
  `PrecompiledNet`, a `NetMap` (transition ↔ node, place ↔ (node, port)) and `dotExport`.
- Emission rule: every connected output emits data or an explicit empty token; producers on a
  cycle emit `nil` instead, so downstream joins never wait on an edge that may never fire.
- Per-node gadget with two-phase start/run, an explicit `X/idle` mutex and a routed outcome
  (`X_run` → `X_route`); nodes with more than three connected outputs are routed per output so
  execution and verification stay linear in the number of outputs.
- Join gadget: slot semantics matching n8n's first-free-slot allocator, enumerated
  data/empty combinations for Merge chooseBranch, partial `requiredInputs` arrays, and a
  diagnostic for joins n8n can never run (unwired required input).
- OR-inputs: several producers into one input aggregate a round (one run per data arrival,
  one skip per all-empty round) instead of emitting one empty per producer.
- Retry gadget with n8n's own `getRetryParams` clamping (2–5 tries, 0–5000 ms wait), timed by
  the net's `delayed(waitBetweenTries)` transition.
- Halt and reap: `stopWorkflow` errors raise `_halt`; every start, retry and skip is
  inhibited and in-flight tokens are reaped into `_halted`.
- Expression references `$('Y')`: read arcs on `Y/done` make the dependency explicit; a
  reference to a skipped or unreachable node runs the node with a tagged
  `UnmetReferencePayload` so n8n's own error surfaces; self/downstream references are reported.
- Concurrency budget `_budget` with `_budget + Σ(running + ok + retry) = k` as a real
  P-semiflow, and `joinReadyPlaces` per join input for proper-completion queries.
- Structural hash (v3) over the compiled shape, stable across cosmetic workflow edits.
- Spike suite (`tests/spikes`) pinning every derived fact against libpetri 4.1.0, a z3 gate
  test (fails CI when proofs would silently become skips), and ADRs 0002–0005 (emission rule,
  join gadget, two-phase budget and routed outcome, marking codec).
- `scripts/bootstrap-n8n.sh`: idempotent clone of n8n at the pinned commit `441970b`, pnpm via
  corepack, filtered install, turbo build, and the unpatched execution-engine junit baseline
  (1657 cases, 75 files, 0 failures) under `conformance-results/`.
- n8n patches `0001-extract-scheduler-loop` (the `executionLoop` moved verbatim into a
  `StackScheduler` behind a `WorkflowScheduler` interface) and `0002-scheduler-registry`
  (`setWorkflowSchedulerFactory` so an alternative scheduler can be registered without an
  environment variable); `scripts/verify-patch.sh` re-applies them and fails on drift.
- Conformance harness (`n8n-libpetri/conformance`): dependency-free junit reader, explicit
  loop-driving classification (36 of 1657 cases), per-engine matrix with
  same/regression/fixed/new/changed verdicts, Markdown report and CLI;
  `scripts/run-conformance.sh` runs the suite under both engines.

- `PetriScheduler` (`n8n-libpetri`): a drop-in `WorkflowScheduler` for n8n's execution engine.
  Register it once and n8n's own loop is gone — the net decides what runs next:

  ```ts
  import { registerPetriScheduler } from 'n8n-libpetri';

  registerPetriScheduler({
    setWorkflowSchedulerFactory, // from n8n's scheduler registry (patch 0002)
    nodeHelpers: NodeHelpers,    // from 'n8n-workflow'
    StackScheduler,              // the legacy loop, for non-v1 workflows
  });
  ```

  It runs the node and routes the result, nothing more: no dispatch queue, no policy. Tokens
  carry the live `INodeExecutionData[]` arrays, so `$json`, `$node`, `pairedItem` and
  `WorkflowDataProxy` see exactly what they saw before. Workflows on `executionOrder` other
  than `v1` are handed to the scheduler you pass in.
- Wait nodes, destination-node stops and cancellation resume through the marking codec:
  `decodeExecutionData` turns a saved `IRunExecutionData` into a marking, `encodeMarking` turns
  a paused, cancelled or stranded net back into `nodeExecutionStack` / `waitingExecution` in
  n8n's own shape — including join slots, OR rounds, retries and in-flight activations.
  Cancellation is `executor.close()`; a run is never given a timeout.
- Retries are timed by the net (`delayed(waitBetweenTries)`) rather than by a sleep in the loop,
  so siblings keep running while a node waits between attempts.
- A `stopWorkflow` error halts the net and the activations it reaped are written back to
  `nodeExecutionStack` behind the failed entry n8n pushed, so a retry of the execution resumes
  from where it stopped instead of losing the queued work.
- Conformance against n8n's execution-engine suite at k = 1 (`scripts/run-conformance.sh`, full
  matrix in `docs/conformance-m2.md`): 26/36 loop-driving cases and 1619/1621 helper cases —
  26/30 and 1621/1621 once the AI-agent tool dispatch this milestone does not implement is
  excluded. The legacy leg is byte-identical to the unpatched baseline, so the patched seam is
  still a pure refactor. The remaining four failures are registered divergences (#2, #5, #11,
  #12), none of them data loss.
- Nodes that use the AI-agent `EngineRequest` / `EngineResponse` tool protocol fail with an
  explicit `NodeOperationError` naming the limitation instead of behaving unpredictably.
- Divergence register extended with #11–#15 and an amendment to #2; ADR 0005 amended with the
  mapping that landed.

- **Nodes run concurrently.** The `_budget` place is seeded with `k` unit tokens, so up to `k`
  nodes whose inputs are ready run at the same time — the whole point of replacing a loop that
  runs one node at a time. Two independent 500 ms HTTP calls now take ~500 ms, not ~1 s:

  ```ts
  registerPetriScheduler({ setWorkflowSchedulerFactory, nodeHelpers, StackScheduler, budget: 4 });
  ```

  The compiler decides whether the budget is safe to use and silently lowers it to 1 when it is
  not — a workflow with a cycle, or with an input index fed by more than one producer, takes its
  payload-to-`runIndex` pairing from arrival order, which above k = 1 is the producers' completion
  order. When it lowers the budget it says so as a diagnostic
  (`budget: k=4 lowered to 1 (multi-producer-input: C.0 has 2 producers)`). Across n8n's own
  1657-case suite exactly two workflows are lowered; everything else runs at the budget asked for.
- Same data at every budget. For every workflow the compiler leaves above k = 1, the
  `IRunExecutionData` at k in {1, 2, 4, 8} is identical: payloads, `pairedItem`, `source`,
  `executionStatus`, `metadata`, error shape, the resumable state (`nodeExecutionStack`,
  `waitingExecution`, `waitingExecutionSource`, `contextData`, `waitTill`) and the scheduler's
  own `executionError` / `closeFunction`. Only *ordering* moves, and every field that can move
  has a register row. `tests/conformance/budget-equivalence.test.ts` is that statement as a test.
- Input items are read-only. A node's output array is shared with every consumer it is wired to
  — exactly as n8n shares it — so a node must not write into what it was handed. n8n's own
  `addPairedItemLineage` already copies rather than stamping in place, so no second copy is
  taken; ADR 0006 has the aliasing table and the cost measurements (~19 ns/item to copy, against
  a 6.4x speed-up on a 25 ms-per-node workflow at k = 8).
- `PetriScheduler.maxInFlight` reports the high-water mark of concurrent node runs of an
  execution — a lower bound on how much of the budget was actually used.
- Differential harness (`n8n-libpetri/conformance`, `docs/differential.md`): a faithful port of
  n8n's own `stack-scheduler` loop runs the same fixture under the same host as the net, and the
  two are compared on three levels — a **data gate** (per `(node, runIndex)`: payloads, source,
  status, metadata, error, plus the resumable state and the scheduler contract), a
  **happens-before** check (every dependency n8n realised must be ordered the same under the net)
  and an **ordering** report where each moved activation is attributed to a numbered divergence
  row. `npx tsx src/conformance/differ-cli.ts <fixtures> --budget 1 --budget 2` exits non-zero on
  any unattributed difference or any mechanism no row names. 23 fixtures x k in {1, 2, 4}: 0 fail,
  0 unattributed, 0 novel mechanisms, 0 unobserved happens-before edges.
- Benchmark (`npm run bench`, numbers in `docs/differential.md`). Fan-out of N x 500 ms nodes,
  mean ms: width 2 — n8n 1006, k=1 1019, k=2 507, k=4 508; width 4 — n8n 2010, k=1 2019, k=2 1007,
  k=4 504; width 8 — n8n 4021, k=1 4023, k=2 2009, k=4 1006. A deep 8 x 500 ms chain, where there
  is nothing to win, is within 0.2 % at every budget. Scheduling overhead over n8n's own loop on a
  100-node chain of 0 ms actions: ~16 us per node warm (~79 us on a cold compiler cache), against
  an 80 ms HTTP call or a 400 ms LLM call.
- `scripts/run-conformance.sh --budget=N` runs n8n's suite at any budget. k = 1 keeps the M2
  artefact names; k > 1 writes `libpetri-k<N>.*` and is compared against the k = 1 libpetri leg,
  not the legacy baseline, so the matrix shows what the *budget* changed rather than re-reporting
  the k = 1 divergences. Budget restrictions and decode diagnostics are collected per leg.
- Conformance per budget (`docs/conformance-m3.md`). Loop-driving / helpers, and regressions
  against each leg's reference: legacy 36/36 and 1621/1621, byte-identical to the unpatched
  baseline; libpetri k=1 26/36 and 1619/1621, 12 regressions against the baseline; k=2 25/36 and
  1618/1621 and k=4 26/36 and 1618/1621, **2 regressions against k = 1** at either budget. Both
  are ordering, both are registered: the total execution order of a workflow with independent
  branches (#21) and a Respond node that the net has already started when a sibling fails (#17).
  No case moved from an order assertion to a data assertion at any budget.
- Divergence register at 21 rows: #19 (`executionError` is split into a write-once halt error and
  a completion-ordered leftover), #20 (an OR-input arm transition costs a scheduling cycle) and
  #21 (total execution order is n8n's, and only n8n's, property) are new; #1, #11 and #17 are
  widened by what the harnesses found. Every row M3 observed is now `designed`.
- ADR 0006 (payload safety and the k > 1 semantics): the aliasing analysis, why no extra copy is
  taken, the three hazard verdicts (waitTill claim, halt snapshot, in-flight sibling), and why
  the k-safety check is sound as written.

### Changed
- The concurrency budget is live. At k = 1 the engine remains n8n-sequential and byte-identical,
  which is what M2 proved; above it, `executionIndex` records the order nodes *started* rather
  than n8n's depth-first walk, and the execution-global fields n8n's loop owns —
  `lastNodeExecuted`, `waitTill`, `executionError` — become properties of completion order.
  Each is a numbered divergence (#15, #16, #19) rather than a silent difference. Keep k = 1 for a
  workflow whose correctness depends on a failure suppressing a ready sibling (#17), or that uses
  dynamically-resolved credentials (#18).
- README per-node gadget now documents the routed `X_run`/`X_route` shape (libpetri's
  validator rejects the earlier nested-`xor` form on the retry and halt branches, ADR 0004).
