# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **The budget semiflow was reported present or missing depending on the state-class cap.** A
  P-invariant is a statement about the incidence matrix, so it cannot depend on how many state
  classes the enumeration was allowed to keep — but it did. `runBudget` asks the solver-free
  `graphBound` first and falls back to an SMT query, and that query's run asks
  `semiflowInvariants('auto')`, which *skips* the semiflow union whenever the null-space basis
  is complete. Its basis-only invariants were then cached, and the call site read
  `ctx.invariants ?? collectInvariants(ctx)` — short-circuiting past the one run that asks for
  the union in non-negative form, the very form this search needs. So the same net with the same
  marking reported `_budget + Σ(running + routed) = k` at a cap large enough to close the graph
  and "no law giving `_budget` and every `X/running` the same positive weight" at one that
  truncated. The call site now always goes through `collectInvariants`, which reuses a cached
  list only when that list actually carries the union. Found by the first fixture large enough
  to truncate at the default cap — a nested agent.

- **`FakeHost` did not mirror n8n's rule for a failing `ai_tool` node.** n8n continues such a
  node even with no `onError` at all, and hands the agent `{ json: { error } }` rather than the
  tool's input passed through — `isAiToolExecution` keys on the `rewireOutputLogTo` tag that
  `planEngineRequest` sets when it reserves the slot. The mirror set the tag and never read it,
  so it halted where the host would have continued. Every conformance measurement involving a
  failing tool was being taken against a mirror that diverged from the host; it is faithful now,
  and no existing case moved.
- **A `--node-types` entry silently dropped `loopNode`.** `shapeOf` applied `LOOP_NODE_TYPES`
  on the built-in and guessed paths but not on the two supplied-shape paths, so cataloguing
  `splitInBatches` would have changed its emission semantics. It is applied on every path now,
  and a shape that sets the flag explicitly still wins in either direction. The same change lets
  a supplied shape keep the `outputNames` the built-in knows and it does not carry: n8n's own
  type file lists a port as the bare string `"main"`, so a generated catalogue can never carry
  names, and without this `route: 'true'` on an IF would have stopped resolving. Counts from the
  supplied shape always win; names are grafted on only while the two agree on how many ports
  there are.

### Added
- **The agent wait cliff, measured on n8n's own new agent runtime.** `@n8n/agents`
  (`packages/cli/src/modules/agents`, not a default module) can be driven from the testbed:
  `N8N_ENABLED_MODULES=agents`, an agent created over
  `/rest/projects/:projectId/agents/v2`, and — because
  `openai: (c) => ({ apiKey: c.apiKey, baseURL: c.url })` — the existing stub-OpenAI credential
  unchanged. So `stub-llm.mjs` drives it, which was the open question.

  Their half of the wait problem is decided by two constants in two packages that **do not
  overlap**: `Wait.node.ts:596` blocks in-process on a `setTimeout` when the remaining wait is
  under `65000` ms and never suspends, while the agent tool's
  `WAIT_POLL_ELIGIBLE_MS = 60_000` polls only a `waitTill` within 60 s. Under 65 s there is no
  `waiting` execution to poll; at 65 s or more the deadline is already past the poll window.
  Measured, one agent with one workflow tool re-pointed between runs: a **30 s** child blocked
  the agent's turn for **30.1 s** and then returned real output, and a **70 s** child produced
  `tool-call-suspended` in **0.7 s** — a `workflow_wait` card with "Check for the result" and
  "Stop waiting" buttons for a human to press. The poll path fired in neither, and cannot fire
  for a Wait node at all; it is reachable only through `Form` / `sendAndWait` with
  `limitWaitTime` set under a minute, which is a human-approval timeout rather than work
  finishing. Default configuration throughout — `backgroundTasksEnabled` is `false`,
  `supportsHitl` is `true`.

  Ours is a marking: the parent records `executionTime: 0 ms`, the marking round-trips through
  `IRunExecutionData`, and the execution resumes — and in queue mode it resumes as a *different
  job id*. Nothing blocks and nobody presses a button. `docs/testbed.md` states plainly that
  these are two different integration points and that n8n's choices are defensible; what it
  claims is the third option neither of theirs offers.

