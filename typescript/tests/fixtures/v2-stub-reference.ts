/**
 * A stand-in for n8n's settlement code, for the suites that run the engine v2 reference loop
 * (`src/conformance/v2/reference.ts`) with no `.n8n`: rules 2–4 of `settlement.ts` for graphs
 * **without a loop**, written here. It lets the loop and the differential's comparisons run; no
 * claim about n8n's answers rests on it. That claim is the `tasks/` scripts', which inject the
 * pinned `dist` (`tasks/spike-v2-settlement.mts`, `tasks/v2-differential.mts`).
 */
import type { StepKey } from '../../src/codec/v2/step-rows.js';
import type { ReferenceRow, SettlementReference } from '../../src/conformance/v2/reference.js';
import type { V2Graph } from '../../src/conformance/v2/graph.js';

/** The stub's `stepKeyId`: `node:iteration`. */
export const stubKeyId = (k: StepKey): string => `${k.nodeId}:${k.iteration}`;
const id = stubKeyId;
const SETTLED = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/** Rule 3 for one candidate at iteration 0: undecidable, queued or skipped. */
function fateOf(graph: V2Graph, nodeId: string, steps: Readonly<Record<string, ReferenceRow>>): 'queued' | 'skipped' | undefined {
  let live = false;
  for (const e of graph.edges.filter((x) => x.to === nodeId)) {
    const source = steps[id({ nodeId: e.from, iteration: 0 })];
    if (source === undefined || !SETTLED.has(source.status)) return undefined;
    if (source.status === 'completed' && source.filledOutputSlots[e.outputIndex]) live = true;
  }
  return live ? 'queued' : 'skipped';
}

const successors = (graph: V2Graph, nodeId: string): string[] =>
  [...new Set(graph.edges.filter((e) => e.from === nodeId).map((e) => e.to))];

function descendants(graph: V2Graph, nodeId: string): string[] {
  const out: string[] = [];
  for (let i = -1; i < out.length; i++) {
    for (const s of successors(graph, i < 0 ? nodeId : out[i]!)) if (s !== nodeId && !out.includes(s)) out.push(s);
  }
  return out;
}

/** A stand-in for n8n's settlement code on graphs without a loop. Not n8n: see the module doc. */
export const stub: SettlementReference = {
  decideSuccessors: (graph, _loops, settled, steps) => {
    const plan = { toQueue: [] as StepKey[], toSkip: [] as StepKey[] };
    for (const to of successors(graph, settled.nodeId)) {
      const key = { nodeId: to, iteration: 0 };
      if (steps[id(key)] !== undefined) continue;
      const fate = fateOf(graph, to, steps);
      if (fate === 'queued') plan.toQueue.push(key);
      else if (fate === 'skipped') plan.toSkip.push(key);
    }
    return plan;
  },
  decisionKeys: (graph, _loops, settled) => {
    const keys = [settled];
    for (const to of successors(graph, settled.nodeId)) {
      keys.push({ nodeId: to, iteration: 0 });
      for (const e of graph.edges.filter((x) => x.to === to)) keys.push({ nodeId: e.from, iteration: 0 });
    }
    return keys;
  },
  countExpectedSettledSteps: (_loops, reachable) => reachable.size,
  deriveLoops: () => [],
  isTerminalStep: (step) => SETTLED.has(step.status) && !step.filledOutputSlots[1],
  exitSourcesInto: () => [],
  stepKeyId: id,
  findTriggerNode: (graph) => graph.nodes.find((n) => n.type === 'trigger'),
  getDescendantNodeIds: descendants,
  getSuccessorNodeIds: successors,
};
