/**
 * An `engineV2` node's three transitions (`tasks/v2-profile-plan.md` decision 3), which are the
 * settlement rules of `packages/@n8n/engine/src/execution/settlement.ts` as arcs:
 *
 * ```
 * X_start: one(e/arrived) per incoming e, all(X/live)  inhibitor(_halt)            → X/running
 * X_skip:  one(e/arrived) per incoming e  inhibitor(X/live) inhibitor(_halt)        → and(f/arrived per out-edge f, X/skipped)
 * X_run:   one(X/running) → xor( and(<routing>, X/done),  and(_halt, X/done) )
 * ```
 *
 * - rule 2 (`isLive`): an edge is live when its `arrived` came with a `live` for its consumer;
 * - rule 3 (`decideNodeFate`): a node is decidable once every incoming `arrived` is marked. With
 *   at least one `live` token it is queued (`X_start`, which takes them all), with none it is
 *   skipped (`X_skip`), and its out-edges all arrive dead. `all()` needs at least one token, so the
 *   two are never enabled together;
 * - rule 4: a skip is settled like a run, so its `arrived` tokens decide the next hop, one hop per
 *   firing, as a `step:settled` per skip does (`StepSettledHandler`).
 *
 * The trigger (decision 7) has no incoming edge: `X_start` takes its seeded synthetic `T/in`, it
 * has no `X_skip`, and its `X_run` has the success branch only, because `ExecutionStartHandler`
 * records the trigger `completed` at birth. Its outputs still route live or dead, since the
 * trigger's outputs can leave slots empty.
 *
 * A failed run (decision 8) halts the execution: `StepSettledHandler` plans nothing after a failed
 * row, nor after any row once one has failed (`hasFailedSteps`). `continueOnFail` /
 * `continueRegularOutput` is a completion inside the step executor, so it is an ordinary success
 * here; a close-function error, `EngineRequestNotSupportedError` and `UnsupportedNodeTypeError` get
 * past it and are the halt branch. `_halt` inhibits only `X_start` and `X_skip`: a run already in
 * flight still settles, as a running v2 step does.
 *
 * A loop member (decision 6) is this same gadget without the `X/done` / `X/skipped` markers: its
 * places serve every pass, and each pass consumes what it was given. Its incoming edges are all
 * `intra` (a way into the body other than the batch node is refused), so `one(e/arrived)` per
 * edge reads the same pass, which is `sourceRow`'s `intra` case. A batch node is `batch.ts`.
 *
 * Every priority is libpetri's default 0: v2 orders nothing but by these arcs.
 */
import { Transition, all, one, outPlace, xor } from 'libpetri';
import type { Out } from 'libpetri';
import { assertNever } from '../../../internal/assert.js';
import { InternalCompilerError } from '../../errors.js';
import { PLACE, TRANSITION } from '../../names.js';
import { andOf } from '../out-spec.js';
import { arrivedOf, haltOf, liveHostOf, type SettlementContext, type SettlementMarkers } from './places.js';
import { arrivalsOf, successRouting, type SettlementRouting } from './routing.js';

/** The names `X_start`, `X_skip` and `X_run` were emitted under. */
export interface SettlementNodeNames {
  readonly start: string;
  readonly skip: string | null;
  readonly run: string;
}

/** `X_start`, `X_skip` (not on the trigger) and `X_run`, in that order. */
export function buildSettlementNode(
  ctx: SettlementContext,
  markers: SettlementMarkers,
  routing: SettlementRouting,
): SettlementNodeNames {
  const { name, isTrigger, incoming, outgoing, emit } = ctx;
  const halt = haltOf(ctx);

  // ---- X_start and X_skip: rule 3 ----
  let start: string;
  let skip: string | null = null;
  if (isTrigger) {
    start = emit(Transition.builder(TRANSITION.start)
      .inputs(one(ctx.bind(ctx.host.places.triggerIn, PLACE.in, 'input')))
      .inhibitor(halt)
      .outputs(outPlace(markers.running))
      .build(), { role: 'start' });
  } else {
    const arrived = incoming.map((e) => one(arrivedOf(ctx, e, 'input')));
    const live = ctx.bind(liveHostOf(ctx, name), PLACE.live, 'input');
    start = emit(Transition.builder(TRANSITION.start)
      .inputs(...arrived, all(live))
      .inhibitor(halt)
      .outputs(outPlace(markers.running))
      .build(), { role: 'start' });
    const skipped = markers.skipped;
    if (skipped === null && ctx.loop === null) throw new InternalCompilerError(`internal: node '${name}' has no skipped marker`);
    skip = emit(Transition.builder(TRANSITION.skip)
      .inputs(...incoming.map((e) => one(arrivedOf(ctx, e, 'input'))))
      .inhibitors(live, halt)
      .outputs(andOf([...arrivalsOf(ctx, outgoing), ...(skipped === null ? [] : [outPlace(skipped)])]))
      .build(), { role: 'skip', combination: [] });
  }

  // ---- X_run: the outcome, routed (collapsed) or handed to X_route_o (split) ----
  const marker: Out[] = markers.done === null ? [] : [outPlace(markers.done)];
  const success = (): Out => andOf([...successRouting(ctx, routing), ...marker]);
  const halted = (): Out => andOf([outPlace(halt), ...marker]);
  let outcome: Out;
  switch (ctx.failure) {
    case 'never': outcome = success(); break;
    case 'possible': outcome = xor(success(), halted()); break;
    default: outcome = assertNever(ctx.failure, 'settlement failure');
  }
  const run = emit(Transition.builder(TRANSITION.run)
    .inputs(one(markers.running))
    .outputs(outcome)
    .build(), { role: 'run', attempt: 1 });
  return { start, skip, run };
}
