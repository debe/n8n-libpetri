/**
 * Engine v2's batch loops, derived again from a description (`tasks/v2-profile-plan.md`
 * decision 6, step 4). A description carries no `isBackEdge`, so the analysis marks the return
 * edges by `markBackEdges`' rule (`node-engine-compatibility` `v1-workflow-converter.ts`) and
 * reads the marked graph by `deriveLoops` (`@n8n/engine` `graph/loops.ts`) and `classifyEdge`
 * (`@n8n/engine` `execution/iteration-mapping.ts`). Each hand-written graph carries the marks
 * n8n's converter puts on it, and the derived ones must equal them edge for edge.
 *
 * The n8n rules the expectations are written from:
 * - `markBackEdges`: the return edges of a loop are its members' edges into the loop's single
 *   entry, which must be a batch node; loops are peeled from the outside in;
 * - `deriveLoops`: a loop's members are its batch node's strongly connected component over
 *   every edge; entries are forward edges into the batch node from outside, exits forward edges
 *   from a member to outside;
 * - `classifyEdge`: `back` if marked; `intra` if both ends share a loop; `exit` if the source is
 *   in a loop (also when the target is in another); `entry` if only the target is; else `plain`.
 */
import type { EdgeRef, V2EdgeClass, WorkflowAnalysis } from '../../../src/compiler/index.js';
import { classifyV2Edge, markV2BackEdges } from '../../../src/compiler/analysis/engine-v2/loops.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import {
  ACCEPTED, analyseV2, backEdge, batch, chain, diamondBody, edge, exitIntoMerge, keyOf, loop, noExit, selfLoop,
  trigger, twoLoops, v1,
} from '../../fixtures/v2-graphs.js';

/** The edges n8n marks `isBackEdge`, by key, sorted. */
const n8nBackEdges = (graph: V2Graph): string[] => graph.edges.filter((e) => e.isBackEdge === true).map(keyOf).sort();

/** The edges the analysis derived as return edges, by key, sorted. */
function derivedBackEdges(analysis: WorkflowAnalysis): string[] {
  return analysis.engineV2!.loops.flatMap((l) => l.backEdges).map(keyOf).sort();
}

/** Every edge's class, by key. */
function classesOf(analysis: WorkflowAnalysis): Record<string, V2EdgeClass> {
  return Object.fromEntries(analysis.edges.map((e) => [keyOf(e), analysis.engineV2!.edgeClass.get(e.id)!]));
}

/** A graph's edges as `EdgeRef`s, for calling the derivation without an analysis. */
const refsOf = (graph: V2Graph): EdgeRef[] => graph.edges.map((e, id) => ({ ...e, id, kind: 'tree' }));

/** The same graph with its nodes and edges in reverse order. */
const reversed = (graph: V2Graph): V2Graph => ({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });

describe('back edges', () => {
  it.each(Object.entries(ACCEPTED))('%s: equal the edges n8n marks isBackEdge', (_name, graph) => {
    expect(derivedBackEdges(analyseV2(graph))).toEqual(n8nBackEdges(graph));
  });

  it.each(Object.entries(ACCEPTED))('%s: do not depend on node or edge order ("only set membership decides")', (_name, graph) => {
    expect(derivedBackEdges(analyseV2(reversed(graph)))).toEqual(n8nBackEdges(graph));
  });

  it('are peeled from the outside in on a nested loop, as markBackEdges\' own example marks them', () => {
    // The doc comment of `markBackEdges`: round 1 marks AfterInner -> Outer, round 2 Body -> Inner.
    // `validateLoops` then refuses the nesting (refusals.test.ts); the marks are the converter's.
    const nested: V2Graph = {
      nodes: [trigger('Trigger'), batch('Outer'), batch('Inner'), v1('Body'), v1('AfterInner')],
      edges: [
        edge('Trigger', 'Outer'), edge('Outer', 'Inner', 1), edge('Inner', 'Body', 1), backEdge('Body', 'Inner'),
        edge('Inner', 'AfterInner', 0), backEdge('AfterInner', 'Outer'),
      ],
    };
    const refs = refsOf(nested);
    const marking = markV2BackEdges(nested.nodes.map((n) => n.id), refs, new Set(['Outer', 'Inner']));
    expect(marking.kind).toBe('marked');
    if (marking.kind !== 'marked') return;
    expect(refs.filter((e) => marking.back.has(e.id)).map(keyOf).sort()).toEqual(n8nBackEdges(nested));
  });

  it('report the two cycles the converter throws on, instead of marking them', () => {
    // `resolveSingleBatchEntry`: no batch member is `UnsupportedCycleError`; two entries, or an
    // entry that is not a batch node, is `UnsupportedLoopEntryError`.
    const unbatched: V2Graph = { nodes: [trigger('T'), v1('A'), v1('B')], edges: [edge('T', 'A'), edge('A', 'B'), edge('B', 'A')] };
    expect(markV2BackEdges(['T', 'A', 'B'], refsOf(unbatched), new Set())).toMatchObject({ kind: 'unbatched-cycle' });
    const midBody: V2Graph = {
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('T', 'Body'), edge('B', 'Body', 1), edge('Body', 'B')],
    };
    expect(markV2BackEdges(['T', 'B', 'Body'], refsOf(midBody), new Set(['B'])))
      .toEqual({ kind: 'ambiguous-entry', members: expect.arrayContaining(['B', 'Body']), entries: ['B', 'Body'] });
  });
});

