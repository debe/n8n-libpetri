/**
 * The six property families against the nets `compile()` actually produces.
 *
 * Each family gets a fixture where the desirable property holds and, where the encoding can
 * express it, one where it does not. Two of the specified violation cases cannot be
 * produced on a compiled net and are pinned here as limits rather than dropped:
 *
 * - **proper completion on a join input.** `joinedOrDeadLettered` is a *quiescence*
 *   property, and on a compiled net z3 answers `unknown` for every join-input `ready_i`
 *   place — for the balanced diamond, which has no stranding, and for the unbalanced join,
 *   which has one. Measured to 600 s in `docs/verification.md`; the same shape hand-written
 *   as a bare join closes in under a second (`tests/spikes/verification.test.ts`), so it is
 *   the size and the marker places of the full gadget, not the property, that defeat it.
 * - **liveness of a node behind a join.** `unreachable({X/running})` is cheap when the
 *   answer is "dead" (~120 ms) and expensive when it is "live" (14 s on a 4-node workflow,
 *   `unknown` at 60 s on the diamond), because a live answer is a SAT witness Spacer has to
 *   search for.
 *
 * Both limits are asserted, so an improvement in libpetri or z3 breaks this file and forces
 * `docs/verification.md` to be re-measured rather than silently going stale.
 */
import { flatten } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { conn, diamond, fanOut, linear, multiProducer, node, twoTriggers, workflow } from '../fixtures/workflows.js';
import { alternativeEntryReach, producersOf, verify, verifyCompiled } from '../../src/verify/index.js';
import type { PropertyCheck } from '../../src/verify/index.js';
import {
  CASE_TIMEOUT_MS, TEST_TIMEOUT_MS, checksOf, describeZ3, digest, liveSampleNode, orphanBranch,
  retryFour, unbalancedJoin,
} from './support.js';

const base = { timeoutMs: TEST_TIMEOUT_MS } as const;

function nodeCheck(checks: readonly PropertyCheck[], node: string): PropertyCheck {
  const found = checks.find((c) => 'node' in c.subject && c.subject.node === node);
  if (found === undefined) throw new Error(`no check for node '${node}'`);
  return found;
}

