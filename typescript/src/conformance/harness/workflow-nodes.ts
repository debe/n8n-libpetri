/**
 * What each node of a compiler `WorkflowDescription` becomes in the fake n8n `Workflow`:
 * its `INode`, and its node type's description. `workflow.ts` assembles the `Workflow`.
 */
import type { INode, INodeParameters } from 'n8n-workflow';
import type { NodeDescription, WorkflowDescription } from '../../compiler/index.js';
import { POLICY_SCHEMA_VERSION } from '../../compiler/index.js';

/** The `INode` a node description becomes, with the fixture's parameters and extra fields over it. */
export function toINode(n: NodeDescription, parameters?: INodeParameters, extras?: Partial<INode>): INode {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    position: [n.position[0], n.position[1]],
    // An agent's round budget lives where n8n keeps it — `options.maxIterations` in the node's
    // parameters — so a fixture's `maxRounds` survives the round-trip back through
    // `describeWorkflow`, which is the only path the scheduler ever reads it by.
    parameters: {
      ...(n.maxRounds === undefined && n.maxToolCalls === undefined ? {} : {
        options: {
          ...(n.maxRounds === undefined ? {} : { maxIterations: n.maxRounds }),
          ...(n.maxToolCalls === undefined ? {} : { maxToolCalls: n.maxToolCalls }),
        },
      }),
      ...(parameters ?? {}),
    },
    ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
    ...(n.onError === undefined ? {} : { onError: n.onError }),
    ...(n.retryOnFail === undefined ? {} : { retryOnFail: n.retryOnFail }),
    ...(n.maxTries === undefined ? {} : { maxTries: n.maxTries }),
    ...(n.waitBetweenTries === undefined ? {} : { waitBetweenTries: n.waitBetweenTries }),
    // The fixture holds the *resolved* policy (layer 2); n8n carries the *declared* one
    // (layer 1), which is what `describeWorkflow` parses. Writing the schema version back is
    // what makes a fixture's `executionPolicy` survive the same round trip `maxRounds` does —
    // and it exercises the real carrier rather than a shortcut past it (ADR 0009 §2).
    ...(n.executionPolicy === undefined
      ? {}
      : { executionPolicy: { v: POLICY_SCHEMA_VERSION, ...n.executionPolicy } }),
    ...(extras ?? {}),
  };
}

/**
 * The node-type description per type: `main` inputs and outputs as the shape counts them,
 * its output names, and its `requiredInputs` — the fixture's expression for the type when it
 * gives one, else the shape's.
 */
export function nodeTypeDescriptions(
  desc: WorkflowDescription, requiredInputsExpression?: Readonly<Record<string, string>>,
): Map<string, unknown> {
  const descriptions = new Map<string, unknown>();
  for (const n of desc.nodes) {
    const shape = desc.nodeTypes(n);
    const expr = requiredInputsExpression?.[n.type];
    const requiredInputs = expr !== undefined ? expr : shape.requiredInputs;
    descriptions.set(n.type, {
      displayName: n.type,
      name: n.type,
      version: n.typeVersion,
      inputs: Array.from({ length: shape.inputCount }, () => 'main'),
      outputs: Array.from({ length: shape.outputCount }, () => 'main'),
      ...(requiredInputs === undefined ? {} : { requiredInputs }),
      ...(shape.outputNames === undefined ? {} : { outputNames: [...shape.outputNames] }),
      properties: [],
    });
  }
  return descriptions;
}
