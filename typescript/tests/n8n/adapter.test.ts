/**
 * The n8n `Workflow` → `WorkflowDescription` adapter: nodes, main connections (dangling
 * targets dropped), node-type shapes through the injected `NodeHelpers` (the error output
 * `getNodeOutputs` appends under `continueErrorOutput` is subtracted, since the compiler
 * appends it again), the string form of `requiredInputs` evaluated the way the stuck-join
 * fallback evaluates it, `loopNode` for Split In Batches, the `$('X')` reference scan and
 * the start-node set of a fresh and of a resumed execution.
 */
import type { INode } from 'n8n-workflow';
import { compile, type NodeDescription } from '../../src/compiler/index.js';
import {
  LOOP_NODE_TYPES, describeWorkflow, mainConnectionsOf, nodeShapeOf, scanExpressionReferences, startNodesOf,
} from '../../src/n8n/adapter.js';
import { SHAPES, conn, continueErrorOutput, diamond, node, workflow } from '../fixtures/workflows.js';
import { fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData } from '../scheduler/support.js';

const adapter = { nodeHelpers: fakeNodeHelpers } as const;

describe('describeWorkflow', () => {
  it('maps nodes, connections and the primary start node of a fresh execution; the result compiles to the same structural hash as the fixture', () => {
    const wf = fakeWorkflow(diamond);
    const red = newRunExecutionData(wf.nodes.Trigger!, { startItems: items(1) });
    const d = describeWorkflow(wf, red, adapter);
    expect(d.id).toBe('diamond');
    expect(d.nodes.map((n) => [n.id, n.name, n.type, n.typeVersion, n.position])).toEqual(
      diamond.nodes.map((n) => [n.id, n.name, n.type, n.typeVersion, n.position]));
    expect(d.connections).toEqual(expect.arrayContaining([...diamond.connections]));
    expect(d.connections).toHaveLength(diamond.connections.length);
    expect(d.startNodes).toEqual(['Trigger']);
    expect(d.nodeTypes(d.nodes.find((n) => n.name === 'Merge')!)).toEqual({ inputCount: 2, outputCount: 1 });
    expect(d.nodeTypes(d.nodes.find((n) => n.name === 'IF')!)).toEqual({ inputCount: 1, outputCount: 2, outputNames: ['true', 'false'] });
    expect(compile(d).structuralHash).toBe(compile(diamond).structuralHash);
  });

  it('carries disabled / onError / retry fields and falls back to n<index> for an id that is missing, repeats another or contains the MOD-010 separator', () => {
    const wf = fakeWorkflow(workflow('ids', [
      node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0], { disabled: true, onError: 'continueErrorOutput' }),
      node('B', 'set', [2, 0], { retryOnFail: true, maxTries: 4, waitBetweenTries: 7 }), node('C', 'set', [3, 0]),
    ], [conn('T', 0, 'A', 0)], 'T'));
    (wf.nodes.A as { id: string }).id = 'has/slash';
    (wf.nodes.B as { id: string }).id = 'id:T'; // repeats T's
    (wf.nodes.C as { id?: string }).id = undefined;
    const d = describeWorkflow(wf, newRunExecutionData(wf.nodes.T!), adapter);
    expect(d.nodes.map((n) => n.id)).toEqual(['id:T', 'n1', 'n2', 'n3']);
    expect(d.nodes[1]).toMatchObject({ disabled: true, onError: 'continueErrorOutput' });
    expect(d.nodes[2]).toMatchObject({ retryOnFail: true, maxTries: 4, waitBetweenTries: 7 });
    expect(Object.keys(d.nodes[3] as object)).not.toContain('disabled');
  });
});

