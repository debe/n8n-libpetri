/**
 * What the ordering rules read off one differential run: gathered once by `compareOrdering`
 * into the `AttributionContext` every move, one-sided and `lastNodeExecuted` rule shares.
 */
import type { AttributionContext } from '../attribution.js';
import type { EngineName, EngineRun } from '../engines.js';
import type { DataComparison } from '../gate-data.js';
import { activationKey } from '../trace.js';
import { reachableOf } from './reach.js';

/** Activations, in either engine, whose recorded `source` has more than one input: multi-input joins. */
function joinActivationsOf(runs: readonly EngineRun[]): Set<string> {
  const joins = new Set<string>();
  for (const run of runs) {
    for (const [node, tasks] of Object.entries(run.runData)) {
      tasks.forEach((task, runIndex) => {
        if (((task.source ?? []) as unknown[]).length > 1) joins.add(activationKey(node, runIndex));
      });
    }
  }
  return joins;
}

export function orderingContext(
  reference: EngineRun,
  candidate: EngineRun,
  data: DataComparison,
  orInputNodes: ReadonlySet<string>,
  oneSided: ReadonlyMap<string, EngineName>,
): AttributionContext {
  return {
    effectiveBudget: candidate.effectiveBudget,
    permutedNodes: data.permutedNodes,
    strandedNodes: data.strandedNodes,
    starvedNodes: data.starvedNodes,
    joinActivations: joinActivationsOf([reference, candidate]),
    reachable: reachableOf([...reference.edges, ...candidate.edges]),
    oneSided,
    candidateOutcome: candidate.outcome,
    destinationNode: reference.runExecutionData.startData?.destinationNode?.nodeName,
    orInputNodes,
  };
}
