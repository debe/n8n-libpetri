/**
 * Structural facts for every fixture: the net builds, `PrecompiledNet.compile` succeeds
 * (CORE-043 checked), `dotExport` renders (EXP-001), transition and place counts match the
 * hand-derived expectation, priorities equal depths (EXEC-002), declaration order equals
 * canvas order (EXEC-002 AC3), every transition declares an `Out` spec except the genuine
 * sinks, every start / retry / exhausted / skip / arm transition inhibits on `_halt` and
 * `_halted` (README "Retries, halt, cancellation") and the `NetMap` covers the whole net.
 */
import { dotExport } from 'libpetri/export';
import { compile, type CompiledWorkflow } from '../../src/compiler/index.js';
import { ALL } from '../fixtures/workflows.js';
import { declarationOrder } from './support.js';

/**
 * Per-node counts (transitions / owned places), before the two pause outcomes:
 * - trigger (no producer):            3 (start run route)       / 5 (in idle running ok done)
 * - direct, tree edge in, acyclic:    4 (+ skip)                / 5 (idle running ok done skipped)
 * - direct, cycle edge in, cyclic, o connected outputs: 3 + o sinks / 4 + o nil
 * - join, k inputs, e tree edges (+ c cycle edges), acyclic: 3 + 1 skip + 2e + c arms / 5 + 2k + hasdata
 * - choose-branch, 2 inputs, 2 tree edges: 3 + 3 skips + 4 arms  / 5 + 2 free + 4 ready
 * - OR, one input, n tree edges: 3 + skip + clear + 2n arms / 5 + ready hasdata ran
 * - split routing (> 3 connected outputs, o of them): 2 + o routes + done (+ skip) / 3 (+ skipped) + 2o
 * - retry adds 2 transitions (retry_wait exhausted) and 2 places (retry tries)
 * - a `$('Y')` reference with a read arc adds one `start_unmet` twin transition
 * Edge places: 2 per tree edge (data, empty), 1 per cycle edge. Shared: _budget _halt _halted.
 * Host: _halt_reap.
 *
 * M2 (README "Retries, halt, cancellation"): every node owns `X/waiting` and `X/stopped`
 * (the Wait and destination-node outcomes of `X_run` / `X_exhausted`) and the net has one
 * more shared place, the control terminal `_pause`, so every fixture gains
 * `pauseOutcomes(nodeCount)` places and no transition.
 */
