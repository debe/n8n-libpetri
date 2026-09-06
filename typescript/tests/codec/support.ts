/**
 * Harness for the codec suite: marking builders over a `CompiledWorkflow`, n8n state
 * builders, a seeded PRNG (hand-rolled; fast-check is not a dependency), two random
 * generators — n8n-consistent `executionData` and quiescent pause markings — a semantic
 * projection of a marking (the pending activations per node, whichever place holds them)
 * for the marking-first round trip, and the shape assertions a legacy consumer
 * (`stack-scheduler.ts`) relies on.
 */
import { Marking, tokenAt, unitToken, type Place, type Token } from 'libpetri';
import type { IExecuteData, INode, INodeExecutionData, IRunData, ISourceData, ITaskData, Workflow } from 'n8n-workflow';
import { entryForEdge } from '../../src/codec.js';
import { readySlot, type CompiledWorkflow, type InputGadget, type NodeGadget } from '../../src/compiler/index.js';
import type { ExecutionDataState } from '../../src/n8n/host.js';
import {
  isEdgePayload, isEntryPayload,
  type EdgePayload, type EntryPayload, type RetryPayload, type StoppedPayload, type WaitingPayload,
} from '../../src/scheduler/index.js';
import { items } from '../scheduler/support.js';

export type MarkingMap = Map<Place<unknown>, Token<unknown>[]>;
export type SlotMain = Array<INodeExecutionData[] | null>;
export type SlotSource = Array<ISourceData | null>;

// ==================== markings ====================

/** Place name → token count of a marking map. */
export function named(m: MarkingMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, tokens] of m) if (tokens.length > 0) out[p.name] = tokens.length;
  return out;
}

/** Place name → token count of a live `Marking`, over the compiled net's places. */
export function namedLive(c: CompiledWorkflow, m: Marking): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of c.net.places) {
    const n = m.tokenCount(p);
    if (n > 0) out[p.name] = n;
  }
  return out;
}

export function live(m: MarkingMap): Marking {
  return Marking.from(m);
}

/** Appends tokens: `null` becomes the unit token, anything else a token stamped `createdAt`. */
export function put(m: MarkingMap, place: Place<unknown>, values: readonly unknown[], createdAt = 1): void {
  const q = m.get(place) ?? [];
  for (const v of values) q.push(v === null ? (unitToken() as Token<unknown>) : tokenAt<unknown>(v, createdAt));
  m.set(place, q);
}

export function values(m: MarkingMap, place: Place<unknown>): unknown[] {
  return (m.get(place) ?? []).map((t) => t.value);
}

export function gadget(c: CompiledWorkflow, name: string): NodeGadget {
  return c.netMap.node(name);
}

