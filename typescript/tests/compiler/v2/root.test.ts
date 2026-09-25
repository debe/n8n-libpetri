/**
 * The port of `V1WorkflowConverter.convert` (`tasks/v2-profile-plan.md` step 13,
 * `analysis/engine-v2/root.ts`), function by function. Each case cites the n8n rule it is
 * written from, at the pin `n8n@2.41.3`:
 * - `isTriggerNodeType` (`n8n-workflow` `node-helpers.ts`): a type in `TRIGGER_NODE_TYPES`, or one
 *   whose name contains `trigger` in any case;
 * - `resolveFiredTrigger`: the named node among the enabled ones, which must be a trigger
 *   (`UnknownTriggerError`, `NotATriggerError`); with no name the only trigger, several refused
 *   (`AmbiguousTriggerError`), none left to the engine;
 * - `rootAt`: the trigger and `getChildNodes(connections, trigger, 'main', -1)`;
 * - `spliceOutDisabledNodes`: "every edge into their input slot 0 is joined to every edge leaving
 *   them, so A -> disabled -> B becomes A -> B, keeping A's `outputIndex` and B's `inputIndex`";
 * - `dedupeEdges`: one edge per `from|to|outputIndex|inputIndex`, over node ids and the index as written;
 * - `convert`: resolve, root, `toGraphNode` per live node, `toEdges` (connection types), splice,
 *   dedupe, `markBackEdges`.
 * The corpus-scale comparison with n8n's own converter is `tasks/v2-acceptance.mts`; the
 * committed-workflow one is `port-golden.test.ts`.
 */
import { CompileError, InternalCompilerError, MERGE_TYPE, SPLIT_IN_BATCHES_TYPE, compile } from '../../../src/compiler/index.js';
import type { MainConnection, NodeDescription, WorkflowDescription } from '../../../src/compiler/index.js';
import {
  convertV2, dedupeEdges, firedTriggerNameOf, isV2TriggerType, resolveFiredTrigger, rootAtTrigger, spliceDisabled,
  V2_TRIGGER_NODE_TYPES,
} from '../../../src/compiler/analysis/engine-v2/root.js';
import { conn, linear, node, workflow } from '../../fixtures/workflows.js';

const text = (edges: readonly MainConnection[]): string[] =>
  edges.map((e) => `${e.from}.${e.outputIndex} -> ${e.to}.${e.inputIndex}`);

/** The `CompileError` code `f` throws, or `returned`. */
function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof CompileError) return e.code;
    throw e;
  }
  return 'returned';
}

describe('isV2TriggerType (isTriggerNodeType, node-helpers.ts)', () => {
  it('holds for the five named types and any type containing "trigger", in any case', () => {
    expect([...V2_TRIGGER_NODE_TYPES]).toEqual([
      'n8n-nodes-base.webhook', 'n8n-nodes-base.cron', 'n8n-nodes-base.emailReadImap', 'n8n-nodes-base.telegramBot',
      'n8n-nodes-base.start',
    ]);
    for (const t of V2_TRIGGER_NODE_TYPES) expect(isV2TriggerType(t), t).toBe(true);
    for (const t of ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger', '@n8n/n8n-nodes-langchain.mcpTrigger',
      'n8n-nodes-base.TRIGGERish', 'trigger']) {
      expect(isV2TriggerType(t), t).toBe(true);
    }
    for (const t of ['n8n-nodes-base.set', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.telegram', 'n8n-nodes-base.webhooks']) {
      expect(isV2TriggerType(t), t).toBe(false);
    }
  });
});

describe('firedTriggerNameOf: what convert is handed as firedTriggerName', () => {
  it('is the trigger option, else the one start node, else none', () => {
    expect(firedTriggerNameOf(linear, undefined)).toBe('Trigger');
    expect(firedTriggerNameOf(linear, 'Trigger')).toBe('Trigger');
    expect(firedTriggerNameOf({ ...linear, startNode: undefined }, 'A')).toBe('A');
    expect(firedTriggerNameOf({ ...linear, startNode: undefined }, undefined)).toBeUndefined();
  });

  it('refuses an option that contradicts the start node, and several start nodes', () => {
    expect(codeOf(() => firedTriggerNameOf(linear, 'A'))).toBe('invalid-options');
    expect(codeOf(() => firedTriggerNameOf({ ...linear, startNode: undefined, startNodes: ['Trigger', 'A'] }, undefined)))
      .toBe('v2-trigger-count');
  });
});

