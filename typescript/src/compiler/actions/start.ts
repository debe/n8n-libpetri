/**
 * `X_start` and its `start-unmet` twin: consume the node's start inputs, refund the join slots,
 * and put the value on `X/running` — tagged with an {@link UnmetReferencePayload} by the twin,
 * as M2's action will.
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { readySlot } from '../gadget.js';
import type { NodeGadget, SlottedGadget, StartUnmetTransition, UnmetReferencePayload } from '../types.js';

/** Consumes the start inputs and returns the value to put on `X/running`, refunding the join slots. */
function startInput(ctx: TransitionContext, g: NodeGadget): unknown {
  switch (g.form) {
    case 'direct': return ctx.input(g.in);
    case 'tool': return ctx.input(g.inTool);
    case 'or': {
      const [i] = g.inputs;
      ctx.output(i.ran, null);
      return ctx.input(i.hasdata);
    }
    case 'join':
    case 'choose-branch': return startJoin(ctx, g);
    default: return assertNever(g, 'gadget form');
  }
}

function startJoin(ctx: TransitionContext, g: SlottedGadget): unknown[] {
  const values = g.inputs.map((i) => ctx.input(readySlot(g, i, 'data')));
  for (const i of g.inputs) ctx.output(i.free, null);
  return values;
}

export function startAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, startInput(ctx, g));
  };
}

export function startUnmetAction(g: NodeGadget, info: StartUnmetTransition): TransitionAction {
  const { reference: unmetReference } = info;
  return async (ctx) => {
    const payload: UnmetReferencePayload = { unmetReference, input: startInput(ctx, g) };
    ctx.output(g.running, payload);
  };
}