describe('nodeShapeOf', () => {
  it('subtracts the error output n8n\'s getNodeOutputs appends under continueErrorOutput, so the compiler appends it exactly once', () => {
    const wf = fakeWorkflow(continueErrorOutput);
    const description = wf.nodeTypes.getByNameAndVersion('set', 1).description;
    // The fake mirrors node-helpers.ts: one declared output plus the `{ category: 'error' }` entry.
    expect(fakeNodeHelpers.getNodeOutputs(wf, wf.nodes.A!, description)).toHaveLength(2);
    expect(nodeShapeOf(wf, wf.nodes.A!, adapter)).toEqual({ inputCount: 1, outputCount: 1 });
    expect(nodeShapeOf(wf, wf.nodes.B!, adapter)).toEqual({ inputCount: 1, outputCount: 1 });
    const c = compile(describeWorkflow(wf, newRunExecutionData(wf.nodes.Trigger!), adapter));
    expect(c.netMap.node('A').outputs.map((o) => [o.index, o.isErrorOutput])).toEqual([[0, false], [1, true]]);
  });

  it('counts main connections only', () => {
    const wf = fakeWorkflow(diamond);
    const helpers = {
      getNodeInputs: () => ['main', { type: 'ai_tool', displayName: 'Tool' }, 'main'] as never,
      getNodeOutputs: () => ['main', 'ai_languageModel'] as never,
    };
    expect(nodeShapeOf(wf, wf.nodes.Merge!, { nodeHelpers: helpers })).toEqual({ inputCount: 2, outputCount: 1 });
  });

  it('evaluates a string requiredInputs with getSimpleParameterValue(node, expr, mode, { $version }, undefined, []) as the stuck-join fallback does', () => {
    const wf = fakeWorkflow(diamond, { requiredInputsExpression: { merge: '={{ $parameter["mode"] === "chooseBranch" ? [0, 1] : 1 }}' }, parameters: { Merge: { mode: 'chooseBranch' } } });
    const spy = vi.fn(wf.expression.getSimpleParameterValue.bind(wf.expression));
    (wf.expression as { getSimpleParameterValue: unknown }).getSimpleParameterValue = spy;
    expect(nodeShapeOf(wf, wf.nodes.Merge!, { ...adapter, mode: 'manual' })).toEqual({ inputCount: 2, outputCount: 1, requiredInputs: [0, 1] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([
      wf.nodes.Merge, '={{ $parameter["mode"] === "chooseBranch" ? [0, 1] : 1 }}', 'manual', { $version: 1 }, undefined, [],
    ]);
    // Default mode is 'internal'; a non-chooseBranch Merge evaluates to the number 1.
    const plain = fakeWorkflow(diamond, { requiredInputsExpression: { merge: '={{ … }}' } });
    const spy2 = vi.fn(plain.expression.getSimpleParameterValue.bind(plain.expression));
    (plain.expression as { getSimpleParameterValue: unknown }).getSimpleParameterValue = spy2;
    expect(nodeShapeOf(plain, plain.nodes.Merge!, adapter).requiredInputs).toBe(1);
    expect(spy2.mock.calls[0]![2]).toBe('internal');
    // A literal requiredInputs is passed through untouched.
    const literal = fakeWorkflow(workflow('cb', [node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [1, 0])], [conn('T', 0, 'M', 0)], 'T'));
    expect(nodeShapeOf(literal, literal.nodes.M!, adapter).requiredInputs).toEqual([0, 1]);
  });

  it('drops a requiredInputs that is neither a count nor an array of indexes, as every branch that reads it in n8n does', () => {
    // n8n reaches `requiredInputs` with whatever the type description holds and falls
    // through every branch on a non-number, non-array (`stack-scheduler.ts:395-416`,
    // `444-465`), so such a value means the same as `undefined`. The compiler's contract is
    // `number | readonly number[]` and `structuralHash` spreads the array form, so a value of
    // another shape reaching it throws — which is what a `mock<INodeType>()` node type does,
    // since it answers every property with a proxy (n8n `workflow-execute.test.ts`
    // "convertBinaryData integration", where the whole execution failed before any node ran).
    const wf = fakeWorkflow(workflow('req', [node('T', 'trigger', [0, 0]), node('M', 'merge', [1, 0])], [conn('T', 0, 'M', 0)], 'T'));
    const description = wf.nodeTypes.getByNameAndVersion('merge', 1).description as { requiredInputs?: unknown };
    for (const raw of [() => [0, 1], {}, true, ['0', '1'], [0, 'x'], Number.NaN]) {
      description.requiredInputs = raw;
      expect(nodeShapeOf(wf, wf.nodes.M!, adapter)).not.toHaveProperty('requiredInputs');
    }
    // The two shapes n8n can act on survive, the array by value.
    description.requiredInputs = 2;
    expect(nodeShapeOf(wf, wf.nodes.M!, adapter).requiredInputs).toBe(2);
    const arr = [0, 1];
    description.requiredInputs = arr;
    expect(nodeShapeOf(wf, wf.nodes.M!, adapter).requiredInputs).toEqual([0, 1]);
    expect(nodeShapeOf(wf, wf.nodes.M!, adapter).requiredInputs).not.toBe(arr);
    // The same narrowing applies to whatever the expression form evaluates to.
    description.requiredInputs = '={{ $parameter["mode"] }}';
    (wf.expression as { getSimpleParameterValue: unknown }).getSimpleParameterValue = () => ({ 0: true });
    expect(nodeShapeOf(wf, wf.nodes.M!, adapter)).not.toHaveProperty('requiredInputs');
  });

  it('keeps only string outputNames, so a proxy from a mocked node type never reaches the NetMap or the structural hash', () => {
    const wf = fakeWorkflow(workflow('names', [node('T', 'trigger', [0, 0]), node('S', 'if', [1, 0])], [conn('T', 0, 'S', 0)], 'T'));
    const description = wf.nodeTypes.getByNameAndVersion('if', 1).description as { outputNames?: unknown };
    expect(nodeShapeOf(wf, wf.nodes.S!, adapter).outputNames).toEqual(['true', 'false']);
    description.outputNames = [() => 'true', 7];
    expect(nodeShapeOf(wf, wf.nodes.S!, adapter)).not.toHaveProperty('outputNames');
  });

  it('marks n8n-nodes-base.splitInBatches as the loop node whatever its version', () => {
    const loop: NodeDescription = { id: 'id:Loop', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [200, 0] };
    const wf = fakeWorkflow(workflow('loop', [node('T', 'trigger', [0, 0]), loop], [conn('T', 0, 'Loop', 0)], 'T', { shapes: { Loop: SHAPES.loop } }));
    expect(LOOP_NODE_TYPES.has(loop.type)).toBe(true);
    expect(nodeShapeOf(wf, wf.nodes.Loop!, adapter)).toMatchObject({ inputCount: 1, outputCount: 2, loopNode: true });
    expect(nodeShapeOf(wf, wf.nodes.T!, adapter)).not.toHaveProperty('loopNode');
  });
});

describe('mainConnectionsOf', () => {
  it('reads connectionsBySourceNode[*].main, drops connections to nodes the workflow does not contain and ignores other connection types', () => {
    const wf = fakeWorkflow(diamond);
    const bySource = wf.connectionsBySourceNode as Record<string, { main: Array<Array<{ node: string; type: string; index: number }> | null> }>;
    bySource.IF!.main[0]!.push({ node: 'Ghost', type: 'main', index: 0 }); // n8n throws only when IF runs
    bySource.IF!.main[1]!.push({ node: 'A', type: 'ai_tool', index: 0 });
    bySource.IF!.main.push(null); // a null output slot
    const out = mainConnectionsOf(wf);
    expect(out).toHaveLength(diamond.connections.length);
    expect(out).toEqual(expect.arrayContaining([...diamond.connections]));
  });
});

describe('scanExpressionReferences', () => {
  const names = new Set(['Webhook', 'Set Data', 'HTTP', 'Code']);

  it.each([
    ["$('Webhook')", ['Webhook']],
    ['$("Set Data").first().json', ['Set Data']],
    ['$(`HTTP`).all()', ['HTTP']],
    ['$node["Set Data"].json.x', ['Set Data']],
    ["$node['Webhook'].json", ['Webhook']],
    ['$node.Code.json.y', ['Code']],
    ['$items("HTTP", 0, 0)', ['HTTP']],
    ["$items('Webhook')", ['Webhook']],
    ["{{ $( 'Webhook' ) }} and {{ $node[ \"Code\" ] }}", ['Webhook', 'Code']],
  ])('recognises %s', (expr, expected) => {
    expect(scanExpressionReferences({ value: `=${expr}` }, names)).toEqual(expected);
  });

  it('walks nested parameters, keeps first-seen order, deduplicates and ignores names that are not nodes of the workflow', () => {
    const parameters = {
      a: "={{ $('HTTP').item }}",
      options: { b: ['={{ $node["Nope"].json }}', { c: "={{ $('Webhook') }} {{ $('HTTP') }}" }] },
      n: 3,
      flag: true,
    };
    expect(scanExpressionReferences(parameters, names)).toEqual(['HTTP', 'Webhook']);
    expect(scanExpressionReferences({}, names)).toEqual([]);
    expect(scanExpressionReferences('$node.Unknown', names)).toEqual([]);
  });

  it('feeds the compiler: a $(\'A\') in B\'s parameters becomes B\'s reference (read arc + start_unmet twin)', () => {
    const wf = fakeWorkflow(diamond, { parameters: { B: { value: "={{ $('A').first().json.x }}" } } });
    const d = describeWorkflow(wf, newRunExecutionData(wf.nodes.Trigger!), adapter);
    expect(d.expressionReferences!(d.nodes.find((n) => n.name === 'B')!)).toEqual(['A']);
    expect(d.expressionReferences!(d.nodes.find((n) => n.name === 'A')!)).toEqual([]);
    const c = compile(d);
    expect(c.netMap.node('B').references).toEqual(['A']);
    expect(c.netMap.node('B').transitions.startUnmet).toHaveLength(1);
  });
});

describe('startNodesOf', () => {
  it('a fresh execution: the one stack entry', () => {
    const wf = fakeWorkflow(diamond);
    expect(startNodesOf(newRunExecutionData(wf.nodes.Trigger!))).toEqual(['Trigger']);
  });

  it('a resumed execution: every stack entry (first the primary, deduplicated) then every node with recorded runs, in runData order', () => {
    const wf = fakeWorkflow(diamond);
    const red = newRunExecutionData(wf.nodes.B!);
    const entry = (n: INode) => ({ node: n, data: { main: [[]] }, source: null });
    red.executionData!.nodeExecutionStack.push(entry(wf.nodes.A!), entry(wf.nodes.B!));
    red.resultData.runData = { Trigger: [{} as never], IF: [{} as never], Merge: [], A: [{} as never] };
    expect(startNodesOf(red)).toEqual(['B', 'A', 'Trigger', 'IF']);
    const d = describeWorkflow(wf, red, adapter);
    expect(d.startNodes).toEqual(['B', 'A', 'Trigger', 'IF']);
    // The compiler canonicalises: primary first, the rest in canvas order — (y, x) ascending,
    // so A at y −100 precedes Trigger (0, 0) and IF (200, 0).
    expect(compile(d).startNodes).toEqual(['B', 'A', 'Trigger', 'IF']);
  });
});
