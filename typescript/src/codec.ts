/**
 * The marking codec (ADR 0005): the quiescent marking ↔ n8n's own
 * `IRunExecutionData.executionData` (`nodeExecutionStack`, `waitingExecution`,
 * `waitingExecutionSource`). n8n stays the system of record; nothing of the net is
 * persisted. The scheduler decodes on every `run()` and encodes at quiescence when the net
 * paused (`X/waiting`, `X/stopped`, `_pause`), was cancelled, or left tokens stranded.
 *
 * **Decoding** ({@link decodeExecutionData}) layers n8n's state over
 * `compiled.sharedMarking()` (`_budget` × k, `X/idle`, `X/free_i`, `X/tries`, the seeded
 * empties of inputs fed only by unreachable producers, the seeded `Y/skipped`):
 *
 * | n8n | marking |
 * |---|---|
 * | stack entry, direct-form node | an {@link EntryPayload} on `X/in` (FIFO) |
 * | stack entry, OR-form node | an {@link EntryPayload} on `X/hasdata_i`; a source over a tree edge from a reachable producer is one delivery of the round (`X/ready_i` + 1) |
 * | stack entry, join / choose-branch node | the entry on the first input's data slot, a unit companion on every other input's data slot, one unit on the generic join's `X/hasdata`; `X/free_i` withheld; the head replaces the seeded empty of an unreachable input — literally what `initialMarking` builds for the start node's own entry |
 * | `waitingExecution[X][k].main[i]` items | an {@link EdgePayload} (`source` from `waitingExecutionSource`) on `X/ready_i` (`X/ready_i_data` for a required choose-branch input) plus one `X/hasdata` unit on a generic join |
 * | `waitingExecution[X][k].main[i] = []` | a unit on `X/ready_i` (`X/ready_i_empty`): n8n's "arrived empty" |
 * | `waitingExecution[X][k].main[i] = null` | nothing (not arrived) |
 * | `waitingExecution[C][k].main = [[]]`, OR-form node | one delivery of the open round (`X/ready_i` + 1) |
 * | `runData[Y]` non-empty | `Y/done` |
 *
 * Slots are read per input in ascending `k` into the input's FIFO: the first arrival takes
 * the `ready` place (its seeded empty, if any, goes; `free_i` is withheld so
 * `free_i + ready_i ≤ 1` holds from the first marking on) and every later one queues on the
 * input's first edge place, behind `free_i`, as a live second arrival would (ADR 0003; the
 * arm forwards the payload). Pairing is positional per input, which is what both the join
 * gadget and n8n's first-fit allocator do. Queued data keeps its order (one FIFO); a queued
 * `[]` sits on the edge's `empty` place and the arms fire data before empty when `free_i`
 * returns, so mixed queued arrivals behind a busy slot are re-paired in that order — the
 * same tie-break the live net applies to arrivals waiting simultaneously (positional class,
 * divergence #8). The seeded empty of an input fed only by unreachable producers is a
 * **one-off**: `sharedMarking()` re-creates exactly one per decode, the first decoded head of
 * that input consumes it, and it is never written back (encode drops a join whose whole
 * content is seeds). It is R6's `null → []` substitution done once, and an n8n stack entry
 * already carries that `[]` in its own `data.main[i]`; queuing the seed behind such an entry
 * would apply the substitution twice and strand a token once the entry had run.
 * An OR-form node whose round is open and that has
 * a recorded run gets one `X/ran_i` marker (the round closes with `X_clear`, not a skip).
 * A referenced node without a recorded run that no pending activation can reach is seeded
 * `Y/skipped` (README "Expression references"): the referencing node must fail with n8n's
 * own error, not strand on its read arc.
 *
 * **Encoding** ({@link encodeMarking}) is the inverse. Only `nodeExecutionStack`,
 * `waitingExecution` and `waitingExecutionSource` are rewritten:
 *
 * | marking | n8n |
 * |---|---|
 * | `X/waiting` | `nodeExecutionStack[0]`: the node's own `executionData` (n8n `pushExecutionStack`) |
 * | `X/stopped` with `ran: false`, `X/retry` (pause, cancelled), `X/running` (cancelled) | a stack entry (the activation re-runs from scratch; the budget a retry held is re-seeded on decode) |
 * | `X/failed_i` (pause, cancelled), `X/timedout_i` (cancelled), `X/running_i` (cancelled) | a stack entry, as `X/retry` and `X/running` are — the attempt *position* is not persisted, so the activation resumes at its first attempt (ADR 0009) |
 * | `X/in` / `X/hasdata_i` data token | a stack entry: `{ node, data: { main }, source: { main: [source] } }` with `main[inputIndex]` the items and `null` below (n8n `addNodeToBeExecuted`); an entry verbatim |
 * | complete join slot (every input has a token, at least one with data) | a stack entry `{ node, data: { main: items \| [] per input }, source: { main } }`; an entry-headed slot is the entry verbatim |
 * | partial join slot; complete all-empty slot (a skip, seen under `cancelled` only) | `waitingExecution[X][k]` / `waitingExecutionSource[X][k]`: items + source, `[]` + `null`, `null` |
 * | OR round: `X/ready_i` beyond the pending arrivals and the seeds | `waitingExecution[C][k] = { main: [[]] }` per delivery |
 * | `X/ok_o` (per-output routing, cancelled only) | routed by the encoder as `X_route_o` would have: the arrivals join their consumers' inputs |
 * | `_pause`, `_budget`, `_halt`, `X/idle`, `X/free_i`, `X/tries`, `X/done`, `X/skipped`, `X/ran_i`, `X/hasdata` (counter), `X/routed(_o)`, `X/nil_o`, `X/stopped` with `ran: true`, a join slot holding nothing but seeded empties | discarded (re-seeded on decode) |
 *
 * Stack order: the waiting node first, then depth descending, canvas order, token FIFO —
 * the deepest pending node first, which is where n8n's LIFO stack (`unshift`) has it.
 * `waitingExecution` slots are numbered `0…` per node in positional order (n8n's run
 * indexes are renumbered; nothing reads them but the allocator).
 *
 * Modes: `pause` (default) and `cancelled` produce the stack; `stranded` (natural
 * quiescence with leftovers, divergence #2) writes every pending token to
 * `waitingExecution` — n8n's own stuck-slot shape — never to the stack, and reports each
 * through `onDiagnostic`. A token on a place the net drains on its own before quiescence
 * (`X/running`, `X/routed(_o)`, `X/ok_o`, `X/in_empty`, an OR input's edge places in
 * `pause` and `stranded`; `X/retry` in `stranded`) is a {@link CodecError} naming the place:
 * the net must be drained before encoding. `cancelled` (`executor.close()`, ENV-013) is the
 * one mode that legitimately sees them, which is why the scheduler also uses it for the two
 * markings a `close()` can have caught mid-flight: a pause raced by a cancellation, and the
 * quiescent marking of a halted run, which keeps every pending activation where it was
 * delivered because nothing reaps it (`compiler/compile.ts`).
 *
 * Round trips: `encode(decode(x))` reproduces n8n's `x` up to slot renumbering and the
 * canonical stack order; `decode(encode(m))` reproduces the pending activations of `m`
 * (`tests/codec/roundtrip.test.ts`).
 */
