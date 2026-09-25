/**
 * Records the engine v2 settlement golden (`tasks/v2-profile-plan.md` step 11):
 * `typescript/tests/fixtures/v2/settlement-golden.json`, which
 * `typescript/tests/conformance/v2-planner-golden.test.ts` replays in CI with no `.n8n`.
 *
 * Everything recorded is n8n's own answer: its compiled settlement code from the pinned
 * checkout's `dist`, injected into the reference loop (`typescript/src/conformance/v2/reference.ts`,
 * decision 15) exactly as `tasks/v2-differential.mts` does. The golden's format is
 * `typescript/src/conformance/v2/golden.ts`.
 *
 * Corpus: **committed graphs only**, so CI replays what the repository holds.
 * - `scripts/testbed/workflows/*.json`, converted by n8n's `V1WorkflowConverter`, one entry per
 *   fireable trigger, kept when the converter and `validateExecutableGraph` accept it; a refusal is
 *   recorded under `skipped` with n8n's reason;
 * - the hand-written graphs of `typescript/tests/fixtures/v2-graphs.ts` (`SETTLEMENT_SHAPES` and
 *   `ACCEPTED`), each checked by n8n's `validateExecutableGraph` first.
 * The plan also names `node-engine-compatibility`'s `m1-acceptance` workflows. They live in n8n's
 * test suite inside `.n8n/`, not in this repository, so they are not a committed source here and
 * are not recorded.
 *
 * Per entry, `--behaviours` behaviours (every fourth with `--p-fail`, all with `--empty-terminal`) ×
 * `--orders` reference orders. Every distinct row set those runs report is a candidate state; at
 * most `--max-states` per entry are kept (`selectStates`, stratified by kind so failed, cancelled,
 * running and empty-terminal states survive), and what is dropped is printed. The runs of the first
 * `--run-orders` orders are recorded for the net to reproduce.
 *
 * While recording, the net is checked too, with n8n's real functions: leg (a) on **every**
 * distinct state (kept or not) and leg (b) on every recorded run. A disagreement is printed with a
 * reproduction and makes the exit code 1. The golden is still written, because its content is
 * n8n's and does not depend on the net: CI then fails on the same disagreement.
 *
 * The file is stamped (decision 16): `n8n@<version>`, the sha256 of the dist files that decide, and
 * the libpetri version (registry or linked). An existing golden with a different stamp is **not**
 * overwritten unless `--force`: a new n8n or libpetri is a decision to re-record, not a side effect.
 *
 *   npx tsx tasks/record-v2-golden.mts [--behaviours 12] [--orders 8] [--run-orders 2]
 *                                      [--max-states 60] [--empty-terminal 0.25] [--p-fail 0.2]
 *                                      [--force] [--out path]
 *
 * `--p-fail` defaults to 0.2, not the differential's 0.05: the golden has few runs, and failed and
 * cancelled row sets are the rarest states.
 *
 * Needs `.n8n/` at the pin, built with `scripts/bootstrap-n8n.sh --scope=cli`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../typescript/src/compiler/index.ts';
import type { CompiledWorkflow } from '../typescript/src/compiler/index.ts';
import { v2Actions } from '../typescript/src/conformance/v2/binder.ts';
import { compareLockstep, compareStateTo, planKeys } from '../typescript/src/conformance/v2/differential.ts';
import {
  asGolden, decodeRows, encodeRow, fatesOf, GOLDEN_FORMAT, selectStates, stampDifferences, stateKey,
} from '../typescript/src/conformance/v2/golden.ts';
import type {
  GoldenEntry, GoldenParameters, GoldenRow, GoldenRun, GoldenStamp, GoldenState, SettlementGolden,
} from '../typescript/src/conformance/v2/golden.ts';
import { graphToDescription } from '../typescript/src/conformance/v2/graph.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';
import { runV2 } from '../typescript/src/conformance/v2/net-run.ts';
import { hash, referenceAnswer, simulate } from '../typescript/src/conformance/v2/reference.ts';
import type { Behaviour, ReferenceRow, SettlementReference, V2Loop } from '../typescript/src/conformance/v2/reference.ts';
import { ACCEPTED, SETTLEMENT_SHAPES } from '../typescript/tests/fixtures/v2-graphs.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(root, '.n8n/packages/@n8n');
const need = `${pkg}/engine/dist/execution/settlement.js`;
if (!existsSync(need)) throw new Error(`${need} missing: run scripts/bootstrap-n8n.sh --scope=cli`);
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);

const { decideSuccessors, decisionKeys } = req(`${pkg}/engine/dist/execution/settlement.js`);
const { countExpectedSettledSteps } = req(`${pkg}/engine/dist/execution/completion.js`);
const { exitSourcesInto, isTerminalStep } = req(`${pkg}/engine/dist/execution/loop-ledger.js`);
const { stepKeyId } = req(`${pkg}/engine/dist/execution/execution.types.js`);
const { deriveLoops } = req(`${pkg}/engine/dist/graph/loops.js`);
const { validateExecutableGraph } = req(`${pkg}/engine/dist/graph/validate-executable-graph.js`);
const { findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds } =
  req(`${pkg}/engine/dist/graph/workflow-graph-queries.js`);
const { V1WorkflowConverter } = req(`${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`);
const { isTriggerNodeType } = req('n8n-workflow');

/** n8n's own settlement code, injected (decision 15). */
const reference: SettlementReference = {
  decideSuccessors, decisionKeys, countExpectedSettledSteps, deriveLoops, isTerminalStep,
  exitSourcesInto, stepKeyId, findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds,
};

