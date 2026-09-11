/**
 * The differential harness: one workflow, one set of node behaviours, both engines, in one
 * process. The reference engine is {@link StackReferenceScheduler} (n8n's own loop at the
 * pinned commit); the candidate is the {@link PetriScheduler}. Both drive the same
 * `FakeHost` mirror of `WorkflowExecute`, so every difference in the result is a difference
 * between the two schedulers and nothing else.
 *
 * Three comparisons, in this order (README "Principles", `docs/divergences.md` #5):
 *
 * 1. **Data equivalence — the gate.** Three things: (a) `resultData.runData` — for every node
 *    and run index, `data` (including `pairedItem`), `source` (`previousNode` /
 *    `previousNodeOutput` / `previousNodeRun`), `executionStatus`, `metadata` and the error
 *    shape; (b) the **resumable state** — `executionData` (`nodeExecutionStack`,
 *    `waitingExecution`, `waitingExecutionSource`, `contextData`) and `waitTill`, which is
 *    what n8n persists and replays and what the marking codec exists to produce; (c) the
 *    `WorkflowScheduler` **contract values** `executionError` and `closeFunction`, which are
 *    not part of `IRunExecutionData` at all — `processRunExecutionData` reads them off the
 *    scheduler after `run()` and persists the execution as a success or a failure by the
 *    first (`workflow-execute.ts:2250-2255`). `resultData.error` is deliberately *not*
 *    compared: nothing in either leg writes it (`processSuccessExecution` does, and that is
 *    outside both engines), so comparing it compared `undefined` with `undefined`.
 *    The first difference is reported with a path. A data difference is never excused as a
 *    divergence — the registered rows that touch this section excuse a *run count*, never
 *    what a run produced.
 * 2. **Happens-before.** Each engine's trace gives a partial order over activations
 *    (`start` / `finish` of every `runNode`). Every data dependency the run actually
 *    realised — read off each `ITaskData.source` — must be respected in the engine that
 *    produced it (`finish(producer) < start(consumer)`), and every dependency n8n ordered
 *    must be ordered the same way under the net: the net's partial order is a *weakening*
 *    of n8n's total order, never a reordering of it. An inversion is a failure, and so is an
 *    edge whose activation left no `runNode` observation at all.
 * 3. **Ordering report — not a gate.** The `executionIndex` sequences side by side. Every
 *    activation whose rank differs is attributed to a `docs/divergences.md` row, or to the
 *    concurrency the budget bought, or flagged `unattributed` — which is a finding.
 *
 * The gate is (1) and (2) plus "no unattributed ordering difference". A run is `pass` when
 * nothing differs, `divergent` when every difference is attributed to a registered
 * `docs/divergences.md` row, and `fail` otherwise — an unattributed difference is a finding,
 * never a pass.
 */
