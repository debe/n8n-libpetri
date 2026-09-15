/**
 * The output side of the gadget (README "Per-node gadget", ADR 0002 / 0004): the edge ports and
 * `nil` places of each connected output, the collapsed or split routing, the outcome branches,
 * `X_run` per attempt, `X_route_o`, `X_done` and the `nil` sinks.
 */
import { Transition, and, forwardInput, one, outPlace, place, timeout, xor } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { PLACE, TRANSITION, attemptRunOf, edgeOutPortOf, emptyTwinOf, nilOf, okOf, qualified, routedOf, routeOf, sinkOf } from '../names.js';
import {
  andOf, xorOf, type GadgetContext, type LocalAgent, type LocalAttempt, type LocalCollapsedOutput, type LocalEdge,
  type LocalInputSide, type LocalOutput, type LocalRetry, type LocalRouting, type LocalSplitOutput,
} from './context.js';
import type { Markers, SharedPorts } from './ports.js';

/**
 * Nodes with **more** connected outputs than this keep the routing on a transition of its
 * own per output — `X_run` writes `X/ok_o`, `X_route_o` deposits the edge tokens and marks
 * `X/routed_o` — instead of routing inside `X_run`'s own `Out` spec. Nodes at or below it
 * route in `X_run` and have a single `X/routed`.
 *
 * **Three**, and it is an IO-016 flattening threshold. The SMT and SCG flatteners expand an
 * `and` of `k` `xor`s into `2^k` virtual transitions, so the outcome costs `2^k + 4` flat
 * branches routed inside `X_run` (the four non-success outcomes on top) against `2k + 5`
 * split across `X_run` and its `X_route_o`s. Neither figure counts `X_done`, which both
 * shapes have. Measured with `enumerateBranches`
 * (`tests/spikes/collapsed-outcome.test.ts`):
 *
 * | connected outputs | routed in `X_run` | split per output |
 * |---|---|---|
 * | 1 | **6** | 7 |
 * | 2 | **8** | 9 |
 * | 3 | 12 | **11** |
 * | 4 | 20 | **13** |
 * | 6 | 68 | **17** |
 * | 10 | 1028 | **25** |
 * | 20 | *`enumerateBranches` overflows the stack* | **45** |
 *
 * Three is where it stops being a rout and becomes a trade: the split is one branch cheaper
 * there, while the collapse removes five places and three transitions and **21 % of the
 * state classes** (a three-output fan-out is 47 places / 20 transitions / 381 classes
 * collapsed against 52 / 23 / 482 split — `tests/compiler/routing.test.ts`). From four
 * outputs the branch count runs away and the split wins outright, so the threshold is 3 —
 * the same value the pre-M4 gadget used, for the same underlying reason.
 *
 * **What M4 changed is not this threshold; it is `X_done`,** and `X_done` is now
 * unconditional. The executor collects its ready set from the enablement flags **before**
 * the firing pass and only `updateDirtyTransitions()` sets them, so a transition another
 * firing enables during that pass can fire no earlier than the next cycle
 * (`precompiled-net-executor.ts` `fireReadyGeneral`). A join / OR consumer needs one such
 * extra cycle for its `arm`, while a direct consumer does not — so a firing that deposited
 * the edge tokens *and* refunded `_budget` let the shallower budget-blocked sibling become
 * evaluable a full cycle before the deeper armed consumer, and the net ran breadth-first
 * exactly where priority = DAG depth was meant to give n8n's depth-first order
 * (divergence #20). Refunding on `X_done` — one cycle after the edge tokens land, which is
 * the cycle the `arm` fires in — puts both candidate `X_start`s in the same ready set,
 * where priority decides. Measured: n8n's own `v1 execution order > should execute nodes in
 * the correct order, depth-first & the most top-left one first` passes with it and fails
 * without it (`docs/conformance-final.md`).
 *
 * That phase is preserved by both shapes here, because both mark `X/routed(_o)` in the
 * firing that deposits the edge tokens and refund `_budget` from `X_done` in the next.
 * Collapsing the routing into `X_run` therefore moves the *whole* chain one cycle earlier
 * without changing any relative phase.
 */
export const SPLIT_ROUTING_ABOVE = 3;

/** The connected outputs over local places and how they are routed. */
export interface OutputSide {
  readonly routing: LocalRouting;
  readonly outputs: readonly LocalOutput[];
  /** The empty of every outgoing tree edge this node writes on a skip. */
  readonly skipEmpties: readonly Out[];
}

/** The outcome alternatives an `X_run`, `X_exhausted` or terminal step chooses among. */
export interface OutcomeBranches {
  readonly routingOf: (out: LocalOutput) => Out;
  readonly success: Out;
  readonly haltBranch: Out;
  readonly waitingBranch: Out;
  readonly stoppedBranch: Out;
}

