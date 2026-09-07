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

**The plan through M6 is done.** Everything below is what it left open.

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
      loop. Invisible at k = 1 with the AI path out of scope; fixing it means carrying the object on
      the run/retry payload
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

- [x] **Proper completion does not close on a compiled net.** *Closed by M5*: the question is
      routed to libpetri's state-class graph (VER-010) first and the SMT encoding is the fallback,
      so it is `proven` in 1-110 ms on every acyclic fixture and `violated` in ~25 ms on
      `ifBothOutputs`. M4's `unknown` at 30 s / 60 s / 600 s was the SMT route's, not the
      question's. What is left is the graph's *shape* ceiling, below
- [x] **The arrival bound closes only where it cannot fail.** *Closed by M5*: the OR-round form
      (`placeBound(ready_i, n)`, the query divergence #8 names) is decided off the graph —
      `proven` on `multiProducer`, complete at 245 classes, ~4 ms. The join-slot form still cannot
      fail by construction (ADR 0003), which is a statement about the gadget rather than a gap
- [ ] **The graph's shape ceiling is the real limit now, and it has three axes**: independent
      branches (combinatorial, NU-053 — a 20-way switch truncates at 200 000 classes), cycles
      (unbounded — answered with the `bounded` verdict rather than a proof), and the budget (the
      41-node chain closes at k = 1 and k = 2 and truncates at k = 4). Partial-order reduction
      upstream is the one change that would move the first
- [ ] **The SMT route is refused above a measured net size** (12 join inputs / 450 flat places),
      because libpetri's pre-solver pipeline exhausts the V8 heap and *aborts the process* on a
      bigger branchy net. That turns an abort into an `unknown`, but the budget semiflow and the
      per-node fallbacks are simply unavailable up there; the upstream fix is below
- [ ] **Liveness is not provable** and is therefore reported `unknown`: libpetri's `violated` on
      `unreachable` is a witness in a priority- and value-blind abstraction (VER-004). Bounded model
      checking (unroll to depth d, one SAT call) is what would answer it. Consequence today: the
      dead-nodes family lists every live node under "Unproven", which is honest but noisy and makes
      `--strict` fail on essentially every real workflow
- [ ] **Every verdict is about the fresh initial marking.** A resumed or retried execution starts
      from a codec-decoded marking that need not be reachable from it, and nothing checks such a
      marking against the validated P-invariants at resume time. The cheap guard was specified
      (ADR 0007 §6a) and not implemented; today the limitation is documentation only
- [ ] `verify()` has no per-report solver budget: on a truncated acyclic graph the dead-nodes
      family still sends one `unreachable` query per unreached node, and on `switch20` that is 20
      witness searches paying the full timeout each — minutes to return nothing. `--property`,
      `--timeout` and `--smt-fallback off` are the workarounds; a `--max-queries` or a
      per-family budget is the fix. (Since M5 the P-invariant pipeline is paid once rather than
      per query, so the cost is the queries themselves.)
- [ ] A **multi-trigger workflow is verified for one execution** — the one started from the chosen
      start node. The other entry points and what only they feed are reported as such rather than as
      dead nodes, but no run verifies the executions they start; `--start` does it by hand
- [ ] The workflow-JSON shape heuristic cannot see an input nobody wired, which is exactly the
      all-required-Merge-with-an-unwired-input shape the dead-join diagnostic exists for.
      `--node-types` is required for such a workflow; the CLI warns per guessed node but cannot
      detect this case specifically
- [ ] `Counterexample.ordered` is false whenever libpetri's abstract replay does not confirm a
      firing sequence; the renderer says so, but nothing here can turn an unordered derivation set
      into a path

### 4. Upstream (libpetri)

- [ ] **No per-place quiescence property honours declared sinks.** `joinedOrDeadLettered` is
      sink-blind by design (NU-040 AC4) and `deadlockFree` is whole-net. Since M5 the whole-net
      form *is* what the fallback asks, with the structural rest set as sinks — but it is false by
      construction on any workflow with a reachable paused marking holding an arrival, so its
      `proven` direction is unreachable there and `verify()` does not ask it. A sink-aware
      per-place variant would ask the right question; today the graph classifies instead
- [ ] **Partial-order reduction in the state-class graph** (NU-053 names its absence). Independent
      branches are what a workflow engine produces, and they are the one truncation shape the
      `bounded` verdict cannot soften
- [ ] **A coverability / cutoff route for cyclic workflows**, which would turn today's `bounded`
      into a `proven` on Loop Over Items without changing the net
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
- [ ] The **classifier counts the six out-of-scope AI-agent "waiting tools" cases as loop-driving**,
      so every headline needs the "excluding out-of-scope" restatement. Either add an exclusion list
      to `src/conformance/classify.ts` or keep stating both figures
- [ ] The **differ's candidate leg has no timeout** so a net that never quiesces hangs it. The
      reference leg has a 10 000-activation valve; the candidate leg has only the fixtures' own
      bounds. libpetri 5.0.0's `run(ms, 'close')` **is** the right tool here — a harness safety
      valve is not n8n's timeout, so the hard rule that keeps it out of the scheduler does not
      apply to `src/conformance/`
- [ ] The **row #17 attribution rule is coarse**: any candidate-only activation in a halted, paused
      or cancelled run is attributed to it. A tighter rule needs the activation's trace start to fall
      after the halting activation's, and the halting instant is not observable from the trace
- [ ] `FakeHost` mirrors `WorkflowExecute` at `441970b` closely but not fully (no
      `convertBinaryData`, no `handleNodeErrorOutput`, no `sendChunk` hook, no AI-tool rewire, no
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
