/**
 * The per-node gadget as a libpetri `SubnetDef` (MOD-001), instantiated at prefix `node.id`
 * (MOD-010) and composed by port binding (MOD-020). Implements README "Per-node gadget"
 * (ADR 0004: two-phase start/run, the outcome routed by `X_run` itself):
 *
 * ```
 * X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_pause)
 *               [read(Y/done) per $('Y')]                     → X/running        priority depth
 * X_start_unmet_k: the same without the reads, read(Y_k/skipped) → X/running (tagged) priority depth − 1
 * X_run:        one(X/running) → and( xor( and( per output o: xor( and(data edges_o),
 *                                                                 and(empty edges_o) | X/nil_o ),
 *                                               X/routed ),
 *                                          [X/retry], [and(_halt, _budget)],
 *                                          and(X/waiting, _pause, _budget), and(X/stopped, _pause, _budget) ),
 *                                     X/idle )                                    priority depth + 1
 * X_done:       one(X/routed) → and( _budget, X/done )                            priority depth + 1
 * X_skip:       one(X/in_empty) → and( empty tree edges, X/skipped )              priority depth
 * X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_pause)
 *               delayed(waitBetweenTries) → X/running                             priority depth
 * X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( <the same success branch>, [and(_halt, _budget)],
 *                                                      and(X/waiting, _pause, _budget), and(X/stopped, _pause, _budget) )
 *                                                                                 priority depth + 1
 * sink_o:       one(X/nil_o)  (no Out spec: a genuine sink, CORE-043 AC4)
 * ```
 *
 * A node with **more than {@link SPLIT_ROUTING_ABOVE} connected outputs** keeps the routing
 * on its own transition per output, because an `and` of `k` `xor`s is `2^k` flat branches
 * (IO-016) — see {@link SPLIT_ROUTING_ABOVE} for the measurement:
 *
 * ```
 * X_run success branch: and( X/ok_o per connected output o )
 * X_route_o:    one(X/ok_o) → and( xor( and(data edges_o), and(empty edges_o) | X/nil_o ),
 *                                  X/routed_o )                                   priority depth + 1
 * X_done:       one(X/routed_0) … one(X/routed_k-1) → and( _budget, X/done )      priority depth + 1
 * ```
 *
 * The `waiting` outcome is n8n's `waitTill` (the node put the execution to wait and must
 * re-run on resume; the token carries its input `executionData`) and `stopped` is the
 * destination-node stop (outputs recorded, successors never enqueued). Both deposit the
 * shared control terminal `_pause`, which every start / start-unmet / retry-wait inhibits
 * — routes, skips, arms, clears, done and exhausted do not — so a paused net drains its
 * structural transitions and quiesces with every token on an in / ready / hasdata /
 * waiting place, where the marking codec reads it (README "Retries, halt, cancellation").
 *
 * **`X_done` is what phases the budget refund**, at both shapes. `X_run` (or `X_route_o`)
 * deposits the edge tokens and marks `X/routed`; `X_done` refunds `_budget` one scheduling
 * cycle later, which is the cycle a join / OR consumer's `arm` fires in, so the consumer's
 * `X_start` and a budget-blocked sibling's `X_start` land in one ready set and priority
 * decides (M4, divergence #20 — see {@link SPLIT_ROUTING_ABOVE}). Every node has an
 * `X_done`, including one with no connected output, whose success branch is just `X/routed`.
 * The P-semiflow is `_budget + Σ_X(X/running + X/retry + inflight_X) = k`, where `inflight_X`
 * is `X/routed` for a node that routes inside `X_run` and `X/ok_o + X/routed_o` for **one**
 * output `o` of a node above {@link SPLIT_ROUTING_ABOVE}: a split node has no single
 * `X/routed`, so the Farkas enumeration returns one such law **per output** instead of one
 * folded law, and `verify.ts` `nodeCarriesUnit` accepts any of them ("at least one", not
 * "all"). A workflow with no split node yields the single folded
 * `_budget + Σ_X(X/running + X/retry + X/routed) = k`.
 *
 * Input sides (README "Join gadget", "OR-inputs"; ADR 0003):
 * - `join`: `arm_e_data` / `arm_e_empty` per edge consuming `X/free_i`, `X/ready_i`,
 *   `X/hasdata`, `X_start` with `all(X/hasdata)` and `X_skip` with `inhibitor(X/hasdata)`,
 *   both refunding `X/free_*`;
 * - `choose-branch`: required inputs (`requiredInputs`) get `X/ready_i_data` /
 *   `X/ready_i_empty` and their data/empty combinations are enumerated; the rest keep one
 *   `X/ready_i`; a required input with no producer is dead (never written);
 * - `or`: one input with `n ≥ 2` empty-capable producers aggregates a round —
 *   `arm_data → and(ready_i, hasdata_i)`, `arm_empty → ready_i`, `X_start: one(hasdata_i)
 *   → and(running, ran_i)`, `X_skip: exactly(n, ready_i) inhibitor(hasdata_i)
 *   inhibitor(ran_i)`, `X_clear: exactly(n, ready_i) inhibitor(hasdata_i) inhibitor(_halt) all(ran_i)`, both
 *   with `read(idle)` (the round decision waits for an in-flight `X_start` to land `ran_i`).
 *   Producers inside a cycle deliver `hasdata_i` only and do not count towards `n`; their
 *   runs leave `ran_i` markers behind once the round is closed.
 *
 * Emission rule per edge kind (README, ADR 0002): a tree edge from an acyclic producer
 * carries `data | empty`; a tree edge from a producer inside a cycle carries `data | nil`
 * on run and `empty` on skip; a cycle edge carries `data | nil` on run and nothing on skip.
 *
 * Every start, retry-wait, exhausted, skip, arm and clear transition inhibits on `_halt`
 * (README "Retries, halt, cancellation"), so a halted run quiesces without a post-halt
 * cascade — with every pending activation still on the `in` / edge / `ready` / `hasdata`
 * place it was delivered to, which is where the marking codec reads it. Nothing consumes
 * `_halt`: it is the halted run's terminal marker, not a signal to be acknowledged.
 *
 * Everything that crosses a node boundary is a port: `_budget` / `_halt` / `_pause`, the
 * consumer-owned edge places (data and, for tree edges, empty), and `Y/done` / `Y/skipped`
 * for every `$('Y')` reference (read arcs, CORE-032). Places that stay inside the node keep
 * their prefixed names (MOD-012). Actions are bound after composition on the flat net
 * (CORE-042), so the body carries libpetri's default `passthrough()` until then.
 */
