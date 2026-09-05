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
- [ ] libpetri engine leg of `run-conformance.sh` is untested until M2 produces
      `typescript/dist/n8n-vitest-setup.js` (currently reports "skipped")
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
- [ ] `PetriScheduler` + `MarkingCodec`, v1 only, cancellation via `close()`
- [ ] `typescript/dist/n8n-vitest-setup.js` registering `PetriScheduler` via
      `setWorkflowSchedulerFactory` (patch 0002) so `run-conformance.sh` runs both engines
- [ ] Data equivalence + happens-before on the fixture set at k = 1; divergence register complete

## M3 — Concurrency + differential report
- [ ] k > 1 under the safety check; lineage-step copy; differ over both engines

## M4 — Verification
- [ ] `verify(workflow)`: proper completion (per join input), dead nodes, exclusion, bounds,
      ≤ maxTries