const pauseOutcomes = (nodeCount: number): number => 2 * nodeCount + 1;
const EXPECTED: Record<keyof typeof ALL, { transitions: number; places: number }> = {
  linear: { transitions: 3 + 3 * 4 + 1, places: 5 + 3 * 5 + 3 * 2 + 3 + pauseOutcomes(4) },
  fanOut: { transitions: 3 + 3 * 4 + 1, places: 5 + 3 * 5 + 3 * 2 + 3 + pauseOutcomes(4) },
  // Trigger, IF, A, B, End direct; Merge = join(2 inputs, 2 tree edges): 3 + 1 + 4 arms = 8 / 5 + 4 + 1 = 10.
  diamond: { transitions: 3 + 4 * 4 + 8 + 1, places: 5 + 4 * 5 + 10 + 6 * 2 + 3 + pauseOutcomes(6) },
  // Switch routes per output: start run + 20 route_o + done + skip = 24 / idle running done skipped + 20 ok_o + 20 routed_o = 44.
  switch20: { transitions: 3 + 24 + 20 * 4 + 1, places: 5 + 44 + 20 * 5 + 21 * 2 + 3 + pauseOutcomes(22) },
  // Merge chooseBranch: start run route + skip_de skip_ed skip_ee + 4 arms = 10 / 5 + 2 free + 4 ready = 11.
  chooseBranch: { transitions: 3 + 4 + 10 + 4 + 1, places: 5 + 5 + 11 + 5 + 4 * 2 + 3 + pauseOutcomes(4) },
  // C = OR(1 input, 2 tree edges): start run route skip clear + 4 arms = 9 / 5 + ready_0 hasdata_0 ran_0 = 8.
  multiProducer: { transitions: 3 + 4 + 4 + 9 + 1, places: 5 + 5 + 5 + 8 + 4 * 2 + 3 + pauseOutcomes(4) },
  // Loop = cyclic join(1 input: tree + cycle edge; 2 connected outputs): 3 + skip + 3 arms + 2 sinks = 9 /
  //   5 + free ready hasdata + 2 nil = 10. Body = cyclic direct on a cycle edge, 1 output: 4 / 5. After direct: 4 / 5.
  //   Edges: 2 tree (Trigger->Loop, Loop->After) + 2 cycle (Loop->Body, Body->Loop) = 6.
  loopOverItems: { transitions: 3 + 9 + 4 + 4 + 1, places: 5 + 10 + 5 + 5 + 6 + 3 + pauseOutcomes(4) },
  // A = cyclic join(1 input: tree + cycle; 1 output): 3 + skip + 3 arms + 1 sink = 8 / 5 + 3 + 1 nil = 9.
  //   B = cyclic direct on a cycle edge, 1 output (two edges): 4 / 5. Exit direct: 4 / 5. Edges: 2 tree + 2 cycle = 6.
  userCycle: { transitions: 3 + 8 + 4 + 4 + 1, places: 5 + 9 + 5 + 5 + 6 + 3 + pauseOutcomes(4) },
  twoTriggers: { transitions: 3 + 3 + 8 + 4 + 1, places: 5 + 5 + 10 + 5 + 3 * 2 + 3 + pauseOutcomes(4) },
  // B references A (reachable avoiding B): B gets a start_unmet twin.
  expressionRef: { transitions: 3 + 4 + 4 + 5 + 1, places: 5 + 3 * 5 + 3 * 2 + 3 + pauseOutcomes(4) },
  retry: { transitions: 3 + 6 + 4 + 1, places: 5 + 7 + 5 + 2 * 2 + 3 + pauseOutcomes(3) },
  continueErrorOutput: { transitions: 3 + 3 * 4 + 1, places: 5 + 3 * 5 + 3 * 2 + 3 + pauseOutcomes(4) },
  ifHalf: { transitions: 3 + 4 + 4 + 1, places: 5 + 5 + 5 + 2 * 2 + 3 + pauseOutcomes(3) },
  // C = OR(2 tree edges): 9 / 8; Merge = join(2 inputs, 2 tree edges): 8 / 10; 6 tree edges.
  ifBothOutputs: { transitions: 3 + 4 + 9 + 8 + 4 + 1, places: 5 + 5 + 8 + 10 + 5 + 6 * 2 + 3 + pauseOutcomes(5) },
  // Q splits: start run + 4 route_o + done + skip = 8 / idle running done skipped + 4 ok_o + 4 routed_o = 12.
  fanOut4: { transitions: 3 + 8 + 4 * 4 + 1, places: 5 + 12 + 4 * 5 + 5 * 2 + 3 + pauseOutcomes(6) },
  // M = choose-branch(3 inputs, required [0, 1]): 3 + skips de ed ee + 6 arms = 12 /
  //   5 + 3 free + ready_0_data ready_0_empty ready_1_data ready_1_empty ready_2 = 13. 7 tree edges.
  partialRequired: { transitions: 3 + 12 + 4 * 4 + 1, places: 5 + 13 + 4 * 5 + 7 * 2 + 3 + pauseOutcomes(6) },
};

const DEPTHS: Record<keyof typeof ALL, Record<string, number>> = {
  linear: { Trigger: 0, A: 1, B: 2, C: 3 },
  fanOut: { Trigger: 0, A: 1, B: 1, C: 1 },
  diamond: { Trigger: 0, IF: 1, A: 2, B: 2, Merge: 3, End: 4 },
  switch20: { Trigger: 0, Switch: 1, S0: 2, S19: 2 },
  chooseBranch: { Trigger: 0, IF: 1, Merge: 2, End: 3 },
  multiProducer: { Trigger: 0, A: 1, B: 1, C: 2 },
  loopOverItems: { Trigger: 0, Loop: 1, Body: 1, After: 2 },
  userCycle: { Trigger: 0, A: 1, B: 1, Exit: 2 },
  twoTriggers: { TrigA: 0, TrigB: 0, Merge: 1, End: 2 },
  expressionRef: { Trigger: 0, IF: 1, A: 2, B: 2 },
  retry: { Trigger: 0, A: 1, B: 2 },
  continueErrorOutput: { Trigger: 0, A: 1, B: 2, Err: 2 },
  ifHalf: { Trigger: 0, IF: 1, A: 2 },
  ifBothOutputs: { Trigger: 0, IF: 1, C: 2, Merge: 3, End: 4 },
  fanOut4: { Trigger: 0, Q: 1, S0: 2, S3: 2 },
  partialRequired: { T: 0, A: 1, B: 1, Cc: 1, M: 2, End: 3 },
};