import type { IRunData, IRunExecutionData, ISourceData, ITaskData, Workflow } from 'n8n-workflow';
import type { BudgetRestriction, WorkflowDescription } from '../compiler/index.js';
import type { SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import { PetriScheduler } from '../scheduler/index.js';
import {
  fakeHooks, fakeNodeHelpers, fakeWorkflow, newRunExecutionData,
  type FakeHostOptions, type FakeWorkflowOptions, type NodeScript, type RunDataOptions,
} from './harness.js';
import { ReferenceHost, StackReferenceScheduler } from './stack-reference.js';

// ==================== fixtures ====================

/** Everything the differ needs to run one workflow through both engines. */
export interface DifferFixture {
  readonly name: string;
  readonly workflow: WorkflowDescription;
  /** Node behaviours; a node without one passes its first input through. */
  readonly scripts?: Readonly<Record<string, NodeScript>>;
  /** Harness options (start items, node parameters, run-node filter, …). */
  readonly options?: FakeWorkflowOptions & RunDataOptions & FakeHostOptions;
  /** Budgets this fixture is meaningful at. Default `[1, 2, 4]`. */
  readonly budgets?: readonly number[];
}

/** The engine label used everywhere in the report. */
export type EngineName = 'n8n' | 'libpetri';

// ==================== traces ====================

/** One observation of a node run. `seq` is a per-engine monotonic counter. */
export interface TraceEvent {
  readonly seq: number;
  readonly kind: 'start' | 'finish';
  readonly node: string;
  readonly runIndex: number;
  /** 0-based attempt of this activation (a retry or a soft-failure re-run is another attempt). */
  readonly attempt: number;
  /** Milliseconds since the engine started. Informational: ordering is by `seq`. */
  readonly at: number;
}

/** One node activation: every attempt of one `(node, runIndex)` pair. */
export interface Activation {
  readonly key: string;
  readonly node: string;
  readonly runIndex: number;
  /** `seq` of the first attempt's start. */
  readonly start: number;
  /** `seq` of the last attempt's finish; `Infinity` if it never finished. */
  readonly finish: number;
  readonly attempts: number;
}

export function activationKey(node: string, runIndex: number): string {
  return `${node}#${runIndex}`;
}

/** Fold a trace into one activation per `(node, runIndex)`. */
export function activationsOf(trace: readonly TraceEvent[]): Map<string, Activation> {
  const out = new Map<string, Activation>();
  for (const e of trace) {
    const key = activationKey(e.node, e.runIndex);
    const seen = out.get(key);
    if (e.kind === 'start') {
      out.set(key, seen === undefined
        ? { key, node: e.node, runIndex: e.runIndex, start: e.seq, finish: Number.POSITIVE_INFINITY, attempts: 1 }
        : { ...seen, attempts: seen.attempts + 1 });
    } else if (seen !== undefined) {
      out.set(key, { ...seen, finish: e.seq });
    }
  }
  return out;
}

/** The host both engines run on: the `FakeHost` mirror plus a `runNode` trace. */
class TracingHost extends ReferenceHost {
  readonly trace: TraceEvent[] = [];
  private seq = 0;
  private readonly t0 = performance.now();
  private readonly attempts = new Map<string, number>();

  override async runNode(
    ...args: Parameters<SchedulerHost['runNode']>
  ): ReturnType<SchedulerHost['runNode']> {
    const node = args[1].node.name;
    const runIndex = args[3];
    const key = activationKey(node, runIndex);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    this.mark('start', node, runIndex, attempt);
    try {
      return await super.runNode(...args);
    } finally {
      this.mark('finish', node, runIndex, attempt);
    }
  }

  private mark(kind: TraceEvent['kind'], node: string, runIndex: number, attempt: number): void {
    this.trace.push({ seq: this.seq++, kind, node, runIndex, attempt, at: performance.now() - this.t0 });
  }
}

// ==================== running both engines ====================

/**
 * The two values `WorkflowScheduler` promises `processRunExecutionData` after `run()`
 * resolves (patch 0001): `executionError` decides whether the execution is persisted as a
 * success or as a failure (`workflow-execute.ts:2250-2255`), and `closeFunction` deactivates
 * a trigger. Neither is part of `IRunExecutionData`, so nothing else in this harness sees
 * them — a scheduler that lost the halting error would have passed every gate.
 */
export interface SchedulerContract {
  readonly executionError: { readonly name?: string; readonly message?: string } | undefined;
  readonly closeFunction: boolean;
}

function contractOf(scheduler: WorkflowScheduler): SchedulerContract {
  const e = scheduler.executionError as { name?: string; message?: string } | undefined;
  return {
    executionError: e === undefined ? undefined : { name: e.name, message: e.message },
    closeFunction: scheduler.closeFunction !== undefined,
  };
}

/** What one engine leg produced. */
export interface EngineRun {
  readonly engine: EngineName;
  readonly scheduler: WorkflowScheduler;
  /** The contract values read off the scheduler after `run()` (part of the data gate). */
  readonly contract: SchedulerContract;
  /** `PetriScheduler.outcome` — how the net's run ended; `null` for the n8n leg. */
  readonly outcome: string | null;
  readonly host: TracingHost;
  readonly runExecutionData: IRunExecutionData;
  readonly runData: IRunData;
  readonly trace: readonly TraceEvent[];
  readonly activations: Map<string, Activation>;
  /** Wall-clock milliseconds of `run()`. */
  readonly elapsedMs: number;
  /** The rejection of `run()`, if it rejected (n8n's loop rejects the same way). */
  readonly error: unknown;
  /** `k` the net actually ran at; `1` for the n8n leg, which has no budget. */
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly diagnostics: readonly string[];
}

/**
 * The payload objects a fixture supplies, copied for one leg. A token holds the very array
 * n8n produced and `addPairedItemLineage` copies items only shallowly (README "Concurrency":
 * *a node's input items are read-only*), so a fixture whose script writes into its input
 * would otherwise mutate objects the **other** leg had already recorded — the legs run one
 * after the other and the comparison happens after both. That erased the difference it was
 * built to find: the two engines produced `i: 100` and `i: 200` and `compareData` reported
 * `equal`, because both `runData`s pointed at the same item object. Cloning the fixture's
 * start items and pin data per leg is what keeps the two runs disjoint (and keeps the
 * fixture module's own `START` array unmutated for every later fixture in the process).
 */
function perLegPayloads<T extends RunDataOptions>(options: T): T {
  return {
    ...options,
    ...(options.startItems === undefined ? {} : { startItems: structuredClone(options.startItems) }),
    ...(options.pinData === undefined ? {} : { pinData: structuredClone(options.pinData) }),
  };
}

function buildHost(fixture: DifferFixture): { host: TracingHost; workflow: Workflow; data: IRunExecutionData } {
  const options = perLegPayloads(fixture.options ?? {});
  const workflow = fakeWorkflow(fixture.workflow, options);
  const startName = fixture.workflow.startNodes?.[0] ?? fixture.workflow.startNode!;
  const data = newRunExecutionData(workflow.nodes[startName]!, options);
  const host = new TracingHost(workflow, data, fixture.scripts ?? {}, options);
  return { host, workflow, data };
}

async function runLeg(
  engine: EngineName,
  fixture: DifferFixture,
  scheduler: WorkflowScheduler,
  hooksOf: (host: TracingHost) => SchedulerHooks,
  prepare: (host: TracingHost) => void,
): Promise<Omit<EngineRun, 'effectiveBudget' | 'budgetRestriction' | 'diagnostics' | 'outcome'>> {
  const { host, workflow, data } = buildHost(fixture);
  prepare(host);
  const hooks = hooksOf(host);
  let error: unknown;
  const t0 = performance.now();
  await scheduler.run(host, workflow, data, hooks).catch((e: unknown) => { error = e; });
  const elapsedMs = performance.now() - t0;
  return {
    engine, scheduler, contract: contractOf(scheduler), host, runExecutionData: data,
    runData: data.resultData.runData,
    trace: host.trace, activations: activationsOf(host.trace), elapsedMs, error,
  };
}

/** Run `fixture` through n8n's own loop. */
export async function runReference(fixture: DifferFixture): Promise<EngineRun> {
  const scheduler = new StackReferenceScheduler();
  const leg = await runLeg('n8n', fixture, scheduler, (h) => fakeHooks(h.calls), (h) => { h.enableEnqueue(); });
  return { ...leg, effectiveBudget: 1, budgetRestriction: null, diagnostics: [], outcome: null };
}

/** Run `fixture` through the `PetriScheduler` at budget `k`. */
export async function runPetri(fixture: DifferFixture, budget: number): Promise<EngineRun> {
  const scheduler = new PetriScheduler({
    nodeHelpers: fakeNodeHelpers,
    legacy: () => { throw new Error('differ: v1 only, the legacy scheduler must not be reached'); },
    budget,
  });
  // `enableEnqueue` is deliberately NOT called: `addNodeToBeExecuted` stays fatal, so a
  // scheduler that reached for n8n's dispatch queue would fail the run, not pass quietly.
  const leg = await runLeg('libpetri', fixture, scheduler, (h) => fakeHooks(h.calls), () => {});
  return {
    ...leg,
    effectiveBudget: scheduler.compiled?.effectiveBudget ?? budget,
    budgetRestriction: scheduler.compiled?.budgetRestriction ?? null,
    diagnostics: [...scheduler.diagnostics],
    outcome: scheduler.outcome ?? null,
  };
}

// ==================== 1. data equivalence ====================

/** One difference between the two `IRunData`s, addressed by a JSON-pointer-ish path. */
export interface DataDifference {
  readonly path: string;
  readonly n8n: string;
  readonly libpetri: string;
}

const MISSING = Symbol('missing');

/** `[object Date]` → `Date`; the class of a value the plain-object walk cannot descend into. */
function classOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

function render(value: unknown): string {
  if (value === MISSING) return '<missing>';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (isExotic(value)) {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    // A Buffer stringifies as `{"type":"Buffer","data":[…]}`; a Map or a Set as `{}`, which
    // says nothing, so those are rendered by class and size instead.
    if (!ArrayBuffer.isView(value)) {
      const size = (value as { size?: number }).size;
      return `[${classOf(value)}${typeof size === 'number' ? ` size ${size}` : ''}]`;
    }
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 197)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * A `{}` literal (or a null-prototype object), the only shape the walk below descends into
 * key by key. `Object.keys` of anything else — a `Date`, a `Map`, a `Set`, an `Error`, a
 * class instance — is empty, so treating them as plain objects made *every pair of them
 * compare equal*: `new Date(1)` vs `new Date(2)` was `null` (no difference), and n8n node
 * output routinely carries dates (`$now`, the Date & Time node, a Code node).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** An object the key walk cannot handle: not a plain object and not an array. */
function isExotic(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value);
}

/**
 * The first difference between two JSON-shaped values, depth first, or `null`. `undefined`
 * and an absent key are the same thing (n8n writes both).
 */
export function firstDifference(a: unknown, b: unknown, path: string): DataDifference | null {
  const left = a === MISSING ? undefined : a;
  const right = b === MISSING ? undefined : b;
  if (left === right) return null;
  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) return null;
  if (left === undefined || right === undefined || left === null || right === null) {
    return { path, n8n: render(a), libpetri: render(b) };
  }
  if (isExotic(left) || isExotic(right)) {
    const different = { path, n8n: render(a), libpetri: render(b) };
    if (classOf(left) !== classOf(right)) return different;
    // A `Date` is its instant; an `Error` is the `{ name, message }` the gate compares
    // everywhere else; a `Buffer` (or any other view) is its bytes, which `JSON.stringify`
    // renders faithfully, so it goes through the key walk below. Anything else — a `Map`, a
    // `Set`, a class instance — has no comparable structure here and is different unless it
    // is literally the same object.
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime() ? null : different;
    }
    if (left instanceof Error && right instanceof Error) {
      return firstDifference({ name: left.name, message: left.message }, { name: right.name, message: right.message }, path);
    }
    if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
      return firstDifference([...(left as Uint8Array)], [...(right as Uint8Array)], path);
    }
    return different;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return { path, n8n: render(a), libpetri: render(b) };
    if (left.length !== right.length) {
      return { path: `${path}.length`, n8n: String(left.length), libpetri: String(right.length) };
    }
    for (let i = 0; i < left.length; i++) {
      const d = firstDifference(left[i], right[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const d = firstDifference(
        Object.hasOwn(left, key) ? left[key] : MISSING,
        Object.hasOwn(right, key) ? right[key] : MISSING,
        `${path}.${key}`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  if (typeof left !== typeof right) return { path, n8n: render(a), libpetri: render(b) };
  return { path, n8n: render(a), libpetri: render(b) };
}

/** An error as it is compared: the stack and the class identity are host-side noise. */
function errorShape(task: ITaskData): unknown {
  const error = task.error as { name?: string; message?: string } | undefined;
  return error === undefined ? undefined : { name: error.name, message: error.message };
}

/**
 * The fields of an `ITaskData` the data gate compares. Left out, and listed here rather than
 * left implicit: `startTime` / `executionTime` (clocks), `executionIndex` (the order, which
 * is section 3's business), `hints`, `inputOverride`, `redactedError`, and
 * `usedDynamicCredentials` / `attemptedDynamicCredentials` — divergence #18's observable,
 * which no scheduler can scope above k = 1 and which this host does not mirror anyway.
 */
export function comparableTask(task: ITaskData): Record<string, unknown> {
  return {
    data: task.data,
    source: task.source,
    executionStatus: task.executionStatus,
    metadata: task.metadata,
    error: errorShape(task),
  };
}

/** Why a data difference is not a defect — or that nothing in the register covers it. */
export type DataAttribution =
  | { readonly kind: 'divergence'; readonly row: number; readonly why: string }
  | { readonly kind: 'unattributed' };

export interface AttributedDifference extends DataDifference {
  readonly attribution: DataAttribution;
}

export interface DataComparison {
  readonly equal: boolean;
  readonly differences: readonly AttributedDifference[];
  /** Differences no registered row covers: the gate fails on these and only these. */
  readonly unattributed: number;
  /**
   * Nodes whose runs are a permutation of each other rather than equal position by
   * position: divergence #11's signature (n8n `unshift`s onto a stack it `shift`s from, so
   * the most recent arrival runs first; the net's `hasdata` place is FIFO).
   */
  readonly permutedNodes: readonly string[];
  /** Nodes the engine reported a stranded token for, and everything downstream of them. */
  readonly strandedNodes: readonly string[];
  /**
   * Nodes n8n left sitting in `waitingExecution`, and everything downstream of them: a join
   * n8n never completed. Divergence #1 — the net propagates an explicit empty token, so its
   * AND-join completes and the node runs where n8n's did not.
   */
  readonly starvedNodes: readonly string[];
}

/** The static main-connection descendants of every node, for the divergence #2 rule. */
export function descendantsOf(workflow: WorkflowDescription): Map<string, Set<string>> {
  const next = new Map<string, string[]>();
  for (const c of workflow.connections) {
    const list = next.get(c.from);
    if (list === undefined) next.set(c.from, [c.to]);
    else list.push(c.to);
  }
  const out = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    const seen = new Set<string>();
    const stack = [...(next.get(node.name) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(next.get(n) ?? []));
    }
    out.set(node.name, seen);
  }
  return out;
}

/** `node 'X': stranded token on …` — the runtime half of divergence #2. */
export function strandedNodesOf(diagnostics: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of diagnostics) {
    if (!d.includes('stranded')) continue;
    const match = /node '([^']+)'/.exec(d);
    if (match !== null) out.push(match[1]!);
  }
  return out;
}

