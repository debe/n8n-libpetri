/**
 * Spike 6 — what the SMT verifier proves on the gadgets, with z3.
 *
 * The encoding is atomic per firing, value-blind and priority-blind (VER-004), and
 * `joinedOrDeadLettered(p)` encodes `quiescent ∧ M(p) >= 1` (NU-040) with quiescence
 * taken as "every transition disabled" plus `M(sink) = 0` per declared sink (VER-002).
 * With NO sinks declared it is exactly workflow-net proper completion for place `p`: no
 * reachable stuck marking still holds a token there.
 *
 * Pins:
 * - join gadget, input 0 with two producers and input 1 with one: the second slot's
 *   token is stranded — `violated` on the join-input place `X/ready_0`. The edge place
 *   itself comes back `proven`, because `arm_0` always drains the edge into `ready_0`
 *   once `free_0` returns; the stranded token lives one place downstream of the edge.
 *   So the M4 proper-completion query must run per join input (`ready_i`), not only
 *   per edge place.
 * - the balanced diamond is `proven` on the edge place and on both ready places.
 * - two-phase start/run: `placeBound(_budget, k)` is proven; at k = 1
 *   `mutualExclusion(A/running, B/running)` is proven and at k = 2 it is violated, so
 *   the proof is real, not vacuous; `X/idle + X/running = 1` is a found P-invariant and
 *   `placeBound(X/running, 1)` is proven with the idle place and violated without it.
 * - a self-loop budget (one transition consumes and refunds `_budget`) proves
 *   `placeBound(_budget, k)` trivially — the incidence column for `_budget` is zero, so
 *   the verifier never sees the place move, and there is no `running` place to state
 *   exclusion on. That is why the gadget is two-phase.
 */
import {
  PetriNet, Transition, place, one, all, and, outPlace, xor, type Place,
} from 'libpetri';
import {
  SmtVerifier, joinedOrDeadLettered, mutualExclusion, placeBound,
  type MarkingStateBuilder, type PInvariant,
} from 'libpetri/verification';
import { describeZ3, nodeGadget, shared, type Shared } from './support.js';

const VERIFY_TIMEOUT = 120_000;

