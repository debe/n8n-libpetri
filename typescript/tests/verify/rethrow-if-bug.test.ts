/**
 * `rethrowIfBug` decides which failures may become an "undecided" verdict and which are bugs
 * that must fail loudly. A compiler invariant broken inside the verifier is a bug by definition;
 * a malformed workflow (`CompileError`) or an unanswerable query is a condition.
 */
import { CompileError, InternalCompilerError } from '../../src/compiler/index.js';
import { rethrowIfBug } from '../../src/verify/state-class.js';

describe('rethrowIfBug', () => {
  it.each([
    ['a TypeError', new TypeError('x is not a function')],
    ['a ReferenceError', new ReferenceError('y is not defined')],
    ['an InternalCompilerError', new InternalCompilerError('internal: duplicate place')],
  ])('rethrows %s: a bug is never a verdict', (_label, error) => {
    expect(() => rethrowIfBug(error)).toThrow(error);
  });

  it.each([
    ['a plain Error', new Error('solver died')],
    ['a RangeError', new RangeError('Maximum call stack size exceeded')],
    ['a CompileError', new CompileError('unknown-node', "compile: unknown node 'X'", 'X')],
  ])('lets %s through to become undecided', (_label, error) => {
    expect(() => rethrowIfBug(error)).not.toThrow();
  });
});
