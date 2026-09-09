/**
 * Round trips (ADR 0005): the wait fixture through the real scheduler and back through
 * the codec, then resumed as n8n resumes it (`handleWaitingState`); a resumed execution
 * with two pending branches and a partial Merge slot, decoded, re-encoded and run; the
 * legacy consumer's shape on every encoded state; and seeded random generators —
 * `encode(decode(x)) ≡ x` up to slot renumbering for n8n-consistent state,
 * `decode(encode(m)) ≡ m` under the semantic projection for quiescent pause markings.
 */
import { InMemoryEventStore } from 'libpetri';
import type { IRunExecutionData, Workflow } from 'n8n-workflow';
import { decodeExecutionData, encodeMarking } from '../../src/codec.js';
import { compile, type CompiledWorkflow, type WorkflowDescription } from '../../src/compiler/index.js';
import { PetriScheduler } from '../../src/scheduler/index.js';
import { agentSharedTool, agentTwoTools, ALL, conn, linear, node, twoTriggers, workflow } from '../fixtures/workflows.js';
import {
  FakeHost, execute, fakeHooks, fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData, ranNodes, sleep,
  type NodeScript,
} from '../scheduler/support.js';
import {
  Rng, assertLegacyShape, emptyState, entryFor, gadget, live, named, namedLive, randomExecutionData, randomPauseMarking,
  slotsOf, src, stateOf, taskData, view,
} from './support.js';

const START = items({ n: 1 });

/** Runs a fresh `PetriScheduler` on `red` as n8n would after loading it (a new `WorkflowExecute`). */
async function resume(wf: Workflow, red: IRunExecutionData, scripts: Readonly<Record<string, NodeScript>> = {}, host = new FakeHost(wf, red, scripts)) {
  const store = new InMemoryEventStore();
  const scheduler = new PetriScheduler({ nodeHelpers: fakeNodeHelpers, legacy: () => { throw new Error('legacy'); }, eventStore: store });
  const hooks = fakeHooks(host.calls);
  await scheduler.run(host, wf, red, hooks);
  return { scheduler, host, store };
}

describe('an agent round the execution stopped inside', () => {
  /**
   * One agent that asks for both tools once and answers afterwards, and a Calculator that
   * cancels the execution the first time it runs. The state is shared across both phases on
   * purpose: the resumed run must find the agent *mid-round*, not asking again.
   */
  function agentScripts() {
    let asked = false;
    let cancelled = false;
    return {
      Agent: () => {
        if (asked) return { data: [[{ json: { answer: 'done' } }]] };
        asked = true;
        return {
          actions: ['Calculator', 'Search'].map((nodeName, i) => ({
            actionType: 'ExecutionNodeAction' as const, nodeName, input: {}, type: 'ai_tool' as const,
            id: `c${i}`, metadata: {},
          })),
          metadata: { requestId: 'r1' },
        };
      },
      Calculator: async ({ host }) => {
        if (!cancelled) {
          cancelled = true;
          await sleep(20); host.cancel(); await sleep(5);
        }
        return { data: [[{ json: { result: 1 } }]] };
      },
      Search: () => ({ data: [[{ json: { result: 2 } }]] }),
    } as Readonly<Record<string, NodeScript>>;
  }

  it('resumes from the stack it was written back to, and finishes the round', async () => {
    // Cancel inside the first tool at budget 1, so the second is still undispatched.
    const scripts = agentScripts();
    const r = await execute(agentTwoTools, scripts, { startItems: [{ json: { n: 1 } }], budget: 1 });
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Agent', 'Calculator']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name))
      .toEqual(['Search', 'Agent']);

    // The decoded marking is the round, not two fresh activations: the agent's re-entry is on
    // `A/dispatched` (not on its main `X/in`, which would start a new run and lose the round),
    // the undispatched tool is on the queue, and the round is therefore not drained.
    const c = r.scheduler.compiled!;
    const m = decodeExecutionData(c, r.runExecutionData.executionData!, { runData: r.runData });
    const n = named(m);
    expect(n['id:Agent/dispatched']).toBe(1);
    expect(n['id:Agent/queue']).toBe(1);
    expect(n['id:Agent/drained']).toBeUndefined();
    expect(n['id:Agent/in']).toBeUndefined();
    // The tool-call budget comes fresh from `sharedMarking`: it resets across a resume.
    expect(n['id:Agent/calls']).toBe(c.netMap.node('Agent').maxToolCalls);
    // `Search` has a reserved `runData` slot but never ran, so its `X/done` must not be marked:
    // `initializeNodeRunData` writes the slot at plan time, with no `data`.
    expect(n['id:Search/done']).toBeUndefined();
    expect(n['id:Calculator/done']).toBe(1);

    // And it runs to completion from there: the remaining tool, then the agent with both
    // results, then the rest of the workflow. Neither tool runs twice.
    const { scheduler, host } = await resume(r.workflow, r.runExecutionData, scripts);
    expect(scheduler.outcome).toBe('completed');
    expect(ranNodes(host.calls)).toEqual(['Search', 'Agent', 'End']);
    expect(r.runData.Calculator).toHaveLength(1);
    expect(r.runData.Search).toHaveLength(1);
    expect(r.runData.End![0]!.data!.main![0]![0]!.json).toEqual({ answer: 'done' });
  });
});

