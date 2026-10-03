# RFC: agent tool-call rounds as steps in engine v2

**Draft. Not posted.** Written by an AI agent for the repository owner, who rewrites it before
it goes anywhere. n8n facts are read at master [`944afe5`][pin].

## Summary

Engine v2 accepts agent workflows, but no agent completes on it today. We propose one way to
model an agent's tool calls as step rows that keeps engine v2's rule: "any planner, at any
time, recomputes the same decisions". It is a starting point for discussion. We offer a formal
model and checks for the rules, not the node runtime side.

## What happens today

There are two gaps, and they occur in this order.

1. **Sub-nodes do not reach the step.** The converter roots the graph at the fired trigger
   through `main` connections only ([`rootAt`][rootAt]), so models, memory and tools are
   dropped. [`toV1Workflow`][toV1Workflow] builds the node's `Workflow` from graph nodes and
   `main` edges only ([`toV1Connections`][toV1Connections]). The agent's "Chat Model" input is
   `required` ([`utils.ts:47`][agentInputs]), so `getInputConnectionData` throws
   ["A Chat Model sub-node must be connected and enabled"][requiredCheck]. Our live engine v2
   test server shows this error on three agent workflows (an integration observation, not a
   conformance result). The fix is data plumbing in `node-engine-compatibility`, outside this
   RFC.
