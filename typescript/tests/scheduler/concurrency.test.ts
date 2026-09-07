/**
 * The k > 1 semantics (ADR 0006): what the shared `_budget` place buys, what it bounds, and
 * what changes when more than one node activation is in flight at once.
 *
 * At k = 1 the engine is n8n-sequential and M2 proved it case for case. Above 1 the net
 * fires every enabled `X_start` the budget allows, so two independent branches run at the
 * same time — the point of the project. The gate is **data equivalence**: `runData` minus
 * the clocks and `executionIndex` (`dataOf`) must be what k = 1 produced. Order is allowed
 * to differ (divergences #5 / #12); data is not.
 *
 * Timing bounds are deliberately loose (a loaded runner is slow, never fast), and every
 * timing test also asserts the structural fact behind it — `maxInFlight`, the high-water
 * mark of concurrent `X_run` actions. That is a *lower bound* on the `_budget +
 * Σ(running + ok + retry) = k` semiflow, not a reading of it: a retry wait and an exhausted
 * recording hold their budget unit without running the node, so the `runNode`
 * instrumentation below is what actually bounds concurrency and `maxInFlight` is the
 * scheduler's own agreeing witness.
 */
import { conn, diamond, fanOut, linear, loopOverItems, multiProducer, node, workflow } from '../fixtures/workflows.js';
import type { IExecuteData, IRunNodeResponse, ITaskStartedData, IRunExecutionData, Workflow } from 'n8n-workflow';
import { compile } from '../../src/compiler/index.js';
import {
  FakeHost, callsOf, dataOf, execute, items, ranNodes, sleep, transitionsFailed, transitionsStarted,
  type FakeHostOptions, type NodeScript,
} from './support.js';

const START = items({ n: 1 });

/** Node names in the order their `nodeExecuteAfter` hook ran: completion order. */
function completedNodes(calls: readonly string[]): string[] {
  return calls.filter((c) => c.startsWith('hook:nodeExecuteAfter(')).map((c) => c.slice('hook:nodeExecuteAfter('.length, -1));
}

/** Three independent branches off one trigger, plus one node behind the second. */
const threeBranches = workflow('three-branches', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('B', 'set', [200, 100]),
  node('C', 'set', [200, 200]),
  node('D', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('Trigger', 0, 'C', 0), conn('B', 0, 'D', 0),
], 'Trigger');

/** A node that takes `ms` and passes its input through. */
const takes = (ms: number): NodeScript => async ({ executionData }) => {
  await sleep(ms);
  return { data: [executionData.data.main![0] ?? []] };
};

