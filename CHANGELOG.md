# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **libpetri 5.1.0 is the floor** (`^5.0.0` → `^5.1.0`, lock relocked). The verifier calls
  `sinkPlacesWhen` [VER-014], `stateEquation` [VER-016], `enumerationMaxClasses` [VER-017] and
  `semiflowInvariants('auto')`, reads `SmtVerificationResult.route`, and pins class counts that
  hold only under the canonical state-class key. None of that is in 5.0.0, which the old range
  admitted: against that copy every SMT query degrades to `unknown` rather than failing, so the
  range expressed a compatibility claim nobody had checked. `verify()` now asserts the surface
  at entry and refuses such an install by name. The suite is 869/869 against the **published**
  5.1.0 tarball rather than a working-tree symlink, which is the configuration none of the
  day's measurements had used.
- **The semiflow union is asked for as `'auto'` on the query path.** libpetri unions the
  P-semiflows only when the null-space basis lost a law to the H1 guard, deciding in one pass,
  which is what this project measured its way to: the enumeration is worst-case exponential in
  branching and on a branchy net it *is* the pipeline. Phases 1-3 on 81 nodes and 870 places
  cost 135.1 s with the union forced on and **2.6 s** under `'auto'`, which skipped it and
  returned 144 of the 145 invariants, the missing one having moved no verdict on any fixture.
  `ifBothOutputs`, whose OR gadget loses a law to that guard, gets the union and its full 12.
  The invariant-only run keeps asking for the union explicitly: it needs a law of a particular
  *form* (non-negative over `_budget` and every `X/running`) and `'auto'` tests only for
  deficiency, so under `'auto'` the budget family reported no such law on a net that has one.
- **libpetri's bounded enumeration (VER-017) is switched off at both call sites.** It reads a
  verdict off a state-class graph before the solver pipeline runs, which is the attempt this
  package already makes first: `StateSpace` builds the same graph with a larger budget (200 000
  against its 50 000) and the classification the report is built on. Since the SMT route runs
  only where that graph did *not* close, a second enumeration under a smaller budget cannot
  close either — it re-explores up to 50 000 classes per query and then declines. Measured with
  it on: the test suite goes from 17 s to 101 s and the two-tool agent at `maxToolCalls` 64
  from 1.5 s to 2.6 s. It also empties the report's structural section, because a verdict read
  off the graph runs no P-invariant pipeline and `invariants` comes back empty. Enumeration now
  happens once, in the route that classifies and reports it; `maxClasses` is how a caller asks
  for more of it.
- **The SMT proper-completion fallback asks the graph's own question.** libpetri VER-014
  (`SmtVerifier.sinkPlacesWhen`) can declare a sink set that applies only while a marker holds
  a token, so the whole-net `deadlockFree` query now declares the pause / halt widenings the
  solver-free route always applied (`_pause` admits the pause rest set, `_halt` the halt rest
  set). The "not asked when the graph has refuted it" gate is retired with the reason it gave,
  the designed-terminal downgrade becomes a declaration-mismatch tripwire, and the query record
  carries `conditionalSinks`, and the query runs with libpetri's state equation (VER-016,
  `stateEquation(true)`) so the ordering laws its inductive invariant needs are facts in the
  rule bodies rather than lemmas Spacer has to invent. `fanOut` is proven by the fallback in
  0.2 s where it used to return a paused witness, and the two-tool agent at `maxToolCalls` 64 —
  `unknown` at 120 s under the plain question — proves in 1.5 s. **`loopOverItems`, the cyclic
  fixture the graph could only ever call `bounded`, is proven by the fallback in 0.5 s**, so a
  full report on it reads `proven` and `--strict` passes; `--smt-fallback off` keeps the
  graph's `bounded` (ADR 0007 §13). The whole-net row's explanation says which route proved it.
- **State-class counts re-pinned under libpetri's canonical state-class key.** libpetri now
  orders a class's clocks canonically and keys on the full DBM matrix, so one marking is one
  class: `diamond` 330 → 306 (1094 → 963 at k = 2), `multiProducer` 218 → 211, `ifBothOutputs`
  732 → 697, the two-tool agent at `maxToolCalls` 8 149 958 → 85 935. Verdicts unchanged.