import { tokenOf, unitToken, type Marking, type Place, type Token } from 'libpetri';
import type {
  IExecuteData, INodeExecutionData, IRunData, ISourceData, ITaskDataConnections, ITaskDataConnectionsSource,
  IWaitingForExecution, IWaitingForExecutionSource,
} from 'n8n-workflow';
import { readySlot, type CompiledWorkflow, type InputGadget, type NodeGadget, type Variant } from './compiler/index.js';
import type { ExecutionDataState } from './n8n/host.js';
import {
  isDispatchPayload, isEdgePayload, isEntryPayload, isRequestPayload, isRoundPayload,
  type EdgePayload, type EntryPayload, type OkPayload, type RequestPayload, type RetryPayload,
  type RoundPayload, type RunPayload, type StoppedPayload, type WaitingPayload,
} from './scheduler/payloads.js';

export type {
  DispatchPayload, EdgePayload, EntryPayload, InputPayload, OkPayload, RequestPayload, ResponsePayload,
  RetryPayload, RoundPayload, RunPayload, StoppedPayload, WaitingPayload,
} from './scheduler/payloads.js';

/** A marking the codec cannot encode or n8n state it cannot decode; the message names node and place. */
export class CodecError extends Error {
  constructor(what: string) {
    super(`n8n-libpetri codec: ${what}`);
    this.name = 'CodecError';
  }
}

export interface DecodeOptions {
  /** `resultData.runData`: every node with a recorded run gets its `X/done` marker (and an open OR round its `X/ran_i`). */
  readonly runData?: IRunData;
  /** Receives one line per foreign slot decode had to drop (shapes n8n itself never writes). */
  readonly onDiagnostic?: (message: string) => void;
}

export type EncodeMode = 'pause' | 'cancelled' | 'stranded';

export interface EncodeOptions {
  /** Default `'pause'`. */
  readonly mode?: EncodeMode;
  /** Receives one line per dropped or stranded token, naming node and place. */
  readonly onDiagnostic?: (message: string) => void;
  /**
   * The live `INode` object of a node name (`workflow.nodes[name]`), which n8n puts on
   * every stack entry (`handleWaitingState` flips `nodeExecutionStack[0].node.disabled` on
   * it). Without it the encoder reuses the object of any entry already naming the node and
   * otherwise a name-only stub.
   */
  readonly node?: (name: string) => IExecuteData['node'] | undefined;
}

type MarkingMap = Map<Place<unknown>, Token<unknown>[]>;
type Items = INodeExecutionData[];
type SlotMain = Array<Items | null>;
type SlotSource = Array<ISourceData | null>;

const noop = (): void => {};

function unit(): Token<unknown> {
  return unitToken() as Token<unknown>;
}

function add(marking: MarkingMap, place: Place<unknown>, token: Token<unknown>): void {
  const queue = marking.get(place);
  if (queue === undefined) marking.set(place, [token]);
  else queue.push(token);
}

function count(marking: MarkingMap, place: Place<unknown> | null): number {
  return place === null ? 0 : (marking.get(place)?.length ?? 0);
}

function edgePayload(items: Items, source: ISourceData | null): EdgePayload {
  return { kind: 'edge', items, source };
}

/** The input index a direct-form node's `X/in` serves (0 for a synthetic `in`). */
function directInputIndex(compiled: CompiledWorkflow, g: NodeGadget): number {
  return compiled.netMap.place(g.in!.name)?.edge?.inputIndex ?? 0;
}

/** n8n's `connectionsByDestinationNode[node].main.length`: the slot arrays are this long. */
function inputCountOf(compiled: CompiledWorkflow, g: NodeGadget): number {
  if (g.form === 'direct') return directInputIndex(compiled, g) + 1;
  return Math.max(1, ...g.inputs.map((i) => i.index + 1));
}

/** The n8n source of an entry's first input (`source.main[0]`), where n8n records a single-input delivery. */
function sourceOfEntry(entry: IExecuteData): ISourceData | null {
  return entry.source?.main?.[0] ?? null;
}

function sourceOfValue(value: unknown): ISourceData | null {
  if (isEdgePayload(value)) return value.source;
  if (isEntryPayload(value)) return sourceOfEntry(value.executionData);
  return null;
}

/**
 * README "OR-inputs": a delivery over a tree edge counts towards the round's `n`; a
 * producer the compile cannot reach is already represented by the seeded deliveries of
 * `sharedMarking()`, so only a reachable producer's delivery is counted again.
 */
