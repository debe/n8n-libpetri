/**
 * The per-node gadget as a libpetri `SubnetDef` (MOD-001), instantiated at prefix `node.id`
 * (MOD-010) and composed by port binding (MOD-020). Implements README "Per-node gadget"
 * (ADR 0004: two-phase start/run, the outcome routed by `X_run` itself):
 *
 * ```
 * X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_pause)
 *               [read(Y/done) per $('Y')]                     → X/running        priority depth
 * X_start_unmet_k: the same without the reads, read(Y_k/skipped) → X/running (tagged) priority depth − 1
 * X_run:        one(X/running) → and( xor( and( per output o: xor( and(data edges_o),
 *                                                                 and(empty edges_o) | X/nil_o ),
 *                                               X/routed ),
 *                                          [X/retry], [and(_halt, _budget)],
 *                                          and(X/waiting, _pause, _budget), and(X/stopped, _pause, _budget) ),
 *                                     X/idle )                                    priority depth + 1
 * X_done:       one(X/routed) → and( _budget, X/done )                            priority depth + 1
 * X_skip:       one(X/in_empty) → and( empty tree edges, X/skipped )              priority depth
 * X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_pause)
 *               delayed(waitBetweenTries) → X/running                             priority depth
 * X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( <the same success branch>, [and(_halt, _budget)],
 *                                                      and(X/waiting, _pause, _budget), and(X/stopped, _pause, _budget) )
 *                                                                                 priority depth + 1
 * sink_o:       one(X/nil_o)  (no Out spec: a genuine sink, CORE-043 AC4)
 * ```
 *
 * A node with **more than {@link SPLIT_ROUTING_ABOVE} connected outputs** keeps the routing
 * on its own transition per output, because an `and` of `k` `xor`s is `2^k` flat branches
 * (IO-016) — see {@link SPLIT_ROUTING_ABOVE} for the measurement:
 *
 * ```
 * X_run success branch: and( X/ok_o per connected output o )
 * X_route_o:    one(X/ok_o) → and( xor( and(data edges_o), and(empty edges_o) | X/nil_o ),
 *                                  X/routed_o )                                   priority depth + 1
 * X_done:       one(X/routed_0) … one(X/routed_k-1) → and( _budget, X/done )      priority depth + 1
 * ```
 *
 * The `waiting` outcome is n8n's `waitTill` (the node put the execution to wait and must
 * re-run on resume; the token carries its input `executionData`) and `stopped` is the
 * destination-node stop (outputs recorded, successors never enqueued). Both deposit the
 * shared control terminal `_pause`, which every start / start-unmet / retry-wait inhibits
 * — routes, skips, arms, clears, done and exhausted do not — so a paused net drains its
 * structural transitions and quiesces with every token on an in / ready / hasdata /
 * waiting place, where the marking codec reads it (README "Retries, halt, cancellation").
 *
 * **`X_done` is what phases the budget refund**, at both shapes. `X_run` (or `X_route_o`)
 * deposits the edge tokens and marks `X/routed`; `X_done` refunds `_budget` one scheduling
 * cycle later, which is the cycle a join / OR consumer's `arm` fires in, so the consumer's
 * `X_start` and a budget-blocked sibling's `X_start` land in one ready set and priority
 * decides (M4, divergence #20 — see {@link SPLIT_ROUTING_ABOVE}). Every node has an
 * `X_done`, including one with no connected output, whose success branch is just `X/routed`.
 * The P-semiflow is `_budget + Σ_X(X/running + X/retry + inflight_X) = k`, where `inflight_X`
 * is `X/routed` for a node that routes inside `X_run` and `X/ok_o + X/routed_o` for **one**
 * output `o` of a node above {@link SPLIT_ROUTING_ABOVE}: a split node has no single
 * `X/routed`, so the Farkas enumeration returns one such law **per output** instead of one
 * folded law, and `verify.ts` `nodeCarriesUnit` accepts any of them ("at least one", not
 * "all"). A workflow with no split node yields the single folded
 * `_budget + Σ_X(X/running + X/retry + X/routed) = k`.
 *
 * Input sides (README "Join gadget", "OR-inputs"; ADR 0003):
 * - `join`: `arm_e_data` / `arm_e_empty` per edge consuming `X/free_i`, `X/ready_i`,
 *   `X/hasdata`, `X_start` with `all(X/hasdata)` and `X_skip` with `inhibitor(X/hasdata)`,
 *   both refunding `X/free_*`;
 * - `choose-branch`: required inputs (`requiredInputs`) get `X/ready_i_data` /
 *   `X/ready_i_empty` and their data/empty combinations are enumerated; the rest keep one
 *   `X/ready_i`; a required input with no producer is dead (never written);
 * - `or`: one input with `n ≥ 2` empty-capable producers aggregates a round —
 *   `arm_data → and(ready_i, hasdata_i)`, `arm_empty → ready_i`, `X_start: one(hasdata_i)
 *   → and(running, ran_i)`, `X_skip: exactly(n, ready_i) inhibitor(hasdata_i)
 *   inhibitor(ran_i)`, `X_clear: exactly(n, ready_i) inhibitor(hasdata_i) inhibitor(_halt) all(ran_i)`, both
 *   with `read(idle)` (the round decision waits for an in-flight `X_start` to land `ran_i`).
 *   Producers inside a cycle deliver `hasdata_i` only and do not count towards `n`; their
 *   runs leave `ran_i` markers behind once the round is closed.
 *
 * Emission rule per edge kind (README, ADR 0002): a tree edge from an acyclic producer
 * carries `data | empty`; a tree edge from a producer inside a cycle carries `data | nil`
 * on run and `empty` on skip; a cycle edge carries `data | nil` on run and nothing on skip.
 *
 * Every start, retry-wait, exhausted, skip, arm and clear transition inhibits on `_halt`
 * (README "Retries, halt, cancellation"), so a halted run quiesces without a post-halt
 * cascade — with every pending activation still on the `in` / edge / `ready` / `hasdata`
 * place it was delivered to, which is where the marking codec reads it. Nothing consumes
 * `_halt`: it is the halted run's terminal marker, not a signal to be acknowledged.
 *
 * Everything that crosses a node boundary is a port: `_budget` / `_halt` / `_pause`, the
 * consumer-owned edge places (data and, for tree edges, empty), and `Y/done` / `Y/skipped`
 * for every `$('Y')` reference (read arcs, CORE-032). Places that stay inside the node keep
 * their prefixed names (MOD-012). Actions are bound after composition on the flat net
 * (CORE-042), so the body carries libpetri's default `passthrough()` until then.
 */
import {
  SubnetDef, Transition, place, one, all, exactly, and, xor, outPlace, delayed, timeout, forwardInput,
} from 'libpetri';
import type { Out, Place, PortDirection } from 'libpetri';
import { assertNever } from '../internal/assert.js';
import { joinFormOf } from './graph.js';
import type {
  AgentGadget, AnalysedNode, AttemptGadget, EdgeRef, EdgeSlot, InputGadgetCommon, JoinForm, NodeGadget,
  NodeGadgetCommon, OrInput, OrSlot, OutputGadgetCommon, PlaceInfo, PlaceRole, ReadyInput, ReadySlot, RetryGadget,
  RoutingGadget, SharedPlaces, SplitReadyInput, SplitReadySlot, TransitionInfo, Variant, WorkflowAnalysis,
} from './types.js';