### Fixed
- **A programming error inside a verification query is no longer reported as `unknown`.** The
  catch in `query()` turns a failed query into an undecided verdict, which is right for a solver
  that died and wrong for a bug: the two were indistinguishable once both were `unknown`, so a
  `TypeError` — the shape a missing library method takes — would empty every proof from the
  report while leaving it well-formed, with no crash and no failing build. `TypeError` and
  `ReferenceError` now propagate; `RangeError` deliberately does not, since a stack overflow on
  a deep net is the capacity limit `unknown` exists for. The same rule is applied to the
  invariant-only run, whose catch was bare. Version skew was the instance that surfaced it; the
  class is any bug in a verification path becoming a weaker verdict, so the rule is applied at
  all four boundaries that convert a failure into "undecided": the query, the invariant run,
  z3 resolution (a defect there made every report solver-free) and `StateSpace.explore` (a
  defect there deleted the solver-free route from every report). libpetri found the same fault
  five times in its own transports on the same reading.
- **A stranding the SMT fallback finds is no longer discarded because the run also paused.**
  The downgrade rule asked "does the witness hold any terminal role", which was right while the
  query could not tell a designed terminal from a stranding. With the pause / halt widenings
  declared as conditional sinks it is not: everything a marker excuses is already excused, so a
  witness that still marks something outside the widened set is a real finding even when it
  holds `_pause` — a workflow that pauses on one branch and strands another. The witness is now
  classified exactly as the graph classifies a quiescent class, and only a witness the graph
  would call a designed terminal outright is downgraded, as the declaration mismatch it would
  be. Found by the 2026-09-09 review; pinned in both directions.
- **The structural hash separates workflows by their `ai_tool` wiring and round budget** (v7 →
  v8). The net cache is keyed by `(structural hash, budget)`, and neither fact is derivable from
  the main graph, so two workflows differing only in which tools an agent is wired to shared one
  compiled net. Found by the boundary review; no test was failing.
- **A paused agent round survives a resume.** `decodeExecutionData` dropped a tool-form node's
  stack entry silently — the form has no `inputs`, so the join branch iterated nothing — losing
  every undispatched tool call. It now reassembles the round from the entries the encoder wrote.
- **`FakeHost.collectSubNodeResults` is implemented**, so an agent in the differential harness
  receives its own tool results. It was a stub, which meant a fixture agent had to count rounds
  in a closure and the differ could not run an agent workflow at all.
- **`n8n-libpetri verify` reads `ai_tool` connections** from a workflow JSON export. It read only
  `main`, so an agent workflow was analysed as a net with no round — a different net from the one
  the scheduler runs, reported with the same confidence.

### Added
- **AI Agent tool dispatch runs in the net** (ADR 0008). `AgentV3` returns an `EngineRequest`
  instead of data when its model wants a tool; that is now a fourth outcome of `X_run`, and a
  round of tool calls is a marking rather than a stack. The compiler turns each `ai_tool`
  connection into a dispatch arm, and a tool node is the ordinary per-node gadget with `T/in_tool`
  as its input side and the dispatching agent's `A/response` as its success branch — so retries,
  halts, HITL waits and `$('Tool')` references all work with no new machinery.

  Three things follow that a stack cannot give:

  - **Tool calls run concurrently.** n8n pushes an agent's tool calls onto one stack and runs them
    one at a time; each dispatched tool here takes its own `_budget` unit, so two 500 ms tool calls
    take ~500 ms. Tool *starts* still follow the order the model requested, because `A/queue` holds
    one token and `A_dispatch` pops it once per scheduling cycle. Run data is identical at every
    budget, structurally: `initializeNodeRunData` reserves each tool's `nodeRunIndex` at plan time.
  - **A round survives a pause.** The undispatched tool calls, the dispatched-but-unstarted one and
    the agent's re-entry are written back onto `nodeExecutionStack` in n8n's own shape — and
    because the tokens carry the very `IExecuteData` values `handleRequest` produced, nothing is
    reconstructed.
  - **Agent workflows verify, for every round size up to a budget.** Two budgets bound the round
    loop and nothing refunds either: `A/rounds`, seeded from the agent's own `options.maxIterations`,
    and `A/calls`, a per-agent tool-call budget consumed one unit per dispatch. The second is what
    makes the round *verifiable* — the number of tool calls is a count, an `Out` branch cannot carry
    a count, and consumed one unit per firing the count becomes a path the state-class graph sees.
    Proper completion **proven** solver-free on `agentOneTool` (1,730 classes, 35 ms) and
    `agentTwoTools` (7,968 classes, 200 ms) at a declared `maxToolCalls` of 4, with
    `peak(A/outstanding)` at the budget — the graph explores a round with every tool in flight — and
    no existing verdict changed. An agent that declares no budget runs under the scheduler default
    of 64 and verifies as truncated, cause `tool-calls`, with a report that names the agent, the
    assumed number and the knob (`docs/verification.md`, "What an agent verdict covers").

  Conformance against n8n's own suite goes from **35/44 loop-driving with an eight-case
  restatement to 40/44 with none**, helpers back to 1613/1613 (and 2080/2080 across all of
  `packages/core`). The four remaining regressions are all registered divergences.
