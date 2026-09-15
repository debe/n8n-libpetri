/**
 * Execution policy: the behaviour a workflow declares, in the workflow's own vocabulary.
 *
 * Three layers, and a name belongs to exactly one of them (ADR 0009 §0):
 *
 * | layer | audience | vocabulary | lives in |
 * |---|---|---|---|
 * | 1. Workflow JSON | the author, the editor, any n8n engine | `onFailure`, `timeoutMs`, `concurrency` | `node.executionPolicy` |
 * | 2. Structural IR | this compiler, which never sees n8n | the same words, n8n-free | {@link ExecutionPolicy} |
 * | 3. Net encoding | gadget, codec, verifier | places, arcs, roles | `X/failed_i`, `PlaceRole` |
 *
 * This module is layer 2. It speaks layer 1's vocabulary — `retry`, `route`, `stop` — and
 * names neither n8n nor the net. The test the naming has to pass: **a workflow carrying this
 * JSON must stay meaningful if n8n's own stack scheduler runs it**, honouring what it can and
 * ignoring the rest. That is what forbids `petri`, `place`, `token` or a pattern-library word
 * such as "ladder" or "bulkhead" anywhere at layer 1.
 *
 * {@link FailureStep} is not a new concept: it is n8n's own `onError` generalised over
 * attempts. `stopWorkflow` / `continueErrorOutput` / `continueRegularOutput` are `stop` /
 * `route` / `continue`, and `retryOnFail` + `maxTries` + `waitBetweenTries` is the all-`retry`
 * case. One attempt-indexed list subsumes four existing n8n fields, which is the evidence the
 * abstraction sits at the right layer.
 *
 * **Forward compatibility is asymmetric, deliberately.** An unknown `v`, or an unknown key at a
 * known `v`, is a diagnostic and is ignored: a workflow saved by a newer build must still run
 * on an older one. A *malformed* value at a known `v` is an error, because it changes the net
 * that runs and a silently dropped policy is a workflow behaving differently from its
 * declaration.
 *
 * The field parsers live in `policy/` — the value checks (`values.ts`), the failure-action
 * vocabulary (`failure-action.ts`), the `onFailure` chain (`on-failure.ts`) and the admission
 * fields (`admission.ts`) — and accumulate onto the lists this module turns into one
 * {@link PolicyError}.
 */

import { parseConcurrency, parseRate } from './policy/admission.js';
import { parseOnFailure } from './policy/on-failure.js';
import { isRecord, positiveInt } from './policy/values.js';

// Published from here, where every importer has always found them.
export { isFailureAction, isTerminalAction } from './policy/failure-action.js';
export { nonNegativeInt, positiveInt } from './policy/values.js';

/** The schema version this build understands. Versions the policy, never the engine. */
export const POLICY_SCHEMA_VERSION = 1;

/**
 * What a step does when its attempt fails.
 *
 * - `retry` — wait `waitMs` and run the node again. The all-`retry` policy is `retryOnFail`.
 * - `route` — send the failure down a named output, leaving the execution running.
 * - `stop` — end the execution as failed. n8n then persists it as a failure and triggers
 *   `settings.errorWorkflow`, so the handoff needs no machinery of its own.
 * - `continue` — carry on down output 0 with n8n's own error-item substitution.
 */
export type FailureAction = 'retry' | 'route' | 'stop' | 'continue';

/**
 * One step of a failure policy. **Its index in the array is the attempt it governs.**
 *
 * A thrown error and an expired `timeoutMs` are the same event here: both are "this attempt
 * failed", and both take this step. Differentiating them would need a second failure place per
 * attempt and a rule covering the trigger a step does not name, so it is left to a later
 * schema version rather than half-built (ADR 0009).
 */
export type FailureStep =
  | {
    readonly action: 'route';
    /** Output name or index. Required by `route`, rejected on every other action. */
    readonly output: string | number;
    readonly waitMs?: never;
  }
  | {
    readonly action: 'retry';
    /** Delay before the step acts. `retry` only; ignored elsewhere. */
    readonly waitMs?: number;
  }
  | { readonly action: 'stop' | 'continue' };

