/** A workflow export's `connections` map → the compiler's main and tool connections. */
import type { MainConnection, ToolConnection } from '../../compiler/index.js';
import { subNodeSourcesIn } from '../../n8n/adapter/graph.js';
import { asRecord } from './checked.js';

/** What {@link connectionsOf} reads off an export. */
export interface JsonConnections {
  connections: MainConnection[];
  toolConnections: ToolConnection[];
  diagnostics: string[];
  /** Nodes that are the source of an `ai_*` connection other than `ai_tool` (see below). */
  subNodeSources: Set<string>;
}

/** One target of a connection group that names a node of the workflow. */
interface Target {
  readonly node: string;
  /** The target's raw `index` field. */
  readonly index: unknown;
  /** The index of the group it sits in: the source's output index for `main`. */
  readonly group: number;
}

/**
 * Every target of `type` in `groups` (`[ [ {node,type,index} ] ]`) that names a node of
 * `names`, in order. A malformed group or target is skipped; one of another type is left to
 * its reader; one that names a node the export lacks goes to `unknown` instead. A target with no
 * `node` field is read as naming `nodeless`, when given.
 */
function targetsOf(
  groups: unknown, type: string, names: ReadonlySet<string>, unknown: (group: number, node: unknown) => void,
  nodeless?: string,
): Target[] {
  const out: Target[] = [];
  if (!Array.isArray(groups)) return out;
  groups.forEach((targets, group) => {
    if (!Array.isArray(targets)) return;
    for (const t of targets) {
      if (typeof t !== 'object' || t === null) continue;
      const target = t as Record<string, unknown>;
      if (target['type'] !== undefined && target['type'] !== type) continue;
      const node = target['node'] === undefined ? nodeless : target['node'];
      if (typeof node === 'string' && names.has(node)) out.push({ node, index: target['index'], group });
      else unknown(group, node);
    }
  });
  return out;
}

/**
 * `connections` in n8n's export shape: `{ "<from>": { "main": [ [ {node,type,index} ] ] } }`.
 *
 * Also reads the `ai_tool` key, which n8n stores on the same map keyed *from the tool into the
 * agent*. It has to: the compiled net gives an agent a dispatch arm per `ai_tool` connection,
 * so a verifier that read only `main` would analyse a net without the agent's round — a
 * different net from the one the scheduler runs, reported with the same confidence. One net
 * serves execution and verification, and that includes this path.
 *
 * `engineV2` changes two readings. An `index` that is not a number is `NaN`, not 0, with its
 * written form as `indexKey` (below). And a `main` target with no `node` field names
 * `nameless` (see `nodesOf`): n8n's `toEdges` looks the target up by name, `undefined`, and
 * finds the last node that has none.
 *
 * A connection that names a node the export does not contain is dropped with a *diagnostic*,
 * not a shape warning: the live adapter drops it silently (n8n throws only when the producer
 * runs), and it is not a guess about a port count.
 */
export function connectionsOf(
  raw: unknown, names: ReadonlySet<string>, engineV2 = false, nameless?: string,
): JsonConnections {
  const connections: MainConnection[] = [];
  const toolConnections: ToolConnection[] = [];
  const diagnostics: string[] = [];
  if (raw === undefined || raw === null) {
    return { connections, toolConnections, diagnostics, subNodeSources: new Set() };
  }
  const byNode = asRecord(raw, 'connections');
  for (const [from, value] of Object.entries(byNode)) {
    if (!names.has(from)) {
      diagnostics.push(`connections list '${from}', which is not a node of this workflow; dropped`);
      continue;
    }
    const byType = asRecord(value ?? {}, `connections['${from}']`);
    const main = targetsOf(byType['main'], 'main', names, (outputIndex, to) => {
      diagnostics.push(`connection ${from}.${outputIndex} -> '${String(to)}' names an unknown node; dropped`);
    }, engineV2 ? nameless : undefined);
    // A target's `index` that is not a number is read as 0 under v1. Engine v2's converter copies
    // it as written, and its validator refuses any slot that is not a non-negative integer, so
    // under `engineV2` it is `NaN`, which that rule refuses alike — unless n8n's `dedupeEdges`
    // drops it first: it keys the index as written, so `'0'` beside a later `0` on the same edge
    // is one key, holding the `0`. `indexKey` carries that written form to the port's dedupe.
    for (const t of main) {
      const numeric = typeof t.index === 'number';
      connections.push({
        from, outputIndex: t.group, to: t.node, inputIndex: numeric ? t.index as number : engineV2 ? Number.NaN : 0,
        ...(engineV2 && !numeric ? { indexKey: String(t.index) } : {}),
      });
    }
    // `ai_tool`: the same map, but n8n keys it from the tool node into the agent, so `from` is
    // the tool here. Every other `ai_*` type is resolved by `supplyData` inside `runNode` and
    // never reaches a scheduler, so it is right to ignore them here; `subNodeSourcesIn` below
    // records their sources so the caller can drop a node that is *only* reachable that way.
    const tools = targetsOf(byType['ai_tool'], 'ai_tool', names, (_, agent) => {
      diagnostics.push(`ai_tool connection ${from} -> '${String(agent)}' names an unknown node; dropped`);
    });
    for (const t of tools) toolConnections.push({ agent: t.node, tool: from });
  }
  // The same reading the live adapter makes of `connectionsBySourceNode`: a language model, a
  // memory, an output parser is `supplyData`'s, and compiling it would report a dead node.
  return { connections, toolConnections, diagnostics, subNodeSources: subNodeSourcesIn(byNode) };
}
