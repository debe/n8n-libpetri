# n8n patches

Applied by `scripts/bootstrap-n8n.sh` onto the pinned n8n commit `441970b` (master). Written
to upstream quality and kept rebasable; `scripts/verify-patch.sh` fails on drift.

| Patch | Purpose | Behaviour change |
|---|---|---|
| `0001-extract-scheduler-loop.patch` | Move the `executionLoop:` while (incl. the stuck-join fallback) out of `WorkflowExecute.processRunExecutionData()` into `StackScheduler implements WorkflowScheduler` behind a `SchedulerHost` interface | none |
| `0002-scheduler-registry.patch` | `setWorkflowSchedulerFactory()` so an unmodified `new WorkflowExecute(...)` can pick another scheduler; no test file edited | none |
