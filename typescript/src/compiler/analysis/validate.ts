/**
 * The first phase of `analyse()`: node names and ids unique, ids valid MOD-010 prefixes, the
 * start nodes known, canvas order, and each node's shape, retry parameters and existing
 * references read once.
 */
import { CompileError } from '../errors.js';
import { retryParamsOf } from '../failure-chain.js';
import { nonNegativeInt, positiveInt } from '../policy.js';
import type { NodeDescription, NodeTypeShape, OnError, RetryParams, WorkflowDescription } from '../types.js';
import { isAllRequired, requiredInputsOf } from './inputs.js';

function compareCanvas(a: NodeDescription, b: NodeDescription): number {
  const [ax, ay] = a.position;
  const [bx, by] = b.position;
  if (ay !== by) return ay - by;
  if (ax !== bx) return ax - bx;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * `policy.ts`'s collecting integer check, raised at once: the analysis has no problem list
 * to accumulate into, and a bad count is a description it cannot compile at all.
 */
export function raising(
  check: (v: unknown, what: string, problems: string[]) => number | undefined,
): (v: number, what: string, node?: string) => void {
  return (v, what, node) => {
    const problems: string[] = [];
    check(v, what, problems);
    const [problem] = problems;
    if (problem !== undefined) throw new CompileError('invalid-count', problem, node);
  };
}
export const requireNonNegativeInt = raising(nonNegativeInt);
export const requirePositiveInt = raising(positiveInt);

export interface RawNode {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
  readonly index: number;
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly onError: OnError;
  readonly retry: RetryParams | null;
  /** Existing referenced nodes, resolver order, no duplicates, self included (classified later). */
  readonly rawReferences: readonly string[];
  readonly allRequired: boolean;
  readonly requiredInputs: readonly number[] | null;
}

/** The validated nodes in canvas order, and the canonical start list. */
export interface ValidatedNodes {
  readonly primaryStart: string;
  readonly startNodes: readonly string[];
  readonly raws: readonly RawNode[];
  readonly rawByName: ReadonlyMap<string, RawNode>;
}

/** Validates the nodes and start nodes and reads every node's shape, in canvas order. */
export function validateNodes(workflow: WorkflowDescription, diagnostics: string[]): ValidatedNodes {
  // ---- nodes: uniqueness, prefix validity, canvas order ----
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const n of workflow.nodes) {
    if (names.has(n.name)) throw new CompileError('duplicate-node-name', `compile: duplicate node name '${n.name}'`, n.name);
    names.add(n.name);
    if (n.id.length === 0) throw new CompileError('empty-node-id', `compile: node '${n.name}' has an empty id`, n.name);
    if (n.id.includes('/')) {
      throw new CompileError(
        'invalid-node-id', `compile: node '${n.name}' id '${n.id}' contains '/', the MOD-010 prefix separator`, n.name);
    }
    if (ids.has(n.id)) throw new CompileError('duplicate-node-id', `compile: duplicate node id '${n.id}'`, n.name);
    ids.add(n.id);
  }
  const declaredStarts = workflow.startNodes ?? (workflow.startNode === undefined ? [] : [workflow.startNode]);
  if (declaredStarts.length === 0) throw new CompileError('no-start-node', 'compile: workflow declares no start node');
  for (const s of declaredStarts) {
    if (!names.has(s)) throw new CompileError('unknown-start-node', `compile: start node '${s}' is not in the workflow`, s);
  }
  const ordered = [...workflow.nodes].sort(compareCanvas);
  // Canonical start list: the primary first (it alone is seeded by initialMarking), the
  // rest in canvas order, so the same set hashes alike whatever order it was listed in.
  const primaryStart = declaredStarts[0]!;
  const startSet = new Set(declaredStarts);
  const startNodes = [primaryStart, ...ordered.map((n) => n.name).filter((n) => n !== primaryStart && startSet.has(n))];

  const raws: RawNode[] = [];
  const rawByName = new Map<string, RawNode>();
  ordered.forEach((node, index) => {
    const shape = workflow.nodeTypes(node);
    requireNonNegativeInt(shape.inputCount, `node '${node.name}' inputCount`, node.name);
    requireNonNegativeInt(shape.outputCount, `node '${node.name}' outputCount`, node.name);
    const onError: OnError = node.onError ?? 'stopWorkflow';
    const errorOutputIndex = onError === 'continueErrorOutput' ? shape.outputCount : null;
    const retry = node.retryOnFail === true ? retryParamsOf(node) : null;
    const rawReferences: string[] = [];
    for (const ref of workflow.expressionReferences?.(node) ?? []) {
      if (!names.has(ref)) {
        diagnostics.push(`node '${node.name}' references unknown node '${ref}'; ignored`);
        continue;
      }
      if (!rawReferences.includes(ref)) rawReferences.push(ref);
    }
    const r: RawNode = {
      node, shape, index,
      outputCount: shape.outputCount + (errorOutputIndex === null ? 0 : 1),
      errorOutputIndex, onError, retry,
      rawReferences, allRequired: isAllRequired(shape), requiredInputs: requiredInputsOf(shape),
    };
    raws.push(r);
    rawByName.set(node.name, r);
  });
  return { primaryStart, startNodes, raws, rawByName };
}
