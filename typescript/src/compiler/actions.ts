/**
 * Structural action binders. Every transition that declares an `Out` spec must carry an
 * action that produces it (CORE-043), so `compile()` binds a placeholder per role that
 * selects exactly one branch of every `xor` by the places it writes (IO-015). M2's
 * scheduler layers its real actions over these with `CompiledWorkflow.withActions()` (or
 * `CompileOptions.actions`); a binder returning `null` for a role keeps the placeholder.
 *
 * Routing is a policy per (node, connected output):
 * - `placeholderActions()` — every output takes the no-data alternative (`empty` / `nil`),
 *   so any net, cyclic ones included, quiesces (EXEC-040). The default.
 * - `forwardAllActions()` — every edge receives the consumed value as `data`. Runs an
 *   acyclic workflow end to end; a cycle never terminates under it.
 * - `routingActions(policy)` — the policy decides per output (an IF routing one way).
 *
 * All of them take the success outcome in `X_run` and `X_exhausted` — which, unless the node
 * routes per output ({@link SPLIT_ROUTING_ABOVE}), is where the routing itself happens: the
 * placeholders never halt and never retry, so the net's only decisions are the structural ones. The
 * `start-unmet` twin tags the running token with an {@link UnmetReferencePayload}, as M2's
 * action will.
 *
 * Places are addressed through the canonical objects of the flat net (`NetMap`); the
 * context resolves them by name (CORE-002), so no MOD-031 alias is involved.
 */
import { assertNever } from '../internal/assert.js';
import { dispatchAction, doneRequestAction, reenterAction, roundsOutAction } from './actions/agent-round.js';
import { attemptAction, deadlineAction, retryWaitAction } from './actions/failure.js';
import { armAction, skipAction } from './actions/input-side.js';
import { doneAction, exhaustedAction, routeAction, runAction } from './actions/outcome.js';
import type { RoutingPolicy } from './actions/routing.js';
import { startAction, startUnmetAction } from './actions/start.js';
import type { ActionBinder } from './types.js';

export type { RoutingMode, RoutingPolicy } from './actions/routing.js';

/** Binds a structural action for every role that declares an `Out` spec; sinks and `clear` keep passthrough. */
export function structuralActions(policy: RoutingPolicy): ActionBinder {
  return (info, map) => {
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g);
      case 'start-unmet': return startUnmetAction(g, info);
      case 'run': return runAction(g, policy, map);
      case 'route': return routeAction(g, info, policy);
      case 'done': return doneAction(g, map);
      case 'exhausted': return exhaustedAction(g, policy, map);
      case 'skip': return skipAction(g);
      case 'arm': return armAction(g, info);
      case 'retry': return retryWaitAction(g);
      case 'attempt': return attemptAction(g, info, policy, map);
      case 'deadline': return deadlineAction(g, info);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'rounds-out': return roundsOutAction(g, map);
      // `A_resume` and `A_calls_out` both re-enter `X_run` off `A/dispatched`.
      case 'resume':
      case 'calls-out': return reenterAction(g);
      // `sink`, `clear` and `collect` close a round or drain a `nil` and produce nothing:
      // genuine sinks (CORE-043 AC4), so they keep libpetri's passthrough rather than a
      // placeholder that would have to invent an output.
      case 'sink':
      case 'clear':
      case 'collect': return null;
      default: return assertNever(info, 'transition role');
    }
  };
}

/** `structuralActions` with a per-output policy. */
export function routingActions(policy: RoutingPolicy): ActionBinder {
  return structuralActions(policy);
}

export function placeholderActions(): ActionBinder {
  return structuralActions(() => 'no-data');
}

export function forwardAllActions(): ActionBinder {
  return structuralActions(() => 'data');
}
