# ADR 0008 — Agent tool dispatch: the round is a marking

Status: accepted (2026-09-08).

## Context

`@n8n/n8n-nodes-langchain.agent` (`AgentV3`) is an ordinary `main` node with an ordinary
`execute()`. What makes it different is its **return type**: `INodeType.execute` may return
`NodeOutput = INodeExecutionData[][] | EngineRequest | null`, and when the model wants a tool the
agent returns an `EngineRequest` instead of data. n8n's loop then reserves a `runData` slot per
requested tool, pushes each tool onto `nodeExecutionStack` as a normal entry, and re-queues the
agent underneath them carrying `metadata: { nodeWasResumed, subNodeExecutionData }`. When the
agent is popped again, `collectSubNodeResults` reads the tools' recorded output back out and hands
it to `execute()` as an `EngineResponse`. The agent may request again.

It is the **only place in n8n where the scheduler loop is driven by a node's return value** rather
than by the graph: a re-entrant node with a data-dependent number of rounds.

Two things it is not, and both narrow the problem:

- **Not the `ai_*` connections generally.** `ai_languageModel`, `ai_memory`, `ai_outputParser`,
  `ai_embedding`, `ai_vectorStore` and the rest are resolved by `getInputConnectionData` →
  `supplyData` *inside* `runNode`. They never reach a scheduler. Only `ai_tool` actions inside an
  `EngineRequest` do.
- **Not all agents.** Agent V1/V2 drive LangChain's own `AgentExecutor` and invoke tools in-process
  through `makeHandleToolInvocation`. Those already ran under this scheduler.

Until M7 the scheduler refused: `postRun` threw `engineRequestUnsupported` the moment `runNode`
returned an `EngineRequest`, and the compiler could not have run one anyway — `mainConnectionsOf`
reads only `connectionsBySourceNode[*].main`, so a tool node compiled to a gadget no marking ever
seeded. That refusal was **8 of the 11 conformance regressions**, which is why every headline
number in the repository carried an "excluding out-of-scope AI-agent dispatch" restatement.

## Decision

### 1. The round is a fan-out with pending markers

The gadget is libpetri's own `patterns.md` §5, the stated encoding for *"have all N results
arrived, where N is data-dependent and unknown at build time"*:

```
X_run        one(A/running) → and( xor( <success>, [A/retry], [and(_halt,_budget)],
                                        and(A/waiting,_pause,_budget),
                                        and(A/stopped,_pause,_budget),
                                        A/routed_req ),                      ← new
                                   A/idle )
A_done_req   one(A/routed_req) → xor( and( _budget, A/queue, A/dispatched ),
                                      and( _budget, A/drained, A/dispatched ) )   ← empty request
A_dispatch   one(A/queue) one(A/calls) inhibitor(_halt) inhibitor(_pause)
             → and( xor( T_1/in_tool, …, T_m/in_tool ), A/outstanding,
                    xor( A/queue, A/drained ) )                                    ← more / last
A_collect    one(A/outstanding) one(A/response)                 (no Out spec)
A_resume     one(A/dispatched) one(A/drained) one(A/rounds) one(A/idle) one(_budget)
             inhibitor(A/outstanding) inhibitor(_halt) inhibitor(_pause) → A/running
A_calls_out  one(A/dispatched) one(A/queue) one(A/idle) one(_budget)
             inhibitor(A/calls) inhibitor(A/outstanding) inhibitor(_halt) inhibitor(_pause)
             → A/running                                          ← budget spent: re-enter to fail
A_rounds_out one(A/dispatched) one(A/drained) inhibitor(A/rounds) inhibitor(A/outstanding)
             inhibitor(_halt) → and( A/stopped, _pause )
```

`A/outstanding` is the pattern's `JOB_PENDING`, `A/dispatched` its `ROUTING_DONE`, `A_collect` its
`StoreResult` and `A_resume` its `ResolveAxis`, at the priority order the pattern prescribes:
store before resolve.

A **tool node** is the ordinary per-node gadget with two substitutions: its input side is
`T/in_tool` (form `tool`) instead of `X/in`, and its success branch deposits the dispatching
agent's `A/response` instead of edge tokens. It keeps `T/idle`, `T/tries`, `T/retry`, `T/waiting`,
`T/stopped`, `T/done` and its own start / run / done, so retries, halts, HITL waits and `$('T')`
references work with no new machinery. `T/idle` being a unit place also serialises one tool across
two agents, which is what n8n does.