// ---- options -----------------------------------------------------------------------------------
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const FORCE = process.argv.includes('--force');
const OUT = resolve(root, arg('out', 'typescript/tests/fixtures/v2/settlement-golden.json'));
const parameters: GoldenParameters = {
  behaviours: Number(arg('behaviours', '12')),
  orders: Number(arg('orders', '8')),
  runOrders: Number(arg('run-orders', '2')),
  emptyTerminal: Number(arg('empty-terminal', '0.25')),
  pFail: Number(arg('p-fail', '0.2')),
  pFailEvery: 4,
  maxStatesPerEntry: Number(arg('max-states', '60')),
};

// ---- decision 16's stamp -----------------------------------------------------------------------
const STAMPED = [
  'engine/dist/execution/settlement.js', 'engine/dist/execution/iteration-mapping.js', 'engine/dist/execution/completion.js',
  'engine/dist/execution/loop-ledger.js', 'engine/dist/graph/loops.js', 'node-engine-compatibility/dist/v1-workflow-converter.js',
];
const libpetriDir = resolve(root, 'typescript/node_modules/libpetri');
const stamp: GoldenStamp = {
  n8n: `n8n@${JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string}`,
  dist: Object.fromEntries(STAMPED.map((f) => [f, createHash('sha256').update(readFileSync(resolve(pkg, f))).digest('hex')])),
  libpetri: {
    version: JSON.parse(readFileSync(resolve(libpetriDir, 'package.json'), 'utf8')).version as string,
    linked: lstatSync(libpetriDir).isSymbolicLink(),
  },
};

if (existsSync(OUT)) {
  const old = asGolden(JSON.parse(readFileSync(OUT, 'utf8')));
  const diff = stampDifferences(old.stamp, stamp);
  if (diff.length > 0 && !FORCE) {
    console.error(`${relative(root, OUT)} was recorded under another stamp; not overwriting (pass --force to re-record):`);
    for (const d of diff) console.error(`  ${d}`);
    process.exit(2);
  }
  if (diff.length > 0) console.log(`--force: re-recording under a new stamp (${diff.join('; ')})`);
}

// ---- corpus ------------------------------------------------------------------------------------
interface Source { readonly id: string; readonly source: string; readonly trigger: string | null; readonly graph: V2Graph }
const sources: Source[] = [];
const skipped: { source: string; reason: string }[] = [];
const converter = new V1WorkflowConverter();

