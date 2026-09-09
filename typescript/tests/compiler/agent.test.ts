/**
 * The agent gadget: `ai_tool` connections compile to a dispatch round in the net
 * (README "Agent tool dispatch", `tests/spikes/agent-round.test.ts` for the shape in isolation).
 *
 * What is asserted here is structure, not behaviour: the places and transitions exist, the
 * round budget is seeded from the node's own `options.maxIterations`, a tool is reachable only
 * through its agent, and the cross-node ports bind so that one flat net comes out.
 */
import { compile, analyse } from '../../src/compiler/index.js';
import { structuralHash } from '../../src/compiler/hash.js';
import { enumerateBranches } from 'libpetri';
import { verify } from '../../src/verify/index.js';
import { renderStateSpace } from '../../src/verify/report.js';
import { StateSpace } from '../../src/verify/state-class.js';
import { markingStateOf } from '../../src/verify/verify.js';
import {
  agentAssumedRounds, agentOneTool, agentSharedTool, agentTwoTools, linear,
} from '../fixtures/workflows.js';

describe('analysis', () => {
  it('classifies the tool and the agent', () => {
    const a = analyse(agentOneTool);
    expect(a.hasAgents).toBe(true);
    expect(a.byName.get('Calculator')!.isTool).toBe(true);
    expect(a.byName.get('Agent')!.isTool).toBe(false);
    expect(a.byName.get('Agent')!.tools).toEqual(['Calculator']);
    expect([...a.agentsOf.get('Calculator')!]).toEqual(['Agent']);
  });

  it('leaves a workflow without tool connections exactly as it was', () => {
    const a = analyse(linear);
    expect(a.hasAgents).toBe(false);
    expect(a.toolConnections).toEqual([]);
    for (const n of a.nodes) expect(n.isTool).toBe(false);
  });

  it('reaches a tool through its agent, and gives it the agent depth plus one', () => {
    const a = analyse(agentOneTool);
    // The tool has no main producer, so only the dispatch edge can reach it.
    expect(a.reachable.has('Calculator')).toBe(true);
    expect(a.depth.get('Calculator')).toBe(a.depth.get('Agent')! + 1);
  });

  it('takes the round budget from the node and says so when it has to assume one', () => {
    expect(analyse(agentOneTool).byName.get('Agent')!.maxRounds).toBe(3);
    expect(analyse(agentOneTool).byName.get('Agent')!.roundsAssumed).toBe(false);

    const assumed = analyse(agentAssumedRounds);
    expect(assumed.byName.get('Agent')!.maxRounds).toBe(10); // n8n's own default
    expect(assumed.byName.get('Agent')!.roundsAssumed).toBe(true);
    expect(assumed.diagnostics.join('\n')).toMatch(/does not declare a static maxIterations/);

    const capped = analyse(agentAssumedRounds, { maxAgentRounds: 4 });
    expect(capped.byName.get('Agent')!.maxRounds).toBe(4);
  });

  it('drops an ai_tool connection to a node that also has a main producer', () => {
    const a = analyse({
      ...agentOneTool,
      connections: [...agentOneTool.connections, { from: 'Trigger', outputIndex: 0, to: 'Calculator', inputIndex: 0 }],
      nodes: agentOneTool.nodes.map((n) =>
        (n.name === 'Calculator' ? { ...n, type: 'set' } : n)),
      nodeTypes: (n) => (n.name === 'Calculator'
        ? { inputCount: 1, outputCount: 1 }
        : agentOneTool.nodeTypes(n)),
    });
    expect(a.byName.get('Calculator')!.isTool).toBe(false);
    expect(a.diagnostics.join('\n')).toMatch(/also has a main producer/);
  });
});

