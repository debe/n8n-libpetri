/**
 * Agent tool dispatch end to end: an `EngineRequest` opens a round in the net, the tools run as
 * ordinary node activations, and the agent re-enters with n8n's own `EngineResponse`.
 *
 * The scheduler contributes nothing to the *data* here — `planEngineRequest` reserves the
 * `runData` slots and builds every `IExecuteData`, and `collectSubNodeResults` rebuilds the
 * response from the metadata that round-trips on the resume entry. What the net contributes is
 * *when*: the round is a marking, so a paused or halted execution keeps it, the budget bounds
 * how many tools are in flight, and `A/rounds` bounds how many times the agent may go round.
 */
import { agentOneTool, agentTwoTools } from '../fixtures/workflows.js';
import { execute, items, ranNodes, sleep } from './support.js';

const START = items({ n: 1 });

/** An agent script that asks for `tools` on its first run and answers on its second. */
function agentCalling(tools: readonly string[]) {
  let asked = false;
  return () => {
    if (asked) return { data: [items({ answer: 'done' })] };
    asked = true;
    return {
      actions: tools.map((nodeName, i) => ({
        actionType: 'ExecutionNodeAction' as const, nodeName, input: { q: nodeName }, type: 'ai_tool' as const,
        id: `call_${i}`, metadata: {},
      })),
      metadata: { requestId: 'r1' },
    };
  };
}