describe('a tool shared by two agents', () => {
  it('attributes a pending tool call to the agent whose round names it', () => {
    // The encoder writes a round's tools *before* its agent (the stack is depth-descending, and
    // a tool sits one below its agent), so attributing during the stack walk would always see
    // an empty round map and fall back to the tool's first agent. Here that would be `A1`.
    const c = compile(agentSharedTool);
    const wf = fakeWorkflow(agentSharedTool);
    const red = newRunExecutionData(wf.nodes.Trigger!, { startItems: items({ n: 1 }) });
    const x = red.executionData!;
    x.nodeExecutionStack = [
      { node: wf.nodes.Calculator!, data: { main: [items({ q: 1 })] }, source: { main: [{ previousNode: 'A2' }] } },
      {
        node: wf.nodes.A2!, data: { main: [items({})] }, source: { main: [{ previousNode: 'A1' }] },
        metadata: {
          nodeWasResumed: true,
          subNodeExecutionData: { actions: [{ nodeName: 'Calculator', runIndex: 0, action: {} }], metadata: {} },
        },
      },
    ] as never;

    const n = named(decodeExecutionData(c, x, { runData: {} }));
    expect(n['id:A2/dispatched']).toBe(1);
    expect(n['id:A2/queue']).toBe(1);
    expect(n['id:A2/drained']).toBeUndefined();
    expect(n['id:A1/dispatched']).toBeUndefined();
    expect(n['id:A1/queue']).toBeUndefined();
  });
});

describe('the wait fixture', () => {
  it('encoded by the scheduler, decoded and re-encoded byte-for-byte; then resumed as handleWaitingState resumes it and run to completion', async () => {
    const r = await execute(linear, {
      B: ({ runExecutionData }) => { runExecutionData.waitTill = new Date(Date.now() + 60_000); return { data: [items({ b: 1 })] }; },
    }, { startItems: START });
    expect(r.scheduler.outcome).toBe('paused');
    const c = r.scheduler.compiled!;
    const x = r.runExecutionData.executionData!;
    assertLegacyShape(x, r.workflow, c);
    expect(x.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);

    const m = decodeExecutionData(c, x, { runData: r.runData });
    expect(named(m)['id:B/in']).toBe(1);
    expect(named(m)['id:Trigger/done']).toBe(1);
    expect(named(m)['id:A/done']).toBe(1);
    expect(named(m)['id:B/done']).toBe(1); // the waiting run is recorded; handleWaitingState pops it on resume
    expect(named(m)._pause).toBeUndefined(); // a resumed net is not paused
    const y = encodeMarking(c, live(m), emptyState(), { node: (n) => r.workflow.nodes[n] });
    expect(y.nodeExecutionStack).toEqual(x.nodeExecutionStack);
    expect(y.nodeExecutionStack[0]).toBe(x.nodeExecutionStack[0]);
    expect(y.waitingExecution).toEqual(x.waitingExecution);
    expect(y.waitingExecutionSource).toEqual(x.waitingExecutionSource);

    // n8n `handleWaitingState` (workflow-execute.ts 1501–1521): clear waitTill, disable the
    // node of nodeExecutionStack[0], pop the last run of lastNodeExecuted.
    const red = r.runExecutionData;
    red.waitTill = undefined;
    x.nodeExecutionStack[0]!.node.disabled = true;
    red.resultData.runData[red.resultData.lastNodeExecuted!]!.pop();
    const before = r.host.calls.length;
    const { scheduler } = await resume(r.workflow, red, {}, r.host);
    expect(scheduler.outcome).toBe('completed');
    expect(ranNodes(r.host.calls.slice(before))).toEqual(['B', 'C']);
    // B re-ran as a pass-through of its stored input; C received it.
    expect(r.runData.B).toHaveLength(1);
    expect(r.runData.C).toHaveLength(1);
    expect(r.runData.C![0]!.data!.main![0]![0]!.json).toEqual({ n: 1 });
    expect(red.executionData!.nodeExecutionStack).toEqual([]);
    expect(red.executionData!.waitingExecution).toEqual({});
  });
});

