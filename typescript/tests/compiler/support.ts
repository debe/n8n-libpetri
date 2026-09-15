/**
 * Shared helpers for the compiler suite: structural introspection of a `CompiledWorkflow`
 * and running its net to natural quiescence (EXEC-040) on either libpetri executor with
 * an `InMemoryEventStore` attached. `run()` is never given a timeout (CLAUDE.md).
 *
 * The event-store readers and the `NetMap` narrowing helpers live in `tests/support/`, where
 * the other suites share them; they are re-exported here, so this module's surface is what it
 * always was.
 */
import {
  BitmapNetExecutor, InMemoryEventStore, PrecompiledNetExecutor, enumerateBranches,
  type Marking, type Place, type Token, type Transition,
} from 'libpetri';
import type { CompiledWorkflow } from '../../src/compiler/index.js';
import { gadget, routedOf } from '../support/netmap.js';

export { failed, isStartOf, started } from '../support/events.js';
export {
  agentOf, asForm, asSlot, edgeSlot, freeOf, gadget, hasdataOf, inEmptyOf, inOf, inToolOf, inputOf, orInputOf,
  readyDataOf, readyEmptyOf, readyOf, retryOf, routedOf, splitOutputsOf, transitionInfoOf,
} from '../support/netmap.js';

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
