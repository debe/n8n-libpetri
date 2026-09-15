/**
 * Agent rounds (README "Agent tool dispatch", ADR 0008) in both directions.
 *
 * n8n keeps a paused round as ordinary `nodeExecutionStack` entries: the agent's own re-entry
 * (`metadata.nodeWasResumed` with the round's `subNodeExecutionData`) and, above it, the tool
 * calls not yet collected. **Encode** ({@link roundEntriesOf}) writes the round tokens back as
 * exactly those entries — the tokens carry the very `IExecuteData` values n8n's own
 * `handleRequest` produced, so nothing is reconstructed. **Decode** ({@link RoundAssembly})
 * recognises them, attributes every tool call to the agent whose round names it, and rebuilds
 * the round: `A/dispatched` with the {@link RoundPayload}, then `A/queue` or `A/drained`; a
 * tool that is itself an agent gets its answers address back ({@link RoundPayload.answers}).
 *
 * A tool call no open round claims is a foreign stack shape (the encoder never writes one, and
 * nothing would collect its response): reported by node and skipped.
 */
import { tokenOf, type Marking } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type { AgentGadget, NodeGadget, ToolGadget } from '../compiler/index.js';
import { unit } from '../internal/tokens.js';
import {
  isDispatchPayload, isRequestPayload, isRoundPayload,
  type RequestPayload, type RoundPayload, type ToolDispatch,
} from '../scheduler/payloads.js';
import { add, type Diagnostic, type MarkingMap } from './shared.js';

/** A gadget with an agent side. */
export type AgentNode = NodeGadget & { readonly agent: AgentGadget };

// ==================== decode ====================

/**
 * An agent's re-entry carrying the round it is waiting on. It must not go to `X/in`: that
 * would start a *new* activation from the agent's main input and lose the round.
 */
export function isRoundResume(g: NodeGadget, entry: IExecuteData): g is AgentNode {
  return g.agent !== null && entry.metadata?.nodeWasResumed === true && entry.metadata.subNodeExecutionData !== undefined;
}

/**
 * The agent rounds of one decode: the re-entries and tool calls set aside while the stack is
 * read, reassembled into round tokens once every entry has been seen.
 *
 * Attribution runs after the stack and not during it: the encoder writes a round's tools
 * *before* its agent (the stack is ordered by depth descending, and a tool sits one below its
 * agent), so while the stack is read the agent's re-entry is not known yet and a tool shared
 * by two agents would always fall back to the first one.
 */
export class RoundAssembly {
  private readonly resumes = new Map<string, { readonly g: AgentNode; readonly entry: IExecuteData }>();
  /** Tool activations in stack order. */
  private readonly toolCalls: Array<{ readonly tool: ToolGadget; readonly entry: IExecuteData }> = [];

  /** Sets an agent's re-entry aside ({@link isRoundResume}). */
  resume(g: AgentNode, entry: IExecuteData): void {
    this.resumes.set(g.node, { g, entry });
  }

  /** Sets a tool activation aside, for attribution once the stack has been read. */
  toolCall(tool: ToolGadget, entry: IExecuteData): void {
    this.toolCalls.push({ tool, entry });
  }

  /** The agent a tool answers to: its only agent, or the one whose open round names it. */
  private ownerOf(tool: ToolGadget): string | undefined {
    return tool.agents.length === 1
      ? tool.agents[0]
      : tool.agents.find((agent) => (this.resumes.get(agent)?.entry.metadata?.subNodeExecutionData?.actions ?? [])
        .some((a) => a.nodeName === tool.node));
  }

