/**
 * `PetriScheduler.compileDescription` analyses and hashes a description once per call: the
 * analysis for the cache key, and on a miss the same analysis and hash go to `compile` rather
 * than being computed again (CONC-020: compile once per workflow version, and do not pay for the
 * analysis twice to find out whether that already happened).
 *
 * Own file because `vi.mock` is hoisted and applies to every test in the module.
 */
import { analyse } from '../../src/compiler/graph.js';
import { structuralHash } from '../../src/compiler/hash.js';
import { fakeNodeHelpers } from '../../src/conformance/harness.js';
import { CompiledWorkflowCache, PetriScheduler } from '../../src/scheduler/index.js';
import { agentAssumedRounds, diamond, linear } from '../fixtures/workflows.js';

vi.mock('../../src/compiler/graph.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/compiler/graph.js')>();
  return { ...real, analyse: vi.fn(real.analyse) };
});
vi.mock('../../src/compiler/hash.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/compiler/hash.js')>();
  return { ...real, structuralHash: vi.fn(real.structuralHash) };
});

const analyseSpy = vi.mocked(analyse);
const hashSpy = vi.mocked(structuralHash);

function scheduler(options: { readonly maxAgentRounds?: number; readonly cache?: CompiledWorkflowCache } = {}): PetriScheduler {
  return new PetriScheduler({
    nodeHelpers: fakeNodeHelpers,
    legacy: () => { throw new Error('the legacy scheduler is not part of this test'); },
    ...options,
  });
}

beforeEach(() => {
  analyseSpy.mockClear();
  hashSpy.mockClear();
});

describe('compileDescription: one analysis and one hash per call', () => {
  it('a miss analyses and hashes once, and compiles on exactly that analysis and hash', () => {
    const s = scheduler();
    const c = s.compileDescription(diamond);
    expect(analyseSpy).toHaveBeenCalledTimes(1);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    const [analysed] = analyseSpy.mock.results;
    const [hashed] = hashSpy.mock.results;
    expect(c.analysis).toBe(analysed?.value);
    expect(c.structuralHash).toBe(hashed?.value);
    expect(hashSpy).toHaveBeenCalledWith(c.analysis);
  });

  it('a hit analyses and hashes once for the key, and returns the cached compile', () => {
    const cache = new CompiledWorkflowCache();
    const first = scheduler({ cache }).compileDescription(linear);
    analyseSpy.mockClear();
    hashSpy.mockClear();
    const again = scheduler({ cache }).compileDescription(linear);
    expect(again).toBe(first);
    expect(analyseSpy).toHaveBeenCalledTimes(1);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("the scheduler's agent budgets reach the one analysis, and so the compiled net", () => {
    const c = scheduler({ maxAgentRounds: 7 }).compileDescription(agentAssumedRounds);
    expect(analyseSpy).toHaveBeenCalledTimes(1);
    expect(analyseSpy.mock.calls[0]?.[1]).toEqual({ maxAgentRounds: 7 });
    expect(c.analysis.byName.get('Agent')?.maxRounds).toBe(7);
    expect(c.netMap.node('Agent').agent?.maxRounds).toBe(7);
  });
});