/** T → A → M.0, T → B → M.1, T → C → D, T → W (the Wait node); M → End. */
const twoBranches: WorkflowDescription = workflow('two-branches', [
  node('T', 'trigger', [0, 0]),
  node('A', 'set', [200, -100]), node('B', 'set', [200, 0]), node('C', 'set', [200, 100]), node('W', 'set', [200, 200]),
  node('M', 'merge', [400, -50]), node('D', 'set', [400, 100]), node('End', 'set', [600, -50]),
], [
  conn('T', 0, 'A', 0), conn('T', 0, 'B', 0), conn('T', 0, 'C', 0), conn('T', 0, 'W', 0),
  conn('A', 0, 'M', 0), conn('B', 0, 'M', 1), conn('C', 0, 'D', 0), conn('M', 0, 'End', 0),
], 'T');

describe('a resumed execution with two pending branches and one partial Merge slot', () => {
  function resumedState(wf: Workflow) {
    const a = items({ a: 1 });
    const red = newRunExecutionData(wf.nodes.W!, { startItems: START });
    const x = red.executionData!;
    const bEntry = entryFor(wf.nodes.B!, [START], [src('T')]);
    const cEntry = entryFor(wf.nodes.C!, [START], [src('T')]);
    x.nodeExecutionStack = [bEntry, cEntry];
    x.waitingExecution = { M: { 2: { main: [a, null] } } };
    x.waitingExecutionSource = { M: { 2: { main: [src('A'), null] } } };
    red.resultData.runData = { T: [taskData(START)], A: [taskData(a)], W: [taskData(START)] };
    return { red, x, a, bEntry, cEntry };
  }

  it('decodes to two pending entries and a half-filled join slot, encodes back to the same state (slot renumbered), and the legacy shape holds', () => {
    const wf = fakeWorkflow(twoBranches);
    const { x, a, bEntry, cEntry, red } = resumedState(wf);
    const c = compile({ ...twoBranches, startNode: undefined, startNodes: ['B', 'C', 'T', 'A', 'W'] });
    const m = decodeExecutionData(c, x, { runData: red.resultData.runData });
    expect(named(m)['id:B/in']).toBe(1);
    expect(named(m)['id:C/in']).toBe(1);
    expect(named(m)['id:M/ready_0']).toBe(1);
    expect(named(m)['id:M/hasdata']).toBe(1);
    expect(named(m)['id:M/free_0']).toBeUndefined();
    expect(named(m)['id:M/free_1']).toBe(1);
    expect(named(m)['id:T/done']).toBe(1);
    expect(named(m)['id:A/done']).toBe(1);
    expect(named(m)['id:W/done']).toBe(1);
    const y = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(y.nodeExecutionStack).toEqual([bEntry, cEntry]);
    expect(y.nodeExecutionStack[0]).toBe(bEntry);
    expect(slotsOf(y.waitingExecution, 'M')).toEqual([{ main: [a, null] }]);
    expect(slotsOf(y.waitingExecutionSource!, 'M')).toEqual([{ main: [src('A'), null] }]);
    assertLegacyShape(y, wf, c);
  });

  it('run: B\'s output pairs with the decoded slot, M runs once with [a, b], C → D runs; nothing is stranded', async () => {
    const wf = fakeWorkflow(twoBranches);
    const { red, a } = resumedState(wf);
    const b = items({ b: 1 });
    const { scheduler, host } = await resume(wf, red, { B: () => ({ data: [b] }) });
    expect(scheduler.outcome).toBe('completed');
    // Data equivalence + happens-before (divergence #5), not n8n's total order.
    const ran = ranNodes(host.calls);
    expect([...ran].sort()).toEqual(['B', 'C', 'D', 'End', 'M']);
    expect(ran.indexOf('B')).toBeLessThan(ran.indexOf('M'));
    expect(ran.indexOf('M')).toBeLessThan(ran.indexOf('End'));
    expect(ran.indexOf('C')).toBeLessThan(ran.indexOf('D'));
    const mRun = host.runNodeCalls.find((r) => r.node === 'M')!;
    // addPairedItemLineage rebuilds the input arrays (n8n line 65): compare by content.
    expect(mRun.main[0]!.map((i) => i.json)).toEqual(a.map((i) => i.json));
    expect(mRun.main[1]!.map((i) => i.json)).toEqual([{ b: 1 }]);
    expect(red.executionData!.waitingExecution).toEqual({});
    expect(red.executionData!.nodeExecutionStack).toEqual([]);
  });
});

