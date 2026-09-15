/**
 * The input side of the gadget (README "Per-node gadget", "Join gadget", "OR-inputs"; ADR 0003):
 * the edge ports and join slots of each form and whether the node can skip. Each form declares
 * its places in its own module — `input-direct.ts`, `input-or.ts`, `input-join.ts`,
 * `input-choose-branch.ts`, `input-tool.ts` — over the shared producer edges of `input-edges.ts`.
 * `X_start` with its `start_unmet` twins, `X_skip`, the OR form's `X_clear` and the arms are
 * built by `start.ts`, `skip.ts`, `input-or.ts` and `arms.ts`, and re-exported here.
 */
import { outPlace } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { PLACE, skippedPlaceOf } from '../names.js';
import type { Variant } from '../types.js';
import type { GadgetContext } from './context.js';
import { declareChooseBranchSide } from './input-choose-branch.js';
import { declareDirectSide } from './input-direct.js';
import { declareJoinSide } from './input-join.js';
import { declareOrSide } from './input-or.js';
import { declareToolSide } from './input-tool.js';
import type { LocalInputSide, LocalJoinInput, LocalOrInput } from './local-shapes.js';
import { readySlot } from './ready-slot.js';

export { buildArms } from './arms.js';
export { buildClear } from './input-or.js';
export { readySlot } from './ready-slot.js';
export { buildSkips } from './skip.js';
export { buildStart } from './start.js';

/** The input side over local places, with the helpers every start, skip and arm reads it through. */
export interface InputSide {
  readonly side: LocalInputSide;
  /** The join-slot inputs (empty for the direct, OR and tool forms). */
  readonly joinInputs: readonly LocalJoinInput[];
  /** Every modelled input, whichever slot shape. */
  readonly allInputs: readonly (LocalOrInput | LocalJoinInput)[];
  readonly slotOf: (i: LocalJoinInput, variant: Variant) => Place<unknown>;
  /** The `X/free_i` refunds every start / skip writes. */
  readonly freeRefunds: () => Out[];
}

/** Whether the node skips, and where its `skipped` marker lives. */
export interface SkipDecl {
  readonly hasSkip: boolean;
  /** The local `X/skipped`, exposed as a port; `null` when the node has no skip. */
  readonly skipped: Place<unknown> | null;
  /** The host-level `X/skipped` `compile` creates for a referenced node without a skip. */
  readonly hostSkippedName: string | null;
}

/** The places of the node's form, declared by that form's module. */
function declareSide(ctx: GadgetContext): LocalInputSide {
  switch (ctx.form) {
    case 'tool': return declareToolSide(ctx);
    case 'direct': return declareDirectSide(ctx);
    case 'or': return declareOrSide(ctx);
    case 'join': return declareJoinSide(ctx);
    case 'choose-branch': return declareChooseBranchSide(ctx);
    default: return assertNever(ctx.form, 'join form');
  }
}

/** Declares the input side of the node's form: edge ports, join slots, the OR round places, `in_tool`. */
export function buildInputSide(ctx: GadgetContext): InputSide {
  const { name, form } = ctx;
  const side = declareSide(ctx);
  /** The join-slot inputs (empty for the direct, OR and tool forms), for the refunds every start / skip writes. */
  const joinInputs: readonly LocalJoinInput[] = side.form === 'join' || side.form === 'choose-branch' ? side.inputs : [];
  /** Every modelled input, whichever slot shape: the arms and the gadget's `inputs`. */
  const allInputs: readonly (LocalOrInput | LocalJoinInput)[] = side.form === 'or' ? [side.input] : joinInputs;
  const slotOf = (i: LocalJoinInput, variant: Variant): Place<unknown> => readySlot({ node: name, form }, i, variant);
  const freeRefunds = (): Out[] => joinInputs.map((i) => outPlace(i.free));
  return { side, joinInputs, allInputs, slotOf, freeRefunds };
}

/** Whether an empty token can arrive where it decides the activation. */
function canSkip(side: LocalInputSide): boolean {
  switch (side.form) {
    case 'tool': return false;
    case 'direct': return side.inEmpty !== null;
    case 'or': return true;
    case 'join': return side.inputs.some((i) => i.emptyCapable);
    case 'choose-branch': return side.inputs.some((i) => i.required && i.emptyCapable);
    default: return assertNever(side, 'input side');
  }
}

/** Decides whether the node skips and declares its `skipped` marker, as a port or host-owned. */
export function declareSkipped(ctx: GadgetContext, side: LocalInputSide): SkipDecl {
  const { analysis, name, id, internal, hostOwned, portDecls } = ctx;

  // ---- skip exists iff an empty token can arrive where it decides the activation ----
  const hasSkip = canSkip(side);
  // The skipped marker also exists when a referencing node's start_unmet twin reads it: as
  // a port when a skip writes it, otherwise as a host-level place owned by this node.
  const referenced = analysis.referenced.has(name);
  const skipped = hasSkip ? internal(PLACE.skipped, 'skipped', null) : null;
  if (skipped !== null) portDecls.push({ name: PLACE.skipped, local: skipped, direction: 'output' });
  /** The host-level `X/skipped` `compile` creates for a referenced node without a skip. */
  const hostSkippedName = skipped === null && referenced ? skippedPlaceOf(id) : null;
  if (hostSkippedName !== null) hostOwned(hostSkippedName, 'skipped', null);
  return { hasSkip, skipped, hostSkippedName };
}
