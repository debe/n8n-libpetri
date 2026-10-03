/**
 * The engine v2 differential (`tasks/v2-profile-plan.md` step 10; ADR 0012 §2's stop condition):
 * is the `engineV2` net's stateless planner n8n's own planner, on every row set n8n's loop reaches?
 *
 * n8n's side is its compiled settlement code from the pinned checkout's `dist`, injected into the
 * reference loop (`typescript/src/conformance/v2/reference.ts`, decision 15), exactly as
 * `tasks/spike-v2-settlement.mts` does. The net's side is the graph n8n's own
 * `V1WorkflowConverter` produced, compiled through stage 1 (`graphToDescription`, decision 10)
 * under `profile: 'engineV2'`. The corpus is the spike's: the 200 templates and the 11 testbed
 * workflows, one graph per fireable trigger (`isTriggerNodeType`), kept when the converter and
 * `validateExecutableGraph` accept it.
 *
 * Per entry, per behaviour b and order o (a behaviour fixes every step's outcome; an order fixes
 * the reference's event draws and the net's action delays):
 *  (a) state: at every row set S the reference run reports (`onState`),
 *      `planFromMarking(decodeStepRows(S))` equals R(S) = `referenceAnswer` (decision 13);
 *  (b) lockstep: the net run under the same behaviour (`v2Actions`, `runV2`) ends as the
 *      reference run did; failure-free the fates are the same multiset and the net settles
 *      `countExpectedSettledSteps` rows; with a failure, both agree on every step both decided;
 *  (c) firing: at every row-set point of the net run, the rows decode to the executor's marking and
 *      the planner equals libpetri's enabled starts and skips there (`StateClassGraph`).
 *  (a″) key-scoped decision (`tasks/v2-seam-plan.md` decisions 6 and 13): each time the reference's
 *      `StepSettledHandler` takes a completed or skipped step s at rows S (`onSettled`),
 *      `scopePlan(R(S), candidateKeys(s))` equals what the handler decides there — ∅ once a row
 *      has failed, `decideSuccessors(s)` loaded as `planSuccessors` loads it otherwise — as ordered
 *      queue and skip sequences. On a failed S a non-empty unguarded `decideSuccessors(s)` is
 *      F2's named race (a failure after `hasFailedSteps`), counted and not compared.
 *  (a‴) completion (decision 7 as amended after F3 fired at step 2): at every row set S the
 *      reference reports without a failed row, the net's `isFinished` (every row settled, R(S)
 *      empty) equals `countSettledSteps ≥ countExpectedSettledSteps`. A row set with a failed row
 *      is F3's named race (a failure between the planning read and `hasFailedSteps`): `isFinished`
 *      is false there, and it is counted, with how n8n's count test answered, not compared.
 *  (f) frontier (`tasks/v2-seam-plan.md` step 14): at every reported S and every reached (S, s),
 *      the frontier decode against the global decoder (`compareFrontier`): the marking and row
 *      counts from S's frontier alone, and the policy's `decideFromRows` / `finishedFromRows` on the
 *      frontier (plus s's row) against the same on S with the full snapshot. `--max-passes N` lets
 *      a batch node run up to N steps (default 3, every run from before), so the frontier is
 *      smaller than S.
 *
 * A disagreement is a finding: it is printed with a reproduction (entry, trigger, b, o and the
 * row set), never smoothed over. Results are settlement-level evidence, not conformance numbers
 * (decision 16).
 *
 *   npx tsx tasks/v2-differential.mts [--behaviours 20] [--orders 20] [--net-behaviours B]
 *                                     [--net-orders O] [--limit N] [--empty-terminal 0.25]
 *                                     [--wait 0] [--max-passes 3] [--json out.json]
 *
 * `--net-behaviours` / `--net-orders` (default: all) bound which (b, o) pairs also run the net for
 * legs (b) and (c); leg (a) runs on every pair.
 *
 * `--wait p` lets a step that completes suspend first with chance p (master's `waiting`,
 * `Behaviour.pWait`): it goes `waiting`, and a seeded resume completes it later with the outputs it
 * stored. The default 0 draws nothing and reproduces every run from before. Leg (b) also counts,
 * on every failed pair, the rows the reference cancelled (`cancelPendingSteps`), by the status they
 * had before (`queued` or `waiting`) and what the net did with the same step: the measurement of
 * `docs/divergences.md` row 31.
 *
 * Needs `.n8n/` at the pin, built with `scripts/bootstrap-n8n.sh --scope=cli`.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../typescript/src/compiler/index.ts';
import type { CompiledWorkflow } from '../typescript/src/compiler/index.ts';
import { v2Actions } from '../typescript/src/conformance/v2/binder.ts';
import { compareFinished, compareFrontier, compareLockstep, comparePoint, compareScoped, compareState, netPlanAt } from '../typescript/src/conformance/v2/differential.ts';
import type { PlanKeys, PlanSequence } from '../typescript/src/conformance/v2/differential.ts';
import { graphToDescription } from '../typescript/src/conformance/v2/graph.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';
import { GOLDEN_STAMPED_DIST } from '../typescript/src/conformance/v2/golden.ts';
import { runV2 } from '../typescript/src/conformance/v2/net-run.ts';
import { hash, reachableOf, simulate } from '../typescript/src/conformance/v2/reference.ts';
import type { ReferenceRow, RunResult, SettlementReference, V2Loop } from '../typescript/src/conformance/v2/reference.ts';
import type { StepRow } from '../typescript/src/codec/v2/step-rows.ts';

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

// Decision 16's stamp: the pin, the dist files that decide, and the libpetri the net ran on.
const STAMPED = GOLDEN_STAMPED_DIST;
const sha = (f: string) => createHash('sha256').update(readFileSync(resolve(pkg, f))).digest('hex').slice(0, 12);
const n8nVersion = JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string;
const libpetriPkg = resolve(root, 'typescript/node_modules/libpetri/package.json');
const libpetriVersion = JSON.parse(readFileSync(libpetriPkg, 'utf8')).version as string;
/** `scripts/link-libpetri.sh` makes `node_modules/libpetri` a symlink; a number from a linked tree is not a registry number. */
const libpetriLinked = lstatSync(resolve(root, 'typescript/node_modules/libpetri')).isSymbolicLink();

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BEHAVIOURS = Number(arg('behaviours', '20'));
const ORDERS = Number(arg('orders', '20'));
const NET_BEHAVIOURS = Number(arg('net-behaviours', String(BEHAVIOURS)));
const NET_ORDERS = Number(arg('net-orders', String(ORDERS)));
const LIMIT = Number(arg('limit', '100000'));
const EMPTY_TERMINAL = Number(arg('empty-terminal', '0.25'));
const P_WAIT = Number(arg('wait', '0'));
const MAX_PASSES = Number(arg('max-passes', '3'));
const JSON_OUT = arg('json', '');

