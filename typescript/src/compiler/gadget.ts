/**
 * The per-node gadget as a libpetri `SubnetDef` (MOD-001), instantiated at prefix `node.id`
 * (MOD-010) and composed by port binding (MOD-020). Implements README "Per-node gadget"
 * (ADR 0004: two-phase start/run with the outcome routed through `X/ok`):
 *
 * ```
 * X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_halted)
 *               [read(Y/done) per $('Y')]                     → X/running        priority depth
 * X_start_unmet_k: the same without the reads, read(Y_k/skipped) → X/running (tagged) priority depth − 1
 * X_run:        one(X/running) → and( xor( X/ok, [X/retry], [and(_halt, _budget)] ), X/idle )
 *                                                                                 priority depth + 1
 * X_route:      one(X/ok) → and( per connected output o: xor( and(data edges_o), and(empty edges_o) | X/nil_o ),
 *                                _budget, X/done )                                priority depth + 1
 * X_skip:       one(X/in_empty) → and( empty tree edges, X/skipped )              priority depth
 * X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
 *               delayed(waitBetweenTries) → X/running                             priority depth
 * X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, [and(_halt, _budget)] ) priority depth + 1
 * sink_o:       one(X/nil_o)  (no Out spec: a genuine sink, CORE-043 AC4)
 * ```
 *
 * **Verifier scaling** (README): the flatteners expand `and` of `k` `xor`s into `2^k`
 * virtual transitions (IO-016), so above {@link SPLIT_ROUTING_ABOVE} connected outputs the
 * success branch of `X_run` / `X_exhausted` produces `and(X/ok_o …)`, each
 * `X_route_o: one(X/ok_o) → and(xor(…), X/routed_o)` routes one output and
 * `X_done: one(X/routed_0) … → and(_budget, X/done)` refunds the budget. The P-semiflow
 * then reads `n·_budget + n·running + n·retry + Σ_o(ok_o + routed_o) = n·k`.
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
 *   inhibitor(ran_i)`, `X_clear: exactly(n, ready_i) inhibitor(hasdata_i) all(ran_i)`, both
 *   with `read(idle)` (the round decision waits for an in-flight `X_start` to land `ran_i`).
 *   Producers inside a cycle deliver `hasdata_i` only and do not count towards `n`; their
 *   runs leave `ran_i` markers behind once the round is closed.
 *
 * Emission rule per edge kind (README, ADR 0002): a tree edge from an acyclic producer
 * carries `data | empty`; a tree edge from a producer inside a cycle carries `data | nil`
 * on run and `empty` on skip; a cycle edge carries `data | nil` on run and nothing on skip.
 *
 * Every start, retry-wait, exhausted, skip and arm transition inhibits on `_halt` and
 * `_halted` (README "Retries, halt, cancellation"), so a halted run quiesces without a
 * post-halt cascade. `X/retry` is never reaped: it holds a budget unit.
 *
 * Everything that crosses a node boundary is a port: `_budget` / `_halt` / `_halted`, the
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

/** Nodes with more connected outputs than this route per output (README "Verifier scaling"). */
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

export interface GadgetBuild {
  readonly def: SubnetDef<void>;
  readonly prefix: string;
  /** Original port name → host place, for `compose(instance, ports)`. Reference ports excluded. */
  readonly ports: ReadonlyMap<string, Place<unknown>>;
  readonly refPorts: readonly ReferencePort[];
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
  /** Final names of the internal places `_halt_reap` resets (ready and hasdata places). */
  readonly reapPlaceNames: readonly string[];
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

  const portDecls: PortDecl[] = [];
  const ports = new Map<string, Place<unknown>>();
  const refPorts: ReferencePort[] = [];
  const pending: PendingPlace[] = [];
  const transitions: TransitionInfo[] = [];
  const reapPlaceNames: string[] = [];
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
  const halted = place<unknown>('halted');
  port('halted', halted, host.halted, 'input');

  // ---- markers ----
  const idle = internal('idle', 'idle', null);
  const running = internal('running', 'running', null);
  const done = internal('done', 'done', null);
  // Exposed (unbound) so referencing nodes can bind their read port to it.
  portDecls.push({ name: 'done', local: done, direction: 'output' });

  // ---- input side ----
  let inLocal: Place<unknown> | null = null;
  let inEmptyLocal: Place<unknown> | null = null;
  let inFinal: string | null = null;
  let inEmptyFinal: string | null = null;
  const inputs: LocalInput[] = [];

