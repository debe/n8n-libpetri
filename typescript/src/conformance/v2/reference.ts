/**
 * The reference side of the engine v2 differential (`tasks/v2-profile-plan.md` decision 13 and 15,
 * step 9; ADR 0012 §2): the event loop engine v2's `StepSettledHandler` and `StepReadyHandler` run
 * (`packages/@n8n/engine/src/execution/step-settled-handler.ts`, `step-ready-handler.ts` at the
 * pin n8n master `944afe5`), with no database and no queue, and the answer R(S) the net's planner is
 * compared with.
 *
 * **Nothing here decides.** Every settlement decision is n8n's own code, handed in as a
 * {@link SettlementReference}: `decideSuccessors`, `decisionKeys`, `countExpectedSettledSteps`,
 * `deriveLoops`, `isTerminalStep`, `exitSourcesInto`, `stepKeyId` and the graph queries. `src/`
 * never imports `.n8n` (decision 15); a `tasks/` script loads those functions from the pinned
 * checkout's `dist` and injects them. What this module supplies is only what the handlers get from
 * their stores and queues: which step rows exist, and the order in which events are handled.
 *
 * - {@link outcome}: what one step does, a pure function of (node, iteration, behaviour), so the
 *   same in every interleaving.
 * - {@link simulate}: one run. The next event is drawn at random from every pending `step:ready`
 *   and `step:settled`, which is the nondeterminism concurrent workers produce. Every row set it
 *   passes through is reported to `onState`.
 * - {@link referenceAnswer}: R(S), what v2 plans next from a row set S.
 * - {@link handlerPlan} and {@link referenceFinished}: what `StepSettledHandler` decides for one
 *   settled step s at S (`decideSuccessors(s)`, loaded as `planSuccessors` loads it) and whether
 *   `finishExecutionIfDone` would end the run there (`countSettledSteps ≥
 *   countExpectedSettledSteps`): n8n's side of `tasks/v2-seam-plan.md` decision 13's legs (a″)
 *   and (a‴).
 *
 * Moved from `tasks/spike-v2-settlement.mts`, which imports it and reprints its first report with
 * `--baseline`. Four additions over the spike:
 * - a `running` row between the claim and the settle (`StepReadyHandler` claims `queued → running`
 *   before it runs);
 * - the `cancelled` rows `failExecution` leaves (`cancelPendingSteps`), so a failed run's queued
 *   and waiting rows end cancelled;
 * - the `[null, null]` batch terminal, drawn with chance {@link Behaviour.emptyTerminal};
 * - suspend and resume (master's `waiting`), drawn with chance {@link Behaviour.pWait}: a step
 *   that suspends goes `running → waiting` and owes its settlement until a `resume` event
 *   (`resumeStep`) puts it back to `queued`; its next claim emits the outputs it stored and does
 *   not run the node again (`resumedOutputs`).
 *
 * The first two draw no random number, so no run's order, end or event count moves; at
 * `emptyTerminal` 0 and `pWait` 0 the last two draw nothing either and add no event, and every
 * run is the spike's.
 *
 * The claim and the run are one event here, as `StepReadyHandler.handle` is one call: no row is
 * `running` between events. So when a failure is handled no step is running, and master's rule
 * that a running step keeps its status and still settles (`cancelPendingSteps` touches only
 * `queued` and `waiting`) holds without a case of its own. `tasks/spike-v2-exhaustive.mts` splits
 * the claim from the settle and exercises it.
 */
import type { StepKey, V2StepStatus } from '../../codec/v2/step-rows.js';
import type { V2Graph, V2Node } from './graph.js';

/** `WorkflowLoop` (`graph/loops.ts`), the fields this module reads; the rest pass through to n8n untouched. */
export interface V2Loop {
  readonly batchNodeId: string;
  readonly memberIds: ReadonlySet<string>;
}

/**
 * A step row as the reference holds it: `StepSummary` (`execution/step-store.ts`), which is what
 * `decideSuccessors` and `isTerminalStep` read. `id` is the store's row id, in creation order.
 */