/**
 * Nodes with **more** connected outputs than this keep the routing on a transition of its
 * own per output — `X_run` writes `X/ok_o`, `X_route_o` deposits the edge tokens and marks
 * `X/routed_o` — instead of routing inside `X_run`'s own `Out` spec. Nodes at or below it
 * route in `X_run` and have a single `X/routed`.
 *
 * **Three**, and it is an IO-016 flattening threshold. The SMT and SCG flatteners expand an
 * `and` of `k` `xor`s into `2^k` virtual transitions, so the outcome costs `2^k + 4` flat
 * branches routed inside `X_run` (the four non-success outcomes on top) against `2k + 5`
 * split across `X_run` and its `X_route_o`s. Neither figure counts `X_done`, which both
 * shapes have. Measured with `enumerateBranches`
 * (`tests/spikes/collapsed-outcome.test.ts`):
 *
 * | connected outputs | routed in `X_run` | split per output |
 * |---|---|---|
 * | 1 | **6** | 7 |
 * | 2 | **8** | 9 |
 * | 3 | 12 | **11** |
 * | 4 | 20 | **13** |
 * | 6 | 68 | **17** |
 * | 10 | 1028 | **25** |
 * | 20 | *`enumerateBranches` overflows the stack* | **45** |
 *
 * Three is where it stops being a rout and becomes a trade: the split is one branch cheaper
 * there, while the collapse removes five places and three transitions and **21 % of the
 * state classes** (a three-output fan-out is 47 places / 20 transitions / 381 classes
 * collapsed against 52 / 23 / 482 split — `tests/compiler/routing.test.ts`). From four
 * outputs the branch count runs away and the split wins outright, so the threshold is 3 —
 * the same value the pre-M4 gadget used, for the same underlying reason.
 *
 * **What M4 changed is not this threshold; it is `X_done`,** and `X_done` is now
 * unconditional. The executor collects its ready set from the enablement flags **before**
 * the firing pass and only `updateDirtyTransitions()` sets them, so a transition another
 * firing enables during that pass can fire no earlier than the next cycle
 * (`precompiled-net-executor.ts` `fireReadyGeneral`). A join / OR consumer needs one such
 * extra cycle for its `arm`, while a direct consumer does not — so a firing that deposited
 * the edge tokens *and* refunded `_budget` let the shallower budget-blocked sibling become
 * evaluable a full cycle before the deeper armed consumer, and the net ran breadth-first
 * exactly where priority = DAG depth was meant to give n8n's depth-first order
 * (divergence #20). Refunding on `X_done` — one cycle after the edge tokens land, which is
 * the cycle the `arm` fires in — puts both candidate `X_start`s in the same ready set,
 * where priority decides. Measured: n8n's own `v1 execution order > should execute nodes in
 * the correct order, depth-first & the most top-left one first` passes with it and fails
 * without it (`docs/conformance-final.md`).
 *
 * That phase is preserved by both shapes here, because both mark `X/routed(_o)` in the
 * firing that deposits the edge tokens and refund `_budget` from `X_done` in the next.
 * Collapsing the routing into `X_run` therefore moves the *whole* chain one cycle earlier
 * without changing any relative phase.
 */
export const SPLIT_ROUTING_ABOVE = 3;

/** A consumer-owned host edge place pair (created by `compile`, bound into both subnets). */
export interface HostEdgeSlot {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  readonly empty: Place<unknown> | null;
}

/** A `PlaceInfo` before the canonical place object is known. */
export type PendingPlace = Omit<PlaceInfo, 'place'>;

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

export interface GadgetBuild {
  readonly def: SubnetDef<void>;
  readonly prefix: string;
  /** Original port name → host place, for `compose(instance, ports)`. Reference ports excluded. */
  readonly ports: ReadonlyMap<string, Place<unknown>>;
  readonly refPorts: readonly ReferencePort[];
  /** Ports bound to another node's `in_tool` / `response` place (agent tool dispatch). */
  readonly toolPorts: readonly ToolPort[];
  /**
   * Whether the subnet exposes a `skipped` output port (it has a skip transition). A
   * referenced node without one gets its `skipped` marker as a host-level place bound
   * straight into the referencing twins' read ports (a port must be touched by the body,
   * MOD-006), seeded by `initialMarking` when the node is unreachable.
   */
  readonly exposesSkipped: boolean;
  /** Transition descriptors in declaration order. */
  readonly transitions: readonly TransitionInfo[];
  /** Place descriptors of every place this node owns (edge places included). */
  readonly places: readonly PendingPlace[];
  /** Builds the `NodeGadget` once canonical place objects can be looked up by final name. */
  materialise(lookup: (finalName: string) => Place<unknown>): NodeGadget;
}

/**
 * The `ready` place a join input's arrival of `variant` lands on: `X/ready_i` for the
 * generic join and for a non-required choose-branch input (one place for both variants),
 * `X/ready_i_data` / `X/ready_i_empty` for a required choose-branch input. Throws a named
 * compile error instead of yielding a `null` marking key when the enumerated form has no
 * place for the variant (an input fed only by cycle edges has no `ready_i_empty`;
 * `initialMarking` never asks for it, since an input seeded empty has only unreachable —
 * hence tree-edge — producers).
 *
 * The one copy of the rule: the gadget applies it to its own local places before
 * composition, the compiler, the codec and the scheduler to the canonical ones afterwards.
 */
export function readySlot(
  g: { readonly node: string; readonly form: JoinForm },
  i: Pick<InputGadgetCommon, 'index' | 'emptyCapable'> & (ReadySlot | SplitReadySlot),
  variant: Variant,
): Place<unknown> {
  const p = i.slot === 'ready-split' ? (variant === 'data' ? i.readyData : i.readyEmpty) : i.ready;
  if (p === null) {
    throw new Error(
      `compile: node '${g.node}' input ${i.index} has no ready_${i.index}_${variant} place to seed ` +
      `(form '${g.form}', emptyCapable ${i.emptyCapable})`);
  }
  return p;
}

/** `and` with one child collapses to the child (IO-011 requires ≥ 1 child). */
function andOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new Error('internal: andOf() with no children');
  return rest.length === 0 ? first : and(first, ...rest);
}

/** `xor` with one child collapses to the child (IO-012 requires ≥ 2 children). */
function xorOf(children: readonly Out[]): Out {
  const [first, ...rest] = children;
  if (first === undefined) throw new Error('internal: xorOf() with no children');
  return rest.length === 0 ? first : xor(first, ...rest);
}

/** Every assignment over `choices[i]` per input, in lexicographic order with `data` first. */
function combinations(choices: readonly (readonly Variant[])[]): Variant[][] {
  let acc: Variant[][] = [[]];
  for (const options of choices) {
    const next: Variant[][] = [];
    for (const c of acc) for (const v of options) next.push([...c, v]);
    acc = next;
  }
  return acc;
}

/** A {@link TransitionInfo} member without the fields the gadget fills in itself (distributive over the union). */
type TransitionBody = TransitionInfo extends infer T ? (T extends TransitionInfo ? Omit<T, 'name' | 'node'> : never) : never;

interface PortDecl {
  readonly name: string;
  readonly local: Place<unknown>;
  readonly direction: PortDirection;
}

interface LocalEdge {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  readonly empty: Place<unknown> | null;
  readonly dataFinal: string;
  readonly emptyFinal: string | null;
}

/** The common input fields over local (subnet) edge places; the slot places are the local ones too. */
type LocalInputCommon = Omit<InputGadgetCommon, 'edges'> & { readonly edges: readonly LocalEdge[] };
type LocalOrInput = LocalInputCommon & OrSlot;
type LocalReadyInput = LocalInputCommon & ReadySlot;
type LocalSplitReadyInput = LocalInputCommon & SplitReadySlot;
type LocalJoinInput = LocalReadyInput | LocalSplitReadyInput;

/** The input side, by form, over local places (the shape {@link NodeGadget} takes after composition). */
type LocalInputSide =
  | { readonly form: 'direct'; readonly in: Place<unknown>; readonly inEmpty: Place<unknown> | null; readonly inFinal: string; readonly inEmptyFinal: string | null }
  | { readonly form: 'or'; readonly input: LocalOrInput }
  | { readonly form: 'join'; readonly hasdata: Place<unknown>; readonly inputs: readonly LocalReadyInput[] }
  | { readonly form: 'choose-branch'; readonly inputs: readonly LocalJoinInput[] }
  | { readonly form: 'tool'; readonly inTool: Place<unknown> };