/** Canvas order: (y, x) ascending. */
const CANVAS_ORDER: Record<keyof typeof ALL, string[]> = {
  linear: ['Trigger', 'A', 'B', 'C'],
  fanOut: ['A', 'Trigger', 'B', 'C'],
  diamond: ['A', 'Trigger', 'IF', 'Merge', 'End', 'B'],
  switch20: ['Trigger', 'Switch', ...Array.from({ length: 20 }, (_, i) => `S${i}`)],
  chooseBranch: ['Trigger', 'IF', 'Merge', 'End'],
  multiProducer: ['A', 'Trigger', 'C', 'B'],
  loopOverItems: ['After', 'Trigger', 'Loop', 'Body'],
  userCycle: ['Trigger', 'A', 'B', 'Exit'],
  twoTriggers: ['TrigA', 'Merge', 'End', 'TrigB'],
  expressionRef: ['A', 'Trigger', 'IF', 'B'],
  retry: ['Trigger', 'A', 'B'],
  continueErrorOutput: ['B', 'Trigger', 'A', 'Err'],
  ifHalf: ['Trigger', 'IF', 'A'],
  ifBothOutputs: ['Trigger', 'IF', 'C', 'Merge', 'End'],
  fanOut4: ['Trigger', 'Q', 'S0', 'S1', 'S2', 'S3'],
  partialRequired: ['A', 'T', 'B', 'M', 'End', 'Cc'],
};

