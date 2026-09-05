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

### Changed
- README per-node gadget now documents the routed `X_run`/`X_route` shape (libpetri's
  validator rejects the earlier nested-`xor` form on the retry and halt branches, ADR 0004).
