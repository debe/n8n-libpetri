/**
 * Spike — the agent tool-call round: a fan-out whose size is decided at run time.
 *
 * The shape is `references/patterns.md` §5, "fan-out and join with pending markers", with one
 * change that this spike exists to justify: **the round's size is a budget, not a count.**
 *
 * [IO-015] output validation compares the produced place *names* (`validateOutSpec` takes a
 * `Set<string>`; `enumerateBranches` returns `ReadonlySet<Place>`), so an `Out` branch says
 * which places a firing writes and never how many tokens it writes to them. The first half
 * pins that fact: an action may deposit `n` tokens into a place a branch names once. That is
 * exactly what makes a deposited count *invisible* to the state-class graph, which enumerates
 * the same branches and fires the "some calls" branch as one token — an under-approximation of
 * the executor, the direction that yields a false `proven` on a safety property. Measured, an
 * earlier shape peaked at one call in flight where the executor reaches many.
 *
 * The second half pins the fix. `A_dispatch` consumes one unit of a per-agent budget per
 * firing, so "how many tool calls" becomes "how many times dispatch fired" — a *path*, which
 * enumeration sees: `peak(A/outstanding)` equals the budget. Nothing refunds it, and that is
 * load-bearing: refund it at the join and a round can dispatch without bound, `T/done`
 * accumulates and the graph truncates. This is NU-040's decidability lever — *"the budget place
 * is the decidability lever"* — without ν-names, because one round is live per agent.
 *
 * The last part measures what it costs. Not `m^K` — the graph is keyed on markings, and two
 * dispatch sequences of the same tools reach one marking — but a product of independent
 * counters, polynomial in K and in the tool count; the numbers are what
 * `DEFAULT_MAX_AGENT_TOOL_CALLS` rests on.
 */
import { PetriNet, Transition, and, one, outPlace, place, tokenOf, xor } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';
import { marking, runNet } from './support.js';

// ==================== 1. an Out branch names places, never token counts ====================

describe('an Out branch names places, not token counts', () => {
  it('lets one firing deposit three tokens into a place its branch names once', async () => {
    const src = place<unknown>('src');
    const bag = place<unknown>('bag');
    const done = place<unknown>('done');
    const t = Transition.builder('fan')
      .inputs(one(src))
      .outputs(xor(outPlace(done), and(outPlace(done), outPlace(bag))))
      .action(async (ctx) => {
        ctx.output(done, null);
        for (let i = 0; i < 3; i++) ctx.output(bag, i);
      })
      .build();
    const net = PetriNet.builder('mult').transitions(t).build();
    const { marking: m } = await runNet(net, marking([[src, [tokenOf<unknown>('go')]]]));
    expect(m.peekTokens(bag)).toHaveLength(3);
    expect(m.peekTokens(done)).toHaveLength(1);
  });
});

// ==================== 2. the round, with a budget ====================

/** The round gadget of `src/compiler/gadget.ts`, reduced to one agent and `m` tools. */
function roundNet(m: number, K: number, rounds: number, opts: { refundAtJoin?: boolean; doneMarkers?: boolean } = {}) {
  const P = (n: string) => place<unknown>(n);
  const running = P('running'), idle = P('idle'), routedReq = P('routed_req'), answered = P('answered');
  const queue = P('queue'), drained = P('drained'), dispatched = P('dispatched');
  const outstanding = P('outstanding'), response = P('response');
  const calls = P('calls'), roundsP = P('rounds'), stopped = P('stopped'), pause = P('_pause');
  const tools = Array.from({ length: m }, (_, i) => P(`t${i}/in_tool`));
  const dones = Array.from({ length: m }, (_, i) => P(`t${i}/done`));
  const T = (name: string) => Transition.builder(name);

  const net = PetriNet.builder('round').transitions(
    // The agent runs: answers, or asks. Idle back either way.
    T('run').inputs(one(running)).outputs(and(xor(outPlace(answered), outPlace(routedReq)), outPlace(idle)))
      .action(async (c) => { c.output(routedReq, c.input(routedReq) ?? null); c.output(idle, null); }).build(),
    // Open the round: with a queue, or already drained (an empty request).
    T('done_req').inputs(one(routedReq))
      .outputs(xor(and(outPlace(queue), outPlace(dispatched)), and(outPlace(drained), outPlace(dispatched))))
      .action(async (c) => { c.output(queue, null); c.output(dispatched, null); }).build(),
    // One call per firing, one budget unit per firing; the action says whether more remain.
    T('dispatch').inputs(one(queue), one(calls))
      .outputs(and(xor(...tools.map((t) => outPlace(t))), outPlace(outstanding), xor(outPlace(queue), outPlace(drained))))
      .action(async (c) => { c.output(tools[0]!, null); c.output(outstanding, null); c.output(drained, null); }).build(),
    ...tools.map((t, i) => (opts.doneMarkers
      ? T(`t${i}_run`).inputs(one(t)).outputs(and(outPlace(response), outPlace(dones[i]!)))
        .action(async (c) => { c.output(response, null); c.output(dones[i]!, null); }).build()
      : T(`t${i}_run`).inputs(one(t)).outputs(outPlace(response))
        .action(async (c) => { c.output(response, null); }).build())),
    // Collect: a sink, or — the variant this spike rules out — a refund of the budget.
    (opts.refundAtJoin
      ? T('collect').inputs(one(outstanding), one(response)).outputs(outPlace(calls)).action(async (c) => { c.output(calls, null); }).build()
      : T('collect').inputs(one(outstanding), one(response)).build()),
    // Resume: drained, and nothing still out.
    T('resume').inputs(one(dispatched), one(drained), one(roundsP), one(idle)).inhibitors(outstanding)
      .outputs(outPlace(running)).action(async (c) => { c.output(running, null); }).build(),
    // Budget spent with calls still queued: the agent re-enters to fail, never a stranding.
    T('calls_out').inputs(one(dispatched), one(queue), one(idle)).inhibitors(calls, outstanding)
      .outputs(outPlace(running)).action(async (c) => { c.output(running, null); }).build(),
    // Rounds spent with a round open: a designed pause, as in the compiled gadget.
    T('rounds_out').inputs(one(dispatched), one(drained)).inhibitors(roundsP, outstanding)
      .outputs(and(outPlace(stopped), outPlace(pause))).action(async (c) => { c.output(stopped, null); c.output(pause, null); }).build(),
  ).build();

  const m0 = MarkingState.builder();
  m0.tokens(running, 1); m0.tokens(calls, K); m0.tokens(roundsP, rounds);
  return { net, m0: m0.build(), outstanding, calls, queue, drained, running, routedReq, roundsP, tools };
}

