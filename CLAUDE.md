# CLAUDE.md

Guidance for Claude Code when working in the n8n-libpetri repository.

## Project overview

n8n-libpetri is an alternative intra-workflow scheduler for n8n, registered through the seams the
four patches under `patches/n8n/` add. It models an execution as a Coloured Time Petri Net built
on [libpetri](https://github.com/debe/libpetri) `typescript/`, so the scheduling model is
available to analysis as well as to execution. n8n keeps node execution, persistence, hooks,
webhooks and queue mode. There is no n8n source fork: `.n8n/` is a gitignored clone at a pinned
commit, and the patches add extension points rather than changing behaviour:
- v1 (n8n's default engine): patch 0001 extracts n8n's existing loop as `StackScheduler` behind a
  `WorkflowScheduler` interface, and patch 0002 adds the registry. `PetriScheduler` runs the net.
- engine v2 (`packages/@n8n/engine`, maintained but not shipped, ADR 0015): patch 0003 extracts the settlement
  decision as a `SettlementPolicy` (`decideSuccessors` + `isFinished` over a read-only reader),
  and patch 0004 adds an engine-side registry read only in `createEngineRuntime`. The net-backed
  policy is `createSettlementPolicy` in `src/settlement/` (ADR 0014).

With nothing registered, n8n runs its own loop and its own planner exactly as before.

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
- **The compile profile follows the engine (ADR 0015).** With no profile named, `compile()`,
  `analyse()`, `verify()` and the JSON loader compile for `v1`, and they never guess the engine.
  The verify CLI defaults to `--profile auto`: `engineV2` when the workflow's
  `settings.engineType` is `'v2'`, `v1` otherwise (`profileForWorkflow`), and the report states
  the profile it used. Runtime consumers still name their profile (`compileCached` names `'v1'`,
  `src/settlement/` names `'engineV2'`). v1 gets the product work; its net is pinned
  byte-identical by `tests/compiler/v1-identity.test.ts`. Engine v2 stays in the repository,
  maintained and tested, and is left out of the install path, the Docker image and their docs
  (ADR 0015 scope amendment).
- **Licensing and publishing (owner's decision, 2026-10-04).** Files derived from n8n
  (`patches/n8n/*`, `typescript/seams/**`, n8n's layers in the image) stay under n8n's
  Sustainable Use License, with their `NOTICE` files; everything else is Apache-2.0
  (`package.json`: `Apache-2.0 AND LicenseRef-n8n-sustainable-use`). Never relabel a derived
  file, drop a `NOTICE` or narrow the licence string. The package stays `"private": true` and
  nothing is published (no `npm publish`, no image push, no upstream post) until the owner signs
  off (`tasks/inject-plan.md`, "Licensing and publishing preconditions"; `tasks/todo.md` §10).
- **The engine v2 policy has no fallback to n8n's planner** (ADR 0014, plan decision 8). A compile
  refusal, a `CodecError` or a malformed store answer is a `settlement policy error` and a throw,
  and the execution stays `running` (divergence row 38). Named races (a failed row, a cancelled
  row with no failed one) answer ∅ and not finished, each with a divergence row. Patches 0003/0004
  keep n8n's decision core byte-identical; the golden accepts only the handler hash 0003 gives
  (`GOLDEN_SEAM_PATCHED_DIST`). Never re-record the golden to make a change pass.
- An agent's `ai_tool` dispatch is a round in the net, not a host loop (ADR 0008). Only `ai_tool`
  reaches the scheduler; every other `ai_*` connection is resolved by `supplyData` inside
  `runNode` and the compiler is right not to model it.
- Reporting rule: only a minority of n8n's cases drive the scheduler loop. At the pin `944afe5`
  that is 45 of the execution-engine suite's 1,756 (`src/conformance/classify.ts`), 45 of
  `packages/core`'s 2,258, and none of `packages/workflow`'s or `packages/cli`'s
  (`docs/conformance-master.md`). Headline numbers are loop-driving
  cases passed; pure-helper cases are stated separately. A scope whose tests never construct a
  scheduler is a patch-neutrality leg, not an engine result — say which one a number is.
  The live testbed (`scripts/testbed/`, `docs/testbed.md`) is neither: it is an integration
  harness, and its wall clocks and data-equivalence results are never conformance numbers.
  Engine v2 has four kinds, never pooled (`tasks/v2-seam-plan.md` decision 12): **neutrality
  legs** (patched, nothing registered, against the unpatched baseline), **policy-entering cases
  passed** (counted per case by the entered counter, `conformance/v2/entered.ts`; cases that
  never enter are labelled, not counted), **settlement evidence** (golden, differential, handler
  legs; not conformance numbers) and **integration results** (the `--v2` testbed).

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

`libpetri@^7.0.0`, an ordinary registry dependency; the lock pins 7.0.0 (`registry.npmjs.org`),
and `node_modules/libpetri` is the installed package, not a link. The engine v2 seam's stamps
(`tasks/v2-seam-plan.md`, steps 2–14: differential, golden, handler legs, settlement legs on
Postgres) record 7.0.0 from the registry, not linked. The neutrality legs load no libpetri. The verifier's **surface** dates from 6.0.0,
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
200-template survey (`--profile v1`, as all surveys were then) compiles 200/200 with no timeouts.
Nothing moved for the shapes we have — that is not a general result, and a new timed shape is
not covered by it.

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

Compiling is not verifying. At libpetri 7.0.0 (2026-10-02) the v1 survey decides at least one
check on 121 of the 200; the other 79 come back all `unknown` (k = 4, `--smt-fallback off`). The
engineV2 survey (`--profile engineV2`) compiles 91, decides something on 85, and refuses 109 (52 of them for
having several triggers, which the survey does not enumerate yet).

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

Engine v2 scopes (`--scope=`): `engine`, `compat`, `cli-v2` (unit, no Postgres) and `engine-int`,
`compat-int` (Postgres through testcontainers; Docker must be up, `scripts/pg-stamp.sh` records
the image id). `--engines=legacy` on these is the neutrality leg; `--engines=libpetri` is the
settlement leg (policy registered, `--settlement-mode=primary|shadow|primary-shadowed`). The
`-int` legs were measured with `--maxWorkers=1` on a 0.95 GB Docker VM. `verify-patch.sh` must
leave `.n8n` at the detached pin with 0001–0004 applied and no commits or branches.

Pinned n8n: master `944afe5` (2026-10-02; ADR 0013 decision 1, kept by ADR 0015), defined once
in `scripts/n8n-pin.sh`. The installer targets released n8n-core versions instead, one seam
manifest each under `typescript/seams/n8n-core/` (2.41.4 for n8n 2.41.5/2.41.6, 2.42.2), each
with its own neutrality record (below).
`scripts/check-n8n-drift.sh` reports, read-only, whether the patches still apply to `stable`,
`beta`, the newest release and master, and what touched the seam or engine v2 since the pin.

### Install path (v1 only, ADR 0015)

```bash
n8n-libpetri install | uninstall | status | env      # the package bin; docs/install.md
node scripts/release/build-seams.mjs [--check] n8n@2.41.5 n8n@2.41.6 n8n@2.42.2   # seams from .n8n tags
scripts/release/neutrality.sh n8n@<version>          # release neutrality, one tag; docs/conformance-release.md
scripts/release/e2e-npm.sh <work-dir> <tarball.tgz>  # a real npm i -g n8n, end to end (local)
scripts/docker/build.sh [n8n-version]                # local image from npm pack; nothing pushed
scripts/docker/smoke.sh <version>                    # seven legs, one container at a time
```

The installer patches the `n8n-core` an installed n8n loads with patches 0001/0002, rebuilt per
release as copy/insert deltas plus regenerated maps (`typescript/seams/n8n-core/<version>/`),
after checking the sha256 of every file it replaces or creates. `typescript/hook/n8n-preload.mjs`
is the `NODE_OPTIONS` `--import` preload that registers the scheduler (`preloadFromEnv`,
`src/n8n/boot.ts`) before n8n runs anything, and only in n8n's own command on its main thread;
`typescript/hook/n8n-hook.cjs` is the `EXTERNAL_HOOK_FILES` entry and only confirms the
registration (`confirmBooted`). **Never register from the hook file:** n8n `start` can resume an
overdue wait before it loads hook files (divergence row 40, fixed by the preload). Both do
nothing unless `N8N_EXECUTION_ENGINE` is non-empty. **A change to patch 0001 or 0002 means regenerating the
seams (`build-seams.mjs`) and re-running `neutrality.sh` for every shipped manifest:**
`tests/install/seams.test.ts` pins each manifest to the committed patches' sha256, a changed
`after` hash resets a manifest's `neutrality` record to null, and `install` refuses such seams
without `--allow-unverified`. `hook-dist.test.ts` needs `npm run build`; CI runs it after the
build with `N8N_LIBPETRI_REQUIRE_DIST=1`. The e2e, the image smoke legs and neutrality runs are
release steps outside CI; the first two are integration results, and a neutrality run is a
patch-neutrality leg, never an engine result.

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
scripts/testbed/n8n-testbed.sh --v2 --settlement=primary   # engine v2 with the net-backed policy
scripts/testbed/diff-engines-v2.sh      # off, primary, shadow, primary-shadowed, compared over SQL
```

`--v2` needs Docker: `scripts/testbed/pg.sh` runs the engine's Postgres data plane
(`postgres:18.4-alpine`, 384 MB cap); n8n's main database stays sqlite. The preload's v2 branch
resolves `@n8n/engine` from `packages/cli`, refuses to boot without `setSettlementPolicy`, and
registers on the main thread only; the launcher gates on `settlement policy registered`. State is
`.testbed/v2/`. v2-only workflows live in `scripts/testbed/workflows-v2/`, outside `workflows/`,
so `v1-identity` does not fingerprint them.

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
(`tests/z3-gate.test.ts`); the `n8n-libpetri verify` CLI exits **3** when no solver resolved (v1) or when no check was
decided (engineV2). A v1 run whose checks all came back `unknown` with z3 present still exits 0:
the survey separates those runs itself (`scripts/templates/survey-outcome.mjs`).

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
- **Two compile profiles.** `compile(…, { profile: 'engineV2' })` targets n8n's engine v2
  (ADR 0012). `buildNodeGadget` is the single switch, into `compiler/gadget/settlement/` (v2's
  settlement rule as arcs), with `compiler/analysis/engine-v2/` for n8n's converter (ported:
  `root.ts`, every n8n throw site mapped in `refusals.ts`), loops and refusals. The v1
  net must stay byte-identical: `tests/compiler/v1-identity.test.ts` pins it; never regenerate
  its recording to make a change pass. `codec/v2/` decodes v2 step rows into a marking and plans
  from it (the stateless planner). `conformance/v2/` holds the reference loop, with n8n's code
  injected (`src/` never imports `.n8n`), the differential and the CI golden. Plan and deviations
  are in `tasks/v2-profile-plan.md`.
- `scheduler/` — `PetriScheduler` and its transition actions. `run-loop.ts` mirrors n8n's loop,
  `outcomes.ts` turns an outcome into the tokens a firing deposits and `round.ts` runs agent
  rounds (ADR 0008). `payloads.ts` is the token vocabulary the codec shares.
- `codec.ts`, `codec/` — the marking codec: n8n's execution state ↔ a marking (ADR 0005).
- `n8n/` — `host.ts` mirrors patch 0001's interfaces; `adapter.ts` turns an n8n `Workflow`
  into a compiler description. `boot.ts` (`bootFromEnv`, tsup entry `n8n/boot`) is the one boot
  path the hook and the testbed preload share: it reads `N8N_EXECUTION_ENGINE` and the knobs,
  resolves n8n-core, refuses a core without the seam or one that drifted from the install
  record, and registers `PetriScheduler`. `v2-host.ts` mirrors patches 0003/0004's types, and
  `v2-graph.ts` turns an engine v2 `WorkflowGraph` into a description (a configless `v1-node`
  is an opaque step).
- `settlement/` — the net-backed engine v2 `SettlementPolicy` (ADR 0014): `policy.ts`
  (`createSettlementPolicy`, snapshot reuse per settlement), `rows.ts` (the scoped read),
  `scope.ts` (`candidateKeys`, n8n's per-key order; `isFinished`), `compile-cache.ts`,
  `shadow.ts` and `register.ts`. `codec/v2/frontier.ts` decodes the bounded frontier. Package
  entries `n8n-v2` and `n8n-v2-vitest-setup`. Plan, falsifiers and deviations:
  `tasks/v2-seam-plan.md`.
- `verify/` — properties over the compiled net; counterexample → node path. `families/` has one
  module per property family, and `route.ts` decides how each query is answered.
- `conformance/` — trace recorder, differ, harness, junit → matrix report.
- `cli/` — the I/O, flag parsing and exit handling the command lines share. `main.ts` is the
  package `bin`; `dispatch.ts` routes `install | uninstall | status | env` to `install/cli.ts`
  and everything else to `verify`.
- `install/` — the installer (ADR 0015, `tasks/inject-plan.md`): `locate.ts` (n8n and its one
  n8n-core), `manifest.ts` (seam manifests, path guards), `delta.ts` (copy/insert codec),
  `plan.ts` (every output built and hash-checked before a write), `apply.ts` (install and
  uninstall, crash-safe order), `record.ts` / `lock.ts` (state in `<n8n-core>/.n8n-libpetri/`:
  record, journal, lock, backups), `status.ts`. Outside `src/`: `typescript/hook/` (the hook
  file) and `typescript/seams/` (shipped seams, n8n's licence, `NOTICE`).
- `internal/` — cross-layer helpers (`assertNever`, `messageOf`, unit tokens).

## Memory / process

Decisions go in `docs/adr/`. Open work goes in `tasks/todo.md`. Divergences from n8n go in
`docs/divergences.md`.

