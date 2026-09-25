/**
 * Engine v2's settlement rule, driven by n8n's own code: is it confluent, and does it finish?
 *
 * ADR 0012 §2 puts a differential against n8n's `decideSuccessors` before any compiler work. This
 * spike is its reference side. It runs the event loop `StepSettledHandler` runs
 * (`packages/@n8n/engine/src/execution/step-settled-handler.ts` at the pin), with no database and
 * no queue, over workflows converted by n8n's own `V1WorkflowConverter`. Everything that decides
 * is n8n's compiled code, loaded from the pinned checkout's `dist`:
 * `decideSuccessors`, `decisionKeys`, `countExpectedSettledSteps`, `deriveLoops`,
 * `exitSourcesInto`, `isTerminalStep`, `validateExecutableGraph`. What this file supplies is only
 * what the handler gets from its stores and queues: which step rows exist, and the order in which
 * events are handled.
 *
 * A step's outcome is a pure function of (node, iteration, behaviour seed): completed with some
 * output slots filled, or failed. A batch node fills its loop slot for a seeded number of passes
 * and then its done slot, as `runBatchStep` does. The order is the free choice: at each step the
 * next event is drawn at random from every `step:ready` and `step:settled` message still pending.
 * That is the nondeterminism concurrent workers produce.
 *
 * Three properties, the ones `settlement.ts` claims for itself:
 *  1. termination: the loop drains;
 *  2. completion: a run with no failure ends `completed` by `countExpectedSettledSteps`, never
 *     drained-but-unfinished, and never with a queued step left behind;
 *  3. confluence ("any planner, at any time, recomputes the same decisions"): the same behaviour
 *     under different interleavings gives the same fate for every step.
 *
 *   npx tsx tasks/spike-v2-settlement.mts [--behaviours 20] [--orders 20] [--limit N]
 *
 * Needs `.n8n/` at the pin, built with `scripts/bootstrap-n8n.sh --scope=cli` (which builds
 * `@n8n/engine` and `@n8n/node-engine-compatibility`).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// The predicate the converter itself uses to tell a trigger, from the n8n-workflow it resolves.
const { isTriggerNodeType } = req('n8n-workflow');

type Status = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled';
interface Key { nodeId: string; iteration: number }
interface Row extends Key { id: string; status: Status; filledOutputSlots: boolean[] }
interface Edge { from: string; to: string; outputIndex: number; inputIndex: number; isBackEdge?: boolean }
interface Node { id: string; name: string; type: string; config?: unknown }
interface Graph { nodes: Node[]; edges: Edge[] }
interface Loop { batchNodeId: string; memberIds: Set<string> }

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BEHAVIOURS = Number(arg('behaviours', '20'));
const ORDERS = Number(arg('orders', '20'));
const LIMIT = Number(arg('limit', '100000'));

/** FNV-1a, so behaviours are a pure function of their inputs. */
function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('\u0000')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}
/** n8n's own row key, because `decideSuccessors` looks rows up by it. */
const keyId = (k: Key): string => stepKeyId(k);

function outputArity(graph: Graph, nodeId: string): number {
  let n = 1;
  for (const e of graph.edges) if (e.from === nodeId) n = Math.max(n, e.outputIndex + 1);
  return n;
}

/** What one step does, fixed by the behaviour seed: the same in every interleaving. */
function outcome(graph: Graph, node: Node, iteration: number, seed: number, pFail: number):
  { status: 'completed' | 'failed'; filled: boolean[] } {
  if (node.type === 'batch') {
    const passes = 1 + (hash(seed, node.id, 'passes') % 3);
    return iteration < passes - 1
      ? { status: 'completed', filled: [false, true] }
      : { status: 'completed', filled: [true, false] };
  }
  const r = rng(hash(seed, node.id, iteration));
  if (r() < pFail) return { status: 'failed', filled: [] };
  const filled = Array.from({ length: outputArity(graph, node.id) }, () => r() < 0.7);
  return { status: 'completed', filled };
}

interface Result {
  end: 'completed' | 'failed' | 'drained-unfinished';
  fates: string;
  expected: number | undefined;
  settled: number;
  leftQueued: number;
  events: number;
}

