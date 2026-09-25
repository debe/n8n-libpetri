/**
 * The settlement gadget: one `engineV2` node as a libpetri `SubnetDef` (MOD-001), instantiated at
 * prefix `node.id` (MOD-010) and composed by port binding (MOD-020), as a v1 node's gadget is
 * (`tasks/v2-profile-plan.md` decisions 2–4, 7 and 8). `buildNodeGadget` (`gadget.ts`) is the one
 * place that sends a node here, on `analysis.profile`; no v1 gadget file is shared beyond the
 * builder's recorders and the `Out` combinators.
 *
 * The places are `places.ts`, `X_start` / `X_skip` / `X_run` are `node.ts`, the routing and
 * `X_route_o` are `routing.ts`, and a batch node's two start / skip pairs and its run are
 * `batch.ts` (decisions 5 and 6). What the gadget has none of is as much the model as what it
 * has: no `_budget`, `_pause` or `idle`, no retry, failure chain, error output, agent round or
 * reference arc, and no ordering priority — engine v2 has none of them.
 */
import { SubnetDef } from 'libpetri';
import type { Place } from 'libpetri';
import { isV2BatchNode } from '../../analysis/engine-v2/batch.js';
import { InternalCompilerError } from '../../errors.js';
import type {
  AnalysedNode, EdgeRef, PendingPlace, SettlementEdge, SettlementGadget, TransitionInfo, WorkflowAnalysis,
} from '../../types.js';
import { assertNever } from '../../../internal/assert.js';
import { buildBatchNode, type BatchNode } from './batch.js';
import { buildSettlementNode, type SettlementNodeNames } from './node.js';
import {
  arrivedHostOf, createSettlementContext, declareSettlementPlaces, liveHostOf, type SettlementContext, type SettlementHost,
} from './places.js';
import { buildRoutes, declareRouting, type SettlementRouting } from './routing.js';

export type { SettlementHost } from './places.js';

/** One `engineV2` node's built subnet, before composition. */
export interface SettlementBuild {
  readonly def: SubnetDef<void>;
  readonly prefix: string;
  /** Port name → host place, for `compose(instance, ports)`. */
  readonly ports: ReadonlyMap<string, Place<unknown>>;
  /** Transition descriptors in declaration order. */
  readonly transitions: readonly TransitionInfo[];
  /** Place descriptors of every place this node owns (its incoming `arrived` places included). */
  readonly places: readonly PendingPlace[];
  /** Builds the `SettlementGadget` once canonical place objects can be looked up by final name. */
  materialise(lookup: (finalName: string) => Place<unknown>): SettlementGadget;
}

/** The `SubnetDef` of the body, with every bound port. */
function subnetDefOf(ctx: SettlementContext): SubnetDef<void> {
  ctx.declarePorts();
  const b = SubnetDef.builder(ctx.name).transitions(...ctx.body);
  for (const p of ctx.portDecls) {
    switch (p.direction) {
      case 'input': b.inputPort(p.name, p.local); break;
      case 'output': b.outputPort(p.name, p.local); break;
      case 'inout': b.inoutPort(p.name, p.local); break;
      default: assertNever(p.direction, 'port direction');
    }
  }
  return b.build();
}

/** The transitions of one node, of either kind, and how its outputs are routed. */
interface NodeBody {
  readonly routing: SettlementRouting;
  readonly names: SettlementNodeNames;
  readonly routes: readonly string[];
  readonly batch: BatchNode | null;
}

/**
 * Builds node `a`'s settlement gadget. Places first, then the transitions, then the `SubnetDef`.
 * A batch node (decision 5: Split In Batches v3, `isV2BatchNode`) gets `batch.ts`; every other
 * node, a loop member included, gets `node.ts` and `routing.ts`.
 */
export function buildSettlementGadget(a: AnalysedNode, analysis: WorkflowAnalysis, host: SettlementHost): SettlementBuild {
  const ctx = createSettlementContext(a, analysis, host);
  const markers = declareSettlementPlaces(ctx);
  let body: NodeBody;
  if (isV2BatchNode(a.node)) {
    const batch = buildBatchNode(ctx, markers);
    body = { routing: batch.routing, names: batch.names, routes: [], batch };
  } else {
    const routing = declareRouting(ctx);
    const names = buildSettlementNode(ctx, markers, routing);
    body = { routing, names, routes: buildRoutes(ctx, routing), batch: null };
  }
  const { routing, names, routes, batch } = body;
  const def = subnetDefOf(ctx);

  const materialise = (lookup: (finalName: string) => Place<unknown>): SettlementGadget => {
    const fin = (p: Place<unknown>): Place<unknown> => {
      const finalName = ctx.finalNames.get(p);
      if (finalName === undefined) throw new InternalCompilerError(`internal: node '${ctx.name}' has no final name for '${p.name}'`);
      return lookup(finalName);
    };
    // Host places are looked up by their own names: every one is in the flat net, because its
    // consumer's start and skip consume it, whether or not this node declared a port for it.
    const edgeOf = (e: EdgeRef): SettlementEdge => ({
      edge: e, arrived: lookup(arrivedHostOf(ctx, e).name), live: lookup(liveHostOf(ctx, e.to).name),
    });
    return {
      node: ctx.name, id: ctx.id, type: a.node.type, typeVersion: a.node.typeVersion,
      isTrigger: ctx.isTrigger, failure: ctx.failure,
      in: ctx.isTrigger ? lookup(host.places.triggerIn.name) : null,
      live: ctx.isTrigger ? null : lookup(liveHostOf(ctx, ctx.name).name),
      incoming: ctx.incoming.map(edgeOf),
      running: fin(markers.running),
      done: markers.done === null ? null : fin(markers.done),
      skipped: markers.skipped === null ? null : fin(markers.skipped),
      routing: routing.kind,
      outputs: routing.outputs.map((o) => ({ index: o.index, edges: o.edges.map(edgeOf), ok: o.ok === null ? null : fin(o.ok) })),
      transitions: { ...names, routes },
      loop: ctx.loop?.batchNode ?? null,
      batch: batch === null ? null : {
        entry: edgeOf(batch.entry),
        back: edgeOf(batch.back),
        ended: fin(batch.ended),
        transitions: { startBack: batch.startBack, skipBack: batch.skipBack },
      },
    };
  };

  return { def, prefix: ctx.id, ports: ctx.ports, transitions: ctx.transitions, places: ctx.pending, materialise };
}