export function placeNamed(c: CompiledWorkflow, name: string): Place<unknown> {
  const p = c.netMap.place(name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p.place;
}

/** The consumer-owned data place of the connection `from.outputIndex -> to.inputIndex`. */
export function edgeData(c: CompiledWorkflow, from: string, outputIndex: number, to: string, inputIndex: number): Place<unknown> {
  const g = gadget(c, to);
  if (g.form === 'direct') return g.in!;
  for (const i of g.inputs) {
    for (const e of i.edges) {
      if (e.edge.from === from && e.edge.outputIndex === outputIndex && e.edge.inputIndex === inputIndex) return e.data;
    }
  }
  throw new Error(`no edge ${from}.${outputIndex} -> ${to}.${inputIndex}`);
}

// ==================== n8n state ====================

export function src(previousNode: string, previousNodeOutput = 0, previousNodeRun = 0): ISourceData {
  return { previousNode, previousNodeOutput, previousNodeRun };
}

export function edge(data: INodeExecutionData[], source: ISourceData | null = null): EdgePayload {
  return { kind: 'edge', items: data, source };
}

export function entryPayload(executionData: IExecuteData): EntryPayload {
  return { kind: 'entry', executionData };
}

/** A stack entry in n8n's multi-input shape: `data.main` per input, `source.main` alongside (`null` = no source). */
export function entryFor(node: INode, main: SlotMain, sources: SlotSource | null = main.map(() => null)): IExecuteData {
  return { node, data: { main }, source: sources === null ? null : { main: sources } };
}

export function emptyState(): ExecutionDataState {
  return { contextData: {}, metadata: {}, nodeExecutionStack: [], waitingExecution: {}, waitingExecutionSource: {} } as unknown as ExecutionDataState;
}

export function stateOf(
  stack: IExecuteData[],
  waiting: ExecutionDataState['waitingExecution'] = {},
  waitingSource: NonNullable<ExecutionDataState['waitingExecutionSource']> = {},
): ExecutionDataState {
  const s = emptyState();
  s.nodeExecutionStack = stack;
  s.waitingExecution = waiting;
  s.waitingExecutionSource = waitingSource;
  return s;
}

/** A recorded run, as `runData[node]` holds it (only its presence matters to the codec). */
export function taskData(data: INodeExecutionData[] = items({})): ITaskData {
  return { startTime: 1, executionTime: 1, executionStatus: 'success', source: [], data: { main: [data] } } as unknown as ITaskData;
}

/** `waitingExecution[node]` slots in ascending run index, as arrays (renumbering-insensitive). */
export function slotsOf<T>(byNode: Record<string, Record<number, T>> | null | undefined, node: string): T[] {
  const slots = byNode?.[node];
  if (slots === undefined) return [];
  return Object.keys(slots).map(Number).sort((a, b) => a - b).map((k) => slots[k]!);
}

// ==================== legacy consumer shape ====================

/**
 * What `stack-scheduler.ts` (n8n `441970b`) reads off the state: `entry.node` is the live
 * `workflow.nodes[name]`, `entry.data.main` an array of item arrays or `null`, `entry.source`
 * `null` or `{ main: (ISourceData | null)[] }`, `runIndex` unset (`computeRunIndex`), and
 * `waitingExecution[node][k].main` / `waitingExecutionSource[node][k].main` one slot per
 * input (R6, lines 2645–2740). `pauseMode` adds n8n's own invariant that a complete
 * multi-input slot never stays in `waitingExecution` (`allDataFound` moves it to the stack).
 */
export function assertLegacyShape(x: ExecutionDataState, workflow: Workflow, c: CompiledWorkflow, pauseMode = true): void {
  for (const e of x.nodeExecutionStack) {
    const liveNode = workflow.nodes[e.node.name];
    expect(liveNode, `stack entry names a workflow node`).toBeDefined();
    expect(e.node).toBe(liveNode);
    expect(Array.isArray(e.data.main)).toBe(true);
    for (const input of e.data.main!) expect(input === null || Array.isArray(input)).toBe(true);
    if (e.source !== null) {
      expect(Array.isArray(e.source.main)).toBe(true);
      for (const s of e.source.main!) expect(s === null || typeof s.previousNode === 'string').toBe(true);
    }
    expect(e.runIndex).toBeUndefined();
    expect(e.metadata === undefined || typeof e.metadata === 'object').toBe(true);
  }
  for (const [name, slots] of Object.entries(x.waitingExecution)) {
    expect(workflow.nodes[name]).toBeDefined();
    const g = gadget(c, name);
    const inputCount = g.form === 'direct' ? (c.netMap.place(g.in!.name)?.edge?.inputIndex ?? 0) + 1 : Math.max(1, ...g.inputs.map((i) => i.index + 1));
    for (const [k, slot] of Object.entries(slots)) {
      expect(Number.isInteger(Number(k))).toBe(true);
      expect(slot.main).toHaveLength(inputCount);
      for (const input of slot.main!) expect(input === null || Array.isArray(input)).toBe(true);
      const source = x.waitingExecutionSource?.[name]?.[Number(k)];
      expect(source, `waitingExecutionSource[${name}][${k}] mirrors the slot`).toBeDefined();
      expect(source!.main).toHaveLength(inputCount);
      for (const s of source!.main!) expect(s === null || typeof s.previousNode === 'string').toBe(true);
      if (pauseMode && g.form !== 'direct' && g.form !== 'or') {
        const complete = g.inputs.every((i) => slot.main![i.index] !== null);
        const anyData = g.inputs.some((i) => (slot.main![i.index]?.length ?? 0) > 0);
        expect(complete && anyData, `no complete slot with data stays in waitingExecution (${name}[${k}])`).toBe(false);
      }
    }
  }
}

// ==================== the semantic projection ====================

/**
 * The pending activations of every node, in the encoder's emission order, whichever
 * place holds them: an `IExecuteData` for a waiting / stopped / retry / running token, a
 * direct or OR arrival (the entry `X_start` would build) and a complete or entry-headed
 * join slot; `{ partial }` for a partial join slot. Plus the control counts the codec
 * re-seeds. `_budget` (a retry holds a unit that decode re-seeds), `_pause` (a resumed net
 * is not paused) and `X/skipped` (rebuilt from reachability) are deliberately outside it.
 */
export function view(c: CompiledWorkflow, m: Marking, nodeOf: (name: string) => INode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const g of c.netMap.nodes) {
    const acts: unknown[] = [];
    const entryOf = (inputIndex: number, v: unknown): unknown => {
      if (isEntryPayload(v)) return { entry: v.executionData };
      if (isEdgePayload(v)) return { entry: entryForEdge(nodeOf(g.node), inputIndex, v) };
      return { unit: true };
    };
    for (const t of m.peekTokens(g.waiting)) acts.push({ entry: (t.value as WaitingPayload).executionData });
    for (const t of m.peekTokens(g.stopped)) {
      const v = t.value as StoppedPayload;
      if (!v.ran) acts.push({ entry: v.executionData });
    }
    if (g.retry !== null) for (const t of m.peekTokens(g.retry)) acts.push({ entry: (t.value as RetryPayload).executionData });
    const controls: Record<string, unknown> = { idle: m.tokenCount(g.idle), done: m.tokenCount(g.done) };
    if (g.tries !== null) controls.tries = m.tokenCount(g.tries);
    if (g.form === 'direct') {
      const idx = c.netMap.place(g.in!.name)?.edge?.inputIndex ?? 0;
      for (const t of m.peekTokens(g.in!)) acts.push(entryOf(idx, t.value));
    } else if (g.form === 'or') {
      const i = g.inputs[0]!;
      for (const t of m.peekTokens(i.hasdata!)) acts.push(entryOf(i.index, t.value));
      controls.ready = m.tokenCount(i.ready!);
      controls.ran = m.tokenCount(i.ran!) > 0;
    } else {
      const queues = g.inputs.map((i) => {
        const q: Array<{ value: unknown; seed: boolean }> = [];
        for (const p of [i.ready, i.readyData, i.readyEmpty]) {
          if (p === null) continue;
          // The shared marking's seeded empty of an input fed only by unreachable producers:
          // a control token, not an arrival. The encoder drops a node whose whole join
          // content is seeds (it re-seeds on decode) and a decoded activation replaces it,
          // so the projection has to leave those rows out on both sides.
          const seed = i.seedEmpty && (p === i.ready || p === i.readyEmpty);
          for (const t of m.peekTokens(p)) q.push({ value: t.value, seed: seed && !isEdgePayload(t.value) && !isEntryPayload(t.value) });
        }
        for (const e of i.edges) {
          for (const t of m.peekTokens(e.data)) q.push({ value: t.value, seed: false });
          if (e.empty !== null) for (const t of m.peekTokens(e.empty)) q.push({ value: t.value, seed: false });
        }
        return q;
      });
      const depth = queues.every((q) => q.every((c) => c.seed)) ? 0 : Math.max(0, ...queues.map((q) => q.length));
      const inputCount = Math.max(1, ...g.inputs.map((i) => i.index + 1));
      for (let j = 0; j < depth; j++) {
        const cells = queues.map((q) => q[j]?.value);
        const entry = cells.find((v) => isEntryPayload(v)) as EntryPayload | undefined;
        if (entry !== undefined) {
          acts.push({ entry: entry.executionData });
          continue;
        }
        const main: SlotMain = Array.from({ length: inputCount }, () => null);
        const sources: SlotSource = Array.from({ length: inputCount }, () => null);
        g.inputs.forEach((i, k) => {
          const v = cells[k];
          if (v === undefined) return;
          if (isEdgePayload(v)) {
            main[i.index] = v.items;
            sources[i.index] = v.source;
          } else {
            main[i.index] = [];
          }
        });
        const anyData = cells.some((v) => isEdgePayload(v));
        if (anyData && cells.every((v) => v !== undefined)) acts.push({ entry: { node: nodeOf(g.node), data: { main }, source: { main: sources } } });
        else acts.push({ partial: main, sources }); // a complete all-empty slot is a skip, not an activation
      }
      // Every complete row and every waiting / stopped / retry activation of a join is an
      // n8n stack entry, which decode heads as an entry slot (free_i withheld, one hasdata):
      // the activations are equal, and these two controls are comparable only for a node
      // whose pending work is partial slots alone.
      if (!acts.some((a) => typeof a === 'object' && a !== null && 'entry' in a)) {
        for (const i of g.inputs) controls[`free_${i.index}`] = m.tokenCount(i.free!);
        if (g.hasdata !== null) controls.hasdata = m.tokenCount(g.hasdata) > 0;
      }
    }
    out[g.node] = { activations: acts, controls };
  }
  return out;
}