function countsTowardRound(compiled: CompiledWorkflow, i: InputGadget, source: ISourceData | null): boolean {
  if (source === null) return false;
  const e = i.edges.find((s) => s.edge.from === source.previousNode && s.edge.outputIndex === (source.previousNodeOutput ?? 0));
  return e !== undefined && e.empty !== null && compiled.analysis.reachable.has(source.previousNode);
}

/** `readySlot` as a codec error: the variant has no place on this input (foreign n8n data). */
function slotPlace(g: NodeGadget, i: InputGadget, variant: Variant): Place<unknown> {
  try {
    return readySlot(g, i, variant);
  } catch (error) {
    throw new CodecError(`node '${g.node}' input ${i.index} cannot receive an ${variant} arrival (${(error as Error).message})`);
  }
}

// ==================== decode ====================

/** One arrival of a join input's positional queue, before it is placed. */
type JoinArrival =
  | { readonly kind: 'entry'; readonly token: Token<unknown> }
  | { readonly kind: 'companion' }
  | { readonly kind: 'data'; readonly token: Token<unknown> }
  | { readonly kind: 'empty' };

export function decodeExecutionData(
  compiled: CompiledWorkflow,
  executionData: ExecutionDataState,
  options: DecodeOptions = {},
): Map<Place<unknown>, Token<unknown>[]> {
  const diag = options.onDiagnostic ?? noop;
  const marking = compiled.sharedMarking();
  /**
   * Whether `name` actually executed. A tool node is the one place where having a `runData`
   * entry is not the same thing: `initializeNodeRunData` **reserves** a slot per requested
   * action before the tool runs — n8n's own test asserts `data` is `undefined` for a tool whose
   * round was abandoned — so a reserved-but-unfilled slot must not mark `X/done` or a resumed
   * `$('Tool')` read arc would see a run that never happened.
   */
  const hasRun = (name: string): boolean => {
    const runs = options.runData?.[name] ?? [];
    if (runs.length === 0) return false;
    let isTool = false;
    try { isTool = compiled.netMap.node(name).form === 'tool'; } catch { isTool = false; }
    return isTool ? runs.some((t) => t.data !== undefined) : true;
  };
  const nodeOf = (name: string): NodeGadget => {
    try {
      return compiled.netMap.node(name);
    } catch {
      throw new CodecError(`executionData names node '${name}', which the compiled workflow does not have`);
    }
  };

  // Join inputs collect their arrivals positionally and are materialised afterwards.
  const joinQueues = new Map<NodeGadget, Map<number, JoinArrival[]>>();
  const enqueue = (g: NodeGadget, i: InputGadget, arrival: JoinArrival): void => {
    let queues = joinQueues.get(g);
    if (queues === undefined) joinQueues.set(g, (queues = new Map()));
    const q = queues.get(i.index);
    if (q === undefined) queues.set(i.index, [arrival]);
    else q.push(arrival);
  };
  // Deliveries of an open OR round to add to `X/ready_i`.
  const roundDeliveries = new Map<NodeGadget, number>();
  const deliver = (g: NodeGadget, n = 1): void => { roundDeliveries.set(g, (roundDeliveries.get(g) ?? 0) + n); };
  // Nodes with a decoded activation: what the resumed execution can still reach starts here.
  const pendingNodes = new Set<string>();

  // An agent round the encoder wrote back (README "Agent tool dispatch"): the agent's own
  // re-entry, and the tool calls that had not been dispatched when the execution stopped. Both
  // are ordinary `nodeExecutionStack` entries — that is the shape n8n keeps them in — so they
  // are recognised here and reassembled after the loop, once every entry has been seen.
  const roundResume = new Map<string, IExecuteData>();
  /** Tool activations in stack order; attributed to their agents after the loop, not during. */
  const roundPending: Array<{ readonly tool: NodeGadget; readonly entry: IExecuteData }> = [];

  // ---- nodeExecutionStack: one activation per entry, in stack order ----
  for (const entry of executionData.nodeExecutionStack) {
    const g = nodeOf(entry.node.name);
    pendingNodes.add(g.node);
    const payload: EntryPayload = { kind: 'entry', executionData: entry };
    const token = tokenOf<unknown>(payload);
    // An agent's re-entry carries the round it is waiting on. It must not go to `X/in`: that
    // would start a *new* activation from the agent's main input and lose the round.
    if (g.rounds !== null && entry.metadata?.nodeWasResumed === true
      && entry.metadata.subNodeExecutionData !== undefined) {
      roundResume.set(g.node, entry);
      continue;
    }
    if (g.form === 'tool') {
      roundPending.push({ tool: g, entry });
      continue;
    }
    if (g.form === 'direct') {
      add(marking, g.in!, token);
    } else if (g.form === 'or') {
      const i = g.inputs[0]!;
      add(marking, i.hasdata!, token);
      if (countsTowardRound(compiled, i, sourceOfEntry(entry))) deliver(g);
    } else {
      // n8n runs an entry unconditionally: the entry heads the first input's slot and every
      // other input takes a unit companion on its data slot, so X_start fires and the start
      // action passes the entry through (`startInput`).
      g.inputs.forEach((i, k) => enqueue(g, i, k === 0 ? { kind: 'entry', token } : { kind: 'companion' }));
    }
  }

  // ---- agent rounds: reassemble what the encoder wrote back ----
  // Attribution runs here and not inside the loop above: the encoder writes a round's tools
  // *before* its agent (the stack is ordered by depth descending, and a tool sits one below its
  // agent), so during the loop `roundResume` is still empty and a tool shared by two agents
  // would always fall back to the first one.
  const pendingOf = new Map<string, IExecuteData[]>();
  for (const { tool, entry } of roundPending) {
    const owner = tool.agents.length === 1
      ? tool.agents[0]!
      : tool.agents.find((agent) => (roundResume.get(agent)?.metadata?.subNodeExecutionData?.actions ?? [])
        .some((a) => a.nodeName === tool.node));
    if (owner === undefined) {
      diag(
        `node '${tool.node}': a stack entry for an ai_tool activation no open round claims; dropped ` +
        `(agents: ${tool.agents.join(', ') || 'none'})`);
      continue;
    }
    const q = pendingOf.get(owner);
    if (q === undefined) pendingOf.set(owner, [entry]);
    else q.push(entry);
  }

  // Every pending tool call goes on `A/queue`, whether the pause caught it undispatched or
  // dispatched-but-unstarted: both re-dispatch to the same run, and routing all of them through
  // the queue keeps them in request order, which putting them straight on `T/in_tool` would
  // not. A tool already collected is not on the stack at all, so it does not re-run;
  // `A/outstanding` is therefore zero and `A_resume` waits only on these.
  for (const [agent, resume] of roundResume) {
    const g = nodeOf(agent);
    const pending = pendingOf.get(agent) ?? [];
    pendingOf.delete(agent);
    const roundId = `${agent}#${resume.runIndex ?? 0}`;
    add(marking, g.dispatched!, tokenOf<unknown>({ kind: 'round', resume, roundId } as RoundPayload));
    // The queue when there is anything left to dispatch, `drained` when there is not — the
    // two are exclusive, and `A/calls` comes fresh from `sharedMarking`: the budget resets
    // across a resume, which the ADR records.
    if (pending.length > 0) {
      add(marking, g.queue!, tokenOf<unknown>({ kind: 'request', pending, resume, roundId } as RequestPayload));
    } else {
      add(marking, g.drained!, unit());
    }
    pendingNodes.add(agent);
    for (const e of pending) pendingNodes.add(e.node.name);
  }
  // A tool activation whose agent is not waiting on a round: the encoder never writes one, so
  // this is hand-made state. n8n would still run it, but nothing would collect the response.
  for (const [agent, entries] of pendingOf) {
    diag(
      `agent '${agent}': ${entries.length} ai_tool activation(s) on the stack with no re-entry ` +
      `for '${agent}'; dropped (${entries.map((e) => e.node.name).join(', ')})`);
  }

  // ---- waitingExecution: partial slots, per node in ascending run index ----
  const waiting = executionData.waitingExecution ?? {};
  const waitingSource = executionData.waitingExecutionSource ?? {};
  for (const [name, slots] of Object.entries(waiting)) {
    if (slots === undefined || slots === null) continue;
    const g = nodeOf(name);
    const keys = Object.keys(slots).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const k of keys) {
      const main: ReadonlyArray<Items | null | undefined> = slots[k]?.main ?? [];
      const sources: ReadonlyArray<ISourceData | null | undefined> = waitingSource?.[name]?.[k]?.main ?? [];
      const valueAt = (index: number): Items | null => main[index] ?? null;
      const sourceAt = (index: number): ISourceData | null => sources[index] ?? null;
      const foreign = (owned: (index: number) => boolean): void => {
        main.forEach((v, index) => {
          if (v !== null && v !== undefined && !owned(index)) {
            diag(`node '${g.node}': waitingExecution[${k}].main[${index}] names an input the node does not have; dropped`);
          }
        });
      };
      if (g.form === 'direct') {
        // n8n never writes a single-input node here; the stranded encoder does (divergence #2).
        const index = directInputIndex(compiled, g);
        foreign((idx) => idx === index);
        const v = valueAt(index);
        if (v === null) continue;
        pendingNodes.add(g.node);
        if (v.length > 0) add(marking, g.in!, tokenOf<unknown>(edgePayload(v, sourceAt(index))));
        else if (g.inEmpty !== null) add(marking, g.inEmpty, unit());
        else diag(`node '${g.node}': waitingExecution[${k}] holds [] for an input that cannot carry an empty; dropped`);
        continue;
      }
      if (g.form === 'or') {
        const i = g.inputs[0]!;
        foreign((idx) => idx === i.index);
        const v = valueAt(i.index);
        if (v === null) continue;
        if (v.length === 0) {
          deliver(g); // a delivered empty of the open round
          continue;
        }
        pendingNodes.add(g.node);
        const source = sourceAt(i.index);
        add(marking, i.hasdata!, tokenOf<unknown>(edgePayload(v, source)));
        if (countsTowardRound(compiled, i, source)) deliver(g);
        continue;
      }
      foreign((idx) => g.inputs.some((i) => i.index === idx));
      let any = false;
      for (const i of g.inputs) {
        const v = valueAt(i.index);
        if (v === null) continue;
        any = true;
        enqueue(g, i, v.length > 0 ? { kind: 'data', token: tokenOf<unknown>(edgePayload(v, sourceAt(i.index))) } : { kind: 'empty' });
      }
      if (any) pendingNodes.add(g.node);
    }
  }

  // ---- join inputs: the head takes the slot, the rest queue behind free_i ----
  for (const [g, queues] of joinQueues) {
    for (const i of g.inputs) {
      const q = queues.get(i.index);
      if (q === undefined || q.length === 0) continue;
      // The decoded head replaces the seeded empty of an unreachable input and withholds free_i.
      marking.delete(i.free!);
      for (const p of [i.ready, i.readyData, i.readyEmpty]) if (p !== null) marking.delete(p);
      const [head, ...rest] = q as [JoinArrival, ...JoinArrival[]];
      add(marking, slotPlace(g, i, head.kind === 'empty' ? 'empty' : 'data'), tokenOfArrival(head));
      if (g.hasdata !== null && (head.kind === 'data' || head.kind === 'entry')) add(marking, g.hasdata, unit());
      for (const a of rest) {
        const place = a.kind === 'empty' ? (i.edges.find((e) => e.empty !== null)?.empty ?? null) : (i.edges[0]?.data ?? null);
        if (place === null) {
          throw new CodecError(
            `node '${g.node}' input ${i.index}: a second pending ${a.kind === 'empty' ? 'empty' : 'arrival'} cannot queue ` +
            `(the input has no ${a.kind === 'empty' ? 'empty-capable ' : ''}producer edge)`);
        }
        add(marking, place, tokenOfArrival(a));
      }
    }
  }

  // ---- OR rounds: the deliveries, and the marker of a round the node already ran in ----
  for (const [g, n] of roundDeliveries) {
    const i = g.inputs[0]!;
    for (let k = 0; k < n; k++) add(marking, i.ready!, unit());
  }
  for (const g of compiled.netMap.nodes) {
    if (g.form !== 'or') continue;
    const i = g.inputs[0]!;
    if (count(marking, i.ready) > 0 && hasRun(g.node)) add(marking, i.ran!, unit());
  }

  // ---- markers: done from runData, skipped for references nothing pending can satisfy ----
  for (const g of compiled.netMap.nodes) {
    if (hasRun(g.node)) add(marking, g.done, unit());
  }
  const referenced = new Set<string>();
  for (const g of compiled.netMap.nodes) for (const y of g.references) referenced.add(y);
  if (referenced.size > 0) {
    const reach = reachableFrom(compiled, pendingNodes);
    for (const y of referenced) {
      const g = compiled.netMap.node(y);
      if (g.skipped === null || hasRun(y) || reach.has(y) || count(marking, g.skipped) > 0) continue;
      add(marking, g.skipped, unit());
    }
  }
  return marking;
}