/** Declares every connected output's edge ports and `nil`, and the routing shape. */
export function buildOutputSide(ctx: GadgetContext, hasSkip: boolean): OutputSide {
  const { a, edgeSlots, name, cyclic, outgoing, port, internal } = ctx;

  // ---- output side ----
  // The empty place of an outgoing tree edge is written by X_route (acyclic producer) or by
  // X_skip (any producer); a cyclic producer without a skip never writes it and declares no
  // port for it (the consumer still owns the place; its skip is simply unreachable).
  const collapsedOutputs: LocalCollapsedOutput[] = [];
  const splitOutputs: LocalSplitOutput[] = [];
  const connectedOutputs = new Set(outgoing.map((e) => e.outputIndex)).size;
  const split = connectedOutputs > SPLIT_ROUTING_ABOVE;
  for (let o = 0; o < a.outputCount; o++) {
    const edges: LocalEdge[] = [];
    for (const e of outgoing) {
      if (e.outputIndex !== o) continue;
      const slot = edgeSlots.get(e.id);
      if (slot === undefined) throw new InternalCompilerError(`internal: node '${name}' has no host slot for edge ${e.id}`);
      const dataPort = edgeOutPortOf(e.id);
      const data = place<unknown>(dataPort);
      port(dataPort, data, slot.data, 'output');
      let empty: Place<unknown> | null = null;
      if (slot.empty !== null && (!cyclic || hasSkip)) {
        const emptyPort = emptyTwinOf(dataPort);
        empty = place<unknown>(emptyPort);
        port(emptyPort, empty, slot.empty, 'output');
      }
      edges.push({ edge: e, data, empty, host: slot });
    }
    if (edges.length === 0) continue; // unconnected outputs get no places
    const nil = cyclic ? internal(nilOf(o), 'nil', o) : null;
    if (split) {
      splitOutputs.push({ index: o, edges, nil, routing: 'split', ok: internal(okOf(o), 'ok', o), routed: internal(routedOf(o), 'routed', o) });
    } else {
      collapsedOutputs.push({ index: o, edges, nil, routing: 'collapsed' });
    }
  }
  // `X/routed`: the single "the outcome has been delivered" marker of a node that routes
  // inside `X_run`. A split node has one per output instead (`outputs[*].routed`).
  const routing: LocalRouting = split
    ? { kind: 'split', outputs: splitOutputs }
    : { kind: 'collapsed', routed: internal(PLACE.routed, 'routed', null), outputs: collapsedOutputs };
  const outputs: readonly LocalOutput[] = routing.outputs;
  const skipEmpties: Out[] = [];
  for (const out of outputs) for (const e of out.edges) if (e.empty !== null) skipEmpties.push(outPlace(e.empty));
  return { routing, outputs, skipEmpties };
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
  const { name } = ctx;
  const { budget, halt, pause } = shared;
  const { waiting, stopped } = markers;

  // ---- Out spec builders ----
  const routingOf = (out: LocalOutput): Out => xor(
    andOf(out.edges.map((e) => outPlace(e.data))),
    // An acyclic producer's edges are all tree edges, so each has its empty place: a cycle
    // edge would put both ends in one SCC and give the producer `nil` instead.
    out.nil !== null ? outPlace(out.nil) : andOf(out.edges.map((e) => outPlace(e.empty!))),
  );
  // The success branch. Collapsed: the per-output routing plus `X/routed`, which `X_done`
  // consumes one cycle later — an inner `xor` left unwritten on a sibling branch of the
  // enclosing `xor` is fine, IO-015 searches for an exact explanation
  // (`tests/spikes/out-spec.test.ts`, `tests/spikes/collapsed-outcome.test.ts`). Split: one
  // `X/ok_o` per output, each routed by its own `X_route_o`.
  // A tool's output is not a main edge: it is its agent's `A/response`. Several agents can
  // share one tool, so the branch is an `xor` over them and the action picks the agent the
  // dispatch token names. `X/routed` still marks the outcome for `X_done` to refund the budget
  // one cycle later, so the phase and the P-semiflow are the ordinary ones (ADR 0004).
  const success: Out = (() => {
    if (side.form === 'tool') {
      if (routing.kind === 'split') throw new InternalCompilerError(`internal: tool '${name}' routes per output`);
      return and(xorOf(agentResponsePorts.map((r) => outPlace(r))), outPlace(routing.routed));
    }
    return routing.kind === 'split'
      ? andOf(routing.outputs.map((o) => outPlace(o.ok)))
      : andOf([...routing.outputs.map(routingOf), outPlace(routing.routed)]);
  })();
  const haltBranch = and(outPlace(halt), outPlace(budget));
  // The two pause outcomes: the budget is refunded here since nothing routes afterwards.
  const waitingBranch = and(outPlace(waiting), outPlace(pause), outPlace(budget));
  const stoppedBranch = and(outPlace(stopped), outPlace(pause), outPlace(budget));
  return { routingOf, success, haltBranch, waitingBranch, stoppedBranch };
}

