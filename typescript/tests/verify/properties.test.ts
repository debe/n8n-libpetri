/**
 * The six property families against the nets `compile()` actually produces.
 *
 * Each family gets a fixture where the desirable property holds and one where it does not.
 * Since M5 the primary route is the solver-free state-class graph (`state-class.test.ts`
 * pins that route on its own, with no solver at all); this file is about the families as
 * `verify()` reports them, the polarity rules that survive whichever route answered, and the
 * SMT **fallback** — which is only reached where the graph truncates.
 *
 * The limit that stays a limit, and is asserted so it cannot go stale:
 *
 * - **liveness is not provable by either route.** `unreachable({X/running})` *proven* is a
 *   verdict — the node is dead — and its negation is not: both routes explore a
 *   priority-blind, value-blind abstraction in which every `xor` branch of a router is
 *   available whatever the data (VER-004 AC2/AC3). The graph now answers the reachability
 *   question in milliseconds where z3 used to time out, and the answer is *still* `unknown`,
 *   which is the point: the limit is the encoding's, not the solver's.
 */
import { flatten } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import {
  conn, diamond, fanOut, linear, loopOverItems, multiProducer, node, switch20, twoTriggers, workflow,
} from '../fixtures/workflows.js';
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

    it('the two-phase semiflow _budget + sum(running + routed) = k is among the invariants', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, { ...base, budget: 2, properties: ['budget'] });
      const semiflow = report.invariants.budgetSemiflow;
      expect(semiflow, digest(report)).not.toBeNull();
      expect(semiflow).toMatch(/_budget/);
      expect(semiflow).toMatch(/= 2$/);
      for (const g of compile(diamond, { budget: 2 }).netMap.nodes) {
        expect(semiflow, `${g.node} is not in the semiflow`).toContain(g.running.name);
        // The in-flight place: `X/routed` for a node that routes inside `X_run`, `X/ok_o`
        // for one above `SPLIT_ROUTING_ABOVE` — where the enumeration returns one law per
        // output rather than one folded law.
        const inFlight = g.routed?.name ?? g.outputs[0]!.ok!.name;
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

    it('a reachable node is `unknown`, never `proven`: reachability is not a liveness proof (VER-004)', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(orphanBranch, { ...base, properties: ['dead-nodes'] });
      const checks = checksOf(report, 'dead-nodes');
      expect(checks.some((c) => c.verdict === 'proven'), `no dead-nodes check may be 'proven'\n${digest(report)}`)
        .toBe(false);
      const live = checks.filter((c) => c.query.verdict === 'violated');
      expect(live.length, `the route found no reachable node at all; this case would be vacuous\n${digest(report)}`)
        .toBeGreaterThan(0);
      for (const check of live) {
        expect(check.verdict, check.name).toBe('unknown');
        expect(check.reason).toMatch(/VER-004/);
        expect(check.explanation).toContain('not a proof');
      }
      // M4's measured limit was that this question did not *close* behind a join: `Merge` on
      // the diamond was `unknown` at 30 s because Spacer could not find the witness. The
      // graph finds it immediately — and the verdict is `unknown` all the same, because the
      // reason it is `unknown` was never the solver. If this ever becomes `proven`, the
      // polarity rule of ADR 0007 §5 has been broken.
      const deep = await verify(diamond, { ...base, properties: ['dead-nodes'] });
      const merge = nodeCheck(checksOf(deep, 'dead-nodes'), 'Merge');
      expect(merge.verdict, `a reached node must never be 'proven' live\n${digest(deep)}`).toBe('unknown');
      expect(merge.query.verdict).toBe('violated');
      expect(merge.query.route).toBe('state-class-graph');
      expect(merge.reason).toMatch(/VER-004/);
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
      // One whole-net row, two per join-input ready place (the bound and the quiescence
      // question) and one per edge.
      expect(checks.length).toBe(1 + 2 * readyPlaces + compiled.edgeDataPlaces.length);
      expect(checks.some((c) => c.verdict === 'violated'), digest(report)).toBe(false);
      expect(checks.every((c) => c.verdict === 'proven'), digest(report)).toBe(true);

      const bounds = checks.filter((c) => c.query.property === 'place-bound');
      expect(bounds).toHaveLength(readyPlaces);
      // A join slot is not the arrival-count query of divergence #8: every arm consumes the
      // slot and only X_start / X_skip refund it, so the bound holds by construction and the
      // check says which of the two questions it is.
      expect(bounds[0]!.name).toContain('keeps its join slot discipline');
      expect(bounds[0]!.explanation).toContain('by construction');

      // The question is the VER-002 one — quiescent and something outside the declared
      // terminals is still marked — and the sinks it records are the structural rest set,
      // not M4's two-place declaration.
      const quiescence = checks.filter((c) => c.query.property === 'deadlock-free');
      expect(quiescence.length).toBe(1 + readyPlaces + compiled.edgeDataPlaces.length);
      const sinks = quiescence[0]!.query.sinks;
      expect(sinks).toContain('_pause');
      expect(sinks).toContain('_halt'); // never consumed: the halted run's terminal marker
      expect(sinks.some((p) => p.endsWith('/idle'))).toBe(true);
      expect(sinks.some((p) => p.endsWith('/done'))).toBe(true);
      expect(sinks.some((p) => p.endsWith('/ready_0'))).toBe(false);
    });

    it('the OR-round bound is the arrival query that *could* fail — and the graph decides it', { timeout: CASE_TIMEOUT_MS }, async () => {
      // `multiProducer`: two producers into one input of a direct-form consumer, so `C`
      // aggregates a round of 2 with no slot token at all (README "OR-inputs"). This is the
      // form `docs/divergences.md` row #8 is about, and the only one where `placeBound` has
      // a reachable violation — the join slot's is unfalsifiable by construction (above).
      //
      // M4 measured this `unknown` at 30 s on the smallest OR shape there is, so the family
      // had no working detector for the arrival-count class. The graph decides it exactly.
      const compiled = compile(multiProducer);
      expect(compiled.netMap.node('C').form).toBe('or');
      const report = await verifyCompiled(compiled, { ...base, properties: ['proper-completion'] });
      const bound = checksOf(report, 'proper-completion').find((c) => c.query.property === 'place-bound')!;
      expect(bound.name).toBe('C input 0 queues at most 2 arrivals per round');
      expect(bound.verdict, digest(report)).toBe('proven');
      expect(bound.query.route).toBe('state-class-graph');
    });

    it('the join-input question closes both ways — proven on the balanced net, violated on the stranding', { timeout: CASE_TIMEOUT_MS }, async () => {
      // The headline reversal. M4 measured this `unknown` at 30 s, 60 s and 600 s on *both*
      // fixtures — on the one that strands and on the one that does not — which is what made
      // the project's most valuable claim undeliverable.
      const clean = await verifyCompiled(compile(diamond), { ...base, properties: ['proper-completion'] });
      const cleanJoins = checksOf(clean, 'proper-completion')
        .filter((c) => c.subject.kind === 'join-input' && c.name.includes('always completes'));
      expect(cleanJoins.length).toBeGreaterThan(0);
      for (const check of cleanJoins) expect(check.verdict, digest(clean)).toBe('proven');

      const broken = await verifyCompiled(compile(unbalancedJoin), { ...base, properties: ['proper-completion'] });
      const brokenJoins = checksOf(broken, 'proper-completion')
        .filter((c) => c.subject.kind === 'join-input' && c.name.includes('always completes'));
      expect(brokenJoins.some((c) => c.verdict === 'violated'), digest(broken)).toBe(true);
      expect(broken.ok).toBe(false);
      const finding = brokenJoins.find((c) => c.verdict === 'violated')!;
      expect(finding.counterexample!.stuckMarking.some((p) => p.node === 'M' && p.role === 'ready')).toBe(true);
    });

    it('a paused run is classified, not reported: a fan-out is clean', { timeout: CASE_TIMEOUT_MS }, async () => {
      // Every node's X_run offers the waiting / stopped outcomes, so on any fan-out there is
      // a quiescent marking holding `_pause` and an unconsumed sibling arrival. That is the
      // designed pause the marking codec writes back (ADR 0005), not a stranding. M4 got
      // three `violated` witnesses here and had to downgrade each to `unknown`, because
      // `joinedOrDeadLettered` ignores declared sinks (NU-040 AC4). The graph classifies the
      // class instead, so the same workflow is simply `proven`.
      const report = await verify(fanOut, { ...base, properties: ['proper-completion'] });
      const checks = checksOf(report, 'proper-completion');
      expect(checks.every((c) => c.verdict === 'proven'), digest(report)).toBe(true);
      expect(checks.every((c) => c.counterexample === null)).toBe(true);
      expect(report.stateSpace.terminal, 'the paused markings are there — they are just not findings')
        .toBeGreaterThan(0);
      expect(report.ok).toBe(true);
      expect(report.counts.unknown).toBe(0);
    });

    it('a truncated cyclic graph answers with its own bound, and does not spend a timeout on a refuted query', { timeout: CASE_TIMEOUT_MS }, async () => {
      // The fallback for this family is one whole-net `deadlockFree` with the structural rest
      // set as sinks — and on this net the graph has already exhibited a quiescent marking
      // outside that sink set, so the query is false here and its `proven` (the only
      // direction it could add) cannot come back. It is therefore not asked, and the row
      // lands on the graph's own `bounded` prefix with a reason carrying both halves.
      const report = await verify(loopOverItems, {
        ...base, timeoutMs: 4_000, maxClasses: 500, properties: ['proper-completion'],
      });
      const whole = checksOf(report, 'proper-completion').find((c) => c.subject.kind === 'net')!;
      expect(whole.verdict, digest(report)).toBe('bounded');
      expect(whole.query.property).toBe('deadlock-free');
      expect(whole.query.route).not.toBe('smt');
      expect(whole.reason).toMatch(/500-class cap/);
      expect(whole.reason).toMatch(/deadlockFree fallback \(VER-002, structural rest set as sinks\) was not asked/);
      expect(whole.reason).toMatch(/can never return proven/);
      expect(whole.reason).toMatch(/not a proof/);
      // Nothing borrows a proof from the truncated prefix: every row the *graph* decides is
      // `bounded`. The one row the solver still closes is the structural join-slot bound —
      // a `placeBound`, not a reachability question, so it is sound on a truncated graph.
      for (const c of checksOf(report, 'proper-completion')) {
        if (c.query.route === 'smt') continue;
        expect(c.verdict, `${c.name}: ${digest(report)}`).toBe('bounded');
      }
      expect(checksOf(report, 'proper-completion')
        .filter((c) => c.verdict === 'proven')
        .map((c) => c.subject.kind), digest(report)).toEqual(['join-input']);
    });

    it('an acyclic workflow whose graph truncates has nothing to bound, and stays unknown — with the query really asked', { timeout: CASE_TIMEOUT_MS }, async () => {
      // The other truncation shape (NU-053: independent parallelism, no partial-order
      // reduction). There is nothing to count, so no bounded verdict is available and the
      // honest answer is `unknown` — the row must never borrow the cyclic case's bound. It is
      // also the one fixture where the fallback is a real question: every quiescent class the
      // graph found is inside the rest set, so `deadlockFree` is not refuted and z3 is asked.
      const report = await verify(switch20, {
        ...base, timeoutMs: 2_000, maxClasses: 500, properties: ['proper-completion'],
      });
      expect(report.stateSpace.truncation).toBe('parallelism');
      expect(report.stateSpace.boundedCyclicRuns).toBeNull();
      expect(report.stateSpace.loopSteps).toBe(0);
      const whole = checksOf(report, 'proper-completion').find((c) => c.subject.kind === 'net')!;
      expect(whole.verdict, digest(report)).toBe('unknown');
      expect(whole.query.route).toBe('smt');
      expect(report.counts.bounded).toBe(0);
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
      const { proven, violated, bounded, unknown } = report.counts;
      expect(proven + violated + bounded + unknown).toBe(report.checks.length);
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
      // And it does not pay the P-invariant pipeline either: since M5 that runs only for the
      // budget family's semiflow, which is the one claim the graph cannot make. That is what
      // keeps a 41-node workflow verifiable at all — the pipeline is the wall, not z3.
      expect(report.invariants.encoded).toBe(0);
      const budget = await verify(linear, { ...base, properties: ['budget'] });
      expect(budget.invariants.encoded).toBeGreaterThan(0);
    });

    it('carries the solver-free route\'s own numbers, so a truncation is visible in the JSON', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, { ...base, properties: ['proper-completion'] });
      // Re-measured with the collapsed outcome (ADR 0004): 393 with X/ok + X_route per node.
      expect(report.stateSpace.classes).toBe(330);
      expect(report.stateSpace.complete).toBe(true);
      expect(report.stateSpace.maxClasses).toBe(200_000);
      expect(report.stateSpace.strandedPlaces).toBe(0);
      expect(report.stateSpace.error).toBeNull();
    });
  });
});
