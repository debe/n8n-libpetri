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
import type { NodeTypesFile } from '../../src/verify/workflow-json.js';
import { agentOf } from '../compiler/support.js';

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
  it('drops sticky notes, name or no name, and keeps every other node', () => {
    // A published export may omit `name` on an annotation: `5385.json` in the template corpus
    // carries four nameless sticky notes among nineteen nodes, and requiring a name before
    // the type check rejected the whole workflow. The live adapter has always dropped them
    // (`NON_EXECUTABLE_TYPES`), so a workflow the scheduler runs must not be one the CLI
    // refuses. They are unwired by construction — `connections` is keyed by name.
    const withNotes = {
      ...EXPORT,
      nodes: [
        { id: 'sticky-1', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -200], parameters: {} },
        ...EXPORT.nodes,
        { id: 'sticky-2', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 200], parameters: {} },
      ],
    };
    const { description } = describeWorkflowJson(withNotes);
    expect(description.nodes.map((n) => n.name)).toEqual(['Webhook', 'If', 'Left', 'Right', 'Merge']);
    expect(description.startNode).toBe('Webhook');
    // The kept nodes' ids do not move when an annotation is dropped from in front of them.
    const plain = describeWorkflowJson(EXPORT).description;
    expect(description.nodes.map((n) => n.id)).toEqual(plain.nodes.map((n) => n.id));
  });

  it('still rejects a nameless node that is not an annotation', () => {
    const broken = { ...EXPORT, nodes: [{ id: 'x', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0] }, ...EXPORT.nodes] };
    expect(() => describeWorkflowJson(broken)).toThrow(/has no name/);
  });

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

  it('drops connections naming a node the workflow does not contain, with a diagnostic', () => {
    const names = new Set(['A']);
    const { connections, diagnostics } = connectionsOf(
      { A: { main: [[{ node: 'Missing', type: 'main', index: 0 }]] }, Ghost: { main: [[]] } }, names);
    expect(connections).toEqual([]);
    expect(diagnostics).toHaveLength(2);
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

describe('what is a shape guess and what is not', () => {
  it('a dangling connection is a diagnostic on the description, never a guessed shape', () => {
    // `warnings` is the CLI's "the compiled net may differ from the workflow" list, and the
    // report renders it as "Guessed node shapes (n)". A dropped connection is not a guess.
    const raw = {
      ...EXPORT,
      connections: {
        ...EXPORT.connections,
        Left: { main: [[{ node: 'Merge', type: 'main', index: 0 }, { node: 'Ghost', type: 'main', index: 0 }]] },
      },
    };
    const { description, warnings } = describeWorkflowJson(raw, {
      nodeTypes: { types: { 'n8n-nodes-base.set@3': { inputCount: 1, outputCount: 1 }, 'n8n-nodes-base.webhook': { inputCount: 0, outputCount: 1 } } },
    });
    expect(warnings).toEqual([]);
    expect(description.diagnostics?.some((d) => d.includes("'Ghost'") && d.includes('dropped'))).toBe(true);
  });

  it('gives an id-less node a prefix no other node already owns, even a literal n<index>', () => {
    const { description } = describeWorkflowJson({
      nodes: [
        { id: 'n1', name: 'A', type: 'x', position: [0, 0] },
        { name: 'B', type: 'x', position: [0, 1] },
      ],
      connections: {},
    });
    expect(description.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(() => compile(description)).not.toThrow();
  });

  it('--start must name a node the scheduler runs, not an annotation', () => {
    const raw = {
      nodes: [
        { id: 't', name: 'Trig', type: 'custom.somethingTrigger', typeVersion: 1, position: [0, 0] },
        { id: 'n', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 100] },
      ],
      connections: {},
    };
    expect(() => describeWorkflowJson(raw, { startNode: 'Note' })).toThrow(/not a node/);
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
    expect(c.initialMarking([{ json: {} }]).get(agentOf(agent).rounds)).toHaveLength(4);
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

describe('describeWorkflowJson for engine v2 (tasks/v2-profile-plan.md step 13)', () => {
  const json = {
    nodes: [
      { id: 't', name: 'T', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'c', name: 'Cron', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 300], parameters: {} },
      { id: 'b', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [200, 0], parameters: { batchSize: 4, options: {} } },
      { id: 'x', name: 'Body', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
      { id: 'm', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [600, 0], parameters: { mode: 'append' } },
      { id: 'l', name: 'LM', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1, position: [400, 300], parameters: {} },
    ],
    connections: {
      T: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      Cron: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
      Loop: { main: [[{ node: 'Merge', type: 'main', index: 0 }], [{ node: 'Body', type: 'main', index: 0 }]] },
      Body: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      LM: { ai_languageModel: [[{ node: 'Body', type: 'ai_languageModel', index: 0 }]] },
    },
  };

  it('fills the fields the converter reads and picks no start node', () => {
    const { description } = describeWorkflowJson(json, { profile: 'engineV2' });
    expect(description.startNode).toBeUndefined();
    expect(description.startNodes).toBeUndefined();
    const byName = new Map(description.nodes.map((n) => [n.name, n]));
    expect(byName.get('Loop')!.batch).toEqual({ batchSize: 4 });
    expect(byName.get('Merge')!.mergeMode).toBe('append');
    // n8n's node set, not the scheduler's graph: the sub-node is kept, with its connection type,
    // and rootAt drops it from the graph since no main connection reaches it.
    expect(byName.get('LM')!.aiOutputs).toEqual(['ai_languageModel']);
    expect(describeWorkflowJson(json).description.nodes.some((n) => n.name === 'LM')).toBe(false);
    // Under v1 the start node is picked as before.
    expect(describeWorkflowJson(json).description.startNode).toBe('T');
  });

  it('refuses a start node under engineV2: the fired trigger is the compile option', () => {
    expect(() => describeWorkflowJson(json, { profile: 'engineV2', startNode: 'T' })).toThrow(/name it with the trigger option/);
  });

  it('compiles for the fired trigger n8n\'s way: both triggers name one, each rooted apart', () => {
    const { description } = describeWorkflowJson(json, { profile: 'engineV2' });
    expect(() => analyse(description, { profile: 'engineV2' })).toThrow(/the workflow has 2 triggers/);
    const fromT = analyse(description, { profile: 'engineV2', trigger: 'T' });
    expect(fromT.nodes.map((n) => n.node.name).sort()).toEqual(['Body', 'Loop', 'Merge', 'T']);
    expect(fromT.engineV2!.loops.map((l) => l.batchNode)).toEqual(['Loop']);
    const fromCron = compile(description, { profile: 'engineV2', trigger: 'Cron' });
    expect(fromCron.netMap.settlements.map((g) => g.node).sort()).toEqual(['Cron', 'Merge']);
  });
});

/**
 * Raw-JSON inputs where the scheduler's reading of an export is not n8n's converter's (review
 * findings on step 13). Each verdict below is what n8n@2.41.3's `V1WorkflowConverter.convert`
 * followed by `validateExecutableGraph` gives the same export, reproduced against the pinned
 * dist; `tasks/v2-acceptance.mts` re-checks each shape against n8n on the corpus's mutants.
 */
describe('describeWorkflowJson under engineV2 hands the port n8n\'s workflow, not the scheduler\'s graph', () => {
  const node = (name: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id: `id-${name}`, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
  const main = (...targets: string[]) => ({ main: [targets.map((n) => ({ node: n, type: 'main', index: 0 }))] });
  const TRIGGER = 'n8n-nodes-base.manualTrigger';
  const LM = '@n8n/n8n-nodes-langchain.lmChatOpenAi';
  const AGENT = '@n8n/n8n-nodes-langchain.agent';
  /** `code` of the CompileError the engineV2 analysis throws, `accepted: nodes`, or the error. */
  const v2 = (raw: unknown, trigger?: string, nodeTypes?: NodeTypesFile): string => {
    try {
      const { description } = describeWorkflowJson(raw, { profile: 'engineV2', ...(nodeTypes === undefined ? {} : { nodeTypes }) });
      const a = analyse(description, { profile: 'engineV2', ...(trigger === undefined ? {} : { trigger }) });
      compile(description, { profile: 'engineV2', ...(trigger === undefined ? {} : { trigger }), analysis: a });
      return `accepted: ${[...a.reachable].sort().join(', ')}`;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  // (a) n8n: UnsupportedWorkflowError on B (continueErrorOutput): rootAt reaches B through Ghost.
  it('roots through a connections key that is no node, as getChildNodes walks the map by name', () => {
    const ghost = { nodes: [node('T', TRIGGER), node('B', 'n8n-nodes-base.set', { onError: 'continueErrorOutput' })],
      connections: { T: main('Ghost'), Ghost: main('B') } };
    expect(v2(ghost)).toBe('v2-continue-error-output');
    expect(describeWorkflowJson(ghost, { profile: 'engineV2' }).description.strayConnections)
      .toEqual({ main: [{ from: 'T', to: 'Ghost' }, { from: 'Ghost', to: 'B' }], sources: [] });
    // Under v1 nothing changes: the hops are dropped with a diagnostic, as before.
    expect(describeWorkflowJson(ghost).description.strayConnections).toBeUndefined();
  });

  // (b) n8n: GraphValidationError "slot index undefined; slot indices are non-negative integers".
  it('reads a main connection index that is no number as NaN, which the slot rule refuses', () => {
    for (const index of [undefined, '1']) {
      const wf = { nodes: [node('T', TRIGGER), node('A', 'n8n-nodes-base.set')],
        connections: { T: { main: [[{ node: 'A', type: 'main', ...(index === undefined ? {} : { index }) }]] } } };
      expect(v2(wf), String(index)).toBe('input-index-out-of-range');
      // v1 reads it as 0, as before.
      expect(describeWorkflowJson(wf).description.connections[0]!.inputIndex).toBe(0);
    }
  });

  // (c) n8n: UnsupportedWorkflowError, "sets its Merge mode with an expression": '3' >= 2.
  it('compares a Merge version written as a string as n8n does', () => {
    const wf = { nodes: [node('T', TRIGGER), node('M', 'n8n-nodes-base.merge', { typeVersion: '3', parameters: { mode: '={{ "append" }}' } })],
      connections: { T: main('M') } };
    expect(v2(wf)).toBe('v2-merge-mode');
    // A Split In Batches whose version is the string '3' is not version 3 there (`!==`): refused either way.
    const sib = { nodes: [node('T', TRIGGER), node('L', 'n8n-nodes-base.splitInBatches', { typeVersion: '3' })], connections: { T: main('L') } };
    expect(v2(sib)).toBe('v2-batch-config');
  });

  // (d) n8n: UnsupportedWorkflowError on B; with B fine it accepts, the note a step of the graph.
  it('keeps a named sticky note, so one wired on the main path is rooted through', () => {
    const wf = (onError?: string) => ({
      nodes: [node('T', TRIGGER), node('S', 'n8n-nodes-base.stickyNote'), node('B', 'n8n-nodes-base.set', onError === undefined ? {} : { onError })],
      connections: { T: main('S'), S: main('B') } });
    expect(v2(wf('continueErrorOutput'))).toBe('v2-continue-error-output');
    expect(v2(wf())).toBe('accepted: B, S, T');
  });

  // Review finding (round 3): a `main` target with no `node` field puts `undefined` in rootAt's
  // reachable set, which keeps every nameless node, and toEdges turns it into an edge to the last
  // of them. n8n@2.41.3: T -> {no node} beside a nameless note is accepted as nodes [T, <nameless>]
  // with edge T -> <nameless>; with the note on continueErrorOutput it is refused.
  it('describes a nameless note under a name of its own, which a target with no node reaches', () => {
    const note = (extra: Record<string, unknown> = {}) => ({ id: 's', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
    const nodeless = { type: 'main', index: 0 };
    const wf = (...notes: Record<string, unknown>[]) => ({ nodes: [node('T', TRIGGER), ...notes], connections: { T: { main: [[nodeless]] } } });
    const { description } = describeWorkflowJson(wf(note()), { profile: 'engineV2' });
    expect(description.nodes.map((n) => n.name)).toEqual(['T', '(nameless nodes[1])']);
    expect(description.connections).toEqual([{ from: 'T', outputIndex: 0, to: '(nameless nodes[1])', inputIndex: 0 }]);
    expect(v2(wf(note()))).toBe('accepted: (nameless nodes[1]), T');
    expect(v2(wf(note({ onError: 'continueErrorOutput' })))).toBe('v2-continue-error-output');
    // Every nameless node is kept, the edge goes to the last: the first is checked, and is an orphan.
    expect(v2(wf(note({ id: 's1', onError: 'continueErrorOutput' }), note({ id: 's2' })))).toBe('v2-continue-error-output');
    expect(v2(wf(note({ id: 's1' }), note({ id: 's2' })))).toBe('accepted: (nameless nodes[2]), T');
    // No target without a node: nothing reaches the note, and the port drops it (n8n: accepts [T]).
    expect(v2({ nodes: [node('T', TRIGGER), note({ onError: 'continueErrorOutput' })], connections: {} })).toBe('accepted: T');
    // The walk goes on through the map's key 'undefined' (n8n: refuses B), and not through a node
    // of that name, which it does not keep (n8n: accepts [T, B]).
    const through = (extra: Record<string, unknown>) => ({ nodes: [node('T', TRIGGER), node('B', 'n8n-nodes-base.set', extra)],
      connections: { T: { main: [[nodeless]] }, undefined: main('B') } });
    expect(v2(through({ onError: 'continueErrorOutput' }))).toBe('v2-continue-error-output');
    const named = { ...through({}), nodes: [...through({}).nodes, node('undefined', 'n8n-nodes-base.set', { onError: 'continueErrorOutput' })] };
    expect(v2(named)).toBe('accepted: T');
    const graph = analyse(describeWorkflowJson(named, { profile: 'engineV2' }).description, { profile: 'engineV2' });
    expect(graph.nodes.map((n) => n.node.name).sort()).toEqual(['B', 'T']);
    expect(graph.edges).toEqual([]);
    // A name no node has: a node already called that pushes it aside. v1 still drops every note.
    const taken = { nodes: [node('T', TRIGGER), node('(nameless nodes[2])', 'n8n-nodes-base.set'), note()], connections: {} };
    expect(describeWorkflowJson(taken, { profile: 'engineV2' }).description.nodes.map((n) => n.name))
      .toEqual(['T', '(nameless nodes[2])', "(nameless nodes[2])'"]);
    expect(describeWorkflowJson(wf(note())).description.nodes.map((n) => n.name)).toEqual(['T']);
  });

  // Review finding (round 3): n8n's dedupeEdges keys `${from}|${to}|${out}|${in}` over node ids.
  it('drops the edge n8n\'s dedupe drops when node ids hold `|`', () => {
    const wf = { nodes: [node('T', TRIGGER), { ...node('A', 'n8n-nodes-base.set'), id: 'x|y' }, { ...node('B', 'n8n-nodes-base.set'), id: 'z' },
      { ...node('C', 'n8n-nodes-base.set'), id: 'x' }, { ...node('D', 'n8n-nodes-base.set'), id: 'y|z' }],
    connections: { T: main('A', 'C'), A: main('B'), C: main('D') } };
    const { description } = describeWorkflowJson(wf, { profile: 'engineV2' });
    const a = analyse(description, { profile: 'engineV2' });
    // n8n@2.41.3: nodes [T, A, B, C, D], edges T -> A, T -> C, C -> D; B is in the graph and never runs.
    expect(a.nodes.map((n) => n.node.name).sort()).toEqual(['A', 'B', 'C', 'D', 'T']);
    expect(a.edges.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual(['C -> D', 'T -> A', 'T -> C']);
  });

  // Review finding (round 3): the dedupe key prints the index as written, so '0' beside a later 0
  // is one key holding the 0. n8n@2.41.3 accepts ['0', 0] as T -> A.0, refuses [0, '0'] ("slot index 0").
  it('lets n8n\'s dedupe decide between an index written "0" and a 0 on the same edge', () => {
    const wf = (...indexes: unknown[]) => ({ nodes: [node('T', TRIGGER), node('A', 'n8n-nodes-base.set')],
      connections: { T: { main: [indexes.map((index) => ({ node: 'A', type: 'main', index }))] } } });
    expect(v2(wf('0', 0))).toBe('accepted: A, T');
    expect(v2(wf([0], 0))).toBe('accepted: A, T');
    expect(v2(wf(0, '0'))).toBe('input-index-out-of-range');
    expect(v2(wf('0'))).toBe('input-index-out-of-range');
    expect(describeWorkflowJson(wf('0'), { profile: 'engineV2' }).description.connections)
      .toEqual([{ from: 'T', outputIndex: 0, to: 'A', inputIndex: Number.NaN, indexKey: '0' }]);
    // v1 reads it as 0 and carries no key.
    expect(describeWorkflowJson(wf('0')).description.connections).toEqual([{ from: 'T', outputIndex: 0, to: 'A', inputIndex: 0 }]);
  });

  // Review finding (round 3): a guessed count came from a fractional slot on an edge rootAt drops,
  // and the compiler refused it (invalid-count) before the port ran. n8n@2.41.3 accepts [T -> A].
  it('guesses no port count from a slot no count can hold', () => {
    const wf = { nodes: [node('T', TRIGGER), node('A', 'acme.custom'), node('U', 'n8n-nodes-base.webhook')],
      connections: { T: main('A'), U: { main: [[{ node: 'A', type: 'main', index: 1.5 }]] } } };
    expect(v2(wf, 'T')).toBe('accepted: A, T');
    // Rooted, the slot rule refuses the edge itself, as n8n does ("slot index 1.5").
    expect(v2({ ...wf, connections: { T: { main: [[{ node: 'A', type: 'main', index: 1.5 }]] } } }, 'T')).toBe('input-index-out-of-range');
  });

  // Recorded, not reproduced (docs/divergences.md row 34, "Exports n8n's converter crashes on"):
  // n8n@2.41.3 throws "TypeError: connections.hasOwnProperty is not a function" whenever the
  // connections map has a key `hasOwnProperty` and rootAt runs, reached or not. A crash has no throw
  // site for V2_REFUSALS to map, so the port gives the verdict the rest of the workflow earns.
  it('pins the port\'s verdict on a connections key n8n\'s rootAt crashes on', () => {
    const wf = { nodes: [node('T', TRIGGER), node('hasOwnProperty', 'n8n-nodes-base.set'), node('B', 'n8n-nodes-base.set')],
      connections: { T: main('hasOwnProperty'), hasOwnProperty: main('B') } };
    expect(v2(wf)).toBe('accepted: B, T, hasOwnProperty');
  });

  // (e) n8n: AmbiguousTriggerError ("T", "X"): the trigger rule reads types, not wiring.
  it('keeps a sub-node, so one whose type reads as a trigger makes the trigger ambiguous', () => {
    const wf = { nodes: [node('T', TRIGGER), node('Agent', AGENT), node('X', 'acme.fooTriggerModel')],
      connections: { T: main('Agent'), X: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } } };
    expect(v2(wf)).toBe('v2-ambiguous-trigger');
    expect(v2(wf, 'T')).toBe('accepted: Agent, T');
  });

  // Finding 2: the codes n8n gives when the dropped nodes were the first defect.
  it('gives n8n\'s code when the node the scheduler would drop is the one n8n refuses', () => {
    const lm = (extra: Record<string, unknown> = {}) => ({ nodes: [node('Agent', AGENT), node('LM', LM, extra)],
      connections: { LM: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } } });
    // No trigger, so nothing is rooted: n8n checks LM (UnsupportedConnectionTypeError, then its onError first).
    expect(v2(lm())).toBe('v2-connection-type');
    expect(v2(lm({ onError: 'continueErrorOutput' }))).toBe('v2-continue-error-output');
    // Named as the fired trigger: n8n finds the node and refuses it as no trigger (NotATriggerError).
    const named = { nodes: [node('T', TRIGGER), node('S', 'n8n-nodes-base.stickyNote'), ...lm().nodes], connections: lm().connections };
    expect(v2(named, 'LM')).toBe('v2-not-a-trigger');
    expect(v2(named, 'S')).toBe('v2-not-a-trigger');
    // Only notes: "Graph has no trigger node to start from", named or not.
    expect(v2({ nodes: [node('S', 'n8n-nodes-base.stickyNote')], connections: {} })).toBe('v2-trigger-count');
    expect(v2({ nodes: [{ type: 'n8n-nodes-base.stickyNote', parameters: {} }], connections: {} })).toBe('v2-trigger-count');
  });

  // Finding 3: n8n accepts; assertSupportedMergeMode never looks at requiredInputs.
  it('never refuses a node for its requiredInputs, whatever shape --node-types supplies', () => {
    const wf = (type: string, typeVersion: number) => ({
      nodes: [node('T', TRIGGER), node('I', 'n8n-nodes-base.if'), node('C', type, { typeVersion })],
      connections: { T: main('I'), I: { main: [[{ node: 'C', type: 'main', index: 0 }], [{ node: 'C', type: 'main', index: 1 }]] } } });
    const nodeTypes = { nodes: { C: { inputCount: 2, outputCount: 4, requiredInputs: [0, 1] } } };
    expect(v2(wf('n8n-nodes-base.compareDatasets', 2.3), undefined, nodeTypes)).toBe('accepted: C, I, T');
    // A Merge with no mode set: n8n reads the parameter, which is absent.
    expect(v2(wf('n8n-nodes-base.merge', 3), undefined, nodeTypes)).toBe('accepted: C, I, T');
  });
});
