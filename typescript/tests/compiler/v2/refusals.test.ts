/**
 * What engine v2 refuses, refused by the `engineV2` analysis as `CompileError`s
 * (`tasks/v2-profile-plan.md` step 4, `analysis/engine-v2/shape.ts` and `nodes.ts`). Each case
 * names the n8n throw site it mirrors; the message cites it too, so a refusal can be traced back
 * to n8n's own rule. Throw sites, at the pin `n8n@2.41.3`:
 * - `validate-executable-graph.ts` `validateExecutableGraph` (`@n8n/engine` `graph/`);
 * - `loops.ts` `validateLoops` (`@n8n/engine` `graph/`);
 * - `v1-workflow-converter.ts` `markBackEdges` / `resolveSingleBatchEntry`, `toGraphNode` and
 *   `assertSupportedMergeMode` (`@n8n/node-engine-compatibility`);
 * - `step-ready-handler.ts` `StepReadyHandler.executorFor` (`@n8n/engine` `execution/`).
 *
 * What a case claims is stated in it. A case on a stage-1 graph (n8n's own converted shape) is
 * n8n's verdict and code. A case on a raw description meets n8n's rule without the converter's
 * `rootAt`, `spliceOutDisabledNodes` and `toBatchConfig` in front of it (stage 2, step 13), so
 * where those would decide first the case says so rather than claim parity; `v2-disabled-node`
 * is ours outright. With several defects in one graph only the verdict is n8n's, not the code.
 */
import { analyse, compile, CompileError, MERGE_TYPE, SPLIT_IN_BATCHES_TYPE } from '../../../src/compiler/index.js';
import type { CompileErrorCode, NodeDescription, WorkflowDescription } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import {
  ALL, chooseBranch, conn, continueErrorOutput, diamond, linear, multiProducer, twoTriggers, userCycle, workflow,
} from '../../fixtures/workflows.js';
import { backEdge, batch, edge, trigger, v1, waitStep } from '../../fixtures/v2-graphs.js';

/** `code: message` of the `CompileError` the engineV2 analysis throws, or `accepted`. */
function verdict(description: WorkflowDescription): string {
  try {
    analyse(description, { profile: 'engineV2' });
  } catch (e) {
    if (e instanceof CompileError) return `${e.code}: ${e.message}`;
    throw e;
  }
  return 'accepted';
}

const verdictOf = (graph: V2Graph): string => verdict(graphToDescription(graph).description);

/** `wf` with `patch` applied to node `name`. */
const withNode = (wf: WorkflowDescription, name: string, patch: Partial<NodeDescription>): WorkflowDescription =>
  ({ ...wf, nodes: wf.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)) });

/** The node a refusal names, beside its code. */
function refusalOf(description: WorkflowDescription): { code: CompileErrorCode; node: string | undefined } {
  try {
    analyse(description, { profile: 'engineV2' });
  } catch (e) {
    if (e instanceof CompileError) return { code: e.code, node: e.node };
    throw e;
  }
  throw new Error('accepted');
}

describe('v2-trigger-count (validateExecutableGraph, validate-executable-graph.ts)', () => {
  it('refuses two start nodes: v2 has exactly one trigger step', () => {
    expect(verdict({ ...linear, startNode: undefined, startNodes: ['Trigger', 'A'] })).toBe(
      'v2-trigger-count: compile: engine v2 starts from exactly one trigger, and the workflow declares 2 start ' +
      'nodes (Trigger, A) (validateExecutableGraph, validate-executable-graph.ts)');
  });

  it('refuses none, as the same refusal rather than v1\'s no-start-node', () => {
    expect(verdict({ ...linear, startNode: undefined })).toMatch(/^v2-trigger-count: .*declares 0 start nodes/);
    // A start node listed twice is one trigger.
    expect(verdict({ ...linear, startNode: undefined, startNodes: ['Trigger', 'Trigger'] })).toBe('accepted');
  });
});