interface LocalOutputCommon {
  readonly index: number;
  readonly edges: readonly LocalEdge[];
  readonly nil: Place<unknown> | null;
}
type LocalCollapsedOutput = LocalOutputCommon & { readonly routing: 'collapsed' };
type LocalSplitOutput = LocalOutputCommon & { readonly routing: 'split'; readonly ok: Place<unknown>; readonly routed: Place<unknown> };
type LocalOutput = LocalCollapsedOutput | LocalSplitOutput;
type LocalRouting =
  | { readonly kind: 'collapsed'; readonly routed: Place<unknown>; readonly outputs: readonly LocalCollapsedOutput[] }
  | { readonly kind: 'split'; readonly outputs: readonly LocalSplitOutput[] };

interface LocalAttemptCommon {
  readonly index: number;
  readonly running: Place<unknown>;
  readonly failed: Place<unknown>;
  readonly timedOut: Place<unknown> | null;
}
type LocalAttempt = LocalAttemptCommon & (
  | { readonly action: 'retry'; readonly waitMs: number; readonly next: Place<unknown> }
  | { readonly action: 'route'; readonly outputIndex: number }
  | { readonly action: 'stop' | 'continue' }
);

interface LocalRetry {
  readonly retry: Place<unknown>;
  readonly tries: Place<unknown>;
  readonly maxTries: number;
  readonly waitBetweenTries: number;
}

