/**
 * `analyse()` under the `engineV2` profile (`tasks/v2-profile-plan.md` step 4). The v1 phases
 * that model `WorkflowExecute` have no counterpart in engine v2 and are not run:
 *
 * - expression references: v2 orders a step after its incoming edges only; a `$('Y')` read
 *   does not delay it (the race is a recorded divergence, step 14);
 * - dead inputs and `requiredInputs`: v2 queues a node once every incoming edge is decided and
 *   one is live (`decideSuccessors`, `execution/settlement.ts`), whatever the node declares;
 * - skip observers: v2 announces every skip (`step:settled` for a skipped row), so there is no
 *   subset of nodes that must hear of one;
 * - `ai_tool` wiring: the converter roots the graph at the trigger through `main` only
 *   (`rootAt`, `v1-workflow-converter.ts`), so sub-nodes never become steps, and an agent fails
 *   at its first tool call (`EngineRequestNotSupportedError`, `v1-step-executor.ts`);
 * - depth: v2 has no ordering priority, so every node sits at depth 0;
 * - k-safety: v2 has no concurrency budget (`compile/options.ts` refuses one);
 * - retry and the failure policy: v2 has no retry (`api.types.ts`: "has no retry mechanism"),
 *   and a failed step fails the execution (decision 8).
 *
 * A node that declares one of those is diagnosed, never silently read. What replaces them is
 * n8n's own pipeline: the port of its converter (`root.ts`, with the node checks of `nodes.ts`)
 * builds the graph n8n's engine would get — rooted at the fired trigger, disabled nodes spliced
 * out, back edges marked — or refuses as the converter does; the validator's refusals
 * (`shape.ts`) run on that graph; and the analysis, the loops and the compiled node set of
 * decision 9 are that graph's. A node the converter drops is diagnosed, never compiled.
 */
import { CompileError, InternalCompilerError } from '../../errors.js';
import type { AnalysedNode, EdgeRef, WorkflowAnalysis, WorkflowDescription } from '../../types.js';
import type { RawEdge } from '../connections.js';
import { joinFormOf } from '../inputs.js';
import { decompose } from '../scc.js';
import { validateIdentity, validateNodes } from '../validate.js';
import { checkV2Steps } from './nodes.js';
import { convertV2, firedTriggerNameOf } from './root.js';
import { checkV2Shape } from './shape.js';

/** What the `engineV2` analysis reads beside the description. */
export interface EngineV2Options {
  /** `CompileOptions.trigger`: the trigger that fired, `firedTriggerName` of n8n's converter. */
  readonly trigger?: string;
}

/** Every main connection names two nodes of the description (`unknown-connection-node`). */
function checkEndpoints(workflow: WorkflowDescription, names: ReadonlySet<string>): void {
  for (const c of workflow.connections) {
    if (!names.has(c.from)) {
      throw new CompileError('unknown-connection-node', `compile: connection from unknown node '${c.from}'`, c.from);
    }
    if (!names.has(c.to)) {
      throw new CompileError('unknown-connection-node', `compile: connection to unknown node '${c.to}'`, c.to);
    }
  }
}

