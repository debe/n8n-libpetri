/**
 * The places that cross a node boundary as ports (MOD-020): the shared `_budget` / `_halt` /
 * `_pause`, the node's own markers (`done` exposed for `$('Y')` read arcs, CORE-032), and the
 * `SubnetDef` (MOD-001) that declares every port. The reference read ports and the agent ↔ tool
 * write ports are declared by `cross-node-ports.ts` and re-exported here.
 */
import { SubnetDef } from 'libpetri';
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { PLACE } from '../names.js';
import { boundPort } from './builder.js';
import type { GadgetContext } from './context.js';

export {
  declareReferencePorts, declareToolPorts, type ReferencePorts, type ToolWritePorts,
} from './cross-node-ports.js';

/** The shared places, as the node's local `inout` ports. */
export interface SharedPorts {
  readonly budget: Place<unknown>;
  readonly halt: Place<unknown>;
  readonly pause: Place<unknown>;
}

/** The node's own lifecycle markers. */
export interface Markers {
  readonly idle: Place<unknown>;
  readonly running: Place<unknown>;
  readonly done: Place<unknown>;
  readonly waiting: Place<unknown>;
  readonly stopped: Place<unknown>;
}

/** `_budget`, `_halt` and `_pause` as `inout` ports bound to the host's shared places. */
export function declareSharedPorts(ctx: GadgetContext): SharedPorts {
  const { host } = ctx;

  // ---- shared places as ports ----
  const budget = boundPort(ctx, PLACE.budget, host.budget, 'inout');
  const halt = boundPort(ctx, PLACE.halt, host.halt, 'inout');
  const pause = boundPort(ctx, PLACE.pause, host.pause, 'inout');
  return { budget, halt, pause };
}

/** `X/idle`, `X/running`, `X/done` (exposed), `X/waiting` and `X/stopped`. */
export function declareMarkers(ctx: GadgetContext): Markers {
  const { internal, portDecls } = ctx;

  // ---- markers ----
  const idle = internal(PLACE.idle, 'idle', null);
  const running = internal(PLACE.running, 'running', null);
  const done = internal(PLACE.done, 'done', null);
  // Exposed (unbound) so referencing nodes can bind their read port to it.
  portDecls.push({ name: PLACE.done, local: done, direction: 'output' });
  const waiting = internal(PLACE.waiting, 'waiting', null);
  const stopped = internal(PLACE.stopped, 'stopped', null);
  return { idle, running, done, waiting, stopped };
}

/** The `SubnetDef` of every transition built so far, with every declared port. */
export function buildSubnetDef(ctx: GadgetContext): SubnetDef<void> {
  const { name, body, portDecls } = ctx;

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
  return defBuilder.build();
}
