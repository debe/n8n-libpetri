/**
 * Exhaustive planner check for engine v2: every event order and every step outcome, not a sample.
 *
 * `tasks/v2-differential.mts` compares the engineV2 net's stateless planner with n8n's own
 * `decideSuccessors` on sampled interleavings. This script removes the sampling on small graphs.
 * It explores `StepSettledHandler`'s loop depth-first through every choice it can make:
 * - which pending `step:ready` or `step:settled` event goes next;
 * - every outcome of a running step: each filling of its output slots, failure, and for a batch
 *   node all three terminals (`[acc,null]`, `[null,null]`) plus failure, with loop passes capped;
 * - after a failure, queued rows are cancelled and running steps still settle, as in v2.
 * At every distinct row set it checks `planFromMarking(decodeStepRows(S))` against n8n's R(S), and
 * it checks that decoding the rows in reverse order gives the same plan. The reference is n8n's
 * compiled code, loaded from the pinned checkout's `dist`.
 *
 * Graphs: the committed golden's graphs, plus every corpus entry n8n accepts with at most
 * MAX_NODES nodes and output arity at most 3.
 *
 *   npx --prefix typescript tsx tasks/spike-v2-exhaustive.mts [maxPasses=3] [cap=300000] [maxNodes=9]
 *
 * Written by the adversarial review of plan steps 8-12 (tasks/v2-profile-plan.md). Checked for
 * sensitivity: dropping B's back start in a copy of the planner makes it report 70 disagreements.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { compile } = await import(`${root}/typescript/src/compiler/index.ts`);
const { graphToDescription } = await import(`${root}/typescript/src/conformance/v2/graph.ts`);
const { referenceAnswer } = await import(`${root}/typescript/src/conformance/v2/reference.ts`);
const { decodeStepRows } = await import(`${root}/typescript/src/codec/v2/step-rows.ts`);
const { planFromMarking } = await import(`${root}/typescript/src/codec/v2/plan.ts`);
const { planKeys } = await import(`${root}/typescript/src/conformance/v2/differential.ts`);
const pkg = resolve(root, '.n8n/packages/@n8n');
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);
const { decideSuccessors, decisionKeys } = req(`${pkg}/engine/dist/execution/settlement.js`);
const { countExpectedSettledSteps } = req(`${pkg}/engine/dist/execution/completion.js`);
const { exitSourcesInto, isTerminalStep } = req(`${pkg}/engine/dist/execution/loop-ledger.js`);
const { stepKeyId } = req(`${pkg}/engine/dist/execution/execution.types.js`);
const { deriveLoops } = req(`${pkg}/engine/dist/graph/loops.js`);
const { validateExecutableGraph } = req(`${pkg}/engine/dist/graph/validate-executable-graph.js`);
const { findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds } = req(`${pkg}/engine/dist/graph/workflow-graph-queries.js`);
const { V1WorkflowConverter } = req(`${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`);
const { isTriggerNodeType } = req('n8n-workflow');
const ref = { decideSuccessors, decisionKeys, countExpectedSettledSteps, deriveLoops, isTerminalStep, exitSourcesInto, stepKeyId, findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds };

const MAX_PASSES = Number(process.argv[2] ?? 3);
const CAP = Number(process.argv[3] ?? 300000);
const MAX_NODES = Number(process.argv[4] ?? 9);

type Row = { nodeId: string; iteration: number; id: string; status: string; filledOutputSlots: boolean[] };
interface St { rows: Row[]; settle: string[]; ready: string[] }
const kid = (r: { nodeId: string; iteration: number }) => stepKeyId({ nodeId: r.nodeId, iteration: r.iteration });
const canon = (s: St) => s.rows.map((r) => `${kid(r)}=${r.status}${r.filledOutputSlots.map(Number).join('')}`).sort().join(' ') + '|' + [...s.settle].sort().join(',') + '|' + [...s.ready].sort().join(',');
const keyStr = (p: any) => `Q{${p.toQueue.join(' ')}} S{${p.toSkip.join(' ')}}`;

function explore(tag: string, graph: any, total: any) {
  const compiled = compile(graphToDescription(graph).description, { profile: 'engineV2' });
  const loops = deriveLoops(graph);
  const trig = findTriggerNode(graph).id;
  const arity = new Map<string, number>();
  for (const n of graph.nodes) arity.set(n.id, 1);
  for (const e of graph.edges) arity.set(e.from, Math.max(arity.get(e.from)!, e.outputIndex + 1));
  const isBatch = new Set(graph.nodes.filter((n: any) => n.type === 'batch').map((n: any) => n.id));
  const outcomes = (nodeId: string, it: number): { status: string; filled: boolean[] }[] => {
    if (isBatch.has(nodeId)) {
      const o = [{ status: 'completed', filled: [true, false] }, { status: 'completed', filled: [false, false] }, { status: 'failed', filled: [] }];
      if (it < MAX_PASSES - 1) o.push({ status: 'completed', filled: [false, true] });
      return o;
    }
    const a = arity.get(nodeId)!;
    const o = [{ status: 'failed', filled: [] as boolean[] }];
    for (let m = 0; m < 1 << a; m++) o.push({ status: 'completed', filled: Array.from({ length: a }, (_, i) => Boolean(m & (1 << i))) });
    return o;
  };
  const init: St = { rows: [{ nodeId: trig, iteration: 0, id: '0', status: 'completed', filledOutputSlots: [true] }], settle: [kid({ nodeId: trig, iteration: 0 })], ready: [] };
  const seen = new Set<string>();
  const stack: St[] = [init];
  let states = 0, rowSets = new Set<string>(), nonEmpty = 0, dis = 0, truncated = false;
  const checked = new Set<string>();
  const check = (rows: Row[]) => {
    const rk = rows.map((r) => `${kid(r)}=${r.status}${r.filledOutputSlots.map(Number).join('')}`).sort().join(' ');
    if (checked.has(rk)) return; checked.add(rk);
    const R = keyStr(planKeys(referenceAnswer(ref, graph, loops, rows)));
    let P: string;
    try { P = keyStr(planKeys(planFromMarking(compiled, decodeStepRows(compiled, rows)))); }
    catch (e) { P = `THROW ${(e as Error).message}`; }
    let P2: string;
    try { P2 = keyStr(planKeys(planFromMarking(compiled, decodeStepRows(compiled, [...rows].reverse())))); } catch (e) { P2 = `THROW ${(e as Error).message}`; }
    if (R !== 'Q{} S{}') nonEmpty++;
    if (P !== R || P2 !== P) { dis++; if (total.examples.length < 15) total.examples.push(`${tag}: rows ${rk}\n   net ${P}\n   net(rev) ${P2}\n   R   ${R}`); }
  };
  while (stack.length > 0) {
    const s = stack.pop()!;
    const c = canon(s);
    if (seen.has(c)) continue;
    seen.add(c);
    if (++states > CAP) { truncated = true; break; }
    check(s.rows);
    const failed = s.rows.some((r) => r.status === 'failed');
    const byK = new Map(s.rows.map((r) => [kid(r), r]));
    const clone = (): St => ({ rows: s.rows.map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] })), settle: [...s.settle], ready: [...s.ready] });
    // ready events: claim, then outcome
    for (const k of s.ready) {
      const r = byK.get(k)!;
      const n = clone(); n.ready = n.ready.filter((x) => x !== k);
      if (r.status === 'queued') n.rows.find((x) => kid(x) === k)!.status = 'running';
      stack.push(n);
    }
    // running rows settle with every outcome
    for (const r of s.rows) {
      if (r.status !== 'running') continue;
      for (const o of outcomes(r.nodeId, r.iteration)) {
        const n = clone(); const x = n.rows.find((y) => kid(y) === kid(r))!;
        x.status = o.status; x.filledOutputSlots = o.status === 'completed' ? o.filled : [];
        n.settle.push(kid(r));
        stack.push(n);
      }
    }
    // settled events: the handler
    for (const k of s.settle) {
      const r = byK.get(k)!;
      const n = clone(); n.settle = n.settle.filter((x) => x !== k);
      if (r.status === 'failed' || failed) {
        for (const x of n.rows) if (x.status === 'queued') x.status = 'cancelled';
        n.ready = [];
        stack.push(n); continue;
      }
      if (r.status === 'completed' || r.status === 'skipped') {
        const steps: any = {}; for (const x of s.rows) steps[kid(x)] = x;
        const term = new Map<string, number>();
        for (const l of loops) {
          const bs = s.rows.filter((x) => x.nodeId === l.batchNodeId).sort((a, b) => b.iteration - a.iteration)[0];
          if (bs && isTerminalStep(bs)) term.set(l.batchNodeId, bs.iteration);
        }
        const d = decideSuccessors(graph, loops, { nodeId: r.nodeId, iteration: r.iteration }, steps, term);
        let id = n.rows.length;
        for (const q of d.toQueue) if (!n.rows.some((x) => kid(x) === kid(q))) { n.rows.push({ nodeId: q.nodeId, iteration: q.iteration, id: String(id++), status: 'queued', filledOutputSlots: [] }); n.ready.push(kid(q)); }
        for (const q of d.toSkip) if (!n.rows.some((x) => kid(x) === kid(q))) { n.rows.push({ nodeId: q.nodeId, iteration: q.iteration, id: String(id++), status: 'skipped', filledOutputSlots: [] }); n.settle.push(kid(q)); }
      }
      stack.push(n);
    }
  }
  total.graphs++; total.states += Math.min(states, CAP); total.rowSets += checked.size; total.nonEmpty += nonEmpty; total.dis += dis; if (truncated) total.truncated.push(tag);
  if (loops.length) total.loopGraphs++;
}

const total = { graphs: 0, loopGraphs: 0, states: 0, rowSets: 0, nonEmpty: 0, dis: 0, truncated: [] as string[], examples: [] as string[] };
const golden = JSON.parse(readFileSync(`${root}/typescript/tests/fixtures/v2/settlement-golden.json`, 'utf8'));
for (const e of golden.entries) if (e.graph.nodes.length <= MAX_NODES + 3) explore(e.id, e.graph, total);
const conv = new V1WorkflowConverter();
const files = readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f));
for (const file of files) {
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const workflow = { id: basename(file, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
  let triggers: (string | undefined)[] = [undefined];
  try { conv.convert(workflow); } catch (e) { if ((e as Error).constructor.name === 'AmbiguousTriggerError') triggers = workflow.nodes.filter((n: any) => !n.disabled && isTriggerNodeType(n.type)).map((n: any) => n.name); }
  for (const fired of triggers) {
    let graph: any;
    try { graph = conv.convert(workflow, fired); validateExecutableGraph(graph); } catch { continue; }
    const maxAr = Math.max(0, ...graph.edges.map((e: any) => e.outputIndex + 1));
    if (graph.nodes.length > MAX_NODES || maxAr > 3) continue;
    explore(basename(file) + (fired ? `[${fired}]` : ''), graph, total);
  }
}
console.log(JSON.stringify({ ...total, examples: undefined }, null, 1));
console.log(total.examples.join('\n'));
