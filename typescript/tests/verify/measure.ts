/**
 * The measurement behind the **SMT** half of `docs/verification.md` — the fallback route,
 * and the pipeline cost that is the reason it is only a fallback. The solver-free route has
 * its own harness, `measure-graph.ts`. Not a vitest file (vitest picks up `*.test.ts` only):
 * run it, paste the tables.
 *
 * ```
 * npx tsx tests/verify/measure.ts                 # 60 s per query, semiflows on and off
 * npx tsx tests/verify/measure.ts --timeout 10000 # a quicker sweep
 * npx tsx tests/verify/measure.ts --sizes small   # one size only
 * ```
 *
 * It measures **one representative query per property family per size**, not the whole
 * family: a family costs (queries × per-query cost), and the per-query cost is what varies
 * with the workflow. The family sizes are printed alongside so the product is readable.
 * Sampling is what keeps the sweep to minutes rather than hours — a 100-node workflow has
 * ~100 dead-node queries, and a query that does not close costs the full timeout.
 *
 * The **net size** table covers every size, including the ones no query runs on: compiling
 * and flattening are cheap at any size. The **query** table covers only the sizes named by
 * `--sizes` (default {@link FEASIBLE_SIZES}), because the pipeline's P-invariant and
 * semiflow enumeration exhausts the default V8 heap above ~25 nodes — before z3 is called
 * at all. Reproduce that with `--sizes 'large (49'` and watch it abort.
 */
import { performance } from 'node:perf_hooks';
import {
  MarkingState, SmtVerifier, deadlockFree, flatten, mutualExclusion, placeBound, unreachable,
  z3Available, type SmtProperty,
} from 'libpetri/verification';
import type { Place, Token } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow, WorkflowDescription } from '../../src/compiler/index.js';
import { diamond, multiProducer } from '../fixtures/workflows.js';
import { HALT_REST_ROLES, PAUSE_REST_ROLES, REST_ROLES } from '../../src/verify/index.js';
import type { PlaceRole } from '../../src/compiler/types.js';
import { generateWorkflow, liveSampleNode, orphanBranch } from './support.js';

interface Sample {
  readonly family: string;
  readonly what: string;
  /** How many queries the family runs on this workflow. */
  readonly familySize: number;
  readonly property: SmtProperty;
  readonly sinks: readonly Place<unknown>[];
  readonly conditionalSinks: readonly { readonly marker: Place<unknown>; readonly places: readonly Place<unknown>[] }[];
}

/**
 * The sizes measured by default. Above ~25 nodes the P-invariant / semiflow enumeration
 * exhausts the default V8 heap before any query runs, so a sweep that included them would
 * abort rather than report; name one explicitly with `--sizes` to see that happen.
 */
const FEASIBLE_SIZES: readonly string[] = ['small', 'orphan', 'or (', 'medium'];

interface Row {
  readonly size: string;
  readonly semiflows: boolean;
  readonly family: string;
  readonly what: string;
  readonly familySize: number;
  readonly verdict: string;
  readonly ms: number;
}

function markingStateOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): MarkingState {
  const builder = MarkingState.builder();
  for (const [place, tokens] of marking) builder.tokens(place, tokens.length);
  return builder.build();
}

