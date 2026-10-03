/**
 * Leg (d) of `tasks/v2-seam-plan.md` (step 8): the handler-level leg. n8n's own
 * `ExecutionStartHandler`, `StepReadyHandler` and `StepSettledHandler`, from the PATCHED engine
 * `dist` (patches 0001–0004), run each corpus graph twice under the same behaviour and the same
 * event order: once with `defaultSettlementPolicy` (patch 0003) answering, once with our
 * `createSettlementPolicy` answering. Nothing is ported: the handlers, `settlementReaderFor`,
 * `runBatchStep` and input gathering are n8n's compiled code.
 *
 * **The stores are ours.** `MemoryStepStore` and `MemoryExecutionStore`
 * (`typescript/src/conformance/v2/memory-stores.ts`) emulate the TypeORM stores' dedupe,
 * compare-and-set and refuse-after-fail, as their module doc states. The queues are a pool the
 * driver draws from at random (seeded): the nondeterminism of concurrent workers. A result here is
 * settlement evidence about n8n's handlers on these stores (decision 12): not a conformance
 * number, not a policy-entering case count and not a neutrality leg.
 *
 * What is compared, per (graph, behaviour b, order o):
 *  (d1) per settlement: every time the handler asks the answering policy, the other policy is
 *       asked too, at the same row set S, through `settlementReaderFor` on a frozen copy of S.
 *       `decideSuccessors` is compared as ordered queue and skip sequences, `isFinished` as a
 *       boolean. An S with a failed row is the named race (F2, and F3 as amended): counted, with
 *       how the two answered, not compared. A throw is a disagreement, race or not, except n8n's
 *       own policy, which is n8n's.
 *  (d2) per run (sequential mode only, where the two runs are lockstep): the same calls with the
 *       same answers, the same final rows (status and outputs), the same execution status, the
 *       same lifecycle events in order, the same `ended` response, the same handler errors.
 *  (d3) decision 7 as amended: every run that ends with a failed row ends with execution status
 *       `failed`, under both policies; every run without one ends `completed` (a run that stays
 *       `running` under ours where the default completes is F3's second clause). A run whose
 *       cancel on request won (`--p-cancel`) must end `cancelled` with no row `queued` or
 *       `running`, whatever its rows hold.
 *
 * The two named races of decision 8, live (divergence rows 36 and 37):
 *  - **failure race at `isFinished`**: a run that ends `failed` through `finishExecutionIfDone`,
 *    i.e. the policy said finished and the handler's `hasFailedSteps` then found the failure.
 *    n8n's count can do that, and the `ended` response then names the settling sibling as
 *    `lastStep`. Ours must never: a run of ours ending that way is a (d3) finding.
 *  - **cancel race**: `--p-cancel P` sends n8n's own `CancelExecutionService.cancel` into the
 *    event pool at a seeded event, in a fraction P of the runs, as a request would arrive. At an S
 *    with a cancelled row and no failed one, ours must answer ∅ and not finished (a (d1) finding
 *    otherwise); the leg counts where the default plans there, and every row either policy
 *    creates after the execution was cancelled (rows `StepReadyHandler` then cancels at claim).
 *
 * `--concurrency C` (default 1) runs up to C events at once and makes every store call yield a
 * seeded number of ticks first, so a failure can land between `hasFailedSteps` and the planning
 * read: the named races, live. The two runs then interleave differently (the policies make
 * different reads), so (d2) shrinks to: the same status, and, failure-free, the same final rows.
 * (d1) still compares at the S each call started at; a call whose rows changed under it is
 * counted as skewed and both policies are asked on the frozen S. A concurrent pair with a cancel
 * sent into either run is left to (d3): the cancel lands at a different point of each run.
 *
 * Behaviours are the differential's (`seed`, `pFail` 0.05 on every 4th, `--wait`), through
 * `outcome()` for every `v1-node` step: the executor throws for a failure, returns a wait for a
 * suspend (resumed by request with the outputs it would have produced), and otherwise fills each
 * slot it fires with 1–3 items. Batch steps are n8n's `runBatchStep` on those items, so the number
 * of passes is the engine's, and `--empty-terminal` does not apply.
 *
 *   npx tsx tasks/v2-handler-leg.mts [--behaviours 20] [--orders 20] [--limit N] [--wait 0]
 *                                    [--concurrency 1] [--p-fail 0.05] [--p-cancel 0]
                                     [--mutate FAULT]
 *                                    [--max-events 20000] [--json out.json]
 *
 * `--p-fail` raises the failure chance of every 4th behaviour, to make the races of
 * `--concurrency` frequent; `--mutate` plants a fault in our policy (a mutation check, see
 * `MUTATE`).
 *
 * Needs `.n8n/` at the pin with patches 0001–0004 applied and `@n8n/engine` built
 * (`pnpm --filter @n8n/engine build`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { V2Graph, V2Node } from '../typescript/src/conformance/v2/graph.ts';
import { GOLDEN_STAMPED_DIST } from '../typescript/src/conformance/v2/golden.ts';
import { MemoryExecutionStore, MemoryStepStore } from '../typescript/src/conformance/v2/memory-stores.ts';
import type { MemoryStepRecord } from '../typescript/src/conformance/v2/memory-stores.ts';
import { hash, outcome, rng } from '../typescript/src/conformance/v2/reference.ts';
import type { Behaviour } from '../typescript/src/conformance/v2/reference.ts';
import type { V2SettlementPolicy, V2SettlementReader, V2StepKey, V2SuccessorDecisions } from '../typescript/src/n8n/v2-host.ts';
import { createCompileCache } from '../typescript/src/settlement/compile-cache.ts';
import { createSettlementPolicy } from '../typescript/src/settlement/policy.ts';
import type { SettlementDiagnostic } from '../typescript/src/settlement/policy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(root, '.n8n/packages/@n8n');
const dist = `${pkg}/engine/dist`;
const need = `${dist}/execution/settlement-policy.js`;
if (!existsSync(need)) throw new Error(`${need} missing: apply patches 0001–0004 (scripts/verify-patch.sh) and build @n8n/engine`);
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);

const { StepSettledHandler } = req(`${dist}/execution/step-settled-handler.js`);
const { StepReadyHandler } = req(`${dist}/execution/step-ready-handler.js`);
const { ExecutionStartHandler } = req(`${dist}/execution/execution-start-handler.js`);
const { CancelExecutionService } = req(`${dist}/execution/cancel-execution.service.js`);
const { defaultSettlementPolicy, settlementReaderFor } = req(need) as {
  defaultSettlementPolicy: V2SettlementPolicy;
  settlementReaderFor: (store: MemoryStepStore, executionId: string) => V2SettlementReader;
};
const { StepNotFoundError } = req(`${dist}/execution/step-store.js`);
const { ExecutionNotFoundError } = req(`${dist}/execution/execution-store.js`);
const { validateExecutableGraph } = req(`${dist}/graph/validate-executable-graph.js`);
const { findTriggerNode } = req(`${dist}/graph/workflow-graph-queries.js`);
const { V1WorkflowConverter } = req(`${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`);
const { isTriggerNodeType } = req('n8n-workflow');

// ---- stamp ----
const sha = (f: string) => createHash('sha256').update(readFileSync(resolve(pkg, f))).digest('hex').slice(0, 12);
const n8nVersion = JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string;
const libpetriVersion = JSON.parse(readFileSync(resolve(root, 'typescript/node_modules/libpetri/package.json'), 'utf8')).version as string;
const libpetriLinked = lstatSync(resolve(root, 'typescript/node_modules/libpetri')).isSymbolicLink();
const STAMP_FILES = [...new Set([
  ...GOLDEN_STAMPED_DIST.filter((f) => f.startsWith('engine/dist/execution/') || f.startsWith('engine/dist/graph/loops')),
  'engine/dist/execution/settlement-policy.js', 'engine/dist/execution/step-ready-handler.js',
  'engine/dist/execution/execution-start-handler.js', 'engine/dist/execution/batch-step.js',
  'engine/dist/execution/cancel-execution.service.js',
])];

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const BEHAVIOURS = Number(arg('behaviours', '20'));
const ORDERS = Number(arg('orders', '20'));
const LIMIT = Number(arg('limit', '100000'));
const P_WAIT = Number(arg('wait', '0'));
/** The failure chance on every 4th behaviour (the differential's 0.05 by default); a stress leg raises it. */
const P_FAIL = Number(arg('p-fail', '0.05'));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '1')));
/** The share of runs into which a cancel on request is sent (n8n's `CancelExecutionService`). */
const P_CANCEL = Number(arg('p-cancel', '0'));
const MAX_EVENTS = Number(arg('max-events', '20000'));
const JSON_OUT = arg('json', '');
/**
 * A deliberate fault in our policy, to show the leg catches it (a mutation check, never a result):
 * `reverse` reverses both lists, `no-skip` drops every skip, `never-finish` answers `isFinished`
 * false, `finish-on-failed` answers it true on any failed row.
 */