export interface ReferenceRow extends StepKey {
  readonly id: string;
  readonly status: V2StepStatus;
  readonly filledOutputSlots: readonly boolean[];
}

/** `SuccessorDecisions` (`execution/settlement.ts`). */
export interface ReferencePlan {
  readonly toQueue: readonly StepKey[];
  readonly toSkip: readonly StepKey[];
}

/**
 * n8n's settlement code, injected (decision 15). Each member is the function of the same name at
 * the pin, with its n8n module; a `tasks/` script passes the `dist` exports as they are.
 */
export interface SettlementReference {
  /** `execution/settlement.ts`. `steps` holds at least the rows `decisionKeys` names, by `stepKeyId`. */
  decideSuccessors(
    graph: V2Graph,
    loops: readonly V2Loop[],
    settled: StepKey,
    steps: Readonly<Record<string, ReferenceRow>>,
    terminalIterations: ReadonlyMap<string, number>,
  ): ReferencePlan;
  /** `execution/settlement.ts`: the rows a decision about `settled`'s successors reads. */
  decisionKeys(graph: V2Graph, loops: readonly V2Loop[], settled: StepKey, terminalIterations: ReadonlyMap<string, number>): StepKey[];
  /** `execution/completion.ts`: settled rows a finished execution owes, `undefined` while a loop runs. */
  countExpectedSettledSteps(loops: readonly V2Loop[], reachable: ReadonlySet<string>, terminalIterations: ReadonlyMap<string, number>): number | undefined;
  /** `graph/loops.ts`. */
  deriveLoops(graph: V2Graph): V2Loop[];
  /** `execution/loop-ledger.ts`: a batch row settled with its loop slot unfilled. */
  isTerminalStep(step: ReferenceRow): boolean;
  /** `execution/loop-ledger.ts`: the batch nodes whose exit edges reach `targetNodeIds`. */
  exitSourcesInto(graph: V2Graph, loops: readonly V2Loop[], targetNodeIds: readonly string[]): string[];
  /** `execution/execution.types.ts`: a row's key, which `decideSuccessors` looks rows up by. */
  stepKeyId(key: StepKey): string;
  /** `graph/workflow-graph-queries.ts`. */
  findTriggerNode(graph: V2Graph): V2Node | undefined;
  /** `graph/workflow-graph-queries.ts`: transitive successors, without `nodeId`. */
  getDescendantNodeIds(graph: V2Graph, nodeId: string): string[];
  /** `graph/workflow-graph-queries.ts`: direct successors, in edge order. */
  getSuccessorNodeIds(graph: V2Graph, nodeId: string): string[];
}

/** FNV-1a, so behaviours are a pure function of their inputs. */
export function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('\u0000')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** xorshift32 over `seed`, in [0, 1). A seed of 0 is taken as 1, which xorshift needs. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/**
 * What a run's steps do. `seed` fixes every outcome, `pFail` is the chance that a step other than a
 * batch step fails, `emptyTerminal` is the chance, per batch node, that its terminal step ends
 * with nothing accumulated, and `pWait` is the chance that a step which completes suspends first.
 */
export interface Behaviour {
  readonly seed: number;
  readonly pFail: number;
  /** 0 reproduces the spike's baseline, where every loop ends with its done slot filled. */
  readonly emptyTerminal: number;
  /**
   * The chance, per (node, iteration), that a step other than a batch step or the trigger
   * suspends (`running → waiting`) before it completes; absent is 0, which reproduces every run
   * from before master's `waiting`.
   */
  readonly pWait?: number;
}

/** One step's outcome: the row status and, when completed, its filled output slots. */
export interface Outcome {
  readonly status: 'completed' | 'failed';
  readonly filled: boolean[];
  /**
   * Present and `true` when the step suspends first: it goes `waiting`, and a resume completes it
   * with `filled`, the outputs the wait stored (`resumedOutputs`). Absent otherwise.
   */
  readonly suspends?: true;
}

/** A node's output arity from its edges: highest `outputIndex` + 1, and at least 1. */
function outputArity(graph: V2Graph, nodeId: string): number {
  let n = 1;
  for (const e of graph.edges) if (e.from === nodeId) n = Math.max(n, e.outputIndex + 1);
  return n;
}

