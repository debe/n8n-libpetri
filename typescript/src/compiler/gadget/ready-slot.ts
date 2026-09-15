/** The `ready` place a join input's arrival lands on — the one copy of the rule. */
import type { Place } from 'libpetri';
import { CompileError } from '../errors.js';
import { readyVariantOf } from '../names.js';
import type { InputGadgetCommon, JoinForm, ReadySlot, SplitReadySlot, Variant } from '../types.js';

/**
 * The `ready` place a join input's arrival of `variant` lands on: `X/ready_i` for the
 * generic join and for a non-required choose-branch input (one place for both variants),
 * `X/ready_i_data` / `X/ready_i_empty` for a required choose-branch input. Throws a named
 * compile error instead of yielding a `null` marking key when the enumerated form has no
 * place for the variant (an input fed only by cycle edges has no `ready_i_empty`;
 * `initialMarking` never asks for it, since an input seeded empty has only unreachable —
 * hence tree-edge — producers).
 *
 * The one copy of the rule: the gadget applies it to its own local places before
 * composition, the compiler, the codec and the scheduler to the canonical ones afterwards.
 */
export function readySlot(
  g: { readonly node: string; readonly form: JoinForm },
  i: Pick<InputGadgetCommon, 'index' | 'emptyCapable'> & (ReadySlot | SplitReadySlot),
  variant: Variant,
): Place<unknown> {
  const p = i.slot === 'ready-split' ? (variant === 'data' ? i.readyData : i.readyEmpty) : i.ready;
  if (p === null) {
    throw new CompileError('no-ready-place',
      `compile: node '${g.node}' input ${i.index} has no ${readyVariantOf(i.index, variant)} place to seed ` +
      `(form '${g.form}', emptyCapable ${i.emptyCapable})`, g.node);
  }
  return p;
}
