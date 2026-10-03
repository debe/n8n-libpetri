/**
 * What one settlement costs the net-backed `SettlementPolicy` (`tasks/v2-seam-plan.md` step 6),
 * cold and warm, on the corpus graphs, beside n8n's own `defaultSettlementPolicy` from the patched
 * `dist` on the same in-memory reader. CPU only: no store, no Postgres, no round trip. It is not
 * F4: F4 is measured live under the testbed (steps 11 and 12) against n8n's handler p95. A number
 * here is an offline cost, not a conformance number and not an integration result (decision 12).
 *
 * Settlements are the reached (S, s) of the reference loop (`simulate`, `onSettled`) with n8n's own
 * settlement code injected, as in `tasks/v2-differential.mts`. Each settlement gets a fresh copy of
 * the graph, as `loadExecution` gives the handler one, so the policy's key hash is paid every time.
 *
 * - **cold**: the first call on a graph with an empty compile memo: hash, stage 1, compile, snapshot,
 *   decode, plan. Per graph.
 * - **warm**: every settlement after, memo hit: `decideSuccessors(s)` then `isFinished`, the two
 *   calls the handler makes when the settlement queues nothing (an upper bound when it queues).
 * - **agreement** (information): on S without a failed row, ours equals n8n's default per settlement
 *   (ordered decisions, and `isFinished`); a failed S is the named race, counted.
 * - **long loop**: a Loop Over Items at batch size 1 at pass k (k = 1 … 10,000), rows built
 *   directly. The policy reads S's frontier (step 14), so its keys stay flat in k; the same policy
 *   with the full snapshot (`snapshot: 'full'`, the global decoder) is timed beside it, and its keys
 *   grow with k, which is what F4 watches live.
 *
 *   npx tsx tasks/v2-policy-cost.mts [--behaviours 4] [--orders 3] [--max-settlements 300] [--limit N] [--json out.json]
 *
 * Needs `.n8n/` at the pin with patches 0001–0004 applied and `@n8n/engine` built.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepKey, StepRow } from '../typescript/src/codec/v2/step-rows.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';
import { hash, simulate } from '../typescript/src/conformance/v2/reference.ts';
import type { ReferenceRow, SettlementReference } from '../typescript/src/conformance/v2/reference.ts';
import type { V2SettlementPolicy, V2SuccessorDecisions } from '../typescript/src/n8n/v2-host.ts';
import { compileGraph, createCompileCache, graphKey } from '../typescript/src/settlement/compile-cache.ts';
import { createSettlementPolicy } from '../typescript/src/settlement/policy.ts';
import { memoryReader } from '../typescript/tests/support/settlement-reader.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(root, '.n8n/packages/@n8n');
const need = `${pkg}/engine/dist/execution/settlement-policy.js`;
if (!existsSync(need)) throw new Error(`${need} missing: apply patches 0001–0004 (scripts/verify-patch.sh) and build @n8n/engine`);
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);

const { decideSuccessors, decisionKeys } = req(`${pkg}/engine/dist/execution/settlement.js`);
const { countExpectedSettledSteps } = req(`${pkg}/engine/dist/execution/completion.js`);
const { exitSourcesInto, isTerminalStep } = req(`${pkg}/engine/dist/execution/loop-ledger.js`);
const { stepKeyId } = req(`${pkg}/engine/dist/execution/execution.types.js`);
const { deriveLoops } = req(`${pkg}/engine/dist/graph/loops.js`);
const { validateExecutableGraph } = req(`${pkg}/engine/dist/graph/validate-executable-graph.js`);
const { findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds } = req(`${pkg}/engine/dist/graph/workflow-graph-queries.js`);
const { defaultSettlementPolicy } = req(need) as { defaultSettlementPolicy: V2SettlementPolicy };
const { V1WorkflowConverter } = req(`${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`);
const { isTriggerNodeType } = req('n8n-workflow');

const reference: SettlementReference = {
  decideSuccessors, decisionKeys, countExpectedSettledSteps, deriveLoops, isTerminalStep,
  exitSourcesInto, stepKeyId, findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds,
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BEHAVIOURS = Number(arg('behaviours', '4'));
const ORDERS = Number(arg('orders', '3'));
const MAX_SETTLEMENTS = Number(arg('max-settlements', '300'));
const LIMIT = Number(arg('limit', '100000'));
const JSON_OUT = arg('json', '');

// ---- stamp ----
const sha = (f: string) => createHash('sha256').update(readFileSync(resolve(pkg, f))).digest('hex').slice(0, 12);
const n8nVersion = JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string;
const libpetriVersion = JSON.parse(readFileSync(resolve(root, 'typescript/node_modules/libpetri/package.json'), 'utf8')).version as string;
const libpetriLinked = lstatSync(resolve(root, 'typescript/node_modules/libpetri')).isSymbolicLink();
const stamp = {
  n8n: n8nVersion, node: process.version, libpetri: `${libpetriVersion}${libpetriLinked ? ' (linked)' : ' (registry)'}`,
  dist: Object.fromEntries(['engine/dist/execution/settlement-policy.js', 'engine/dist/execution/settlement.js', 'engine/dist/execution/completion.js']
    .map((f) => [f, sha(f)])),
};

// ---- statistics ----
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? NaN, mean };
}
const us = (ms: number) => `${(ms * 1000).toFixed(0)} µs`;
const msText = (ms: number) => `${ms.toFixed(2)} ms`;
const line = (name: string, xs: number[], f: (x: number) => string) => {
  const s = stats(xs);
  return `${name.padEnd(44)} n=${String(s.n).padStart(6)}  p50 ${f(s.p50).padStart(9)}  p95 ${f(s.p95).padStart(9)}  p99 ${f(s.p99).padStart(9)}  max ${f(s.max).padStart(9)}  mean ${f(s.mean).padStart(9)}`;
};

const seq = (d: V2SuccessorDecisions) => `${d.toQueue.map((k) => `${k.nodeId}@${k.iteration}`).join(' ')}|${d.toSkip.map((k) => `${k.nodeId}@${k.iteration}`).join(' ')}`;

// ---- corpus ----
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);
const converter = new V1WorkflowConverter();

const t = {
  coldFirstCall: [] as number[], compile: [] as number[], hashFresh: [] as number[],
  warmDecide: [] as number[], warmFinished: [] as number[], warmSettlement: [] as number[],
  n8nDecide: [] as number[], n8nFinished: [] as number[], n8nSettlement: [] as number[],
  rows: [] as number[],
};
const count = {
  entries: 0, accepted: 0, graphs: 0, refused: 0, settlements: 0, maxReadsOurs: 0, maxReadsN8n: 0,
  decideCompared: 0, decideDisagree: 0, finishedCompared: 0, finishedDisagree: 0, races: 0, ourErrors: 0,
};
const findings: string[] = [];
const cache = createCompileCache({ maxEntries: 1024 });
const warm = createSettlementPolicy({ cache });

/** One timed call: the answer and the milliseconds it took. */
async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await f();
  return [v, performance.now() - t0];
}

