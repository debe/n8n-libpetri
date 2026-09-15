/**
 * The one rule every catch in the verification surface follows: a real condition may become
 * "undecided", a programming error may not.
 */
import { InternalCompilerError } from '../compiler/index.js';

/**
 * Re-throws a **programming** error rather than letting it become a weaker verdict.
 *
 * The catches in this surface convert a failure into "undecided" — the route could not answer,
 * the solver died, the graph could not be built. That is right for a real condition and wrong
 * for a bug in this codebase or a mismatch with libpetri, and once both arrive as "undecided"
 * they are indistinguishable: the report stays well-formed, the proofs quietly disappear, and
 * nothing fails. A `TypeError` is how a library method this code calls but the installed
 * version does not have presents itself, so that instance would turn a version skew into a
 * silently weaker suite (`tasks/todo.md`).
 *
 * `TypeError` and `ReferenceError` are never verdicts, and neither is an
 * `InternalCompilerError`: it is the compiler saying one of its own invariants broke, which is
 * a bug in this codebase by definition. `RangeError` is deliberately excluded: a stack overflow
 * on a deep net is a capacity limit, which is what "undecided" is for.
 */
export function rethrowIfBug(e: unknown): void {
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof InternalCompilerError) throw e;
}