2. **A tool call has no step.** An Agent V3 that asks for a tool returns an `EngineRequest`,
   and `V1StepExecutor` throws `EngineRequestNotSupportedError`
   ([`v1-step-executor.ts:211`][throwSite], pinned by [n8n's test][throwTest]). Agent V1 and
   V2 call tools in-process through LangChain, so only gap 1 affects them.

**How many workflows this affects.** We ran n8n's own `V1WorkflowConverter` and
`validateExecutableGraph` (dist at the pin) over 200 public templates and 11 workflows of
our own. One entry is one (workflow, fired trigger) pair.

| entries | all | templates | ours |
|---|---:|---:|---:|
| (workflow, fired trigger) | 310 | 299 | 11 |
| accepted | 209 | 202 | 7 |
| in a workflow with an `ai_tool` connection | 85 | 82 | 3 |
| with a tool-using node on the fired trigger's graph | 69 | 66 | 3 |
| of those: an Agent V3 (gaps 1 and 2) | 12 | 9 | 3 |
| of those: Agent V1/V2 only (gap 1) | 44 | 44 | 0 |
| of those: an MCP Server Trigger (not discussed here) | 13 | 13 | 0 |

The templates column is the sample. Our 11 workflows are test fixtures, and 5 of them are
Agent V3 workflows we built on purpose, so their column is not a sample of anything. Agent V3
is already in the templates: 13 of the 200 contain an Agent at `typeVersion` 3 or 3.1, and 9
accepted template entries reach one from the fired trigger. New agents default to
[version 3.1][defaultVersion].

## Where we start: in v1, the round is a marking

In v1, [`handleRequest`][handleRequest] reserves a run slot per requested tool, pushes the
tools and re-queues the agent under them. [`collectSubNodeResults`][collect] hands the tools'
task data back as an `EngineResponse`. The agent stops itself after `maxIterations` rounds
([`checkMaxIterations`][maxIter]).

Our Petri net model of that loop (run in n8n v1 by an alternative scheduler) makes the round
state, not control flow: pending calls, calls in flight and the agent's re-entry are tokens.
Engine v2 already treats graph steps as state, so the idea maps onto rows.

## Proposal: a round is rows

**Step result.** `StepExecutionResult` gains a third variant beside `outputs` and `wait`:

```ts
{ dispatch: { calls: Array<{ nodeId: string; inputs: StepSlots }>; state: JsonValue } }
```

It has no `n8n-workflow` types, as `AGENTS.md` requires. The compat layer translates an
`EngineRequest` into calls and builds the `EngineResponse` on resume. `state` carries what the
node needs back, such as `iterationCount`.

**Call rows.** Each call is a step row keyed `(parent step, round, ordinal)`, for example
three nullable columns with a unique index. Graph `StepKey`s do not change. Call rows reuse
claim, complete, fail, cancel and waits.

**Rules,** numbered after the five in [`settlement.ts`][rules]:

6. **Request.** A step that returns `dispatch` moves `running → waiting` with the request on
   its row (round *r*). One call row per call is created `queued`, in request order. These
   are separate writes. A waiting step with fewer call rows than calls can be detected from
   the rows alone, as in rule 5.
7. **Call.** A call row runs and settles like any step. Its settlement decides no graph
   successor, because a tool has no `main` out-edge.
8. **Resume.** When every call row of round *r* has settled, the parent goes
   `waiting → queued` by compare-and-set, with a cause that names *r*. The handler of any
   call in the round may try. The CAS makes duplicates no-ops. The parent **runs again**
   with the call outputs read by key. Today's resume path does not run the node again: it
   replays outputs ([`resumedOutputs`][resumed]).
9. **Order.** Calls are created in request order and may run at the same time. Each output
   has its own key, so finishing order cannot move data (v1 reserves run indices for this).
10. **Bounds.** The node bounds the rounds (`maxIterations`). An optional per-execution cap on
    calls bounds the width. When a request would pass the cap, the parent runs again with a
    cause that fails it by name.

| v1 net (round as marking) | v2 rows |
|---|---|
| calls not yet dispatched | calls in the stored request with no row |
| dispatch | call row created `queued` |
| calls outstanding | unsettled call rows of round *r* |
| collect | a call row settles |
| resume, blocked while calls are outstanding | rule 8 |
| one round per agent at a time | the parent is `waiting`, so this holds by structure |
| round budget | `maxIterations`, checked by the node |
| call budget, and the exit when it is spent | rule 10 |

## How the settlement rules extend

- **`decideSuccessors` does not change.** Call rows are not on `main` edges. A waiting parent
  is unsettled, so its successors stay undecidable.
- **Completion does not change** if `countSettledSteps` leaves call rows out. A waiting
  parent cannot settle early, so the count cannot pass early.
- **Failure and cancellation.** `cancelPendingSteps` already cancels queued and waiting rows,
  so it also cancels call rows and the parent. Running calls settle. Rule 8 finds the
  execution not live and resumes nothing, as `handle()` does today.
- **Reconciliation** can detect two new states from rows: a request with missing call rows,
  and a settled round whose parent still waits.
- **The settlement seam (separate RFC):** rule 8 could become `SettlementPolicy.decideResume`.

## What we can contribute

- **A model, and a differential against the implementation.** Our net for engine v2's
  current rules matches `decideSuccessors` with 0 disagreements. These numbers are settlement
  evidence for our model, not conformance numbers for n8n:
  - every event order and every step outcome on 196 graphs of at most 14 nodes, 123,142
    distinct row sets. One graph hit the exploration's 1M cap and is covered only up to
    it;
  - 972,945 state reports (33,367 distinct row sets) from seeded random runs on the 209
    accepted corpus entries.

  The round model exists for v1. Its engine v2 port is **not built**; we would build it once
  the rules are agreed.
- **A property test.** We would extend the settlement-loop property test (offered
  separately) to rounds, with repeated tools, failures, cancellation and redelivery, in every
  delivery order. It would check that each round resumes its parent exactly once, that no call
  row exists outside a request, that no round is left waiting at rest, and that the completion
  count does not change.
- **Findings from verifying v1 rounds**, which apply to any design:
  - a call count kept in a value is invisible to state-space exploration, which then proved a
    net that never ran two tools at once; the budget must be structural;
  - a refunded call budget makes the state space infinite, and a per-round budget cost about
    10 times more to verify than a per-execution one;
  - a spent budget needs a designed exit, or every agent workflow strands a round;
  - with a declared budget of 4, proper completion is proven for one tool (1,464 state
    classes, 29 ms) and two tools (6,313 classes, 113 ms), measured on 2026-09-15 as the
    median of three runs.

## Open questions

1. Gap 1: sub-nodes in the graph, or in the step config? Who owns it?
2. Call rows: columns on the step table, or a separate table?
3. Running again on resume: a new `ResumeCause` kind, or a new parent iteration?
4. While a parent waits for calls, `refreshLiveStatus` would report `waiting`, though nothing
   outside the engine is awaited.
5. A failed call: fail the execution (engine v2's rule), or hand the error to the agent? v1's
   `collectSubNodeResults` hands back each tool's task data, error included. We have not
   measured v1 end to end here.
6. Is a per-execution call cap the engine's job or the node's?
7. Tools that wait (human review), and agents used as tools that issue their own requests:
   is the depth bounded?

[pin]: https://github.com/n8n-io/n8n/tree/944afe5c889f130ac07c1831dd88fa7c7103a5c1
[rootAt]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/node-engine-compatibility/src/v1-workflow-converter.ts#L400
[toV1Workflow]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/node-engine-compatibility/src/v1-adapters.ts#L154
[toV1Connections]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/node-engine-compatibility/src/v1-adapters.ts#L72
[agentInputs]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/nodes-langchain/nodes/agents/Agent/utils.ts#L47
[requiredCheck]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/core/src/execution-engine/node-execution-context/utils/get-input-connection-data.ts#L368-L371
[throwSite]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/node-engine-compatibility/src/v1-step-executor.ts#L211
[throwTest]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/node-engine-compatibility/src/__tests__/v1-step-executor.test.ts#L277
[defaultVersion]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/nodes-langchain/nodes/agents/Agent/Agent.node.ts#L31
[handleRequest]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/core/src/execution-engine/requests-response.ts#L238
[collect]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/core/src/execution-engine/workflow-execute.ts#L1833
[maxIter]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/nodes-langchain/nodes/agents/Agent/agents/ToolsAgent/V3/helpers/checkMaxIterations.ts#L27
[rules]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/settlement.ts#L11-L34
[resumed]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/step-ready-handler.ts#L397