function tokenOfArrival(a: JoinArrival): Token<unknown> {
  return a.kind === 'entry' || a.kind === 'data' ? a.token : unit();
}

/** Nodes a resumed execution can still activate: the pending nodes and everything downstream of them. */
function reachableFrom(compiled: CompiledWorkflow, pending: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>(pending);
  const stack = [...pending];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const e of compiled.analysis.outgoing.get(n) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return seen;
}

// ==================== encode ====================

/** A pending activation to be written back as a stack entry. */
interface PendingEntry {
  readonly executionData: IExecuteData;
  readonly depth: number;
  readonly canvas: number;
  readonly waiting: boolean;
  /** Discovery order: per node waiting, stopped, retry, running, then the input FIFO / positional rows. */
  readonly seq: number;
}

/** A token of a join input's positional queue. */
interface Cell {
  readonly value: unknown;
  readonly place: Place<unknown>;
}

/** An arrival a token on `X/ok_o` (routed by the encoder) adds to a consumer's input. */
interface RoutedArrival {
  readonly inputIndex: number;
  /** `null`: the output was empty (the consumer's `empty` place would have received a unit). */
  readonly payload: EdgePayload | null;
  readonly edgeId: number;
}

/**
 * The `IExecuteData` for one edge arrival, in the shape n8n hands the node: the items at
 * `main[inputIndex]`, `[]` on the inputs below it, the source alongside.
 *
 * `addNodeToBeExecuted`'s single-input path (`workflow-execute.ts:786-800`) writes `null`
 * below the index, but it is unreachable above input 0: `numberOfInputs` there is
 * `connectionsByDestinationNode[node].main.length`, which is `inputIndex + 1` for a node
 * wired on `inputIndex`, so every arrival above input 0 goes to the waiting path and reaches
 * the node through R6's stuck-join fallback instead — and that substitutes `[]` for every
 * input which never arrived, keeping the sources positional
 * (`stack-scheduler.ts:467-491`, `prepareWaitingToExecution`). A node wired only on a higher
 * input is compiled in direct form and run on arrival with the same data (divergence #9), so
 * it is the fallback's shape that must be reproduced: a `null` below the index would make
 * `getInputItems` throw "Input index was not set" (`base-execute-context.ts:321`) in a node
 * that reads input 0, which is what n8n's Merge does.
 */