describe('resolveFiredTrigger', () => {
  const nodes: NodeDescription[] = [
    node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 1], { disabled: true }), node('A', 'set', [1, 0]),
  ];

  it('takes the only enabled trigger when none is named; a disabled one is not a candidate', () => {
    expect(resolveFiredTrigger(nodes, undefined)?.name).toBe('T1');
    expect(resolveFiredTrigger(nodes.slice(2), undefined)).toBeNull();
  });

  it('refuses several enabled triggers with none named (AmbiguousTriggerError)', () => {
    const two = nodes.map((n) => (n.name === 'T2' ? { ...n, disabled: false } : n));
    expect(codeOf(() => resolveFiredTrigger(two, undefined))).toBe('v2-ambiguous-trigger');
    expect(resolveFiredTrigger(two, 'T2')?.name).toBe('T2');
  });

  it('refuses a name no enabled node has, and a named node of no trigger type', () => {
    expect(codeOf(() => resolveFiredTrigger(nodes, 'Nope'))).toBe('v2-unknown-trigger');
    expect(codeOf(() => resolveFiredTrigger(nodes, 'T2'))).toBe('v2-unknown-trigger');
    expect(codeOf(() => resolveFiredTrigger(nodes, 'A'))).toBe('v2-not-a-trigger');
  });
});

describe('rootAtTrigger (rootAt)', () => {
  it('keeps the trigger and what it reaches over every slot, through disabled nodes, never upstream', () => {
    const edges = [conn('X', 0, 'T', 0), conn('T', 1, 'A', 2), conn('A', 0, 'D', 1), conn('D', 3, 'B', 0), conn('B', 0, 'A', 0),
      conn('Y', 0, 'B', 0)];
    expect([...rootAtTrigger(edges, 'T')].sort()).toEqual(['A', 'B', 'D', 'T']);
  });
});

describe('dedupeEdges', () => {
  it('keeps one edge per (from, to, outputIndex, inputIndex), at its first position', () => {
    const edges = [conn('A', 0, 'B', 0), conn('A', 1, 'B', 0), conn('A', 0, 'B', 0), conn('A', 0, 'B', 1)];
    expect(text(dedupeEdges(edges))).toEqual(['A.0 -> B.0', 'A.1 -> B.0', 'A.0 -> B.1']);
  });

  // Review finding: n8n keys by node id with a `|` separator, so ids holding `|` collide. Measured
  // against n8n@2.41.3: T, A (id 'x|y'), B ('z'), C ('x'), D ('y|z'); T -> A, T -> C, A -> B, C -> D
  // is accepted with edges T -> A, T -> C, C -> D — A -> B is lost, and B never runs.
  it('keys by node id with n8n\'s `|` separator, so ids holding `|` collide and the later edge stays', () => {
    const ids: Record<string, string> = { T: 't', A: 'x|y', B: 'z', C: 'x', D: 'y|z' };
    const edges = [conn('T', 0, 'A', 0), conn('T', 0, 'C', 0), conn('A', 0, 'B', 0), conn('C', 0, 'D', 0)];
    expect(text(dedupeEdges(edges, (n) => ids[n]!))).toEqual(['T.0 -> A.0', 'T.0 -> C.0', 'C.0 -> D.0']);
    // Keyed by name the four are distinct, and so they are by ids without `|`.
    expect(dedupeEdges(edges)).toHaveLength(4);
  });

  // Review finding: n8n copies a non-number `index` as written, and its key prints it, so `'0'` and
  // `0` on one edge are one key. Measured: `[{index:'0'},{index:0}]` is accepted as T -> A.0, the
  // reverse refused ("slot index 0"). The JSON reader hands the written form as `indexKey`.
  it('keys an index that is no number by its written form, so "0" and 0 are one edge, the later kept', () => {
    const written: MainConnection = { ...conn('T', 0, 'A', Number.NaN), indexKey: '0' };
    expect(dedupeEdges([written, conn('T', 0, 'A', 0)])).toEqual([conn('T', 0, 'A', 0)]);
    expect(dedupeEdges([conn('T', 0, 'A', 0), written])).toEqual([written]);
    // `undefined` and `'1'` print as themselves, so they stay beside a numeric 0.
    expect(dedupeEdges([{ ...written, indexKey: 'undefined' }, conn('T', 0, 'A', 0)])).toHaveLength(2);
  });
});

