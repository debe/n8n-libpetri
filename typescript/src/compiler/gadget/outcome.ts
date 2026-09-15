/**
 * The outcome alternatives an `X_run`, `X_exhausted` or terminal step chooses among (README
 * "Per-node gadget", ADR 0004): the success branch — routed inside `X_run`, split per output,
 * or a tool's agent response — and the halt, waiting and stopped branches.
 */
import { and, outPlace, xor } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { GadgetContext } from './context.js';
import type { LocalInputSide, LocalOutput, LocalRouting } from './local-shapes.js';
import { andOf, xorOf } from './out-spec.js';
import type { Markers, SharedPorts } from './ports.js';

/** The outcome alternatives an `X_run`, `X_exhausted` or terminal step chooses among. */
export interface OutcomeBranches {
  readonly routingOf: (out: LocalOutput) => Out;
  readonly success: Out;
  readonly haltBranch: Out;
  readonly waitingBranch: Out;
  readonly stoppedBranch: Out;
}

/** One output's routing: all its data edges, or its empties (acyclic producer) / its `nil` (cyclic). */
function routingOf(out: LocalOutput): Out {
  return xor(
    andOf(out.edges.map((e) => outPlace(e.data))),
    // An acyclic producer's edges are all tree edges, so each has its empty place: a cycle
    // edge would put both ends in one SCC and give the producer `nil` instead.
    out.nil !== null ? outPlace(out.nil) : andOf(out.edges.map((e) => outPlace(e.empty!))),
  );
}

/**
 * The success branch. Collapsed: the per-output routing plus `X/routed`, which `X_done`
 * consumes one cycle later — an inner `xor` left unwritten on a sibling branch of the
 * enclosing `xor` is fine, IO-015 searches for an exact explanation
 * (`tests/spikes/out-spec.test.ts`, `tests/spikes/collapsed-outcome.test.ts`). Split: one
 * `X/ok_o` per output, each routed by its own `X_route_o`.
 * A tool's output is not a main edge: it is its agent's `A/response`. Several agents can
 * share one tool, so the branch is an `xor` over them and the action picks the agent the
 * dispatch token names. `X/routed` still marks the outcome for `X_done` to refund the budget
 * one cycle later, so the phase and the P-semiflow are the ordinary ones (ADR 0004).
 */
function successBranch(name: string, side: LocalInputSide, routing: LocalRouting, agentResponsePorts: readonly Place<unknown>[]): Out {
  if (side.form === 'tool') {
    if (routing.kind === 'split') throw new InternalCompilerError(`internal: tool '${name}' routes per output`);
    return and(xorOf(agentResponsePorts.map((r) => outPlace(r))), outPlace(routing.routed));
  }
  return routing.kind === 'split'
    ? andOf(routing.outputs.map((o) => outPlace(o.ok)))
    : andOf([...routing.outputs.map(routingOf), outPlace(routing.routed)]);
}

/** The success branch and the halt / waiting / stopped branches of the outcome. */
export function buildOutcomeBranches(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  side: LocalInputSide,
  routing: LocalRouting,
  agentResponsePorts: readonly Place<unknown>[],
): OutcomeBranches {
  const { budget, halt, pause } = shared;
  const { waiting, stopped } = markers;
  const success = successBranch(ctx.name, side, routing, agentResponsePorts);
  const haltBranch = and(outPlace(halt), outPlace(budget));
  // The two pause outcomes: the budget is refunded here since nothing routes afterwards.
  const waitingBranch = and(outPlace(waiting), outPlace(pause), outPlace(budget));
  const stoppedBranch = and(outPlace(stopped), outPlace(pause), outPlace(budget));
  return { routingOf, success, haltBranch, waitingBranch, stoppedBranch };
}
