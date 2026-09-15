/**
 * One leg of a differential run: a scheduler run on a fresh `TracingHost` built from the
 * fixture (`fixture.ts`), and what that run produced — run data, resumable state, contract
 * values, trace — collected into the record `record.ts` defines. `engines.ts` runs the two
 * legs.
 */
import type { SchedulerHooks, WorkflowScheduler } from '../../n8n/host.js';
import { activationsOf, dependencyEdges } from '../trace.js';
import { buildHost, type DifferFixture } from './fixture.js';
import type { EngineName, LegRun, SchedulerContract } from './record.js';
import type { TracingHost } from './tracing-host.js';

/** The contract values of a scheduler whose `run()` has settled. */
function contractOf(scheduler: WorkflowScheduler): SchedulerContract {
  const e = scheduler.executionError as { name?: string; message?: string } | undefined;
  return {
    executionError: e === undefined ? undefined : { name: e.name, message: e.message },
    closeFunction: scheduler.closeFunction !== undefined,
  };
}

/** Run `scheduler` on a fresh host built from `fixture`, and collect what the run produced. */
export async function runLeg(
  engine: EngineName,
  fixture: DifferFixture,
  scheduler: WorkflowScheduler,
  hooksOf: (host: TracingHost) => SchedulerHooks,
  prepare: (host: TracingHost) => void,
): Promise<LegRun> {
  const { host, workflow, data } = buildHost(fixture);
  prepare(host);
  const hooks = hooksOf(host);
  let error: unknown;
  const t0 = performance.now();
  await scheduler.run(host, workflow, data, hooks).catch((e: unknown) => { error = e; });
  const elapsedMs = performance.now() - t0;
  const runData = data.resultData.runData;
  return {
    engine, scheduler, contract: contractOf(scheduler), host, runExecutionData: data, runData,
    trace: host.trace, activations: activationsOf(host.trace), edges: dependencyEdges(runData), elapsedMs, error,
  };
}
