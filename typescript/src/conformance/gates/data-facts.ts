/**
 * What the data rules read besides the difference itself, gathered once per run by
 * `compareData`: the nodes whose runs came out permuted, the stranded and starved joins with
 * their downstream closures, and the run facts the direction of a count difference needs.
 */
import { strandedNodesOf, type DataAttributionFacts } from '../attribution.js';
import type { EngineRun } from '../engines.js';
import type { RunDataComparison } from './run-data.js';

/** `roots` and everything downstream of them. */
function closureOf(roots: readonly string[], descendants: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const closure = new Set<string>(roots);
  for (const node of roots) for (const d of descendants.get(node) ?? []) closure.add(d);
  return closure;
}

export function dataFactsOf(
  reference: EngineRun,
  candidate: EngineRun,
  runData: RunDataComparison,
  descendants: ReadonlyMap<string, ReadonlySet<string>>,
): DataAttributionFacts {
  const stranded = strandedNodesOf(candidate.diagnostics);
  // The other direction: a join n8n left in `waitingExecution` and never ran (divergence #1).
  const starved = Object.keys(reference.runExecutionData.executionData?.waitingExecution ?? {});
  return {
    permutedNodes: runData.permuted,
    strandedNodes: stranded,
    strandedClosure: closureOf(stranded, descendants),
    starvedNodes: starved,
    starvedClosure: closureOf(starved, descendants),
    countDiffers: runData.countDiffers,
    runData: { n8n: reference.runData, libpetri: candidate.runData },
    candidateOutcome: candidate.outcome,
    destinationNode: reference.runExecutionData.startData?.destinationNode?.nodeName,
  };
}
