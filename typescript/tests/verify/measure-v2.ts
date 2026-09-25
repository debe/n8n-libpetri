/**
 * The measurement behind ADR 0012's hypothesis that `engineV2` nets are smaller and verify
 * faster than v1's (`tasks/v2-profile-plan.md` step 12). Not a vitest file (vitest picks up
 * `*.test.ts` only): run it, paste the table.
 *
 * ```
 * npx tsx tests/verify/measure-v2.ts                     # the table, 200 000-class cap
 * npx tsx tests/verify/measure-v2.ts --max-classes 50000
 * ```
 *
 * One row per **acyclic** workflow the `engineV2` analysis accepts: the fixtures of `ALL` it
 * does not refuse, plus the generated chain and fan-out the v1 tables use. Cyclic ones are left
 * out on purpose: a v1 loop's graph never closes (it gets `bounded`), and a folded v2 loop's
 * always does, so a class count there compares a truncation with a closure.
 *
 * Three nets per workflow, each explored with libpetri's state-class graph from its own
 * initial marking:
 *
 * - **v1 k=1**: the net `verify()` compiles by default, one node in flight;
 * - **v1 k=n**: the budget raised to the node count, so no node ever waits for a unit. That is
 *   the v1 net with engine v2's concurrency, which has no budget at all (decision 3);
 * - **engineV2**: `compile(…, { profile: 'engineV2' })`.
 *
 * The report columns time a whole `verify()` per net, v1 with `smtFallback: 'off'` so that no z3
 * run enters the comparison. A `+` after a class count means the graph truncated at the cap.
 */
import { performance } from 'node:perf_hooks';
import { StateClassGraph } from 'libpetri/verification';
import { CompileError, compile } from '../../src/compiler/index.js';
import type { CompileOptions, CompiledWorkflow, WorkflowDescription } from '../../src/compiler/index.js';
import { markingStateOf, verify } from '../../src/verify/index.js';
import type { VerifyOptions } from '../../src/verify/index.js';
import { ALL } from '../fixtures/workflows.js';
import { generateChain, generateFanOut } from './support.js';

const capArg = process.argv.indexOf('--max-classes');
const MAX_CLASSES = capArg >= 0 ? Number(process.argv[capArg + 1]) : 200_000;

interface Net {
  readonly places: number;
  readonly transitions: number;
  readonly classes: string;
  readonly graphMs: number;
  readonly reportMs: number;
}

function explore(c: CompiledWorkflow): { classes: string; ms: number } {
  const started = performance.now();
  const g = StateClassGraph.build(c.net, markingStateOf(c.initialMarking(null)), MAX_CLASSES);
  return { classes: `${g.size()}${g.isComplete() ? '' : '+'}`, ms: performance.now() - started };
}

async function measure(wf: WorkflowDescription, compileOptions: CompileOptions, verifyOptions: VerifyOptions): Promise<Net> {
  const c = compile(wf, compileOptions);
  const { classes, ms } = explore(c);
  const started = performance.now();
  await verify(wf, { ...verifyOptions, maxClasses: MAX_CLASSES });
  return {
    places: c.net.places.size,
    transitions: c.net.transitions.size,
    classes,
    graphMs: ms,
    reportMs: performance.now() - started,
  };
}

function subjects(): Array<readonly [string, WorkflowDescription]> {
  const out: Array<readonly [string, WorkflowDescription]> = [];
  for (const [name, wf] of Object.entries(ALL)) {
    if (compile(wf).analysis.hasCycle) continue;
    try {
      compile(wf, { profile: 'engineV2' });
    } catch (e) {
      if (e instanceof CompileError) {
        process.stderr.write(`skip ${name}: engineV2 refuses it (${e.code})\n`);
        continue;
      }
      throw e;
    }
    out.push([name, wf]);
  }
  out.push(['chain40', generateChain(40, 'chain-40')], ['wide8', generateFanOut(8, 'wide-8')]);
  return out;
}

const ms = (n: number): string => (n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(1)} s`);

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  return rows.map((row) => row.map((c, i) => c.padEnd(widths[i]!)).join(' | ')).join('\n');
}

const rows: string[][] = [[
  'workflow', 'nodes', 'v1 k=1 P/T', 'v1 k=1 classes', 'v1 k=n classes', 'v2 P/T', 'v2 classes',
  'v1 k=1 report', 'v1 k=n report', 'v2 report',
]];
for (const [name, wf] of subjects()) {
  const n = wf.nodes.length;
  const v1 = await measure(wf, { budget: 1 }, { budget: 1, smtFallback: 'off' });
  const v1n = await measure(wf, { budget: n }, { budget: n, smtFallback: 'off' });
  const v2 = await measure(wf, { profile: 'engineV2' }, { profile: 'engineV2' });
  rows.push([
    name, String(n), `${v1.places}/${v1.transitions}`, v1.classes, v1n.classes, `${v2.places}/${v2.transitions}`,
    v2.classes, ms(v1.reportMs), ms(v1n.reportMs), ms(v2.reportMs),
  ]);
  process.stderr.write(`${name} done\n`);
}
process.stdout.write(`${table(rows)}\n`);