/**
 * What one step does, fixed by the behaviour: the same in every interleaving.
 *
 * A batch node runs `1 + hash % 3` steps. Every step before the last fills the loop slot, which is
 * `runBatchStep`'s `[null, slice]` (`execution/batch-step.ts`). The last step is terminal: it fills
 * the done slot (`[acc, null]`), or, with chance `emptyTerminal` per (behaviour, batch node), fills
 * nothing (`[null, null]`, a loop that ends with nothing accumulated). A batch step never fails
 * here. Any other step fails with chance `pFail`, and otherwise fills each output slot with
 * chance 0.7. A step that completes suspends first with chance `pWait`: an executor returns a wait
 * or an error, never both, so a failing step does not suspend, and a batch step, which the engine
 * runs itself (`runBatchStep` returns outputs), never does.
 *
 * The empty-terminal and the wait draws use hashes of their own, so they move no other draw: with
 * `emptyTerminal` and `pWait` 0 every outcome is the spike's.
 */
export function outcome(graph: V2Graph, node: V2Node, iteration: number, behaviour: Behaviour): Outcome {
  const { seed, pFail, emptyTerminal, pWait = 0 } = behaviour;
  if (node.type === 'batch') {
    const passes = 1 + (hash(seed, node.id, 'passes') % 3);
    if (iteration < passes - 1) return { status: 'completed', filled: [false, true] };
    const empty = emptyTerminal > 0 && rng(hash(seed, node.id, 'empty-terminal'))() < emptyTerminal;
    return { status: 'completed', filled: empty ? [false, false] : [true, false] };
  }
  const r = rng(hash(seed, node.id, iteration));
  if (r() < pFail) return { status: 'failed', filled: [] };
  const filled = Array.from({ length: outputArity(graph, node.id) }, () => r() < 0.7);
  if (pWait > 0 && rng(hash(seed, node.id, iteration, 'wait'))() < pWait) return { status: 'completed', filled, suspends: true };
  return { status: 'completed', filled };
}

/**
 * Each batch node's terminal iteration, when its latest row is terminal (`loadTerminalIterations`,
 * `execution/loop-ledger.ts`): rows of a batch node are written in pass order, so only the latest
 * can end the loop. A batch node whose loop has not ended is absent.
 */
export function latestTerminal(
  ref: SettlementReference,
  rows: Iterable<ReferenceRow>,
  batchIds: readonly string[],
): Map<string, number> {
  const latest = new Map<string, ReferenceRow>();
  const asked = new Set(batchIds);
  for (const r of rows) {
    if (!asked.has(r.nodeId)) continue;
    const seen = latest.get(r.nodeId);
    if (seen === undefined || r.iteration > seen.iteration) latest.set(r.nodeId, r);
  }
  const m = new Map<string, number>();
  for (const b of batchIds) {
    const r = latest.get(b);
    if (r !== undefined && ref.isTerminalStep(r)) m.set(b, r.iteration);
  }
  return m;
}

/** `terminalIterations(S)` for every loop of the graph. */
export function terminalIterations(
  ref: SettlementReference,
  loops: readonly V2Loop[],
  rows: Iterable<ReferenceRow>,
): Map<string, number> {
  return latestTerminal(ref, rows, loops.map((l) => l.batchNodeId));
}

/**
 * R(S) (decision 13): what engine v2 plans next from the row set `rows`.
 *
 * - ∅ if any row failed: `StepSettledHandler` plans nothing once `hasFailedSteps` holds.
 * - Otherwise the union, over every completed or skipped row r, of
 *   `decideSuccessors(graph, loops, r, S, terminalIterations(S))`, less the keys S already has a
 *   row for (`createSteps` inserts a key once; a planner that got there first wins).
 *
 * `steps` is the whole row set, a superset of what `decisionKeys` names, and `terminalIterations`
 * covers every loop, a superset of `exitSourcesInto`'s; each entry is the value the handler would
 * load. The union keeps a key in both lists if two rows disagree about it, so such a split in
 * n8n's own answer surfaces in a comparison instead of being resolved here. Order is first
 * appearance; comparisons are of sets.
 */
