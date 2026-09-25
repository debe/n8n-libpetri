/**
 * `settlement` — the `engineV2` family (`tasks/v2-profile-plan.md` step 12, decision 18): the
 * invariants that make the settlement gadget a statement of engine v2's rule, asked of every
 * class of the net's state-class graph (`settlement.ts`, `state-space/settlement-survey.ts`).
 *
 * | Check | Subject | Claim |
 * |---|---|---|
 * | start / skip exclusive | every node with a skip; a batch node's entry pair and back pair | no class enables `X_start` and `X_skip` together, so a decided node is queued or skipped, never both (`decideNodeFate`, rules 2–3 of `settlement.ts`) |
 * | arrives at most once | every `e/arrived`, and the trigger's `T/in` | the place never holds two tokens: an edge's source settles once per pass before the consumer decides |
 * | runs at most once at a time | every `X/running` | never two tokens: at most one step of a node is in flight (the folding falsifier, decision 6) |
 * | nothing pending at rest | the whole net | a quiescent class without `_halt` holds no `arrived`, `live`, `running` or `ok` token |
 * | decided exactly once | every node outside a loop | `X/done + X/skipped` never exceeds 1, and is 1 in every quiescent class without `_halt` |
 * | the loop ends exactly once | every batch node | `B/ended` never exceeds 1, and is 1 in every quiescent class without `_halt` |
 *
 * **The halted terminal is not a completion claim.** After a failure v2 plans nothing more
 * (decision 8), so a class holding `_halt` may leave edges arrived, steps running (the net
 * finishes a start already in flight) and a loop unended — or ended: a failed batch row writes
 * `B/ended` beside `_halt` (step 6), and a failed body row leaves it unwritten. Both are
 * consistent with v2, so the two at-rest checks quantify over halt-free quiescent classes only,
 * and the bounds and the exclusivity hold over every class, halted or not.
 *
 * **Verdicts, in the one direction the graph licenses (VER-004).** `proven` needs the graph to
 * have closed. A class breaking a claim is `violated` whether or not it closed, with the firing
 * path to it: a witness in the priority- and value-blind abstraction, never more. A truncated
 * graph with no witness is `unknown`, and so is an at-rest claim when no halt-free quiescent class
 * was reached at all, which would make it vacuous.
 */
import type { StateClass } from 'libpetri/verification';
import type { EdgeRef } from '../../compiler/index.js';
import { record } from '../record.js';
import type { SettlementContext, SettlementSpace } from '../settlement.js';
import { witnessCounterexample } from '../state-space/decode.js';
import { pairKey, type ExclusivePair } from '../state-space/settlement-survey.js';
import type { CheckSubject, CheckVerdict, Counterexample, QueryRecord } from '../types.js';

/** A graph verdict and what backs it. */
interface GraphAnswer {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly counterexample: Counterexample | null;
}

/** One check of the family: what it is about, which question it asks, and in which words. */
interface Spec {
  readonly name: string;
  readonly subject: CheckSubject;
  /** The graph question, recorded as `QueryRecord.property`. */
  readonly question: string;
  readonly place: string | null;
  /** The first class breaking the claim, when one was found. */
  readonly witness: StateClass | undefined;
  /** Whether the claim quantifies over halt-free quiescent classes (vacuous when there are none). */
  readonly atRest: boolean;
  readonly explanation: { proven: string; violated: string; unknown: string };
}

