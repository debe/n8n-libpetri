/**
 * The measurement behind the M5 half of `docs/verification.md`: the **solver-free route**
 * (VER-010) against the SMT fallback, on the same nets. Not a vitest file (vitest picks up
 * `*.test.ts` only): run it, paste the tables.
 *
 * ```
 * npx tsx tests/verify/measure-graph.ts                    # the graph table only (no solver)
 * npx tsx tests/verify/measure-graph.ts --smt              # + the whole-net deadlockFree fallback
 * npx tsx tests/verify/measure-graph.ts --smt --timeout 60000
 * npx tsx tests/verify/measure-graph.ts --max-classes 50000
 * ```
 *
 * Four tables:
 *
 * 1. **proper completion, solver-free** — one state-class graph per workflow, the verdict it
 *    yields and what it cost. This is the headline claim of the milestone.
 * 2. **the iteration bound** — for the workflows whose graph cannot close because they have
 *    a cycle, the largest number of loop iterations the explored prefix closes, per class
 *    cap. That is what the `bounded` verdict quantifies over.
 * 3. **the SMT fallback** (`--smt`) — one whole-net `deadlockFree` query per workflow with
 *    the structural rest set declared as sinks (VER-002), which is the *only* SMT query the
 *    proper-completion family still makes and only where the graph truncated. It exists to
 *    answer one question honestly: does the fallback decide anything the graph could not?
 * 4. **the whole report** — every family, routed, end to end, so the per-family cost of the
 *    two routes is comparable.
 */
import { performance } from 'node:perf_hooks';
import { SmtVerifier, deadlockFree, z3Available } from 'libpetri/verification';
import type { Place } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import type { WorkflowDescription } from '../../src/compiler/index.js';
import {
  chooseBranch, diamond, fanOut, ifBothOutputs, linear, loopOverItems, multiProducer, switch20, userCycle,
} from '../fixtures/workflows.js';
import { REST_ROLES, markingStateOf, verify } from '../../src/verify/index.js';
import type { VerificationReport } from '../../src/verify/index.js';
import { generateChain, generateFanOut } from './support.js';

