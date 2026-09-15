/** Action binding over a mapped net (CORE-042): every transition resolved through its `NetMap` entry. */
import type { PetriNet } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { NetMap } from '../net-map.js';
import type { ActionBinder } from '../types.js';

/** `net` with `binder`'s action on every transition; a binder returning `null` keeps passthrough. */
export function bindActions(net: PetriNet, map: NetMap, binder: ActionBinder): PetriNet {
  return net.bindActionsWithResolver((name) => {
    const info = map.transition(name);
    if (info === undefined) throw new InternalCompilerError(`internal: binding an unmapped transition '${name}'`);
    return binder(info, map);
  });
}
