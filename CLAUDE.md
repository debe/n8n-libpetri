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
- The scheduler runs the net to quiescence and stops it only through `close()`. libpetri's
  `run(ms, 'close')` is sound (5.0.0) but is *not* n8n's timeout: `shouldStopExecuting()` sets
  the `status` / `timedOut` fields the caller reads, and n8n polls it between activations —
  see ADR 0004, "The timeout is n8n's, not the net's".
- Every n8n behaviour we do not reproduce is recorded in `docs/divergences.md`. No silent skips.
- An agent's `ai_tool` dispatch is a round in the net, not a host loop (ADR 0008). Only `ai_tool`
  reaches the scheduler; every other `ai_*` connection is resolved by `supplyData` inside
  `runNode` and the compiler is right not to model it.
- Reporting rule: only a minority of n8n's cases drive the scheduler loop — 44 of the
  execution-engine suite's 1657 (`src/conformance/classify.ts`), 44 of `packages/core`'s 2124,
  and none of `packages/workflow`'s or `packages/cli`'s. Headline numbers are loop-driving
  cases passed; pure-helper cases are stated separately. A scope whose tests never construct a
  scheduler is a patch-neutrality leg, not an engine result — say which one a number is.
  The live testbed (`scripts/testbed/`, `docs/testbed.md`) is neither: it is an integration
  harness, and its wall clocks and data-equivalence results are never conformance numbers.

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

### libpetri

`libpetri@^5.1.0`. 5.0.0 made [IO-015] an exact-explanation search (`And` unordered, an inner
`Xor` no longer pre-empting an enclosing one), split [VER-002] into strict `DeadlockFree` and
`TerminatesAtSink`, added the `run(ms, 'close')` timeout policy, and fixed sparse enablement at
bit 31. **5.1.0 is the floor** because the verifier calls its surface directly:
`sinkPlacesWhen` conditional sinks [VER-014], the linear state-equation bound [VER-015], the
state equation with firing counters [VER-016], bounded enumeration [VER-017] with
`enumerationMaxClasses`, `semiflowInvariants('auto')`, `SmtVerificationResult.route`, and the
canonical state-class key that five pinned class counts rest on. The compiler and the verifier
both depend on those semantics; do not downgrade. `verify()` checks the surface at entry
(`assertLibpetriSurface`) and refuses an install that predates it, because the alternative is a
report that closes with every proof silently missing.

### n8n conformance (`scripts/`)

```bash
scripts/bootstrap-n8n.sh      # clone n8n @ pinned commit into .n8n/, pnpm via corepack, build, baseline
scripts/run-conformance.sh    # run the execution-engine suite under both engines, emit the matrix
scripts/verify-patch.sh       # re-apply patches to the pinned commit; fails on drift
```

Pinned n8n commit: `441970b` (master; the release tag predates n8n's helper extraction).

### Node-type catalogue (`scripts/node-types/`)

```bash
node scripts/node-types/extract.mjs      # .n8n dist -> .node-types/catalogue.json
```

A workflow JSON export carries no node-type descriptions, so without a catalogue the verify CLI
**guesses** every port count from the connections — a lower bound, since an unwired output is
invisible in an export and one miscounted port changes the compiled net. The extractor reads
n8n's own generated `dist/types/nodes.json`, so the counts are n8n's. Ports declared by an
expression are *evaluated* against probes derived from that expression (its own parameter names,
its own string literals); a count that moves with a parameter is withheld and left to
`BUILT_IN_SHAPES`, which is parameter-aware. Anchors are asserted on every run — the catalogue is
generated, so nothing else would notice a probe that starts calling a router's variable output
count invariant. Measured on the 200-template corpus: **236 of ~5,114 nodes still guessed (4.6%)**,
against 4,805 (94%) before.

`canWait` is derived the same way — `known/nodes.json` names each node's built file, and that
directory is searched for `putExecutionToWait` — so the answer comes from the code that runs.

### Live testbed (`scripts/testbed/`)

```bash
scripts/testbed/n8n-testbed.sh     # real n8n editor on the net at http://127.0.0.1:5678
scripts/testbed/diff-engines.sh    # both engines in a live server, compared on data and order
scripts/testbed/browser-check.sh   # drive the editor, screenshot the canvas
```

The engine reaches a running server through an `--import` preload (`scripts/testbed/preload.mjs`),
not the vitest shim. It rebuilds `packages/core` when `dist` is older than the patched source,
because the server loads `dist` and `planEngineRequest` lives only in the patch. Everything
runtime is in the gitignored `.testbed/`. See `docs/testbed.md`.

### Verification

libpetri shells out to the `z3` executable (`PATH` or `LIBPETRI_Z3`, ≥ 4.8.0). Without it
verification returns `unknown`, never throws. CI installs z3 and fails if proofs become skips
(`tests/z3-gate.test.ts`); the `n8n-libpetri verify` CLI exits **3** when no solver resolved,
so a run that verified nothing is never mistaken for a clean one.

What the surface proves, what it cannot, and what it costs is measured in
[`docs/verification.md`](docs/verification.md) (ADR 0007). Two rules when touching it: report
only the direction the encoding licenses — a *witness* (a reachable node, a violated
exclusion) is a statement about a priority- and value-blind abstraction (VER-004), never a
proof — and never widen a check's claim past its query.

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
