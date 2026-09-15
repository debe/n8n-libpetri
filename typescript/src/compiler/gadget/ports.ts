/**
 * The places that cross a node boundary as ports (MOD-020): the shared `_budget` / `_halt` /
 * `_pause`, the node's own markers (`done` exposed for `$('Y')` read arcs, CORE-032), the
 * reference read ports, the agent ↔ tool write ports, and the `SubnetDef` (MOD-001) that
 * declares them all.
 */
import { SubnetDef, place } from 'libpetri';
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { PLACE, agentResponsePortOf, refDonePortOf, refSkippedPortOf, toolInPortOf } from '../names.js';
import type { GadgetContext } from './context.js';

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

/** The read ports of the node's guarded `$('Y')` references, reference order. */
export interface ReferencePorts {
  readonly refDone: readonly Place<unknown>[];
  /** Per reference: the referenced node and the local `Y/skipped` read port its twin uses. */
  readonly refSkipped: ReadonlyArray<{ readonly node: string; readonly skipped: Place<unknown> }>;
  readonly referenceNames: readonly string[];
  readonly unguardedReferences: readonly string[];
}

/** The agent's write ports into its tools' `in_tool`, and the tool's into its agents' `response`. */
export interface ToolWritePorts {
  readonly toolInPorts: readonly Place<unknown>[];
  readonly agentResponsePorts: readonly Place<unknown>[];
}

/** `_budget`, `_halt` and `_pause` as `inout` ports bound to the host's shared places. */
export function declareSharedPorts(ctx: GadgetContext): SharedPorts {
  const { port, host } = ctx;

  // ---- shared places as ports ----
  const budget = place<unknown>(PLACE.budget);
  port(PLACE.budget, budget, host.budget, 'inout');
  const halt = place<unknown>(PLACE.halt);
  port(PLACE.halt, halt, host.halt, 'inout');
  const pause = place<unknown>(PLACE.pause);
  port(PLACE.pause, pause, host.pause, 'inout');
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

/** One `Y/done` and one `Y/skipped` read port per guarded reference; unguarded ones get none. */
export function declareReferencePorts(ctx: GadgetContext): ReferencePorts {
  const { a, portDecls, refPorts } = ctx;

  // ---- references: read arcs on Y/done, twins on Y/skipped ----
  const refDone: Place<unknown>[] = [];
  /** Per reference: the referenced node and the local `Y/skipped` read port its twin uses. */
  const refSkipped: Array<{ readonly node: string; readonly skipped: Place<unknown> }> = [];
  const referenceNames: string[] = [];
  const unguardedReferences: string[] = [];
  for (const ref of a.references) {
    if (ref.kind === 'unguarded') {
      unguardedReferences.push(ref.node);
      continue;
    }
    const k = referenceNames.length;
    referenceNames.push(ref.node);
    const donePort = refDonePortOf(k);
    const doneLocal = place<unknown>(donePort);
    refDone.push(doneLocal);
    portDecls.push({ name: donePort, local: doneLocal, direction: 'input' });
    refPorts.push({ port: donePort, node: ref.node, marker: 'done' });
    const skippedPort = refSkippedPortOf(k);
    const skippedLocal = place<unknown>(skippedPort);
    refSkipped.push({ node: ref.node, skipped: skippedLocal });
    portDecls.push({ name: skippedPort, local: skippedLocal, direction: 'input' });
    refPorts.push({ port: skippedPort, node: ref.node, marker: 'skipped' });
  }
  return { refDone, refSkipped, referenceNames, unguardedReferences };
}

/** The cross-node write ports of agent tool dispatch, bound in `compile()`. */
export function declareToolPorts(ctx: GadgetContext): ToolWritePorts {
  const { tools, agents, portDecls, toolPorts } = ctx;

  // An agent's write port into each of its tools' `in_tool`, and a tool's write port into each
  // of its agents' `response`. Both are cross-node, so both are bound in `compile()`.
  const toolInPorts = (tools ?? []).map((toolName, k) => {
    const toolPort = toolInPortOf(k);
    const local = place<unknown>(toolPort);
    portDecls.push({ name: toolPort, local, direction: 'output' });
    toolPorts.push({ port: toolPort, node: toolName, marker: 'in_tool' });
    return local;
  });
  const agentResponsePorts = (agents ?? []).map((agentName, k) => {
    const responsePort = agentResponsePortOf(k);
    const local = place<unknown>(responsePort);
    portDecls.push({ name: responsePort, local, direction: 'output' });
    toolPorts.push({ port: responsePort, node: agentName, marker: 'response' });
    return local;
  });
  return { toolInPorts, agentResponsePorts };
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
  const def = defBuilder.build();
  return def;
}
