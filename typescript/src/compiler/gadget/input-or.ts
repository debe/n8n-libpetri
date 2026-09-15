/**
 * The OR form (README "OR-inputs", ADR 0003): one input with `n ≥ 2` empty-capable producers
 * aggregates a round — `arm_data → and(ready_i, hasdata_i)`, `arm_empty → ready_i`,
 * `X_start: one(hasdata_i) → and(running, ran_i)`. `X_skip` decides a round every producer
 * delivered empty, `X_clear` closes one that ran. Producers inside a cycle deliver `hasdata_i`
 * only and do not count towards `n`.
 */
import { Transition, all, exactly } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { TRANSITION, clearOf, hasdataOf, ranOf, readyOf } from '../names.js';
import type { GadgetContext } from './context.js';
import { inputCommon, inputIndexes } from './input-edges.js';
import type { LocalInputSide, LocalOrSide } from './local-shapes.js';
import type { Markers, SharedPorts } from './ports.js';
import type { SkipFrame } from './skip.js';

/** Declares the round's `X/ready_i`, `X/hasdata_i` and `X/ran_i` over the one modelled input. */
export function declareOrSide(ctx: GadgetContext): LocalOrSide {
  const { name, internal } = ctx;
  // `joinFormOf` chooses the OR form for exactly one input index with several tree edges.
  const [i, ...more] = inputIndexes(ctx);
  if (i === undefined || more.length > 0) throw new InternalCompilerError(`internal: OR-form node '${name}' models ${more.length + (i === undefined ? 0 : 1)} inputs`);
  const common = inputCommon(ctx, i);
  return {
    form: 'or',
    input: {
      ...common, slot: 'or',
      ready: internal(readyOf(i), 'ready', i),
      hasdata: internal(hasdataOf(i), 'hasdata', i),
      ran: internal(ranOf(i), 'ran', i),
      round: common.edges.filter((e) => e.empty !== null).length,
    },
  };
}

/** The OR `X_skip`: every producer of the round delivered, none with data, and no run from it. */
export function buildOrSkip(ctx: GadgetContext, side: LocalOrSide, frame: SkipFrame): string {
  // read(X/idle): X_start consumes hasdata_i when it fires but deposits ran_i only when
  // its action completes (outputs land on completion), so without the node's own mutex
  // an all-delivered round could skip while the run it just started is in flight.
  const i = side.input;
  return ctx.emit(Transition.builder(TRANSITION.skip)
    .inputs(exactly(i.round, i.ready))
    .inhibitors(i.hasdata, i.ran, frame.halt)
    .read(frame.idle)
    .outputs(frame.skipOut)
    .priority(ctx.depth).build(), { role: 'skip', combination: [] });
}

/** The OR form's round closer, a genuine sink (CORE-043 AC4). */
export function buildClear(ctx: GadgetContext, shared: SharedPorts, markers: Markers, side: LocalInputSide): readonly string[] {
  if (side.form !== 'or') return [];
  // ---- X_clear (OR form): the round closes once every producer delivered and ≥ 1 run happened ----
  // read(X/idle) for the same reason as X_skip: a run started from this round must have
  // landed its ran_i before the round is cleared, or that marker would leak into the next.
  const i = side.input;
  return [ctx.emit(Transition.builder(clearOf(i.index))
    .inputs(exactly(i.round, i.ready), all(i.ran))
    .inhibitors(i.hasdata, shared.halt)
    .read(markers.idle)
    .priority(ctx.depth).build(), { role: 'clear', port: i.index })];
}