/** The join gadget with `n0` producer edges into input 0 and `n1` into input 1. */
function joinNet(n0: number, n1: number) {
  const budget = place<null>('_budget');
  const idle = place<null>('X/idle');
  const halt = place<null>('_halt');
  const hasdata = place<null>('X/hasdata');
  const running = place<null>('X/running');
  const out = place<null>('X/out');
  const outEmpty = place<null>('X/out_empty');
  const skipped = place<null>('X/skipped');
  const done = place<null>('X/done');
  const transitions: Transition[] = [];
  const seeded: Place<any>[] = [];
  const free: Place<null>[] = [];
  const ready: Place<null>[] = [];
  const edges: Place<null>[][] = [];

  for (const [i, count] of [n0, n1].entries()) {
    const freeI = place<null>(`X/free_${i}`);
    const readyI = place<null>(`X/ready_${i}`);
    free.push(freeI);
    ready.push(readyI);
    edges.push([]);
    for (let k = 0; k < count; k++) {
      const pIn = place<null>(`P${i}${k}/in`);
      const eData = place<null>(`e/P${i}${k}->X.${i}/data`);
      const eEmpty = place<null>(`e/P${i}${k}->X.${i}/empty`);
      seeded.push(pIn);
      edges[i]!.push(eData);
      transitions.push(
        Transition.builder(`P${i}${k}_run`).inputs(one(pIn))
          .outputs(xor(outPlace(eData), outPlace(eEmpty)))
          .action(async (ctx) => { ctx.output(eData, null); }).build(),
        Transition.builder(`arm_${i}${k}_data`).inputs(one(eData), one(freeI))
          .outputs(and(outPlace(readyI), outPlace(hasdata)))
          .action(async (ctx) => { ctx.output(readyI, null); ctx.output(hasdata, null); }).build(),
        Transition.builder(`arm_${i}${k}_empty`).inputs(one(eEmpty), one(freeI))
          .outputs(outPlace(readyI))
          .action(async (ctx) => { ctx.output(readyI, null); }).build(),
      );
    }
  }
  transitions.push(
    Transition.builder('X_start')
      .inputs(one(ready[0]!), one(ready[1]!), all(hasdata), one(budget), one(idle))
      .inhibitor(halt)
      .outputs(and(outPlace(running), outPlace(free[0]!), outPlace(free[1]!)))
      .action(async (ctx) => { ctx.output(running, null); ctx.output(free[0]!, null); ctx.output(free[1]!, null); })
      .build(),
    Transition.builder('X_skip')
      .inputs(one(ready[0]!), one(ready[1]!))
      .inhibitor(hasdata)
      .outputs(and(outPlace(outEmpty), outPlace(skipped), outPlace(free[0]!), outPlace(free[1]!)))
      .action(async (ctx) => {
        ctx.output(outEmpty, null); ctx.output(skipped, null); ctx.output(free[0]!, null); ctx.output(free[1]!, null);
      })
      .build(),
    Transition.builder('X_run')
      .inputs(one(running))
      .outputs(and(xor(outPlace(out), outPlace(outEmpty)), outPlace(budget), outPlace(idle), outPlace(done)))
      .action(async (ctx) => { ctx.output(out, null); ctx.output(budget, null); ctx.output(idle, null); ctx.output(done, null); })
      .build(),
  );
  const net = PetriNet.builder(`join-${n0}-${n1}`).transitions(...transitions).build();
  const verifier = () => SmtVerifier.forNet(net).initialMarking((m: MarkingStateBuilder) => {
    for (const p of seeded) m.tokens(p, 1);
    for (const f of free) m.tokens(f, 1);
    m.tokens(budget, 1);
    m.tokens(idle, 1);
  });
  return { net, verifier, edge0: edges[0]![0]!, ready0: ready[0]!, ready1: ready[1]! };
}

/** Two-phase nodes A and B under a budget of k (the per-node gadget, no sinks declared). */
function twoPhaseNet(k: number, withIdle = true, sh: Shared = shared()) {
  const ok = async () => ({ kind: 'ok' as const, value: 'v' });
  const a = nodeGadget({ name: 'A', withIdle, act: ok }, sh);
  const b = nodeGadget({ name: 'B', withIdle, act: ok }, sh);
  const net = PetriNet.builder(`two-phase-k${k}`).transitions(...a.transitions, ...b.transitions).build();
  const verifier = (tokensOnAIn = 1) => SmtVerifier.forNet(net).initialMarking((m: MarkingStateBuilder) => {
    m.tokens(a.input, tokensOnAIn); m.tokens(b.input, 1); m.tokens(sh.budget, k);
    if (withIdle) { m.tokens(a.idle, 1); m.tokens(b.idle, 1); }
  });
  return { a, b, net, verifier, budget: sh.budget };
}

/** A unit-weight P-semiflow over exactly `size` places summing to `constant`. */
function unitSemiflow(invariants: readonly PInvariant[], size: number, constant: number): PInvariant | undefined {
  return invariants.find((inv) =>
    inv.support.size === size && inv.constant === constant && [...inv.support].every((i) => inv.weights[i] === 1));
}