const testbed = resolve(root, 'scripts/testbed/workflows');
for (const f of readdirSync(testbed).filter((x) => x.endsWith('.json')).sort()) {
  const file = resolve(testbed, f);
  const source = relative(root, file);
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const workflow = { id: basename(f, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
  let triggers: (string | undefined)[] = [undefined];
  try { converter.convert(workflow); } catch (e) {
    if ((e as Error).constructor.name === 'AmbiguousTriggerError') {
      triggers = (workflow.nodes as { name: string; type: string; disabled?: boolean }[])
        .filter((n) => !n.disabled && isTriggerNodeType(n.type)).map((n) => n.name);
    }
  }
  for (const fired of triggers) {
    const at = fired === undefined ? source : `${source} [${fired}]`;
    try {
      const graph: V2Graph = converter.convert(workflow, fired);
      validateExecutableGraph(graph);
      sources.push({ id: `testbed/${f}${fired === undefined ? '' : `#${fired}`}`, source, trigger: fired ?? null, graph });
    } catch (e) {
      skipped.push({ source: at, reason: `${(e as Error).constructor.name}: ${(e as Error).message}` });
    }
  }
}
const fixtures = { ...SETTLEMENT_SHAPES, ...ACCEPTED };
for (const [name, graph] of Object.entries(fixtures)) {
  const source = `typescript/tests/fixtures/v2-graphs.ts#${name}`;
  try {
    validateExecutableGraph(graph);
    // A fixture is recorded as written: a structured clone drops nothing a JSON file can hold.
    sources.push({ id: `fixture/${name}`, source, trigger: null, graph: JSON.parse(JSON.stringify(graph)) as V2Graph });
  } catch (e) {
    skipped.push({ source, reason: `${(e as Error).constructor.name}: ${(e as Error).message}` });
  }
}

// ---- recording ---------------------------------------------------------------------------------
const findings: string[] = [];
const entries: GoldenEntry[] = [];
const rowsText = (rows: readonly ReferenceRow[]) =>
  rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}${r.status === 'completed' ? `[${r.filledOutputSlots.map(Number).join('')}]` : ''}`).join(' ');

for (const src of sources) {
  const { graph } = src;
  let compiled: CompiledWorkflow;
  try {
    compiled = compile(graphToDescription(graph).description, { profile: 'engineV2' });
  } catch (e) {
    // n8n accepts the graph, so a refusal here is a finding about the compiler, not a skip.
    findings.push(`${src.id}: compile error: ${(e as Error).message}`);
    continue;
  }
  const loops: V2Loop[] = deriveLoops(graph);
  const batchIds = new Set(graph.nodes.filter((n) => n.type === 'batch').map((n) => n.id));
  const behaviours: Behaviour[] = Array.from({ length: parameters.behaviours }, (_, b) => ({
    seed: hash(src.id, 'behaviour', b),
    pFail: b % parameters.pFailEvery === 0 ? parameters.pFail : 0,
    emptyTerminal: parameters.emptyTerminal,
  }));
  const distinct = new Map<string, { rows: GoldenRow[]; kind: string }>();
  let reported = 0;
  let stateDisagreements = 0;
  const runs: GoldenRun[] = [];

  for (let b = 0; b < behaviours.length; b++) {
    const behaviour = behaviours[b]!;
    for (let o = 0; o < parameters.orders; o++) {
      const run = simulate(reference, graph, behaviour, o, {
        onState: (rows) => {
          reported++;
          const encoded = rows.map((r) => encodeRow(graph, r));
          const key = stateKey(encoded);
          if (distinct.has(key)) return;
          const kind = [
            rows.some((r) => r.status === 'failed') ? 'failed' : '',
            rows.some((r) => r.status === 'cancelled') ? 'cancelled' : '',
            rows.some((r) => r.status === 'running') ? 'running' : '',
            rows.some((r) => batchIds.has(r.nodeId) && r.status === 'completed' && !r.filledOutputSlots.some(Boolean)) ? 'empty-terminal' : '',
          ].filter(Boolean).join('+') || 'plain';
          distinct.set(key, { rows: encoded, kind });
        },
      });
      if (o >= parameters.runOrders) continue;
      const netDelaySeed = hash(behaviour.seed, 'net-order', o);
      // The golden stores the rows, not the fate string: the two must say the same.
      if (fatesOf(graph, run.rows) !== run.fates) throw new Error(`${src.id} b${b} o${o}: fatesOf(rows) is not simulate's fates`);
      runs.push({
        behaviour: b, order: o, netDelaySeed, end: run.end, expected: run.expected ?? null,
        settled: run.settled, leftQueued: run.leftQueued, events: run.events, rows: run.rows.map((r) => encodeRow(graph, r)),
      });
      // Leg (b) now, with n8n's own countExpectedSettledSteps.
      const net = await runV2(compiled, v2Actions(graph, behaviour, netDelaySeed));
      const lock = compareLockstep(reference, graph, loops, compiled, run, net);
      if (!lock.agree) findings.push(`${src.id} b${b} o${o} (b): ${lock.problems.join('; ')}`);
    }
  }

  // R(S) for every distinct state, and leg (a) on all of them, kept or not.
  const all: GoldenState[] = [];
  const kinds: string[] = [];
  for (const { rows, kind } of distinct.values()) {
    const decoded = decodeRows(graph, rows);
    const plan = planKeys(referenceAnswer(reference, graph, loops, decoded));
    const v = compareStateTo(compiled, decoded, plan);
    if (!v.agree) {
      stateDisagreements++;
      findings.push(`${src.id} (a): ${v.error !== null ? `decode threw: ${v.error}` : `planner queue {${v.net!.toQueue.join(', ')}} skip {${v.net!.toSkip.join(', ')}}`}; R(S) queue {${plan.toQueue.join(', ')}} skip {${plan.toSkip.join(', ')}}\n      rows ${rowsText(decoded)}`);
    }
    all.push({ rows, plan });
    kinds.push(kind);
  }
  const kindOf = new Map(all.map((s, i) => [s, kinds[i]!]));
  const states = selectStates(all, parameters.maxStatesPerEntry, (s) => kindOf.get(s)!);
  const byKind = (list: readonly GoldenState[]) => {
    const m = new Map<string, number>();
    for (const s of list) m.set(kindOf.get(s)!, (m.get(kindOf.get(s)!) ?? 0) + 1);
    return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
  };
  const stateCounts = { reported, distinct: all.length, kept: states.length, dropped: all.length - states.length };
  entries.push({ id: src.id, source: src.source, trigger: src.trigger, graph, behaviours, runs, states, stateCounts });
  console.log(`${src.id}: ${graph.nodes.length} nodes, ${loops.length} loop(s); states reported ${reported}, distinct ${all.length}, kept ${states.length}, dropped ${stateCounts.dropped}; runs ${runs.length} (${runs.filter((r) => r.end === 'failed').length} failed); leg (a) disagreements ${stateDisagreements}`);
  if (stateCounts.dropped > 0) console.log(`    kept by kind: ${byKind(states)}; distinct by kind: ${byKind(all)}`);
}

