/**
 * The input side of a materialised gadget: the form-specific fields of a {@link NodeGadget} —
 * `in` / `inEmpty`, `hasdata`, `inTool` and `agents`, and the modelled inputs — over the
 * canonical places.
 */
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import type { InputGadgetCommon, NodeGadget, NodeGadgetCommon, OrInput, ReadyInput, SplitReadyInput } from '../types.js';
import type { Canon } from './canonical.js';
import type { LocalInputCommon, LocalInputSide, LocalOrInput, LocalReadyInput, LocalSplitReadyInput } from './local-shapes.js';

/** A {@link NodeGadget} member without its common fields (distributive over the union). */
export type FormFields = NodeGadget extends infer G ? (G extends NodeGadget ? Omit<G, keyof NodeGadgetCommon> : never) : never;

function inputCommonOf(c: Canon, i: LocalInputCommon): InputGadgetCommon {
  return {
    index: i.index, edges: i.edges.map(c.slot), wired: i.wired, required: i.required,
    emptyCapable: i.emptyCapable, seedEmpty: i.seedEmpty, unreachableEdges: i.unreachableEdges,
  };
}

function readyInput(c: Canon, i: LocalReadyInput): ReadyInput {
  return { ...inputCommonOf(c, i), slot: 'ready', free: c.fin(i.free), ready: c.fin(i.ready) };
}

function splitReadyInput(c: Canon, i: LocalSplitReadyInput): SplitReadyInput {
  return { ...inputCommonOf(c, i), slot: 'ready-split', free: c.fin(i.free), readyData: c.fin(i.readyData), readyEmpty: c.finOpt(i.readyEmpty) };
}

function orInput(c: Canon, i: LocalOrInput): OrInput {
  return { ...inputCommonOf(c, i), slot: 'or', ready: c.fin(i.ready), hasdata: c.fin(i.hasdata), ran: c.fin(i.ran), round: i.round };
}

/** The form-specific fields of node `name`'s gadget over canonical places. */
export function formFieldsOf(c: Canon, side: LocalInputSide, name: string, agents: readonly [string, ...string[]] | null): FormFields {
  switch (side.form) {
    case 'direct':
      return { form: 'direct', in: c.fin(side.in), inEmpty: c.finOpt(side.inEmpty), inputs: [] };
    case 'or':
      return { form: 'or', inputs: [orInput(c, side.input)] };
    case 'join':
      return { form: 'join', hasdata: c.fin(side.hasdata), inputs: side.inputs.map((i) => readyInput(c, i)) };
    case 'choose-branch':
      return { form: 'choose-branch', inputs: side.inputs.map((i) => (i.slot === 'ready' ? readyInput(c, i) : splitReadyInput(c, i))) };
    case 'tool': {
      if (agents === null) throw new InternalCompilerError(`internal: tool '${name}' has no agent`);
      return { form: 'tool', inTool: c.fin(side.inTool), agents, inputs: [] };
    }
    default: return assertNever(side, 'input side');
  }
}
