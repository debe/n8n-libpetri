/**
 * The reference side of the engine v2 differential (`tasks/v2-profile-plan.md` decision 13 and 15,
 * step 9; ADR 0012 §2): the event loop engine v2's `StepSettledHandler` and `StepReadyHandler` run
 * (`packages/@n8n/engine/src/execution/step-settled-handler.ts`, `step-ready-handler.ts` at the
 * pin `n8n@2.41.3`), with no database and no queue, and the answer R(S) the net's planner is
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
 *
 * Moved from `tasks/spike-v2-settlement.mts`, which imports it and reprints its first report with
 * `--baseline`. Three additions over the spike:
 * - a `running` row between the claim and the settle (`StepReadyHandler` claims `queued → running`
 *   before it runs);
 * - the `cancelled` rows `failExecution` leaves (`cancelQueuedSteps`), so a failed run's queued
 *   rows end cancelled rather than queued;
 * - the `[null, null]` batch terminal, drawn with chance {@link Behaviour.emptyTerminal}.
 *
 * The first two draw no random number, so no run's order, end or event count moves; at
 * `emptyTerminal` 0 the third draws nothing either, and every run is the spike's.
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
 * batch step fails, and `emptyTerminal` is the chance, per batch node, that its terminal step ends
 * with nothing accumulated.
 */
export interface Behaviour {
  readonly seed: number;
  readonly pFail: number;
  /** 0 reproduces the spike's baseline, where every loop ends with its done slot filled. */
  readonly emptyTerminal: number;
}

/** One step's outcome: the row status and, when completed, its filled output slots. */
export interface Outcome {
  readonly status: 'completed' | 'failed';
  readonly filled: boolean[];
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
 * chance 0.7.
 *
 * The empty-terminal draw uses its own hash, so it moves no other draw: with `emptyTerminal` 0
 * every outcome is the spike's.
 */
export function outcome(graph: V2Graph, node: V2Node, iteration: number, behaviour: Behaviour): Outcome {
  const { seed, pFail, emptyTerminal } = behaviour;
  if (node.type === 'batch') {
    const passes = 1 + (hash(seed, node.id, 'passes') % 3);
    if (iteration < passes - 1) return { status: 'completed', filled: [false, true] };
    const empty = emptyTerminal > 0 && rng(hash(seed, node.id, 'empty-terminal'))() < emptyTerminal;
    return { status: 'completed', filled: empty ? [false, false] : [true, false] };
  }
  const r = rng(hash(seed, node.id, iteration));
  if (r() < pFail) return { status: 'failed', filled: [] };
  const filled = Array.from({ length: outputArity(graph, node.id) }, () => r() < 0.7);
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
  /** Events after which the run throws, as not terminating. Default {@link MAX_EVENTS}. */
  readonly maxEvents?: number;
}

/** A run stops with a throw after this many events: the loop did not terminate. */
export const MAX_EVENTS = 20_000;

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/**
 * One run of engine v2's event loop over `graph` under `behaviour`, with event order `order`.
 *
 * `ExecutionStartHandler` writes the trigger's row completed at birth with slot 0 filled. Then, until
 * nothing is pending or the run ends, an event is drawn at random:
 * - `step:ready` (`StepReadyHandler`): claim the queued row (`running`), run it ({@link outcome}),
 *   settle it and announce `step:settled`;
 * - `step:settled` (`StepSettledHandler.handle`): a failed row, or any failed row before planning,
 *   ends the run `failed` and cancels the queued rows (`failExecution`, `cancelQueuedSteps`);
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
  const reachable = new Set<string>([trigger.id, ...ref.getDescendantNodeIds(graph, trigger.id)]);
  const rows = new Map<string, { -readonly [K in keyof ReferenceRow]: ReferenceRow[K] }>();
  const { onState, maxEvents = MAX_EVENTS } = options;
  const report = onState === undefined
    ? () => {}
    : () => onState([...rows.values()].map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] })));
  let nextId = 0;
  const create = (k: StepKey, status: V2StepStatus, filled: boolean[] = []): boolean => {
    const id = ref.stepKeyId(k);
    if (rows.has(id)) return false; // the unique key (execution, node, iteration)
    rows.set(id, { nodeId: k.nodeId, iteration: k.iteration, id: String(nextId++), status, filledOutputSlots: filled });
    return true;
  };
  const batchIds = loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId);
  const pending: { kind: 'ready' | 'settled'; key: StepKey }[] = [];
  create({ nodeId: trigger.id, iteration: 0 }, 'completed', [true]);
  report();
  pending.push({ kind: 'settled', key: { nodeId: trigger.id, iteration: 0 } });

  const pick = rng(hash(behaviour.seed, 'order', order));
  let end: RunEnd | undefined;
  let events = 0;
  const fail = () => {
    end = 'failed';
    let cancelled = false;
    for (const r of rows.values()) if (r.status === 'queued') { r.status = 'cancelled'; cancelled = true; }
    if (cancelled) report();
  };

  while (pending.length > 0 && end === undefined) {
    if (++events > maxEvents) throw new Error(`simulate: no termination within ${maxEvents} events`);
    const ev = pending.splice(Math.floor(pick() * pending.length), 1)[0]!;
    const row = rows.get(ref.stepKeyId(ev.key))!;
    if (ev.kind === 'ready') {
      if (row.status !== 'queued') continue;
      row.status = 'running';
      report();
      const o = outcome(graph, byId.get(row.nodeId)!, row.iteration, behaviour);
      row.status = o.status;
      row.filledOutputSlots = o.status === 'completed' ? o.filled : [];
      report();
      pending.push({ kind: 'settled', key: ev.key });
      continue;
    }
    if (row.status === 'failed') { fail(); break; }
    let queued = 0;
    if (row.status === 'completed' || row.status === 'skipped') {
      if ([...rows.values()].some((r) => r.status === 'failed')) { fail(); break; }
      const candidates = ref.getSuccessorNodeIds(graph, row.nodeId);
      const terminal = latestTerminal(ref, rows.values(), ref.exitSourcesInto(graph, loops, candidates));
      const keys = ref.decisionKeys(graph, loops, ev.key, terminal);
      const steps: Record<string, ReferenceRow> = {};
      for (const k of keys) { const r = rows.get(ref.stepKeyId(k)); if (r) steps[ref.stepKeyId(k)] = r; }
      const { toQueue, toSkip } = ref.decideSuccessors(graph, loops, ev.key, steps, terminal);
      let created = false;
      for (const k of toQueue) if (create(k, 'queued')) { created = true; queued++; pending.push({ kind: 'ready', key: k }); }
      for (const k of toSkip) if (create(k, 'skipped')) { created = true; pending.push({ kind: 'settled', key: k }); }
      if (created) report();
    }
    if (queued > 0) continue;
    const expected = ref.countExpectedSettledSteps(loops, reachable, latestTerminal(ref, rows.values(), batchIds));
    if (expected === undefined) continue;
    const settled = [...rows.values()].filter((r) => SETTLED.has(r.status)).length;
    if (settled >= expected) end = [...rows.values()].some((r) => r.status === 'failed') ? 'failed' : 'completed';
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