for (const file of files) {
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const workflow = { id: basename(file, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
  let triggers: (string | undefined)[] = [undefined];
  try { converter.convert(workflow); } catch (e) {
    if ((e as Error).constructor.name === 'AmbiguousTriggerError') {
      triggers = (workflow.nodes as { name: string; type: string; disabled?: boolean }[]).filter((n) => !n.disabled && isTriggerNodeType(n.type)).map((n) => n.name);
    }
  }
  for (const fired of triggers) {
    count.entries++;
    let graph: V2Graph;
    try {
      graph = converter.convert(workflow, fired);
      validateExecutableGraph(graph);
    } catch {
      continue;
    }
    count.accepted++;
    const tag = `${basename(file)}${fired === undefined ? '' : ` [${fired}]`}`;

    // Stage costs on their own: the key hash of a fresh graph object, and stage 1 + compile.
    { const g = structuredClone(graph); const t0 = performance.now(); graphKey(g); t.hashFresh.push(performance.now() - t0); }
    try {
      const t0 = performance.now();
      compileGraph(graph);
      t.compile.push(performance.now() - t0);
    } catch (e) {
      count.refused++;
      findings.push(`${tag}: compile refusal: ${(e as Error).message}`);
      continue;
    }
    count.graphs++;

    // The reached (S, s) of the reference loop, with n8n's own settlement code.
    const settlements: { rows: readonly ReferenceRow[]; settled: StepKey }[] = [];
    for (let b = 0; b < BEHAVIOURS && settlements.length < MAX_SETTLEMENTS; b++) {
      const behaviour = { seed: hash(file, fired ?? '', 'behaviour', b), pFail: b % 4 === 0 ? 0.05 : 0, emptyTerminal: 0.25 };
      for (let o = 0; o < ORDERS && settlements.length < MAX_SETTLEMENTS; o++) {
        simulate(reference, graph, behaviour, o, { onSettled: (rows, settled) => { if (settlements.length < MAX_SETTLEMENTS) settlements.push({ rows, settled }); } });
      }
    }
    if (settlements.length === 0) continue;

    // Cold: a policy with an empty memo, its first call.
    {
      const first = settlements[0]!;
      const cold = createSettlementPolicy();
      const [, ms] = await timed(() => cold.decideSuccessors(structuredClone(graph), first.settled, memoryReader(first.rows)));
      t.coldFirstCall.push(ms);
    }
    // Prime the shared memo, untimed, so every timed call below is warm.
    cache.get(graph);

    for (const { rows, settled } of settlements) {
      count.settlements++;
      t.rows.push(rows.length);
      const g = structuredClone(graph); // what loadExecution hands the handler
      const failed = rows.some((r) => r.status === 'failed');
      let ours: V2SuccessorDecisions | null = null;
      let oursFinished: boolean | null = null;
      try {
        const rd = memoryReader(rows as StepRow[]);
        const [d, msD] = await timed(() => warm.decideSuccessors(g, settled, rd));
        const rf = memoryReader(rows as StepRow[]);
        const [f, msF] = await timed(() => warm.isFinished(g, rf));
        ours = d; oursFinished = f;
        t.warmDecide.push(msD); t.warmFinished.push(msF); t.warmSettlement.push(msD + msF);
        count.maxReadsOurs = Math.max(count.maxReadsOurs, rd.total(), rf.total());
      } catch (e) {
        count.ourErrors++;
        findings.push(`${tag}: our policy threw at ${settled.nodeId}@${settled.iteration}: ${(e as Error).message}`);
      }
      const nd = memoryReader(rows as StepRow[]);
      const [theirs, msD] = await timed(() => defaultSettlementPolicy.decideSuccessors(g, settled, nd));
      const nf = memoryReader(rows as StepRow[]);
      const [theirFinished, msF] = await timed(() => defaultSettlementPolicy.isFinished(g, nf));
      t.n8nDecide.push(msD); t.n8nFinished.push(msF); t.n8nSettlement.push(msD + msF);
      count.maxReadsN8n = Math.max(count.maxReadsN8n, nd.total(), nf.total());

      if (failed) { count.races++; continue; }
      if (ours !== null) {
        count.decideCompared++;
        if (seq(ours) !== seq(theirs)) {
          count.decideDisagree++;
          findings.push(`${tag}: decideSuccessors(${settled.nodeId}@${settled.iteration}) ours ${seq(ours)} n8n ${seq(theirs)}`);
        }
      }
      if (oursFinished !== null) {
        count.finishedCompared++;
        if (oursFinished !== theirFinished) {
          count.finishedDisagree++;
          findings.push(`${tag}: isFinished ours ${oursFinished} n8n ${theirFinished}`);
        }
      }
    }
  }
}

// ---- the long loop: Loop Over Items at batch size 1, pass k ----
const longLoop: V2Graph = {
  nodes: [
    { id: 'T', name: 'T', type: 'trigger', config: { nodeType: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} } },
    { id: 'B', name: 'Loop Over Items', type: 'batch', config: { batchSize: 1 } },
    { id: 'Body', name: 'Body', type: 'v1-node', config: { nodeType: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, continueOnFail: false } },
    { id: 'After', name: 'After', type: 'v1-node', config: { nodeType: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, continueOnFail: false } },
  ],
  edges: [
    { from: 'T', to: 'B', outputIndex: 0, inputIndex: 0 },
    { from: 'B', to: 'Body', outputIndex: 1, inputIndex: 0 },
    { from: 'Body', to: 'B', outputIndex: 0, inputIndex: 0, isBackEdge: true },
    { from: 'B', to: 'After', outputIndex: 0, inputIndex: 0 },
  ],
};
const loopRows = (k: number): StepRow[] => {
  const rows: StepRow[] = [{ nodeId: 'T', iteration: 0, status: 'completed', filledOutputSlots: [true] }];
  for (let i = 0; i <= k; i++) rows.push({ nodeId: 'B', iteration: i, status: 'completed', filledOutputSlots: [false, true] });
  for (let i = 0; i < k; i++) rows.push({ nodeId: 'Body', iteration: i, status: 'completed', filledOutputSlots: [true] });
  return rows;
};
/** `memoryReader(rows)`, also recording the most keys one keyed read asked for. */
const keyed = (rows: readonly StepRow[]) => {
  const inner = memoryReader(rows);
  let keys = 0;
  return {
    keys: () => keys,
    total: () => inner.total(),
    reader: {
      executionId: inner.executionId,
      loadLatestStepSummaries: inner.loadLatestStepSummaries.bind(inner),
      loadStepSummariesByKeys: (asked: StepKey[]) => { keys = Math.max(keys, asked.length); return inner.loadStepSummariesByKeys(asked); },
      countSettledSteps: inner.countSettledSteps.bind(inner),
    },
  };
};
const longLoopResults: {
  k: number; rows: number; reads: number; keys: number; fullKeys: number;
  ours: ReturnType<typeof stats>; full: ReturnType<typeof stats>; n8n: ReturnType<typeof stats>; agree: boolean;
}[] = [];
{
  const policy = createSettlementPolicy();
  const fullPolicy = createSettlementPolicy({ snapshot: 'full' });
  for (const k of [1, 10, 100, 300, 1000, 10_000]) {
    const rows = loopRows(k);
    const settled = { nodeId: 'B', iteration: k };
    const reps = k >= 10_000 ? 10 : k >= 300 ? 20 : 60;
    const ours: number[] = [];
    const full: number[] = [];
    const n8n: number[] = [];
    let reads = 0;
    let keys = 0;
    let fullKeys = 0;
    let agree = true;
    for (let r = 0; r < reps; r++) {
      const g = structuredClone(longLoop);
      const ro = keyed(rows);
      const [d, msD] = await timed(() => policy.decideSuccessors(g, settled, ro.reader));
      const rf = keyed(rows);
      const [f, msF] = await timed(() => policy.isFinished(g, rf.reader));
      ours.push(msD + msF);
      reads = Math.max(reads, ro.total(), rf.total());
      keys = Math.max(keys, ro.keys(), rf.keys());
      const fo = keyed(rows);
      const [fd, fmsD] = await timed(() => fullPolicy.decideSuccessors(g, settled, fo.reader));
      const [ff, fmsF] = await timed(() => fullPolicy.isFinished(g, memoryReader(rows)));
      full.push(fmsD + fmsF);
      fullKeys = Math.max(fullKeys, fo.keys());
      const [nd, nmsD] = await timed(() => defaultSettlementPolicy.decideSuccessors(g, settled, memoryReader(rows)));
      const [nfin, nmsF] = await timed(() => defaultSettlementPolicy.isFinished(g, memoryReader(rows)));
      n8n.push(nmsD + nmsF);
      if (seq(d) !== seq(nd) || f !== nfin || seq(fd) !== seq(nd) || ff !== nfin) agree = false;
    }
    // The first rep is cold for this k's row count only (the memo is warm from k = 1); drop it.
    longLoopResults.push({ k, rows: rows.length, reads, keys, fullKeys, ours: stats(ours.slice(1)), full: stats(full.slice(1)), n8n: stats(n8n.slice(1)), agree });
  }
}

// ---- report ----
console.log(`stamp: n8n ${stamp.n8n}, node ${stamp.node}, libpetri ${stamp.libpetri}`);
for (const [f, h] of Object.entries(stamp.dist)) console.log(`  ${f} ${h}`);
console.log(`corpus: ${files.length} files, ${count.entries} entries, ${count.accepted} accepted, ${count.graphs} compiled, ${count.refused} refused`);
console.log(`settlements: ${count.settlements} (≤ ${MAX_SETTLEMENTS} per graph; ${BEHAVIOURS} behaviours × ${ORDERS} orders), rows per S: ${JSON.stringify(stats(t.rows))}`);
console.log('\nper graph (CPU, in-memory reader):');
console.log(line('key hash of a fresh graph object', t.hashFresh, us));
console.log(line('stage 1 + compile (engineV2)', t.compile, msText));
console.log(line('cold first call (empty memo)', t.coldFirstCall, msText));
console.log('\nper settlement, warm (memo hit; fresh graph object each time):');
console.log(line('ours decideSuccessors', t.warmDecide, us));
console.log(line('ours isFinished', t.warmFinished, us));
console.log(line('ours decide + isFinished', t.warmSettlement, us));
console.log(line('n8n default decide + isFinished (same reader)', t.n8nSettlement, us));
console.log(`\nreader calls per policy call: ours ≤ ${count.maxReadsOurs}, n8n default ≤ ${count.maxReadsN8n}`);
console.log(`agreement (information; failed S are the named race): decideSuccessors ${count.decideCompared - count.decideDisagree}/${count.decideCompared}, isFinished ${count.finishedCompared - count.finishedDisagree}/${count.finishedCompared}, races ${count.races}, our throws ${count.ourErrors}`);
console.log('\nlong loop (Loop Over Items, batch size 1), settlement of B@k, decide + isFinished, warm:');
for (const r of longLoopResults) {
  console.log(`  k=${String(r.k).padStart(6)} rows ${String(r.rows).padStart(6)} reads ${r.reads} keys ${String(r.keys).padStart(2)} (full ${String(r.fullKeys).padStart(5)})  ours p50 ${msText(r.ours.p50).padStart(9)} p95 ${msText(r.ours.p95).padStart(9)}   full p50 ${msText(r.full.p50).padStart(9)} p95 ${msText(r.full.p95).padStart(9)}   n8n p50 ${msText(r.n8n.p50).padStart(9)} p95 ${msText(r.n8n.p95).padStart(9)}   ${r.agree ? 'agree' : 'DISAGREE'}`);
}
if (findings.length > 0) {
  console.log(`\nfindings (${findings.length}, first 30):`);
  for (const f of findings.slice(0, 30)) console.log(`  ${f}`);
}
if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, JSON.stringify({ stamp, count, stats: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stats(v)])), longLoop: longLoopResults, findings }, null, 2));
}
