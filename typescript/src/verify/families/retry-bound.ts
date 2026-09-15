/**
 * `retry-bound` — `X/tries` never exceeds `maxTries − 1` **plus** a structural check that no
 * transition of the net produces `X/tries`; and, for an `onFailure` chain (ADR 0009), a
 * one-token bound per attempt plus the structural check that the chain is a line. The bound
 * alone only restates the seeding; the conjunction is what bounds the number of *attempts*.
 */
import { queryRecord, record, recordBound, structuralDecision } from '../record.js';
import { explain, unknownReason } from '../reasons.js';
import { weakerVerdict, type Context } from '../route.js';
import { producerIndex } from '../shape.js';
import type { CheckVerdict } from '../types.js';

/** Place name → the flat transitions producing on it, for every place this family asks about. */
type Producers = ReadonlyMap<string, readonly string[]>;

/**
 * An `onFailure` chain's bound, in the same two halves as the retry bound below (ADR 0009 §3).
 *
 * The **place bound** is `placeBound(X/failed_i, 1)` per attempt: one activation can have at
 * most one failure outstanding at each position. The **structural** half is what turns that
 * into "the node runs at most `steps.length` times per activation": the chain is a line, so
 * every `X/running_i` after the first must be produced by exactly one transition — the step of
 * the attempt before it — and nothing may put a token back on an earlier one. A compiler change
 * that wired a step to an earlier attempt would make the chain a cycle and is exactly what this
 * half catches; the place bound alone would still hold.
 *
 * Read off the flattened net, so it costs no route and cannot come back `unknown`.
 */
