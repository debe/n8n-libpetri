/**
 * `NetMap`: the bidirectional correspondence between the flat net and the workflow:
 * transition name <-> (node, role), place name <-> (node, port, role), plus the per-node
 * gadget descriptors the scheduler drives. Place objects are the canonical ones of the
 * flat net (CORE-002); transition objects are looked up by name on the bound net, so a
 * `NetMap` can be re-pointed at a re-bound net (CORE-042) without rebuilding its indexes.
 *
 * The map of an `engineV2` net (`tasks/v2-profile-plan.md` decision 14) has no `NodeGadget`s and
 * no `_budget` / `_pause`: its nodes are {@link SettlementGadget}s, served by `settlement(name)`,
 * and `_halt` is its one shared place. The transition and place lookups serve both profiles; the
 * gadget accessors serve one each and throw `InternalCompilerError` on the other's map
 * (`shared`, `nodes`, `node`, `hasNode`, `tryNode` are v1's; `settlements`, `settlement` are
 * `engineV2`'s). An empty answer would be wrong rather than empty: every v1 consumer reads a
 * workflow with no gadgets as one with no nodes. The consumers refuse the other profile at their
 * entry (`ProfileMismatchError`), so reaching one of these throws is a bug past that check.
 */
import type { PetriNet, Place, Transition } from 'libpetri';
import { CompileError, InternalCompilerError } from './errors.js';
import type {
  CompileProfile, NetMapView, NodeGadget, PlaceInfo, PlaceRole, SettlementGadget, SharedPlaces, TransitionInfo,
  TransitionInfoOf, TransitionRole,
} from './types.js';

/** What an `engineV2` net's map holds instead of the v1 gadgets and shared places. */
export interface SettlementNodes {
  /** `_halt`, the one shared place of an `engineV2` net. */
  readonly halt: Place<unknown>;
  /** One per compiled node, in declaration (canvas) order. */
  readonly gadgets: readonly SettlementGadget[];
}

/**
 * The key of a `(node, role, port)` lookup. `port` is `null` for an info that carries none
 * (a `PlaceInfo` says so with `null`, a `TransitionInfo` by having no `port` field), and
 * a query without a port is keyed on the pair alone, so it finds the first info of that
 * role in declaration order whatever its port — the match the linear scan made.
 */
function roleKey(node: string, role: string, port: number | null | undefined): string {
  // NUL never occurs in an n8n node name; roles are identifiers and ports integers.
  return port === undefined ? `${node}\0${role}` : `${node}\0${role}\0${port}`;
}

/** The port a transition info carries, `null` when its role has none (`route`, `clear` carry one). */
function transitionPort(t: TransitionInfo): number | null {
  return 'port' in t ? t.port : null;
}

export class NetMap implements NetMapView {
  readonly profile: CompileProfile;
  readonly transitions: readonly TransitionInfo[];
  readonly places: readonly PlaceInfo[];
  readonly halt: Place<unknown>;

  // `private`, not `#private`: a view made with `Object.create(netMap, …)` must still read them.
  private readonly nodeGadgets: readonly NodeGadget[];
  private readonly settlementGadgets: readonly SettlementGadget[];
  private readonly sharedPlaces: SharedPlaces | null;
  private readonly settlementNodes: SettlementNodes | null;
  private readonly settlementsByName = new Map<string, SettlementGadget>();

  private readonly transitionsByName = new Map<string, TransitionInfo>();
  private readonly transitionsByNode = new Map<string, TransitionInfo[]>();
  private readonly transitionsByRole = new Map<string, TransitionInfo>();
  private readonly placesByName = new Map<string, PlaceInfo>();
  private readonly placesByNode = new Map<string, PlaceInfo[]>();
  private readonly placesByRole = new Map<string, PlaceInfo>();
  private readonly nodesByName = new Map<string, NodeGadget>();
  private readonly transitionObjects = new Map<string, Transition>();