export function referenceAnswer(
  ref: SettlementReference,
  graph: V2Graph,
  loops: readonly V2Loop[],
  rows: readonly ReferenceRow[],
): ReferencePlan {
  if (rows.some((r) => r.status === 'failed')) return { toQueue: [], toSkip: [] };
  const steps: Record<string, ReferenceRow> = {};
  for (const r of rows) steps[ref.stepKeyId(r)] = r;
  const terminal = terminalIterations(ref, loops, rows);
  const toQueue = new Map<string, StepKey>();
  const toSkip = new Map<string, StepKey>();
  for (const r of rows) {
    if (r.status !== 'completed' && r.status !== 'skipped') continue;
    const plan = ref.decideSuccessors(graph, loops, { nodeId: r.nodeId, iteration: r.iteration }, steps, terminal);
    for (const [into, keys] of [[toQueue, plan.toQueue], [toSkip, plan.toSkip]] as const) {
      for (const k of keys) {
        const id = ref.stepKeyId(k);
        if (!(id in steps)) into.set(id, { nodeId: k.nodeId, iteration: k.iteration });
      }
    }
  }
  return { toQueue: [...toQueue.values()], toSkip: [...toSkip.values()] };
}

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/** The trigger and every node it reaches (`StepSettledHandler.reachableNodeIds`). */
export function reachableOf(ref: SettlementReference, graph: V2Graph): Set<string> {
  const trigger = ref.findTriggerNode(graph);
  if (trigger === undefined) throw new Error('reachableOf: the graph has no trigger node');
  return new Set<string>([trigger.id, ...ref.getDescendantNodeIds(graph, trigger.id)]);
}

/**
 * `decideSuccessors(settled)` at the rows `rows`, loaded as `StepSettledHandler.planSuccessors`
 * loads it: the terminal iterations of the loops whose exit edges reach the settled node's direct
 * successors (`exitSourcesInto`, `loadTerminalIterations`), then the rows `decisionKeys` names
 * (`loadStepSummariesByKeys`; a key without a row is absent). No failure check: the handler makes
 * that before it plans (`hasFailedSteps`), and the caller decides whether to.
 */
export function handlerPlan(
  ref: SettlementReference,
  graph: V2Graph,
  loops: readonly V2Loop[],
  rows: Iterable<ReferenceRow>,
  settled: StepKey,
): ReferencePlan {
  const byId = new Map<string, ReferenceRow>();
  for (const r of rows) byId.set(ref.stepKeyId(r), r);
  const candidates = ref.getSuccessorNodeIds(graph, settled.nodeId);
  const terminal = latestTerminal(ref, byId.values(), ref.exitSourcesInto(graph, loops, candidates));
  const steps: Record<string, ReferenceRow> = {};
  for (const k of ref.decisionKeys(graph, loops, settled, terminal)) {
    const id = ref.stepKeyId(k);
    const r = byId.get(id);
    if (r !== undefined) steps[id] = r;
  }
  return ref.decideSuccessors(graph, loops, settled, steps, terminal);
}

/** The two numbers `finishExecutionIfDone` compares. */
export interface SettledCount {
  /** `countSettledSteps`: rows completed, failed, skipped or cancelled. */
  readonly settled: number;
  /** `countExpectedSettledSteps` over the reachable loops' terminal iterations; `undefined` while a loop runs. */
  readonly expected: number | undefined;
}

/** {@link SettledCount} at the rows `rows`. `reachable` is {@link reachableOf}. */
export function settledCount(
  ref: SettlementReference,
  loops: readonly V2Loop[],
  reachable: ReadonlySet<string>,
  rows: readonly ReferenceRow[],
): SettledCount {
  const batchIds = loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId);
  return {
    settled: rows.filter((r) => SETTLED.has(r.status)).length,
    expected: ref.countExpectedSettledSteps(loops, reachable, latestTerminal(ref, rows, batchIds)),
  };
}

/**
 * `finishExecutionIfDone`'s test at the rows `rows`: `countExpectedSettledSteps` is defined and the
 * settled rows (`countSettledSteps`) reach it.
 */
