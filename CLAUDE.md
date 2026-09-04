# CLAUDE.md

Guidance for Claude Code when working in the n8n-libpetri repository.

## Project overview

n8n-libpetri replaces n8n's intra-workflow scheduler (the `executionLoop` inside
`WorkflowExecute.processRunExecutionData()`) with a Coloured Time Petri Net engine built on
[libpetri](https://github.com/debe/libpetri) `typescript/`. n8n keeps node execution,
persistence, hooks, webhooks and queue mode. There is no n8n source fork: `.n8n/` is a
gitignored clone at a pinned commit plus two patches under `patches/n8n/`.

The architecture, the model (emission rule, per-node gadget, join gadget, retries, halt,
budget, marking codec) and the design principles live in the root
[`README.md`](README.md). It is the single source of truth; read it before structural changes.

## Hard rules

- Every transition carries a real `Out` spec. Never `null`, never `skipOutputValidation`.
- One net serves execution and verification. No separate "verification net".
- The net decides what runs. No host-side dispatch queue, permit gating or scheduler policy.
- Never call `executor.run(timeoutMs)`; use `close()` (libpetri's timeout branch leaks the loop).
- Every n8n behaviour we do not reproduce is recorded in `docs/divergences.md`. No silent skips.
- Reporting rule: of n8n's ~146 execution-engine cases only ~19 drive the loop. Headline
  numbers are loop-driving cases passed; pure-helper cases are stated separately.

## Build and test commands

### TypeScript (`typescript/`)

```bash
cd typescript
npm install
npm run build          # tsup, multi-entry ESM
npm run check          # tsc --noEmit for src and tests
npm test               # vitest
npm test -- compiler   # tests matching "compiler"
```

House style mirrors `libpetri/typescript`: ESM-only, strict + `noUncheckedIndexedAccess`,
tests under `tests/` (not beside sources), vitest, tsup, no ESLint/Prettier. Doc comments cite
libpetri requirement IDs (`IO-015`, `EXEC-003`, `MOD-010`, …).

Local iteration against a libpetri checkout: `npm link ../../libpetri/typescript`.

### n8n conformance (`scripts/`)

```bash
scripts/bootstrap-n8n.sh      # clone n8n @ pinned commit into .n8n/, pnpm via corepack, build, baseline
scripts/run-conformance.sh    # run the execution-engine suite under both engines, emit the matrix
scripts/verify-patch.sh       # re-apply patches to the pinned commit; fails on drift
```

Pinned n8n commit: `441970b` (master; the release tag predates n8n's helper extraction).

### Verification

libpetri shells out to the `z3` executable (`PATH` or `LIBPETRI_Z3`, ≥ 4.8.0). Without it
verification returns `unknown`, never throws. CI installs z3 and fails if proofs become skips.

## Source layout (`typescript/src/`)

- `index.ts` — `PetriScheduler` (action = run node + route result) and `MarkingCodec`.
- `compiler/` — n8n workflow → `CompiledWorkflow` (one `PetriNet`, cached `PrecompiledNet`,
  `NetMap` transition ↔ node, place ↔ (node, port)). Takes a structural description, no n8n
  dependency.
- `verify/` — properties over the compiled net; counterexample → node path.
- `conformance/` — trace recorder, differ, junit → matrix report.

## Memory / process

Decisions go in `docs/adr/`. Open work goes in `tasks/todo.md`. Divergences from n8n go in
`docs/divergences.md`.
