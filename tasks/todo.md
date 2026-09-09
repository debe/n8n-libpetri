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

## M4 — Verification and the final conformance gate
- [x] Track J: `src/verify` — six property families over `compile(workflow).net` (proper
      completion per join input and per edge, dead nodes, no double activation, the budget bound
      plus its P-semiflow, the retry bound, mutual exclusion), counterexamples decoded into node
      paths, the `n8n-libpetri verify` CLI over a workflow JSON export, and `docs/verification.md`
      / ADR 0007 as the measured surface
- [x] Track K: the `_budget` refund moved to `X_done` (divergence #20 fixed), conformance scopes
      `execution-engine | core | workflow | cli | all`, the classifier's loop-driving denominator
      at 44, and `docs/conformance-final.md`
- [x] Fix pass: dead-node liveness reported `unknown` rather than `proven`, alternative trigger
      entry points no longer reported as dead, `--strict` and exit 3 with no solver, the engine
      **entered**-vs-registered counter per conformance leg, the arrival bound's two forms
      separated and re-measured, and README / ADR 0004 / `docs/differential.md` re-measured
      against the model change
- [x] Final integration: `npm run check && npm test` (44 files, 700 tests) `&& npm run build`
      green, `scripts/verify-patch.sh` clean, the conformance numbers re-measured for this
      report, `docs/state-of-the-project.md` written

## M5 — Solver-free verification
- [x] The state-class graph (VER-010) became the primary proper-completion route, with the
      `SmtVerifier` as the fallback for a graph that truncates; the `bounded` verdict quantifies
      the explored cyclic-run prefix rather than passing a truncation off as a proof

## M6 — libpetri 5.0.0: the two workarounds deleted
- [x] **The routed outcome is gone.** libpetri 5.0.0 made [IO-015] an exact-explanation search,
      so `X_run` carries the per-output routing in its own `Out` spec and marks `X/routed`;
      `X/ok` and `X_route` are deleted at or below `SPLIT_ROUTING_ABOVE` (3) connected outputs.
      Above the threshold the per-output split stays, because an `and` of k `xor`s flattens to
      `2^k` (IO-016). `X_done` is kept and unconditional, so the budget refund still lands one
      scheduling cycle after the edge tokens and divergence #20 stays fixed (ADR 0004's M6
      amendment; `tests/spikes/collapsed-outcome.test.ts`)
- [x] **The halt reap is gone.** `_halt_reap` and `_halted` are deleted; `_halt` is written once
      and never consumed, so it is the halted run's terminal marker and every start / retry-wait /
      exhausted / skip / arm / clear inhibits on it. That closed the race the reap introduced once
      `X_run` routed its own outcome (a sibling resolving in the same executor cycle lost its
      arrivals), and removed `state.haltMarking`, `haltStarts`, `haltPending` and
      `ExecutionEnv.snapshotMarking` with it
- [x] **The timeout poll stays.** libpetri's `run(ms, 'close')` is sound but is not n8n's
      timeout: `shouldStopExecuting()` sets the `status` / `timedOut` fields the caller reads to
      tell a timeout from a cancellation, and n8n polls it *between* activations. The stale
      "libpetri leaks the losing loop" rationale was replaced with this one in CLAUDE.md, the
      README and ADR 0004 ("The timeout is n8n's, not the net's")
- [x] Structural hash v5 → v7; the budget semiflow restated as
      `_budget + Σ_X(X/running + X/retry + in-flight_X) = k`, one law per output for a split node
- [x] Final integration: `npm run check && npm test` (48 files, 815 tests) `&& npm run build`
      green, `scripts/verify-patch.sh` clean; conformance re-measured (legacy 44/44 + 1613/1613
      identical; libpetri k = 1 35/44 + 1611/1613, 11 regressions; k = 2 32/44, 3 against k = 1);
      differential 49 pass / 20 divergent / 0 fail; the net-size and state-class reduction measured
      before/after and recorded in `docs/state-of-the-project.md`

## M7 — Agent tool dispatch
- [x] **`ai_tool` connections compile.** `WorkflowDescription` carries `toolConnections`; a node
      with an incoming `ai_tool` connection and no `main` producer compiles in the `tool` form —
      the ordinary node gadget with `T/in_tool` as its input side and the dispatching agent's
      `A/response` as its success branch. `toolConnectionsOf` reads them off
      `connectionsBySourceNode[*].ai_tool`; every other `ai_*` type stays invisible, because
      `supplyData` resolves those inside `runNode`
- [x] **The round is a fan-out with pending markers** (`patterns.md` §5): `A_done_req`,
      `A_dispatch`, `A_collect` (a genuine sink) and `A_resume`, with `A/queue` carrying the data
      and `A/pending` the count so no action decides "am I the last one". `X_run` gains a request
      outcome, phased through `A/routed_req` exactly as the success outcome is phased through
      `X/routed` (ADR 0008)
