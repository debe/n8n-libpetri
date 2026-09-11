# The live testbed

Everything else in this repository measures the engine against `FakeHost` — a structural mirror
of patch 0001, good enough to run n8n's own execution-engine cases and to diff two schedulers
against each other, and deliberately not n8n. `docs/conformance-final.md` records the `cli`
scope as **registered, never entered**: the engine had never once been constructed by the
process n8n actually ships.

The testbed closes that gap. It boots the real `packages/cli`, with the real editor, the real
node types, the real task runner, real credentials and real persistence, and installs
`PetriScheduler` into it. Two workflows are seeded so there is something to press.

```bash
scripts/testbed/n8n-testbed.sh                 # libpetri, k = 4, http://127.0.0.1:5678
scripts/testbed/diff-engines.sh                # both engines, headless, compared
scripts/testbed/browser-check.sh               # drive the editor, screenshot the canvas
```

## What it is, and what it is not

It is an **integration and demonstration harness**. It is not a conformance measurement, and no
number here belongs in a headline: `scripts/run-conformance.sh` remains the authority on case
counts, and the reporting rule in `CLAUDE.md` applies to it, not to this. What the testbed adds
is a different kind of evidence — that the seam holds in the process that has n8n's own
dependency injection, module loading, credential decryption and task-runner IPC around it.

## How the engine gets in

n8n does not read `N8N_EXECUTION_ENGINE`; patch 0002 exposes `setWorkflowSchedulerFactory` and
nothing more, and an external process decides whether to call it. The conformance suite calls it
from a generated vitest `setupFiles` shim. A server has no such seam, so the testbed calls it
from an `--import` preload, `scripts/testbed/preload.mjs`:

```
node --import scripts/testbed/preload.mjs .n8n/packages/cli/bin/n8n start
```

Three details decide whether that works.

**`createRequire`, not `import`.** `packages/core` builds to CommonJS and `n8n-libpetri` is
ESM-only, so the preload resolves `n8n-core` and `n8n-workflow` through a `require` rooted at
`packages/cli/package.json`. Node resolves pnpm's symlinks to their realpath, so the registry
the preload writes to is the same CJS module instance `WorkflowExecute` later reads from.

**`--import`, not `NODE_OPTIONS`.** `bin/n8n` never re-execs, so a command-line preload covers
the process. `NODE_OPTIONS` would also load it into the internal task-runner child, which never
constructs a scheduler.

**No fallback.** If any of that fails the preload throws and n8n does not start. A testbed that
quietly runs n8n's stack loop while claiming to run the net would be worse than one that
refuses to boot. Both directions are checked:

```
$ N8N_EXECUTION_ENGINE=legacy   node --import scripts/testbed/preload.mjs -e "0"
                                                     # inert, exits clean
$ N8N_EXECUTION_ENGINE=libpetri node --import scripts/testbed/preload.mjs -e "0"
Error: N8N_LIBPETRI_RESOLVE_FROM is not set          # refuses rather than degrades
```

### Two claims, two lines

The log carries them separately, because they are not the same statement:

```
[n8n-libpetri] scheduler registered: budget=4, hook=…/typescript/dist/index.js
[n8n-libpetri] engine entered: n8n constructed a scheduler through the registered factory
```

Registration is true at boot. **Entry** is `ENGINE_ENTERED_DIAGNOSTIC`, emitted by the factory
itself the first time n8n constructs a scheduler through it, and only an execution can
establish it. `docs/conformance-final.md` keeps the same distinction for the same reason.

### `packages/core` must be rebuilt

The server loads `packages/core/dist`, not `src`. A `dist` older than the patch runs an older
seam — and since M7, patch 0001 adds `planEngineRequest`, which the agent round calls. The
launcher rebuilds when `dist` is older than the patched source and then asserts both
`getWorkflowSchedulerFactory` and `planEngineRequest` are in the built file. The rebuild is
shared state with `scripts/run-conformance.sh --scope=cli`, whose own guard greps the same
built file; rebuilding from the patched source can only make that leg more correct.

