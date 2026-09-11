/**
 * Spike — can the net express n8n's *quiescence* fallback?
 *
 * Divergence #2. `stack-scheduler.ts:372`:
 *
 * ```ts
 * if (runExecutionData.executionData!.nodeExecutionStack.length === 0 && waitingNodes.length) {
 *   // … run each waiting join with its missing inputs padded to []
 * ```
 *
 * The trigger is **global**: nothing left to run, anywhere. The net strands the partial arrival
 * instead, which is divergence #1's abandonment of R6's partial fire and three of the four
 * loop-driving conformance regressions' worth of trouble.
 *
 * A "fire only when nothing else can" transition is the textbook construct for this, and
 * **libpetri has the priority semantics it needs**: conflict-only pre-emption. A lower-priority
 * transition is dominated by a strictly-higher-priority, no-later-ready one that
 * `sharesConsumedInput` with it — shares an input place where the marking cannot satisfy both
 * demands. The executor resolves that way, and the Route-B analyzer models it under
 * `prioritySemantics('conflict')` (NU-052), whose documented purpose is "removing spurious
 * dead-letter-drain stalls the eager, priority-ordered executor never produces" — this exact
 * pattern. What priority does *not* do is order transitions that never compete for a token.
 *
 * That is what makes `_budget` the right gate rather than an incidental one: every `X_start`
 * consumes a unit, a drain taking `exactly(k, _budget)` demands all of them, so combined demand
 * always exceeds the marking and the drain is in conflict with — and therefore dominated by —
 * every startable node. The spike pins the four consequences:
 *
 * 1. a higher-priority transition competing for the same unit stops the drain firing;
 * 2. the drain fires when nothing else can;
 * 3. it stays disabled while an action is in flight, because a running node holds a unit;
 * 4. and it still loses when the finishing firing hands the unit back *together with* the edge
 *    token that arms the next `X_start`, so there is no window between them.
 *
 * Then the case that breaks a budget-only gate, and its fix — see the last two tests.
 */
import {
  PetriNet, Transition, place, one, exactly, and, delayed, outPlace, tokenOf,
} from 'libpetri';
import { marking, runNet, sleep, started, units } from './support.js';

const budget = place<null>('_budget');
const work = place<null>('work');
const ranHigh = place<null>('ran/high');
const ranLow = place<null>('ran/low');
const edge = place<null>('edge');

/** k budget units, a drain that needs all of them, at a priority below every worker. */
function drain(k: number) {
  return Transition.builder('drain')
    .inputs(exactly(k, budget))
    .outputs(outPlace(ranLow))
    .action(async (ctx) => { ctx.output(ranLow, tokenOf(null)); })
    .priority(-1)
    .build();
}

