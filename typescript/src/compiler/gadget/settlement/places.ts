/**
 * The places of one `engineV2` node's settlement gadget (`tasks/v2-profile-plan.md` decision 3)
 * and the builder state its phases share. All of them hold unit tokens: engine v2 keeps a step's
 * data in its own rows, and its planner reads only a step's settled flags (`StepSummary`,
 * `packages/@n8n/engine/src/execution/step-store.ts`), so the net carries none.
 *
 * - host places, bound as ports (MOD-020) because another node writes them: the `arrived` place
 *   of every incoming and outgoing edge, the node's own `live`, each successor's `live`, the
 *   trigger's synthetic `in` and the shared `_halt`;
 * - local places under the node's prefix (MOD-010): `X/running`, the markers `X/done` and
 *   `X/skipped` (none on the trigger for `skipped`, which nothing skips, and neither on a loop
 *   member, decision 6), `X/ok_o` per connected output under split routing (`routing.ts`), and a
 *   batch node's `B/ended` (`batch.ts`).
 *
 * Loop members carry no markers because a loop is folded, not unrolled (decision 6): member `X`
 * has one row per pass, and its places are reused by every pass. `validateLoops` leaves one back
 * edge, one way in and no way out but the batch node's done slot, so pass `p` settles completely
 * before the batch node's pass `p + 1` is decided, and a member's arrivals and `live` tokens are
 * all consumed by the pass they belong to. A per-pass marker would only accumulate; what records
 * that the loop is over is `B/ended`.
 *
 * A host place is bound through one port however the node uses it (`bind`), so a node that both
 * writes and consumes a place — a batch node's self loop (`batch.ts`) — declares it once, `inout`.
 * Ports are created on first use, so a node declares no port its body never touches (MOD-006).
 */
import { place } from 'libpetri';
import type { Place, PortDirection } from 'libpetri';
import type { SettlementHostPlaces } from '../../compile/edge-places.js';
import { InternalCompilerError } from '../../errors.js';
import { PLACE, arrivedPortOf, successorLivePortOf } from '../../names.js';
import type { AnalysedNode, EdgeRef, SettlementFailure, V2Loop, WorkflowAnalysis } from '../../types.js';
import { createGadgetBuilder, type GadgetBuilder } from '../builder.js';

/** What `compile()` hands an `engineV2` node: the host places and the shared `_halt`. */
export interface SettlementHost {
  readonly places: SettlementHostPlaces;
  readonly halt: Place<unknown>;
}

/** One node's settlement gadget under construction: its facts, the builder state and `bind`. */
export interface SettlementContext extends GadgetBuilder {
  readonly a: AnalysedNode;
  readonly analysis: WorkflowAnalysis;
  readonly host: SettlementHost;
  readonly name: string;
  readonly id: string;
  readonly isTrigger: boolean;
  /** The loop this node is a member of (decision 6), the batch node's own included; `null` outside one. */
  readonly loop: V2Loop | null;
  readonly failure: SettlementFailure;
  readonly incoming: readonly EdgeRef[];
  readonly outgoing: readonly EdgeRef[];
  /**
   * The local place bound to `hostPlace`, created on first use under `portName` and widened to
   * `inout` when a later use has the other direction. Later uses keep the first port name.
   */
  readonly bind: (hostPlace: Place<unknown>, portName: string, direction: PortDirection) => Place<unknown>;
  /** Declares every bound port on the builder, in first-use order. Called once, after the body. */
  readonly declarePorts: () => void;
}

/** A node's own lifecycle places. */
export interface SettlementMarkers {
  readonly running: Place<unknown>;
  /** `null` on a loop member (decision 6). */
  readonly done: Place<unknown> | null;
  /** `null` on the trigger and on a loop member. */
  readonly skipped: Place<unknown> | null;
}

/**
 * Decision 7 and 8: the trigger's run cannot fail, and every other run may. A `wait` /
 * `subworkflow` step never gets here: the analysis refuses it (`v2-unsupported-step`).
 */
function failureOf(isTrigger: boolean): SettlementFailure {
  return isTrigger ? 'never' : 'possible';
}