## The six workflows

All six set `settings.executionOrder: "v1"`. Without it `PetriScheduler` delegates straight to
n8n's `StackScheduler` (divergence #3) and the testbed would silently demonstrate the thing it
replaces.

### Concurrency Showcase — 13 nodes

```
Manual Trigger → Seed → Route (If)
  false → Skipped
  true  → Fan → Fetch A | Fetch B | Fetch C | Fetch D     (Code, each sleeps 1.2 s)
Fetch A, Fetch B → Merge AB        Fetch C, Fetch D → Merge CD
Merge AB, Merge CD → Merge All → Summarise
```

Acyclic, with one producer per input index — which is what the k-safety check needs to leave
the budget alone. A cyclic SCC or a multi-producer index lowers the effective budget to 1, so
`Skipped` is a terminal node of its own rather than a second producer into `Merge All`: wiring
it there would have deleted the concurrency without saying so.

Every payload is deterministic. The legs return `{ leg: 'A' }` and not a timestamp, and
`Summarise` reports `{ legs: 4, order: 'A,B,C,D' }` — `append` concatenates input 0 then input 1
whatever order the branches finished in. The wall clock is measured from outside, so nothing
time-dependent has to travel through the data channel that the legacy/libpetri comparison reads.

### Agent · Two Tools — 6 nodes

```
Manual Trigger → AI Agent (typeVersion 3.1, options.maxIterations 4) → Answer
Stub Chat Model  --ai_languageModel-->  AI Agent
Calculator       --ai_tool---------->   AI Agent
Fact_Lookup      --ai_tool---------->   AI Agent
```

`maxIterations` is the number the compiler seeds `A/rounds` from (ADR 0008 §2), which is what
makes the round cycle bounded. Two tools rather than one, because one exercises the round and
two exercise the **pending marker** — `A_dispatch` fires per call, `A/pending` counts them, and
`A_collect` closes the round when the last lands. Not the shared-tool shape: `agentSharedTool`
verifies as `violated` and it is a false alarm (`tasks/todo.md`).

The model is `scripts/testbed/stub-llm.mjs`, a local OpenAI-compatible server — no key, no
bill, no network, and a fixed script: the first call returns one `tool_calls` message naming
every tool the agent offered, the second returns a plain answer. Tool names and arguments are
read off the request's own `tools` array, so renaming a node cannot desynchronise the stub.

Two configuration details are load-bearing. n8n reaches the stub through the **credential's**
`url`, because `LmChatOpenAi` only validates `options.baseURL` and takes `credentials.url`
unguarded. And `responsesApiEnabled` defaults to **true** at typeVersion ≥ 1.3, so the workflow
turns it off explicitly; otherwise the node calls `POST /v1/responses` rather than chat
completions.

### Agent · Tool-Call Budget — 7 nodes

```
Manual Trigger → Confused Agent (maxIterations 30) ─0→ Answer
                                                   └─1→ Budget Exhausted
Stub Chat Model  --ai_languageModel-->  Confused Agent
Calculator       --ai_tool---------->   Confused Agent
Fact_Lookup      --ai_tool---------->   Confused Agent
```

