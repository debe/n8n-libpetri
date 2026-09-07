/**
 * `compile(workflow, options)`: one flat libpetri net per workflow.
 *
 * Pipeline: structural analysis (`graph.ts`), one `SubnetDef` per node (`gadget.ts`)
 * instantiated at prefix `node.id` (MOD-010), composed in canvas order by port binding
 * (MOD-020) into a flat net (MOD-023) with the shared `_budget` / `_halt` /
 * `_pause` places, the consumer-owned edge places and the `Y/done` reference places bound as ports;
 * then action binding (CORE-042) and the `NetMap`. Every transition of the flat net belongs
 * to a node: there is no host-level transition (see the halt note below). The `PrecompiledNet` program is compiled lazily once per `CompiledWorkflow`
 * (CONC-020) and enforces CORE-043.
 *
 * Declaration order is canvas order: nodes are composed sorted by `(y, x)` ascending and
 * each gadget declares its transitions in a fixed order, so libpetri's declaration-order
 * tiebreak (EXEC-002 AC3) reproduces n8n's sibling order.
 */
import { PetriNet, PrecompiledNet, place, tokenOf, unitToken } from 'libpetri';
import type { Instance, Place, Token } from 'libpetri';
import { placeholderActions } from './actions.js';
import { buildNodeGadget, type GadgetBuild, type HostEdgeSlot } from './gadget.js';
import { analyse, joinFormOf, type WorkflowAnalysis } from './graph.js';
import { structuralHash } from './hash.js';
import { NetMap } from './net-map.js';
import type {
  ActionBinder, BudgetRestriction, CompileOptions, CompiledWorkflow, InputGadget, JoinReadyPlaces, NodeGadget,
  PlaceInfo, SharedPlaces, TransitionInfo, Variant, WorkflowDescription,
} from './types.js';

/**
 * README "Concurrency budget and its safety condition": positional pairing is sound above
 * k = 1 only if every node fires at most once per execution, so the budget is forced to 1
 * for a cyclic workflow or one where an input index has more than one producer.
 */
export function kSafety(analysis: WorkflowAnalysis): BudgetRestriction | null {
  if (analysis.hasCycle) {
    return {
      reason: 'cyclic',
      detail: `nodes in a cycle: ${[...analysis.cyclic].sort().join(', ')}`,
    };
  }
  if (analysis.multiProducerInputs.length > 0) {
    const detail = analysis.multiProducerInputs
      .map((m) => `${m.node}.${m.inputIndex} has ${m.producers} producers`)
      .join('; ');
    return { reason: 'multi-producer-input', detail };
  }
  return null;
}

/**
 * The `ready` place a pre-filled slot of join input `i` lands on: `X/ready_i` for the
 * generic join and for a non-required choose-branch input (one place for both variants),
 * `X/ready_i_data` / `X/ready_i_empty` for a required choose-branch input. Throws a named
 * compile error instead of yielding a `null` marking key when the enumerated form has no
 * place for the variant (an input fed only by cycle edges has no `ready_i_empty`;
 * `initialMarking` never asks for it, since an input seeded empty has only unreachable —
 * hence tree-edge — producers).
 */
export function readySlot(g: NodeGadget, i: InputGadget, variant: Variant): Place<unknown> {
  const p = g.form === 'choose-branch' && i.required ? (variant === 'data' ? i.readyData : i.readyEmpty) : i.ready;
  if (p === null) {
    throw new Error(
      `compile: node '${g.node}' input ${i.index} has no ready_${i.index}_${variant} place to seed ` +
      `(form '${g.form}', emptyCapable ${i.emptyCapable})`);
  }
  return p;
}

