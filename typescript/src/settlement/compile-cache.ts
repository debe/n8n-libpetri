/**
 * The compile memo of the settlement policy (`tasks/v2-seam-plan.md` decision 10): one `engineV2`
 * net per graph, compiled on the first settlement that names the graph and reused by every later
 * one, whichever execution it belongs to.
 *
 * - **Pure memo of the graph.** The key is the sha256 of the graph's canonical JSON: `nodes` and
 *   `edges` in the order the graph gives them, every object's keys sorted. Order is kept because it
 *   is meaning: edge order is `decideSuccessors`' order and node order is the net's declaration
 *   order. Nothing per execution is stored, so a cached entry is the same answer for any execution
 *   of the graph, and the policy stays a function of the rows it reads.
 * - **The whole graph is hashed**, node config included, though stage 1 reads only part of it
 *   (`n8n/v2-graph.ts`). Hashing less would need a second copy of what stage 1 reads and would
 *   go wrong silently when that changes; hashing everything can only cost a miss.
 * - **A refusal is cached as a refusal.** A graph that does not compile (`V2GraphError`,
 *   `CompileError`) is refused again on every settlement without compiling again, each time with a
 *   fresh {@link SettlementCompileRefusal} carrying the first error as its `cause`. The policy does
 *   not fall back to n8n's planner (decision 8): the refusal reaches the handler as a throw.
 * - **Bounded LRU.** At most `maxEntries` graphs, refusals included; the least recently used is
 *   evicted first.
 * - **Graph objects are read once.** `StepSettledHandler` hands both policy calls of one
 *   settlement the same `execution.graph` object, so the key is also remembered per graph object
 *   (weakly) and not recomputed. A converted graph is not mutated afterwards; `settlement/scope.ts`
 *   relies on that too.
 *
 * Each entry also keeps the first graph object seen with its key, so `candidateKeys`' per-graph
 * derivation (`scope.ts`, keyed by object) is reused across settlements: graphs with one key are
 * the same graph.
 */
import { createHash } from 'node:crypto';
import { compile } from '../compiler/index.js';
import type { CompiledWorkflow } from '../compiler/index.js';
import { graphToDescription } from '../n8n/v2-graph.js';
import type { V2Graph } from '../n8n/v2-graph.js';
import { messageOf } from '../internal/errors.js';

/** A compiled graph: the net, and the graph object the cache keeps for the key. */
export interface CompiledGraph {
  /** sha256 (hex) of the graph's canonical JSON. */
  readonly key: string;
  /** The first graph object seen with this key. Equal, as JSON, to every graph with the key. */
  readonly graph: V2Graph;
  readonly compiled: CompiledWorkflow;
  /**
   * Each node's rank in a topological order of the graph without its back edges (ties in graph
   * order): the order the policy hands rows to the decoder in, so a loop's passes replay in one
   * sweep. The decoder's answer does not depend on the order (`decodeStepRows`); its cost does.
   */
  readonly rank: ReadonlyMap<string, number>;
}

/** A graph the policy cannot compile, refused again from the cache. `cause` is the first error. */
export class SettlementCompileRefusal extends Error {
  override readonly name = 'SettlementCompileRefusal';
  constructor(readonly key: string, readonly first: unknown) {
    super(`settlement policy: the graph ${key.slice(0, 12)} does not compile under the engineV2 profile: ${messageOf(first)}`, { cause: first });
  }
}

/** What the cache has done since it was made. */
export interface CompileCacheStats {
  readonly hits: number;
  readonly misses: number;
  /** Misses that compiled to a refusal, and hits that returned one. */
  readonly refusals: number;
  readonly evictions: number;
  readonly size: number;
}

export interface CompileCache {
  /** The compiled graph for `graph`, compiling it on a miss. Throws {@link SettlementCompileRefusal}. */
  get(graph: V2Graph): CompiledGraph;
  /** The cache key of `graph`. */
  keyOf(graph: V2Graph): string;
  stats(): CompileCacheStats;
  /** Drops every entry; the stats keep counting. */
  clear(): void;
}

export interface CompileCacheOptions {
  /** At most this many graphs are kept, refusals included. Default 128. */
  readonly maxEntries?: number;
  /** How a graph becomes a net. Default: stage 1, then `compile` under `profile: 'engineV2'`. */
  readonly compileGraph?: (graph: V2Graph) => CompiledWorkflow;
}

/** The default `compileGraph`: stage 1 (`graphToDescription`), then the `engineV2` profile. */
export function compileGraph(graph: V2Graph): CompiledWorkflow {
  return compile(graphToDescription(graph).description, { profile: 'engineV2' });
}

/** JSON with every object's keys sorted, arrays in order; `undefined` members dropped, as `JSON.stringify` does. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

/** The cache key of a graph: sha256 of the canonical JSON of `{ nodes, edges }`. */
export function graphKey(graph: V2Graph): string {
  return createHash('sha256').update(canonicalJson({ nodes: graph.nodes, edges: graph.edges })).digest('hex');
}

/** Kahn's order over the edges that are not back edges, ties in graph node order; leftovers after. */
function rankOf(graph: V2Graph): Map<string, number> {
  const ids = graph.nodes.map((n) => n.id);
  const position = new Map(ids.map((id, i) => [id, i]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (e.isBackEdge === true || !position.has(e.from) || !position.has(e.to)) continue;
    next.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const rank = new Map<string, number>();
  let ready = ids.filter((id) => indegree.get(id) === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    rank.set(id, rank.size);
    for (const to of next.get(id)!) {
      const left = indegree.get(to)! - 1;
      indegree.set(to, left);
      if (left === 0) ready.push(to);
    }
  }
  // A cycle without a marked back edge: stage 1 or the compiler refuses it; rank it anyway.
  for (const id of ids) if (!rank.has(id)) rank.set(id, rank.size);
  return rank;
}

type Entry = { readonly ok: true; readonly value: CompiledGraph } | { readonly ok: false; readonly key: string; readonly error: unknown };

/** A bounded LRU compile memo (see the module doc). */
export function createCompileCache(options: CompileCacheOptions = {}): CompileCache {
  const maxEntries = options.maxEntries ?? 128;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError(`createCompileCache: maxEntries is ${maxEntries}; it must be a whole number of at least 1`);
  const build = options.compileGraph ?? compileGraph;
  const entries = new Map<string, Entry>();
  let keys = new WeakMap<V2Graph, string>();
  let hits = 0;
  let misses = 0;
  let refusals = 0;
  let evictions = 0;

  const keyOf = (graph: V2Graph): string => {
    const known = keys.get(graph);
    if (known !== undefined) return known;
    const key = graphKey(graph);
    keys.set(graph, key);
    return key;
  };

  const answer = (entry: Entry): CompiledGraph => {
    if (entry.ok) return entry.value;
    refusals++;
    throw new SettlementCompileRefusal(entry.key, entry.error);
  };

  return {
    keyOf,
    get(graph) {
      const key = keyOf(graph);
      const known = entries.get(key);
      if (known !== undefined) {
        hits++;
        entries.delete(key);
        entries.set(key, known);
        return answer(known);
      }
      misses++;
      let entry: Entry;
      try {
        entry = { ok: true, value: { key, graph, compiled: build(graph), rank: rankOf(graph) } };
      } catch (error) {
        entry = { ok: false, key, error };
      }
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value!);
        evictions++;
      }
      return answer(entry);
    },
    stats: () => ({ hits, misses, refusals, evictions, size: entries.size }),
    clear() {
      entries.clear();
      keys = new WeakMap();
    },
  };
}
