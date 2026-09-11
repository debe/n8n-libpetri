/**
 * The n8n workflow JSON export → `WorkflowDescription` path the CLI needs.
 *
 * The adapter in `src/n8n/adapter.ts` works from a live `Workflow` object, where
 * `NodeHelpers` evaluates each node type's port expressions. A JSON export carries no type
 * descriptions, so the shape has to be supplied (`--node-types`) or guessed — and every
 * guess must show up as a warning. That is what this file pins.
 */
import { analyse, compile } from '../../src/compiler/index.js';
import {
  BUILT_IN_SHAPES, connectionsOf, describeWorkflowJson, looksLikeTrigger, parseWorkflowJson, pickStartNode,
} from '../../src/verify/index.js';

/** A minimal but realistic export: a webhook, an IF, two branches and a Merge. */
const EXPORT = {
  name: 'diamond-export',
  id: 'wf-1',
  nodes: [
    { id: 'a1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
    { id: 'a2', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0], parameters: {} },
    { id: 'a3', name: 'Left', type: 'n8n-nodes-base.set', typeVersion: 3, position: [400, -100], parameters: { value: "={{ $('Webhook').item.json.x }}" } },
    { id: 'a4', name: 'Right', type: 'n8n-nodes-base.set', typeVersion: 3, position: [400, 100], parameters: {} },
    { id: 'a5', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [600, 0], parameters: { numberInputs: 2 } },
  ],
  connections: {
    Webhook: { main: [[{ node: 'If', type: 'main', index: 0 }]] },
    If: { main: [[{ node: 'Left', type: 'main', index: 0 }], [{ node: 'Right', type: 'main', index: 0 }]] },
    Left: { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    Right: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
  },
};

describe('workflow JSON adapter', () => {
  it('reads nodes, main connections and the start node', () => {
    const { description, warnings } = describeWorkflowJson(EXPORT);
    expect(description.name).toBe('diamond-export');
    expect(description.id).toBe('wf-1');
    expect(description.nodes.map((n) => n.name)).toEqual(['Webhook', 'If', 'Left', 'Right', 'Merge']);
    expect(description.startNode).toBe('Webhook');
    expect(description.connections).toContainEqual({ from: 'If', outputIndex: 1, to: 'Right', inputIndex: 0 });
    // The Set nodes have no built-in shape, so they are guessed and reported.
    expect(warnings.some((w) => w.startsWith('Left ('))).toBe(true);
    expect(warnings.some((w) => w.startsWith('If ('))).toBe(false);
  });

  it('takes If, Merge and Loop Over Items from the built-in table, not from the connections', () => {
    const shapes = describeWorkflowJson(EXPORT).description.nodeTypes;
    const nodes = describeWorkflowJson(EXPORT).description.nodes;
    const byName = (name: string) => shapes(nodes.find((n) => n.name === name)!);
    expect(byName('If')).toMatchObject({ inputCount: 1, outputCount: 2 });
    expect(byName('Merge')).toMatchObject({ inputCount: 2, outputCount: 1 });
    expect(byName('Webhook')).toMatchObject({ inputCount: 0, outputCount: 1 });
    expect(BUILT_IN_SHAPES['n8n-nodes-base.splitInBatches']!({})).toMatchObject({ loopNode: true, outputCount: 2 });
  });

  it("reads Merge's numberInputs and chooseBranch mode", () => {
    const three = BUILT_IN_SHAPES['n8n-nodes-base.merge']!({ numberInputs: 3, mode: 'chooseBranch' });
    expect(three).toEqual({ inputCount: 3, outputCount: 1, requiredInputs: [0, 1] });
    expect(BUILT_IN_SHAPES['n8n-nodes-base.merge']!({})).toEqual({ inputCount: 2, outputCount: 1 });
  });

  it('carries $() expression references through to the compiler', () => {
    const { description } = describeWorkflowJson(EXPORT);
    const left = description.nodes.find((n) => n.name === 'Left')!;
    expect(description.expressionReferences?.(left)).toEqual(['Webhook']);
  });

  it('compiles what it produced', () => {
    const compiled = compile(describeWorkflowJson(EXPORT).description);
    expect(compiled.netMap.nodes.map((g) => g.node)).toContain('Merge');
    expect(compiled.netMap.node('Merge').form).toBe('join');
  });

  it('a --node-types entry wins over the built-in table and over the heuristic', () => {
    const { description, warnings } = describeWorkflowJson(EXPORT, {
      nodeTypes: {
        types: {
          'n8n-nodes-base.set@3': { inputCount: 1, outputCount: 1 },
          'n8n-nodes-base.webhook': { inputCount: 0, outputCount: 1 },
        },
        nodes: { If: { inputCount: 1, outputCount: 4 } },
      },
    });
    const shape = (name: string) => description.nodeTypes(description.nodes.find((n) => n.name === name)!);
    expect(shape('If').outputCount).toBe(4);
    expect(shape('Left').outputCount).toBe(1);
    // Nothing was guessed any more, so nothing is warned about.
    expect(warnings).toEqual([]);
  });

  it('applies loopNode to a supplied shape, which the type knows and the shape need not restate', () => {
    // A catalogue built from n8n's generated type file carries counts and nothing else, so a
    // `--node-types` entry for the loop node used to silently drop `loopNode` — and with it
    // the loop emission semantics. Every resolution path applies it now.
    const raw = {
      nodes: [
        { id: 't', name: 'T', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        { id: 'l', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [200, 0] },
        { id: 'b', name: 'Body', type: 'n8n-nodes-base.set', typeVersion: 3, position: [400, 0] },
      ],
      connections: {
        T: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
        Loop: { main: [[], [{ node: 'Body', type: 'main', index: 0 }]] },
        Body: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      },
    };
    const catalogue = { types: { 'n8n-nodes-base.splitInBatches@3': { inputCount: 1, outputCount: 2 } } };
    const { description } = describeWorkflowJson(raw, { nodeTypes: catalogue });
    const loop = description.nodes.find((n) => n.name === 'Loop')!;
    expect(description.nodeTypes(loop).loopNode).toBe(true);
    // And the built-in's names survive: the supplied entry has none, and n8n's own type file
    // lists a port as the bare string "main", so a catalogue can never carry them.
    expect(description.nodeTypes(loop).outputNames).toEqual(['done', 'loop']);
  });

  it('takes counts from the supplied shape but keeps the built-in names it does not carry', () => {
    const catalogue = { types: { 'n8n-nodes-base.if@2': { inputCount: 1, outputCount: 2 } } };
    const { description } = describeWorkflowJson(EXPORT, { nodeTypes: catalogue });
    const iff = description.nodes.find((n) => n.name === 'If')!;
    expect(description.nodeTypes(iff).outputNames).toEqual(['true', 'false']);
  });

  it('does not graft names on when the supplied counts disagree with the built-in', () => {
    // Disagreement means the two are describing different things — a newer type version, or a
    // deliberate override — and names from the other one would be a fiction.
    const catalogue = { types: { 'n8n-nodes-base.if@2': { inputCount: 1, outputCount: 3 } } };
    const { description } = describeWorkflowJson(EXPORT, { nodeTypes: catalogue });
    const iff = description.nodes.find((n) => n.name === 'If')!;
    expect(description.nodeTypes(iff).outputCount).toBe(3);
    expect(description.nodeTypes(iff).outputNames).toBeUndefined();
  });

  it('guesses port counts from the connections and says so', () => {
    const raw = {
      nodes: [
        { id: 't', name: 'T', type: 'custom.trigger', typeVersion: 1, position: [0, 0] },
        { id: 's', name: 'S', type: 'custom.router', typeVersion: 1, position: [100, 0] },
        { id: 'x', name: 'X', type: 'custom.thing', typeVersion: 1, position: [200, 0] },
        { id: 'y', name: 'Y', type: 'custom.thing', typeVersion: 1, position: [200, 100] },
      ],
      connections: {
        T: { main: [[{ node: 'S', type: 'main', index: 0 }]] },
        S: { main: [[{ node: 'X', type: 'main', index: 0 }], [{ node: 'Y', type: 'main', index: 0 }]] },
      },
    };
    const { description, warnings } = describeWorkflowJson(raw);
    const shape = (name: string) => description.nodeTypes(description.nodes.find((n) => n.name === name)!);
    expect(shape('T')).toMatchObject({ inputCount: 0, outputCount: 1 });
    expect(shape('S')).toMatchObject({ inputCount: 1, outputCount: 2 });
    expect(warnings.filter((w) => w.includes('guessed')).length).toBe(4);
  });

  it("takes the highest connected output of a continueErrorOutput node to be the error output", () => {
    const raw = {
      nodes: [
        { id: 't', name: 'T', type: 'custom.trigger', typeVersion: 1, position: [0, 0] },
        { id: 'a', name: 'A', type: 'custom.thing', typeVersion: 1, position: [100, 0], onError: 'continueErrorOutput' },
        { id: 'b', name: 'B', type: 'custom.thing', typeVersion: 1, position: [200, 0] },
        { id: 'e', name: 'E', type: 'custom.thing', typeVersion: 1, position: [200, 100] },
      ],
      connections: {
        T: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
        A: { main: [[{ node: 'B', type: 'main', index: 0 }], [{ node: 'E', type: 'main', index: 0 }]] },
      },
    };
    const { description, warnings } = describeWorkflowJson(raw);
    const a = description.nodes.find((n) => n.name === 'A')!;
    expect(a.onError).toBe('continueErrorOutput');
    // Two outputs are wired; the second is the appended error output, so one is declared.
    expect(description.nodeTypes(a).outputCount).toBe(1);
    expect(warnings.some((w) => w.includes('error output'))).toBe(true);
  });

  it('drops connections naming a node the workflow does not contain, with a warning', () => {
    const names = new Set(['A']);
    const { connections, warnings } = connectionsOf(
      { A: { main: [[{ node: 'Missing', type: 'main', index: 0 }]] }, Ghost: { main: [[]] } }, names);
    expect(connections).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('picks a trigger over another unfed node, and honours an explicit start node', () => {
    const raw = {
      nodes: [
        { id: 'x', name: 'Loose', type: 'custom.thing', typeVersion: 1, position: [0, 0] },
        { id: 't', name: 'Trig', type: 'custom.somethingTrigger', typeVersion: 1, position: [0, 100] },
      ],
      connections: { Trig: { main: [[{ node: 'Loose', type: 'main', index: 0 }]] } },
    };
    expect(describeWorkflowJson(raw).description.startNode).toBe('Trig');
    expect(describeWorkflowJson(raw, { startNode: 'Loose' }).description.startNode).toBe('Loose');
    expect(() => describeWorkflowJson(raw, { startNode: 'Nope' })).toThrow(/not a node/);
  });

  it('recognises n8n trigger types by name and by suffix', () => {
    expect(looksLikeTrigger('n8n-nodes-base.webhook')).toBe(true);
    expect(looksLikeTrigger('n8n-nodes-base.scheduleTrigger')).toBe(true);
    expect(looksLikeTrigger('n8n-nodes-base.set')).toBe(false);
  });

  it('rejects malformed input with a message, never a stack from JSON.parse', () => {
    expect(() => parseWorkflowJson('{')).toThrow(/not valid JSON/);
    expect(() => describeWorkflowJson({ nodes: 'no' })).toThrow(/`nodes` array/);
    expect(() => describeWorkflowJson({ nodes: [{ type: 'x' }] })).toThrow(/has no name/);
    expect(() => describeWorkflowJson({
      nodes: [{ name: 'A', type: 'x', position: [0, 0] }, { name: 'A', type: 'x', position: [0, 1] }],
    })).toThrow(/same name/);
  });

  it('gives two nodes distinct MOD-010 prefixes even when the export repeats or omits ids', () => {
    const { description } = describeWorkflowJson({
      nodes: [
        { id: 'same', name: 'A', type: 'x', position: [0, 0] },
        { id: 'same', name: 'B', type: 'x', position: [0, 1] },
        { id: 'has/slash', name: 'C', type: 'x', position: [0, 2] },
      ],
      connections: {},
    });
    expect(description.nodes.map((n) => n.id)).toEqual(['same', 'n1', 'n2']);
  });

  it('pickStartNode falls back to the topmost node when everything is fed', () => {
    const nodes = [
      { id: 'a', name: 'A', type: 'x', typeVersion: 1, position: [0, 100] as const },
      { id: 'b', name: 'B', type: 'x', typeVersion: 1, position: [0, 0] as const },
    ];
    const cycle = [
      { from: 'A', outputIndex: 0, to: 'B', inputIndex: 0 },
      { from: 'B', outputIndex: 0, to: 'A', inputIndex: 0 },
    ];
    expect(pickStartNode(nodes, cycle)).toBe('B');
  });
});

describe('agent tool dispatch in an exported workflow', () => {
  // The scheduler reads `ai_tool` off a live `Workflow`; the CLI reads the JSON export. If only
  // one of them sees the tool wiring, `verify` analyses a *different net* from the one the
  // scheduler runs and reports it with the same confidence — which is the one thing "one net
  // serves execution and verification" forbids.
  const exported = {
    name: 'agent-export',
    nodes: [
      { name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3, position: [220, 0], parameters: { options: { maxIterations: 4 } } },
      { name: 'Calculator', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [220, 200], parameters: {} },
      { name: 'Respond', type: 'n8n-nodes-base.set', typeVersion: 1, position: [440, 0], parameters: {} },
    ],
    connections: {
      Trigger: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
      'AI Agent': { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
      // A tool node's only connection, keyed from the tool into the agent — and with no `main`
      // key at all, which is what made an early `continue` skip it.
      Calculator: { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
    },
  };

  it('reads the ai_tool wiring and the round budget off the export', () => {
    const { description } = describeWorkflowJson(exported);
    expect(description.toolConnections).toEqual([{ agent: 'AI Agent', tool: 'Calculator' }]);
    expect(description.nodes.find((n) => n.name === 'AI Agent')!.maxRounds).toBe(4);

    const a = analyse(description);
    expect(a.byName.get('Calculator')!.isTool).toBe(true);
    expect(a.byName.get('AI Agent')!.tools).toEqual(['Calculator']);
    expect(a.byName.get('AI Agent')!.roundsAssumed).toBe(false);
  });

  it('compiles the same round the scheduler would run', () => {
    const c = compile(describeWorkflowJson(exported).description);
    const agent = c.netMap.node('AI Agent');
    expect(agent.transitions.dispatch).not.toBeNull();
    expect(agent.transitions.resume).not.toBeNull();
    expect(c.initialMarking([{ json: {} }]).get(agent.rounds!)).toHaveLength(4);
  });

  it('says so when maxIterations is an expression it cannot read', () => {
    const withExpression = {
      ...exported,
      nodes: exported.nodes.map((n) => (n.name === 'AI Agent'
        ? { ...n, parameters: { options: { maxIterations: '={{ $json.limit }}' } } } : n)),
    };
    const a = analyse(describeWorkflowJson(withExpression).description);
    expect(a.byName.get('AI Agent')!.roundsAssumed).toBe(true);
    expect(a.diagnostics.join('\n')).toMatch(/does not declare a static maxIterations/);
  });
});