export function compile(workflow: WorkflowDescription, options: CompileOptions = {}): CompiledWorkflow {
  const requested = options.budget ?? 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`compile: budget must be a positive integer, got ${requested}`);
  }
  const analysis = analyse(workflow);
  const hash = structuralHash(analysis);
  const restriction = kSafety(analysis);
  const effectiveBudget = restriction === null ? requested : 1;

  const shared: SharedPlaces = {
    budget: place<unknown>('_budget'),
    halt: place<unknown>('_halt'),
    pause: place<unknown>('_pause'),
  };

  // Consumer-owned edge places. The direct form names them `X/in` / `X/in_empty` (README);
  // a join input names them per edge. Cycle edges carry no empty place (emission rule).
  // A node with no producer gets a synthetic `X/in` (the start node's trigger data lands there).
  const edgeSlots = new Map<number, HostEdgeSlot>();
  const syntheticIn = new Map<string, Place<unknown>>();
  for (const a of analysis.nodes) {
    const incoming = analysis.incoming.get(a.node.name)!;
    if (incoming.length === 0) {
      syntheticIn.set(a.node.name, place<unknown>(`${a.node.id}/in`));
      continue;
    }
    const direct = joinFormOf(a, incoming) === 'direct';
    for (const e of incoming) {
      const base = direct ? `${a.node.id}/in` : `${a.node.id}/in${e.inputIndex}_e${e.id}`;
      edgeSlots.set(e.id, {
        edge: e,
        data: place<unknown>(base),
        empty: e.kind === 'tree' ? place<unknown>(`${base}_empty`) : null,
      });
    }
  }

  const builds: GadgetBuild[] = analysis.nodes.map((a) =>
    buildNodeGadget(a, analysis, edgeSlots, syntheticIn.get(a.node.name) ?? null, shared));
  const instances: Instance<void>[] = builds.map((b) => b.def.instantiate(b.prefix));
  const instanceByNode = new Map<string, Instance<void>>();
  const buildByNode = new Map<string, GadgetBuild>();
  analysis.nodes.forEach((a, i) => {
    instanceByNode.set(a.node.name, instances[i]!);
    buildByNode.set(a.node.name, builds[i]!);
  });
  // A referenced node without a skip transition has no body transition touching `skipped`,
  // so the marker lives at the host level and is bound straight into the twins' read ports.
  const hostSkipped = new Map<string, Place<unknown>>();
  for (const a of analysis.nodes) {
    if (analysis.referenced.has(a.node.name) && !buildByNode.get(a.node.name)!.exposesSkipped) {
      hostSkipped.set(a.node.name, place<unknown>(`${a.node.id}/skipped`));
    }
  }

  const builder = PetriNet.builder(workflow.name ?? workflow.id ?? 'workflow');
  builds.forEach((b, i) => {
    const ports = new Map<string, Place<unknown>>(b.ports);
    for (const r of b.refPorts) {
      const host = r.marker === 'skipped' ? hostSkipped.get(r.node) : undefined;
      ports.set(r.port, host ?? instanceByNode.get(r.node)!.port<unknown>(r.marker));
    }
    builder.compose(instances[i]!, ports);
  });

  // There is no reap: `_halt` is the halted run's terminal marker and nothing consumes it
  // (README "Retries, halt, cancellation", ADR 0004). Every transition that could move a
  // pending activation on - start, start_unmet, retry_wait, exhausted, skip, arm, clear -
  // inhibits on it, so the run quiesces with each arrival still on the `in` / edge /
  // `ready` / `hasdata` place it was delivered to, which is where `encodeMarking` in mode
  // `cancelled` reads it and `HALT_REST_ROLES` counts it as a designed terminal's residue
  // (`verify/state-class.ts`). Destroying them with reset arcs and reconstructing them from
  // a marking snapshot, as this did through M5, could not survive `X_run` routing its own
  // outcome: a sibling that resolves in the same executor cycle as the halting node deposits
  // its arrivals in the same phase-1 batch that carries `_halt`, later than any snapshot the
  // halting action could take and earlier than the reap that destroyed them.
  //
  // Canonical place objects are the flat net's own (CORE-002: TS Place identity is by name,
  // so the composition may have funnelled several objects of one name into one).
  const canonical = new Map<string, Place<unknown>>();
  const collect = (net: PetriNet): void => {
    canonical.clear();
    for (const p of net.places) {
      if (canonical.has(p.name)) throw new Error(`internal: two place objects named '${p.name}'`);
      canonical.set(p.name, p);
    }
  };
  const lookup = (name: string): Place<unknown> => {
    const p = canonical.get(name);
    if (p === undefined) throw new Error(`internal: no canonical place '${name}'`);
    return p;
  };
  const structural = builder.build();
  collect(structural);

  const gadgets: NodeGadget[] = builds.map((b) => b.materialise(lookup));
  const placeInfos: PlaceInfo[] = [
    { name: shared.budget.name, role: 'budget', node: null, port: null, place: lookup(shared.budget.name) },
    { name: shared.halt.name, role: 'halt', node: null, port: null, place: lookup(shared.halt.name) },
    { name: shared.pause.name, role: 'pause', node: null, port: null, place: lookup(shared.pause.name) },
    ...builds.flatMap((b) => b.places.map((p): PlaceInfo => ({ ...p, place: lookup(p.name) }))),
  ];
  const transitionInfos: TransitionInfo[] = builds.flatMap((b) => b.transitions);

  // Every place and transition of the flat net is mapped exactly once.
  const mappedPlaces = new Set(placeInfos.map((p) => p.name));
  if (mappedPlaces.size !== placeInfos.length) throw new Error('internal: a place is mapped twice');
  for (const p of structural.places) {
    if (!mappedPlaces.has(p.name)) throw new Error(`internal: unmapped place '${p.name}'`);
  }
  if (structural.places.size !== placeInfos.length) {
    throw new Error(`internal: ${placeInfos.length} mapped places but the net has ${structural.places.size}`);
  }
  if (structural.transitions.size !== transitionInfos.length) {
    throw new Error(`internal: ${transitionInfos.length} mapped transitions but the net has ${structural.transitions.size}`);
  }

  const map0 = new NetMap(structural, shared, gadgets, transitionInfos, placeInfos);
  const fallback = placeholderActions();
  const user = options.actions;
  const net = structural.bindActionsWithResolver((name) => {
    const info = map0.transition(name)!;
    return user?.(info, map0) ?? fallback(info, map0);
  });

  return new CompiledWorkflowImpl(
    net, map0.rebind(net), analysis, hash, requested, effectiveBudget, restriction);
}