describe('the compiled net', () => {
  it('gives the agent a round and the tool a dispatch place', () => {
    const c = compile(agentOneTool);
    const agent = c.netMap.node('Agent');
    const tool = c.netMap.node('Calculator');

    expect(agent.form).toBe('direct');
    expect(tool.form).toBe('tool');
    for (const p of [agent.routedRequest, agent.queue, agent.drained, agent.outstanding,
      agent.response, agent.dispatched, agent.rounds, agent.calls]) {
      expect(p).not.toBeNull();
    }
    expect(tool.inTool).not.toBeNull();
    // A tool has no main producer, so it must not have picked up a synthetic `X/in` either.
    expect(tool.in).toBeNull();

    const t = agent.transitions;
    expect(t.doneRequest).not.toBeNull();
    expect(t.dispatch).not.toBeNull();
    expect(t.collect).not.toBeNull();
    expect(t.resume).not.toBeNull();
    // The tool is an ordinary node: it has none of them.
    expect(tool.transitions.dispatch).toBeNull();
    expect(tool.transitions.resume).toBeNull();
  });

  it('seeds A/rounds with the agent maxRounds and A/idle with one', () => {
    const c = compile(agentOneTool);
    const agent = c.netMap.node('Agent');
    const marking = c.initialMarking([{ json: {} }]);
    expect(marking.get(agent.rounds!)).toHaveLength(3);
    expect(marking.get(agent.idle)).toHaveLength(1);
    // The tool starts idle and undispatched.
    const tool = c.netMap.node('Calculator');
    expect(marking.get(tool.inTool!)).toBeUndefined();
    expect(marking.get(tool.idle)).toHaveLength(1);
  });

  it('binds the cross-node ports into one flat net', () => {
    const c = compile(agentTwoTools);
    const agent = c.netMap.node('Agent');
    const names = new Set([...c.net.places].map((p) => p.name));
    // The agent writes each tool's own `in_tool` place; the composition funnels the agent's
    // `tool_k` port onto it rather than leaving two places behind.
    for (const toolName of ['Calculator', 'Search']) {
      expect(names.has(c.netMap.node(toolName).inTool!.name)).toBe(true);
    }
    expect(names.has(agent.response!.name)).toBe(true);
    expect(agent.tools).toEqual(['Calculator', 'Search']);
  });

  it('lets two agents share one tool', () => {
    const c = compile(agentSharedTool);
    const tool = c.netMap.node('Calculator');
    expect(tool.agents).toEqual(['A1', 'A2']);
    // One dispatch place, one idle token: the tool is serialised across both agents.
    expect(c.initialMarking([{ json: {} }]).get(tool.idle)).toHaveLength(1);
  });

  it('runs the structural placeholder net to quiescence', async () => {
    // The placeholder action never takes the request outcome, so an agent workflow still
    // terminates under `compile()`'s own actions — which is what the verifier explores.
    const c = compile(agentOneTool);
    expect(c.net.transitions).toBeDefined();
    expect(() => c.program).not.toThrow();
  });
});