/** What the attribution rules need beyond the two runs themselves. */
export interface DataContext {
  /** The static main-connection closure, for the divergence #2 rule. */
  readonly descendants?: Map<string, Set<string>>;
}

/** One raw difference plus the node it is about (`''` when it is about neither). */
interface NodeDifference {
  readonly d: DataDifference;
  readonly node: string;
}

/** The `IExecuteData` fields a stack entry is compared by: the node, its input, its source. */
function entryShape(entry: { node: { name: string }; data?: unknown; source?: unknown }): unknown {
  return { node: entry.node.name, data: (entry as { data?: { main?: unknown } }).data?.main, source: entry.source };
}

/**
 * The **resumable state**: `IRunExecutionData.executionData` plus `waitTill`. This is what
 * n8n persists with a paused, waiting or failed execution and what "Retry execution" and a
 * Wait-node resume replay, and producing it is the marking codec's whole job (README
 * "Initial marking and the marking codec"). It is data, not order, so it belongs in the gate:
 * two engines that agree on every `ITaskData` and leave different `nodeExecutionStack` /
 * `waitingExecution` behind have not produced the same execution.
 *
 * Skipped when either side has no `executionData` (a hand-built {@link EngineRun}).
 */
function compareResumableState(reference: EngineRun, candidate: EngineRun): NodeDifference[] {
  const left = reference.runExecutionData.executionData;
  const right = candidate.runExecutionData.executionData;
  if (left === undefined || right === undefined) return [];
  const out: NodeDifference[] = [];
  const push = (d: DataDifference | null, node: string): void => { if (d !== null) out.push({ d, node }); };

  const names = (e: typeof left): string[] => e.nodeExecutionStack.map((x) => x.node.name);
  const stackNames = firstDifference(names(left), names(right), 'executionData.nodeExecutionStack');
  if (stackNames !== null) {
    const at = /\[(\d+)\]$/.exec(stackNames.path);
    const index = at === null ? -1 : Number(at[1]);
    push(stackNames, index < 0 ? '' : (left.nodeExecutionStack[index] ?? right.nodeExecutionStack[index])?.node.name ?? '');
  } else {
    left.nodeExecutionStack.forEach((entry, i) => {
      push(firstDifference(entryShape(entry), entryShape(right.nodeExecutionStack[i]!), `executionData.nodeExecutionStack[${i}]`), entry.node.name);
    });
  }
  for (const field of ['waitingExecution', 'waitingExecutionSource'] as const) {
    const a = (left[field] ?? {}) as Record<string, unknown>;
    const b = (right[field] ?? {}) as Record<string, unknown>;
    for (const node of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      push(firstDifference(
        Object.hasOwn(a, node) ? a[node] : MISSING,
        Object.hasOwn(b, node) ? b[node] : MISSING,
        `executionData.${field}.${node}`,
      ), node);
    }
  }
  push(firstDifference(left.contextData, right.contextData, 'executionData.contextData'), '');
  push(firstDifference(reference.runExecutionData.waitTill, candidate.runExecutionData.waitTill, 'waitTill'), '');
  return out;
}

