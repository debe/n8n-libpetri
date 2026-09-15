/**
 * The flat-net prefix rule every other name in `names.ts` is qualified by (MOD-010, MOD-012).
 */

/** The flat-net name of a node-local place or transition: `${id}/${local}` (MOD-010, MOD-012). */
export function qualified(id: string, local: string): string {
  return `${id}/${local}`;
}
