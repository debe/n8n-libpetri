/**
 * The arms (README "Join gadget", "OR-inputs"; ADR 0003): one `data` arm per producer edge and an
 * `empty` arm per tree edge, for every modelled input of the join, choose-branch and OR forms.
 * An arm moves the edge token onto its input's slot — the OR round's `X/ready_i` / `X/hasdata_i`,
 * or a join slot taken from `X/free_i`.
 */
import { Transition, and, one, outPlace } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { armOf } from '../names.js';
import type { Variant } from '../types.js';
import type { GadgetContext } from './context.js';
import type { InputSide } from './input-side.js';
import type { LocalEdge, LocalJoinInput, LocalOrInput } from './local-shapes.js';
import type { SharedPorts } from './ports.js';

/** What every arm reads its arcs from. */
interface ArmFrame {
  readonly halt: Place<unknown>;
  readonly slotOf: InputSide['slotOf'];
  /** The generic join's `X/hasdata`, which a data arm also marks; `null` for the other forms. */
  readonly joinHasdata: Place<unknown> | null;
}

/** An OR round's arm: a tree edge counts towards the round; a cycle edge only triggers a run. */
function orArmOutput(i: LocalOrInput, e: LocalEdge, variant: Variant): Out {
  if (variant === 'empty') return outPlace(i.ready);
  return e.empty !== null ? and(outPlace(i.ready), outPlace(i.hasdata)) : outPlace(i.hasdata);
}

/** A join slot's arm: the variant's `ready` place, and `X/hasdata` on a generic join's data arm. */
function joinArmOutput(ready: Place<unknown>, hasdata: Place<unknown> | null): Out {
  return hasdata !== null ? and(outPlace(ready), outPlace(hasdata)) : outPlace(ready);
}

/** The arm of `variant` on edge `e`, consuming `source` (and, for a join slot, `X/free_i`). */
function buildArm(
  ctx: GadgetContext,
  frame: ArmFrame,
  i: LocalOrInput | LocalJoinInput,
  e: LocalEdge,
  variant: Variant,
  source: Place<unknown>,
): string {
  const arm = Transition.builder(armOf(e.edge.id, variant)).inputs(one(source)).inhibitor(frame.halt).priority(ctx.depth);
  if (i.slot === 'or') {
    arm.outputs(orArmOutput(i, e, variant));
  } else {
    arm.inputs(one(i.free)).outputs(joinArmOutput(frame.slotOf(i, variant), variant === 'data' ? frame.joinHasdata : null));
  }
  return ctx.emit(arm.build(), { role: 'arm', edge: e.edge, variant });
}

/** One `data` arm per producer edge and an `empty` arm per tree edge, for every modelled input. */
export function buildArms(ctx: GadgetContext, shared: SharedPorts, input: InputSide): readonly string[] {
  const { side, allInputs, slotOf } = input;
  const frame: ArmFrame = { halt: shared.halt, slotOf, joinHasdata: side.form === 'join' ? side.hasdata : null };
  const armNames: string[] = [];
  for (const i of allInputs) {
    for (const e of i.edges) {
      armNames.push(buildArm(ctx, frame, i, e, 'data', e.data));
      if (e.empty !== null) armNames.push(buildArm(ctx, frame, i, e, 'empty', e.empty));
    }
  }
  return armNames;
}