/**
 * Compare everything the two engines are supposed to produce identically, first difference
 * first, and attribute each one. Three parts, all of them the gate:
 *
 * 1. `resultData.runData` — every `ITaskData` field but the clocks and `executionIndex`;
 * 2. the **resumable state** (`executionData`, `waitTill`) — {@link compareResumableState};
 * 3. the `WorkflowScheduler` **contract values** (`executionError`, `closeFunction`), which
 *    decide whether n8n persists the execution as a success or as a failure.
 *
 * Only registered rows can excuse a difference here, and each is an abandonment of an n8n
 * behaviour rather than a change of a node's result:
 *
 * - **#11** — a node's runs came out permuted: the same activations with the same payloads
 *   in the other order, because n8n delivers the most recent arrival first.
 * - **#2** — the net stranded a join arrival and said so, where n8n's quiescence fallback
 *   re-runs the join with `[]` on the input that never arrived. The join and everything
 *   downstream of it therefore runs *fewer times* — which is all this row excuses: a run
 *   count, a node missing entirely, and the arrival the codec wrote to `waitingExecution`.
 *   A per-field difference *inside* a run of such a node is a wrong result, not a divergence.
 * - **#13** — the destination-node stop: the net pauses instead of draining the stack, so an
 *   in-filter entry still pending at that moment never runs.
 * - **#17** — the halt / pause window: an activation the net started or had in flight when
 *   the execution stopped finishes and is recorded, where n8n's `break` left it unrun.
 *
 * Everything else is `unattributed` and fails the gate.
 */
export function compareData(
  reference: EngineRun,
  candidate: EngineRun,
  context: DataContext | Map<string, Set<string>> = {},
): DataComparison {
  const ctx: DataContext = context instanceof Map ? { descendants: context } : context;
  const descendants = ctx.descendants ?? new Map<string, Set<string>>();
  const raw: NodeDifference[] = [];
  const permuted: string[] = [];
  const stranded = strandedNodesOf(candidate.diagnostics);
  const strandedClosure = new Set<string>(stranded);
  for (const node of stranded) for (const d of descendants.get(node) ?? []) strandedClosure.add(d);
  // The other direction: a join n8n left in `waitingExecution` and never ran (divergence #1).
  const starved = Object.keys(reference.runExecutionData.executionData?.waitingExecution ?? {});
  const starvedClosure = new Set<string>(starved);
  for (const node of starved) for (const d of descendants.get(node) ?? []) starvedClosure.add(d);
  /** Nodes whose run count differs, and in which direction. */
  const countOnly = new Set<string>();

  const nodes = [...new Set([...Object.keys(reference.runData), ...Object.keys(candidate.runData)])].sort();
  for (const node of nodes) {
    const left = reference.runData[node];
    const right = candidate.runData[node];
    if (left === undefined || right === undefined) {
      countOnly.add(node);
      raw.push({
        node,
        d: {
          path: `runData.${node}`,
          n8n: left === undefined ? '<never ran>' : `${left.length} run(s)`,
          libpetri: right === undefined ? '<never ran>' : `${right.length} run(s)`,
        },
      });
      continue;
    }
    if (left.length !== right.length) {
      countOnly.add(node);
      raw.push({ node, d: { path: `runData.${node}.length`, n8n: String(left.length), libpetri: String(right.length) } });
      continue;
    }
    const before = raw.length;
    for (let i = 0; i < left.length; i++) {
      const d = firstDifference(comparableTask(left[i]!), comparableTask(right[i]!), `runData.${node}[${i}]`);
      if (d !== null) raw.push({ node, d });
    }
    if (raw.length > before && left.length > 1) {
      const key = (t: ITaskData): string => JSON.stringify(comparableTask(t));
      const sorted = (list: readonly ITaskData[]): string[] => list.map(key).sort();
      if (JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))) permuted.push(node);
    }
  }
  // `resultData.lastNodeExecuted` is not compared here: it records *which node ran last*,
  // a fact about the total order and nothing about any node's result, so it belongs to the
  // ordering report (row #5) — `compareOrdering` checks it there.
  raw.push(...compareResumableState(reference, candidate));
  const contractError = firstDifference(
    reference.contract.executionError, candidate.contract.executionError, 'scheduler.executionError');
  if (contractError !== null) raw.push({ node: '', d: contractError });
  const contractClose = firstDifference(
    reference.contract.closeFunction, candidate.contract.closeFunction, 'scheduler.closeFunction');
  if (contractClose !== null) raw.push({ node: '', d: contractClose });

  const runsIn = (run: EngineRun, node: string): number => run.runData[node]?.length ?? 0;
  const stopped = candidate.outcome === 'halted' || candidate.outcome === 'paused' || candidate.outcome === 'cancelled';
  const destination = reference.runExecutionData.startData?.destinationNode?.nodeName;
  const differences: AttributedDifference[] = raw.map(({ d, node }) => {
    const attributed = (row: number, why: string): AttributedDifference =>
      ({ ...d, attribution: { kind: 'divergence', row, why } });
    if (node !== '' && permuted.includes(node)) {
      return attributed(11,
        `'${node}' ran the same activations with the same payloads in the other order: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`);
    }
    // Row #2 is about a join and its descendants running *fewer times* and about the arrival
    // the codec wrote back instead — never about what a run of them produced.
    const countLike = countOnly.has(node) || d.path.startsWith('executionData.');
    if (node !== '' && strandedClosure.has(node) && countLike) {
      const cause = stranded.includes(node) ? node : `an upstream join (${stranded.join(', ')})`;
      return attributed(2,
        `the net stranded an arrival on ${cause} and reported it, where n8n's quiescence fallback re-runs the join with [] on the input that never arrived`);
    }
    if (node !== '' && starvedClosure.has(node) && countLike && runsIn(candidate, node) >= runsIn(reference, node)) {
      const cause = starved.includes(node) ? `'${node}'` : `an upstream join (${starved.join(', ')})`;
      return attributed(1,
        `n8n left ${cause} in waitingExecution and never ran it — its R6 fallback fires only at the end of an iteration that ran a node, and a starved input never arrives — where the net propagates an explicit empty token, so its AND-join completes`);
    }
    if (destination !== undefined && countLike && (node === '' || runsIn(candidate, node) < runsIn(reference, node) || node === destination)) {
      return attributed(13,
        `the run stopped at destination node '${destination}': n8n keeps popping the stack after it, the net deposits _pause and quiesces, so an entry still pending then never runs`);
    }
    if (stopped && node !== '' && runsIn(candidate, node) > runsIn(reference, node)) {
      return attributed(17,
        `the execution ${candidate.outcome} and '${node}' ran under the net only: the net cannot un-start an action, and the halt window runs until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`);
    }
    if (stopped && countLike && node === '') {
      return attributed(17,
        `the execution ${candidate.outcome}: the activations that finished inside the halt window routed, so the entries written back differ from what n8n's break left`);
    }
    return { ...d, attribution: { kind: 'unattributed' } };
  });
  return {
    equal: differences.length === 0,
    differences,
    unattributed: differences.filter((d) => d.attribution.kind === 'unattributed').length,
    permutedNodes: permuted,
    strandedNodes: [...strandedClosure].sort(),
    starvedNodes: [...starvedClosure].sort(),
  };
}

// ==================== 2. happens-before ====================

/** A data dependency the run actually realised: `to` consumed `from`'s output. */
export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly inputIndex: number;
}