/** One query per family: the cheapest shape and, where they differ, the expensive one too. */
function samplesFor(compiled: CompiledWorkflow): Sample[] {
  const map = compiled.netMap;
  // The fallback's sink declaration: every place where a token at quiescence is legitimate
  // residue (`state-class.ts` REST_ROLES), which is the VER-002 shape of workflow-net proper
  // completion. M4 declared only `_pause` and `_halted` and asked `joinedOrDeadLettered`,
  // which ignores sinks entirely (NU-040 AC4).
  const sinks = map.places.filter((p) => REST_ROLES.has(p.role)).map((p) => p.place);
  const nodes = map.nodes;
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  // A workflow with no unreachable node has no cheap `proven` case for this family, so the
  // sample falls back to the last node — which is the expensive `live` case, and is labelled
  // as such rather than pretending the workflow has a dead node.
  const deadNode = nodes.find((g) => !g.reachable);
  const dead = deadNode ?? last;
  // The `[live]` sample must be a node that really is live: the last node in canvas order is
  // not one on a workflow whose dead branch sits at the bottom of the canvas (`orphan`).
  const live = liveSampleNode(map) ?? last;
  const joinPlaces = compiled.joinReadyPlaces.flatMap((j) => j.places);
  const samples: Sample[] = [
    {
      family: 'budget', what: 'placeBound(_budget, k)', familySize: 1,
      property: placeBound(map.shared.budget, compiled.effectiveBudget), sinks: [], conditionalSinks: [],
    },
    {
      family: 'no-double-activation', what: `placeBound(${last.node}/running, 1)`, familySize: nodes.length,
      property: placeBound(last.running, 1), sinks: [], conditionalSinks: [],
    },
    {
      family: 'dead-nodes',
      what: `unreachable(${dead.node}/running) [${deadNode === undefined ? 'no dead node in this workflow; live' : 'dead'}]`,
      familySize: nodes.length,
      property: unreachable(new Set([dead.running])), sinks: [], conditionalSinks: [],
    },
    {
      family: 'dead-nodes', what: `unreachable(${live.node}/running) [live]`, familySize: nodes.length,
      property: unreachable(new Set([live.running])), sinks: [], conditionalSinks: [],
    },
    {
      family: 'mutual-exclusion', what: `mutualExclusion(${first.node}, ${last.node})`,
      familySize: (nodes.length * (nodes.length - 1)) / 2,
      property: mutualExclusion(first.running, last.running), sinks: [], conditionalSinks: [],
    },
  ];
  if (deadNode === undefined) samples.splice(2, 1);
  // One whole-net query, not one per place: that is the fallback's shape since M5, and the
  // `familySize: 1` is the point — M4's per-place form cost (places x timeout).
  const widened = (roles: ReadonlySet<PlaceRole>): Place<unknown>[] =>
    map.places.filter((p) => roles.has(p.role) && !REST_ROLES.has(p.role)).map((p) => p.place);
  samples.push({
    family: 'proper-completion', what: 'deadlockFree() [whole net, rest set as sinks, pause / halt widenings as conditional sinks]',
    familySize: 1, property: deadlockFree(), sinks,
    conditionalSinks: [
      { marker: map.shared.pause, places: widened(PAUSE_REST_ROLES) },
      { marker: map.shared.halt, places: widened(HALT_REST_ROLES) },
    ],
  });
  const joinPlace = joinPlaces[0];
  if (joinPlace !== undefined) {
    // The second, weaker question, and the one whose cost differs by form:
    // a join slot has capacity 1 and cannot be violated by construction (ADR 0003), an OR
    // round has capacity n and is the only form where divergence #8 could show up.
    const group = compiled.joinReadyPlaces.find((j) => j.places.includes(joinPlace))!;
    const input = map.node(group.node).inputs.find((i) => i.index === group.inputIndex);
    const capacity = input?.round ?? 1;
    samples.push({
      family: 'proper-completion',
      what: `placeBound(${joinPlace.name}, ${capacity}) [arrival bound, ${input?.round === null || input?.round === undefined ? 'join slot' : 'OR round'}]`,
      familySize: joinPlaces.length,
      property: placeBound(joinPlace, capacity), sinks: [], conditionalSinks: [],
    });
  }
  return samples;
}