describe('independent branches overlap', () => {
  const NODE_MS = 60;
  const scripts = { A: takes(NODE_MS), B: takes(NODE_MS), C: takes(NODE_MS), D: takes(NODE_MS) };

  async function timed(budget: number) {
    const t0 = performance.now();
    const r = await execute(threeBranches, scripts, { startItems: START, budget });
    return { r, elapsedMs: performance.now() - t0 };
  }

  it('k = 1 runs the four nodes one after the other (~4 x 60 ms) and never has two in flight', { timeout: 20_000 }, async () => {
    const { r, elapsedMs } = await timed(1);
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.maxInFlight).toBe(1);
    // Priority = DAG depth, so `D` (depth 2) beats `C` (depth 1): n8n's depth-first v1 order.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'D', 'C']);
    expect(elapsedMs).toBeGreaterThanOrEqual(4 * NODE_MS * 0.9);
  });

  it('two independent 60 ms branches take ~60 ms at k >= 2, not ~120 ms (the point of the project)', { timeout: 20_000 }, async () => {
    // Three siblings, nothing behind them: one round of node work at k = 3 against three at
    // k = 1. This is the M3 exit criterion at 60 ms instead of 500 ms.
    const siblings = { A: takes(NODE_MS), B: takes(NODE_MS), C: takes(NODE_MS) };
    const run = async (budget: number) => {
      const t0 = performance.now();
      const r = await execute(fanOut, siblings, { startItems: START, budget });
      return { r, elapsedMs: performance.now() - t0 };
    };
    const one = await run(1);
    const three = await run(3);
    expect(one.r.scheduler.maxInFlight).toBe(1);
    expect(three.r.scheduler.maxInFlight).toBe(3);
    expect(dataOf(three.r.runData)).toEqual(dataOf(one.r.runData));
    // The trigger is a pass-through, so k = 1 is three rounds of node work and k = 3 is one.
    expect(one.elapsedMs).toBeGreaterThanOrEqual(3 * NODE_MS * 0.9);
    expect(three.elapsedMs).toBeLessThan(2 * NODE_MS);
    expect(three.elapsedMs).toBeGreaterThanOrEqual(NODE_MS * 0.9);
  });

  it('k = 2 and k = 4 both collapse the four sequential rounds to two', { timeout: 20_000 }, async () => {
    const two = await timed(2);
    const four = await timed(4);
    expect(two.r.scheduler.compiled!.effectiveBudget).toBe(2);
    expect(four.r.scheduler.compiled!.effectiveBudget).toBe(4);
    expect(two.r.scheduler.maxInFlight).toBe(2);
    expect(four.r.scheduler.maxInFlight).toBe(3); // only three nodes are ever ready at once
    // k = 2: A+B, then C+D. k = 4: A+B+C, then D. Both are two rounds of node work; a
    // fourth unit buys nothing here because `D` cannot start before `B` has finished.
    for (const { elapsedMs } of [two, four]) {
      expect(elapsedMs).toBeLessThan(3 * NODE_MS);
      expect(elapsedMs).toBeGreaterThanOrEqual(2 * NODE_MS * 0.9);
    }
  });

  it('the budget is never exceeded: the in-flight count stays <= k for every k', { timeout: 20_000 }, async () => {
    for (const budget of [1, 2, 3, 4, 8]) {
      let inFlight = 0;
      let peak = 0;
      const instrumented: Record<string, NodeScript> = {};
      for (const name of ['A', 'B', 'C', 'D']) {
        instrumented[name] = async ({ executionData }) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(5);
          inFlight--;
          return { data: [executionData.data.main![0] ?? []] };
        };
      }
      const r = await execute(threeBranches, instrumented, { startItems: START, budget });
      expect(r.error, `k=${budget}`).toBeUndefined();
      expect(peak, `k=${budget}`).toBeLessThanOrEqual(budget);
      // The scheduler's own counter agrees with the instrumentation exactly: both count
      // `X_run` actions, and nothing here retries or exhausts.
      expect(r.scheduler.maxInFlight, `k=${budget}`).toBe(peak);
      expect(r.scheduler.maxInFlight, `k=${budget}`).toBeLessThanOrEqual(budget);
      expect(inFlight, `k=${budget}`).toBe(0);
    }
  });
});