- **A per-agent tool-call budget** (`options.maxToolCalls` on the agent, else
  `registerPetriScheduler({ maxAgentToolCalls })`, default 64). n8n has no such bound: `maxIterations`
  caps rounds and a model may request any number of calls in one. Over budget, the agent fails with
  `toolCallBudgetExceeded` under its own `onError`, the shape `maxIterations` has when n8n's node
  throws it (divergence #25). The budget is also the width of a verification claim, and the one
  truncation cause with a knob: `verify` reports `tool-calls` and says what to declare.
- `planEngineRequest` on the scheduler seam (patch 0001): `handleEngineRequest` without the
  `addNodeToBeExecuted` calls, so a scheduler that keeps its own representation of pending work
  can have n8n *build* a round without anything being enqueued on the host.
- Agent fixtures in the differential sweep (`agentRound`, `agentTwoRounds`): **data equal,
  happens-before respected and order equal at k = 1, 2 and 4** against the reference stack loop.
  `agentRound` is also the first fixture whose concurrency is the *model's* rather than the
  workflow's — n8n runs an agent's tool calls one at a time, so the overlap the
  budget-equivalence test now asserts at k = 2 exists only here.
- `state-class.ts` refuses to build a graph for a net carrying a ν-net `matchSpec`. The plain
  `StateClassGraph` never reads one, so it is libpetri's over-approximation fallback — sound for
  reachability safety, **not** for quiescence (`nu-nets.md` §8), which is what
  `proper-completion` asks. Nothing compiles a `matchSpec` today; this is the tripwire for
  whoever adds the first.

- Repository scaffold: TypeScript package skeleton, docs, spec and task layout, CI.
- Architecture and model in `README.md`; net-native modelling principles in ADR 0001.
- `compile(workflow)` (`n8n-libpetri/compiler`): turns an n8n workflow description into one
  libpetri Coloured Time Petri Net that serves both execution and verification, plus a cached
  `PrecompiledNet`, a `NetMap` (transition ↔ node, place ↔ (node, port)) and `dotExport`.
- Emission rule: every connected output emits data or an explicit empty token; producers on a
  cycle emit `nil` instead, so downstream joins never wait on an edge that may never fire.
- Per-node gadget with two-phase start/run, an explicit `X/idle` mutex and a routed outcome.
  `X_run` routes every connected output in its own `Out` spec and marks `X/routed`; `X_done`
  refunds `_budget` one scheduling cycle later, so the refund lands one cycle after the edge
  tokens. A node with **more than three** connected outputs keeps the per-output split
  (`X/ok_o` → `X_route_o` → `X/routed_o`), so execution and verification stay linear in the
  number of outputs where the flattening would otherwise be exponential (ADR 0004).
- Join gadget: slot semantics matching n8n's first-free-slot allocator, enumerated
  data/empty combinations for Merge chooseBranch, partial `requiredInputs` arrays, and a
  diagnostic for joins n8n can never run (unwired required input).
- OR-inputs: several producers into one input aggregate a round (one run per data arrival,
  one skip per all-empty round) instead of emitting one empty per producer.
- Retry gadget with n8n's own `getRetryParams` clamping (2–5 tries, 0–5000 ms wait), timed by
  the net's `delayed(waitBetweenTries)` transition.
- Halt: `stopWorkflow` errors raise `_halt`, which **nothing consumes** — it is the halted
  run's terminal marker. Every start, retry, skip, arm and clear inhibits on it, so the run
  quiesces with each pending activation still on the place it was delivered to, and the
  marking codec encodes them from there (ADR 0004, "The reap is gone").
- Expression references `$('Y')`: read arcs on `Y/done` make the dependency explicit; a
  reference to a skipped or unreachable node runs the node with a tagged
  `UnmetReferencePayload` so n8n's own error surfaces; self/downstream references are reported.
- Concurrency budget `_budget` with `_budget + Σ_X(running + retry + in-flight) = k`
  as a real P-semiflow, and `joinReadyPlaces` per join input for proper-completion queries.
- Structural hash (v7) over the compiled shape, stable across cosmetic workflow edits.
- Spike suite (`tests/spikes`) pinning every derived fact against libpetri, a z3 gate
  test (fails CI when proofs would silently become skips), and ADRs 0002–0005 (emission rule,
  join gadget, two-phase budget and routed outcome, marking codec).
- `scripts/bootstrap-n8n.sh`: idempotent clone of n8n at the pinned commit `441970b`, pnpm via
  corepack, filtered install, turbo build, and the unpatched execution-engine junit baseline
  (1657 cases, 75 files, 0 failures) under `conformance-results/`.
- n8n patches `0001-extract-scheduler-loop` (the `executionLoop` moved verbatim into a
  `StackScheduler` behind a `WorkflowScheduler` interface) and `0002-scheduler-registry`
  (`setWorkflowSchedulerFactory` so an alternative scheduler can be registered without an
  environment variable); `scripts/verify-patch.sh` re-applies them and fails on drift.
- Conformance harness (`n8n-libpetri/conformance`): dependency-free junit reader, explicit
  loop-driving classification (44 of 1657 cases since M4, 36 before it), per-engine matrix with
  same/regression/fixed/new/changed verdicts, Markdown report and CLI;
  `scripts/run-conformance.sh` runs the suite under both engines.

- `PetriScheduler` (`n8n-libpetri`): a drop-in `WorkflowScheduler` for n8n's execution engine.
  Register it once and n8n's own loop is gone — the net decides what runs next:

  ```ts
  import { registerPetriScheduler } from 'n8n-libpetri';

  registerPetriScheduler({
    setWorkflowSchedulerFactory, // from n8n's scheduler registry (patch 0002)
    nodeHelpers: NodeHelpers,    // from 'n8n-workflow'
    StackScheduler,              // the legacy loop, for non-v1 workflows
  });
  ```

  It runs the node and routes the result, nothing more: no dispatch queue, no policy. Tokens
  carry the live `INodeExecutionData[]` arrays, so `$json`, `$node`, `pairedItem` and
  `WorkflowDataProxy` see exactly what they saw before. Workflows on `executionOrder` other
  than `v1` are handed to the scheduler you pass in.
- Wait nodes, destination-node stops and cancellation resume through the marking codec:
  `decodeExecutionData` turns a saved `IRunExecutionData` into a marking, `encodeMarking` turns
  a paused, cancelled or stranded net back into `nodeExecutionStack` / `waitingExecution` in
  n8n's own shape — including join slots, OR rounds, retries and in-flight activations.
  Cancellation is `executor.close()`; a run is never given a timeout.
- Retries are timed by the net (`delayed(waitBetweenTries)`) rather than by a sleep in the loop,
  so siblings keep running while a node waits between attempts.
- A `stopWorkflow` error halts the net and the activations it reaped are written back to
  `nodeExecutionStack` behind the failed entry n8n pushed, so a retry of the execution resumes
  from where it stopped instead of losing the queued work.
- Conformance against n8n's execution-engine suite at k = 1 (`scripts/run-conformance.sh`, full
  matrix in `docs/conformance-m2.md`): 26/36 loop-driving cases and 1619/1621 helper cases —
  26/30 and 1621/1621 once the AI-agent tool dispatch this milestone does not implement is
  excluded. The legacy leg is byte-identical to the unpatched baseline, so the patched seam is
  still a pure refactor. The remaining four failures are registered divergences (#2, #5, #11,
  #12), none of them data loss.
- Nodes that use the AI-agent `EngineRequest` / `EngineResponse` tool protocol fail with an
  explicit `NodeOperationError` naming the limitation instead of behaving unpredictably.
- Divergence register extended with #11–#15 and an amendment to #2; ADR 0005 amended with the
  mapping that landed.

- **Nodes run concurrently.** The `_budget` place is seeded with `k` unit tokens, so up to `k`
  nodes whose inputs are ready run at the same time — the whole point of replacing a loop that
  runs one node at a time. Two independent 500 ms HTTP calls now take ~500 ms, not ~1 s:

  ```ts
  registerPetriScheduler({ setWorkflowSchedulerFactory, nodeHelpers, StackScheduler, budget: 4 });
  ```

  The compiler decides whether the budget is safe to use and silently lowers it to 1 when it is
  not — a workflow with a cycle, or with an input index fed by more than one producer, takes its
  payload-to-`runIndex` pairing from arrival order, which above k = 1 is the producers' completion
  order. When it lowers the budget it says so as a diagnostic
  (`budget: k=4 lowered to 1 (multi-producer-input: C.0 has 2 producers)`). Across n8n's own
  1657-case suite exactly two workflows are lowered; everything else runs at the budget asked for.
- Same data at every budget. For every workflow the compiler leaves above k = 1, the
  `IRunExecutionData` at k in {1, 2, 4, 8} is identical: payloads, `pairedItem`, `source`,
  `executionStatus`, `metadata`, error shape, the resumable state (`nodeExecutionStack`,
  `waitingExecution`, `waitingExecutionSource`, `contextData`, `waitTill`) and the scheduler's
  own `executionError` / `closeFunction`. Only *ordering* moves, and every field that can move
  has a register row. `tests/conformance/budget-equivalence.test.ts` is that statement as a test.
- Input items are read-only. A node's output array is shared with every consumer it is wired to
  — exactly as n8n shares it — so a node must not write into what it was handed. n8n's own
  `addPairedItemLineage` already copies rather than stamping in place, so no second copy is
  taken; ADR 0006 has the aliasing table and the cost measurements (~19 ns/item to copy, against
  a 6.4x speed-up on a 25 ms-per-node workflow at k = 8).
- `PetriScheduler.maxInFlight` reports the high-water mark of concurrent node runs of an
  execution — a lower bound on how much of the budget was actually used.
- Differential harness (`n8n-libpetri/conformance`, `docs/differential.md`): a faithful port of
  n8n's own `stack-scheduler` loop runs the same fixture under the same host as the net, and the
  two are compared on three levels — a **data gate** (per `(node, runIndex)`: payloads, source,
  status, metadata, error, plus the resumable state and the scheduler contract), a
  **happens-before** check (every dependency n8n realised must be ordered the same under the net)
  and an **ordering** report where each moved activation is attributed to a numbered divergence
  row. `npx tsx src/conformance/differ-cli.ts <fixtures> --budget 1 --budget 2` exits non-zero on
  any unattributed difference or any mechanism no row names. 23 fixtures x k in {1, 2, 4}: 0 fail,
  0 unattributed, 0 novel mechanisms, 0 unobserved happens-before edges.
- Benchmark (`npm run bench`, numbers in `docs/differential.md`). Fan-out of N x 500 ms nodes,
  mean ms: width 2 — n8n 1006, k=1 1019, k=2 507, k=4 508; width 4 — n8n 2010, k=1 2019, k=2 1007,
  k=4 504; width 8 — n8n 4021, k=1 4023, k=2 2009, k=4 1006. A deep 8 x 500 ms chain, where there
  is nothing to win, is within 0.2 % at every budget. Scheduling overhead over n8n's own loop on a
  100-node chain of 0 ms actions: ~16 us per node warm (~79 us on a cold compiler cache), against
  an 80 ms HTTP call or a 400 ms LLM call.
- `scripts/run-conformance.sh --budget=N` runs n8n's suite at any budget. k = 1 keeps the M2
  artefact names; k > 1 writes `libpetri-k<N>.*` and is compared against the k = 1 libpetri leg,
  not the legacy baseline, so the matrix shows what the *budget* changed rather than re-reporting
  the k = 1 divergences. Budget restrictions and decode diagnostics are collected per leg.
- Conformance per budget (`docs/conformance-m3.md`). Loop-driving / helpers, and regressions
  against each leg's reference: legacy 36/36 and 1621/1621, byte-identical to the unpatched
  baseline; libpetri k=1 26/36 and 1619/1621, 12 regressions against the baseline; k=2 25/36 and
  1618/1621 and k=4 26/36 and 1618/1621, **2 regressions against k = 1** at either budget. Both
  are ordering, both are registered: the total execution order of a workflow with independent
  branches (#21) and a Respond node that the net has already started when a sibling fails (#17).
  No case moved from an order assertion to a data assertion at any budget.
- Divergence register at 21 rows: #19 (`executionError` is split into a write-once halt error and
  a completion-ordered leftover), #20 (an OR-input arm transition costs a scheduling cycle) and
  #21 (total execution order is n8n's, and only n8n's, property) are new; #1, #11 and #17 are
  widened by what the harnesses found. Every row M3 observed is now `designed`.
- ADR 0006 (payload safety and the k > 1 semantics): the aliasing analysis, why no extra copy is
  taken, the three hazard verdicts (waitTill claim, halt snapshot, in-flight sibling), and why
  the k-safety check is sound as written.

- **Verify a workflow before you activate it.** `verify(workflow)` (`n8n-libpetri/verify`) and
  the `n8n-libpetri verify` command run six property families over the *same net the scheduler
  executes* — there is no verification net — and answer each as a named check with its own
  verdict:

  ```bash
  npx n8n-libpetri verify my-workflow.json --property dead-nodes
  #   PROPERTY    CHECK            VERDICT   TIME
  #   dead-nodes  Trigger can run  unknown   58ms
  #   dead-nodes  A can run        unknown   367ms
  #   dead-nodes  Never can run    VIOLATED  60ms
  #
  #   Findings (1)
  #     1. [dead-nodes] Never can never run: no reachable marking ever puts a token on its
  #        running place. The compiler already marks it unreachable from every start node.
  ```

  ```ts
  import { verify } from 'n8n-libpetri/verify';
  const report = await verify(description, { budget: 2 });
  report.checks.filter((c) => c.verdict === 'violated');   // findings, with node paths
  ```

  Counterexamples come back as node paths (`Trigger -> A -> Merge`) and markings in node
  terms, never as place names. Exit 0 clean, 1 on a finding (or on any `unknown` under
  `--strict`), 2 on a usage error, 3 when no usable z3 resolved — a run that verified nothing
  never looks like a clean one. `--json` carries the whole report, including every node shape
  the CLI had to guess from a workflow export.
- **"Can this workflow strand a branch?" now answers.** The verifier asks libpetri's
  state-class graph (VER-010) first and keeps z3 as the fallback, which is the order NU-053
  prescribes and the inverse of the first cut. The headline proper-completion question — which
  used to come back `unknown` at 30 s, 60 s *and* 600 s — is decided by enumeration instead:

  ```bash
  npx n8n-libpetri verify if-both-outputs.json --property proper-completion
  #   state space        889 classes in 25ms, 80 quiescent (71 paused or halted), complete (VER-010)
  #   proper-completion  no branch is ever left stranded  VIOLATED  graph  25ms
  #
  #   Findings (1)
  #     1. [proper-completion] This workflow can come to rest with work still pending: it
  #        quiesces holding Merge input 0 ready (id:Merge/ready_0), Merge hasdata (id:Merge/hasdata).
  #        node path: Trigger -> IF -> C -> Merge
  ```

  A paused or halted run is *classified* rather than reported, so a Wait node is not a
  finding; anything else at rest is. On the fixtures that is 1–110 ms, and a 41-node chain
  closes in ~110 ms where the old route never closed at all.
- **A fourth verdict, `bounded`, for workflows with a cycle.** A loop's state space is
  infinite, so `proven` is unreachable at any cap — but the part that *was* enumerated is
  exact, and that is what the verdict says: *no branch strands in any run where this
  workflow's cyclic nodes run at most `k` times* (`k = 21` on Loop Over Items, ten complete
  passes of its body). It is counted apart from the proofs, printed in its own section, and
  `--strict` fails on it. A stranding found inside that prefix is still a full finding.