describe('a partial slot whose missing input is fed only by unreachable producers', () => {
  it('completes on decode with the seeded empty (R6\'s null → [] substitution done once) and comes back as a stack entry', () => {
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    const a = items({ a: 1 });
    const x = stateOf([], { Merge: { 0: { main: [a, null] } } }, { Merge: { 0: { main: [src('TrigA'), null] } } });
    const m = decodeExecutionData(c, x);
    expect(named(m)['id:Merge/ready_0']).toBe(1);
    expect(named(m)['id:Merge/ready_1']).toBe(1);
    const y = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(y.nodeExecutionStack).toEqual([{ node: wf.nodes.Merge, data: { main: [a, []] }, source: { main: [src('TrigA'), null] } }]);
    expect(y.waitingExecution).toEqual({});
  });

  it('the seed is not written back once an activation has consumed it: an entry plus a slot on the seeded input round-trips exactly', () => {
    // Regression: re-queuing the seed behind the entry added a phantom `{ main: [null, []] }`
    // slot n8n never had, and stranded a token on the seeded input after the entry had run.
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    const b = items({ b: 1 });
    const e = entryFor(wf.nodes.Merge!, [items({ a: 1 }), []], [src('TrigA'), null]);
    const x = stateOf([e], { Merge: { 3: { main: [null, b] } } }, { Merge: { 3: { main: [null, src('TrigB')] } } });
    const y = encodeMarking(c, live(decodeExecutionData(c, x)), emptyState(), { node: (n) => wf.nodes[n] });
    expect(y.nodeExecutionStack).toEqual([e]);
    expect(y.nodeExecutionStack[0]).toBe(e);
    expect(slotsOf(y.waitingExecution, 'Merge')).toEqual([{ main: [null, b] }]);
    expect(slotsOf(y.waitingExecutionSource!, 'Merge')).toEqual([{ main: [null, src('TrigB')] }]);
    assertLegacyShape(y, wf, c);
  });

  it('run: the decoded entry runs once and the net quiesces with nothing stranded on the seeded input', async () => {
    const wf = fakeWorkflow(twoTriggers);
    const red = newRunExecutionData(wf.nodes.Merge!, { startItems: START });
    const e = entryFor(wf.nodes.Merge!, [START, []], [src('TrigA'), null]);
    red.executionData!.nodeExecutionStack = [e];
    red.resultData.runData = { TrigA: [taskData(START)] };
    const { scheduler, host } = await resume(wf, red);
    expect(scheduler.outcome).toBe('completed');
    expect(ranNodes(host.calls)).toEqual(['Merge', 'End']);
    expect(red.executionData!.nodeExecutionStack).toEqual([]);
    expect(red.executionData!.waitingExecution).toEqual({});
  });
});

describe('random n8n state: encode(decode(x)) ≡ x up to slot renumbering', () => {
  const fixtures = Object.entries(ALL).map(([name, desc]) => ({ name, desc, c: compile(desc), wf: fakeWorkflow(desc) }));

  it.each(fixtures)('$name', ({ c, wf }) => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = new Rng(seed * 7919);
      const { state: x, runData } = randomExecutionData(rng, c, wf);
      const m = decodeExecutionData(c, x, { runData });
      const y = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
      const why = `seed ${seed}`;
      expect(y.nodeExecutionStack.length, why).toBe(x.nodeExecutionStack.length);
      y.nodeExecutionStack.forEach((e, k) => expect(e, `${why} entry ${k}`).toBe(x.nodeExecutionStack[k]));
      expect(Object.keys(y.waitingExecution).sort(), why).toEqual(Object.keys(x.waitingExecution).sort());
      for (const node of Object.keys(x.waitingExecution)) {
        expect(slotsOf(y.waitingExecution, node), `${why} slots of ${node}`).toEqual(slotsOf(x.waitingExecution, node));
        expect(slotsOf(y.waitingExecutionSource!, node), `${why} sources of ${node}`).toEqual(slotsOf(x.waitingExecutionSource!, node));
      }
      assertLegacyShape(y, wf, c);
      // Decoding the re-encoded state gives the same marking, token for token (same payload objects).
      const m2 = decodeExecutionData(c, y, { runData });
      expect(named(m2), why).toEqual(named(m));
      for (const [p, tokens] of m) expect(m2.get(p)!.map((t) => t.value), `${why} ${p.name}`).toEqual(tokens.map((t) => t.value));
    }
  });
});