async function run(
  compiled: CompiledWorkflow, sample: Sample, semiflows: boolean, timeoutMs: number,
): Promise<{ verdict: string; ms: number }> {
  const verifier = SmtVerifier.forNet(compiled.net)
    .initialMarking(markingStateOf(compiled.initialMarking(null)))
    .semiflowInvariants(semiflows)
    .timeout(timeoutMs)
    .property(sample.property);
  if (sample.sinks.length > 0) verifier.sinkPlaces(...sample.sinks);
  for (const c of sample.conditionalSinks) verifier.sinkPlacesWhen(c.marker, ...c.places);
  if (sample.property.type === 'deadlock-free') verifier.stateEquation(true);
  const started = performance.now();
  const result = await verifier.verify();
  return { verdict: result.verdict.type, ms: performance.now() - started };
}

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  const line = (row: readonly string[]) => `| ${row.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  const head = rows[0]!;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.slice(1).map(line)].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const timeoutIndex = argv.indexOf('--timeout');
  const timeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 60_000;
  const sizesIndex = argv.indexOf('--sizes');
  const wanted = sizesIndex >= 0 ? (argv[sizesIndex + 1] ?? '').split(',') : null;

  if (!z3Available()) {
    process.stderr.write('no usable z3 (PATH or LIBPETRI_Z3): nothing to measure\n');
    process.exitCode = 1;
    return;
  }

  const all: Array<readonly [string, WorkflowDescription]> = [
    ['small (6 nodes, one join)', diamond],
    ['orphan (4 nodes, two dead)', orphanBranch],
    ['or (4 nodes, one OR round)', multiProducer],
    ['medium (21 nodes, 5 joins)', generateWorkflow(5, 'generated-medium')],
    ['large (49 nodes, 12 joins)', generateWorkflow(12, 'generated-large')],
    ['huge (101 nodes, 25 joins)', generateWorkflow(25, 'generated-huge')],
  ];
  const selected = all.filter(([label]) =>
    wanted === null ? FEASIBLE_SIZES.some((f) => label.startsWith(f)) : wanted.some((w) => label.startsWith(w)));

  // Compiling and flattening are cheap at every size, so the size table covers all of them.
  const sizeRows: string[][] = [['workflow', 'nodes', 'places', 'transitions', 'flat transitions', 'compile ms', 'queried']];
  for (const [label, workflow] of all) {
    const t0 = performance.now();
    const compiled = compile(workflow, { budget: 1 });
    const compileMs = performance.now() - t0;
    const flat = flatten(compiled.net);
    sizeRows.push([
      label, String(compiled.netMap.nodes.length), String(compiled.net.places.size),
      String(compiled.net.transitions.size), String(flat.transitions.length),
      compileMs.toFixed(0), selected.some(([l]) => l === label) ? 'yes' : 'no',
    ]);
  }

  const rows: Row[] = [];
  const pipelineRows: string[][] = [['workflow', 'phases 1-3 (semiflows on)', 'phases 1-3 (semiflows off)']];
  for (const [label, workflow] of selected) {
    const compiled = compile(workflow, { budget: 1 });
    const pipeline: string[] = [label];
    // Phases 1-3 of the pipeline, with a 1 ms solver budget: what every query pays before z3.
    for (const semiflows of [true, false]) {
      const t1 = performance.now();
      await SmtVerifier.forNet(compiled.net)
        .initialMarking(markingStateOf(compiled.initialMarking(null)))
        .semiflowInvariants(semiflows)
        .timeout(1)
        .property(placeBound(compiled.netMap.shared.budget, compiled.effectiveBudget))
        .verify();
      pipeline.push(`${(performance.now() - t1).toFixed(0)} ms`);
    }
    pipelineRows.push(pipeline);

    for (const semiflows of [true, false]) {
      for (const sample of samplesFor(compiled)) {
        const { verdict, ms } = await run(compiled, sample, semiflows, timeoutMs);
        rows.push({ size: label, semiflows, family: sample.family, what: sample.what, familySize: sample.familySize, verdict, ms });
        process.stderr.write(
          `${label} | semiflows=${semiflows} | ${sample.what} -> ${verdict} in ${(ms / 1000).toFixed(1)}s\n`);
      }
    }
  }

  process.stdout.write(`### Net size\n\n${table(sizeRows)}\n\n`);
  process.stdout.write(`### Pipeline before z3 (flatten, structural pre-check, P-invariants)\n\n${table(pipelineRows)}\n\n`);
  const queryRows: string[][] = [['workflow', 'family', 'query', 'queries in the family', 'semiflows', 'verdict', 'wall clock']];
  for (const r of rows) {
    queryRows.push([
      r.size, r.family, r.what, String(r.familySize), r.semiflows ? 'on' : 'off', r.verdict,
      r.ms < 1000 ? `${r.ms.toFixed(0)} ms` : `${(r.ms / 1000).toFixed(1)} s`,
    ]);
  }
  process.stdout.write(`### Per-query wall clock (timeout ${timeoutMs} ms)\n\n${table(queryRows)}\n`);
}

await main();