- **New options:** `--max-classes` (the state-class cap; `0` turns the solver-free route off)
  and `--smt-fallback auto|off|force`. The default `auto` refuses to start the SMT route on a
  net above a measured size, because libpetri's pre-solver pipeline exhausts the V8 heap on a
  big branchy workflow and a heap exhaustion **aborts the process** — `unknown` naming the
  ceiling is a verdict, an abort is not.
- **What the verifier actually proves, measured** (`docs/verification.md`, ADR 0007): proper
  completion, the structural family — the concurrency budget and its P-semiflow, one
  activation per node, the retry bound, the join-slot discipline, the OR-round arrival bound —
  and dead nodes, on any workflow whose state-class graph closes. The ceiling is the
  workflow's *shape* rather than its node count: independent branches interleave
  combinatorially (a 20-way switch truncates), a cycle is unbounded (`bounded`), and the
  budget is a third axis. It still cannot prove a node *live* (that direction is a witness in
  a value-blind abstraction, so it is reported `unknown`, never `proven`), and it says nothing
  about firing order or about values (VER-004). Every one of those limits is pinned by a test,
  so an improvement in libpetri or z3 breaks the suite and forces the document to be
  re-measured.
- Conformance widened past the execution-engine filter (`docs/conformance-final.md`):
  `scripts/run-conformance.sh --scope=execution-engine|core|workflow|cli|all`, each with its
  own baseline and artefacts. The engine is measured on all of `packages/core`; the
  `workflow` and `cli` scopes are patch-neutrality legs — 29 931 further cases that run with
  the engine registered and never constructed — and the harness now counts factory
  constructions per leg so "registered" is never reported as "measured". Re-measured for the
  final report: `execution-engine` legacy 44/44 loop-driving + 1613/1613 helpers and
  *identical* to the unpatched baseline, libpetri k = 1 35/44 + 1611/1613 with 11 regressions
  (8 out-of-scope AI-agent tool dispatch, 3 registered divergences, 0 defects) and the engine
  entered in 5 of 75 files, k = 2 32/44 + 1611/1613 with 3 regressions *against k = 1*;
  `cli` legacy identical to its baseline and libpetri 20 328/20 328 with 0 regressions and the
  engine never entered — patch neutrality across 20 328 cases, which the harness says out loud
  rather than reporting as a pass.