/** `X_run`, or one `X_run_i` per attempt of an `onFailure` chain. */
export function buildRun(
  ctx: GadgetContext,
  markers: Markers,
  branches: OutcomeBranches,
  retry: LocalRetry | null,
  chain: { readonly attempts: readonly LocalAttempt[]; readonly chainTimeoutMs: number | null },
  agent: LocalAgent | null,
): { readonly runName: string; readonly attemptRunNames: readonly string[] } {
  const { id, depth, body, tinfo, stopWorkflow } = ctx;
  const { idle, running } = markers;
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;
  const { attempts, chainTimeoutMs } = chain;

  // ---- X_run: the outcome ----
  // An agent has one more: the node returned an `EngineRequest` instead of data. It is phased
  // like the success outcome — `A/routed_req` here, the budget refunded by `A_done_req` one
  // cycle later — so `_budget + Σ(running + retry + routed) = k` still holds with `routed_req`
  // counted among the in-flight markers.
  const requestBranch = agent === null ? [] : [outPlace(agent.routedRequest)];
  /**
   * The outcome of one attempt. Without a policy this is the historical shape and `failure` is
   * `null`; with one, the retry alternative is that attempt's own `X/failed_i` — a chain
   * position rather than a counter decrement.
   */
  const outcomeOf = (failure: Place<unknown> | null): Out => xorOf([
    success,
    ...(failure !== null ? [outPlace(failure)] : retry !== null ? [outPlace(retry.retry)] : []),
    ...(stopWorkflow ? [haltBranch] : []),
    waitingBranch,
    stoppedBranch,
    ...requestBranch,
  ]);

  const attemptRunNames: string[] = [];
  const runName = qualified(id, TRANSITION.run);
  if (attempts.length === 0) {
    body.push(Transition.builder(TRANSITION.run)
      .inputs(one(running))
      .outputs(and(outcomeOf(null), outPlace(idle)))
      .priority(depth + 1).build());
    tinfo(TRANSITION.run, { role: 'run', attempt: 1 });
  } else {
    for (const att of attempts) {
      // Attempt 1 keeps the name `run`, so every consumer that addresses a node's run
      // transition by name — the scheduler's binder, `NetMap`, the differ — is unchanged.
      const local = attemptRunOf(att.index);
      const normal = and(outcomeOf(att.failed), outPlace(idle));
      // IO-013's timeout child is an `Xor` sibling of the normal spec, and IO-015 needs
      // exactly one assignment to explain a write. It therefore has to claim a place the
      // normal branches do not, or every failing firing would be ambiguous — hence the
      // separate `timedout_i`, funnelled into `failed_i` below.
      body.push(Transition.builder(local)
        .inputs(one(att.running))
        .outputs(att.timedOut === null || chainTimeoutMs === null
          ? normal
          // `forwardInput`, not `outPlace`: IO-013 AC3 gives the timeout child *sentinel*
          // tokens, so a plain output would land a `null` on `timedout_i` and the step would
          // have no `executionData` to act on. IO-014 forwards the very token the firing
          // consumed from `X/running_i` — the run payload — which is what "this enables retry
          // patterns without losing tokens" means.
          : xor(normal, timeout(chainTimeoutMs,
              and(forwardInput(att.running, att.timedOut), outPlace(idle)))))
        .priority(depth + 1).build());
      attemptRunNames.push(tinfo(local, { role: 'run', attempt: att.index }));
    }
  }
  return { runName, attemptRunNames };
}

/** `X_route_o` per connected output under the split shape, and `X_done`. */
export function buildRouteAndDone(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  routing: LocalRouting,
  routingOf: (out: LocalOutput) => Out,
): { readonly routeNames: readonly string[]; readonly doneName: string } {
  const { depth, body, tinfo } = ctx;
  const { budget } = shared;
  const { done } = markers;

  // ---- X_route_o (split shape only) and X_done: the budget refund, one cycle later ----
  const routeNames: string[] = [];
  if (routing.kind === 'split') {
    for (const out of routing.outputs) {
      const local = routeOf(out.index);
      body.push(Transition.builder(local)
        .inputs(one(out.ok))
        .outputs(and(routingOf(out), outPlace(out.routed)))
        .priority(depth + 1).build());
      routeNames.push(tinfo(local, { role: 'route', port: out.index }));
    }
  }
  body.push(Transition.builder(TRANSITION.done)
    .inputs(...(routing.kind === 'split' ? routing.outputs.map((o) => one(o.routed)) : [one(routing.routed)]))
    .outputs(and(outPlace(budget), outPlace(done)))
    .priority(depth + 1).build());
  const doneName = tinfo(TRANSITION.done, { role: 'done' });
  return { routeNames, doneName };
}

/** One sink per `nil` place. */
export function buildSinks(ctx: GadgetContext, outputs: readonly LocalOutput[]): readonly string[] {
  const { depth, body, tinfo } = ctx;

  // ---- nil sinks (CORE-043 AC4: genuine sinks carry no Out spec) ----
  const sinkNames: string[] = [];
  for (const out of outputs) {
    if (out.nil === null) continue;
    const local = sinkOf(out.index);
    body.push(Transition.builder(local).inputs(one(out.nil)).priority(depth).build());
    sinkNames.push(tinfo(local, { role: 'sink' }));
  }
  return sinkNames;
}
