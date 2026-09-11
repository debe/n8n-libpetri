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
 */

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
export interface FailureStep {
  /** Delay before the step acts. `retry` only; ignored elsewhere. */
  readonly waitMs?: number;
  readonly action: FailureAction;
  /** Output name or index. Required by `route`, rejected on every other action. */
  readonly output?: string | number;
}

/** `retry` continues the chain; everything else ends the activation. */
export function isTerminalAction(action: FailureAction): boolean {
  return action !== 'retry';
}

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

const ACTIONS: ReadonlySet<string> = new Set<FailureAction>(['retry', 'route', 'stop', 'continue']);

/** Keys a known `v` defines. Anything else is a diagnostic, never an error. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'v', 'timeoutMs', 'onFailure', 'concurrency', 'rate', 'maxRuns', 'maxToolCalls', 'maxRounds',
]);
const KNOWN_STEP_KEYS: ReadonlySet<string> = new Set(['waitMs', 'action', 'output']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A positive integer, or `undefined`. Anything else is a problem the caller records. */
function positiveInt(v: unknown, what: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    problems.push(`${what} must be a positive integer, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

/** A non-negative integer, or `undefined`. `waitMs: 0` is a legitimate "retry at once". */
function nonNegativeInt(v: unknown, what: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    problems.push(`${what} must be a non-negative integer, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function parseStep(
  raw: unknown, index: number, problems: string[], diagnostics: string[], where: string,
): FailureStep | undefined {
  const at = `${where}.onFailure[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${at} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_STEP_KEYS.has(key)) diagnostics.push(`${at}: unknown key '${key}'; ignored`);
  }

  const action = raw['action'];
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    problems.push(`${at}.action must be one of ${[...ACTIONS].join(', ')}, got ${JSON.stringify(action)}`);
    return undefined;
  }

  const waitMs = nonNegativeInt(raw['waitMs'], `${at}.waitMs`, problems);
  if (waitMs !== undefined && action !== 'retry') {
    diagnostics.push(`${at}: waitMs is meaningful only on 'retry'; ignored for '${action}'`);
  }

  // `output` is required by `route` and rejected elsewhere: a `stop` carrying an output is a
  // policy whose author expected routing, and honouring the stop silently would hide that.
  const output = raw['output'];
  if (action === 'route') {
    if (typeof output !== 'string' && typeof output !== 'number') {
      problems.push(`${at}.output is required by action 'route' (an output name or index)`);
      return undefined;
    }
    if (typeof output === 'number' && (!Number.isInteger(output) || output < 0)) {
      problems.push(`${at}.output must be a non-negative integer index, got ${JSON.stringify(output)}`);
      return undefined;
    }
  } else if (output !== undefined) {
    problems.push(`${at}.output is only valid on action 'route', not '${action}'`);
    return undefined;
  }

  return {
    ...(waitMs === undefined || action !== 'retry' ? {} : { waitMs }),
    action: action as FailureAction,
    ...(action === 'route' ? { output: output as string | number } : {}),
  };
}

function parseGroupRef(
  raw: Record<string, unknown>, at: string, problems: string[],
): string | undefined {
  const group = raw['group'];
  if (group === undefined) return undefined;
  if (typeof group !== 'string' || group === '') {
    problems.push(`${at}.group must be a non-empty string`);
    return undefined;
  }
  return group;
}

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

  let onFailure: FailureStep[] | undefined;
  const rawSteps = raw['onFailure'];
  if (rawSteps !== undefined) {
    if (!Array.isArray(rawSteps)) {
      problems.push(`${where}.onFailure must be an array of steps`);
    } else if (rawSteps.length === 0) {
      problems.push(`${where}.onFailure must name at least one step`);
    } else {
      const steps: FailureStep[] = [];
      rawSteps.forEach((step, i) => {
        const parsed = parseStep(step, i, problems, diagnostics, where);
        if (parsed !== undefined) steps.push(parsed);
      });
      // The chain runs to its first terminal step. A chain of nothing but `retry` never ends
      // an activation and would strand the last attempt's failure, so it is an error. Steps
      // *after* the first terminal are merely unreachable, which is a diagnostic: rejecting
      // them would refuse a workflow whose author simply listed one escalation too many.
      const terminal = steps.findIndex((step) => isTerminalAction(step.action));
      if (steps.length === rawSteps.length) {
        if (terminal < 0) {
          problems.push(
            `${where}.onFailure is all 'retry', so the last attempt's failure has nowhere to go; ` +
            "end the chain with 'route', 'stop' or 'continue'");
        } else {
          if (terminal < steps.length - 1) {
            const first = terminal + 1;
            const last = steps.length - 1;
            const which = first === last ? `step ${first}` : `steps ${first}..${last}`;
            diagnostics.push(
              `${where}.onFailure: step ${terminal} ('${steps[terminal]!.action}') ends the ` +
              `activation, so ${which} cannot be reached; ignored`);
          }
          onFailure = steps.slice(0, terminal + 1);
        }
      }
    }
  }

  let concurrency: ExecutionPolicy['concurrency'];
  const rawConcurrency = raw['concurrency'];
  if (rawConcurrency !== undefined) {
    if (!isRecord(rawConcurrency)) {
      problems.push(`${where}.concurrency must be an object`);
    } else {
      const limit = positiveInt(rawConcurrency['limit'], `${where}.concurrency.limit`, problems);
      const group = parseGroupRef(rawConcurrency, `${where}.concurrency`, problems);
      if (limit === undefined) problems.push(`${where}.concurrency.limit is required`);
      else concurrency = { ...(group === undefined ? {} : { group }), limit };
    }
  }

  let rate: ExecutionPolicy['rate'];
  const rawRate = raw['rate'];
  if (rawRate !== undefined) {
    if (!isRecord(rawRate)) {
      problems.push(`${where}.rate must be an object`);
    } else {
      const perMs = positiveInt(rawRate['perMs'], `${where}.rate.perMs`, problems);
      const burst = positiveInt(rawRate['burst'], `${where}.rate.burst`, problems);
      const group = parseGroupRef(rawRate, `${where}.rate`, problems);
      if (perMs === undefined || burst === undefined) {
        problems.push(`${where}.rate requires both perMs and burst`);
      } else {
        rate = { ...(group === undefined ? {} : { group }), perMs, burst };
      }
    }
  }

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

