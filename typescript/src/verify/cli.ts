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
 *   --profile NAME         v1 (default) | engineV2 — the target the workflow is compiled for
 *   --budget k             concurrency budget (default 1; the compiler may lower it; refused under engineV2)
 *   --property NAME        run only this property family; repeatable
 *   --timeout MS           per-query z3 timeout for the SMT fallback (default 60000)
 *   --max-classes N        state-class cap for the solver-free route (default 200000; 0 = off)
 *   --smt-fallback MODE    auto (default) | off | force — how far the SMT route may go
 *   --node-types FILE      JSON node-type shapes; without it port counts are guessed
 *   --start NODE           start node (default: the first unfed node, triggers first; v1 only)
 *   --trigger NODE         the trigger that fired (engineV2 only; default: the only trigger)
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
 * `--profile engineV2` compiles for engine v2 (`tasks/v2-profile-plan.md`) and runs the
 * `settlement` family over the state-class graph alone (`settlement.ts`); `--property` of a v1
 * family then records it as not applicable. The workflow goes through the compiler's port of
 * n8n's converter (plan step 13): it is rooted at the trigger that fired — `--trigger`, or the
 * workflow's only trigger; a workflow with several needs `--trigger`, as n8n needs the name —
 * disabled nodes are spliced out, and what n8n's converter or validator refuses is refused with
 * the compiler's `CompileError`, exit 2 with the refusal on stderr, never a report. Measured on
 * the template corpus against n8n's own converter (`tasks/v2-acceptance.mts`), the verdicts
 * agree on every entry. Exit 3 does not apply under engineV2: no check there is solver-backed.
 *
 * `--smt-fallback` is the escape hatch for the size ceiling `verify()` applies to the SMT
 * route: above a measured net size libpetri's pre-solver pipeline exhausts the V8 heap, which
 * **aborts the process** rather than returning a verdict, so `auto` refuses to start it and
 * reports `unknown` with the ceiling instead. `force` runs it anyway; `off` never runs it.
 *
 * The flags are read in `cli/args.ts` and the exit code of a finished run is decided in
 * `cli/exit-code.ts`; this module runs the steps between them.
 */
import type { CliIo } from '../cli/io.js';
import { messageOf } from '../internal/errors.js';
import { parseArgs, USAGE } from './cli/args.js';
import type { ParsedArgs } from './cli/args.js';
import { exitCodeOf } from './cli/exit-code.js';
import { renderReport, renderSubject } from './report.js';
import { rethrowIfBug } from './state-class.js';
import type { PropertyCheck, VerificationReport, VerifyOptions } from './types.js';
import { verify } from './verify.js';
import { parseNodeTypesFile, parseWorkflowJson } from './workflow-json.js';
import type { NodeTypesFile, WorkflowJsonResult } from './workflow-json.js';

// The command-line kernel every CLI here shares; re-exported so `n8n-libpetri/verify/cli`
// keeps its surface. `main.ts` runs `runCli` against `nodeIo`.
export { UsageError } from '../cli/flags.js';
export { nodeIo } from '../cli/io.js';
export type { CliIo } from '../cli/io.js';
export { parseArgs, USAGE } from './cli/args.js';
export type { ParsedArgs } from './cli/args.js';

/** A usage or input error: the run ends here, the reason already on stderr. */
const INPUT_ERROR = 2;

// Each step below returns its value, or `undefined` once it has put the input error on stderr.

function parsedOrUsage(argv: readonly string[], io: CliIo): ParsedArgs | undefined {
  try {
    return parseArgs(argv);
  } catch (e) {
    io.stderr(`${messageOf(e)}\n${USAGE}\n`);
    return undefined;
  }
}

/**
 * Checked, not cast: a file that parses but is not a NodeTypesFile is an input error, and
 * was a silent "no shapes" — every port count guessed, as if the flag had not been given.
 */
function readNodeTypes(parsed: ParsedArgs, io: CliIo): NodeTypesFile | undefined {
  if (parsed.nodeTypesFile === null) return {};
  try {
    return parseNodeTypesFile(JSON.parse(io.readFile(parsed.nodeTypesFile)));
  } catch (e) {
    io.stderr(`could not read --node-types ${parsed.nodeTypesFile}: ${messageOf(e)}\n`);
    return undefined;
  }
}

function readWorkflow(parsed: ParsedArgs, nodeTypes: NodeTypesFile, io: CliIo): WorkflowJsonResult | undefined {
  try {
    return parseWorkflowJson(io.readFile(parsed.file), {
      nodeTypes,
      ...(parsed.startNode === undefined ? {} : { startNode: parsed.startNode }),
      ...(parsed.options.profile === undefined ? {} : { profile: parsed.options.profile }),
    });
  } catch (e) {
    io.stderr(`${parsed.file}: ${messageOf(e)}\n`);
    return undefined;
  }
}

/** The line streamed to stderr as each check completes. */
const progressLine = (check: PropertyCheck): string =>
  `  ${check.verdict.padEnd(8)} ${check.property} / ${renderSubject(check.subject)} ` +
  `(${(check.elapsedMs / 1000).toFixed(1)}s)\n`;

/**
 * The guessed shapes go into the report as well as onto stderr: they change which net was
 * verified, and a stored --json report has to say so on its own (ADR 0007 §8).
 */
function verifyOptionsFor(parsed: ParsedArgs, workflow: WorkflowJsonResult, io: CliIo): VerifyOptions {
  const base: VerifyOptions = { ...parsed.options, shapeWarnings: workflow.warnings };
  return parsed.quiet ? base : { ...base, onCheck: (check) => io.stderr(progressLine(check)) };
}

/**
 * What `verify()` throws is an input error — the compiler refusing the workflow, a policy
 * that names an output the node lacks — and is reported like one. A programming error
 * (`TypeError`, `ReferenceError`) is neither, and reporting it as exit 2 dropped the stack
 * the one person who can fix it needs; it propagates, and `main.ts` prints the stack of a
 * rejected run.
 */
async function verified(
  parsed: ParsedArgs, workflow: WorkflowJsonResult, io: CliIo,
): Promise<VerificationReport | undefined> {
  const options = verifyOptionsFor(parsed, workflow, io);
  try {
    return await verify(workflow.description, options);
  } catch (e) {
    rethrowIfBug(e);
    io.stderr(`${parsed.file}: ${messageOf(e)}\n`);
    return undefined;
  }
}

function writeReport(parsed: ParsedArgs, report: VerificationReport, io: CliIo): void {
  const text = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`;
  if (parsed.out !== null) io.writeFile(parsed.out, text);
  else io.stdout(text);
}

/** Runs the command line against `io`; resolves to the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parsedOrUsage(argv, io);
  if (parsed === undefined) return INPUT_ERROR;
  const nodeTypes = readNodeTypes(parsed, io);
  if (nodeTypes === undefined) return INPUT_ERROR;
  const workflow = readWorkflow(parsed, nodeTypes, io);
  if (workflow === undefined) return INPUT_ERROR;
  for (const w of workflow.warnings) io.stderr(`warning: ${w}\n`);

  const report = await verified(parsed, workflow, io);
  if (report === undefined) return INPUT_ERROR;
  writeReport(parsed, report, io);
  return exitCodeOf(report, parsed.strict, io);
}