describe('spliceDisabled (spliceOutDisabledNodes)', () => {
  it('turns A -> D -> B into A -> B, keeping A\'s output slot and B\'s input slot', () => {
    expect(text(spliceDisabled([conn('A', 1, 'D', 0), conn('D', 0, 'B', 2)], ['D']))).toEqual(['A.1 -> B.2']);
  });

  it('joins input slot 0 only: an edge into another slot is dropped with the node', () => {
    expect(text(spliceDisabled([conn('A', 0, 'D', 1), conn('D', 0, 'B', 0)], ['D']))).toEqual([]);
    expect(text(spliceDisabled([conn('A', 0, 'D', 0), conn('C', 0, 'D', 1), conn('D', 0, 'B', 0)], ['D'])))
      .toEqual(['A.0 -> B.0']);
  });

  it('keeps the edges out of every output slot, diverging from v1\'s pass-through on output 0', () => {
    expect(text(spliceDisabled([conn('A', 0, 'D', 0), conn('D', 0, 'B', 0), conn('D', 1, 'C', 0)], ['D'])))
      .toEqual(['A.0 -> B.0', 'A.0 -> C.0']);
  });

  it('joins every edge in to every edge out, and deduplicates', () => {
    const edges = [conn('A', 0, 'D', 0), conn('C', 0, 'D', 0), conn('D', 0, 'B', 0), conn('D', 1, 'B', 0), conn('A', 0, 'B', 0)];
    expect(text(spliceDisabled(edges, ['D']))).toEqual(['A.0 -> B.0', 'C.0 -> B.0']);
  });

  it('drops a disabled node\'s self loop, and can make one on its neighbour', () => {
    expect(text(spliceDisabled([conn('A', 0, 'D', 0), conn('D', 0, 'D', 0), conn('D', 0, 'B', 0)], ['D']))).toEqual(['A.0 -> B.0']);
    expect(text(spliceDisabled([conn('A', 0, 'D', 0), conn('D', 0, 'A', 1)], ['D']))).toEqual(['A.0 -> A.1']);
  });

  it('splices a chain of disabled nodes one after the other', () => {
    const chain = [conn('A', 0, 'D1', 0), conn('D1', 0, 'D2', 0), conn('D2', 0, 'B', 0)];
    expect(text(spliceDisabled(chain, ['D1', 'D2']))).toEqual(['A.0 -> B.0']);
    expect(text(spliceDisabled(chain, ['D2', 'D1']))).toEqual(['A.0 -> B.0']);
    // The second in the chain fed on slot 1: the join after the first splice drops it.
    expect(text(spliceDisabled([conn('A', 0, 'D1', 0), conn('D1', 0, 'D2', 1), conn('D2', 0, 'B', 0)], ['D1', 'D2']))).toEqual([]);
  });
});

describe('spliceDisabled keys as n8n does', () => {
  it('carries the target\'s written index through the splice, and dedupes by id', () => {
    // T -> D (disabled) -> A.'0' beside T -> A.0: the spliced edge is T -> A with index '0', one
    // key with T -> A.0, and the later of the two is kept (n8n: refused, "slot index 0").
    const written: MainConnection = { ...conn('D', 0, 'A', Number.NaN), indexKey: '0' };
    const out = spliceDisabled([conn('T', 0, 'A', 0), conn('T', 0, 'D', 0), written], ['D']);
    expect(out).toEqual([{ ...conn('T', 0, 'A', Number.NaN), indexKey: '0' }]);
    // Ids holding `|`: the spliced A -> B prints the key of the earlier C -> D and replaces it.
    const ids: Record<string, string> = { T: 't', A: 'x|y', X: 'q', B: 'z', C: 'x', D: 'y|z' };
    const edges = [conn('T', 0, 'A', 0), conn('T', 0, 'C', 0), conn('A', 0, 'X', 0), conn('X', 0, 'B', 0), conn('C', 0, 'D', 0)];
    expect(text(spliceDisabled(edges, ['X'], (n) => ids[n]!))).toEqual(['T.0 -> A.0', 'T.0 -> C.0', 'A.0 -> B.0']);
  });
});

