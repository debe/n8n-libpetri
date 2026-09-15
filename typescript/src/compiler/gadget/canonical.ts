/**
 * Local → canonical places, for `materialise` (MOD-010, MOD-020): every local place a gadget
 * declared resolves, through the final name recorded when it was declared, to the canonical
 * place of the composed net; a host place `compile` created is already under its final name.
 */
import type { Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { EdgeSlot } from '../types.js';
import type { LocalEdge } from './local-shapes.js';

/** The lookups every canonical part is built through. */
export interface Canon {
  /** The canonical place of a final name. */
  readonly lookup: (finalName: string) => Place<unknown>;
  /** The canonical place of a local one, by the final name recorded when it was declared. */
  readonly fin: (p: Place<unknown>) => Place<unknown>;
  readonly finOpt: (p: Place<unknown> | null) => Place<unknown> | null;
  /** An edge's host slot, whose places `compile` created under their final names. */
  readonly slot: (e: LocalEdge) => EdgeSlot;
}

/** The lookups of node `name`'s gadget over the composed net's `lookup`. */
export function canonOf(
  name: string,
  finalNames: ReadonlyMap<Place<unknown>, string>,
  lookup: (finalName: string) => Place<unknown>,
): Canon {
  const fin = (p: Place<unknown>): Place<unknown> => {
    const finalName = finalNames.get(p);
    if (finalName === undefined) throw new InternalCompilerError(`internal: node '${name}' has no final name for local place '${p.name}'`);
    return lookup(finalName);
  };
  return {
    lookup,
    fin,
    finOpt: (p) => (p === null ? null : fin(p)),
    slot: (e) => ({
      edge: e.edge,
      data: lookup(e.host.data.name),
      empty: e.host.empty === null ? null : lookup(e.host.empty.name),
    }),
  };
}