/** A node's declared behaviour, merged from node, group and workflow scope. */
export interface ExecutionPolicy {
  /**
   * Deadline for **one attempt**, in milliseconds. Arms libpetri's output timeout (IO-013) on
   * that attempt's run transition: on expiry the firing is abandoned and the failure branch
   * receives the tokens instead, with anything the action wrote before expiry discarded along
   * with the firing (IO-013 AC5).
   *
   * Whether the node's own work stops is n8n's, not ours — IO-013 is explicit that cancelling
   * an abandoned action is "a capability, not a guarantee". The marking is correct either way;
   * what the late completion must not do is write to n8n behind the net's back, which is the
   * scheduler's abandonment guard rather than a compiler concern.
   */
  readonly timeoutMs?: number;
  /** Attempt-indexed failure handling. Mutually exclusive with n8n's `retryOnFail` / `onError`. */
  readonly onFailure?: readonly FailureStep[];
  /** Admission: at most `limit` activations of this node — or of its group — at once. */
  readonly concurrency?: { readonly group?: string; readonly limit: number };
  /** Rate: `burst` permits, refilled one per `perMs`. */
  readonly rate?: { readonly group?: string; readonly perMs: number; readonly burst: number };
  /** At most this many activations of the node in one execution. */
  readonly maxRuns?: number;
  /** An agent's tool-call budget. The carrier `parameters.options.maxToolCalls` cannot reach. */
  readonly maxToolCalls?: number;
  /** An agent's round budget, where n8n keeps it (`options.maxIterations`). */
  readonly maxRounds?: number;
}

/** A policy that failed validation. Names the node, so the message reads without context. */
export class PolicyError extends Error {
  constructor(readonly source: string, readonly problems: readonly string[]) {
    super(`${source}: invalid executionPolicy — ${problems.join('; ')}`);
    this.name = 'PolicyError';
  }
}

/** What {@link parseExecutionPolicy} produces: the policy, plus what it chose to ignore. */
export interface PolicyParse {
  readonly policy: ExecutionPolicy | undefined;
  readonly diagnostics: readonly string[];
}

// ==================== parsing (layer 1 -> layer 2) ====================

/** Keys a known `v` defines. Anything else is a diagnostic, never an error. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'v', 'timeoutMs', 'onFailure', 'concurrency', 'rate', 'maxRuns', 'maxToolCalls', 'maxRounds',
  // Known here so it is not diagnosed as unknown, but deliberately not parsed here: `groups`
  // holds one nested policy per name, and each is parsed on demand against the node that names
  // it (`groupPolicyOf` in `n8n/adapter.ts`, which the verify CLI reaches through the adapter's
  // `resolveNodePolicy`, so both paths resolve a group the same way). Without
  // this entry a workflow that uses groups was told on every compile that they were ignored,
  // which was the opposite of what happened.
  'groups',
]);

/**
 * One layer-1 policy object into the layer-2 IR.
 *
 * `where` names the source for messages (`node 'HTTP Request'`, `settings`), so a problem reads
 * without the caller re-wrapping it. Returns `undefined` for an absent or ignorable policy;
 * throws {@link PolicyError} for a malformed one at a known `v`.
 */
export function parseExecutionPolicy(raw: unknown, where: string): PolicyParse {
  const diagnostics: string[] = [];
  if (raw === undefined || raw === null) return { policy: undefined, diagnostics };
  if (!isRecord(raw)) throw new PolicyError(where, ['executionPolicy must be an object']);

  // An unknown `v` is the forward-compatibility case: a workflow saved by a newer build. Report
  // it and run the workflow without the policy rather than refusing to run it at all.
  const v = raw['v'];
  if (v !== POLICY_SCHEMA_VERSION) {
    diagnostics.push(
      `${where}: executionPolicy v=${JSON.stringify(v)} is not v${POLICY_SCHEMA_VERSION}; ignored`);
    return { policy: undefined, diagnostics };
  }

  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) diagnostics.push(`${where}: unknown executionPolicy key '${key}'; ignored`);
  }

  const timeoutMs = positiveInt(raw['timeoutMs'], `${where}.timeoutMs`, problems);
  const maxRuns = positiveInt(raw['maxRuns'], `${where}.maxRuns`, problems);
  const maxToolCalls = positiveInt(raw['maxToolCalls'], `${where}.maxToolCalls`, problems);
  const maxRounds = positiveInt(raw['maxRounds'], `${where}.maxRounds`, problems);
  const onFailure = parseOnFailure(raw['onFailure'], where, problems, diagnostics);
  const concurrency = parseConcurrency(raw['concurrency'], where, problems);
  const rate = parseRate(raw['rate'], where, problems);

  if (problems.length > 0) throw new PolicyError(where, problems);

  const policy: ExecutionPolicy = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onFailure === undefined ? {} : { onFailure }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(rate === undefined ? {} : { rate }),
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
  };
  return {
    policy: Object.keys(policy).length === 0 ? undefined : policy,
    diagnostics,
  };
}

/**
 * Node wins over group wins over workflow default, per key.
 *
 * Shallow by key rather than deep: a node that declares `onFailure` replaces the workflow's
 * list outright instead of merging step by step, because a half-inherited escalation chain is
 * not something an author can reason about.
 */
export function mergePolicies(
  ...layers: readonly (ExecutionPolicy | undefined)[]
): ExecutionPolicy | undefined {
  let merged: ExecutionPolicy | undefined;
  for (const layer of layers) {
    if (layer === undefined) continue;
    merged = { ...(merged ?? {}), ...layer };
  }
  return merged;
}
