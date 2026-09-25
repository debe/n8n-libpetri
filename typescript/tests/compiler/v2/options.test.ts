/**
 * The compile profile (ADR 0012 §1, `tasks/v2-profile-plan.md` decision 1 and step 2): the
 * option, its default, where it is recorded and hashed, and the refusals that keep the two
 * targets apart. What an `engineV2` net looks like is later steps' business; this suite pins
 * only the plumbing.
 */
import { analyse, compile, CompileError, structuralHash } from '../../../src/compiler/index.js';
import type { CompileOptions, CompileProfile, WorkflowDescription } from '../../../src/compiler/index.js';
import { ALL, agentTwoTools, diamond, linear } from '../../fixtures/workflows.js';

/** `code: message` of the `CompileError` `f` throws; anything else is rethrown. */
function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof CompileError) return `${e.code}: ${e.message}`;
    throw e;
  }
  return 'nothing thrown';
}

const compileAs = (wf: WorkflowDescription, options: CompileOptions): string => refusal(() => compile(wf, options));

describe('the profile option', () => {
  it('defaults to v1, in analyse and in compile', () => {
    expect(analyse(diamond).profile).toBe('v1');
    expect(compile(diamond).analysis.profile).toBe('v1');
    expect(compile(diamond, { profile: 'v1' }).structuralHash).toBe(compile(diamond).structuralHash);
  });

  it('is recorded on the analysis compile builds', () => {
    expect(analyse(linear, { profile: 'engineV2' }).profile).toBe('engineV2');
    expect(compile(linear, { profile: 'engineV2' }).analysis.profile).toBe('engineV2');
  });

  it('accepts a precomputed analysis of the same profile, as the compiled workflow\'s own', () => {
    const v2 = analyse(linear, { profile: 'engineV2' });
    expect(compile(linear, { profile: 'engineV2', analysis: v2 }).analysis).toBe(v2);
    const v1 = analyse(linear);
    expect(compile(linear, { profile: 'v1', analysis: v1 }).analysis).toBe(v1);
  });

  it('seeds no budget of its own under engineV2: requested and effective are 1', () => {
    const c = compile(linear, { profile: 'engineV2' });
    expect([c.requestedBudget, c.effectiveBudget]).toEqual([1, 1]);
  });
});

/**
 * The `ALL` fixtures the engineV2 analysis refuses; `refusals.test.ts` pins each one's code.
 * There is no engineV2 analysis of them to hash.
 */
const V2_REFUSED: ReadonlySet<string> = new Set([
  'multiProducer', 'loopOverItems', 'userCycle', 'twoTriggers', 'ifBothOutputs',
  'chooseBranch', 'partialRequired', 'continueErrorOutput',
]);

describe('structuralHash v14', () => {
  it('separates the profiles of every fixture engine v2 accepts, so the two nets never share a cache entry', () => {
    for (const [name, wf] of Object.entries(ALL)) {
      if (V2_REFUSED.has(name)) continue;
      const v1 = structuralHash(analyse(wf));
      const v2 = structuralHash(analyse(wf, { profile: 'engineV2' }));
      expect(v2, name).toMatch(/^[0-9a-f]{64}$/);
      expect(v2, name).not.toBe(v1);
    }
  });

  it('is stable per profile', () => {
    expect(structuralHash(analyse(diamond, { profile: 'engineV2' })))
      .toBe(structuralHash(analyse(diamond, { profile: 'engineV2' })));
    expect(compile(diamond, { profile: 'engineV2' }).structuralHash)
      .toBe(structuralHash(analyse(diamond, { profile: 'engineV2' })));
  });
});

describe('refusals, all invalid-options', () => {
  it('refuses a precomputed analysis of another profile, in both directions', () => {
    const v1 = analyse(linear);
    const v2 = analyse(linear, { profile: 'engineV2' });
    expect(compileAs(linear, { profile: 'engineV2', analysis: v1 })).toBe(
      "invalid-options: compile: the precomputed analysis is for profile 'v1', but compile was asked for " +
      "'engineV2'; analyse with the same profile");
    // No profile option is the v1 default, not "whatever the analysis says".
    expect(compileAs(linear, { analysis: v2 })).toBe(
      "invalid-options: compile: the precomputed analysis is for profile 'engineV2', but compile was asked for " +
      "'v1'; analyse with the same profile");
  });

  it('refuses any budget under engineV2, a valid one included, before the budget is checked', () => {
    const want = 'invalid-options: compile: budget is the v1 concurrency budget; the engineV2 profile has no _budget';
    expect(compileAs(linear, { profile: 'engineV2', budget: 1 })).toBe(want);
    expect(compileAs(linear, { profile: 'engineV2', budget: 3 })).toBe(want);
    expect(compileAs(linear, { profile: 'engineV2', budget: 0 })).toBe(want);
    // v1 keeps its own refusal of the same value.
    expect(compileAs(linear, { budget: 0 })).toBe('invalid-budget: compile: budget must be a positive integer, got 0');
  });

  it('refuses the agent budgets under engineV2, with or without a precomputed analysis', () => {
    const want = 'invalid-options: compile: maxAgentRounds / maxAgentToolCalls seed the agent round, ' +
      'which the engineV2 profile does not have';
    const v2 = analyse(agentTwoTools, { profile: 'engineV2' });
    expect(compileAs(agentTwoTools, { profile: 'engineV2', maxAgentRounds: 3 })).toBe(want);
    expect(compileAs(agentTwoTools, { profile: 'engineV2', maxAgentToolCalls: 3 })).toBe(want);
    expect(compileAs(agentTwoTools, { profile: 'engineV2', analysis: v2, maxAgentRounds: 3 })).toBe(want);
    expect(refusal(() => analyse(agentTwoTools, { profile: 'engineV2', maxAgentToolCalls: 3 }))).toBe(
      'invalid-options: analyse: maxAgentRounds / maxAgentToolCalls seed the agent round, ' +
      'which the engineV2 profile does not have');
  });

  it('refuses a profile it does not know rather than compiling it as v1', () => {
    const unknown = 'v3' as CompileProfile;
    expect(compileAs(linear, { profile: unknown })).toBe(
      "invalid-options: compile: profile must be 'v1' or 'engineV2', got v3");
    expect(refusal(() => analyse(linear, { profile: unknown }))).toBe(
      "invalid-options: analyse: profile must be 'v1' or 'engineV2', got v3");
  });

  it('leaves the v1 refusals as they were', () => {
    const a = analyse(agentTwoTools);
    expect(compileAs(agentTwoTools, { analysis: a, maxAgentRounds: 3 })).toMatch(/^invalid-options: .*pass them to analyse\(\)$/);
    expect(compileAs(agentTwoTools, { structuralHash: 'x' })).toMatch(/^invalid-options: .*without the analysis it hashes$/);
    expect(compile(agentTwoTools, { maxAgentRounds: 3, budget: 2 }).requestedBudget).toBe(2);
  });
});
