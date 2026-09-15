/**
 * The state one `buildNodeGadget` call shares across its phases: the node's derived facts, the
 * builder state (port declarations, host-port bindings, place and transition descriptors, the
 * transition bodies) and the four recorders every phase declares through — `port` (MOD-020),
 * `internal` (MOD-010), `hostOwned` and `tinfo`. Also the local (pre-composition) shapes of the
 * gadget's parts and the two `Out` combinators IO-011 / IO-012 need collapsed.
 */
import { and, place, xor } from 'libpetri';
import type { Out, Place, PortDirection, Transition } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { qualified } from '../names.js';
import type {
  AnalysedNode, EdgeRef, EdgeSlot, InputGadgetCommon, JoinForm, OrSlot, PendingPlace, PlaceRole, ReadySlot,
  SharedPlaces, SplitReadySlot, TransitionInfo, WorkflowAnalysis,
} from '../types.js';

/** A reference port: bound by `compile` to the referenced instance's `done` or `skipped` port. */
export interface ReferencePort {
  readonly port: string;
  readonly node: string;
  readonly marker: 'done' | 'skipped';
}

/**
 * A port bound to a place another node owns, for agent tool dispatch. Same mechanism as
 * {@link ReferencePort} — the owner exposes the place as a port and `compile()` binds this one
 * to `instance.port(marker)` — but the two directions are writes, not read arcs:
 * `in_tool` is the agent writing the tool's dispatch place, `response` the tool writing the
 * agent's response place.
 */
export interface ToolPort {
  readonly port: string;
  readonly node: string;
  readonly marker: 'in_tool' | 'response';
}

/** `and` with one child collapses to the child (IO-011 requires ≥ 1 child). */
export function andOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new InternalCompilerError('internal: andOf() with no children');
  return rest.length === 0 ? first : and(first, ...rest);
}

/** `xor` with one child collapses to the child (IO-012 requires ≥ 2 children). */
export function xorOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new InternalCompilerError('internal: xorOf() with no children');
  return rest.length === 0 ? first : xor(first, ...rest);
}

/** A {@link TransitionInfo} member without the fields the gadget fills in itself (distributive over the union). */
export type TransitionBody = TransitionInfo extends infer T ? (T extends TransitionInfo ? Omit<T, 'name' | 'node'> : never) : never;

export interface PortDecl {
  readonly name: string;
  readonly local: Place<unknown>;
  readonly direction: PortDirection;
}

/**
 * One edge as the gadget sees it: its local port places (`empty` only where this side declares
 * the port) and the consumer-owned host slot `compile` created, which is what the materialised
 * gadget reports — for an output edge too, where a cyclic producer without a skip writes no
 * empty but the consumer still owns one.
 */
export interface LocalEdge {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  readonly empty: Place<unknown> | null;
  readonly host: EdgeSlot;
}

/** The common input fields over local (subnet) edge places; the slot places are the local ones too. */
export type LocalInputCommon = Omit<InputGadgetCommon, 'edges'> & { readonly edges: readonly LocalEdge[] };
export type LocalOrInput = LocalInputCommon & OrSlot;
export type LocalReadyInput = LocalInputCommon & ReadySlot;
export type LocalSplitReadyInput = LocalInputCommon & SplitReadySlot;
export type LocalJoinInput = LocalReadyInput | LocalSplitReadyInput;

/** The input side, by form, over local places (the shape {@link NodeGadget} takes after composition). */
export type LocalInputSide =
  | { readonly form: 'direct'; readonly in: Place<unknown>; readonly inEmpty: Place<unknown> | null }
  | { readonly form: 'or'; readonly input: LocalOrInput }
  | { readonly form: 'join'; readonly hasdata: Place<unknown>; readonly inputs: readonly LocalReadyInput[] }
  | { readonly form: 'choose-branch'; readonly inputs: readonly LocalJoinInput[] }
  | { readonly form: 'tool'; readonly inTool: Place<unknown> };

export interface LocalOutputCommon {
  readonly index: number;
  readonly edges: readonly LocalEdge[];
  readonly nil: Place<unknown> | null;
}
export type LocalCollapsedOutput = LocalOutputCommon & { readonly routing: 'collapsed' };
export type LocalSplitOutput = LocalOutputCommon & { readonly routing: 'split'; readonly ok: Place<unknown>; readonly routed: Place<unknown> };
export type LocalOutput = LocalCollapsedOutput | LocalSplitOutput;
export type LocalRouting =
  | { readonly kind: 'collapsed'; readonly routed: Place<unknown>; readonly outputs: readonly LocalCollapsedOutput[] }
  | { readonly kind: 'split'; readonly outputs: readonly LocalSplitOutput[] };

export interface LocalAttemptCommon {
  readonly index: number;
  readonly running: Place<unknown>;
  readonly failed: Place<unknown>;
  readonly timedOut: Place<unknown> | null;
}
export type LocalAttempt = LocalAttemptCommon & (
  | { readonly action: 'retry'; readonly waitMs: number; readonly next: Place<unknown> }
  | { readonly action: 'route'; readonly outputIndex: number }
  | { readonly action: 'stop' | 'continue' }
);

export interface LocalRetry {
  readonly retry: Place<unknown>;
  readonly tries: Place<unknown>;
  readonly maxTries: number;
  readonly waitBetweenTries: number;
}

