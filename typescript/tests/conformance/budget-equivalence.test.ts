/**
 * The M3 exit criterion, as a test: **the data a workflow produces does not depend on k**.
 *
 * The differ (`differ.test.ts`) compares the net against n8n's own loop, which answers "is the
 * net right?". This file asks the other question, the one milestone M3 is actually gated on:
 * *does raising the budget change anything the user can read back?* Both legs here are the
 * `PetriScheduler` on the same fixture, so n8n's ordering artifacts cancel out and the only
 * thing left is the budget. A difference here is a defect by definition — the premise of the
 * whole milestone is that concurrency changes timing, not results — unless it is one of the
 * registered abandonments the register already names, and the only one that can appear is
 * `docs/divergences.md` #17: the net cannot un-start an action, so an activation in flight
 * when the execution halts finishes and is recorded where a k = 1 run never reached it.
 *
 * Why it is sound to expect equality at all: the compiler's k-safety check (README
 * "Concurrency budget and its safety condition", `src/compiler/compile.ts` `kSafety`) forces
 * k = 1 unless the workflow is acyclic with at most one producer per input index. Under that
 * condition every node fires at most once and its input on index *i* is exactly its unique
 * producer's output, so `runData` is determined by the graph, not by the schedule. This test
 * is what keeps that argument honest: it also pins which fixtures actually ran above k = 1
 * and which ones actually had two nodes in flight, so the equality cannot pass vacuously
 * because everything was quietly forced back to k = 1.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PetriScheduler } from '../../src/scheduler/index.js';
import { compareData, descendantsOf, runPetri, type EngineRun } from '../../src/conformance/index.js';
import { DIFFER_FIXTURES } from './differ-fixtures.js';

/** k = 1 plus the budgets M3 reports; 8 is above every fixture's width, so it is the ceiling. */
const BUDGETS = [2, 4, 8] as const;

/**
 * Fixtures the k-safety check forces back to k = 1: cyclic, or an input index with more than
 * one producer. Their equality across budgets is true by construction, so they are listed
 * rather than counted as evidence.
 */
const FORCED_TO_ONE = ['destinationStop', 'ifBothOutputs', 'loopOverItems', 'multiProducer', 'userCycle'];

/**
 * Fixtures that really put two or more actions in flight at once. The rest are structurally
 * sequential — a chain, a single retrying node, one trigger at a time — so no budget helps
 * them, which is a fact about the workflow and not about the engine.
 */
const OVERLAPS = [
  // `agentRound` is the one that is *only* concurrent here: n8n pushes an agent's tool calls
  // onto one stack and runs them one at a time, so the overlap is the model's, not the
  // workflow's. `agentTwoRounds` asks for one tool per round and stays sequential.
  'agentRound',
  'complicatedMulti', 'diamond', 'expressionRef', 'fanOut', 'fanOut4', 'haltInFlight',
  'parallelBranches', 'partialRequired', 'runFilter', 'switch20', 'webhookRespond',
];

/** The two fixtures whose execution halts, and the register row that explains the difference. */
const HALTS: Readonly<Record<string, number>> = { haltInFlight: 17, webhookRespond: 17 };

interface Leg {
  readonly fixture: string;
  readonly budget: number;
  readonly run: EngineRun;
}

const maxInFlight = (run: EngineRun): number => (run.scheduler as PetriScheduler).maxInFlight;