/**
 * The dependency edges of one run, read off the `source` n8n stamps on every `ITaskData`
 * (`previousNode` / `previousNodeRun`). This is the *realised* dependency graph, not the
 * workflow's static one: it names the exact activations that fed each other.
 *
 * **A dispatched `ai_tool` activation is not one of these.** n8n stamps the agent as its
 * `previousNode`, but the agent did not *feed* it — it *asked* for it, and then waited. The
 * agent activation that asked and the one that answers share a run index (`handleRequest` sets
 * `nodeRunIndex: runIndex`), so `finish(agent) < start(tool)` is false in n8n itself, and
 * reading the edge as a data dependency reports a violation against every engine including the
 * reference one. `initializeNodeRunData` marks exactly these runs with an `inputOverride` on a
 * non-`main` connection, which is n8n's own way of saying the same thing.
 */
function isDispatched(task: ITaskData): boolean {
  const override = (task as { inputOverride?: Record<string, unknown> }).inputOverride;
  return override !== undefined && Object.keys(override).some((k) => k !== 'main');
}

export function dependencyEdges(runData: IRunData): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, runIndex) => {
      if (isDispatched(task)) return;
      const sources = (task.source ?? []) as Array<ISourceData | null>;
      sources.forEach((source, inputIndex) => {
        if (source === null || source === undefined) return;
        edges.push({
          from: activationKey(source.previousNode, source.previousNodeRun ?? 0),
          to: activationKey(node, runIndex),
          inputIndex,
        });
      });
    });
  }
  return edges;
}

export interface HappensBeforeViolation {
  readonly engine: EngineName | 'weakening';
  readonly edge: DependencyEdge;
  readonly detail: string;
}

export interface HappensBefore {
  readonly respected: boolean;
  readonly violations: readonly HappensBeforeViolation[];
  readonly checkedEdges: number;
  /**
   * n8n edges the net never realised. Zero whenever the data gate passes (equal `source`
   * fields mean equal dependency graphs); non-zero only under a data difference, where the
   * pairing of producer run to consumer run itself moved and comparing the orders of two
   * different graphs would say nothing.
   */
  readonly unmatchedEdges: number;
  /**
   * Edges whose producer or consumer activation left **no `runNode` observation**, so the
   * order could not be checked at all — the activation is in `runData` but not in the trace,
   * which happens when the run was short-circuited (a pinned output). These used to be
   * counted as checked and then silently skipped; they are violations now, because an edge
   * the harness cannot observe is an edge the harness cannot clear.
   */
  readonly absentEdges: number;
}

function ordered(activations: Map<string, Activation>, edge: DependencyEdge): 'ok' | 'inverted' | 'absent' {
  const from = activations.get(edge.from);
  const to = activations.get(edge.to);
  if (from === undefined || to === undefined) return 'absent';
  return from.finish < to.start ? 'ok' : 'inverted';
}

/**
 * Every realised dependency is respected inside each engine, and every dependency n8n
 * ordered is ordered the same way under the net. Independent activations are free to be
 * unordered under the net — that is the concurrency, and it is not checked here.
 */
export function checkHappensBefore(reference: EngineRun, candidate: EngineRun): HappensBefore {
  const violations: HappensBeforeViolation[] = [];
  let checked = 0;
  let absent = 0;
  for (const run of [reference, candidate]) {
    for (const edge of dependencyEdges(run.runData)) {
      checked++;
      const verdict = ordered(run.activations, edge);
      if (verdict === 'inverted') {
        const from = run.activations.get(edge.from)!;
        const to = run.activations.get(edge.to)!;
        violations.push({
          engine: run.engine,
          edge,
          detail: `finish(${edge.from})=${from.finish} is not before start(${edge.to})=${to.start}`,
        });
      } else if (verdict === 'absent') {
        absent++;
        const missing = [edge.from, edge.to].filter((k) => run.activations.get(k) === undefined);
        violations.push({
          engine: run.engine,
          edge,
          detail: `${missing.join(' and ')} left no runNode observation, so ${edge.from} → ${edge.to} could not be ordered`,
        });
      }
    }
  }
  const candidateEdges = new Set(dependencyEdges(candidate.runData).map((e) => `${e.from}->${e.to}@${e.inputIndex}`));
  let unmatched = 0;
  for (const edge of dependencyEdges(reference.runData)) {
    if (!candidateEdges.has(`${edge.from}->${edge.to}@${edge.inputIndex}`)) {
      unmatched++;
      continue;
    }
    if (ordered(candidate.activations, edge) === 'inverted') {
      violations.push({
        engine: 'weakening',
        edge,
        detail: `n8n orders ${edge.from} before ${edge.to} by a real dependency; the net does not`,
      });
    }
  }
  return { respected: violations.length === 0, violations, checkedEdges: checked, unmatchedEdges: unmatched, absentEdges: absent };
}

// ==================== 3. ordering report ====================

/**
 * Why an activation's `executionIndex` moved. The register's row **#5** is the umbrella:
 * n8n's total order is a LIFO artifact of a stack it `unshift`s onto and `shift`s from, and
 * this project replaces the total-order assertion with data equivalence plus happens-before
 * (`docs/divergences.md` #5, `docs/conformance-m2.md` attributes its two order failures the
 * same way). So an *order-only* difference — data equal, happens-before intact — is
 * attributed to #5, and the mechanism that produced it is named separately: #11 and #12 are
 * the two mechanisms already in the register, and anything else is a `novel` mechanism,
 * which the report lists as a finding for the register even though the gate passes.
 */
export type Attribution =
  | { readonly kind: 'divergence'; readonly row: number; readonly mechanism: string; readonly novel: boolean; readonly why: string }
  | { readonly kind: 'concurrency'; readonly why: string }
  | { readonly kind: 'unattributed'; readonly why: string };

export interface OrderDifference {
  readonly activation: string;
  readonly n8nRank: number | null;
  readonly libpetriRank: number | null;
  readonly attribution: Attribution;
}

/**
 * `resultData.lastNodeExecuted`: the name n8n's error reporting and "Retry execution" read.
 * It is a function of the execution order alone, so a difference is attributed to row #5 —
 * but only when both engines name a node that actually ran in both. A name that belongs to
 * a node one engine never ran is a real defect and stays unattributed.
 */
export interface LastNodeExecuted {
  readonly n8n: string | undefined;
  readonly libpetri: string | undefined;
  readonly equal: boolean;
  readonly attribution: Attribution | null;
}

export interface OrderingReport {
  readonly n8n: readonly string[];
  readonly libpetri: readonly string[];
  readonly equal: boolean;
  readonly differences: readonly OrderDifference[];
  readonly unattributed: number;
  /** Mechanisms observed that no `docs/divergences.md` row names yet. */
  readonly novelMechanisms: readonly string[];
  readonly lastNodeExecuted: LastNodeExecuted;
}

/** The activations in `executionIndex` order — n8n's own `nodeExecutionOrder`. */
export function executionOrder(runData: IRunData): string[] {
  const rows: Array<{ key: string; index: number }> = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, runIndex) => {
      rows.push({ key: activationKey(node, runIndex), index: (task as { executionIndex?: number }).executionIndex ?? 0 });
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.key);
}

