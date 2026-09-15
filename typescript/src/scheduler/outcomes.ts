/**
 * Writing one attempt's outcome, and reading the token a firing consumed.
 *
 * An outcome becomes a complete list of {@link Deposit}s before anything is emitted, and
 * {@link guarded} is the one writer: whatever the body or the list throws takes the halt (or
 * stopped) branch, so a firing never loses the tokens and the budget unit it consumed
 * (EXEC-030). {@link dispatchOf} lives here rather than with the round because a tool's
 * success branch is where the dispatch it carries is spent, and keeping it here leaves the
 * round depending on this module and not the other way round.
 */
import type { Place, TransitionContext } from 'libpetri';
import type { IExecuteData, INodeExecutionData, ISourceData } from 'n8n-workflow';
import type { NetMapView, NodeGadget, ToolGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import type { ExecutionEnv } from './env.js';
import { asExecutionError, InternalSchedulerError } from './errors.js';
import type {
  EdgePayload, OkPayload, RequestPayload, ResponsePayload, RetryPayload, RunPayload, StoppedPayload, ToolDispatch,
  WaitingPayload,
} from './payloads.js';

export type Outcome =
  | { readonly kind: 'ok'; readonly nodeSuccessData: INodeExecutionData[][]; readonly runIndex: number }
  | { readonly kind: 'retry'; readonly payload: RetryPayload }
  | { readonly kind: 'halt' }
  | { readonly kind: 'waiting'; readonly executionData: IExecuteData }
  | { readonly kind: 'stopped'; readonly executionData: IExecuteData; readonly ran: boolean }
  /** The node returned an `EngineRequest`: `A_done_req` opens a tool round from this payload. */
  | { readonly kind: 'request'; readonly payload: RequestPayload };

/**
 * The dispatch a tool's run payload carries: the agent whose `A/response` its success branch
 * writes, and the round it belongs to. Every producer of a tool's `RunPayload` sets both — the
 * dispatch token at `T_start`, and every retry, step, deadline and re-entry after it — so a
 * payload without them is an invariant of this file broken, not a workflow condition.
 */
export function dispatchOf(g: ToolGadget, run: RunPayload | undefined): ToolDispatch {
  if (run?.agent === undefined || run.roundId === undefined) {
    throw new InternalSchedulerError(`internal: tool '${g.node}' ran without the agent that dispatched it; its run payload carries no dispatch`);
  }
  if (!g.agents.includes(run.agent)) {
    throw new InternalSchedulerError(`internal: tool '${g.node}' has no ai_tool connection to '${run.agent}'`);
  }
  return { agent: run.agent, roundId: run.roundId };
}

/**
 * One token a firing deposits. An outcome is turned into a complete list of these *before*
 * anything is emitted, so the writer is a pure function of the outcome and the gadget: a list
 * that cannot be computed leaves the marking untouched and takes the fallback branch instead,
 * where a throw mid-way through a sequence of `ctx.output` calls would reject the transition
 * after the firing consumed its tokens and its budget unit (EXEC-030).
 */
interface Deposit {
  readonly place: Place<unknown>;
  readonly value: unknown;
}

/**
 * The success outcome. Unless the node routes per output ({@link SPLIT_ROUTING_ABOVE}),
 * `X_run` carries the routing in its own `Out` spec, so the edge tokens are deposited here
 * and `X/routed` marks the outcome for `X_done` to refund the budget one cycle later
 * (ADR 0004). A split node writes one `X/ok_o` per output for its `X_route_o` instead.
 */
function succeed(g: NodeGadget, value: OkPayload, map: NetMapView, run?: RunPayload): Deposit[] {
  if (g.form === 'tool') {
    // A tool's output goes to the agent that dispatched it, not to a main edge. The `xor` over
    // the agents is resolved by the dispatch the run payload carries, which the dispatch token
    // named when `T_start` fired and every attempt since has kept. The place is the agent's own
    // `A/response`: composition funnelled this tool's `resp_k` port onto it, so addressing it
    // through the map is addressing the same place (CORE-002).
    const dispatch = dispatchOf(g, run);
    const agent = map.node(dispatch.agent).agent;
    if (agent === null) {
      throw new InternalSchedulerError(`internal: '${dispatch.agent}' is wired as an agent of '${g.node}' but compiled without an agent side`);
    }
    if (g.routing.kind === 'split') throw new InternalSchedulerError(`internal: tool '${g.node}' routes per output`);
    const payload: ResponsePayload = { kind: 'response', tool: g.node, roundId: dispatch.roundId };
    return [{ place: agent.response, value: payload }, { place: g.routing.routed, value: null }];
  }
  if (g.routing.kind === 'split') return g.routing.outputs.map((out) => ({ place: out.ok, value }));
  return [...g.routing.outputs.flatMap((out) => routeOutput(g, out, value)), { place: g.routing.routed, value: null }];
}

/** Whether `X_run` was compiled with a halt branch (`compiler/gadget.ts`: `stopWorkflow`, or any `onFailure` chain). */
function hasHaltBranch(g: NodeGadget): boolean {
  return g.onError === 'stopWorkflow' || g.attempts.length > 0;
}

/** The tokens `outcome` deposits on `g`'s branch for it; throws only on an invariant of the compiled net broken. */
function deposits(g: NodeGadget, map: NetMapView, outcome: Outcome, run?: RunPayload): Deposit[] {
  const shared = map.shared;
  switch (outcome.kind) {
    case 'ok':
      return succeed(g, { kind: 'ok', nodeSuccessData: outcome.nodeSuccessData, runIndex: outcome.runIndex }, map, run);
    case 'retry': {
      // With a chain the failure is a *position*, not a counter decrement: it goes to the
      // place belonging to the attempt that just failed, which `run.attempt` names (0-based,
      // as `X_start` seeds it). Without one it is n8n's single `X/retry`.
      if (g.attempts.length > 0) {
        const failing = g.attempts[run?.attempt ?? 0];
        if (failing === undefined) {
          throw new InternalSchedulerError(`internal: node '${g.node}' has no attempt ${run?.attempt ?? 0} in its onFailure chain`);
        }
        return [{ place: failing.failed, value: outcome.payload }];
      }
      if (g.retry === null) throw new InternalSchedulerError(`internal: node '${g.node}' produced a retry outcome without a retry gadget or an onFailure chain`);
      return [{ place: g.retry.retry, value: outcome.payload }];
    }
    case 'halt':
      // Unreachable for a gadget without the branch: {@link admissible} has already mapped it.
      if (!hasHaltBranch(g)) throw new InternalSchedulerError(`internal: node '${g.node}' (onError ${g.onError}) has no halt branch`);
      return [{ place: shared.halt, value: null }, { place: shared.budget, value: null }];
    case 'waiting': {
      const v: WaitingPayload = { kind: 'waiting', executionData: outcome.executionData };
      return [{ place: g.waiting, value: v }, { place: shared.pause, value: null }, { place: shared.budget, value: null }];
    }
    case 'stopped': {
      const v: StoppedPayload = { kind: 'stopped', executionData: outcome.executionData, ran: outcome.ran };
      return [{ place: g.stopped, value: v }, { place: shared.pause, value: null }, { place: shared.budget, value: null }];
    }
    case 'request':
      // Phased like the success outcome: the marker here, the budget refunded by `A_done_req`
      // one cycle later (ADR 0004), so the agent releases its slot for the tools it asked for.
      if (g.agent === null) throw new InternalSchedulerError(`internal: node '${g.node}' produced a request outcome but is not an agent`);
      return [{ place: g.agent.routedRequest, value: outcome.payload }];
    default: return assertNever(outcome, 'outcome');
  }
}

/**
 * The branch `X_run` was compiled with for `outcome`. A `halt` on a gadget without a halt
 * branch — the host stopped the execution on a node whose `onError` continues, which n8n's own
 * handler never does — becomes the stopped branch with `ran: true`: the task data is already
 * recorded, the halt error is already the contract value, and it is the one branch that is
 * always writable. Nothing is re-queued: the marking write-back owns `nodeExecutionStack`, so an
 * entry the host pushed itself does not survive it. Only a host other than n8n's reaches this.
 */
function admissible(env: ExecutionEnv, g: NodeGadget, executionData: IExecuteData, outcome: Outcome): Outcome {
  if (outcome.kind !== 'halt' || hasHaltBranch(g)) return outcome;
  env.diagnostic(
    `node '${g.node}' (onError ${g.onError}): the host stopped the execution, but X_run has no halt branch for ` +
    'a node whose policy continues; the stopped branch stands in and nothing is re-queued');
  return { kind: 'stopped', executionData, ran: true };
}

/**
 * Runs `body` and writes its outcome; anything it throws (the mirrored loop would have
 * rejected `run()`) becomes the contract's halt error and the execution's fatal error, and takes
 * the halt branch — `stopped` (with `ran: true`, so nothing is re-queued) when the gadget
 * has no halt alternative — so the net quiesces and the token is never lost.
 *
 * The same holds for the outcome's *deposits*: they are computed in full before the first
 * `ctx.output`, and a list that cannot be computed is the same fatal, written the same way.
 * Both fallback branches are always writable, so the emission itself cannot fail.
 */
export async function guarded(
  ctx: TransitionContext,
  env: ExecutionEnv,
  g: NodeGadget,
  map: NetMapView,
  executionData: IExecuteData,
  body: () => Promise<Outcome>,
  run?: RunPayload,
): Promise<void> {
  const fallback = (error: unknown): Outcome => {
    env.state.fatal ??= error;
    const fatal = asExecutionError(error);
    // It ends the execution, so it is a halt error: write-once, never cleared by a sibling.
    env.state.haltError ??= fatal;
    env.diagnostic(`node '${g.node}': fatal error outside n8n's node try (run() rejects after quiescence): ${fatal.message}`);
    return hasHaltBranch(g) ? { kind: 'halt' } : { kind: 'stopped', executionData, ran: true };
  };
  let outcome: Outcome;
  try {
    outcome = admissible(env, g, executionData, await body());
  } catch (error) {
    outcome = fallback(error);
  }
  let list: readonly Deposit[];
  try {
    list = deposits(g, map, outcome, run);
  } catch (error) {
    list = deposits(g, map, fallback(error), run);
  }
  // The halt token this writes is the run's terminal marker: nothing consumes it, nothing
  // clears the pending activations, and the quiescent marking still holds every one of them
  // where the codec reads it (`compiler/compile.ts`, ADR 0004). No snapshot is taken here —
  // one taken at this point could not see what a sibling resolving in the same executor
  // cycle deposits, since `X_run` routes its own outcome and those arrivals reach the
  // marking in the same phase-1 batch as `_halt` itself.
  for (const d of list) ctx.output(d.place, d.value);
}

/** Lines 272–331 per connected output: the v1 gate `nodeSuccessData[o].length !== 0`. */
export function routeOutput(g: NodeGadget, out: NodeGadget['outputs'][number], value: OkPayload): Deposit[] {
  const items = value.nodeSuccessData[out.index];
  if (items !== undefined && items !== null && items.length !== 0) {
    const source: ISourceData = { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: value.runIndex };
    const payload: EdgePayload = { kind: 'edge', items, source };
    return out.edges.map((e) => ({ place: e.data, value: payload }));
  }
  if (out.nil !== null) return [{ place: out.nil, value: null }];
  return out.edges.map((e) => {
    // An acyclic producer's edges are all tree edges, each with its empty place (`compiler/gadget.ts`).
    if (e.empty === null) throw new InternalSchedulerError(`internal: node '${g.node}' output ${out.index} has a cycle edge but no nil place`);
    return { place: e.empty, value: null };
  });
}

/**
 * A token a transition consumed that is not the payload the gadget puts on that place. The
 * compiler builds every place for one payload and the actions in this file are its only
 * writers, so this is an invariant of the compiled net broken, never an n8n condition: it
 * names the transition and the place so the gadget that wired them can be found.
 */
export class UnexpectedTokenError extends InternalSchedulerError {
  constructor(transition: string, place: string) {
    super(`internal: '${transition}' consumed a token on '${place}' that is not the payload the place carries`);
    this.name = 'UnexpectedTokenError';
  }
}

/** The token `ctx` consumed from `place`, narrowed by `guard`; anything else is an {@link UnexpectedTokenError}. */
export function take<T>(ctx: TransitionContext, place: Place<unknown>, guard: (v: unknown) => v is T): T {
  const v = ctx.input(place);
  if (!guard(v)) throw new UnexpectedTokenError(ctx.transitionName(), place.name);
  return v;
}
