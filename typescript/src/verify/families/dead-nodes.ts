/**
 * `dead-nodes` — is `X/running` reachable? The graph answers by enumeration; the SMT fallback
 * asks `unreachable({X/running})`. Only the *unreachable* direction becomes a verdict, and
 * because that is the finding, the check reports `violated` (`types.ts`). A node the route
 * *reaches* is `unknown`, never `proven` (VER-004 AC3, `reasons.ts` `LIVENESS_REASON`), and so
 * is a node that is dead only because n8n starts one trigger per execution (`shape.ts`
 * `alternativeEntryReach`).
 */
import { unreachable } from 'libpetri/verification';
import { queryRecord, record } from '../record.js';
import { LIVENESS_REASON, unknownReason } from '../reasons.js';
import { graphUnreachable, smtDecision, type Context } from '../route.js';
import type { CheckVerdict } from '../types.js';

/**
 * `unreachable({X/running})`: only the *proven* direction is a verdict (see
 * `LIVENESS_REASON`). The graph decides every node in one pass when it is complete,
 * which is the family's whole cost; the SMT fallback is one query per node.
 */
export async function runDeadNodes(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    const property = unreachable(new Set([g.running]));
    const decision = graphUnreachable(ctx, g.running) ?? await smtDecision(ctx, property);
    const entry = ctx.entryReach.get(g.node);
    const dead = decision.verdict === 'proven';
    const verdict: CheckVerdict = dead && entry === undefined ? 'violated' : 'unknown';
    const structural = g.reachable ? '' : ' The compiler already marks it unreachable from every start node.';
    const entryReason = entry === undefined
      ? null
      : `n8n starts one trigger per execution and this net was compiled with '${ctx.compiled.startNode}' ` +
        `as the start node, so ${entry === g.node ? 'this entry point' : `'${entry}'`} never fires here; ` +
        `re-run with the start node set to '${entry}' to verify the execution it starts`;
    record(ctx, {
      property: 'dead-nodes',
      name: `${g.node} can run`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      verdict,
      explanation: verdict === 'violated'
        ? `${g.node} can never run: no reachable marking ever puts a token on its running place.${structural}`
        : dead
          ? `${g.node} cannot run in an execution started from ${ctx.compiled.startNode}, but it is ` +
            `${entry === g.node ? 'another entry point of this workflow' : `reachable only from '${entry}', another entry point`}` +
            ' — an alternative entry point, not a dead node.'
          : decision.verdict === 'violated'
            ? `${g.node} is reachable in the abstraction. That is not a proof that it is live (VER-004).`
            : `Whether ${g.node} can ever run was not decided.`,
      reason: verdict === 'violated'
        ? decision.reason
        : dead
          ? entryReason
          : decision.verdict === 'violated'
            ? LIVENESS_REASON
            : decision.route === 'smt' ? unknownReason(ctx, decision) : decision.reason,
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      // The witness of a reachable node is a path that runs it in the abstraction, not a
      // defect; the finding here is the dead node, and a dead node has no trace.
      counterexample: null,
    });
  }
}
