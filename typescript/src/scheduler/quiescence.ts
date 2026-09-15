/**
 * Steps 3 and 4 of `PetriScheduler.run()` (see `petri-scheduler.ts`): from n8n's pending state
 * to a quiescent marking. The initial marking is decoded from `executionData` (the marking
 * codec) and the stack entries it decoded are popped through the host; the executor then runs
 * to quiescence (EXEC-040) — never `run(timeoutMs)`. `host.abortSignal` → `executor.close()`
 * (ENV-013) is the only cancellation.
 */
import { PrecompiledNetExecutor, type EventStore, type Marking, type Place, type Token } from 'libpetri';
import { decodeExecutionData } from '../codec.js';
import type { CompiledWorkflow } from '../compiler/index.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { ENV_KEY, type ExecutionEnv } from './env.js';

/** A quiescent run: the marking the net stopped in, and whether a cancellation closed it. */
export interface Quiesced {
  readonly marking: Marking;
  readonly cancelled: boolean;
}

/**
 * The executor of one execution. Per-execution state reaches the actions through
 * `executionContextProvider` under {@link ENV_KEY}; the compiled workflow and its actions are
 * shared by every execution of the workflow version.
 */
function executorFor(
  compiled: CompiledWorkflow,
  initial: Map<Place<unknown>, Token<unknown>[]>,
  env: ExecutionEnv,
  eventStore: EventStore | undefined,
): PrecompiledNetExecutor {
  const contexts = new Map<string, unknown>([[ENV_KEY, env]]);
  return new PrecompiledNetExecutor(compiled.net, initial, {
    program: compiled.program,
    executionContextProvider: () => contexts,
    ...(eventStore === undefined ? {} : { eventStore }),
  });
}

/** Runs `executor` to quiescence, closing it if `signal` aborts; `cancelled` says whether it did. */
async function runToQuiescence(executor: PrecompiledNetExecutor, signal: AbortSignal): Promise<Quiesced> {
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
    executor.close();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const marking = await executor.run();
    return { marking, cancelled };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Decodes `executionData` into the initial marking, pops what it decoded, and runs the net to quiescence. */
export async function quiesce(
  compiled: CompiledWorkflow, executionData: ExecutionDataState, env: ExecutionEnv, eventStore: EventStore | undefined,
): Promise<Quiesced> {
  const { host } = env;
  const initial = decodeExecutionData(compiled, executionData, {
    runData: env.runExecutionData.resultData.runData,
    onDiagnostic: (m) => env.diagnostic(`decode: ${m}`),
  });
  // n8n pops every entry it runs; the net took them all at once.
  while (host.isExecutionStackNotEmpty()) host.popExecutionStack();
  return runToQuiescence(executorFor(compiled, initial, env, eventStore), host.abortSignal);
}
