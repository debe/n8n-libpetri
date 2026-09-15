/**
 * A `route` step's target: an output name or index resolved to a connected output index of the
 * node. The emission rule writes connected outputs only, so a step routed anywhere else would
 * have nowhere to put its token; every such target is recorded as a problem instead.
 */
import type { NodeTypeShape } from '../types.js';

/** The node facts a `route` target is resolved against, and the problem list it records into. */
export interface RouteTargets {
  /** `node '<name>'`, the prefix of every problem. */
  readonly where: string;
  readonly shape: NodeTypeShape;
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly connectedOutputs: ReadonlySet<number>;
  readonly problems: string[];
}

/** An output name or index into an output index, not yet checked against the node's outputs. */
function outputIndexOf(t: RouteTargets, raw: string | number, at: string): number | undefined {
  if (typeof raw === 'number') return raw;
  if (raw === 'error' && t.errorOutputIndex !== null) return t.errorOutputIndex;
  const named = t.shape.outputNames?.indexOf(raw) ?? -1;
  if (named >= 0) return named;
  t.problems.push(
    `${t.where}: ${at} routes to output '${raw}', which this node type does not name` +
    (t.shape.outputNames === undefined
      ? ' (the node type declares no output names; use an index)'
      : ` (it names ${t.shape.outputNames.map((n) => `'${n}'`).join(', ')})`));
  return undefined;
}

/** An output name or index into a connected output index; `undefined` records a problem. */
export function routeTargetOf(t: RouteTargets, raw: string | number, at: string): number | undefined {
  // A node with no outputs at all cannot route anywhere, and the commonest one by far is an
  // `ai_tool` node — whose result is its agent's response, not a main edge — so the message
  // names that rather than leaving the author to work out why an index is out of range.
  if (t.outputCount === 0) {
    t.problems.push(
      `${t.where}: ${at} declares action 'route', but this node has no output to route to ` +
      "(a tool's result goes to its agent rather than down a main edge). Use 'retry', " +
      "'stop' or 'continue'");
    return undefined;
  }
  const index = outputIndexOf(t, raw, at);
  if (index === undefined) return undefined;
  if (index >= t.outputCount) {
    t.problems.push(
      `${t.where}: ${at} routes to output ${index}, but the node has ${t.outputCount}`);
    return undefined;
  }
  if (!t.connectedOutputs.has(index)) {
    t.problems.push(
      `${t.where}: ${at} routes to output ${index}, which has no connection; wire it or ` +
      "use 'stop' / 'continue'");
    return undefined;
  }
  return index;
}