describe('the same net at k = 1 and at k > 1 (the M3 exit criterion)', () => {
  const legs: Leg[] = [];
  const base = new Map<string, EngineRun>();

  // One pass over the fixture set, reused by every assertion below.
  beforeAll(async () => {
    for (const fixture of DIFFER_FIXTURES) {
      base.set(fixture.name, await runPetri(fixture, 1));
      for (const budget of BUDGETS) {
        legs.push({ fixture: fixture.name, budget, run: await runPetri(fixture, budget) });
      }
    }
  }, 60_000);

  it('is the whole fixture set, not a sample', () => {
    expect(base.size).toBe(DIFFER_FIXTURES.length);
    expect(legs).toHaveLength(DIFFER_FIXTURES.length * BUDGETS.length);
  });

  it('actually runs above k = 1: only the k-unsafe fixtures are forced back', () => {
    const forced = legs.filter((l) => l.run.effectiveBudget === 1).map((l) => l.fixture);
    expect([...new Set(forced)].sort()).toEqual(FORCED_TO_ONE);
    for (const l of legs) {
      expect(`${l.fixture}@k=${l.budget}: ${l.run.effectiveBudget}`)
        .toBe(`${l.fixture}@k=${l.budget}: ${FORCED_TO_ONE.includes(l.fixture) ? 1 : l.budget}`);
      // A restriction is always explained; an unrestricted run never invents one.
      expect(l.run.budgetRestriction === null).toBe(!FORCED_TO_ONE.includes(l.fixture));
    }
  });

  it('actually overlaps: the fixtures that can run two nodes at once do', () => {
    // Without this the equality below could hold because nothing ever ran concurrently.
    for (const l of legs) {
      const overlapped = maxInFlight(l.run) > 1;
      expect(`${l.fixture}@k=${l.budget}: overlapped=${overlapped}`)
        .toBe(`${l.fixture}@k=${l.budget}: overlapped=${OVERLAPS.includes(l.fixture)}`);
    }
    // At k = 1 nothing overlaps, at any fixture: `_budget` holds one token.
    for (const run of base.values()) expect(maxInFlight(run)).toBe(1);
    // `fanOut`'s three siblings and `partialRequired` reach three in flight once k allows it.
    expect(maxInFlight(legs.find((l) => l.fixture === 'fanOut' && l.budget === 4)!.run)).toBe(3);
    expect(maxInFlight(legs.find((l) => l.fixture === 'fanOut' && l.budget === 2)!.run)).toBe(2);
  });

  it('produces the same data at every budget for every workflow that runs to completion', () => {
    // The gate. A difference here is a defect, never a divergence: the same engine, the same
    // fixture, the same node scripts — only k differs.
    const differing: string[] = [];
    for (const l of legs) {
      if (l.fixture in HALTS) continue;
      const comparison = compareData(base.get(l.fixture)!, l.run, {
        descendants: descendantsOf(DIFFER_FIXTURES.find((f) => f.name === l.fixture)!.workflow),
      });
      if (!comparison.equal) {
        differing.push(`${l.fixture}@k=${l.budget}: ${comparison.differences.map((d) => d.path).join(', ')}`);
      }
    }
    expect(differing).toEqual([]);
  });

  it('changes data only where the execution halts, and only for the reason row #17 gives', () => {
    // The one exception, and it is bounded: an extra activation and the stack entries it
    // therefore did not leave behind — never a different payload for a run both budgets did.
    for (const l of legs.filter((x) => x.fixture in HALTS)) {
      const comparison = compareData(base.get(l.fixture)!, l.run, {
        descendants: descendantsOf(DIFFER_FIXTURES.find((f) => f.name === l.fixture)!.workflow),
      });
      expect(`${l.fixture}@k=${l.budget}: equal=${comparison.equal}`)
        .toBe(`${l.fixture}@k=${l.budget}: equal=false`);
      expect(comparison.unattributed).toBe(0);
      for (const d of comparison.differences) {
        expect(d.attribution).toEqual({ kind: 'divergence', row: HALTS[l.fixture], why: expect.any(String) });
        // Every path is either a node that ran only above k = 1, or the pending stack the
        // codec wrote back — never a field inside a run both budgets produced.
        expect(d.path).toMatch(/^(runData\.[^.[]+|executionData\.nodeExecutionStack(\.length|\[\d+\]))$/);
      }
      expect(l.run.outcome).toBe('halted');
    }
  });

  it('keeps the scheduler contract: the halting error is the same value at every budget', () => {
    // Divergence #19: the halt error is written once by the activation whose failure ended
    // the execution and never overwritten, so a sibling finishing inside the halt window
    // cannot replace it. That is what makes the halt exception above bounded to run counts.
    for (const l of legs.filter((x) => x.fixture in HALTS)) {
      expect(`${l.fixture}@k=${l.budget}: ${JSON.stringify(l.run.contract.executionError)}`)
        .toBe(`${l.fixture}@k=${l.budget}: ${JSON.stringify(base.get(l.fixture)!.contract.executionError)}`);
    }
  });
});
