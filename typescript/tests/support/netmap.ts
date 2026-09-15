/**
 * Structural introspection of a `CompiledWorkflow`'s `NetMap`: a node's gadget, a place by
 * name, the slot of one connection, and the narrowing helpers a test uses to say which form,
 * slot or sub-record it expects before it reads a form-specific place. Each one throws with
 * the node and what it found instead of handing back `undefined`, so a test that compiled a
 * different gadget than it assumed fails at the line that assumed it.
 */
import type { Place } from 'libpetri';
import type {
  AgentGadget, CompiledWorkflow, EdgeSlot, InputGadget, NodeGadget, OrInput, RetryGadget, SplitOutput,
  TransitionInfoOf, TransitionRole,
} from '../../src/compiler/index.js';

export function gadget(c: CompiledWorkflow, node: string): NodeGadget {
  return c.netMap.node(node);
}

/** The place `name` of the flat net. */
export function placeNamed(c: CompiledWorkflow, name: string): Place<unknown> {
  const p = c.netMap.place(name);
  if (p === undefined) throw new Error(`no place '${name}'`);
  return p.place;
}

/** The transition `name`, which the test knows carries `role`. */
export function transitionInfoOf<R extends TransitionRole>(c: CompiledWorkflow, name: string, role: R): TransitionInfoOf<R> {
  const info = c.netMap.transition(name);
  if (info === undefined) throw new Error(`no transition '${name}'`);
  if (info.role !== role) throw new Error(`transition '${name}' has role '${info.role}', not '${role}'`);
  return info as TransitionInfoOf<R>;
}

// ---- the slot of one connection ----

/**
 * The edge slot of `from.outputIndex -> to.inputIndex` as seen from the consumer's gadget. A
 * direct-form consumer has at most one producer edge, and its `X/in` is the `in-data` place
 * that carries it; every other form lists its slots per input.
 */
export function edgeSlot(c: CompiledWorkflow, from: string, outputIndex: number, to: string, inputIndex: number): EdgeSlot {
  const g = gadget(c, to);
  if (g.form === 'direct') {
    const p = c.netMap.placesOf(to).find((pi) => pi.role === 'in-data' && pi.edge?.from === from
      && pi.edge.outputIndex === outputIndex && pi.edge.inputIndex === inputIndex);
    if (p === undefined || p.edge === undefined) {
      throw new Error(`no in-data place for ${from}.${outputIndex} -> ${to}.${inputIndex}`);
    }
    return { edge: p.edge, data: p.place, empty: g.inEmpty };
  }
  for (const i of g.inputs) {
    for (const e of i.edges) {
      if (e.edge.from === from && e.edge.outputIndex === outputIndex && e.edge.inputIndex === inputIndex) return e;
    }
  }
  throw new Error(`no edge slot for ${from}.${outputIndex} -> ${to}.${inputIndex}`);
}

/** The consumer-owned data place of the connection `from.outputIndex -> to.inputIndex` ({@link edgeSlot}'s `data`). */
export function edgeData(c: CompiledWorkflow, from: string, outputIndex: number, to: string, inputIndex: number): Place<unknown> {
  return edgeSlot(c, from, outputIndex, to, inputIndex).data;
}

// ---- narrowing: a test that reads a form-specific place says which form it expects ----

export function asForm<F extends NodeGadget['form']>(g: NodeGadget, form: F): Extract<NodeGadget, { form: F }> {
  if (g.form !== form) throw new Error(`node '${g.node}' compiled in form '${g.form}', not '${form}'`);
  return g as Extract<NodeGadget, { form: F }>;
}

/** The direct form's `X/in`. */
export function inOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'direct').in;
}

/** The direct form's `X/in_empty`, which the test knows exists (a tree edge feeds it). */
export function inEmptyOf(g: NodeGadget): Place<unknown> {
  const p = asForm(g, 'direct').inEmpty;
  if (p === null) throw new Error(`node '${g.node}' has no in_empty place`);
  return p;
}

/** The OR form's one input. */
export function orInputOf(g: NodeGadget): OrInput {
  return asForm(g, 'or').inputs[0];
}

/** `g.inputs[k]`, which the test knows exists. */
export function inputOf(g: NodeGadget, k: number): InputGadget {
  const i = g.inputs[k];
  if (i === undefined) throw new Error(`node '${g.node}' has no input #${k}`);
  return i;
}

export function asSlot<S extends InputGadget['slot']>(i: InputGadget, slot: S): Extract<InputGadget, { slot: S }> {
  if (i.slot !== slot) throw new Error(`input ${i.index} has slot '${i.slot}', not '${slot}'`);
  return i as Extract<InputGadget, { slot: S }>;
}

/** The single `ready` place of an OR or generic join input. */
export function readyOf(i: InputGadget): Place<unknown> {
  if (i.slot === 'ready-split') throw new Error(`input ${i.index} is enumerated: ready_data / ready_empty`);
  return i.ready;
}

/** `X/free_i` of a join input; the OR form has no slot to free. */
export function freeOf(i: InputGadget): Place<unknown> {
  if (i.slot === 'or') throw new Error(`input ${i.index} is an OR input: no free_${i.index}`);
  return i.free;
}

/** `X/ready_i_data` of an enumerated (required choose-branch) input. */
export function readyDataOf(i: InputGadget): Place<unknown> {
  return asSlot(i, 'ready-split').readyData;
}

/** `X/ready_i_empty` of an enumerated input, which the test knows exists. */
export function readyEmptyOf(i: InputGadget): Place<unknown> {
  const p = asSlot(i, 'ready-split').readyEmpty;
  if (p === null) throw new Error(`input ${i.index} has no ready_${i.index}_empty place`);
  return p;
}

/** `X/hasdata` of the join form. */
export function hasdataOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'join').hasdata;
}

/** `T/in_tool` of the tool form. */
export function inToolOf(g: NodeGadget): Place<unknown> {
  return asForm(g, 'tool').inTool;
}

/** `X/routed` of a node that routes inside `X_run`. */
export function routedOf(g: NodeGadget): Place<unknown> {
  if (g.routing.kind !== 'collapsed') throw new Error(`node '${g.node}' routes per output`);
  return g.routing.routed;
}

/** The outputs of a node that routes per output, with their `ok_o` / `routed_o`. */
export function splitOutputsOf(g: NodeGadget): readonly SplitOutput[] {
  if (g.routing.kind !== 'split') throw new Error(`node '${g.node}' routes inside X_run`);
  return g.routing.outputs;
}

export function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new Error(`node '${g.node}' is not an agent`);
  return g.agent;
}

export function retryOf(g: NodeGadget): RetryGadget {
  if (g.retry === null) throw new Error(`node '${g.node}' has no retry gadget`);
  return g.retry;
}
