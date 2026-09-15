/**
 * The choose-branch form (README "Join gadget"): required inputs (`requiredInputs`) get
 * `X/ready_i_data` / `X/ready_i_empty` and their data/empty combinations are enumerated — one
 * skip per combination but the all-data one, which is `X_start`; the rest keep one `X/ready_i`.
 * A required input with no producer is dead (never written).
 */
import { Transition, one } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { freeOf, readyOf, readyVariantOf, skipCombinationOf } from '../names.js';
import type { Variant } from '../types.js';
import type { GadgetContext } from './context.js';
import { inputCommon, inputIndexes } from './input-edges.js';
import type { LocalChooseBranchSide, LocalJoinInput, LocalSplitReadyInput } from './local-shapes.js';
import type { SkipFrame } from './skip.js';

/** Declares every modelled input's join slots. */
export function declareChooseBranchSide(ctx: GadgetContext): LocalChooseBranchSide {
  return { form: 'choose-branch', inputs: inputIndexes(ctx).map((i) => declareInput(ctx, i)) };
}

/** `X/free_i` and either the split `X/ready_i_data` / `X/ready_i_empty` (required) or one `X/ready_i`. */
function declareInput(ctx: GadgetContext, i: number): LocalJoinInput {
  const { internal } = ctx;
  const common = inputCommon(ctx, i);
  const free = internal(freeOf(i), 'free', i);
  if (!common.required) return { ...common, slot: 'ready', free, ready: internal(readyOf(i), 'ready', i) };
  const readyData = internal(readyVariantOf(i, 'data'), 'ready', i, { variant: 'data' });
  const readyEmpty = common.emptyCapable ? internal(readyVariantOf(i, 'empty'), 'ready', i, { variant: 'empty' }) : null;
  return { ...common, slot: 'ready-split', free, readyData, readyEmpty };
}

/** Every assignment over `choices[i]` per input, in lexicographic order with `data` first. */
function combinations(choices: readonly (readonly Variant[])[]): Variant[][] {
  let acc: Variant[][] = [[]];
  for (const options of choices) {
    const next: Variant[][] = [];
    for (const c of acc) for (const v of options) next.push([...c, v]);
    acc = next;
  }
  return acc;
}

/** One skip per enumerated combination of the required inputs' variants, bar the all-data one. */
export function buildChooseBranchSkips(ctx: GadgetContext, side: LocalChooseBranchSide, frame: SkipFrame): readonly string[] {
  const listed = side.inputs.filter((i): i is LocalSplitReadyInput => i.slot === 'ready-split');
  /** Each enumerated input's position in `listed`, which is its column in every combination. */
  const columnOf = new Map(listed.map((i, k) => [i, k] as const));
  const choices = listed.map((i): Variant[] => (i.emptyCapable ? ['data', 'empty'] : ['data']));
  const skipNames: string[] = [];
  for (const combo of combinations(choices)) {
    if (combo.every((v) => v === 'data')) continue; // that combination is X_start
    skipNames.push(buildCombinationSkip(ctx, side, frame, combo, columnOf));
  }
  return skipNames;
}

/** The skip of one combination: every `X/ready_i`, and each enumerated input on its variant's place. */
function buildCombinationSkip(
  ctx: GadgetContext,
  side: LocalChooseBranchSide,
  frame: SkipFrame,
  combo: Variant[],
  columnOf: ReadonlyMap<LocalSplitReadyInput, number>,
): string {
  const local = skipCombinationOf(combo);
  const variantOf = (i: LocalSplitReadyInput): Variant => {
    const column = columnOf.get(i);
    const v = column === undefined ? undefined : combo[column];
    if (v === undefined) throw new InternalCompilerError(`internal: node '${ctx.name}' skip ${local} has no variant for input ${i.index}`);
    return v;
  };
  const skip = Transition.builder(local).inhibitor(frame.halt).priority(ctx.depth);
  for (const i of side.inputs) skip.inputs(one(i.slot === 'ready' ? i.ready : frame.slotOf(i, variantOf(i))));
  return ctx.emit(skip.outputs(frame.skipOut).build(), { role: 'skip', combination: combo });
}
