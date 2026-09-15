/**
 * Proper completion's headline row — *can this workflow strand a branch anywhere?* — decided
 * from the graph's strandings when it has any or closed, and by the whole-net `deadlockFree`
 * fallback (`route.ts` `smtFallbackCompletion`) where it did neither.
 */
import { renderMarkedPlace } from '../counterexample.js';
import { completionUnknownReason, smtFallbackNote } from '../reasons.js';
import {
  boundedOrUnknown, graphDecision, smtFallbackCompletion, type Context, type Decision,
} from '../route.js';
import { MAX_WITNESSES, witnessCounterexample } from '../state-class.js';
import type { Stranding } from '../types.js';
import { recordCompletionRow } from './completion-row.js';

/** The headline check: no reachable quiescent marking leaves pending work anywhere. */
export async function runWholeNetCompletion(ctx: Context): Promise<void> {
  const strandings: readonly Stranding[] = ctx.space.usable ? ctx.space.strandings() : [];
  const decision = await wholeNetDecision(ctx, strandings);
  recordCompletionRow(ctx, 'no branch is ever left stranded', { kind: 'net' }, decision, {
    proven: provenSentence(ctx, decision),
    violated: violatedSentence(decision, strandings),
    unknown: `Whether this workflow can strand a branch was not decided: ${ctx.space.classes} state classes ` +
      'explored, none of them a stranding, and the graph is not complete.',
  });
}

/** A stranding the graph found; else the closed graph's proof; else the fallback's answer. */
async function wholeNetDecision(ctx: Context, strandings: readonly Stranding[]): Promise<Decision> {
  const space = ctx.space;
  const first = strandings[0];
  if (first !== undefined) {
    return { ...graphDecision('violated', witnessCounterexample(first)), elapsedMs: space.elapsedMs };
  }
  if (space.complete) return { ...graphDecision('proven'), elapsedMs: space.elapsedMs };
  const fallback = await smtFallbackCompletion(ctx);
  // `proven` and `violated` are both real verdicts about the whole net here: the
  // violated one survived the pause filter, so it is a stranding z3 found outside the
  // explored prefix and it is reported as the finding it is.
  if (fallback.verdict === 'proven' || fallback.verdict === 'violated') return fallback;
  return boundedOrUnknown(ctx, {
    ...fallback,
    verdict: 'unknown',
    reason: completionUnknownReason(ctx, fallback),
    elapsedMs: space.elapsedMs + fallback.elapsedMs,
  }, smtFallbackNote(fallback));
}

function provenSentence(ctx: Context, decision: Decision): string {
  const space = ctx.space;
  return decision.route === 'smt'
    ? 'The solver proved it: the whole-net deadlockFree question — rest set as sinks, pause / halt ' +
      'widenings as conditional sinks, state equation on — has an inductive invariant over every ' +
      'reachable marking, so no quiescent marking leaves work pending anywhere in the net. The graph ' +
      `had explored ${space.classes} state classes without closing.`
    : `Every one of the ${space.quiescentClasses} reachable quiescent markings of this workflow ` +
      `(${space.classes} state classes) is either a completed run holding only residue or one of the ` +
      `${space.terminalClasses} designed terminals — a paused or halted run the marking codec writes ` +
      'back. Nothing is left pending anywhere in the net.';
}

function violatedSentence(decision: Decision, strandings: readonly Stranding[]): string {
  const first = strandings[0];
  // The same renderer as the finding block's stuck marking, so a stranded place reads the
  // same in this sentence and in the witness printed under it.
  const stranded = first === undefined
    ? ''
    : ` It quiesces holding ${first.stranded.map(renderMarkedPlace).join(', ')}.`;
  // The graph found none but the fallback did: the row is still `violated`, and its sentence
  // has to say where the witness came from rather than quoting a class count of zero.
  const solverFound = decision.verdict === 'violated' && strandings.length === 0;
  return solverFound
    ? 'This workflow can come to rest with work still pending: the whole-net deadlockFree query ' +
      '(VER-002, rest set as sinks, pause / halt widenings as conditional sinks) returned a quiescent ' +
      'marking outside that set, and it is not one of the designed terminals the marking codec writes back.'
    : `This workflow can come to rest with work still pending: ${strandings.length}` +
      `${strandings.length >= MAX_WITNESSES ? '+' : ''} quiescent marking(s) hold a token on a place ` +
      `that is not residue.${stranded}`;
}
