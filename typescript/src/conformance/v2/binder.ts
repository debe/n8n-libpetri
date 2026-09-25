/**
 * The net side's behaviour in the engine v2 differential (`tasks/v2-profile-plan.md` step 10,
 * decision 17): actions for an `engineV2` net whose runs do what the reference's steps do.
 *
 * Every `X_run` asks {@link outcome} — the same pure function of (node, iteration, behaviour) the
 * reference loop draws from (`reference.ts`) — so a net run and a reference run under one
 * {@link Behaviour} give every step the same outcome, and only the order differs. The iteration is
 * the node's row count less one, which `settlementActions` keeps. The trigger is the exception, as
 * in the reference: `ExecutionStartHandler` writes its row completed with slot 0 filled, and
 * `outcome` is never asked about it.
 *
 * Every action (start, skip, run and route) awaits a seeded number of macrotask ticks, 0 to 3,
 * before it writes, so firings overlap and complete out of order: the interleavings are the
 * executor's, not a schedule this module picks. The draws come from one stream per run, in the
 * order the executor invokes the actions.
 */
import type { TransitionAction } from 'libpetri';
import { settlementActions } from '../../compiler/index.js';
import type { ActionBinder, SettlementGadget, SettlementPolicy } from '../../compiler/index.js';
import type { V2Graph, V2Node } from './graph.js';
import { hash, outcome, rng } from './reference.js';
import type { Behaviour, Outcome } from './reference.js';

/** At most this many macrotask ticks before an action writes. */
export const MAX_DELAY_TICKS = 3;

/** The {@link SettlementPolicy} of `behaviour` on `graph`: every run is {@link outcome}'s, the trigger fills slot 0. */
export function outcomePolicy(graph: V2Graph, behaviour: Behaviour): SettlementPolicy {
  const byId = new Map<string, V2Node>(graph.nodes.map((n) => [n.id, n]));
  const drawn = new Map<string, Outcome>();
  const of = (g: SettlementGadget, iteration: number): Outcome => {
    const key = `${g.id}\u0000${iteration}`;
    let o = drawn.get(key);
    if (o === undefined) {
      const node = byId.get(g.id);
      if (node === undefined) throw new Error(`v2Actions: the net's node '${g.node}' (id '${g.id}') is not in the graph`);
      o = outcome(graph, node, iteration, behaviour);
      drawn.set(key, o);
    }
    return o;
  };
  return {
    fails: (g, iteration) => of(g, iteration).status === 'failed',
    filled: (g, output, iteration) => (g.isTrigger ? output === 0 : of(g, iteration).filled[output] === true),
  };
}

/** `binder`'s actions, each after a seeded number of macrotask ticks (see the module doc). */
export function delayed(binder: ActionBinder, delaySeed: number): ActionBinder {
  const draw = rng(hash(delaySeed, 'delay'));
  return (info, map) => {
    const action = binder(info, map);
    if (action === null) return null;
    const wrapped: TransitionAction = async (ctx) => {
      for (let n = Math.floor(draw() * (MAX_DELAY_TICKS + 1)); n > 0; n--) await new Promise<void>((r) => setImmediate(r));
      return action(ctx);
    };
    return wrapped;
  };
}

/**
 * Actions for one run of an `engineV2` net compiled from `graph`: runs as {@link outcome} decides
 * under `behaviour`, each action delayed by the stream `delaySeed` fixes. The binder counts rows,
 * so bind a fresh one per concurrent run.
 */
export function v2Actions(graph: V2Graph, behaviour: Behaviour, delaySeed: number): ActionBinder {
  return delayed(settlementActions(outcomePolicy(graph, behaviour)), delaySeed);
}