/** The `engineV2` analysis of a description (`graph.ts` `analyse` hands it over whole). */
export function analyseEngineV2(
  workflow: WorkflowDescription, options: EngineV2Options, diagnostics: string[],
): WorkflowAnalysis {
  const originalNames = validateIdentity(workflow);
  checkEndpoints(workflow, originalNames);
  // n8n's converter, then its validator (`root.ts`, `shape.ts`), then the run-time refusal.
  const conversion = convertV2(workflow, firedTriggerNameOf(workflow, options.trigger));
  const { trigger } = conversion;
  for (const c of workflow.toolConnections ?? []) {
    diagnostics.push(
      `ai_tool connection ${c.tool} -> ${c.agent} is ignored under engineV2: engine v2 roots the graph at the ` +
      'trigger through main connections only, and fails an agent at its first tool call');
  }
  for (const n of conversion.unrooted) {
    diagnostics.push(
      `node '${n}' is not reachable from the trigger '${trigger}'; engine v2's converter drops it (rootAt), so it ` +
      'is not compiled under engineV2');
  }
  for (const n of conversion.spliced) {
    diagnostics.push(
      `node '${n}' is disabled; engine v2's converter splices it out, joining the edges into its input 0 to the ` +
      'edges out of it (spliceOutDisabledNodes), so it is not compiled under engineV2');
  }

  // The converted graph as a description: what the rest of the analysis, and the net, are built on.
  const converted: WorkflowDescription = {
    ...workflow,
    nodes: conversion.nodes,
    connections: conversion.edges,
    startNodes: [trigger],
    startNode: undefined,
    toolConnections: [],
    expressionReferences: undefined,
  };
  const validated = validateNodes(converted, diagnostics);
  const { raws, rawByName, startNodes } = validated;
  // Canonical order, as v1's; no port-count check, since n8n checks slots only by
  // `validateExecutableGraph`'s rule (`shape.ts`) and a gadget reads only its edges.
  const raw: RawEdge[] = conversion.edges.map((c) => ({
    from: c.from, outputIndex: c.outputIndex, to: c.to, inputIndex: c.inputIndex,
    fromIndex: rawByName.get(c.from)!.index, toIndex: rawByName.get(c.to)!.index,
  }));
  raw.sort((x, y) =>
    (x.fromIndex - y.fromIndex) || (x.outputIndex - y.outputIndex) || (x.toIndex - y.toIndex) || (x.inputIndex - y.inputIndex));
  const { sccOf, sccs, cyclic, edges, incoming, outgoing } = decompose(raws, raw);

  // The validator reads the graph in the converter's orders (`shape.ts`). The key is the tuple
  // serialised by JSON, which is injective for any node name: a separator-joined string is not,
  // since a name may contain the separator (a review found two edges sharing a U+0000 key).
  const key = (e: { from: string; outputIndex: number; to: string; inputIndex: number }): string =>
    JSON.stringify([e.from, e.outputIndex, e.to, e.inputIndex]);
  const refByKey = new Map(edges.map((e) => [key(e), e]));
  const inOrder: EdgeRef[] = conversion.edges.map((c) => refByKey.get(key(c))!);
  const back = new Set([...conversion.back].map((i) => inOrder[i]!.id));
  const shape = checkV2Shape({ nodes: conversion.nodes, edges: inOrder, trigger, back });
  const { reachable } = shape;
  // The loops in canvas order of their batch node, as `EngineV2Analysis.loops` promises; the
  // validator visited them in n8n's order.
  const engineV2 = {
    ...shape.engineV2,
    loops: [...shape.engineV2.loops].sort((x, y) => rawByName.get(x.batchNode)!.index - rawByName.get(y.batchNode)!.index),
  };
  checkV2Steps(raws, reachable);

  // Decision 9: every compiled node other than the trigger has an incoming edge. A node without
  // one would get a skip whose only arcs are inhibitors, enabled forever. Reachability over the
  // edges makes this true by construction; the assertion keeps it true.
  for (const n of reachable) {
    if (n !== trigger && incoming.get(n)!.length === 0) {
      throw new InternalCompilerError(`internal: engineV2 node '${n}' is compiled but has no incoming edge`);
    }
  }

  const nodes: AnalysedNode[] = [];
  const byName = new Map<string, AnalysedNode>();
  for (const r of raws) {
    const name = r.node.name;
    if (!reachable.has(name)) {
      diagnostics.push(
        `node '${name}' is not reachable from the trigger; engine v2 owes it no step ` +
        '(countExpectedSettledSteps), so it is not compiled under engineV2');
    }
    if (r.node.retryOnFail === true) {
      diagnostics.push(`node '${name}' has retryOnFail; engine v2 has no retry, so it is ignored under engineV2`);
    }
    if (r.node.executionPolicy !== undefined) {
      diagnostics.push(`node '${name}' declares an executionPolicy; engine v2 has none, so it is ignored under engineV2`);
    }
    if (r.shape.requiredInputs !== undefined) {
      diagnostics.push(
        `node '${name}' declares requiredInputs; engine v2 queues a node once any input is live, so they are ` +
        'ignored under engineV2');
    }
    for (const ref of referencesOf(workflow, r.node, originalNames, diagnostics)) {
      diagnostics.push(
        `node '${name}' references '${ref}'; engine v2 does not order a step after the nodes its expressions ` +
        'read, so the reference is ignored under engineV2');
    }
    const a: AnalysedNode = {
      node: r.node, shape: r.shape, index: r.index, outputCount: r.outputCount,
      errorOutputIndex: r.errorOutputIndex, onError: r.onError, retry: null, references: [],
      allRequired: false, requiredInputs: null, deadInputs: [], isTool: false,
      // The v1 input form, kept because the field is required; the settlement gadget does not
      // read it (decision 3: every incoming edge is its own `arrived` place).
      form: joinFormOf({ isTool: false, deadInputs: [], requiredInputs: null }, incoming.get(name)!),
      tools: [], maxRounds: null, roundsAssumed: false, maxToolCalls: null, toolCallsAssumed: false,
      failure: null,
    };
    nodes.push(a);
    byName.set(name, a);
  }

  return {
    profile: 'engineV2', startNode: trigger, startNodes, startNodeSet: new Set(startNodes),
    nodes, byName, edges, incoming, outgoing, sccOf, sccs, cyclic, reachable,
    depth: new Map(raws.map((r) => [r.node.name, 0])), maxDepth: 0, hasCycle: cyclic.size > 0,
    multiProducerInputs: [], referenced: new Set(), seededSkipped: new Set(), skipObservable: new Set(),
    toolConnections: [], agentsOf: new Map(), hasAgents: false, engineV2, diagnostics,
  };
}

/**
 * The nodes `node` references through `$('Y')`, by the description's own resolver: the
 * converted description carries none, so a reference to a node the converter dropped is still
 * reported as ignored. A name the workflow lacks is diagnosed as v1's validation does.
 */
function referencesOf(
  workflow: WorkflowDescription, node: AnalysedNode['node'], names: ReadonlySet<string>, diagnostics: string[],
): string[] {
  const out: string[] = [];
  for (const ref of workflow.expressionReferences?.(node) ?? []) {
    if (!names.has(ref)) {
      diagnostics.push(`node '${node.name}' references unknown node '${ref}'; ignored`);
      continue;
    }
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}
