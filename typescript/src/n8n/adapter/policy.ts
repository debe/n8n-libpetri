/**
 * The workflow's declared execution policy, and the per-node policy resolved against it.
 *
 * **The carrier, and why it is where it is.** Both keys round-trip through n8n untouched:
 * `workflow.settings.executionPolicy` survives the REST DTO's `.passthrough()` schema, the
 * `@JsonColumn` on `WorkflowEntity` and the editor's spread-based settings modal, and
 * `Workflow.setSettings` stores it verbatim; a top-level `node.executionPolicy` survives the
 * DTO (which validates only that `nodes` is an array), `normalizeNodeShape`'s `{...node}` and
 * the editor's own copy loop in `nodeTransforms.ts`, which skips a fixed list of keys and
 * anything beginning with `_` — so the name must not start with an underscore.
 *
 * **`node.parameters` is not a carrier**, which is why the policy is not there.
 * `getNodeParameters` rebuilds a `collection` from the node type's *declared* options into a
 * fresh object, so an undeclared key inside `parameters.options` is dropped on the editor's
 * save path and again in the `Workflow` constructor. That is why `options.maxToolCalls` — the
 * knob the README's known limits tell users to declare — cannot be set in a live n8n at all,
 * and why the resolved `maxToolCalls` reads the policy first and keeps the `options` path
 * (`readPositiveIntOption`) only for the verify CLI's raw-JSON fixtures.
 *
 * **One resolution, two callers.** The verify CLI reads the same carrier off a JSON export, and
 * one net serves execution and verification: a CLI that resolved the policy differently would
 * analyse a different net and report it with the same confidence. So the rule and the
 * precedence live here once, over raw `settings` and a raw node — {@link parseWorkflowPolicy}
 * and {@link resolveNodePolicy} — and the `Workflow` forms only hand them the fields.
 */
import type { INode, Workflow } from 'n8n-workflow';
import type { ExecutionPolicy, NodeDescription } from '../../compiler/index.js';
import { mergePolicies, parseExecutionPolicy, POLICY_SCHEMA_VERSION } from '../../compiler/index.js';
import { fieldOf, readPositiveIntOption, recordOf } from './readers.js';

/** {@link parseWorkflowPolicy} over `workflow.settings` (see the module doc). */
export function workflowPolicyOf(workflow: Workflow, diagnostics: string[]): ExecutionPolicy | undefined {
  return parseWorkflowPolicy(workflow.settings, diagnostics);
}

/** `settings.executionPolicy` parsed and narrowed by {@link inheritableWorkflowPolicy}. */
export function parseWorkflowPolicy(settings: unknown, diagnostics: string[]): ExecutionPolicy | undefined {
  const parsed = parseExecutionPolicy(fieldOf(settings, 'executionPolicy'), 'workflow settings');
  diagnostics.push(...parsed.diagnostics);
  return inheritableWorkflowPolicy(parsed.policy, diagnostics);
}

/**
 * The part of a workflow-level policy every node inherits.
 *
 * **The failure policy does not inherit from workflow scope.** The resource knobs do —
 * `concurrency`, `rate`, `maxRuns`, `maxToolCalls`, `maxRounds` all mean something sensible as
 * a workflow-wide default. `onFailure` and `timeoutMs` do not, for the reason this ADR gives
 * for refusing `onFailure` beside `retryOnFail`: it would invent "a precedence a workflow
 * author cannot see". A single `timeoutMs` here would otherwise arm a deadline on every node,
 * and since a deadline needs a chain to say what an expired attempt does, the *whole workflow*
 * would fail to compile over a key the author set as a default. A workflow-wide `onFailure`
 * would likewise rewrite the failure behaviour of every node, and throw on the first one that
 * declares `retryOnFail` or lacks the output a `route` step names.
 *
 * Declared per node, or per group where a node names one. Said once here rather than per node.
 */
export function inheritableWorkflowPolicy(
  policy: ExecutionPolicy | undefined, diagnostics: string[],
): ExecutionPolicy | undefined {
  if (policy === undefined) return undefined;
  const { onFailure, timeoutMs, ...rest } = policy;
  if (onFailure === undefined && timeoutMs === undefined) return policy;
  diagnostics.push(
    'workflow settings: executionPolicy' +
    `${onFailure !== undefined ? '.onFailure' : ''}${timeoutMs !== undefined ? '.timeoutMs' : ''}` +
    ' is not inherited by every node — a failure chain and its deadline are declared on the node ' +
    'they govern, or on a group a node names. The rest of the workflow policy still applies.');
  return rest;
}

/** A group's policy from `settings.executionPolicy.groups`, by name. */
function groupPolicyOf(
  settings: unknown, group: string, diagnostics: string[],
): ExecutionPolicy | undefined {
  const entry = recordOf(fieldOf(fieldOf(fieldOf(settings, 'executionPolicy'), 'groups'), group));
  if (entry === undefined) return undefined;
  const parsed = parseExecutionPolicy({ v: POLICY_SCHEMA_VERSION, ...entry }, `group '${group}'`);
  diagnostics.push(...parsed.diagnostics);
  return parsed.policy;
}

/**
 * One node's resolved policy: workflow default, then the group it names, then its own — node
 * wins over group wins over workflow, per key.
 *
 * The group is named by the *node's* policy, so a node opts into a shared limit rather than a
 * workflow assigning one to it. That keeps the node readable on its own, which is the same
 * reason the policy sits on the node rather than in a settings map keyed by node name.
 *
 * `declared` is the node's raw `executionPolicy` carrier and `settings` the workflow's raw
 * settings, so the JSON path and the live path decide precedence in this one function.
 */
export function resolveNodePolicy(
  declared: unknown,
  nodeName: string,
  settings: unknown,
  workflowPolicy: ExecutionPolicy | undefined,
  diagnostics: string[],
): ExecutionPolicy | undefined {
  const parsed = parseExecutionPolicy(declared, `node '${nodeName}'`);
  diagnostics.push(...parsed.diagnostics);
  const own = parsed.policy;
  const group = own?.concurrency?.group ?? own?.rate?.group;
  const groupPolicy = group === undefined ? undefined : groupPolicyOf(settings, group, diagnostics);
  return mergePolicies(workflowPolicy, groupPolicy, own);
}

/** {@link resolveNodePolicy} for a live node: its `executionPolicy` against `workflow.settings`. */
export function nodePolicyOf(
  node: INode, workflow: Workflow, workflowPolicy: ExecutionPolicy | undefined, diagnostics: string[],
): ExecutionPolicy | undefined {
  return resolveNodePolicy(fieldOf(node, 'executionPolicy'), node.name, workflow.settings, workflowPolicy, diagnostics);
}

/**
 * The fields a node's resolved `policy` and its `parameters` contribute to its description:
 * the agent's round budget, where n8n keeps it, read by {@link readPositiveIntOption} (only a
 * literal counts), and the policy's `maxToolCalls`, which wins over the `options` path. The
 * live adapter and the verify CLI both build a node's description from this.
 */
export function policyFieldsOf(
  parameters: unknown, policy: ExecutionPolicy | undefined,
): Pick<NodeDescription, 'maxRounds' | 'maxToolCalls' | 'executionPolicy'> {
  // Computed once each so the spread below evaluates one read per field rather than two.
  const maxRounds = readPositiveIntOption(parameters, 'maxIterations');
  const maxToolCalls = policy?.maxToolCalls ?? readPositiveIntOption(parameters, 'maxToolCalls');
  return {
    ...(maxRounds === undefined ? {} : { maxRounds }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(policy === undefined ? {} : { executionPolicy: policy }),
  };
}
