/**
 * The solver-free route (VER-010) — the primary decision procedure since M5.
 *
 * **No `describeZ3` here, on purpose.** The whole point of the route is that it needs no
 * solver: every assertion in this file runs with z3 absent, and the fact that it does is
 * itself pinned (`decides proper completion with no solver at all`). The SMT fallback has
 * its own coverage in `properties.test.ts`.
 *
 * What is pinned, and why each one has to be:
 *
 * - **every measured verdict** of `docs/verification.md`'s solver-free table, class counts
 *   included. A change in libpetri's graph, in the compiler's gadget or in the rest set
 *   moves those numbers, and the doc has to be re-measured rather than quietly going stale.
 * - **the pause filter.** A workflow that can pause — which is every workflow, since every
 *   `X_run` offers the `waiting` / `stopped` outcomes — must be `proven`, and the same shape
 *   with a real stranding must be `violated`. That pair is the whole difference between this
 *   route and M4's, which could only downgrade a paused witness to `unknown`.
 * - **truncation reporting.** A truncated graph must never read as a pass: `proven` must be
 *   impossible, the verdict must be `unknown`, and the reason must name the cap and which of
 *   NU-053's two shapes caused it.
 * - **a false `proven` is impossible** for the cases the route cannot decide, which is the
 *   one failure mode that would make the whole surface worthless.
 */
import { StateClassGraph } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import {
  DEFAULT_MAX_CLASSES, HALT_REST_ROLES, PAUSE_REST_ROLES, REST_ROLES, StateSpace, TERMINAL_ROLES,
  effectiveMaxClasses, loopTransitions, markingStateOf, restRolesFor, terminalKindOf, verify,
} from '../../src/verify/index.js';
import type { PropertyCheck, VerificationReport } from '../../src/verify/index.js';
import {
  chooseBranch, diamond, fanOut, ifBothOutputs, linear, loopOverItems, multiProducer, switch20,
} from '../fixtures/workflows.js';
import {
  CASE_TIMEOUT_MS, cyclicStranding, digest, generateChain, generateFanOut, retryFour, unbalancedJoin,
} from './support.js';

/**
 * Every check the proper-completion family produced, and the one whole-net row that is the
 * headline: *can this workflow strand a branch?*
 */
function completion(report: VerificationReport): { whole: PropertyCheck; all: PropertyCheck[] } {
  const all = report.checks.filter((c) => c.property === 'proper-completion');
  const whole = all.find((c) => c.subject.kind === 'net');
  if (whole === undefined) throw new Error(`no whole-net completion check\n${digest(report)}`);
  return { whole, all };
}

/**
 * Proper completion only, with the solver *fallback* effectively disabled (1 ms): every
 * verdict this file asserts has to come from the graph, so a slow or missing z3 can never
 * change one.
 */
async function completionOf(
  workflow: Parameters<typeof verify>[0], maxClasses?: number,
): Promise<VerificationReport> {
  return verify(workflow, {
    properties: ['proper-completion'],
    timeoutMs: 1,
    ...(maxClasses === undefined ? {} : { maxClasses }),
  });
}