describe('loops', () => {
  it('have the batch node\'s component as members, its one return, entry and exits', () => {
    const [l, ...rest] = analyseV2(loop).engineV2!.loops;
    expect(rest).toEqual([]);
    expect(l!.batchNode).toBe('B');
    expect([...l!.members].sort()).toEqual(['B', 'Body']);
    expect(l!.backEdges.map(keyOf)).toEqual(['Body.0 -> B.0']);
    expect(l!.entryEdges.map(keyOf)).toEqual(['T.0 -> B.0']);
    expect(l!.exitEdges.map(keyOf)).toEqual(['B.0 -> After.0']);
  });

  it('put every body node of a branching body in the loop, and nothing after it', () => {
    const a = analyseV2(diamondBody);
    expect([...a.engineV2!.loops[0]!.members].sort()).toEqual(['B', 'If', 'M', 'P', 'Q']);
    expect([...a.engineV2!.loopOf.keys()].sort()).toEqual(['B', 'If', 'M', 'P', 'Q']);
  });

  it('are one per batch node, in canvas order, with no entry or exit where none is wired', () => {
    expect(analyseV2(twoLoops).engineV2!.loops.map((l) => l.batchNode)).toEqual(['B1', 'B2']);
    const [l] = analyseV2(noExit).engineV2!.loops;
    expect(l!.exitEdges).toEqual([]);
    expect(analyseV2(chain).engineV2!.loops).toEqual([]);
  });
});

describe('edge classes (classifyEdge)', () => {
  it('are plain outside any loop', () => {
    expect(classesOf(analyseV2(chain))).toEqual({ 'T.0 -> A.0': 'plain', 'A.0 -> B.0': 'plain' });
  });

  it('are entry, intra, back and exit around one loop', () => {
    expect(classesOf(analyseV2(loop))).toEqual({
      'T.0 -> B.0': 'entry', 'B.1 -> Body.0': 'intra', 'Body.0 -> B.0': 'back', 'B.0 -> After.0': 'exit',
    });
  });

  it('make a batch node\'s return to itself back, not intra', () => {
    expect(classesOf(analyseV2(selfLoop))).toEqual({ 'T.0 -> B.0': 'entry', 'B.1 -> B.0': 'back', 'B.0 -> After.0': 'exit' });
  });

  it('make an edge from one loop into the next exit, not entry', () => {
    expect(classesOf(analyseV2(twoLoops))['B1.0 -> B2.0']).toBe('exit');
  });

  it('keep a plain edge beside an exit into the same Merge', () => {
    const c = classesOf(analyseV2(exitIntoMerge));
    expect([c['B.0 -> M.0'], c['Other.0 -> M.1'], c['If.0 -> B.0']]).toEqual(['exit', 'plain', 'entry']);
  });

  it('follow classifyEdge on its own inputs', () => {
    const [l] = analyseV2(loop).engineV2!.loops;
    const e = (from: string, to: string): EdgeRef => ({ id: 0, from, to, outputIndex: 0, inputIndex: 0, kind: 'tree' });
    expect(classifyV2Edge(e('Body', 'B'), true, [l!])).toBe('back');
    expect(classifyV2Edge(e('X', 'B'), false, [l!])).toBe('entry');
    expect(classifyV2Edge(e('X', 'Y'), false, [l!])).toBe('plain');
  });
});