/** Transitive reachability over the realised dependency edges. */
function reachable(edges: readonly DependencyEdge[]): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const e of edges) {
    let set = next.get(e.from);
    if (set === undefined) { set = new Set(); next.set(e.from, set); }
    set.add(e.to);
  }
  const closure = new Map<string, Set<string>>();
  const walk = (from: string): Set<string> => {
    const done = closure.get(from);
    if (done !== undefined) return done;
    const out = new Set<string>();
    closure.set(from, out);
    for (const to of next.get(from) ?? []) {
      out.add(to);
      for (const deep of walk(to)) out.add(deep);
    }
    return out;
  };
  for (const key of next.keys()) walk(key);
  return closure;
}

export interface AttributionContext {
  readonly effectiveBudget: number;
  /** Node names whose runs came out permuted: divergence #11's signature. */
  readonly permutedNodes: readonly string[];
  /** Nodes the net stranded an arrival on, plus everything downstream: divergence #2. */
  readonly strandedNodes: readonly string[];
  /** Nodes n8n left in `waitingExecution`, plus everything downstream: divergence #1. */
  readonly starvedNodes?: readonly string[];
  /** Activations whose recorded `source` has more than one input: multi-input joins. */
  readonly joinActivations: ReadonlySet<string>;
  readonly reachable: Map<string, Set<string>>;
  /**
   * Activations only one engine ran, and which one. They did not *move* — there is no rank
   * to compare — so the concurrency rule must not claim them: "no dependency either way with
   * the activations it passed" is vacuously true over an empty `movedAgainst`, and saying
   * `concurrency` about an activation that exists once is a false correctness claim.
   */
  readonly oneSided?: ReadonlyMap<string, EngineName>;
  /** `PetriScheduler.outcome` of the net's run: a stopped run is the divergence #17 window. */
  readonly candidateOutcome?: string | null;
  /** `startData.destinationNode.nodeName`, when the run had one: divergence #13. */
  readonly destinationNode?: string | undefined;
  /** Nodes with more than one producer edge into one input: the divergence #20 gadget. */
  readonly orInputNodes?: ReadonlySet<string>;
}

/**
 * Nodes an input of which has more than one producer edge — the OR-input gadget (README
 * "OR-inputs"), whose `arm` transition is what divergence #20 is about.
 */
