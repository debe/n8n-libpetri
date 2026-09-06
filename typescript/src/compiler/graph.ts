/**
 * Structural analysis of the main-connection graph: validation, canvas order, SCC
 * decomposition (Tarjan), edge classification for the emission rule, reachability from the
 * start node, depth (longest path in the SCC condensation, the `X_start` priority under
 * EXEC-002), the classification of `$('Y')` references (README "Expression references"),
 * the required-input facts of the join gadget and the k-safety facts the budget check needs.
 */
import type {
  EdgeRef, JoinForm, NodeDescription, NodeTypeShape, OnError, WorkflowDescription,
} from './types.js';

/**
 * n8n's retry parameters as `WorkflowExecute.getRetryParams` reads them
 * (`workflow-execute.ts` @ `441970b`, lines 1801–1811):
 * `maxTries = min(5, max(2, node.maxTries || 3))`,
 * `waitBetweenTries = min(5000, max(0, node.waitBetweenTries || 1000))`.
 * `0`, `undefined` and `NaN` are falsy and take the default; out-of-range values are
 * clamped; nothing is rejected.
 */
export const DEFAULT_MAX_TRIES = 3;
export const MIN_MAX_TRIES = 2;
export const MAX_MAX_TRIES = 5;
export const DEFAULT_WAIT_BETWEEN_TRIES_MS = 1000;
export const MAX_WAIT_BETWEEN_TRIES_MS = 5000;

export interface RetryParams {
  readonly maxTries: number;
  readonly waitBetweenTries: number;
}

/** The clamped retry parameters of a `retryOnFail` node (see the constants above). */
export function retryParamsOf(node: Pick<NodeDescription, 'maxTries' | 'waitBetweenTries'>): RetryParams {
  return {
    maxTries: Math.min(MAX_MAX_TRIES, Math.max(MIN_MAX_TRIES, node.maxTries || DEFAULT_MAX_TRIES)),
    waitBetweenTries: Math.min(MAX_WAIT_BETWEEN_TRIES_MS, Math.max(0, node.waitBetweenTries || DEFAULT_WAIT_BETWEEN_TRIES_MS)),
  };
}

/**
 * How one `$('Y')` reference from `X` compiles (README "Expression references"):
 * - `read`: `Y` is reachable from the start node on a path avoiding `X` — `X_start` reads
 *   `Y/done`, the `X_start_unmet` twin reads `Y/skipped`;
 * - `seeded`: `Y` is unreachable from the start node — the same arcs, and `Y/skipped` is
 *   seeded in the initial marking so the reference fails exactly as in n8n;
 * - `unguarded`: `Y` is reachable only through `X` (self, downstream or loop-back) — no
 *   arc; the expression fails inside the action as in n8n.
 */
export type ReferenceKind = 'read' | 'seeded' | 'unguarded';

export interface ResolvedReference {
  readonly node: string;
  readonly kind: ReferenceKind;
}

export interface AnalysedNode {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
  /** Position in canvas order ((y, x) ascending): the declaration order of the gadget. */
  readonly index: number;
  /** `shape.outputCount`, plus one for the error output under `continueErrorOutput`. */
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly onError: OnError;
  readonly retryOnFail: boolean;
  /** Clamped (`retryParamsOf`) when `retryOnFail`; `null` otherwise. */
  readonly maxTries: number | null;
  readonly waitBetweenTries: number | null;
  /** Classified expression references (existing nodes), resolver order, no duplicates. */
  readonly references: readonly ResolvedReference[];
  /** `requiredInputs` names every input: every connected input must carry data. */
  readonly allRequired: boolean;
  /**
   * Inputs that must carry data for the node to run: every index below `inputCount` when
   * `allRequired`, the listed indexes for a shorter non-empty array, `null` for the
   * generic join (`undefined`, `[]`, or a number below `inputCount`).
   */
  readonly requiredInputs: readonly number[] | null;
  /**
   * Required inputs with no producer below the highest wired index. n8n pads the lower
   * inputs (`mapConnectionsByDestination`) and never runs such a node; the join gadget
   * models them as inputs that never receive a token.
   */
  readonly deadInputs: readonly number[];
}

