/**
 * `mutual-exclusion` — `A/running` and `B/running` never marked together, for caller-supplied
 * pairs or every pair. At k = 1 every pair holds, which is a sanity check of the budget model
 * rather than a workflow property; at k ≥ 2 it fails for independent nodes, which is the point
 * of the budget.
 */
import { mutualExclusion } from 'libpetri/verification';
import { queryRecord, record } from '../record.js';
import { explain, unknownReason } from '../reasons.js';
import { boundedOrUnknown, graphDecision, smtDecision, type Context, type Decision } from '../route.js';
import { exclusionPairs } from '../shape.js';
import { witnessCounterexample } from '../state-class.js';
import type { CheckSubject, MutualExclusionRequest } from '../types.js';

export async function runMutualExclusion(ctx: Context, request: MutualExclusionRequest): Promise<void> {
  const pairs = exclusionPairs(ctx.map, request);
  // One pass over the classes covers every pair, so `--all-pairs` costs what one pair costs.
  // It runs on a truncated graph too: a class marking both places is a real witness whatever
  // the BFS did, so only the *absence* of one needs the graph to have closed.
  const co = ctx.space.usable ? ctx.space.coMarkings(ctx.map.nodes.map((g) => g.running)) : null;
  for (const [a, b] of pairs) {
    const subject: CheckSubject = { kind: 'node-pair', nodes: [a, b] };
    const ga = ctx.map.tryNode(a);
    const gb = ctx.map.tryNode(b);
    if (ga === undefined || gb === undefined) {
      record(ctx, {
        property: 'mutual-exclusion',
        name: `${a} and ${b} never run at once`,
        subject,
        verdict: 'unknown',
        explanation: 'The pair could not be resolved to two nodes of this workflow.',
        // The sentence `NetMap.node` throws for the first name that does not resolve.
        reason: `NetMap: unknown node '${ga === undefined ? a : b}'`,
        elapsedMs: 0,
        query: { property: 'mutual-exclusion', place: null, verdict: 'unknown', sinks: [], conditionalSinks: [], method: null, route: 'none' },
      });
      continue;
    }
    const property = mutualExclusion(ga.running, gb.running);
    const witness = co === null ? null : co.witness(ga.running, gb.running);
    const decision: Decision = witness !== null
      ? graphDecision('violated', witnessCounterexample(witness))
      : co !== null && ctx.space.complete
        ? graphDecision('proven')
        : boundedOrUnknown(ctx, await smtDecision(ctx, property));
    record(ctx, {
      property: 'mutual-exclusion',
      name: `${a} and ${b} never run at once`,
      subject,
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `${a} and ${b} can never be running at the same time.`,
        violated: `${a} and ${b} can be running at the same time.`,
        unknown: `Whether ${a} and ${b} can overlap was not decided.`,
      }),
      reason: unknownReason(ctx, decision),
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      counterexample: decision.counterexample,
    });
  }
}
