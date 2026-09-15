/**
 * The output side of the gadget (README "Per-node gadget", ADR 0002 / 0004): the edge ports and
 * `nil` places of each connected output and the collapsed or split routing. The outcome
 * branches (`outcome.ts`), `X_run` per attempt (`run.ts`), `X_route_o`, `X_done` and the `nil`
 * sinks (`routing.ts`) are built beside it and re-exported here.
 */
import { outPlace } from 'libpetri';
import type { Out } from 'libpetri';
import { PLACE, edgeOutPortOf, emptyTwinOf, nilOf, okOf, routedOf } from '../names.js';
import type { EdgeRef } from '../types.js';
import { boundPort } from './builder.js';
import type { GadgetContext } from './context.js';
import { hostSlotOf } from './facts.js';
import type { LocalCollapsedOutput, LocalEdge, LocalOutput, LocalRouting, LocalSplitOutput } from './local-shapes.js';

export { buildOutcomeBranches, type OutcomeBranches } from './outcome.js';
export { buildRouteAndDone, buildSinks } from './routing.js';
export { buildRun } from './run.js';

/**
 * Nodes with **more** connected outputs than this keep the routing on a transition of its
 * own per output — `X_run` writes `X/ok_o`, `X_route_o` deposits the edge tokens and marks
 * `X/routed_o` — instead of routing inside `X_run`'s own `Out` spec. Nodes at or below it
 * route in `X_run` and have a single `X/routed`.
 *
 * **Three**, and it is an IO-016 flattening threshold. The SMT and SCG flatteners expand an
 * `and` of `k` `xor`s into `2^k` virtual transitions, so the outcome costs `2^k + 4` flat
 * branches routed inside `X_run` (the four non-success outcomes on top) against `2k + 5`
 * split across `X_run` and its `X_route_o`s. Neither figure counts `X_done`, which both
 * shapes have. Measured with `enumerateBranches`
 * (`tests/spikes/collapsed-outcome.test.ts`):
 *
 * | connected outputs | routed in `X_run` | split per output |
 * |---|---|---|
 * | 1 | **6** | 7 |
 * | 2 | **8** | 9 |
 * | 3 | 12 | **11** |
 * | 4 | 20 | **13** |
 * | 6 | 68 | **17** |
 * | 10 | 1028 | **25** |
 * | 20 | *`enumerateBranches` overflows the stack* | **45** |
 *
 * Three is where it stops being a rout and becomes a trade: the split is one branch cheaper
 * there, while the collapse removes five places and three transitions and **21 % of the
 * state classes** (a three-output fan-out is 47 places / 20 transitions / 381 classes
 * collapsed against 52 / 23 / 482 split — `tests/compiler/routing.test.ts`). From four
 * outputs the branch count runs away and the split wins outright, so the threshold is 3 —
 * the same value the pre-M4 gadget used, for the same underlying reason.
 *
 * **What M4 changed is not this threshold; it is `X_done`,** and `X_done` is now
 * unconditional. The executor collects its ready set from the enablement flags **before**
 * the firing pass and only `updateDirtyTransitions()` sets them, so a transition another
 * firing enables during that pass can fire no earlier than the next cycle
 * (`precompiled-net-executor.ts` `fireReadyGeneral`). A join / OR consumer needs one such
 * extra cycle for its `arm`, while a direct consumer does not — so a firing that deposited
 * the edge tokens *and* refunded `_budget` let the shallower budget-blocked sibling become
 * evaluable a full cycle before the deeper armed consumer, and the net ran breadth-first
 * exactly where priority = DAG depth was meant to give n8n's depth-first order
 * (divergence #20). Refunding on `X_done` — one cycle after the edge tokens land, which is
 * the cycle the `arm` fires in — puts both candidate `X_start`s in the same ready set,
 * where priority decides. Measured: n8n's own `v1 execution order > should execute nodes in
 * the correct order, depth-first & the most top-left one first` passes with it and fails
 * without it (`docs/conformance-final.md`).
 *
 * That phase is preserved by both shapes here, because both mark `X/routed(_o)` in the
 * firing that deposits the edge tokens and refund `_budget` from `X_done` in the next.
 * Collapsing the routing into `X_run` therefore moves the *whole* chain one cycle earlier
 * without changing any relative phase.
 */
export const SPLIT_ROUTING_ABOVE = 3;

/** The connected outputs over local places and how they are routed. */
export interface OutputSide {
  readonly routing: LocalRouting;
  readonly outputs: readonly LocalOutput[];
  /** The empty of every outgoing tree edge this node writes on a skip. */
  readonly skipEmpties: readonly Out[];
}

/** One outgoing edge as local output ports; the empty port only where this node writes it. */
function declareOutputEdge(ctx: GadgetContext, e: EdgeRef, writesEmpty: boolean): LocalEdge {
  const slot = hostSlotOf(ctx, e);
  const dataPort = edgeOutPortOf(e.id);
  const data = boundPort(ctx, dataPort, slot.data, 'output');
  const empty = slot.empty !== null && writesEmpty ? boundPort(ctx, emptyTwinOf(dataPort), slot.empty, 'output') : null;
  return { edge: e, data, empty, host: slot };
}

/** Declares every connected output's edge ports and `nil`, and the routing shape. */
export function buildOutputSide(ctx: GadgetContext, hasSkip: boolean): OutputSide {
  const { a, cyclic, outgoing, internal } = ctx;

  // ---- output side ----
  // The empty place of an outgoing tree edge is written by X_route (acyclic producer) or by
  // X_skip (any producer); a cyclic producer without a skip never writes it and declares no
  // port for it (the consumer still owns the place; its skip is simply unreachable).
  const writesEmpty = !cyclic || hasSkip;
  const collapsedOutputs: LocalCollapsedOutput[] = [];
  const splitOutputs: LocalSplitOutput[] = [];
  const split = new Set(outgoing.map((e) => e.outputIndex)).size > SPLIT_ROUTING_ABOVE;
  for (let o = 0; o < a.outputCount; o++) {
    const edges = outgoing.filter((e) => e.outputIndex === o).map((e) => declareOutputEdge(ctx, e, writesEmpty));
    if (edges.length === 0) continue; // unconnected outputs get no places
    const nil = cyclic ? internal(nilOf(o), 'nil', o) : null;
    if (split) {
      splitOutputs.push({ index: o, edges, nil, routing: 'split', ok: internal(okOf(o), 'ok', o), routed: internal(routedOf(o), 'routed', o) });
    } else {
      collapsedOutputs.push({ index: o, edges, nil, routing: 'collapsed' });
    }
  }
  // `X/routed`: the single "the outcome has been delivered" marker of a node that routes
  // inside `X_run`. A split node has one per output instead (`outputs[*].routed`).
  const routing: LocalRouting = split
    ? { kind: 'split', outputs: splitOutputs }
    : { kind: 'collapsed', routed: internal(PLACE.routed, 'routed', null), outputs: collapsedOutputs };
  const skipEmpties = routing.outputs.flatMap((out) => out.edges.flatMap((e) => (e.empty !== null ? [outPlace(e.empty)] : [])));
  return { routing, outputs: routing.outputs, skipEmpties };
}
