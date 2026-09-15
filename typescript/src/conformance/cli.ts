/**
 * Command line: `tsx src/conformance/cli.ts <baseline.junit.xml> <candidate.junit.xml>
 * [--baseline-label L] [--candidate-label L] [--out report.md] [--require-identical]`.
 *
 * Prints the Markdown matrix (or writes it to `--out`) and exits 0 when the candidate has
 * no regression against the baseline — with `--require-identical`, only when the case set
 * and every outcome are the same, which is what a pure refactor of the loop must produce.
 * Exit 1 otherwise, 2 on a usage or input error (bad flag, unreadable report, a report that
 * is not JUnit XML). `scripts/run-conformance.sh` drives it.
 */
import { pathToFileURL } from 'node:url';

import { exitWith } from '../cli/exit.js';
import { parseFlags, UsageError } from '../cli/flags.js';
import { nodeIo } from '../cli/io.js';
import type { CliIo } from '../cli/io.js';
import { messageOf } from '../internal/errors.js';
import { parseJunit } from './junit.js';
import type { JunitReport } from './junit.js';
import { buildMatrix } from './matrix.js';
import { renderMatrix } from './report.js';

export type { CliIo } from '../cli/io.js';

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
  try {
    parseFlags(argv, {
      values: {
        '--baseline-label': (v) => { baselineLabel = v; },
        '--candidate-label': (v) => { candidateLabel = v; },
        '--out': (v) => { out = v; },
      },
      switches: { '--require-identical': () => { requireIdentical = true; } },
      positional: (word) => { files.push(word); },
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (files.length !== 2) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const [baselinePath, candidatePath] = files as [string, string];

  // Reading or parsing a report is an input error: exit 2 naming the file, like
  // `n8n-libpetri verify`, not an exception the script turns into exit 1 — which the
  // conformance run could not tell apart from a regression.
  const reports: JunitReport[] = [];
  for (const path of [baselinePath, candidatePath]) {
    try {
      reports.push(parseJunit(io.readFile(path)));
    } catch (e) {
      io.stderr(`${path}: ${messageOf(e)}\n`);
      return 2;
    }
  }
  const [baseline, candidate] = reports as [JunitReport, JunitReport];

  const matrix = buildMatrix(baseline, candidate, { baselineLabel, candidateLabel });
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

// Not a tsup entry, and must not become one as is: under code splitting this guard compares
// a chunk's URL and is never true (see `src/verify/main.ts`) — give it a thin main first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitWith(() => runCli(process.argv.slice(2), nodeIo));
}