/** Runs every check of the family, in the table's order, recording each. */
export function runSettlementFamily(ctx: SettlementContext): void {
  const { space } = ctx;
  const survey = space.survey;
  const map = ctx.compiled.netMap;

  for (const p of space.questions.pairs) {
    const what = pairLabel(p);
    check(ctx, {
      name: `${what} never both enabled`,
      subject: { kind: 'node', node: p.node },
      question: 'settlement:start-skip-exclusive',
      place: null,
      witness: survey?.bothEnabled.get(pairKey(p)),
      atRest: false,
      explanation: {
        proven: `No reachable marking enables ${p.start} and ${p.skip} together: ${p.node} is queued or skipped, never both.`,
        violated: `A marking of the abstraction enables ${p.start} and ${p.skip} together, so ${p.node} could be both queued and skipped.`,
        unknown: `Whether ${p.start} and ${p.skip} can be enabled together was not decided.`,
      },
    });
  }

  for (const info of map.places) {
    if (info.role !== 'arrived') continue;
    const e = info.edge;
    if (e === undefined) {
      bound(ctx, info.name, { kind: 'edge', node: info.node ?? info.name, place: info.name }, `${info.node} input arrives at most once`);
    } else {
      bound(ctx, info.name, edgeSubject(e, info.name), `${edgeLabel(e)} arrives at most once at a time`);
    }
  }

  for (const g of map.settlements) {
    const running = g.running.name;
    check(ctx, {
      name: `${g.node} runs at most once at a time`,
      subject: { kind: 'node', node: g.node, place: running },
      question: 'place-bound',
      place: running,
      witness: overPeak(space, running, 1),
      atRest: false,
      explanation: {
        proven: `${running} never holds two tokens: at most one step of ${g.node} is in flight, as folding the loop needs (decision 6).`,
        violated: `${running} can hold two tokens in the abstraction: two steps of ${g.node} in flight, which a folded loop cannot represent.`,
        unknown: `Whether two steps of ${g.node} can be in flight at once was not decided.`,
      },
    });
  }

  check(ctx, {
    name: 'every halt-free run ends with nothing pending',
    subject: { kind: 'net' },
    question: 'settlement:quiescent-without-halt-is-settled',
    place: null,
    witness: survey?.firstResidue ?? undefined,
    atRest: true,
    explanation: {
      proven: 'Every quiescent marking without _halt holds no arrived, live, running or routed-outcome token: every edge was read, every step settled.',
      violated: 'A quiescent marking of the abstraction without _halt still holds an arrived, live, running or routed-outcome token: work left behind in a run that did not fail.',
      unknown: 'Whether a halt-free run can come to rest with work left behind was not decided.',
    },
  });

  for (const d of space.questions.decided) {
    const markers = d.skipped === null ? d.done.name : `${d.done.name} + ${d.skipped.name}`;
    check(ctx, {
      name: `${d.node} is decided exactly once`,
      subject: { kind: 'node', node: d.node },
      question: 'settlement:decided-exactly-once',
      place: markers,
      witness: survey?.overDecided.get(d.node) ?? survey?.undecided.get(d.node),
      atRest: true,
      explanation: {
        proven: `${markers} never exceeds 1, and is 1 in every quiescent marking without _halt: ${d.node} is settled exactly once in every run that does not fail.`,
        violated: `${markers} exceeds 1, or is not 1 at a halt-free rest, in the abstraction: ${d.node} settled twice or never.`,
        unknown: `Whether ${d.node} is always decided exactly once was not decided.`,
      },
    });
  }

  for (const l of space.questions.loops) {
    const ended = l.ended.name;
    check(ctx, {
      name: `${l.batch}'s loop ends exactly once`,
      subject: { kind: 'node', node: l.batch, place: ended },
      question: 'settlement:loop-ends-exactly-once',
      place: ended,
      witness: overPeak(space, ended, 1) ?? survey?.notEnded.get(l.batch),
      atRest: true,
      explanation: {
        proven: `${ended} never exceeds 1, and is 1 in every quiescent marking without _halt: the loop of ${l.batch} ends exactly once in every run that does not fail. A halted run may or may not have ended it (a failed batch row writes it beside _halt), and no claim is made there.`,
        violated: `${ended} exceeds 1, or is not 1 at a halt-free rest, in the abstraction: the loop of ${l.batch} ended twice or never.`,
        unknown: `Whether the loop of ${l.batch} always ends exactly once was not decided.`,
      },
    });
  }
}