  if (form === 'direct') {
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
        reapPlaceNames.push(F(`ready_${i}`), F(`hasdata_${i}`));
      } else {
        free = internal(`free_${i}`, 'free', i);
        if (form === 'choose-branch' && isRequired) {
          readyData = internal(`ready_${i}_data`, 'ready', i, { variant: 'data' });
          reapPlaceNames.push(F(`ready_${i}_data`));
          if (emptyCapable) {
            readyEmpty = internal(`ready_${i}_empty`, 'ready', i, { variant: 'empty' });
            reapPlaceNames.push(F(`ready_${i}_empty`));
          }
        } else {
          ready = internal(`ready_${i}`, 'ready', i);
          reapPlaceNames.push(F(`ready_${i}`));
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
  if (hasdata !== null) reapPlaceNames.push(F('hasdata'));

  // ---- skip exists iff an empty token can arrive where it decides the activation ----
  const hasSkip = form === 'direct' ? inEmptyLocal !== null
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
  const ok = split ? null : internal('ok', 'ok', null);
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

  // ---- Out spec builders ----
  const routingOf = (out: LocalOutput): Out => xor(
    andOf(out.edges.map((e) => outPlace(e.data))),
    out.nil !== null ? outPlace(out.nil) : andOf(out.edges.map((e) => outPlace(e.empty!))),
  );
  const success: Out = split ? and(...outputs.map((o) => outPlace(o.ok!))) : outPlace(ok!);
  const haltBranch = and(outPlace(halt), outPlace(budget));
  const freeRefunds = (): Out[] => inputs.map((i) => outPlace(i.free!));
  const readyOf = (i: LocalInput): Place<unknown> => (i.required && form === 'choose-branch' ? i.readyData! : i.ready!);

  // ---- X_start and its start_unmet twins ----
  const startBuilder = (local: string, priority: number) => {
    const b = Transition.builder(local).priority(priority).inhibitors(halt, halted);
    if (form === 'direct') {
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
  const outcome = xorOf([
    success,
    ...(retry !== null ? [outPlace(retry)] : []),
    ...(stopWorkflow ? [haltBranch] : []),
  ]);
  body.push(Transition.builder('run')
    .inputs(one(running))
    .outputs(and(outcome, outPlace(idle)))
    .priority(depth + 1).build());
  tinfo('run', 'run');

  // ---- X_route: per-edge routing, budget refund, done (split per output above the threshold) ----
  const routeNames: string[] = [];
  let doneName: string | null = null;
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
    body.push(Transition.builder('done')
      .inputs(...outputs.map((o) => one(o.routed!)))
      .outputs(and(outPlace(budget), outPlace(done)))
      .priority(depth + 1).build());
    tinfo('done', 'done');
    doneName = F('done');
  } else {
    body.push(Transition.builder('route')
      .inputs(one(ok!))
      .outputs(and(...outputs.map(routingOf), outPlace(budget), outPlace(done)))
      .priority(depth + 1).build());
    tinfo('route', 'route');
    routeNames.push(F('route'));
  }

  // ---- X_skip ----
  const skipNames: string[] = [];
  if (hasSkip) {
    if (form === 'direct') {
      body.push(Transition.builder('skip')
        .inputs(one(inEmptyLocal!))
        .inhibitors(halt, halted)
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
        .inhibitors(i.hasdata!, i.ran!, halt, halted)
        .read(idle)
        .outputs(andOf([...skipEmpties, outPlace(skipped!)]))
        .priority(depth).build());
      tinfo('skip', 'skip');
      skipNames.push(F('skip'));
    } else if (form === 'join') {
      const skip = Transition.builder('skip').inhibitors(hasdata!, halt, halted).priority(depth);
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
        const skip = Transition.builder(local).inhibitors(halt, halted).priority(depth);
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
      .inhibitor(i.hasdata!)
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
      const armData = Transition.builder(dataName).inputs(one(e.data)).inhibitors(halt, halted).priority(depth);
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
        const armEmpty = Transition.builder(emptyName).inputs(one(e.empty)).inhibitors(halt, halted).priority(depth);
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
      .inhibitors(halt, halted)
      .timing(delayed(a.waitBetweenTries!))
      .outputs(outPlace(running))
      .priority(depth).build());
    tinfo('retry_wait', 'retry');
    body.push(Transition.builder('exhausted')
      .inputs(one(retry))
      .inhibitors(tries, halt, halted)
      .outputs(xorOf([success, ...(stopWorkflow ? [haltBranch] : [])]))
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
      form, depth, cyclic, reachable, isStart: name === analysis.startNode,
      onError: a.onError, retryOnFail: a.retryOnFail, maxTries: a.maxTries, waitBetweenTries: a.waitBetweenTries,
      in: inFinal === null ? null : lookup(inFinal),
      inEmpty: inEmptyFinal === null ? null : lookup(inEmptyFinal),
      running: lookup(F('running')), idle: lookup(F('idle')),
      ok: opt(ok, 'ok'), splitRouting: split, done: lookup(F('done')),
      skipped: hasSkip || referenced ? lookup(F('skipped')) : null,
      hasdata: opt(hasdata, 'hasdata'),
      retry: opt(retry, 'retry'),
      tries: opt(tries, 'tries'),
      inputs: inputGadgets, outputs: outputGadgets,
      references: referenceNames, unguardedReferences,
      transitions: {
        start: F('start'), startUnmet: startUnmetNames, run: F('run'), routes: routeNames, done: doneName,
        skip: skipNames, arms: armNames, clear: clearNames,
        retryWait: retry === null ? null : F('retry_wait'),
        exhausted: retry === null ? null : F('exhausted'),
        sinks: sinkNames,
      },
    };
  };

  return { def, prefix: id, ports, refPorts, exposesSkipped: hasSkip, transitions, places: pending, reapPlaceNames, materialise };
}
