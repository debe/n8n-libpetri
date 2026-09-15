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
 *   --timeout MS           per-query z3 timeout for the SMT fallback (default 60000)
 *   --max-classes N        state-class cap for the solver-free route (default 200000; 0 = off)
 *   --smt-fallback MODE    auto (default) | off | force — how far the SMT route may go
 *   --node-types FILE      JSON node-type shapes; without it port counts are guessed
 *   --start NODE           start node (default: the first unfed node, triggers first)
 *   --mutex A,B            add a mutual-exclusion pair; repeatable
 *   --all-pairs            mutual exclusion for every pair of nodes (O(n^2) queries)
 *   --no-semiflows         turn VER-007 semiflow strengthening off
 *   --strict               fail the run when any check is not `proven` (unknown or bounded)
 *   --json                 emit the report as JSON instead of the table
 *   --out FILE             write to FILE instead of stdout
 *   --quiet                do not stream each check as it completes
 * ```
 *
 * Exit codes, which are the whole of the CI contract:
 *
 * - **0** — every check came back `proven`, or `unknown` / `bounded` without `--strict`.
 * - **1** — something came back `violated`; with `--strict`, also when anything came back
 *   `unknown` or `bounded`.
 * - **2** — a usage or input error (bad flag, unreadable file, malformed JSON).
 * - **3** — **no usable z3 resolved**, so the SMT fallback never ran (VER-013). This is
 *   deliberately not 0: a run whose solver-backed families were all skipped must not be
 *   indistinguishable from a clean one at the exit code, which is the only thing a CI job
 *   reads. Since M5 it ranks **below** a finding: the solver-free route (VER-010) decides
 *   the reachability-safety families with no solver at all, so a stranding it found is
 *   reported as exit 1 even when no z3 resolved — a real finding must never be masked by a
 *   missing tool.
 *
 * Without `--strict` an `unknown` or `bounded` verdict does not fail the run — neither is a
 * finding, and `docs/verification.md` says which checks are expected to return one — but the
 * table and the JSON both carry it, and `--strict` is what a gate that wants the proofs to
 * stay proofs should use. `--strict` fails on `bounded` as well as on `unknown`: a bounded
 * verdict is sound within the graph's closed prefix and is deliberately not a proof, so a
 * gate that demands proofs must not accept it.
 *
 * `--smt-fallback` is the escape hatch for the size ceiling `verify()` applies to the SMT
 * route: above a measured net size libpetri's pre-solver pipeline exhausts the V8 heap, which
 * **aborts the process** rather than returning a verdict, so `auto` refuses to start it and
 * reports `unknown` with the ceiling instead. `force` runs it anyway; `off` never runs it.
 */
import { parseFlags, UsageError } from '../cli/flags.js';
import type { CliIo } from '../cli/io.js';
import { messageOf } from '../internal/errors.js';
import { renderReport, renderSubject } from './report.js';
import { rethrowIfBug } from './state-class.js';
import { PROPERTY_NAMES } from './types.js';
import type { PropertyName, SmtFallbackMode, VerificationReport, VerifyOptions } from './types.js';
import { verify } from './verify.js';
import { parseNodeTypesFile, parseWorkflowJson } from './workflow-json.js';
import type { NodeTypesFile, WorkflowJsonResult } from './workflow-json.js';

// The command-line kernel every CLI here shares; re-exported so `n8n-libpetri/verify/cli`
// keeps its surface. `main.ts` runs `runCli` against `nodeIo`.
export { UsageError } from '../cli/flags.js';
export { nodeIo } from '../cli/io.js';
export type { CliIo } from '../cli/io.js';

export const USAGE =
  'usage: n8n-libpetri verify <workflow.json> [--budget k] [--property NAME]... [--timeout ms]\n' +
  '                          [--max-classes n] [--smt-fallback auto|off|force] [--node-types FILE]\n' +
  '                          [--start NODE] [--mutex A,B]... [--all-pairs] [--no-semiflows]\n' +
  '                          [--strict] [--json] [--out FILE] [--quiet]\n' +
  `  properties: ${PROPERTY_NAMES.join(', ')}\n` +
  '  exit: 0 clean, 1 violation (or unknown/bounded under --strict), 2 usage, 3 no usable z3';

/** What {@link parseArgs} read off the command line. */
export interface ParsedArgs {
  readonly file: string;
  readonly options: VerifyOptions;
  readonly nodeTypesFile: string | null;
  readonly startNode: string | undefined;
  readonly json: boolean;
  readonly out: string | null;
  readonly quiet: boolean;
  readonly strict: boolean;
}

/** Parses `argv` (without `node` and the script). Throws {@link UsageError} on a bad flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv[0] === 'verify' ? argv.slice(1) : argv;
  const files: string[] = [];
  const properties: PropertyName[] = [];
  const pairs: Array<readonly [string, string]> = [];
  let budget: number | undefined;
  let timeoutMs: number | undefined;
  let maxClasses: number | undefined;
  let smtFallback: SmtFallbackMode | undefined;
  let nodeTypesFile: string | null = null;
  let startNode: string | undefined;
  let allPairs = false;
  let semiflows = true;
  let json = false;
  let out: string | null = null;
  let quiet = false;
  let strict = false;

  parseFlags(args, {
    values: {
      '--budget': (v) => {
        budget = Number(v);
        if (!Number.isInteger(budget) || budget < 1) throw new UsageError('--budget must be a positive integer');
      },
      '--timeout': (v) => {
        timeoutMs = Number(v);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout must be a positive number of ms');
      },
      '--property': (name) => {
        if (!PROPERTY_NAMES.includes(name as PropertyName)) {
          throw new UsageError(`unknown property '${name}'; one of ${PROPERTY_NAMES.join(', ')}`);
        }
        properties.push(name as PropertyName);
      },
      '--max-classes': (v) => {
        maxClasses = Number(v);
        if (!Number.isInteger(maxClasses) || maxClasses < 0) {
          throw new UsageError('--max-classes must be a non-negative integer (0 turns the solver-free route off)');
        }
      },
      '--smt-fallback': (mode) => {
        if (mode !== 'auto' && mode !== 'off' && mode !== 'force') {
          throw new UsageError("--smt-fallback must be one of auto, off, force");
        }
        smtFallback = mode;
      },
      '--node-types': (v) => { nodeTypesFile = v; },
      '--start': (v) => { startNode = v; },
      '--mutex': (v) => {
        const parts = v.split(',').map((s) => s.trim());
        if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
          throw new UsageError('--mutex takes two comma-separated node names');
        }
        pairs.push([parts[0]!, parts[1]!] as const);
      },
      '--out': (v) => { out = v; },
    },
    switches: {
      '--all-pairs': () => { allPairs = true; },
      '--no-semiflows': () => { semiflows = false; },
      '--strict': () => { strict = true; },
      '--json': () => { json = true; },
      '--quiet': () => { quiet = true; },
    },
    positional: (word) => { files.push(word); },
  });
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
      ...(maxClasses === undefined ? {} : { maxClasses }),
      ...(smtFallback === undefined ? {} : { smtFallback }),
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
    io.stderr(`${messageOf(e)}\n${USAGE}\n`);
    return 2;
  }

  // Checked, not cast: a file that parses but is not a NodeTypesFile is an input error, and
  // was a silent "no shapes" — every port count guessed, as if the flag had not been given.
  let nodeTypes: NodeTypesFile = {};
  try {
    if (parsed.nodeTypesFile !== null) nodeTypes = parseNodeTypesFile(JSON.parse(io.readFile(parsed.nodeTypesFile)));
  } catch (e) {
    io.stderr(`could not read --node-types ${parsed.nodeTypesFile}: ${messageOf(e)}\n`);
    return 2;
  }

  let workflow: WorkflowJsonResult;
  try {
    workflow = parseWorkflowJson(io.readFile(parsed.file), {
      nodeTypes,
      ...(parsed.startNode === undefined ? {} : { startNode: parsed.startNode }),
    });
  } catch (e) {
    io.stderr(`${parsed.file}: ${messageOf(e)}\n`);
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

  // What `verify()` throws is an input error — the compiler refusing the workflow, a policy
  // that names an output the node lacks — and is reported like one. A programming error
  // (`TypeError`, `ReferenceError`) is neither, and reporting it as exit 2 dropped the stack
  // the one person who can fix it needs; it propagates, and `main.ts` prints the stack of a
  // rejected run.
  let report: VerificationReport;
  try {
    report = await verify(workflow.description, options);
  } catch (e) {
    rethrowIfBug(e);
    io.stderr(`${parsed.file}: ${messageOf(e)}\n`);
    return 2;
  }

  const text = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`;
  if (parsed.out !== null) io.writeFile(parsed.out, text);
  else io.stdout(text);

  // A finding outranks a missing solver: the solver-free route (VER-010) decides the
  // reachability-safety families without z3, so a stranding it found is a finding whether or
  // not the fallback could run.
  if (!report.ok) return 1;
  // No solver: the SMT fallback never ran. That is not a clean run either.
  if (!report.solver.available) {
    io.stderr(`the SMT fallback did not run: ${report.solver.reason ?? 'no usable z3'}\n`);
    return 3;
  }
  const unproven = report.counts.unknown + report.counts.bounded;
  if (parsed.strict && unproven > 0) {
    io.stderr(
      `--strict: ${unproven} check(s) are not proven (${report.counts.unknown} unknown, ` +
      `${report.counts.bounded} bounded)\n`);
    return 1;
  }
  return 0;
}
