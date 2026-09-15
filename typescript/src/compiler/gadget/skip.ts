/**
 * The node's skip transitions (README "Per-node gadget", "Join gadget"): one per form, one per
 * enumerated combination for choose-branch, each built by its form's module.
 */
import { outPlace } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import type { GadgetContext } from './context.js';
import { buildChooseBranchSkips } from './input-choose-branch.js';
import { buildDirectSkip } from './input-direct.js';
import { buildJoinSkip } from './input-join.js';
import { buildOrSkip } from './input-or.js';
import type { InputSide } from './input-side.js';
import { andOf } from './out-spec.js';
import type { Markers, SharedPorts } from './ports.js';

/** What every form's skip reads its arcs and its output from. */
export interface SkipFrame {
  readonly halt: Place<unknown>;
  readonly idle: Place<unknown>;
  /** The one output every skip writes. */
  readonly skipOut: Out;
  readonly slotOf: InputSide['slotOf'];
}

/** The node's skip transitions: one per form, one per enumerated combination for choose-branch. */
export function buildSkips(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  input: InputSide,
  skipped: Place<unknown> | null,
  skipEmpties: readonly Out[],
): readonly string[] {
  if (skipped === null) return [];
  const { side, slotOf, freeRefunds } = input;
  // What every skip writes, whichever form decides it: the empty of each outgoing tree
  // edge, the marker, and the join slots refunded (none outside the join forms).
  const skipOut = andOf([...skipEmpties, outPlace(skipped), ...freeRefunds()]);
  const frame: SkipFrame = { halt: shared.halt, idle: markers.idle, skipOut, slotOf };
  switch (side.form) {
    case 'direct': return [buildDirectSkip(ctx, side, frame)];
    case 'or': return [buildOrSkip(ctx, side, frame)];
    case 'join': return [buildJoinSkip(ctx, side, frame)];
    case 'choose-branch': return buildChooseBranchSkips(ctx, side, frame);
    case 'tool': throw new InternalCompilerError(`internal: tool '${ctx.name}' has a skip transition`);
    default: return assertNever(side, 'input side');
  }
}