describe('v2-unbatched-cycle (markBackEdges → UnsupportedCycleError, v1-workflow-converter.ts)', () => {
  it('refuses a cycle with no batch node', () => {
    expect(verdict(userCycle)).toBe(
      'v2-unbatched-cycle: compile: nodes A, B form a cycle with no batch node; engine v2 loops only through a ' +
      'Split In Batches v3 (UnsupportedCycleError, v1-workflow-converter.ts)');
  });

  // n8n refuses this graph earlier, in `toBatchConfig` (a Split In Batches of version 2), which
  // step 13 ports; until then the description reaches `markBackEdges` as a cycle through an
  // ordinary node. Same verdict, not n8n's error.
  it('refuses a loop through a Split In Batches at another version: only v3 is v2\'s batch step', () => {
    const b = { id: 'B', name: 'B', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 2, position: [1, 0] as const };
    const wf = workflow('sib-v2', [
      { id: 'T', name: 'T', type: 'trigger', typeVersion: 1, position: [0, 0] }, b,
      { id: 'Body', name: 'Body', type: 'set', typeVersion: 1, position: [2, 0] },
    ], [conn('T', 0, 'B', 0), conn('B', 1, 'Body', 0), conn('Body', 0, 'B', 0)], 'T',
    { shapes: { B: { inputCount: 1, outputCount: 2 } } });
    expect(verdict(wf)).toMatch(/^v2-unbatched-cycle: compile: nodes B, Body form a cycle with no batch node/);
  });
});

describe('v2-loop-shape (validateLoops, graph/loops.ts; UnsupportedLoopEntryError, v1-workflow-converter.ts)', () => {
  const loopShape = (graph: V2Graph): string => {
    const v = verdictOf(graph);
    expect(v).toMatch(/^v2-loop-shape: /);
    return v;
  };

  it('refuses a loop entered other than through one batch node (resolveSingleBatchEntry)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('T', 'Body'), edge('B', 'Body', 1), edge('Body', 'B')],
    })).toMatch(/is entered through B, Body; .*\(UnsupportedLoopEntryError, v1-workflow-converter\.ts\)$/);
  });

  it('refuses a batch node with no back-edge (rule 3, none)', () => {
    expect(loopShape({ nodes: [trigger('T'), batch('B'), v1('After')], edges: [edge('T', 'B'), edge('B', 'After')] }))
      .toMatch(/batch node 'B' has no back-edge returning to it, .*\(validateLoops rule 3, graph\/loops\.ts\)$/);
  });

  it('refuses a batch node with no literal batch size', () => {
    const { description } = graphToDescription({
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B')],
    });
    const noSize: WorkflowDescription = {
      ...description,
      nodes: description.nodes.map((n) => n.name === 'B' ? { ...n, batch: { batchSize: 'expression' } } : n),
    };
    expect(verdict(noSize)).toMatch(/^v2-loop-shape: compile: batch node 'B' has no batch size, .*\(validateLoops, graph\/loops\.ts\)$/);
  });

  it('refuses a loop with the trigger inside it', () => {
    expect(loopShape({ nodes: [trigger('T'), batch('B')], edges: [edge('T', 'B'), edge('B', 'T', 1)] }))
      .toMatch(/trigger 'T' is inside the loop of 'B'/);
  });

  it('refuses a nested loop (UnimplementedError)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('Outer'), batch('Inner'), v1('Body'), v1('AfterInner')],
      edges: [
        edge('T', 'Outer'), edge('Outer', 'Inner', 1), edge('Inner', 'Body', 1), backEdge('Body', 'Inner'),
        edge('Inner', 'AfterInner', 0), backEdge('AfterInner', 'Outer'),
      ],
    })).toMatch(/batch node 'Inner' sits inside the loop of 'Outer'; engine v2 does not support nested loops/);
  });

  it('refuses a return into a slot other than 0 (rule 2)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), edge('Body', 'B', 0, 1)],
    })).toMatch(/back-edge Body -> B feeds input slot 1; returns feed the batch node's slot 0/);
  });

  it('refuses two returns (rule 3, several; UnimplementedError)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('X'), v1('Y')],
      edges: [edge('T', 'B'), edge('B', 'X', 1), edge('B', 'Y', 1), backEdge('X', 'B'), backEdge('Y', 'B')],
    })).toMatch(/batch node 'B' has 2 back-edges/);
  });

  it('refuses an edge into a batch node\'s slot 1 (rule 4)', () => {
    expect(loopShape({
      nodes: [trigger('T'), v1('If', 'n8n-nodes-base.if'), batch('B'), v1('Body')],
      edges: [edge('T', 'If'), edge('If', 'B', 0, 0), edge('If', 'B', 1, 1), edge('B', 'Body', 1), backEdge('Body', 'B')],
    })).toMatch(/edge If -> B feeds input slot 1 of a batch node, which has only slot 0/);
  });

  it('refuses an edge from a batch node\'s output 2 (rule 4)', () => {
    const { description } = graphToDescription({
      nodes: [trigger('T'), batch('B'), v1('Body'), v1('X')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B')],
    });
    const threeOutputs: WorkflowDescription = {
      ...description,
      connections: [...description.connections, conn('B', 2, 'X', 0)],
      nodeTypes: (n) => n.name === 'B' ? { inputCount: 1, outputCount: 3 }
        : n.name === 'X' ? { inputCount: 1, outputCount: 0 } : description.nodeTypes(n),
    };
    expect(verdict(threeOutputs)).toMatch(/edge B -> X leaves output slot 2 of a batch node, which has only done \(0\) and loop \(1\)/);
  });

  it('refuses two entry edges (UnimplementedError), before the converging-slot rule sees them', () => {
    expect(loopShape({
      nodes: [trigger('T'), v1('If', 'n8n-nodes-base.if'), batch('B'), v1('Body')],
      edges: [edge('T', 'If'), edge('If', 'B', 0), edge('If', 'B', 1), edge('B', 'Body', 1), backEdge('Body', 'B')],
    })).toMatch(/batch node 'B' has 2 entry edges/);
  });

  it('refuses an exit from mid-body (rule 5; UnimplementedError)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('Body'), v1('After')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B'), edge('Body', 'After')],
    })).toMatch(/edge Body -> After leaves the loop of 'B' mid-body/);
  });

  it('refuses an exit from the loop slot (rule 5)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('Body'), v1('After')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B'), edge('B', 'After', 1)],
    })).toMatch(/edge B -> After leaves the loop from the loop slot; only the done slot \(0\) exits/);
  });

  it('refuses a done slot that feeds the body (rule 5)', () => {
    expect(loopShape({
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 0), backEdge('Body', 'B')],
    })).toMatch(/done slot of 'B' feeds 'Body', a member of its own loop/);
  });
});

