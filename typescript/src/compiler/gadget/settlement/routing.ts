/**
 * How an `engineV2` run routes its outcome (`tasks/v2-profile-plan.md` decisions 3 and 4): every
 * out-edge's `arrived`, and for each connected output slot the run filled, the `live` of every
 * node that slot's edges enter. That is rule 2 of `packages/@n8n/engine/src/execution/settlement.ts`
 * (`isLive`: the source completed and filled the edge's output slot) — so a slot's edges are all
 * live or all dead, and every edge arrives either way:
 *
 * ```
 * per connected output o:  xor( and(f/arrived, f.to/live for f ∈ out(o)),  and(f/arrived for f ∈ out(o)) )
 * ```
 *
 * **Collapsed** (the default): `X_run`'s success branch is the `and` of those `xor`s.
 *
 * **Split**: `X_run`'s success branch writes `X/ok_o` per connected output, and `X_route_o` takes
 * `one(X/ok_o)` and writes output `o`'s `xor`. A node splits when
 * - it has more than {@link SPLIT_ROUTING_ABOVE} connected outputs: IO-016 flattens an `and` of `k`
 *   `xor`s into `2^k` branches (`gadget/output-side.ts` has the measurement), or
 * - two sets of filled slots would write the same places, which happens when outputs share a
 *   successor: If → Merge on both branches writes `{M/live}` whether one slot or both were filled.
 *   Two branches claiming one output are ambiguous to the executor (`validateOutSpec`), and to the
 *   net they are one outcome, so each output gets its own transition instead.
 *
 * `X_route_o` is the only consumer of its `X/ok_o` and has no inhibitor: a split run's routing
 * completes like the run it belongs to, `_halt` or not, as a running v2 step still settles after
 * another step failed (decision 8), and replaying one run's routes in any order reaches the same
 * marking.
 */
import { Transition, one, outPlace, xor } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { InternalCompilerError } from '../../errors.js';
import { okOf, routeOf } from '../../names.js';
import type { EdgeRef } from '../../types.js';
import { SPLIT_ROUTING_ABOVE } from '../output-side.js';
import { andOf } from '../out-spec.js';
import { arrivedOf, successorLiveOf, type SettlementContext } from './places.js';

/** One connected output slot of the node under construction, over local places. */
export interface LocalSettlementOutput {
  readonly index: number;
  readonly edges: readonly EdgeRef[];
  /** `X/ok_o` under split routing; `null` when `X_run` routes. */
  readonly ok: Place<unknown> | null;
}

/**
 * The connected outputs and how they are routed. `batch` is a batch node's, whose run fills one
 * slot at most and routes in its own `Out` spec (`batch.ts`); {@link successRouting} and
 * {@link buildRoutes} serve the other two.
 */
export interface SettlementRouting {
  readonly kind: 'collapsed' | 'split' | 'batch';
  readonly outputs: readonly LocalSettlementOutput[];
}

/**
 * Whether some two sets of filled slots write the same `live` places. At most
 * {@link SPLIT_ROUTING_ABOVE} outputs reach this, so the `2^k` sets are few.
 */
function fillingsCollide(targets: readonly ReadonlySet<string>[]): boolean {
  const seen = new Set<string>();
  for (let filled = 0; filled < 1 << targets.length; filled++) {
    const live = new Set<string>();
    targets.forEach((t, k) => { if ((filled & (1 << k)) !== 0) for (const n of t) live.add(n); });
    const key = [...live].sort().join('\0');
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * The connected outputs, ascending, and the routing shape.
 */
export function declareRouting(ctx: SettlementContext): SettlementRouting {
  const indexes = [...new Set(ctx.outgoing.map((e) => e.outputIndex))].sort((x, y) => x - y);
  const edgesOf = (o: number): EdgeRef[] => ctx.outgoing.filter((e) => e.outputIndex === o);
  const split = indexes.length > SPLIT_ROUTING_ABOVE ||
    fillingsCollide(indexes.map((o) => new Set(edgesOf(o).map((e) => e.to))));
  return {
    kind: split ? 'split' : 'collapsed',
    outputs: indexes.map((o) => ({ index: o, edges: edgesOf(o), ok: split ? ctx.internal(okOf(o), 'ok', o) : null })),
  };
}

/** Every out-edge's `arrived`: what a skip writes, and a run for every slot it left empty. */
export function arrivalsOf(ctx: SettlementContext, edges: readonly EdgeRef[]): Out[] {
  return edges.map((e) => outPlace(arrivedOf(ctx, e, 'output')));
}

/**
 * The `live` place of every node `edges` enter, once each: two edges of one slot into one node
 * (different input slots) make that node live once.
 */
export function livesOf(ctx: SettlementContext, edges: readonly EdgeRef[]): Out[] {
  return [...new Set(edges.map((e) => successorLiveOf(ctx, e)))].map((p) => outPlace(p));
}

/** Output `o`'s `xor`: every edge arrived and its consumer live, or every edge arrived only. */
function slotOut(ctx: SettlementContext, out: LocalSettlementOutput): Out {
  const dead = arrivalsOf(ctx, out.edges);
  return xor(andOf([...dead, ...livesOf(ctx, out.edges)]), andOf(dead));
}

/** What `X_run`'s success branch writes for the outputs: every slot's `xor`, or every `X/ok_o`. */
export function successRouting(ctx: SettlementContext, routing: SettlementRouting): Out[] {
  return routing.outputs.map((out) => (out.ok !== null ? outPlace(out.ok) : slotOut(ctx, out)));
}

/** `X_route_o` per connected output under split routing, in output order. */
export function buildRoutes(ctx: SettlementContext, routing: SettlementRouting): readonly string[] {
  if (routing.kind !== 'split') return [];
  return routing.outputs.map((out) => {
    const ok = out.ok;
    if (ok === null) throw new InternalCompilerError(`internal: split output ${out.index} of '${ctx.name}' has no ok place`);
    return ctx.emit(Transition.builder(routeOf(out.index))
      .inputs(one(ok))
      .outputs(slotOut(ctx, out))
      .build(), { role: 'route', port: out.index });
  });
}
