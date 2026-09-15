/**
 * The `AnalysedNode` of every node, assembled from the phases before it: agent budgets, the
 * resolved failure chain (ADR 0009) and the input-side form.
 */
import { resolveFailureChain } from '../failure-chain.js';
import type { AnalysedNode, EdgeRef, ResolvedReference } from '../types.js';
import { joinFormOf } from './inputs.js';
import { requirePositiveInt, type RawNode } from './validate.js';

/** What the earlier phases found, per node. */
export interface NodeFacts {
  readonly raws: readonly RawNode[];
  readonly toolsOf: ReadonlyMap<string, readonly string[]>;
  readonly agentsOf: ReadonlyMap<string, readonly string[]>;
  readonly incoming: ReadonlyMap<string, readonly EdgeRef[]>;
  readonly outgoing: ReadonlyMap<string, readonly EdgeRef[]>;
  readonly referencesOf: ReadonlyMap<string, readonly ResolvedReference[]>;
  readonly deadInputsOf: ReadonlyMap<string, readonly number[]>;
  /** Seed of `A/rounds` for an agent that declares no static `maxIterations`. */
  readonly fallbackRounds: number;
  /** Seed of `A/calls` for an agent that declares no `maxToolCalls`. */
  readonly defaultCalls: number;
}

/** The analysed nodes in canvas order, and by name. */
export function assembleNodes(
  { raws, toolsOf, agentsOf, incoming, outgoing, referencesOf, deadInputsOf, fallbackRounds, defaultCalls }: NodeFacts,
  diagnostics: string[],
): { readonly analysed: readonly AnalysedNode[]; readonly byName: ReadonlyMap<string, AnalysedNode> } {
  const analysed: AnalysedNode[] = [];
  const byName = new Map<string, AnalysedNode>();
  for (const r of raws) {
    const tools = toolsOf.get(r.node.name) ?? [];
    const isAgent = tools.length > 0;
    const declared = r.node.maxRounds;
    if (isAgent && declared !== undefined) requirePositiveInt(declared, `node '${r.node.name}' maxRounds`, r.node.name);
    if (isAgent && declared === undefined) {
      diagnostics.push(
        `agent '${r.node.name}' does not declare a static maxIterations; A/rounds is seeded with ` +
        `${fallbackRounds} and the agent counts as unbounded for verification`);
    }
    const declaredCalls = r.node.maxToolCalls;
    if (isAgent && declaredCalls !== undefined) {
      requirePositiveInt(declaredCalls, `node '${r.node.name}' maxToolCalls`, r.node.name);
    }
    const connectedOutputs = new Set((outgoing.get(r.node.name) ?? []).map((e) => e.outputIndex));
    const failure = resolveFailureChain(
      r.node, r.shape, r.outputCount, r.errorOutputIndex, connectedOutputs, diagnostics);
    const isTool = agentsOf.has(r.node.name);
    const deadInputs = deadInputsOf.get(r.node.name)!;
    const form = joinFormOf({ isTool, deadInputs, requiredInputs: r.requiredInputs }, incoming.get(r.node.name)!);
    const a: AnalysedNode = {
      node: r.node, shape: r.shape, index: r.index, outputCount: r.outputCount,
      errorOutputIndex: r.errorOutputIndex, onError: r.onError, retry: r.retry,
      references: referencesOf.get(r.node.name)!,
      allRequired: r.allRequired, requiredInputs: r.requiredInputs, deadInputs,
      isTool, form,
      tools,
      maxRounds: isAgent ? (declared ?? fallbackRounds) : null,
      roundsAssumed: isAgent && declared === undefined,
      maxToolCalls: isAgent ? (declaredCalls ?? defaultCalls) : null,
      toolCallsAssumed: isAgent && declaredCalls === undefined,
      failure,
    };
    analysed.push(a);
    byName.set(r.node.name, a);
  }
  return { analysed, byName };
}
