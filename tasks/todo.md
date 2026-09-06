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

**The four-milestone plan is done.** Everything below is what it left open.

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

- [ ] **The `X_skip` half of the halt-snapshot race is unguarded.** `X_start` increments a per-node
      counter the snapshot subtracts, but `X_skip` is a structural transition with no bound action,
      so a skip consuming an `in_empty` / `ready_i` token inside the same ≤ 2-microtask window
      would be double-encoded. Two targeted experiments (400 runs sweeping sleep durations, 520
      sweeping microtask offsets) failed to reach the window; not fixed blind, because a fix means
      binding an action to a structural transition and nothing here could pin it with a failing test
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

- [ ] **Proper completion does not close on a compiled net.** `joinedOrDeadLettered(ready_i)` is
      `unknown` at 30 s, 60 s and 600 s, on a workflow with a stranding and on one without; the same
      shape hand-written closes in under a second. Pinned as a limit in
      `tests/verify/properties.test.ts`, so an improvement breaks the suite. This is the property a
      workflow author would actually want
- [ ] **The arrival bound closes only where it cannot fail.** `placeBound(ready_i, 1)` on a join
      slot is proven in ~300 ms and is unfalsifiable by construction (ADR 0003); the OR-round form
      (`placeBound(ready_i, n)`, the query divergence #8 names) is `unknown` at 30 s on the smallest
      OR shape there is, with semiflows on and off. So the family has no working detector for the
      arrival-count class today
- [ ] **Liveness is not provable** and is therefore reported `unknown`: libpetri's `violated` on
      `unreachable` is a witness in a priority- and value-blind abstraction (VER-004). Bounded model
      checking (unroll to depth d, one SAT call) is what would answer it. Consequence today: the
      dead-nodes family lists every live node under "Unproven", which is honest but noisy and makes
      `--strict` fail on essentially every real workflow
- [ ] **Every verdict is about the fresh initial marking.** A resumed or retried execution starts
      from a codec-decoded marking that need not be reachable from it, and nothing checks such a
      marking against the validated P-invariants at resume time. The cheap guard was specified
      (ADR 0007 §6a) and not implemented; today the limitation is documentation only
- [ ] `verify()` runs one query per place/node, with no parallelism, no early exit and no per-family
      budget; a 21-node workflow is ~100 queries, each paying the 2.9 s pipeline again. The CLI
      streams progress but there is no `--max-queries`
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
      sink-blind by design (NU-040 AC4) and `deadlockFree` is whole-net, which on a compiled
      workflow is violated by every clean run. That gap is what forces the pause-witness downgrade.
      A sink-aware variant — or a `deadlockFree` whose sink set could be "every place that may
      legitimately hold a token at quiescence", which is derivable from `PlaceRole` — would ask the
      right question in **one** query per workflow
- [ ] **The P-invariant / P-semiflow enumeration runs on dense `number[][]`** and exhausts a 4 GB V8
      heap at 49 nodes (599 places) after ~3 minutes. This, not z3, is what caps `verify()` at
      roughly 25 nodes, and it is the single change that would take the verifier from small
      workflows to real ones
- [ ] Phases 1–3 (flatten, structural pre-check, invariants) are recomputed per query; a cached
      `FlatNet` + invariants per (net, marking) would cut a full run by an order of magnitude
- [ ] Every compiled net reports `Structurally bounded: NO`: `X/done`, `X/skipped`, `X/ran` and the
      other markers are produced and never consumed. Removing `_halt_reap`'s reset arcs recovers
      every dropped invariant (13 found / 0 dropped against 8 / 5) and the join-input query still
      does not close, so the H1 guard is a contributing cause, not the cause. A compiler change that
      consumed the markers, or a verifier option that bounded them, is what IC3 is missing
- [ ] `PrecompiledNetExecutor.getMarking()` caches `this.marking` on its first call and never
      invalidates it, so a second mid-run snapshot silently returns the first one's marking. The
      scheduler takes exactly one (`haltMarking ??=`) and the halt-snapshot logic depends on it
      being the one taken inside the halting action, so it is correct today only by accident
- [ ] Nested-`xor` validation depends on child order inside `and` (IO-015 defines `And` as
      unordered); Java/Rust validators unchecked for the same behaviour. The routed gadget does not
      depend on it, which is why it is a question and not a blocker

### 5. Harness and CI

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
- [ ] The **differ's candidate leg has no timeout** — cancellation is `close()`-only and
      `run(timeoutMs)` is forbidden — so a net that never quiesces hangs it. The reference leg has a
      10 000-activation valve; the candidate leg has only the fixtures' own bounds
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
