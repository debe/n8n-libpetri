/**
 * Composition: one `SubnetDef` per node (`gadget.ts`) instantiated at prefix `node.id`
 * (MOD-010), composed in canvas order by port binding (MOD-020) into one flat net (MOD-023)
 * with the shared `_budget` / `_halt` / `_pause` places, the consumer-owned edge places and the
 * `Y/done` reference places bound as ports.
 */
import { PetriNet, place } from 'libpetri';
import type { Instance, Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { buildNodeGadget, type GadgetBuild } from '../gadget.js';
import { SHARED_PLACE, skippedPlaceOf } from '../names.js';
import type { AnalysedNode, SharedPlaces, WorkflowAnalysis, WorkflowDescription } from '../types.js';
import { hostEdgePlaces } from './edge-places.js';

/** The structural (action-free) flat net, the gadget builds it was composed from, and its shared places. */
export interface ComposedNet {
  readonly structural: PetriNet;
  readonly builds: readonly GadgetBuild[];
  readonly shared: SharedPlaces;
}

interface ComposedNode {
  readonly a: AnalysedNode;
  readonly build: GadgetBuild;
  readonly instance: Instance<void>;
}

type Instances = ReadonlyMap<string, Instance<void>>;

/** The instance of a node another node's port binds to; every name here came from the analysis. */
function instanceOf(instances: Instances, node: string): Instance<void> {
  const instance = instances.get(node);
  if (instance === undefined) throw new InternalCompilerError(`internal: no instance for node '${node}'`);
  return instance;
}

/**
 * A referenced node without a skip transition has no body transition touching `skipped`,
 * so the marker lives at the host level and is bound straight into the twins' read ports.
 */
function hostSkippedPlaces(analysis: WorkflowAnalysis, composed: readonly ComposedNode[]): Map<string, Place<unknown>> {
  const hostSkipped = new Map<string, Place<unknown>>();
  for (const { a, build } of composed) {
    if (analysis.referenced.has(a.node.name) && !build.exposesSkipped) {
      hostSkipped.set(a.node.name, place<unknown>(skippedPlaceOf(a.node.id)));
    }
  }
  return hostSkipped;
}

/** Original port name → host place for one node's `compose(instance, ports)`. */
function portsOf(b: GadgetBuild, hostSkipped: ReadonlyMap<string, Place<unknown>>, instances: Instances): Map<string, Place<unknown>> {
  const ports = new Map<string, Place<unknown>>(b.ports);
  for (const r of b.refPorts) {
    const host = r.marker === 'skipped' ? hostSkipped.get(r.node) : undefined;
    ports.set(r.port, host ?? instanceOf(instances, r.node).port<unknown>(r.marker));
  }
  // Agent tool dispatch: the agent's `tool_k` port binds to the tool's own `in_tool` place,
  // and the tool's `resp_k` port to its agent's `response` place. Same mechanism as a
  // reference port — the owner exposes it, the writer binds to it.
  for (const t of b.toolPorts) {
    ports.set(t.port, instanceOf(instances, t.node).port<unknown>(t.marker));
  }
  return ports;
}

/** Composes every node's gadget, in canvas order, into the structural flat net. */
export function composeNet(workflow: WorkflowDescription, analysis: WorkflowAnalysis): ComposedNet {
  const shared: SharedPlaces = {
    budget: place<unknown>(SHARED_PLACE.budget),
    halt: place<unknown>(SHARED_PLACE.halt),
    pause: place<unknown>(SHARED_PLACE.pause),
  };
  const { edgeSlots, syntheticIn } = hostEdgePlaces(analysis);
  const instances = new Map<string, Instance<void>>();
  const composed = analysis.nodes.map((a): ComposedNode => {
    const build = buildNodeGadget(a, analysis, edgeSlots, syntheticIn.get(a.node.name) ?? null, shared);
    const instance = build.def.instantiate(build.prefix);
    instances.set(a.node.name, instance);
    return { a, build, instance };
  });
  const hostSkipped = hostSkippedPlaces(analysis, composed);

  const builder = PetriNet.builder(workflow.name ?? workflow.id ?? 'workflow');
  for (const { build, instance } of composed) builder.compose(instance, portsOf(build, hostSkipped, instances));

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
  return { structural: builder.build(), builds: composed.map((c) => c.build), shared };
}