export function referenceFinished(
  ref: SettlementReference,
  loops: readonly V2Loop[],
  reachable: ReadonlySet<string>,
  rows: readonly ReferenceRow[],
): boolean {
  const { settled, expected } = settledCount(ref, loops, reachable, rows);
  return expected !== undefined && settled >= expected;
}

/** How a run ended: as the handlers record it, or drained with rows still owed. */
export type RunEnd = 'completed' | 'failed' | 'drained-unfinished';

/** One run of {@link simulate}. */
export interface RunResult {
  readonly end: RunEnd;
  /** `name#iteration=status` per row, sorted: the fate of every step. */
  readonly fates: string;
  /** `countExpectedSettledSteps` on the final rows. */
  readonly expected: number | undefined;
  /** Rows settled (completed, failed, skipped or cancelled). */
  readonly settled: number;
  /** Rows still queued at the end. */
  readonly leftQueued: number;
  /** Events handled. */
  readonly events: number;
  /** The final rows, in creation order. */
  readonly rows: readonly ReferenceRow[];
}

/** Options of one run: a callback, and the termination guard. */
export interface SimulateOptions {
  /**
   * Called with every row set the run passes through, each once: the trigger's birth row, then
   * after every event that changed a row. `rows` is a snapshot in creation order; the caller may
   * keep it.
   */
  readonly onState?: (rows: readonly ReferenceRow[]) => void;
  /**
   * Called each time `StepSettledHandler` takes a `step:settled` event for a completed or skipped
   * row, before its failure check: `rows` as they are then (the row set `onState` last reported)
   * and the settled step's key. These are the reached (S, s) of decision 13's leg (a″).
   */
  readonly onSettled?: (rows: readonly ReferenceRow[], settled: StepKey) => void;
  /** Events after which the run throws, as not terminating. Default {@link MAX_EVENTS}. */
  readonly maxEvents?: number;
}

/** A run stops with a throw after this many events: the loop did not terminate. */
export const MAX_EVENTS = 20_000;

/**
 * One run of engine v2's event loop over `graph` under `behaviour`, with event order `order`.
 *
 * `ExecutionStartHandler` writes the trigger's row completed at birth with slot 0 filled. Then, until
 * nothing is pending or the run ends, an event is drawn at random:
 * - `step:ready` (`StepReadyHandler`): claim the queued row (`running`), run it ({@link outcome}),
 *   settle it and announce `step:settled`. A step that suspends goes `waiting` instead, announces
 *   nothing, and gets a pending resume; a resumed step's claim completes it with the outputs its
 *   wait stored;
 * - `resume` (`resumeStep`, or the sweep's `resumeDueSteps`): a row still `waiting` goes back to
 *   `queued` and announces `step:ready`; a row cancelled meanwhile is left alone, as the
 *   compare-and-set on `waiting` leaves it;
 * - `step:settled` (`StepSettledHandler.handle`): a failed row, or any failed row before planning,
 *   ends the run `failed` and cancels the queued and waiting rows (`failExecution`,
 *   `cancelPendingSteps`);
 *   otherwise a completed or skipped row plans its successors through `decisionKeys` and
 *   `decideSuccessors`, and inserts the new rows (queued ones announce `step:ready`, skipped ones
 *   `step:settled`). With nothing queued, `finishExecutionIfDone` ends the run once the settled
 *   count reaches `countExpectedSettledSteps`.
 *
 * Throws after `options.maxEvents` events, {@link MAX_EVENTS} by default.
 */
