/**
 * Shared helpers for the compiler suite: structural introspection of a `CompiledWorkflow`
 * and running its net to natural quiescence (EXEC-040) on either libpetri executor with
 * an `InMemoryEventStore` attached. `run()` is never given a timeout (CLAUDE.md).
 */
import {
  BitmapNetExecutor, InMemoryEventStore, PrecompiledNetExecutor, enumerateBranches,
  type Marking, type NetEvent, type Place, type Token, type Transition, type TransitionFailed,
} from 'libpetri';
import type {
  AgentGadget, CompiledWorkflow, InputGadget, NodeGadget, OrInput, RetryGadget, SplitOutput, TransitionInfoOf,
  TransitionRole,
} from '../../src/compiler/index.js';

export type Executor = 'precompiled' | 'bitmap';

export interface RunResult {
  readonly marking: Marking;
  readonly store: InMemoryEventStore;
}

/** Runs the compiled net from `initial` to quiescence; the program is reused from the workflow. */
export async function runCompiled(
  c: CompiledWorkflow,
  initial: Map<Place<unknown>, Token<unknown>[]>,
  executor: Executor = 'precompiled',
): Promise<RunResult> {
  const store = new InMemoryEventStore();
  const ex = executor === 'precompiled'
    ? new PrecompiledNetExecutor(c.net, initial, { eventStore: store, program: c.program })
    : new BitmapNetExecutor(c.net, initial, { eventStore: store });
  const marking = await ex.run();
  return { marking, store };
}

/** Transition names in `transition-started` order (EVT-006), optionally filtered. */
export function started(store: InMemoryEventStore, filter?: (name: string) => boolean): string[] {
  const names: string[] = [];
  for (const e of store.events()) {
    if (e.type === 'transition-started' && (filter === undefined || filter(e.transitionName))) {
      names.push(e.transitionName);
    }
  }
  return names;
}

/** Every `transition-failed` event (EVT-008). */
export function failed(store: InMemoryEventStore): TransitionFailed[] {
  return store.events().filter((e): e is TransitionFailed => e.type === 'transition-failed');
}

export function isStartOf(name: string): (e: NetEvent) => boolean {
  return (e) => e.type === 'transition-started' && e.transitionName === name;
}

/** Names of the places a transition consumes (input arcs). */
export function inputNames(t: Transition): string[] {
  return t.inputSpecs.map((s) => s.place.name).sort();
}

/** Names of the places a transition may produce to (every place in its Out spec). */
export function outputNames(t: Transition): string[] {
  return [...t.outputPlaces()].map((p) => p.name).sort();
}

export function inhibitorNames(t: Transition): string[] {
  return t.inhibitors.map((a) => a.place.name).sort();
}

export function readNames(t: Transition): string[] {
  return t.reads.map((a) => a.place.name).sort();
}

export function resetNames(t: Transition): string[] {
  return t.resets.map((a) => a.place.name).sort();
}

/**
 * The `Transition` object of a node's role (first match, or the one carrying `port`), by
 * name lookup on the bound net. `port` picks one `X_route_o` of a node that routes several
 * outputs; without it a multi-output node's first route comes back.
 */
export function transitionOf(
  c: CompiledWorkflow, node: string, role: Parameters<typeof c.netMap.transitionFor>[1], port?: number,
): Transition {
  const info = c.netMap.transitionFor(node, role, port);
  if (info === undefined) throw new Error(`no ${role} transition on ${node}`);
  return c.netMap.transitionObject(info.name);
}

export function gadget(c: CompiledWorkflow, node: string): NodeGadget {
  return c.netMap.node(node);
}

/** The transition `name`, which the test knows carries `role`. */
export function transitionInfoOf<R extends TransitionRole>(c: CompiledWorkflow, name: string, role: R): TransitionInfoOf<R> {
  const info = c.netMap.transition(name);
  if (info === undefined) throw new Error(`no transition '${name}'`);
  if (info.role !== role) throw new Error(`transition '${name}' has role '${info.role}', not '${role}'`);
  return info as TransitionInfoOf<R>;
}

// ---- narrowing: a test that reads a form-specific place says which form it expects ----

export function asForm<F extends NodeGadget['form']>(g: NodeGadget, form: F): Extract<NodeGadget, { form: F }> {
  if (g.form !== form) throw new Error(`node '${g.node}' compiled in form '${g.form}', not '${form}'`);
  return g as Extract<NodeGadget, { form: F }>;
}

/** The direct form's `X/in`. */
export function inOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'direct').in;
}

/** The direct form's `X/in_empty`, which the test knows exists (a tree edge feeds it). */
export function inEmptyOf(g: NodeGadget): Place<unknown> {
  const p = asForm(g, 'direct').inEmpty;
  if (p === null) throw new Error(`node '${g.node}' has no in_empty place`);
  return p;
}

/** The OR form's one input. */
export function orInputOf(g: NodeGadget): OrInput {
  return asForm(g, 'or').inputs[0];
}

/** `g.inputs[k]`, which the test knows exists. */
export function inputOf(g: NodeGadget, k: number): InputGadget {
  const i = g.inputs[k];
  if (i === undefined) throw new Error(`node '${g.node}' has no input #${k}`);
  return i;
}

export function asSlot<S extends InputGadget['slot']>(i: InputGadget, slot: S): Extract<InputGadget, { slot: S }> {
  if (i.slot !== slot) throw new Error(`input ${i.index} has slot '${i.slot}', not '${slot}'`);
  return i as Extract<InputGadget, { slot: S }>;
}