export function orInputNodesOf(workflow: WorkflowDescription): Set<string> {
  const producers = new Map<string, number>();
  for (const c of workflow.connections) {
    const key = `${c.to}#${c.inputIndex}`;
    producers.set(key, (producers.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [key, count] of producers) if (count > 1) out.add(key.slice(0, key.lastIndexOf('#')));
  return out;
}

/**
 * Attribute one reordered activation. Order-only movement is row #5; the rules below only
 * decide which *mechanism* to name, and `novel: true` marks one the register does not have.
 */
export function attribute(
  activation: string,
  movedAgainst: readonly string[],
  ctx: AttributionContext,
): Attribution {
  const node = activation.slice(0, activation.lastIndexOf('#'));
  const ranIn = ctx.oneSided?.get(activation);
  if (ranIn !== undefined) {
    // Not a move: the activation exists in one engine only. The three registered rows that
    // produce one are checked in order of specificity; anything else is a finding.
    if (ctx.strandedNodes.includes(node)) {
      return {
        kind: 'divergence', row: 2, mechanism: 'stranded-join', novel: false,
        why: `'${activation}' ran in ${ranIn} only: '${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`,
      };
    }
    if (ranIn === 'libpetri' && (ctx.starvedNodes ?? []).includes(node)) {
      return {
        kind: 'divergence', row: 1, mechanism: 'starved-join', novel: false,
        why: `'${activation}' ran under the net only: n8n left this join (or its ancestor) in waitingExecution and never ran it, while the net's explicit empty token completes the AND-join`,
      };
    }
    if (ranIn === 'n8n' && ctx.destinationNode !== undefined) {
      return {
        kind: 'divergence', row: 13, mechanism: 'destination-stop', novel: false,
        why: `'${activation}' ran in n8n only: after destination node '${ctx.destinationNode}' n8n keeps popping the stack, while the net deposits _pause and quiesces`,
      };
    }
    const stopped = ctx.candidateOutcome === 'halted' || ctx.candidateOutcome === 'paused' || ctx.candidateOutcome === 'cancelled';
    if (ranIn === 'libpetri' && stopped) {
      return {
        kind: 'divergence', row: 17, mechanism: 'halt-window', novel: false,
        why: `'${activation}' ran under the net only and the execution ${ctx.candidateOutcome}: the net cannot un-start an action, and the window lasts until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`,
      };
    }
    return { kind: 'unattributed', why: `'${activation}' ran in ${ranIn} only, and no registered row explains it` };
  }
  const independent = movedAgainst.every(
    (other) => !(ctx.reachable.get(activation)?.has(other) ?? false)
      && !(ctx.reachable.get(other)?.has(activation) ?? false),
  );
  if (ctx.effectiveBudget > 1 && independent) {
    return {
      kind: 'concurrency',
      why: `k=${ctx.effectiveBudget}: no dependency either way with ${movedAgainst.join(', ') || 'the activations it passed'}, so the net leaves the pair unordered and either order is correct`,
    };
  }
  const nodeOfKey = (key: string): string => key.slice(0, key.lastIndexOf('#'));
  if (ctx.permutedNodes.includes(node)) {
    return {
      kind: 'divergence', row: 11, mechanism: 'or-input-lifo', novel: false,
      why: `two runs of '${node}' are a permutation: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`,
    };
  }
  const joinsInvolved = [activation, ...movedAgainst].filter((k) => ctx.joinActivations.has(k));
  if (joinsInvolved.length > 0) {
    return {
      kind: 'divergence', row: 12, mechanism: 'join-unshift', novel: false,
      why: `${joinsInvolved.join(', ')} completed a multi-input join: n8n unshifts such an entry so it runs after every queued sibling, the net fires it at priority = depth`,
    };
  }
  // Everything a permuted node's activations passed moved *because* they did: one event.
  const permutedPassed = movedAgainst.filter((o) => ctx.permutedNodes.includes(nodeOfKey(o)));
  if (permutedPassed.length > 0 && permutedPassed.length === movedAgainst.length) {
    return {
      kind: 'divergence', row: 11, mechanism: 'or-input-lifo', novel: false,
      why: `'${activation}' moved only against ${permutedPassed.join(', ')}, whose node delivers its arrivals in the other order (n8n most-recent-first, the net FIFO)`,
    };
  }
  const orInvolved = [activation, ...movedAgainst].filter((k) => ctx.orInputNodes?.has(nodeOfKey(k)) ?? false);
  if (orInvolved.length > 0) {
    return {
      kind: 'divergence', row: 20, mechanism: 'or-input-arm', novel: false,
      why: `${orInvolved.join(', ')} is an OR-input node: its arm transition spends one scheduling cycle turning the arrival into X/ready + X/hasdata, and a shallower sibling takes the budget unit in that cycle, so the net runs breadth-first where priority = depth alone would have been depth-first`,
    };
  }
  if (ctx.strandedNodes.includes(node) || movedAgainst.some((o) => ctx.strandedNodes.includes(nodeOfKey(o)))) {
    return {
      kind: 'divergence', row: 2, mechanism: 'stranded-join', novel: false,
      why: `'${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`,
    };
  }
  return {
    kind: 'divergence', row: 5, mechanism: 'unnamed', novel: true,
    why: `order-only: '${activation}' moved relative to ${movedAgainst.join(', ') || '(nothing)'} with equal data — n8n's total order is the LIFO artifact row #5 abandons, but no registered row names this mechanism`,
  };
}

/** Build the ordering report and attribute every rank difference. */
export function compareOrdering(
  reference: EngineRun,
  candidate: EngineRun,
  data: DataComparison,
  orInputNodes: ReadonlySet<string> = new Set(),
): OrderingReport {
  const left = executionOrder(reference.runData);
  const right = executionOrder(candidate.runData);
  const rankOf = (seq: readonly string[]): Map<string, number> => new Map(seq.map((k, i) => [k, i]));
  const leftRank = rankOf(left);
  const rightRank = rankOf(right);
  const joins = new Set<string>();
  for (const run of [reference, candidate]) {
    for (const [node, runs] of Object.entries(run.runData)) {
      runs.forEach((task, runIndex) => {
        if (((task.source ?? []) as unknown[]).length > 1) joins.add(activationKey(node, runIndex));
      });
    }
  }
  const oneSided = new Map<string, EngineName>();
  for (const key of left) if (!rightRank.has(key)) oneSided.set(key, 'n8n');
  for (const key of right) if (!leftRank.has(key)) oneSided.set(key, 'libpetri');
  const ctx: AttributionContext = {
    effectiveBudget: candidate.effectiveBudget,
    permutedNodes: data.permutedNodes,
    strandedNodes: data.strandedNodes,
    starvedNodes: data.starvedNodes,
    joinActivations: joins,
    reachable: reachable([...dependencyEdges(reference.runData), ...dependencyEdges(candidate.runData)]),
    oneSided,
    candidateOutcome: candidate.outcome,
    destinationNode: reference.runExecutionData.startData?.destinationNode?.nodeName,
    orInputNodes,
  };
  const differences: OrderDifference[] = [];
  for (const key of [...new Set([...left, ...right])]) {
    const a = leftRank.get(key);
    const b = rightRank.get(key);
    if (a === b) continue;
    const movedAgainst = a === undefined || b === undefined
      ? []
      : left.filter((other) => {
        const oa = leftRank.get(other)!;
        const ob = rightRank.get(other);
        return ob !== undefined && other !== key && (oa < a) !== (ob < b);
      });
    differences.push({
      activation: key,
      n8nRank: a ?? null,
      libpetriRank: b ?? null,
      attribution: attribute(key, movedAgainst, ctx),
    });
  }
  const lastLeft = reference.runExecutionData.resultData.lastNodeExecuted;
  const lastRight = candidate.runExecutionData.resultData.lastNodeExecuted;
  const ranInBoth = (name: string | undefined): boolean =>
    name !== undefined && reference.runData[name] !== undefined && candidate.runData[name] !== undefined;
  /**
   * A name that belongs to a node only one engine ran is not a defect when that node's runs
   * are themselves attributed: the field then names the last node of a run that legitimately
   * differs (a starved join the net completed, a sibling that finished inside the halt
   * window, an entry n8n ran after a destination stop).
   */
  const oneSidedRow = (name: string | undefined): { row: number; mechanism: string } | null => {
    if (name === undefined) return null;
    const inReference = reference.runData[name] !== undefined;
    const inCandidate = candidate.runData[name] !== undefined;
    if (inReference === inCandidate) return null;
    if (data.strandedNodes.includes(name)) return { row: 2, mechanism: 'stranded-join' };
    if (inCandidate && data.starvedNodes.includes(name)) return { row: 1, mechanism: 'starved-join' };
    if (inReference && ctx.destinationNode !== undefined) return { row: 13, mechanism: 'destination-stop' };
    const stopped = ctx.candidateOutcome === 'halted' || ctx.candidateOutcome === 'paused' || ctx.candidateOutcome === 'cancelled';
    if (inCandidate && stopped) return { row: 17, mechanism: 'halt-window' };
    return null;
  };
  const lastAttribution = (): Attribution | null => {
    if (lastLeft === lastRight) return null;
    const oneSided = oneSidedRow(lastLeft) ?? oneSidedRow(lastRight);
    if (oneSided !== null) {
      return {
        kind: 'divergence', row: oneSided.row, mechanism: oneSided.mechanism, novel: false,
        why: `'${lastLeft ?? 'undefined'}' / '${lastRight ?? 'undefined'}': the field names the last node to run, and one of them ran in one engine only for the reason divergence #${oneSided.row} records`,
      };
    }
    if (!ranInBoth(lastLeft) || !ranInBoth(lastRight)) {
      return { kind: 'unattributed', why: `'${lastLeft ?? 'undefined'}' / '${lastRight ?? 'undefined'}': one of them never ran in one engine` };
    }
    // Row #16 is the k > 1 case (the field records the last node to *complete*, which is its
    // definition under concurrency); at k = 1 it is the total order row #5 abandons.
    return {
      kind: 'divergence', row: candidate.effectiveBudget > 1 ? 16 : 5, mechanism: 'last-node-executed', novel: false,
      why: candidate.effectiveBudget > 1
        ? `both '${lastLeft}' and '${lastRight}' ran in both engines; at k=${candidate.effectiveBudget} the field records the last node to complete (row #16)`
        : `both '${lastLeft}' and '${lastRight}' ran in both engines: which of them ran *last* is the total order row #5 abandons`,
    };
  };
  const lastNodeExecuted: LastNodeExecuted = {
    n8n: lastLeft,
    libpetri: lastRight,
    equal: lastLeft === lastRight,
    attribution: lastAttribution(),
  };
  const withLast = lastNodeExecuted.attribution === null
    ? differences
    : [...differences, { activation: 'resultData.lastNodeExecuted', n8nRank: null, libpetriRank: null, attribution: lastNodeExecuted.attribution }];
  const novel = new Set<string>();
  for (const d of withLast) {
    if (d.attribution.kind === 'divergence' && d.attribution.novel) novel.add(d.attribution.mechanism);
  }
  return {
    n8n: left,
    libpetri: right,
    equal: differences.length === 0 && lastNodeExecuted.equal,
    differences: withLast,
    unattributed: withLast.filter((d) => d.attribution.kind === 'unattributed').length,
    novelMechanisms: [...novel].sort(),
    lastNodeExecuted,
  };
}

// ==================== the result ====================

export interface DiffResult {
  readonly fixture: string;
  readonly requestedBudget: number;
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly data: DataComparison;
  readonly happensBefore: HappensBefore;
  readonly ordering: OrderingReport;
  /**
   * `pass` — nothing differs. `divergent` — every difference is attributed to a registered
   * `docs/divergences.md` row. `fail` — something is unattributed, or happens-before broke.
   */
  readonly verdict: 'pass' | 'divergent' | 'fail';
  /** Ordering mechanisms observed that no register row names yet (a finding, not a failure). */
  readonly novelMechanisms: readonly string[];
  readonly elapsed: { readonly n8n: number; readonly libpetri: number };
  readonly errors: { readonly n8n: string | null; readonly libpetri: string | null };
  readonly diagnostics: readonly string[];
}

const describeError = (e: unknown): string | null =>
  e === undefined ? null : e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Run one fixture through both engines at `budget` and compare. */
export async function diffFixture(fixture: DifferFixture, budget = 1): Promise<DiffResult> {
  const reference = await runReference(fixture);
  const candidate = await runPetri(fixture, budget);
  const data = compareData(reference, candidate, descendantsOf(fixture.workflow));
  const happensBefore = checkHappensBefore(reference, candidate);
  const ordering = compareOrdering(reference, candidate, data, orInputNodesOf(fixture.workflow));
  const errors = { n8n: describeError(reference.error), libpetri: describeError(candidate.error) };
  const clean = happensBefore.respected && ordering.unattributed === 0 && errors.n8n === errors.libpetri;
  const verdict = !clean || data.unattributed > 0
    ? 'fail'
    : data.equal && ordering.equal ? 'pass' : 'divergent';
  return {
    fixture: fixture.name,
    requestedBudget: budget,
    effectiveBudget: candidate.effectiveBudget,
    budgetRestriction: candidate.budgetRestriction,
    data, happensBefore, ordering, verdict,
    novelMechanisms: ordering.novelMechanisms,
    elapsed: { n8n: reference.elapsedMs, libpetri: candidate.elapsedMs },
    errors,
    diagnostics: candidate.diagnostics,
  };
}

/** Run every fixture at every budget it declares (default 1, 2, 4). */
export async function diffAll(
  fixtures: readonly DifferFixture[],
  budgets: readonly number[] = [1, 2, 4],
): Promise<DiffResult[]> {
  const results: DiffResult[] = [];
  for (const fixture of fixtures) {
    for (const budget of fixture.budgets ?? budgets) {
      results.push(await diffFixture(fixture, budget));
    }
  }
  return results;
}

// ==================== the report ====================

const tick = (ok: boolean): string => (ok ? 'yes' : '**no**');

/** The Markdown report: one summary table, then a section per failing or reordered fixture. */
export function renderDiffReport(results: readonly DiffResult[], title = 'Differential report'): string {
  const lines: string[] = [`# ${title}`, ''];
  const passed = results.filter((r) => r.verdict === 'pass').length;
  const divergent = results.filter((r) => r.verdict === 'divergent').length;
  const failed = results.filter((r) => r.verdict === 'fail').length;
  const novel = [...new Set(results.flatMap((r) => r.novelMechanisms))].sort();
  lines.push(
    `${passed} pass, ${divergent} divergent (every difference attributed to a \`docs/divergences.md\` row), ` +
    `${failed} fail, of ${results.length} runs.`,
    '',
    '| fixture | k | effective k | data | happens-before | order | attributed | verdict |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of results) {
    const attributed = r.ordering.differences.length - r.ordering.unattributed;
    const dataCell = r.data.equal
      ? 'equal'
      : r.data.unattributed > 0 ? `**${r.data.unattributed} unattributed**` : `${r.data.differences.length} attributed`;
    const skipped = r.happensBefore.unmatchedEdges;
    const hbCell = `${tick(r.happensBefore.respected)}${skipped > 0 ? ` (${skipped} skipped)` : ''}`;
    lines.push(
      `| ${r.fixture} | ${r.requestedBudget} | ${r.effectiveBudget} | ${dataCell} | ` +
      `${hbCell} | ${r.ordering.equal ? 'equal' : `${r.ordering.differences.length} moved`} | ` +
      `${attributed}/${r.ordering.differences.length}${r.ordering.unattributed > 0 ? ' **(unattributed)**' : ''} | ` +
      `${r.verdict === 'fail' ? '**fail**' : r.verdict} |`,
    );
  }
  if (novel.length > 0) {
    lines.push('', `Ordering mechanisms with no row in \`docs/divergences.md\`: ${novel.map((m) => `\`${m}\``).join(', ')}.`);
  }
  for (const r of results) {
    if (r.verdict === 'pass' && r.budgetRestriction === null) continue;
    lines.push('', `## ${r.fixture} @ k=${r.requestedBudget}`, '');
    if (r.budgetRestriction !== null) {
      lines.push(`Budget forced to ${r.effectiveBudget}: ${r.budgetRestriction.reason} (${r.budgetRestriction.detail}).`, '');
    }
    if (!r.data.equal) {
      lines.push('### Data differences (the gate)', '', '| path | n8n | libpetri | attribution |', '|---|---|---|---|');
      for (const d of r.data.differences.slice(0, 20)) {
        const a = d.attribution;
        const label = a.kind === 'divergence' ? `divergence #${a.row}: ${a.why}` : '**unattributed**';
        lines.push(`| \`${d.path}\` | \`${d.n8n}\` | \`${d.libpetri}\` | ${label} |`);
      }
      if (r.data.differences.length > 20) lines.push(`| … | ${r.data.differences.length - 20} more | |`);
      if (r.data.permutedNodes.length > 0) {
        lines.push('', `Permuted (same runs, other order): ${r.data.permutedNodes.join(', ')}.`);
      }
      lines.push('');
    }
    if (!r.happensBefore.respected) {
      lines.push('### Happens-before violations', '');
      for (const v of r.happensBefore.violations) lines.push(`- **${v.engine}**: ${v.detail}`);
      lines.push('');
    }
    // Always stated, so an edge the check could not look at is never invisible: `unmatched`
    // is an n8n dependency the net never realised (only reachable under a data difference,
    // where the producer/consumer pairing itself moved) and `absent` is an activation with
    // no `runNode` observation, which is a violation above.
    lines.push(
      `Happens-before: ${r.happensBefore.checkedEdges} edge(s) checked, ` +
      `${r.happensBefore.unmatchedEdges} n8n edge(s) the net never realised (not comparable), ` +
      `${r.happensBefore.absentEdges} with no runNode observation.`, '');
    lines.push('### Ordering', '', `- n8n: \`${r.ordering.n8n.join(' → ')}\``, `- libpetri: \`${r.ordering.libpetri.join(' → ')}\``);
    if (!r.ordering.lastNodeExecuted.equal) {
      lines.push(`- \`lastNodeExecuted\`: n8n \`${r.ordering.lastNodeExecuted.n8n ?? 'undefined'}\`, libpetri \`${r.ordering.lastNodeExecuted.libpetri ?? 'undefined'}\``);
    }
    lines.push('');
    if (r.ordering.differences.length > 0) {
      lines.push('| activation | n8n rank | libpetri rank | attribution |', '|---|---|---|---|');
      for (const d of r.ordering.differences) {
        const a = d.attribution;
        const label = a.kind === 'divergence'
          ? `divergence #${a.row} (${a.mechanism}${a.novel ? ', **not in the register**' : ''})`
          : a.kind === 'concurrency' ? 'concurrency' : '**unattributed**';
        lines.push(`| ${d.activation} | ${d.n8nRank ?? '—'} | ${d.libpetriRank ?? '—'} | ${label}: ${a.why} |`);
      }
      lines.push('');
    }
    if (r.errors.n8n !== r.errors.libpetri) {
      lines.push(`Run errors differ — n8n: \`${r.errors.n8n ?? 'none'}\`, libpetri: \`${r.errors.libpetri ?? 'none'}\`.`, '');
    }
    if (r.diagnostics.length > 0) {
      lines.push('Engine diagnostics:', '');
      for (const d of r.diagnostics) lines.push(`- ${d}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