describe('convertV2 (convert)', () => {
  /** T -> A -> D(disabled) -> B, X unwired; B loops through a batch node. */
  const wf: WorkflowDescription = workflow('convert', [
    node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0]), node('D', 'set', [2, 0], { disabled: true }),
    { id: 'L', name: 'L', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 3, position: [3, 0], batch: { batchSize: 2 } },
    node('Body', 'set', [4, 0]), node('X', 'set', [5, 0]),
  ], [
    conn('T', 0, 'A', 0), conn('A', 0, 'D', 0), conn('D', 0, 'L', 0), conn('L', 1, 'Body', 0), conn('Body', 0, 'L', 0),
  ], 'T', { shapes: { L: { inputCount: 1, outputCount: 2 } } });

  it('roots, splices, deduplicates and marks the return edge', () => {
    const c = convertV2(wf, 'T');
    expect(c.trigger).toBe('T');
    expect(c.nodes.map((n) => n.name)).toEqual(['T', 'A', 'L', 'Body']);
    expect(c.unrooted).toEqual(['X']);
    expect(c.spliced).toEqual(['D']);
    expect(text(c.edges)).toEqual(['T.0 -> A.0', 'L.1 -> Body.0', 'Body.0 -> L.0', 'A.0 -> L.0']);
    expect([...c.back].map((i) => text([c.edges[i]!])[0])).toEqual(['Body.0 -> L.0']);
  });

  it('refuses in convert\'s order: node checks, then connection types, then markBackEdges, then no trigger', () => {
    const patched = (name: string, patch: Partial<NodeDescription>, w: WorkflowDescription = wf): WorkflowDescription =>
      ({ ...w, nodes: w.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)) });
    const cycle = { ...wf, connections: [...wf.connections, conn('Body', 0, 'A', 0)] };
    expect(codeOf(() => convertV2(cycle, 'T'))).toBe('v2-loop-shape');
    const typed = patched('Body', { aiOutputs: ['ai_tool'] }, cycle);
    expect(codeOf(() => convertV2(typed, 'T'))).toBe('v2-connection-type');
    expect(codeOf(() => convertV2(patched('A', { onError: 'continueErrorOutput' }, typed), 'T'))).toBe('v2-continue-error-output');
    // A disabled node is not converted, so its own onError is not refused; its connections are.
    expect(codeOf(() => convertV2(patched('D', { onError: 'continueErrorOutput' }), 'T'))).toBe('returned');
    expect(codeOf(() => convertV2(patched('D', { aiOutputs: ['ai_memory'] }), 'T'))).toBe('v2-connection-type');
    // With no trigger nothing is rooted: X's defect is the converter's, before the missing trigger.
    const none = { ...patched('T', { type: 'set' }), startNode: undefined };
    expect(codeOf(() => convertV2(none, undefined))).toBe('v2-trigger-count');
    expect(codeOf(() => convertV2(patched('X', { onError: 'continueErrorOutput' }, none), undefined))).toBe('v2-continue-error-output');
  });

  it('asks a node\'s shape only for a Merge check without mergeMode: assertSupportedMergeMode runs on MERGE_TYPE only', () => {
    const asked: string[] = [];
    const counting: WorkflowDescription = { ...wf, nodeTypes: (n) => {
      asked.push(n.name);
      return n.type === MERGE_TYPE ? { inputCount: 2, outputCount: 1 } : wf.nodeTypes(n);
    } };
    convertV2(counting, 'T');
    expect(asked).toEqual([]);
    const merge = { ...counting, nodes: counting.nodes.map((n) => (n.name === 'A' ? { ...n, type: MERGE_TYPE } : n)) };
    convertV2(merge, 'T');
    expect(asked).toEqual(['A']);
    asked.length = 0;
    convertV2({ ...merge, nodes: merge.nodes.map((n) => ({ ...n, mergeMode: null })) }, 'T');
    expect(asked).toEqual([]);
  });

  // Review finding (a): `rootAt` is `getChildNodes` over n8n's connections map, by name.
  it('roots through the hops a description cannot hold as connections, as getChildNodes walks them', () => {
    // T -> Ghost -> B, where Ghost is a key of the map and no node: n8n reaches B, drops both edges.
    const ghost: WorkflowDescription = {
      ...workflow('ghost', [node('T', 'trigger', [0, 0]), node('B', 'set', [1, 0])], [], 'T'),
      strayConnections: { main: [{ from: 'T', to: 'Ghost' }, { from: 'Ghost', to: 'B' }], sources: [] },
    };
    expect([...rootAtTrigger([], 'T', ghost.strayConnections!.main)].sort()).toEqual(['B', 'Ghost', 'T']);
    const c = convertV2(ghost, 'T');
    expect(c.nodes.map((n) => n.name)).toEqual(['T', 'B']);
    expect(c.edges).toEqual([]);
    expect(c.unrooted).toEqual([]);
    // So B's own defect is the converter's to refuse.
    const refused = { ...ghost, nodes: ghost.nodes.map((n) => (n.name === 'B' ? { ...n, onError: 'continueErrorOutput' as const } : n)) };
    expect(codeOf(() => convertV2(refused, 'T'))).toBe('v2-continue-error-output');
    // Without the hops B is not reached, and nothing is refused.
    expect(convertV2({ ...refused, strayConnections: undefined }, 'T').unrooted).toEqual(['B']);
  });

  it('checks the connection types of a map key that names no node once rootAt reaches it, or when nothing is rooted', () => {
    const base = workflow('ghost-source', [node('T', 'trigger', [0, 0]), node('B', 'set', [1, 0])], [conn('T', 0, 'B', 0)], 'T');
    const sources = [{ name: 'Ghost', aiOutputs: ['ai_languageModel'] }];
    const unreached: WorkflowDescription = { ...base, strayConnections: { main: [], sources } };
    expect(codeOf(() => convertV2(unreached, 'T'))).toBe('returned');
    const reached: WorkflowDescription = { ...base, strayConnections: { main: [{ from: 'B', to: 'Ghost' }], sources } };
    expect(codeOf(() => convertV2(reached, 'T'))).toBe('v2-connection-type');
    const none = { ...unreached, nodes: unreached.nodes.map((n) => (n.name === 'T' ? { ...n, type: 'set' } : n)), startNode: undefined };
    expect(codeOf(() => convertV2(none, undefined))).toBe('v2-connection-type');
  });

  it('raises an InternalCompilerError, never a CompileError, for a site the port rules out', async () => {
    const { refuseV2 } = await import('../../../src/compiler/analysis/engine-v2/refusals.js');
    expect(() => refuseV2('severalTriggers', 'x')).toThrow(InternalCompilerError);
    expect(() => refuseV2('convergingInput', 'x', undefined, 'v2-loop-shape')).toThrow(InternalCompilerError);
    expect(() => refuseV2('slotAboveMax', 'x', 'N', 'input-index-out-of-range')).toThrow(CompileError);
  });
});

describe('edges are matched back to the analysis by an injective key (review 3)', () => {
  it('two edges whose U+0000-joined keys collide both survive, and n8n accepts the graph', () => {
    // Under the old key `${from}\0${out}\0${to}\0${in}` both edges below read
    // 'Trigger\u00000\u0000P\u00000\u0000Q\u00000': Trigger -> 'P\0 0\0 Q' and 'Trigger\0 0\0 P' -> Q.
    const tp = 'Trigger\u00000\u0000P';
    const pq = 'P\u00000\u0000Q';
    const wf = workflow('nul-names', [
      node('Trigger', 'trigger', [0, 0]),
      node(tp, 'set', [200, 0]),
      node(pq, 'set', [200, 200]),
      node('Q', 'set', [400, 0]),
    ], [conn('Trigger', 0, pq, 0), conn('Trigger', 0, tp, 0), conn(tp, 0, 'Q', 0)], 'Trigger');
    const compiled = compile(wf, { profile: 'engineV2' });
    for (const n of [tp, pq, 'Q']) expect(compiled.netMap.settlement(n)).toBeDefined();
  });
});
