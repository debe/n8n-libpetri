# n8n-libpetri — milestones

## M0 — Repository
- [x] Scaffold from adk-libpetri conventions, TypeScript package skeleton, CI
- [x] `debe/n8n-libpetri` created

## M1 — Compiler, confirmations, n8n bootstrap + patches
- [x] Track A: `src/compiler` — SCC + emission rule, per-node gadget (routed `X_run`/`X_route`,
      split routing above 3 outputs), join gadget (slot form, enumerated chooseBranch, partial
      `requiredInputs`, dead joins), OR-inputs (rounds), retry gadget (n8n `getRetryParams`
      clamping), halt + reap, expression references (read / seeded / unguarded), k-safety
      budget, NetMap, `joinReadyPlaces`, structural hash v3, dotExport (347 tests, 23 files)
- [x] Track B: `tests/spikes` — 8 spike files + z3 gate pin every derived fact (Out spec
      validation order, join gadget, budget/idle, priority-depth, verification, halt, retry,
      emission on cycles); ADRs 0002–0005
- [x] Track C1: `scripts/bootstrap-n8n.sh`, unpatched junit baseline (1657 cases / 75 files,
      0 failures) under `conformance-results/`
- [x] Track C2: patches 0001 (extract scheduler loop) / 0002 (scheduler registry),
      `scripts/verify-patch.sh`, `scripts/run-conformance.sh`, `src/conformance` harness
      (junit reader, loop-driving classifier 36/1657, matrix, Markdown report, CLI);
      patched suite byte-identical to baseline after normalisation
- [x] Integration: `npm run check && npm test && npm run build` green, `verify-patch.sh` applies
      both patches cleanly on `441970b`

### M1 open items (from the track reports)
Docs
- [ ] README "OR-inputs": add `read(X/idle)` to `X_skip` and `X_clear` (the compiler needs it —
      without it an all-delivered round skips while the run it started is still in flight;
      reproduced on both executors, see `tests/compiler/or-input.test.ts`)
- [ ] ADR 0003 "one arm per edge" wording for input-side OR is superseded for single-input nodes
      by the README round form; note the ran_i residue on cyclic OR nodes
- [ ] `docs/divergences.md`: record the `X/ran_i` residue for cyclic OR nodes and that the OR
      round form applies to single-input-index nodes only (multi-input nodes keep slot joins)
- [ ] `docs/divergences.md` #4: confirm the slot-overwrite clobber path in
      `addNodeToBeExecuted` (440–851) before citing it as a data-loss defect; ADR 0003 defers
- [ ] `scripts/README.md`: mark `run-conformance.sh` and `verify-patch.sh` as done
- [ ] `patches/n8n/*.patch` carry `From <sha>` lines of temporary commits; regenerating changes
      the hashes, not the diff (procedure in `patches/n8n/README.md`)

Compiler / model
- [ ] Cyclic OR node (n ≥ 2 tree producers plus a cycle-edge producer): cycle-triggered runs
      leave `X/ran_i` markers after the round closes, so a later all-empty round does not skip.
      Rare shape; flagged, not modelled
- [ ] `X_start_unmet` priority is depth−1 (−1 for a depth-0 node); shift all priorities by +1 if
      any consumer assumes non-negative priorities
- [ ] Choose-branch node whose required inputs are all fed by cycle edges gets no skip; unlisted
      empties land on `ready_i` and `X_start` fires with them
- [ ] Retry at k > 1 holds `_budget` across the wait (a waiting node counts as running);
      revisit if retry-heavy workflows starve siblings
- [ ] `switch20` fixture: "< 100 flat branches for the whole net" is infeasible (leaf nodes alone
      total 100); pinned as Switch 45, net 151
- [ ] Upstream libpetri: nested-xor validation depends on child order inside `and`
      (IO-015 defines And as unordered); Java/Rust validators unchecked for the same behaviour

Conformance / M2 hand-over
- [ ] M4: query `joinedOrDeadLettered` per join input on `X/ready_i`, not only on edge places
      (the arm transition drains the edge place; the stranded token sits on `ready_i`)
- [x] libpetri engine leg of `run-conformance.sh` is untested until M2 produces
      `typescript/dist/n8n-vitest-setup.js` — done in M2, both legs run
- [ ] Loop-driving classification is the explicit 36-case list; retryOnFail, cancellation,
      destination filtering, resume-hook and sub-workflow describe blocks in
      `workflow-execute.test.ts` also drive the loop but count as helpers — extend
      `LOOP_DRIVING_PATTERNS` deliberately and move the pinned counts
- [ ] n8n suite is load-sensitive (507 s and one 5 s timeout at load avg > 20); run conformance
      idle or raise the vitest timeout via a config override
- [ ] Node ≥ 25 ships no corepack: bootstrap falls back to `npx --yes corepack@0.36.0`;
      offline machines need `npm i -g corepack`
- [ ] junit comparisons must normalise time/timestamp/hostname, drop `<system-out>` and compare
      per suite/case name (vitest lists suites in completion order under parallel forks)
- [ ] `bootstrap-timings.tsv` has `# run N` marker lines; parsers must skip `#` lines
- [ ] `tests/spikes/budget.test.ts` upper timing bounds (k=2 < 380 ms, k=1 < 800 ms) may be
      flaky on a loaded CI runner