class CompiledWorkflowImpl implements CompiledWorkflow {
  readonly net: PetriNet;
  readonly netMap: NetMap;
  readonly analysis: WorkflowAnalysis;
  readonly structuralHash: string;
  readonly startNode: string;
  readonly startNodes: readonly string[];
  readonly requestedBudget: number;
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly joinInputPlaces: readonly Place<unknown>[];
  readonly joinReadyPlaces: readonly JoinReadyPlaces[];
  readonly edgeDataPlaces: readonly Place<unknown>[];
  readonly runningPlaces: readonly Place<unknown>[];
  readonly diagnostics: readonly string[];
  private compiledProgram: PrecompiledNet | null = null;

  constructor(
    net: PetriNet,
    netMap: NetMap,
    analysis: WorkflowAnalysis,
    structuralHash: string,
    requestedBudget: number,
    effectiveBudget: number,
    budgetRestriction: BudgetRestriction | null,
  ) {
    this.net = net;
    this.netMap = netMap;
    this.analysis = analysis;
    this.structuralHash = structuralHash;
    this.startNode = analysis.startNode;
    this.startNodes = analysis.startNodes;
    this.requestedBudget = requestedBudget;
    this.effectiveBudget = effectiveBudget;
    this.budgetRestriction = budgetRestriction;
    this.diagnostics = analysis.diagnostics;
    this.joinInputPlaces = netMap.places.filter((p) => p.role === 'ready').map((p) => p.place);
    this.joinReadyPlaces = netMap.nodes.flatMap((g) => g.inputs.map((i): JoinReadyPlaces => ({
      node: g.node,
      inputIndex: i.index,
      places: [i.ready, i.readyData, i.readyEmpty].filter((p): p is Place<unknown> => p !== null),
    })));
    this.edgeDataPlaces = netMap.places
      .filter((p) => p.role === 'in-data' || p.role === 'edge-data')
      .map((p) => p.place);
    this.runningPlaces = netMap.nodes.map((g) => g.running);
  }

