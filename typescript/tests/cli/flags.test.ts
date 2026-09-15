/**
 * The flag parser the three command lines share. Its order is the contract: every word is
 * handled as it comes, so the first bad word on the line is the one reported.
 */
import { parseFlags, UsageError } from '../../src/cli/flags.js';
import type { FlagSpec } from '../../src/cli/flags.js';

/** A spec that records what it saw, in order. */
function recording(): { seen: string[]; spec: FlagSpec } {
  const seen: string[] = [];
  return {
    seen,
    spec: {
      values: {
        '--out': (v) => { seen.push(`out=${v}`); },
        '--budget': (v) => {
          if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError('--budget must be a positive integer');
          seen.push(`budget=${v}`);
        },
      },
      switches: { '--json': () => { seen.push('json'); } },
      positional: (word) => { seen.push(`file=${word}`); },
    },
  };
}

describe('parseFlags', () => {
  it('handles values, switches and positionals in the order they appear', () => {
    const { seen, spec } = recording();
    parseFlags(['a', '--json', '--out', 'r.md', 'b', '--budget', '2'], spec);
    expect(seen).toEqual(['file=a', 'json', 'out=r.md', 'file=b', 'budget=2']);
  });

  it('a value flag takes the next word, whatever it looks like', () => {
    const { seen, spec } = recording();
    parseFlags(['--out', '--json', '--out', '-'], spec);
    expect(seen).toEqual(['out=--json', 'out=-']);
  });

  it('a value flag at the end of the line needs a value', () => {
    const { spec } = recording();
    expect(() => parseFlags(['a', '--out'], spec)).toThrow(new UsageError('--out needs a value'));
  });

  it('an unknown -- option is a usage error; a single dash is a positional', () => {
    const { seen, spec } = recording();
    expect(() => parseFlags(['--nope'], spec)).toThrow(new UsageError('unknown option --nope'));
    expect(() => parseFlags(['--'], spec)).toThrow(UsageError);
    parseFlags(['-x', '-'], spec);
    expect(seen).toEqual(['file=-x', 'file=-']);
  });

  it('reports the first bad word, not the first bad kind', () => {
    const { spec } = recording();
    expect(() => parseFlags(['--budget', '0', '--nope'], spec)).toThrow('--budget must be a positive integer');
    expect(() => parseFlags(['--nope', '--budget', '0'], spec)).toThrow('unknown option --nope');
  });

  it('never dispatches to a key inherited from Object.prototype', () => {
    const { seen, spec } = recording();
    parseFlags(['toString', 'constructor', '__proto__'], spec);
    expect(seen).toEqual(['file=toString', 'file=constructor', 'file=__proto__']);
  });

  it('passes on what a handler throws', () => {
    expect(() => parseFlags(['x'], { positional: () => { throw new RangeError('boom'); } })).toThrow(RangeError);
  });

  it('UsageError is a named Error', () => {
    const e = new UsageError('bad');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('UsageError');
    expect(e.message).toBe('bad');
  });
});