function simulate(graph: Graph, seed: number, order: number, pFail: number): Result {
  const loops: Loop[] = deriveLoops(graph);
  const trigger: Node = findTriggerNode(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const reachable = new Set<string>([trigger.id, ...getDescendantNodeIds(graph, trigger.id)]);
  const rows = new Map<string, Row>();
  let nextId = 0;
  const create = (k: Key, status: Status, filled: boolean[] = []): Row | undefined => {
    const id = keyId(k);
    if (rows.has(id)) return undefined; // the unique key (execution, node, iteration)
    const row: Row = { ...k, id: String(nextId++), status, filledOutputSlots: filled };
    rows.set(id, row);
    return row;
  };
  // ExecutionStartHandler: the trigger settles at birth, with its captured output in slot 0.
  const pending: { kind: 'ready' | 'settled'; key: Key }[] = [];
  create({ nodeId: trigger.id, iteration: 0 }, 'completed', [true]);
  pending.push({ kind: 'settled', key: { nodeId: trigger.id, iteration: 0 } });

  const pick = rng(hash(seed, 'order', order));
  const latestTerminal = (batchIds: string[]) => {
    const m = new Map<string, number>();
    for (const b of batchIds) {
      let latest: Row | undefined;
      for (const r of rows.values()) if (r.nodeId === b && (!latest || r.iteration > latest.iteration)) latest = r;
      if (latest && isTerminalStep(latest)) m.set(b, latest.iteration);
    }
    return m;
  };
  let end: Result['end'] | undefined;
  let events = 0;

  while (pending.length > 0 && end === undefined) {
    if (++events > 20_000) throw new Error('no termination within 20000 events');
    const ev = pending.splice(Math.floor(pick() * pending.length), 1)[0]!;
    const row = rows.get(keyId(ev.key))!;
    if (ev.kind === 'ready') {
      // StepReadyHandler: claim, run, settle.
      if (row.status !== 'queued') continue;
      const o = outcome(graph, byId.get(row.nodeId)!, row.iteration, seed, pFail);
      row.status = o.status;
      row.filledOutputSlots = o.status === 'completed' ? o.filled : [];
      pending.push({ kind: 'settled', key: ev.key });
      continue;
    }
    // StepSettledHandler.handle
    if (row.status === 'failed') { end = 'failed'; break; }
    let queued = 0;
    if (row.status === 'completed' || row.status === 'skipped') {
      if ([...rows.values()].some((r) => r.status === 'failed')) { end = 'failed'; break; }
      const candidates = getSuccessorNodeIds(graph, row.nodeId);
      const terminalIterations = latestTerminal(exitSourcesInto(graph, loops, candidates));
      const keys: Key[] = decisionKeys(graph, loops, ev.key, terminalIterations);
      const steps: Record<string, Row> = {};
      for (const k of keys) { const r = rows.get(keyId(k)); if (r) steps[keyId(k)] = r; }
      const { toQueue, toSkip } = decideSuccessors(graph, loops, ev.key, steps, terminalIterations);
      for (const k of toQueue as Key[]) if (create(k, 'queued')) { queued++; pending.push({ kind: 'ready', key: k }); }
      for (const k of toSkip as Key[]) if (create(k, 'skipped')) pending.push({ kind: 'settled', key: k });
    }
    if (queued > 0) continue;
    // finishExecutionIfDone
    const terminalIterations = latestTerminal(loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId));
    const expected: number | undefined = countExpectedSettledSteps(loops, reachable, terminalIterations);
    if (expected === undefined) continue;
    const settled = [...rows.values()].filter((r) => ['completed', 'failed', 'skipped', 'cancelled'].includes(r.status)).length;
    if (settled >= expected) end = [...rows.values()].some((r) => r.status === 'failed') ? 'failed' : 'completed';
  }

  const all = [...rows.values()];
  const terminalIterations = latestTerminal(loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId));
  return {
    end: end ?? 'drained-unfinished',
    fates: all.map((r) => `${byId.get(r.nodeId)!.name}#${r.iteration}=${r.status}`).sort().join(' '),
    expected: countExpectedSettledSteps(loops, reachable, terminalIterations),
    settled: all.filter((r) => ['completed', 'failed', 'skipped', 'cancelled'].includes(r.status)).length,
    leftQueued: all.filter((r) => r.status === 'queued').length,
    events,
  };
}

// --- corpus ------------------------------------------------------------------------------------
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);

