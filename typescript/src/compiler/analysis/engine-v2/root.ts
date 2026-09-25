/**
 * Stage 2 of the engine v2 input (`tasks/v2-profile-plan.md` decision 10, step 13): the port of
 * `V1WorkflowConverter.convert` (`@n8n/node-engine-compatibility` `v1-workflow-converter.ts`,
 * at the pin `n8n@2.41.3`) onto a compiler description. Stage 1 compiles the graph n8n's own
 * converter produced (`conformance/v2/graph.ts`); this builds the same graph from the workflow,
 * so a description from the live adapter or a JSON export compiles to the net n8n's graph
 * would — measured against n8n's converter on the template corpus by `tasks/v2-acceptance.mts`.
 *
 * {@link convertV2} runs `convert`'s steps in its order, each a function here:
 * 1. {@link resolveFiredTrigger}: the trigger that fired, named or the only one;
 * 2. {@link rootAtTrigger}: keep the trigger and what it reaches over `main`, disabled nodes
 *    included ("a disabled node must not cut the reachable set short"), walking the map by name
 *    as n8n does (`WorkflowDescription.strayConnections`);
 * 3. `toGraphNode` on each live node kept but the trigger (`nodes.ts`);
 * 4. `toEdges`: the connection types of every node kept (`nodes.ts`), then its `main` edges;
 * 5. {@link spliceDisabled}: every edge into a disabled node's input slot 0 joined to every edge
 *    out of it; then {@link dedupeEdges}, keyed by node id as n8n keys it;
 * 6. `markBackEdges` (`loops.ts` `markV2BackEdges`): the return edge of each batch loop, or a
 *    refusal.
 *
 * Nodes are visited in description order, which is `workflow.nodes` order on both adapters — the
 * order `convert` visits them in — and edges in connection order, which is the order of n8n's
 * connections-by-source map on both. So with several defects the converter's first is also
 * ours, as far as the description keeps n8n's orders (a connection type is checked per node,
 * then per map key that names no node, not per entry of the connections map).
 */
import { CompileError } from '../../errors.js';
import type { EdgeRef, MainConnection, NodeDescription, WorkflowDescription } from '../../types.js';
import { reachFrom } from '../reachability.js';
import { isV2BatchNode } from './batch.js';
import { markV2BackEdges } from './loops.js';
import { checkV2ConnectionTypes, checkV2ConvertedNode, checkV2StraySources } from './nodes.js';
import { refuseV2 } from './refusals.js';

/**
 * `TRIGGER_NODE_TYPES` (`n8n-workflow` `node-helpers.ts`): the trigger types whose name does not
 * say so.
 */
export const V2_TRIGGER_NODE_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.telegramBot',
  'n8n-nodes-base.start',
]);

/**
 * `isTriggerNodeType` (`n8n-workflow` `node-helpers.ts`), the converter's "type heuristic: there
 * is no `INodeTypes` here": one of {@link V2_TRIGGER_NODE_TYPES}, or a type whose name contains
 * `trigger` in any case.
 */
export function isV2TriggerType(type: string): boolean {
  return V2_TRIGGER_NODE_TYPES.has(type) || type.toLowerCase().includes('trigger');
}

/**
 * The name `convert` is handed as `firedTriggerName`: `CompileOptions.trigger`, or the
 * description's one start node, or none. A description declares the node its execution starts
 * from, which under engine v2 is the trigger that fired; several start nodes (a resumed v1
 * execution) name no one trigger, and v2 fires exactly one.
 */
export function firedTriggerNameOf(workflow: WorkflowDescription, option: string | undefined): string | undefined {
  const declared = new Set(workflow.startNodes ?? (workflow.startNode === undefined ? [] : [workflow.startNode]));
  if (declared.size > 1) {
    throw new CompileError('v2-trigger-count',
      `compile: engine v2 starts from the one trigger that fired, and the workflow declares ${declared.size} start ` +
      `nodes (${[...declared].join(', ')})`);
  }
  const [start] = declared;
  if (option !== undefined && start !== undefined && option !== start) {
    throw new CompileError('invalid-options',
      `compile: the trigger option names '${option}', and the workflow's start node is '${start}'`);
  }
  return option ?? start;
}

/**
 * `resolveFiredTrigger`: among the enabled nodes, the one named — which must exist and be of a
 * trigger type — or, with no name, the only node of a trigger type. Several are refused,
 * "because guessing would run the wrong branch". `null` when there is none: "a trigger-less
 * workflow is the engine's to reject", which {@link convertV2} does after the converter's own
 * checks.
 */
