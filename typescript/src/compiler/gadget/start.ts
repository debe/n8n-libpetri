/**
 * `X_start` and its `X_start_unmet_k` twins (README "Per-node gadget"; ADR 0004): the activation
 * the form delivers, one `_budget` unit and `X/idle`, inhibited by `_halt` and `_pause`, with a
 * read arc on every guarded reference's `Y/done` (CORE-032) — or, on twin `k`, on reference
 * `k`'s `Y/skipped`, one priority lower.
 */
import { Transition, all, and, one, outPlace } from 'libpetri';
import type { In, Out, Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { TRANSITION, startUnmetOf } from '../names.js';
import type { GadgetContext } from './context.js';
import type { InputSide } from './input-side.js';
import type { LocalInputSide } from './local-shapes.js';
import type { Markers, ReferencePorts, SharedPorts } from './ports.js';

/** The arcs `X_start` takes the activation through, per form; `_budget` and `X/idle` follow them. */
function activationInputs(side: LocalInputSide, slotOf: InputSide['slotOf']): In[] {
  switch (side.form) {
    case 'tool': return [one(side.inTool)];
    case 'direct': return [one(side.in)];
    case 'or': return [one(side.input.hasdata)];
    case 'join': return [...side.inputs.map((i) => one(i.ready)), all(side.hasdata)];
    case 'choose-branch': return side.inputs.map((i) => one(slotOf(i, 'data')));
    default: return assertNever(side, 'input side');
  }
}

/** What `X_start` writes: `X/running`, with the OR form's `X/ran_i` or the join forms' `X/free_*` refunds. */
function startOutput(side: LocalInputSide, running: Place<unknown>, freeRefunds: InputSide['freeRefunds']): Out {
  switch (side.form) {
    case 'tool':
    case 'direct': return outPlace(running);
    case 'or': return and(outPlace(running), outPlace(side.input.ran));
    case 'join':
    case 'choose-branch': return and(outPlace(running), ...freeRefunds());
    default: return assertNever(side, 'input side');
  }
}

/** `X_start` and one `X_start_unmet_k` per guarded reference. */
export function buildStart(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  input: InputSide,
  references: ReferencePorts,
): { readonly startName: string; readonly startUnmetNames: readonly string[] } {
  const { depth, emit } = ctx;
  const { budget, halt, pause } = shared;
  const { idle, running } = markers;
  const { side, slotOf, freeRefunds } = input;
  const { refDone, refSkipped } = references;

  const startBuilder = (local: string, priority: number) => Transition.builder(local)
    .priority(priority)
    .inhibitors(halt, pause)
    .inputs(...activationInputs(side, slotOf), one(budget), one(idle))
    .outputs(startOutput(side, running, freeRefunds));
  const startName = emit(startBuilder(TRANSITION.start, depth).reads(...refDone).build(), { role: 'start' });
  const startUnmetNames = refSkipped.map((ref, k) =>
    emit(startBuilder(startUnmetOf(k), depth - 1).read(ref.skipped).build(), { role: 'start-unmet', reference: ref.node }));
  return { startName, startUnmetNames };
}