// ---- write -------------------------------------------------------------------------------------
const golden: SettlementGolden = { format: GOLDEN_FORMAT, stamp, parameters, skipped, entries };

/**
 * JSON with one node, edge, behaviour, run or state per line: small enough to review in a diff,
 * without a line per boolean.
 */
const ONE_PER_LINE = new Set(['nodes', 'edges', 'behaviours', 'runs', 'states', 'skipped']);
function format(value: unknown, indent = '', key = ''): string {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || flat.length <= 110) return flat;
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    const item = ONE_PER_LINE.has(key) ? (v: unknown) => JSON.stringify(v) : (v: unknown) => format(v, next);
    return `[\n${value.map((v) => `${next}${item(v)}`).join(',\n')}\n${indent}]`;
  }
  const fields = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{\n${fields.map(([k, v]) => `${next}${JSON.stringify(k)}: ${format(v, next, k)}`).join(',\n')}\n${indent}}`;
}

const text = `${format(golden)}\n`;
const previous = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);

const totalStates = entries.reduce((n, e) => n + e.states.length, 0);
const totalDropped = entries.reduce((n, e) => n + e.stateCounts.dropped, 0);
const totalRuns = entries.reduce((n, e) => n + e.runs.length, 0);
console.log(`stamp: ${stamp.n8n}; ${STAMPED.map((f) => `${basename(f)} ${stamp.dist[f]!.slice(0, 12)}`).join(', ')}; libpetri ${stamp.libpetri.version}${stamp.libpetri.linked ? ' (LINKED checkout)' : ' (registry)'}`);
console.log(`parameters: ${JSON.stringify(parameters)}`);
console.log(`skipped ${skipped.length}:`);
for (const s of skipped) console.log(`  ${s.source}: ${s.reason}`);
console.log('not a committed source: the m1-acceptance workflows (n8n test suite, inside .n8n/)');
console.log(`entries ${entries.length}: states kept ${totalStates} (dropped ${totalDropped}), runs ${totalRuns}`);
console.log(`wrote ${relative(root, OUT)} (${(text.length / 1024).toFixed(1)} KiB)${previous === null ? '' : previous === text ? ', unchanged' : ', changed'}`);
console.log(`findings ${findings.length}`);
for (const f of findings) console.log(`  ${f}`);
process.exitCode = findings.length > 0 ? 1 : 0;