- `docs/state-of-the-project.md`: one page on what exists, what it is measured to do
  (conformance per scope and budget, the benchmark, verification), what it deliberately does not
  do (the divergence register in prose) and what the honest next steps are — including that n8n's
  workflow JSON cannot express guards, real cycles, budgets or correlation ids, which is the
  blocker for surfacing the net's expressiveness in the editor.

### Changed
- **M6 — the routed outcome collapsed into `X_run`, and the halt reap is gone.** libpetri
  5.0.0 made [IO-015] an exact-explanation search, so the nested spec M1 could not use now
  validates: `X_run` routes every connected output itself and marks one `X/routed`, and
  `X/ok` / `X_route` disappear at or below three connected outputs (above it the per-output
  split still wins on flat-branch count, `2^k + 4` against `2k + 5`). Routing inside `X_run`
  puts a sibling's arrivals in the *same* executor cycle as `_halt`, which the old
  `_halt_reap` destroyed and the halt snapshot — taken before that cycle's outputs were
  committed — could not recover, losing a pending activation outright at k ≥ 2. So the reap
  and `_halted` are gone too: `_halt` is never consumed, nothing is cleared, and the codec
  reads the pending activations out of the quiescent marking. Net effect, k = 1: `linear`
  41 places / 19 transitions / 50 classes → 37 / 15 / **43**, `diamond` 393 → **330**,
  `chain40` 2048 → **1967**, `wide8` 6151 → **5894**; at k = 2 the diamond 1551 → **1094**.
  Every verification verdict is unchanged (ADR 0004, `docs/verification.md`).
