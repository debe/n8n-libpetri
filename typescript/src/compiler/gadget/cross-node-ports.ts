/**
 * The ports `compile()` binds to a place another node owns (MOD-020): the read ports of the
 * node's guarded `$('Y')` references (CORE-032), and the agent ↔ tool write ports of agent
 * tool dispatch (README "Agent tool dispatch", ADR 0008).
 */
import { place } from 'libpetri';
import type { Place } from 'libpetri';
import { agentResponsePortOf, refDonePortOf, refSkippedPortOf, toolInPortOf } from '../names.js';
import type { ReferencePort, ToolPort } from './builder.js';
import type { GadgetContext } from './context.js';

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

/** A local read port on `node`'s `marker`, bound by `compile`. */
function referencePort(ctx: GadgetContext, portName: string, node: string, marker: ReferencePort['marker']): Place<unknown> {
  const local = place<unknown>(portName);
  ctx.portDecls.push({ name: portName, local, direction: 'input' });
  ctx.refPorts.push({ port: portName, node, marker });
  return local;
}

/** One `Y/done` and one `Y/skipped` read port per guarded reference; unguarded ones get none. */
export function declareReferencePorts(ctx: GadgetContext): ReferencePorts {
  // ---- references: read arcs on Y/done, twins on Y/skipped ----
  const refDone: Place<unknown>[] = [];
  /** Per reference: the referenced node and the local `Y/skipped` read port its twin uses. */
  const refSkipped: Array<{ readonly node: string; readonly skipped: Place<unknown> }> = [];
  const referenceNames: string[] = [];
  const unguardedReferences: string[] = [];
  for (const ref of ctx.a.references) {
    if (ref.kind === 'unguarded') {
      unguardedReferences.push(ref.node);
      continue;
    }
    const k = referenceNames.length;
    referenceNames.push(ref.node);
    refDone.push(referencePort(ctx, refDonePortOf(k), ref.node, 'done'));
    refSkipped.push({ node: ref.node, skipped: referencePort(ctx, refSkippedPortOf(k), ref.node, 'skipped') });
  }
  return { refDone, refSkipped, referenceNames, unguardedReferences };
}

/** A local output port into `node`'s `marker` place, bound by `compile()`. */
function toolWritePort(ctx: GadgetContext, portName: string, node: string, marker: ToolPort['marker']): Place<unknown> {
  const local = place<unknown>(portName);
  ctx.portDecls.push({ name: portName, local, direction: 'output' });
  ctx.toolPorts.push({ port: portName, node, marker });
  return local;
}

/** The cross-node write ports of agent tool dispatch, bound in `compile()`. */
export function declareToolPorts(ctx: GadgetContext): ToolWritePorts {
  // An agent's write port into each of its tools' `in_tool`, and a tool's write port into each
  // of its agents' `response`. Both are cross-node, so both are bound in `compile()`.
  const toolInPorts = (ctx.tools ?? []).map((toolName, k) => toolWritePort(ctx, toolInPortOf(k), toolName, 'in_tool'));
  const agentResponsePorts = (ctx.agents ?? []).map((agentName, k) => toolWritePort(ctx, agentResponsePortOf(k), agentName, 'response'));
  return { toolInPorts, agentResponsePorts };
}