async function runAttemptBound(ctx: Context, producersOf: Producers): Promise<void> {
  for (const g of ctx.map.nodes) {
    if (g.attempts.length === 0) continue;
    let weakest: CheckVerdict = 'proven';
    for (const attempt of g.attempts) {
      const decision = await recordBound(ctx, {
        property: 'retry-bound',
        name: `${g.node} attempt ${attempt.index} has at most one failure outstanding`,
        subject: { kind: 'node', node: g.node, place: attempt.failed.name },
        place: attempt.failed,
        bound: 1,
        explanation: {
          proven: `${attempt.failed.name} never holds more than one token, so attempt ${attempt.index} of ` +
            `${g.node} can fail at most once before its onFailure step acts on it.`,
          violated: `${attempt.failed.name} can hold more than one token: two activations are at the same ` +
            'attempt position at once, and the step would answer them in an order nothing fixes.',
          unknown: `Whether ${attempt.failed.name} stays within one token was not decided.`,
        },
      });
      weakest = weakerVerdict(weakest, decision.verdict);
    }

    // The chain must be a line, not a loop: each later attempt has exactly one producer, and it
    // is the step of the attempt before it.
    const wrong: string[] = [];
    g.attempts.forEach((attempt, i) => {
      if (i === 0) return;
      const expected = g.transitions.attemptSteps[i - 1];
      const producers = producersOf.get(attempt.running.name) ?? [];
      if (producers.length !== 1 || producers[0] !== expected) {
        wrong.push(`${attempt.running.name} <- [${producers.join(', ') || 'nothing'}] (expected ${expected})`);
      }
    });
    const attempts: CheckVerdict = wrong.length > 0 ? 'violated' : weakest;
    const structural = structuralDecision(wrong.length > 0 ? 'violated' : 'proven', 'structural');
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node} attempts at most ${g.attempts.length} times per activation`,
      subject: { kind: 'node', node: g.node, place: g.attempts[0]!.failed.name },
      verdict: attempts,
      explanation: explain(attempts, {
        proven: `The chain is a line of ${g.attempts.length} attempt(s): each is reached only from the step ` +
          'before it and no failure place holds more than one token, so the node runs at most that many times ' +
          'for one activation — and, unlike X/tries, the next activation starts the chain over.',
        violated: wrong.length > 0
          ? `The chain is not a line: ${wrong.join('; ')}. An attempt reachable from anywhere else is a cycle, ` +
            'and the number of runs is not bounded by the step count.'
          : 'A failure place can hold more than one token, so the attempt count is not bounded by the chain.',
        unknown: 'The chain is a line, but the bound on its failure places was not established.',
      }),
      reason: attempts === 'unknown' || attempts === 'bounded' ? 'the per-attempt place bound did not close' : null,
      elapsedMs: 0,
      query: { ...queryRecord('none', structural), place: g.attempts[0]!.failed.name },
    });
  }
}

/**
 * The retry bound is two checks, because the place bound alone does not entail it.
 *
 * `placeBound(X/tries, maxTries − 1)` is true in the initial marking — `X/tries` is seeded
 * with exactly that many tokens — and a net that *refunded* a try token would still satisfy
 * it while `X_retry_wait` fired without limit (a two-place net whose
 * `retry_wait: one(tries), one(go) → and(go, tries)` keeps `placeBound(tries, 2)` proven
 * forever, and `placeBound(tries, 1)` violated, so the query is live rather than vacuous).
 * What turns the bound into "at most `maxTries` attempts" is the structural fact that
 * **nothing produces `X/tries`**: it is seeded, consumed by `X_retry_wait` and read as an
 * inhibitor by `X_exhausted`. That half needs neither route — it is read off the flattened
 * net — and it is the half a future compiler change would break.
 */
export async function runRetryBound(ctx: Context): Promise<void> {
  // Every place this family asks "what produces it?" about — each later attempt's running
  // place and each retry node's tries — in one pass over the flat transitions, rather than one
  // pass per place.
  const producers = producerIndex(ctx.flat, ctx.map.nodes.flatMap((g) => [
    ...g.attempts.slice(1).map((a) => a.running),
    ...(g.retry === null ? [] : [g.retry.tries]),
  ]));
  await runAttemptBound(ctx, producers);
  for (const g of ctx.map.nodes) {
    if (g.retry === null) continue;
    const { tries, maxTries } = g.retry;
    const bound = maxTries - 1;
    const decision = await recordBound(ctx, {
      property: 'retry-bound',
      name: `${g.node}/tries never holds more than ${bound}`,
      subject: { kind: 'node', node: g.node, place: tries.name },
      place: tries,
      bound,
      explanation: {
        proven: `${g.node}/tries never exceeds the ${bound} token(s) it is seeded with. On its own that bounds ` +
          'the try tokens, not the attempts — the attempt bound is the check below.',
        violated: `${g.node}/tries can exceed ${bound}: something puts a try token back.`,
        unknown: `Whether ${g.node}/tries stays within ${bound} was not decided.`,
      },
    });

    const refunds = producers.get(tries.name) ?? [];
    // The attempt bound is the conjunction, so it is only ever as strong as the weaker half:
    // a `bounded` place bound makes the attempt bound `bounded` too, never `proven`.
    const attempts: CheckVerdict = refunds.length > 0
      ? 'violated'
      : decision.verdict === 'proven' || decision.verdict === 'bounded' ? decision.verdict : 'unknown';
    const structural = structuralDecision(refunds.length > 0 ? 'violated' : 'proven', 'structural');
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node} attempts at most ${maxTries} times`,
      subject: { kind: 'node', node: g.node, place: tries.name },
      verdict: attempts,
      explanation: explain(attempts, {
        proven: `No transition produces ${tries.name} and it never exceeds ${bound}, so X_retry_wait can fire at ` +
          `most ${bound} times and ${g.node} runs at most ${maxTries} times before X_exhausted.`,
        violated: `${refunds.length} transition(s) produce ${tries.name} (${refunds.join(', ')}), so the try ` +
          'tokens are refunded and the number of attempts is not bounded by the seeding.',
        unknown: `Nothing produces ${tries.name}, but the bound on it was not established, so the attempt count ` +
          'is not bounded either.',
      }),
      reason: attempts === 'unknown' || attempts === 'bounded' ? unknownReason(ctx, decision) : null,
      elapsedMs: 0,
      query: { ...queryRecord('none', structural), place: tries.name },
      counterexample: null,
    });
  }
}
