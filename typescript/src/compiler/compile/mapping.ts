/**
 * The `NetMap` of a composed net: every gadget materialised over the flat net's canonical place
 * objects, and every place and transition mapped exactly once.
 */
import type { PetriNet, Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { GadgetBuild } from '../gadget.js';
import { NetMap } from '../net-map.js';
import type { PlaceInfo, SharedPlaces, TransitionInfo } from '../types.js';
import type { ComposedNet, SettlementComposedNet } from './compose.js';

type Lookup = (name: string) => Place<unknown>;

/**
 * Canonical place objects are the flat net's own (CORE-002: TS Place identity is by name,
 * so the composition may have funnelled several objects of one name into one).
 */
function canonicalLookup(structural: PetriNet): Lookup {
  const canonical = new Map<string, Place<unknown>>();
  for (const p of structural.places) {
    if (canonical.has(p.name)) throw new InternalCompilerError(`internal: two place objects named '${p.name}'`);
    canonical.set(p.name, p);
  }
  return (name) => {
    const p = canonical.get(name);
    if (p === undefined) throw new InternalCompilerError(`internal: no canonical place '${name}'`);
    return p;
  };
}

/** The shared places first, then every node's own, each resolved to its canonical object. */
function placeInfosOf(shared: SharedPlaces, builds: readonly GadgetBuild[], lookup: Lookup): PlaceInfo[] {
  return [
    { name: shared.budget.name, role: 'budget', node: null, port: null, place: lookup(shared.budget.name) },
    { name: shared.halt.name, role: 'halt', node: null, port: null, place: lookup(shared.halt.name) },
    { name: shared.pause.name, role: 'pause', node: null, port: null, place: lookup(shared.pause.name) },
    ...builds.flatMap((b) => b.places.map((p): PlaceInfo => ({ ...p, place: lookup(p.name) }))),
  ];
}

/** Every place and transition of the flat net is mapped exactly once. */
function assertMappedOnce(structural: PetriNet, placeInfos: readonly PlaceInfo[], transitionInfos: readonly TransitionInfo[]): void {
  const mappedPlaces = new Set<string>();
  for (const p of placeInfos) {
    if (mappedPlaces.has(p.name)) throw new InternalCompilerError('internal: a place is mapped twice');
    mappedPlaces.add(p.name);
  }
  for (const p of structural.places) {
    if (!mappedPlaces.has(p.name)) throw new InternalCompilerError(`internal: unmapped place '${p.name}'`);
  }
  if (structural.places.size !== placeInfos.length) {
    throw new InternalCompilerError(`internal: ${placeInfos.length} mapped places but the net has ${structural.places.size}`);
  }
  if (structural.transitions.size !== transitionInfos.length) {
    throw new InternalCompilerError(`internal: ${transitionInfos.length} mapped transitions but the net has ${structural.transitions.size}`);
  }
}

/**
 * The `NetMap` of an `engineV2` net: `_halt`, then every node's own places, and a settlement
 * gadget per compiled node instead of a v1 `NodeGadget` (`tasks/v2-profile-plan.md` decision 14).
 */
function mapSettlementNet({ structural, builds, halt }: SettlementComposedNet): NetMap {
  const lookup = canonicalLookup(structural);
  const settlements = builds.map((b) => b.materialise(lookup));
  const placeInfos: PlaceInfo[] = [
    { name: halt.name, role: 'halt', node: null, port: null, place: lookup(halt.name) },
    ...builds.flatMap((b) => b.places.map((p): PlaceInfo => ({ ...p, place: lookup(p.name) }))),
  ];
  const transitionInfos: TransitionInfo[] = builds.flatMap((b) => b.transitions);
  assertMappedOnce(structural, placeInfos, transitionInfos);
  return new NetMap(structural, null, [], transitionInfos, placeInfos, { halt: lookup(halt.name), gadgets: settlements });
}

/** The `NetMap` of a composed net, of either profile. */
export function mapNet(composed: ComposedNet): NetMap {
  return composed.profile === 'engineV2'
    ? mapSettlementNet(composed)
    : mapV1Net(composed.structural, composed.shared, composed.builds);
}

/** The `NetMap` of the structural net `builds` were composed into. */
function mapV1Net(structural: PetriNet, shared: SharedPlaces, builds: readonly GadgetBuild[]): NetMap {
  const lookup = canonicalLookup(structural);
  const gadgets = builds.map((b) => b.materialise(lookup));
  const placeInfos = placeInfosOf(shared, builds, lookup);
  const transitionInfos: TransitionInfo[] = builds.flatMap((b) => b.transitions);
  assertMappedOnce(structural, placeInfos, transitionInfos);
  return new NetMap(structural, shared, gadgets, transitionInfos, placeInfos);
}