/** `placeBound(place, 1)` over the graph. */
function bound(ctx: SettlementContext, place: string, subject: CheckSubject, name: string): void {
  check(ctx, {
    name,
    subject,
    question: 'place-bound',
    place,
    witness: overPeak(ctx.space, place, 1),
    atRest: false,
    explanation: {
      proven: `${place} never holds two tokens: its source settles once before its consumer decides.`,
      violated: `${place} can hold two tokens in the abstraction: a second settlement arrives before the first was read.`,
      unknown: `Whether ${place} can hold two tokens was not decided.`,
    },
  });
}

function check(ctx: SettlementContext, spec: Spec): void {
  const answer = answerOf(ctx.space, spec);
  const query: QueryRecord = {
    property: spec.question,
    place: spec.place,
    verdict: answer.verdict,
    sinks: [],
    conditionalSinks: [],
    method: ctx.space.graph === null ? null : 'state-class graph',
    route: ctx.space.graph === null ? 'none' : 'state-class-graph',
  };
  const explanation = spec.explanation[answer.verdict === 'bounded' ? 'unknown' : answer.verdict];
  record(ctx, {
    property: 'settlement',
    name: spec.name,
    subject: spec.subject,
    verdict: answer.verdict,
    explanation,
    reason: answer.reason,
    counterexample: answer.counterexample,
    elapsedMs: 0,
    query,
  });
}

/** The verdict a class of the graph, or its absence, licenses. */
function answerOf(space: SettlementSpace, spec: Spec): GraphAnswer {
  if (space.graph === null || space.survey === null || space.decoder === null) {
    return { verdict: 'unknown', reason: `the state-class graph could not be built: ${space.error ?? 'no graph'}`, counterexample: null };
  }
  if (spec.witness !== undefined) {
    const decoded = space.decoder.decode(spec.witness);
    return {
      verdict: 'violated',
      reason: null,
      counterexample: witnessCounterexample({ marking: decoded.marking, path: decoded.path }),
    };
  }
  if (!space.complete) return { verdict: 'unknown', reason: truncatedReason(space), counterexample: null };
  if (spec.atRest && space.survey.restClasses === 0) {
    return {
      verdict: 'unknown',
      reason: 'the complete graph reached no quiescent class without _halt, so the claim would hold vacuously',
      counterexample: null,
    };
  }
  return { verdict: 'proven', reason: null, counterexample: null };
}

function truncatedReason(space: SettlementSpace): string {
  const cause = space.truncation === 'off'
    ? `the solver-free route is off (maxClasses = ${space.requestedMaxClasses})`
    : `the state-class graph truncated at its ${space.maxClasses}-class cap with no violation in its prefix` +
      (space.truncation === 'parallelism' ? ' (independent parallel branches, NU-053)' : '');
  return `${cause}; an engineV2 report has no SMT fallback yet, so nothing else decides it`;
}

/** The first class putting more than `bound` tokens on `place`, if any. */
function overPeak(space: SettlementSpace, place: string, bound: number): StateClass | undefined {
  const survey = space.survey;
  if (survey === null || (survey.peak.get(place) ?? 0) <= bound) return undefined;
  return survey.peakClass.get(place);
}

function pairLabel(p: ExclusivePair): string {
  switch (p.pair) {
    case 'node': return `${p.node} start and skip`;
    case 'entry': return `${p.node} entry start and skip`;
    case 'back': return `${p.node} back-edge start and skip`;
  }
}

const edgeLabel = (e: EdgeRef): string => `${e.from}.${e.outputIndex} -> ${e.to}.${e.inputIndex}`;

const edgeSubject = (e: EdgeRef, place: string): CheckSubject => ({
  kind: 'edge', node: e.to, place, from: e.from, outputIndex: e.outputIndex, inputIndex: e.inputIndex,
});
