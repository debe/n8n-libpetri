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
import { agentNested, agentOneTool, agentToolPolicy, agentTwoTools, conn, node } from '../fixtures/workflows.js';
import { compile } from '../../src/compiler/index.js';
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

  /**
   * The same agent, but the budget's outcome is the *author's* to declare: `onFailure` routes
   * the exhausted agent down the error output `continueErrorOutput` gives it.
   */
  const routed = (maxToolCalls: number) => ({
    ...agentTwoTools,
    nodes: [
      ...agentTwoTools.nodes.map((n) => (n.name === 'Agent'
        ? {
          ...n, maxToolCalls, onError: 'continueErrorOutput' as const,
          executionPolicy: { onFailure: [{ action: 'route' as const, output: 'error' }] },
        }
        : n)),
      node('Fallback', 'set', [400, 200]),
    ],
    connections: [...agentTwoTools.connections, conn('Agent', 1, 'Fallback', 0)],
  });

  it('routes an exhausted budget where the author declared, and the execution completes', async () => {
    // The contribution ADR 0009 adds on top of the budget itself: what happens when it runs out
    // is declared in the workflow, not fixed by the engine. Three calls against two: the first
    // two run, `A_calls_out` re-enters the agent, and the failure takes the wired error branch
    // instead of halting the execution.
    const r = await execute(routed(2), { Agent: asking(3), ...tools }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    // Exactly two tool calls were spent, and `End` — the success branch — never ran.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator', 'Search', 'Fallback']);
    expect(r.runData.Agent![0]!.executionStatus).toBe('error');
    expect(r.runData.Agent![0]!.error?.message).toContain('Tool-call budget (2) reached');
    expect(r.runData.End).toBeUndefined();
    expect(r.runData.Fallback).toHaveLength(1);
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

/**
 * An `onFailure` chain on the **tool**, which is the node that calls the flaky service. n8n has
 * `retryOnFail` there and no deadline at any level, so this is the shape where a per-node policy
 * gives an agent a bound n8n expresses at the round level rather than the call level.
 *
 * A tool's outcome is its agent's `A/response`, not a main edge, so only three actions mean
 * anything on one — and the fourth has to be refused rather than compiled into something
 * incoherent.
 */
describe('a policy on an agent\'s tool', () => {
  const asking = () => {
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
  };

  it('retries the tool on its own delay and the agent never sees the failure', async () => {
    const r = await execute(agentToolPolicy({
      onFailure: [{ action: 'retry', waitMs: 5 }, { action: 'retry', waitMs: 5 }, { action: 'continue' }],
    }), {
      Agent: asking(),
      Calculator: ({ call }) => {
        if (call < 2) throw new Error(`flaky ${call}`);
        return { data: [items({ result: 42 })] };
      },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    // Three calls for one dispatch: the chain is per activation, and the agent resumed once.
    expect(ranNodes(r.calls).filter((n) => n === 'Calculator')).toHaveLength(3);
    expect(r.runData.Calculator![0]!.executionStatus).toBe('success');
    expect(r.runData.End).toHaveLength(1);
  });

  it('continue hands the error to the agent as its tool response, which is n8n\'s own default', async () => {
    // n8n continues a failing `ai_tool` node by default so the agent receives the
    // error as a tool response", and it surfaces `{ json: { error } }` on the ai_tool channel.
    const r = await execute(agentToolPolicy({ onFailure: [{ action: 'continue' }] }), {
      Agent: asking(),
      Calculator: () => { throw new Error('service down'); },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runData.Calculator![0]!.executionStatus).toBe('error');
    // On `main`, not `ai_tool`: the mirror records `rewireOutputLog` and no-ops it, so the
    // channel move n8n's own host performs afterwards is out of scope here. What matters is
    // the payload — the error itself, not the tool's input passed through.
    expect(r.runData.Calculator![0]!.data!.main![0]![0]!.json).toEqual({ error: 'service down' });
    expect(r.runData.End).toHaveLength(1);
  });

  it('stop halts the execution on the tool, which n8n reaches only through onError', async () => {
    const r = await execute(agentToolPolicy({ onFailure: [{ action: 'stop' }] }), {
      Agent: asking(),
      Calculator: () => { throw new Error('fatal'); },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.Calculator![0]!.executionStatus).toBe('error');
    expect(r.runData.End).toBeUndefined();
  });

  it('abandons a tool that never answers at its own deadline, and the agent carries on', async () => {
    // The thing n8n has at no level: a per-tool deadline. Without one a hung tool holds the
    // agent — and therefore the execution — until n8n's whole-execution timeout. [IO-013]
    // abandons the firing and the chain's `continue` hands the agent an error tool response,
    // which is the same shape a thrown tool failure takes.
    let resolvedLate = false;
    const r = await execute(agentToolPolicy({
      timeoutMs: 40,
      onFailure: [{ action: 'continue' }],
    }), {
      Agent: asking(),
      Calculator: async () => { await sleep(400); resolvedLate = true; return { data: [items({ never: true })] }; },
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runData.Calculator![0]!.executionStatus).toBe('error');
    expect(r.runData.Calculator![0]!.error?.message).toMatch(/deadline|timeout|40/i);
    // The agent resumed and the workflow finished while the tool was still working: IO-013 is
    // explicit that abandoning a firing is not cancelling the work behind it.
    expect(r.runData.End).toHaveLength(1);

    // Then let the abandoned tool land, and confirm it changed nothing. Asserting
    // `resolvedLate === false` here instead would have been an *upper* bound on how long the
    // whole round may take — two agent runs, a dispatch, a resume and `End`, all inside 400 ms —
    // which a loaded machine breaks for reasons that have nothing to do with the code. Waiting
    // for the late write and finding it dropped is a lower bound, which `setTimeout` cannot
    // violate, and it tests the stronger claim: the guard refused the write, rather than the
    // write merely not having arrived yet.
    await sleep(450);
    expect(resolvedLate).toBe(true);
    expect(r.runData.Calculator).toHaveLength(1);
    expect(r.runData.Calculator![0]!.executionStatus).toBe('error');
    expect(r.runData.End).toHaveLength(1);
  });

  it('refuses route: a tool has no output to route to', () => {
    expect(() => compile(agentToolPolicy({ onFailure: [{ action: 'route', output: 0 }] })))
      .toThrow(/Calculator.*no output to route to.*goes to its agent/s);
  });
});

/**
 * A nested agent. n8n's own runtime caps delegation at one level — `@n8n/agents` parses a
 * task path, whose format admits one level below the root, so a second level is rejected when
 * that path is parsed rather than by a check written for the purpose. Here delegation is the graph, and
 * a second level is a second round in the same net — no new concept, no new code path.
 */
describe('an agent that dispatches another agent', () => {
  it('runs both rounds and answers up the chain', async () => {
    const r = await execute(agentNested, {
      A: agentCalling(['B']),
      B: agentCalling(['Code']),
      Code: () => ({ data: [items({ result: 7 })] }),
      Calculator: () => ({ data: [items({ result: 1 })] }),
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
    // `B` runs twice for the same reason `A` does — once to ask, once to answer — and `Code`
    // runs between its two activations, inside `A`'s own round.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'Code', 'B', 'A', 'End']);
    // `Calculator` is wired to `A` and was never asked for, so it never ran: a tool is
    // dispatched, not scheduled.
    expect(r.runData.Calculator).toBeUndefined();
    // One `runData` entry per agent, not two: the re-entry reuses the requesting run's index,
    // at both levels.
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.B).toHaveLength(1);
    expect(r.runData.Code).toHaveLength(1);
    expect(r.runData.End![0]!.data!.main![0]![0]!.json).toEqual({ answer: 'done' });
  });

  it('keeps the same runData at budget 1 and 4: the nesting is order, not concurrency', async () => {
    const run = async (budget: number) => await execute(agentNested, {
      A: agentCalling(['B']),
      B: agentCalling(['Code']),
      Code: () => ({ data: [items({ result: 7 })] }),
    }, { startItems: START, budget });
    const one = await run(1);
    const four = await run(4);
    for (const node of ['A', 'B', 'Code', 'End']) {
      expect(four.runData[node]?.map((t) => t.data), node).toEqual(one.runData[node]?.map((t) => t.data));
    }
    expect(ranNodes(four.calls)).toEqual(ranNodes(one.calls));
  });

  it('contains the inner agent\'s tool-call budget at its own level', async () => {
    // `B` asks for a tool on every activation and never answers. `B/calls` is 2, so the third
    // request has no unit left and `B_calls_out` re-enters `B` with the fact — the run then
    // fails by name, inside `B`.
    let bCalls = 0;
    const r = await execute(agentNested, {
      A: agentCalling(['B']),
      B: () => {
        bCalls++;
        return {
          actions: [{
            actionType: 'ExecutionNodeAction' as const, nodeName: 'Code', input: {}, type: 'ai_tool' as const,
            id: `c${bCalls}`, metadata: {},
          }],
          metadata: { requestId: `r${bCalls}` },
        };
      },
      Code: () => ({ data: [items({ result: 7 })] }),
    }, { startItems: START });

    expect(r.error).toBeUndefined();
    expect(bCalls).toBe(3);
    // Two activations of `Code`, and a third `runData` slot that `planEngineRequest` reserved
    // for the request `B_calls_out` then refused — divergence #29, and the reason the count and
    // the run count differ here.
    expect(ranNodes(r.calls).filter((n) => n === 'Code')).toHaveLength(2);
    expect(r.runData.Code).toHaveLength(3);
    expect(r.runData.Code![2]!.data).toBeUndefined();
    // `B` is an `ai_tool` execution, so n8n's own rule applies to it exactly as to any other
    // failing tool (n8n continues an `ai_tool` node by default so the agent
    // receives the error as a tool response). The inner agent's exhausted budget is therefore
    // *data* to the outer one, not an execution failure.
    expect(r.runData.B![0]!.executionStatus).toBe('error');
    expect(r.runData.B![0]!.data!.main![0]![0]!.json).toEqual({
      error: expect.stringContaining('Tool-call budget (2) reached: "B"'),
    });
    // And the outer agent carries on: it gets its response, answers, and `End` runs. A runaway
    // at depth 2 is contained at depth 2 — the execution completes.
    expect(r.scheduler.outcome).toBe('completed');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'Code', 'B', 'Code', 'B', 'A', 'End']);
    expect(r.runData.End![0]!.data!.main![0]![0]!.json).toEqual({ answer: 'done' });
  });

  it('ends an exhausted round budget the same way at depth 2 as at depth 1', async () => {
    // The other exhaustion. `A_rounds_out` is a *designed terminal*, not a failure: `_pause`
    // marks the stop and the codec writes the open round back onto n8n's stack. That is the
    // same outcome whether the agent whose rounds ran out is the top-level one or a tool of
    // another agent, which is the claim worth pinning — nesting adds no new terminal.
    const asking = (toolName: string, n: () => void) => () => {
      n();
      return {
        actions: [{
          actionType: 'ExecutionNodeAction' as const, nodeName: toolName, input: {}, type: 'ai_tool' as const,
          id: 'c', metadata: {},
        }],
        metadata: { requestId: 'r' },
      };
    };
    // `maxToolCalls` raised out of the way so `A/rounds` is what binds, not `A/calls`.
    const raise = (name: string) => ({
      ...agentNested,
      nodes: agentNested.nodes.map((x) => (x.name === name ? { ...x, maxToolCalls: 8 } : x)),
    });

    let inner = 0;
    const nested = await execute(raise('B') as never, {
      A: agentCalling(['B']),
      B: asking('Code', () => { inner++; }),
      Code: () => ({ data: [items({ result: 7 })] }),
    }, { startItems: START });

    // Depth 1, for comparison: the same shape with the *outer* agent asking forever.
    let outer = 0;
    const flat = await execute(raise('A') as never, {
      A: asking('Calculator', () => { outer++; }),
      Calculator: () => ({ data: [items({ result: 1 })] }),
      B: () => ({ data: [items({ answer: 'x' })] }),
      Code: () => ({ data: [items({ result: 7 })] }),
    }, { startItems: START });

    // One initial run plus `maxRounds` resumes, at either depth.
    expect([inner, outer]).toEqual([3, 3]);
    // Each outcome asserted concretely, then their equality. Asserting only that the two agree
    // would pass just as well if both regressed to `completed`, which is the failure this test
    // is meant to catch: `A_rounds_out` deposits `_pause`, so the execution stops rather than
    // finishing, and the codec writes the open round back onto n8n's stack.
    expect(nested.scheduler.outcome).toBe('cancelled');
    expect(flat.scheduler.outcome).toBe('cancelled');
    expect(nested.scheduler.outcome).toBe(flat.scheduler.outcome);
    expect(nested.error).toBeUndefined();
    expect(flat.error).toBeUndefined();
    // Neither completes: the agent that ran out of rounds never answered, so nothing downstream
    // of it can run, and the marking is kept rather than discarded.
    expect(nested.runData.End).toBeUndefined();
    expect(flat.runData.End).toBeUndefined();
  });
});