export function simulate(
  ref: SettlementReference,
  graph: V2Graph,
  behaviour: Behaviour,
  order: number,
  options: SimulateOptions = {},
): RunResult {
  const loops = ref.deriveLoops(graph);
  const trigger = ref.findTriggerNode(graph);
  if (trigger === undefined) throw new Error('simulate: the graph has no trigger node');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const reachable = reachableOf(ref, graph);
  const rows = new Map<string, { -readonly [K in keyof ReferenceRow]: ReferenceRow[K] }>();
  const { onState, onSettled, maxEvents = MAX_EVENTS } = options;
  const snapshot = () => [...rows.values()].map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] }));
  const report = onState === undefined ? () => {} : () => onState(snapshot());
  let nextId = 0;
  const create = (k: StepKey, status: V2StepStatus, filled: boolean[] = []): boolean => {
    const id = ref.stepKeyId(k);
    if (rows.has(id)) return false; // the unique key (execution, node, iteration)
    rows.set(id, { nodeId: k.nodeId, iteration: k.iteration, id: String(nextId++), status, filledOutputSlots: filled });
    return true;
  };
  const batchIds = loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId);
  const pending: { kind: 'ready' | 'settled' | 'resume'; key: StepKey }[] = [];
  /** Rows a resume put back to `queued`: their next claim emits the stored outputs (`resumedOutputs`). */
  const resumed = new Set<string>();
  create({ nodeId: trigger.id, iteration: 0 }, 'completed', [true]);
  report();
  pending.push({ kind: 'settled', key: { nodeId: trigger.id, iteration: 0 } });

  const pick = rng(hash(behaviour.seed, 'order', order));
  let end: RunEnd | undefined;
  let events = 0;
  const fail = () => {
    end = 'failed';
    let cancelled = false;
    for (const r of rows.values()) {
      if (r.status === 'queued' || r.status === 'waiting') { r.status = 'cancelled'; cancelled = true; }
    }
    if (cancelled) report();
  };

  while (pending.length > 0 && end === undefined) {
    if (++events > maxEvents) throw new Error(`simulate: no termination within ${maxEvents} events`);
    const ev = pending.splice(Math.floor(pick() * pending.length), 1)[0]!;
    const row = rows.get(ref.stepKeyId(ev.key))!;
    if (ev.kind === 'resume') {
      if (row.status !== 'waiting') continue;
      row.status = 'queued';
      resumed.add(ref.stepKeyId(ev.key));
      report();
      pending.push({ kind: 'ready', key: ev.key });
      continue;
    }
    if (ev.kind === 'ready') {
      if (row.status !== 'queued') continue;
      row.status = 'running';
      report();
      const o = outcome(graph, byId.get(row.nodeId)!, row.iteration, behaviour);
      if (o.suspends === true && !resumed.has(ref.stepKeyId(ev.key))) {
        row.status = 'waiting';
        report();
        pending.push({ kind: 'resume', key: ev.key });
        continue;
      }
      row.status = o.status;
      row.filledOutputSlots = o.status === 'completed' ? o.filled : [];
      report();
      pending.push({ kind: 'settled', key: ev.key });
      continue;
    }
    if (row.status === 'failed') { fail(); break; }
    let queued = 0;
    if (row.status === 'completed' || row.status === 'skipped') {
      onSettled?.(snapshot(), { nodeId: ev.key.nodeId, iteration: ev.key.iteration });
      if ([...rows.values()].some((r) => r.status === 'failed')) { fail(); break; }
      const { toQueue, toSkip } = handlerPlan(ref, graph, loops, rows.values(), ev.key);
      let created = false;
      for (const k of toQueue) if (create(k, 'queued')) { created = true; queued++; pending.push({ kind: 'ready', key: k }); }
      for (const k of toSkip) if (create(k, 'skipped')) { created = true; pending.push({ kind: 'settled', key: k }); }
      if (created) report();
    }
    if (queued > 0) continue;
    const now = [...rows.values()];
    if (referenceFinished(ref, loops, reachable, now)) end = now.some((r) => r.status === 'failed') ? 'failed' : 'completed';
  }

  const all = [...rows.values()];
  return {
    end: end ?? 'drained-unfinished',
    fates: all.map((r) => `${byId.get(r.nodeId)!.name}#${r.iteration}=${r.status}`).sort().join(' '),
    expected: ref.countExpectedSettledSteps(loops, reachable, latestTerminal(ref, all, batchIds)),
    settled: all.filter((r) => SETTLED.has(r.status)).length,
    leftQueued: all.filter((r) => r.status === 'queued').length,
    events,
    rows: all.map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] })),
  };
}