describeZ3('spike: verification with z3', () => {
  describe('joinedOrDeadLettered, no sinks declared (proper completion)', () => {
    it('unbalanced join (2 producers on input 0, 1 on input 1): violated on X/ready_0', { timeout: VERIFY_TIMEOUT }, async () => {
      const j = joinNet(2, 1);
      const r = await j.verifier().property(joinedOrDeadLettered(j.ready0)).verify();
      expect(r.verdict.type, r.report).toBe('violated');
      expect(r.counterexampleTransitions.length).toBeGreaterThan(0);
    });

    it('unbalanced join: the edge place itself is proven (the arm drains it into ready_0)', { timeout: VERIFY_TIMEOUT }, async () => {
      const j = joinNet(2, 1);
      const r = await j.verifier().property(joinedOrDeadLettered(j.edge0)).verify();
      expect(r.verdict.type, r.report).toBe('proven');
    });

    it('balanced diamond: proven on the edge place and on both ready places', { timeout: VERIFY_TIMEOUT }, async () => {
      const j = joinNet(1, 1);
      for (const p of [j.edge0, j.ready0, j.ready1]) {
        const r = await j.verifier().property(joinedOrDeadLettered(p)).verify();
        expect(r.verdict.type, `${p.name}\n${r.report}`).toBe('proven');
      }
    });
  });

  describe('two-phase start/run and the budget', () => {
    it('placeBound(_budget, k) is proven at k = 1 and k = 2', { timeout: VERIFY_TIMEOUT }, async () => {
      for (const k of [1, 2]) {
        const t = twoPhaseNet(k);
        const r = await t.verifier().property(placeBound(t.budget, k)).verify();
        expect(r.verdict.type, r.report).toBe('proven');
      }
    });

    it('mutualExclusion(A/running, B/running) is proven at k = 1 and violated at k = 2', { timeout: VERIFY_TIMEOUT }, async () => {
      const k1 = twoPhaseNet(1);
      const r1 = await k1.verifier().property(mutualExclusion(k1.a.running, k1.b.running)).verify();
      expect(r1.verdict.type, r1.report).toBe('proven');
      // X/idle + X/running = 1 is a P-invariant the verifier finds for each node.
      expect(r1.invariants.filter((inv) => unitSemiflow([inv], 2, 1) !== undefined).length, r1.report)
        .toBeGreaterThanOrEqual(2);

      const k2 = twoPhaseNet(2);
      const r2 = await k2.verifier().property(mutualExclusion(k2.a.running, k2.b.running)).verify();
      expect(r2.verdict.type, r2.report).toBe('violated');
    });

    it('placeBound(A/running, 1) is proven with the idle place and violated without it', { timeout: VERIFY_TIMEOUT }, async () => {
      const withIdle = twoPhaseNet(2, true);
      const r1 = await withIdle.verifier(2).property(placeBound(withIdle.a.running, 1)).verify();
      expect(r1.verdict.type, r1.report).toBe('proven');

      const noIdle = twoPhaseNet(2, false);
      const r2 = await noIdle.verifier(2).property(placeBound(noIdle.a.running, 1)).verify();
      expect(r2.verdict.type, r2.report).toBe('violated');
    });

    it('a self-loop budget proves placeBound trivially and has nothing to state exclusion on', { timeout: VERIFY_TIMEOUT }, async () => {
      const budget = place<null>('_budget');
      const aIn = place<null>('A/in');
      const aOut = place<null>('A/out');
      const bIn = place<null>('B/in');
      const bOut = place<null>('B/out');
      const selfLoop = (name: string, i: Place<null>, o: Place<null>) =>
        Transition.builder(name).inputs(one(i), one(budget)).outputs(and(outPlace(o), outPlace(budget)))
          .action(async (ctx) => { ctx.output(o, null); ctx.output(budget, null); }).build();
      const net = PetriNet.builder('self-loop').transitions(selfLoop('A_fire', aIn, aOut), selfLoop('B_fire', bIn, bOut)).build();

      const r = await SmtVerifier.forNet(net)
        .initialMarking((m: MarkingStateBuilder) => { m.tokens(aIn, 1); m.tokens(bIn, 1); m.tokens(budget, 1); })
        .property(placeBound(budget, 1))
        .verify();
      expect(r.verdict.type, r.report).toBe('proven');
      // The budget column of the incidence matrix is zero: `_budget = 1` alone is an invariant,
      // i.e. the verifier never sees the place move. The in-flight state has no place, so
      // mutual exclusion of the two actions is not even expressible on this net.
      expect(unitSemiflow(r.invariants, 1, 1), r.report).toBeDefined();
      expect([...net.places].map((p) => p.name)).not.toContain('A/running');
    });
  });
});