- **The workflow timeout stays n8n's, deliberately.** libpetri 5.0.0 also added
  `run(ms, 'close')`, which rejects *and* stops the loop, so the old reason the scheduler
  avoided a timed run — the losing loop leaked — is gone. The scheduler still does not use it:
  n8n's deadline is `WorkflowExecute.shouldStopExecuting()`, which is not a pure predicate but
  sets the `status` / `timedOut` fields the caller reads to persist a timeout as a cancellation
  rather than a success, and n8n polls it *between* activations, where the scheduler polls it
  too. A net-side deadline would stop the run mid-activation and change what gets recorded.
  CLAUDE.md, the README and ADR 0004 now carry that reason instead of the stale one
  (ADR 0004, "The timeout is n8n's, not the net's").
- The concurrency budget is live. At k = 1 the engine remains n8n-sequential and byte-identical,
  which is what M2 proved; above it, `executionIndex` records the order nodes *started* rather
  than n8n's depth-first walk, and the execution-global fields n8n's loop owns —
  `lastNodeExecuted`, `waitTill`, `executionError` — become properties of completion order.
  Each is a numbered divergence (#15, #16, #19) rather than a silent difference. Keep k = 1 for a
  workflow whose correctness depends on a failure suppressing a ready sibling (#17), or that uses
  dynamically-resolved credentials (#18).
- README per-node gadget now documents the routed `X_run`/`X_route_o`/`X_done` shape
  (libpetri's validator rejects the earlier nested-`xor` form on the retry and halt branches,
  ADR 0004). *Superseded by M6: libpetri 5.0.0's [IO-015] accepts the nested form, so `X_run`
  routes in its own spec at or below three connected outputs and the split survives only above
  it — see "M6" below and ADR 0004's M6 amendment.*
- **The `_budget` refund moved from `X_route` to `X_done`, one scheduling cycle later**, and
  every node with a connected output now routes per output. This is the one model change of
  the project so far, and it is what restores n8n's depth-first order at budget 1: libpetri's
  executor snapshots its ready set before firing, so a join or OR consumer needs one extra
  cycle for its `arm`, and refunding in the same firing that deposited the edge tokens let a
  shallower budget-blocked sibling take the unit first. n8n's own
  `v1 execution order > should execute nodes in the correct order, depth-first & the most
  top-left one first` fails without the change and passes with it. Divergence #20 is `fixed`;
  the honest costs are a `destinationStop` sibling that no longer runs (#13) and, on one
  fixture, `lastNodeExecuted` at k = 1 (#16). Places and transitions per node go up by one
  each; the flatteners get cheaper. *Half superseded by M6*: the refund is still `X_done`
  and the phase is unchanged, but `SPLIT_ROUTING_ABOVE` is 3 again, so "every node with a
  connected output routes per output" no longer holds.

### Fixed
- **The lockfile still resolved libpetri 4.1.0**, so `npm ci` — CI's install step, and the only
  one that reads `package-lock.json` as authoritative — refused every build with
  `Invalid: lock file's libpetri@4.1.0 does not satisfy libpetri@5.0.0`. M6 had already moved
  the model to 5.0.0 and `package.json` asked for `^5.0.0`; only the lock was left behind, which
  is why a local `npm install` tree stayed green while CI could not install at all. No source
  change: the lock now pins `libpetri@5.0.0` and the suite is 815/815 on it.
- **Two load-sensitive test failures that only appear when the whole suite shares the cores**,
  both artefacts of the harness rather than the engine:
  - `tests/spikes/collapsed-outcome.test.ts`, the twenty-output case, drives `enumerateBranches`
    through the `2^20` expansion until the stack gives out and then builds a second twenty-output
    net for the `route` leg: ~2.6 s alone, ~7.5 s with the other 47 files running. vitest's 5 s
    default was never a bound on it, so the case carries an explicit `60_000` (the convention
    `tests/conformance/budget-equivalence.test.ts:71` already uses).
  - `dataOf` (`tests/scheduler/support.ts`) compared `error.stack` verbatim, and V8 splices
    `at runNextTicks (node:internal/…)` / `at processTimers (node:internal/…)` into a stack only
    when the throw happened to unwind through them. A node that throws after an `await sleep()`
    therefore produced two different stacks for the same script depending on how that tick's
    timer drained, failing the k > 1 vs k = 1 data-equivalence assertion in
    `execution-error.test.ts` about one run in seven. `dataOf` now drops `node:` frames — the
    same category as the clocks and `executionIndex` it already dropped — and keeps every project
    frame, so a real difference in the throw path still fails. 15 consecutive full-suite runs
    green, against a first failure at run 7 before the change.
- **CI had been red on every commit since n8n-workflow entered the dev tree** (2026-09-05); only
  the two scaffold commits before it were ever green. Three independent causes, all outside the
  engine:
  - The job asked for Node 26, set in the scaffold commit when the dev tree was pure TypeScript.
    `n8n-workflow` pulls `@n8n/expression-runtime` -> `isolated-vm@6.2.0`, whose prebuilds stop at
    abi137 (Node 24), so `npm ci` fell through to `node-gyp rebuild` and died on
    `PropertyCallbackInfo<Value>` having no `This()` member. The runner is pinned to Node 24 —
    `engines.node`'s floor, the version every number in the repo was measured on, and the newest
    the tree installs on. Moving up needs `isolated-vm >= 7.0.1` (it ships abi147) forced through
    an `overrides` entry, which is a deliberate change rather than part of getting CI green.
  - `properties.test.ts` pinned `stateSpace.maxClasses` to the literal `200_000`, but that field
    is the cap *after* `effectiveMaxClasses` lowers it to what the heap can hold — only a memory
    bound stops a V8 heap exhaustion from aborting the process. A runner's ~2.35 GB heap reports
    140 928, so the assertion pinned the runner's memory. It now compares against
    `effectiveMaxClasses(DEFAULT_MAX_CLASSES)` and asserts the cap is above the 330 classes the
    graph actually closed at; `state-class.test.ts` still covers the lowering at fixed heap sizes.
  - `concurrency.test.ts`'s "four rounds collapse to two" bounded wall-clock at `< 3 x NODE_MS`,
    which cannot tell a slow round from an extra one: under a 2 GB heap two rounds measured
    180.78 ms against the 180 ms bound. It now measures against k = 1 in the same conditions,
    where a per-round overhead `o` cancels in `(2n + 2o) / (4n + 4o)` — two rounds sit at ~0.5
    however loaded the runner is, three would sit at ~0.75, and the bound is 0.7.