- **Queue mode: the engine reaches the worker.** `scripts/testbed/n8n-testbed.sh --queue` runs
  n8n the way production does — `n8n start` enqueues onto Redis, a separate `n8n worker`
  dequeues and executes — and gives the worker the same `--import` preload, because in queue
  mode the main process never constructs a scheduler for a queued execution
  (`WorkflowExecute.processRunExecutionData()` is called at `job-processor.ts:275`, in the
  worker). The launcher refuses to continue if the worker's log does not carry
  `scheduler registered`: a worker without the engine would run n8n's own stack loop while the
  main process's log still said it was installed.

  Measured: `engine entered` appears **once in the worker log and zero times in the main log**,
  and five workflows are **data-identical** to their `regular`-mode runs, in the same order,
  with every happens-before edge holding. The resume is the part worth having — execution 136
  appears twice under two different job ids, so the marking the codec wrote in the first job was
  persisted, re-enqueued when the wait elapsed, and read back by the second, which completed the
  execution. Redis carries only `{ executionId }`; the worker loads the whole
  `IRunExecutionData` from the database, so queue mode changes the process topology and nothing
  about the path ADR 0005 depends on.

  Three things it took, each found by hitting it: the worker needs its own
  `N8N_RUNNERS_BROKER_PORT` (it exits on the main process's 5679); a *manual* execution is not
  enqueued at all without `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`
  (`workflow-runner.ts:299`), so the first attempt measured the main process while calling
  itself queue mode; and n8n warns that scaling mode is not officially supported with sqlite,
  which the testbed keeps and `docs/testbed.md` records rather than hides.

- **Nested agents compile, run and verify.** n8n's `AgentToolV3` is an agent wired as another
  agent's tool: `outputs: [NodeConnectionTypes.AiTool]`, every input `ai_*`, and
  `toolsAgentExecute` for a body, so it emits an `EngineRequest` exactly as a top-level agent
  does. After the adapter filters inputs to `main` its shape is a tool's — which makes it the
  one node that is `isTool` *and* an agent at once, a composition nothing in the gadget was
  written for. It composes: the tool input side (`B/in_tool`, no `in` / `in_empty` / `skipped`)
  meets the whole round block (`B/queue`, `B/calls`, `B/rounds`, …), and the two meet in one
  `X_run` `xor` whose tool branch writes the parent's `A/response` and whose request branch
  writes `B/routed_req` — disjoint, so IO-015's exact-explanation search separates them.
  `analyse` already iterated reachability and depth to a fixpoint for this case; what was
  unverified was the gadget, and it is now pinned by hand-derived place and transition sets
  rather than by a recorded count.

  Two things the nesting buys that a host-side recursion cap does not. **The bound is in the
  marking of the level that is spending**: each agent has its own `A/calls`, nothing anywhere
  refunds either, and the exhaustion is contained at its own level — an inner agent that runs
  out of tool calls fails by name *inside itself*, and n8n's own rule for a failing `ai_tool`
  node (`aiToolDefaultsToContinue`) hands that error to the agent above it as an ordinary tool
  response, which answers and completes. **And the conservation law spans both levels**: z3
  validates one `_budget + Σ(running + routed + routed_req) = k` covering `A` and `B` together.
  n8n's own agent runtime caps delegation at one level by *parse failure* —
  `SUB_AGENT_TASK_PATH_PATTERN = /^\/root(?:\/[a-z0-9_]+)?$/` does not match a depth-2 task path.

  The cost is real and is stated rather than hidden: two nested agents at `maxToolCalls` 2 close
  in 19,523 state classes, at 3 in 202,164, and at 4 the solver-free route runs out of heap
  before it closes (`effectiveMaxClasses` clamps to what the heap affords, 263,737 here). The
  SMT route still answers past that point, which is what `smtFallback` is for.

- **Execution policy in workflow JSON: the attempt chain** (ADR 0009). A node may declare
  `executionPolicy.onFailure`, an attempt-indexed list of `retry` / `route` / `stop` /
  `continue` steps, and `executionPolicy.timeoutMs`, a per-attempt deadline. It is n8n's own
  `onError` generalised over attempts — `stopWorkflow` / `continueErrorOutput` /
  `continueRegularOutput` are `stop` / `route` / `continue`, and `retryOnFail` + `maxTries` +
  `waitBetweenTries` is the all-`retry` case — so one list subsumes four existing n8n fields.
  **The patches are unchanged**: both carriers (`node.executionPolicy`,
  `workflow.settings.executionPolicy`) already round-trip through n8n's DTO, database and editor
  and arrive on the `Workflow` object the existing seam passes.

  The chain is **unrolled, not counted**: one `X/running_i` / `X/failed_i` pair per attempt, so
  every token lives inside one activation. `X/tries` does not — nothing produces it, so a node
  that activates twice inherits its leftover allowance where n8n gives it a fresh one. Attempt 1
  reuses `X/running` and keeps the name `run`, so a policy-free node compiles byte-identically
  and no existing verdict moves. The deadline is libpetri's output timeout [IO-013] with its own
  `X/timedout_i` place (the timeout child is an `Xor` sibling, and a child claiming the failure
  place would make every failing firing ambiguous under [IO-015]) funnelled into `X/failed_i`,
  so one step answers both a thrown error and an expired budget. Cost is linear in the attempt
  count and measured in the ADR.

  **The scheduler runs it**, reusing n8n's own error handling rather than reimplementing it: a
  `retry` step *is* `X_retry_wait` with the step's delay, a terminal step *is* `X_exhausted`
  with the outcome the workflow chose, and `handleNodeExecutionError` is driven by cloning
  `executionData` with `node.onError` set to the step's action. Measured against the
  `WorkflowExecute` mirror on `multiProducer`, whose `C` activates twice and fails twice per
  activation: `retryOnFail` with `maxTries: 3` calls the node **4** times and **halts**, because
  the first activation spends both retry tokens and the second has none left; the equivalent
  three-attempt chain calls it **6** times and **completes**. Still open, in `tasks/todo.md` §1:
  The **codec** round-trips `X/failed_i`, `X/timedout_i` and the later `X/running_i` exactly as
  it does `X/retry` and `X/running`, and the `failurePolicy` fixture joined `ALL` so the
  200-seed property suite covers the shape. The **verifier** proves `placeBound(X/failed_i, 1)`
  per attempt plus a structural check that the chain is a line rather than a loop — the half a
  compiler change would break — both solver-free. And the chain is measured *equal* to
  `retryOnFail` where the two express the same policy: identical `runData` on the recovering and
  the never-recovering script.

  **Measured in a live n8n** (`scripts/testbed/workflows/failure-policy-showcase.json`, with new
  `/flaky` and `/hang` endpoints on the testbed stub). One branch calls a service that fails
  twice then recovers; the other calls one that never answers. Under n8n's own scheduler the
  execution **errors in 70 ms** on the first 503 and nothing downstream runs. On the net with
  the chain declared it **succeeds in 3,086 ms**: the flaky branch recovers on its third call
  with 250 ms and 1,000 ms waits between attempts, the hung branch is abandoned twice at its
  1,500 ms deadline and the `continue` terminal carries the workflow on. The policy also comes
  back out of n8n's REST API and database byte-for-byte, and the legacy leg ran the same
  document without complaint — the layering test, which is what makes the carrier an interface
  rather than a leak.

  **Resilient Fan-Out** (`scripts/testbed/workflows/resilient-fan-out.json`) puts both halves
  together: four ordinary HTTP branches, two of them declaring a policy, run in the real editor.
  **5,123 ms at k = 4 against 12,654 ms at k = 1**, every branch starting within 2 ms of the
  others, one of them abandoned twice on its 2.5 s deadline and carrying on anyway — and the
  same document **failing in 3,106 ms** under n8n's own loop, which stops at the first 503.
  `scripts/testbed/record-demo.sh` records it; `docs/testbed.md` has the timeline.
- **`onError` declares the port, `onFailure` decides the policy.** A `route` step needs a
  connected output, and a node with one main output has none — but
  `NodeHelpers.getNodeOutputs` appends n8n's error output on `onError === 'continueErrorOutput'`
  alone, which is what makes the editor draw the arc. The two are therefore allowed together on
  one node (`continueRegularOutput` is not), and a step may name `output: 'error'`.

  This does something n8n cannot: **its error output never catches a thrown failure.**
  `handleNodeErrorOutput` runs on the success path and sorts *per-item* errors out of an
  otherwise-successful run; a node that actually throws is continued down output 0 with its
  input passed through, identically under both continue modes. Measured on the
  `continueErrorOutput` fixture — n8n runs `Trigger, A, B` and `Err` never runs. A chain sends
  the same failure, thrown or timed out, down the error arc carrying `{ json: { error } }`, and
  applies the branch inside `record()` so what is recorded is what was routed. Divergence #27
  is rewritten around the measurement.
- **A suspended parent survives the marking round trip in a real server.** `Waiting Child` and
  `Parent Waits On Child` — a workflow calling a sub-workflow that waits. The parent is bound to
  the child by a `__WORKFLOW_ID:<name>__` placeholder the seeder resolves, so nothing under
  `workflows/` hardcodes instance state.

  70 seconds is the point. `Wait.node.ts` suspends only past a cliff — *"If wait time is shorter
  than 65 seconds leave execution active"* — and under it holds the execution with a `setTimeout`.
  The node's own `executionTime` is what tells the two apart, measured both ways: a 4-second
  child left `Call The Child` at **4,036 ms**, held for the whole wait; a 70-second child left it
  at **0 ms**, suspended and re-run on resume. At 70 s the parent goes to
  `putExecutionToWait(WAIT_INDEFINITELY)` and `WaitTracker.resumeParentExecution` wakes it.

  Both engines at 70 s: legacy 70,161 ms, libpetri 70,143 ms, **data equal**, every payload
  identical. Parity, not advantage — and that is the point, because every resume claim in this
  project rests on it. The advantage is the sub-cliff case: a node held by `setTimeout` holds its
  `_budget` unit for the entire wait, and `executionPolicy.timeoutMs` is the only thing in either
  engine that bounds it. n8n has a second cliff of the same shape in its agent bridge —
  `WAIT_POLL_ELIGIBLE_MS = 60_000`, under which it polls the database every two seconds and over
  which it renders a button for a human to press.
- **A failure policy on an agent's tool**, which is the node that actually calls the flaky
  service. Only three of the four actions mean anything there: a tool's outcome is its agent's
  `A/response` rather than a main edge, so `route` has nowhere to go and the compiler now refuses
  it by name instead of leaving the author to decode an out-of-range index. `continue` is n8n's
  own default for a failing tool (`workflow-execute.ts`: *"AI tools default to continue-on-fail so
  the agent receives the error as a tool response"*), and `retry` and `stop` behave as anywhere.

  `timeoutMs` is the half n8n has at **no** level. Measured in a live n8n against a service that
  never answers, with the workflow's own `executionTimeout` at 20 s because that is n8n's only
  bound here: n8n's leg is **canceled at 20,083 ms** with the agent never recorded and nothing
  downstream run; the net's is **success at 3,592 ms**, the tool alone marked
  `error — "Attempt 1 of \"Slow_Service\" did not finish within 3000 ms and was abandoned"`, the
  agent answering from that error and `Answer` running. Same workflow, same hung service: n8n's
  bound takes the execution with it, ours loses one tool call.
- **The agent that will not stop** (`scripts/testbed/workflows/agent-budget-showcase.json`), the
  one shape where the tool-call budget of divergence #25 is visible. Its prompt carries a
  `[stub:loop]` marker that makes the testbed stub answer every call with tool calls and never
  with `stop` — the failure users report against the real thing ("it enters an infinite
  loop—calling the same tools repeatedly") made deterministic and offline — and the agent
  declares `onError: continueErrorOutput` with
  `executionPolicy: { maxToolCalls: 6, onFailure: [{ action: 'route', output: 'error' }] }`.

  **Measured in a live n8n, one leg each.** Under n8n's own scheduler the run ends on
  `maxIterations` — left at n8n's default of 30 on purpose, because it is the wrong bound: it
  caps *rounds*, and a model may request any number of calls in one — after **30 model calls and
  60 tool executions**, in 378 ms. On the net it ends on `Tool-call budget (6) reached` after
  **4 model calls and 6 tool executions**, in 579 ms. Both take the same declared error branch
  and both finish the execution as `success`; what differs is the price of finding out, and in a
  real workflow those 60 are billed API calls. `tests/scheduler/agent.test.ts` pins the same
  mechanism against `FakeHost` without a server.

  Two honest differences fall out and are recorded rather than smoothed over. The node's
  `executionStatus` differs — `success` under n8n, `error` on the net — because
  `checkMaxIterations` throws *inside* the agent's `Promise.allSettled` batch
  (`ToolsAgent/V3/helpers/executeBatch.ts:81`) and `continueOnFail` turns the rejection into a
  per-item error on the success path, which is divergence #27's mechanism, while an engine-level
  budget goes through `handleNodeExecutionError`. And **divergence #29** is new: n8n's
  `handleRequest` reserves a `runData` slot per requested action before anything runs, so a round
  the budget cannot pay for leaves its undispatched slots behind with `startTime: 0`.
- **A node-type catalogue, so the corpus numbers stop resting on guesses**
  (`scripts/node-types/extract.mjs`). A workflow JSON export carries no node-type descriptions,
  so the verify CLI guessed every port count from the connections — and a guess is only ever a
  lower bound, since an unwired output is invisible in an export and one miscounted port changes
  the compiled net. On the 200-template corpus that was **4,805 of ~5,114 nodes guessed (94%)**,
  which is an asterisk on every number measured over it.

  The extractor reads n8n's own generated `dist/types/nodes.json`, so the counts are n8n's.
  Ports declared by an expression are **evaluated**, not parsed — they are full JavaScript IIFEs
  over `$parameter` — against probes derived from the expression itself: the parameter names it
  reads, varied over structural values *and over the expression's own string literals*, because
  `'checkIfEvaluating'` is not a value a generic probe would invent. A count that moves with a
  parameter is withheld and left to `BUILT_IN_SHAPES`, which is parameter-aware. Tool variants
  (`<name>Tool`, synthesised by n8n for every node with `usableAsTool` and never present in that
  file) are derived: no `main` port at either end. Result on the 200-template corpus: **236 of ~5,114
  nodes still guessed (4.6%), against 4,805 (94%) before** — and what is left is nearly all
  community nodes that no catalogue built from n8n's own packages can carry.

  **The two headline numbers did not move**: 199/200 templates compile (99.5%) and 101/199
  (50.8%) keep k > 1, exactly as they read when 94% of shapes were guesses. What moved is the
  noise: workflows reporting a violated check fell from **85 to 27**, and dead-node violations
  from **652 to 22** — almost all of them Sticky Notes, which a catalogue knows have no ports.

  Two rules the first version got wrong, both now pinned by anchors the extractor asserts on
  every run — it is generated, so nothing else would notice. A fixed probe list called
  `textClassifier` a zero-output node and `evaluation` a one-output node, which turned two real
  templates into `output index out of range` compile failures; probes are derived from the
  expression now. And an early return on the first *name* disagreement stopped the count check,
  which catalogued Webhook as one output when it has as many as it has HTTP methods.

  `canWait` — whether an activation can suspend the execution — is derived the same way, from
  `known/nodes.json` plus a search of each node's built directory for `putExecutionToWait`, so
  it comes from the code that runs rather than from a list that rots. **24 types**, plus
  `executeWorkflow` by hand because a waiting sub-workflow suspends its parent from inside the
  engine. Nothing reads it yet; it is what lets the gadget stop offering a `waiting` outcome to
  the ~94% of nodes that can never take one.
- `docs/adr/0009-execution-policy.md`, and the three-layer rule it opens with — workflow JSON,
  structural IR, net encoding — with the test that keeps them apart: *a workflow carrying this
  JSON must stay meaningful if n8n's own stack scheduler runs it*.
- `tasks/todo.md` §4b, **Upstream (n8n)**: nowhere to persist an engine-owned counter across a
  Wait (why `A/calls` re-seeds), no per-node cancellation (desirable, not required — [IO-013]
  keeps the marking correct without it), and `options.maxToolCalls` never having had a working
  carrier. Two new libpetri asks in §4: expose the ν quotient (Route B, `nu-scg`, [VER-012]) as
  a public `ClassView`, which is what blocks activation lineage, and a threshold inhibitor arc.

### Fixed
- **`options.maxToolCalls` could not be set in a live n8n.** `getNodeParameters` rebuilds a
  `collection` from the node type's *declared* options, so an undeclared key inside
  `parameters.options` is dropped on the editor's save path and again in the `Workflow`
  constructor; it survived only in the verify CLI's raw-JSON path. The README's known limits and
  divergence #25 both told users to declare a knob they could not declare. It moves to
  `node.executionPolicy.maxToolCalls`, with the old read kept as a deprecated fallback.

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
