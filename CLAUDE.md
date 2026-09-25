# CLAUDE.md

Guidance for Claude Code when working in the n8n-libpetri repository.

## Project overview

n8n-libpetri is an alternative intra-workflow scheduler for n8n, registered through the seam the
two patches under `patches/n8n/` add. It models an execution as a Coloured Time Petri Net built
on [libpetri](https://github.com/debe/libpetri) `typescript/`, so the scheduling model is
available to analysis as well as to execution. n8n keeps node execution, persistence, hooks,
webhooks and queue mode. There is no n8n source fork: `.n8n/` is a gitignored clone at a pinned
commit, and the patches add an extension point rather than changing behaviour — patch 0001
extracts n8n's existing loop as `StackScheduler` behind a `WorkflowScheduler` interface, patch
0002 adds the registry. With nothing registered, n8n runs its own loop exactly as before.

The architecture, the model (emission rule, per-node gadget, join gadget, retries, halt,
budget, marking codec) and the design principles live in the root
[`README.md`](README.md). It is the single source of truth; read it before structural changes.

## Hard rules

- Every transition carries a real `Out` spec. Never `null`, never `skipOutputValidation`.
- One net serves execution and verification. No separate "verification net".
- The net decides what runs. No host-side dispatch queue, permit gating or scheduler policy.
- The scheduler runs the net to quiescence and stops it only through `close()`. libpetri's
  `run(ms, 'close')` is sound but is *not* n8n's timeout: `shouldStopExecuting()` sets
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

`libpetri@^7.0.0`, an ordinary registry dependency. The verifier's **surface** dates from 6.0.0,
and 7.0.0 is the floor for a soundness fix (below). The verifier calls that surface directly: `sinkPlacesWhen` conditional sinks [VER-014], the linear
state-equation bound [VER-015], the state equation with firing counters [VER-016], bounded
enumeration [VER-017] with `enumerationMaxClasses`, the state-equation and firing-bound phases
[VER-018] / [VER-019], open-net contracts [VER-022], `semiflowInvariants('auto')`,
`SmtVerificationResult.route`, and the canonical state-class key that five pinned class counts
rest on. The compiler and the verifier both depend on those semantics; do not downgrade.
`verify()` checks the surface at entry (`assertLibpetriSurface`) and refuses an install that
predates it, because the alternative is a report that closes with every proof silently missing.

VER-018 / VER-019 are in `REQUIRED_VERIFIER_METHODS` even though nothing calls them — they are
default-on, so an install without them does not fail, it just stops proving things: measured
2026-09-16, every fallback proof on every fixture carried method `state-equation`, and without
the phases `switch20` and `chain40` return nothing at all above k = 2
([`tasks/libpetri-handover-2026-09-16.md`](tasks/libpetri-handover-2026-09-16.md)).

**What the 6.0.0 major changed under us.** [TIME-012] restarts a transition's clock when a
firing takes its input or read token and puts one back, and the state-class graph now also
requires enablement in `M - Pre(t)` ([VER-010] AC4) — so verdicts on timed nets with a
consume-and-return or a reset refresh *can* move, and we have both (`delayed(waitBetweenTries)`
in the failure chain, `all(X/hasdata)` in the join's start). Immediate transitions also move
later in FIFO order within their priority, and `stateEquation(true)` now gives a place drained
by `all()` / `atLeast()` an upper bound in the HORN encoding, so its scripts change. Measured
2026-09-17 against released 6.0.0: suite 1075/1075 across 79 files, typecheck clean, and the
200-template survey compiles and verifies 200/200 with no timeouts. Nothing moved for the
shapes we have — that is not a general result, and a new timed shape is not covered by it.

**Why 7.0.0 is the floor.** 7.0.0 fixed [VER-020] AC4: with enumeration off, the structural
deadlock shortcut could prove a net that is dead at its initial marking. Our whole-net
`deadlockFree` fallback runs in exactly that configuration (`enumerationMaxClasses(0)`), and 75
of the 279 checks on the testbed workflows are proven there by method `structural`. No method
marks the fix, so `assertLibpetriSurface` still probes the 6.0.0 surface and `package.json`
carries the floor. The ν fixes in the same release (VER-006 AC7/AC8, NU-051 AC7) cannot reach
us: we compile no `matchSpec` and no environment places (`assertMatchBlind`). Measured
2026-09-25 against released 7.0.0, compared with 6.0.0 on the same machine:
- suite 1075/1075;
- the 200-template survey identical in outcome, hash, budget and every verdict;
- the forced SMT fallback on the 11 testbed workflows identical in verdict, route and method
  (279 checks);
- conformance identical at k = 1, 2 and 4.

Nothing moved. Terminal places ([EXEC-042]) and `terminationReason()` are not used yet.

`scripts/link-libpetri.sh` points `node_modules/libpetri` at a sibling libpetri checkout, for
the periods when this repository is again the first consumer of an unreleased surface. It is
**not** the current state, and a number produced against a linked tree is not comparable with
one produced against the registry; say which a measurement used.

### n8n conformance (`scripts/`)

```bash
scripts/bootstrap-n8n.sh      # clone n8n @ pinned commit into .n8n/, pnpm via corepack, build, baseline
scripts/run-conformance.sh    # run the execution-engine suite under both engines, emit the matrix
scripts/verify-patch.sh       # re-apply patches to the pinned commit; fails on drift
```

Pinned n8n: the release `n8n@2.41.3` (`7f7a8ac`), defined once in `scripts/n8n-pin.sh`.
`scripts/check-n8n-drift.sh` reports, read-only, whether the patches still apply to `stable`,
`beta`, the newest release and master, and what touched the seam or engine v2 since the pin.

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
scripts/testbed/n8n-testbed.sh          # real n8n editor on the net at http://127.0.0.1:5678
scripts/testbed/n8n-testbed.sh --queue  # EXECUTIONS_MODE=queue: a producer and a worker on Redis
scripts/testbed/diff-engines.sh         # both engines in a live server, compared on data and order
scripts/testbed/browser-check.sh        # drive the editor, screenshot the canvas
```

The engine reaches a running server through an `--import` preload (`scripts/testbed/preload.mjs`),
not the vitest shim. In queue mode the **worker** gets the same preload and the launcher gates on
`scheduler registered` appearing in the worker's log: the main process never constructs a
scheduler for a queued execution, so a worker without the engine would silently run n8n's own
stack loop. It rebuilds `packages/core` when `dist` is older than the patched source,
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

- `index.ts` — the package root: `PetriScheduler`, the marking codec and the n8n adapter.
- `compiler/` — n8n workflow → `CompiledWorkflow` (one `PetriNet`, cached `PrecompiledNet`,
  `NetMap` transition ↔ node, place ↔ (node, port)). Takes a structural description, no n8n
  dependency. `analysis/` holds the phases of `analyse()`, `gadget/` the phases of the per-node
  gadget and `types/` the types by audience. `names.ts` is the one vocabulary every place and
  transition name comes from; `errors.ts` has `CompileError` and `InternalCompilerError`.
- `scheduler/` — `PetriScheduler` and its transition actions. `run-loop.ts` mirrors n8n's loop,
  `outcomes.ts` turns an outcome into the tokens a firing deposits and `round.ts` runs agent
  rounds (ADR 0008). `payloads.ts` is the token vocabulary the codec shares.
- `codec.ts`, `codec/` — the marking codec: n8n's execution state ↔ a marking (ADR 0005).
- `n8n/` — `host.ts` mirrors patch 0001's interfaces; `adapter.ts` turns an n8n `Workflow`
  into a compiler description.
- `verify/` — properties over the compiled net; counterexample → node path. `families/` has one
  module per property family, and `route.ts` decides how each query is answered.
- `conformance/` — trace recorder, differ, harness, junit → matrix report.
- `cli/` — the I/O, flag parsing and exit handling the command lines share.
- `internal/` — cross-layer helpers (`assertNever`, `messageOf`, unit tokens).

## Memory / process

Decisions go in `docs/adr/`. Open work goes in `tasks/todo.md`. Divergences from n8n go in
`docs/divergences.md`.

<!-- code-graph-mcp:begin v2 -->
## Code Graph (repo-wide AST index)

AST + FTS + vector index of the whole repo — prefer over multi-round Grep/Read for
structural queries (LSP only sees open files; this sees everything). Fastest path = Bash CLI:

| Intent | Command |
|--------|---------|
| Who calls X / what X calls | `code-graph-mcp callgraph X` |
| Impact before editing a fn | `code-graph-mcp impact X` |
| Unfamiliar dir / module | `code-graph-mcp overview <dir>` |
| Symbol source / signature | `code-graph-mcp show X` |
| Concept search (no exact name) | `code-graph-mcp search "…"` (vector: MCP `semantic_code_search`) |
| grep + AST context | `code-graph-mcp grep "pat" [paths] [-t lang] [-g glob] [-c]` |

Not on PATH? A plugin-only install keeps its own copy — same commands, run
`~/.cache/code-graph/bin/code-graph-mcp` (or `npm i -g @sdsrs/code-graph` once).

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