interface LocalAgent {
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

/** `analysis.startNodes` as a set, built once per analysis: every gadget of one compile asks it. */
const startNodeSets = new WeakMap<WorkflowAnalysis, ReadonlySet<string>>();
function startNodeSetOf(analysis: WorkflowAnalysis): ReadonlySet<string> {
  let set = startNodeSets.get(analysis);
  if (set === undefined) startNodeSets.set(analysis, set = new Set(analysis.startNodes));
  return set;
}

export function buildNodeGadget(
  a: AnalysedNode,
  analysis: WorkflowAnalysis,
  edgeSlots: ReadonlyMap<number, HostEdgeSlot>,
  syntheticIn: Place<unknown> | null,
  host: SharedPlaces,
): GadgetBuild {
  const name = a.node.name;
  const id = a.node.id;
  const F = (local: string): string => `${id}/${local}`;
  const depth = analysis.depth.get(name) ?? 0;
  const cyclic = analysis.cyclic.has(name);
  const reachable = analysis.reachable.has(name);
  const isStartNode = startNodeSetOf(analysis).has(name);
  const incoming = analysis.incoming.get(name) ?? [];
  const outgoing = analysis.outgoing.get(name) ?? [];
  const form = joinFormOf(a, incoming);
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

  const port = (portName: string, local: Place<unknown>, hostPlace: Place<unknown>, direction: PortDirection): void => {
    portDecls.push({ name: portName, local, direction });
    ports.set(portName, hostPlace);
  };
  const internal = (local: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): Place<unknown> => {
    pending.push({ name: F(local), role, node: name, port: portIndex, ...extra });
    return place<unknown>(local);
  };
  const hostOwned = (finalName: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): void => {
    pending.push({ name: finalName, role, node: name, port: portIndex, ...extra });
  };
  const tinfo = (local: string, info: TransitionBody): void => {
    transitions.push({ name: F(local), node: name, ...info });
  };

  // ---- shared places as ports ----
  const budget = place<unknown>('budget');
  port('budget', budget, host.budget, 'inout');
  const halt = place<unknown>('halt');
  port('halt', halt, host.halt, 'inout');
  const pause = place<unknown>('pause');
  port('pause', pause, host.pause, 'inout');

  // ---- markers ----
  const idle = internal('idle', 'idle', null);
  const running = internal('running', 'running', null);
  const done = internal('done', 'done', null);
  // Exposed (unbound) so referencing nodes can bind their read port to it.
  portDecls.push({ name: 'done', local: done, direction: 'output' });
  const waiting = internal('waiting', 'waiting', null);
  const stopped = internal('stopped', 'stopped', null);

  // ---- input side ----
  /** The producer edges of input `i` as local places, their host places declared and mapped. */
  const edgesOf = (i: number): { edges: LocalEdge[]; unreachableEdges: number; allUnreachable: boolean } => {
    const edges: LocalEdge[] = [];
    let unreachableEdges = 0;
    let allUnreachable = true;
    for (const e of incoming) {
      if (e.inputIndex !== i) continue;
      const producerReachable = analysis.reachable.has(e.from);
      if (producerReachable) allUnreachable = false;
      const slot = edgeSlots.get(e.id);
      if (slot === undefined) throw new Error(`internal: node '${name}' has no host slot for edge ${e.id}`);
      const data = place<unknown>(`in${i}_e${e.id}`);
      port(`in${i}_e${e.id}`, data, slot.data, 'input');
      hostOwned(slot.data.name, 'edge-data', i, { edge: e });
      let empty: Place<unknown> | null = null;
      if (slot.empty !== null) {
        empty = place<unknown>(`in${i}_e${e.id}_empty`);
        port(`in${i}_e${e.id}_empty`, empty, slot.empty, 'input');
        hostOwned(slot.empty.name, 'edge-empty', i, { edge: e });
        if (!producerReachable) unreachableEdges++;
      }
      edges.push({ edge: e, data, empty, dataFinal: slot.data.name, emptyFinal: slot.empty?.name ?? null });
    }
    return { edges, unreachableEdges, allUnreachable };
  };
  const inputCommon = (i: number): LocalInputCommon => {
    const { edges, unreachableEdges, allUnreachable } = edgesOf(i);
    const wired = edges.length > 0;
    return {
      index: i, edges, wired, required: required.has(i),
      emptyCapable: edges.some((e) => e.empty !== null),
      seedEmpty: reachable && wired && allUnreachable, unreachableEdges,
    };
  };
  /** Modelled input indexes, ascending: connected ones plus dead required ones. */
  const inputIndexes = (): number[] =>
    [...new Set([...incoming.map((e) => e.inputIndex), ...a.deadInputs])].sort((x, y) => x - y);

  let side: LocalInputSide;
  switch (form) {
    case 'tool': {
      // `T/in_tool`: the tool's only input, written by every agent that can dispatch it. The tool
      // owns the place and exposes it; each agent binds an output port to it, the way a referencing
      // node binds a read port to `Y/done`. No main producer, so no edge places and no join slots.
      const inTool = internal('in_tool', 'in-tool', null);
      portDecls.push({ name: 'in_tool', local: inTool, direction: 'input' });
      side = { form, inTool };
      break;
    }
    case 'direct': {
      const edge = incoming[0];
      const inLocal = place<unknown>('in');
      if (edge !== undefined) {
        const slot = edgeSlots.get(edge.id);
        if (slot === undefined) throw new Error(`internal: node '${name}' has no host slot for edge ${edge.id}`);
        port('in', inLocal, slot.data, 'input');
        hostOwned(slot.data.name, 'in-data', edge.inputIndex, { edge });
        let inEmpty: Place<unknown> | null = null;
        if (slot.empty !== null) {
          inEmpty = place<unknown>('in_empty');
          port('in_empty', inEmpty, slot.empty, 'input');
          hostOwned(slot.empty.name, 'in-empty', edge.inputIndex, { edge });
        }
        side = { form, in: inLocal, inEmpty, inFinal: slot.data.name, inEmptyFinal: slot.empty?.name ?? null };
      } else {
        if (syntheticIn === null) throw new Error(`internal: node '${name}' has no producer and no synthetic in place`);
        port('in', inLocal, syntheticIn, 'input');
        hostOwned(syntheticIn.name, 'in-data', 0);
        side = { form, in: inLocal, inEmpty: null, inFinal: syntheticIn.name, inEmptyFinal: null };
      }
      break;
    }
    case 'or': {
      // `joinFormOf` chooses the OR form for exactly one input index with several tree edges.
      const [i, ...more] = inputIndexes();
      if (i === undefined || more.length > 0) throw new Error(`internal: OR-form node '${name}' models ${more.length + (i === undefined ? 0 : 1)} inputs`);
      const common = inputCommon(i);
      const input: LocalOrInput = {
        ...common, slot: 'or',
        ready: internal(`ready_${i}`, 'ready', i),
        hasdata: internal(`hasdata_${i}`, 'hasdata', i),
        ran: internal(`ran_${i}`, 'ran', i),
        round: common.edges.filter((e) => e.empty !== null).length,
      };
      side = { form, input };
      break;
    }
    case 'join': {
      const inputs: LocalReadyInput[] = inputIndexes().map((i) => ({
        ...inputCommon(i), slot: 'ready', free: internal(`free_${i}`, 'free', i), ready: internal(`ready_${i}`, 'ready', i),
      }));
      side = { form, hasdata: internal('hasdata', 'hasdata', null), inputs };
      break;
    }
    case 'choose-branch': {
      const inputs: LocalJoinInput[] = inputIndexes().map((i): LocalJoinInput => {
        const common = inputCommon(i);
        const free = internal(`free_${i}`, 'free', i);
        if (common.required) {
          const readyData = internal(`ready_${i}_data`, 'ready', i, { variant: 'data' });
          const readyEmpty = common.emptyCapable ? internal(`ready_${i}_empty`, 'ready', i, { variant: 'empty' }) : null;
          return { ...common, slot: 'ready-split', free, readyData, readyEmpty };
        }
        return { ...common, slot: 'ready', free, ready: internal(`ready_${i}`, 'ready', i) };
      });
      side = { form, inputs };
      break;
    }
    default: return assertNever(form, 'join form');
  }
  /** The join-slot inputs (empty for the direct, OR and tool forms), for the refunds every start / skip writes. */
  const joinInputs: readonly LocalJoinInput[] = side.form === 'join' || side.form === 'choose-branch' ? side.inputs : [];
  /** Every modelled input, whichever slot shape: the arms and the gadget's `inputs`. */
  const allInputs: readonly (LocalOrInput | LocalJoinInput)[] = side.form === 'or' ? [side.input] : joinInputs;
  const slotOf = (i: LocalJoinInput, variant: Variant): Place<unknown> => readySlot({ node: name, form }, i, variant);

  // ---- skip exists iff an empty token can arrive where it decides the activation ----
  const hasSkip = side.form === 'tool' ? false
    : side.form === 'direct' ? side.inEmpty !== null
    : side.form === 'or' ? true
    : side.form === 'join' ? side.inputs.some((i) => i.emptyCapable)
    : side.inputs.some((i) => i.required && i.emptyCapable);
  // The skipped marker also exists when a referencing node's start_unmet twin reads it: as
  // a port when a skip writes it, otherwise as a host-level place owned by this node.
  const referenced = analysis.referenced.has(name);
  const skipped = hasSkip ? internal('skipped', 'skipped', null) : null;
  if (skipped !== null) portDecls.push({ name: 'skipped', local: skipped, direction: 'output' });
  else if (referenced) hostOwned(F('skipped'), 'skipped', null);

  // ---- output side ----
  // The empty place of an outgoing tree edge is written by X_route (acyclic producer) or by
  // X_skip (any producer); a cyclic producer without a skip never writes it and declares no
  // port for it (the consumer still owns the place; its skip is simply unreachable).
  const collapsedOutputs: LocalCollapsedOutput[] = [];
  const splitOutputs: LocalSplitOutput[] = [];
  const connectedOutputs = new Set(outgoing.map((e) => e.outputIndex)).size;
  const split = connectedOutputs > SPLIT_ROUTING_ABOVE;
  for (let o = 0; o < a.outputCount; o++) {
    const edges: LocalEdge[] = [];
    for (const e of outgoing) {
      if (e.outputIndex !== o) continue;
      const slot = edgeSlots.get(e.id);
      if (slot === undefined) throw new Error(`internal: node '${name}' has no host slot for edge ${e.id}`);
      const data = place<unknown>(`out_e${e.id}`);
      port(`out_e${e.id}`, data, slot.data, 'output');
      let empty: Place<unknown> | null = null;
      if (slot.empty !== null && (!cyclic || hasSkip)) {
        empty = place<unknown>(`out_e${e.id}_empty`);
        port(`out_e${e.id}_empty`, empty, slot.empty, 'output');
      }
      edges.push({ edge: e, data, empty, dataFinal: slot.data.name, emptyFinal: slot.empty?.name ?? null });
    }
    if (edges.length === 0) continue; // unconnected outputs get no places
    const nil = cyclic ? internal(`nil_${o}`, 'nil', o) : null;
    if (split) {
      splitOutputs.push({ index: o, edges, nil, routing: 'split', ok: internal(`ok_${o}`, 'ok', o), routed: internal(`routed_${o}`, 'routed', o) });
    } else {
      collapsedOutputs.push({ index: o, edges, nil, routing: 'collapsed' });
    }
  }
  // `X/routed`: the single "the outcome has been delivered" marker of a node that routes
  // inside `X_run`. A split node has one per output instead (`outputs[*].routed`).
  const routing: LocalRouting = split
    ? { kind: 'split', outputs: splitOutputs }
    : { kind: 'collapsed', routed: internal('routed', 'routed', null), outputs: collapsedOutputs };
  const outputs: readonly LocalOutput[] = routing.outputs;
  const skipEmpties: Out[] = [];
  for (const out of outputs) for (const e of out.edges) if (e.empty !== null) skipEmpties.push(outPlace(e.empty));

  // ---- references: read arcs on Y/done, twins on Y/skipped ----
  const refDone: Place<unknown>[] = [];
  /** Per reference: the referenced node and the local `Y/skipped` read port its twin uses. */
  const refSkipped: Array<{ readonly node: string; readonly skipped: Place<unknown> }> = [];
  const referenceNames: string[] = [];
  const unguardedReferences: string[] = [];
  for (const ref of a.references) {
    if (ref.kind === 'unguarded') {
      unguardedReferences.push(ref.node);
      continue;
    }
    const k = referenceNames.length;
    referenceNames.push(ref.node);
    const doneLocal = place<unknown>(`ref_${k}`);
    refDone.push(doneLocal);
    portDecls.push({ name: `ref_${k}`, local: doneLocal, direction: 'input' });
    refPorts.push({ port: `ref_${k}`, node: ref.node, marker: 'done' });
    const skippedLocal = place<unknown>(`refskip_${k}`);
    refSkipped.push({ node: ref.node, skipped: skippedLocal });
    portDecls.push({ name: `refskip_${k}`, local: skippedLocal, direction: 'input' });
    refPorts.push({ port: `refskip_${k}`, node: ref.node, marker: 'skipped' });
  }

  // ---- retry places ----
  const retry: LocalRetry | null = a.retry === null ? null : {
    retry: internal('retry', 'retry', null),
    tries: internal('tries', 'tries', null),
    maxTries: a.retry.maxTries,
    waitBetweenTries: a.retry.waitBetweenTries,
  };

  // ---- onFailure chain places (ADR 0009) ----
  // One `running` / `failed` pair per attempt, plus a `timedout` when a deadline is declared.
  // Attempt 1 reuses `X/running`, so `X_start` never learns the node has a policy and a
  // policy-free node compiles exactly as before.
  const chain = a.failure;
  const chainSteps = chain?.steps ?? [];
  const chainTimeoutMs = chain?.timeoutMs ?? null;
  const created = chainSteps.map((step, i) => ({
    step,
    running: i === 0 ? running : internal(`running_${step.attempt}`, 'running', null),
    failed: internal(`failed_${step.attempt}`, 'failed', null),
    timedOut: chainTimeoutMs === null ? null : internal(`timedout_${step.attempt}`, 'failed', null),
  }));
  // Linked from the end, so a `retry` step's "next attempt" is the place already created for
  // it: the chain is unrolled, and `resolveFailureChain` guarantees the last step is terminal.
  const attempts: LocalAttempt[] = [];
  let next: Place<unknown> | null = null;
  for (const c of [...created].reverse()) {
    const common: LocalAttemptCommon = { index: c.step.attempt, running: c.running, failed: c.failed, timedOut: c.timedOut };
    let attempt: LocalAttempt;
    switch (c.step.action) {
      case 'retry':
        if (next === null) throw new Error(`internal: node '${name}' onFailure retry step ${c.step.attempt} has no next attempt`);
        attempt = { ...common, action: 'retry', waitMs: c.step.waitMs, next };
        break;
      case 'route':
        attempt = { ...common, action: 'route', outputIndex: c.step.outputIndex };
        break;
      case 'stop':
      case 'continue':
        attempt = { ...common, action: c.step.action };
        break;
      default: return assertNever(c.step, 'failure step');
    }
    attempts.unshift(attempt);
    next = c.running;
  }

  // ---- agent round places (patterns.md §5, "fan-out and join with pending markers") ----
  // `routed_req` phases the budget refund exactly as `routed` does for every other outcome;
  // `queue` carries the undispatched actions and `drained` marks that there are none;
  // `outstanding` is the pattern's `JOB_PENDING`; `dispatched` its `ROUTING_DONE`; `rounds`
  // is the round budget, seeded from the agent's own `options.maxIterations`; `calls` is the
  // tool-call budget, the scheduler's own, consumed one unit per dispatch and never refunded.
  //
  // Why a budget and not a count. The number of tool calls in a round is decided at run time,
  // and an `Out` branch cannot carry a number — IO-015 validates the *set* of places a firing
  // writes. A count deposited as tokens is therefore invisible to the state-class graph, which
  // fires the branch as one token and explores one call in flight where the executor reaches
  // many: an under-approximation, the direction that yields a false `proven` on a safety
  // property. Consumed one unit per firing of `A_dispatch`, the count becomes a path length
  // instead, and the graph explores every round size up to the budget (`peak(A/outstanding)`
  // equals the budget, `tests/spikes/agent-round.test.ts`). Never refunding it is what keeps
  // that finite: a refund at the join lets a round dispatch without bound and `T/done`
  // accumulates — measured, the graph truncates. This is NU-040's decidability lever, the
  // budget place, without ν-names because one round is live per agent (`A/idle`).
  let agent: LocalAgent | null = null;
  if (tools !== null) {
    if (a.maxRounds === null || a.maxToolCalls === null) {
      throw new Error(`internal: agent '${name}' has tools but no round or tool-call budget`);
    }
    agent = {
      routedRequest: internal('routed_req', 'routed-request', null),
      queue: internal('queue', 'queue', null),
      calls: internal('calls', 'calls', null),
      drained: internal('drained', 'drained', null),
      outstanding: internal('outstanding', 'outstanding', null),
      dispatched: internal('dispatched', 'dispatched', null),
      rounds: internal('rounds', 'rounds', null),
      // Owned by the agent, written by every tool it dispatches — exposed like `done` and bound
      // by each tool's own output port.
      response: internal('response', 'response', null),
      tools, maxRounds: a.maxRounds, roundsAssumed: a.roundsAssumed,
      maxToolCalls: a.maxToolCalls, toolCallsAssumed: a.toolCallsAssumed,
    };
    portDecls.push({ name: 'response', local: agent.response, direction: 'output' });
  }

  // An agent's write port into each of its tools' `in_tool`, and a tool's write port into each
  // of its agents' `response`. Both are cross-node, so both are bound in `compile()`.
  const toolInPorts = (tools ?? []).map((toolName, k) => {
    const local = place<unknown>(`tool_${k}`);
    portDecls.push({ name: `tool_${k}`, local, direction: 'output' });
    toolPorts.push({ port: `tool_${k}`, node: toolName, marker: 'in_tool' });
    return local;
  });
  const agentResponsePorts = (agents ?? []).map((agentName, k) => {
    const local = place<unknown>(`resp_${k}`);
    portDecls.push({ name: `resp_${k}`, local, direction: 'output' });
    toolPorts.push({ port: `resp_${k}`, node: agentName, marker: 'response' });
    return local;
  });

  // ---- Out spec builders ----
  const routingOf = (out: LocalOutput): Out => xor(
    andOf(out.edges.map((e) => outPlace(e.data))),
    // An acyclic producer's edges are all tree edges, so each has its empty place: a cycle
    // edge would put both ends in one SCC and give the producer `nil` instead.
    out.nil !== null ? outPlace(out.nil) : andOf(out.edges.map((e) => outPlace(e.empty!))),
  );
  // The success branch. Collapsed: the per-output routing plus `X/routed`, which `X_done`
  // consumes one cycle later — an inner `xor` left unwritten on a sibling branch of the
  // enclosing `xor` is fine, IO-015 searches for an exact explanation
  // (`tests/spikes/out-spec.test.ts`, `tests/spikes/collapsed-outcome.test.ts`). Split: one
  // `X/ok_o` per output, each routed by its own `X_route_o`.
  // A tool's output is not a main edge: it is its agent's `A/response`. Several agents can
  // share one tool, so the branch is an `xor` over them and the action picks the agent the
  // dispatch token names. `X/routed` still marks the outcome for `X_done` to refund the budget
  // one cycle later, so the phase and the P-semiflow are the ordinary ones (ADR 0004).
  const success: Out = (() => {
    if (side.form === 'tool') {
      if (routing.kind === 'split') throw new Error(`internal: tool '${name}' routes per output`);
      return and(xorOf(agentResponsePorts.map((r) => outPlace(r))), outPlace(routing.routed));
    }
    return routing.kind === 'split'
      ? andOf(routing.outputs.map((o) => outPlace(o.ok)))
      : andOf([...routing.outputs.map(routingOf), outPlace(routing.routed)]);
  })();
  const haltBranch = and(outPlace(halt), outPlace(budget));
  // The two pause outcomes: the budget is refunded here since nothing routes afterwards.
  const waitingBranch = and(outPlace(waiting), outPlace(pause), outPlace(budget));
  const stoppedBranch = and(outPlace(stopped), outPlace(pause), outPlace(budget));
  const freeRefunds = (): Out[] => joinInputs.map((i) => outPlace(i.free));

  // ---- X_start and its start_unmet twins ----
  const startBuilder = (local: string, priority: number) => {
    const b = Transition.builder(local).priority(priority).inhibitors(halt, pause);
    switch (side.form) {
      case 'tool':
        b.inputs(one(side.inTool), one(budget), one(idle)).outputs(outPlace(running));
        break;
      case 'direct':
        b.inputs(one(side.in), one(budget), one(idle)).outputs(outPlace(running));
        break;
      case 'or':
        b.inputs(one(side.input.hasdata), one(budget), one(idle)).outputs(and(outPlace(running), outPlace(side.input.ran)));
        break;
      case 'join':
        for (const i of side.inputs) b.inputs(one(i.ready));
        b.inputs(all(side.hasdata));
        b.inputs(one(budget), one(idle)).outputs(and(outPlace(running), ...freeRefunds()));
        break;
      case 'choose-branch':
        for (const i of side.inputs) b.inputs(one(slotOf(i, 'data')));
        b.inputs(one(budget), one(idle)).outputs(and(outPlace(running), ...freeRefunds()));
        break;
      default: return assertNever(side, 'input side');
    }
    return b;
  };
  const start = startBuilder('start', depth);
  if (refDone.length > 0) start.reads(...refDone);
  body.push(start.build());
  tinfo('start', { role: 'start' });
  const startUnmetNames: string[] = [];
  refSkipped.forEach((ref, k) => {
    const local = `start_unmet_${k}`;
    body.push(startBuilder(local, depth - 1).read(ref.skipped).build());
    tinfo(local, { role: 'start-unmet', reference: ref.node });
    startUnmetNames.push(F(local));
  });

  // ---- X_run: the outcome ----
  // An agent has one more: the node returned an `EngineRequest` instead of data. It is phased
  // like the success outcome — `A/routed_req` here, the budget refunded by `A_done_req` one
  // cycle later — so `_budget + Σ(running + retry + routed) = k` still holds with `routed_req`
  // counted among the in-flight markers.
  const requestBranch = agent === null ? [] : [outPlace(agent.routedRequest)];
  /**
   * The outcome of one attempt. Without a policy this is the historical shape and `failure` is
   * `null`; with one, the retry alternative is that attempt's own `X/failed_i` — a chain
   * position rather than a counter decrement.
   */
  const outcomeOf = (failure: Place<unknown> | null): Out => xorOf([
    success,
    ...(failure !== null ? [outPlace(failure)] : retry !== null ? [outPlace(retry.retry)] : []),
    ...(stopWorkflow ? [haltBranch] : []),
    waitingBranch,
    stoppedBranch,
    ...requestBranch,
  ]);

  const attemptRunNames: string[] = [];
  if (attempts.length === 0) {
    body.push(Transition.builder('run')
      .inputs(one(running))
      .outputs(and(outcomeOf(null), outPlace(idle)))
      .priority(depth + 1).build());
    tinfo('run', { role: 'run', attempt: 1 });
  } else {
    for (const att of attempts) {
      // Attempt 1 keeps the name `run`, so every consumer that addresses a node's run
      // transition by name — the scheduler's binder, `NetMap`, the differ — is unchanged.
      const local = att.index === 1 ? 'run' : `run_${att.index}`;
      const normal = and(outcomeOf(att.failed), outPlace(idle));
      // IO-013's timeout child is an `Xor` sibling of the normal spec, and IO-015 needs
      // exactly one assignment to explain a write. It therefore has to claim a place the
      // normal branches do not, or every failing firing would be ambiguous — hence the
      // separate `timedout_i`, funnelled into `failed_i` below.
      body.push(Transition.builder(local)
        .inputs(one(att.running))
        .outputs(att.timedOut === null || chainTimeoutMs === null
          ? normal
          // `forwardInput`, not `outPlace`: IO-013 AC3 gives the timeout child *sentinel*
          // tokens, so a plain output would land a `null` on `timedout_i` and the step would
          // have no `executionData` to act on. IO-014 forwards the very token the firing
          // consumed from `X/running_i` — the run payload — which is what "this enables retry
          // patterns without losing tokens" means.
          : xor(normal, timeout(chainTimeoutMs,
              and(forwardInput(att.running, att.timedOut), outPlace(idle)))))
        .priority(depth + 1).build());
      tinfo(local, { role: 'run', attempt: att.index });
      attemptRunNames.push(F(local));
    }
  }

  // ---- X_route_o (split shape only) and X_done: the budget refund, one cycle later ----
  const routeNames: string[] = [];
  if (routing.kind === 'split') {
    for (const out of routing.outputs) {
      const local = `route_${out.index}`;
      body.push(Transition.builder(local)
        .inputs(one(out.ok))
        .outputs(and(routingOf(out), outPlace(out.routed)))
        .priority(depth + 1).build());
      tinfo(local, { role: 'route', port: out.index });
      routeNames.push(F(local));
    }
  }
  body.push(Transition.builder('done')
    .inputs(...(routing.kind === 'split' ? routing.outputs.map((o) => one(o.routed)) : [one(routing.routed)]))
    .outputs(and(outPlace(budget), outPlace(done)))
    .priority(depth + 1).build());
  tinfo('done', { role: 'done' });
  const doneName = F('done');

  // ---- the agent round: done_req, dispatch, collect, resume ----
  let doneRequestName: string | null = null;
  let dispatchName: string | null = null;
  let collectName: string | null = null;
  let resumeName: string | null = null;
  let roundsOutName: string | null = null;
  let callsOutName: string | null = null;
  if (agent !== null) {
    // `A_done_req`: the round opens with something to dispatch, or — an empty request — with
    // nothing, in which case it is already drained and `A_resume` fires next.
    body.push(Transition.builder('done_req')
      .inputs(one(agent.routedRequest))
      .outputs(xor(
        and(outPlace(budget), outPlace(agent.queue), outPlace(agent.dispatched)),
        and(outPlace(budget), outPlace(agent.drained), outPlace(agent.dispatched)),
      ))
      .priority(depth + 1).build());
    tinfo('done_req', { role: 'done-request' });
    doneRequestName = F('done_req');

    // `A_dispatch`: one action per firing, one budget unit per firing. `A/queue` holds a single
    // token, so dispatch is serialised and pops in the order the model requested — which is
    // what n8n's own "executes requested tools in the order the actions were requested"
    // asserts — while the tools themselves then run at whatever width `_budget` allows. The
    // action says whether more remain (the queue goes back) or that was the last (`drained`).
    //
    // That last choice is the one `patterns.md` warns about — "never decide 'is this the last
    // one' inside an action and expose it as an Xor" — and here it is safe, because of what
    // each spurious branch leads to in the graph. Taking `drained` early is a smaller round, a
    // subset. Taking the queue past the real end spends budget until `A/calls` is empty, and
    // `A_calls_out` then re-enters the agent: a designed exit, not the stranded batch the
    // warning is about. Both directions are explored, so the graph is an over-approximation of
    // the executor — the sound direction for a safety property.
    body.push(Transition.builder('dispatch')
      .inputs(one(agent.queue), one(agent.calls))
      .inhibitors(halt, pause)
      .outputs(and(
        xorOf(toolInPorts.map((t) => outPlace(t))),
        outPlace(agent.outstanding),
        xor(outPlace(agent.queue), outPlace(agent.drained)),
      ))
      .priority(depth + 1).build());
    tinfo('dispatch', { role: 'dispatch' });
    dispatchName = F('dispatch');

    // `A_collect`: pairs one arrived response with one outstanding dispatch and produces
    // nothing — a genuine sink (CORE-043 AC4), the same category as the OR form's `X_clear`.
    // An accumulator drained by `A_resume` would race: `collect` consumes `A/outstanding` when
    // it fires but would deposit on completion, and `A_resume` — no longer inhibited — can fire
    // inside that window and leak a marker into the next round. High priority, because the
    // pattern's order is store before resolve.
    body.push(Transition.builder('collect')
      .inputs(one(agent.outstanding), one(agent.response))
      .priority(depth + 2).build());
    tinfo('collect', { role: 'collect' });
    collectName = F('collect');

    // `A_resume`: the round is complete — nothing left to dispatch, nothing still out — so the
    // agent re-enters `X_run` with the resume entry `A/dispatched` carries. It takes a budget
    // unit and a round unit; when `A/rounds` is empty the loop stops, which is what makes the
    // whole cycle structurally bounded.
    body.push(Transition.builder('resume')
      .inputs(one(agent.dispatched), one(agent.drained), one(agent.rounds), one(idle))
      .inhibitors(agent.outstanding, halt, pause)
      .inputs(one(budget))
      .outputs(outPlace(running))
      .priority(depth).build());
    tinfo('resume', { role: 'resume' });
    resumeName = F('resume');

    // `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
    // re-enters `X_run` — taking its budget unit as any start does — carrying the fact, and
    // that run fails with `toolCallBudgetExceeded` under the node's own `onError` policy: the
    // same shape as `maxIterations` throwing inside n8n's node, and it is what gives the
    // graph's spurious "more remain" path an exit that is not a stranding. Below `A_resume` in
    // priority, though the two are structurally exclusive: one needs `drained`, this one needs
    // the queue.
    body.push(Transition.builder('calls_out')
      .inputs(one(agent.dispatched), one(agent.queue), one(idle), one(budget))
      .inhibitors(agent.calls, agent.outstanding, halt, pause)
      .outputs(outPlace(running))
      .priority(depth - 1).build());
    tinfo('calls_out', { role: 'calls-out' });
    callsOutName = F('calls_out');

    // `A_rounds_out`: the round budget is spent and a round is still open, so the agent can
    // never resume. Rather than let the net quiesce holding work nothing will ever take, this
    // makes it a **designed terminal**: `_pause` marks the stop, and the agent's re-entry goes
    // back through `A/stopped` (`ran: false`) the way any un-run activation does, so the codec
    // writes it — and the tool calls still on `A/queue` — onto `nodeExecutionStack`.
    //
    // Only a mock reaches it. A real agent counts its own `iterationCount` and throws "Max
    // iterations reached" first, which is why `A/rounds` is seeded with exactly that number.
    // The verifier cannot know that, so without this transition every agent workflow reports a
    // stranding — measured, `tests/verify/measure-graph.ts`.
    body.push(Transition.builder('rounds_out')
      .inputs(one(agent.dispatched), one(agent.drained))
      .inhibitors(agent.outstanding, agent.rounds, halt)
      .outputs(and(outPlace(stopped), outPlace(pause)))
      .priority(depth - 1).build());
    tinfo('rounds_out', { role: 'rounds-out' });
    roundsOutName = F('rounds_out');
  }

  // ---- X_skip ----
  const skipNames: string[] = [];
  if (skipped !== null) {
    // What every skip writes, whichever form decides it: the empty of each outgoing tree
    // edge, the marker, and the join slots refunded (none outside the join forms).
    const skipOut = andOf([...skipEmpties, outPlace(skipped), ...freeRefunds()]);
    switch (side.form) {
      case 'direct': {
        if (side.inEmpty === null) throw new Error(`internal: node '${name}' skips without an in-empty place`);
        body.push(Transition.builder('skip')
          .inputs(one(side.inEmpty))
          .inhibitor(halt)
          .outputs(skipOut)
          .priority(depth).build());
        tinfo('skip', { role: 'skip', combination: [] });
        skipNames.push(F('skip'));
        break;
      }
      case 'or': {
        // read(X/idle): X_start consumes hasdata_i when it fires but deposits ran_i only when
        // its action completes (outputs land on completion), so without the node's own mutex
        // an all-delivered round could skip while the run it just started is in flight.
        const i = side.input;
        body.push(Transition.builder('skip')
          .inputs(exactly(i.round, i.ready))
          .inhibitors(i.hasdata, i.ran, halt)
          .read(idle)
          .outputs(skipOut)
          .priority(depth).build());
        tinfo('skip', { role: 'skip', combination: [] });
        skipNames.push(F('skip'));
        break;
      }
      case 'join': {
        const skip = Transition.builder('skip').inhibitors(side.hasdata, halt).priority(depth);
        for (const i of side.inputs) skip.inputs(one(i.ready));
        skip.outputs(skipOut);
        body.push(skip.build());
        tinfo('skip', { role: 'skip', combination: [] });
        skipNames.push(F('skip'));
        break;
      }
      case 'choose-branch': {
        const listed = side.inputs.filter((i): i is LocalSplitReadyInput => i.slot === 'ready-split');
        /** Each enumerated input's position in `listed`, which is its column in every combination. */
        const columnOf = new Map(listed.map((i, k) => [i, k] as const));
        const choices = listed.map((i): Variant[] => (i.emptyCapable ? ['data', 'empty'] : ['data']));
        for (const combo of combinations(choices)) {
          if (combo.every((v) => v === 'data')) continue; // that combination is X_start
          const local = `skip_${combo.map((v) => v[0]).join('')}`;
          const skip = Transition.builder(local).inhibitor(halt).priority(depth);
          for (const i of side.inputs) {
            if (i.slot === 'ready') {
              skip.inputs(one(i.ready));
              continue;
            }
            const column = columnOf.get(i);
            const v = column === undefined ? undefined : combo[column];
            if (v === undefined) throw new Error(`internal: node '${name}' skip ${local} has no variant for input ${i.index}`);
            skip.inputs(one(slotOf(i, v)));
          }
          skip.outputs(skipOut);
          body.push(skip.build());
          tinfo(local, { role: 'skip', combination: combo });
          skipNames.push(F(local));
        }
        break;
      }
      case 'tool':
        throw new Error(`internal: tool '${name}' has a skip transition`);
      default: return assertNever(side, 'input side');
    }
  }

  // ---- X_clear (OR form): the round closes once every producer delivered and ≥ 1 run happened ----
  // read(X/idle) for the same reason as X_skip: a run started from this round must have
  // landed its ran_i before the round is cleared, or that marker would leak into the next.
  const clearNames: string[] = [];
  if (side.form === 'or') {
    const i = side.input;
    const local = `clear_${i.index}`;
    body.push(Transition.builder(local)
      .inputs(exactly(i.round, i.ready), all(i.ran))
      .inhibitors(i.hasdata, halt)
      .read(idle)
      .priority(depth).build());
    tinfo(local, { role: 'clear', port: i.index });
    clearNames.push(F(local));
  }

  // ---- arms (join, choose-branch and OR forms) ----
  const armNames: string[] = [];
  const joinHasdata = side.form === 'join' ? side.hasdata : null;
  for (const i of allInputs) {
    for (const e of i.edges) {
      const dataName = `arm_e${e.edge.id}_data`;
      const armData = Transition.builder(dataName).inputs(one(e.data)).inhibitor(halt).priority(depth);
      if (i.slot === 'or') {
        // A tree edge counts towards the round; a cycle edge only triggers a run.
        armData.outputs(e.empty !== null ? and(outPlace(i.ready), outPlace(i.hasdata)) : outPlace(i.hasdata));
      } else {
        armData.inputs(one(i.free));
        const ready = slotOf(i, 'data');
        armData.outputs(joinHasdata !== null ? and(outPlace(ready), outPlace(joinHasdata)) : outPlace(ready));
      }
      body.push(armData.build());
      tinfo(dataName, { role: 'arm', edge: e.edge, variant: 'data' });
      armNames.push(F(dataName));
      if (e.empty !== null) {
        const emptyName = `arm_e${e.edge.id}_empty`;
        const armEmpty = Transition.builder(emptyName).inputs(one(e.empty)).inhibitor(halt).priority(depth);
        if (i.slot === 'or') {
          armEmpty.outputs(outPlace(i.ready));
        } else {
          armEmpty.inputs(one(i.free));
          armEmpty.outputs(outPlace(slotOf(i, 'empty')));
        }
        body.push(armEmpty.build());
        tinfo(emptyName, { role: 'arm', edge: e.edge, variant: 'empty' });
        armNames.push(F(emptyName));
      }
    }
  }

  // ---- retry gadget: the budget stays held across the wait (README, ADR 0004) ----
  if (retry !== null) {
    body.push(Transition.builder('retry_wait')
      .inputs(one(retry.retry), one(retry.tries), one(idle))
      .inhibitors(halt, pause)
      .timing(delayed(retry.waitBetweenTries))
      .outputs(outPlace(running))
      .priority(depth).build());
    tinfo('retry_wait', { role: 'retry' });
    body.push(Transition.builder('exhausted')
      .inputs(one(retry.retry))
      .inhibitors(retry.tries, halt)
      .outputs(xorOf([success, ...(stopWorkflow ? [haltBranch] : []), waitingBranch, stoppedBranch]))
      .priority(depth + 1).build());
    tinfo('exhausted', { role: 'exhausted' });
  }

  // ---- the onFailure chain: one step per attempt, plus the deadline funnel (ADR 0009) ----
  //
  // This is `retry_wait` + `exhausted` generalised: a `retry` step is `retry_wait` with its own
  // delay, and a terminal step is `exhausted` with the outcome the workflow chose instead of
  // the one `onError` fixed. What it does not have is a counter — the position is the place,
  // so the allowance cannot leak across activations the way `X/tries` does.
  const attemptStepNames: string[] = [];
  const attemptTimeoutNames: string[] = [];
  for (const att of attempts) {
    if (att.timedOut !== null) {
      // A rename, structurally: it inhibits `_halt` like an arm and not `_pause`, so a paused
      // net still funnels and quiesces with one failure place marked rather than two.
      const local = `timeout_${att.index}`;
      body.push(Transition.builder(local)
        .inputs(one(att.timedOut))
        .inhibitors(halt)
        .outputs(outPlace(att.failed))
        .priority(depth + 1).build());
      tinfo(local, { role: 'deadline', attempt: att.index });
      attemptTimeoutNames.push(F(local));
    }
    const local = `attempt_${att.index}`;
    const b = Transition.builder(local).inputs(one(att.failed));
    if (att.action === 'retry') {
      // Holds `_budget` across the wait, as n8n's retry loop does and as `retry_wait` does.
      b.inputs(one(idle))
        .inhibitors(halt, pause)
        .timing(delayed(att.waitMs))
        .outputs(outPlace(att.next))
        .priority(depth);
    } else {
      // A terminal step *is* `X_exhausted` with the outcome the workflow chose rather than the
      // one `onError` fixed, so it offers the same union: the recording it performs can still
      // end in a wait (the node set `waitTill`), a destination stop, or a halt — either because
      // the step said `stop` or because `guarded` caught a fatal outside n8n's own try.
      // `route` and `continue` differ only in which output carries the data, which is a value
      // decision the action makes inside the one `success` branch.
      b.inhibitors(halt)
        .outputs(xorOf([success, haltBranch, waitingBranch, stoppedBranch]))
        .priority(depth + 1);
    }
    body.push(b.build());
    tinfo(local, { role: 'attempt', attempt: att.index });
    attemptStepNames.push(F(local));
  }

  // ---- nil sinks (CORE-043 AC4: genuine sinks carry no Out spec) ----
  const sinkNames: string[] = [];
  for (const out of outputs) {
    if (out.nil === null) continue;
    body.push(Transition.builder(`sink_${out.index}`).inputs(one(out.nil)).priority(depth).build());
    tinfo(`sink_${out.index}`, { role: 'sink' });
    sinkNames.push(F(`sink_${out.index}`));
  }

  // ---- SubnetDef ----
  const defBuilder = SubnetDef.builder(name).transitions(...body);
  for (const p of portDecls) {
    switch (p.direction) {
      case 'input': defBuilder.inputPort(p.name, p.local); break;
      case 'output': defBuilder.outputPort(p.name, p.local); break;
      case 'inout': defBuilder.inoutPort(p.name, p.local); break;
      default: assertNever(p.direction, 'port direction');
    }
  }
  const def = defBuilder.build();

  const materialise = (lookup: (finalName: string) => Place<unknown>): NodeGadget => {
    /** The canonical place of a local (`internal`) one: the same name under the instance prefix (MOD-010). */
    const fin = (p: Place<unknown>): Place<unknown> => lookup(F(p.name));
    const finOpt = (p: Place<unknown> | null): Place<unknown> | null => (p === null ? null : fin(p));
    const slot = (e: LocalEdge): EdgeSlot => ({
      edge: e.edge,
      data: lookup(e.dataFinal),
      empty: e.emptyFinal === null ? null : lookup(e.emptyFinal),
    });
    const inputCommonOf = (i: LocalInputCommon): InputGadgetCommon => ({
      index: i.index, edges: i.edges.map(slot), wired: i.wired, required: i.required,
      emptyCapable: i.emptyCapable, seedEmpty: i.seedEmpty, unreachableEdges: i.unreachableEdges,
    });
    const readyInput = (i: LocalReadyInput): ReadyInput => ({
      ...inputCommonOf(i), slot: 'ready', free: fin(i.free), ready: fin(i.ready),
    });
    const splitReadyInput = (i: LocalSplitReadyInput): SplitReadyInput => ({
      ...inputCommonOf(i), slot: 'ready-split', free: fin(i.free), readyData: fin(i.readyData), readyEmpty: finOpt(i.readyEmpty),
    });
    const orInput = (i: LocalOrInput): OrInput => ({
      ...inputCommonOf(i), slot: 'or', ready: fin(i.ready), hasdata: fin(i.hasdata), ran: fin(i.ran), round: i.round,
    });
    const outputCommonOf = (o: LocalOutputCommon): OutputGadgetCommon => ({
      index: o.index,
      name: o.index === a.errorOutputIndex ? 'error' : (a.shape.outputNames?.[o.index] ?? null),
      isErrorOutput: o.index === a.errorOutputIndex,
      edges: o.edges.map(slot),
      nil: finOpt(o.nil),
    });
    const routingGadget: RoutingGadget = routing.kind === 'split'
      ? { kind: 'split', outputs: routing.outputs.map((o) => ({ ...outputCommonOf(o), routing: 'split', ok: fin(o.ok), routed: fin(o.routed) })) }
      : { kind: 'collapsed', routed: fin(routing.routed), outputs: routing.outputs.map((o) => ({ ...outputCommonOf(o), routing: 'collapsed' })) };
    const attemptGadgets = attempts.map((att): AttemptGadget => {
      const common = { index: att.index, running: fin(att.running), failed: fin(att.failed), timedOut: finOpt(att.timedOut) };
      switch (att.action) {
        case 'retry': return { ...common, action: 'retry', waitMs: att.waitMs, next: fin(att.next) };
        case 'route': return { ...common, action: 'route', outputIndex: att.outputIndex };
        case 'stop':
        case 'continue': return { ...common, action: att.action };
        default: return assertNever(att, 'attempt');
      }
    });
    const retryGadget: RetryGadget | null = retry === null ? null : {
      retry: fin(retry.retry), tries: fin(retry.tries), maxTries: retry.maxTries, waitBetweenTries: retry.waitBetweenTries,
    };
    const agentGadget: AgentGadget | null = agent === null ? null : {
      routedRequest: fin(agent.routedRequest), queue: fin(agent.queue), calls: fin(agent.calls), drained: fin(agent.drained),
      outstanding: fin(agent.outstanding), response: fin(agent.response), dispatched: fin(agent.dispatched), rounds: fin(agent.rounds),
      tools: agent.tools, maxRounds: agent.maxRounds, roundsAssumed: agent.roundsAssumed,
      maxToolCalls: agent.maxToolCalls, toolCallsAssumed: agent.toolCallsAssumed,
    };
    const common: NodeGadgetCommon = {
      node: name, id, type: a.node.type, typeVersion: a.node.typeVersion,
      disabled: a.node.disabled === true, loopNode: a.shape.loopNode === true,
      depth, cyclic, reachable, isStart: name === analysis.startNode, isStartNode,
      onError: a.onError, retry: retryGadget,
      running: fin(running), idle: fin(idle),
      routing: routingGadget, done: fin(done),
      skipped: hasSkip || referenced ? lookup(F('skipped')) : null,
      attempts: attemptGadgets,
      attemptTimeoutMs: chainTimeoutMs,
      waiting: fin(waiting), stopped: fin(stopped),
      agent: agentGadget,
      outputs: routingGadget.outputs,
      references: referenceNames, unguardedReferences,
      transitions: {
        start: F('start'), startUnmet: startUnmetNames, run: F('run'), routes: routeNames, done: doneName,
        skip: skipNames, arms: armNames, clear: clearNames,
        retryWait: retry === null ? null : F('retry_wait'),
        exhausted: retry === null ? null : F('exhausted'),
        attemptRuns: attemptRunNames,
        attemptSteps: attemptStepNames,
        attemptTimeouts: attemptTimeoutNames,
        sinks: sinkNames,
        doneRequest: doneRequestName, dispatch: dispatchName, collect: collectName, resume: resumeName,
        roundsOut: roundsOutName, callsOut: callsOutName,
      },
    };
    switch (side.form) {
      case 'direct':
        return {
          ...common, form: 'direct',
          in: lookup(side.inFinal),
          inEmpty: side.inEmptyFinal === null ? null : lookup(side.inEmptyFinal),
          inputs: [],
        };
      case 'or':
        return { ...common, form: 'or', inputs: [orInput(side.input)] };
      case 'join':
        return { ...common, form: 'join', hasdata: fin(side.hasdata), inputs: side.inputs.map(readyInput) };
      case 'choose-branch':
        return {
          ...common, form: 'choose-branch',
          inputs: side.inputs.map((i) => (i.slot === 'ready' ? readyInput(i) : splitReadyInput(i))),
        };
      case 'tool': {
        if (agents === null) throw new Error(`internal: tool '${name}' has no agent`);
        return { ...common, form: 'tool', inTool: fin(side.inTool), agents, inputs: [] };
      }
      default: return assertNever(side, 'input side');
    }
  };

  return {
    def, prefix: id, ports, refPorts, toolPorts, exposesSkipped: hasSkip,
    transitions, places: pending, materialise,
  };
}
