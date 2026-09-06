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
- [x] k > 1 halt snapshot race (bounded): the marking snapshot is taken inside the halting
      action, so a token another node's `X_start` consumes between that instant and the `_halt`
      deposit is encoded as a pending entry too — one duplicated stack entry on resume.
      Impossible at k = 1. Guarded for `X_start` in M3 (per-node start counters against the
      snapshot's counts, FIFO drop); the `X_skip` half is still open, see M3
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
- [x] The conformance leg only runs at k = 1 (`N8N_LIBPETRI_BUDGET` defaults to 1). Every k > 1
      path is covered by `FakeHost` tests only. M3 should add a budget leg; expect #12-class
      order failures to multiply, so the headline will need the data-equivalence-only variant —
      done in M3: `run-conformance.sh --budget=N`, compared against the k = 1 libpetri leg so the
      matrix shows what the budget changed; only 2 regressions at k = 2 and k = 4
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
- [x] k > 1 under the safety check: the `_budget` place carries `k` unit tokens, the compiler
      lowers `k` to 1 (with a diagnostic) on a cycle or a multi-producer input index, and
      `PetriScheduler.maxInFlight` reports what was used
- [x] Lineage-step copy: analysed rather than added — n8n's `addPairedItemLineage` already
      `.map()`s to fresh shallow copies and every in-place stamp is on the node's own fresh
      output, so no two concurrent activations can write the same object. The rule "input items
      are read-only" is documented instead; aliasing table, options and costs in ADR 0006, proof
      in `tests/scheduler/payload.test.ts` (an in-place-stamping host is shown to break at k = 2)
- [x] The three hazard verdicts: the `waitTill` claim was a real defect (claimed on reaching the
      recording path, not on the node's own resolution) and is fixed; the halt snapshot race is
      bounded and guarded for `X_start`; an in-flight sibling at halt/pause is correct and
      divergent (EXEC-040, row #17)
- [x] `state.executionError` split into a write-once halt error and a completion-ordered leftover
      (row #19); pinned by `tests/scheduler/execution-error.test.ts`, verified failing pre-fix
- [x] Differ over both engines (`src/conformance/{harness,stack-reference,differ,differ-cli}.ts`,
      `docs/differential.md`): a port of n8n's own loop against the net under one host, compared
      on data, happens-before and attributed ordering. 23 fixtures × k ∈ {1, 2, 4}: 0 fail,
      0 unattributed, 0 novel mechanisms, 0 unobserved edges
- [x] Benchmark (`npm run bench`): the headline claim holds — two independent 500 ms branches
      take 507 ms at k ≥ 2 against n8n's 1006 ms, every fan-out cell is `ceil(width/k) × 500 ms`,
      a chain with nothing to win is within 0.2 % at every k, and the net costs ~16 µs per node
      over n8n's loop warm
- [x] Data equivalence at k > 1 measured three ways (n8n's suite per budget, the differ, and the
      committed `tests/conformance/budget-equivalence.test.ts` gate) — identical `runData`,
      resumable state and scheduler contract at k ∈ {1, 2, 4, 8}, the halting execution excepted
      (row #17). `docs/conformance-m3.md`
- [x] Register at 21 rows (#19, #20, #21 new; #1, #11, #17 widened); every row M3 observed
      promoted from `proposed` to `designed`, #18 alone left `proposed` because no harness here
      can measure it. ADR 0006 added

### M3 open items (from the track reports)
Behaviour a user can see
- [ ] Divergence #17 is the one k > 1 behaviour change with a user-visible shape: a
      `responseMode: responseNode` webhook answers the caller at k ≥ 2 where n8n's `break` would
      have left it unanswered. The recommendation ("keep k = 1 where a failure must suppress a
      ready sibling") is in the register and the report, but nothing enforces or warns about it —
      the compiler's k-safety check does not consider it
- [ ] Divergence #18 (`currentNodeUsedDynamicCredentials` / `…Attempted…` not node-scoped above
      k = 1) is unfixable from the scheduler — the write is inside n8n's credential layer and the
      window spans an await we do not own — and invisible to this harness, since `FakeHost` does
      not mirror that layer. Either keep k = 1 for such workflows or upstream a per-activation
      scope into `WorkflowExecute`. The differ deliberately excludes both fields from
      `comparableTask` rather than compare two `undefined`s
- [ ] Divergence #15 residual: a node that sets `runExecutionData.waitTill` and then keeps working
      while a sibling finishes loses the claim, and the execution resumes the sibling instead of
      the Wait node. Closing it needs a write barrier (`Object.defineProperty`) on the field plus
      `AsyncLocalStorage` (`node:async_hooks`) around `host.runNode`. Designed in ADR 0006, not
      built; pinned as a known limit in `concurrency.test.ts`
- [ ] `closeFunction` is last-writer-wins in n8n too, so above k = 1 "last" becomes completion
      order. Noted in ADR 0006, compared only as present/absent by the differ, and not registered
      as its own row — if a workflow can register two close functions it deserves one

Model / compiler
- [ ] The `X_skip` half of the halt-snapshot race is unguarded: `X_start` increments a per-node
      counter the snapshot subtracts, but `X_skip` is a structural transition with no bound
      action, so a skip consuming an `in_empty`/`ready_i` token inside the same ≤ 2-microtask
      window would be double-encoded. Two targeted experiments (400 runs sweeping sleep
      durations, 520 runs sweeping microtask offsets) failed to reach the window; not fixed
      blind, because a fix means binding an action to a structural transition and nothing here
      could pin it with a failing test. Recorded in `docs/conformance-m3.md`
- [ ] k-safety relaxation for self-serialising loops (a single-entry simple-cycle SCC with one
      single-firing tree producer plus one cycle producer — the canonical Loop Over Items) is
      specified with its proof obligations in ADR 0006 and not implemented: it needs a per-input
      order-determined/multi-firing analysis in `src/compiler/graph.ts`, changes
      `effectiveBudget` for cyclic fixtures and re-pins `tests/compiler/budget.test.ts`
- [ ] Divergence #20 (an OR-input arm transition costs a scheduling cycle, so a shallower sibling
      takes the budget unit in it and the net runs breadth-first where priority = DAG depth was
      meant to reproduce n8n's depth-first order). A fix would keep structural transitions out of
      the same scheduling round as real starts; data is unaffected

Harness
- [ ] The k > 1 conformance legs are compared against `conformance-results/libpetri.junit.xml`,
      which must therefore be produced first; the script checks neither its age nor its
      provenance, so a stale k = 1 artefact silently becomes the wrong reference
- [ ] The differ's candidate leg has no timeout — cancellation is `close()`-only and
      `run(timeoutMs)` is forbidden — so a net that never quiesces hangs it. The reference leg has
      a 10 000-activation valve; the candidate leg has only the fixtures' own bounds
- [ ] The row #17 attribution rule is coarse: any candidate-only activation in a halted, paused or
      cancelled run is attributed to it. A tighter rule needs the activation's trace start to fall
      after the halting activation's, and the halting instant is not observable from the trace
- [ ] The differ inherits every `FakeHost` gap (no `convertBinaryData`, no
      `handleNodeErrorOutput`, no `sendChunk` hook, no AI-tool rewire, no expression evaluation,
      so divergence #7's `$('Y')` shape cannot be reproduced). Its verdicts are about the two
      schedulers, not about `WorkflowExecute`; only the real conformance run covers the rest
- [ ] The randomised soak that backs the equivalence claim (per-node jitter, every fixture at
      k ∈ {2, 4, 8}, five seeds, ~2200 runs, zero findings) is not committed because it is
      wall-clock-dependent. Gating on it needs a seeded, timer-free formulation
- [ ] Timing-sensitive tests: `docs/differential.md`'s absolute benchmark numbers were measured at
      load average ~4 and are upper bounds (the ratios reproduce under load, the absolutes inflate
      3–5×); `concurrency.test.ts`'s wall-clock bounds and `tests/spikes/budget.test.ts` may be
      flaky on a loaded runner; `differ.test.ts`'s safety-valve case carries an explicit 20 s
      timeout for the same reason
- [ ] Still open from M1/M2: the classifier counts the six out-of-scope AI-agent "waiting tools"
      cases as loop-driving, so every headline needs the "excluding out-of-scope" restatement, and
      `webhook-respond-branch-order.test.ts` is classified as a helper although it drives the
      loop — which is why the second k > 1 regression lands in the helper column. Extend
      `LOOP_DRIVING_PATTERNS` deliberately and move the pinned counts

Upstream
- [ ] libpetri: `PrecompiledNetExecutor.getMarking()` caches `this.marking` on its first call and
      never invalidates it, so a second mid-run snapshot silently returns the first one's marking.
      The scheduler takes exactly one (`haltMarking ??=`) and the halt-snapshot logic depends on
      it being the one taken inside the halting action, so it is correct today only by accident —
      worth a fix or a doc note upstream

## M4 — Verification
- [ ] `verify(workflow)`: proper completion (per join input), dead nodes, exclusion, bounds,
      ≤ maxTries
