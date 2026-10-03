/**
 * Command line: `tsx src/conformance/v2/entered-cli.ts <leg.junit.xml> <ledger.jsonl>
 * [--label L] [--out report.md] [--expect-entering]`.
 *
 * Writes the settlement leg's policy-entering report (`entered.ts`) and prints its headline.
 * Exit 0, or 1 when `--expect-entering` is given and no case entered the policy (F5: the scope
 * builds runtimes through `createEngineRuntime`, so a leg that never entered registered on the
 * wrong module instance), or 2 on a usage or input error. Regressions against the baseline are
 * the matrix's (`conformance/cli.ts`), not this command's. `scripts/run-conformance.sh` drives it.
 */
import { pathToFileURL } from 'node:url';

import { exitWith } from '../../cli/exit.js';
import { parseFlags, UsageError } from '../../cli/flags.js';
import { nodeIo } from '../../cli/io.js';
import type { CliIo } from '../../cli/io.js';
import { messageOf } from '../../internal/errors.js';
import { parseJunit } from '../junit.js';
import type { JunitReport } from '../junit.js';
import { buildEnteredReport, enteredHeadline, parseLedger, renderEnteredReport } from './entered.js';
import type { SettlementLedgerRecord } from '../../n8n-v2-vitest-setup.js';

export const USAGE = 'usage: entered <leg.junit.xml> <ledger.jsonl> [--label L] [--out FILE] [--expect-entering]';

/** Run the command line against `io`; returns the process exit code. */
export function runEnteredCli(argv: readonly string[], io: CliIo): number {
  const files: string[] = [];
  let label = 'leg';
  let out: string | undefined;
  let expectEntering = false;
  try {
    parseFlags(argv, {
      values: { '--label': (v) => { label = v; }, '--out': (v) => { out = v; } },
      switches: { '--expect-entering': () => { expectEntering = true; } },
      positional: (w) => { files.push(w); },
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
  const [junitPath, ledgerPath] = files as [string, string];
  let junit: JunitReport;
  let ledger: SettlementLedgerRecord[];
  try {
    junit = parseJunit(io.readFile(junitPath));
  } catch (e) {
    io.stderr(`${junitPath}: ${messageOf(e)}\n`);
    return 2;
  }
  try {
    ledger = parseLedger(io.readFile(ledgerPath));
  } catch (e) {
    io.stderr(`${ledgerPath}: ${messageOf(e)}\n`);
    return 2;
  }
  const report = buildEnteredReport(junit, ledger, label);
  const md = renderEnteredReport(report);
  if (out) io.writeFile(out, md);
  else io.stdout(md);
  io.stderr(`${label}: ${enteredHeadline(report)}\n`);
  if (expectEntering && report.totalCalls === 0) {
    io.stderr(`${label}: F5 — the scope builds engine runtimes, and no case entered the registered policy\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitWith(() => runEnteredCli(process.argv.slice(2), nodeIo));
}
