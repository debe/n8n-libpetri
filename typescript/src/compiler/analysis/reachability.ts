/**
 * Reachability over the main graph: from the union of the start nodes, with tools reachable
 * through the agents that dispatch them, and from any set of nodes for callers outside the
 * analysis.
 */
import type { ToolConnection, WorkflowAnalysis } from '../types.js';

/**
 * The one depth-first walk both reachability questions share: every node reachable from any of
 * `starts` over `next`, the starts included, never entering `avoid`.
 */
function walk(starts: Iterable<string>, next: (n: string) => Iterable<string>, avoid: string | null): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const start of starts) {
    if (start === avoid || seen.has(start)) continue;
    seen.add(start);
    stack.push(start);
  }
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const m of next(n)) {
      if (m === avoid || seen.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return seen;
}

/** Nodes reachable from any of `starts` over `succ`, never entering `avoid`. */
export function reachFrom(starts: readonly string[], succ: ReadonlyMap<string, readonly string[]>, avoid: string | null): Set<string> {
  return walk(starts, (n) => succ.get(n) ?? [], avoid);
}

/**
 * Nodes reachable from any of `starts` over the analysis's main edges (`outgoing`), the starts
 * themselves included — also a start the analysis does not know, which simply has no
 * successors. The `reachable` field answers this for the start nodes; this answers it for any
 * set, e.g. the activations a resumed execution still has pending (`codec.ts`). No `ai_tool`
 * dispatch is followed: those are not main edges.
 */
export function reachableFrom(analysis: WorkflowAnalysis, starts: Iterable<string>): Set<string> {
  return walk(starts, (n) => (analysis.outgoing.get(n) ?? []).map((e) => e.to), null);
}

/** Nodes reachable from the union of the start nodes, tools through their agents. */
export function reachableFromStarts(
  startNodes: readonly string[],
  succ: ReadonlyMap<string, readonly string[]>,
  toolConnections: readonly ToolConnection[],
): Set<string> {
  // ---- reachability from the union of the start nodes ----
  // A tool is reachable exactly when an agent that can dispatch it is: it has no main producer,
  // so nothing else could reach it. Iterated to a fixpoint because a tool may itself be an agent
  // (n8n's AgentTool — an agent used as another agent's tool).
  const reachable = reachFrom(startNodes, succ, null);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of toolConnections) {
      if (reachable.has(c.agent) && !reachable.has(c.tool)) {
        reachable.add(c.tool);
        changed = true;
      }
    }
  }
  return reachable;
}