describe('one round, one tool', () => {
  it('runs the tool, resumes the agent with the response, and carries on', async () => {
    const r = await execute(agentOneTool, {
      Agent: agentCalling(['Calculator']),
      Calculator: () => ({ data: [items({ result: 42 })] }),
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    // The tool ran between the agent's two activations, and `End` ran after both.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator', 'Agent', 'End']);
    // One `runData` entry for the agent, not two: n8n's re-entry reuses the same `runIndex`
    // (`handleRequest` sets `nodeRunIndex: runIndex`), so the answering activation writes the
    // slot the requesting one never did — the requesting one records nothing at all, because
    // n8n `continue`s its loop before `upsertTaskData`.
    expect(r.runData.Agent).toHaveLength(1);
    expect(r.runData.Agent![0]!.data!.main![0]![0]!.json).toEqual({ answer: 'done' });
    expect(r.runData.Calculator).toHaveLength(1);
    expect(r.runData.End![0]!.data!.main![0]![0]!.json).toEqual({ answer: 'done' });
  });

  it('reserves the tool runData slot before the tool runs, with the ai_tool input override', async () => {
    const r = await execute(agentOneTool, {
      Agent: agentCalling(['Calculator']),
      Calculator: () => ({ data: [items({ result: 42 })] }),
    }, { startItems: START });
    // `initializeNodeRunData` writes the slot at plan time; the run then fills it.
    expect(r.runData.Calculator![0]!.inputOverride?.ai_tool?.[0]?.[0]?.json).toEqual({ q: 'Calculator' });
  });

  it('does not emit nodeExecuteBefore twice for the resumed agent', async () => {
    const r = await execute(agentOneTool, {
      Agent: agentCalling(['Calculator']),
      Calculator: () => ({ data: [items({ result: 42 })] }),
    }, { startItems: START });
    // n8n suppresses it on a resumed entry (`metadata.nodeWasResumed`), and the resume entry we
    // carry is the one n8n built, so the existing check in `attempt()` covers it unchanged.
    const before = r.calls.filter((c) => c === 'hook:nodeExecuteBefore(Agent)');
    expect(before).toHaveLength(1);
  });

  it('never enqueues on n8n\'s stack: the round is the net\'s', async () => {
    const r = await execute(agentOneTool, {
      Agent: agentCalling(['Calculator']),
      Calculator: () => ({ data: [items({ result: 42 })] }),
    }, { startItems: START });
    expect(r.calls).not.toContain('handleEngineRequest(Agent)');
    expect(r.calls.some((c) => c.startsWith('addNodeToBeExecuted'))).toBe(false);
    expect(r.calls).toContain('planEngineRequest(Agent)');
  });
});

describe('several tools in one round', () => {
  it('dispatches in the order the actions were requested', async () => {
    const r = await execute(agentTwoTools, {
      Agent: agentCalling(['Calculator', 'Search']),
      Calculator: () => ({ data: [items({ result: 1 })] }),
      Search: () => ({ data: [items({ result: 2 })] }),
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator', 'Search', 'Agent', 'End']);
  });

  it('keeps the same runData at budget 1 and 4, only the timing moves', async () => {
    const run = async (budget: number) => await execute(agentTwoTools, {
      Agent: agentCalling(['Calculator', 'Search']),
      Calculator: () => ({ data: [items({ result: 1 })] }),
      Search: () => ({ data: [items({ result: 2 })] }),
    }, { startItems: START, budget });

    const one = await run(1);
    const four = await run(4);
    for (const node of ['Agent', 'Calculator', 'Search', 'End']) {
      expect(four.runData[node]?.map((t) => t.data)).toEqual(one.runData[node]?.map((t) => t.data));
    }
  });
});

describe('the round budget', () => {
  it('an agent that keeps asking stops when A/rounds runs out', async () => {
    // `agentTwoTools` declares maxRounds 2, so the net allows two resumes and no more.
    //
    // Only a mock reaches this: a real `AgentV3` counts its own `iterationCount` and throws
    // "Max iterations reached" first, which is why `A/rounds` is seeded with exactly that
    // number and never binds in production. What it buys is a *bounded* cycle, so an agent
    // workflow has a finite reachability graph for the verifier to close.
    let rounds = 0;
    const r = await execute(agentTwoTools, {
      Agent: () => {
        rounds++;
        return {
          actions: [{
            actionType: 'ExecutionNodeAction' as const, nodeName: 'Calculator', input: {}, type: 'ai_tool' as const,
            id: `call_${rounds}`, metadata: {},
          }],
          metadata: { requestId: `r${rounds}` },
        };
      },
      Calculator: () => ({ data: [items({ result: 1 })] }),
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    // One initial run plus two resumes, each dispatching one tool; the net then has no round
    // token left and quiesces.
    expect(rounds).toBe(3);
    expect(r.runData.Calculator).toHaveLength(3);
    // The agent never produced output, so it has no task data and `End` never runs — the same
    // shape n8n leaves behind when every activation ends in a request.
    expect(r.runData.Agent).toBeUndefined();
    expect(r.runData.End).toBeUndefined();
  });
});

describe('a round the execution stops in the middle of', () => {
  it('writes the undispatched tools and the agent re-entry back onto n8n\'s stack', async () => {
    // Two tool calls at budget 1: the first tool takes the unit, and cancelling inside it
    // leaves the second undispatched and the agent waiting to resume.
    const r = await execute(agentTwoTools, {
      Agent: () => ({
        actions: ['Calculator', 'Search'].map((nodeName, i) => ({
          actionType: 'ExecutionNodeAction' as const, nodeName, input: {}, type: 'ai_tool' as const,
          id: `c${i}`, metadata: {},
        })),
        metadata: { requestId: 'r1' },
      }),
      Calculator: async ({ host }) => { await sleep(20); host.cancel(); await sleep(5); return { data: [items({ result: 1 })] }; },
      Search: () => ({ data: [items({ result: 2 })] }),
    }, { startItems: START, budget: 1 });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('cancelled');
    // `Calculator` ran and is recorded; `Search` never started.
    expect(r.runData.Calculator).toHaveLength(1);
    expect(r.runData.Search![0]!.data).toBeUndefined(); // the reserved slot, never filled
    // The round is written back in n8n's own shape: the tool it had not dispatched, and the
    // agent's re-entry underneath. Both entries are the ones `handleRequest` built.
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['Search', 'Agent']);
    const resume = stack.find((e) => e.node.name === 'Agent')!;
    expect(resume.metadata?.nodeWasResumed).toBe(true);
    expect(resume.metadata?.subNodeExecutionData?.actions.map((a) => a.nodeName)).toEqual(['Calculator', 'Search']);
  });
});

describe('the tool-call budget', () => {
  const budgeted = (maxToolCalls: number, onError?: 'continueRegularOutput') => ({
    ...agentTwoTools,
    nodes: agentTwoTools.nodes.map((n) => (n.name === 'Agent'
      ? { ...n, maxToolCalls, ...(onError === undefined ? {} : { onError }) } : n)),
  });
  const asking = (calls: number) => {
    let asked = false;
    return () => {
      if (asked) return { data: [items({ answer: 'done' })] };
      asked = true;
      return {
        actions: Array.from({ length: calls }, (_, i) => ({
          actionType: 'ExecutionNodeAction' as const, nodeName: i % 2 === 0 ? 'Calculator' : 'Search',
          input: { i }, type: 'ai_tool' as const, id: `c${i}`, metadata: {},
        })),
        metadata: { requestId: 'r1' },
      };
    };
  };
  const tools = {
    Calculator: () => ({ data: [items({ result: 1 })] }),
    Search: () => ({ data: [items({ result: 2 })] }),
  };

  it('a round within the budget runs every call', async () => {
    const r = await execute(budgeted(4), { Agent: asking(3), ...tools }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    // Every call runs, and the data is the request's: `initializeNodeRunData` reserved each
    // slot at plan time, so `runData` is decided by the request and not by the schedule.
    const ran = ranNodes(r.calls);
    expect(ran.slice(0, 2)).toEqual(['Trigger', 'Agent']);
    expect(ran.slice(-2)).toEqual(['Agent', 'End']);
    expect(ran.filter((n) => n === 'Calculator')).toHaveLength(2);
    expect(ran.filter((n) => n === 'Search')).toHaveLength(1);
    expect(r.runData.Calculator!.map((t) => t.inputOverride?.ai_tool?.[0]?.[0]?.json)).toEqual([{ i: 0 }, { i: 2 }]);
    // The *start* order of a repeated tool is not n8n's (divergence #23): at k = 1 the second
    // Calculator token and the Search token wait on the same budget unit, and priority ties
    // between two different nodes are the executor's to break. n8n's stack keeps them in
    // request order. Data is untouched either way.
    expect(new Set(ran.slice(2, 5))).toEqual(new Set(['Calculator', 'Search']));
  });

  it('a round over the budget fails the agent by name, under stopWorkflow', async () => {
    // Three calls against a budget of two: the first two dispatch and run, then `A_calls_out`
    // re-enters the agent and the run fails before `runNode` — the same shape as n8n's own
    // `checkMaxIterations` throwing inside the node — so the execution halts on the agent.
    const r = await execute(budgeted(2), { Agent: asking(3), ...tools }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.scheduler.executionError?.message).toContain('Tool-call budget (2) reached');
    expect(r.scheduler.executionError?.message).toContain('1 more tool call');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator', 'Search']);
    expect(r.runData.Agent![0]!.executionStatus).toBe('error');
    expect(r.runData.End).toBeUndefined();
  });

  it('honours onError: continueRegularOutput passes the agent input through, as n8n does', async () => {
    const r = await execute(budgeted(2, 'continueRegularOutput'), { Agent: asking(3), ...tools }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator', 'Search', 'End']);
    // n8n's `handleNodeExecutionError` under continueRegularOutput forwards the node's own
    // input (`workflow-execute.ts`); the error itself is on the agent's task data.
    expect(r.runData.Agent![0]!.executionStatus).toBe('error');
    expect(r.runData.Agent![0]!.error?.message).toContain('Tool-call budget (2) reached');
    expect(r.runData.End![0]!.data!.main![0]![0]!.json).toEqual({ n: 1 });
  });

  it('counts across rounds: the budget is per execution, not per round', async () => {
    // Two rounds of two calls against a budget of three: the second round has one unit left.
    let rounds = 0;
    const r = await execute(budgeted(3), {
      Agent: () => {
        if (rounds >= 2) return { data: [items({ answer: 'done' })] };
        rounds++;
        return {
          actions: ['Calculator', 'Search'].map((nodeName, i) => ({
            actionType: 'ExecutionNodeAction' as const, nodeName, input: {}, type: 'ai_tool' as const,
            id: `r${rounds}c${i}`, metadata: {},
          })),
          metadata: { requestId: `r${rounds}` },
        };
      },
      ...tools,
    }, { startItems: START });
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.scheduler.executionError?.message).toContain('Tool-call budget (3) reached');
    // Count the runs that happened, not the slots: `initializeNodeRunData` reserved a slot for
    // the second round's Search at plan time, and that call was never dispatched.
    const ran = (name: string) => (r.runData[name] ?? []).filter((t) => t.data !== undefined).length;
    expect(ran('Calculator')).toBe(2);
    expect(ran('Search')).toBe(1);
  });
});
