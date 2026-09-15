/**
 * The public vocabulary of `PetriScheduler` (`petri-scheduler.ts`, which exports both names):
 * what it is configured with, and how one of its runs ended.
 */
import type { EventStore } from 'libpetri';
import type { NodeHelpersLike, WorkflowScheduler } from '../n8n/host.js';
import type { CompiledWorkflowCache } from './cache.js';

export interface PetriSchedulerOptions {
  /** `NodeHelpers` from `n8n-workflow` (injected; not a runtime dependency). */
  readonly nodeHelpers: NodeHelpersLike;
  /** Creates the legacy `StackScheduler` a non-v1 workflow is delegated to. */
  readonly legacy: () => WorkflowScheduler;
  /** Concurrency budget `k` (`_budget` tokens). Default 1 (sequential n8n). */
  readonly budget?: number;
  /**
   * An agent's round budget when its `options.maxIterations` is an expression the adapter could
   * not read. Default `DEFAULT_MAX_AGENT_ROUNDS`, n8n's own default for that parameter.
   */
  readonly maxAgentRounds?: number;
  /**
   * An agent's tool-call budget for one execution, unless the workflow declares
   * `options.maxToolCalls`. Default `DEFAULT_MAX_AGENT_TOOL_CALLS`. Distinct from {@link budget}:
   * that bounds how many nodes run at once, this bounds how many tool calls an agent may make.
   */
  readonly maxAgentToolCalls?: number;
  /** Compiled-workflow LRU shared across executions. A private one when omitted. */
  readonly cache?: CompiledWorkflowCache;
  /** libpetri event store attached to every execution (`InMemoryEventStore` for tests). */
  readonly eventStore?: EventStore;
  /** Receives the compiler's and the codec's diagnostics, and the scheduler's own. */
  readonly onDiagnostic?: (message: string) => void;
}

/** How a `run()` ended. `fatal`: it rejected, as n8n's loop would have. */
export type SchedulerOutcome =
  | 'legacy' | 'nothing-to-run' | 'completed' | 'paused' | 'cancelled' | 'halted' | 'stranded' | 'fatal';