describe('data equivalence is the gate', () => {
  // Node work of different lengths, so the completion order at k > 1 is not the k = 1 order.
  const scripts = {
    A: takes(30), B: takes(5), C: takes(15),
    D: async ({ executionData }: { executionData: IExecuteData }) => ({ data: [[{ json: { from: 'D', n: (executionData.data.main![0] ?? []).length } }]] }),
  } as Record<string, NodeScript>;

  it('every branch\'s runData at k = 2 / 4 / 8 is identical to the k = 1 result', { timeout: 20_000 }, async () => {
    const base = await execute(threeBranches, scripts, { startItems: START, budget: 1 });
    expect(base.error).toBeUndefined();
    for (const budget of [2, 4, 8]) {
      const r = await execute(threeBranches, scripts, { startItems: START, budget });
      expect(r.error, `k=${budget}`).toBeUndefined();
      expect(transitionsFailed(r.store), `k=${budget}`).toEqual([]);
      expect(r.scheduler.outcome, `k=${budget}`).toBe('completed');
      expect(dataOf(r.runData), `k=${budget}`).toEqual(dataOf(base.runData));
    }
  });

  it('the same holds for a join: the diamond\'s Merge gets both inputs in the same slots at any k', { timeout: 20_000 }, async () => {
    const branchScripts: Record<string, NodeScript> = {
      IF: ({ executionData }) => ({ data: [executionData.data.main![0] ?? [], executionData.data.main![0] ?? []] }),
      A: takes(25), B: takes(2),
      Merge: ({ executionData }) => ({ data: [[...(executionData.data.main![0] ?? []), ...(executionData.data.main![1] ?? [])]] }),
    };
    const base = await execute(diamond, branchScripts, { startItems: START, budget: 1 });
    const par = await execute(diamond, branchScripts, { startItems: START, budget: 4 });
    expect(base.error).toBeUndefined();
    expect(par.error).toBeUndefined();
    // B really did finish before A, so the k > 1 schedule is not the k = 1 one…
    expect(completedNodes(par.calls).indexOf('B')).toBeLessThan(completedNodes(par.calls).indexOf('A'));
    expect(completedNodes(base.calls).indexOf('B')).toBeGreaterThan(completedNodes(base.calls).indexOf('A'));
    // …and the data is the same anyway: the join's slots are positional per input.
    expect(dataOf(par.runData)).toEqual(dataOf(base.runData));
    expect(par.runData.Merge![0]!.source).toEqual(base.runData.Merge![0]!.source);
  });

  it('order does differ, and only order: executionIndex is start order, which concurrency moves', { timeout: 20_000 }, async () => {
    // Two branches of two nodes. At k = 1 the slow branch completes first (depth-first), so
    // `A2` is indexed before `B`; at k = 2 both branches start at once and the fast one gets
    // its successor going first, so `B2` is indexed before `A2`. The data is the same.
    const twoChains = workflow('two-chains', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0]), node('A2', 'set', [400, 0]),
      node('B', 'set', [200, 100]), node('B2', 'set', [400, 100]),
    ], [
      conn('Trigger', 0, 'A', 0), conn('A', 0, 'A2', 0),
      conn('Trigger', 0, 'B', 0), conn('B', 0, 'B2', 0),
    ], 'Trigger');
    const s = { A: takes(40), B: takes(2) } as Record<string, NodeScript>;
    const base = await execute(twoChains, s, { startItems: START, budget: 1 });
    const par = await execute(twoChains, s, { startItems: START, budget: 2 });
    expect(dataOf(par.runData)).toEqual(dataOf(base.runData));
    expect(base.runData.A2![0]!.executionIndex!).toBeLessThan(base.runData.B![0]!.executionIndex!);
    expect(par.runData.B2![0]!.executionIndex!).toBeLessThan(par.runData.A2![0]!.executionIndex!);
  });
});

describe('cancellation with several nodes in flight', () => {
  it('close() mid-flight: the in-flight nodes finish and are recorded, nothing new starts, the marking still encodes', async () => {
    const r = await execute(threeBranches, {
      A: async ({ host }) => { await sleep(10); host.cancel(); await sleep(10); return { data: [items({ a: 1 })] }; },
      B: takes(40), C: takes(40),
    }, { startItems: START, budget: 3 });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).toBe('cancelled');
    // EXEC-040: `close()` stops scheduling, it does not stop the actions already running.
    expect(ranNodes(r.calls).sort()).toEqual(['A', 'B', 'C', 'Trigger']);
    for (const n of ['A', 'B', 'C']) expect(r.runData[n], n).toHaveLength(1);
    // `D` was routed by `B`, but `close()` (ENV-013) means it never runs: `X_run` polls
    // `shouldStopExecuting()` first (line 49) and puts the entry back untouched, which is
    // where n8n's loop leaves it. Nothing of `D` is recorded.
    expect(r.runData.D).toBeUndefined();
    expect(callsOf(r.calls, 'D')).not.toContain('runNode(D)');
    // `D`'s start still fires — the entry is there — but `X_run` polls `shouldStopExecuting()`
    // and takes the stopped branch, which marks no `X/routed`, so `id:D/done` never fires.
    expect(transitionsStarted(r.store, (n) => n === 'id:D/done')).toHaveLength(0);
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['D']);
    expect(stack[0]!.source).toEqual({ main: [{ previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 }] });
  });

  it('a cancellation that lands after X_run leaves the routed unit, which only mode cancelled can encode', async () => {
    const r = await execute(linear, {
      A: async ({ host }) => { await sleep(5); host.cancel(); return { data: [items({ a: 1 })] }; },
    }, { startItems: START, budget: 4 });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
  });
});

