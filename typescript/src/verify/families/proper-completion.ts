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
 */
import type { Place } from 'libpetri';
import { deadlockFree } from 'libpetri/verification';
import { renderMarkedPlace } from '../counterexample.js';
import { queryRecord, record, recordBound } from '../record.js';
import { completionUnknownReason, explain, smtFallbackNote } from '../reasons.js';
import {
  boundedOrUnknown, decideStranding, graphDecision, smtFallbackCompletion,
  type Context, type Decision,
} from '../route.js';
import { MAX_WITNESSES, witnessCounterexample } from '../state-class.js';
import type { CheckSubject } from '../types.js';

/**
 * The **arrival capacity** of a join / OR input: how many arrivals its gadget can hold at
 * once, and which of the two gadgets it is.
 *
 * A join / choose-branch input has one slot: every `arm` consumes `free_i` and only
 * `X_start` / `X_skip` refund it (ADR 0003), so `free_i + ready_i ≤ 1` holds **by
 * construction** and a violation would mean the compiler broke the gadget. The OR form
 * aggregates a round of `n` deliveries with no slot token at all (README "OR-inputs"), and
 * `placeBound(ready_i, n)` there is the query `docs/divergences.md` row #8 names — the form
 * where a violation is a real finding, and the one M4's SMT route could not decide.
 */
function arrivalCapacity(ctx: Context, node: string, inputIndex: number): { capacity: number; round: boolean } {
  const input = ctx.map.node(node).inputs.find((i) => i.index === inputIndex);
  return input === undefined || input.slot !== 'or'
    ? { capacity: 1, round: false }
    : { capacity: input.round, round: true };
}

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
    const { capacity, round } = arrivalCapacity(ctx, group.node, group.inputIndex);
    for (const place of group.places) {
      await recordArrivalBound(ctx, group.node, group.inputIndex, place, capacity, round);
    }
    for (const place of group.places) {
      const where = `${group.node}'s input ${group.inputIndex}`;
      const decision = await decideStranding(ctx, place);
      record(ctx, {
        property: 'proper-completion',
        name: `${group.node} input ${group.inputIndex} always completes`,
        subject: { kind: 'join-input', node: group.node, inputIndex: group.inputIndex, place: place.name },
        verdict: decision.verdict,
        explanation: explain(decision.verdict, {
          proven: `No reachable quiescent marking leaves an arrival waiting on ${where}.`,
          violated: `${group.node} can be left with an arrival stranded on input ${group.inputIndex}: the run ` +
            'quiesces with that token still waiting, which is what n8n discovers at runtime as a stuck Merge.',
          unknown: `Whether an arrival can strand on ${where} was not decided.`,
        }),
        reason: decision.reason,
        elapsedMs: decision.elapsedMs,
        query: queryRecord(deadlockFree(), decision, ctx.completion.recorded),
        counterexample: decision.counterexample,
      });
    }
  }

  for (const place of ctx.compiled.edgeDataPlaces) {
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
    record(ctx, {
      property: 'proper-completion',
      name: `${where} is always consumed`,
      subject,
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `No reachable quiescent marking leaves a payload on ${where}.`,
        violated: `A payload can be left undelivered on ${where}: ${consumer} never consumes it and the run quiesces.`,
        unknown: `Whether a payload can be left on ${where} was not decided.`,
      }),
      reason: decision.reason,
      elapsedMs: decision.elapsedMs,
      query: queryRecord(deadlockFree(), decision, ctx.completion.recorded),
      counterexample: decision.counterexample,
    });
  }
}

