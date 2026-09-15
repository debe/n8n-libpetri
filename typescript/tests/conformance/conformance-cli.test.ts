/**
 * `tsx src/conformance/cli.ts <baseline> <candidate>`: the exit-2 contract of its docstring.
 *
 * A usage error, an unreadable report or one that is not JUnit XML is an input error — exit 2
 * with a sentence on stderr, like `n8n-libpetri verify`. It used to throw out of `runCli`, so
 * `scripts/run-conformance.sh` saw exit 1 with a stack, indistinguishable from a regression.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli, USAGE } from '../../src/conformance/cli.js';
import type { CliIo } from '../../src/conformance/cli.js';

const XML = readFileSync(fileURLToPath(new URL('./fixtures/baseline.junit.xml', import.meta.url)), 'utf8');

interface Captured extends CliIo {
  out: string;
  err: string;
  readonly written: Map<string, string>;
}

function io(files: Readonly<Record<string, string>>): Captured {
  const captured: Captured = {
    out: '',
    err: '',
    written: new Map(),
    readFile: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return content;
    },
    writeFile: (p, c) => { captured.written.set(p, c); },
    stdout: (t) => { captured.out += t; },
    stderr: (t) => { captured.err += t; },
  };
  return captured;
}

describe('conformance CLI input errors exit 2', () => {
  it('a missing baseline file', () => {
    const captured = io({ 'cand.xml': XML });
    expect(runCli(['base.xml', 'cand.xml'], captured)).toBe(2);
    expect(captured.err).toContain('base.xml: ');
    expect(captured.err).toContain('ENOENT');
    expect(captured.out).toBe('');
  });

  it('a missing candidate file', () => {
    const captured = io({ 'base.xml': XML });
    expect(runCli(['base.xml', 'cand.xml'], captured)).toBe(2);
    expect(captured.err).toContain('cand.xml: ');
    expect(captured.out).toBe('');
  });

  it('a report that is not JUnit XML', () => {
    for (const text of ['<testsuites><testsuite>', '', '<html></html>']) {
      const captured = io({ 'base.xml': XML, 'cand.xml': text });
      expect(runCli(['base.xml', 'cand.xml', '--out', 'r.md'], captured), JSON.stringify(text)).toBe(2);
      expect(captured.err, JSON.stringify(text)).toContain('cand.xml: ');
      expect(captured.written.size).toBe(0);
      expect(captured.out).toBe('');
    }
  });

  it('an unknown flag, a missing value and a wrong file count, each with the usage line', () => {
    for (const argv of [['a', 'b', '--bogus'], ['a', 'b', '--out'], ['a'], ['a', 'b', 'c'], []]) {
      const captured = io({ a: XML, b: XML, c: XML });
      expect(runCli(argv, captured), argv.join(' ')).toBe(2);
      expect(captured.err, argv.join(' ')).toContain(USAGE);
      expect(captured.out).toBe('');
    }
  });
});
