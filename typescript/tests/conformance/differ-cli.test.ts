/**
 * `tsx src/conformance/differ-cli.ts <fixtures-module>`: the exit-2 contract of its
 * docstring. A usage error or a fixtures module that cannot be loaded is an input error —
 * exit 2 with a sentence on stderr, like `n8n-libpetri verify` — not a rejection the script
 * entry turned into exit 1, indistinguishable from a failed run.
 */
import { runDifferCli } from '../../src/conformance/differ-cli.js';
import type { DifferCliIo } from '../../src/conformance/differ-cli.js';

interface Captured extends DifferCliIo {
  out: string;
  err: string;
  readonly written: Map<string, string>;
}

function io(load: DifferCliIo['load']): Captured {
  const captured: Captured = {
    out: '',
    err: '',
    written: new Map(),
    load,
    writeFile: (p, c) => { captured.written.set(p, c); },
    stdout: (t) => { captured.out += t; },
    stderr: (t) => { captured.err += t; },
    diff: () => { throw new Error('no fixture should run'); },
  };
  return captured;
}

const unreachable: DifferCliIo['load'] = () => { throw new Error('no module should load'); };

describe('differ CLI input errors exit 2', () => {
  it('a fixtures module that cannot be loaded', async () => {
    const captured = io(async (specifier) => {
      await Promise.resolve();
      throw new Error(`Cannot find module '${specifier}'`);
    });
    expect(await runDifferCli(['./gone.ts'], captured)).toBe(2);
    expect(captured.err).toContain('./gone.ts: ');
    expect(captured.err).toContain('Cannot find module');
    expect(captured.out).toBe('');
  });

  it('a fixtures module whose evaluation throws synchronously', async () => {
    const captured = io(() => { throw new SyntaxError('Unexpected token'); });
    expect(await runDifferCli(['./broken.ts'], captured)).toBe(2);
    expect(captured.err).toContain('./broken.ts: Unexpected token');
  });

  it('an unknown flag, a missing value, a second module and a bad budget, each with the usage line', async () => {
    for (const argv of [['m', '--nope'], ['m', '--out'], ['m', 'n'], ['m', '--budget', '0'], ['m', '--budget', 'x'], []]) {
      const captured = io(unreachable);
      expect(await runDifferCli(argv, captured), argv.join(' ')).toBe(2);
      expect(captured.err, argv.join(' ')).toContain('usage: differ-cli <fixtures-module>');
      expect(captured.out).toBe('');
    }
  });
});