const MUTATE = arg('mutate', '');

// ---- corpus, as the differential reads it ----
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);
const converter = new V1WorkflowConverter();

type PolicyName = 'default' | 'ours';
type Leg = 'd1' | 'd2' | 'd3' | 'error';
interface Finding { readonly leg: Leg; readonly entry: string; readonly behaviour: number; readonly order: number; readonly detail: string }
const findings: Finding[] = [];
const KEEP = 200;
const kept = new Map<Leg, number>();
const addFinding = (f: Finding) => {
  const n = kept.get(f.leg) ?? 0;
  kept.set(f.leg, n + 1);
  if (n < KEEP) findings.push(f);
};

const count = {
  workflows: files.length, entries: 0, accepted: 0, runs: 0, events: 0,
  // (d1)
  decideCalls: 0, decideCompared: 0, decideDisagreements: 0, decideNonEmpty: 0, decideOrdered: 0,
  decideRaces: 0, decideRacesDiffer: 0, decideCancelRaces: 0, decideCancelRacesDefaultPlans: 0,
  finishCalls: 0, finishCompared: 0, finishTrueBoth: 0, finishDisagreements: 0,
  finishRaces: 0, finishRacesDefaultTrue: 0, finishCancelRaces: 0, finishCancelRacesDefaultTrue: 0,
  skewedCalls: 0, skewMoved: 0, oursThrew: 0, defaultThrew: 0, waitingAtCall: 0,
  // (d2)
  pairs: 0, pairDifferences: 0,
  /** Concurrent pairs with a cancel sent into either run: not compared by (d2), see `comparePair`. */
  pairsCancelledConcurrent: 0,
  // (d3)
  endedFailedRow: { default: 0, ours: 0 }, failedRowNotFailed: { default: 0, ours: 0 },
  endedFailureFree: { default: 0, ours: 0 }, failureFreeNotCompleted: { default: 0, ours: 0 },
  statuses: { default: {} as Record<string, number>, ours: {} as Record<string, number> },
  handlerErrors: { default: 0, ours: 0 },
  /** Failure race at `isFinished`: runs ended `failed` by `finishExecutionIfDone`, and `ended` responses by `lastStep`. */
  failedByIsFinished: { default: 0, ours: 0 },
  failedLastStepFailed: { default: 0, ours: 0 }, failedLastStepSibling: { default: 0, ours: 0 },
  /** Cancel on request: runs it was sent into, runs where it won, rows created after it won. */
  cancelSent: { default: 0, ours: 0 }, cancelWon: { default: 0, ours: 0 },
  cancelWonNotCancelled: { default: 0, ours: 0 }, cancelWonRowsLeftPending: { default: 0, ours: 0 },
  rowsCreatedAfterCancel: { default: 0, ours: 0 }, runsWithRowsAfterCancel: { default: 0, ours: 0 },
  // F5-style: ours entered
  oursEntered: 0, oursErrors: 0, oursRaceDiagnostics: 0,
  suspended: 0, resumed: 0, cancelledRows: 0,
  /** Final rows past iteration 0 (later loop passes), and runs that have one. */
  laterPassRows: 0, runsWithLaterPass: 0, maxIteration: 0,
};