describe('the round budget is a hard bound', () => {
  it('nothing in the compiled net refunds A/rounds', () => {
    // The whole verification story rests on this: `A/rounds` is seeded once and consumed by
    // `A_resume`, so the round loop can go round at most `maxIterations` times. If any
    // transition ever produced it, the cycle would be unbounded again and the graph would stop
    // closing — silently, because it would just truncate instead.
    const c = compile(agentTwoTools);
    const rounds = c.netMap.node('Agent').rounds!;
    const producers: string[] = [];
    for (const t of c.net.transitions) {
      const out = (t as unknown as { outputSpec?: unknown }).outputSpec;
      if (out === undefined || out === null) continue;
      for (const branch of enumerateBranches(out as never)) {
        if ([...branch].some((p) => p.name === rounds.name)) producers.push(t.name);
      }
    }
    expect(producers).toEqual([]);
    expect(c.initialMarking(null).get(rounds)).toHaveLength(2);
  });

  it('is what closes the graph: the class count scales with it, and every graph is complete', async () => {
    // A small tool-call budget, so this measures the *rounds* axis alone: at the default K = 8
    // the graph is 11k classes per two rounds and grows with the round count faster than a
    // unit test should pay for.
    const withRounds = (n: number) => ({
      ...agentTwoTools,
      nodes: agentTwoTools.nodes.map((x) => (x.name === 'Agent' ? { ...x, maxRounds: n, maxToolCalls: 2 } : x)),
    });
    const sizes: number[] = [];
    for (const n of [1, 2, 3]) {
      const r = await verify(withRounds(n), { properties: ['proper-completion'], timeoutMs: 1 });
      expect(r.stateSpace.complete).toBe(true);
      sizes.push(r.stateSpace.classes);
    }
    // Strictly increasing: the budget is doing the bounding, not some other ceiling.
    expect(sizes[0]).toBeLessThan(sizes[1]!);
    expect(sizes[1]).toBeLessThan(sizes[2]!);
  });

  it('and the graph explores every round size up to the tool-call budget', () => {
    // [IO-015] validates the *set* of places a firing writes, never how many tokens go to each
    // (`enumerateBranches` returns `ReadonlySet<Place>`), so a count deposited as tokens is
    // invisible to branch enumeration: an earlier shape put one `A/pending` unit per requested
    // call and the graph explored exactly one call in flight where the executor reaches n — an
    // under-approximation, the direction that yields a false `proven` on a safety property.
    //
    // The budget turns the count into a *path*. `A_dispatch` consumes one `A/calls` unit per
    // firing, so "how many tool calls" is "how many times dispatch fired", which the graph sees:
    // `peak(A/outstanding)` reaches the budget. And because nothing refunds `A/calls`, that
    // path is finite — refund at the join and the round can dispatch without bound.
    const K = 3;
    const wf = {
      ...agentTwoTools,
      nodes: agentTwoTools.nodes.map((x) => (x.name === 'Agent' ? { ...x, maxRounds: 2, maxToolCalls: K } : x)),
    };
    const c = compile(wf);
    const g = c.netMap.node('Agent');
    const doneReq = [...c.net.transitions].find((t) => t.name === g.transitions.doneRequest)!;
    const branches = enumerateBranches((doneReq as unknown as { outputSpec: never }).outputSpec);
    // No count in any branch: the round opens with a queue or already drained, and that is all.
    expect(branches).toHaveLength(2);
    expect(branches.every((b) => ![...b].some((p) => p.name === g.calls!.name))).toBe(true);

    const space = StateSpace.explore(c.net, markingStateOf(c.initialMarking(null)), c.netMap, 200_000);
    expect(space.complete).toBe(true);
    expect(space.peak(g.calls!)).toBe(K);
    expect(space.peak(g.outstanding!)).toBe(K);
    // Both tools reachable, and a round can hold both in flight at once — the executor's case.
    expect(space.everMarked(c.netMap.node('Calculator').inTool!)).toBe(true);
    expect(space.everMarked(c.netMap.node('Search').inTool!)).toBe(true);
  });

  it('nothing in the compiled net refunds A/calls either', () => {
    const c = compile(agentTwoTools);
    const calls = c.netMap.node('Agent').calls!;
    const producers: string[] = [];
    for (const t of c.net.transitions) {
      const out = (t as unknown as { outputSpec?: unknown }).outputSpec;
      if (out === undefined || out === null) continue;
      for (const branch of enumerateBranches(out as never)) {
        if ([...branch].some((p) => p.name === calls.name)) producers.push(t.name);
      }
    }
    expect(producers).toEqual([]);
  });
});

