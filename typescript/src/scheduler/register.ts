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

export function registerPetriScheduler(options: RegisterPetriSchedulerOptions): PetriSchedulerRegistration {
  const cache = new CompiledWorkflowCache(options.cacheCapacity ?? 16);
  const factory: WorkflowSchedulerFactory = () => new PetriScheduler({
    nodeHelpers: options.nodeHelpers,
    legacy: () => new options.StackScheduler(),
    budget: options.budget ?? 1,
    cache,
    ...(options.eventStore === undefined ? {} : { eventStore: options.eventStore }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  options.setWorkflowSchedulerFactory(factory);
  return { factory, cache };
}
