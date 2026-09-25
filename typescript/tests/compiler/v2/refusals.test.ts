/**
 * What engine v2 refuses, refused by the `engineV2` analysis as `CompileError`s
 * (`tasks/v2-profile-plan.md` steps 4 and 13; `analysis/engine-v2/root.ts`, `nodes.ts`,
 * `shape.ts`, each site mapped in `refusals.ts`). Each case names the n8n throw site it mirrors;
 * the message cites it too, so a refusal can be traced back to n8n's own rule. Throw sites, at
 * the pin `n8n@2.41.3`:
 * - `v1-workflow-converter.ts` (`@n8n/node-engine-compatibility`): `resolveFiredTrigger`,
 *   `toGraphNode`, `assertSupportedMergeMode`, `toBatchConfig`, `validateSupportedConnectionType`,
 *   `markBackEdges` / `resolveSingleBatchEntry`;
 * - `loops.ts` `validateLoops` (`@n8n/engine` `graph/`);
 * - `validate-executable-graph.ts` `validateExecutableGraph` (`@n8n/engine` `graph/`);
 * - `step-ready-handler.ts` `StepReadyHandler.executorFor` (`@n8n/engine` `execution/`).
 *
 * A raw description goes through the converter port (`rootAt`, splicing, `toBatchConfig`), so a
 * case on one is n8n's verdict and code for the workflow it describes; a case on a stage-1 graph
 * (n8n's own converted shape) is n8n's verdict on that graph. With several defects in one graph
 * only the verdict is claimed, not the code.
 */