The request outcome is **phased like the success outcome**: `A/routed_req` here, the budget
refunded by `A_done_req` one cycle later (ADR 0004). So the agent releases its slot for the tools
it asked for, and the P-semiflow is unchanged with `routed_req` counted among the in-flight
markers (`verify.ts` `nodeCarriesUnit`).

### 2. The round's size is a budget, not a count

The number of tool calls in a round is decided at run time, and the compiled net has to carry
it somehow. The first shape deposited it: `A_done_req` put one `A/pending` unit per requested
call, and `A_resume` was inhibited on that place. It ran correctly and it verified wrongly.

[IO-015] output validation compares the produced place *names* (`validateOutSpec` takes a
`Set<string>`; `enumerateBranches` returns `ReadonlySet<Place>`). That is what let one branch
open a round of any size — and it is why branch enumeration cannot see the size. The state-class
graph enumerates the same branches, fires the "some calls" one as one token, and explored one
call in flight where the executor reaches `n`: measured, `peak(A/pending) = 1`. Proper completion
is a safety property, so exploring fewer reachable markings is the direction that yields a false
`proven`. The verdict was about a net that never dispatches two tools at once — the one case the
feature exists for.

The fix is the ν-net spec's own lever: a **budget place**. `A/calls` is seeded with the agent's
tool-call budget and `A_dispatch` consumes one unit per firing, so "how many tool calls" becomes
"how many times dispatch fired" — a path, which enumeration sees. Measured on the real net,
`peak(A/outstanding)` equals the budget at every budget tested; the graph explores a round with
every tool in flight. One place with K tokens, not K places: the count is structural without
being enumerated.

Three facts pin the shape, all in `tests/spikes/agent-round.test.ts`:

- **Nothing refunds `A/calls`.** NU-040's idiom returns the budget unit at the join. Do that here
  and the budget bounds calls *in flight*, not calls *per round*: after a batch is collected the
  budget is full again, the queue is still there, and the graph dispatches another batch —
  `T/done` grows each time, so the marking set is infinite and the graph truncates. Consumed and
  never refunded, the budget is monotonic like `A/rounds`, and the graph closes.
- **The budget is per execution, not per round.** A per-round budget — refilled between rounds
  one unit per firing, gated on no round being open — was built and measured. It closes, at
  about ten times the cost for the same K: verification cost tracks the *total* dispatches
  explored, and per-round makes that K × rounds. Per execution keeps one place and no refill,
  and is also the bound an operator wants — a cap on what an agent may spend in one run.
- **`A_collect` produces nothing.** An accumulator drained with `all()` races: `collect` consumes
  `A/outstanding` at fire time and would deposit on completion, so `A_resume` could drain n − 1
  markers inside that window. A genuine sink (CORE-043 AC4), the same category as `X_clear`.

`A/queue` carries the data — the undispatched activations, in request order — and `A/drained`
marks that there are none; they are exclusive. `A_dispatch`'s action says which, and that is the
one decision the graph cannot make. `patterns.md` warns against exactly this — *"never decide
'is this the last one' inside an action and expose it as an Xor"* — and here it is safe because
of where each spurious branch leads. Taking `drained` early is a smaller round, a subset. Taking
the queue past the real end spends the budget until `A/calls` is empty, and then `A_calls_out`
re-enters the agent: a designed exit, not the stranded batch the warning is about. Both
directions are explored, so the graph over-approximates the executor — the sound direction.

### 3. Dispatch is ordered; execution is not