function explore(net: PetriNet, m0: MarkingState, cap = 200_000) {
  const g = StateClassGraph.build(net, m0, cap);
  const peak = (p: ReturnType<typeof place<unknown>>) => {
    let n = 0;
    for (const sc of g.stateClasses()) n = Math.max(n, sc.marking.tokens(p));
    return n;
  };
  return { classes: g.size(), complete: g.isComplete(), peak };
}

describe('the round size is a budget, and the graph sees it as a path', () => {
  for (const K of [1, 2, 4]) {
    it(`explores every round size up to K = ${K}: peak(outstanding) = K`, () => {
      const r = roundNet(2, K, 2, { doneMarkers: true });
      const { complete, peak } = explore(r.net, r.m0);
      expect(complete).toBe(true);
      expect(peak(r.outstanding)).toBe(K);
    });
  }

  it('closes because nothing refunds the budget', () => {
    const r = roundNet(2, 4, 2, { doneMarkers: true });
    expect(explore(r.net, r.m0).complete).toBe(true);
  });

  it('would not close with the ν idiom\'s refund at the join, once tools leave done markers', () => {
    // NU-040's idiom refunds the budget when the join fires. That bounds calls *in flight*,
    // not calls *per round*: after a batch is collected the budget is full again, the queue
    // is still there, and the graph dispatches another batch — `T/done` grows each time, so
    // the marking set is infinite. The spike without done markers closes (the markings repeat);
    // the real gadget has them, and does not.
    const r = roundNet(2, 4, 2, { doneMarkers: true, refundAtJoin: true });
    expect(explore(r.net, r.m0, 20_000).complete).toBe(false);
  });

  it('the spurious "more remain" path ends in calls_out, not in a stranding', () => {
    // With the queue kept past the real end the graph spends the budget and reaches
    // `calls_out`; every quiescent class holds either `answered` or `stopped`, never an open
    // round with nothing left to fire.
    const r = roundNet(2, 2, 2, { doneMarkers: true });
    const g = StateClassGraph.build(r.net, r.m0, 200_000);
    for (const sc of g.stateClasses()) {
      if (g.enabledTransitions(sc).size > 0) continue;
      const open = sc.marking.tokens(r.queue) + sc.marking.tokens(r.drained);
      expect(open).toBe(0);
    }
  });
});

// ==================== 3. what the budget costs ====================

describe('the class count grows polynomially in the tool count', () => {
  // The graph is keyed on markings, so dispatch *sequences* do not multiply — dispatching t1
  // then t2 and t2 then t1 reach one marking. What multiplies is the product of per-tool
  // counters (`in_tool`, `done`) with the round's (`calls`, `outstanding`, `response`): about
  // m^2.8 in the tool count and K^3.7 in the budget on the real net. A four-tool agent at K = 8
  // truncates. The per-tool counters are interchangeable, so a symmetry quotient would divide
  // the m-dimension by about m!; that is libpetri work, recorded upstream — along with the
  // larger finding that the graph counts one marking once per enabling history.
  it('grows with the tool count at a fixed budget', () => {
    const two = explore(roundNet(2, 4, 2).net, roundNet(2, 4, 2).m0).classes;
    const three = explore(roundNet(3, 4, 2).net, roundNet(3, 4, 2).m0).classes;
    expect(three).toBeGreaterThan(two);
  });
});
