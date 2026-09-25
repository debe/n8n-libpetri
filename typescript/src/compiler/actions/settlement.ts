/**
 * Structural action binders for an `engineV2` net (`tasks/v2-profile-plan.md` decisions 3, 4, 7
 * and 8). Every transition of the settlement gadget declares an `Out` spec, so each gets an
 * action that writes exactly one of its branches (CORE-043, IO-015); a policy picks which:
 * whether a run fails, and on success which output slots it filled. Every token is a unit.
 *
 * - `settlementActions(policy)` — the policy decides per run and per connected output slot;
 * - `settlementPlaceholderActions()` — every run completes and fills no slot, so every successor
 *   is skipped and any net quiesces. `compile()` binds it by default under `engineV2`, as it
 *   binds `placeholderActions()` under v1.
 *
 * Under split routing the policy's `filled` is asked by `X_route_o`, not by `X_run`, which writes
 * only `X/ok_o`; a policy is a function of the node, the slot and the row, so the answer is the
 * same.
 *
 * A policy is asked about one row, `(node, iteration)` (`StepKey`, `execution/execution.types.ts`):
 * the binder counts each node's rows — a start or a skip is one — so the iteration of a run is its
 * node's row count less one, at most one step per node being in flight (decision 6). That is 0
 * outside a loop, the pass for a loop member and for a batch node. The count restarts when the
 * trigger starts, so a bound net may be run again, but not twice at once.
 *
 * A batch node's run (decision 5) asks for both of its slots: the loop slot filled is a pass, the
 * done slot filled or neither ends the loop (`runBatchStep`, `execution/batch-step.ts`). Both
 * filled is no outcome `runBatchStep` has, and the action throws.
 */
import type { Place, TransitionAction, TransitionContext } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { assertProfile, InternalCompilerError } from '../errors.js';
import { DONE_SLOT, LOOP_SLOT } from '../analysis/engine-v2/batch.js';
import type { ActionBinder, NetMapView, SettlementEdge, SettlementGadget, SettlementOutput } from '../types.js';

/** What an `engineV2` run does: fail, or complete with some output slots filled. */
export interface SettlementPolicy {
  /**
   * Whether the run of row `(g.node, iteration)` fails, which halts the execution. Not asked of a
   * run that cannot fail (the trigger). Default: never.
   */
  readonly fails?: (g: SettlementGadget, iteration: number) => boolean;
  /**
   * Whether the completed run of row `(g.node, iteration)` filled output slot `output`
   * (`StepSummary.filledOutputSlots`).
   */
  readonly filled: (g: SettlementGadget, output: number, iteration: number) => boolean;
}

/** Each node's row count in the execution in progress (see the module comment). */
class Rows {
  private readonly counts = new Map<string, number>();

  /** A start or a skip of `g`: a new row. The trigger's start begins a new execution. */
  open(g: SettlementGadget): void {
    if (g.isTrigger) this.counts.clear();
    this.counts.set(g.node, (this.counts.get(g.node) ?? 0) + 1);
  }

  /** The iteration of `g`'s latest row; 0 for a run seeded in flight, which no start opened. */
  latest(g: SettlementGadget): number {
    return Math.max(0, (this.counts.get(g.node) ?? 0) - 1);
  }
}

/** Writes one unit on `p`. */
function mark(ctx: TransitionContext, p: Place<unknown>): void {
  ctx.output(p, null);
}

/** One slot's edges: every `arrived`, and each consumer's `live` once when the slot is filled. */
function routeSlot(ctx: TransitionContext, edges: readonly SettlementEdge[], filled: boolean): void {
  for (const e of edges) mark(ctx, e.arrived);
  if (filled) for (const live of new Set(edges.map((e) => e.live))) mark(ctx, live);
}

/** Whether `g`'s run of row `iteration` fails under `policy`, as its `SettlementFailure` allows. */
function runFails(g: SettlementGadget, policy: SettlementPolicy, iteration: number): boolean {
  switch (g.failure) {
    case 'never': return false;
    case 'possible': return policy.fails?.(g, iteration) ?? false;
    default: return assertNever(g.failure, 'settlement failure');
  }
}

/** The edges of `g`'s output slot `index`; none when the slot is not connected. */
function slotEdges(g: SettlementGadget, index: number): readonly SettlementEdge[] {
  return g.outputs.find((o) => o.index === index)?.edges ?? [];
}