/** The single `ready` place of an OR or generic join input. */
export function readyOf(i: InputGadget): Place<unknown> {
  if (i.slot === 'ready-split') throw new Error(`input ${i.index} is enumerated: ready_data / ready_empty`);
  return i.ready;
}

/** `X/free_i` of a join input; the OR form has no slot to free. */
export function freeOf(i: InputGadget): Place<unknown> {
  if (i.slot === 'or') throw new Error(`input ${i.index} is an OR input: no free_${i.index}`);
  return i.free;
}

/** `X/ready_i_data` of an enumerated (required choose-branch) input. */
export function readyDataOf(i: InputGadget): Place<unknown> {
  return asSlot(i, 'ready-split').readyData;
}

/** `X/ready_i_empty` of an enumerated input, which the test knows exists. */
export function readyEmptyOf(i: InputGadget): Place<unknown> {
  const p = asSlot(i, 'ready-split').readyEmpty;
  if (p === null) throw new Error(`input ${i.index} has no ready_${i.index}_empty place`);
  return p;
}

/** `X/hasdata` of the join form. */
export function hasdataOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'join').hasdata;
}

/** `T/in_tool` of the tool form. */
export function inToolOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'tool').inTool;
}

/** `X/routed` of a node that routes inside `X_run`. */
export function routedOf(g: NodeGadget): Place<unknown> {
  if (g.routing.kind !== 'collapsed') throw new Error(`node '${g.node}' routes per output`);
  return g.routing.routed;
}

/** The outputs of a node that routes per output, with their `ok_o` / `routed_o`. */
export function splitOutputsOf(g: NodeGadget): readonly SplitOutput[] {
  if (g.routing.kind !== 'split') throw new Error(`node '${g.node}' routes inside X_run`);
  return g.routing.outputs;
}

export function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new Error(`node '${g.node}' is not an agent`);
  return g.agent;
}

export function retryOf(g: NodeGadget): RetryGadget {
  if (g.retry === null) throw new Error(`node '${g.node}' has no retry gadget`);
  return g.retry;
}

/** The edge slot of `from.outputIndex -> to.inputIndex` as seen from the consumer's gadget. */
export function edgeSlot(c: CompiledWorkflow, from: string, outputIndex: number, to: string, inputIndex: number) {
  const g = gadget(c, to);
  if (g.form === 'direct') {
    const p = c.netMap.placesOf(to).find((pi) => pi.role === 'in-data' && pi.edge?.from === from
      && pi.edge.outputIndex === outputIndex && pi.edge.inputIndex === inputIndex);
    if (p === undefined) throw new Error(`no in-data place for ${from}.${outputIndex} -> ${to}.${inputIndex}`);
    return { edge: p.edge!, data: p.place, empty: g.inEmpty };
  }
  for (const i of g.inputs) {
    for (const e of i.edges) {
      if (e.edge.from === from && e.edge.outputIndex === outputIndex && e.edge.inputIndex === inputIndex) return e;
    }
  }
  throw new Error(`no edge slot for ${from}.${outputIndex} -> ${to}.${inputIndex}`);
}

/** Node names in the order their gadgets are declared in the flat net (consecutive runs compressed). */
export function declarationOrder(c: CompiledWorkflow): (string | null)[] {
  const order: (string | null)[] = [];
  for (const t of c.net.transitions) {
    const owner = c.netMap.transition(t.name)!.node;
    if (order.length === 0 || order[order.length - 1] !== owner) order.push(owner);
  }
  return order;
}

/** Sorted place names of the flat net matching a predicate. */
export function placeNames(c: CompiledWorkflow, pred: (name: string) => boolean = () => true): string[] {
  return [...c.net.places].map((p) => p.name).filter(pred).sort();
}

export function tokenCounts(m: Marking, places: readonly Place<unknown>[]): number[] {
  return places.map((p) => m.tokenCount(p));
}

/**
 * The **success** branches of a node's outcome, as flat place-name sets (IO-016): the
 * branches of `X_run` that deposit the edge tokens, or — for a node that routes per output
 * ({@link SPLIT_ROUTING_ABOVE}) — the branches of `X_route_o`. `X_run`'s halt / waiting /
 * stopped alternatives are dropped: none of them writes `X/routed`.
 */
export function successBranches(c: CompiledWorkflow, node: string, port?: number): string[][] {
  const g = gadget(c, node);
  const t = g.routing.kind === 'split' ? transitionOf(c, node, 'route', port) : transitionOf(c, node, 'run');
  const branches = enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort());
  if (g.routing.kind === 'split') return branches;
  return branches.filter((b) => b.includes(routedOf(g).name));
}

/**
 * Sorted names of the places a node's success outcome can write, excluding the markers it
 * always writes (`X/idle`, `X/routed`) — i.e. the emission rule's edge and `nil` places.
 */
export function routingPlaces(c: CompiledWorkflow, node: string, port?: number): string[] {
  const g = gadget(c, node);
  const skip = new Set([
    g.idle.name,
    ...(g.routing.kind === 'collapsed' ? [g.routing.routed.name] : g.routing.outputs.map((o) => o.routed.name)),
  ]);
  return [...new Set(successBranches(c, node, port).flat())].filter((n) => !skip.has(n)).sort();
}