/** The headline check: no reachable quiescent marking leaves pending work anywhere. */
async function runWholeNetCompletion(ctx: Context): Promise<void> {
  const space = ctx.space;
  const strandings = space.usable ? space.strandings() : [];
  const decision: Decision = strandings.length > 0
    ? {
      ...graphDecision('violated', witnessCounterexample(strandings[0]!)),
      elapsedMs: space.elapsedMs,
    }
    : space.complete
      ? { ...graphDecision('proven'), elapsedMs: space.elapsedMs }
      : await (async (): Promise<Decision> => {
        const fallback = await smtFallbackCompletion(ctx);
        // `proven` and `violated` are both real verdicts about the whole net here: the
        // violated one survived the pause filter, so it is a stranding z3 found outside the
        // explored prefix and it is reported as the finding it is.
        return fallback.verdict === 'proven' || fallback.verdict === 'violated'
          ? fallback
          : boundedOrUnknown(ctx, {
            ...fallback,
            verdict: 'unknown',
            reason: completionUnknownReason(ctx, fallback),
            elapsedMs: space.elapsedMs + fallback.elapsedMs,
          }, smtFallbackNote(fallback));
      })();

  const first = strandings[0];
  // The same renderer as the finding block's stuck marking, so a stranded place reads the
  // same in this sentence and in the witness printed under it.
  const stranded = first === undefined
    ? ''
    : ` It quiesces holding ${first.stranded.map(renderMarkedPlace).join(', ')}.`;
  // The graph found none but the fallback did: the row is still `violated`, and its sentence
  // has to say where the witness came from rather than quoting a class count of zero.
  const solverFound = decision.verdict === 'violated' && strandings.length === 0;
  record(ctx, {
    property: 'proper-completion',
    name: 'no branch is ever left stranded',
    subject: { kind: 'net' },
    verdict: decision.verdict,
    explanation: explain(decision.verdict, {
      proven: decision.route === 'smt'
        ? 'The solver proved it: the whole-net deadlockFree question — rest set as sinks, pause / halt ' +
          'widenings as conditional sinks, state equation on — has an inductive invariant over every ' +
          'reachable marking, so no quiescent marking leaves work pending anywhere in the net. The graph ' +
          `had explored ${space.classes} state classes without closing.`
        : `Every one of the ${space.quiescentClasses} reachable quiescent markings of this workflow ` +
          `(${space.classes} state classes) is either a completed run holding only residue or one of the ` +
          `${space.terminalClasses} designed terminals — a paused or halted run the marking codec writes ` +
          'back. Nothing is left pending anywhere in the net.',
      violated: solverFound
        ? 'This workflow can come to rest with work still pending: the whole-net deadlockFree query ' +
          '(VER-002, rest set as sinks, pause / halt widenings as conditional sinks) returned a quiescent ' +
          'marking outside that set, and it is not one of the designed terminals the marking codec writes back.'
        : `This workflow can come to rest with work still pending: ${strandings.length}` +
          `${strandings.length >= MAX_WITNESSES ? '+' : ''} quiescent marking(s) hold a token on a place ` +
          `that is not residue.${stranded}`,
      unknown: `Whether this workflow can strand a branch was not decided: ${space.classes} state classes ` +
        'explored, none of them a stranding, and the graph is not complete.',
    }),
    reason: decision.reason,
    elapsedMs: decision.elapsedMs,
    query: queryRecord(deadlockFree(), decision, ctx.completion.recorded),
    counterexample: decision.counterexample,
  });
}

/**
 * How many arrivals can queue on one join / OR input at once (README "OR-inputs").
 *
 * Its undecided reason is `recordBound`'s: an `unknown` here can only come from the SMT route
 * (the graph decides a bound outright or declines), and the SMT route is only reached on a
 * graph that did not close, so the truncation half is always part of it.
 */
async function recordArrivalBound(
  ctx: Context, node: string, inputIndex: number, place: Place<unknown>, capacity: number, round: boolean,
): Promise<void> {
  const where = `${node}'s input ${inputIndex}`;
  await recordBound(ctx, {
    property: 'proper-completion',
    name: round
      ? `${node} input ${inputIndex} queues at most ${capacity} arrival${capacity === 1 ? '' : 's'} per round`
      : `${node} input ${inputIndex} keeps its join slot discipline`,
    subject: { kind: 'join-input', node, inputIndex, place: place.name },
    place,
    bound: capacity,
    explanation: {
      proven: round
        ? `${where} never holds more than ${capacity} arrival(s), so a round cannot over-fill and the ` +
          'positional pairing of divergence #8 cannot bite on it. This bounds pile-up; whether anything ' +
          'strands is the check below.'
        : `${where} never holds more than one arrival at a time, so the slot discipline of ADR 0003 ` +
          '(free_i + ready_i <= 1) holds. That bound holds by construction on a join input — every arm ' +
          'consumes the slot and only X_start / X_skip refund it — so this re-checks the gadget against ' +
          'the compiled net rather than detecting anything.',
      violated: round
        ? `More than ${capacity} arrival(s) can pile up on ${where}: arrivals are paired positionally, ` +
          'so the pairing is decided by arrival order (divergence #8).'
        : `${where} can hold two arrivals at once: the join slot discipline of ADR 0003 is broken — an ` +
          'arm armed the input without taking its free token, or something refunded the slot twice.',
      unknown: `Whether ${where} can hold more than ${capacity} arrival(s) was not decided.`,
    },
  });
}