describe('spike: a quiescence drain', () => {
  it('loses to a higher-priority transition competing for the same budget unit', async () => {
    // Both are enabled in the very first cycle. If the executor fired a stale ready set, both
    // would run; if contention re-validates, the worker takes the unit and the drain never does.
    const net = PetriNet.builder('preempt').transitions(
      Transition.builder('worker')
        .inputs(one(work), one(budget))
        .outputs(outPlace(ranHigh))
        .action(async (ctx) => { ctx.output(ranHigh, tokenOf(null)); })
        .priority(5).build(),
      drain(1),
    ).build();
    const r = await runNet(net, marking([[budget, units(1)], [work, units(1)]]));
    expect(started(r.store)).toEqual(['worker']);
    expect(r.marking.tokenCount(ranLow)).toBe(0);
  });

  it('fires when nothing else can — which is the whole point', async () => {
    const net = PetriNet.builder('quiet').transitions(
      Transition.builder('worker')
        .inputs(one(work), one(budget))
        .outputs(outPlace(ranHigh))
        .action(async (ctx) => { ctx.output(ranHigh, tokenOf(null)); })
        .priority(5).build(),
      drain(1),
    ).build();
    // No `work` token, so the worker is not enabled and the drain is the only thing left.
    const r = await runNet(net, marking([[budget, units(1)]]));
    expect(started(r.store)).toEqual(['drain']);
  });

  it('stays disabled while an action is in flight, because a running node holds a unit', async () => {
    // k = 2 and one unit taken by a slow action: `exactly(_budget, 2)` cannot be satisfied, so
    // the drain cannot mistake "a node is working" for "there is nothing to do".
    const net = PetriNet.builder('inflight').transitions(
      Transition.builder('slow')
        .inputs(one(work), one(budget))
        .outputs(and(outPlace(ranHigh), outPlace(budget)))
        .action(async (ctx) => {
          await sleep(60);
          ctx.output(ranHigh, tokenOf(null));
          ctx.output(budget, tokenOf(null));
        })
        .priority(5).build(),
      drain(2),
    ).build();
    const r = await runNet(net, marking([[budget, units(2)], [work, units(1)]]));
    // The drain fired only after `slow` completed and its unit came back.
    expect(started(r.store)).toEqual(['slow', 'drain']);
    const events = r.store.events();
    const done = events.findIndex((e) => e.type === 'transition-completed' && e.transitionName === 'slow');
    const drained = events.findIndex((e) => e.type === 'transition-started' && e.transitionName === 'drain');
    expect(done).toBeGreaterThanOrEqual(0);
    expect(drained).toBeGreaterThan(done);
  });

  it('still loses when the finishing action hands back the unit and enables the next start at once', async () => {
    // The real shape: `X_done` returns `_budget` *and* produces the edge token that arms the
    // downstream `X_start`, in one firing. If the drain could fire in the window between them
    // there would be no window at all — this pins that there is none.
    const net = PetriNet.builder('handback').transitions(
      Transition.builder('slow')
        .inputs(one(work), one(budget))
        .outputs(and(outPlace(edge), outPlace(budget)))
        .action(async (ctx) => {
          await sleep(40);
          ctx.output(edge, tokenOf(null));
          ctx.output(budget, tokenOf(null));
        })
        .priority(5).build(),
      Transition.builder('next')
        .inputs(one(edge), one(budget))
        .outputs(outPlace(ranHigh))
        .action(async (ctx) => { ctx.output(ranHigh, tokenOf(null)); })
        .priority(5).build(),
      drain(1),
    ).build();
    const r = await runNet(net, marking([[budget, units(1)], [work, units(1)]]));
    expect(started(r.store)).toEqual(['slow', 'next']);
    expect(r.marking.tokenCount(ranLow)).toBe(0);
  });

  it('drains only after the whole cascade is quiet', async () => {
    const net = PetriNet.builder('cascade').transitions(
      Transition.builder('slow')
        .inputs(one(work), one(budget))
        .outputs(and(outPlace(edge), outPlace(budget)))
        .action(async (ctx) => {
          await sleep(40);
          ctx.output(edge, tokenOf(null));
          ctx.output(budget, tokenOf(null));
        })
        .priority(5).build(),
      Transition.builder('next')
        .inputs(one(edge), one(budget))
        .outputs(and(outPlace(ranHigh), outPlace(budget)))
        .action(async (ctx) => {
          ctx.output(ranHigh, tokenOf(null));
          ctx.output(budget, tokenOf(null));
        })
        .priority(5).build(),
      drain(1),
    ).build();
    const r = await runNet(net, marking([[budget, units(1)], [work, units(1)]]));
    expect(started(r.store)).toEqual(['slow', 'next', 'drain']);
  });

  /**
   * The hazard the budget alone does not cover. A node waiting out an `onFailure` retry delay
   * holds `X/failed_i` and `X/idle` — **not** a budget unit (`attempt_i` takes the delay, not the
   * budget) — so every unit is free and a budget-only drain would call that quiescence. n8n's
   * stack is not empty there; work is pending.
   */
  it('a budget-only drain fires during a retry delay, which is a false quiescence', async () => {
    const failed = place<null>('X/failed_1');
    const net = PetriNet.builder('retry-window').transitions(
      Transition.builder('attempt_2')
        .inputs(one(failed))
        .timing(delayed(80))
        .outputs(outPlace(ranHigh))
        .action(async (ctx) => { ctx.output(ranHigh, tokenOf(null)); })
        .priority(5).build(),
      drain(1),
    ).build();
    const r = await runNet(net, marking([[budget, units(1)], [failed, units(1)]]));
    // The drain went first: the retry is pending but holds no budget.
    expect(started(r.store)[0]).toBe('drain');
  });

  it('and inhibiting the drain on the pending-work place fixes it', async () => {
    const failed = place<null>('X/failed_1');
    const net = PetriNet.builder('retry-gated').transitions(
      Transition.builder('attempt_2')
        .inputs(one(failed))
        .timing(delayed(80))
        .outputs(outPlace(ranHigh))
        .action(async (ctx) => { ctx.output(ranHigh, tokenOf(null)); })
        .priority(5).build(),
      Transition.builder('drain')
        .inputs(exactly(1, budget))
        .inhibitors(failed)
        .outputs(outPlace(ranLow))
        .action(async (ctx) => { ctx.output(ranLow, tokenOf(null)); })
        .priority(-1).build(),
    ).build();
    const r = await runNet(net, marking([[budget, units(1)], [failed, units(1)]]));
    expect(started(r.store)).toEqual(['attempt_2', 'drain']);
  });
});
