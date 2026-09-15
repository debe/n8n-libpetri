/**
 * The builder state one gadget accumulates — port declarations, host-port bindings, place and
 * transition descriptors, the transition bodies — and the recorders every phase declares
 * through: `port` (MOD-020), `internal` (MOD-010), `hostOwned`, `tinfo` and `emit`.
 */
import { place } from 'libpetri';
import type { Place, PortDirection, Transition } from 'libpetri';
import { qualified } from '../names.js';
import type { PendingPlace, PlaceRole, TransitionInfo } from '../types.js';

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

/** A {@link TransitionInfo} member without the fields the gadget fills in itself (distributive over the union). */
export type TransitionBody = TransitionInfo extends infer T ? (T extends TransitionInfo ? Omit<T, 'name' | 'node'> : never) : never;

export interface PortDecl {
  readonly name: string;
  readonly local: Place<unknown>;
  readonly direction: PortDirection;
}

/** One gadget's builder state and the recorders that fill it. */
export interface GadgetBuilder {
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
  /** Adds a built transition to the body and records its descriptor; returns its flat-net name. */
  readonly emit: (t: Transition, info: TransitionBody) => string;
}

/** An empty builder for node `name` under instance prefix `id`, with the recorders closed over it. */
export function createGadgetBuilder(id: string, name: string): GadgetBuilder {
  const portDecls: PortDecl[] = [];
  const ports = new Map<string, Place<unknown>>();
  const pending: PendingPlace[] = [];
  const transitions: TransitionInfo[] = [];

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
  const hostOwned = (finalName: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): void => {
    pending.push({ name: finalName, role, node: name, port: portIndex, ...extra });
  };
  const internal = (local: string, role: PlaceRole, portIndex: number | null, extra?: Partial<PendingPlace>): Place<unknown> => {
    const p = place<unknown>(local);
    const finalName = qualified(id, local);
    finalNames.set(p, finalName);
    hostOwned(finalName, role, portIndex, extra);
    return p;
  };
  /** Records a transition descriptor and returns its flat-net name. */
  const tinfo = (local: string, info: TransitionBody): string => {
    const finalName = qualified(id, local);
    transitions.push({ name: finalName, node: name, ...info });
    return finalName;
  };
  const body: Transition[] = [];
  const emit = (t: Transition, info: TransitionBody): string => {
    body.push(t);
    return tinfo(t.name, info);
  };

  return {
    portDecls, ports, refPorts: [], toolPorts: [], pending, transitions, body, finalNames,
    port, internal, hostOwned, tinfo, emit,
  };
}

/** A local place named `portName`, declared as a port bound to `hostPlace` (MOD-020). */
export function boundPort(
  b: Pick<GadgetBuilder, 'port'>,
  portName: string,
  hostPlace: Place<unknown>,
  direction: PortDirection,
): Place<unknown> {
  const local = place<unknown>(portName);
  b.port(portName, local, hostPlace, direction);
  return local;
}