export interface MultiProducerInput {
  readonly node: string;
  readonly inputIndex: number;
  readonly producers: number;
}

export interface WorkflowAnalysis {
  /** The primary start node (`startNodes[0]`): n8n's `nodeExecutionStack[0]`. */
  readonly startNode: string;
  /** Every start node: the primary first, then the others in canvas order, no duplicates. */
  readonly startNodes: readonly string[];
  /** Nodes in canvas order. */
  readonly nodes: readonly AnalysedNode[];
  readonly byName: ReadonlyMap<string, AnalysedNode>;
  /** Deduplicated connections in canonical order, ids ascending. */
  readonly edges: readonly EdgeRef[];
  readonly incoming: ReadonlyMap<string, readonly EdgeRef[]>;
  readonly outgoing: ReadonlyMap<string, readonly EdgeRef[]>;
  /** Node name to SCC index (Tarjan emission order: reverse topological). */
  readonly sccOf: ReadonlyMap<string, number>;
  readonly sccs: readonly (readonly string[])[];
  /** Nodes in a non-trivial SCC or carrying a self-loop: producers "in a cycle". */
  readonly cyclic: ReadonlySet<string>;
  /** Nodes reachable from the union of the start nodes. */
  readonly reachable: ReadonlySet<string>;
  /** Longest path (tree edges) from any start node's SCC; unreachable nodes get 0. */
  readonly depth: ReadonlyMap<string, number>;
  readonly maxDepth: number;
  readonly hasCycle: boolean;
  readonly multiProducerInputs: readonly MultiProducerInput[];
  /** Nodes referenced with a read arc (`read` or `seeded`): their `skipped` place must exist. */
  readonly referenced: ReadonlySet<string>;
  /** Referenced nodes unreachable from every start node: `Y/skipped` is seeded. */
  readonly seededSkipped: ReadonlySet<string>;
  readonly diagnostics: readonly string[];
}

/** Whether `requiredInputs` names every input (n8n `workflow-execute.ts`, the R6 check). */
export function isAllRequired(shape: NodeTypeShape): boolean {
  const r = shape.requiredInputs;
  if (r === undefined) return false;
  if (typeof r === 'number') return r === shape.inputCount;
  return r.length === shape.inputCount;
}

/** The inputs that must carry data (see `AnalysedNode.requiredInputs`). */
export function requiredInputsOf(shape: NodeTypeShape): readonly number[] | null {
  if (isAllRequired(shape)) return Array.from({ length: shape.inputCount }, (_, i) => i);
  const r = shape.requiredInputs;
  if (r === undefined || typeof r === 'number' || r.length === 0) return null;
  return [...new Set(r)].filter((i) => Number.isInteger(i) && i >= 0 && i < shape.inputCount).sort((x, y) => x - y);
}

/**
 * Chooses the input-side gadget. `direct` for at most one producer on one input (dead
 * inputs count as inputs); `or` for one input with several empty-capable (tree) producer
 * edges (README "OR-inputs"; producers inside a cycle carry `nil`, never `empty`, and do
 * not count); otherwise the join gadget, `choose-branch` when some inputs are required.
 */
export function joinFormOf(a: AnalysedNode, incoming: readonly EdgeRef[]): JoinForm {
  const indexes = new Set<number>(a.deadInputs);
  for (const e of incoming) indexes.add(e.inputIndex);
  if (indexes.size <= 1) {
    const treeEdges = incoming.filter((e) => e.kind === 'tree').length;
    if (treeEdges > 1) return 'or';
    if (incoming.length <= 1) return 'direct';
    return 'join';
  }
  return a.requiredInputs === null ? 'join' : 'choose-branch';
}

