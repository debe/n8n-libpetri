/**
 * The differ's fixture set: every workflow in `tests/fixtures/workflows.ts` with a node
 * behaviour per node type, so both engines see identical, deterministic node outputs.
 *
 * Scripts are pure functions of `(executionData, runIndex)` — never of the attempt count,
 * which differs between a sequential and a concurrent run — with the one exception of
 * `retry`'s node A, whose whole point is to fail its first two attempts.
 *
 * Deliberately no `$('Y')` expression parameters: `FakeHost.runNode` does not evaluate
 * expressions, so the reference engine cannot produce n8n's "node is unexecuted" error and
 * divergence #7 is not differentiable on this harness (see `docs/differential.md`).
 */
import type { INodeExecutionData } from 'n8n-workflow';
import type { DifferFixture } from '../../src/conformance/index.js';
import { items, passThrough, sleep, type NodeScript } from '../../src/conformance/index.js';
import type { WorkflowDescription } from '../../src/compiler/index.js';
import { ALL, SHAPES, agentTwoTools, conn, node, workflow, type ShapeName } from '../fixtures/workflows.js';

/** Two items, so a router can put one on each of two outputs. */
export const START = items({ i: 0 }, { i: 1 });

const inputItems = (main: Array<INodeExecutionData[] | null> | undefined): INodeExecutionData[] =>
  (main ?? []).flatMap((input) => input ?? []);

/** Routes item `n` to output `n % outputs`: every output that gets an item is exercised. */
const router = (outputs: number): NodeScript => ({ executionData }) => {
  const data: INodeExecutionData[][] = Array.from({ length: outputs }, () => []);
  (executionData.data.main?.[0] ?? []).forEach((item, index) => data[index % outputs]!.push(item));
  return { data };
};

/** Concatenates every input into output 0, as a Merge in append mode does. */
const merge: NodeScript = ({ executionData }) => ({ data: [inputItems(executionData.data.main)] });

/** Loop Over Items: two loop rounds, then `done`. */
const loop: NodeScript = ({ executionData, runIndex }) => {
  const incoming = executionData.data.main?.[0] ?? [];
  return runIndex < 2 ? { data: [incoming, []] } : { data: [[], incoming] };
};

/**
 * Two rounds, then nothing: the fixture-side bound on a user cycle. n8n's loop has no
 * bound of its own on a cycle whose nodes keep producing (its endless-loop guard only
 * catches the deferred `ensureInputData` case), so an unbounded producer hangs both
 * engines, not just one.
 */
const twoRounds: NodeScript = ({ executionData, runIndex }) =>
  ({ data: [runIndex < 2 ? (executionData.data.main?.[0] ?? []) : []] });

/** Fails its first two attempts, then succeeds: the retry gadget's three tries. */
const flaky: NodeScript = ({ executionData, call }) => {
  if (call < 2) throw new Error('flaky');
  return { data: [executionData.data.main?.[0] ?? []] };
};

function scriptsFor(workflow: WorkflowDescription): Record<string, NodeScript> {
  const scripts: Record<string, NodeScript> = {};
  for (const node of workflow.nodes) {
    const shape = SHAPES[node.type as ShapeName];
    scripts[node.name] = node.type === 'loop'
      ? loop
      : node.type === 'merge' || node.type === 'mergeChoose' || node.type === 'merge3Choose'
        ? merge
        : shape.outputCount > 1 ? router(shape.outputCount) : passThrough;
  }
  return scripts;
}

/** Every fixture, with `retry`'s flaky node overridden. */
/**
 * Two independent two-node chains. The head of the first sleeps, so at k >= 2 the second
 * chain overtakes it and the `executionIndex` order stops being n8n's depth-first one —
 * the only fixture that makes the concurrency attribution fire, because with instantaneous
 * actions the net's start order coincides with n8n's on every acyclic fixture.
 */
export const parallelBranches = workflow('parallel-branches', [
  node('Trigger', 'trigger', [0, 0]),
  node('A1', 'set', [200, 0]),
  node('A2', 'set', [400, 0]),
  node('B1', 'set', [200, 200]),
  node('B2', 'set', [400, 200]),
], [
  conn('Trigger', 0, 'A1', 0), conn('A1', 0, 'A2', 0),
  conn('Trigger', 0, 'B1', 0), conn('B1', 0, 'B2', 0),
], 'Trigger');

/** Sleeps `ms`, then passes its first input through. */
const slow = (ms: number): NodeScript => async ({ executionData }) => {
  await sleep(ms);
  return { data: [executionData.data.main?.[0] ?? []] };
};

