/**
 * Command line: `n8n-libpetri verify <workflow.json> [options]`.
 *
 * Takes a real n8n workflow JSON export, compiles it with the same `compile()` the
 * scheduler uses and prints the property table plus, for every violation, the node path.
 * The leading `verify` word is optional, so `tsx src/verify/main.ts <workflow.json>` works
 * as well. This module is the pure part — {@link runCli} against an injected {@link CliIo};
 * `main.ts` is the process entry point the `bin` maps to.
 *
 * ```
 *   --budget k             concurrency budget (default 1; the compiler may lower it)
 *   --property NAME        run only this property family; repeatable
 *   --timeout MS           per-query z3 timeout (default 60000)
 *   --node-types FILE      JSON node-type shapes; without it port counts are guessed
 *   --start NODE           start node (default: the first unfed node, triggers first)
 *   --mutex A,B            add a mutual-exclusion pair; repeatable
 *   --all-pairs            mutual exclusion for every pair of nodes (O(n^2) queries)
 *   --no-semiflows         turn VER-007 semiflow strengthening off
 *   --strict               fail the run when any check came back `unknown`
 *   --json                 emit the report as JSON instead of the table
 *   --out FILE             write to FILE instead of stdout
 *   --quiet                do not stream each check as it completes
 * ```
 *
 * Exit codes, which are the whole of the CI contract:
 *
 * - **0** — every check came back `proven`, or `unknown` without `--strict`.
 * - **1** — something came back `violated`; with `--strict`, also when anything is `unknown`.
 * - **2** — a usage or input error (bad flag, unreadable file, malformed JSON).
 * - **3** — **no usable z3 resolved**, so no query ran at all (VER-013). This is deliberately
 *   not 0: a run in which nothing was verified must never be indistinguishable from a clean
 *   one at the exit code, which is the only thing a CI job reads. It is not 1 either — no
 *   finding was made — and it is returned whether or not `--strict` was given.
 *
 * Without `--strict` an `unknown` verdict does not fail the run — it is not a finding, and
 * `docs/verification.md` says which queries are expected to return one — but the table and
 * the JSON both carry it, and `--strict` is what a gate that wants the proofs to stay proofs
 * should use.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { renderReport, renderSubject } from './report.js';
import { PROPERTY_NAMES } from './types.js';
import type { PropertyName, VerifyOptions } from './types.js';
import { verify } from './verify.js';
import { parseWorkflowJson, type NodeTypesFile } from './workflow-json.js';

export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const USAGE =
  'usage: n8n-libpetri verify <workflow.json> [--budget k] [--property NAME]... [--timeout ms]\n' +
  '                          [--node-types FILE] [--start NODE] [--mutex A,B]... [--all-pairs]\n' +
  '                          [--no-semiflows] [--strict] [--json] [--out FILE] [--quiet]\n' +
  `  properties: ${PROPERTY_NAMES.join(', ')}\n` +
  '  exit: 0 clean, 1 violation (or unknown under --strict), 2 usage, 3 no usable z3';

interface ParsedArgs {
  readonly file: string;
  readonly options: VerifyOptions;
  readonly nodeTypesFile: string | null;
  readonly startNode: string | undefined;
  readonly json: boolean;
  readonly out: string | null;
  readonly quiet: boolean;
  readonly strict: boolean;
}

class UsageError extends Error {}

/** Parses `argv` (without `node` and the script). Throws {@link UsageError} on a bad flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv[0] === 'verify' ? argv.slice(1) : argv;
  const files: string[] = [];
  const properties: PropertyName[] = [];
  const pairs: Array<readonly [string, string]> = [];
  let budget: number | undefined;
  let timeoutMs: number | undefined;
  let nodeTypesFile: string | null = null;
  let startNode: string | undefined;
  let allPairs = false;
  let semiflows = true;
  let json = false;
  let out: string | null = null;
  let quiet = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--budget': {
        budget = Number(value());
        if (!Number.isInteger(budget) || budget < 1) throw new UsageError('--budget must be a positive integer');
        break;
      }
      case '--timeout': {
        timeoutMs = Number(value());
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout must be a positive number of ms');
        break;
      }
      case '--property': {
        const name = value();
        if (!PROPERTY_NAMES.includes(name as PropertyName)) {
          throw new UsageError(`unknown property '${name}'; one of ${PROPERTY_NAMES.join(', ')}`);
        }
        properties.push(name as PropertyName);
        break;
      }
      case '--node-types': nodeTypesFile = value(); break;
      case '--start': startNode = value(); break;
      case '--mutex': {
        const parts = value().split(',').map((s) => s.trim());
        if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
          throw new UsageError('--mutex takes two comma-separated node names');
        }
        pairs.push([parts[0]!, parts[1]!] as const);
        break;
      }
      case '--all-pairs': allPairs = true; break;
      case '--no-semiflows': semiflows = false; break;
      case '--strict': strict = true; break;
      case '--json': json = true; break;
      case '--out': out = value(); break;
      case '--quiet': quiet = true; break;
      default:
        if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
        files.push(arg);
    }
  }
  if (files.length !== 1) throw new UsageError('exactly one workflow file is required');

  const mutualExclusion = allPairs ? 'all-pairs' as const : pairs.length > 0 ? pairs : undefined;
  // No `--property` means "the defaults", which `selectProperties` widens with
  // mutual exclusion when a pair was named.
  const selected = properties.length > 0 ? properties : undefined;
  return {
    file: files[0]!,
    options: {
      ...(budget === undefined ? {} : { budget }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(selected === undefined ? {} : { properties: selected }),
      ...(mutualExclusion === undefined ? {} : { mutualExclusion }),
      semiflowInvariants: semiflows,
    },
    nodeTypesFile,
    startNode,
    json,
    out,
    quiet,
    strict,
  };
}

/** Runs the command line against `io`; resolves to the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.stderr(`${e instanceof UsageError ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }

  let nodeTypes: NodeTypesFile = {};
  try {
    if (parsed.nodeTypesFile !== null) nodeTypes = JSON.parse(io.readFile(parsed.nodeTypesFile)) as NodeTypesFile;
  } catch (e) {
    io.stderr(`could not read --node-types ${parsed.nodeTypesFile}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let workflow;
  try {
    workflow = parseWorkflowJson(io.readFile(parsed.file), {
      nodeTypes,
      ...(parsed.startNode === undefined ? {} : { startNode: parsed.startNode }),
    });
  } catch (e) {
    io.stderr(`${parsed.file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  for (const w of workflow.warnings) io.stderr(`warning: ${w}\n`);

  // The guessed shapes go into the report as well as onto stderr: they change which net was
  // verified, and a stored --json report has to say so on its own (ADR 0007 §8).
  const base: VerifyOptions = { ...parsed.options, shapeWarnings: workflow.warnings };
  const options: VerifyOptions = parsed.quiet ? base : {
    ...base,
    onCheck: (check) => io.stderr(
      `  ${check.verdict.padEnd(8)} ${check.property} / ${renderSubject(check.subject)} ` +
      `(${(check.elapsedMs / 1000).toFixed(1)}s)\n`),
  };

  let report;
  try {
    report = await verify(workflow.description, options);
  } catch (e) {
    io.stderr(`${parsed.file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const text = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`;
  if (parsed.out !== null) io.writeFile(parsed.out, text);
  else io.stdout(text);

  // No solver: every verdict is `unknown` because nothing ran. That is not a clean run.
  if (!report.solver.available) {
    io.stderr(`no verification ran: ${report.solver.reason ?? 'no usable z3'}\n`);
    return 3;
  }
  if (!report.ok) return 1;
  if (parsed.strict && report.counts.unknown > 0) {
    io.stderr(`--strict: ${report.counts.unknown} check(s) came back unknown\n`);
    return 1;
  }
  return 0;
}

/** Real files and streams. `main.ts` runs {@link runCli} against this. */
export const nodeIo: CliIo = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};