  /**
   * Every round, on its agent's places; the nodes it activates join `pendingNodes`.
   *
   * Every pending tool call goes on `A/queue`, whether the pause caught it undispatched or
   * dispatched-but-unstarted: both re-dispatch to the same run, and routing all of them through
   * the queue keeps them in request order, which putting them straight on `T/in_tool` would
   * not. A tool already collected is not on the stack at all, so it does not re-run;
   * `A/outstanding` is therefore zero and `A_resume` waits only on these.
   */
  materialise(marking: MarkingMap, diag: Diagnostic, pendingNodes: Set<string>): void {
    const pendingOf = new Map<string, IExecuteData[]>();
    for (const { tool, entry } of this.toolCalls) {
      const owner = this.ownerOf(tool);
      if (owner === undefined) {
        diag(
          `node '${tool.node}': a stack entry for an ai_tool activation no open round claims; dropped ` +
          `(agents: ${tool.agents.join(', ') || 'none'})`);
        continue;
      }
      const q = pendingOf.get(owner);
      if (q === undefined) pendingOf.set(owner, [entry]);
      else q.push(entry);
    }

    for (const [agent, { g, entry: resume }] of this.resumes) {
      // An agent that is itself a tool answers the agent that dispatched it. The round token
      // carries that address ({@link RoundPayload.answers}); it is rebuilt here by the same
      // attribution a pending tool call gets, from the metadata n8n keeps on the outer round.
      let answers: ToolDispatch | undefined;
      if (g.form === 'tool') {
        const owner = this.ownerOf(g);
        if (owner === undefined) {
          diag(
            `node '${agent}': a round re-entry for an ai_tool agent no open round claims; dropped ` +
            `(agents: ${g.agents.join(', ') || 'none'})`);
          continue;
        }
        answers = { agent: owner, roundId: `${owner}#${this.resumes.get(owner)?.entry.runIndex ?? 0}` };
      }
      const carried = answers === undefined ? {} : { answers };
      const pending = pendingOf.get(agent) ?? [];
      pendingOf.delete(agent);
      const roundId = `${agent}#${resume.runIndex ?? 0}`;
      const round: RoundPayload = { kind: 'round', resume, roundId, ...carried };
      add(marking, g.agent.dispatched, tokenOf<unknown>(round));
      // The queue when there is anything left to dispatch, `drained` when there is not — the
      // two are exclusive, and `A/calls` comes fresh from `sharedMarking`: the budget resets
      // across a resume, which the ADR records.
      if (pending.length > 0) {
        const request: RequestPayload = { kind: 'request', pending, resume, roundId, ...carried };
        add(marking, g.agent.queue, tokenOf<unknown>(request));
      } else {
        add(marking, g.agent.drained, unit());
      }
      pendingNodes.add(agent);
      for (const e of pending) pendingNodes.add(e.node.name);
    }
    // A tool activation whose agent is not waiting on a round: the encoder never writes one, so
    // this is hand-made state. n8n would still run it, but nothing would collect the response.
    for (const [agent, entries] of pendingOf) {
      diag(
        `agent '${agent}': ${entries.length} ai_tool activation(s) on the stack with no re-entry ` +
        `for '${agent}'; dropped (${entries.map((e) => e.node.name).join(', ')})`);
    }
  }
}

// ==================== encode ====================

/**
 * The stack entries of an agent round a pause or the halt caught mid-flight, in stack order:
 * a tool's dispatched-but-unstarted call (`T/in_tool`), the calls not yet dispatched
 * (`A/queue`), and the agent's own re-entry underneath them (`A/dispatched`). Writing them
 * back is writing exactly the `nodeExecutionStack` n8n would have been left holding.
 *
 * A dispatched tool that is *running* is written by its own activations, off `X/running`; one
 * that finished has its response on `A/response` and its `runData` written, so there is
 * nothing left to re-queue for it. A token of any other shape is reported and skipped.
 */
export function roundEntriesOf(g: NodeGadget, marking: Marking, diag: Diagnostic): IExecuteData[] {
  const out: IExecuteData[] = [];
  if (g.form === 'tool') {
    for (const t of marking.peekTokens(g.inTool)) {
      const v = t.value;
      if (isDispatchPayload(v)) out.push(v.executionData);
      else diag(`node '${g.node}': token on '${g.inTool.name}' carries no dispatch; dropped`);
    }
  }
  if (g.agent !== null) {
    const { queue, dispatched } = g.agent;
    for (const t of marking.peekTokens(queue)) {
      const v = t.value;
      if (isRequestPayload(v)) out.push(...v.pending);
      else diag(`node '${g.node}': token on '${queue.name}' carries no request; dropped`);
    }
    for (const t of marking.peekTokens(dispatched)) {
      const v = t.value;
      if (isRoundPayload(v)) out.push(v.resume);
      else diag(`node '${g.node}': token on '${dispatched.name}' carries no round; dropped`);
    }
  }
  return out;
}
