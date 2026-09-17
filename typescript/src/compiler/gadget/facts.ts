/**
 * The facts one node's gadget is built from: the node, its analysis and the host places, and
 * what the phases derive from them — depth, cycle and reachability membership, edges, join
 * form, whether the outcome has a halt branch, the required inputs and the agent ↔ tool links.
 */
import type { Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { AnalysedNode, EdgeRef, EdgeSlot, JoinForm, SharedPlaces, WorkflowAnalysis } from '../types.js';

/** One node's derived facts, read by every phase and never written. */
export interface GadgetFacts {
  readonly a: AnalysedNode;
  readonly analysis: WorkflowAnalysis;
  readonly edgeSlots: ReadonlyMap<number, EdgeSlot>;
  readonly syntheticIn: Place<unknown> | null;
  readonly host: SharedPlaces;
  readonly name: string;
  readonly id: string;
  readonly depth: number;
  readonly cyclic: boolean;
  readonly reachable: boolean;
  readonly isStartNode: boolean;
  readonly incoming: readonly EdgeRef[];
  readonly outgoing: readonly EdgeRef[];
  readonly form: JoinForm;
  /**
   * A successor must hear of this node's skip — it reads skips itself or feeds a node that does
   * (`analysis/skip-observers.ts`) — so the skip forwards its empties (ADR 0002).
   */
  readonly skipForwards: boolean;
  /** The halt branch is part of the outcome: `onError: 'stopWorkflow'`, or any `onFailure` chain. */
  readonly stopWorkflow: boolean;
  readonly required: ReadonlySet<number>;
  /** Tool nodes this agent dispatches; `null` unless the node is an agent. */
  readonly tools: readonly [string, ...string[]] | null;
  /** Agents that dispatch this tool; `null` unless the node is a tool. */
  readonly agents: readonly [string, ...string[]] | null;
}

/** The list as a non-empty tuple, or `null` when it is empty. */
function nonEmpty<T>(items: readonly T[]): readonly [T, ...T[]] | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

/** Derives the node's facts from its analysis. */
export function deriveGadgetFacts(
  a: AnalysedNode,
  analysis: WorkflowAnalysis,
  edgeSlots: ReadonlyMap<number, EdgeSlot>,
  syntheticIn: Place<unknown> | null,
  host: SharedPlaces,
): GadgetFacts {
  const name = a.node.name;
  const outgoing = analysis.outgoing.get(name) ?? [];
  return {
    a, analysis, edgeSlots, syntheticIn, host, name,
    id: a.node.id,
    depth: analysis.depth.get(name) ?? 0,
    cyclic: analysis.cyclic.has(name),
    reachable: analysis.reachable.has(name),
    isStartNode: analysis.startNodeSet.has(name),
    incoming: analysis.incoming.get(name) ?? [],
    outgoing,
    form: a.form,
    skipForwards: outgoing.some((e) => analysis.skipObservable.has(e.to)),
    // A chain needs the halt branch whatever `onError` says: its own `stop` step deposits it, and
    // `guarded()` falls back to it for a fatal raised outside n8n's node try (ADR 0009 §3).
    stopWorkflow: a.onError === 'stopWorkflow' || a.failure !== null,
    required: new Set<number>(a.requiredInputs ?? []),
    // Agent tool dispatch (README "Agent tool dispatch"). `tools` is non-empty exactly on an
    // agent; `agents` exactly on a tool, whose form is `'tool'`.
    tools: nonEmpty(a.tools),
    agents: nonEmpty(analysis.agentsOf.get(name) ?? []),
  };
}

/** The host slot `compile` created for edge `e` of this node. */
export function hostSlotOf(facts: Pick<GadgetFacts, 'edgeSlots' | 'name'>, e: EdgeRef): EdgeSlot {
  const slot = facts.edgeSlots.get(e.id);
  if (slot === undefined) throw new InternalCompilerError(`internal: node '${facts.name}' has no host slot for edge ${e.id}`);
  return slot;
}
