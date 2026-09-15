/**
 * `ai_tool` wiring (README "Agent tool dispatch", ADR 0008): which agent may dispatch which tool,
 * with self-wiring, duplicates and tools that also have a main producer diagnosed and dropped,
 * and the main edges out of a tool removed from the graph.
 */
import { CompileError } from '../errors.js';
import type { ToolConnection, WorkflowDescription } from '../types.js';
import type { RawEdge } from './connections.js';
import type { RawNode } from './validate.js';

/** The tool dispatch relation, and the main edges left once a tool's own out-edges are dropped. */
export interface ToolWiring {
  /** Deduplicated, canonical order (agent canvas index, then tool). */
  readonly toolConnections: readonly ToolConnection[];
  /** Tools each agent may dispatch. */
  readonly toolsOf: ReadonlyMap<string, readonly string[]>;
  /** Agents that may dispatch each tool. */
  readonly agentsOf: ReadonlyMap<string, readonly string[]>;
  readonly mainEdges: readonly RawEdge[];
}

/** Resolves the `ai_tool` connections and drops the main edges a tool never writes. */
export function wireTools(
  workflow: WorkflowDescription,
  rawByName: ReadonlyMap<string, RawNode>,
  raw: readonly RawEdge[],
  diagnostics: string[],
): ToolWiring {
  // ---- ai_tool connections: which agent may dispatch which tool ----
  // Kept out of the main graph deliberately: the SCC decomposition below is what the emission
  // rule reads (ADR 0002), and a dispatch edge is not a data edge, so it must not turn an
  // agent and its tool into one SCC. Reachability and depth are propagated separately below.
  const hasProducer = new Set(raw.map((e) => e.to));
  const toolsOf = new Map<string, string[]>();
  const agentsOf = new Map<string, string[]>();
  const keyedTools: Array<ToolConnection & { readonly agentIndex: number; readonly toolIndex: number }> = [];
  const seenTool = new Set<string>();
  for (const c of workflow.toolConnections ?? []) {
    const agent = rawByName.get(c.agent);
    const tool = rawByName.get(c.tool);
    if (agent === undefined) {
      throw new CompileError('unknown-tool-connection-node', `compile: ai_tool connection to unknown node '${c.agent}'`, c.agent);
    }
    if (tool === undefined) {
      throw new CompileError('unknown-tool-connection-node', `compile: ai_tool connection from unknown node '${c.tool}'`, c.tool);
    }
    if (c.agent === c.tool) {
      diagnostics.push(`node '${c.agent}' is wired as its own ai_tool; ignored`);
      continue;
    }
    const key = `${c.tool} -> ${c.agent}`;
    if (seenTool.has(key)) {
      diagnostics.push(`duplicate ai_tool connection ${c.tool} -> ${c.agent}; ignored`);
      continue;
    }
    // A tool node has no main producer in n8n: its only input is the agent's dispatch. One that
    // has both is malformed, and half-compiling it would give the agent a branch whose input
    // place is also fed by a main edge. Drop the tool wiring, say so, and let a dispatch naming
    // the node fail by name at run time.
    if (hasProducer.has(c.tool)) {
      diagnostics.push(
        `node '${c.tool}' is wired as an ai_tool of '${c.agent}' but also has a main producer; ` +
        'the tool connection is ignored and a dispatch naming it will fail');
      continue;
    }
    seenTool.add(key);
    keyedTools.push({ agent: c.agent, tool: c.tool, agentIndex: agent.index, toolIndex: tool.index });
  }
  keyedTools.sort((x, y) => (x.agentIndex - y.agentIndex) || (x.toolIndex - y.toolIndex));
  const toolConnections: ToolConnection[] = keyedTools.map(({ agent, tool }) => ({ agent, tool }));
  for (const c of toolConnections) {
    let tools = toolsOf.get(c.agent);
    if (tools === undefined) toolsOf.set(c.agent, tools = []);
    tools.push(c.tool);
    let agents = agentsOf.get(c.tool);
    if (agents === undefined) agentsOf.set(c.tool, agents = []);
    agents.push(c.agent);
  }
  // A tool's result goes to its agent's `A/response` and nowhere else (ADR 0008), so a main
  // edge out of a tool never carries a token. Dropped here rather than modelled: kept, the
  // gadget would declare an output port no transition writes, and above `SPLIT_ROUTING_ABOVE`
  // a per-output routing the tool form cannot take. The consumer keeps its own `in` place and
  // is simply unreachable, which is what it was.
  const toolsWithConsumers = new Set<string>();
  for (const tool of agentsOf.keys()) {
    if (raw.some((e) => e.from === tool)) {
      toolsWithConsumers.add(tool);
      diagnostics.push(
        `ai_tool node '${tool}' has main consumers; a tool's output goes to its agent, ` +
        'so those connections never carry a token; ignored');
    }
  }
  const mainEdges = toolsWithConsumers.size === 0 ? raw : raw.filter((e) => !toolsWithConsumers.has(e.from));
  return { toolConnections, toolsOf, agentsOf, mainEdges };
}