export function resolveFiredTrigger(nodes: readonly NodeDescription[], named: string | undefined): NodeDescription | null {
  const live = nodes.filter((n) => n.disabled !== true);
  if (named !== undefined) {
    const fired = live.find((n) => n.name === named);
    if (fired === undefined) {
      refuseV2('unknownTrigger', `the workflow has no enabled node named '${named}' to start from ` +
        '(UnknownTriggerError, resolveFiredTrigger, v1-workflow-converter.ts)', named);
    }
    if (!isV2TriggerType(fired.type)) {
      refuseV2('notATrigger', `node '${fired.name}' (${fired.type}) is not a trigger, so nothing can start from it ` +
        '(NotATriggerError, resolveFiredTrigger, v1-workflow-converter.ts)', fired.name);
    }
    return fired;
  }
  const triggers = live.filter((n) => isV2TriggerType(n.type));
  if (triggers.length > 1) {
    refuseV2('ambiguousTrigger',
      `the workflow has ${triggers.length} triggers (${triggers.map((n) => `'${n.name}'`).join(', ')}), so the ` +
      'trigger that fired must be named (AmbiguousTriggerError, resolveFiredTrigger, v1-workflow-converter.ts)');
  }
  return triggers[0] ?? null;
}

/**
 * `rootAt`: the trigger and every name it reaches over `main` connections
 * (`getChildNodes(connections, trigger, 'main', -1)`), through disabled nodes and every output
 * and input slot. `getChildNodes` walks n8n's connections map by name, so it also walks the
 * `stray` hops a description's connections cannot hold (`StrayConnections.main`): a name that
 * is no node, and a connection under `main` of another type. The set holds names, and a name
 * that is no node keeps nothing.
 */
export function rootAtTrigger(
  connections: readonly MainConnection[], trigger: string,
  stray: readonly { readonly from: string; readonly to: string }[] = [],
): ReadonlySet<string> {
  const succ = new Map<string, string[]>();
  for (const c of [...connections, ...stray]) {
    const next = succ.get(c.from);
    if (next === undefined) succ.set(c.from, [c.to]);
    else next.push(c.to);
  }
  return reachFrom([trigger], succ, null);
}

/** How the converter names a node in an edge: its id. A test may key edges by name. */
export type V2IdOf = (name: string) => string;
const byName: V2IdOf = (name) => name;

/**
 * `dedupeEdges`' key, exactly: `${from}|${to}|${outputIndex}|${inputIndex}` over node **ids**,
 * the index as written ({@link MainConnection.indexKey}). Ids may hold `|`, so two different
 * edges can print one key — ids `x|y → z` and `x → y|z` — and n8n then keeps only the later.
 */
const edgeKey = (e: MainConnection, idOf: V2IdOf): string =>
  `${idOf(e.from)}|${idOf(e.to)}|${e.outputIndex}|${e.indexKey ?? e.inputIndex}`;

/**
 * `dedupeEdges`: one edge per key (see {@link edgeKey}), at the position of the key's first
 * occurrence, holding its last: n8n's `Map.set` over the edges in order. `idOf` gives a node's
 * id; by default the name stands in.
 */
export function dedupeEdges(edges: readonly MainConnection[], idOf: V2IdOf = byName): MainConnection[] {
  const byKey = new Map<string, MainConnection>();
  for (const e of edges) byKey.set(edgeKey(e, idOf), e);
  return [...byKey.values()];
}

/**
 * `spliceOutDisabledNodes`: for each disabled node in turn, every edge into its input slot 0
 * (other than its own self loop) is joined to every edge out of it (likewise), keeping the
 * source's output slot and the target's input slot; the node's edges go, and the result is
 * deduplicated. Only slot 0 is joined, "because v1 passes nothing else through": an edge into
 * another slot of a disabled node is dropped, and a node fed only that way is left with no
 * incoming edge — an orphan `validateExecutableGraph` refuses once it feeds the reached graph,
 * and v2 owes no step otherwise (`shape.ts`). Out of the node, edges from every output slot
 * are kept, which "deliberately diverges from v1", where pass-through leaves on output 0 only.
 */
export function spliceDisabled(edges: readonly MainConnection[], disabled: readonly string[], idOf: V2IdOf = byName): MainConnection[] {
  let out = [...edges];
  for (const d of disabled) {
    const incoming = out.filter((e) => e.to === d && e.from !== d && e.inputIndex === 0);
    const outgoing = out.filter((e) => e.from === d && e.to !== d);
    const spliced = incoming.flatMap((into) => outgoing.map((outOf): MainConnection => ({
      from: into.from, to: outOf.to, outputIndex: into.outputIndex, inputIndex: outOf.inputIndex,
      ...(outOf.indexKey === undefined ? {} : { indexKey: outOf.indexKey }),
    })));
    out = dedupeEdges(out.filter((e) => e.from !== d && e.to !== d).concat(spliced), idOf);
  }
  return out;
}

