/**
 * The compiler's errors, typed. Every message is the text it always was — the suites, the
 * verifier's CLI and the conformance differ read messages — so the class and `code` add a
 * machine-readable reason beside the sentence rather than replacing it.
 *
 * {@link PolicyError} (`policy.ts`) stays what it is: a malformed `executionPolicy`, with the
 * list of problems it found.
 */
import type { CompileProfile } from './types/analysis.js';

/**
 * Why the compiler refused a description, or a lookup on what it compiled:
 * - `invalid-budget`: `options.budget` is not a positive integer;
 * - `invalid-options`: options that contradict each other (agent budgets beside a precomputed
 *   analysis, a structural hash without its analysis, a precomputed analysis of another
 *   profile), an unknown profile, or a v1 option under the `engineV2` profile (a budget, an
 *   agent budget);
 * - `empty-workflow`: no nodes at all;
 * - `duplicate-node-name` / `duplicate-node-id`: two nodes share a name or an id;
 * - `empty-node-id` / `invalid-node-id`: an id that cannot be a MOD-010 prefix (empty, or
 *   containing the `/` separator);
 * - `no-start-node` / `unknown-start-node`: no start node declared, or one the workflow lacks;
 * - `unknown-connection-node`, `output-index-out-of-range`, `input-index-out-of-range`: a main
 *   connection naming a node or a port the workflow does not have;
 * - `unknown-tool-connection-node`: an `ai_tool` connection naming a node the workflow lacks;
 * - `invalid-count`: a port count or an agent budget that is not the integer it must be;
 * - `no-ready-place`: a marking asked for a `ready` place the input's form does not have;
 * - `tool-start-node`: the start node is an `ai_tool` node, which only its agent can reach;
 * - `unknown-node` / `unknown-transition`: a `NetMap` lookup of a name the net does not have.
 *
 * Under the `engineV2` profile, the shapes engine v2 refuses (`analysis/engine-v2/shape.ts`,
 * each citing its n8n throw site):
 * - `v2-trigger-count`: other than exactly one start node, v2's one `trigger` step
 *   (`validateExecutableGraph`);
 * - `v2-unbatched-cycle`: a cycle with no batch node (`UnsupportedCycleError` in
 *   `markBackEdges`, rule 1 of `validateLoops`);
 * - `v2-loop-shape`: a batch loop that breaks a `validateLoops` rule, or a cycle not entered
 *   through exactly one batch node (`UnsupportedLoopEntryError`); the message names the rule;
 * - `v2-converging-input`: more than one non-back edge into one input slot
 *   (`validateExecutableGraph`);
 * - `v2-unreachable-feeder`: an edge into a node the trigger reaches from one it cannot
 *   (`validateExecutableGraph`).
 *
 * and the nodes it refuses (`analysis/engine-v2/nodes.ts`):
 * - `v2-continue-error-output`: a node with `onError: 'continueErrorOutput'` (`toGraphNode`);
 * - `v2-merge-mode`: a Merge in mode chooseBranch (`assertSupportedMergeMode`);
 * - `v2-disabled-node`: a disabled node the trigger reaches, which n8n splices out
 *   (`spliceOutDisabledNodes`) and the profile does not port yet;
 * - `v2-unsupported-step`: a `wait` or `subworkflow` step, which v2 has no executor for
 *   (`StepReadyHandler.executorFor`) and so never settles.
 *
 * A slot above v2's `MAX_SLOT_INDEX` is `output-index-out-of-range` / `input-index-out-of-range`.
 */
export type CompileErrorCode =
  | 'invalid-budget'
  | 'invalid-options'
  | 'empty-workflow'
  | 'duplicate-node-name'
  | 'duplicate-node-id'
  | 'empty-node-id'
  | 'invalid-node-id'
  | 'no-start-node'
  | 'unknown-start-node'
  | 'unknown-connection-node'
  | 'output-index-out-of-range'
  | 'input-index-out-of-range'
  | 'unknown-tool-connection-node'
  | 'invalid-count'
  | 'no-ready-place'
  | 'tool-start-node'
  | 'tool-main-consumer'
  | 'unknown-node'
  | 'unknown-transition'
  | 'v2-trigger-count'
  | 'v2-unbatched-cycle'
  | 'v2-loop-shape'
  | 'v2-converging-input'
  | 'v2-unreachable-feeder'
  | 'v2-continue-error-output'
  | 'v2-merge-mode'
  | 'v2-disabled-node'
  | 'v2-unsupported-step';

/**
 * A description the compiler cannot compile, or a question about the compiled net it cannot
 * answer. `node` names the node the refusal is about, when there is one — also a node the
 * workflow lacks, e.g. an unknown start node.
 */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  readonly node?: string;

  constructor(code: CompileErrorCode, message: string, node?: string) {
    super(message);
    this.name = 'CompileError';
    this.code = code;
    if (node !== undefined) this.node = node;
  }
}

/**
 * A broken invariant of the compiler itself (the `internal:` family): the analysis, the gadget
 * and the flat net disagree. Never the workflow's fault, so it has no code to act on; the
 * message says which invariant failed.
 */
export class InternalCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalCompilerError';
  }
}

/**
 * A net compiled for one profile handed to a consumer written for another
 * (`tasks/v2-profile-plan.md` decision 14). The scheduler, the marking codec, the deposit rule
 * and the verifier's families read `NodeGadget`s, `_budget` and `_pause`; an `engineV2` net has
 * none of them, so they refuse it at entry instead of reading a v1 view that is not there.
 *
 * Not an {@link InternalCompilerError}: the compiler built what it was asked for, and the caller
 * passed it to the wrong consumer. The NetMap's own v1 accessors, which only a consumer past
 * such a check can reach, throw that one instead.
 */
export class ProfileMismatchError extends Error {
  /** The entry point that refused, e.g. `encodeMarking`. */
  readonly consumer: string;
  readonly expected: CompileProfile;
  readonly actual: CompileProfile;

  constructor(consumer: string, expected: CompileProfile, actual: CompileProfile) {
    super(`${consumer}: needs a net compiled for the '${expected}' profile, got one compiled for '${actual}'`);
    this.name = 'ProfileMismatchError';
    this.consumer = consumer;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Throws {@link ProfileMismatchError} unless `actual` is `expected`: the entry check of a profile-bound consumer. */
export function assertProfile(consumer: string, expected: CompileProfile, actual: CompileProfile): void {
  if (actual !== expected) throw new ProfileMismatchError(consumer, expected, actual);
}