describe('a halt with siblings in flight', () => {
  it('k = 2: both in-flight siblings are recorded, the successors they routed go back on the stack, nothing new starts', async () => {
    const r = await execute(threeBranches, {
      A: async () => { await sleep(10); throw new Error('A failed'); },
      B: takes(40), C: takes(40),
    }, { startItems: START, budget: 3 });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.scheduler.executionError?.message).toBe('A failed');
    expect(ranNodes(r.calls).sort()).toEqual(['A', 'B', 'C', 'Trigger']);
    expect(r.runData.B![0]!.executionStatus).toBe('success');
    expect(r.runData.C![0]!.executionStatus).toBe('success');
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    expect(r.runData.D).toBeUndefined();
    // n8n's `break` leaves the failed entry plus everything it never popped.
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['A', 'D']);
  });

  it('no node that actually ran is ever written back as a pending entry, at any k', { timeout: 20_000 }, async () => {
    // The halt marking snapshot is a lower bound on what `_halt_reap` destroys: it is taken
    // when the halting action writes its branch, and `_halt` only reaches the marking when
    // that action resolves. The start counter closes the gap (ADR 0006); this is the
    // invariant it protects — a node cannot be both recorded and pending.
    for (const budget of [1, 2, 4]) {
      for (const failAfter of [0, 5, 20]) {
        const r = await execute(threeBranches, {
          A: async () => { await sleep(failAfter); throw new Error('A failed'); },
          B: takes(10), C: takes(2),
        }, { startItems: START, budget });
        const label = `k=${budget} failAfter=${failAfter}`;
        expect(r.error, label).toBeUndefined();
        expect(r.scheduler.outcome, label).toBe('halted');
        const pending = r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name);
        // `A` is on the stack because n8n's `handleNodeExecutionError` pushes the failed entry.
        for (const name of pending.slice(1)) {
          expect(r.runData[name], `${label}: '${name}' both ran and is pending`).toBeUndefined();
        }
        expect(new Set(pending).size, label).toBe(pending.length);
      }
    }
  });
});

