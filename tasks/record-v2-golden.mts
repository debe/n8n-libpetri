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
 * Settlements (`tasks/v2-seam-plan.md` step 7, format 2): every (S, s) the same runs reach —
 * `StepSettledHandler` taking the `step:settled` of a completed or skipped step — with
 * `decideSuccessors(s)` in n8n's order and `countExpectedSettledSteps` and the finish test on the
 * rows the settlement leaves (`GoldenSettlement`). Distinct by (row set, s); at most
 * `--max-settlements` per entry are kept, stratified by kind as the states are. Recording adds
 * them and moves nothing format 1 held: the same runs, states and stamp.
 *
 * While recording, the net is checked too, with n8n's real functions: leg (a) on **every**
 * distinct state (kept or not), leg (b) on every recorded run, and the net-backed
 * `createSettlementPolicy` replayed on every distinct settlement through an in-memory reader
 * (`replaySettlement`: legs (a″) and (a‴), failed S counted as the named race). Where the build
 * carries patch 0003, n8n's own `defaultSettlementPolicy` from `dist` is replayed on every distinct
 * settlement too, races compared: it must give back exactly what was recorded, which checks the
 * recording against the seam itself. A disagreement is printed with a reproduction and makes the
 * exit code 1. The golden is still written, because its content is n8n's and does not depend on
 * the net: CI then fails on the same disagreement.
 *
 * The file is stamped (decision 16): `n8n@<version>`, the sha256 of the dist files that decide, and
 * the libpetri version (registry or linked). An existing golden with a different stamp is **not**
 * overwritten unless `--force`: a new n8n or libpetri is a decision to re-record, not a side effect.
 * A stamped file a committed seam patch changes (`GOLDEN_SEAM_PATCHED_DIST`) counts as its
 * recorded hash when its local hash is exactly the patched one (`unpatchedStamp`), so a build
 * with the patches records under n8n's stamp. With no golden to read that hash from (a fresh
 * `--out`), the committed golden's stamp is used; with neither, the recorder refuses.
 *
 *   npx tsx tasks/record-v2-golden.mts [--behaviours 12] [--orders 8] [--run-orders 2]
 *                                      [--max-states 60] [--max-settlements 60]
 *                                      [--empty-terminal 0.25] [--p-fail 0.2]
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
  decodeRows, encodeDecision, encodeKey, encodeRow, fatesOf, GOLDEN_FORMAT, GOLDEN_SEAM_PATCHED_DIST, GOLDEN_STAMPED_DIST,
  replaySettlement, selectStates, settlementKey, settlementRows, stampDifferences, stateKey, unpatchedStamp,
} from '../typescript/src/conformance/v2/golden.ts';
import type {
  GoldenEntry, GoldenParameters, GoldenRow, GoldenRun, GoldenSettlement, GoldenStamp, GoldenState, SettlementGolden,
} from '../typescript/src/conformance/v2/golden.ts';
import { graphToDescription } from '../typescript/src/conformance/v2/graph.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';
import { runV2 } from '../typescript/src/conformance/v2/net-run.ts';
import {
  handlerPlan, hash, reachableOf, referenceAnswer, settledCount, simulate,
} from '../typescript/src/conformance/v2/reference.ts';
import type { Behaviour, ReferenceRow, SettlementReference, V2Loop } from '../typescript/src/conformance/v2/reference.ts';
import type { V2SettlementPolicy } from '../typescript/src/n8n/v2-host.ts';
import { createSettlementPolicy } from '../typescript/src/settlement/policy.ts';
import { ACCEPTED, SETTLEMENT_SHAPES } from '../typescript/tests/fixtures/v2-graphs.ts';
import { memoryReader } from '../typescript/tests/support/settlement-reader.ts';

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
/** Patch 0003's `defaultSettlementPolicy`, when the build carries it: the seam's own answers. */
const seamFile = `${pkg}/engine/dist/execution/settlement-policy.js`;
const n8nPolicy: V2SettlementPolicy | null = existsSync(seamFile) ? req(seamFile).defaultSettlementPolicy : null;

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
  maxSettlementsPerEntry: Number(arg('max-settlements', '60')),
};

// ---- decision 16's stamp -----------------------------------------------------------------------
const STAMPED = GOLDEN_STAMPED_DIST;
const libpetriDir = resolve(root, 'typescript/node_modules/libpetri');
const localStamp: GoldenStamp = {
  n8n: `n8n@${JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string}`,
  dist: Object.fromEntries(STAMPED.map((f) => [f, createHash('sha256').update(readFileSync(resolve(pkg, f))).digest('hex')])),
  libpetri: {
    version: JSON.parse(readFileSync(resolve(libpetriDir, 'package.json'), 'utf8')).version as string,
    linked: lstatSync(libpetriDir).isSymbolicLink(),
  },
};