describe('v2-converging-input (validateExecutableGraph, validate-executable-graph.ts)', () => {
  it('refuses two edges into one input slot', () => {
    expect(verdict(multiProducer)).toBe(
      "v2-converging-input: compile: node 'C' has more than one edge into input slot 0; engine v2 does not " +
      'converge branches on one slot (validateExecutableGraph, validate-executable-graph.ts)');
  });

  it('does not count a return edge: entry and return share the batch node\'s slot 0', () => {
    expect(verdictOf({
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B')],
    })).toBe('accepted');
  });
});

describe('v2-unreachable-feeder (validateExecutableGraph, validate-executable-graph.ts)', () => {
  // A raw description is not rooted: n8n's `rootAt` drops TrigB (the trigger does not reach it)
  // before this rule runs, and then accepts the graph. So this is the rule, applied ahead of
  // stage 2's `rootAt`, not n8n's verdict on `twoTriggers`; the stage-1 case below is both.
  it('refuses an edge into a node the trigger reaches from one it cannot reach', () => {
    expect(verdict(twoTriggers)).toBe(
      'v2-unreachable-feeder: compile: edge TrigB -> Merge feeds a node the trigger reaches from one it cannot ' +
      "reach, so 'Merge' would wait on 'TrigB' forever (validateExecutableGraph, validate-executable-graph.ts)");
  });

  it('refuses the orphan disabled-node splicing leaves, once it feeds the reached graph', () => {
    // `spliceOutDisabledNodes` joins input slot 0 only: A -> Disabled.1 -> Y leaves Y with no
    // incoming edge, and Y -> M then feeds a node the trigger reaches.
    expect(verdictOf({
      nodes: [trigger('T'), v1('A'), v1('Y'), v1('M', 'n8n-nodes-base.merge')],
      edges: [edge('T', 'A'), edge('A', 'M', 0, 0), edge('Y', 'M', 0, 1)],
    })).toMatch(/^v2-unreachable-feeder: compile: edge Y -> M /);
  });
});

describe('a slot above MAX_SLOT_INDEX (validateExecutableGraph, validate-executable-graph.ts)', () => {
  it('is out of range for engine v2, whatever the node declares', () => {
    expect(verdictOf({
      nodes: [trigger('T'), v1('S', 'n8n-nodes-base.switch'), v1('P')],
      edges: [edge('T', 'S'), edge('S', 'P', 101)],
    })).toBe(
      'output-index-out-of-range: compile: edge S -> P has slot index 101; engine v2 supports no slot above 100 ' +
      '(validateExecutableGraph, validate-executable-graph.ts)');
    expect(verdictOf({ nodes: [trigger('T'), v1('S'), v1('P')], edges: [edge('T', 'S'), edge('S', 'P', 100)] }))
      .toBe('accepted');
  });
});