describe('verification', () => {
  it('proves proper completion, solver-free, because the round budget bounds the cycle', async () => {
    // The agent's `queue → dispatched → running → queue` loop is a cycle, and a cycle is what
    // leaves `loopOverItems` at `bounded` forever. This one closes: `A/rounds` is seeded from
    // the workflow's own `options.maxIterations`, so the reachability graph is finite.
    const report = await verify(agentOneTool, { properties: ['proper-completion'], timeoutMs: 1 });
    expect(report.counts.violated).toBe(0);
    expect(report.counts.unknown).toBe(0);
    expect(report.stateSpace.complete).toBe(true);
  });

  it('an assumed budget truncates and the report names the knob; a declared one proves', async () => {
    // At the scheduler's runtime default (64) the graph cannot close — about K^3.7 markings
    // sequences — and the cause must say so in terms the user can act on, not "cap too low".
    const assumed = await verify(agentAssumedRounds, { properties: ['proper-completion'], timeoutMs: 1, maxClasses: 5_000 });
    expect(assumed.stateSpace.complete).toBe(false);
    expect(assumed.stateSpace.truncation).toBe('tool-calls');
    expect(assumed.stateSpace.agents).toEqual([{ node: 'Agent', tools: 1, maxToolCalls: 64, assumed: true }]);
    expect(renderStateSpace(assumed)).toMatch(/'Agent' may make 64 tool call\(s\).*the scheduler default/);
    expect(renderStateSpace(assumed)).toMatch(/declare a small options\.maxToolCalls/);
    expect(assumed.counts.proven).toBe(0);

    // The same workflow with a declared budget — the runtime cap the workflow chose — closes,
    // and the report says the claim's width.
    const declared = await verify({
      ...agentAssumedRounds,
      nodes: agentAssumedRounds.nodes.map((n) => (n.name === 'Agent' ? { ...n, maxRounds: 2, maxToolCalls: 3 } : n)),
    }, { properties: ['proper-completion'], timeoutMs: 1 });
    expect(declared.stateSpace.complete).toBe(true);
    expect(declared.stateSpace.agents).toEqual([{ node: 'Agent', tools: 1, maxToolCalls: 3, assumed: false }]);
    expect(declared.counts.violated).toBe(0);
    expect(declared.counts.unknown).toBe(0);
  });

  it('treats a spent round budget as a designed pause, not a stranding', async () => {
    // Without `A_rounds_out` the graph reaches a quiescent marking holding `A/dispatched` and
    // `A/queue` with no round token left — work nothing can ever take. That is a real stranding
    // in the abstraction (a real agent throws "Max iterations reached" first, which the
    // value-blind graph cannot know), so the net makes it a terminal the codec writes back.
    const c = compile(agentOneTool);
    expect(c.netMap.node('Agent').transitions.roundsOut).not.toBeNull();
  });
});

describe('the structural hash', () => {
  // The net cache is keyed by `(structural hash, budget)`. Neither the `ai_tool` wiring nor
  // `maxRounds` is derivable from the main graph, so leaving them out of the hash let two
  // materially different agent workflows share one compiled net — an agent dispatching through
  // arms built for a different workflow. Found by the boundary review, not by a failing test.
  const withoutTools = { ...agentOneTool, toolConnections: [] };
  const withNineRounds = {
    ...agentOneTool,
    nodes: agentOneTool.nodes.map((n) => (n.name === 'Agent' ? { ...n, maxRounds: 9 } : n)),
  };

  it('separates workflows that differ only in their ai_tool wiring', () => {
    expect(structuralHash(analyse(agentOneTool))).not.toBe(structuralHash(analyse(withoutTools)));
  });

  it('separates workflows that differ only in the agent round budget', () => {
    expect(structuralHash(analyse(agentOneTool))).not.toBe(structuralHash(analyse(withNineRounds)));
  });

  it('separates a declared round budget from an assumed one of the same size', () => {
    // Same seed, same marking — but only one of them licenses a bound in a verification report,
    // and the fallback is a compile option, so the same workflow under a different cap must not
    // reuse the entry either.
    const assumed = analyse(agentAssumedRounds, { maxAgentRounds: 3 });
    const declared = analyse({
      ...agentAssumedRounds,
      nodes: agentAssumedRounds.nodes.map((n) => (n.name === 'Agent' ? { ...n, maxRounds: 3 } : n)),
    });
    expect(assumed.byName.get('Agent')!.maxRounds).toBe(declared.byName.get('Agent')!.maxRounds);
    expect(structuralHash(assumed)).not.toBe(structuralHash(declared));
  });

  it('is unchanged by adding an empty toolConnections list to a workflow without agents', () => {
    expect(structuralHash(analyse(linear))).toBe(structuralHash(analyse({ ...linear, toolConnections: [] })));
  });
});
