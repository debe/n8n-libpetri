/**
 * The readers every policy carrier goes through.
 *
 * n8n hands the adapter typed objects whose *policy* fields are untyped passthroughs
 * (`workflow.settings.executionPolicy`, `node.executionPolicy`, `parameters.options.*`), and
 * the verify CLI hands the same readers raw JSON. Both are `unknown` at the edge; these
 * functions are the only place that edge is narrowed, so no call site casts.
 */

/** `v` as a string-keyed record, or `undefined` when it is not a plain object. */
export function recordOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/** `v[key]` when `v` is a plain object; `undefined` otherwise. */
export function fieldOf(v: unknown, key: string): unknown {
  return recordOf(v)?.[key];
}

/**
 * `parameters.options[key]` when it is a literal positive integer; `undefined` otherwise.
 *
 * The two keys read this way are an agent's `maxIterations` — the bound n8n's own
 * `checkMaxIterations` enforces (`V3/helpers/executeBatch.ts`, default 10) — and
 * `maxToolCalls`, which n8n's agent does not declare and which is forward-compatible plumbing
 * for the scheduler's own bound (a workflow that sets it gets that budget, one that does not
 * gets `maxAgentToolCalls`). It is the path the verify CLI's raw-JSON fixtures still use; a
 * live workflow carries `maxToolCalls` in the policy instead, see `workflowPolicyOf`.
 *
 * Only a literal counts. n8n allows an expression on any parameter and resolves it per item at
 * execution time, so a compiled seed taken from one would be a guess; `undefined` then lets the
 * compiler fall back and mark the agent unbounded for verification rather than claim a bound.
 */
export function readPositiveIntOption(parameters: unknown, key: string): number | undefined {
  const raw = fieldOf(fieldOf(parameters, 'options'), key);
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}
