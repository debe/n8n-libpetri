/**
 * The generic join form (README "Join gadget", ADR 0003): per input `X/free_i` and `X/ready_i`,
 * one `X/hasdata` for the node. `X_start` takes every `ready_i` with `all(X/hasdata)`, `X_skip`
 * every `ready_i` with `inhibitor(X/hasdata)`, both refunding `X/free_*`.
 */
import { Transition, one } from 'libpetri';
import { PLACE, TRANSITION, freeOf, readyOf } from '../names.js';
import type { GadgetContext } from './context.js';
import { inputCommon, inputIndexes } from './input-edges.js';
import type { LocalJoinSide, LocalReadyInput } from './local-shapes.js';
import type { SkipFrame } from './skip.js';

/** Declares each modelled input's `X/free_i` / `X/ready_i`, then `X/hasdata`. */
export function declareJoinSide(ctx: GadgetContext): LocalJoinSide {
  const { internal } = ctx;
  const inputs: LocalReadyInput[] = inputIndexes(ctx).map((i) => ({
    ...inputCommon(ctx, i), slot: 'ready', free: internal(freeOf(i), 'free', i), ready: internal(readyOf(i), 'ready', i),
  }));
  return { form: 'join', hasdata: internal(PLACE.hasdata, 'hasdata', null), inputs };
}

/** The join `X_skip`: every input arrived, none with data. */
export function buildJoinSkip(ctx: GadgetContext, side: LocalJoinSide, frame: SkipFrame): string {
  return ctx.emit(Transition.builder(TRANSITION.skip)
    .inhibitors(side.hasdata, frame.halt)
    .priority(ctx.depth)
    .inputs(...side.inputs.map((i) => one(i.ready)))
    .outputs(frame.skipOut).build(), { role: 'skip', combination: [] });
}