export function entryForEdge(node: IExecuteData['node'], inputIndex: number, edge: EdgePayload): IExecuteData {
  const main: Array<INodeExecutionData[] | null> = Array.from({ length: inputIndex + 1 }, () => []);
  main[inputIndex] = edge.items;
  const data: ITaskDataConnections = { main };
  let source: ITaskDataConnectionsSource | null = null;
  if (edge.source !== null) {
    const sources: Array<ISourceData | null> = Array.from({ length: inputIndex + 1 }, () => null);
    sources[inputIndex] = edge.source;
    source = { main: sources };
  }
  return { node, data, source };
}

export function encodeMarking(
  compiled: CompiledWorkflow,
  marking: Marking,
  executionData: ExecutionDataState,
  options: EncodeOptions = {},
): ExecutionDataState {
  const mode = options.mode ?? 'pause';
  const diag = options.onDiagnostic ?? noop;
  const nodes = compiled.netMap.nodes;
  const pending: PendingEntry[] = [];
  const waiting: IWaitingForExecution = {};
  const waitingSource: IWaitingForExecutionSource = {};
  let seq = 0;

  const undrained = (g: NodeGadget, place: Place<unknown>): CodecError => new CodecError(
    `node '${g.node}': ${marking.tokenCount(place)} token(s) on '${place.name}' — the net must be drained before ` +
    `encoding (mode '${mode}')`);

  // ---- places the net drains on its own before it quiesces ----
  for (const g of nodes) {
    if (mode !== 'cancelled') {
      // `A/routed_req` belongs here with `X/routed`: both are the marker `X_run` writes in the
      // firing that ends an activation, and both are consumed one cycle later by a transition
      // that inhibits on nothing — so a quiesced net has drained them whatever stopped it.
      const inFlight: Array<Place<unknown> | null> = [
        g.running, g.routed, g.routedRequest, g.inEmpty, ...g.outputs.flatMap((o) => [o.ok, o.routed]),
        // An `onFailure` chain's later attempts are `X/running` for every purpose here, and its
        // deadline funnel inhibits `_halt` alone — so a *paused* net has already moved every
        // `X/timedout_i` on to `X/failed_i` and only a halted one can still hold it
        // (ADR 0009 §3).
        ...g.attempts.slice(1).map((a) => a.running),
        ...g.attempts.map((a) => a.timedOut),
      ];
      if (g.form === 'or') for (const e of g.inputs[0]!.edges) inFlight.push(e.data, e.empty);
      for (const p of inFlight) if (p !== null && marking.tokenCount(p) > 0) throw undrained(g, p);
    }
    if (mode === 'stranded') {
      if (g.retry !== null && marking.tokenCount(g.retry) > 0) throw undrained(g, g.retry);
      // `X/failed_i` is `X/retry` for a chain: a pending activation, not residue.
      for (const a of g.attempts) if (marking.tokenCount(a.failed) > 0) throw undrained(g, a.failed);
    }
  }

  const routed = collectRouted(marking, nodes);

  /** `waitingExecution[node][k]` / `waitingExecutionSource[node][k]`, created on first use with `null` per input. */
  const slot = (g: NodeGadget, k: number): { main: SlotMain; source: SlotSource } => {
    const inputCount = inputCountOf(compiled, g);
    const w = (waiting[g.node] ??= {});
    const ws = (waitingSource[g.node] ??= {});
    if (w[k] === undefined) {
      w[k] = { main: Array.from({ length: inputCount }, () => null) };
      ws[k] = { main: Array.from({ length: inputCount }, () => null) };
    }
    return { main: w[k]!.main as SlotMain, source: ws[k]!.main! };
  };
  const nextSlot = (g: NodeGadget): { main: SlotMain; source: SlotSource } => slot(g, Object.keys(waiting[g.node] ?? {}).length);

  for (const g of nodes) {
    const canvas = nodes.indexOf(g);
    const push = (e: IExecuteData, isWaiting = false): void => {
      pending.push({ executionData: e, depth: g.depth, canvas, waiting: isWaiting, seq: seq++ });
    };
    const liveNode = (): IExecuteData['node'] => nodeOfGadget(g, executionData, options.node);
    /** An `X/in` / `X/hasdata_i` token as n8n's stack entry; `null` for a value that carries none. */
    const entryOf = (inputIndex: number, value: unknown, place: Place<unknown>): IExecuteData | null => {
      if (isEntryPayload(value)) return value.executionData;
      if (isEdgePayload(value)) return entryForEdge(liveNode(), inputIndex, value);
      diag(`node '${g.node}': token on '${place.name}' carries no executionData; dropped`);
      return null;
    };
    /** The stranded form of an entry: its first input's data as a stuck slot. */
    const strand = (inputIndex: number, e: IExecuteData, place: Place<unknown>): void => {
      diag(`node '${g.node}': stranded token on '${place.name}' (divergence #2); written to waitingExecution`);
      const s = nextSlot(g);
      s.main[inputIndex] = e.data.main?.[inputIndex] ?? [];
      s.source[inputIndex] = e.source?.main?.[0] ?? null;
    };
    const routedHere = routed.get(g.node) ?? [];

    // ---- the node's own activations: waiting first, then the ones cancellation caught ----
    for (const t of marking.peekTokens(g.waiting)) push((t.value as WaitingPayload).executionData, true);
    for (const t of marking.peekTokens(g.stopped)) {
      const v = t.value as StoppedPayload;
      if (!v.ran) push(v.executionData);
    }
    if (g.retry !== null) {
      for (const t of marking.peekTokens(g.retry)) push((t.value as RetryPayload).executionData);
    }
    for (const t of marking.peekTokens(g.running)) push((t.value as RunPayload).executionData);
    // An `onFailure` chain, in the same order and for the same reason: a failure whose step has
    // not acted (`X/failed_i`), an attempt a deadline abandoned in a halted net
    // (`X/timedout_i`), and a later attempt cancellation caught mid-run (`X/running_i`). Each
    // becomes an ordinary stack entry and the activation re-runs from its first attempt —
    // n8n has nowhere to persist the position, which `tasks/todo.md` §4b records.
    for (const a of g.attempts) {
      for (const t of marking.peekTokens(a.failed)) push((t.value as RetryPayload).executionData);
      if (a.timedOut !== null) {
        for (const t of marking.peekTokens(a.timedOut)) push((t.value as RunPayload).executionData);
      }
      if (a.index > 1) {
        for (const t of marking.peekTokens(a.running)) push((t.value as RunPayload).executionData);
      }
    }

    // ---- an agent round the pause or the halt caught mid-flight ----
    // The tokens carry the very `IExecuteData` values n8n's own `handleRequest` produced, so
    // writing them back is writing exactly the `nodeExecutionStack` n8n would have been left
    // holding: the tool calls not yet dispatched, the one dispatched but not yet started, and
    // the agent's own re-entry underneath them. Nothing here is reconstructed.
    //
    // A dispatched tool that is *running* is already pushed above, off `X/running`; one that
    // finished has its response on `A/response` and its `runData` written, so there is nothing
    // left to re-queue for it.
    if (g.inTool !== null) {
      for (const t of marking.peekTokens(g.inTool)) {
        const v = t.value;
        if (isDispatchPayload(v)) push(v.executionData);
        else diag(`node '${g.node}': token on '${g.inTool.name}' carries no dispatch; dropped`);
      }
    }
    if (g.queue !== null) {
      for (const t of marking.peekTokens(g.queue)) {
        const v = t.value;
        if (isRequestPayload(v)) for (const e of v.pending) push(e);
        else diag(`node '${g.node}': token on '${g.queue.name}' carries no request; dropped`);
      }
    }
    if (g.dispatched !== null) {
      for (const t of marking.peekTokens(g.dispatched)) {
        const v = t.value;
        if (isRoundPayload(v)) push(v.resume);
        else diag(`node '${g.node}': token on '${g.dispatched.name}' carries no round; dropped`);
      }
    }

    if (g.form === 'direct') {
      const inputIndex = directInputIndex(compiled, g);
      const arrivals: Cell[] = [
        ...marking.peekTokens(g.in!).map((t): Cell => ({ value: t.value, place: g.in! })),
        ...routedHere.filter((r) => r.payload !== null).map((r): Cell => ({ value: r.payload, place: g.in! })),
      ];
      for (const a of arrivals) {
        const e = entryOf(inputIndex, a.value, a.place);
        if (e === null) continue;
        if (mode === 'stranded') strand(inputIndex, e, a.place);
        else push(e);
      }
      if (g.inEmpty !== null && marking.tokenCount(g.inEmpty) > 0) {
        diag(`node '${g.node}': ${marking.tokenCount(g.inEmpty)} pending empty token(s) on '${g.inEmpty.name}'; n8n never enqueues an empty, dropped`);
      }
      continue;
    }

    if (g.form === 'or') {
      const i = g.inputs[0]!;
      // Armed arrivals were counted in the round; arrivals still on an edge (cancelled) were not.
      const armed = marking.peekTokens(i.hasdata!).map((t): Cell => ({ value: t.value, place: i.hasdata! }));
      const unarmed: Cell[] = [];
      let unarmedEmpties = 0;
      for (const e of i.edges) {
        for (const t of marking.peekTokens(e.data)) unarmed.push({ value: t.value, place: e.data });
        if (e.empty !== null) unarmedEmpties += marking.tokenCount(e.empty);
      }
      for (const r of routedHere) {
        if (r.payload !== null) unarmed.push({ value: r.payload, place: i.edges.find((e) => e.edge.id === r.edgeId)?.data ?? i.hasdata! });
        else if (i.edges.find((e) => e.edge.id === r.edgeId)?.empty !== null) unarmedEmpties++;
      }
      // Every activation decode turns back into a stack entry was armed once — waiting,
      // stopped before its run, retrying, running (cancelled) or still on hasdata_i — and
      // decode counts its delivery again, so the encoder subtracts all of them.
      const activationSources: Array<ISourceData | null> = [
        ...marking.peekTokens(g.waiting).map((t) => sourceOfEntry((t.value as WaitingPayload).executionData)),
        ...marking.peekTokens(g.stopped).filter((t) => !(t.value as StoppedPayload).ran).map((t) => sourceOfEntry((t.value as StoppedPayload).executionData)),
        ...(g.retry === null ? [] : marking.peekTokens(g.retry).map((t) => sourceOfEntry((t.value as RetryPayload).executionData))),
        ...marking.peekTokens(g.running).map((t) => sourceOfEntry((t.value as RunPayload).executionData)),
        ...g.attempts.flatMap((a) => [
          ...marking.peekTokens(a.failed).map((t) => sourceOfEntry((t.value as RetryPayload).executionData)),
          ...(a.timedOut === null ? [] : marking.peekTokens(a.timedOut).map((t) => sourceOfEntry((t.value as RunPayload).executionData))),
          ...(a.index === 1 ? [] : marking.peekTokens(a.running).map((t) => sourceOfEntry((t.value as RunPayload).executionData))),
        ]),
        ...armed.map((a) => sourceOfValue(a.value)),
      ];
      const counted = activationSources.filter((source) => countsTowardRound(compiled, i, source)).length;
      for (const a of [...armed, ...unarmed]) {
        const e = entryOf(i.index, a.value, a.place);
        if (e === null) continue;
        if (mode === 'stranded') strand(i.index, e, a.place);
        else push(e);
      }
      // The open round's other deliveries: one `[]` slot each (n8n's R6 discards them; decode counts them).
      const seeds = g.reachable ? i.unreachableEdges : 0;
      const deliveries = Math.max(0, marking.tokenCount(i.ready!) - counted - seeds) + unarmedEmpties;
      if (deliveries > 0 && mode === 'stranded') {
        diag(`node '${g.node}': OR-input round left open on '${i.ready!.name}' (${deliveries} delivered empties, divergence #2); written to waitingExecution`);
      }
      for (let k = 0; k < deliveries; k++) nextSlot(g).main[i.index] = [];
      continue;
    }

    // ---- join / choose-branch: positional slots over the per-input queues ----
    const queues = g.inputs.map((i) => joinQueue(g, i, marking, routedHere));
    if (queues.some((q) => q.length > 0) && queues.every((q, k) => q.every((c) => isSeed(g.inputs[k]!, c)))) {
      // Nothing but the seeded empties of inputs fed by unreachable producers:
      // `sharedMarking()` re-seeds them on decode, and n8n never had them. (With anything
      // else queued the seed is written as `[]` in its row, so positions are kept.)
      if (mode === 'stranded') {
        diag(`node '${g.node}': join never completed; only the seeded empty of input ` +
          `${g.inputs.filter((i, k) => queues[k]!.length > 0 && i.seedEmpty).map((i) => i.index).join(', ')} (unreachable producers) arrived; not written`);
      }
      continue;
    }
    const depth = Math.max(0, ...queues.map((q) => q.length));
    for (let j = 0; j < depth; j++) {
      const cells = queues.map((q) => q[j]);
      const entries = cells.filter((c): c is Cell => c !== undefined && isEntryPayload(c.value));
      if (entries.length > 0) {
        const e = (entries[0]!.value as EntryPayload).executionData;
        if (entries.some((c) => (c.value as EntryPayload).executionData !== e)) {
          throw new CodecError(`node '${g.node}': slot ${j} pairs two different stack entries ('${entries.map((c) => c.place.name).join("', '")}')`);
        }
        if (mode === 'stranded') {
          diag(`node '${g.node}': stranded entry on '${entries[0]!.place.name}' (divergence #2); written to waitingExecution`);
          const s = nextSlot(g);
          for (const i of g.inputs) {
            s.main[i.index] = e.data.main?.[i.index] ?? null;
            s.source[i.index] = e.source?.main?.[i.index] ?? null;
          }
        } else {
          push(e);
        }
        continue;
      }
      const complete = cells.every((c) => c !== undefined);
      const inputCount = inputCountOf(compiled, g);
      const main: SlotMain = Array.from({ length: inputCount }, () => null);
      const sources: SlotSource = Array.from({ length: inputCount }, () => null);
      let anyData = false;
      g.inputs.forEach((i, k) => {
        const c = cells[k];
        if (c === undefined) return;
        if (isEdgePayload(c.value)) {
          main[i.index] = c.value.items;
          sources[i.index] = c.value.source;
          anyData = true;
        } else {
          main[i.index] = []; // an empty token: n8n's "arrived empty"
        }
        if (mode === 'stranded') diag(`node '${g.node}': stranded token on '${c.place.name}' input ${i.index} (divergence #2); written to waitingExecution`);
      });
      if (complete && anyData && mode !== 'stranded') {
        // n8n's `allDataFound`: the node goes on the stack with the slot as its data.
        push({ node: liveNode(), data: { main }, source: { main: sources } });
      } else {
        // Partial, or complete without data: the latter is a skip (`X_skip`, only seen under
        // `cancelled`), which n8n's R6 drops from `waitingExecution` and decode restores;
        // a stack entry would run the node on empties.

        const s = nextSlot(g);
        for (const i of g.inputs) {
          s.main[i.index] = main[i.index] ?? null;
          s.source[i.index] = sources[i.index] ?? null;
        }
      }
    }
  }

  // The deepest pending node first, which is where n8n's LIFO stack (`unshift`) has it;
  // within a node the FIFO / positional order, which is the order the net fires them in.
  pending.sort((x, y) => (Number(y.waiting) - Number(x.waiting)) || (y.depth - x.depth) || (x.canvas - y.canvas) || (x.seq - y.seq));
  executionData.nodeExecutionStack = pending.map((p) => p.executionData);
  executionData.waitingExecution = waiting;
  executionData.waitingExecutionSource = waitingSource;
  return executionData;
}

