/**
 * `no-double-activation` — `X/running` never holds two tokens: the `X/idle` mutex made
 * structural (`X/idle + X/running = 1` is a found P-invariant, ADR 0004).
 */
import { recordBound } from '../record.js';
import type { Context } from '../route.js';

/** `placeBound(X/running, 1)`: the `X/idle` mutex, structurally (ADR 0004). */
export async function runNoDoubleActivation(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    await recordBound(ctx, {
      property: 'no-double-activation',
      name: `${g.node} never runs twice at once`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      place: g.running,
      bound: 1,
      explanation: {
        proven: `Two activations of ${g.node} can never overlap: X/idle + X/running = 1 holds on every reachable marking.`,
        violated: `${g.node} can be running twice at once — its X/idle mutex does not hold.`,
        unknown: `Whether two activations of ${g.node} can overlap was not decided.`,
      },
    });
  }
}
