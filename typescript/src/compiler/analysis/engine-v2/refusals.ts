/**
 * Every place n8n refuses a workflow on its way to an engine v2 graph, and the `CompileError`
 * code the `engineV2` profile refuses it with (`tasks/v2-profile-plan.md` decision 11, step 13).
 *
 * The throw sites are those of the pin `n8n@2.41.3`:
 * - `v1-workflow-converter.ts` (`@n8n/node-engine-compatibility` `src/`): `V1WorkflowConverter`
 *   and `toBatchConfig`, ported in `root.ts` and `nodes.ts`;
 * - `loops.ts` (`@n8n/engine` `src/graph/`): `validateLoops`, ported in `shape.ts`;
 * - `validate-executable-graph.ts` (`@n8n/engine` `src/graph/`): `validateExecutableGraph`,
 *   ported in `shape.ts`.
 *
 * {@link V2_REFUSALS} is not documentation beside the code: every engine v2 refusal the analysis
 * raises goes through {@link refuseV2} with its entry, so the code a site maps to is the code it
 * throws. `tasks/v2-acceptance.mts` is the drift guard: it reads the three sources, finds every
 * `throw new X(` and requires each to match exactly one entry here by file, class and
 * {@link V2Refusal.match}, and each entry to match exactly one site — so a throw site n8n adds,
 * moves or rewords fails the guard until it is mapped.
 *
 * An entry with no codes is a throw that cannot fire on a graph the port produces: the
 * converter never emits it, or a step before it already refused (the comment says which). The
 * port still checks the predicate where n8n does, as an `InternalCompilerError`, so a broken
 * invariant is a compiler bug and never a silent accept.
 */
import { CompileError, InternalCompilerError } from '../../errors.js';
import type { CompileErrorCode } from '../../errors.js';

/** The n8n source a throw site is in, by file name (unique across the three). */
export type V2RefusalFile = 'v1-workflow-converter.ts' | 'loops.ts' | 'validate-executable-graph.ts';

/** One n8n throw site and what the `engineV2` profile raises for it. */
export interface V2Refusal {
  readonly file: V2RefusalFile;
  /** The n8n function the `throw` is in. */
  readonly fn: string;
  /** The class n8n throws. */
  readonly error: string;
  /**
   * A fragment of the throw's source text, unique among the file's throw sites of {@link error}:
   * the drift guard matches sites on it. For a class n8n throws at several sites it is also a
   * fragment of the message thrown, so a thrown error names its site by class and message
   * ({@link v2RefusalOf}).
   */
  readonly match: string;
  /**
   * The codes the profile refuses with: one, except the slot rule, which names the output or the
   * input side. Empty: unreachable on the port's input (see the module doc).
   */
  readonly codes: readonly CompileErrorCode[];
}

const converter = (fn: string, error: string, match: string, ...codes: CompileErrorCode[]): V2Refusal =>
  ({ file: 'v1-workflow-converter.ts', fn, error, match, codes });
const loops = (error: string, match: string, ...codes: CompileErrorCode[]): V2Refusal =>
  ({ file: 'loops.ts', fn: 'validateLoops', error, match, codes });
const executable = (error: string, match: string, ...codes: CompileErrorCode[]): V2Refusal =>
  ({ file: 'validate-executable-graph.ts', fn: 'validateExecutableGraph', error, match, codes });

