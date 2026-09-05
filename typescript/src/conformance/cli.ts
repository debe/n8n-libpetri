/**
 * Command line: `tsx src/conformance/cli.ts <baseline.junit.xml> <candidate.junit.xml>
 * [--baseline-label L] [--candidate-label L] [--out report.md] [--require-identical]`.
 *
 * Prints the Markdown matrix (or writes it to `--out`) and exits 0 when the candidate has
 * no regression against the baseline — with `--require-identical`, only when the case set
 * and every outcome are the same, which is what a pure refactor of the loop must produce.
 * Exit 1 otherwise, 2 on a usage error. `scripts/run-conformance.sh` drives it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseJunit } from './junit.js';
import { buildMatrix } from './matrix.js';
import { renderMatrix } from './report.js';

export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const USAGE =
  'usage: conformance <baseline.junit.xml> <candidate.junit.xml> ' +
  '[--baseline-label L] [--candidate-label L] [--out FILE] [--require-identical]';

/** Run the command line against `io`; returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const files: string[] = [];
  let baselineLabel: string | undefined;
  let candidateLabel: string | undefined;
  let out: string | undefined;
  let requireIdentical = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === '--baseline-label') baselineLabel = value();
      else if (arg === '--candidate-label') candidateLabel = value();
      else if (arg === '--out') out = value();
      else if (arg === '--require-identical') requireIdentical = true;
      else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
      else files.push(arg);
    } catch (e) {
      io.stderr(`${(e as Error).message}\n${USAGE}\n`);
      return 2;
    }
  }
  if (files.length !== 2) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const [baselinePath, candidatePath] = files as [string, string];
  const matrix = buildMatrix(
    parseJunit(io.readFile(baselinePath)),
    parseJunit(io.readFile(candidatePath)),
    { baselineLabel, candidateLabel },
  );
  const report = renderMatrix(matrix);
  if (out) io.writeFile(out, report);
  else io.stdout(report);
  const ok = requireIdentical ? matrix.identical : matrix.regressions.length === 0;
  io.stderr(
    `loop-driving ${matrix.loopDriving.passed}/${matrix.loopDriving.total} passed, ` +
      `helper ${matrix.helper.passed}/${matrix.helper.total} passed, ` +
      `${matrix.regressions.length} regression(s)` +
      `${requireIdentical ? `, identical: ${matrix.identical}` : ''}\n`,
  );
  return ok ? 0 : 1;
}

const nodeIo: CliIo = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2), nodeIo);
}
