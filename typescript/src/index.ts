/**
 * n8n-libpetri — the scheduler seam.
 *
 * `PetriScheduler` replaces the `executionLoop:` inside n8n's
 * `WorkflowExecute.processRunExecutionData()` (patch 0001 extracts it as `StackScheduler`
 * behind `WorkflowScheduler`; patch 0002 adds the registry `registerPetriScheduler` plugs
 * into). The action bound to every node's `X_run` transition calls the host's public
 * `runNode()` and routes the result into the declared output places (IO-015). Scheduling
 * itself is the net's job (EXEC-002, EXEC-003). The marking codec (`decodeExecutionData` /
 * `encodeMarking`) converts the marking to and from n8n's `nodeExecutionStack` /
 * `waitingExecution` so Wait-node resume and queue-mode handoff keep working with n8n as
 * the system of record.
 *
 * n8n packages are not runtime dependencies: `n8n-workflow` types are imported type-only,
 * and `NodeHelpers`, the registry and `StackScheduler` are injected (`registerPetriScheduler`).
 *
 * Milestone M2. See README.md ("The model") for the gadgets these actions serve.
 */
export const VERSION = '0.1.0';

export { PetriScheduler, registerPetriScheduler, CompiledWorkflowCache, schedulerActions, ENV_KEY } from './scheduler/index.js';
export type {
  PetriSchedulerOptions, SchedulerOutcome, RegisterPetriSchedulerOptions, PetriSchedulerRegistration, ExecutionEnv,
  SchedulerState,
  EdgePayload, EntryPayload, InputPayload, OkPayload, RetryPayload, RetryReason, RunPayload, StoppedPayload, WaitingPayload,
} from './scheduler/index.js';
export {
  SchedulerNodeError, UnmetReferenceError, UNMET_REFERENCE_MESSAGE_TEMPLATE, isEdgePayload, isEntryPayload,
} from './scheduler/index.js';
export {
  decodeExecutionData, encodeMarking, entryForEdge, CodecError,
  type DecodeOptions, type EncodeOptions, type EncodeMode,
} from './codec.js';
export {
  describeWorkflow, scanExpressionReferences, mainConnectionsOf, nodeShapeOf, startNodesOf, LOOP_NODE_TYPES,
} from './n8n/adapter.js';
export type { AdapterOptions } from './n8n/adapter.js';
export type {
  SchedulerHost, SchedulerHooks, WorkflowScheduler, WorkflowSchedulerFactory, SetWorkflowSchedulerFactory,
  NodeHelpersLike, ExecutionDataState,
} from './n8n/host.js';