  /**
   * A v1 map takes the shared places and the node gadgets; an `engineV2` map takes `null`, no node
   * gadgets, and its {@link SettlementNodes}.
   */
  constructor(
    net: PetriNet,
    shared: SharedPlaces | null,
    nodes: readonly NodeGadget[],
    transitions: readonly TransitionInfo[],
    places: readonly PlaceInfo[],
    settlement: SettlementNodes | null = null,
  ) {
    const halt = shared === null ? settlement?.halt : settlement === null ? shared.halt : undefined;
    if (halt === undefined) {
      throw new InternalCompilerError('NetMap: a map has either the v1 shared places or engineV2 settlement nodes');
    }
    if (settlement !== null && nodes.length > 0) throw new InternalCompilerError('NetMap: an engineV2 map has v1 node gadgets');
    this.profile = settlement === null ? 'v1' : 'engineV2';
    this.sharedPlaces = shared;
    this.settlementNodes = settlement;
    this.halt = halt;
    this.settlementGadgets = settlement?.gadgets ?? [];
    this.nodeGadgets = nodes;
    this.transitions = transitions;
    this.places = places;
    for (const g of nodes) this.nodesByName.set(g.node, g);
    for (const g of this.settlementGadgets) this.settlementsByName.set(g.node, g);
    for (const t of transitions) {
      if (this.transitionsByName.has(t.name)) throw new InternalCompilerError(`NetMap: duplicate transition '${t.name}'`);
      this.transitionsByName.set(t.name, t);
      const list = this.transitionsByNode.get(t.node) ?? [];
      list.push(t);
      this.transitionsByNode.set(t.node, list);
      // First in declaration order wins both keys: the match the linear scan made.
      for (const key of [roleKey(t.node, t.role, undefined), roleKey(t.node, t.role, transitionPort(t))]) {
        if (!this.transitionsByRole.has(key)) this.transitionsByRole.set(key, t);
      }
    }
    for (const p of places) {
      if (this.placesByName.has(p.name)) throw new InternalCompilerError(`NetMap: duplicate place '${p.name}'`);
      this.placesByName.set(p.name, p);
      if (p.node !== null) {
        const list = this.placesByNode.get(p.node) ?? [];
        list.push(p);
        this.placesByNode.set(p.node, list);
        for (const key of [roleKey(p.node, p.role, undefined), roleKey(p.node, p.role, p.port)]) {
          if (!this.placesByRole.has(key)) this.placesByRole.set(key, p);
        }
      }
    }
    for (const t of net.transitions) this.transitionObjects.set(t.name, t);
    for (const name of this.transitionsByName.keys()) {
      if (!this.transitionObjects.has(name)) throw new InternalCompilerError(`NetMap: net has no transition '${name}'`);
    }
  }

  /**
   * `_budget`, `_halt` and `_pause`. A v1 accessor: an `engineV2` net has no budget and no pause,
   * so asking its map is a compiler bug, not a question with an empty answer.
   */
  get shared(): SharedPlaces {
    if (this.sharedPlaces === null) {
      throw new InternalCompilerError('NetMap.shared: an engineV2 net has no _budget or _pause; read NetMap.halt');
    }
    return this.sharedPlaces;
  }

  /** Node gadgets in declaration (canvas) order. A v1 accessor. */
  get nodes(): readonly NodeGadget[] {
    this.requireV1('nodes');
    return this.nodeGadgets;
  }

  /** Settlement gadgets in declaration (canvas) order. An `engineV2` accessor. */
  get settlements(): readonly SettlementGadget[] {
    this.requireEngineV2('settlements');
    return this.settlementGadgets;
  }

  /** The same map over a re-bound net (same names, new `Transition` objects). */
  rebind(net: PetriNet): NetMap {
    return new NetMap(net, this.sharedPlaces, this.nodeGadgets, this.transitions, this.places, this.settlementNodes);
  }

  /** The settlement gadget of `name` in an `engineV2` net; throws for a node the net does not compile. */
  settlement(name: string): SettlementGadget {
    this.requireEngineV2('settlement');
    const g = this.settlementsByName.get(name);
    if (g === undefined) throw new CompileError('unknown-node', `NetMap: no settlement gadget for node '${name}'`, name);
    return g;
  }

  node(name: string): NodeGadget {
    this.requireV1('node');
    const g = this.nodesByName.get(name);
    if (g === undefined) throw new CompileError('unknown-node', `NetMap: unknown node '${name}'`, name);
    return g;
  }

  hasNode(name: string): boolean {
    this.requireV1('hasNode');
    return this.nodesByName.has(name);
  }

  tryNode(name: string): NodeGadget | undefined {
    this.requireV1('tryNode');
    return this.nodesByName.get(name);
  }

  private requireV1(accessor: string): void {
    if (this.profile !== 'v1') {
      throw new InternalCompilerError(`NetMap.${accessor}: an engineV2 net has no NodeGadgets; read NetMap.settlement(s)`);
    }
  }

  private requireEngineV2(accessor: string): void {
    if (this.profile !== 'engineV2') {
      throw new InternalCompilerError(`NetMap.${accessor}: a v1 net has no SettlementGadgets; read NetMap.node(s)`);
    }
  }

  transition(name: string): TransitionInfo | undefined {
    return this.transitionsByName.get(name);
  }

  transitionsOf(node: string): readonly TransitionInfo[] {
    return this.transitionsByNode.get(node) ?? [];
  }

  transitionFor<R extends TransitionRole>(node: string, role: R, port?: number): TransitionInfoOf<R> | undefined {
    // `port` is carried by `route` (an output index) and `clear` (an input index) only; asking
    // another role for one matches nothing, as it always did.
    const t = this.transitionsByRole.get(roleKey(node, role, port));
    return t === undefined ? undefined : (t as TransitionInfoOf<R>);
  }

  transitionObject(name: string): Transition {
    const t = this.transitionObjects.get(name);
    if (t === undefined) throw new CompileError('unknown-transition', `NetMap: unknown transition '${name}'`);
    return t;
  }

  place(name: string): PlaceInfo | undefined {
    return this.placesByName.get(name);
  }

  placesOf(node: string): readonly PlaceInfo[] {
    return this.placesByNode.get(node) ?? [];
  }

  placeFor(node: string, role: PlaceRole, port?: number): PlaceInfo | undefined {
    return this.placesByRole.get(roleKey(node, role, port));
  }
}
