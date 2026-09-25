/**
 * Port names: the edge ports a producer writes and a consumer binds, their `empty` twins, and
 * the cross-node ports of `$('Y')` references and agent tool dispatch. A host place bound to a
 * port carries the port's name qualified by the consumer (`names.ts`). Re-exported through
 * `names.ts`, the one import surface of the vocabulary.
 */
import { PLACE } from './places.js';

/** The `empty` twin of an edge place or port: `${local}_empty`. */
export function emptyTwinOf(local: string): string {
  return `${local}_empty`;
}

/** A join / OR input's data port for one producer edge: `in${inputIndex}_e${edgeId}`. */
export function edgeInPortOf(inputIndex: number, edgeId: number): string {
  return `in${inputIndex}_e${edgeId}`;
}

/**
 * The consumer port an edge's data place binds to: {@link PLACE}`.in` in the direct form,
 * {@link edgeInPortOf} in a join or OR input. Its {@link emptyTwinOf} is the empty port.
 */
export function consumerPortOf(direct: boolean, inputIndex: number, edgeId: number): string {
  return direct ? PLACE.in : edgeInPortOf(inputIndex, edgeId);
}

/** A producer's output port for one edge: `out_e${edgeId}`. */
export function edgeOutPortOf(edgeId: number): string {
  return `out_e${edgeId}`;
}

/** The read port a `$('Y')` reference binds to `Y/done`: `ref_${k}` (CORE-032). */
export function refDonePortOf(reference: number): string {
  return `ref_${reference}`;
}

/** The read port a start-unmet twin binds to `Y/skipped`: `refskip_${k}`. */
export function refSkippedPortOf(reference: number): string {
  return `refskip_${reference}`;
}

/** An agent's write port into its `k`-th tool's `in_tool`: `tool_${k}`. */
export function toolInPortOf(tool: number): string {
  return `tool_${tool}`;
}

/** A tool's write port into its `k`-th agent's `response`: `resp_${k}`. */
export function agentResponsePortOf(agent: number): string {
  return `resp_${agent}`;
}

/**
 * The one port an `engineV2` gadget binds edge `edgeId`'s `arrived` host place through, whether
 * it consumes the arrival, writes it, or both (a batch node's self loop): `arrived_e${edgeId}`.
 */
export function arrivedPortOf(edgeId: number): string {
  return `arrived_e${edgeId}`;
}

/**
 * The port an `engineV2` producer writes a successor's `live` place through: `live_${id}`. The
 * node's own `live` keeps {@link PLACE}`.live`, and a node that writes its own (a batch node's self
 * loop) binds it once, under that name.
 */
export function successorLivePortOf(id: string): string {
  return `live_${id}`;
}
