/**
 * The input side's own transitions: `X_skip`, which passes the emptiness on and refunds the
 * join slots, and a join / OR input's `arm` per edge and variant (README "Join gadget",
 * "OR-inputs").
 */
import type { Place, TransitionAction } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { readySlot } from '../gadget.js';
import type {
  ArmTransition, EdgeSlot, InputGadget, NodeGadget, OrGadget, OrInput, ReadyInput, SlottedGadget, SplitReadyInput, Variant,
} from '../types.js';

export function skipAction(g: NodeGadget): TransitionAction {
  const { skipped } = g;
  if (skipped === null) throw new InternalCompilerError(`internal: node '${g.node}' has a skip transition but no skipped place`);
  const refunds = g.form === 'join' || g.form === 'choose-branch' ? g.inputs.map((i) => i.free) : [];
  // Exactly the empties `X_skip`'s Out spec names: none past the last node that reads a skip.
  const empties = g.skipForwards
    ? g.outputs.flatMap((out) => out.edges.flatMap((e) => (e.empty !== null ? [e.empty] : [])))
    : [];
  return async (ctx) => {
    for (const empty of empties) ctx.output(empty, null);
    ctx.output(skipped, null);
    for (const free of refunds) ctx.output(free, null);
  };
}

/** The input and producer edge an arm serves; the gadget built one arm per (input, edge, variant). */
function armedSlotOf(g: OrGadget | SlottedGadget, info: ArmTransition): { input: InputGadget; slot: EdgeSlot } {
  const { edge } = info;
  const input = g.inputs.find((i) => i.index === edge.inputIndex);
  const slot = input?.edges.find((e) => e.edge.id === edge.id);
  if (input === undefined || slot === undefined) {
    throw new InternalCompilerError(`internal: node '${g.node}' has no input ${edge.inputIndex} edge ${edge.id} for '${info.name}'`);
  }
  return { input, slot };
}

/** An OR input's arm: a data arrival lands on `X/hasdata` (and counts toward the round when the edge can carry an empty). */
function orArmAction(input: OrInput, slot: EdgeSlot, variant: Variant): TransitionAction {
  if (variant === 'data') {
    return async (ctx) => {
      ctx.output(input.hasdata, ctx.input(slot.data));
      if (slot.empty !== null) ctx.output(input.ready, null);
    };
  }
  return async (ctx) => { ctx.output(input.ready, null); };
}

/** A join / choose-branch input's arm: the arrival fills its `ready` slot, and a data arrival marks the join's `X/hasdata`. */
function slotArmAction(
  g: OrGadget | SlottedGadget, input: ReadyInput | SplitReadyInput, slot: EdgeSlot, variant: Variant,
): TransitionAction {
  const ready: Place<unknown> = readySlot(g, input, variant);
  if (variant === 'data') {
    const hasdata = g.form === 'join' ? g.hasdata : null;
    return async (ctx) => {
      ctx.output(ready, ctx.input(slot.data));
      if (hasdata !== null) ctx.output(hasdata, null);
    };
  }
  return async (ctx) => {
    ctx.output(ready, null);
  };
}

export function armAction(g: NodeGadget, info: ArmTransition): TransitionAction {
  if (g.form === 'direct' || g.form === 'tool') throw new InternalCompilerError(`internal: node '${g.node}' has an arm but no join input`);
  const { input, slot } = armedSlotOf(g, info);
  if (input.slot === 'or') return orArmAction(input, slot, info.variant);
  return slotArmAction(g, input, slot, info.variant);
}