// ==================== seeded randomness ====================

/** mulberry32. */
export class Rng {
  constructor(private s: number) {}

  next(): number {
    let t = (this.s = (this.s + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
}

let itemSeq = 0;

export function freshItems(rng: Rng): INodeExecutionData[] {
  return items(...Array.from({ length: 1 + rng.int(2) }, () => ({ v: itemSeq++ })));
}

/** A random recorded source of input `i` (a producer edge), or `null` a quarter of the time. */
function randomSource(rng: Rng, edges: ReadonlyArray<{ edge: { from: string; outputIndex: number } }>): ISourceData | null {
  if (edges.length === 0 || rng.bool(0.25)) return null;
  const e = rng.pick(edges);
  return src(e.edge.from, e.edge.outputIndex, 0);
}

function producerEdges(c: CompiledWorkflow, g: NodeGadget, i?: InputGadget) {
  if (g.form === 'direct') {
    const e = c.netMap.place(g.in!.name)?.edge;
    return e === undefined ? [] : [{ edge: e }];
  }
  return (i ?? g.inputs[0]!).edges;
}

/** README "OR-inputs": a delivery over a tree edge from a reachable producer counts towards the round. */
export function countsTowardRound(c: CompiledWorkflow, i: InputGadget, source: ISourceData | null): boolean {
  if (source === null) return false;
  const e = i.edges.find((s) => s.edge.from === source.previousNode && s.edge.outputIndex === (source.previousNodeOutput ?? 0));
  return e !== undefined && e.empty !== null && c.analysis.reachable.has(source.previousNode);
}

/** n8n's entry for a fresh activation of `g`: single-input shape, or a complete multi-input slot. */
export function randomEntry(rng: Rng, c: CompiledWorkflow, g: NodeGadget, node: INode): IExecuteData {
  if (g.form === 'direct' || g.form === 'or') {
    const idx = g.form === 'direct' ? (c.netMap.place(g.in!.name)?.edge?.inputIndex ?? 0) : g.inputs[0]!.index;
    return entryForEdge(node, idx, edge(freshItems(rng), randomSource(rng, producerEdges(c, g))));
  }
  const inputCount = Math.max(1, ...g.inputs.map((i) => i.index + 1));
  const main: SlotMain = Array.from({ length: inputCount }, () => null);
  const sources: SlotSource = Array.from({ length: inputCount }, () => null);
  for (const i of g.inputs) {
    if (i.emptyCapable && rng.bool(0.3)) {
      main[i.index] = [];
    } else {
      main[i.index] = freshItems(rng);
      sources[i.index] = randomSource(rng, i.edges);
    }
  }
  return entryFor(node, main, sources);
}

export interface RandomState {
  readonly state: ExecutionDataState;
  readonly runData: IRunData;
}

/**
 * n8n-consistent `executionData`: stack entries (the primary start node first, as n8n's
 * stack has it, then the encoder's canonical order), partial `waitingExecution` slots that
 * follow the first-fit discipline (per input a contiguous prefix of slots, at least one
 * input never filled — a complete slot never stays in `waitingExecution`), `[]` round
 * slots for OR nodes, arbitrary run indexes (renumbering), and random `runData`.
 */
export function randomExecutionData(rng: Rng, c: CompiledWorkflow, wf: Workflow): RandomState {
  const nodes = c.netMap.nodes;
  const gen: Array<{ entry: IExecuteData; depth: number; canvas: number; seq: number }> = [];
  const waiting: ExecutionDataState['waitingExecution'] = {};
  const waitingSource: NonNullable<ExecutionDataState['waitingExecutionSource']> = {};
  const runData: IRunData = {};
  let seq = 0;
  nodes.forEach((g, canvas) => {
    const node = wf.nodes[g.node]!;
    const isJoin = g.form === 'join' || g.form === 'choose-branch';
    const everyInputWired = g.inputs.every((i) => i.edges.length > 0);
    let entries = rng.bool(0.6) ? 0 : 1 + rng.int(2);
    if (isJoin && !everyInputWired) entries = Math.min(entries, 1);
    for (let n = 0; n < entries; n++) gen.push({ entry: randomEntry(rng, c, g, node), depth: g.depth, canvas, seq: seq++ });
    // The input left unfilled must not be a seeded one: its seeded empty would head the
    // slot on decode and complete it (the R6 substitution done once, ADR 0005), which is the
    // intended transformation, not a round trip. A `[]` is generated only as a slot head
    // (no entries ahead, a single slot on that input): a queued `[]` sits on the edge's
    // `empty` place and is re-paired after queued data (codec header, divergence #8).
    const unseeded = g.inputs.filter((i) => !i.seedEmpty);
    if (isJoin && rng.bool(0.5) && g.inputs.length > 1 && unseeded.length > 0) {
      const missing = rng.pick(unseeded);
      const lengths = new Map<number, number>();
      for (const i of g.inputs) lengths.set(i.index, i === missing || i.edges.length === 0 ? 0 : rng.int(3));
      const depth = Math.max(...lengths.values());
      const inputCount = Math.max(1, ...g.inputs.map((i) => i.index + 1));
      let k = rng.int(3);
      for (let j = 0; j < depth; j++) {
        const main: SlotMain = Array.from({ length: inputCount }, () => null);
        const sources: SlotSource = Array.from({ length: inputCount }, () => null);
        for (const i of g.inputs) {
          if (j >= lengths.get(i.index)!) continue;
          const emptyHeadOk = g.form === 'choose-branch' && i.required ? i.readyEmpty !== null : true;
          const headOnly = j === 0 && entries === 0 && lengths.get(i.index) === 1;
          // On a seeded input a `[]` head is the seed itself (not written back): data only there.
          if (headOnly && emptyHeadOk && !i.seedEmpty && rng.bool(0.3)) {
            main[i.index] = [];
          } else {
            main[i.index] = freshItems(rng);
            sources[i.index] = randomSource(rng, i.edges);
          }
        }
        (waiting[g.node] ??= {})[k] = { main };
        (waitingSource[g.node] ??= {})[k] = { main: sources };
        k += 1 + (rng.bool(0.3) ? 1 + rng.int(3) : 0);
      }
    }
    if (g.form === 'or' && rng.bool(0.4)) {
      const i = g.inputs[0]!;
      const n = 1 + rng.int(2);
      let k = rng.int(2);
      for (let j = 0; j < n; j++) {
        const main: SlotMain = Array.from({ length: i.index + 1 }, () => null);
        main[i.index] = [];
        (waiting[g.node] ??= {})[k] = { main };
        (waitingSource[g.node] ??= {})[k] = { main: Array.from({ length: i.index + 1 }, () => null) };
        k += 1 + rng.int(2);
      }
    }
    if (rng.bool(0.3)) runData[g.node] = [taskData()];
  });
  gen.sort((x, y) => (y.depth - x.depth) || (x.canvas - y.canvas) || (x.seq - y.seq));
  return { state: stateOf(gen.map((e) => e.entry), waiting, waitingSource), runData };
}

export interface RandomMarking {
  readonly marking: MarkingMap;
  readonly runData: IRunData;
}

/**
 * A quiescent pause marking over `sharedMarking()`: at most one waiting node, stopped
 * (`ran: false`) and retry tokens, direct / OR arrivals (edge or entry payloads), OR round
 * counters consistent with the seeds and the counted arrivals (with `X/ran_i` backed by
 * `runData`), join slots (a head per input — data, empty where the input can carry one, or
 * an entry with unit companions — plus arrivals queued on the first edge place), `X/done`
 * for every node with `runData`. Token timestamps increase in emission order so the
 * encoder's FIFO tiebreak agrees with the generation order.
 */
export function randomPauseMarking(rng: Rng, c: CompiledWorkflow, wf: Workflow): RandomMarking {
  const m = c.sharedMarking();
  const runData: IRunData = {};
  let clock = 1000;
  const tick = (): number => clock++;
  const nodes = c.netMap.nodes;
  const activation = (g: NodeGadget): IExecuteData => randomEntry(rng, c, g, wf.nodes[g.node]!);
  const unitTok = (): Token<unknown> => unitToken() as Token<unknown>;
  const addTok = (p: Place<unknown>, v: unknown): void => { m.set(p, [...(m.get(p) ?? []), v === null ? unitTok() : tokenAt<unknown>(v, tick())]); };
  const count = (p: Place<unknown> | null): number => (p === null ? 0 : (m.get(p)?.length ?? 0));
  const arrival = (g: NodeGadget, i?: InputGadget): unknown =>
    (rng.bool(0.3) ? entryPayload(activation(g)) : edge(freshItems(rng), randomSource(rng, producerEdges(c, g, i))));

  for (const g of nodes) if (rng.bool(0.3)) runData[g.node] = [taskData()];
  // The node-level activations (waiting, stopped before the run, retrying): every one of
  // them was armed once, so for an OR node its delivery is part of the round.
  const nodeLevel = new Map<NodeGadget, IExecuteData[]>();
  const nodeActivation = (g: NodeGadget): IExecuteData => {
    const e = activation(g);
    nodeLevel.set(g, [...(nodeLevel.get(g) ?? []), e]);
    return e;
  };
  let paused = false;
  if (rng.bool(0.5)) {
    const g = rng.pick(nodes);
    const v: WaitingPayload = { executionData: nodeActivation(g) };
    addTok(g.waiting, v);
    paused = true;
  }
  for (const g of nodes) {
    if (rng.bool(0.15)) {
      const v: StoppedPayload = { executionData: nodeActivation(g), ran: false };
      addTok(g.stopped, v);
      paused = true;
    }
    if (g.retry !== null && rng.bool(0.3)) {
      const v: RetryPayload = {
        executionData: nodeActivation(g), attempt: 1, taskStartedData: { startTime: 1, executionIndex: 0, source: [], hints: [] } as never,
        reason: { kind: 'error', error: new Error('retrying') },
      };
      addTok(g.retry, v);
    }
    if (g.form === 'direct') {
      for (let n = rng.int(3); n > 0; n--) addTok(g.in!, arrival(g));
    } else if (g.form === 'or') {
      const i = g.inputs[0]!;
      let counted = (nodeLevel.get(g) ?? []).filter((e) => countsTowardRound(c, i, e.source?.main?.[0] ?? null)).length;
      for (let n = rng.int(3); n > 0; n--) {
        const v = arrival(g, i);
        addTok(i.hasdata!, v);
        const source = isEdgePayload(v) ? v.source : (v as EntryPayload).executionData.source?.main?.[0] ?? null;
        if (countsTowardRound(c, i, source)) counted++;
      }
      for (let n = counted + rng.int(2); n > 0; n--) addTok(i.ready!, null);
      // An acyclic OR node has one round: a recorded run with the round open means it ran in it.
      if (count(i.ready) > 0 && runData[g.node] !== undefined) addTok(i.ran!, null);
    } else {
      const everyInputWired = g.inputs.every((i) => i.edges.length > 0);
      const headed = new Set<number>();
      if (rng.bool(0.2)) {
        // An entry-headed slot: the entry on the first input's data slot, unit companions elsewhere.
        g.inputs.forEach((i, k) => {
          m.delete(i.free!);
          for (const p of [i.ready, i.readyData, i.readyEmpty]) if (p !== null) m.delete(p);
          addTok(readySlot(g, i, 'data'), k === 0 ? entryPayload(activation(g)) : null);
          headed.add(i.index);
        });
        if (g.hasdata !== null) addTok(g.hasdata, null);
      } else {
        const heads = new Map<number, 'none' | 'data' | 'empty' | 'seeded'>();
        for (const i of g.inputs) {
          const seeded = count(i.ready) + count(i.readyData) + count(i.readyEmpty) > 0;
          const emptyHeadOk = g.form === 'choose-branch' && i.required ? i.readyEmpty !== null : true;
          heads.set(i.index, seeded ? 'seeded' : rng.pick(['none', 'data', 'data', emptyHeadOk ? 'empty' : 'none'] as const));
        }
        // A complete all-empty head row is a skip the net fires before it quiesces (only
        // `close()` freezes one); with rows queued behind it the skip/run order has no n8n
        // shape. Keep the generator on quiescent states: one head carries data.
        if ([...heads.values()].every((h) => h !== 'none') && ![...heads.values()].includes('data')) {
          const flip = g.inputs.find((i) => heads.get(i.index) === 'empty');
          if (flip !== undefined) heads.set(flip.index, 'data');
        }
        for (const i of g.inputs) {
          const head = heads.get(i.index)!;
          if (head === 'none') continue;
          headed.add(i.index);
          if (head !== 'seeded') {
            m.delete(i.free!);
            if (head === 'data') {
              addTok(readySlot(g, i, 'data'), edge(freshItems(rng), randomSource(rng, i.edges)));
              if (g.hasdata !== null) addTok(g.hasdata, null);
            } else {
              addTok(readySlot(g, i, 'empty'), null);
            }
          }
          if (i.edges.length > 0 && rng.bool(0.4)) {
            // A node-level activation heads the slots on decode and pushes an empty head into
            // the queued zone, where data is re-paired ahead of it (codec header): keep the
            // generator off that documented corner.
            const dataOk = head === 'data' || (nodeLevel.get(g) ?? []).length === 0;
            const emptyEdge = i.edges.find((e) => e.empty !== null);
            if (emptyEdge !== undefined && (rng.bool(0.3) || !dataOk)) addTok(emptyEdge.empty!, null);
            else if (dataOk) addTok(i.edges[0]!.data, edge(freshItems(rng), randomSource(rng, i.edges)));
          }
        }
      }
      // A second entry queues behind a busy slot: every input must be headed (free_i withheld,
      // or the arm would fire) and have an edge to queue on.
      if (everyInputWired && g.inputs.every((i) => headed.has(i.index)) && rng.bool(0.15)) {
        g.inputs.forEach((i, k) => addTok(i.edges[0]!.data, k === 0 ? entryPayload(activation(g)) : null));
      }
    }
  }
  for (const g of nodes) if (runData[g.node] !== undefined) addTok(g.done, null);
  if (paused) addTok(c.netMap.shared.pause, null);
  return { marking: m, runData };
}
