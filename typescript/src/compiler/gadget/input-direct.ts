/**
 * The direct form's input side: `X/in` bound to the one producer edge's data place (or to the
 * synthetic in place of a node without a producer), `X/in_empty` to its empty place, and the
 * `X_skip` that consumes that empty.
 */
import { Transition, one } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { PLACE, TRANSITION, emptyTwinOf } from '../names.js';
import { boundPort } from './builder.js';
import type { GadgetContext } from './context.js';
import { hostSlotOf } from './facts.js';
import type { LocalDirectSide } from './local-shapes.js';
import type { SkipFrame } from './skip.js';

/** Declares `X/in`, and `X/in_empty` when the producer edge has an empty place. */
export function declareDirectSide(ctx: GadgetContext): LocalDirectSide {
  const edge = ctx.incoming[0];
  if (edge === undefined) return declareSyntheticIn(ctx);
  const slot = hostSlotOf(ctx, edge);
  const inLocal = boundPort(ctx, PLACE.in, slot.data, 'input');
  ctx.hostOwned(slot.data.name, 'in-data', edge.inputIndex, { edge });
  if (slot.empty === null) return { form: 'direct', in: inLocal, inEmpty: null };
  const inEmpty = boundPort(ctx, emptyTwinOf(PLACE.in), slot.empty, 'input');
  ctx.hostOwned(slot.empty.name, 'in-empty', edge.inputIndex, { edge });
  return { form: 'direct', in: inLocal, inEmpty };
}

/** `X/in` of a node without a producer, bound to the synthetic in place `compile` created. */
function declareSyntheticIn(ctx: GadgetContext): LocalDirectSide {
  const { syntheticIn, name } = ctx;
  if (syntheticIn === null) throw new InternalCompilerError(`internal: node '${name}' has no producer and no synthetic in place`);
  const inLocal = boundPort(ctx, PLACE.in, syntheticIn, 'input');
  ctx.hostOwned(syntheticIn.name, 'in-data', 0);
  return { form: 'direct', in: inLocal, inEmpty: null };
}

/** The direct `X_skip`: the producer's empty token. */
export function buildDirectSkip(ctx: GadgetContext, side: LocalDirectSide, frame: SkipFrame): string {
  if (side.inEmpty === null) throw new InternalCompilerError(`internal: node '${ctx.name}' skips without an in-empty place`);
  return ctx.emit(Transition.builder(TRANSITION.skip)
    .inputs(one(side.inEmpty))
    .inhibitor(frame.halt)
    .outputs(frame.skipOut)
    .priority(ctx.depth).build(), { role: 'skip', combination: [] });
}