describe('divergence #15: claiming the execution-global waitTill', () => {
  /** Makes one node's `processNodeOutput` slow — n8n's `convertBinaryData` can be. */
  class SlowOutputHost extends FakeHost {
    constructor(
      w: Workflow, red: IRunExecutionData, scripts: Readonly<Record<string, NodeScript>>,
      options: FakeHostOptions, private readonly slow: string, private readonly ms: number,
    ) {
      super(w, red, scripts, options);
    }

    override async processNodeOutput(
      runNodeData: IRunNodeResponse, w: Workflow, executionData: IExecuteData,
      taskStartedData: ITaskStartedData, runIndex: number,
    ) {
      const result = await super.processNodeOutput(runNodeData, w, executionData, taskStartedData, runIndex);
      if (executionData.node.name === this.slow) await sleep(this.ms);
      return result;
    }
  }

  /** Sets `waitTill` 5 ms in — after a sibling has read the field, before that sibling ends. */
  const waitAndReturn: NodeScript = async ({ runExecutionData }) => {
    await sleep(5);
    runExecutionData.waitTill = new Date(Date.now() + 60_000);
    return { data: [items({ w: 1 })] };
  };

  it('the node that set waitTill keeps the pause even when a sibling reaches the recording path first', async () => {
    // `W`'s `runNode` sets the field at 5 ms and resolves; its `processNodeOutput` then takes
    // 40 ms (n8n's `convertBinaryData` can). `S` read the field at 0 ms — before `W` set it,
    // so `waitTill !== before` for `S` too — and resolves at 10 ms, reaching `record()` 35 ms
    // before `W` does. The claim is made in the same turn as each node's own `runNode`
    // resolution, so `W`, which resolved first, owns it. Claiming later (in `record`) gave
    // the pause to `S`, pushed `S` back on the stack and dropped `W`'s wait entirely.
    const wf = workflow('wait-claim', [
      node('Trigger', 'trigger', [0, 0]), node('W', 'set', [200, 0]), node('S', 'set', [200, 100]),
    ], [conn('Trigger', 0, 'W', 0), conn('Trigger', 0, 'S', 0)], 'Trigger');
    const r = await execute(wf, { W: waitAndReturn, S: takes(10) }, {
      startItems: START, budget: 2,
      host: (w, red, scripts, options) => new SlowOutputHost(w, red, scripts, options, 'W', 40),
    });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).toBe('paused');
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['W']);
    expect(r.runData.W![0]!.executionStatus).toBe('waiting');
    // `S` finished normally; `createTaskData` read the execution-global field and stamped
    // 'waiting' on it, which is corrected to the status the run actually had.
    expect(r.runData.S![0]!.executionStatus).toBe('success');
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'S'") && d.includes("by 'W'"))).toBe(true);
  });

  it('at k = 1 nothing changes: the node that waited claims it and is the only entry on the stack', async () => {
    const r = await execute(linear, {
      B: ({ runExecutionData }) => { runExecutionData.waitTill = new Date(Date.now() + 60_000); return { data: [items({ b: 1 })] }; },
    }, { startItems: START, budget: 1 });
    expect(r.scheduler.outcome).toBe('paused');
    expect(r.runData.B![0]!.executionStatus).toBe('waiting');
    expect(r.scheduler.diagnostics).toEqual([]);
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
  });

  it('a sibling that started after the pause was set never claims it, and is still recorded as the run it was', async () => {
    // `W` sets the field inside its own `runNode`, before `S` reads it, so `S`'s `before` is
    // already the pause: `S` cannot be the node that set it and never claims, whichever of
    // the two finishes first. `S` still reached `createTaskData` with the global field set,
    // so its recorded status has to be corrected.
    const wf = workflow('wait-started-after', [
      node('Trigger', 'trigger', [0, 0]), node('W', 'set', [200, 0]), node('S', 'set', [200, 100]),
    ], [conn('Trigger', 0, 'W', 0), conn('Trigger', 0, 'S', 0)], 'Trigger');
    const r = await execute(wf, {
      W: async ({ runExecutionData }) => {
        runExecutionData.waitTill = new Date(Date.now() + 60_000);
        await sleep(40);
        return { data: [items({ w: 1 })] };
      },
      S: takes(10),
    }, { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('paused');
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['W']);
    expect(r.runData.W![0]!.executionStatus).toBe('waiting');
    expect(r.runData.S![0]!.executionStatus).toBe('success');
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'S'"))).toBe(true);
  });

  it('a node that sets waitTill and then keeps working can still lose the claim; the refusal is reported, never silent', async () => {
    // The residual of divergence #15: `W` sets the field 5 ms in and runs for another 40 ms,
    // so `S`, which finishes at 20 ms, observed the change during its own run and no other
    // node had claimed it. (A node that *started* after the field was set never claims:
    // `waitTill === before` is the `none` branch of `observeWait`.) Nothing outside the node can tell which of the two set it. The
    // engine reports the ambiguity by diagnostic and records both runs correctly; the pause
    // is honoured, but by `S`. `AsyncLocalStorage` around `runNode` plus a write barrier on
    // the field would decide it (openIssues).
    const wf = workflow('wait-claim-residual', [
      node('Trigger', 'trigger', [0, 0]), node('W', 'set', [200, 0]), node('S', 'set', [200, 100]),
    ], [conn('Trigger', 0, 'W', 0), conn('Trigger', 0, 'S', 0)], 'Trigger');
    const r = await execute(wf, {
      W: async ({ runExecutionData }) => {
        // Set *after* `S` has read the field, so `S` sees it change during its own run.
        await sleep(5);
        runExecutionData.waitTill = new Date(Date.now() + 60_000);
        await sleep(40);
        return { data: [items({ w: 1 })] };
      },
      S: takes(20),
    }, { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('paused');
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'W'") && d.includes("by 'S'"))).toBe(true);
    expect(r.runData.W![0]!.executionStatus).toBe('success');
    expect(r.runData.S![0]!.executionStatus).toBe('waiting');
  });
});

describe('retryOnFail at k > 1 holds its budget unit across the wait (ADR 0004)', () => {
  const retryWf = workflow('retry-sibling', [
    node('Trigger', 'trigger', [0, 0]),
    node('R', 'set', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 30 }),
    node('B', 'set', [200, 100]),
    node('C', 'set', [200, 200]),
  ], [conn('Trigger', 0, 'R', 0), conn('Trigger', 0, 'B', 0), conn('Trigger', 0, 'C', 0)], 'Trigger');

  const scripts: Record<string, NodeScript> = {
    R: ({ call }) => { if (call < 2) throw new Error(`R try ${call}`); return { data: [items({ r: 1 })] }; },
    B: takes(5), C: takes(5),
  };

  it('the siblings run while R waits between tries — the unit R holds costs one slot, not the whole budget', { timeout: 20_000 }, async () => {
    const r = await execute(retryWf, scripts, { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.host.runNodeCalls.filter((c) => c.node === 'R')).toHaveLength(3);
    // B and C completed before R's last attempt: the retry wait did not starve them.
    const completed = completedNodes(r.calls);
    expect(completed.indexOf('B')).toBeLessThan(completed.indexOf('R'));
    expect(completed.indexOf('C')).toBeLessThan(completed.indexOf('R'));
    // A retry wait and the exhausted recording hold a budget unit without running the node,
    // so this counts runs, not tokens (see the header).
    expect(r.scheduler.maxInFlight).toBeLessThanOrEqual(2);
    expect(dataOf(r.runData)).toEqual(dataOf((await execute(retryWf, scripts, { startItems: START, budget: 1 })).runData));
  });

  it('the cost, pinned: at k = 1 the retry wait blocks the whole net, so a sibling only runs after the last try', { timeout: 20_000 }, async () => {
    const r = await execute(retryWf, scripts, { startItems: START, budget: 1 });
    const completed = completedNodes(r.calls);
    expect(completed).toEqual(['Trigger', 'R', 'B', 'C']);
    // At k = 2 one unit is unavailable for the two 30 ms waits; a third branch waits for it.
    const k2 = await execute(retryWf, scripts, { startItems: START, budget: 2 });
    expect(completedNodes(k2.calls).at(-1)).toBe('R');
  });
});

describe('the k-safety condition (README "Concurrency budget and its safety condition")', () => {
  it('is not about overlap — X/idle already forbids two activations of one node — but about arrival order', async () => {
    // `C`'s input 0 has two producers, so `C` runs twice, once per arrival. The compiler
    // forces k = 1, and at k = 1 the arrivals are the producers' declaration order.
    const c = compile(multiProducer, { budget: 4 });
    expect(c.requestedBudget).toBe(4);
    expect(c.effectiveBudget).toBe(1);
    expect(c.budgetRestriction).toEqual({ reason: 'multi-producer-input', detail: 'C.0 has 2 producers' });
    // The restriction is also a diagnostic: it is the only way a k > 1 conformance leg can
    // see which of n8n's own workflows actually ran above k = 1 (`scripts/run-conformance.sh`
    // collects these into `<label>.budget.txt`).
    const diagnosed = await execute(multiProducer, {}, { startItems: START, budget: 4 });
    expect(diagnosed.scheduler.diagnostics)
      .toContain('budget: k=4 lowered to 1 (multi-producer-input: C.0 has 2 producers)');
    const r = await execute(multiProducer, {
      A: async () => { await sleep(30); return { data: [items({ from: 'A' })] }; },
      B: () => ({ data: [items({ from: 'B' })] }),
    }, { startItems: START, budget: 4 });
    expect(r.scheduler.maxInFlight).toBe(1);
    expect(r.runData.C).toHaveLength(2);
    expect(r.runData.C![0]!.source).toEqual([{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(r.runData.C![1]!.source).toEqual([{ previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 }]);
  });

  it('the counterexample: with the same producers on separate consumers, k > 1 completes them in the other order', async () => {
    // The same `A` (30 ms) and `B` (instant), wired to one consumer each so the workflow is
    // k-safe. At k = 4 `B` completes first. Were `C`'s OR round allowed to run at k > 1 it
    // would take its first delivery from `B`, so `runData.C[0]` would carry `B`'s payload and
    // `C[1]` `A`'s — the payload/runIndex pairing of the test above, reversed. Positional
    // pairing is what the check protects.
    const wf = workflow('separate-consumers', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]), node('B', 'set', [200, 100]),
      node('CA', 'set', [400, 0]), node('CB', 'set', [400, 100]),
    ], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('A', 0, 'CA', 0), conn('B', 0, 'CB', 0)], 'Trigger');
    const c = compile(wf, { budget: 4 });
    expect(c.effectiveBudget).toBe(4);
    const r = await execute(wf, {
      A: async () => { await sleep(30); return { data: [items({ from: 'A' })] }; },
      B: () => ({ data: [items({ from: 'B' })] }),
    }, { startItems: START, budget: 4 });
    const completed = completedNodes(r.calls);
    expect(completed.indexOf('B')).toBeLessThan(completed.indexOf('A'));
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'CB', 'CA']);
  });

  it('a cycle is forced to k = 1 for the same reason, and the loop still runs correctly at any requested k', { timeout: 20_000 }, async () => {
    expect(compile(loopOverItems, { budget: 4 }).budgetRestriction!.reason).toBe('cyclic');
    let iteration = 0;
    const r = await execute(loopOverItems, {
      // Two iterations, then the `done` output.
      Loop: ({ executionData }) => (iteration++ < 2
        ? { data: [executionData.data.main![0] ?? [], []] }
        : { data: [[], items({ done: true })] }),
    }, { startItems: START, budget: 4 });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.compiled!.effectiveBudget).toBe(1);
    expect(r.scheduler.maxInFlight).toBe(1);
    expect(r.runData.Loop).toHaveLength(3);
    expect(r.runData.Body).toHaveLength(2);
    expect(r.runData.After).toHaveLength(1);
  });
});

describe('the compiled-workflow cache is keyed by (hash, budget)', () => {
  it('two budgets of one workflow are two entries; the same budget hits', async () => {
    const first = await execute(fanOut, {}, { startItems: START, budget: 2 });
    const cache = first.scheduler['cache' as keyof typeof first.scheduler] as unknown as { size: number };
    const second = await execute(fanOut, {}, { startItems: START, budget: 2 });
    expect(cache.size).toBe(1);
    expect(second.scheduler.compiled!.effectiveBudget).toBe(2);
    expect(callsOf(first.calls, 'A')).toEqual(callsOf(second.calls, 'A'));
  });
});