import type { Place, SubnetDef } from 'libpetri';
import type { AnalysedNode, EdgeSlot, NodeGadget, PendingPlace, SharedPlaces, TransitionInfo, WorkflowAnalysis } from './types.js';
import { buildAgentRound, declareAgentPlaces } from './gadget/agent-round.js';
import { createGadgetContext, type ReferencePort, type ToolPort } from './gadget/context.js';
import { buildFailureSteps, buildRetryGadget, declareFailureChain, declareRetryPlaces } from './gadget/failure-chain.js';
import { buildArms, buildClear, buildInputSide, buildSkips, buildStart, declareSkipped } from './gadget/input-side.js';
import { materialiser } from './gadget/materialise.js';
import { buildOutcomeBranches, buildOutputSide, buildRouteAndDone, buildRun, buildSinks } from './gadget/output-side.js';
import {
  buildSubnetDef, declareMarkers, declareReferencePorts, declareSharedPorts, declareToolPorts,
} from './gadget/ports.js';

export type { ReferencePort, ToolPort } from './gadget/context.js';
export { readySlot } from './gadget/input-side.js';
export { SPLIT_ROUTING_ABOVE } from './gadget/output-side.js';

export interface GadgetBuild {
  readonly def: SubnetDef<void>;
  readonly prefix: string;
  /** Original port name → host place, for `compose(instance, ports)`. Reference ports excluded. */
  readonly ports: ReadonlyMap<string, Place<unknown>>;
  readonly refPorts: readonly ReferencePort[];
  /** Ports bound to another node's `in_tool` / `response` place (agent tool dispatch). */
  readonly toolPorts: readonly ToolPort[];
  /**
   * Whether the subnet exposes a `skipped` output port (it has a skip transition). A
   * referenced node without one gets its `skipped` marker as a host-level place bound
   * straight into the referencing twins' read ports (a port must be touched by the body,
   * MOD-006), seeded by `initialMarking` when the node is unreachable.
   */
  readonly exposesSkipped: boolean;
  /** Transition descriptors in declaration order. */
  readonly transitions: readonly TransitionInfo[];
  /** Place descriptors of every place this node owns (edge places included). */
  readonly places: readonly PendingPlace[];
  /** Builds the `NodeGadget` once canonical place objects can be looked up by final name. */
  materialise(lookup: (finalName: string) => Place<unknown>): NodeGadget;
}