/** Every throw site, keyed by the name the port refers to it by. */
export const V2_REFUSALS = {
  // ---- V1WorkflowConverter.resolveFiredTrigger ----
  unknownTrigger: converter('resolveFiredTrigger', 'UnknownTriggerError', 'UnknownTriggerError(firedTriggerName)', 'v2-unknown-trigger'),
  notATrigger: converter('resolveFiredTrigger', 'NotATriggerError', 'NotATriggerError(fired.name', 'v2-not-a-trigger'),
  ambiguousTrigger: converter('resolveFiredTrigger', 'AmbiguousTriggerError', 'AmbiguousTriggerError(triggers', 'v2-ambiguous-trigger'),
  // ---- toGraphNode, assertSupportedMergeMode, toBatchConfig ----
  continueErrorOutput: converter('toGraphNode', 'UnsupportedWorkflowError', 'onError=continueErrorOutput', 'v2-continue-error-output'),
  mergeChooseBranch: converter('assertSupportedMergeMode', 'UnsupportedWorkflowError', 'uses Merge mode "chooseBranch"', 'v2-merge-mode'),
  mergeExpressionMode: converter('assertSupportedMergeMode', 'UnsupportedWorkflowError', 'sets its Merge mode with an expression', 'v2-merge-mode'),
  batchVersion: converter('toBatchConfig', 'UnsupportedWorkflowError', 'is a Split In Batches of version', 'v2-batch-config'),
  batchOptionsExpression: converter('toBatchConfig', 'UnsupportedWorkflowError', 'sets its options from an expression', 'v2-batch-config'),
  batchReset: converter('toBatchConfig', 'UnsupportedWorkflowError', 'uses the reset option', 'v2-batch-config'),
  batchSizeExpression: converter('toBatchConfig', 'UnsupportedWorkflowError', 'sets its batch size from an expression', 'v2-batch-config'),
  batchSizeInvalid: converter('toBatchConfig', 'UnsupportedWorkflowError', 'must be a whole number of at least 1', 'v2-batch-config'),
  // ---- validateSupportedConnectionType (toEdgesForSource) ----
  connectionType: converter('validateSupportedConnectionType', 'UnsupportedConnectionTypeError', 'UnsupportedConnectionTypeError(nodeName', 'v2-connection-type'),
  // ---- markBackEdges → resolveSingleBatchEntry ----
  unbatchedCycle: converter('resolveSingleBatchEntry', 'UnsupportedCycleError', 'UnsupportedCycleError(toNames(members))', 'v2-unbatched-cycle'),
  loopEntry: converter('resolveSingleBatchEntry', 'UnsupportedLoopEntryError', 'UnsupportedLoopEntryError(toNames(members)', 'v2-loop-shape'),

  // ---- validateLoops (graph/loops.ts) ----
  // The converter's ids are n8n's node ids (a description's are unique by `analyse()`'s own
  // check) and its edges join the nodes it keeps.
  duplicateId: loops('GraphValidationError', 'Two nodes share the id'),
  unknownEndpoint: loops('GraphValidationError', 'which is not a node in the graph'),
  forwardCycle: loops('GraphValidationError', 'form a cycle with no back-edge to close it', 'v2-unbatched-cycle'),
  noBackEdge: loops('GraphValidationError', 'has no back-edge returning to it', 'v2-loop-shape'),
  // `markBackEdges` marks only edges into a batch entry, from the entry's own component.
  notBatchTarget: loops('GraphValidationError', 'has a back-edge returning to it but is not a batch node'),
  // `toBatchConfig` already refused a batch node without a whole batch size.
  noBatchSize: loops('GraphValidationError', 'has no batch size'),
  triggerInLoop: loops('GraphValidationError', 'is inside the loop of', 'v2-loop-shape'),
  nestedLoop: loops('UnimplementedError', 'nested loops are not supported yet', 'v2-loop-shape'),
  backEdgeSlot: loops('GraphValidationError', "returns feed the batch node's slot 0", 'v2-loop-shape'),
  backEdgeFromOutside: loops('GraphValidationError', 'returns from outside the loop'),
  severalBackEdges: loops('UnimplementedError', 'back-edges; multiple returns converge', 'v2-loop-shape'),
  batchInputSlot: loops('GraphValidationError', 'of a batch node, which has only slot 0', 'v2-loop-shape'),
  batchOutputSlot: loops('GraphValidationError', 'which has only done (0) and loop (1)', 'v2-loop-shape'),
  severalEntries: loops('UnimplementedError', 'entry edges; converging entries', 'v2-loop-shape'),
  midBodyExit: loops('UnimplementedError', 'mid-body; dangling body branches', 'v2-loop-shape'),
  loopSlotExit: loops('GraphValidationError', 'leaves the loop from the loop slot', 'v2-loop-shape'),
  doneFeedsMember: loops('GraphValidationError', 'a member of its own loop', 'v2-loop-shape'),
  midBodyEntry: loops('GraphValidationError', 'the batch node is the only way in', 'v2-loop-shape'),

  // ---- validateExecutableGraph (graph/validate-executable-graph.ts) ----
  noTrigger: executable('GraphValidationError', 'Graph has no trigger node to start from', 'v2-trigger-count'),
  // The converter makes exactly the fired trigger a `trigger` step.
  severalTriggers: executable('GraphValidationError', 'Graph must have exactly one trigger node'),
  unreachableFeeder: executable('GraphValidationError', 'feeds a node the trigger reaches from one it cannot reach', 'v2-unreachable-feeder'),
  slotNotNonNegative: executable('GraphValidationError', 'slot indices are non-negative integers',
    'output-index-out-of-range', 'input-index-out-of-range'),
  slotAboveMax: executable('GraphValidationError', 'slot indices above',
    'output-index-out-of-range', 'input-index-out-of-range'),
  convergingInput: executable('UnimplementedError', 'converging branches on one slot', 'v2-converging-input'),
} as const satisfies Record<string, V2Refusal>;

export type V2RefusalSite = keyof typeof V2_REFUSALS;

/**
 * Raises what the profile raises for `site`: a `CompileError` with `code` (default the site's
 * first), or an `InternalCompilerError` when the site cannot fire on the port's input.
 */
export function refuseV2(
  site: V2RefusalSite, message: string, node?: string, code?: CompileErrorCode,
): never {
  const entry: V2Refusal = V2_REFUSALS[site];
  const chosen = code ?? entry.codes[0];
  if (chosen === undefined) {
    throw new InternalCompilerError(`internal: engineV2 reached n8n's ${entry.error} in ${entry.fn} (${entry.file}), ` +
      `which the converter port rules out: ${message}`);
  }
  if (!entry.codes.includes(chosen)) {
    throw new InternalCompilerError(`internal: ${chosen} is not a code of ${entry.fn}'s ${entry.error} (${entry.file})`);
  }
  throw new CompileError(chosen, `compile: ${message}`, node);
}

/**
 * The site an error n8n threw comes from: by its class when one site throws it, else by the
 * site whose {@link V2Refusal.match} its message contains. `undefined` for an error no site
 * throws — a class or message this map does not know, which is drift.
 */
export function v2RefusalOf(errorClass: string, message: string): V2RefusalSite | undefined {
  const sites = (Object.keys(V2_REFUSALS) as V2RefusalSite[]).filter((k) => V2_REFUSALS[k].error === errorClass);
  if (sites.length === 1) return sites[0];
  const hits = sites.filter((k) => message.includes(V2_REFUSALS[k].match));
  return hits.length === 1 ? hits[0] : undefined;
}