function startAction(g: SettlementGadget, rows: Rows): TransitionAction {
  return async (ctx) => {
    rows.open(g);
    mark(ctx, g.running);
  };
}

/**
 * Every out-edge arrives dead, and the node's marker: `X/skipped`, none on a loop member, and on a
 * batch node `B/ended` — its skip is terminal and decides the exits only (`batchStepDecides`).
 */
function skipAction(g: SettlementGadget, rows: Rows): TransitionAction {
  const { skipped, batch } = g;
  if (skipped === null && g.loop === null) {
    throw new InternalCompilerError(`internal: node '${g.node}' has a skip transition but no skipped place`);
  }
  return async (ctx) => {
    rows.open(g);
    if (batch !== null) {
      routeSlot(ctx, slotEdges(g, DONE_SLOT), false);
      mark(ctx, batch.ended);
      return;
    }
    for (const out of g.outputs) routeSlot(ctx, out.edges, false);
    if (skipped !== null) mark(ctx, skipped);
  };
}

function runAction(g: SettlementGadget, policy: SettlementPolicy, map: NetMapView, rows: Rows): TransitionAction {
  if (g.batch !== null) return batchRunAction(g, g.batch.ended, policy, map, rows);
  return async (ctx) => {
    const iteration = rows.latest(g);
    if (g.done !== null) mark(ctx, g.done);
    if (runFails(g, policy, iteration)) {
      mark(ctx, map.halt);
      return;
    }
    for (const out of g.outputs) {
      if (out.ok !== null) mark(ctx, out.ok);
      else routeSlot(ctx, out.edges, policy.filled(g, out.index, iteration));
    }
  };
}

/** `B_run`: a pass into the body, or the terminal step onto the exits (decision 5). */
function batchRunAction(
  g: SettlementGadget,
  ended: Place<unknown>,
  policy: SettlementPolicy,
  map: NetMapView,
  rows: Rows,
): TransitionAction {
  return async (ctx) => {
    const iteration = rows.latest(g);
    if (runFails(g, policy, iteration)) {
      mark(ctx, map.halt);
      mark(ctx, ended);
      return;
    }
    const pass = policy.filled(g, LOOP_SLOT, iteration);
    const done = policy.filled(g, DONE_SLOT, iteration);
    if (pass && done) {
      throw new Error(
        `settlement policy: batch node '${g.node}' filled both its done and its loop slot at pass ${iteration}; ` +
        'runBatchStep fills one at most');
    }
    if (pass) {
      routeSlot(ctx, slotEdges(g, LOOP_SLOT), true);
      return;
    }
    routeSlot(ctx, slotEdges(g, DONE_SLOT), done);
    mark(ctx, ended);
  };
}

function routeAction(g: SettlementGadget, out: SettlementOutput, policy: SettlementPolicy, rows: Rows): TransitionAction {
  return async (ctx) => { routeSlot(ctx, out.edges, policy.filled(g, out.index, rows.latest(g))); };
}

/** The output `X_route_o` serves. */
function routedOutput(g: SettlementGadget, port: number): SettlementOutput {
  const out = g.outputs.find((o) => o.index === port);
  if (out === undefined || out.ok === null) throw new InternalCompilerError(`internal: node '${g.node}' routes no split output ${port}`);
  return out;
}

/** Binds a settlement action for every transition role an `engineV2` net has; a v1 map is refused (`ProfileMismatchError`). */
export function settlementActions(policy: SettlementPolicy): ActionBinder {
  const rows = new Rows();
  return (info, map) => {
    assertProfile('settlementActions', 'engineV2', map.profile);
    const g = map.settlement(info.node);
    switch (info.role) {
      case 'start': return startAction(g, rows);
      case 'skip': return skipAction(g, rows);
      case 'run': return runAction(g, policy, map, rows);
      case 'route': return routeAction(g, routedOutput(g, info.port), policy, rows);
      default: throw new InternalCompilerError(`internal: an engineV2 net has no '${info.role}' transition ('${info.name}')`);
    }
  };
}

/**
 * Every run completes and fills no slot: the net skips everything after the trigger — a batch node
 * ends its loop at pass 0 with nothing accumulated (`[null, null]`) — and quiesces.
 */
export function settlementPlaceholderActions(): ActionBinder {
  return settlementActions({ filled: () => false });
}
