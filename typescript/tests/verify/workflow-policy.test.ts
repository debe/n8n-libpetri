/**
 * The verify CLI reads the same workflow-level `executionPolicy` the scheduler reads, and
 * resolves it the same way. One net serves execution and verification: a JSON export and the
 * live `Workflow` built from the same workflow must compile to the same structural hash, and
 * the non-inheritance rule for `onFailure` / `timeoutMs` (`n8n/adapter.ts`) must be reported
 * once on either path — the same sentence, from the same function.
 */
import { compile } from '../../src/compiler/index.js';
import { describeWorkflow } from '../../src/n8n/adapter.js';
import { describeWorkflowJson } from '../../src/verify/index.js';
import { SHAPES, conn, idOf, node, workflow } from '../fixtures/workflows.js';
import { fakeNodeHelpers, fakeWorkflow, newRunExecutionData } from '../scheduler/support.js';

const NOT_INHERITED = /is not inherited by every node/;

/** Trigger -> A, with no per-node policy: everything a node resolves comes from the workflow. */
const desc = workflow('policy-export', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
], [conn('Trigger', 0, 'A', 0)], 'Trigger');

function exportOf(executionPolicy: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'policy-export',
    name: 'policy-export',
    nodes: desc.nodes.map((n) => ({
      id: idOf(n.name), name: n.name, type: n.type, typeVersion: n.typeVersion, position: n.position, parameters: {},
    })),
    connections: { Trigger: { main: [[{ node: 'A', type: 'main', index: 0 }]] } },
    settings: { executionPolicy },
  };
}

function liveOf(executionPolicy: Record<string, unknown>) {
  const wf = fakeWorkflow(desc);
  (wf.settings as Record<string, unknown>)['executionPolicy'] = executionPolicy;
  return describeWorkflow(wf, newRunExecutionData(wf.nodes.Trigger!), { nodeHelpers: fakeNodeHelpers });
}

describe('a workflow-level executionPolicy resolves the same on the JSON path as on the live one', () => {
  it.each([
    ['timeoutMs', { v: 1, timeoutMs: 5_000, maxToolCalls: 3 }],
    ['onFailure', { v: 1, onFailure: [{ action: 'stop' }], maxToolCalls: 3 }],
  ])('%s is stripped with one diagnostic, and the two descriptions hash alike', (_key, policy) => {
    const live = liveOf(policy);
    const fromJson = describeWorkflowJson(exportOf(policy), {
      nodeTypes: { nodes: { Trigger: SHAPES.trigger, A: SHAPES.set } },
    }).description;
    expect(compile(fromJson).structuralHash).toBe(compile(live).structuralHash);
    expect((live.diagnostics ?? []).filter((d) => NOT_INHERITED.test(d))).toHaveLength(1);
    expect((fromJson.diagnostics ?? []).filter((d) => NOT_INHERITED.test(d))).toHaveLength(1);
    // The resource knobs still inherit: the same sentence says so.
    for (const n of fromJson.nodes) expect(n.executionPolicy).toEqual({ maxToolCalls: 3 });
  });
});