// ==================== the behaviour registry (layer 2 -> 3) ====================

/**
 * How far a declared behaviour has been taken.
 *
 * `registered` is the bar for the editor: schema, encoding, a declared verification property
 * and a measured state-space cost all exist. `planned` parses and is reported as unverified,
 * so a JSON author is never silently ignored and never silently over-promised.
 */
export type BehaviourStatus = 'registered' | 'planned';

export interface BehaviourEntry {
  readonly behaviour: string;
  readonly status: BehaviourStatus;
  /** What the verifier is asked, and so what a `proven` licenses. */
  readonly property: string | null;
  /** One line on the encoding, for the report and for whoever adds the next one. */
  readonly encoding: string;
}

/**
 * The registry. Keyed by the layer-1 behaviour, holding the layer-3 note — which is the only
 * place the two vocabularies are allowed to meet.
 */
export const BEHAVIOURS: readonly BehaviourEntry[] = [
  {
    behaviour: 'onFailure',
    status: 'registered',
    property: 'placeBound(X/failed_i, 1) per attempt; proper completion over the finite chain',
    encoding: 'an unrolled per-attempt chain: X/running_i to X/failed_i to the step arm',
  },
  {
    behaviour: 'timeoutMs',
    status: 'registered',
    property: null,
    encoding: 'libpetri output timeout (IO-013) on X_run_i, failing into X/failed_i',
  },
  {
    behaviour: 'concurrency',
    status: 'planned',
    property: 'placeBound(g/slots, n) and the semiflow slots + sum(running) = n',
    encoding: 'a scoped _budget: g/slots taken by X_start, refunded by X_done',
  },
  {
    behaviour: 'maxRuns',
    status: 'planned',
    property: 'placeBound(X/runs, N)',
    encoding: 'A/calls generalised: one unit per X_start, refunded by nothing',
  },
  {
    behaviour: 'rate',
    status: 'planned',
    property: 'placeBound(bucket, burst) and the semiflow bucket + bucket_free = burst',
    encoding: 'a complementary pair with a refill gated on a demand read arc (ADR 0009 section 4)',
  },
];

/** Behaviours a policy declares that are parsed but not yet encoded. For the report. */
export function plannedBehavioursOf(policy: ExecutionPolicy): readonly string[] {
  const planned = new Set(BEHAVIOURS.filter((b) => b.status === 'planned').map((b) => b.behaviour));
  return Object.keys(policy).filter((k) => planned.has(k));
}