describe.each(Object.entries(ALL) as [keyof typeof ALL, (typeof ALL)[keyof typeof ALL]][])('fixture %s', (name, wf) => {
  let c: CompiledWorkflow;
  beforeAll(() => { c = compile(wf); });

  it('builds one flat net and PrecompiledNet.compile succeeds (CORE-043 clean)', () => {
    expect(c.net.transitions.size).toBeGreaterThan(0);
    expect(c.program.transitionCount).toBe(c.net.transitions.size);
    expect(c.program.placeCount).toBe(c.net.places.size);
    expect(c.program).toBe(c.program); // memoised
  });

  it('renders with dotExport', () => {
    const dot = dotExport(c.net);
    expect(dot.startsWith('digraph')).toBe(true);
    for (const t of c.net.transitions) expect(dot).toContain(t.name.replace(/[^A-Za-z0-9_]/g, '_'));
  });

  it('has the hand-derived transition and place counts', () => {
    expect({ transitions: c.net.transitions.size, places: c.net.places.size }).toEqual(EXPECTED[name]);
  });

  it('priorities equal depths: start = depth, start_unmet = depth - 1, run/route/done/exhausted = depth + 1, reap = maxDepth + 2', () => {
    for (const [node, depth] of Object.entries(DEPTHS[name])) {
      const g = c.netMap.node(node);
      const prio = (n: string) => c.netMap.transitionObject(n).priority;
      expect(g.depth, node).toBe(depth);
      expect(prio(g.transitions.start), `${node} start`).toBe(depth);
      for (const u of g.transitions.startUnmet) expect(prio(u), u).toBe(depth - 1);
      expect(prio(g.transitions.run), `${node} run`).toBe(depth + 1);
      expect(g.transitions.routes.length).toBeGreaterThanOrEqual(1);
      for (const r of g.transitions.routes) expect(prio(r), r).toBe(depth + 1);
      if (g.transitions.done !== null) expect(prio(g.transitions.done), `${node} done`).toBe(depth + 1);
      for (const s of [...g.transitions.skip, ...g.transitions.arms, ...g.transitions.clear, ...g.transitions.sinks]) {
        expect(prio(s), s).toBe(depth);
      }
      if (g.transitions.retryWait !== null) expect(prio(g.transitions.retryWait)).toBe(depth);
      if (g.transitions.exhausted !== null) expect(prio(g.transitions.exhausted)).toBe(depth + 1);
    }
    expect(c.netMap.transitionObject('_halt_reap').priority).toBe(c.analysis.maxDepth + 2);
  });

  it('declaration order equals canvas order (y, then x, ascending), the reap last', () => {
    expect(c.analysis.nodes.map((n) => n.node.name)).toEqual(CANVAS_ORDER[name]);
    expect(c.netMap.nodes.map((g) => g.node)).toEqual(CANVAS_ORDER[name]);
    expect(declarationOrder(c)).toEqual([...CANVAS_ORDER[name], null]);
  });

  it('every transition carries an Out spec except the genuine sinks: nil sinks and X_clear (CORE-043 AC4)', () => {
    for (const t of c.net.transitions) {
      const info = c.netMap.transition(t.name)!;
      if (info.role === 'sink' || info.role === 'clear') expect(t.outputSpec, t.name).toBeNull();
      else expect(t.outputSpec, t.name).not.toBeNull();
    }
  });

  it('NetMap covers every place and transition exactly once, with an owner and a role', () => {
    expect(c.netMap.transitions.map((t) => t.name).sort()).toEqual([...c.net.transitions].map((t) => t.name).sort());
    expect(c.netMap.places.map((p) => p.name).sort()).toEqual([...c.net.places].map((p) => p.name).sort());
    for (const p of c.netMap.places) {
      expect(c.net.places.has(p.place), p.name).toBe(true);
      // `_pause` joined the shared places in M2 (the Wait / destination-node control terminal).
      if (p.node === null) expect(['budget', 'halt', 'halted', 'pause']).toContain(p.role);
      else expect(c.netMap.node(p.node)).toBeDefined();
    }
    for (const t of c.netMap.transitions) {
      if (t.node === null) expect(t.role).toBe('reap');
      else expect(c.netMap.transitionsOf(t.node)).toContain(t);
    }
    expect(c.runningPlaces).toHaveLength(wf.nodes.length);
    expect(c.joinInputPlaces.map((p) => p.name)).toEqual(c.netMap.places.filter((p) => p.role === 'ready').map((p) => p.name));
  });

  it('joinReadyPlaces groups every ready place per (node, input) and covers joinInputPlaces exactly', () => {
    const flat = c.joinReadyPlaces.flatMap((j) => j.places.map((p) => p.name)).sort();
    expect(flat).toEqual(c.joinInputPlaces.map((p) => p.name).sort());
    for (const j of c.joinReadyPlaces) {
      const g = c.netMap.node(j.node);
      const input = g.inputs.find((i) => i.index === j.inputIndex)!;
      expect(input).toBeDefined();
      for (const p of j.places) expect(c.netMap.place(p.name)).toMatchObject({ role: 'ready', node: j.node, port: j.inputIndex });
    }
    expect(c.joinReadyPlaces).toHaveLength(c.netMap.nodes.reduce((n, g) => n + g.inputs.length, 0));
  });

  it('every start, start_unmet, retry_wait, exhausted, skip and arm inhibits on _halt and _halted; only starts and retry_wait on _pause; X/idle is consumed and refunded', () => {
    for (const g of c.netMap.nodes) {
      const guarded = [
        g.transitions.start, ...g.transitions.startUnmet, g.transitions.retryWait, g.transitions.exhausted,
        ...g.transitions.skip, ...g.transitions.arms,
      ];
      // A paused net (Wait, destination-node stop) must drain its structural transitions and
      // quiesce with every token on an in / ready / hasdata / waiting place, so exhausted,
      // skips, arms, clears, routes and done are NOT pause-inhibited (README "Retries, halt,
      // cancellation"); only the transitions that would start a new run are.
      const pauseInhibited = new Set([g.transitions.start, ...g.transitions.startUnmet, g.transitions.retryWait]);
      for (const n of guarded) {
        if (n === null) continue;
        const t = c.netMap.transitionObject(n);
        const inh = t.inhibitors.map((a) => a.place.name);
        expect(inh, n).toContain('_halt');
        expect(inh, n).toContain('_halted');
        if (pauseInhibited.has(n)) expect(inh, `${n} inhibits on _pause`).toContain('_pause');
        else expect(inh, `${n} is not pause-inhibited`).not.toContain('_pause');
      }
      for (const n of [...g.transitions.routes, g.transitions.done, ...g.transitions.clear]) {
        if (n === null) continue;
        expect(c.netMap.transitionObject(n).inhibitors.map((a) => a.place.name), `${n} is not pause-inhibited`).not.toContain('_pause');
      }
      for (const n of [g.transitions.start, ...g.transitions.startUnmet, g.transitions.retryWait]) {
        if (n === null) continue;
        expect(c.netMap.transitionObject(n).inputSpecs.map((s) => s.place.name), n).toContain(g.idle.name);
      }
      expect([...c.netMap.transitionObject(g.transitions.run).outputPlaces()].map((p) => p.name)).toContain(g.idle.name);
      expect(c.netMap.transitionObject('_halt_reap').resets.map((a) => a.place.name)).not.toContain(g.retry?.name ?? '');
    }
  });
});
