/**
 * Registers the PetriScheduler with n8n's scheduler registry (patch 0002,
 * `setWorkflowSchedulerFactory`). Everything n8n-specific is injected by the caller — the
 * process that hosts n8n — so this package never imports n8n at runtime.
 */
import type { EventStore } from 'libpetri';
import type { NodeHelpersLike, SetWorkflowSchedulerFactory, WorkflowScheduler, WorkflowSchedulerFactory } from '../n8n/host.js';
import { CompiledWorkflowCache } from './cache.js';
import { PetriScheduler } from './petri-scheduler.js';

export interface RegisterPetriSchedulerOptions {
  /** `setWorkflowSchedulerFactory` from `@/execution-engine/scheduler-registry`. */
  readonly setWorkflowSchedulerFactory: SetWorkflowSchedulerFactory;
  /** `NodeHelpers` from `n8n-workflow`. */
  readonly nodeHelpers: NodeHelpersLike;
  /** `StackScheduler` from `@/execution-engine/stack-scheduler`: the legacy scheduler non-v1 workflows go to. */
  readonly StackScheduler: new () => WorkflowScheduler;
  /** Concurrency budget `k`. Default 1. */
  readonly budget?: number;
  /** An agent's round budget when its `options.maxIterations` cannot be read statically. Default 10. */
  readonly maxAgentRounds?: number;
  /** An agent's tool-call budget per execution unless the workflow declares `options.maxToolCalls`. Default 8. */
  readonly maxAgentToolCalls?: number;
  readonly eventStore?: EventStore;
  /** LRU capacity of the shared compiled-workflow cache. Default 16. */
  readonly cacheCapacity?: number;
  readonly onDiagnostic?: (message: string) => void;
}

export interface PetriSchedulerRegistration {
  /** The factory that was registered: one `PetriScheduler` per execution, sharing `cache`. */
  readonly factory: WorkflowSchedulerFactory;
  readonly cache: CompiledWorkflowCache;
}

/**
 * The diagnostic the registered factory emits the **first time n8n constructs a scheduler
 * through it**, per module instance (i.e. per vitest test file).
 *
 * Registering a factory proves nothing about a conformance leg. A scope whose tests never
 * reach `processRunExecutionData` — `packages/workflow`, which does not depend on n8n-core
 * at all, or `packages/cli`, whose tests mock `n8n-core`'s `WorkflowExecute` before they get
 * there — runs every case with the engine registered and never entered, and its junit is
 * then evidence of patch neutrality, not of the engine (`docs/conformance-final.md`
 * "Scopes"). One line per file that actually entered the engine turns "is this leg real?"
 * into a number `scripts/run-conformance.sh` counts into `<label>.diagnostics.txt`.
 */
export const ENGINE_ENTERED_DIAGNOSTIC =
  'engine entered: n8n constructed a scheduler through the registered factory';

export function registerPetriScheduler(options: RegisterPetriSchedulerOptions): PetriSchedulerRegistration {
  const cache = new CompiledWorkflowCache(options.cacheCapacity ?? 16);
  let entered = false;
  const factory: WorkflowSchedulerFactory = () => {
    if (!entered) {
      entered = true;
      options.onDiagnostic?.(ENGINE_ENTERED_DIAGNOSTIC);
    }
    return new PetriScheduler({
      nodeHelpers: options.nodeHelpers,
      legacy: () => new options.StackScheduler(),
      budget: options.budget ?? 1,
      ...(options.maxAgentRounds === undefined ? {} : { maxAgentRounds: options.maxAgentRounds }),
      ...(options.maxAgentToolCalls === undefined ? {} : { maxAgentToolCalls: options.maxAgentToolCalls }),
      cache,
      ...(options.eventStore === undefined ? {} : { eventStore: options.eventStore }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  };
  options.setWorkflowSchedulerFactory(factory);
  return { factory, cache };
}
