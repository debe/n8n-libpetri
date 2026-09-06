/**
 * Shared helpers for the compiler suite: structural introspection of a `CompiledWorkflow`
 * and running its net to natural quiescence (EXEC-040) on either libpetri executor with
 * an `InMemoryEventStore` attached. `run()` is never given a timeout (CLAUDE.md).
 */
import {
  BitmapNetExecutor, InMemoryEventStore, PrecompiledNetExecutor,
  type Marking, type NetEvent, type Place, type Token, type Transition, type TransitionFailed,
} from 'libpetri';
import type { CompiledWorkflow, NodeGadget } from '../../src/compiler/index.js';

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