export interface LocalAgent {
  readonly routedRequest: Place<unknown>;
  readonly queue: Place<unknown>;
  readonly calls: Place<unknown>;
  readonly drained: Place<unknown>;
  readonly outstanding: Place<unknown>;
  readonly dispatched: Place<unknown>;
  readonly rounds: Place<unknown>;
  readonly response: Place<unknown>;
  readonly tools: readonly [string, ...string[]];
  readonly maxRounds: number;
  readonly roundsAssumed: boolean;
  readonly maxToolCalls: number;
  readonly toolCallsAssumed: boolean;
}

/** One node's gadget under construction: its derived facts, the builder state and the recorders. */
export interface GadgetContext {
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
  /** The halt branch is part of the outcome: `onError: 'stopWorkflow'`, or any `onFailure` chain. */
  readonly stopWorkflow: boolean;
  readonly required: ReadonlySet<number>;
  /** Tool nodes this agent dispatches; `null` unless the node is an agent. */
  readonly tools: readonly [string, ...string[]] | null;
  /** Agents that dispatch this tool; `null` unless the node is a tool. */
  readonly agents: readonly [string, ...string[]] | null;
  readonly portDecls: PortDecl[];
  readonly ports: Map<string, Place<unknown>>;
  readonly refPorts: ReferencePort[];
  readonly toolPorts: ToolPort[];
  readonly pending: PendingPlace[];
  readonly transitions: TransitionInfo[];
  readonly body: Transition[];
  /** The flat-net name of every local place whose final name is known before composition. */
  readonly finalNames: Map<Place<unknown>, string>;
  /** Declares a port bound to `hostPlace` (MOD-020). */
  readonly port: (portName: string, local: Place<unknown>, hostPlace: Place<unknown>, direction: PortDirection) => void;
  /** Creates a place under the instance prefix (MOD-010) and records its descriptor. */
  readonly internal: (local: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>) => Place<unknown>;
  /** Records the descriptor of a host-level place this node owns. */
  readonly hostOwned: (finalName: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>) => void;
  /** Records a transition descriptor and returns its flat-net name. */
  readonly tinfo: (local: string, info: TransitionBody) => string;
}

/** The node's derived facts and an empty builder, with the recorders closed over it. */
export function createGadgetContext(
  a: AnalysedNode,
  analysis: WorkflowAnalysis,
  edgeSlots: ReadonlyMap<number, EdgeSlot>,
  syntheticIn: Place<unknown> | null,
  host: SharedPlaces,
): GadgetContext {
  const name = a.node.name;
  const id = a.node.id;
  const depth = analysis.depth.get(name) ?? 0;
  const cyclic = analysis.cyclic.has(name);
  const reachable = analysis.reachable.has(name);
  const isStartNode = analysis.startNodeSet.has(name);
  const incoming = analysis.incoming.get(name) ?? [];
  const outgoing = analysis.outgoing.get(name) ?? [];
  const form = a.form;
  // A chain needs the halt branch whatever `onError` says: its own `stop` step deposits it, and
  // `guarded()` falls back to it for a fatal raised outside n8n's node try (ADR 0009 §3).
  const stopWorkflow = a.onError === 'stopWorkflow' || a.failure !== null;
  const required = new Set<number>(a.requiredInputs ?? []);

  // Agent tool dispatch (README "Agent tool dispatch"). `tools` is non-empty exactly on an
  // agent; `agents` exactly on a tool, whose form is `'tool'`.
  const [firstTool, ...moreTools] = a.tools;
  const tools: readonly [string, ...string[]] | null = firstTool === undefined ? null : [firstTool, ...moreTools];
  const [firstAgent, ...moreAgents] = analysis.agentsOf.get(name) ?? [];
  const agents: readonly [string, ...string[]] | null = firstAgent === undefined ? null : [firstAgent, ...moreAgents];

  const portDecls: PortDecl[] = [];
  const ports = new Map<string, Place<unknown>>();
  const refPorts: ReferencePort[] = [];
  const toolPorts: ToolPort[] = [];
  const pending: PendingPlace[] = [];
  const transitions: TransitionInfo[] = [];
  const body: Transition[] = [];

  /**
   * The flat-net name of every local place whose final name is known before composition:
   * an `internal()` place under the instance prefix (MOD-010), a port-bound one under its host
   * place's name (MOD-020). `materialise` looks canonical places up through it, so no name is
   * derived twice.
   */
  const finalNames = new Map<Place<unknown>, string>();
  const port = (portName: string, local: Place<unknown>, hostPlace: Place<unknown>, direction: PortDirection): void => {
    portDecls.push({ name: portName, local, direction });
    ports.set(portName, hostPlace);
    finalNames.set(local, hostPlace.name);
  };
  const internal = (local: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): Place<unknown> => {
    const p = place<unknown>(local);
    const finalName = qualified(id, local);
    finalNames.set(p, finalName);
    pending.push({ name: finalName, role, node: name, port: portIndex, ...extra });
    return p;
  };
  const hostOwned = (finalName: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): void => {
    pending.push({ name: finalName, role, node: name, port: portIndex, ...extra });
  };
  /** Records a transition descriptor and returns its flat-net name. */
  const tinfo = (local: string, info: TransitionBody): string => {
    const finalName = qualified(id, local);
    transitions.push({ name: finalName, node: name, ...info });
    return finalName;
  };

  return {
    a, analysis, edgeSlots, syntheticIn, host, name, id, depth, cyclic, reachable, isStartNode, incoming, outgoing, form,
    stopWorkflow, required, tools, agents, portDecls, ports, refPorts, toolPorts, pending, transitions, body, finalNames,
    port, internal, hostOwned, tinfo,
  };
}
