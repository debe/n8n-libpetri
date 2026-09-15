/**
 * The two legs of a differential run. One fixture runs once through n8n's own loop
 * ({@link StackReferenceScheduler}) and once through the {@link PetriScheduler}, each on a
 * fresh `TracingHost` built from the same fixture, so the two runs share one workflow
 * and one set of node behaviours and nothing else. What a leg produced — run data, resumable
 * state, contract values, trace — is collected into an {@link EngineRun} for the comparisons.
 *
 * The fixture is `legs/fixture.ts`, the traced host `legs/tracing-host.ts`, and running one
 * leg and collecting its record `legs/leg.ts`; this module runs the two legs and is the one
 * surface of all four.
 */
import { PetriScheduler } from '../scheduler/index.js';
import { fakeHooks } from './harness/hooks.js';
import { fakeNodeHelpers } from './harness/workflow.js';
import type { DifferFixture } from './legs/fixture.js';
import { runLeg } from './legs/leg.js';
import type { EngineRun } from './legs/record.js';
import { StackReferenceScheduler } from './stack-reference.js';

export { DifferFixtureError, startNodeOf, type DifferFixture } from './legs/fixture.js';
export type { EngineName, EngineRun, SchedulerContract } from './legs/record.js';

/** Run `fixture` through n8n's own loop. */
export async function runReference(fixture: DifferFixture): Promise<EngineRun> {
  const scheduler = new StackReferenceScheduler();
  const leg = await runLeg('n8n', fixture, scheduler, (h) => fakeHooks(h.calls), (h) => { h.enableEnqueue(); });
  return { ...leg, effectiveBudget: 1, budgetRestriction: null, diagnostics: [], outcome: null };
}

/**
 * Run `fixture` through the `PetriScheduler` at budget `k`.
 *
 * Nothing bounds this leg but the fixture itself: the reference leg stops at its
 * 10 000-activation valve, so a net that never quiesces hangs here instead. A valve belongs
 * in this function, and libpetri's `run(ms, 'close')` is the tool for it — a harness safety
 * valve is not n8n's timeout, so the rule that keeps one out of the scheduler does not
 * apply here.
 */
export async function runPetri(fixture: DifferFixture, budget: number): Promise<EngineRun> {
  const scheduler = new PetriScheduler({
    nodeHelpers: fakeNodeHelpers,
    legacy: () => { throw new Error('differ: v1 only, the legacy scheduler must not be reached'); },
    budget,
  });
  // `enableEnqueue` is deliberately NOT called: `addNodeToBeExecuted` stays fatal, so a
  // scheduler that reached for n8n's dispatch queue would fail the run, not pass quietly.
  const leg = await runLeg('libpetri', fixture, scheduler, (h) => fakeHooks(h.calls), () => {});
  return {
    ...leg,
    effectiveBudget: scheduler.compiled?.effectiveBudget ?? budget,
    budgetRestriction: scheduler.compiled?.budgetRestriction ?? null,
    diagnostics: [...scheduler.diagnostics],
    outcome: scheduler.outcome ?? null,
  };
}
