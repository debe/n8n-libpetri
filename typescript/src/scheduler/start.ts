/**
 * `X_start` / `X_start_unmet`: the node's `IExecuteData` built from its input token(s) in
 * `addNodeToBeExecuted`'s shape, moved to `X/running` with `attempt = 0` and, for the twin,
 * the unmet reference.
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import type { IExecuteData, INodeExecutionData, ISourceData } from 'n8n-workflow';
import { entryForEdge } from '../codec.js';
import { readySlot } from '../compiler/index.js';
import type { NetMapView, NodeGadget, SlottedGadget, ToolGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import { envOf, liveNode, type ExecutionEnv } from './env.js';
import { UnexpectedTokenError } from './outcomes.js';
import { isDispatchPayload, isEdgePayload, isEntryPayload, type DispatchPayload, type RunPayload } from './payloads.js';

/**
 * The tool form's input side: one dispatch token, which carries the activation n8n's own
 * `addNodeToBeExecuted` built *and* the agent that asked for it. The agent travels on the token
 * because a tool can serve several agents and `T_run`'s success is an `xor` over their
 * `A/response` places.
 */
function startInputTool(ctx: TransitionContext, g: ToolGadget): DispatchPayload {
  const v = ctx.input(g.inTool);
  if (!isDispatchPayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), g.inTool.name);
  return v;
}

/** What one form's `X_start` consumes and builds, bound once per gadget: the per-firing part is the read. */
type StartInput = (ctx: TransitionContext, env: ExecutionEnv) => IExecuteData;

/**
 * Consumes the start inputs and builds the node's `IExecuteData`, refunding the join slots.
 * Everything that does not depend on the tokens — which input a direct edge lands on, the
 * width of a join's `main` — is computed here, at bind time, not per firing.
 */
function startInput(g: NodeGadget, map: NetMapView): StartInput {
  switch (g.form) {
    case 'tool': return (ctx) => startInputTool(ctx, g).executionData;
    case 'direct': {
      const inputIndex = map.place(g.in.name)?.edge?.inputIndex ?? 0;
      return (ctx, env) => {
        const v = ctx.input(g.in);
        if (isEntryPayload(v)) return v.executionData;
        if (!isEdgePayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), g.in.name);
        return entryForEdge(liveNode(env, g), inputIndex, v);
      };
    }
    case 'or': {
      const [i] = g.inputs;
      return (ctx, env) => {
        ctx.output(i.ran, null);
        const v = ctx.input(i.hasdata);
        if (isEntryPayload(v)) return v.executionData;
        if (!isEdgePayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), i.hasdata.name);
        return entryForEdge(liveNode(env, g), i.index, v);
      };
    }
    case 'join':
    case 'choose-branch': return startInputJoin(g);
    default: return assertNever(g, 'gadget form');
  }
}

function startInputJoin(g: SlottedGadget): StartInput {
  const slots = g.inputs.map((i) => readySlot(g, i, 'data'));
  // n8n's waitingExecution shape: items per arrived input, `[]` for an empty (R6's null → []
  // substitution done once), sources alongside.
  const inputCount = Math.max(...g.inputs.map((i) => i.index + 1));
  return (ctx, env) => {
    const values = slots.map((slot) => ctx.input(slot));
    for (const i of g.inputs) ctx.output(i.free, null);
    const first = values[0];
    if (isEntryPayload(first)) return first.executionData;
    const main: Array<INodeExecutionData[] | null> = Array.from({ length: inputCount }, () => null);
    const sources: Array<ISourceData | null> = Array.from({ length: inputCount }, () => null);
    g.inputs.forEach((i, k) => {
      const v = values[k];
      if (isEdgePayload(v)) {
        main[i.index] = v.items;
        sources[i.index] = v.source;
      } else {
        main[i.index] = [];
      }
    });
    return { node: liveNode(env, g), data: { main }, source: { main: sources } };
  };
}

export function startAction(g: NodeGadget, map: NetMapView, unmetReference?: string): TransitionAction {
  const read = startInput(g, map);
  const unmet = unmetReference === undefined ? {} : { unmetReference };
  if (g.form === 'tool') {
    // The tool form consumes a dispatch token that names the agent it answers to, so the run
    // can route its success back to the right `A/response`.
    return async (ctx) => {
      const dispatch = startInputTool(ctx, g);
      const payload: RunPayload = {
        kind: 'run', executionData: dispatch.executionData, attempt: 0, ...unmet,
        agent: dispatch.agent, roundId: dispatch.roundId,
      };
      ctx.output(g.running, payload);
    };
  }
  return async (ctx) => {
    const payload: RunPayload = { kind: 'run', executionData: read(ctx, envOf(ctx)), attempt: 0, ...unmet };
    ctx.output(g.running, payload);
  };
}