/**
 * Builds one node's gadget. The phases run in a fixed order because the order of declaration is
 * the order of the flat net (MOD-010, MOD-020): places and ports first, then the transitions,
 * then the `SubnetDef` and the `materialise` that reports the composed gadget.
 */
export function buildNodeGadget(
  a: AnalysedNode,
  analysis: WorkflowAnalysis,
  edgeSlots: ReadonlyMap<number, EdgeSlot>,
  syntheticIn: Place<unknown> | null,
  host: SharedPlaces,
): GadgetBuild {
  const ctx = createGadgetContext(a, analysis, edgeSlots, syntheticIn, host);

  const shared = declareSharedPorts(ctx);
  const markers = declareMarkers(ctx);
  const input = buildInputSide(ctx);
  const skip = declareSkipped(ctx, input.side);
  const out = buildOutputSide(ctx, skip.hasSkip);
  const references = declareReferencePorts(ctx);
  const retry = declareRetryPlaces(ctx);
  const chain = declareFailureChain(ctx, markers.running);
  const agent = declareAgentPlaces(ctx);
  const { toolInPorts, agentResponsePorts } = declareToolPorts(ctx);
  const branches = buildOutcomeBranches(ctx, shared, markers, input.side, out.routing, agentResponsePorts);

  const start = buildStart(ctx, shared, markers, input, references);
  const run = buildRun(ctx, markers, branches, retry, chain, agent);
  const routeAndDone = buildRouteAndDone(ctx, shared, markers, out.routing, branches.routingOf);
  const agentRound = buildAgentRound(ctx, shared, markers, agent, toolInPorts);
  const skipNames = buildSkips(ctx, shared, markers, input, skip.skipped, out.skipEmpties);
  const clearNames = buildClear(ctx, shared, markers, input.side);
  const armNames = buildArms(ctx, shared, input);
  const retryGadget = buildRetryGadget(ctx, shared, markers, branches, retry);
  const steps = buildFailureSteps(ctx, shared, markers, branches, chain.attempts);
  const sinkNames = buildSinks(ctx, out.outputs);

  const def = buildSubnetDef(ctx);
  const materialise = materialiser(ctx, {
    markers, side: input.side, skip, routing: out.routing, references, retry, chain, agent,
    names: { ...start, ...run, ...routeAndDone, ...agentRound, skipNames, clearNames, armNames, ...retryGadget, ...steps, sinkNames },
  });

  const { id, ports, refPorts, toolPorts, transitions, pending } = ctx;
  return {
    def, prefix: id, ports, refPorts, toolPorts, exposesSkipped: skip.hasSkip,
    transitions, places: pending, materialise,
  };
}