describeZ3('verify: properties', () => {
  describe('budget', () => {
    it('placeBound(_budget, k) is proven at k = 1, 2 and 4', { timeout: CASE_TIMEOUT_MS }, async () => {
      for (const k of [1, 2, 4]) {
        const report = await verify(diamond, { ...base, budget: k, properties: ['budget'] });
        expect(report.budget).toBe(k);
        const bound = report.checks.find((c) => c.subject.kind === 'place')!;
        expect(bound.verdict, `k=${k}\n${digest(report)}`).toBe('proven');
        expect(bound.query.property).toBe('place-bound');
      }
    });

    it('the two-phase semiflow _budget + sum(running + ok) = k is among the invariants', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, { ...base, budget: 2, properties: ['budget'] });
      const semiflow = report.invariants.budgetSemiflow;
      expect(semiflow, digest(report)).not.toBeNull();
      expect(semiflow).toMatch(/_budget/);
      expect(semiflow).toMatch(/= 2$/);
      for (const g of compile(diamond, { budget: 2 }).netMap.nodes) {
        expect(semiflow, `${g.node} is not in the semiflow`).toContain(g.running.name);
        // The in-flight place: `X/ok` for a node routing one (or no) output, `X/ok_o` for a
        // node routing per output — where the enumeration returns one law per output.
        const inFlight = g.ok?.name ?? g.outputs[0]!.ok!.name;
        expect(semiflow, `${g.node} holds no in-flight place in the semiflow`).toContain(inFlight);
      }
      const structural = report.checks.find((c) => c.subject.kind === 'net')!;
      expect(structural.verdict).toBe('proven');
      expect(structural.query.method).toBe('P-invariant');
      // VER-007 is on by default and the encoder was handed more than the null-space basis.
      expect(report.invariants.encoded).toBeGreaterThanOrEqual(report.invariants.basis);
      expect(report.invariants.semiflowsEncoded).toBeGreaterThan(0);
    });
  });

  describe('no double activation', () => {
    it('placeBound(X/running, 1) is proven for every node, at k = 1 and k = 4', { timeout: CASE_TIMEOUT_MS }, async () => {
      for (const k of [1, 4]) {
        const report = await verify(diamond, { ...base, budget: k, properties: ['no-double-activation'] });
        const checks = checksOf(report, 'no-double-activation');
        expect(checks).toHaveLength(6);
        expect(checks.every((c) => c.verdict === 'proven'), `k=${k}\n${digest(report)}`).toBe(true);
      }
    });
  });

  describe('retry bound', () => {
    it('a retryOnFail node proves at most maxTries attempts — the place bound AND the producer check', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(retryFour, { ...base, properties: ['retry-bound'] });
      const checks = checksOf(report, 'retry-bound');
      // Two checks, because the place bound alone does not entail the attempt bound: it is
      // true in the initial marking and a net that refunded a try token would keep it.
      expect(checks).toHaveLength(2);
      const bound = checks[0]!;
      expect(bound.name).toBe('A/tries never holds more than 3');
      expect(bound.verdict, digest(report)).toBe('proven');
      expect(bound.query.property).toBe('place-bound');
      expect(bound.query.place).toMatch(/tries$/);

      const attempts = checks[1]!;
      expect(attempts.name).toBe('A attempts at most 4 times');
      expect(attempts.verdict, digest(report)).toBe('proven');
      // The half that would break under a compiler change: it needs no solver.
      expect(attempts.query.method).toBe('structural');
      expect(attempts.explanation).toContain('No transition produces');

      const none = await verify(linear, { ...base, properties: ['retry-bound'] });
      expect(checksOf(none, 'retry-bound')).toHaveLength(0);
    });

    it('the producer half is what carries the attempt bound: nothing in the net produces X/tries', () => {
      // Structural, no solver: the check reads the flattened net the encoder sees.
      const compiled = compile(retryFour);
      const tries = compiled.netMap.node('A').tries!;
      expect(producersOf(flatten(compiled.net), tries)).toEqual([]);
      // The query is live rather than vacuous: something *does* produce X/running.
      expect(producersOf(flatten(compiled.net), compiled.netMap.node('A').running).length).toBeGreaterThan(0);
    });
  });

  describe('mutual exclusion', () => {
    it('every pair is provable at k = 1 — the budget model is what makes it so', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, {
        ...base, budget: 1, properties: ['mutual-exclusion'], mutualExclusion: 'all-pairs',
      });
      const checks = checksOf(report, 'mutual-exclusion');
      expect(checks).toHaveLength(15); // 6 nodes, unordered pairs
      expect(checks.every((c) => c.verdict === 'proven'), digest(report)).toBe(true);
    });

    it('a caller-supplied pair is violated at k = 2, with the counterexample as a node path', { timeout: CASE_TIMEOUT_MS }, async () => {
      // `fanOut` and not `diamond`: a *violation* is a SAT witness Spacer has to search for,
      // and past a join that search does not close (docs/verification.md). Two siblings of
      // one trigger are the shallowest shape that can hold two budget units at once.
      const report = await verify(fanOut, { ...base, timeoutMs: 30_000, budget: 2, mutualExclusion: [['A', 'B']], properties: ['mutual-exclusion'] });
      const check = checksOf(report, 'mutual-exclusion')[0]!;
      expect(check.verdict, digest(report)).toBe('violated');
      const cex = check.counterexample;
      expect(cex, 'a violation must carry a witness').not.toBeNull();
      // Every step is a real node of the workflow, not a place name.
      const names = new Set(compile(fanOut).netMap.nodes.map((g) => g.node));
      expect(cex!.nodePath.length).toBeGreaterThan(0);
      for (const n of cex!.nodePath) expect(names, `'${n}' is not a node`).toContain(n);
      expect(cex!.nodePath).toContain('A');
      expect(cex!.nodePath).toContain('B');
      expect(cex!.steps.every((s) => s.node === null || names.has(s.node))).toBe(true);
      expect(cex!.stuckMarking.some((p) => p.role === 'running')).toBe(true);
    });

    it('a pair naming a node the workflow does not have is unknown, never a throw', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, { ...base, mutualExclusion: [['A', 'Nope']], properties: ['mutual-exclusion'] });
      const check = checksOf(report, 'mutual-exclusion')[0]!;
      expect(check.verdict).toBe('unknown');
      expect(check.reason).toMatch(/unknown node/);
    });
  });

  describe('dead nodes', () => {
    it('a node no execution can reach is reported dead, by name', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(orphanBranch, { ...base, properties: ['dead-nodes'] });
      const checks = checksOf(report, 'dead-nodes');
      expect(checks).toHaveLength(4);
      for (const dead of ['Orphan', 'OrphanChild']) {
        const check = nodeCheck(checks, dead);
        expect(check.verdict, `${dead}\n${digest(report)}`).toBe('violated');
        expect(check.explanation).toContain(`${dead} can never run`);
        // The polarity inverts: libpetri proved the unreachability, which is the finding.
        expect(check.query.verdict).toBe('proven');
        expect(check.query.property).toBe('unreachable');
      }
      expect(report.ok).toBe(false);
    });

    it('a reachable node is `unknown`, never `proven`: the SAT direction is not a liveness proof (VER-004)', { timeout: CASE_TIMEOUT_MS }, async () => {
      // 20 s, not the file's 5: the witness search for a live node one hop from the trigger
      // is ~650 ms measured, and this case has to *see* a `violated` from libpetri to be
      // about anything. Everything asserted below is about what verify() does with it.
      const report = await verify(orphanBranch, { ...base, timeoutMs: 20_000, properties: ['dead-nodes'] });
      const checks = checksOf(report, 'dead-nodes');
      expect(checks.some((c) => c.verdict === 'proven'), `no dead-nodes check may be 'proven'\n${digest(report)}`)
        .toBe(false);
      const live = checks.filter((c) => c.query.verdict === 'violated');
      expect(live.length, `libpetri found no reachable node at all; this case would be vacuous\n${digest(report)}`)
        .toBeGreaterThan(0);
      for (const check of live) {
        expect(check.verdict, check.name).toBe('unknown');
        expect(check.reason).toMatch(/VER-004/);
        expect(check.explanation).toContain('not a proof');
      }
      // The measured limit (docs/verification.md): on the diamond the join makes every live
      // node's witness search exceed the timeout, so libpetri itself answers `unknown`.
      const deep = await verify(diamond, { ...base, properties: ['dead-nodes'] });
      const merge = nodeCheck(checksOf(deep, 'dead-nodes'), 'Merge');
      expect(merge.verdict, `if this is now 'proven', re-measure docs/verification.md\n${digest(deep)}`)
        .toBe('unknown');
      expect(merge.query.verdict).toBe('unknown');
      expect(merge.reason).toBeTruthy();
    });

    it('a second trigger is an alternative entry point, not a finding — the workflow stays clean', { timeout: CASE_TIMEOUT_MS }, async () => {
      // n8n runs one trigger per execution, and `initialMarking` seeds only the start node's
      // own input, so `unreachable(TrigB/running)` really is proven. Reporting it as a
      // finding would fail the CLI's exit code on an ordinary Manual-plus-Webhook workflow.
      const report = await verify(twoTriggers, { ...base, properties: ['dead-nodes'] });
      const check = nodeCheck(checksOf(report, 'dead-nodes'), 'TrigB');
      expect(check.verdict, digest(report)).toBe('unknown');
      // libpetri's own verdict is still recorded: the downgrade is never hidden.
      expect(check.query.verdict).toBe('proven');
      expect(check.reason).toMatch(/one trigger per execution/);
      expect(check.reason).toMatch(/TrigB/);
      expect(report.ok, digest(report)).toBe(true);
      expect(report.counts.violated).toBe(0);
    });
  });

  describe('alternative entry points (no solver)', () => {
    it('names a second trigger and everything only it feeds, and nothing else', () => {
      expect([...alternativeEntryReach(compile(twoTriggers))]).toEqual([['TrigB', 'TrigB']]);
      // An unwired node whose shape has an input is an orphan, not an entry point: n8n can
      // never start there, so `Orphan` stays a finding.
      expect([...alternativeEntryReach(compile(orphanBranch))]).toEqual([]);
      // A private branch behind the second trigger is dead for the same reason it is.
      const twoBranches = workflow('two-branches', [
        node('TrigA', 'trigger', [0, 0]),
        node('TrigB', 'trigger', [0, 100]),
        node('Own', 'set', [200, 100]),
        node('Shared', 'set', [400, 50]),
      ], [
        conn('TrigA', 0, 'Shared', 0), conn('TrigB', 0, 'Own', 0), conn('Own', 0, 'Shared', 0),
      ], 'TrigA');
      const reach = alternativeEntryReach(compile(twoBranches));
      expect([...reach].sort()).toEqual([['Own', 'TrigB'], ['TrigB', 'TrigB']]);
      // `Shared` is fed by the start node too, so it is not excused.
      expect(reach.has('Shared')).toBe(false);
    });
  });

  describe('proper completion', () => {
    it('a balanced diamond reports no stranding, and every arrival bound proves', { timeout: CASE_TIMEOUT_MS }, async () => {
      const compiled = compile(diamond);
      const report = await verifyCompiled(compiled, { ...base, properties: ['proper-completion'] });
      const checks = checksOf(report, 'proper-completion');
      const readyPlaces = compiled.joinReadyPlaces.flatMap((j) => j.places).length;
      // Two per join-input ready place (the bound and the quiescence query) plus one per edge.
      expect(checks.length).toBe(2 * readyPlaces + compiled.edgeDataPlaces.length);
      expect(checks.some((c) => c.verdict === 'violated'), digest(report)).toBe(false);

      // The arrival bound is the half of the family that closes; the quiescence half is
      // measured in docs/verification.md and is `unknown` on this net at any timeout.
      const bounds = checks.filter((c) => c.query.property === 'place-bound');
      expect(bounds).toHaveLength(readyPlaces);
      expect(bounds.every((c) => c.verdict === 'proven'), digest(report)).toBe(true);
      // A join slot is not the arrival-count query of divergence #8: every arm consumes the
      // slot and only X_start / X_skip refund it, so the bound holds by construction and the
      // check says which of the two questions it is.
      expect(bounds[0]!.name).toContain('keeps its join slot discipline');
      expect(bounds[0]!.explanation).toContain('by construction');
      expect(bounds[0]!.explanation).toContain('neither a proof that nothing strands nor the arrival-order query of divergence #8');

      // Declared sinks are the two designed terminal markings, and nothing else (VER-002).
      const quiescence = checks.filter((c) => c.query.property === 'joined-or-dead-lettered');
      expect(quiescence.length).toBe(readyPlaces + compiled.edgeDataPlaces.length);
      expect([...quiescence[0]!.query.sinks].sort()).toEqual(['_halted', '_pause']);
    });

    it('the OR-round bound is the only arrival query that *could* fail — and it does not close', { timeout: CASE_TIMEOUT_MS }, async () => {
      // `multiProducer`: two producers into one input of a direct-form consumer, so `C`
      // aggregates a round of 2 with no slot token at all (README "OR-inputs"). This is the
      // form `docs/divergences.md` row #8 is about, and the only one where `placeBound` has
      // a reachable violation — the join slot's is unfalsifiable by construction (above).
      const compiled = compile(multiProducer);
      expect(compiled.netMap.node('C').form).toBe('or');
      const report = await verifyCompiled(compiled, { ...base, properties: ['proper-completion'] });
      const bound = checksOf(report, 'proper-completion').find((c) => c.query.property === 'place-bound')!;
      expect(bound.name).toBe('C input 0 queues at most 2 arrivals per round');
      // The measured limit (docs/verification.md): `unknown` at 5 s here and still `unknown`
      // at 30 s, on the smallest OR shape a compiled workflow can have. So the arrival-bound
      // half of proper completion closes exactly where it cannot fail. If this ever becomes
      // `proven` or `violated`, re-measure the doc and move the pin.
      expect(
        bound.verdict,
        `the OR-round arrival bound now answers something; re-measure docs/verification.md\n${digest(report)}`,
      ).toBe('unknown');
    });

    it('the join-input query does not close — the measured limit, on a net with a stranding and on one without', { timeout: CASE_TIMEOUT_MS }, async () => {
      for (const workflow of [diamond, unbalancedJoin]) {
        const report = await verifyCompiled(compile(workflow), { ...base, properties: ['proper-completion'] });
        const joins = checksOf(report, 'proper-completion')
          .filter((c) => c.query.property === 'joined-or-dead-lettered' && c.subject.kind === 'join-input');
        expect(joins.length).toBeGreaterThan(0);
        for (const check of joins) {
          expect(
            check.verdict,
            'the join-input quiescence query answered something other than `unknown`; re-measure ' +
            `docs/verification.md and move this pin\n${digest(report)}`,
          ).toBe('unknown');
        }
      }
    });

    it('a violation whose witness is a paused run is not a finding, and carries a node path', { timeout: CASE_TIMEOUT_MS }, async () => {
      // Every node's X_run offers the waiting / stopped outcomes, so on any fan-out there is
      // a quiescent marking holding `_pause` and an unconsumed sibling arrival. That is the
      // designed pause the marking codec writes back (ADR 0005), not a stranding — and
      // `joinedOrDeadLettered` ignores the declared sinks (NU-040 AC4), so it cannot be
      // excluded by declaring them. `verify()` downgrades such a violation to `unknown`.
      const report = await verify(fanOut, { ...base, timeoutMs: 20_000, properties: ['proper-completion'] });
      const witnessed = checksOf(report, 'proper-completion').filter((c) => c.counterexample !== null);
      expect(witnessed.length, digest(report)).toBeGreaterThan(0);
      const names = new Set(compile(fanOut).netMap.nodes.map((g) => g.node));
      for (const check of witnessed) {
        expect(check.verdict, check.name).toBe('unknown');
        expect(check.reason).toMatch(/NU-040 AC4/);
        const cex = check.counterexample!;
        expect(cex.stuckMarking.some((p) => p.role === 'pause')).toBe(true);
        // The witness is a node path, and every step names a node of this workflow.
        expect(cex.nodePath.length).toBeGreaterThan(0);
        for (const n of cex.nodePath) expect(names, `'${n}' is not a node`).toContain(n);
        expect(cex.ordered, 'the abstract replay confirmed a firing sequence').toBe(true);
      }
      // A downgraded witness is not a finding: the run stays clean.
      expect(report.ok).toBe(true);
      expect(report.counts.violated).toBe(0);
    });

    it('the stranding the unbalanced join has is real, and is what the query would have to find', () => {
      // Not a solver assertion: the shape itself. Input 0 has two producers and input 1 one,
      // so the join's slot discipline leaves the second arrival on ready_0 for good.
      const compiled = compile(unbalancedJoin, { budget: 4 });
      expect(compiled.effectiveBudget).toBe(1);
      expect(compiled.budgetRestriction?.reason).toBe('multi-producer-input');
      expect(compiled.budgetRestriction?.detail).toContain('M.0 has 2 producers');
      expect(compiled.netMap.node('M').form).toBe('join');
    });
  });

  describe('the measurement sample (docs/verification.md)', () => {
    it('the [live] dead-node sample is a node the start node can reach', () => {
      // `measure.ts` labels one dead-nodes query `[live]`. Taking the last node in canvas
      // order picks `OrphanChild` here, which is dead — so the doc's two `[live]` rows for
      // the orphan size were a deadness proof under a liveness label.
      const compiled = compile(orphanBranch);
      const live = liveSampleNode(compiled.netMap)!;
      expect(live.node).toBe('A');
      expect(live.reachable).toBe(true);
      const last = compiled.netMap.nodes[compiled.netMap.nodes.length - 1]!;
      expect(last.node).toBe('OrphanChild');
      expect(last.reachable).toBe(false);
    });
  });

  describe('the whole report', () => {
    it('carries the net size, the solver, the invariants and the compiler diagnostics', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(linear, { ...base, properties: ['budget'] });
      expect(report.workflow).toBe('linear');
      expect(report.structuralHash).toMatch(/^[0-9a-f]{64}$/);
      expect(report.net.places).toBeGreaterThan(0);
      expect(report.net.flatTransitions).toBeGreaterThanOrEqual(report.net.transitions);
      expect(report.solver.available).toBe(true);
      expect(report.solver.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.counts.proven + report.counts.violated + report.counts.unknown).toBe(report.checks.length);
      expect(report.properties).toEqual(['budget']);
      expect(report.timeoutMs).toBe(TEST_TIMEOUT_MS);
    });

    it('a k-safety restriction is reported, and the budget it verifies is the effective one', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(unbalancedJoin, { ...base, budget: 4, properties: ['budget'] });
      expect(report.requestedBudget).toBe(4);
      expect(report.budget).toBe(1);
      expect(report.budgetRestriction?.reason).toBe('multi-producer-input');
      expect(report.checks.find((c) => c.subject.kind === 'place')!.name).toBe('at most 1 node in flight');
    });

    it('runs no query and reports nothing when no property is selected', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(linear, { ...base, properties: [] });
      expect(report.checks).toEqual([]);
      expect(report.ok).toBe(true);
      // The invariant summary is still filled: it comes from the pipeline, not from z3.
      expect(report.invariants.encoded).toBeGreaterThan(0);
    });
  });
});