- [x] **The round budget is n8n's own number.** `A/rounds` is seeded from the agent's
      `options.maxIterations` (default 10), so the round cycle is *bounded* and the reachability
      graph closes: proper completion **proven** solver-free on `agentOneTool` (296 classes, 2 ms)
      and `agentTwoTools` (380 classes, 3 ms). `A_rounds_out` turns exhaustion into a designed
      pause rather than the stranding the verifier found
- [x] **The host builds, the net decides.** Patch 0001 adds `planEngineRequest` —
      `handleEngineRequest` without the `addNodeToBeExecuted` calls — and nothing is ever enqueued
      on n8n's stack; `FakeHost.addNodeToBeExecuted` still throws
- [x] **No `matchSpec` and no `freshName`**, on `nu-nets.md` §6's own criteria, with the three
      blocking findings recorded in ADR 0008. `state-class.ts` now refuses to build a graph for a
      net carrying a `matchSpec`, because it is the fallback and the fallback is not sound for
      quiescence
- [x] Conformance re-measured: execution-engine and core both **40/44 loop-driving** (from 35/44)
      with helpers back to 1613/1613 and 2080/2080, and **no restatement** — 4 regressions, all
      registered divergences. Divergences #22–#24 added

## M8 — The live testbed

- [x] **The engine runs inside the process n8n ships.** `scripts/testbed/preload.mjs` is the
      server-side equivalent of the vitest shim: an `--import` preload that resolves `n8n-core`
      and `n8n-workflow` through a `createRequire` rooted at `packages/cli/package.json` — the
      same realpath, so the same CJS registry instance `WorkflowExecute` reads — and calls
      `registerPetriScheduler`. It throws rather than falling back, and registration ("scheduler
      registered") is logged separately from entry (`ENGINE_ENTERED_DIAGNOSTIC`), because only an
      execution establishes the second
- [x] **`packages/core/dist` was stale and is now rebuilt by the launcher.** The server loads
      `dist`, not `src`, and the committed `dist` predated M7: no `planEngineRequest`, which is
      what an agent round calls. `n8n-testbed.sh` rebuilds through `.n8n/node_modules/.bin/tsc`
      + `tsc-alias` (no pnpm needed) when `dist` is older than the patched source, then asserts
      both `getWorkflowSchedulerFactory` and `planEngineRequest` are in the built file
- [x] **Two seeded workflows, both real n8n exports** (the repo previously had none — every
      fixture is a `WorkflowDescription` of structural stubs). *Concurrency Showcase*: 13 nodes,
      an If, a four-way fan of 1.2 s Code legs and three Merge joins, acyclic with one producer
      per input index so k-safety leaves the budget alone. *Agent · Two Tools*: AgentV3 with a
      Calculator and a Code tool over `ai_tool`, driven by `stub-llm.mjs`, a local
      OpenAI-compatible model with a fixed script — one `tool_calls` message naming both tools,
      then an answer, so the round is a genuine two-outstanding fan-out with no key or network
- [x] **Measured 2026-09-10, best of two, n8n 2.37.0 @ `441970b2`, Node 26.8.1**: Concurrency
      Showcase at legacy 4944 ms, libpetri k = 1 4944 ms, **k = 4 1284 ms**; Agent · Two Tools at
      131 / 129 / 130 ms. `runData` **identical** on every leg, all 14 (resp. 2) realised
      dependency edges respected, and the k = 4 order reordered exactly as expected — n8n runs
      `Merge AB` before it starts `Fetch C`, the net starts all four legs first
- [x] `diff-engines.sh` boots one server per engine (the preload reads the engine once, at start)
      and `run.mjs` drives `POST /rest/workflows/:id/run`, the editor's own manual-execution path.
      `tests/testbed/compare-run.ts` reuses `firstDifference`, `dependencyEdges`, `activationKey`
      and `executionOrder` from `src/conformance/differ.ts`; it lives under `tests/` so
      `npm run check` typechecks it and vitest does not collect it
- [x] `browser-check.sh` drives the editor with `agent-browser` — sign in, execute, wait for
      n8n's own success toast, screenshot the canvas — and fails if nothing entered the engine
- [x] `docs/testbed.md` records what it demonstrates and what it does not: it is an integration
      harness, not a conformance measurement, divergence #17 is unreachable on these two
      workflows, and the k > 1 agent leg exercises divergence #23 on purpose

**The plan through M8 is done.** Everything below is what it left open.

---

## Open

One list, most valuable first. Each item says what it is, why it is not done, and what closing
it needs. Nothing here is a regression: every item is either a known limit with a pinned test,
an upstream ask, or work that was specified and deliberately not built.

### 1. Behaviour a user can see

- [ ] **Divergence #17 has no guard.** At k ≥ 2 a `responseMode: responseNode` webhook answers the
      caller where n8n's `break` would have left it unanswered, because the net cannot un-start an
      action. The recommendation ("keep k = 1 where a failure must suppress a ready sibling") is in
      the register and the reports, but the compiler's k-safety check does not consider it and
      nothing warns. It is the one k > 1 behaviour change with a user-visible shape
- [ ] **Divergence #15 residual**: a node that sets `runExecutionData.waitTill` and then keeps
      working while a sibling finishes loses the claim, so the execution resumes the sibling
      instead of the Wait node. Closing it needs a write barrier (`Object.defineProperty`) on the
      field plus `AsyncLocalStorage` (`node:async_hooks`) around `host.runNode`; designed in
      ADR 0006, not built, pinned as a known limit in `concurrency.test.ts`
- [ ] **Divergence #18 is unfixable from the scheduler**: `currentNodeUsedDynamicCredentials` /
      `…Attempted…` are written inside n8n's credential layer across an await we do not own, so a
      sibling's reset can land between another node's resolution and its read. Either keep k = 1
      for such workflows or upstream a per-activation scope into `WorkflowExecute`. Invisible to
      this harness (`FakeHost` does not mirror that layer), which is why the row is still
      `proposed`
- [ ] **Divergence #11 (OR-input LIFO vs FIFO)** is the one conformance finding not fixable from
      the scheduler: n8n delivers the most recent arrival first, the net's `X/hasdata_i` is FIFO.
      Needs LIFO consumption in `src/compiler/gadget.ts`, and probably a libpetri newest-token arc.
      Until then n8n's "should run node twice when it has two input connections" stays red and the
      two runs are index-swapped
- [ ] **k-safety relaxation for self-serialising loops.** A single-entry simple-cycle SCC with one
      single-firing tree producer plus one cycle producer — the canonical Loop Over Items — is
      provably safe above k = 1. Specified with its proof obligations in ADR 0006; needs a
      per-input order-determined/multi-firing analysis in `src/compiler/graph.ts`, changes
      `effectiveBudget` for cyclic fixtures and re-pins `tests/compiler/budget.test.ts`. This is
      what would let the most common cyclic workflow in n8n use the budget at all

- [ ] **The testbed has no cyclic workflow.** Both seeded workflows are acyclic on purpose, so
      nothing there shows the compiler lowering `k` to 1 on a cycle and saying so. A Loop Over
      Items demo would make the honest half of the concurrency story visible in the editor
      rather than only in `docs/divergences.md` — and it is the shape the k-safety relaxation
      above would change
- [ ] **The testbed's happens-before check is millisecond-resolution.** A live server produces no
      `runNode` trace, so `tests/testbed/compare-run.ts` reads n8n's own per-task `startTime` and
      `executionTime`. Two activations inside the same millisecond cannot be ordered by it, so an
      inversion between two sub-millisecond nodes would not be seen. The `FakeHost` differ has a
      real sequence counter and does not have this limit; the live leg is the weaker instrument
      and should be read as such
- [ ] **`stub-llm.mjs` does not speak the Responses API.** The workflow sets
      `responsesApiEnabled: false` to avoid it, which is a documented step rather than a
      limitation of the engine — but it means the testbed never exercises whatever an
      `EngineRequest` looks like when it comes out of that path

### 2. Model and compiler corners

- [x] **The `X_skip` half of the halt-snapshot race is unguarded.** `X_start` increments a per-node
      counter the snapshot subtracts, but `X_skip` is a structural transition with no bound action,
      so a skip consuming an `in_empty` / `ready_i` token inside the same ≤ 2-microtask window
      would be double-encoded. **Closed in M6 by removal**: there is no snapshot and no reap, so
      nothing is reconstructed and a token another transition consumed is simply absent from the
      quiescent marking (ADR 0004, "The reap is gone")
- [ ] **Cyclic OR node** (n ≥ 2 tree producers plus a cycle-edge producer): cycle-triggered runs
      leave `X/ran_i` markers after the round closes, so a later all-empty round does not skip.
      Rare shape; flagged (divergence #10), not modelled
- [ ] **OR-round resume stays approximate** (ADR 0005): a round that ran only a filtered-out or
      no-output activation loses its `X/ran_i` marker and may skip after a pause; a second round of
      a node with unreachable producers double-counts the seeds (#8 / #10)
- [ ] **Choose-branch node whose required inputs are all fed by cycle edges** gets no skip;
      unlisted empties land on `ready_i` and `X_start` fires with them
- [ ] `subNodeExecutionResults` is rebuilt per attempt; n8n creates it once per popped entry
      (`stack-scheduler.ts:53`) and passes the same populated object to every `runNode` of the retry
      loop. **Now reachable**: since M7 an agent's resumed activation carries
      `metadata.subNodeExecutionData`, so a `retryOnFail` agent whose first attempt throws re-runs
      with a response rebuilt from the same metadata rather than the same object. Equal in content
      today because `collectSubNodeResults` is a pure read of `runData`; fixing it properly means
      carrying the object on the run/retry payload
- [ ] `X_start_unmet` priority is depth − 1 (−1 for a depth-0 node); shift all priorities by +1 if
      any consumer assumes non-negative priorities
- [ ] Retry at k > 1 holds `_budget` across the wait (a waiting node counts as running); revisit if
      retry-heavy workflows starve siblings
- [ ] `closeFunction` is last-writer-wins in n8n too, so above k = 1 "last" becomes completion
      order. Noted in ADR 0006, compared only as present/absent by the differ, and not registered as
      its own row — if a workflow can register two close functions it deserves one
- [ ] Divergence #4: confirm the slot-overwrite clobber path in `addNodeToBeExecuted` (440–851)
      before citing it as a data-loss defect; ADR 0003 defers

### 3. Verifier

- [ ] **`semiflowInvariants(true)` is what aborts the process, and it changes no verdict.** The
      option is enabled because libpetri's guidance says to enable it on a net with an `all()`
      arc on a busy place, which the OR gadget has. Measured 2026-09-09 against libpetri's
      gated build, whole-net `deadlockFree` with the widenings and the state equation, 60 s:
      the union changes **no verdict on any fixture** — `diamond` proven either way (35.8 s vs
      35.7 s), `agentTwoTools` proven either way (1.4 s vs 0.9 s), `layers` 3/5/7 unknown either
      way — and adds one invariant to the basis in every case but the agent net, which gains
      five. What it costs: `layers7` (29 nodes) spends 145.5 s against 61.1 s, and **`layers9`
      (37 nodes) aborts the process with it and completes without it.** That abort is the
      `SMT_MAX_JOIN_INPUTS` / `SMT_MAX_FLAT_PLACES` ceiling's whole reason for existing
      (ADR 0007 §12), and it is uncatchable, so the ceiling is a guard against an option that
      buys nothing measurable here. The enumeration is worst-case exponential in branching
      (upstream measured `2^k` minimal semiflows on `k` diamonds in series, hitting the
      8192-row backstop past thirteen), which is exactly the `layers` shape.

      **Re-measured 2026-09-09 against libpetri's bounded-candidate fix, and the case is now
      much stronger.** The abort is gone: the pipeline completes at every size tried, 18.9 s at
      37 nodes and 130.2 s at 81 nodes (870 places), where it used to kill the process at 37.
      But turning the union off makes that phase almost **flat** — 1.8 s at 37 nodes, 2.2 s at
      49, 2.6 s at 81 — so on this shape the union is essentially the whole cost of the
      pipeline, 128 s of the 130 s at 81 nodes. What it buys there is **one invariant** (145
      against 144; 68 against 67 at 37 nodes), and no invariant it has added moved a verdict on
      any fixture measured. Upstream now states in the spec that enabling it is a *strength*
      choice and not a *correctness* one: where the minimal set is exponential the survivors are
      an arbitrary truncation, so a proof needing one particular law can miss it anyway.

      **Refinement, and it qualifies the recommendation**: everything above priced the
      *pipeline*. Fewer invariants can leave the solver more work, and on `switch20` — the
      branchiest fixture, 22 nodes and 238 places — the whole query is **slower** under
      `'auto'`: proven in 442.5 s with 44 invariants, against 351.3 s with 64 when the union is
      forced. Still no verdict moved either way. So `'auto'` is right where preprocessing
      dominates (the `layers` family, 135 s against 2.6 s) and costs about a quarter of the wall
      clock where the proof dominates. The total is what a caller waits for, not the phase, and
      neither setting wins on every shape — which is an argument for measuring per shape rather
      than for changing the default again.

      **Upstream's own rule, applied here.** libpetri now says to enable the union when the
      report carries `Dropped invariant:` / `Dropped semiflow:` lines naming a consume-all or
      reset place, because that is when the basis is deficient, and to leave it off on a branchy
      net that reports none. Measured: `diamond`, `agentTwoTools`, `loopOverItems` and `layers9`
      report **no** dropped lines, so the rule says off — matching the pricing above. Exactly one
      fixture reports a drop, `ifBothOutputs`, and it is an OR-input net: one invariant over
      `C/in0_e2` / `C/in0_e3` and the terminal markers, dropped by the H1 guard. So the two
      halves of the register disagree by *shape*, which argues against a flat default either way.

      **The self-tuning option, and probably the right one**: run the pipeline once without the
      union — about 2 s even at 81 nodes — and re-run it with the union only when that report
      names a dropped law. That is upstream's rule evaluated rather than assumed, it costs the
      cheap phase twice on the nets that need it and nothing on the rest, and it keeps working if
      the compiler ever reintroduces a draining or reset arc on a busy place, which is the change
      that would flip the calculation back (upstream's caveat, and a real possibility: the OR
      gadget already has the `all()` arc that produced the one drop above).

      **Recommended, in order**: turn the union off, or make it conditional as above; then delete `SMT_MAX_JOIN_INPUTS` (12) and
      `SMT_MAX_FLAT_PLACES` (450) at `src/verify/verify.ts:321`, whose sole justification
      (ADR 0007 §12) was an uncatchable abort that no longer exists and that the union caused
      rather than net size — today they refuse a sound answer the pipeline would give in about
      two seconds. Keeping the union instead is defensible; then the ceiling stays but belongs
      at a far higher value than 450 places. Not done unilaterally: it reverses a default this
      repo chose on libpetri's own guidance, and "no verdict moved on these fixtures" is not
      "never helps"

- [ ] **The SMT fallback's `unknown`s are all budget, and the default budget hides that.** Every
      `unknown` in `docs/verification.md`'s fallback column proves when given minutes:
      `diamond` 35.5 s, `switch20` 277.5 s, `chain40` 410.1 s, and a join-free chain proves at
      every length measured (5.7 s at 12 nodes to 410 s at 40, roughly cubic in length). The
      table runs at 30 s, so it reports three capability limits that are not capability limits.
      Two things follow. The measured table should carry a second column at a large budget, or
      say per row which kind of `unknown` it is — a verdict that means two different things is
      the one thing this surface is not allowed to ship. And the CLI's default timeout is a
      product decision worth revisiting: at 30 s a user gets `unknown` on a workflow the solver
      would prove in four minutes, with nothing telling them more time would settle it.
      Discovered twice over during the 2026-09-09 review, the second time *after* the first had
      been written down — a 60 s sweep showed a clean monotone "wall" between 16 and 20 chain
      nodes that a 300 s budget walked straight through

- [ ] **A tool shared by two agents verifies as `violated`, and it is a false alarm.** The
      tool's success branch is `xor` over its agents' `A/response` places, resolved at run time
      by the dispatch token (`scheduler/actions.ts`, `succeed`, which throws if the named agent
      is not wired). The state-class graph is value-blind (VER-004), so it explores the arm
      that hands A1's response to A2 and reports the dispatcher stranded: `agentSharedTool`
      quiesces on `A1/dispatched` + `A1/drained` + `A1/outstanding` with an uncollected
      `A2/response`, 24 121 classes, whole-net `violated`, `ok: false`. Every other agent
      fixture is `proven`. This is the one place the value-blind abstraction produces a red
      report on a correct workflow rather than a weaker verdict, and no test or doc recorded it
      until the 2026-09-09 review. **The fix that makes the abstraction exact**: compile the
      tool's `T_start` / `T_run` / success chain once per dispatching agent — one `T/in_tool_a`
      place and one run transition per agent, each writing that agent's `A/response` with no
      `xor` — keeping the single `T/idle` so the tool still serialises across agents as n8n
      does. Cost is a per-agent copy of three transitions on shared tools only; nets with one
      agent per tool are unchanged. Until then, `docs/verification.md` tells the reader to read
      that violation as unproven

- [x] ~~**A round's size is a token count, and branch enumeration cannot see it.**~~ Closed by
      the tool-call budget (ADR 0008 §2): `A/calls` is consumed one unit per `A_dispatch`, so the
      count is a path the graph sees and `peak(A/outstanding)` reaches the budget. The
      "N distinct places" fix this item first sketched was the wrong shape — a budget is one
      place with K tokens, and the count is how many times a transition fired
- [ ] **The SMT route returns `unknown` on an agent at the runtime default budget.** The net is
      constant in K — 50 places, 23 transitions, 45 flat, at K = 2 or 1000; only `A/calls`' seed
      moves — so the polynomial blow-up is the state-class graph's alone, and IC3 reasons over place
      *counts* and should not care. Measured: with the graph off (`maxClasses: 0`) and z3 4.13,
      proper completion on `agentTwoTools` at K = 64 is `unknown` via SMT in ~17 s, not a
      timeout. The reason was not extracted. Worth chasing before the `bounded (K)` item below:
      if the coloured or flat encoder decides this, the default-budget agent verifies without a
      declared budget at all, and the graph is only the fast path
- [ ] **A `bounded (K)` verdict for agents.** An agent left at the runtime default (64) verifies
      as truncated. The graph could instead be explored at a smaller budget and the verdict
      reported as "proven for every execution making at most K tool calls" — the agent analogue
      of the cyclic prefix bound. It needs a compile at a different `A/calls` seed than the one
      that runs (a different initial marking, same structure), which the cache already keys
      apart; what it must not do is report that as a proof about the net that runs

### 4. Upstream (libpetri)

- [x] **The declared dependency is wrong, and a clean `npm install` would silently weaken every
      report.** *Closed 2026-09-09: libpetri 5.1.0 shipped the surface, `package.json` asks for
      `^5.1.0`, the lock pins 5.1.0 with its integrity hash, and the suite is 869/869 against the
      published tarball with the working-tree symlink gone — the configuration nothing had been
      measured against until then. `verify()` asserts the surface at entry
      (`assertLibpetriSurface`), so a downgrade or a stale lock now fails with a sentence naming
      the missing methods rather than with a report that closes and proves nothing. The original
      finding: the range `^5.0.0` was satisfied by a package missing every interface the verifier
      calls, and against it each query threw, was caught, and became `unknown` — no crash, no
      failing build, every proof gone.*
- [ ] **Permutation symmetry for structurally interchangeable subnets.** The agent's per-tool
      counters (`T/in_tool`, `T/done`) multiply the state space by about m^2.8 in the tool
      count; on the real net a four-tool agent truncates at K = 8. The tools are identical gadgets
      differing only in name, so markings that permute them are one orbit. That is the quotient
      `nu-nets.md` §8 describes for Route B ("names are interchangeable symbols, quotiented under
      permutation symmetry"), applied to subnet instances rather than to ν-names. Not `m^K`: the
      graph is keyed on markings, and dispatch sequences of the same tools do not multiply — an
      earlier note here said so and was wrong. Measured in `tests/spikes/agent-round.test.ts`
- [ ] **Abstract `X/done` for nodes nothing references.** `done` is history a `$('X')` read arc
      reads and nothing else; on the agent net it multiplies the state space by 3 (27 351
      markings, 9 033 without the two tools' `done`). The compiler knows `analysis.referenced`,
      so the verifier could drop unreferenced `done` places from the marking key — an
      n8n-libpetri-side reduction, sound for every property here, since none reads them
- [ ] **A note on `enumerateBranches` and multiplicity.** An `Out` branch is a `Set<Place>`, so a
      firing that deposits `n` tokens into one place is one branch and one token to every
      analysis that enumerates branches — the state-class graph, the flattener, `applyNuGuard`'s
      fragment check. That is a sound *under*-approximation for a safety property, the direction
      that yields a false `proven`, and nothing reports it. A doc note where the type is defined,
      or a validation-time warning when an action writes a place its branch names once more than
      once, would have made the first agent shape fail loudly instead of verifying quietly

- [x] **No per-place quiescence property honours declared sinks.** `joinedOrDeadLettered` is
      sink-blind by design (NU-040 AC4) and `deadlockFree` is whole-net. Since M5 the whole-net
      form *is* what the fallback asks, with the structural rest set as sinks — and since
      2026-09-08 with the pause / halt widenings as conditional sinks (VER-014, above), so it is
      no longer false by construction and `verify()` asks it wherever the graph did not close.
      The per-place variant is not needed: the whole-net question with the widenings *is* the
      graph's classification
- [ ] **Partial-order reduction in the state-class graph** (NU-053 names its absence). Independent
      branches are what a workflow engine produces, and they are the one truncation shape the
      `bounded` verdict cannot soften. **Measured 2026-09-09, and the cap is not the binding
      constraint**: `switch20` (22 nodes, 238 places) is still truncated at a 400 000-class cap
      after 183.6 s and 4.07 GB, and aborts a 12 GB heap at 1 000 000 — so its graph is not
      "just above the default", and raising `maxClasses` does not reach it. libpetri's own
      enumeration route (VER-017) is the same mechanism at a 50 000 budget, so it declines
      sooner. On this shape the **only** route that decides is the solver, at 351-442 s. That
      makes parallel breadth the one place where all three proof mechanics are slow or absent,
      and it prices the two fixes: interning the marking key (~12 kB per class today) buys a
      constant factor, while partial-order reduction is what would change the exponent.
      **Surveyed in [`docs/research-wide-nets.md`](../docs/research-wide-nets.md)** (2026-09-09)
      against the literature: the load-bearing observation is that proper completion is a
      property of *quiescent markings only*, which is exactly what a deadlock-preserving stubborn
      set preserves — so partial-order reduction is sound for this property, and TAPAAL has
      already published and implemented the inhibitor-arc extension we would need. Structural
      reduction ranks first for cost, since these nets come from a fixed gadget and are full of
      systematically reducible intermediate places, though our property's large support caps the
      win at a constant factor. Unfoldings are the best theoretical fit for breadth and are
      blocked by our inhibitor arcs
- [x] **A coverability / cutoff route for cyclic workflows**, which would turn today's `bounded`
      into a `proven` on Loop Over Items without changing the net. *Reached another way,
      2026-09-08: the SMT fallback, asked as the graph's own question with the state equation on
      (ADR 0007 §13), proves `loopOverItems` in 0.5 s — over every reachable marking, so the
      report's headline is `proven`; the graph's `bounded` remains under `--smt-fallback off`.
      A cutoff route would still be the solver-free way to the same answer*
- [ ] **Intern the marking key.** It is ~12 kB of heap per class, which is what makes the default
      200 000-class cap a ~2.5 GB memory bound and forces the cap to be lowered on a small heap
- [ ] **The P-invariant / P-semiflow enumeration runs on dense `number[][]`** and exhausts a 4 GB
      V8 heap on a branchy net: measured on diamonds in series, 2.8 s at 10 join inputs, 15 s at
      12, 118 s and 2.4 GB at 14, over 7 minutes at 16, heap exhausted at 18 (37 nodes). Since M5
      it no longer caps the whole verifier — the graph decides the reachability families — but it
      is why the SMT route has a size ceiling. **Failing with an error instead of aborting the
      process would already be worth having**: a heap exhaustion is not catchable, so `verify()`
      can only refuse to start the pipeline rather than handle its failure
- [ ] Phases 1–3 (flatten, structural pre-check, invariants) are recomputed per query; a cached
      `FlatNet` + invariants per (net, marking) would cut a full run by an order of magnitude
- [ ] Every compiled net reports `Structurally bounded: NO`: `X/done`, `X/skipped`, `X/ran` and the
      other markers are produced and never consumed. The reset arcs this item blamed for the dropped
      invariants are **gone since M6** (`_halt_reap` was deleted with them, ADR 0004), so the
      invariant counts want re-measuring; the markers are still produced and never consumed, so the
      finding itself stands. A compiler change that consumed them, or a verifier option that
      bounded them, is what IC3 is missing
- [x] `PrecompiledNetExecutor.getMarking()` caches `this.marking` on its first call and never
      invalidates it, so a second mid-run snapshot silently returns the first one's marking. **No
      longer reachable from here:** M6 deleted the halt snapshot along with the reap (ADR 0004),
      so the scheduler never calls `getMarking()` mid-run. Still worth reporting upstream — the
      cache is a trap for any consumer that snapshots twice
- [x] Nested-`xor` validation depends on child order inside `and` (IO-015 defines `And` as
      unordered). **Fixed in libpetri 5.0.0**: [IO-015] is an exact-explanation search, `And` is
      unordered and an unselected subtree is never evaluated. M6 is the consumer of that fix — the
      routing moved back inside `X_run` (ADR 0004's M6 amendment), pinned by
      `tests/spikes/out-spec.test.ts` and `tests/spikes/collapsed-outcome.test.ts`. Java/Rust
      validators still unchecked for the same behaviour

### 5. Harness and CI

- [ ] **CI runs on Node 24 and cannot move up yet.** `n8n-workflow` pulls
      `@n8n/expression-runtime` -> `isolated-vm@6.2.0`, whose prebuilds stop at abi137 (Node 24);
      on Node 26 `npm ci` falls through to `node-gyp rebuild` and dies on
      `PropertyCallbackInfo<Value>` having no `This()` member. Nothing here references isolated-vm
      — it is transitive, and `engines.node` (`>=24`) still describes the published package
      correctly, whose only runtime dependency is libpetri. Moving up needs `isolated-vm >= 7.0.1`
      (it ships abi147) forced in through an `overrides` entry, or an n8n-workflow that has done
      it upstream. Worth doing deliberately, with the override's effect on
      `@n8n/expression-runtime` checked rather than assumed
- [ ] **`caseKeys` (`src/conformance/junit.ts`) pairs duplicate `(file, name)` cases positionally.**
      `packages/workflow` collects its 85 files three times (one vitest project each) and the junit
      carries no project name, so one case that runs in one project and is skipped in the other two
      pairs by document order and produces one spurious regression plus one spurious fixed. Until it
      pairs by **status multiset**, `--scope=workflow` is not a reliable gate and `--scope=all`
      exits 1. Fixing it re-pins `matrix.test.ts`
- [ ] The **k > 1 conformance legs** are compared against `conformance-results/libpetri.junit.xml`,
      which must therefore be produced first; the script checks neither its age nor its provenance,
      so a stale k = 1 artefact silently becomes the wrong reference
- [ ] `packages/cli`'s **integration suite** needs a live database and has never been run: 397 of its
      1501 test files (94 `*.integration.test.ts` under `src/`, 250 under `test/integration/`, 53
      under `test/migration/`)
- [ ] Exactly one `packages/cli` file cannot be instrumented
      (`src/modules/agents/__tests__/agent-sse-stream.test.ts` mocks `n8n-workflow` without
      `NodeHelpers`); the shim reports it as a diagnostic and leaves it on the injected
      `StackScheduler`. It is the one place where a "libpetri" case is really a legacy case
- [ ] `--scope=all` deliberately excludes `cli`: it needs its own `pnpm install` and a multi-minute
      turbo build, so a full-coverage CI leg has to invoke `--scope=cli` separately
- [x] ~~The **classifier counts the six out-of-scope AI-agent "waiting tools" cases as
      loop-driving**, so every headline needs the "excluding out-of-scope" restatement.~~ Closed by
      M7 the other way round: agent tool dispatch is implemented (ADR 0008), so those cases are
      engine results like any other and no restatement is needed. Eight of the nine now pass; the
      ninth is divergence #22
- [ ] The **differ's candidate leg has no timeout** so a net that never quiesces hangs it. The
      reference leg has a 10 000-activation valve; the candidate leg has only the fixtures' own
      bounds. libpetri 5.0.0's `run(ms, 'close')` **is** the right tool here — a harness safety
      valve is not n8n's timeout, so the hard rule that keeps it out of the scheduler does not
      apply to `src/conformance/`
- [ ] The **row #17 attribution rule is coarse**: any candidate-only activation in a halted, paused
      or cancelled run is attributed to it. A tighter rule needs the activation's trace start to fall
      after the halting activation's, and the halting instant is not observable from the trace
- [ ] `FakeHost` mirrors `WorkflowExecute` at `441970b` closely but not fully (no
      `convertBinaryData`, no `handleNodeErrorOutput`, no `sendChunk` hook, no AI-tool output
      rewire (`planEngineRequest` is mirrored, `rewireOutputLog` is not), no
      expression evaluation, so divergence #7's `$('Y')` shape cannot be reproduced). Its verdicts
      are about the two schedulers, not about `WorkflowExecute`; only the real conformance run
      covers the rest
- [ ] The randomised soak that backs the k > 1 equivalence claim (per-node jitter, every fixture at
      k ∈ {2, 4, 8}, five seeds, ~2200 runs, zero findings) is not committed because it is
      wall-clock-dependent. Gating on it needs a seeded, timer-free formulation
- [ ] **Never edit a running shell script**: bash re-reads the file mid-run. Observed once —
      `run-conformance.sh` died with a syntax error after its leg had completed and been logged
- [ ] The generated vitest shim (`.n8n/packages/<pkg>/.n8n-libpetri-setup.mjs` and
      `vitest.libpetri.config.mts`) is left in the clone, covered by `.git/info/exclude`; it embeds
      an absolute `file://` URL and is regenerated if this checkout moves

### 6. Timing sensitivity (run gates on an idle machine)

- [ ] n8n's suite is load-sensitive (507 s and one 5 s timeout at load average > 20); run conformance
      idle or raise the vitest timeout via a config override
- [ ] `tests/verify` takes ~210 s and is z3-bound; two cases deliberately spend a full timeout, and
      the 5 s per-query `TEST_TIMEOUT_MS` is the only thing between the "must prove" assertions and a
      flake. Measured headroom is 10–50× idle; a slower CI runner may want it raised
- [ ] `docs/differential.md`'s and `docs/verification.md`'s absolute numbers are **upper bounds**
      measured on a shared machine. The ratios and the verdicts reproduce; the milliseconds do not
- [ ] `tests/spikes/budget.test.ts` upper timing bounds and `concurrency.test.ts`'s wall-clock bounds
      may be flaky on a loaded runner; `differ.test.ts`'s safety-valve case carries an explicit 20 s
      timeout for the same reason. Two load-sensitive flakes were observed once each and were not
      reproducible in isolation (`tests/spikes/emission-cycle.test.ts` "empty storm", and one
      `packages/cli` template test during a legacy leg)
- [x] **Two more load-sensitive failures, both root-caused and closed** while getting CI green on
      the 5.0.0 lockfile. Neither was the engine. (a) `collapsed-outcome.test.ts`'s twenty-output
      case costs ~2.6 s alone and ~7.5 s with the other 47 files on the same cores — it walks the
      `2^20` expansion to the stack limit and then builds a second twenty-output net — so vitest's
      5 s default was never a bound on it; it carries `60_000` now. (b) `dataOf` compared
      `error.stack` verbatim and V8 only splices `node:internal` frames (`runNextTicks`,
      `processTimers`) into a stack when the throw unwound through them, so the k > 1 vs k = 1
      data-equivalence assertion in `execution-error.test.ts` failed about one run in seven;
      `dataOf` drops `node:` frames now and keeps every project frame. 15 consecutive full-suite
      runs green, against a first failure at run 7 before. **The general rule this leaves:** a
      comparison helper must strip what the *runtime* decides, not only what the clock decides

### 7. Housekeeping

- [ ] `patches/n8n/*.patch` carry `From <sha>` lines of temporary commits; regenerating them changes
      the hashes, not the diff (procedure in `patches/n8n/README.md`)
- [ ] `bootstrap-timings.tsv` has `# run N` marker lines; parsers must skip `#` lines
- [ ] Node ≥ 25 ships no corepack: bootstrap falls back to `npx --yes corepack@0.36.0`; offline
      machines need `npm i -g corepack`
- [ ] junit comparisons must normalise time/timestamp/hostname, drop `<system-out>` and compare per
      suite/case name (vitest lists suites in completion order under parallel forks)
- [ ] `switch20` fixture: "< 100 flat branches for the whole net" is infeasible (leaf nodes alone
      total 100); pinned as Switch 45, net 151
- [ ] `conformance-results/` artefacts are regenerated per leg and are not all from one run: the
      k > 1, core and workflow legs date from their own sessions
