/**
 * The markings a compiled net starts from: the shared marking every execution carries (budget,
 * idle markers, retry and agent budgets, pre-filled join slots, seeded `skipped` markers) and
 * the initial marking, which adds the trigger data at the start node. An `engineV2` net has
 * neither budget nor markers to seed: {@link settlementInitialMarkingOf}.
 */
import { tokenOf } from 'libpetri';
import type { Place, Token } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { units } from '../../internal/tokens.js';
import { CompileError, InternalCompilerError } from '../errors.js';
import { readySlot } from '../gadget.js';
import type { NetMap } from '../net-map.js';
import type { AgentGadget, NodeGadget, OrGadget, SlottedGadget, WorkflowAnalysis } from '../types.js';
import { readyPlacesOf } from './derived-places.js';

export type Marking = Map<Place<unknown>, Token<unknown>[]>;

/** Seeds `tokens` on `p`, leaving an empty place out of the marking. */
function put(marking: Marking, p: Place<unknown>, tokens: Token<unknown>[]): void {
  if (tokens.length > 0) marking.set(p, tokens);
}

function seedAgent(marking: Marking, agent: AgentGadget): void {
  // The agent's round budget: one token per tool-call round its own `options.maxIterations`
  // permits. It bounds the `queue → dispatched → running → queue` cycle structurally, which
  // is what lets the reachability graph close on an agent workflow at all. It never enforces
  // — the node's own `checkMaxIterations` throws first — so seeding exactly `maxRounds`
  // keeps `A/rounds` from binding before n8n does.
  put(marking, agent.rounds, units(agent.maxRounds));
  // The tool-call budget: one unit per call the agent may dispatch in this execution,
  // consumed by `A_dispatch` and refunded by nothing. The seed is what the graph explores
  // up to, so it is the width of the claim a `proven` makes about this agent.
  put(marking, agent.calls, units(agent.maxToolCalls));
}

/**
 * An OR input has no slots: every unreachable tree producer is one empty delivery of the first
 * round (the start node's producers are all unreachable, so its round is complete).
 */
function seedOrRound(marking: Marking, g: OrGadget): void {
  const [i] = g.inputs;
  if (g.reachable && i.unreachableEdges > 0) put(marking, i.ready, units(i.unreachableEdges));
}

/**
 * Join inputs: a pre-filled slot (unreachable producers) withholds its free token so
 * free_i + ready_i <= 1 from the outset. A dead (unwired, required) input keeps its
 * free token and is never written.
 */
function seedJoinSlots(marking: Marking, g: SlottedGadget): void {
  for (const i of g.inputs) {
    if (i.seedEmpty) put(marking, readySlot(g, i, 'empty'), units(1));
    else put(marking, i.free, units(1));
  }
}

function seedNode(marking: Marking, g: NodeGadget): void {
  put(marking, g.idle, units(1));
  if (g.retry !== null) put(marking, g.retry.tries, units(g.retry.maxTries - 1));
  if (g.agent !== null) seedAgent(marking, g.agent);
  if (g.form === 'or') seedOrRound(marking, g);
  if (g.form === 'join' || g.form === 'choose-branch') seedJoinSlots(marking, g);
}

/**
 * A referenced node unreachable from every start node is definitionally skipped, so the
 * referencing node's start_unmet twin fires and its action fails as n8n would. The gadget
 * creates `Y/skipped` for every referenced node, so a seeded one always has it.
 */
function seedSkipped(marking: Marking, netMap: NetMap, seededSkipped: ReadonlySet<string>): void {
  for (const y of seededSkipped) {
    const skipped = netMap.node(y).skipped;
    if (skipped === null) throw new InternalCompilerError(`internal: referenced node '${y}' has no skipped place to seed`);
    put(marking, skipped, units(1));
  }
}

/** The marking every execution of the net starts from, before any trigger data. */
export function sharedMarkingOf(netMap: NetMap, analysis: WorkflowAnalysis, effectiveBudget: number): Marking {
  const marking: Marking = new Map();
  put(marking, netMap.shared.budget, units(effectiveBudget));
  for (const g of netMap.nodes) seedNode(marking, g);
  seedSkipped(marking, netMap, analysis.seededSkipped);
  return marking;
}

/** A slotted start node: its own activation pre-fills every slot, the first one with the trigger data. */
function seedStartSlots(marking: Marking, g: SlottedGadget, triggerItems: unknown): void {
  g.inputs.forEach((i, k) => {
    // The start node's own activation pre-fills every slot, withholding free_i and
    // replacing the empty a seeded (unreachable-producer) input would otherwise carry.
    marking.delete(i.free);
    for (const p of readyPlacesOf(i)) marking.delete(p);
    if (k === 0) {
      // n8n hands `nodeExecutionStack[0].data.main[0]` to the first input.
      marking.set(readySlot(g, i, 'data'), [tokenOf<unknown>(triggerItems)]);
      if (g.form === 'join') marking.set(g.hasdata, units(1));
    } else {
      // The other inputs of the start node are present but carry no items (n8n passes
      // only main[0]); they take the `data` slot so X_start fires, as n8n runs
      // nodeExecutionStack[0] unconditionally. The generic join's ready_i is the same
      // place for both variants; hasdata comes from the first input.
      marking.set(readySlot(g, i, 'data'), units(1));
    }
  });
}

/** `marking` (the shared marking) with the trigger data delivered to start node `g`. */
export function initialMarkingOf(marking: Marking, g: NodeGadget, triggerItems: unknown): Marking {
  // A tool node has no input side of its own — an agent's `A_dispatch` writes its `T/in_tool`
  // — so there is nowhere to put the trigger data. Seeding nothing would leave a net that
  // quiesces immediately and looks like a workflow that did nothing; say so instead. A resumed
  // execution reaches a tool through `decodeExecutionData`, never through here.
  if (g.form === 'tool') {
    throw new CompileError('tool-start-node',
      `compile: start node '${g.node}' is an ai_tool node; a tool is reached only by its ` +
      "agent's dispatch, so it cannot be where an execution starts", g.node);
  }
  switch (g.form) {
    case 'direct': marking.set(g.in, [tokenOf<unknown>(triggerItems)]); break;
    // The trigger payload is one data arrival.
    case 'or': marking.set(g.inputs[0].hasdata, [tokenOf<unknown>(triggerItems)]); break;
    case 'join':
    case 'choose-branch': seedStartSlots(marking, g, triggerItems); break;
    default: assertNever(g, 'gadget form');
  }
  return marking;
}

/**
 * The initial marking of an `engineV2` net (`tasks/v2-profile-plan.md` decision 7): one unit on
 * the trigger's synthetic `T/in`, which is `ExecutionStartHandler` creating the trigger's row.
 */
export function settlementInitialMarkingOf(netMap: NetMap, trigger: string): Marking {
  const g = netMap.settlement(trigger);
  if (g.in === null) throw new InternalCompilerError(`internal: the trigger '${trigger}' has no in place`);
  return new Map([[g.in, units(1)]]);
}