/** The context of node `a`, with an empty builder and no port bound yet. */
export function createSettlementContext(a: AnalysedNode, analysis: WorkflowAnalysis, host: SettlementHost): SettlementContext {
  const name = a.node.name;
  const id = a.node.id;
  const facts = analysis.engineV2;
  if (facts === null) throw new InternalCompilerError(`internal: node '${name}' built as engineV2 without engine v2 facts`);
  const isTrigger = name === facts.trigger;
  const incoming = analysis.incoming.get(name) ?? [];
  // `validateExecutableGraph` refuses an edge back into the trigger's ancestry through anything
  // but a batch node's return, and the trigger is never a batch node.
  if (isTrigger && incoming.length > 0) throw new InternalCompilerError(`internal: the trigger '${name}' has an incoming edge`);

  const builder = createGadgetBuilder(id, name);
  const bound = new Map<string, { portName: string; local: Place<unknown>; hostPlace: Place<unknown>; direction: PortDirection }>();
  const bind = (hostPlace: Place<unknown>, portName: string, direction: PortDirection): Place<unknown> => {
    const known = bound.get(hostPlace.name);
    if (known !== undefined) {
      if (known.direction !== direction) bound.set(hostPlace.name, { ...known, direction: 'inout' });
      return known.local;
    }
    const local = place<unknown>(portName);
    bound.set(hostPlace.name, { portName, local, hostPlace, direction });
    return local;
  };
  const declarePorts = (): void => {
    for (const p of bound.values()) builder.port(p.portName, p.local, p.hostPlace, p.direction);
  };
  return {
    ...builder, a, analysis, host, name, id, isTrigger, loop: facts.loopOf.get(name) ?? null, failure: failureOf(isTrigger),
    incoming, outgoing: analysis.outgoing.get(name) ?? [], bind, declarePorts,
  };
}

/** A host place of the context's map, which `v2EdgePlaces` made for every compiled node and edge. */
function hostPlace<K>(places: ReadonlyMap<K, Place<unknown>>, key: K, what: string): Place<unknown> {
  const p = places.get(key);
  if (p === undefined) throw new InternalCompilerError(`internal: no engineV2 host place for ${what}`);
  return p;
}

/** The `arrived` host place of edge `e`. */
export function arrivedHostOf(ctx: SettlementContext, e: EdgeRef): Place<unknown> {
  return hostPlace(ctx.host.places.arrived, e.id, `edge ${e.id}`);
}

/** The `live` host place of compiled node `node`. */
export function liveHostOf(ctx: SettlementContext, node: string): Place<unknown> {
  return hostPlace(ctx.host.places.live, node, `node '${node}'`);
}

/** Edge `e`'s `arrived` place, bound for this node's use in `direction`. */
export function arrivedOf(ctx: SettlementContext, e: EdgeRef, direction: PortDirection): Place<unknown> {
  return ctx.bind(arrivedHostOf(ctx, e), arrivedPortOf(e.id), direction);
}

/** The `live` place of `edge.to`, bound as this node's output: its own under {@link PLACE}`.live`. */
export function successorLiveOf(ctx: SettlementContext, e: EdgeRef): Place<unknown> {
  const target = ctx.analysis.byName.get(e.to);
  if (target === undefined) throw new InternalCompilerError(`internal: edge ${e.id} into unknown node '${e.to}'`);
  const portName = e.to === ctx.name ? PLACE.live : successorLivePortOf(target.node.id);
  return ctx.bind(liveHostOf(ctx, e.to), portName, 'output');
}

/** `_halt`, bound as the node's `halt` port. */
export function haltOf(ctx: SettlementContext): Place<unknown> {
  return ctx.bind(ctx.host.halt, PLACE.halt, 'inout');
}

/**
 * The host places this node owns in the `NetMap` — the trigger's `in`, the node's `live` and the
 * `arrived` place of every incoming edge, each recorded by its consumer — and its local markers,
 * none of `done` / `skipped` on a loop member.
 */
export function declareSettlementPlaces(ctx: SettlementContext): SettlementMarkers {
  const { name, isTrigger, loop, incoming, internal, hostOwned, host } = ctx;
  if (isTrigger) {
    hostOwned(host.places.triggerIn.name, 'arrived', null);
  } else {
    hostOwned(liveHostOf(ctx, name).name, 'live', null);
    for (const e of incoming) hostOwned(arrivedHostOf(ctx, e).name, 'arrived', e.inputIndex, { edge: e });
  }
  const running = internal(PLACE.running, 'running', null);
  const done = loop !== null ? null : internal(PLACE.done, 'done', null);
  const skipped = isTrigger || loop !== null ? null : internal(PLACE.skipped, 'skipped', null);
  return { running, done, skipped };
}