/** What {@link convertV2} built: n8n's `WorkflowGraph` for the workflow, by node name. */
export interface V2Conversion {
  /** The fired trigger, v2's `trigger` step. */
  readonly trigger: string;
  /** The graph's nodes: the enabled nodes `rootAt` kept, in description order. */
  readonly nodes: readonly NodeDescription[];
  /** The graph's edges, spliced and deduplicated, in the converter's order. */
  readonly edges: readonly MainConnection[];
  /** Indexes into {@link edges} of the edges `markBackEdges` marks `isBackEdge`. */
  readonly back: ReadonlySet<number>;
  /** Nodes `rootAt` dropped: the trigger does not reach them. Description order. */
  readonly unrooted: readonly string[];
  /** Disabled nodes the trigger reaches, spliced out. Description order. */
  readonly spliced: readonly string[];
}

/**
 * `V1WorkflowConverter.convert(workflow, named)`, followed by `validateExecutableGraph`'s first
 * rule, which is the only one a converted graph can break before the loops are validated: no
 * trigger at all. See the module doc for the steps; each refuses by its `V2_REFUSALS` entry.
 */
export function convertV2(workflow: WorkflowDescription, named: string | undefined): V2Conversion {
  const fired = resolveFiredTrigger(workflow.nodes, named);
  // Rooted first: a disabled node must not cut the reachable set short.
  const stray = workflow.strayConnections;
  const rooted = fired === null ? null : rootAtTrigger(workflow.connections, fired.name, stray?.main);
  const kept = rooted === null ? workflow.nodes : workflow.nodes.filter((n) => rooted.has(n.name));
  const keptNames = new Set(kept.map((n) => n.name));
  const live = kept.filter((n) => n.disabled !== true);
  const disabled = kept.filter((n) => n.disabled === true).map((n) => n.name);

  // `toGraphNode`, per live node but the fired trigger.
  for (const node of live) {
    if (node.name === fired?.name) continue;
    checkV2ConvertedNode(node, () => workflow.nodeTypes(node));
  }

  // `toEdges` on the rooted workflow: the connection types of every kept source — the map's keys
  // that name no node included — then its edges.
  checkV2ConnectionTypes(kept);
  checkV2StraySources(stray?.sources ?? [], rooted);
  // n8n keys `dedupeEdges` by node id; a description's ids are unique, as its names are.
  const ids = new Map(kept.map((n) => [n.name, n.id]));
  const idOf: V2IdOf = (name) => ids.get(name) ?? name;
  const edges = dedupeEdges(spliceDisabled(
    workflow.connections.filter((c) => keptNames.has(c.from) && keptNames.has(c.to)), disabled, idOf), idOf);

  // `markBackEdges` over the graph's nodes (the live kept ones) and edges.
  const refs: EdgeRef[] = edges.map((e, id) => ({ ...e, id, kind: 'tree' }));
  const marking = markV2BackEdges(live.map((n) => n.name), refs, new Set(live.filter(isV2BatchNode).map((n) => n.name)));
  const list = (members: readonly string[]): string => [...members].sort().join(', ');
  if (marking.kind === 'unbatched-cycle') {
    refuseV2('unbatchedCycle',
      `nodes ${list(marking.members)} form a cycle with no batch node; engine v2 loops only through ` +
      'a Split In Batches v3 (UnsupportedCycleError, v1-workflow-converter.ts)', marking.members[0]);
  }
  if (marking.kind === 'ambiguous-entry') {
    refuseV2('loopEntry',
      `the loop of ${list(marking.members)} is entered through ${list(marking.entries)}; a loop needs exactly ` +
      'one way in, through its batch node (UnsupportedLoopEntryError, v1-workflow-converter.ts)', marking.members[0]);
  }

  // `validateExecutableGraph`'s first rule: the converter made no trigger step.
  if (fired === null) {
    refuseV2('noTrigger',
      'engine v2 starts from a trigger, and the workflow has no enabled node of a trigger type ' +
      '(validateExecutableGraph, validate-executable-graph.ts)');
  }
  return {
    trigger: fired.name,
    nodes: live,
    edges,
    back: marking.back,
    unrooted: workflow.nodes.filter((n) => !keptNames.has(n.name)).map((n) => n.name),
    spliced: disabled,
  };
}