describe('the solver-free route (VER-010)', () => {
  describe('the measured table (docs/verification.md)', () => {
    // The class counts are exact: the graph is deterministic, so a moved number means the
    // net changed and the doc is stale. `npx tsx tests/verify/measure-graph.ts` re-measures.
    const cases: ReadonlyArray<readonly [string, Parameters<typeof verify>[0], number, 'proven' | 'violated']> = [
      // Counts before the routed outcome was collapsed into `X_run` (ADR 0004), for the
      // record: 50, 393, 99, 245, 108, 889, 2048, 6151. Removing one place and one
      // transition per node removed a class per activation, most on the join-heavy shapes.
      ['linear', linear, 43, 'proven'],
      ['diamond', diamond, 330, 'proven'],
      ['fanOut', fanOut, 90, 'proven'],
      ['multiProducer', multiProducer, 218, 'proven'],
      ['chooseBranch', chooseBranch, 77, 'proven'],
      ['ifBothOutputs', ifBothOutputs, 732, 'violated'],
      ['chain40 (41 nodes)', generateChain(40), 1967, 'proven'],
      ['wide8 (9 nodes)', generateFanOut(8), 5894, 'proven'],
    ];

    for (const [label, workflow, classes, verdict] of cases) {
      it(`${label}: ${classes} classes, ${verdict}`, { timeout: CASE_TIMEOUT_MS }, async () => {
        const report = await completionOf(workflow);
        expect(report.stateSpace.classes, `class count moved; re-measure docs/verification.md\n${digest(report)}`)
          .toBe(classes);
        expect(report.stateSpace.complete).toBe(true);
        expect(report.stateSpace.truncation).toBeNull();
        const { whole } = completion(report);
        expect(whole.verdict, digest(report)).toBe(verdict);
        expect(whole.query.route).toBe('state-class-graph');
        // Every workflow has designed terminals — a Wait node or a destination stop is an
        // outcome of every X_run — and none of them is a finding.
        expect(report.stateSpace.terminal).toBeGreaterThan(0);
      });
    }

    // Every row above is **k = 1**, which is the budget `verify()` defaults to and the axis
    // the doc's table fixes. The class count grows sharply with the budget — a second unit
    // lets independent branches interleave — so the k = 2 counts are pinned too: "41 nodes
    // closes in 106 ms" is a statement about k = 1 and must not be read as a general ceiling.
    // Before the collapse: 1551 and 31448.
    const atBudgetTwo: ReadonlyArray<readonly [string, Parameters<typeof verify>[0], number]> = [
      ['diamond', diamond, 1094],
      ['chain40 (41 nodes)', generateChain(40), 29767],
    ];
    for (const [label, workflow, classes] of atBudgetTwo) {
      it(`${label} at k = 2: ${classes} classes`, { timeout: CASE_TIMEOUT_MS }, async () => {
        const report = await verify(workflow, { properties: ['proper-completion'], timeoutMs: 1, budget: 2 });
        expect(report.budget).toBe(2);
        expect(report.stateSpace.classes, `k = 2 class count moved; re-measure docs/verification.md\n${digest(report)}`)
          .toBe(classes);
        expect(report.stateSpace.complete).toBe(true);
        expect(completion(report).whole.verdict, digest(report)).toBe('proven');
      });
    }

    it('chain40 is past the ~25-node ceiling M4 measured, and closes in well under a second', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(generateChain(40));
      expect(compile(generateChain(40)).netMap.nodes).toHaveLength(41);
      expect(report.stateSpace.elapsedMs).toBeLessThan(5_000);
      expect(completion(report).whole.verdict).toBe('proven');
    });
  });

  describe('the stranding it exists to catch (divergence #2)', () => {
    it('ifBothOutputs strands Merge input 0, decoded into node terms with a firing path', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(ifBothOutputs);
      const { whole, all } = completion(report);
      expect(whole.verdict, digest(report)).toBe('violated');
      expect(report.ok).toBe(false);

      const cex = whole.counterexample;
      expect(cex, 'a violation must carry a witness').not.toBeNull();
      // The stranded token sits on the join's ready place — one place downstream of the edge,
      // because the arm drains the edge as soon as the slot is free (ADR 0003).
      const stranded = cex!.stuckMarking.filter((p) => p.role !== null && !REST_ROLES.has(p.role));
      expect(stranded.map((p) => p.place).sort()).toEqual(['id:Merge/hasdata', 'id:Merge/ready_0']);
      expect(stranded.every((p) => p.node === 'Merge')).toBe(true);

      // The path is a real firing sequence of the net, not an order-free derivation set.
      expect(cex!.ordered).toBe(true);
      const names = new Set(compile(ifBothOutputs).netMap.nodes.map((g) => g.node));
      expect(cex!.nodePath.length).toBeGreaterThan(0);
      for (const n of cex!.nodePath) expect(names, `'${n}' is not a node`).toContain(n);
      expect(cex!.steps.every((s) => s.node === null || names.has(s.node))).toBe(true);

      // And the per-input row names the input, so a reader gets "Merge input 0", not a place.
      const input = all.find((c) => c.subject.kind === 'join-input' && c.subject.node === 'Merge'
        && c.subject.inputIndex === 0 && c.name.includes('always completes'));
      expect(input?.verdict, digest(report)).toBe('violated');
    });

    it('the unbalanced join strands too — the same class of defect, a different shape', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(unbalancedJoin);
      const { whole } = completion(report);
      expect(whole.verdict, digest(report)).toBe('violated');
      const stranded = whole.counterexample!.stuckMarking.filter((p) => p.role !== null && !REST_ROLES.has(p.role));
      expect(stranded.some((p) => p.node === 'M' && p.role === 'ready')).toBe(true);
    });
  });

  describe('the pause filter', () => {
    it('a workflow that can pause is proven; the same shape with a real stranding is violated', { timeout: CASE_TIMEOUT_MS }, async () => {
      // Both workflows have quiescent markings holding `_pause` with an unconsumed arrival
      // still on an `in` / `ready` place — the designed terminal the codec writes back. M4's
      // query could not tell that from a stranding and downgraded both to `unknown`.
      const clean = await completionOf(diamond);
      expect(clean.stateSpace.terminal).toBeGreaterThan(0);
      expect(completion(clean).whole.verdict, digest(clean)).toBe('proven');
      expect(clean.checks.every((c) => c.verdict !== 'violated')).toBe(true);

      const broken = await completionOf(ifBothOutputs);
      expect(broken.stateSpace.terminal).toBeGreaterThan(0);
      expect(completion(broken).whole.verdict, digest(broken)).toBe('violated');
    });

    it('a fan-out is proven, where M4 got three `violated` witnesses it had to downgrade', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(fanOut);
      const { whole, all } = completion(report);
      expect(whole.verdict, digest(report)).toBe('proven');
      // The three edges M4 reported `violated` on with a `_pause` witness (ADR 0007 §3).
      const edges = all.filter((c) => c.subject.kind === 'edge');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      expect(edges.every((c) => c.verdict === 'proven'), digest(report)).toBe(true);
      expect(report.counts.unknown).toBe(0);
    });

    it('the rest sets are the documented ones, and each widening matches the codec mode of its terminal', () => {
      // The structural rest set: a token here is residue of a finished run.
      expect([...REST_ROLES].sort()).toEqual([
        'budget', 'done', 'free', 'halt', 'idle', 'nil', 'pause', 'ran', 'skipped', 'stopped', 'tries', 'waiting',
      ]);
      expect([...TERMINAL_ROLES].sort()).toEqual(['halt', 'pause', 'stopped', 'waiting']);
      // A *paused* class is encoded in codec mode `pause`, which pushes back the arrivals and
      // the retry unit and throws a CodecError on `X/in_empty` and on an OR input's edge
      // places. So the pause widening is exactly the four it writes back — no more.
      const pauseWidening = [...PAUSE_REST_ROLES].filter((r) => !REST_ROLES.has(r)).sort();
      expect(pauseWidening).toEqual(['hasdata', 'in-data', 'ready', 'retry']);
      // A *halted* class is encoded in mode `cancelled`, the one mode that legitimately sees
      // an undrained marking: it also handles the empty and the edge places, which a halt
      // stops draining (X_skip and the arms inhibit on _halt, not on _pause).
      const haltWidening = [...HALT_REST_ROLES].filter((r) => !PAUSE_REST_ROLES.has(r)).sort();
      expect(haltWidening).toEqual(['edge-data', 'edge-empty', 'in-empty']);
      // `_halt` is never consumed, so it *is* the halted terminal's marker and rests in
      // every one of the three sets; `ok` and `running` are pending work in all of them.
      for (const set of [REST_ROLES, PAUSE_REST_ROLES, HALT_REST_ROLES]) {
        expect(set.has('halt')).toBe(true);
        expect(set.has('ok')).toBe(false);
        expect(set.has('running')).toBe(false);
      }
      expect(restRolesFor('none')).toBe(REST_ROLES);
      expect(restRolesFor('pause')).toBe(PAUSE_REST_ROLES);
      expect(restRolesFor('halt')).toBe(HALT_REST_ROLES);
      // A marking holding both is encoded on the halt path, so the halt set classifies it.
      expect(terminalKindOf(['pause', 'halt'])).toBe('halt');
      expect(terminalKindOf(['waiting', 'idle'])).toBe('pause');
      expect(terminalKindOf(['idle', 'done', null])).toBe('none');
    });

    it('an `in_empty` at rest is residue only under a halt, because only mode `cancelled` accepts it', () => {
      // The finding this pins: `in-empty` was in the single widened set, justified as "the
      // codec's write-back surface" — but `encodeMarking` in mode `pause` puts `g.inEmpty` in
      // its inFlight list and *throws* on it. Under a halt (mode `cancelled`) it is dropped
      // with a diagnostic, which is right for a run that is over. Structurally the split is
      // exact: X_skip inhibits on _halt and not on _pause, so an unconsumed empty
      // can only come to rest under a halt in the first place.
      expect(PAUSE_REST_ROLES.has('in-empty')).toBe(false);
      expect(HALT_REST_ROLES.has('in-empty')).toBe(true);
      expect(PAUSE_REST_ROLES.has('edge-data')).toBe(false);
      expect(HALT_REST_ROLES.has('edge-data')).toBe(true);
    });
  });

  describe('truncation is the honest limit, never a pass', () => {
    it('a cyclic workflow truncates and says so — bounded, with the cause, the cap and the bound', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(loopOverItems, 2_000);
      expect(report.stateSpace.complete).toBe(false);
      expect(report.stateSpace.truncation).toBe('cycle');
      expect(report.stateSpace.maxClasses).toBe(2_000);
      const { whole, all } = completion(report);
      // Not `proven` — the state space is unbounded — and not `unknown` either, because the
      // explored prefix closes a whole number of loop iterations exactly (item D).
      expect(whole.verdict, digest(report)).toBe('bounded');
      expect(whole.reason).toMatch(/2000-class cap/);
      expect(whole.reason).toMatch(/cycle/);
      expect(whole.reason).toMatch(/not a proof/);
      expect(whole.reason).toMatch(/cyclic nodes run at most \d+ time/);
      // Nothing in the family may be `proven` off a truncated graph.
      expect(all.some((c) => c.verdict === 'proven' && c.query.route === 'state-class-graph'), digest(report))
        .toBe(false);
    });

    it('heavy independent parallelism truncates with the other cause, and still never proves', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(switch20, 2_000);
      expect(report.stateSpace.complete).toBe(false);
      expect(report.stateSpace.truncation).toBe('parallelism');
      const { whole, all } = completion(report);
      expect(whole.verdict, digest(report)).toBe('unknown');
      expect(whole.reason).toMatch(/partial-order reduction/);
      expect(whole.reason).toMatch(/maxClasses/);
      expect(all.some((c) => c.verdict === 'proven' && c.query.route === 'state-class-graph'), digest(report))
        .toBe(false);
    });

    it('a false `proven` is impossible on a truncated graph, at any cap', { timeout: CASE_TIMEOUT_MS }, async () => {
      // The two shapes that cannot close, at three caps each: the verdict must stay
      // `unknown` however much of the state space was enumerated. This is the assertion that
      // makes the whole surface trustworthy — an `unknown` is a limit, a `proven` is a claim.
      for (const cap of [50, 500, 5_000]) {
        for (const workflow of [loopOverItems, switch20]) {
          const report = await completionOf(workflow, cap);
          expect(report.stateSpace.complete).toBe(false);
          const { whole } = completion(report);
          expect(whole.verdict, `cap=${cap}\n${digest(report)}`).not.toBe('proven');
        }
      }
    });

    it('a cyclic workflow that really strands is `violated`, not `bounded` — truncation loses the proof, not the finding', { timeout: CASE_TIMEOUT_MS }, async () => {
      // The one direction that would make the bounded verdict dangerous: a stranding inside
      // the explored prefix must outrank the bound. A quiescent class of a truncated graph
      // is quiescent and reachable however the BFS ended, so it is a real finding.
      for (const cap of [2_000, 20_000]) {
        const report = await completionOf(cyclicStranding, cap);
        expect(report.stateSpace.complete, `cap=${cap}`).toBe(false);
        expect(report.stateSpace.truncation).toBe('cycle');
        const { whole } = completion(report);
        expect(whole.verdict, `cap=${cap}\n${digest(report)}`).toBe('violated');
        expect(whole.counterexample!.stuckMarking.some((p) => p.node === 'M' && p.role === 'ready')).toBe(true);
        expect(report.ok).toBe(false);
      }
    });

    it('the class cap is lowered to what the heap can hold, because an abort is not a verdict', () => {
      // A class cap bounds the class count; only this bounds the memory. Measured, a class
      // costs 4.4-12.4 kB of peak RSS across nets of 48 to 599 places (the cost is per class,
      // not per place), so 200 000 of them is up to ~2.5 GB — fine under this machine's
      // 4.4 GB heap limit, fatal under a 1 GB container's, where V8 aborts the process and
      // there is no exception to turn into a truncation.
      expect(effectiveMaxClasses(200_000, 8e9)).toBe(200_000);
      expect(effectiveMaxClasses(200_000, 4.4e9)).toBe(200_000);
      expect(effectiveMaxClasses(200_000, 1.17e9)).toBeLessThan(200_000);
      expect(effectiveMaxClasses(200_000, 1.17e9)).toBeGreaterThan(1_000);
      // A small request is never raised, and "off" stays off rather than becoming a 1-class run.
      expect(effectiveMaxClasses(500, 1e6)).toBeGreaterThanOrEqual(1);
      expect(effectiveMaxClasses(500, 8e9)).toBe(500);
      expect(effectiveMaxClasses(0, 8e9)).toBe(0);
    });

    it('the exploration is bounded by default, so the graph never runs unbounded', () => {
      expect(DEFAULT_MAX_CLASSES).toBe(200_000);
      const compiled = compile(loopOverItems);
      const space = StateSpace.explore(
        compiled.net, markingStateOf(compiled.initialMarking(null)), compiled.netMap, 1_000);
      expect(space.usable).toBe(true);
      expect(space.complete).toBe(false);
      // The cap is checked per expansion, so the class that trips it can carry its own
      // successors past the bound: what it promises is O(cap), not exactly cap.
      expect(space.classes).toBeLessThanOrEqual(1_000 + 8);
      expect(space.truncationCause({ hasCycle: true, independentBranches: false })).toBe('cycle');
      expect(space.truncationCause({ hasCycle: false, independentBranches: true })).toBe('parallelism');
      // Neither shape: the cap was simply set below what the workflow needs. Reporting
      // "independent parallel branches" for a workflow that has none sends a reader looking
      // for a fan-out that is not there.
      expect(space.truncationCause({ hasCycle: false, independentBranches: false })).toBe('cap');
    });

    it('`maxClasses: 0` turns the route off entirely, which is M4\'s surface — and says so', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(linear, 0);
      expect(report.stateSpace.complete).toBe(false);
      expect(report.checks.every((c) => c.query.route !== 'state-class-graph'), digest(report)).toBe(true);
      expect(completion(report).whole.verdict).toBe('unknown');
      // Not a limit of the workflow: the route was switched off, and the cause says that
      // rather than blaming NU-053's parallelism for a four-node chain.
      expect(report.stateSpace.truncation).toBe('off');
      expect(completion(report).whole.reason).toContain('turned off');
    });

    it('a cap set too low is reported as a cap, not as parallelism the workflow does not have', { timeout: CASE_TIMEOUT_MS }, async () => {
      // `linear` is Trigger -> A -> B -> C: no cycle, no branching node, 43 classes. At a
      // 10-class cap the old cause was `parallelism`, and every reason read "independent
      // parallel branches blow the class count up combinatorially" — about a chain.
      const report = await completionOf(linear, 10);
      expect(report.stateSpace.complete).toBe(false);
      expect(report.stateSpace.truncation).toBe('cap');
      const { whole } = completion(report);
      expect(whole.verdict).toBe('unknown');
      expect(whole.reason).toContain('the cap is simply below what this workflow needs');
      expect(whole.reason).not.toContain('partial-order reduction');
      expect(whole.reason).not.toContain('independent parallel branches');
    });
  });

  describe('the bounded verdict for a cyclic workflow (item D)', () => {
    // A cyclic workflow's reachable state space is unbounded, so `proven` is out of reach at
    // every cap — but the explored prefix closes a whole number of loop iterations exactly,
    // and saying so is sound. `bounded` is that verdict: never counted as a proof, failed by
    // `--strict`, and always carrying the number it is bounded by.

    it('loopOverItems is `bounded`, and the bound grows with the cap', { timeout: CASE_TIMEOUT_MS }, async () => {
      const bounds: number[] = [];
      for (const cap of [2_000, 20_000]) {
        const report = await completionOf(loopOverItems, cap);
        expect(report.stateSpace.complete).toBe(false);
        expect(report.stateSpace.truncation).toBe('cycle');
        expect(report.stateSpace.loopSteps, 'Loop and Body are the cyclic nodes').toBe(2);
        const k = report.stateSpace.boundedCyclicRuns;
        expect(k, `cap=${cap}\n${digest(report)}`).not.toBeNull();
        expect(k!).toBeGreaterThanOrEqual(1);
        bounds.push(k!);

        const { whole, all } = completion(report);
        expect(whole.verdict, digest(report)).toBe('bounded');
        expect(whole.query.route).toBe('state-class-graph');
        expect(whole.reason).toMatch(/not a proof/);
        expect(whole.reason).toContain(`at most ${k} time`);
        expect(whole.explanation).toMatch(/^Only within the explored cyclic-node-run bound/);
        // The whole family lands on the same verdict, and nothing in it is `proven`.
        expect(all.some((c) => c.verdict === 'proven'), digest(report)).toBe(false);
        expect(report.counts.proven).toBe(0);
        expect(report.counts.bounded).toBeGreaterThan(0);
        // A bound is not a finding: it must not fail an ordinary run.
        expect(report.ok).toBe(true);
      }
      // Raising the cap raises the bound rather than reaching a proof, which is exactly what
      // the reason string tells a reader to expect.
      expect(bounds[1]!).toBeGreaterThan(bounds[0]!);
    });

    it('the prefix the bound is certified over is a real prefix of the explored classes', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(loopOverItems, 2_000);
      const space = report.stateSpace;
      expect(space.expanded).toBeGreaterThan(0);
      expect(space.expanded).toBeLessThan(space.classes);
      // The closure argument (`state-class.ts`, `closedCyclicRuns`) is about classes the BFS
      // expanded; a complete graph expanded all of them and has nothing left to bound.
      const closed = await completionOf(diamond);
      expect(closed.stateSpace.complete).toBe(true);
      expect(closed.stateSpace.expanded).toBe(closed.stateSpace.classes);
      expect(closed.stateSpace.boundedCyclicRuns).toBeNull();
      expect(closed.counts.bounded).toBe(0);
    });

    it('an acyclic truncation has no iteration to count, and stays unknown', { timeout: CASE_TIMEOUT_MS }, async () => {
      // NU-053's other shape: independent parallel branches, no partial-order reduction.
      // There is no loop, so there is no sound bounded statement to make and the honest
      // answer is `unknown`. Borrowing the cyclic case's verdict here would be a fiction.
      const report = await completionOf(switch20, 2_000);
      expect(report.stateSpace.truncation).toBe('parallelism');
      expect(report.stateSpace.loopSteps).toBe(0);
      expect(report.stateSpace.boundedCyclicRuns).toBeNull();
      expect(completion(report).whole.verdict, digest(report)).toBe('unknown');
      expect(report.counts.bounded).toBe(0);
    });

    it('one loop iteration is the floor: a prefix that closes none of them says `unknown`', { timeout: CASE_TIMEOUT_MS }, async () => {
      // At a cap this small the BFS has not closed a single whole iteration, so "nothing goes
      // wrong in runs where the loop never runs" is all that could be said — which is not a
      // statement about the loop at all, and is refused.
      const report = await completionOf(loopOverItems, 30);
      expect(report.stateSpace.boundedCyclicRuns).toBeNull();
      expect(completion(report).whole.verdict, digest(report)).toBe('unknown');
    });

    it('libpetri discovers classes in BFS order, which is the assumption the prefix argument rests on', () => {
      // `closedCyclicRuns` takes the classes libpetri **expanded** to be a *prefix* of
      // `stateClasses()`. That follows from its exploration being a FIFO BFS that appends
      // each newly discovered class — nothing else in this repository would notice if that
      // changed upstream, and the bounded verdict would silently stop being sound, so it is
      // asserted directly against an independent BFS.
      const compiled = compile(loopOverItems);
      const graph = StateClassGraph.build(
        compiled.net, markingStateOf(compiled.initialMarking(null)), 3_000);
      expect(graph.isComplete()).toBe(false);
      const classes = graph.stateClasses();

      const distance = new Map([[graph.initialClass, 0]]);
      const queue = [graph.initialClass];
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const d = distance.get(current)!;
        for (const edges of graph.outgoingBranchEdges(current).values()) {
          for (const edge of edges) {
            if (distance.has(edge.target)) continue;
            distance.set(edge.target, d + 1);
            queue.push(edge.target);
          }
        }
      }
      expect(classes[0]).toBe(graph.initialClass);
      for (let i = 1; i < classes.length; i++) {
        const previous = distance.get(classes[i - 1]!);
        const current = distance.get(classes[i]!);
        // Every class is reachable through recorded edges, and never before its parent.
        expect(current, `class ${i} is not reachable through the recorded edges`).toBeDefined();
        expect(current!, `class ${i} was discovered out of BFS order`).toBeGreaterThanOrEqual(previous!);
      }

      // And the expanded prefix really is a prefix: nothing past it recorded an edge.
      const space = StateSpace.explore(
        compiled.net, markingStateOf(compiled.initialMarking(null)), compiled.netMap, 3_000,
        loopTransitions(compiled));
      expect(space.expandedClasses).toBeGreaterThan(0);
      expect(space.expandedClasses).toBeLessThan(space.classes);
      for (let i = space.expandedClasses; i < classes.length; i++) {
        expect(graph.outgoingBranchEdges(classes[i]!).size, `class ${i} is past the prefix`).toBe(0);
      }
    });

    it('`loopTransitions` counts the run of every cyclic node, and nothing else', () => {
      const compiled = compile(loopOverItems);
      const loops = loopTransitions(compiled);
      const named = [...loops].map((n) => compiled.netMap.transition(n)!);
      expect(named.every((t) => t.role === 'run')).toBe(true);
      expect(named.map((t) => t.node).sort()).toEqual(['Body', 'Loop']);
      // `After` is downstream of the loop's `done` output and is not on the cycle.
      expect(named.some((t) => t.node === 'After')).toBe(false);
      expect(loopTransitions(compile(diamond)).size, 'an acyclic workflow has no loop step').toBe(0);
    });

    it('`--strict` treats a bound as unproven, and a plain run does not fail on it', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await completionOf(loopOverItems, 2_000);
      expect(report.counts.bounded).toBeGreaterThan(0);
      // `ok` is about findings, so a bound leaves it true; the strict gate is the CLI's, and
      // it reads `counts.unknown + counts.bounded` (cli.ts).
      expect(report.ok).toBe(true);
      expect(report.counts.unknown + report.counts.bounded).toBeGreaterThan(0);
    });
  });

  describe('no solver at all', () => {
    it('decides proper completion with no z3 on PATH, and the report says the fallback did not run', { timeout: CASE_TIMEOUT_MS }, async () => {
      const saved = process.env.LIBPETRI_Z3;
      const savedPath = process.env.PATH;
      process.env.LIBPETRI_Z3 = '/nonexistent/definitely-not-a-z3-binary';
      process.env.PATH = '/nonexistent';
      try {
        const report = await verify(diamond, { properties: ['proper-completion'] });
        expect(report.solver.available).toBe(false);
        expect(completion(report).whole.verdict, digest(report)).toBe('proven');
        expect(report.checks.every((c) => c.query.route === 'state-class-graph')).toBe(true);
        expect(report.counts.unknown).toBe(0);
      } finally {
        if (saved === undefined) delete process.env.LIBPETRI_Z3;
        else process.env.LIBPETRI_Z3 = saved;
        process.env.PATH = savedPath;
      }
    });
  });

  describe('the timed part is really explored', () => {
    it('a delayed retry-wait fires in the graph: X/tries is drained and X_exhausted is reached', () => {
      // The one place a *timing* bug would produce a false `proven` rather than a slow run.
      // `X_retry_wait` is `delayed(waitBetweenTries)` while everything around it is
      // `immediate`, and immediate transitions are urgent — time cannot pass while one is
      // enabled. If the DBM ever stopped letting time advance in the classes where only the
      // retry wait is enabled, the whole retry subtree would silently vanish from the graph
      // and every property over it would be vacuously `proven`.
      const compiled = compile(retryFour);
      const space = StateSpace.explore(
        compiled.net, markingStateOf(compiled.initialMarking(null)), compiled.netMap);
      expect(space.complete).toBe(true);
      const gadget = compiled.netMap.node('A');
      // Seeded with maxTries - 1 = 3, and the graph reaches every count down to 0, so the
      // delayed transition fires as often as the seeding allows.
      expect(space.peak(gadget.tries!)).toBe(3);
      expect(space.everMarked(gadget.retry!)).toBe(true);
      // And the exhausted branch beyond it: `_halt` is only reachable through a node failure.
      expect(space.everMarked(compiled.netMap.shared.halt)).toBe(true);
    });
  });

  describe('the other families the graph decides', () => {
    it('dead nodes, the running mutex, the budget bound and mutual exclusion all route to the graph', { timeout: CASE_TIMEOUT_MS }, async () => {
      const report = await verify(diamond, {
        timeoutMs: 1, budget: 1, mutualExclusion: 'all-pairs',
        properties: ['budget', 'no-double-activation', 'dead-nodes', 'mutual-exclusion', 'proper-completion'],
      });
      const routed = report.checks.filter((c) => c.query.route === 'state-class-graph');
      // Everything but the budget semiflow, which is a P-invariant and not a reachability
      // question — the one claim the solver-free route cannot make.
      const structural = report.checks.filter((c) => c.query.route === 'structural');
      expect(structural.map((c) => c.name)).toEqual(['the two-phase budget semiflow holds']);
      expect(routed.length).toBe(report.checks.length - structural.length);
      expect(report.checks.filter((c) => c.query.route === 'smt')).toHaveLength(0);
    });

    it('mutual exclusion is violated at k = 2 and proven at k = 1, from the same one pass', { timeout: CASE_TIMEOUT_MS }, async () => {
      const one = await verify(fanOut, { timeoutMs: 1, budget: 1, mutualExclusion: 'all-pairs', properties: ['mutual-exclusion'] });
      expect(one.checks.every((c) => c.verdict === 'proven'), digest(one)).toBe(true);
      const two = await verify(fanOut, { timeoutMs: 1, budget: 2, mutualExclusion: [['A', 'B']], properties: ['mutual-exclusion'] });
      const check = two.checks[0]!;
      expect(check.verdict, digest(two)).toBe('violated');
      expect(check.counterexample!.stuckMarking.some((p) => p.role === 'running')).toBe(true);
      expect(check.counterexample!.ordered).toBe(true);
    });
  });
});