describe('v2-continue-error-output (toGraphNode → UnsupportedWorkflowError, v1-workflow-converter.ts)', () => {
  it('refuses a node with onError continueErrorOutput', () => {
    expect(verdict(continueErrorOutput)).toBe(
      "v2-continue-error-output: compile: node 'A' uses onError=continueErrorOutput, which engine v2 does not " +
      'support (UnsupportedWorkflowError, toGraphNode, v1-workflow-converter.ts)');
    expect(refusalOf(continueErrorOutput).node).toBe('A');
  });

  it('refuses it by the converter\'s rule, not only the fixture: any reached node, any wiring', () => {
    expect(verdict(withNode(linear, 'A', { onError: 'continueErrorOutput' }))).toMatch(/^v2-continue-error-output: .*'A'/);
  });

  it('exempts the trigger, which toGraphNode makes a trigger step first, and a node rootAt drops', () => {
    expect(verdict(withNode(linear, 'Trigger', { onError: 'continueErrorOutput' }))).toBe('accepted');
    const orphan = workflow('orphan-ceo', [...linear.nodes,
      { id: 'X', name: 'X', type: 'set', typeVersion: 1, position: [0, 500], onError: 'continueErrorOutput' }],
    linear.connections, 'Trigger');
    expect(verdict(orphan)).toBe('accepted');
  });
});

describe('v2-merge-mode (assertSupportedMergeMode → UnsupportedWorkflowError, v1-workflow-converter.ts)', () => {
  it('refuses a Merge in chooseBranch mode', () => {
    expect(verdict(chooseBranch)).toBe(
      "v2-merge-mode: compile: node 'Merge' is a Merge in mode chooseBranch, which engine v2 does not support: " +
      'it waits for data on every input, and v2 runs a node once any input is live (UnsupportedWorkflowError, ' +
      'assertSupportedMergeMode, v1-workflow-converter.ts)');
  });

  /** `diamond` with its Merge given n8n's type and the shape n8n evaluates for `requiredInputs`. */
  const n8nMerge = (requiredInputs: number | readonly number[]): WorkflowDescription => {
    const wf = withNode(diamond, 'Merge', { type: MERGE_TYPE, typeVersion: 3 });
    return { ...wf, nodeTypes: (n) => (n.name === 'Merge' ? { inputCount: 2, outputCount: 1, requiredInputs } : diamond.nodeTypes(n)) };
  };

  it('reads n8n\'s Merge by its requiredInputs: [0, 1] is chooseBranch, 1 is any other mode', () => {
    expect(verdict(n8nMerge([0, 1]))).toMatch(/^v2-merge-mode: /);
    expect(verdict(n8nMerge(1))).toBe('accepted');
  });

  it('refuses n8n\'s chooseBranch Merge whatever is wired into it: the converter reads the mode, not the edges', () => {
    const one = { ...n8nMerge([0, 1]), connections: diamond.connections.filter((c) => !(c.to === 'Merge' && c.inputIndex === 1)) };
    expect(verdict(one)).toMatch(/^v2-merge-mode: /);
  });

  it('leaves a node of another type that requires its one input: it is no join, and n8n checks only Merge', () => {
    const wf = { ...linear, nodeTypes: (n: NodeDescription) => (n.name === 'A' ? { inputCount: 1, outputCount: 1, requiredInputs: 1 } : linear.nodeTypes(n)) };
    expect(verdict(wf)).toBe('accepted');
  });
});

describe('v2-disabled-node (ours: spliceOutDisabledNodes is stage 2, v1-workflow-converter.ts)', () => {
  it('refuses a disabled node the trigger reaches, naming it, rather than compile it as if it ran', () => {
    const wf = withNode(linear, 'A', { disabled: true });
    expect(verdict(wf)).toBe(
      "v2-disabled-node: compile: node 'A' is disabled; engine v2 splices a disabled node out of the graph " +
      '(spliceOutDisabledNodes, v1-workflow-converter.ts), which the engineV2 profile does not port yet');
    expect(refusalOf(wf).node).toBe('A');
    expect(() => compile(wf, { profile: 'engineV2' })).toThrow(CompileError);
  });

  it('leaves a disabled node the trigger does not reach, which rootAt drops before splicing', () => {
    const orphan = workflow('orphan-disabled', [...linear.nodes,
      { id: 'X', name: 'X', type: 'set', typeVersion: 1, position: [0, 500], disabled: true }],
    linear.connections, 'Trigger');
    expect(verdict(orphan)).toBe('accepted');
  });

  it('comes after the converter\'s own node checks, which see only the live nodes', () => {
    // B sits above A on the canvas, so it comes first in canvas order, and still A is refused.
    const both = withNode(continueErrorOutput, 'B', { disabled: true });
    expect(refusalOf(both)).toEqual({ code: 'v2-continue-error-output', node: 'A' });
    // A disabled node is not converted, so its own onError is not the converter's to refuse.
    expect(refusalOf(withNode(continueErrorOutput, 'A', { disabled: true }))).toEqual({ code: 'v2-disabled-node', node: 'A' });
  });
});