/** The fixtures the doc's table is about, in the order it prints them. */
const FIXTURES: ReadonlyArray<readonly [string, WorkflowDescription]> = [
  ['linear', linear],
  ['diamond', diamond],
  ['fanOut', fanOut],
  ['multiProducer', multiProducer],
  ['chooseBranch', chooseBranch],
  ['ifBothOutputs', ifBothOutputs],
  ['chain40', generateChain(40, 'chain-40')],
  ['wide8', generateFanOut(8, 'wide-8')],
  ['switch20', switch20],
  ['loopOverItems', loopOverItems],
];

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  const line = (row: readonly string[]): string => `| ${row.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [line(rows[0]!), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.slice(1).map(line)].join('\n');
}

function ms(value: number): string {
  return value < 1000 ? `${value.toFixed(0)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** The proper-completion verdict of one report, which is the whole-net check's. */
function completionVerdict(report: VerificationReport): string {
  const whole = report.checks.find((c) => c.property === 'proper-completion' && c.subject.kind === 'net');
  if (whole === undefined) return '-';
  if (whole.verdict === 'bounded') return `BOUNDED (k=${report.stateSpace.boundedCyclicRuns})`;
  return whole.verdict === 'unknown' && !report.stateSpace.complete ? 'TRUNCATED' : whole.verdict.toUpperCase();
}

/** What a violation left behind, in node terms, for the table's last column. */
function strandedSummary(report: VerificationReport): string {
  const whole = report.checks.find((c) => c.property === 'proper-completion' && c.subject.kind === 'net');
  const cex = whole?.counterexample;
  if (cex == null) return '';
  const rest = new Set(REST_ROLES);
  return cex.stuckMarking
    .filter((p) => p.role === null || !rest.has(p.role))
    .map((p) => `${p.place}${p.tokens === 1 ? '' : `x${p.tokens}`}`)
    .join(' + ');
}

async function smtFallback(
  workflow: WorkflowDescription, timeoutMs: number,
): Promise<{ verdict: string; ms: number; witness: string }> {
  const compiled = compile(workflow, { budget: 1 });
  const sinks: Place<unknown>[] = compiled.netMap.places
    .filter((p) => REST_ROLES.has(p.role)).map((p) => p.place);
  const started = performance.now();
  const result = await SmtVerifier.forNet(compiled.net)
    .initialMarking(markingStateOf(compiled.initialMarking(null)))
    .semiflowInvariants(true)
    .timeout(timeoutMs)
    .property(deadlockFree())
    .sinkPlaces(...sinks)
    .verify();
  const elapsed = performance.now() - started;
  const last = result.counterexampleTrace[result.counterexampleTrace.length - 1];
  const witness = result.verdict.type !== 'violated' || last === undefined
    ? ''
    : last.placesWithTokens().some((p) => /^_pause$|^_halt$|\/waiting$|\/stopped$/.test(p.name))
      ? 'a paused run (designed terminal)'
      : 'a stranding';
  return { verdict: result.verdict.type, ms: elapsed, witness };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const timeoutMs = Number(at('--timeout') ?? 30_000);
  const maxClassesArg = at('--max-classes');
  const maxClasses = maxClassesArg === undefined ? undefined : Number(maxClassesArg);
  const withSmt = argv.includes('--smt');

  const graphRows: string[][] = [
    ['workflow', 'nodes', 'classes', 'complete', 'quiescent', 'paused/halted', 'verdict', 'wall clock', 'peak RSS', 'stranded'],
  ];
  const cyclic: Array<readonly [string, WorkflowDescription]> = [];
  const reports = new Map<string, VerificationReport>();
  for (const [label, workflow] of FIXTURES) {
    // Peak RSS is measured because the class cap bounds the class *count* and only the
    // memory a class costs turns that into a memory bound — and a heap exhaustion aborts
    // the process rather than truncating (`state-class.ts` `effectiveMaxClasses`).
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    const report = await verify(workflow, {
      properties: ['proper-completion'],
      // Zero solver work in this table: the fallback only runs on a truncated graph, and
      // when it does its cost is the next table's subject rather than this one's.
      timeoutMs: 1,
      ...(maxClasses === undefined ? {} : { maxClasses }),
    });
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    reports.set(label, report);
    const space = report.stateSpace;
    graphRows.push([
      label, String(workflow.nodes.length), String(space.classes), space.complete ? 'yes' : `no (${space.truncation})`,
      String(space.quiescent), String(space.terminal), completionVerdict(report), ms(space.elapsedMs),
      `${(peak / 1e6).toFixed(0)} MB`, strandedSummary(report),
    ]);
    if (space.truncation === 'cycle') cyclic.push([label, workflow]);
    process.stderr.write(`${label}: ${completionVerdict(report)} ${space.classes} classes ${ms(space.elapsedMs)}\n`);
  }
  process.stdout.write(`### Proper completion, solver-free (VER-010)\n\n${table(graphRows)}\n\n`);

  // What the `bounded` verdict is worth on a cyclic workflow, per class cap: the iteration
  // prefix the graph closed, and what reaching it cost.
  if (cyclic.length > 0) {
    const boundRows: string[][] = [
      ['workflow', 'cap', 'classes', 'expanded', 'cyclic nodes', 'cyclic-node runs closed', 'complete passes', 'verdict', 'wall clock'],
    ];
    for (const [label, workflow] of [...cyclic, ['userCycle', userCycle] as const]) {
      for (const cap of [2_000, 20_000, 200_000]) {
        const report = await verify(workflow, {
          properties: ['proper-completion'], timeoutMs: 1, maxClasses: cap,
        });
        const space = report.stateSpace;
        const k = space.boundedCyclicRuns;
        boundRows.push([
          label, String(cap), String(space.classes), String(space.expanded), String(space.loopSteps),
          k === null ? '-' : String(k),
          k === null || space.loopSteps === 0 ? '-' : String(Math.floor(k / space.loopSteps)),
          completionVerdict(report), ms(space.elapsedMs),
        ]);
        process.stderr.write(`${label} cap=${cap}: k=${space.boundedCyclicRuns} ${completionVerdict(report)}\n`);
      }
    }
    process.stdout.write(
      '### The bound a cyclic workflow still gets (runs of its cyclic nodes, not passes of the loop)' +
      `\n\n${table(boundRows)}\n\n`);
  }

  if (withSmt) {
    if (!z3Available()) {
      process.stderr.write('no usable z3 (PATH or LIBPETRI_Z3): skipping the fallback table\n');
    } else {
      const smtRows: string[][] = [
        ['workflow', 'verdict', 'wall clock', 'witness', 'decided what the graph could not?', 'would a report ask it?'],
      ];
      for (const [label, workflow] of FIXTURES) {
        const r = await smtFallback(workflow, timeoutMs);
        const report = reports.get(label)!;
        const graphDecided = completionVerdict(report) !== 'TRUNCATED';
        // Since M5 the query is asked only where the graph neither closed nor refuted the
        // query itself: a reachable quiescent marking outside the sink set makes
        // `deadlockFree` false on that net, so its `proven` can never come back. Note that a
        // `bounded` row did *not* close — it is a truncated cyclic graph that still said
        // something — so the completeness flag, not the verdict, decides this column.
        const asked = report.checks.some((c) => c.property === 'proper-completion' && c.query.route === 'smt')
          ? 'yes'
          : report.stateSpace.complete ? 'no (the graph closed)' : 'no (the graph refuted it)';
        const useful = r.verdict === 'unknown' || r.witness !== 'a stranding'
          ? 'no'
          : graphDecided ? 'no (the graph decided it too)' : 'YES';
        smtRows.push([label, r.verdict, ms(r.ms), r.witness, useful, asked]);
        process.stderr.write(`${label}: deadlockFree -> ${r.verdict} in ${ms(r.ms)} ${r.witness}\n`);
      }
      process.stdout.write(
        `### The SMT fallback: one whole-net deadlockFree, rest set as sinks (timeout ${timeoutMs} ms)\n\n` +
        `${table(smtRows)}\n\n`);
    }
  }

  const familyRows: string[][] = [['workflow', 'checks', 'graph', 'z3', 'structural', 'proven', 'violated', 'bounded', 'unknown', 'wall clock']];
  for (const [label, workflow] of FIXTURES) {
    const started = performance.now();
    const report = await verify(workflow, {
      timeoutMs,
      ...(maxClasses === undefined ? {} : { maxClasses }),
    });
    const routes = { 'state-class-graph': 0, smt: 0, structural: 0, none: 0 };
    for (const c of report.checks) routes[c.query.route]++;
    familyRows.push([
      label, String(report.checks.length), String(routes['state-class-graph']), String(routes.smt),
      String(routes.structural), String(report.counts.proven), String(report.counts.violated),
      String(report.counts.bounded), String(report.counts.unknown), ms(performance.now() - started),
    ]);
    process.stderr.write(`${label}: ${report.checks.length} checks, ${report.counts.unknown} unknown\n`);
  }
  process.stdout.write(`### The whole report, every family (timeout ${timeoutMs} ms)\n\n${table(familyRows)}\n`);
}

await main();
