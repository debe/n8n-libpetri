/**
 * A tool's run payload carries the agent that dispatched it across every attempt. The success
 * branch of `T_run` is an `xor` over the agents' `A/response` places, and the dispatch token
 * is what resolves it — so a retry that dropped the agent would answer whichever agent the
 * compiler listed first, and the agent that asked would wait forever.
 */
import type { NodeDescription } from '../../src/compiler/index.js';
import { conn, node, tool, workflow } from '../fixtures/workflows.js';
import { execute, items, ranNodes, tokensResting, transitionsFailed } from './support.js';

const START = items({ n: 1 });

/** `agentSharedTool` with a policy on the shared tool: `Trigger` → `A1` → `A2` → `End`, `Calculator` wired to both. */
function sharedTool(policy: Partial<NodeDescription>) {
  return workflow('agentSharedToolRetry', [
    node('Trigger', 'trigger', [0, 0]),
    node('A1', 'agent', [200, 0], { maxRounds: 2, maxToolCalls: 4 }),
    node('A2', 'agent', [400, 0], { maxRounds: 2, maxToolCalls: 4 }),
    node('End', 'set', [600, 0]),
    node('Calculator', 'tool', [300, 200], policy),
  ], [
    conn('Trigger', 0, 'A1', 0), conn('A1', 0, 'A2', 0), conn('A2', 0, 'End', 0),
  ], 'Trigger', { toolConnections: [tool('Calculator', 'A1'), tool('Calculator', 'A2')] });
}

/** An agent that asks for `Calculator` on its first run and answers on its second. */
function asking() {
  let asked = false;
  return () => {
    if (asked) return { data: [items({ answer: 'done' })] };
    asked = true;
    return {
      actions: [{
        actionType: 'ExecutionNodeAction' as const, nodeName: 'Calculator', input: { q: 1 },
        type: 'ai_tool' as const, id: 'c0', metadata: {},
      }],
      metadata: { requestId: 'r1' },
    };
  };
}

describe('a shared tool answers the agent that dispatched it, after a retry', () => {
  it('retryOnFail with waitBetweenTries: the second agent dispatches, the tool fails once, the response reaches the second agent', async () => {
    const r = await execute(sharedTool({ retryOnFail: true, maxTries: 2, waitBetweenTries: 1 }), {
      A1: () => ({ data: [items({ a1: true })] }),
      A2: asking(),
      Calculator: ({ call }) => {
        if (call === 0) throw new Error('flaky');
        return { data: [items({ result: 42 })] };
      },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    const netMap = r.scheduler.compiled!.netMap;
    const responseOf = (agent: string) => tokensResting(r.store, netMap.node(agent).agent!.response.name);
    // The response was deposited on `A2/response` (and collected), never on `A1/response`.
    expect(r.store.events().filter((e) => e.type === 'token-added' && e.placeName === netMap.node('A2').agent!.response.name)).toHaveLength(1);
    expect(r.store.events().filter((e) => e.type === 'token-added' && e.placeName === netMap.node('A1').agent!.response.name)).toHaveLength(0);
    expect(responseOf('A1')).toBe(0);
    expect(responseOf('A2')).toBe(0);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A1', 'A2', 'Calculator', 'Calculator', 'A2', 'End']);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runData.End).toHaveLength(1);
  });

  it('an onFailure chain ending in continue: the error response reaches the second agent', async () => {
    const r = await execute(sharedTool({ executionPolicy: { onFailure: [{ action: 'retry', waitMs: 1 }, { action: 'continue' }] } }), {
      A1: () => ({ data: [items({ a1: true })] }),
      A2: asking(),
      Calculator: () => { throw new Error('service down'); },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    const netMap = r.scheduler.compiled!.netMap;
    expect(r.store.events().filter((e) => e.type === 'token-added' && e.placeName === netMap.node('A2').agent!.response.name)).toHaveLength(1);
    expect(r.store.events().filter((e) => e.type === 'token-added' && e.placeName === netMap.node('A1').agent!.response.name)).toHaveLength(0);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A1', 'A2', 'Calculator', 'Calculator', 'A2', 'End']);
    expect(r.runData.Calculator![0]!.executionStatus).toBe('error');
    expect(r.scheduler.outcome).toBe('completed');
  });
});
