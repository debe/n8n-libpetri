/**
 * The scheduler's graph, read off n8n's connections-by-source map: main connections, `ai_tool`
 * connections, and which nodes the scheduler never runs.
 *
 * A connection to a node the workflow does not contain is dropped (n8n throws `Destination
 * node not found` only when the producer runs; the compiler would reject the whole workflow up
 * front).
 */
import type { IConnection, INodeConnections, Workflow } from 'n8n-workflow';
import type { MainConnection, ToolConnection } from '../../compiler/index.js';
import { fieldOf, recordOf } from './readers.js';

/**
 * n8n node types that are annotations, not work: the canvas draws them and the engine never
 * schedules them. A quarter of the nodes in n8n's public template library are sticky notes,
 * and compiling one produces a gadget that can never fire — dead weight in the net and a
 * "this node can never run" finding that is true and useless.
 */
export const NON_EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.stickyNote',
]);

/**
 * Whether a node belongs to the *scheduler's* graph at all.
 *
 * Two kinds do not. An annotation ({@link NON_EXECUTABLE_TYPES}) never runs. And a **sub-node**
 * — a language model, a memory, an output parser, an embedding — reaches its consumer over an
 * `ai_*` connection that is *not* `ai_tool`, and every one of those is resolved by `supplyData`
 * inside `runNode`, never by a scheduler (CLAUDE.md; ADR 0008). Such a node has no `main`
 * connection either way, so compiling it yields an unreachable gadget and a false dead-node
 * report — measured at 523 sticky notes and ~100 sub-nodes across 200 published templates.
 *
 * The test is deliberately conservative: a node is dropped only when it has **no** `main`
 * connection in either direction and **no** `ai_tool` connection, and does appear as the source
 * of some other `ai_*` connection. A node wired both ways keeps its gadget.
 */
export function isSchedulerNode(
  name: string,
  type: string,
  hasMain: (node: string) => boolean,
  hasToolWiring: (node: string) => boolean,
  isSubNodeSource: (node: string) => boolean,
): boolean {
  if (NON_EXECUTABLE_TYPES.has(type)) return false;
  if (hasMain(name) || hasToolWiring(name)) return true;
  return !isSubNodeSource(name);
}

/** The nodes of a workflow the scheduler runs, and the diagnostic for the ones it does not. */
export interface ScheduledNodes<N> {
  /** The nodes {@link isSchedulerNode} keeps, in their order. */
  readonly scheduled: N[];
  /** How many were left out, as one diagnostic; empty when every node was kept. */
  readonly diagnostics: string[];
}

/**
 * The scheduler's graph, not the canvas's — the rule the live adapter and the verify CLI both
 * apply, because one net serves execution and verification and a CLI that analysed a different
 * set of nodes would report about a different net.
 */
export function scheduledNodesOf<N extends { readonly name: string; readonly type: string }>(
  nodes: readonly N[],
  connections: readonly MainConnection[],
  toolConnections: readonly ToolConnection[],
  subNodeSources: ReadonlySet<string>,
): ScheduledNodes<N> {
  const wiredMain = new Set(connections.flatMap((c) => [c.from, c.to]));
  const wiredTool = new Set(toolConnections.flatMap((c) => [c.agent, c.tool]));
  const scheduled = nodes.filter((n) => isSchedulerNode(
    n.name, n.type, (x) => wiredMain.has(x), (x) => wiredTool.has(x), (x) => subNodeSources.has(x)));
  const dropped = nodes.length - scheduled.length;
  return {
    scheduled,
    diagnostics: dropped === 0 ? [] : [
      `${dropped} node(s) are not part of the scheduler's graph (annotations, or sub-nodes ` +
      'resolved by supplyData inside runNode) and are not compiled',
    ],
  };
}

/**
 * Nodes that are the source of an `ai_*` connection other than `ai_tool`, read off a
 * connections-by-source map in n8n's shape (`{ "<from>": { "<type>": [ [ … ] ] } }`) — the
 * live `Workflow`'s or a JSON export's, which is why it takes the map and not the workflow.
 */
export function subNodeSourcesIn(bySource: Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const [from, byType] of Object.entries(bySource)) {
    for (const [key, groups] of Object.entries(recordOf(byType) ?? {})) {
      if (key === 'main' || key === 'ai_tool') continue;
      if (Array.isArray(groups) && groups.some((g) => Array.isArray(g) && g.length > 0)) out.add(from);
    }
  }
  return out;
}

/** {@link subNodeSourcesIn} over `workflow.connectionsBySourceNode`. */
export function subNodeSourcesOf(workflow: Workflow): Set<string> {
  return subNodeSourcesIn(workflow.connectionsBySourceNode);
}

/** The entries of `workflow.connectionsBySourceNode` whose source is a node of the workflow. */
function ownSources(workflow: Workflow): Array<[string, INodeConnections]> {
  return Object.entries(workflow.connectionsBySourceNode).filter(([from]) => Object.hasOwn(workflow.nodes, from));
}

/** Each connection of `type` in `groups` whose target is a node of `workflow`, with its output index. */
function liveTargets(
  workflow: Workflow, groups: ReadonlyArray<IConnection[] | null | undefined>, type: string,
): Array<readonly [IConnection, number]> {
  const out: Array<readonly [IConnection, number]> = [];
  groups.forEach((connections, outputIndex) => {
    for (const c of connections ?? []) {
      if (c.type === type && Object.hasOwn(workflow.nodes, c.node)) out.push([c, outputIndex]);
    }
  });
  return out;
}

/** `workflow.connectionsBySourceNode[*].main` as compiler connections; dangling targets dropped. */
export function mainConnectionsOf(workflow: Workflow): MainConnection[] {
  return ownSources(workflow).flatMap(([from, byType]) =>
    liveTargets(workflow, byType?.main ?? [], 'main')
      .map(([c, outputIndex]) => ({ from, outputIndex, to: c.node, inputIndex: c.index })));
}

/**
 * `workflow.connectionsBySourceNode[*].ai_tool` as compiler tool connections: n8n wires these
 * from the tool node into the agent, which is the direction {@link ToolConnection} keeps.
 *
 * This is the only non-`main` connection type the scheduler ever sees. Every other `ai_*` type
 * is resolved by `supplyData` inside `runNode` (`get-input-connection-data.ts`) and never
 * reaches a scheduler, so reading only this one is the whole story, not an approximation.
 */
export function toolConnectionsOf(workflow: Workflow): ToolConnection[] {
  return ownSources(workflow).flatMap(([from, byType]) => {
    const byAiTool = fieldOf(byType, 'ai_tool');
    if (!Array.isArray(byAiTool)) return [];
    return liveTargets(workflow, byAiTool as Array<IConnection[] | null>, 'ai_tool')
      .map(([c]) => ({ agent: c.node, tool: from }));
  });
}