  get program(): PrecompiledNet {
    if (this.compiledProgram === null) this.compiledProgram = PrecompiledNet.compile(this.net);
    return this.compiledProgram;
  }

  sharedMarking(): Map<Place<unknown>, Token<unknown>[]> {
    const marking = new Map<Place<unknown>, Token<unknown>[]>();
    const units = (n: number): Token<unknown>[] => Array.from({ length: n }, () => unitToken() as Token<unknown>);
    const put = (p: Place<unknown>, tokens: Token<unknown>[]): void => {
      if (tokens.length > 0) marking.set(p, tokens);
    };
    put(this.netMap.shared.budget, units(this.effectiveBudget));
    for (const g of this.netMap.nodes) {
      put(g.idle, units(1));
      if (g.tries !== null && g.maxTries !== null) put(g.tries, units(g.maxTries - 1));
      if (g.form === 'or') {
        // An OR input has no slots: every unreachable tree producer is one empty delivery of
        // the first round (the start node's producers are all unreachable, so its round is
        // complete).
        const i = g.inputs[0]!;
        if (g.reachable && i.unreachableEdges > 0) put(i.ready!, units(i.unreachableEdges));
      }
      // Join inputs: a pre-filled slot (unreachable producers) withholds its free token so
      // free_i + ready_i <= 1 from the outset. A dead (unwired, required) input keeps its
      // free token and is never written.
      if (g.form === 'join' || g.form === 'choose-branch') {
        for (const i of g.inputs) {
          if (i.seedEmpty) put(readySlot(g, i, 'empty'), units(1));
          else put(i.free!, units(1));
        }
      }
    }
    // A referenced node unreachable from every start node is definitionally skipped, so the
    // referencing node's start_unmet twin fires and its action fails as n8n would.
    for (const y of this.analysis.seededSkipped) put(this.netMap.node(y).skipped!, units(1));
    return marking;
  }

  initialMarking(triggerItems: unknown): Map<Place<unknown>, Token<unknown>[]> {
    const marking = this.sharedMarking();
    const units = (n: number): Token<unknown>[] => Array.from({ length: n }, () => unitToken() as Token<unknown>);
    const g = this.netMap.node(this.startNode);
    if (g.form === 'direct') {
      marking.set(g.in!, [tokenOf<unknown>(triggerItems)]);
    } else if (g.form === 'or') {
      // The trigger payload is one data arrival.
      marking.set(g.inputs[0]!.hasdata!, [tokenOf<unknown>(triggerItems)]);
    } else {
      g.inputs.forEach((i, k) => {
        // The start node's own activation pre-fills every slot, withholding free_i and
        // replacing the empty a seeded (unreachable-producer) input would otherwise carry.
        marking.delete(i.free!);
        for (const p of [i.ready, i.readyData, i.readyEmpty]) if (p !== null) marking.delete(p);
        if (k === 0) {
          // n8n hands `nodeExecutionStack[0].data.main[0]` to the first input.
          marking.set(readySlot(g, i, 'data'), [tokenOf<unknown>(triggerItems)]);
          if (g.hasdata !== null) marking.set(g.hasdata, units(1));
        } else {
          // The other inputs of the start node are present but carry no items (n8n passes
          // only main[0]); they take the `data` slot so X_start fires, as n8n runs
          // nodeExecutionStack[0] unconditionally. The generic join's ready_i is the same
          // place for both variants; hasdata comes from the first input.
          marking.set(readySlot(g, i, 'data'), units(1));
        }
      });
    }
    return marking;
  }

  withActions(binder: ActionBinder): CompiledWorkflow {
    const rebound = this.net.bindActionsWithResolver((name) => binder(this.netMap.transition(name)!, this.netMap));
    return new CompiledWorkflowImpl(
      rebound, this.netMap.rebind(rebound), this.analysis, this.structuralHash,
      this.requestedBudget, this.effectiveBudget, this.budgetRestriction);
  }
}