// --- corpus, as the spike reads it ----------------------------------------------------------------
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);

const converter = new V1WorkflowConverter();

interface Finding {
  readonly leg: 'a' | 'b' | 'c' | 'a″' | 'a‴' | 'f';
  readonly entry: string;
  readonly behaviour: number;
  readonly order: number;
  readonly detail: string;
  readonly rows?: readonly (StepRow | ReferenceRow)[];
}
const findings: Finding[] = [];
const count = {
  workflows: files.length, entries: 0, accepted: 0, compiled: 0, compileErrors: 0, loopEntries: 0,
  // leg (a)
  states: 0, statesRunning: 0, statesWaiting: 0, statesWaitingFailed: 0, statesCancelled: 0, statesFailed: 0, statesEmptyTerminal: 0, stateDisagreements: 0, stateCodecErrors: 0,
  refRuns: 0,
  // leg (b)
  pairs: 0, pairsFailureFree: 0, pairsFailed: 0, pairDisagreements: 0, keysCompared: 0, keysFailedCompared: 0, onlyNet: 0, onlyReference: 0,
  // leg (c)
  netFirings: 0, points: 0, pointDisagreements: 0, pointCodecErrors: 0, pointMarkingDiffs: 0,
  // leg (a″): reached (S, s) pairs
  scopedPairs: 0, scopedHalted: 0, scopedRaces: 0, scopedNonEmpty: 0, scopedOrdered: 0, scopedWaiting: 0, scopedDisagreements: 0, scopedCodecErrors: 0,
  // leg (a‴): every reported S; compared on failure-free S, a failed S counted as F3's named race
  finishedStates: 0, finishedCompared: 0, finishedBoth: 0, finishedNetOnly: 0, finishedReferenceOnly: 0,
  finishedDisagreements: 0, finishedCodecErrors: 0,
  /** Disagreements by n8n's count: `countExpectedSettledSteps` undefined (a loop had not ended), or more steps owed than rows settled. */
  finishedLoopRunning: 0, finishedRowsOwed: 0,
  /** Failed S (the race), and those where n8n's count test says finished (the failed step was the last owed). */
  finishedRaces: 0, finishedRacesCountTrue: 0,
  // leg (f): every reported S, and every reached (S, s)
  frontierStates: 0, frontierPairs: 0, frontierCompressed: 0, frontierDisagreements: 0, frontierMaxRows: 0, frontierMaxFrontierRows: 0, maxIteration: 0,
};
/** Findings kept per leg; the rest are counted, not stored. */
const KEEP_FINDINGS = 200;
const kept = new Map<string, number>();
const addFinding = (f: Finding) => {
  const n = kept.get(f.leg) ?? 0;
  kept.set(f.leg, n + 1);
  if (n < KEEP_FINDINGS) findings.push(f);
};
/**
 * Leg (b) on failed pairs: each row the reference cancelled, as `<status before>-><net's status>`
 * (`absent` when the net has no row for the step). Row 31's measurement.
 */
