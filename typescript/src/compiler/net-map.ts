/**
 * `NetMap`: the bidirectional correspondence between the flat net and the workflow:
 * transition name <-> (node, role), place name <-> (node, port, role), plus the per-node
 * gadget descriptors the scheduler drives. Place objects are the canonical ones of the
 * flat net (CORE-002); transition objects are looked up by name on the bound net, so a
 * `NetMap` can be re-pointed at a re-bound net (CORE-042) without rebuilding its indexes.
 */
import type { PetriNet, Transition } from 'libpetri';
import type {
  NetMapView, NodeGadget, PlaceInfo, PlaceRole, SharedPlaces, TransitionInfo, TransitionRole,
} from './types.js';

export class NetMap implements NetMapView {
  readonly shared: SharedPlaces;
  readonly nodes: readonly NodeGadget[];
  readonly transitions: readonly TransitionInfo[];
  readonly places: readonly PlaceInfo[];

  private readonly transitionsByName = new Map<string, TransitionInfo>();
  private readonly transitionsByNode = new Map<string, TransitionInfo[]>();
  private readonly placesByName = new Map<string, PlaceInfo>();
  private readonly placesByNode = new Map<string, PlaceInfo[]>();
  private readonly nodesByName = new Map<string, NodeGadget>();
  private readonly transitionObjects = new Map<string, Transition>();

  constructor(
    net: PetriNet,
    shared: SharedPlaces,
    nodes: readonly NodeGadget[],
    transitions: readonly TransitionInfo[],
    places: readonly PlaceInfo[],
  ) {
    this.shared = shared;
    this.nodes = nodes;
    this.transitions = transitions;
    this.places = places;
    for (const g of nodes) this.nodesByName.set(g.node, g);
    for (const t of transitions) {
      if (this.transitionsByName.has(t.name)) throw new Error(`NetMap: duplicate transition '${t.name}'`);
      this.transitionsByName.set(t.name, t);
      if (t.node !== null) {
        const list = this.transitionsByNode.get(t.node) ?? [];
        list.push(t);
        this.transitionsByNode.set(t.node, list);
      }
    }
    for (const p of places) {
      if (this.placesByName.has(p.name)) throw new Error(`NetMap: duplicate place '${p.name}'`);
      this.placesByName.set(p.name, p);
      if (p.node !== null) {
        const list = this.placesByNode.get(p.node) ?? [];
        list.push(p);
        this.placesByNode.set(p.node, list);
      }
    }
    for (const t of net.transitions) this.transitionObjects.set(t.name, t);
    for (const name of this.transitionsByName.keys()) {
      if (!this.transitionObjects.has(name)) throw new Error(`NetMap: net has no transition '${name}'`);
    }
  }

  /** The same map over a re-bound net (same names, new `Transition` objects). */
  rebind(net: PetriNet): NetMap {
    return new NetMap(net, this.shared, this.nodes, this.transitions, this.places);
  }

  node(name: string): NodeGadget {
    const g = this.nodesByName.get(name);
    if (g === undefined) throw new Error(`NetMap: unknown node '${name}'`);
    return g;
  }

  transition(name: string): TransitionInfo | undefined {
    return this.transitionsByName.get(name);
  }

  transitionsOf(node: string): readonly TransitionInfo[] {
    return this.transitionsByNode.get(node) ?? [];
  }

  transitionFor(node: string, role: TransitionRole, port?: number): TransitionInfo | undefined {
    return this.transitionsOf(node).find((t) => t.role === role && (port === undefined || t.port === port));
  }

  transitionObject(name: string): Transition {
    const t = this.transitionObjects.get(name);
    if (t === undefined) throw new Error(`NetMap: unknown transition '${name}'`);
    return t;
  }

  place(name: string): PlaceInfo | undefined {
    return this.placesByName.get(name);
  }

  placesOf(node: string): readonly PlaceInfo[] {
    return this.placesByNode.get(node) ?? [];
  }

  placeFor(node: string, role: PlaceRole, port?: number): PlaceInfo | undefined {
    return this.placesOf(node).find((p) => p.role === role && (port === undefined || p.port === port));
  }
}