const converter = new V1WorkflowConverter();
const rejected = new Map<string, number>();
const findings: string[] = [];
let accepted = 0, runs = 0, withLoops = 0, entries = 0, toolAgents = 0;
const ends = { completed: 0, failed: 0, 'drained-unfinished': 0 };

/** A rejection by kind: node names, ids and counts stripped, so equal causes group together. */
const kindOf = (e: Error) => `${e.constructor.name}: ${String(e.message)
  .replace(/"[^"]*"|'[^']*'/g, '…').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<id>')
  .replace(/Node \S+ has/, 'Node <n> has').replace(/Edge .* leaves/, 'Edge <e> leaves')
  .replace(/Batch node .* has/, 'Batch node <b> has').replace(/\d+ triggers \(.*?\)/, 'N triggers').slice(0, 100)}`;

/** Does a node that the trigger reaches have tools? v2 accepts it and fails at the first tool call. */
function hasToolAgent(wf: { connections: Record<string, Record<string, unknown>> }): boolean {
  return Object.values(wf.connections ?? {}).some((byType) => 'ai_tool' in (byType ?? {}));
}

for (const file of files) {
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const workflow = { id: basename(file, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
  // One graph per trigger that can fire: the converter needs the fired trigger named when there
  // are several, and each yields a different rooted graph.
  let triggers: (string | undefined)[] = [undefined];
  try { converter.convert(workflow); } catch (e) {
    if ((e as Error).constructor.name === 'AmbiguousTriggerError') {
      triggers = (workflow.nodes as { name: string; type: string; disabled?: boolean }[])
        .filter((n) => !n.disabled && isTriggerNodeType(n.type))
        .map((n) => n.name);
    }
  }
  for (const fired of triggers) {
    entries++;
    let graph: Graph;
    try {
      graph = converter.convert(workflow, fired);
      validateExecutableGraph(graph);
    } catch (e) {
      const why = kindOf(e as Error);
      rejected.set(why, (rejected.get(why) ?? 0) + 1);
      continue;
    }
    accepted++;
    if (hasToolAgent(wf)) toolAgents++;
    if (deriveLoops(graph).length > 0) withLoops++;
    const tag = `${basename(file)}${fired === undefined ? '' : ` [${fired}]`}`;
    for (let b = 0; b < BEHAVIOURS; b++) {
      const seed = hash(file, fired ?? '', 'behaviour', b);
      const pFail = b % 4 === 0 ? 0.05 : 0; // a quarter of the behaviours let a node fail
      let reference: Result | undefined;
      for (let o = 0; o < ORDERS; o++) {
        let r: Result;
        try { r = simulate(graph, seed, o, pFail); } catch (e) {
          findings.push(`${tag} behaviour ${b} order ${o}: threw ${(e as Error).message}`); break;
        }
        runs++;
        ends[r.end]++;
        if (r.end === 'drained-unfinished') findings.push(`${tag} b${b} o${o}: drained unfinished, settled ${r.settled}, expected ${r.expected}`);
        if (r.end === 'completed' && r.leftQueued > 0) findings.push(`${tag} b${b} o${o}: completed with ${r.leftQueued} queued step(s)`);
        if (r.end === 'completed' && r.expected !== r.settled) findings.push(`${tag} b${b} o${o}: completed with settled ${r.settled} != expected ${r.expected}`);
        if (pFail === 0) {
          if (!reference) reference = r;
          else if (reference.fates !== r.fates || reference.end !== r.end) {
            findings.push(`${tag} b${b}: NOT CONFLUENT between order 0 and ${o}\n    ${reference.end}: ${reference.fates}\n    ${r.end}: ${r.fates}`);
            break;
          }
        }
      }
    }
  }
}

console.log(`workflows ${files.length}, (workflow, fired trigger) entries ${entries}`);
console.log(`accepted by the v2 converter + validator ${accepted}: ${withLoops} with a batch loop, ${toolAgents} in a workflow with an ai_tool connection (accepted; v2 fails the agent at its first tool call, EngineRequestNotSupportedError)`);
console.log(`rejected ${entries - accepted}:`);
for (const [why, n] of [...rejected].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);
console.log(`runs ${runs}: completed ${ends.completed}, failed ${ends.failed}, drained-unfinished ${ends['drained-unfinished']}`);
console.log(`findings ${findings.length}`);
for (const f of findings.slice(0, 30)) console.log(`  ${f}`);
