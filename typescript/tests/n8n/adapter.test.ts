/**
 * The n8n `Workflow` → `WorkflowDescription` adapter: nodes, main connections (dangling
 * targets dropped), node-type shapes through the injected `NodeHelpers` (the error output
 * `getNodeOutputs` appends under `continueErrorOutput` is subtracted, since the compiler
 * appends it again), the string form of `requiredInputs` evaluated the way the stuck-join
 * fallback evaluates it, `loopNode` for Split In Batches, the `$('X')` reference scan and
 * the start-node set of a fresh and of a resumed execution.
 */
import type { INode } from 'n8n-workflow';
import { compile, MERGE_TYPE, type NodeDescription } from '../../src/compiler/index.js';
import {
  LOOP_NODE_TYPES, aiOutputsOf, batchDescriptionOf, describeWorkflow, engineV2FieldsOf, mainConnectionsOf, nodeShapeOf,
  strayConnectionsIn,
  scanExpressionReferences, startNodesOf,
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

  it('never hands an id-less node the n<index> prefix another node already owns', () => {
    // n8n runs a workflow whose node ids are `n1` and undefined; `analyse()` refuses a
    // duplicate id, so the fallback has to skip what is taken rather than collide with it.
    const wf = fakeWorkflow(workflow('ids2', [node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0])], [conn('T', 0, 'A', 0)], 'T'));
    (wf.nodes.T as { id: string }).id = 'n1';
    (wf.nodes.A as { id?: string }).id = undefined;
    const d = describeWorkflow(wf, newRunExecutionData(wf.nodes.T!), adapter);
    expect(d.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(() => compile(d)).not.toThrow();
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

describe('the engine v2 fields (adapter/engine-v2.ts; tasks/v2-profile-plan.md decision 11)', () => {
  // What `V1WorkflowConverter` (`v1-workflow-converter.ts`) reads off a node: `toBatchConfig`'s
  // parameters, `assertSupportedMergeMode`'s mode, `validateSupportedConnectionType`'s types.
  it('batchDescriptionOf reads toBatchConfig\'s inputs as it reads them', () => {
    expect(batchDescriptionOf({})).toEqual({ batchSize: 1 });
    expect(batchDescriptionOf(undefined)).toEqual({ batchSize: 1 });
    expect(batchDescriptionOf({ batchSize: null })).toEqual({ batchSize: 1 });
    expect(batchDescriptionOf({ batchSize: 5 })).toEqual({ batchSize: 5 });
    expect(batchDescriptionOf({ batchSize: 0.5 })).toEqual({ batchSize: 0.5 });
    // Any string is refused as an expression, `"10"` included.
    expect(batchDescriptionOf({ batchSize: '={{ 2 }}' })).toEqual({ batchSize: 'expression' });
    expect(batchDescriptionOf({ batchSize: '10' })).toEqual({ batchSize: 'expression' });
    expect(batchDescriptionOf({ batchSize: true }).batchSize).toBeNaN();
    expect(batchDescriptionOf({ options: '={{ {} }}' })).toEqual({ batchSize: 1, optionsExpression: true });
    expect(batchDescriptionOf({ options: { reset: true } })).toEqual({ batchSize: 1, reset: true });
    expect(batchDescriptionOf({ options: { reset: '={{ $json.again }}' } })).toEqual({ batchSize: 1, reset: true });
    expect(batchDescriptionOf({ options: { reset: false } })).toEqual({ batchSize: 1 });
  });

  it('aiOutputsOf lists every type key but main, and every connection filed under main with another type', () => {
    expect(aiOutputsOf({ main: [[{ node: 'B', type: 'main', index: 0 }]] })).toEqual([]);
    expect(aiOutputsOf({ main: [[]], ai_tool: [], ai_languageModel: [[{ node: 'A', type: 'ai_languageModel', index: 0 }]] }))
      .toEqual(['ai_tool', 'ai_languageModel']);
    expect(aiOutputsOf({ main: [null, [{ node: 'B', type: 'ai_tool', index: 0 }, { node: 'C', index: 0 }]] }))
      .toEqual(['ai_tool', 'undefined']);
    expect(aiOutputsOf(undefined)).toEqual([]);
  });

  it('engineV2FieldsOf sets mergeMode on every Merge (null without a string mode), batch on every Split In Batches', () => {
    expect(engineV2FieldsOf(MERGE_TYPE, 3, { mode: 'chooseBranch' }, undefined)).toEqual({ mergeMode: 'chooseBranch' });
    // Read and absent is not "not read": the Merge check then does not fall back on requiredInputs.
    expect(engineV2FieldsOf(MERGE_TYPE, 3, {}, undefined)).toEqual({ mergeMode: null });
    expect(engineV2FieldsOf(MERGE_TYPE, 3, { mode: 7 }, undefined)).toEqual({ mergeMode: null });
    expect(engineV2FieldsOf('n8n-nodes-base.set', 1, { mode: 'raw' }, undefined)).toEqual({});
    expect(engineV2FieldsOf('n8n-nodes-base.splitInBatches', 3, { batchSize: 3 }, { main: [[]] })).toEqual({ batch: { batchSize: 3 } });
  });

  // Review finding (c): `typeVersion >= 2` converts the version as written.
  it('engineV2FieldsOf sets mergeVersion on a Merge whose version is not a number, as `>= 2` reads it', () => {
    expect(engineV2FieldsOf(MERGE_TYPE, '3', { mode: '=x' }, undefined)).toEqual({ mergeMode: '=x', mergeVersion: 3 });
    expect(engineV2FieldsOf(MERGE_TYPE, undefined, {}, undefined)).toEqual({ mergeMode: null, mergeVersion: Number.NaN });
    expect(engineV2FieldsOf(MERGE_TYPE, null, {}, undefined)).toEqual({ mergeMode: null, mergeVersion: 0 });
    expect(engineV2FieldsOf('n8n-nodes-base.set', '3', {}, undefined)).toEqual({});
  });

  // Review finding (a): what `getChildNodes` walks and `toEdgesForSource` checks beyond the main
  // connections between nodes.
  it('strayConnectionsIn lists the main hops through names that are no node, and those names\' other types', () => {
    const names = new Set(['T', 'A', 'B']);
    expect(strayConnectionsIn({
      T: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'Ghost', type: 'main', index: 0 }]] },
      Ghost: { main: [null, [{ node: 'B', type: 'main', index: 0 }]], ai_memory: [] },
      A: { main: [[{ node: 'B', type: 'ai_tool', index: 0 }, { node: 'B', index: 1 }, { node: 5 }]] },
      Orphan: { ai_languageModel: [[{ node: 'A', type: 'ai_languageModel', index: 0 }]] },
    }, names)).toEqual({
      main: [{ from: 'T', to: 'Ghost' }, { from: 'Ghost', to: 'B' }, { from: 'A', to: 'B' }],
      sources: [{ name: 'Ghost', aiOutputs: ['ai_memory'] }, { name: 'Orphan', aiOutputs: ['ai_languageModel'] }],
    });
    expect(strayConnectionsIn({ T: { main: [[{ node: 'A', type: 'main', index: 0 }]] } }, names)).toEqual({ main: [], sources: [] });
  });

  it('describeWorkflow fills them from the live node and connectionsBySourceNode, and engineV2 refuses by them', () => {
    const merge = workflow('live-v2', [
      node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0]), node('B', 'set', [1, 1]),
      { ...node('M', 'merge', [2, 0]), type: 'merge' },
    ], [conn('T', 0, 'A', 0), conn('T', 0, 'B', 0), conn('A', 0, 'M', 0), conn('B', 0, 'M', 1)], 'T');
    const wf = fakeWorkflow(merge, { parameters: { M: { mode: 'chooseBranch' } } });
    (wf.nodes.M as { type: string }).type = MERGE_TYPE;
    const types = wf.nodeTypes;
    (wf as { nodeTypes: unknown }).nodeTypes = {
      getByNameAndVersion: (t: string, v?: number) => types.getByNameAndVersion(t === MERGE_TYPE ? 'merge' : t, v),
    };
    (wf.connectionsBySourceNode as Record<string, unknown>).A = { ...wf.connectionsBySourceNode.A, ai_tool: [[]] };
    const d = describeWorkflow(wf, newRunExecutionData(wf.nodes.T!), adapter);
    expect(d.nodes.find((n) => n.name === 'M')).toMatchObject({ type: MERGE_TYPE, mergeMode: 'chooseBranch' });
    expect(d.nodes.find((n) => n.name === 'A')).toMatchObject({ aiOutputs: ['ai_tool'] });
    expect(() => compile(d, { profile: 'engineV2' })).toThrow(/has a "ai_tool" connection|Merge in mode chooseBranch/);
  });
});