const COMMITTED = resolve(root, 'typescript/tests/fixtures/v2/settlement-golden.json');
const recordedStamp = (path: string): GoldenStamp => {
  const g = JSON.parse(readFileSync(path, 'utf8')) as { stamp?: GoldenStamp };
  if (g.stamp === undefined) throw new Error(`${relative(root, path)} has no stamp`);
  return g.stamp;
};
const stampBase = existsSync(OUT) ? OUT : existsSync(COMMITTED) ? COMMITTED : null;
const seamPatched = Object.entries(GOLDEN_SEAM_PATCHED_DIST).filter(([f, h]) => localStamp.dist[f] === h).map(([f]) => f);
if (seamPatched.length > 0 && stampBase === null) {
  console.error(`the build carries a seam patch (${seamPatched.join(', ')}) and there is no golden to read n8n's own hash from; record from an unpatched build`);
  process.exit(2);
}
const stamp: GoldenStamp = stampBase === null ? localStamp : unpatchedStamp(localStamp, recordedStamp(stampBase));
if (seamPatched.length > 0) {
  console.log(`seam-patched build: ${seamPatched.map((f) => `${basename(f)} ${localStamp.dist[f]!.slice(0, 12)}`).join(', ')} read as n8n's ${seamPatched.map((f) => stamp.dist[f]!.slice(0, 12)).join(', ')} (from ${relative(root, stampBase!)})`);
}