const keyText = (k: V2StepKey) => `${k.nodeId}@${k.iteration}`;
const seqText = (d: V2SuccessorDecisions) => `queue [${d.toQueue.map(keyText).join(', ')}] skip [${d.toSkip.map(keyText).join(', ')}]`;
const rowsText = (rows: readonly MemoryStepRecord[]) =>
  rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}${r.status === 'completed' ? `[${(r.outputs ?? []).map((v) => (v === null ? 0 : 1)).join('')}]` : ''}`).join(' ');
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The named race at S, as decision 8 names it. */
function raceOf(rows: readonly MemoryStepRecord[]): 'failure' | 'cancel' | null {
  if (rows.some((r) => r.status === 'failed')) return 'failure';
  if (rows.some((r) => r.status === 'cancelled')) return 'cancel';
  return null;
}

type Answer<T> = { readonly value: T } | { readonly error: string };
async function attempt<T>(f: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { value: await f() };
  } catch (e) {
    return { error: errText(e) };
  }
}

interface RunRecord {
  readonly status: string;
  readonly rows: string;
  readonly failedRow: boolean;
  readonly lifecycle: readonly string[];
  readonly ended: readonly string[];
  readonly calls: readonly string[];
  readonly errors: readonly string[];
  readonly events: number;
  /** A cancel on request was sent, and whether its compare-and-set won. */
  readonly cancel: 'none' | 'lost' | 'won';
  /** Rows left `queued` or `running` at the end. */
  readonly pendingRows: number;
  /** Whether a `failed` ending was written by `finishExecutionIfDone` (after `isFinished` said true). */
  readonly failedByIsFinished: boolean;
  /** Rows created while the execution was already `cancelled`. */
  readonly rowsAfterCancel: number;
  /** The `lastStep` status of each `ended` response (`null` for a cancel's, which has none). */
  readonly endedLastStatus: readonly (string | null)[];
}

/** Per handled event: whether the answering policy's `isFinished` said true in it. */
const handling = new AsyncLocalStorage<{ saidFinished: boolean }>();

/** Items for one output slot: 1–3 of them, fixed by the behaviour. */
function items(seed: number, nodeId: string, iteration: number, slot: number): unknown[] {
  const n = 1 + (hash(seed, nodeId, iteration, 'items', slot) % 3);
  return Array.from({ length: n }, (_, i) => ({ json: { node: nodeId, iteration, slot, i } }));
}

/** The outputs a completed `v1-node` step produces under the behaviour. */
function outputsOf(graph: V2Graph, node: V2Node, iteration: number, behaviour: Behaviour): unknown[] {
  return outcome(graph, node, iteration, behaviour).filled.map((f, slot) => (f ? items(behaviour.seed, node.id, iteration, slot) : null));
}

interface RunContext {
  readonly tag: string;
  readonly graph: V2Graph;
  readonly behaviour: Behaviour;
  readonly b: number;
  readonly o: number;
}

/**
 * One run of n8n's handlers with `answering` deciding, and the other policy asked at every call
 * (d1). Returns what (d2) and (d3) compare.
 */
async function runOnce(ctx: RunContext, answering: PolicyName, ours: V2SettlementPolicy): Promise<RunRecord> {
  const { graph, behaviour, b, o, tag } = ctx;
  const executionId = `x-${answering}`;
  const tickDraw = rng(hash(behaviour.seed, 'ticks', o));
  const storeOptions = {
    order: hash(behaviour.seed, 'store-order', o),
    yieldTicks: CONCURRENCY > 1 ? () => Math.floor(tickDraw() * 4) : undefined,
    stepNotFound: (id: string) => new StepNotFoundError(id),
    executionNotFound: (id: string) => new ExecutionNotFoundError(id),
  };
  const stepStore = new MemoryStepStore(storeOptions);
  const executionStore = new MemoryExecutionStore(stepStore, storeOptions);
  // The failure race at `isFinished`: a `failed` ending written in the same handled event in which
  // the answering policy said finished can only be `finishExecutionIfDone`'s.
  let failedByIsFinished = false;
  const finishExecution = executionStore.finishExecution.bind(executionStore);
  executionStore.finishExecution = async (id, status) => {
    const finished = await finishExecution(id, status);
    if (finished !== null && status === 'failed' && handling.getStore()?.saidFinished === true) failedByIsFinished = true;
    return finished;
  };

  type Pending = { readonly queue: 'orch' | 'step'; readonly msg: { type: string; executionId: string; stepId?: string } } | { readonly queue: 'resume'; readonly stepId: string; readonly key: V2StepKey } | { readonly queue: 'cancel' };
  const pending: Pending[] = [];
  const orchestrationQueue = { publish: async (msg: never) => { pending.push({ queue: 'orch', msg }); }, start() {}, stop: async () => {} };
  const stepQueue = { publish: async (msg: never) => { pending.push({ queue: 'step', msg }); }, start() {}, stop: async () => {} };
  const lifecycle: string[] = [];
  const publisher = {
    publish: (e: { type: string; nodeId?: string; iteration?: number }) => { lifecycle.push(`${e.type}${e.nodeId === undefined ? '' : ` ${e.nodeId}@${e.iteration}`}`); },
    stop: async () => {},
  };
  const ended: string[] = [];
  const endedLastStatus: (string | null)[] = [];
  const responseSender = {
    send: (m: { type: string; status?: string; lastStep?: { nodeId: string; status: string; outputs: unknown; error?: unknown } | null }) => {
      if (m.type === 'ended') endedLastStatus.push(m.lastStep?.status ?? null);
      if (m.type === 'ended') ended.push(`${m.status} lastStep ${m.lastStep?.nodeId ?? '-'} ${m.lastStep?.status ?? '-'} ${JSON.stringify(m.lastStep?.outputs ?? null)}`);
      return { ok: true, result: undefined };
    },
    stop: async () => {},
  };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let rowsAfterCancel = 0;
  stepStore.onTransition = (row, from) => {
    if (row.status === 'waiting') {
      count.suspended++;
      pending.push({ queue: 'resume', stepId: row.id, key: { nodeId: row.nodeId, iteration: row.iteration } });
    }
    if (row.status === 'cancelled' && from !== null) count.cancelledRows++;
    if (from === null && executionStore.statusNow(executionId) === 'cancelled') rowsAfterCancel++;
  };
  const executor = {
    async execute(request: { node: V2Node; context: { iteration: number } }) {
      const node = byId.get(request.node.id)!;
      const out = outcome(graph, node, request.context.iteration, behaviour);
      if (out.status === 'failed') throw new Error(`behaviour fails ${node.name}#${request.context.iteration}`);
      if (out.suspends === true) return { wait: { acceptsResumeRequest: true } };
      return { outputs: outputsOf(graph, node, request.context.iteration, behaviour) };
    },
  };

  // (d1): the answering policy decides; the other is asked at the same S.
  const calls: string[] = [];
  const other = answering === 'default' ? ours : defaultSettlementPolicy;
  const primary = answering === 'default' ? defaultSettlementPolicy : ours;
  const frozenReader = (S: readonly MemoryStepRecord[]) => settlementReaderFor(MemoryStepStore.frozen(S, { order: storeOptions.order }), executionId);
  const where = () => `[${answering} answering]`;
  const policy: V2SettlementPolicy = {
    async decideSuccessors(g, settled, reader) {
      const S = stepStore.snapshot(reader.executionId);
      const v0 = stepStore.version;
      let answer: V2SuccessorDecisions;
      try {
        answer = await primary.decideSuccessors(g, settled, reader);
      } catch (e) {
        calls.push(`decide ${keyText(settled)} threw ${errText(e)}`);
        throw e;
      }
      calls.push(`decide ${keyText(settled)} ${seqText(answer)}`);
      const skew = stepStore.version !== v0;
      const mine: Answer<V2SuccessorDecisions> = skew ? await attempt(() => primary.decideSuccessors(g, settled, frozenReader(S))) : { value: answer };
      if (skew && !('value' in mine && seqText(mine.value) === seqText(answer))) count.skewMoved++;
      const theirs = await attempt(() => other.decideSuccessors(g, settled, frozenReader(S)));
      recordDecide(ctx, S, settled, answering === 'default' ? mine : theirs, answering === 'default' ? theirs : mine, skew, where());
      return answer;
    },
    async isFinished(g, reader) {
      const S = stepStore.snapshot(reader.executionId);
      const v0 = stepStore.version;
      let answer: boolean;
      try {
        answer = await primary.isFinished(g, reader);
      } catch (e) {
        calls.push(`finished threw ${errText(e)}`);
        throw e;
      }
      calls.push(`finished ${answer}`);
      if (answer) {
        const h = handling.getStore();
        if (h !== undefined) h.saidFinished = true;
      }
      const skew = stepStore.version !== v0;
      const mine: Answer<boolean> = skew ? await attempt(() => primary.isFinished(g, frozenReader(S))) : { value: answer };
      if (skew && !('value' in mine && mine.value === answer)) count.skewMoved++;
      const theirs = await attempt(() => other.isFinished(g, frozenReader(S)));
      recordFinished(ctx, S, answering === 'default' ? mine : theirs, answering === 'default' ? theirs : mine, skew, where());
      return answer;
    },
  };

  const dependencies = { v1StepExecutor: executor };
  const start = new ExecutionStartHandler(executionStore, stepStore, orchestrationQueue, publisher);
  const ready = new StepReadyHandler(executionStore, stepStore, orchestrationQueue, dependencies, publisher, responseSender);
  const settledHandler = new StepSettledHandler(executionStore, stepStore, stepQueue, orchestrationQueue, publisher, responseSender, policy);
  const canceller = new CancelExecutionService(executionStore, stepStore, publisher, responseSender);
  // A cancel on request in a seeded share of the runs, sent into the pool at a seeded event: the
  // same runs and the same event under both policies.
  const cancelDraw = rng(hash(behaviour.seed, 'cancel', o));
  const cancelAt = P_CANCEL > 0 && cancelDraw() < P_CANCEL ? 1 + Math.floor(cancelDraw() * 4 * graph.nodes.length) : null;
  let cancel: RunRecord['cancel'] = 'none';

  const trigger = findTriggerNode(graph) as V2Node;
  await executionStore.createExecution({
    id: executionId, workflowId: tag, status: 'queued', mode: 'manual', graph, workflow: {},
    triggerOutputs: [items(behaviour.seed, trigger.id, 0, 0)], callerContext: { hostMode: 'manual' },
    responseExpectation: { kind: 'runEnd' },
  });
  pending.push({ queue: 'orch', msg: { type: 'execution:enqueued', executionId } });

  const errors: string[] = [];
  const dispatch = async (ev: Pending): Promise<void> => {
    try {
      if (ev.queue === 'cancel') {
        const result = await canceller.cancel(executionId);
        cancel = result.status === 'cancelled' ? 'won' : 'lost';
      } else if (ev.queue === 'resume') {
        const node = byId.get(ev.key.nodeId)!;
        const resumed = await stepStore.resumeStep(ev.stepId, { kind: 'request', outputs: outputsOf(graph, node, ev.key.iteration, behaviour) });
        if (resumed) {
          count.resumed++;
          await stepQueue.publish({ type: 'step:ready', executionId, stepId: ev.stepId } as never);
        }
      } else if (ev.queue === 'step') await ready.handle(ev.msg);
      else if (ev.msg.type === 'execution:enqueued') await start.handle(ev.msg);
      else await handling.run({ saidFinished: false }, () => settledHandler.handle(ev.msg));
    } catch (e) {
      const what = ev.queue === 'resume' || ev.queue === 'cancel' ? ev.queue : ev.msg.type;
      errors.push(`${what}: ${errText(e)}`);
    }
  };

  const pick = rng(hash(behaviour.seed, 'order', o));
  const inflight = new Set<Promise<void>>();
  let events = 0;
  let cancelSent = false;
  while (pending.length > 0 || inflight.size > 0) {
    while (pending.length > 0 && inflight.size < CONCURRENCY) {
      if (cancelAt !== null && !cancelSent && events + 1 >= cancelAt) {
        cancelSent = true;
        pending.push({ queue: 'cancel' });
      }
      if (++events > MAX_EVENTS) throw new Error(`${tag} b${b} o${o} ${answering}: no termination within ${MAX_EVENTS} events`);
      const ev = pending.splice(Math.floor(pick() * pending.length), 1)[0]!;
      const p: Promise<void> = dispatch(ev).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }
  count.events += events;
  const all = stepStore.snapshot(executionId);
  const later = all.filter((r) => r.iteration > 0).length;
  count.laterPassRows += later;
  if (later > 0) count.runsWithLaterPass++;
  for (const r of all) count.maxIteration = Math.max(count.maxIteration, r.iteration);

  const finalRows = stepStore.snapshot(executionId)
    .sort((a, b2) => (a.nodeId < b2.nodeId ? -1 : a.nodeId > b2.nodeId ? 1 : a.iteration - b2.iteration));
  return {
    status: executionStore.statusNow(executionId) ?? 'absent',
    rows: finalRows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}${r.status === 'completed' ? JSON.stringify(r.outputs) : ''}`).join(' '),
    failedRow: finalRows.some((r) => r.status === 'failed'),
    lifecycle, ended, calls, errors, events,
    cancel, failedByIsFinished, rowsAfterCancel, endedLastStatus,
    pendingRows: finalRows.filter((r) => r.status === 'queued' || r.status === 'running').length,
  };
}

function recordDecide(ctx: RunContext, S: readonly MemoryStepRecord[], settled: V2StepKey, d: Answer<V2SuccessorDecisions>, ours: Answer<V2SuccessorDecisions>, skew: boolean, where: string): void {
  count.decideCalls++;
  if (skew) count.skewedCalls++;
  if (S.some((r) => r.status === 'waiting')) count.waitingAtCall++;
  if ('error' in d) count.defaultThrew++;
  if ('error' in ours) count.oursThrew++;
  const race = raceOf(S);
  const detail = () => `${where} decideSuccessors(${keyText(settled)})${skew ? ' (skewed)' : ''}${race === null ? '' : ` (${race} race)`}: default ${'error' in d ? `threw ${d.error}` : seqText(d.value)}\n      ours    ${'error' in ours ? `threw ${ours.error}` : seqText(ours.value)}\n      rows ${rowsText(S)}`;
  if ('error' in ours) {
    addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: detail() });
    count.decideDisagreements++;
    return;
  }
  if (race === 'failure') {
    count.decideRaces++;
    if ('error' in d || seqText(d.value) !== seqText(ours.value)) count.decideRacesDiffer++;
    return;
  }
  if (race === 'cancel') {
    // decision 8: a cancel on request; ours answers ∅, n8n may plan rows `StepReadyHandler` cancels
    count.decideCancelRaces++;
    if (!('error' in d) && d.value.toQueue.length + d.value.toSkip.length > 0) count.decideCancelRacesDefaultPlans++;
    if (ours.value.toQueue.length + ours.value.toSkip.length > 0) {
      count.decideDisagreements++;
      addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `${detail()}\n      ours plans on a cancelled S` });
    }
    return;
  }
  count.decideCompared++;
  if ('error' in d || seqText(d.value) !== seqText(ours.value)) {
    count.decideDisagreements++;
    addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: detail() });
    return;
  }
  if (d.value.toQueue.length + d.value.toSkip.length > 0) count.decideNonEmpty++;
  if (d.value.toQueue.length > 1 || d.value.toSkip.length > 1) count.decideOrdered++;
}

function recordFinished(ctx: RunContext, S: readonly MemoryStepRecord[], d: Answer<boolean>, ours: Answer<boolean>, skew: boolean, where: string): void {
  count.finishCalls++;
  if (skew) count.skewedCalls++;
  if (S.some((r) => r.status === 'waiting')) count.waitingAtCall++;
  if ('error' in d) count.defaultThrew++;
  if ('error' in ours) count.oursThrew++;
  const race = raceOf(S);
  const detail = () => `${where} isFinished${skew ? ' (skewed)' : ''}${race === null ? '' : ` (${race} race)`}: default ${'error' in d ? `threw ${d.error}` : d.value}, ours ${'error' in ours ? `threw ${ours.error}` : ours.value}\n      rows ${rowsText(S)}`;
  if ('error' in ours) {
    count.finishDisagreements++;
    addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: detail() });
    return;
  }
  if (race === 'failure') {
    count.finishRaces++;
    if (!('error' in d) && d.value) count.finishRacesDefaultTrue++;
    if (ours.value) {
      // decision 7 as amended: never finished on a failed S
      count.finishDisagreements++;
      addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `${detail()}\n      ours says finished on a failed S` });
    }
    return;
  }
  if (race === 'cancel') {
    // decision 8: never finished on a cancelled S; the cancel path ended the execution
    count.finishCancelRaces++;
    if (!('error' in d) && d.value) count.finishCancelRacesDefaultTrue++;
    if (ours.value) {
      count.finishDisagreements++;
      addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `${detail()}\n      ours says finished on a cancelled S` });
    }
    return;
  }
  count.finishCompared++;
  if ('error' in d || d.value !== ours.value) {
    count.finishDisagreements++;
    addFinding({ leg: 'd1', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: detail() });
    return;
  }
  if (d.value) count.finishTrueBoth++;
}

/** (d3) on one run. */
function checkEnd(ctx: RunContext, name: PolicyName, run: RunRecord): void {
  count.runs++;
  count.statuses[name][run.status] = (count.statuses[name][run.status] ?? 0) + 1;
  count.handlerErrors[name] += run.errors.length;
  count.rowsCreatedAfterCancel[name] += run.rowsAfterCancel;
  if (run.rowsAfterCancel > 0) count.runsWithRowsAfterCancel[name]++;
  if (run.cancel !== 'none') count.cancelSent[name]++;
  if (run.status === 'failed') {
    if (run.endedLastStatus[0] === 'failed') count.failedLastStepFailed[name]++;
    else count.failedLastStepSibling[name]++;
  }
  if (run.failedByIsFinished) {
    count.failedByIsFinished[name]++;
    if (name === 'ours') {
      addFinding({ leg: 'd3', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `[ours] the execution ended 'failed' through isFinished, which decision 7 as amended rules out\n      rows ${run.rows}` });
    }
  }
  if (run.cancel === 'won') {
    // A cancel on request ended the run: whatever its rows hold, it is `cancelled`, and no row is
    // left claimable or claimed (rows planned after it are cancelled at claim).
    count.cancelWon[name]++;
    if (run.status !== 'cancelled') count.cancelWonNotCancelled[name]++;
    if (run.pendingRows > 0) count.cancelWonRowsLeftPending[name]++;
    if (run.status !== 'cancelled' || run.pendingRows > 0) {
      addFinding({ leg: 'd3', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `[${name}] the cancel won and the execution ended '${run.status}' with ${run.pendingRows} rows queued or running\n      rows ${run.rows}` });
    }
    return;
  }
  if (run.failedRow) {
    count.endedFailedRow[name]++;
    if (run.status !== 'failed') {
      count.failedRowNotFailed[name]++;
      addFinding({ leg: 'd3', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `[${name}] a step failed and the execution ended '${run.status}'\n      rows ${run.rows}` });
    }
  } else {
    count.endedFailureFree[name]++;
    if (run.status !== 'completed') {
      count.failureFreeNotCompleted[name]++;
      addFinding({ leg: 'd3', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: `[${name}] no step failed and the execution ended '${run.status}'${run.errors.length > 0 ? `; handler errors: ${run.errors.join(' | ')}` : ''}\n      rows ${run.rows}` });
    }
  }
}

/** (d2): the two runs. */
function comparePair(ctx: RunContext, d: RunRecord, ours: RunRecord): void {
  count.pairs++;
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    if (x !== y) problems.push(`${what}:\n        default ${x.slice(0, 600)}\n        ours    ${y.slice(0, 600)}`);
  };
  // Under concurrency the two runs interleave differently, so a cancel sent at the same event
  // index lands at a different point of each run: such a pair is checked by (d3) alone.
  const cancelled = d.cancel !== 'none' || ours.cancel !== 'none';
  if (CONCURRENCY > 1 && cancelled) {
    count.pairsCancelledConcurrent++;
    return;
  }
  same('execution status', d.status, ours.status);
  if (CONCURRENCY === 1) {
    same('final rows', d.rows, ours.rows);
    same('policy calls', d.calls, ours.calls);
    same('lifecycle events', d.lifecycle, ours.lifecycle);
    same('ended response', d.ended, ours.ended);
    same('handler errors', d.errors, ours.errors);
    same('events handled', d.events, ours.events);
  } else if (!d.failedRow && !ours.failedRow) {
    same('final rows (failure-free)', d.rows, ours.rows);
  }
  if (problems.length === 0) return;
  count.pairDifferences++;
  addFinding({ leg: 'd2', entry: ctx.tag, behaviour: ctx.b, order: ctx.o, detail: problems.join('\n      ') });
}

const started = performance.now();
const cache = createCompileCache({ maxEntries: 1024 });
const onDiagnostic = (diag: SettlementDiagnostic) => {
  if (diag.kind === 'entered') count.oursEntered++;
  else if (diag.kind === 'error') count.oursErrors++;
  else if (diag.kind === 'race') count.oursRaceDiagnostics++;
};
const unmutated = createSettlementPolicy({ cache, onDiagnostic });
const ours: V2SettlementPolicy = MUTATE === '' ? unmutated : {
  async decideSuccessors(g, settled, reader) {
    const d = await unmutated.decideSuccessors(g, settled, reader);
    if (MUTATE === 'reverse') return { toQueue: [...d.toQueue].reverse(), toSkip: [...d.toSkip].reverse() };
    if (MUTATE === 'no-skip') return { toQueue: d.toQueue, toSkip: [] };
    return d;
  },
  async isFinished(g, reader) {
    if (MUTATE === 'never-finish') return false;
    if (MUTATE === 'finish-on-failed') {
      const latest = await reader.loadLatestStepSummaries(g.nodes.map((n) => n.id));
      if (Object.values(latest).some((r) => r.status === 'failed')) return true;
    }
    return await unmutated.isFinished(g, reader);
  },
};
if (MUTATE !== '' && !['reverse', 'no-skip', 'never-finish', 'finish-on-failed'].includes(MUTATE)) throw new Error(`--mutate ${MUTATE}: unknown`);

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
    for (let b = 0; b < BEHAVIOURS; b++) {
      const seed = hash(file, fired ?? '', 'behaviour', b);
      const behaviour: Behaviour = { seed, pFail: b % 4 === 0 ? P_FAIL : 0, emptyTerminal: 0, pWait: P_WAIT };
      for (let o = 0; o < ORDERS; o++) {
        const ctx: RunContext = { tag, graph, behaviour, b, o };
        const d = await runOnce(ctx, 'default', ours);
        const mine = await runOnce(ctx, 'ours', ours);
        checkEnd(ctx, 'default', d);
        checkEnd(ctx, 'ours', mine);
        comparePair(ctx, d, mine);
      }
    }
  }
}

const wall = (performance.now() - started) / 1000;
console.log(`stamp: n8n@${n8nVersion} with patches 0001–0004; ${STAMP_FILES.map((f) => `${basename(f)} ${sha(f)}`).join(', ')}; libpetri ${libpetriVersion}${libpetriLinked ? ' (LINKED checkout)' : ' (registry)'}; node ${process.version}`);
console.log(`corpus: workflows ${count.workflows}, entries ${count.entries}, accepted ${count.accepted}; behaviours ${BEHAVIOURS} x orders ${ORDERS}, pFail ${P_FAIL} on every 4th behaviour${P_WAIT > 0 ? `, pWait ${P_WAIT}` : ''}${P_CANCEL > 0 ? `, pCancel ${P_CANCEL}` : ''}, concurrency ${CONCURRENCY}`);
if (MUTATE !== '') console.log(`MUTATION CHECK: our policy carries the fault '${MUTATE}'; findings are expected, and nothing below is a result`);
console.log(`runs ${count.runs} (${count.pairs} pairs), events handled ${count.events}; suspended ${count.suspended}, resumed ${count.resumed}, rows cancelled ${count.cancelledRows}; rows past iteration 0 ${count.laterPassRows} in ${count.runsWithLaterPass} runs (highest iteration ${count.maxIteration})`);
console.log(`(d1) decideSuccessors: calls ${count.decideCalls}; compared (no failed or cancelled row) ${count.decideCompared} (${count.decideNonEmpty} non-empty, ${count.decideOrdered} with two or more keys in one list); disagreements ${count.decideDisagreements}; failure race ${count.decideRaces} (answers differ on ${count.decideRacesDiffer}), cancel race ${count.decideCancelRaces} (default plans on ${count.decideCancelRacesDefaultPlans})`);
console.log(`(d1) isFinished:       calls ${count.finishCalls}; compared ${count.finishCompared} (finished by both ${count.finishTrueBoth}); disagreements ${count.finishDisagreements}; failure race ${count.finishRaces} (default true on ${count.finishRacesDefaultTrue}), cancel race ${count.finishCancelRaces} (default true on ${count.finishCancelRacesDefaultTrue})`);
console.log(`(d1) calls beside a waiting row ${count.waitingAtCall}; skewed calls ${count.skewedCalls} (the live answer differs from the one at S on ${count.skewMoved}); ours threw ${count.oursThrew}, default threw ${count.defaultThrew}; ours diagnostics: entered ${count.oursEntered}, race ${count.oursRaceDiagnostics}, error ${count.oursErrors}`);
console.log(`(d2) runs compared${CONCURRENCY === 1 ? ' in lockstep (calls, rows, status, lifecycle, ended, errors)' : ' (status; final rows when failure-free)'}: ${count.pairs}; differences ${count.pairDifferences}${count.pairsCancelledConcurrent > 0 ? `; with a cancel sent, left to (d3) ${count.pairsCancelledConcurrent}` : ''}`);
for (const name of ['default', 'ours'] as const) {
  console.log(`(d3) ${name.padEnd(7)}: with a failed row ${count.endedFailedRow[name]} (not 'failed': ${count.failedRowNotFailed[name]}), failure-free ${count.endedFailureFree[name]} (not 'completed': ${count.failureFreeNotCompleted[name]}); statuses ${JSON.stringify(count.statuses[name])}; handler errors ${count.handlerErrors[name]}`);
}
for (const name of ['default', 'ours'] as const) {
  console.log(`(race) ${name.padEnd(7)}: ended 'failed' through isFinished ${count.failedByIsFinished[name]}; 'failed' endings with lastStep the failed step ${count.failedLastStepFailed[name]}, a settled sibling ${count.failedLastStepSibling[name]}${P_CANCEL > 0 ? `; cancel sent ${count.cancelSent[name]}, won ${count.cancelWon[name]} (not 'cancelled' ${count.cancelWonNotCancelled[name]}, rows left queued or running ${count.cancelWonRowsLeftPending[name]}), rows created after it ${count.rowsCreatedAfterCancel[name]} in ${count.runsWithRowsAfterCancel[name]} runs` : ''}`);
}
console.log(`wall clock ${wall.toFixed(1)} s`);
const total = [...kept.values()].reduce((a, n) => a + n, 0);
console.log(`findings ${total}${total > findings.length ? ` (${findings.length} kept, at most ${KEEP} per leg: ${[...kept].map(([l, n]) => `(${l}) ${n}`).join(', ')})` : ''}`);
for (const f of findings) console.log(`  (${f.leg}) ${f.entry} b${f.behaviour} o${f.order}: ${f.detail}`);
if (JSON_OUT !== '') writeFileSync(JSON_OUT, JSON.stringify({ count, findingsByLeg: Object.fromEntries(kept), findings }, null, 2));
process.exitCode = total > 0 ? 1 : 0;
