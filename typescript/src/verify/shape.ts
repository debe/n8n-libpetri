/**
 * Structural facts about the workflow and its flattened net that the property families read
 * without asking either route anything: which nodes are alternative entry points, what shape
 * explains a truncation, which node pairs a mutual-exclusion request names, and which flat
 * transitions produce on a place.
 *
 * All of it is read off the compiler's own analysis or the flattener's post-vectors, so none
 * of it can come back `unknown`.
 */
import type { Place } from 'libpetri';
import type { FlatNet } from 'libpetri/verification';
import type { CompiledWorkflow, NetMapView } from '../compiler/index.js';
import type { TruncationShape } from './state-class.js';
import type { MutualExclusionRequest } from './types.js';

/**
 * Nodes that can never run in **this** compiled execution only because n8n starts one
 * trigger per execution: an entry point (a node whose type declares no input) that is not
 * the start node the workflow was compiled with, plus everything reachable from it and from
 * no start node. `initialMarking` seeds only `startNodes[0]`'s own input (README "Initial
 * marking and the marking codec"), so `unreachable({X/running})` really is `proven` for
 * them — but a Manual-plus-Webhook workflow is an ordinary n8n pattern, not a defect, and
 * reporting one as a finding would fail the CLI's exit-code gate on a healthy workflow.
 *
 * A node with no incoming connection whose *shape* has an input is **not** an entry point:
 * n8n can never start there, so a dead one is a real finding (the `Orphan` fixture).
 *
 * Returns node name → the entry point it belongs to (an entry point maps to itself).
 */
export function alternativeEntryReach(compiled: CompiledWorkflow): Map<string, string> {
  const analysis = compiled.analysis;
  const starts = new Set(compiled.startNodes);
  const found = new Map<string, string>();
  for (const a of analysis.nodes) {
    const entry = a.node.name;
    if (starts.has(entry) || a.shape.inputCount !== 0 || analysis.reachable.has(entry)) continue;
    const stack = [entry];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (found.has(name)) continue;
      found.set(name, entry);
      // A node a start node reaches is not dead at all, and must not be excused here.
      for (const e of analysis.outgoing.get(name) ?? []) {
        if (!analysis.reachable.has(e.to) && !found.has(e.to)) stack.push(e.to);
      }
    }
  }
  return found;
}

/**
 * The workflow shape behind a truncation cause, from the compiler's own analysis: whether it
 * has a cycle, and whether any node has two or more distinct successors.
 *
 * The second is *evidence* for the "independent parallel branches" reading of a blow-up
 * (NU-053), and its absence is evidence against it: a chain that truncates truncated because
 * the cap was too small, and saying "independent parallel branches" there sends the reader
 * looking for a fan-out that is not in the workflow.
 */
export function truncationShapeOf(compiled: CompiledWorkflow): TruncationShape {
  let branching = false;
  for (const [, edges] of compiled.analysis.outgoing) {
    if (new Set(edges.map((e) => e.to)).size > 1) {
      branching = true;
      break;
    }
  }
  const agents = compiled.netMap.nodes.flatMap((g) => (g.agent === null ? [] : [{
    node: g.node, tools: g.agent.tools.length, maxToolCalls: g.agent.maxToolCalls, assumed: g.agent.toolCallsAssumed,
  }]));
  return { hasCycle: compiled.analysis.hasCycle, independentBranches: branching, agents };
}

/** Node pairs, or every unordered pair in declaration order. */
export function exclusionPairs(map: NetMapView, request: MutualExclusionRequest): Array<readonly [string, string]> {
  if (request !== 'all-pairs') return request.map((p) => [p[0], p[1]] as const);
  const names = map.nodes.map((g) => g.node);
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i]!, names[j]!] as const);
  }
  return pairs;
}

/**
 * The flat transitions that **produce** tokens on each of `places`, read off the encoder's own
 * post-vectors, in flat-transition order — one pass over the transitions for all of them, where
 * asking {@link producersOf} place by place would pay one pass each. A place the flattener does
 * not know maps to no producers.
 *
 * Only the places asked about are indexed: a post-vector is dense (one entry per place), so an
 * index of every place would cost transitions x places, more than the per-place scans it
 * replaces whenever a family asks about fewer places than the net has.
 */
export function producerIndex(flat: FlatNet, places: readonly Place<unknown>[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const wanted: Array<readonly [string[], number]> = [];
  for (const place of places) {
    if (index.has(place.name)) continue;
    const producers: string[] = [];
    index.set(place.name, producers);
    const at = flat.placeIndex.get(place.name);
    if (at !== undefined) wanted.push([producers, at]);
  }
  for (const t of flat.transitions) {
    for (const [producers, at] of wanted) {
      if ((t.postVector[at] ?? 0) > 0) producers.push(t.name);
    }
  }
  return index;
}

/** The flat transitions that **produce** tokens on `place`, read off the encoder's own post-vectors. */
export function producersOf(flat: FlatNet, place: Place<unknown>): string[] {
  return producerIndex(flat, [place]).get(place.name) ?? [];
}
