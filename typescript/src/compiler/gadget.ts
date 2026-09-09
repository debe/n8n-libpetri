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
import { SubnetDef, Transition, place, one, all, exactly, and, xor, outPlace, delayed } from 'libpetri';
import type { Out, Place, PortDirection } from 'libpetri';
import type { AnalysedNode, WorkflowAnalysis } from './graph.js';
import { joinFormOf } from './graph.js';
import type {
  EdgeRef, EdgeSlot, InputGadget, NodeGadget, OutputGadget, PlaceInfo, PlaceRole, SharedPlaces,
  TransitionInfo, TransitionRole, Variant,
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

/** `and` with one child collapses to the child (IO-011 requires ≥ 1 child). */
function andOf(children: readonly Out[]): Out {
  if (children.length === 0) throw new Error('internal: andOf() with no children');
  return children.length === 1 ? children[0]! : and(...children);
}

/** `xor` with one child collapses to the child (IO-012 requires ≥ 2 children). */
function xorOf(children: readonly Out[]): Out {
  if (children.length === 0) throw new Error('internal: xorOf() with no children');
  return children.length === 1 ? children[0]! : xor(...children);
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

interface LocalInput {
  readonly index: number;
  readonly edges: readonly LocalEdge[];
  readonly wired: boolean;
  readonly required: boolean;
  readonly free: Place<unknown> | null;
  readonly ready: Place<unknown> | null;
  readonly readyData: Place<unknown> | null;
  readonly readyEmpty: Place<unknown> | null;
  readonly hasdata: Place<unknown> | null;
  readonly ran: Place<unknown> | null;
  readonly round: number | null;
  readonly emptyCapable: boolean;
  readonly seedEmpty: boolean;
  readonly unreachableEdges: number;
}

interface LocalOutput {
  readonly index: number;
  readonly edges: readonly LocalEdge[];
  readonly nil: Place<unknown> | null;
  readonly ok: Place<unknown> | null;
  readonly routed: Place<unknown> | null;
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
  const incoming = analysis.incoming.get(name) ?? [];
  const outgoing = analysis.outgoing.get(name) ?? [];
  const form = joinFormOf(a, incoming);
  const stopWorkflow = a.onError === 'stopWorkflow';
  const required = new Set<number>(a.requiredInputs ?? []);

  // Agent tool dispatch (README "Agent tool dispatch"). `tools` is non-empty exactly on an
  // agent; `agents` exactly on a tool, whose form is `'tool'`.
  const tools = a.tools;
  const isAgent = tools.length > 0;
  const agents = analysis.agentsOf.get(name) ?? [];

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
  const tinfo = (local: string, role: TransitionRole, extra?: Partial<TransitionInfo>): void => {
    transitions.push({ name: F(local), role, node: name, ...extra });
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
  let inLocal: Place<unknown> | null = null;
  let inEmptyLocal: Place<unknown> | null = null;
  let inFinal: string | null = null;
  let inEmptyFinal: string | null = null;
  const inputs: LocalInput[] = [];

  // `T/in_tool`: the tool's only input, written by every agent that can dispatch it. The tool
  // owns the place and exposes it; each agent binds an output port to it, the way a referencing
  // node binds a read port to `Y/done`.
  let inToolLocal: Place<unknown> | null = null;
  if (form === 'tool') {
    inToolLocal = internal('in_tool', 'in-tool', null);
    portDecls.push({ name: 'in_tool', local: inToolLocal, direction: 'input' });
  }

  if (form === 'tool') {
    // No main producer, so no edge places and no join slots: the input side is `in_tool`.
  } else if (form === 'direct') {
    const edge = incoming[0];
    inLocal = place<unknown>('in');
    if (edge !== undefined) {
      const slot = edgeSlots.get(edge.id)!;
      port('in', inLocal, slot.data, 'input');
      inFinal = slot.data.name;
      hostOwned(inFinal, 'in-data', edge.inputIndex, { edge });
      if (slot.empty !== null) {
        inEmptyLocal = place<unknown>('in_empty');
        port('in_empty', inEmptyLocal, slot.empty, 'input');
        inEmptyFinal = slot.empty.name;
        hostOwned(inEmptyFinal, 'in-empty', edge.inputIndex, { edge });
      }
    } else {
      if (syntheticIn === null) throw new Error(`internal: node '${name}' has no producer and no synthetic in place`);
      port('in', inLocal, syntheticIn, 'input');
      inFinal = syntheticIn.name;
      hostOwned(inFinal, 'in-data', 0);
    }
  } else {
    const indexes = [...new Set([...incoming.map((e) => e.inputIndex), ...a.deadInputs])].sort((x, y) => x - y);
    for (const i of indexes) {
      const edges: LocalEdge[] = [];
      let unreachableEdges = 0;
      let allUnreachable = true;
      for (const e of incoming) {
        if (e.inputIndex !== i) continue;
        const producerReachable = analysis.reachable.has(e.from);
        if (producerReachable) allUnreachable = false;
        const slot = edgeSlots.get(e.id)!;
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
      const wired = edges.length > 0;
      const emptyCapable = edges.some((e) => e.empty !== null);
      const isRequired = required.has(i);
      let free: Place<unknown> | null = null;
      let ready: Place<unknown> | null = null;
      let readyData: Place<unknown> | null = null;
      let readyEmpty: Place<unknown> | null = null;
      let hasdataI: Place<unknown> | null = null;
      let ran: Place<unknown> | null = null;
      let round: number | null = null;
      if (form === 'or') {
        ready = internal(`ready_${i}`, 'ready', i);
        hasdataI = internal(`hasdata_${i}`, 'hasdata', i);
        ran = internal(`ran_${i}`, 'ran', i);
        round = edges.filter((e) => e.empty !== null).length;
      } else {
        free = internal(`free_${i}`, 'free', i);
        if (form === 'choose-branch' && isRequired) {
          readyData = internal(`ready_${i}_data`, 'ready', i, { variant: 'data' });
          if (emptyCapable) {
            readyEmpty = internal(`ready_${i}_empty`, 'ready', i, { variant: 'empty' });
          }
        } else {
          ready = internal(`ready_${i}`, 'ready', i);
        }
      }
      inputs.push({
        index: i, edges, wired, required: isRequired, free, ready, readyData, readyEmpty,
        hasdata: hasdataI, ran, round, emptyCapable,
        seedEmpty: reachable && wired && allUnreachable, unreachableEdges,
      });
    }
  }
  const hasdata = form === 'join' ? internal('hasdata', 'hasdata', null) : null;

  // ---- skip exists iff an empty token can arrive where it decides the activation ----
  const hasSkip = form === 'tool' ? false
    : form === 'direct' ? inEmptyLocal !== null
    : form === 'or' ? true
    : form === 'join' ? inputs.some((i) => i.emptyCapable)
    : inputs.some((i) => i.required && i.emptyCapable);
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
  const outputs: LocalOutput[] = [];
  const connectedOutputs = new Set(outgoing.map((e) => e.outputIndex)).size;
  const split = connectedOutputs > SPLIT_ROUTING_ABOVE;
  for (let o = 0; o < a.outputCount; o++) {
    const edges: LocalEdge[] = [];
    for (const e of outgoing) {
      if (e.outputIndex !== o) continue;
      const slot = edgeSlots.get(e.id)!;
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
    const okO = split ? internal(`ok_${o}`, 'ok', o) : null;
    const routedO = split ? internal(`routed_${o}`, 'routed', o) : null;
    outputs.push({ index: o, edges, nil, ok: okO, routed: routedO });
  }
  // `X/routed`: the single "the outcome has been delivered" marker of a node that routes
  // inside `X_run`. A split node has one per output instead (`outputs[*].routed`).
  const routed = split ? null : internal('routed', 'routed', null);
  const skipEmpties: Out[] = [];
  for (const out of outputs) for (const e of out.edges) if (e.empty !== null) skipEmpties.push(outPlace(e.empty));

  // ---- references: read arcs on Y/done, twins on Y/skipped ----
  const refDone: Place<unknown>[] = [];
  const refSkipped: Place<unknown>[] = [];
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
    refSkipped.push(skippedLocal);
    portDecls.push({ name: `refskip_${k}`, local: skippedLocal, direction: 'input' });
    refPorts.push({ port: `refskip_${k}`, node: ref.node, marker: 'skipped' });
  }

  // ---- retry places ----
  const retry = a.retryOnFail ? internal('retry', 'retry', null) : null;
  const tries = a.retryOnFail ? internal('tries', 'tries', null) : null;

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
  const routedRequest = isAgent ? internal('routed_req', 'routed-request', null) : null;
  const queue = isAgent ? internal('queue', 'queue', null) : null;
  const calls = isAgent ? internal('calls', 'calls', null) : null;
  const drained = isAgent ? internal('drained', 'drained', null) : null;
  const outstanding = isAgent ? internal('outstanding', 'outstanding', null) : null;
  const dispatched = isAgent ? internal('dispatched', 'dispatched', null) : null;
  const rounds = isAgent ? internal('rounds', 'rounds', null) : null;
  // Owned by the agent, written by every tool it dispatches — exposed like `done` and bound
  // by each tool's own output port.
  const response = isAgent ? internal('response', 'response', null) : null;
  if (response !== null) portDecls.push({ name: 'response', local: response, direction: 'output' });

  // An agent's write port into each of its tools' `in_tool`, and a tool's write port into each
  // of its agents' `response`. Both are cross-node, so both are bound in `compile()`.
  const toolInPorts = tools.map((toolName, k) => {
    const local = place<unknown>(`tool_${k}`);
    portDecls.push({ name: `tool_${k}`, local, direction: 'output' });
    toolPorts.push({ port: `tool_${k}`, node: toolName, marker: 'in_tool' });
    return local;
  });
  const agentResponsePorts = agents.map((agentName, k) => {
    const local = place<unknown>(`resp_${k}`);
    portDecls.push({ name: `resp_${k}`, local, direction: 'output' });
    toolPorts.push({ port: `resp_${k}`, node: agentName, marker: 'response' });
    return local;
  });

  // ---- Out spec builders ----
  const routingOf = (out: LocalOutput): Out => xor(
    andOf(out.edges.map((e) => outPlace(e.data))),
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
  const success: Out = form === 'tool'
    ? and(xorOf(agentResponsePorts.map((r) => outPlace(r))), outPlace(routed!))
    : split
      ? andOf(outputs.map((o) => outPlace(o.ok!)))
      : andOf([...outputs.map(routingOf), outPlace(routed!)]);
  const haltBranch = and(outPlace(halt), outPlace(budget));
  // The two pause outcomes: the budget is refunded here since nothing routes afterwards.
  const waitingBranch = and(outPlace(waiting), outPlace(pause), outPlace(budget));
  const stoppedBranch = and(outPlace(stopped), outPlace(pause), outPlace(budget));
  const freeRefunds = (): Out[] => inputs.map((i) => outPlace(i.free!));
  const readyOf = (i: LocalInput): Place<unknown> => (i.required && form === 'choose-branch' ? i.readyData! : i.ready!);

  // ---- X_start and its start_unmet twins ----
  const startBuilder = (local: string, priority: number) => {
    const b = Transition.builder(local).priority(priority).inhibitors(halt, pause);
    if (form === 'tool') {
      b.inputs(one(inToolLocal!), one(budget), one(idle)).outputs(outPlace(running));
    } else if (form === 'direct') {
      b.inputs(one(inLocal!), one(budget), one(idle)).outputs(outPlace(running));
    } else if (form === 'or') {
      const i = inputs[0]!;
      b.inputs(one(i.hasdata!), one(budget), one(idle)).outputs(and(outPlace(running), outPlace(i.ran!)));
    } else {
      for (const i of inputs) b.inputs(one(readyOf(i)));
      if (hasdata !== null) b.inputs(all(hasdata));
      b.inputs(one(budget), one(idle)).outputs(and(outPlace(running), ...freeRefunds()));
    }
    return b;
  };
  const start = startBuilder('start', depth);
  if (refDone.length > 0) start.reads(...refDone);
  body.push(start.build());
  tinfo('start', 'start');
  const startUnmetNames: string[] = [];
  refSkipped.forEach((skippedLocal, k) => {
    const local = `start_unmet_${k}`;
    body.push(startBuilder(local, depth - 1).read(skippedLocal).build());
    tinfo(local, 'start-unmet', { reference: referenceNames[k]! });
    startUnmetNames.push(F(local));
  });

  // ---- X_run: the outcome ----
  // An agent has one more: the node returned an `EngineRequest` instead of data. It is phased
  // like the success outcome — `A/routed_req` here, the budget refunded by `A_done_req` one
  // cycle later — so `_budget + Σ(running + retry + routed) = k` still holds with `routed_req`
  // counted among the in-flight markers.
  const requestBranch = isAgent ? [outPlace(routedRequest!)] : [];
  const outcome = xorOf([
    success,
    ...(retry !== null ? [outPlace(retry)] : []),
    ...(stopWorkflow ? [haltBranch] : []),
    waitingBranch,
    stoppedBranch,
    ...requestBranch,
  ]);
  body.push(Transition.builder('run')
    .inputs(one(running))
    .outputs(and(outcome, outPlace(idle)))
    .priority(depth + 1).build());
  tinfo('run', 'run');

  // ---- X_route_o (split shape only) and X_done: the budget refund, one cycle later ----
  const routeNames: string[] = [];
  if (split) {
    for (const out of outputs) {
      const local = `route_${out.index}`;
      body.push(Transition.builder(local)
        .inputs(one(out.ok!))
        .outputs(and(routingOf(out), outPlace(out.routed!)))
        .priority(depth + 1).build());
      tinfo(local, 'route', { port: out.index });
      routeNames.push(F(local));
    }
  }
  body.push(Transition.builder('done')
    .inputs(...(split ? outputs.map((o) => one(o.routed!)) : [one(routed!)]))
    .outputs(and(outPlace(budget), outPlace(done)))
    .priority(depth + 1).build());
  tinfo('done', 'done');
  const doneName = F('done');

  // ---- the agent round: done_req, dispatch, collect, resume ----
  let doneRequestName: string | null = null;
  let dispatchName: string | null = null;
  let collectName: string | null = null;
  let resumeName: string | null = null;
  let roundsOutName: string | null = null;
  let callsOutName: string | null = null;
  if (isAgent) {
    // `A_done_req`: the round opens with something to dispatch, or — an empty request — with
    // nothing, in which case it is already drained and `A_resume` fires next.
    body.push(Transition.builder('done_req')
      .inputs(one(routedRequest!))
      .outputs(xor(
        and(outPlace(budget), outPlace(queue!), outPlace(dispatched!)),
        and(outPlace(budget), outPlace(drained!), outPlace(dispatched!)),
      ))
      .priority(depth + 1).build());
    tinfo('done_req', 'done-request');
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
      .inputs(one(queue!), one(calls!))
      .inhibitors(halt, pause)
      .outputs(and(
        xorOf(toolInPorts.map((t) => outPlace(t))),
        outPlace(outstanding!),
        xor(outPlace(queue!), outPlace(drained!)),
      ))
      .priority(depth + 1).build());
    tinfo('dispatch', 'dispatch');
    dispatchName = F('dispatch');

    // `A_collect`: pairs one arrived response with one outstanding dispatch and produces
    // nothing — a genuine sink (CORE-043 AC4), the same category as the OR form's `X_clear`.
    // An accumulator drained by `A_resume` would race: `collect` consumes `A/outstanding` when
    // it fires but would deposit on completion, and `A_resume` — no longer inhibited — can fire
    // inside that window and leak a marker into the next round. High priority, because the
    // pattern's order is store before resolve.
    body.push(Transition.builder('collect')
      .inputs(one(outstanding!), one(response!))
      .priority(depth + 2).build());
    tinfo('collect', 'collect');
    collectName = F('collect');

    // `A_resume`: the round is complete — nothing left to dispatch, nothing still out — so the
    // agent re-enters `X_run` with the resume entry `A/dispatched` carries. It takes a budget
    // unit and a round unit; when `A/rounds` is empty the loop stops, which is what makes the
    // whole cycle structurally bounded.
    body.push(Transition.builder('resume')
      .inputs(one(dispatched!), one(drained!), one(rounds!), one(idle))
      .inhibitors(outstanding!, halt, pause)
      .inputs(one(budget))
      .outputs(outPlace(running))
      .priority(depth).build());
    tinfo('resume', 'resume');
    resumeName = F('resume');

    // `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
    // re-enters `X_run` — taking its budget unit as any start does — carrying the fact, and
    // that run fails with `toolCallBudgetExceeded` under the node's own `onError` policy: the
    // same shape as `maxIterations` throwing inside n8n's node, and it is what gives the
    // graph's spurious "more remain" path an exit that is not a stranding. Below `A_resume` in
    // priority, though the two are structurally exclusive: one needs `drained`, this one needs
    // the queue.
    body.push(Transition.builder('calls_out')
      .inputs(one(dispatched!), one(queue!), one(idle), one(budget))
      .inhibitors(calls!, outstanding!, halt, pause)
      .outputs(outPlace(running))
      .priority(depth - 1).build());
    tinfo('calls_out', 'calls-out');
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
      .inputs(one(dispatched!), one(drained!))
      .inhibitors(outstanding!, rounds!, halt)
      .outputs(and(outPlace(stopped), outPlace(pause)))
      .priority(depth - 1).build());
    tinfo('rounds_out', 'rounds-out');
    roundsOutName = F('rounds_out');
  }

  // ---- X_skip ----
  const skipNames: string[] = [];
  if (hasSkip) {
    if (form === 'direct') {
      body.push(Transition.builder('skip')
        .inputs(one(inEmptyLocal!))
        .inhibitor(halt)
        .outputs(andOf([...skipEmpties, outPlace(skipped!)]))
        .priority(depth).build());
      tinfo('skip', 'skip');
      skipNames.push(F('skip'));
    } else if (form === 'or') {
      // read(X/idle): X_start consumes hasdata_i when it fires but deposits ran_i only when
      // its action completes (outputs land on completion), so without the node's own mutex
      // an all-delivered round could skip while the run it just started is in flight.
      const i = inputs[0]!;
      body.push(Transition.builder('skip')
        .inputs(exactly(i.round!, i.ready!))
        .inhibitors(i.hasdata!, i.ran!, halt)
        .read(idle)
        .outputs(andOf([...skipEmpties, outPlace(skipped!)]))
        .priority(depth).build());
      tinfo('skip', 'skip');
      skipNames.push(F('skip'));
    } else if (form === 'join') {
      const skip = Transition.builder('skip').inhibitors(hasdata!, halt).priority(depth);
      for (const i of inputs) skip.inputs(one(i.ready!));
      skip.outputs(and(...skipEmpties, outPlace(skipped!), ...freeRefunds()));
      body.push(skip.build());
      tinfo('skip', 'skip');
      skipNames.push(F('skip'));
    } else {
      const listed = inputs.filter((i) => i.required);
      const choices = listed.map((i): Variant[] => (i.emptyCapable ? ['data', 'empty'] : ['data']));
      for (const combo of combinations(choices)) {
        if (combo.every((v) => v === 'data')) continue; // that combination is X_start
        const local = `skip_${combo.map((v) => v[0]).join('')}`;
        const skip = Transition.builder(local).inhibitor(halt).priority(depth);
        for (const i of inputs) {
          if (!i.required) {
            skip.inputs(one(i.ready!));
            continue;
          }
          const v = combo[listed.indexOf(i)]!;
          skip.inputs(one(v === 'data' ? i.readyData! : i.readyEmpty!));
        }
        skip.outputs(and(...skipEmpties, outPlace(skipped!), ...freeRefunds()));
        body.push(skip.build());
        tinfo(local, 'skip', { combination: combo });
        skipNames.push(F(local));
      }
    }
  }

  // ---- X_clear (OR form): the round closes once every producer delivered and ≥ 1 run happened ----
  // read(X/idle) for the same reason as X_skip: a run started from this round must have
  // landed its ran_i before the round is cleared, or that marker would leak into the next.
  const clearNames: string[] = [];
  if (form === 'or') {
    const i = inputs[0]!;
    const local = `clear_${i.index}`;
    body.push(Transition.builder(local)
      .inputs(exactly(i.round!, i.ready!), all(i.ran!))
      .inhibitors(i.hasdata!, halt)
      .read(idle)
      .priority(depth).build());
    tinfo(local, 'clear', { port: i.index });
    clearNames.push(F(local));
  }

  // ---- arms (join, choose-branch and OR forms) ----
  const armNames: string[] = [];
  for (const i of inputs) {
    for (const e of i.edges) {
      const dataName = `arm_e${e.edge.id}_data`;
      const armData = Transition.builder(dataName).inputs(one(e.data)).inhibitor(halt).priority(depth);
      if (form === 'or') {
        // A tree edge counts towards the round; a cycle edge only triggers a run.
        armData.outputs(e.empty !== null ? and(outPlace(i.ready!), outPlace(i.hasdata!)) : outPlace(i.hasdata!));
      } else {
        armData.inputs(one(i.free!));
        if (form === 'join') armData.outputs(and(outPlace(i.ready!), outPlace(hasdata!)));
        else armData.outputs(outPlace(readyOf(i)));
      }
      body.push(armData.build());
      tinfo(dataName, 'arm', { edge: e.edge, variant: 'data' });
      armNames.push(F(dataName));
      if (e.empty !== null) {
        const emptyName = `arm_e${e.edge.id}_empty`;
        const armEmpty = Transition.builder(emptyName).inputs(one(e.empty)).inhibitor(halt).priority(depth);
        if (form === 'or') {
          armEmpty.outputs(outPlace(i.ready!));
        } else {
          armEmpty.inputs(one(i.free!));
          armEmpty.outputs(outPlace(i.required && form === 'choose-branch' ? i.readyEmpty! : i.ready!));
        }
        body.push(armEmpty.build());
        tinfo(emptyName, 'arm', { edge: e.edge, variant: 'empty' });
        armNames.push(F(emptyName));
      }
    }
  }

  // ---- retry gadget: the budget stays held across the wait (README, ADR 0004) ----
  if (retry !== null && tries !== null) {
    body.push(Transition.builder('retry_wait')
      .inputs(one(retry), one(tries), one(idle))
      .inhibitors(halt, pause)
      .timing(delayed(a.waitBetweenTries!))
      .outputs(outPlace(running))
      .priority(depth).build());
    tinfo('retry_wait', 'retry');
    body.push(Transition.builder('exhausted')
      .inputs(one(retry))
      .inhibitors(tries, halt)
      .outputs(xorOf([success, ...(stopWorkflow ? [haltBranch] : []), waitingBranch, stoppedBranch]))
      .priority(depth + 1).build());
    tinfo('exhausted', 'exhausted');
  }

  // ---- nil sinks (CORE-043 AC4: genuine sinks carry no Out spec) ----
  const sinkNames: string[] = [];
  for (const out of outputs) {
    if (out.nil === null) continue;
    body.push(Transition.builder(`sink_${out.index}`).inputs(one(out.nil)).priority(depth).build());
    tinfo(`sink_${out.index}`, 'sink');
    sinkNames.push(F(`sink_${out.index}`));
  }

  // ---- SubnetDef ----
  const defBuilder = SubnetDef.builder(name).transitions(...body);
  for (const p of portDecls) {
    switch (p.direction) {
      case 'input': defBuilder.inputPort(p.name, p.local); break;
      case 'output': defBuilder.outputPort(p.name, p.local); break;
      case 'inout': defBuilder.inoutPort(p.name, p.local); break;
    }
  }
  const def = defBuilder.build();

  const materialise = (lookup: (finalName: string) => Place<unknown>): NodeGadget => {
    const slot = (e: LocalEdge): EdgeSlot => ({
      edge: e.edge,
      data: lookup(e.dataFinal),
      empty: e.emptyFinal === null ? null : lookup(e.emptyFinal),
    });
    const opt = (p: Place<unknown> | null, local: string): Place<unknown> | null => (p === null ? null : lookup(F(local)));
    const inputGadgets: InputGadget[] = inputs.map((i) => ({
      index: i.index,
      edges: i.edges.map(slot),
      wired: i.wired,
      required: i.required,
      free: opt(i.free, `free_${i.index}`),
      ready: opt(i.ready, `ready_${i.index}`),
      readyData: opt(i.readyData, `ready_${i.index}_data`),
      readyEmpty: opt(i.readyEmpty, `ready_${i.index}_empty`),
      hasdata: opt(i.hasdata, `hasdata_${i.index}`),
      ran: opt(i.ran, `ran_${i.index}`),
      round: i.round,
      emptyCapable: i.emptyCapable,
      seedEmpty: i.seedEmpty,
      unreachableEdges: i.unreachableEdges,
    }));
    const outputGadgets: OutputGadget[] = outputs.map((o) => ({
      index: o.index,
      name: o.index === a.errorOutputIndex ? 'error' : (a.shape.outputNames?.[o.index] ?? null),
      isErrorOutput: o.index === a.errorOutputIndex,
      edges: o.edges.map(slot),
      nil: opt(o.nil, `nil_${o.index}`),
      ok: opt(o.ok, `ok_${o.index}`),
      routed: opt(o.routed, `routed_${o.index}`),
    }));
    return {
      node: name, id, type: a.node.type, typeVersion: a.node.typeVersion,
      disabled: a.node.disabled === true, loopNode: a.shape.loopNode === true,
      form, depth, cyclic, reachable, isStart: name === analysis.startNode, isStartNode: analysis.startNodes.includes(name),
      onError: a.onError, retryOnFail: a.retryOnFail, maxTries: a.maxTries, waitBetweenTries: a.waitBetweenTries,
      in: inFinal === null ? null : lookup(inFinal),
      inEmpty: inEmptyFinal === null ? null : lookup(inEmptyFinal),
      running: lookup(F('running')), idle: lookup(F('idle')),
      routed: opt(routed, 'routed'), splitRouting: split, done: lookup(F('done')),
      skipped: hasSkip || referenced ? lookup(F('skipped')) : null,
      hasdata: opt(hasdata, 'hasdata'),
      retry: opt(retry, 'retry'),
      tries: opt(tries, 'tries'),
      waiting: lookup(F('waiting')), stopped: lookup(F('stopped')),
      inTool: opt(inToolLocal, 'in_tool'),
      routedRequest: opt(routedRequest, 'routed_req'),
      queue: opt(queue, 'queue'),
      calls: opt(calls, 'calls'),
      drained: opt(drained, 'drained'),
      outstanding: opt(outstanding, 'outstanding'),
      response: opt(response, 'response'),
      dispatched: opt(dispatched, 'dispatched'),
      rounds: opt(rounds, 'rounds'),
      tools, agents, maxRounds: a.maxRounds, roundsAssumed: a.roundsAssumed,
      maxToolCalls: a.maxToolCalls, toolCallsAssumed: a.toolCallsAssumed,
      inputs: inputGadgets, outputs: outputGadgets,
      references: referenceNames, unguardedReferences,
      transitions: {
        start: F('start'), startUnmet: startUnmetNames, run: F('run'), routes: routeNames, done: doneName,
        skip: skipNames, arms: armNames, clear: clearNames,
        retryWait: retry === null ? null : F('retry_wait'),
        exhausted: retry === null ? null : F('exhausted'),
        sinks: sinkNames,
        doneRequest: doneRequestName, dispatch: dispatchName, collect: collectName, resume: resumeName,
        roundsOut: roundsOutName, callsOut: callsOutName,
      },
    };
  };

  return {
    def, prefix: id, ports, refPorts, toolPorts, exposesSkipped: hasSkip,
    transitions, places: pending, materialise,
  };
}