describe('v2-unsupported-step (StepReadyHandler.executorFor → UnimplementedError, step-ready-handler.ts)', () => {
  it('refuses a wait step: v2 never settles it, while its siblings complete', () => {
    expect(verdictOf(waitStep)).toBe(
      "v2-unsupported-step: compile: node 'W' is a wait step, which engine v2 has no executor for: it would stay " +
      'running and never settle (UnimplementedError, StepReadyHandler.executorFor, step-ready-handler.ts)');
    expect(() => compile(graphToDescription(waitStep).description, { profile: 'engineV2' })).toThrow(CompileError);
  });

  it('refuses a subworkflow step', () => {
    expect(verdictOf({ nodes: [trigger('T'), { id: 'S', name: 'S', type: 'subworkflow' }], edges: [edge('T', 'S')] }))
      .toMatch(/^v2-unsupported-step: compile: node 'S' is a subworkflow step/);
  });

  it('comes after the shape refusals: n8n validates the graph before it runs a step', () => {
    expect(verdictOf({
      nodes: [trigger('T'), v1('If', 'n8n-nodes-base.if'), { id: 'W', name: 'W', type: 'wait' }],
      edges: [edge('T', 'If'), edge('If', 'W', 0), edge('If', 'W', 1)],
    })).toMatch(/^v2-converging-input: /);
  });
});

describe('several defects in one graph', () => {
  // `shape.ts`: accept versus refuse is n8n's, the code is the first defect in our component
  // order, which may not be the one n8n's Tarjan order throws on.
  it('are refused, with the code of one of them', () => {
    const graph: V2Graph = {
      nodes: [trigger('T'), v1('A'), v1('B'), batch('L'), v1('Body')],
      edges: [
        // A cycle with no batch node.
        edge('T', 'A'), edge('A', 'B'), edge('B', 'A'),
        // A loop entered through its body as well as through its batch node.
        edge('T', 'L', 1), edge('T', 'Body', 2), edge('L', 'Body', 1), edge('Body', 'L'),
      ],
    };
    const { code } = refusalOf(graphToDescription(graph).description);
    expect(['v2-unbatched-cycle', 'v2-loop-shape']).toContain(code);
  });
});

describe('the compiler fixtures under engineV2', () => {
  // Each comment says whether n8n, handed the same workflow with its trigger fired, reaches the
  // same verdict: every one does except `twoTriggers`.
  it('are accepted or refused as pinned', () => {
    const verdicts = Object.fromEntries(Object.entries(ALL).map(([name, wf]) => {
      const v = verdict(wf);
      return [name, v === 'accepted' ? v : (v.split(':')[0] as CompileErrorCode)];
    }));
    expect(verdicts).toEqual({
      // n8n accepts these too: retryOnFail, references and executionPolicy are ignored, with a
      // diagnostic each (`analysis.test.ts`).
      linear: 'accepted', fanOut: 'accepted', diamond: 'accepted', switch20: 'accepted',
      expressionRef: 'accepted', retry: 'accepted', ifHalf: 'accepted', fanOut4: 'accepted', failurePolicy: 'accepted',
      // A Merge in chooseBranch mode, two and three inputs (assertSupportedMergeMode).
      chooseBranch: 'v2-merge-mode',
      partialRequired: 'v2-merge-mode',
      // A's onError (toGraphNode).
      continueErrorOutput: 'v2-continue-error-output',
      // Two producers into C's one input.
      multiProducer: 'v2-converging-input',
      // v1's Loop Over Items shape is not a Split In Batches v3, so its cycle has no batch node.
      loopOverItems: 'v2-unbatched-cycle',
      userCycle: 'v2-unbatched-cycle',
      // TrigB, not the start node, feeds Merge.1. Not n8n's verdict: `rootAt` would drop TrigB
      // and accept (see the v2-unreachable-feeder case).
      twoTriggers: 'v2-unreachable-feeder',
      // Both IF outputs into C's one input.
      ifBothOutputs: 'v2-converging-input',
    });
  });
});
