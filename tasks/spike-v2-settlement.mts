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
 * The loop itself, the seeded outcomes and R(S) live in `typescript/src/conformance/v2/reference.ts`
 * (plan step 9, decision 15); this script injects n8n's functions into it. A step's outcome is a
 * pure function of (node, iteration, behaviour seed): completed with some output slots filled, or
 * failed. A batch node fills its loop slot for a seeded number of passes and then its done slot,
 * or, for a seeded quarter of (behaviour, batch node), nothing (`[null, null]`), as `runBatchStep`
 * does. The order is the free choice: at each step the next event is drawn at random from every
 * `step:ready` and `step:settled` message still pending. That is the nondeterminism concurrent
 * workers produce.
 *
 * Three properties, the ones `settlement.ts` claims for itself:
 *  1. termination: the loop drains;
 *  2. completion: a run with no failure ends `completed` by `countExpectedSettledSteps`, never
 *     drained-but-unfinished, and never with a queued step left behind;
 *  3. confluence ("any planner, at any time, recomputes the same decisions"): the same behaviour
 *     under different interleavings gives the same fate for every step.
 *
 *   npx tsx tasks/spike-v2-settlement.mts [--behaviours 20] [--orders 20] [--limit N]
 *                                          [--empty-terminal 0.25] [--baseline]
 *
 * Beyond the baseline, every reference state (row set) is also checked: at most one step of a node
 * in flight (the premise of folding loops, decision 6), and R(S) never both queues and skips one
 * key. `--baseline` turns off the `[null, null]` terminal and those checks, and prints the spike's
 * first report exactly (entries 310, accepted 209, runs 83,600, findings 0 at n8n@2.41.3).
 *
 * Needs `.n8n/` at the pin, built with `scripts/bootstrap-n8n.sh --scope=cli` (which builds
 * `@n8n/engine` and `@n8n/node-engine-compatibility`).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  referenceAnswer, simulate, hash,
  type ReferenceRow, type RunResult, type SettlementReference, type V2Loop,
} from '../typescript/src/conformance/v2/reference.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';

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

/** n8n's own settlement code, injected into the reference loop (decision 15). */
const reference: SettlementReference = {
  decideSuccessors, decisionKeys, countExpectedSettledSteps, deriveLoops, isTerminalStep,
  exitSourcesInto, stepKeyId, findTriggerNode, getDescendantNodeIds, getSuccessorNodeIds,
};

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BEHAVIOURS = Number(arg('behaviours', '20'));
const ORDERS = Number(arg('orders', '20'));
const LIMIT = Number(arg('limit', '100000'));
/** `--baseline`: the spike as first run, every loop ending with data, and only its report printed. */
const BASELINE = process.argv.includes('--baseline');
const EMPTY_TERMINAL = BASELINE ? 0 : Number(arg('empty-terminal', '0.25'));

// --- corpus ------------------------------------------------------------------------------------
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);

const converter = new V1WorkflowConverter();
const rejected = new Map<string, number>();
const findings: string[] = [];
let accepted = 0, runs = 0, withLoops = 0, entries = 0, toolAgents = 0;
// Beyond the baseline: the row sets the runs pass through, and what they contain.
let states = 0, runningStates = 0, cancelledStates = 0, emptyTerminalRuns = 0;

/**
 * Checks on one reference state, beyond the baseline. Both are about n8n's answer alone, never the
 * net's: at most one step of a node in flight (decision 6's premise for folding loops), and R(S)
 * does not both queue and skip one key.
 */
function checkState(graph: V2Graph, loops: readonly V2Loop[], rows: readonly ReferenceRow[], where: string): void {
  states++;
  if (rows.some((r) => r.status === 'running')) runningStates++;
  if (rows.some((r) => r.status === 'cancelled')) cancelledStates++;
  const inFlight = new Set<string>();
  for (const r of rows) {
    if (r.status !== 'queued' && r.status !== 'running') continue;
    if (inFlight.has(r.nodeId)) findings.push(`${where}: two steps of node ${r.nodeId} in flight`);
    inFlight.add(r.nodeId);
  }
  const answer = referenceAnswer(reference, graph, loops, rows);
  const queued = new Set(answer.toQueue.map((k) => stepKeyId(k)));
  for (const k of answer.toSkip) if (queued.has(stepKeyId(k))) findings.push(`${where}: R(S) both queues and skips ${stepKeyId(k)}`);
}
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
    let graph: V2Graph;
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
    const converted = graph;
    const loops: V2Loop[] = deriveLoops(converted);
    if (loops.length > 0) withLoops++;
    const batchIds = new Set(graph.nodes.filter((n) => n.type === 'batch').map((n) => n.id));
    const tag = `${basename(file)}${fired === undefined ? '' : ` [${fired}]`}`;
    for (let b = 0; b < BEHAVIOURS; b++) {
      const seed = hash(file, fired ?? '', 'behaviour', b);
      const pFail = b % 4 === 0 ? 0.05 : 0; // a quarter of the behaviours let a node fail
      const behaviour = { seed, pFail, emptyTerminal: EMPTY_TERMINAL };
      let first: RunResult | undefined;
      for (let o = 0; o < ORDERS; o++) {
        let r: RunResult;
        const where = `${tag} b${b} o${o}`;
        const options = BASELINE ? {} : { onState: (rows: readonly ReferenceRow[]) => checkState(converted, loops, rows, where) };
        try { r = simulate(reference, converted, behaviour, o, options); } catch (e) {
          findings.push(`${tag} behaviour ${b} order ${o}: threw ${(e as Error).message}`); break;
        }
        runs++;
        ends[r.end]++;
        if (r.rows.some((row) => batchIds.has(row.nodeId) && row.status === 'completed' && !row.filledOutputSlots.some(Boolean))) emptyTerminalRuns++;
        if (r.end === 'drained-unfinished') findings.push(`${tag} b${b} o${o}: drained unfinished, settled ${r.settled}, expected ${r.expected}`);
        if (r.end === 'completed' && r.leftQueued > 0) findings.push(`${tag} b${b} o${o}: completed with ${r.leftQueued} queued step(s)`);
        if (r.end === 'completed' && r.expected !== r.settled) findings.push(`${tag} b${b} o${o}: completed with settled ${r.settled} != expected ${r.expected}`);
        if (pFail === 0) {
          if (!first) first = r;
          else if (first.fates !== r.fates || first.end !== r.end) {
            findings.push(`${tag} b${b}: NOT CONFLUENT between order 0 and ${o}\n    ${first.end}: ${first.fates}\n    ${r.end}: ${r.fates}`);
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
if (!BASELINE) {
  console.log(`[null,null] terminal chance ${EMPTY_TERMINAL} per (behaviour, batch node): ${emptyTerminalRuns} runs with a loop that ended empty`);
  console.log(`reference states ${states}: ${runningStates} with a running row, ${cancelledStates} with a cancelled row`);
}
console.log(`findings ${findings.length}`);
for (const f of findings.slice(0, 30)) console.log(`  ${f}`);
