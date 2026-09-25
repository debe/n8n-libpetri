/**
 * What `analyse()` computes under `engineV2` besides the loops and the refusals
 * (`tasks/v2-profile-plan.md` step 4, decisions 9 and 11): the compiled node set is the trigger
 * and its descendants, and the v1 phases engine v2 has no counterpart for are not run — a node
 * declaring what one of them would read is diagnosed, never silently read.
 */
import { analyse, kSafety } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import { ACCEPTED, analyseV2, loop } from '../../fixtures/v2-graphs.js';
import { agentOneTool, conn, diamond, expressionRef, failurePolicy, node, retry, workflow } from '../../fixtures/workflows.js';

describe('the compiled node set (decision 9)', () => {
  it('is the trigger and its descendants over every edge, back edges included', () => {
    expect([...analyseV2(loop).reachable].sort()).toEqual(['After', 'B', 'Body', 'T']);
  });

  it('leaves out, with a diagnostic, what the converter drops and the orphan disabled-node splicing leaves', () => {
    // T -> A -> D.1 -> Y -> W, D disabled, X unwired: `rootAt` drops X; `spliceOutDisabledNodes`
    // joins slot 0 only, so Y and W lose their way in and stay in the graph unreached. v2 owes
    // them no step (`countExpectedSettledSteps`), and neither do we.
    const wf = workflow('orphans', [
      node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0]), node('D', 'merge', [2, 0], { disabled: true }),
      node('Y', 'set', [3, 0]), node('W', 'set', [4, 0]), node('X', 'set', [5, 0]),
    ], [conn('T', 0, 'A', 0), conn('A', 0, 'D', 1), conn('D', 0, 'Y', 0), conn('Y', 0, 'W', 0)], 'T');
    const a = analyse(wf, { profile: 'engineV2' });
    expect(a.nodes.map((n) => n.node.name)).toEqual(['T', 'A', 'Y', 'W']);
    expect([...a.reachable].sort()).toEqual(['A', 'T']);
    expect(a.diagnostics).toEqual([
      "node 'X' is not reachable from the trigger 'T'; engine v2's converter drops it (rootAt), so it is not " +
      'compiled under engineV2',
      "node 'D' is disabled; engine v2's converter splices it out, joining the edges into its input 0 to the edges " +
      'out of it (spliceOutDisabledNodes), so it is not compiled under engineV2',
      "node 'Y' is not reachable from the trigger; engine v2 owes it no step (countExpectedSettledSteps), so it " +
      'is not compiled under engineV2',
      "node 'W' is not reachable from the trigger; engine v2 owes it no step (countExpectedSettledSteps), so it " +
      'is not compiled under engineV2',
    ]);
  });

  it.each(Object.entries(ACCEPTED))('%s: gives every compiled node but the trigger an incoming edge', (_name, graph) => {
    const a = analyseV2(graph);
    for (const n of a.reachable) if (n !== a.engineV2!.trigger) expect(a.incoming.get(n)!.length, n).toBeGreaterThan(0);
  });
});

describe('the v1 phases, not run under engineV2', () => {
  it('leave no depth, reference, skip observer, dead input, budget fact or agent', () => {
    for (const wf of [diamond, expressionRef, agentOneTool]) {
      const a = analyse(wf, { profile: 'engineV2' });
      expect([...a.depth.values()].every((d) => d === 0), wf.name).toBe(true);
      expect(a.maxDepth).toBe(0);
      expect([a.referenced.size, a.seededSkipped.size, a.skipObservable.size], wf.name).toEqual([0, 0, 0]);
      expect([a.multiProducerInputs, a.toolConnections, a.hasAgents], wf.name).toEqual([[], [], false]);
      for (const n of a.nodes) {
        expect([n.references, n.deadInputs, n.retry, n.failure, n.requiredInputs, n.tools, n.maxRounds], n.node.name)
          .toEqual([[], [], null, null, null, [], null]);
      }
    }
  });

  it('diagnose each ignored declaration: a reference, retryOnFail, a policy, requiredInputs, ai_tool', () => {
    const diagnostics = (wf: Parameters<typeof analyse>[0]): readonly string[] => analyse(wf, { profile: 'engineV2' }).diagnostics;
    expect(diagnostics(expressionRef)).toEqual([
      "node 'B' references 'A'; engine v2 does not order a step after the nodes its expressions read, so the " +
      'reference is ignored under engineV2',
    ]);
    expect(diagnostics(retry)).toEqual(["node 'A' has retryOnFail; engine v2 has no retry, so it is ignored under engineV2"]);
    expect(diagnostics(failurePolicy)).toEqual([
      "node 'A' declares an executionPolicy; engine v2 has none, so it is ignored under engineV2",
    ]);
    // Merge v3 in mode append declares `requiredInputs: 1`, which names no input; a chooseBranch
    // Merge is refused instead (`v2-merge-mode`, `refusals.test.ts`).
    const append = { ...diamond, nodeTypes: (n: Parameters<typeof diamond.nodeTypes>[0]) =>
      n.name === 'Merge' ? { inputCount: 2, outputCount: 1, requiredInputs: 1 } : diamond.nodeTypes(n) };
    expect(diagnostics(append)).toEqual([
      "node 'Merge' declares requiredInputs; engine v2 queues a node once any input is live, so they are ignored " +
      'under engineV2',
    ]);
    expect(diagnostics(agentOneTool)).toEqual([
      'ai_tool connection Calculator -> Agent is ignored under engineV2: engine v2 roots the graph at the trigger ' +
      'through main connections only, and fails an agent at its first tool call',
      "node 'Calculator' is not reachable from the trigger 'Trigger'; engine v2's converter drops it (rootAt), so it " +
      'is not compiled under engineV2',
    ]);
  });

  it('restrict no budget: a batch loop is a cycle, but engine v2 has no budget to force to 1', () => {
    const { description } = graphToDescription(loop);
    expect(kSafety(analyse(description, { profile: 'engineV2' }))).toBeNull();
    expect(kSafety(analyse(description))).toMatchObject({ reason: 'cyclic' });
  });

  it('leave a v1 analysis without engine v2 facts', () => {
    expect(analyse(diamond).engineV2).toBeNull();
    expect(analyse(diamond, { profile: 'engineV2' }).engineV2!.trigger).toBe('Trigger');
  });
});