describe('random pause markings: decode(encode(m)) ≡ m under the semantic projection', () => {
  const fixtures = Object.entries(ALL).map(([name, desc]) => ({ name, desc, c: compile(desc), wf: fakeWorkflow(desc) }));

  function checkRoundTrip(c: CompiledWorkflow, wf: Workflow, seed: number): void {
    const rng = new Rng(seed * 104_729 + 17);
    const { marking, runData } = randomPauseMarking(rng, c, wf);
    const nodeOf = (n: string) => wf.nodes[n]!;
    const x = encodeMarking(c, live(marking), emptyState(), { node: nodeOf });
    assertLegacyShape(x, wf, c);
    const m2 = decodeExecutionData(c, x, { runData });
    const why = `seed ${seed}`;
    expect(view(c, live(m2), nodeOf), why).toEqual(view(c, live(marking), nodeOf));
    // Re-encoding gives the same entries (by reference) and slots. The waiting node's entry
    // is pinned to index 0 only while it sits on X/waiting; decoded, it is a plain entry and
    // takes its place in the canonical order (depth descending, canvas), per-node FIFO kept.
    const y = encodeMarking(c, live(m2), emptyState(), { node: nodeOf });
    const canonical = x.nodeExecutionStack
      .map((e, k) => ({ e, k, depth: gadget(c, e.node.name).depth, canvas: c.netMap.nodes.indexOf(gadget(c, e.node.name)) }))
      .sort((p, q) => (q.depth - p.depth) || (p.canvas - q.canvas) || (p.k - q.k))
      .map((p) => p.e);
    expect(y.nodeExecutionStack.length, why).toBe(x.nodeExecutionStack.length);
    y.nodeExecutionStack.forEach((e, k) => expect(e, `${why} entry ${k}`).toBe(canonical[k]));
    expect(y.waitingExecution, why).toEqual(x.waitingExecution);
    expect(y.waitingExecutionSource, why).toEqual(x.waitingExecutionSource);
    // The control places the codec re-seeds are back where the marking had them (free_i is
    // part of the projection: it is withheld by every entry-headed slot decode builds).
    const before = namedLive(c, live(marking));
    const after = namedLive(c, live(m2));
    for (const g of c.netMap.nodes) {
      expect(after[g.idle.name], `${why} ${g.idle.name}`).toBe(before[g.idle.name]);
      if (g.tries !== null) expect(after[g.tries.name], why).toBe(before[g.tries.name]);
    }
    expect(after._budget, why).toBe(c.effectiveBudget);
    expect(after._pause, why).toBeUndefined();
  }

  it.each(fixtures)('$name', ({ c, wf }) => {
    for (let seed = 1; seed <= 200; seed++) checkRoundTrip(c, wf, seed);
  });

  it('a join node keeps free_i + ready_i ≤ 1 per input after every round trip', () => {
    for (const { c, wf } of fixtures) {
      for (let seed = 1; seed <= 50; seed++) {
        const rng = new Rng(seed);
        const { marking, runData } = randomPauseMarking(rng, c, wf);
        const m2 = decodeExecutionData(c, encodeMarking(c, live(marking), emptyState(), { node: (n) => wf.nodes[n] }), { runData });
        const counts = named(m2);
        for (const g of c.netMap.nodes) {
          if (g.form === 'direct' || g.form === 'or') continue;
          for (const i of g.inputs) {
            const ready = [i.ready, i.readyData, i.readyEmpty].reduce((n, p) => n + (p === null ? 0 : (counts[p.name] ?? 0)), 0);
            expect(ready + (counts[i.free!.name] ?? 0), `${gadget(c, g.node).node} input ${i.index}`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