The agent that will not stop. Its prompt carries the marker `[stub:loop]`, which makes
`stub-llm.mjs` answer **every** call with tool calls and never with `finish_reason: "stop"` —
the failure users report against the real thing ("if a tool returns an unexpected result or if
the agent gets 'confused' … it enters an infinite loop—calling the same tools repeatedly"),
made deterministic and offline. The marker travels in the workflow's own prompt, so nothing
outside the workflow arms it.

The agent declares:

```jsonc
"onError": "continueErrorOutput",
"executionPolicy": { "v": 1, "maxToolCalls": 6,
                     "onFailure": [ { "action": "route", "output": "error" } ] }
```

`onError` declares the *port* — `NodeHelpers.getNodeOutputs` appends the error output on that
field alone — and `onFailure` declares the *policy* that reaches it. This is the pair ADR 0009 §1
separates, in the one shape where the difference is visible: n8n has no tool-call budget to run
out of, so without the policy there would be nothing to route.

`maxIterations` is deliberately left at n8n's own default of 30, because the point is that it is
the wrong bound: it caps *rounds*, and a model may request any number of calls in one.

**Measured, one manual leg each** (`n8n execute` through `scripts/testbed/run.mjs`; the legacy
leg came from `diff-engines.sh`, the net leg from a `--daemon` server at k = 4):

| leg | model calls | tool executions | how it ended | node status | wall |
|---|---|---|---|---|---|
| legacy | 30 | **60** | `Max iterations (30) reached` | `success` | 378 ms |
| libpetri k=4 | 4 | **6** | `Tool-call budget (6) reached` | `error` | 579 ms |

Both route the failure to `Budget Exhausted`, and both finish the execution as `success` — the
declared branch is taken either way. What differs is the price of finding out: **ten times the
tool calls**, and in a real workflow those are billed API calls, not a local stub.

Two details worth stating rather than smoothing over:

- **The node statuses differ, and legitimately.** `checkMaxIterations` throws *inside* the
  agent's `Promise.allSettled` batch (`ToolsAgent/V3/helpers/executeBatch.ts:81`); under
  `continueOnFail` the rejection becomes a per-item `{ json: { error } }` on the success path,
  which is divergence #27's mechanism, so the node is `success` with an error item. Our budget is
  an engine-level failure raised before `runNode`, so it goes through
  `handleNodeExecutionError` and the node is `error`. Same destination, different cause.
- **The tools show 4 runs each, of which the 4th never executed** — divergence #29. n8n's
  `handleRequest` reserves a `runData` slot per requested action before anything runs; the net
  then declines to dispatch the two the budget cannot pay for, and the reservation stays behind
  with `startTime: 0`.

`tests/scheduler/agent.test.ts` pins the same mechanism against `FakeHost`, deterministically
and without a server.

### Agent · Tool Deadline — 5 nodes

```
Manual Trigger → AI Agent (maxIterations 3) → Answer
Stub Chat Model  --ai_languageModel-->  AI Agent
Slow_Service     --ai_tool---------->   AI Agent      (HTTP Request Tool -> stub /hang)
```

The policy is on the **tool**, which is the node that actually calls the service:

```jsonc
"executionPolicy": { "v": 1, "timeoutMs": 3000, "onFailure": [ { "action": "continue" } ] }
```

`/hang` never answers and the socket is deliberately left open — [IO-013] is explicit that
abandoning a firing is a capability, not a guarantee, and this is where that shows. The workflow
sets `settings.executionTimeout: 20`, because n8n's whole-execution timeout is the *only* bound
it has here: there is no per-tool deadline at any level, and `maxIterations` does not help, since
the agent never gets as far as a second iteration.

Only three of the four actions mean anything on a tool. A tool's outcome is its agent's
`A/response`, not a main edge, so `route` has nowhere to go and the compiler refuses it by name.
`continue` is n8n's own default for a failing tool — `workflow-execute.ts`: *"AI tools default to
continue-on-fail so the agent receives the error as a tool response"* — and `retry` and `stop`
behave as they do anywhere else.

**Measured, one leg each:**

| leg | `Slow_Service` | `AI Agent` | execution | wall |
|---|---|---|---|---|
| legacy | never completes, status unset | never recorded | **canceled**, `finished: false` | **20,083 ms** |
| libpetri k=4 | `error` — *"Attempt 1 of \"Slow_Service\" did not finish within 3000 ms and was abandoned"* | `success` | **success** | **3,592 ms** |

Same workflow, same hung service. n8n's only bound is global and it takes the whole execution
with it; the per-tool deadline loses the tool call and nothing else — the agent receives the
error as its tool response, answers, and `Answer` runs. `tests/scheduler/agent.test.ts` pins the
same four behaviours against `FakeHost` without a server.

### Failure Policy Showcase — 5 nodes

Two branches off the trigger, each calling the testbed's own stub over HTTP:

```
Trigger ─┬─ Flaky Service (/flaky?fail=2) ── Recovered
         └─ Hung Service  (/hang)         ── Gave Up
```

`Flaky Service` returns 503 twice for a given key and then 200, so it is a real non-2xx and a
real n8n node error rather than a `throw` in a Code node. `Hung Service` never answers at all.
Neither node sets `retryOnFail` or `onError`; each carries an `executionPolicy` instead
(ADR 0009):

```jsonc
"Flaky Service": { "v": 1, "onFailure": [
  { "action": "retry", "waitMs": 250 }, { "action": "retry", "waitMs": 1000 }, { "action": "stop" } ] }

"Hung Service":  { "v": 1, "timeoutMs": 1500, "onFailure": [
  { "action": "retry", "waitMs": 0 }, { "action": "continue" } ] }
```

The stub keys `/flaky` on `$execution.id`, so every run starts from a fresh failure count.

### Resilient Fan-Out — 7 nodes

The one that puts both halves together: concurrency *and* resilience, declared in the workflow
rather than arranged by the engine's configuration.

```
Trigger ─┬─ Inventory API (/slow?ms=3000) ─┐
         ├─ Pricing API   (/flaky?fail=2)  ├─ Merge (4 inputs) ── Order Summary
         ├─ Shipping API  (/hang)          │
         └─ Reviews API   (/slow?ms=3000) ─┘
```

Four independent branches, so the budget has something to spend. Two are healthy and slow, one
fails twice before recovering, and one never answers at all. The two that need a policy declare
one; the other two declare nothing:

```jsonc
"Pricing API":  { "v": 1, "onFailure": [
  { "action": "retry", "waitMs": 400 }, { "action": "retry", "waitMs": 800 }, { "action": "stop" } ] }

"Shipping API": { "v": 1, "timeoutMs": 2500, "onFailure": [
  { "action": "retry", "waitMs": 0 }, { "action": "continue" } ] }
```

Every node is an ordinary `n8n-nodes-base.httpRequest` against the testbed's own stub, and the
Merge is n8n's own. Nothing here is a Petri net concept: the workflow reads as a workflow.

## What was measured

n8n 2.37.0 at the pin `441970b2`, Node 26.8.1, macOS, k as shown, best of two runs per leg,
2026-09-10. `diff-engines.sh` produced this.

| Workflow | leg | wall clock | data vs n8n | happens-before | order |
| --- | --- | --- | --- | --- | --- |
| Concurrency Showcase | legacy (reference) | 4944 ms | — | 14 edges ok | — |
| | libpetri k = 1 | 4944 ms | identical | 14 edges ok | same |
| | libpetri k = 4 | **1284 ms** | identical | 14 edges ok | **reordered** |
| Agent · Two Tools | legacy (reference) | 131 ms | — | 2 edges ok | — |
| | libpetri k = 1 | 129 ms | identical | 2 edges ok | same |
| | libpetri k = 4 | 130 ms | identical | 2 edges ok | same |

Four independent 1.2 s legs, so 5 s sequentially and 1.2 s four-wide: the net returns 1284 ms
against n8n's 4944 ms, and costs nothing measurable at k = 1 — 4944 ms, the same figure to the
millisecond. The reorder is the whole difference —

```
n8n            … Fan → Fetch A → Fetch B → Merge AB → Fetch C → Fetch D → Merge CD → …
libpetri k = 4 … Fan → Fetch A → Fetch B → Fetch C  → Fetch D → Merge AB → Merge CD → …
```

n8n enqueues `Merge AB` as soon as its two inputs have arrived and runs it before it starts
`Fetch C`; the net starts all four legs, because nothing orders them. Every node still runs
exactly once with the same payload, and every realised dependency edge is still respected.

### How each column is decided

The three are kept apart on purpose, because the claim is that **the data is identical and the
order is not** — folding them into one verdict would report the feature as a failure.

- **Data** compares each node's `ITaskData` field by field, minus `startTime`, `executionTime`
  and `executionIndex`. That field list mirrors `comparableTask` in `src/conformance/differ.ts`,
  which leaves the same three out for the same reason: they are clocks and positions, not data.
- **Happens-before** takes `dependencyEdges` from the same module — the *realised* dependency
  graph, read off the `source` n8n stamps on every task — and checks each edge inside each leg.
  The observation is n8n's own per-task clock, since a live server produces no `runNode` trace;
  an edge holds when the producer's `startTime + executionTime` is at or before the consumer's
  `startTime`. Independent activations are free to be unordered: that is the concurrency.
- **Order** is `executionOrder` over n8n's own `executionIndex`. Reported, never asserted.

### The failure policy, both engines

Run through the same manual-execution endpoint, 2026-09-10, k = 4:

| leg | outcome | wall | Flaky Service | Hung Service | downstream |
| --- | --- | ---: | --- | --- | --- |
| legacy (n8n's own loop) | **error** | 70 ms | `error` on the first 503 | never reached | neither ran |
| libpetri, chain declared | **success** | 3,086 ms | `success` after 3 calls | `error` after 2 × 1,500 ms | both ran |

Three things this leg is for, none of which a unit test can show:

- **The carrier survives the real stack.** The policy goes in through the same
  `POST /rest/workflows` the editor uses and comes back out of the database byte-for-byte. That
  is the claim ADR 0009 §2 rests on, and the types alone cannot establish it.
- **The deadline ends a hang.** A service that never answers costs 3 s and a recorded error
  instead of holding the node until n8n's whole-execution timeout. The socket stays open — IO-013
  is explicit that abandoned work is not cancelled — and the run finishes anyway.
- **The layering test passes.** n8n's own scheduler ran the *same document* without complaint,
  ignoring a key it does not know. A workflow carrying an execution policy stays meaningful under
  the engine that cannot honour it, which is what makes the carrier an interface rather than a
  leak.

The legacy row is not "n8n cannot retry": `retryOnFail` would have recovered the flaky branch.
It is that the declared policy is ignored, and that n8n has no per-attempt delay and no per-node
deadline to declare in the first place.

### Resilient Fan-Out, three legs

Same workflow, same stub, through the manual-execution endpoint, 2026-09-10:

| leg | outcome | wall | what happened |
| --- | --- | ---: | --- |
| legacy (n8n's own loop) | **error** | 3,106 ms | Inventory ran, Pricing hit its first 503, the execution stopped. Shipping, Reviews and Merge never ran |
| libpetri k = 1 | **success** | 12,654 ms | every branch answered, one after another |
| libpetri k = 4 | **success** | **5,123 ms** | every branch answered, all four in flight |

The k = 4 timeline, from n8n's own per-task clock:

| node | status | started | took |
| --- | --- | ---: | ---: |
| Trigger | success | +0 ms | 1 ms |
| Pricing API | success | +2 ms | 1,258 ms |
| Inventory API | success | +2 ms | 3,014 ms |
| Reviews API | success | +2 ms | 3,015 ms |
| Shipping API | **error** | +2 ms | 5,057 ms |
| Merge | success | +5,060 ms | 2 ms |
| Order Summary | success | +5,062 ms | 1 ms |

All four branches start within **2 ms** of each other, and the run is bounded by the slowest of
them rather than by their sum — 5,123 ms against 12,654 ms sequential, a 2.5× cut on a workflow
whose author wrote no concurrency anywhere. Pricing's 1,258 ms is three calls with 400 ms and
800 ms between them; Shipping's 5,057 ms is two attempts abandoned at their 2.5 s deadline,
after which `continue` let the branch carry a payload into the Merge and the workflow finish.
The legacy leg is the same document under the engine that ignores the policy.

### Reading the canvas: why the Error arc is grey

Shipping API's Error arc is labelled **1 item** and drawn **grey**. Both are correct, and they
answer different questions — worth knowing before anyone films it and worries.

The label comes from `runDataTotal` on the connection. The stroke comes from the *source node's*
status, through four steps in n8n's own editor:

1. `handleNodeExecutionError` sets `taskData.executionStatus = 'error'` unconditionally, even for
   a failure it then continues past. Shipping API really did fail, twice.
2. `computeHasIssues(nodeId)` returns true for `'error'` or `'crashed'`
   (`useWorkflowDocumentRenderData.ts`).
3. `getConnectionStatus` matches `error: hasIssuesByNodeId.get(connection.source)`, and
   `CONNECTION_STATUS_PRIORITY = ['running', 'pinned', 'error', 'success']` — **`error` outranks
   `success`**, so the arc is `error` even though `success` matched too
   (`useCanvasMapping.ts`).
4. `CanvasEdge.vue` colours only `success` and `pinned`; everything else falls through to grey.

So **grey means "the source node has issues", not "no data flowed"** — which is why *both* of
Shipping API's arcs are grey, including the Success one. It is n8n's rendering, not the engine's:
in the ordinary n8n case an error-output arc *is* green, because the node emitted per-item errors
and its own status stayed `success`, so `hasIssues` is false and `success` wins. A whole-node
failure is red, and a red node's arcs are grey.

Making it green would mean stamping the node `executionStatus: 'success'` — untrue, and it would
remove the red badge that is the point of the frame.

### The video

`scripts/testbed/record-demo.sh` records a run in the editor:

```bash
scripts/testbed/record-demo.sh                       # Resilient Fan-Out at k = 4
scripts/testbed/record-demo.sh --workflow="Agent · Two Tools" --budget=1
```

Video: `.testbed/video/<workflow>-<engine>-k<budget>.webm`.

It does **not** use `agent-browser record`, for two measured reasons. That recorder opens a
fresh browser context, and n8n binds its auth JWT to a browser id it keeps per context, so the
recorded session lands back on the login page however faithfully cookies are copied. And its
screencast is change-driven: it collapsed a five-second execution into a two-frame flipbook,
which is the one thing the video exists to show. The script screenshots the viewport on a fixed
interval instead, polling n8n's REST API for the execution's status rather than the DOM for a
toast that auto-dismisses, and hands the frames to ffmpeg.

One screenshot costs about 1.2 s of CLI round trip, so the result is a **time-lapse of real
editor frames**, not a smooth screencast: a five-second run yields four or five frames of
itself. That is enough for the shape — every branch dispatched at once, one of them ending red,
the workflow finishing anyway — and every frame is the real editor.

## Caveats

- **Divergence #17 is not reachable here.** Neither workflow uses a `responseMode: responseNode`
  webhook, which is the one k > 1 behaviour change with a user-visible shape. A green table here
  is not a general licence to raise `k`.
- **At k > 1 the agent's tools run concurrently** where n8n runs them one at a time (divergence
  #23). That is why the agent leg is run at k = 1 and k = 4 both. The stub sorts the tool
  results it echoes so that collection order cannot leak into the data channel — otherwise an
  ordering difference would be reported as a data difference.
- **The captures are the figure's only source.** `docs/img/gen-fanout.py` reads
  `.testbed/runs/concurrency-showcase.{legacy,libpetri-k4}.json` and draws the README's animated
  timeline from them — bars, totals, ratio and captions alike — so re-measuring and regenerating
  belong in one step. `.testbed/` is gitignored, so that script is where those numbers enter the
  repository.
- **The browser timings are demonstration figures.** `browser-check.sh` brackets the round trip
  as well as the execution. `diff-engines.sh` is where the wall clock is measured.
- **State is disposable.** Everything lives in `.testbed/` (gitignored): the sqlite database, the
  logs, the captures, the screenshots. `--fresh` wipes it. The encryption key is a fixed
  testbed constant, and the stub credential holds a fake key pointing at localhost.