## M2 — Engine
- [x] Track D: `src/scheduler` — `PetriScheduler` (one net, action = run node + route result, no
      host-side dispatch queue), `src/n8n/host.ts` (structural mirror of patch 0001's
      `SchedulerHost` / `WorkflowScheduler` / hooks), `src/n8n/adapter.ts` (n8n `Workflow` →
      compiler description, `startNodesOf`), `src/n8n/register.ts` + `src/n8n-vitest-setup.ts`,
      v1 only (v0 delegates to the injected `StackScheduler`), cancellation via `close()` only
- [x] Track D: compiler additions for the engine — `startNodes`, `_pause` control terminal,
      waiting/stopped alternatives on `X_run` / `X_exhausted`, roles on `NetMap`, hash v4
- [x] Track E: `src/codec.ts` — `decodeExecutionData` / `encodeMarking` complete (multi-entry
      stacks, `waitingExecution` decode, join slots, OR rounds, retry/waiting/stopped tokens,
      modes `pause` / `cancelled` / `stranded`); property round trip at 200 seeds × 16 fixtures
- [x] Fix pass: pause-during-cancellation mode, halt/fatal write-back of the reaped pending
      stack, transient retry error no longer leaking into `executionError`, per-node `waitTill`
      claim, stop polled once per entry, soft-failure re-run = n8n's inner `while`, decode
      diagnostics surfaced
- [x] `typescript/dist/n8n-vitest-setup.js` registering `PetriScheduler` via
      `setWorkflowSchedulerFactory` (patch 0002) so `run-conformance.sh` runs both engines
- [x] Data equivalence + happens-before on the fixture set at k = 1: libpetri leg 26/36
      loop-driving, 1619/1621 helpers, 12 regressions (8 out-of-scope AI-agent, 4 divergences,
      0 defect-open); legacy leg still identical to the baseline. `docs/conformance-m2.md`
- [x] Divergence register extended: #11, #12 (order), #13 (destination-stop pause), #14
      (`ensureInputData` false), #15 (k > 1 `waitTill` claim), #2 amended (one-off seed)

### M2 open items (from the track reports)
Model / compiler (outside M2's file sets)
- [ ] Divergence #11 (OR-input LIFO vs FIFO) is the one finding not fixable from the scheduler:
      n8n delivers the most recent arrival first, the net's `X/hasdata_i` is FIFO. Needs LIFO
      consumption in `src/compiler/gadget.ts` (and probably a libpetri newest-token arc).
      Until then "should run node twice when it has two input connections" stays red and the
      two runs of such a node are index-swapped
- [ ] OR-round resume stays approximate (ADR 0005): a round that ran only a filtered-out or
      no-output activation loses its `X/ran_i` marker and may skip after a pause; a second
      round of a node with unreachable producers double-counts the seeds (#8 / #10)

Scheduler
- [ ] k > 1 halt snapshot race (bounded): the marking snapshot is taken inside the halting
      action, so a token another node's `X_start` consumes between that instant and the `_halt`
      deposit is encoded as a pending entry too — one duplicated stack entry on resume.
      Impossible at k = 1
- [ ] `subNodeExecutionResults` is rebuilt per attempt; n8n creates it once per popped entry
      (`stack-scheduler.ts:53`) and passes the same populated object to every `runNode` of the
      retry loop. Invisible at k = 1 with the AI path out of scope; fixing it means carrying the
      object on the run/retry payload
- [ ] AI-agent `EngineRequest` / `EngineResponse` tool dispatch is out of scope by decision (the
      node fails with the declared `NodeOperationError`). 8 cases of
      `workflow-execute-process-process-run-execution-data.test.ts` fail on it; revisit in M3+

Conformance / harness
- [ ] The classifier counts 6 AI-agent "waiting tools" cases as loop-driving, dragging the
      headline from 26/30 to 26/36. Either add an out-of-scope exclusion list to
      `src/conformance/classify.ts` or keep stating both figures as `docs/conformance-m2.md` does
- [ ] Still open from M1: extend `LOOP_DRIVING_PATTERNS` deliberately (retryOnFail, cancellation,
      destination filtering, resume hooks, sub-workflows) and move the pinned counts
- [ ] The conformance leg only runs at k = 1 (`N8N_LIBPETRI_BUDGET` defaults to 1). Every k > 1
      path is covered by `FakeHost` tests only. M3 should add a budget leg; expect #12-class
      order failures to multiply, so the headline will need the data-equivalence-only variant
- [ ] `FakeHost` mirrors `WorkflowExecute` at `441970b` closely but not fully (no
      `convertBinaryData`, no `handleNodeErrorOutput`, no `sendChunk` hook, no AI-tool rewire
      paths); the real host is exercised only by the conformance run
- [ ] The generated vitest shim (`.n8n/packages/core/.n8n-libpetri-setup.mjs` and
      `vitest.libpetri.config.mts`) is left in the clone, covered by `.git/info/exclude`; it
      embeds an absolute `file://` URL and is regenerated if this checkout moves. It announces
      registration once per vitest worker on stderr
- [ ] The CLAUDE.md reporting rule still quotes "~146 cases / ~19 loop-driving"; the classifier
      selects 36 of 1657. Update the rule when the pattern list moves

## M3 — Concurrency + differential report
- [ ] k > 1 under the safety check; lineage-step copy; differ over both engines

## M4 — Verification
- [ ] `verify(workflow)`: proper completion (per join input), dead nodes, exclusion, bounds,
      ≤ maxTries