const cancelledFates = new Map<string, number>();
const time = { a: 0, net: 0, c: 0 };
const started = performance.now();

const rowsText = (rows: readonly (StepRow | ReferenceRow)[]) =>
  rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}${r.status === 'completed' ? `[${r.filledOutputSlots.map(Number).join('')}]` : ''}`).join(' ');
const planText = (p: PlanKeys | null) => (p === null ? 'n/a' : `queue {${p.toQueue.join(', ')}} skip {${p.toSkip.join(', ')}}`);
const seqText = (p: PlanSequence | null) => (p === null ? 'n/a' : `queue [${p.toQueue.join(', ')}] skip [${p.toSkip.join(', ')}]`);

for (const file of files) {
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const workflow = { id: basename(file, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
  let triggers: (string | undefined)[] = [undefined];
  try { converter.convert(workflow); } catch (e) {
    if ((e as Error).constructor.name === 'AmbiguousTriggerError') {
      triggers = (workflow.nodes as { name: string; type: string; disabled?: boolean }[])
        .filter((n) => !n.disabled && isTriggerNodeType(n.type))
        .map((n) => n.name);
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
    let compiled: CompiledWorkflow;
    try {
      compiled = compile(graphToDescription(graph).description, { profile: 'engineV2' });
    } catch (e) {
      count.compileErrors++;
      addFinding({ leg: 'a', entry: tag, behaviour: -1, order: -1, detail: `compile error: ${(e as Error).message}` });
      continue;
    }
    count.compiled++;
    const loops: V2Loop[] = deriveLoops(graph);
    const reachable = reachableOf(reference, graph);
    if (loops.length > 0) count.loopEntries++;
    const batchIds = new Set(graph.nodes.filter((n) => n.type === 'batch').map((n) => n.id));

    for (let b = 0; b < BEHAVIOURS; b++) {
      const seed = hash(file, fired ?? '', 'behaviour', b);
      const pFail = b % 4 === 0 ? 0.05 : 0; // a quarter of the behaviours let a node fail, as in the spike
      const behaviour = { seed, pFail, emptyTerminal: EMPTY_TERMINAL, pWait: P_WAIT, ...(MAX_PASSES !== 3 ? { maxPasses: MAX_PASSES } : {}) };
      for (let o = 0; o < ORDERS; o++) {
        // (a) every state of the reference run
        let t0 = performance.now();
        let run: RunResult;
        // The status each row had before it was cancelled, by key: `queued` or `waiting`.
        const lastStatus = new Map<string, string>();
        const cancelledFrom = new Map<string, string>();
        const frontier = (rows: readonly ReferenceRow[], settled?: { nodeId: string; iteration: number }) => {
          if (settled === undefined) count.frontierStates++;
          else count.frontierPairs++;
          const f = compareFrontier(compiled, graph, rows, settled);
          if (f.frontierRows < f.rows) count.frontierCompressed++;
          count.frontierMaxRows = Math.max(count.frontierMaxRows, f.rows);
          count.frontierMaxFrontierRows = Math.max(count.frontierMaxFrontierRows, f.frontierRows);
          for (const r of rows) count.maxIteration = Math.max(count.maxIteration, r.iteration);
          if (f.agree) return;
          count.frontierDisagreements++;
          addFinding({
            leg: 'f', entry: tag, behaviour: b, order: o, rows,
            detail: `${settled === undefined ? 'S' : `settled ${settled.nodeId}@${settled.iteration}`}: ${f.problems.join('\n      ')}`,
          });
        };
        run = simulate(reference, graph, behaviour, o, {
          onState: (rows) => {
            count.states++;
            for (const r of rows) {
              const k = `${r.nodeId}@${r.iteration}`;
              const before = lastStatus.get(k);
              if (r.status === 'cancelled' && before !== undefined && before !== 'cancelled') cancelledFrom.set(k, before);
              lastStatus.set(k, r.status);
            }
            if (rows.some((r) => r.status === 'running')) count.statesRunning++;
            if (rows.some((r) => r.status === 'waiting')) {
              count.statesWaiting++;
              if (rows.some((r) => r.status === 'failed')) count.statesWaitingFailed++;
            }
            if (rows.some((r) => r.status === 'cancelled')) count.statesCancelled++;
            if (rows.some((r) => r.status === 'failed')) count.statesFailed++;
            if (rows.some((r) => batchIds.has(r.nodeId) && r.status === 'completed' && !r.filledOutputSlots.some(Boolean))) count.statesEmptyTerminal++;
            // (a‴) completion at every S: compared without a failed row, the race counted with one
            count.finishedStates++;
            const fin = compareFinished(compiled, reference, loops, reachable, rows);
            if (fin.failed) {
              count.finishedRaces++;
              if (fin.reference) count.finishedRacesCountTrue++;
            } else count.finishedCompared++;
            if (fin.net === true && fin.reference) count.finishedBoth++;
            if (fin.error !== null) count.finishedCodecErrors++;
            if (fin.agree === false) {
              count.finishedDisagreements++;
              if (fin.net === true) count.finishedNetOnly++;
              if (fin.reference) count.finishedReferenceOnly++;
              if (fin.expected === undefined) count.finishedLoopRunning++;
              else if (fin.settled < fin.expected) count.finishedRowsOwed++;
              addFinding({
                leg: 'a‴', entry: tag, behaviour: b, order: o, rows,
                detail: `isFinished ${fin.error !== null ? `threw: ${fin.error}` : String(fin.net)}, countSettled ${fin.settled} >= countExpected ${String(fin.expected)} ${String(fin.reference)}${fin.failed ? ' (a failed row)' : ''}`,
              });
            }
            // (f) the frontier at S
            frontier(rows);
            // (a) R(S)
            const v = compareState(compiled, reference, graph, loops, rows);
            if (v.agree) return;
            count.stateDisagreements++;
            if (v.error !== null) count.stateCodecErrors++;
            addFinding({
              leg: 'a', entry: tag, behaviour: b, order: o, rows: v.rows,
              detail: v.error !== null ? `decode threw: ${v.error}\n      R(S): ${planText(v.reference)}`
                : `planner ${planText(v.net)}\n      R(S)    ${planText(v.reference)}`,
            });
          },
          // (a″) every (S, s) the handler reaches
          onSettled: (rows, settled) => {
            count.scopedPairs++;
            frontier(rows, settled);
            if (rows.some((r) => r.status === 'waiting')) count.scopedWaiting++;
            const v = compareScoped(compiled, reference, graph, loops, rows, settled, netPlanAt(compiled, rows));
            if (v.halted) {
              count.scopedHalted++;
              if (v.unguarded.toQueue.length + v.unguarded.toSkip.length > 0) count.scopedRaces++;
            }
            if (v.reference.toQueue.length + v.reference.toSkip.length > 0) count.scopedNonEmpty++;
            if (v.reference.toQueue.length > 1 || v.reference.toSkip.length > 1) count.scopedOrdered++;
            if (v.agree) return;
            count.scopedDisagreements++;
            if (v.error !== null) count.scopedCodecErrors++;
            addFinding({
              leg: 'a″', entry: tag, behaviour: b, order: o, rows,
              detail: `settled ${settled.nodeId}@${settled.iteration}${v.halted ? ' (a failed row)' : ''}: ${v.error !== null ? `decode threw: ${v.error}` : `scoped net ${seqText(v.net)}`}\n      handler     ${seqText(v.reference)}`,
            });
          },
        });
        count.refRuns++;
        time.a += performance.now() - t0;
        if (b >= NET_BEHAVIOURS || o >= NET_ORDERS) continue;

        // (b) the net run under the same behaviour, against the reference run
        t0 = performance.now();
        const net = await runV2(compiled, v2Actions(graph, behaviour, hash(seed, 'net-order', o)));
        time.net += performance.now() - t0;
        count.pairs++;
        count.netFirings += net.firings;
        const lock = compareLockstep(reference, graph, loops, compiled, run, net);
        if (lock.failed) {
          count.pairsFailed++; count.keysFailedCompared += lock.compared; count.onlyNet += lock.onlyNet; count.onlyReference += lock.onlyReference;
          const netStatus = new Map(net.rows.map((r) => [`${r.nodeId}@${r.iteration}`, r.status]));
          for (const [k, before] of cancelledFrom) {
            const fate = `${before}->${netStatus.get(k) ?? 'absent'}`;
            cancelledFates.set(fate, (cancelledFates.get(fate) ?? 0) + 1);
          }
        }
        else { count.pairsFailureFree++; count.keysCompared += lock.compared; }
        if (!lock.agree) {
          count.pairDisagreements++;
          addFinding({ leg: 'b', entry: tag, behaviour: b, order: o, rows: net.rows, detail: lock.problems.join('\n      ') });
        }

        // (c) every row-set point of the net run
        t0 = performance.now();
        for (const point of net.points) {
          count.points++;
          const v = comparePoint(compiled, point);
          if (v.agree) continue;
          count.pointDisagreements++;
          if (v.error !== null) count.pointCodecErrors++;
          if (v.markingDiff.length > 0) count.pointMarkingDiffs++;
          addFinding({
            leg: 'c', entry: tag, behaviour: b, order: o, rows: v.rows,
            detail: `after firing ${point.firings}: ${v.error !== null ? `decode threw: ${v.error}` : `planner ${planText(v.net)}`}\n      executor ${planText(v.executor)}${v.markingDiff.length > 0 ? `\n      marking ${v.markingDiff.join(', ')}` : ''}`,
          });
        }
        time.c += performance.now() - t0;
      }
    }
  }
}

const wall = (performance.now() - started) / 1000;
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
console.log(`stamp: n8n@${n8nVersion}; ${STAMPED.map((f) => `${basename(f)} ${sha(f)}`).join(', ')}; libpetri ${libpetriVersion}${libpetriLinked ? ' (LINKED checkout)' : ' (registry)'}`);
console.log(`corpus: workflows ${count.workflows}, entries ${count.entries}, accepted ${count.accepted}, compiled ${count.compiled} (${count.loopEntries} with a batch loop), compile errors ${count.compileErrors}`);
console.log(`behaviours ${BEHAVIOURS} x orders ${ORDERS} (net legs: ${Math.min(NET_BEHAVIOURS, BEHAVIOURS)} x ${Math.min(NET_ORDERS, ORDERS)}), emptyTerminal ${EMPTY_TERMINAL}, pFail 0.05 on every 4th behaviour${P_WAIT > 0 ? `, pWait ${P_WAIT}` : ''}`);
const waitingStates = P_WAIT > 0 ? `${count.statesWaiting} with a waiting row (${count.statesWaitingFailed} beside a failed row), ` : '';
console.log(`(a) state:    reference runs ${count.refRuns}, states ${count.states} (${count.statesRunning} with a running row, ${waitingStates}${count.statesCancelled} with a cancelled row, ${count.statesFailed} with a failed row, ${count.statesEmptyTerminal} with an empty terminal); disagreements ${count.stateDisagreements} (of which CodecError ${count.stateCodecErrors})`);
console.log(`(b) lockstep: pairs ${count.pairs} (failure-free ${count.pairsFailureFree}, ${count.keysCompared} steps compared; failed ${count.pairsFailed}, ${count.keysFailedCompared} steps decided by both compared, ${count.onlyNet} only by the net, ${count.onlyReference} only by the reference); disagreements ${count.pairDisagreements}`);
const fateText = [...cancelledFates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, n]) => `${f} ${n}`).join(', ');
console.log(`(b) cancelled on failed pairs, reference status before -> the net's status for the step: ${fateText === '' ? 'none' : fateText}`);
console.log(`(c) firing:   net firings ${count.netFirings}, row-set points ${count.points}; disagreements ${count.pointDisagreements} (CodecError ${count.pointCodecErrors}, marking differs ${count.pointMarkingDiffs})`);
console.log(`(a″) scoped:  reached (S, s) ${count.scopedPairs} (${count.scopedNonEmpty} with a non-empty decision, ${count.scopedOrdered} with two or more keys in one list, ${count.scopedWaiting} beside a waiting row, ${count.scopedHalted} on a failed S, of which ${count.scopedRaces} where unguarded decideSuccessors is non-empty: F2's named race, not compared); disagreements ${count.scopedDisagreements} (CodecError ${count.scopedCodecErrors})`);
console.log(`(a‴) finished: states ${count.finishedStates}: compared (no failed row) ${count.finishedCompared}, finished by both ${count.finishedBoth}; disagreements ${count.finishedDisagreements} (net only ${count.finishedNetOnly}, count test only ${count.finishedReferenceOnly}; by n8n's count: ${count.finishedLoopRunning} with a loop not ended (expected undefined), ${count.finishedRowsOwed} with fewer rows settled than expected; CodecError ${count.finishedCodecErrors}); with a failed row ${count.finishedRaces}: F3's named race, isFinished false, not compared (n8n's count test true on ${count.finishedRacesCountTrue})`);
console.log(`(f) frontier: S ${count.frontierStates}, (S, s) ${count.frontierPairs}; frontier smaller than S at ${count.frontierCompressed}; largest S ${count.frontierMaxRows} rows, largest frontier ${count.frontierMaxFrontierRows} rows; highest iteration ${count.maxIteration}${MAX_PASSES !== 3 ? ` (maxPasses ${MAX_PASSES})` : ''}; disagreements ${count.frontierDisagreements}`);
console.log(`wall clock ${wall.toFixed(1)} s (legs (a), (a″) and (a‴) together ${s(time.a)}): net runs ${s(time.net)}, leg (c) ${s(time.c)}`);
const totalFindings = [...kept.values()].reduce((a, n) => a + n, 0);
console.log(`findings ${totalFindings}${totalFindings > findings.length ? ` (${findings.length} kept, at most ${KEEP_FINDINGS} per leg: ${[...kept].map(([l, n]) => `(${l}) ${n}`).join(', ')})` : ''}`);
for (const f of findings) {
  console.log(`  (${f.leg}) ${f.entry} b${f.behaviour} o${f.order}: ${f.detail}`);
  if (f.rows !== undefined) console.log(`      rows ${rowsText(f.rows)}`);
}
if (JSON_OUT !== '') writeFileSync(JSON_OUT, JSON.stringify({ count, cancelledFates: Object.fromEntries(cancelledFates), findingsByLeg: Object.fromEntries(kept), findings }, null, 2));
process.exitCode = totalFindings > 0 ? 1 : 0;