import { analyse, compile, CompileError, MERGE_TYPE, SPLIT_IN_BATCHES_TYPE } from '../../../src/compiler/index.js';
import type { CompileErrorCode, NodeDescription, WorkflowDescription } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import {
  ALL, chooseBranch, conn, continueErrorOutput, diamond, linear, multiProducer, node, twoTriggers, userCycle, workflow,
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

describe('the fired trigger (resolveFiredTrigger, v1-workflow-converter.ts)', () => {
  const v2 = (wf: WorkflowDescription, trigger?: string) => {
    try {
      return analyse(wf, { profile: 'engineV2', ...(trigger === undefined ? {} : { trigger }) }).engineV2!.trigger;
    } catch (e) {
      if (e instanceof CompileError) return `${e.code}: ${e.message}`;
      throw e;
    }
  };

  it('is the one trigger when none is named', () => {
    expect(v2({ ...linear, startNode: undefined })).toBe('Trigger');
  });

  it('refuses several when none is named: "guessing would run the wrong branch" (AmbiguousTriggerError)', () => {
    expect(v2({ ...twoTriggers, startNode: undefined })).toBe(
      "v2-ambiguous-trigger: compile: the workflow has 2 triggers ('TrigA', 'TrigB'), so the trigger that fired " +
      'must be named (AmbiguousTriggerError, resolveFiredTrigger, v1-workflow-converter.ts)');
    // A disabled trigger is not a candidate: the converter looks at live nodes only.
    expect(v2({ ...withNode(twoTriggers, 'TrigB', { disabled: true }), startNode: undefined })).toBe('TrigA');
  });

  it('is the one named, by the trigger option or the start node', () => {
    const none = { ...twoTriggers, startNode: undefined };
    expect(v2(none, 'TrigB')).toBe('TrigB');
    expect(v2(twoTriggers)).toBe('TrigA');
    expect(v2(twoTriggers, 'TrigA')).toBe('TrigA');
    expect(v2(twoTriggers, 'TrigB')).toMatch(/^invalid-options: compile: the trigger option names 'TrigB', and the workflow's start node is 'TrigA'$/);
  });

  it('refuses a name no enabled node has (UnknownTriggerError)', () => {
    expect(v2(linear, 'Nope')).toBe('invalid-options: compile: the trigger option names \'Nope\', and the workflow\'s start node is \'Trigger\'');
    expect(v2({ ...linear, startNode: undefined }, 'Nope')).toBe(
      "v2-unknown-trigger: compile: the workflow has no enabled node named 'Nope' to start from " +
      '(UnknownTriggerError, resolveFiredTrigger, v1-workflow-converter.ts)');
    expect(v2(withNode(linear, 'Trigger', { disabled: true }))).toMatch(/^v2-unknown-trigger: .*'Trigger'/);
  });

  it('refuses a named node that is not of a trigger type (NotATriggerError, isTriggerNodeType)', () => {
    expect(v2({ ...linear, startNode: 'A' })).toBe(
      "v2-not-a-trigger: compile: node 'A' (set) is not a trigger, so nothing can start from it " +
      '(NotATriggerError, resolveFiredTrigger, v1-workflow-converter.ts)');
  });

  it('refuses a workflow with no trigger, after the converter\'s own checks (validateExecutableGraph)', () => {
    const none = { ...withNode(linear, 'Trigger', { type: 'set' }), startNode: undefined };
    expect(v2(none)).toBe(
      'v2-trigger-count: compile: engine v2 starts from a trigger, and the workflow has no enabled node of a ' +
      'trigger type (validateExecutableGraph, validate-executable-graph.ts)');
    // Unrooted, every node is converted: a node refusal comes first.
    expect(v2(withNode(none, 'B', { onError: 'continueErrorOutput' }))).toMatch(/^v2-continue-error-output: /);
  });

  it('refuses a workflow with no nodes as one with no trigger, n8n\'s verdict; v1 keeps empty-workflow', () => {
    const empty = workflow('empty', [], [], 'T');
    expect(v2({ ...empty, startNode: undefined })).toMatch(/^v2-trigger-count: /);
    expect(() => analyse(empty)).toThrow(expect.objectContaining({ code: 'empty-workflow' }));
  });

  it('refuses two start nodes: a description names at most one fired trigger', () => {
    expect(verdict({ ...linear, startNode: undefined, startNodes: ['Trigger', 'A'] })).toBe(
      'v2-trigger-count: compile: engine v2 starts from the one trigger that fired, and the workflow declares 2 start ' +
      'nodes (Trigger, A)');
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

  it('follows splicing: a cycle through a disabled node\'s slot 1 is gone, one through its slot 0 is a self loop', () => {
    // A -> D.1 and D -> A: splicing D joins only slot 0, so the cycle is gone with D.
    const wf = workflow('spliced-cycle', [
      node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0]), node('D', 'merge', [2, 0], { disabled: true }),
    ], [conn('T', 0, 'A', 0), conn('A', 0, 'D', 1), conn('D', 0, 'A', 0)], 'T');
    expect(verdict(wf)).toBe('accepted');
    // Through slot 0 the cycle is spliced into a self loop on A.
    expect(verdict({ ...wf, connections: [conn('T', 0, 'A', 0), conn('A', 0, 'D', 0), conn('D', 0, 'A', 0)] }))
      .toMatch(/^v2-unbatched-cycle: compile: nodes A form a cycle with no batch node/);
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
    // n8n validates the loops in the order of their first back edge (`deriveLoops`), so Inner's
    // loop comes first, and its component holds Outer.
    })).toMatch(/batch node 'Outer' sits inside the loop of 'Inner'; engine v2 does not support nested loops/);
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
  // `rootAt` keeps only what the trigger reaches, so the only node the trigger cannot reach is
  // the orphan `spliceOutDisabledNodes` leaves: it joins input slot 0 only.
  const orphan = (wire: 'feeds' | 'alone'): WorkflowDescription => workflow(`orphan-${wire}`, [
    node('T', 'trigger', [0, 0]), node('A', 'set', [1, 0]), node('D', 'merge', [2, 0], { disabled: true }),
    node('Y', 'set', [3, 0]), node('M', 'merge', [4, 0]),
  ], [
    conn('T', 0, 'A', 0), conn('A', 0, 'D', 1), conn('D', 0, 'Y', 0),
    ...(wire === 'feeds' ? [conn('A', 0, 'M', 0), conn('Y', 0, 'M', 1)] : [conn('Y', 0, 'M', 0)]),
  ], 'T');

  it('refuses the orphan disabled-node splicing leaves, once it feeds the reached graph', () => {
    expect(verdict(orphan('feeds'))).toBe(
      'v2-unreachable-feeder: compile: edge Y -> M feeds a node the trigger reaches from one it cannot reach, so ' +
      "'M' would wait on 'Y' forever (validateExecutableGraph, validate-executable-graph.ts)");
  });

  it('accepts it when it feeds nothing reached: v2 owes it no step (analysis.test.ts)', () => {
    expect(verdict(orphan('alone'))).toBe('accepted');
  });

  it('is not raised by a trigger that did not fire: rootAt drops it', () => {
    expect(verdict(twoTriggers)).toBe('accepted');
    expect(verdict({ ...twoTriggers, startNode: 'TrigB' })).toBe('accepted');
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

  // Review finding (b): n8n copies a connection's `index` as written, so a missing one is
  // `undefined` and refused by the slot rule; the JSON reader hands it over as `NaN`.
  it('refuses a slot that is no number (NaN) by the non-negative-integer rule', () => {
    const wf = { ...linear, connections: linear.connections.map((c, i) => (i === 0 ? { ...c, inputIndex: Number.NaN } : c)) };
    expect(verdict(wf)).toMatch(/^input-index-out-of-range: compile: edge Trigger -> A has slot index NaN; slot indices are non-negative integers/);
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
    expect(verdict(withNode(chooseBranch, 'Merge', { type: MERGE_TYPE, typeVersion: 3, mergeMode: 'chooseBranch' }))).toBe(
      "v2-merge-mode: compile: node 'Merge' is a Merge in mode chooseBranch, which engine v2 does not support: " +
      'it waits for data on every input, and v2 runs a node once any input is live (UnsupportedWorkflowError, ' +
      'assertSupportedMergeMode, v1-workflow-converter.ts)');
  });

  // Review finding: the check is n8n's, on MERGE_TYPE and the literal mode only. A node of another
  // type is never refused for what it requires, whatever is wired into it.
  it('accepts a node of another type whose requiredInputs make v1\'s chooseBranch join, as n8n does', () => {
    // The compiler fixture's Merge is of type `mergeChoose`, which n8n's converter never checks.
    expect(verdict(chooseBranch)).toBe('accepted');
    // CompareDatasets fed on both slots, with a shape that requires both (a user-supplied one).
    const compare = { ...withNode(chooseBranch, 'Merge', { type: 'n8n-nodes-base.compareDatasets', typeVersion: 2.3 }),
      nodeTypes: (n: NodeDescription) => (n.name === 'Merge' ? { inputCount: 2, outputCount: 4, requiredInputs: [0, 1] } : chooseBranch.nodeTypes(n)) };
    expect(verdict(compare)).toBe('accepted');
    expect(analyse(compare, { profile: 'engineV2' }).diagnostics.some((d) => d.includes("'Merge' declares requiredInputs"))).toBe(true);
  });

  it('reads a Merge whose adapter read no string mode (mergeMode null) as n8n does: no mode, accepted', () => {
    const wf = { ...withNode(diamond, 'Merge', { type: MERGE_TYPE, typeVersion: 3, mergeMode: null }),
      nodeTypes: (n: NodeDescription) => (n.name === 'Merge' ? { inputCount: 2, outputCount: 1, requiredInputs: [0, 1] } : diamond.nodeTypes(n)) };
    expect(verdict(wf)).toBe('accepted');
  });

  it('compares the version n8n compares: a version written "3" is 3 there (mergeVersion)', () => {
    const merge = (typeVersion: number, mergeVersion?: number): WorkflowDescription => ({
      ...withNode(diamond, 'Merge', { type: MERGE_TYPE, typeVersion, mergeMode: '={{ "append" }}', ...(mergeVersion === undefined ? {} : { mergeVersion }) }),
      nodeTypes: (n) => (n.name === 'Merge' ? { inputCount: 2, outputCount: 1 } : diamond.nodeTypes(n)),
    });
    expect(verdict(merge(1))).toBe('accepted');
    expect(verdict(merge(1, 3))).toMatch(/^v2-merge-mode: .*sets its Merge mode with an expression/);
    expect(verdict(merge(1, Number.NaN))).toBe('accepted');
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

  it('reads mergeMode literally when the description carries it', () => {
    const merge = (mergeMode: string, typeVersion = 3): WorkflowDescription => ({
      ...withNode(diamond, 'Merge', { type: MERGE_TYPE, typeVersion, mergeMode }),
      nodeTypes: (n) => (n.name === 'Merge' ? { inputCount: 2, outputCount: 1 } : diamond.nodeTypes(n)),
    });
    expect(verdict(merge('chooseBranch'))).toMatch(/^v2-merge-mode: compile: node 'Merge' is a Merge in mode chooseBranch/);
    expect(verdict(merge('append'))).toBe('accepted');
    expect(verdict(merge('={{ $json.mode }}'))).toBe(
      "v2-merge-mode: compile: node 'Merge' sets its Merge mode with an expression, which cannot be checked at " +
      'conversion time; engine v2 needs a literal mode (UnsupportedWorkflowError, assertSupportedMergeMode, ' +
      'v1-workflow-converter.ts)');
    // Merge v1 predates chooseBranch: an expression mode there is left alone.
    expect(verdict(merge('={{ $json.mode }}', 1))).toBe('accepted');
    // The mode wins over requiredInputs: n8n reads the parameter, not the evaluated description.
    const both = { ...merge('append'), nodeTypes: (n: NodeDescription) =>
      (n.name === 'Merge' ? { inputCount: 2, outputCount: 1, requiredInputs: [0, 1] } : diamond.nodeTypes(n)) };
    expect(verdict(both)).toBe('accepted');
    // Only the Merge type is n8n's to check.
    expect(verdict(withNode(diamond, 'Merge', { mergeMode: 'chooseBranch' }))).toBe('accepted');
  });

  it('leaves a node of another type that requires its one input: it is no join, and n8n checks only Merge', () => {
    const wf = { ...linear, nodeTypes: (n: NodeDescription) => (n.name === 'A' ? { inputCount: 1, outputCount: 1, requiredInputs: 1 } : linear.nodeTypes(n)) };
    expect(verdict(wf)).toBe('accepted');
  });
});

describe('disabled nodes are spliced out, never refused (spliceOutDisabledNodes, v1-workflow-converter.ts)', () => {
  it('compiles A -> disabled -> B as A -> B, without the disabled node', () => {
    const wf = withNode(linear, 'B', { disabled: true });
    expect(verdict(wf)).toBe('accepted');
    const a = analyse(wf, { profile: 'engineV2' });
    expect(a.nodes.map((n) => n.node.name)).toEqual(['Trigger', 'A', 'C']);
    expect(a.edges.map((e) => `${e.from}.${e.outputIndex} -> ${e.to}.${e.inputIndex}`)).toEqual(['Trigger.0 -> A.0', 'A.0 -> C.0']);
    expect(compile(wf, { profile: 'engineV2' }).netMap.settlements.map((g) => g.node)).toEqual(['Trigger', 'A', 'C']);
  });

  it('does not check a disabled node the way it checks a live one: the converter converts live nodes only', () => {
    expect(verdict(withNode(continueErrorOutput, 'A', { disabled: true }))).toBe('accepted');
    // B sits above A on the canvas, and disabling it leaves A's refusal.
    expect(refusalOf(withNode(continueErrorOutput, 'B', { disabled: true }))).toEqual({ code: 'v2-continue-error-output', node: 'A' });
  });

  it('can make the converging slot the port then refuses: two producers through one disabled node', () => {
    // IF.0 -> D.0 and IF.1 -> D.0, D -> End: both spliced edges enter End.0.
    const wf = workflow('converge-through-disabled', [
      node('T', 'trigger', [0, 0]), node('IF', 'if', [1, 0]), node('D', 'set', [2, 0], { disabled: true }),
      node('End', 'set', [3, 0]),
    ], [conn('T', 0, 'IF', 0), conn('IF', 0, 'D', 0), conn('IF', 1, 'D', 0), conn('D', 0, 'End', 0)], 'T');
    expect(verdict(wf)).toMatch(/^v2-converging-input: compile: node 'End' has more than one edge into input slot 0/);
  });
});

describe('v2-batch-config (toBatchConfig → UnsupportedWorkflowError, v1-workflow-converter.ts)', () => {
  /** T -> B, B.1 -> Body -> B, with `B` patched. */
  const sib = (patch: Partial<NodeDescription>): WorkflowDescription => workflow('sib', [
    node('T', 'trigger', [0, 0]),
    { id: 'B', name: 'B', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 3, position: [1, 0], batch: { batchSize: 2 }, ...patch },
    node('Body', 'set', [2, 0]),
  ], [conn('T', 0, 'B', 0), conn('B', 1, 'Body', 0), conn('Body', 0, 'B', 0)], 'T',
  { shapes: { B: { inputCount: 1, outputCount: 2 } } });

  it('accepts version 3 with a whole batch size, and without one (DEFAULT_BATCH_SIZE)', () => {
    expect(verdict(sib({}))).toBe('accepted');
    expect(verdict(sib({ batch: undefined }))).toBe('accepted');
  });

  it('refuses each of toBatchConfig\'s cases, in its order', () => {
    const at = '(UnsupportedWorkflowError, toBatchConfig, v1-workflow-converter.ts)';
    expect(verdict(sib({ typeVersion: 2 }))).toBe(
      `v2-batch-config: compile: node 'B' is a Split In Batches of version 2, and engine v2 supports only version 3 ${at}`);
    expect(verdict(sib({ batch: { batchSize: 2, optionsExpression: true } }))).toBe(
      `v2-batch-config: compile: node 'B' sets its options from an expression, which engine v2 does not support ${at}`);
    expect(verdict(sib({ batch: { batchSize: 2, reset: true } }))).toBe(
      `v2-batch-config: compile: node 'B' uses the reset option, which engine v2 does not support ${at}`);
    expect(verdict(sib({ batch: { batchSize: 'expression' } }))).toBe(
      `v2-batch-config: compile: node 'B' sets its batch size from an expression, which engine v2 does not support ${at}`);
    for (const batchSize of [0, 1.5, Number.NaN]) {
      expect(verdict(sib({ batch: { batchSize } }))).toBe(
        `v2-batch-config: compile: node 'B' has a batch size of ${batchSize}, and it must be a whole number of at least 1 ${at}`);
    }
    // The version first: a v1 node with an expression size is refused for its version.
    expect(verdict(sib({ typeVersion: 1, batch: { batchSize: 'expression', reset: true } }))).toMatch(/of version 1,/);
  });

  it('refuses a Split In Batches at another version outside any cycle too: every one becomes a batch step', () => {
    const wf = workflow('sib-v2-plain', [
      node('T', 'trigger', [0, 0]),
      { id: 'B', name: 'B', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 2, position: [1, 0] },
    ], [conn('T', 0, 'B', 0)], 'T', { shapes: { B: { inputCount: 1, outputCount: 2 } } });
    expect(verdict(wf)).toMatch(/^v2-batch-config: .*of version 2/);
  });

  it('leaves a disabled one, and one the trigger does not reach', () => {
    expect(verdict(workflow('sib-off', [
      node('T', 'trigger', [0, 0]),
      { id: 'B', name: 'B', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 2, position: [1, 0], disabled: true },
      { id: 'C', name: 'C', type: SPLIT_IN_BATCHES_TYPE, typeVersion: 2, position: [1, 1] },
    ], [conn('T', 0, 'B', 0)], 'T', { shapes: { B: { inputCount: 1, outputCount: 2 }, C: { inputCount: 1, outputCount: 2 } } })))
      .toBe('accepted');
  });
});

describe('v2-connection-type (validateSupportedConnectionType → UnsupportedConnectionTypeError, v1-workflow-converter.ts)', () => {
  it('refuses a reached node that is the source of a connection other than main, disabled or not', () => {
    const msg = "v2-connection-type: compile: node 'A' has a \"ai_tool\" connection, which engine v2 does not support: " +
      'only "main" connections are (UnsupportedConnectionTypeError, toEdgesForSource, v1-workflow-converter.ts)';
    expect(verdict(withNode(linear, 'A', { aiOutputs: ['ai_tool'] }))).toBe(msg);
    expect(verdict(withNode(linear, 'A', { aiOutputs: ['ai_tool'], disabled: true }))).toBe(msg);
    // The trigger's connections are converted as well.
    expect(verdict(withNode(linear, 'Trigger', { aiOutputs: ['ai_languageModel'] }))).toMatch(/^v2-connection-type: .*'Trigger'/);
  });

  it('leaves a node the trigger does not reach: rootAt drops its connections with it', () => {
    const wf = workflow('sub-node', [...linear.nodes,
      { id: 'LM', name: 'LM', type: 'lm', typeVersion: 1, position: [0, 500], aiOutputs: ['ai_languageModel'] }],
    linear.connections, 'Trigger');
    expect(verdict(wf)).toBe('accepted');
  });

  it('comes after every node check (toGraphNode runs before toEdges)', () => {
    const wf = withNode(withNode(linear, 'A', { aiOutputs: ['ai_tool'] }), 'C', { onError: 'continueErrorOutput' });
    expect(refusalOf(wf)).toEqual({ code: 'v2-continue-error-output', node: 'C' });
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
  // n8n, handed the same workflow with its start node fired, reaches the same verdict on each.
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
      // v1's chooseBranch join on a type that is not n8n's Merge, two and three inputs: n8n checks
      // the Merge mode on MERGE_TYPE only, and requiredInputs are ignored with a diagnostic.
      chooseBranch: 'accepted',
      partialRequired: 'accepted',
      // A's onError (toGraphNode).
      continueErrorOutput: 'v2-continue-error-output',
      // Two producers into C's one input.
      multiProducer: 'v2-converging-input',
      // v1's Loop Over Items shape is not a Split In Batches v3, so its cycle has no batch node.
      loopOverItems: 'v2-unbatched-cycle',
      userCycle: 'v2-unbatched-cycle',
      // TrigB, not the fired trigger, feeds Merge.1: `rootAt` drops it, and n8n accepts too.
      twoTriggers: 'accepted',
      // Both IF outputs into C's one input.
      ifBothOutputs: 'v2-converging-input',
    });
  });
});