function compareCanvas(a: NodeDescription, b: NodeDescription): number {
  const [ax, ay] = a.position;
  const [bx, by] = b.position;
  if (ay !== by) return ay - by;
  if (ax !== bx) return ax - bx;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function nonNegativeInt(v: number, what: string): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer, got ${v}`);
}

/** Nodes reachable from any of `starts` over `succ`, never entering `avoid`. */
function reachFrom(starts: readonly string[], succ: ReadonlyMap<string, readonly string[]>, avoid: string | null): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const start of starts) {
    if (start === avoid || seen.has(start)) continue;
    seen.add(start);
    stack.push(start);
  }
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const m of succ.get(n) ?? []) {
      if (m === avoid || seen.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return seen;
}

interface RawNode {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
  readonly index: number;
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly onError: OnError;
  readonly retryOnFail: boolean;
  readonly maxTries: number | null;
  readonly waitBetweenTries: number | null;
  /** Existing referenced nodes, resolver order, no duplicates, self included (classified later). */
  readonly rawReferences: readonly string[];
  readonly allRequired: boolean;
  readonly requiredInputs: readonly number[] | null;
}

export function analyse(workflow: WorkflowDescription): WorkflowAnalysis {
  const diagnostics: string[] = [];
  if (workflow.nodes.length === 0) throw new Error('compile: workflow has no nodes');

  // ---- nodes: uniqueness, prefix validity, canvas order ----
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const n of workflow.nodes) {
    if (names.has(n.name)) throw new Error(`compile: duplicate node name '${n.name}'`);
    names.add(n.name);
    if (n.id.length === 0) throw new Error(`compile: node '${n.name}' has an empty id`);
    if (n.id.includes('/')) {
      throw new Error(`compile: node '${n.name}' id '${n.id}' contains '/', the MOD-010 prefix separator`);
    }
    if (ids.has(n.id)) throw new Error(`compile: duplicate node id '${n.id}'`);
    ids.add(n.id);
  }
  const declaredStarts = workflow.startNodes ?? (workflow.startNode === undefined ? [] : [workflow.startNode]);
  if (declaredStarts.length === 0) throw new Error('compile: workflow declares no start node');
  for (const s of declaredStarts) {
    if (!names.has(s)) throw new Error(`compile: start node '${s}' is not in the workflow`);
  }
  const ordered = [...workflow.nodes].sort(compareCanvas);
  // Canonical start list: the primary first (it alone is seeded by initialMarking), the
  // rest in canvas order, so the same set hashes alike whatever order it was listed in.
  const primaryStart = declaredStarts[0]!;
  const startSet = new Set(declaredStarts);
  const startNodes = [primaryStart, ...ordered.map((n) => n.name).filter((n) => n !== primaryStart && startSet.has(n))];

  const raws: RawNode[] = [];
  const rawByName = new Map<string, RawNode>();
  ordered.forEach((node, index) => {
    const shape = workflow.nodeTypes(node);
    nonNegativeInt(shape.inputCount, `node '${node.name}' inputCount`);
    nonNegativeInt(shape.outputCount, `node '${node.name}' outputCount`);
    const onError: OnError = node.onError ?? 'stopWorkflow';
    const errorOutputIndex = onError === 'continueErrorOutput' ? shape.outputCount : null;
    const retryOnFail = node.retryOnFail === true;
    const retry = retryOnFail ? retryParamsOf(node) : null;
    const rawReferences: string[] = [];
    for (const ref of workflow.expressionReferences?.(node) ?? []) {
      if (!names.has(ref)) {
        diagnostics.push(`node '${node.name}' references unknown node '${ref}'; ignored`);
        continue;
      }
      if (!rawReferences.includes(ref)) rawReferences.push(ref);
    }
    const r: RawNode = {
      node, shape, index,
      outputCount: shape.outputCount + (errorOutputIndex === null ? 0 : 1),
      errorOutputIndex, onError, retryOnFail,
      maxTries: retry === null ? null : retry.maxTries,
      waitBetweenTries: retry === null ? null : retry.waitBetweenTries,
      rawReferences, allRequired: isAllRequired(shape), requiredInputs: requiredInputsOf(shape),
    };
    raws.push(r);
    rawByName.set(node.name, r);
  });

  // ---- connections: validation, deduplication, canonical order ----
  const seen = new Set<string>();
  const raw: Omit<EdgeRef, 'id' | 'kind'>[] = [];
  for (const c of workflow.connections) {
    const from = rawByName.get(c.from);
    const to = rawByName.get(c.to);
    if (from === undefined) throw new Error(`compile: connection from unknown node '${c.from}'`);
    if (to === undefined) throw new Error(`compile: connection to unknown node '${c.to}'`);
    if (!Number.isInteger(c.outputIndex) || c.outputIndex < 0 || c.outputIndex >= from.outputCount) {
      throw new Error(
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `output index out of range (node has ${from.outputCount} outputs)`);
    }
    if (!Number.isInteger(c.inputIndex) || c.inputIndex < 0 || c.inputIndex >= to.shape.inputCount) {
      throw new Error(
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `input index out of range (node has ${to.shape.inputCount} inputs)`);
    }
    const key = `${c.from} ${c.outputIndex} ${c.to} ${c.inputIndex}`;
    if (seen.has(key)) {
      diagnostics.push(`duplicate connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}; ignored`);
      continue;
    }
    seen.add(key);
    raw.push({ from: c.from, outputIndex: c.outputIndex, to: c.to, inputIndex: c.inputIndex });
  }
  raw.sort((x, y) =>
    (rawByName.get(x.from)!.index - rawByName.get(y.from)!.index) ||
    (x.outputIndex - y.outputIndex) ||
    (rawByName.get(x.to)!.index - rawByName.get(y.to)!.index) ||
    (x.inputIndex - y.inputIndex));

  // ---- SCC decomposition (Tarjan) ----
  const succ = new Map<string, string[]>();
  for (const r of raws) succ.set(r.node.name, []);
  for (const e of raw) succ.get(e.from)!.push(e.to);
  const { sccOf, sccs } = tarjan(raws.map((r) => r.node.name), succ);
  const cyclic = new Set<string>();
  for (const scc of sccs) if (scc.length > 1) for (const n of scc) cyclic.add(n);
  for (const e of raw) if (e.from === e.to) cyclic.add(e.from);

  const edges: EdgeRef[] = raw.map((e, id) => ({
    ...e, id, kind: sccOf.get(e.from) === sccOf.get(e.to) ? 'cycle' : 'tree',
  }));
  const incoming = new Map<string, EdgeRef[]>();
  const outgoing = new Map<string, EdgeRef[]>();
  for (const r of raws) {
    incoming.set(r.node.name, []);
    outgoing.set(r.node.name, []);
  }
  for (const e of edges) {
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }

  // ---- reachability from the union of the start nodes ----
  const reachable = reachFrom(startNodes, succ, null);

  // ---- depth: longest path over the condensation from any start node, in topological order ----
  // Tarjan emits SCCs in reverse topological order, so walking them backwards visits every
  // SCC after all of its predecessors.
  const sccDepth = new Array<number>(sccs.length).fill(-1);
  for (const s of startNodes) sccDepth[sccOf.get(s)!] = 0;
  for (let s = sccs.length - 1; s >= 0; s--) {
    const d = sccDepth[s]!;
    if (d < 0) continue;
    for (const n of sccs[s]!) {
      for (const e of outgoing.get(n)!) {
        if (e.kind === 'tree') {
          const t = sccOf.get(e.to)!;
          if (sccDepth[t]! < d + 1) sccDepth[t] = d + 1;
        }
      }
    }
  }
  const depth = new Map<string, number>();
  let maxDepth = 0;
  for (const r of raws) {
    const d = Math.max(0, sccDepth[sccOf.get(r.node.name)!]!);
    depth.set(r.node.name, d);
    if (d > maxDepth) maxDepth = d;
  }

  // ---- references: classified by reachability avoiding the referencing node ----
  const referenced = new Set<string>();
  const seededSkipped = new Set<string>();
  const referencesOf = new Map<string, ResolvedReference[]>();
  for (const r of raws) {
    const x = r.node.name;
    const resolved: ResolvedReference[] = [];
    let avoiding: Set<string> | null = null;
    for (const y of r.rawReferences) {
      if (y === x) {
        diagnostics.push(`node '${x}' references itself; the expression fails inside the action as in n8n`);
        resolved.push({ node: y, kind: 'unguarded' });
        continue;
      }
      if (!reachable.has(y)) {
        diagnostics.push(
          `node '${x}' references '${y}', which is unreachable from the start node${startNodes.length > 1 ? 's' : ''}; ` +
          `'${y}/skipped' is seeded and the reference always fails`);
        resolved.push({ node: y, kind: 'seeded' });
        referenced.add(y);
        seededSkipped.add(y);
        continue;
      }
      avoiding ??= reachFrom(startNodes, succ, x);
      if (avoiding.has(y)) {
        resolved.push({ node: y, kind: 'read' });
        referenced.add(y);
      } else {
        diagnostics.push(
          `node '${x}' references '${y}', which is reachable only through '${x}'; ` +
          'no read arc, the expression fails inside the action as in n8n');
        resolved.push({ node: y, kind: 'unguarded' });
      }
    }
    referencesOf.set(x, resolved);
  }

  // ---- dead required inputs (README join gadget) ----
  const deadInputsOf = new Map<string, number[]>();
  for (const r of raws) {
    const wired = new Set<number>();
    let maxWired = -1;
    for (const e of incoming.get(r.node.name)!) {
      wired.add(e.inputIndex);
      if (e.inputIndex > maxWired) maxWired = e.inputIndex;
    }
    const dead: number[] = [];
    if (r.requiredInputs !== null && maxWired >= 1) {
      for (const i of r.requiredInputs) if (i < maxWired && !wired.has(i)) dead.push(i);
    }
    if (dead.length > 0) {
      diagnostics.push(
        `node '${r.node.name}' requires input${dead.length > 1 ? 's' : ''} ${dead.join(', ')} ` +
        `but ${dead.length > 1 ? 'they have' : 'it has'} no producer; n8n pads the lower inputs and never runs it, ` +
        'so the join can never complete');
    }
    deadInputsOf.set(r.node.name, dead);
  }

  const analysed: AnalysedNode[] = raws.map((r) => ({
    node: r.node, shape: r.shape, index: r.index, outputCount: r.outputCount,
    errorOutputIndex: r.errorOutputIndex, onError: r.onError, retryOnFail: r.retryOnFail,
    maxTries: r.maxTries, waitBetweenTries: r.waitBetweenTries,
    references: referencesOf.get(r.node.name)!,
    allRequired: r.allRequired, requiredInputs: r.requiredInputs, deadInputs: deadInputsOf.get(r.node.name)!,
  }));
  const byName = new Map<string, AnalysedNode>();
  for (const a of analysed) byName.set(a.node.name, a);

  // ---- k-safety facts ----
  const producers = new Map<string, MultiProducerInput>();
  for (const e of edges) {
    const key = `${e.to} ${e.inputIndex}`;
    const prev = producers.get(key);
    producers.set(key, prev === undefined
      ? { node: e.to, inputIndex: e.inputIndex, producers: 1 }
      : { ...prev, producers: prev.producers + 1 });
  }
  const multiProducerInputs = [...producers.values()].filter((p) => p.producers > 1);

  return {
    startNode: primaryStart, startNodes,
    nodes: analysed, byName, edges, incoming, outgoing, sccOf, sccs, cyclic, reachable,
    depth, maxDepth, hasCycle: cyclic.size > 0, multiProducerInputs, referenced, seededSkipped, diagnostics,
  };
}

/** Tarjan's SCC algorithm; SCCs are emitted in reverse topological order. */
function tarjan(
  names: readonly string[],
  succ: ReadonlyMap<string, readonly string[]>,
): { sccOf: Map<string, number>; sccs: string[][] } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>();
  const sccs: string[][] = [];
  let counter = 0;

  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of succ.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        sccOf.set(w, sccs.length);
      } while (w !== v);
      sccs.push(scc);
    }
  };

  for (const n of names) if (!index.has(n)) visit(n);
  return { sccOf, sccs };
}
