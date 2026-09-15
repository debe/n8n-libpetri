/**
 * Where a workflow export starts: the first node with no incoming main connection, preferring
 * one whose type looks like a trigger, in canvas order; `--start` overrides it.
 */
import type { MainConnection, NodeDescription } from '../../compiler/index.js';

/** n8n's own convention: a trigger type ends in `Trigger`, plus the fixed legacy names. */
const TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.start',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.interval',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.formTrigger',
]);

export function looksLikeTrigger(type: string): boolean {
  return TRIGGER_TYPES.has(type) || /trigger$/i.test(type);
}

/** The first node with no incoming connection, triggers first, in canvas (y, x) order. */
export function pickStartNode(
  nodes: readonly NodeDescription[], connections: readonly MainConnection[],
): string {
  const fed = new Set(connections.map((c) => c.to));
  const ordered = [...nodes].sort((a, b) =>
    a.position[1] - b.position[1] || a.position[0] - b.position[0] || a.name.localeCompare(b.name));
  const roots = ordered.filter((n) => !fed.has(n.name) && n.disabled !== true);
  const trigger = roots.find((n) => looksLikeTrigger(n.type));
  const start = trigger ?? roots[0] ?? ordered[0];
  if (start === undefined) throw new Error('workflow has no nodes');
  return start.name;
}

/**
 * The start node: `requested` (`--start`) when given, else {@link pickStartNode} over the
 * scheduled nodes. It must name a node the scheduler runs: an annotation or a `supplyData`
 * sub-node has no gadget to seed, and the compiler would refuse the start node it was handed.
 */
export function startNodeOf(
  requested: string | undefined,
  scheduled: readonly NodeDescription[],
  names: ReadonlySet<string>,
  connections: readonly MainConnection[],
): string {
  const startNode = requested ?? pickStartNode(scheduled, connections);
  if (!names.has(startNode)) throw new Error(`start node '${startNode}' is not a node of this workflow`);
  if (!scheduled.some((n) => n.name === startNode)) {
    throw new Error(
      `start node '${startNode}' is not a node the scheduler runs (an annotation, or a sub-node resolved by supplyData)`);
  }
  return startNode;
}