if (existsSync(OUT)) {
  // Only the stamp is read: an older format under the same stamp is upgraded in place, which adds
  // the newer format's fields and leaves the older ones as n8n's code gives them again.
  const oldFormat = (JSON.parse(readFileSync(OUT, 'utf8')) as { format?: unknown }).format;
  if (oldFormat !== GOLDEN_FORMAT) console.log(`${relative(root, OUT)} is format ${String(oldFormat)}; recording format ${GOLDEN_FORMAT}`);
  const diff = stampDifferences(recordedStamp(OUT), stamp);
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
/** The net-backed policy, one memo for the whole run, as a process would hold it. */
const policy = createSettlementPolicy();
const totals = {
  distinct: 0, kept: 0, compared: 0, decidedDisagree: 0, finishedDisagree: 0, races: 0, raceNonEmpty: 0, raceCountFinished: 0, n8nDisagree: 0,
};
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
  const reachable = reachableOf(reference, graph);
  /** Distinct (S, s), in the order first reached; the record is built from n8n's code here. */
  const reached = new Map<string, GoldenSettlement>();
  let settlementsReported = 0;

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
        onSettled: (rows, settled) => {
          settlementsReported++;
          const encoded = rows.map((r) => encodeRow(graph, r));
          const at = encodeKey(graph, settled);
          const key = settlementKey({ rows: encoded, settled: at });
          if (reached.has(key)) return;
          // What planSuccessors decides, with no failure check, in n8n's order; then the finish
          // test on the rows the settlement leaves (S′, as `settlementRows` defines it).
          const decided = encodeDecision(graph, handlerPlan(reference, graph, loops, rows, settled));
          const { after } = settlementRows(graph, { rows: encoded, decided });
          const { settled: count, expected } = settledCount(reference, loops, reachable, after);
          reached.set(key, {
            rows: encoded, settled: at, decided, expected: expected ?? null,
            finished: expected !== undefined && count >= expected,
          });
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

  // Settlements: our policy (legs (a″), (a‴)) and n8n's seam policy on every distinct one, kept or not.
  const allSettlements = [...reached.values()];
  const settlementKind = (x: GoldenSettlement): string => [
    x.rows.some((r) => r[2] === 'failed') ? 'race' : '',
    x.finished ? 'finished' : '',
    x.expected === null ? 'loop-running' : '',
    x.decided.toQueue.length >= 2 || x.decided.toSkip.length >= 2 ? 'order' : '',
    x.decided.toSkip.length > 0 ? 'skip' : '',
    x.decided.toQueue.length + x.decided.toSkip.length === 0 ? 'nothing' : '',
    x.settled[1] > 0 ? 'later-pass' : '',
  ].filter(Boolean).join('+') || 'plain';
  const legs = { compared: 0, decidedDisagree: 0, finishedDisagree: 0, races: 0, raceNonEmpty: 0, raceCountFinished: 0, n8nDisagree: 0 };
  const reader = (rows: readonly ReferenceRow[]) => memoryReader(rows, { executionId: src.id });
  for (const x of allSettlements) {
    const ours = await replaySettlement(policy, graph, x, reader);
    if (ours.race) {
      legs.races++;
      if (ours.theirs.decided.toQueue.length + ours.theirs.decided.toSkip.length > 0) legs.raceNonEmpty++;
      if (x.finished) legs.raceCountFinished++;
      // Decision 8 and decision 7 as amended: on a failed S the policy decides nothing and is not finished.
      const empty = ours.ours.decided !== null && ours.ours.decided.toQueue.length + ours.ours.decided.toSkip.length === 0;
      if (!empty || ours.ours.finished !== false) {
        findings.push(`${src.id} (race): policy on a failed S decided ${JSON.stringify(ours.ours.decided)}, finished ${ours.ours.finished}; ${ours.problems.join('; ')}\n      rows ${rowsText(decodeRows(graph, x.rows))}`);
      }
    } else {
      legs.compared++;
      if (ours.decided === false) legs.decidedDisagree++;
      if (ours.finished === false) legs.finishedDisagree++;
    }
    if (ours.decided === false || ours.finished === false) {
      findings.push(`${src.id} (a″/a‴) s=${x.settled.join('@')}: ${ours.problems.join('; ')}\n      rows ${rowsText(decodeRows(graph, x.rows))}`);
    }
    if (n8nPolicy !== null) {
      const seam = await replaySettlement(n8nPolicy, graph, x, reader, { races: 'compare' });
      if (seam.decided !== true || seam.finished !== true) {
        legs.n8nDisagree++;
        findings.push(`${src.id} (seam) s=${x.settled.join('@')}: n8n's defaultSettlementPolicy is not the recording: ${seam.problems.join('; ')}\n      rows ${rowsText(decodeRows(graph, x.rows))}`);
      }
    }
  }
  const settlementKinds = new Map(allSettlements.map((x) => [x, settlementKind(x)]));
  const settlements = selectStates(allSettlements, parameters.maxSettlementsPerEntry, (x) => settlementKinds.get(x)!);
  const settlementCounts = {
    reported: settlementsReported, distinct: allSettlements.length, kept: settlements.length, dropped: allSettlements.length - settlements.length,
  };
  for (const [k, v] of Object.entries(legs)) totals[k as keyof typeof totals] += v;
  totals.distinct += allSettlements.length;
  totals.kept += settlements.length;

  entries.push({
    id: src.id, source: src.source, trigger: src.trigger, graph, behaviours, runs, states, stateCounts, settlements, settlementCounts,
  });
  console.log(`${src.id}: ${graph.nodes.length} nodes, ${loops.length} loop(s); states reported ${reported}, distinct ${all.length}, kept ${states.length}, dropped ${stateCounts.dropped}; runs ${runs.length} (${runs.filter((r) => r.end === 'failed').length} failed); leg (a) disagreements ${stateDisagreements}`);
  if (stateCounts.dropped > 0) console.log(`    kept by kind: ${byKind(states)}; distinct by kind: ${byKind(all)}`);
  console.log(`    settlements reported ${settlementsReported}, distinct ${allSettlements.length}, kept ${settlements.length}; compared ${legs.compared} (decide disagreements ${legs.decidedDisagree}, finish ${legs.finishedDisagree}); races ${legs.races} (non-empty ${legs.raceNonEmpty}, count says finished ${legs.raceCountFinished})${n8nPolicy === null ? '' : `; seam policy disagreements ${legs.n8nDisagree}`}`);
}

// ---- write -------------------------------------------------------------------------------------
const golden: SettlementGolden = { format: GOLDEN_FORMAT, stamp, parameters, skipped, entries };

/**
 * JSON with one node, edge, behaviour, run or state per line: small enough to review in a diff,
 * without a line per boolean.
 */
const ONE_PER_LINE = new Set(['nodes', 'edges', 'behaviours', 'runs', 'states', 'settlements', 'skipped']);
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
console.log(`settlements: distinct ${totals.distinct}, kept ${totals.kept}; our policy compared on ${totals.compared} failure-free S: decideSuccessors disagreements ${totals.decidedDisagree}, isFinished disagreements ${totals.finishedDisagree}; failed S (named race, not compared) ${totals.races}, of which n8n's raw decision non-empty ${totals.raceNonEmpty} and its count test finished ${totals.raceCountFinished}`);
console.log(n8nPolicy === null
  ? 'seam policy: the build has no patch 0003 (engine/dist/execution/settlement-policy.js); the recording was not replayed through it'
  : `seam policy: n8n's defaultSettlementPolicy (dist) replayed on ${totals.distinct} settlements, races compared: ${totals.n8nDisagree} disagreements`);
console.log(`wrote ${relative(root, OUT)} (${(text.length / 1024).toFixed(1)} KiB)${previous === null ? '' : previous === text ? ', unchanged' : ', changed'}`);
console.log(`findings ${findings.length}`);
for (const f of findings) console.log(`  ${f}`);
process.exitCode = findings.length > 0 ? 1 : 0;
