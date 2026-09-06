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

### Changed
- README per-node gadget now documents the routed `X_run`/`X_route` shape (libpetri's
  validator rejects the earlier nested-`xor` form on the retry and halt branches, ADR 0004).