`A/queue` holds one token, so `A_dispatch` fires once per scheduling cycle and pops in request
order: tools reach their `T/in_tool` places in the order the model asked. Whether they *start* in
that order is then the executor's: two tokens on different tools' places have no FIFO relation,
and when `_budget` serialises them a priority tie between two nodes of equal depth is broken by
the executor. n8n's own `executes requested tools in the order the actions were requested`
passes — two distinct tools, one call each — and a repeated tool can overtake a sibling at k = 1
(divergence #23). Data cannot move either way. **The user-visible gain** is at k ≥ 2: n8n
serialises an agent's tool calls on one stack; the net runs `k` of them at once.

Parallelism cannot scramble `runData`, and structurally so: `initializeNodeRunData` reserves each
tool's `nodeRunIndex` at *plan* time, before any tool runs, so completion order does not decide
which slot a tool writes.

This is the one place the design departs from `patterns.md` §5, which dispatches every family in a
single firing. That shape is `and` of `m` `xor`s — `2^m` flat branches (IO-016, the wall
`SPLIT_ROUTING_ABOVE` guards) — and it cannot express the same tool being called twice in one
round, which a model does routinely. Popping one per cycle costs `m` branches, keeps the order n8n
asserts, and supports repeats.

### 4. The round budget: n8n's own number, as a place

**n8n does bound the rounds, but its engine has no idea.** The bound is `options.maxIterations`, a
node parameter with default 10 (`agents/ToolsAgent/options.ts`), read per batch and enforced by
`checkMaxIterations`, which throws *"Max iterations (N) reached"* when the `iterationCount` carried
on the request metadata reaches it. A counter in a token payload, checked by an `if` inside the
node's action — the scheduler loop would go round forever; only the node refuses.

`A/rounds` is that bound as a place, seeded with `maxIterations` unit tokens and consumed one per
`A_resume`. It is the exact analogue of `X/tries` for retries, and it follows the skill's design
loop: *"Bound everything that can grow … each becomes a place with a fixed number of tokens, not a
counter."*

It **never enforces**. `collectSubNodeResults` round-trips `iterationCount` through
`subNodeExecutionData.metadata`, so the node's own check fires exactly as it does under the stack
scheduler; seeding exactly `maxIterations` keeps the place from binding first. What it buys is
analysis — see below.

Distinct from `_budget`, and the two must not be conflated: `A/rounds` bounds **depth**, how many
times the agent goes round; `_budget` bounds **width**, how many tools run at once.

When `maxIterations` is an expression rather than a literal, the adapter reads nothing (n8n
resolves it per item at execution time), the compiler falls back to its configured
`maxAgentRounds`, emits a diagnostic naming the node, and the agent counts as unbounded for
verification rather than claiming a bound it cannot justify.

**The tool-call budget is the scheduler's.** n8n has no bound on how many tool calls an agent
makes — `maxIterations` caps rounds, and a model may request any number in one — so `A/calls`
has no n8n counter behind it: it is the bound. The default, `DEFAULT_MAX_AGENT_TOOL_CALLS` = 64,
serves the runtime: above any ordinary execution, still a runaway guard, and a run that reaches it
fails by name with the knob in the message. It is far too wide for a graph — on the real two-tool
net K = 4 is 6 315 classes, K = 6 is 27 351, K = 8 is 85 935, about K^3.3 — so an agent that declares
nothing verifies as *truncated*, cause `tool-calls`, and the report names the agent, the assumed
number, and says to declare a small `options.maxToolCalls`. A declared budget is both the runtime
cap the workflow chose and the width of the claim its `proven` makes; `toolCallsAssumed` is what
keeps the verifier from ever reporting a bound it invented. Over budget at run time, `A_calls_out`
re-enters the agent carrying the fact and `attempt()` fails it before `runNode` under its own
`onError` — the shape `maxIterations` has when `checkMaxIterations` throws inside the node.

`A_rounds_out` exists because of what the verifier found. With the budget spent and a round still
open the net quiesced holding `A/dispatched` and `A/queue` — work nothing could ever take, which
`proper-completion` correctly reported as a stranding on **every** agent workflow. A real agent
throws first, but the priority- and value-blind abstraction cannot know that. So exhaustion became
a *designed terminal*: `_pause` marks the stop and the re-entry goes back through `A/stopped`
(`ran: false`), the shape the codec already writes onto `nodeExecutionStack`.

### 5. The host builds the round; the net decides when it runs

n8n's `handleRequest` is where the round is *constructed*: it reserves each tool's `runData` slot,
tags `node.rewireOutputLogTo` and derives the `preservedSourceOverwrite` metadata that two of the
eight conformance cases assert on. We need that and not the stack push, so patch 0001 adds one
method beside the already-public `handleEngineRequest`:

```ts
planEngineRequest(args): NodeToBeExecuted[] { return handleRequest(args).nodesToBeExecuted; }
```

The scheduler builds each `IExecuteData` from the plan the way `addNodeToBeExecuted` builds it for
a node with at most one `main` input, which every agent and tool activation is — and refuses, by
name, rather than guessing if a workflow ever presents one wired otherwise.

**Nothing is enqueued on the host.** An earlier draft called `host.addNodeToBeExecuted` per entry
and drained the stack back, on the grounds that it reuses n8n's own construction. `FakeHost`
throws from that method precisely to keep "no host-side dispatch queue" true, and routing around an
assertion that exists to enforce a hard rule is the wrong move even when the substance is
defensible. The 15 lines of mirrored construction are the price, and `stack-reference.ts` is the
house precedent for paying it.

### 6. No `matchSpec`, no `freshName`

A tool round is a fork/join whose branch count is decided at run time — the shape
`state-of-the-project.md` names as the motivation for lineage-aware tokens, and libpetri supports
it directly (`ctx.freshName()`, NU-010; `Transition.match(matchSpec(…))`, NU-020/021). This design
uses neither, and `nu-nets.md` §6 decides the case on its own terms:

> Plain colours and cardinality are enough, and cheaper, when: **At most one group is structurally
> live at a time** (a budget of 1, or a mutex place). Then FIFO plus cardinality already pairs
> correctly.

`A/idle` is that mutex: one round in flight per agent, structurally. §6 closes with *"Do not
declare a match spec you do not need. It moves the query onto the ν routes and away from cheap
linear-arithmetic IC3."*

Three further findings, each of which would block it independently:

1. **The gadget is outside the ν fragment on two counts.** §7: *"No reset, read or inhibitor arc on
   any coloured place (NU-051), in both fragment modes."* `A_resume` inhibits `A/outstanding`
   and `A_calls_out` inhibits `A/calls` — precisely the places a correlated version would colour. Separately `T_start`
   consumes a coloured `T/in_tool` without a match, which the base fragment rejects outright.
2. **Our verifier is the fallback, and the fallback is not sound for quiescence.** §8: *"The
   over-approximation fallback is sound for reachability safety, but **not** for quiescence. A
   `Proven` on a quiescence property never comes from the fallback."* We build `StateClassGraph`
   directly, and that class never reads `matchSpec` — its enablement is structural token counts.
   `SmtVerifier` routes and guards around this; a direct call does not. `state-class.ts` now
   **refuses** to build a graph for a net carrying a `matchSpec`, so whoever adds the first cannot
   silently get quiescence verdicts from a coarser abstraction.
3. **`freshName()` would be the wrong mint anyway.** §2: *"Reaching for a fresh name when a
   correlation id is already in hand … buys nothing."* n8n supplies one
   (`EngineRequest.metadata.requestId`), and the minter's counter is per-executor while our
   markings outlive the executor by design, so a name minted before a pause could collide with one
   minted after resume.

What the ν reading gives us at no cost: `A/outstanding` **is** NU-040's pending place by
construction of `patterns.md` §5, so `joinedOrDeadLettered` applies to it with the encoding we
already have; and the round id rides on the payloads as data — for the codec, diagnostics and the
differ — never entering enablement.

The wider migration — moving the existing net to ν for the OR-input lineage and the cyclic /
multi-producer k = 1 pinning — stays a separate decision with a real cost (the M5 solver-free
route), recorded in `tasks/todo.md`.

## Consequences

**The round is a marking, so it survives.** A pause, a halt or a cancellation mid-round leaves the
undispatched tool calls on `A/queue`, the dispatched-but-unstarted one on `T/in_tool` and the
agent's re-entry on `A/dispatched`. `encodeMarking` writes all three back onto
`nodeExecutionStack` — and because the tokens carry the very `IExecuteData` values n8n's own
`handleRequest` produced, nothing is reconstructed.

**Agent workflows verify, for every round size up to the budget.** `A/rounds` and `A/calls`
make `queue → dispatched → running → queue` a *bounded* cycle, so the reachability graph is
finite where `loopOverItems`'s is not. Both bounds are hard — nothing in the compiled net
produces either place, and the class count scales with each — so they are what close the
exploration. Measured at the fixtures' declared `maxToolCalls` of 4
(`tests/verify/measure-graph.ts`): proper completion **proven**, solver-free, on `agentOneTool`
(1 466 classes, 16 ms) and `agentTwoTools` (6 315 classes, 101 ms), with `peak(A/outstanding)`
at the budget — the graph explores a round with every tool in flight. No existing verdict moved.
An agent that declares no budget verifies as truncated, and the report says which knob closes it.

**An agent does not lower `k`.** Its own activations are serialised by `A/idle` and tool run
indices are pre-reserved, so neither hazard `kSafety` guards against — cycles, multi-producer
inputs — applies.

**What a user can see.** Tool starts follow request order at every budget, and node data is
unchanged across budgets. What moves above k = 1 is completion order, and the same argument as
divergence #21 applies to tools; `docs/divergences.md` records it.

**The round budget resets across a resume.** A resumed execution compiles a fresh net, so
`A/rounds` is seeded again from `options.maxIterations`. n8n's own bound is unaffected —
`iterationCount` rides on the request metadata and round-trips through `subNodeExecutionData`,
so `checkMaxIterations` still counts across the pause — and the place cannot bind before that
counter does. The one case where it matters is an agent whose `maxIterations` is an expression:
the compiler's assumed cap starts over each resume, which is one more reason such an agent is
reported as unbounded rather than carrying a claimed bound.

## Boundary review

Five seams were reviewed after the first implementation landed. Four had defects, and none of
them had a failing test — which is the argument for the review rather than for more of the same
tests:

1. **The structural hash omitted the tool wiring and `maxRounds`.** The net cache is keyed by
   `(structural hash, budget)`, so two workflows differing only in which tools an agent is wired
   to hashed alike and shared one compiled net — an agent dispatching through arms built for a
   different workflow. Neither fact is derivable from the main graph. Hash is now v8.
2. **`decodeExecutionData` silently dropped a paused round.** A tool-form node has no `inputs`,
   so the stack loop's join branch iterated nothing and the entry vanished; a resumed execution
   lost every undispatched tool call without a diagnostic. Decode now reassembles the round —
   the agent's re-entry to `A/dispatched`, the tool entries to `A/queue` — and `tests/codec/roundtrip.test.ts` runs a cancelled round through encode, decode and
   completion. Attribution of a tool shared by two agents runs in a second pass, because the
   encoder writes a round's tools *before* its agent and the first version always fell back.
3. **`FakeHost.collectSubNodeResults` was a no-op stub**, so no agent in the differential
   harness ever received its own tool results. Every agent test passed only because its script
   counted rounds in a closure. It is now n8n's implementation, `ScriptContext` exposes the
   `EngineResponse`, and the differ has agent fixtures.
4. **The verify CLI read only `main`.** `n8n-libpetri verify agent.json` analysed a net with no
   round at all — a different net from the one the scheduler runs, reported with the same
   confidence, which is exactly what "one net serves execution and verification" forbids. The
   JSON path now reads `ai_tool` and `options.maxIterations`.

A second review, prompted by the question "is the turn budget hard, so the solver's `proven` is
not resting on an unbounded loop", found that the loop was bounded and the *proof* was not sound:
the round's size was a deposited count, invisible to branch enumeration, so the graph explored one
call in flight where the executor reaches many — §2 above records the finding, the measurement
and the budget that replaced it. The claim in this section was narrowed for one revision and then
restored on the new footing.

The fifth, the reference engine, needed no fix beyond (3): `ReferenceHost` gained
`handleEngineRequest` (the plan plus one `addNodeToBeExecuted` per entry, as n8n does), and the
differ reports **data equal, happens-before respected and order equal at k = 1, 2 and 4** on both
agent fixtures. Its happens-before model needed one correction: a dispatched activation's
`source` names the agent that *asked* for it, not a producer that fed it, and the asking and
answering activations share a run index — so `finish(agent) < start(tool)` is false in n8n
itself. `initializeNodeRunData` marks those runs with a non-`main` `inputOverride`, which is
n8n's own way of saying the same thing, and the differ now excludes them.