/**
 * The stop surface: a fatal node error, a Wait node, a destination-node stop and a run
 * filter. Without these the sweep could not reach registered rows #13 and #17 at all — every
 * shipped fixture ran to completion, so "nothing fails at any budget" was a property of the
 * fixture set rather than of the engine.
 */

/** `Trigger` into three siblings; `A` fails fatally while `B` is still running. */
export const haltBranches = workflow('halt-branches', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('B', 'set', [200, 100]),
  node('C', 'set', [200, 200]),
  node('D', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('Trigger', 0, 'C', 0), conn('B', 0, 'D', 0),
], 'Trigger');

/** `Trigger` → `W` (puts the execution to wait) → `After`. */
export const waitNode = workflow('wait-node', [
  node('Trigger', 'trigger', [0, 0]),
  node('W', 'set', [200, 0]),
  node('After', 'set', [400, 0]),
], [conn('Trigger', 0, 'W', 0), conn('W', 0, 'After', 0)], 'Trigger');

/** The Wait node's own behaviour: set the execution-global `waitTill`, then return normally. */
const putsToWait: NodeScript = ({ executionData, runExecutionData }) => {
  runExecutionData.waitTill = new Date(Date.UTC(2030, 0, 1));
  return { data: [executionData.data.main?.[0] ?? []] };
};

/**
 * The two n8n conformance cases that pass at k = 1 and fail at k > 1, reproduced here so the
 * classification in `docs/conformance-m3.md` is measured rather than argued. n8n's suite
 * asserts a total `nodeExecutionOrder` and stops at the first mismatch, so it can never say
 * whether the *data* still matches; the differ can.
 */

/**
 * n8n `test/helpers/constants.ts` `v1WorkflowExecuteTests` "should run complicated multi node
 * workflow" — node names, canvas positions and connections verbatim (the fixture declares
 * `Merge4` twice; `Workflow` keys nodes by name, so it is one node). Nine nodes, acyclic, one
 * producer per input index, so k-safety leaves the budget alone and k > 1 really runs it
 * concurrently. n8n runs `Start, Set1, Set3, Set4, Set2, Merge1, …`; at k >= 2 the net runs
 * `Start, Set1, Set2, Set3, Merge1, Set4, …` because `Set2` and the `Set3 → Set4` chain have
 * no dependency either way. Every node still runs exactly once with the same payload.
 */
export const complicatedMulti = workflow('complicated-multi', [
  node('Merge4', 'merge', [1150, 500]),
  node('Set2', 'set', [290, 400]),
  node('Set4', 'set', [850, 200]),
  node('Set3', 'set', [650, 200]),
  node('Merge3', 'merge', [1000, 400]),
  node('Merge2', 'merge', [700, 400]),
  node('Merge1', 'merge', [500, 300]),
  node('Set1', 'set', [300, 200]),
  node('Start', 'trigger', [100, 300]),
], [
  conn('Start', 0, 'Set1', 0), conn('Start', 0, 'Set2', 0), conn('Start', 0, 'Merge4', 1),
  conn('Set1', 0, 'Merge1', 0), conn('Set1', 0, 'Set3', 0),
  conn('Set2', 0, 'Merge1', 1), conn('Set2', 0, 'Merge2', 1),
  conn('Set3', 0, 'Set4', 0),
  conn('Set4', 0, 'Merge3', 0),
  conn('Merge1', 0, 'Merge2', 0),
  conn('Merge2', 0, 'Merge3', 1),
  conn('Merge3', 0, 'Merge4', 0),
], 'Start');

/**
 * n8n `webhook-respond-branch-order.test.ts` — a `responseMode: responseNode` webhook fanning
 * out to the work node (y = 500) and to a shared Respond node (y = 1000). The case
 * "skips the Respond node when the work node runs first and fails" asserts that only
 * `Webhook` and `Agent` run. At k >= 2 both children hold a budget unit from the same
 * scheduling cycle, so `Respond to Webhook` is already in flight when `Agent` throws and the
 * net cannot un-start it (divergence #17). Positions and connection order are n8n's.
 */
export const webhookRespond = workflow('webhook-respond', [
  node('Webhook', 'trigger', [0, 500]),
  node('Agent', 'set', [300, 500]),
  node('Respond to Webhook', 'set', [300, 1000]),
], [
  conn('Webhook', 0, 'Agent', 0), conn('Webhook', 0, 'Respond to Webhook', 0),
], 'Webhook');

const OVERRIDES: Readonly<Record<string, Readonly<Record<string, NodeScript>>>> = {
  retry: { A: flaky },
  userCycle: { B: twoRounds },
};