/** A unit token on the `ready` place of an input whose producers are all unreachable: the shared marking's seed. */
function isSeed(i: InputGadget, c: Cell): boolean {
  return i.seedEmpty && !isEdgePayload(c.value) && !isEntryPayload(c.value) && (c.place === i.ready || c.place === i.readyEmpty);
}

/**
 * The positional queue of one join input: the `ready` head, then the edge places in
 * canonical order (per edge `data` before `empty`), then routed arrivals. That is the order
 * the arms fire in when `free_i` returns to simultaneously waiting arrivals (equal priority,
 * declaration order), so it is also the pairing a resumed net produces for them.
 */
function joinQueue(g: NodeGadget, i: InputGadget, marking: Marking, routedHere: readonly RoutedArrival[]): Cell[] {
  const q: Cell[] = [];
  for (const p of [i.ready, i.readyData, i.readyEmpty]) {
    if (p === null) continue;
    for (const t of marking.peekTokens(p)) q.push({ value: t.value, place: p });
  }
  for (const e of i.edges) {
    for (const t of marking.peekTokens(e.data)) q.push({ value: t.value, place: e.data });
    if (e.empty !== null) for (const t of marking.peekTokens(e.empty)) q.push({ value: t.value, place: e.empty });
  }
  for (const r of routedHere) {
    if (r.inputIndex !== i.index) continue;
    const e = i.edges.find((s) => s.edge.id === r.edgeId);
    const place = r.payload === null ? (e?.empty ?? e?.data) : e?.data;
    q.push({ value: r.payload, place: place ?? g.running });
  }
  return q;
}

