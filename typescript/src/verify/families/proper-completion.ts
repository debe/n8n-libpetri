/**
 * `proper-completion` — *can this workflow strand a branch?* One whole-net check plus one per
 * join input and per edge place, and the arrival bound of every join / OR input.
 *
 * A quiescent class of the graph is a run that has come to rest; it is a **stranding** when
 * it still holds a token on a place whose `PlaceRole` means pending work (`state-class.ts`
 * `REST_ROLES`), and a *designed* terminal — a paused or halted run whose pending activations
 * the marking codec writes back (ADR 0005) — is classified against the rest set its codec mode
 * accepts rather than reported. The SMT fallback is one whole-net `deadlockFree` query
 * (VER-002) with the rest set as sinks and the pause / halt widenings as conditional sinks
 * (VER-014): `route.ts` `decideStranding`.
 *
 * The headline row is `whole-net-completion.ts`, the arrival bounds `arrival-bound.ts`, and
 * every row is recorded through `completion-row.ts`.
 */
import type { Place } from 'libpetri';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { decideStranding, type Context } from '../route.js';
import type { CheckSubject } from '../types.js';
import { recordArrivalBounds } from './arrival-bound.js';
import { recordCompletionRow } from './completion-row.js';
import { runWholeNetCompletion } from './whole-net-completion.js';

/** One join / OR input and the places its arrivals land on. */
type JoinReadyGroup = CompiledWorkflow['joinReadyPlaces'][number];

/**
 * The whole-net question — *can this workflow strand a branch anywhere?* — and the family's
 * per-input, per-edge and arrival-bound rows.
 *
 * The whole-net row is the headline and is asked first, because it is the one that covers
 * places the per-place rows do not: a token left on `X/hasdata`, on `X/routed`, on an unreaped
 * `_halt`. The per-place rows keep the granularity a finding needs — which input of which
 * node — and are decided from the same graph at no extra cost.
 */
export async function runProperCompletion(ctx: Context): Promise<void> {
  await runWholeNetCompletion(ctx);
  for (const group of ctx.compiled.joinReadyPlaces) {
    await recordArrivalBounds(ctx, group);
    for (const place of group.places) await recordJoinInputStranding(ctx, group, place);
  }
  for (const place of ctx.compiled.edgeDataPlaces) await recordEdgeStranding(ctx, place);
}

/** Whether an arrival can be left waiting on one input of a join. */
async function recordJoinInputStranding(ctx: Context, group: JoinReadyGroup, place: Place<unknown>): Promise<void> {
  const where = `${group.node}'s input ${group.inputIndex}`;
  const decision = await decideStranding(ctx, place);
  const subject: CheckSubject = { kind: 'join-input', node: group.node, inputIndex: group.inputIndex, place: place.name };
  recordCompletionRow(ctx, `${group.node} input ${group.inputIndex} always completes`, subject, decision, {
    proven: `No reachable quiescent marking leaves an arrival waiting on ${where}.`,
    violated: `${group.node} can be left with an arrival stranded on input ${group.inputIndex}: the run ` +
      'quiesces with that token still waiting, which is what n8n discovers at runtime as a stuck Merge.',
    unknown: `Whether an arrival can strand on ${where} was not decided.`,
  });
}

/** Whether a payload can be left undelivered on one edge place. */
async function recordEdgeStranding(ctx: Context, place: Place<unknown>): Promise<void> {
  const info = ctx.map.place(place.name);
  const consumer = info?.node ?? '(unknown)';
  const edge = info?.edge;
  const subject: CheckSubject = {
    kind: 'edge',
    node: consumer,
    place: place.name,
    ...(edge === undefined ? {} : { from: edge.from, outputIndex: edge.outputIndex, inputIndex: edge.inputIndex }),
  };
  const where = edge === undefined
    ? `${consumer}'s input`
    : `the edge ${edge.from}.${edge.outputIndex} -> ${edge.to}.${edge.inputIndex}`;
  const decision = await decideStranding(ctx, place);
  recordCompletionRow(ctx, `${where} is always consumed`, subject, decision, {
    proven: `No reachable quiescent marking leaves a payload on ${where}.`,
    violated: `A payload can be left undelivered on ${where}: ${consumer} never consumes it and the run quiesces.`,
    unknown: `Whether a payload can be left on ${where} was not decided.`,
  });
}
