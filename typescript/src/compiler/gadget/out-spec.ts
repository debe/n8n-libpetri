/** The two `Out` combinators the gadget needs collapsed when they would have one child (IO-011, IO-012). */
import { and, xor } from 'libpetri';
import type { Out } from 'libpetri';
import { InternalCompilerError } from '../errors.js';

/** `and` with one child collapses to the child (IO-011 requires ≥ 1 child). */
export function andOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new InternalCompilerError('internal: andOf() with no children');
  return rest.length === 0 ? first : and(first, ...rest);
}

/** `xor` with one child collapses to the child (IO-012 requires ≥ 2 children). */
export function xorOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new InternalCompilerError('internal: xorOf() with no children');
  return rest.length === 0 ? first : xor(first, ...rest);
}
