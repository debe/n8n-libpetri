/**
 * `FakeHost.planEngineRequest`: the round is planned without writing, then reserved. These
 * pin what that split keeps — one `runData` slot per action, consecutive when a node is asked
 * twice, the `rewireOutputLogTo` tag, and each action's reserved index in the agent's
 * re-entry — and n8n's order on a request naming a node the workflow lacks: every action
 * before it is reserved and tagged, then the request is refused, as `handleRequest` does.
 */
import { describe, expect, it } from 'vitest';
import type { EngineRequest, IExecuteData, INode } from 'n8n-workflow';
import { FakeHost, fakeWorkflow, newRunExecutionData } from '../../src/conformance/harness.js';
import { agentTwoTools } from '../fixtures/workflows.js';

function setup(withParent = true) {
  const workflow = fakeWorkflow(agentTwoTools);
  const data = newRunExecutionData(workflow.nodes['Trigger']!);
  const host = new FakeHost(workflow, data, {});
  const agent = workflow.nodes['Agent']!;
  const executionData = {
    node: agent,
    data: { main: [[{ json: { q: 1 } }]] },
    source: withParent ? { main: [{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }] } : null,
  } as unknown as IExecuteData;
  const runData = data.resultData.runData;
  const plan = (actions: ReadonlyArray<{ nodeName: string; id: string }>) => host.planEngineRequest({
    workflow, currentNode: agent, runIndex: 0, executionData, runData,
    request: { actions: actions.map((a) => ({ ...a, type: 'ai_tool', input: { x: a.id } })), metadata: {} } as unknown as EngineRequest,
  });
  return { workflow, runData, plan };
}

describe('FakeHost.planEngineRequest', () => {
  it('reserves one slot per action, consecutive for a node asked twice, and tags each tool', () => {
    const { workflow, runData, plan } = setup();
    const planned = plan([{ nodeName: 'Calculator', id: 'c1' }, { nodeName: 'Search', id: 's1' }, { nodeName: 'Calculator', id: 'c2' }]);
    // v1: the agent's re-entry first, then the tools reversed for a LIFO stack.
    expect(planned.map((e) => `${e.inputConnectionData.node}#${e.nodeRunIndex}`))
      .toEqual(['Agent#0', 'Calculator#1', 'Search#0', 'Calculator#0']);
    const actions = (planned[0]!.metadata as unknown as { subNodeExecutionData: { actions: Array<{ nodeName: string; runIndex: number }> } })
      .subNodeExecutionData.actions;
    expect(actions.map((a) => `${a.nodeName}#${a.runIndex}`)).toEqual(['Calculator#0', 'Search#0', 'Calculator#1']);
    expect(runData['Calculator']).toHaveLength(2);
    expect(runData['Search']).toHaveLength(1);
    expect(runData['Calculator']![1]!.source).toEqual([{ previousNode: 'Agent', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect((workflow.nodes['Calculator'] as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo).toBe('ai_tool');
  });

  it('plans and reserves nothing for an agent with no parent', () => {
    const { workflow, runData, plan } = setup(false);
    expect(plan([{ nodeName: 'Calculator', id: 'c1' }])).toEqual([]);
    expect(runData['Calculator']).toBeUndefined();
    expect((workflow.nodes['Calculator'] as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo).toBeUndefined();
  });

  it('reserves the actions before an unknown node, then refuses, as handleRequest does', () => {
    const { workflow, runData, plan } = setup();
    expect(() => plan([{ nodeName: 'Calculator', id: 'c1' }, { nodeName: 'Nope', id: 'n1' }]))
      .toThrow('Workflow does not contain a node with the name of "Nope".');
    expect(runData['Calculator']).toHaveLength(1);
    expect((workflow.nodes['Calculator'] as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo).toBe('ai_tool');
  });
});