/**
 * The arrivals the tokens still on `X/ok_o` (`close()` stopped a **per-output routing** node
 * between `X_run` and `X_route_o`) would have produced, per consumer, in canonical edge
 * order — where n8n's `addNodeToBeExecuted` had put them before the next iteration's
 * cancellation check.
 *
 * Only a node above {@link SPLIT_ROUTING_ABOVE} has such a place: everywhere else `X_run`
 * deposits the edge tokens itself, so a cancellation catches them already on the consumer's
 * edge places, where `joinQueue` and the direct-form arrival list read them.
 */
function collectRouted(marking: Marking, nodes: readonly NodeGadget[]): Map<string, RoutedArrival[]> {
  const routed = new Map<string, RoutedArrival[]>();
  for (const g of nodes) {
    if (!g.splitRouting) continue;
    const okTokens = g.outputs.flatMap((o) => marking.peekTokens(o.ok!).map((t) => ({ t, outputs: [o] })));
    for (const { t, outputs } of okTokens) {
      const v = t.value as OkPayload;
      for (const out of outputs) {
        const items = v.nodeSuccessData[out.index];
        const payload: EdgePayload | null = items !== undefined && items !== null && items.length !== 0
          ? { kind: 'edge', items, source: { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: v.runIndex } }
          : null;
        if (payload === null && out.nil !== null) continue; // a cycle edge carries nothing on nil
        for (const e of out.edges) {
          const list = routed.get(e.edge.to) ?? [];
          list.push({ inputIndex: e.edge.inputIndex, payload, edgeId: e.edge.id });
          routed.set(e.edge.to, list);
        }
      }
    }
  }
  for (const list of routed.values()) list.sort((a, b) => a.edgeId - b.edgeId);
  return routed;
}

/**
 * The live `INode` of a gadget, as n8n puts it on a stack entry (`workflow.nodes[name]`):
 * from `options.node`, else from any entry already on the stack that names the node, else
 * a name-only stub.
 */
function nodeOfGadget(
  g: NodeGadget,
  executionData: ExecutionDataState,
  resolve: EncodeOptions['node'],
): IExecuteData['node'] {
  const live = resolve?.(g.node);
  if (live !== undefined) return live;
  for (const e of executionData.nodeExecutionStack) if (e.node.name === g.node) return e.node;
  return { id: g.id, name: g.node, type: g.type, typeVersion: g.typeVersion, position: [0, 0], parameters: {} };
}

// Re-exported for the scheduler's start actions (README "Join gadget": the input a slot serves).
export type { InputGadget };
