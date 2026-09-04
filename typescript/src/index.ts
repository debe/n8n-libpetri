/**
 * n8n-libpetri — the scheduler seam.
 *
 * `PetriScheduler` replaces the `executionLoop:` inside n8n's
 * `WorkflowExecute.processRunExecutionData()`. The action bound to every node's
 * `X_run` transition calls the host's public `runNode()` and routes the result into the
 * declared output places (IO-015). Scheduling itself is the net's job (EXEC-002,
 * EXEC-003). `MarkingCodec` converts the marking to and from n8n's
 * `nodeExecutionStack` / `waitingExecution` so Wait-node resume and queue-mode handoff
 * keep working with n8n as the system of record.
 *
 * Milestone M2. See README.md ("The model") for the gadgets these actions serve.
 */
export const VERSION = '0.1.0';