/**
 * An agent that asks for `tools` for `rounds` rounds and answers after that.
 *
 * **Stateless on purpose.** The differ runs one fixture on both engines, so a closure counter
 * would let the first run starve the second. It reads the round off the `EngineResponse` the
 * engine hands it — which is what a real agent does too: `checkMaxIterations` counts
 * `response.metadata.iterationCount`, and that metadata round-trips through
 * `subNodeExecutionData` exactly so the node can.
 */
function agentAsking(tools: readonly string[], rounds = 1): NodeScript {
  return ({ response }) => {
    const done = (response?.metadata as { round?: number } | undefined)?.round ?? 0;
    if (done >= rounds) return { data: [items({ answer: 'done' })] };
    const round = done + 1;
    return {
      actions: tools.map((nodeName, i) => ({
        actionType: 'ExecutionNodeAction' as const, nodeName, input: { q: nodeName }, type: 'ai_tool' as const,
        id: `call_${round}_${i}`, metadata: {},
      })),
      metadata: { round },
    };
  };
}

export const DIFFER_FIXTURES: readonly DifferFixture[] = [
  ...Object.entries(ALL).map(([name, description]) => ({
    name,
    workflow: description,
    scripts: { ...scriptsFor(description), ...(OVERRIDES[name] ?? {}) },
    options: { startItems: START },
  })),
  {
    // Agent tool dispatch: `Agent` asks for both tools, they run, it answers. n8n pushes them
    // onto one stack and runs them in request order; the net dispatches them into a round. At
    // k = 1 both engines run the same activations in the same order, which is what this pins.
    name: 'agentRound',
    workflow: agentTwoTools,
    scripts: {
      ...scriptsFor(agentTwoTools),
      Agent: agentAsking(['Calculator', 'Search']),
    },
    options: { startItems: START },
  },
  {
    // One tool, two rounds: the agent asks again after the first answer, so the round loop runs
    // twice and `A/rounds` is spent down to its last token.
    name: 'agentTwoRounds',
    workflow: agentTwoTools,
    scripts: {
      ...scriptsFor(agentTwoTools),
      Agent: agentAsking(['Calculator'], 2),
    },
    options: { startItems: START },
  },
  {
    name: 'parallelBranches',
    workflow: parallelBranches,
    scripts: { ...scriptsFor(parallelBranches), A1: slow(25) },
    options: { startItems: START },
  },
  {
    // `A` throws under the default `onError` (stopWorkflow) at 1 ms while `B` is 20 ms in:
    // n8n's loop `break`s and leaves `B` unrun, the net cannot un-start `B` (divergence #17).
    name: 'haltInFlight',
    workflow: haltBranches,
    scripts: {
      ...scriptsFor(haltBranches),
      A: async () => { await sleep(1); throw new Error('A failed'); },
      B: slow(20),
    },
    options: { startItems: START },
  },
  {
    // The Wait node: one execution-global `waitTill`, n8n `break`s right after the node that
    // set it, and the marking codec has to leave the same resumable state behind.
    name: 'waitTill',
    workflow: waitNode,
    scripts: { ...scriptsFor(waitNode), W: putsToWait },
    options: { startItems: START },
  },
  {
    // A destination-node stop on a node fed by two producers: n8n keeps popping the stack
    // after it and runs the second arrival, the net deposits `_pause` (divergence #13).
    name: 'destinationStop',
    workflow: ALL.multiProducer!,
    scripts: scriptsFor(ALL.multiProducer!),
    options: { startItems: START, destinationNode: 'C' },
  },
  {
    // A run filter: n8n pops the excluded entry and drops it at `isNodeFilteredOut` without
    // running it; the net's `X_run` does the same, so both engines must agree exactly.
    name: 'runFilter',
    workflow: ALL.diamond!,
    scripts: scriptsFor(ALL.diamond!),
    options: { startItems: START, runNodeFilter: ['Trigger', 'IF', 'A', 'Merge', 'End'] },
  },
  {
    // n8n's own "should run complicated multi node workflow": the k > 1 conformance leg fails
    // it on `nodeExecutionOrder` alone, and this run is the evidence that the data is equal.
    name: 'complicatedMulti',
    workflow: complicatedMulti,
    scripts: scriptsFor(complicatedMulti),
    options: { startItems: START },
  },
  {
    // n8n's own "skips the Respond node when the work node runs first and fails": the second
    // k > 1 conformance regression, and the one that is a registered abandonment (#17).
    name: 'webhookRespond',
    workflow: webhookRespond,
    scripts: {
      ...scriptsFor(webhookRespond),
      Agent: () => { throw new Error('Model call failed'); },
    },
    options: { startItems: START },
  },
];

export default DIFFER_FIXTURES;
