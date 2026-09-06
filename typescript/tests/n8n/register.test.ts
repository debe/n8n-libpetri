/**
 * The registry hook: `registerPetriScheduler` hands n8n's `setWorkflowSchedulerFactory`
 * (patch 0002) a factory that creates one `PetriScheduler` per execution, all sharing one
 * compiled-workflow cache and delegating non-v1 workflows to the injected `StackScheduler`;
 * `setupN8nVitest` (the tsup entry the conformance shim calls) registers only under
 * `N8N_EXECUTION_ENGINE=libpetri`.
 */
import type { WorkflowScheduler, WorkflowSchedulerFactory } from '../../src/n8n/host.js';
import { ENGINE_ENV, setupN8nVitest } from '../../src/n8n-vitest-setup.js';
import { ENGINE_ENTERED_DIAGNOSTIC, PetriScheduler, registerPetriScheduler } from '../../src/scheduler/index.js';
import { linear } from '../fixtures/workflows.js';
import { FakeHost, fakeHooks, fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData } from '../scheduler/support.js';

class FakeStackScheduler implements WorkflowScheduler {
  static instances = 0;
  executionError = undefined;
  closeFunction = undefined;
  ran: unknown[] = [];
  constructor() { FakeStackScheduler.instances++; }
  async run(...args: unknown[]): Promise<void> { this.ran = args; }
}

function registrySpy() {
  const calls: WorkflowSchedulerFactory[] = [];
  return { calls, set: (next: WorkflowSchedulerFactory) => { calls.push(next); } };
}

describe('registerPetriScheduler', () => {
  it('reports the first time n8n actually constructs a scheduler, once per registration', () => {
    // Registering proves nothing about a conformance leg: `packages/cli` registers the
    // engine in all 1104 of its unit files and constructs it in none, because every test
    // that would reach `processRunExecutionData` mocks `n8n-core` first. This line is what
    // `<label>.diagnostics.txt` counts, so a leg with none is reported as "registered, never
    // entered" instead of as an engine result (docs/conformance-final.md).
    const messages: string[] = [];
    const registry = registrySpy();
    const reg = registerPetriScheduler({
      setWorkflowSchedulerFactory: registry.set, nodeHelpers: fakeNodeHelpers,
      StackScheduler: FakeStackScheduler, onDiagnostic: (m) => messages.push(m),
    });
    expect(messages, 'registration alone must say nothing').toEqual([]);
    reg.factory();
    reg.factory();
    expect(messages).toEqual([ENGINE_ENTERED_DIAGNOSTIC]);
    // The factory that was registered is the one that counts.
    expect(registry.calls).toEqual([reg.factory]);
  });

  it('registers one factory; every scheduler it creates is a fresh PetriScheduler sharing the registration\'s cache and budget', async () => {
    const registry = registrySpy();
    const reg = registerPetriScheduler({
      setWorkflowSchedulerFactory: registry.set, nodeHelpers: fakeNodeHelpers, StackScheduler: FakeStackScheduler, budget: 2, cacheCapacity: 3,
    });
    expect(registry.calls).toEqual([reg.factory]);
    expect(reg.cache.capacity).toBe(3);
    const a = reg.factory();
    const b = reg.factory();
    expect(a).toBeInstanceOf(PetriScheduler);
    expect(b).not.toBe(a);
    expect((a as PetriScheduler)['cache']).toBe(reg.cache);
    expect((b as PetriScheduler)['cache']).toBe(reg.cache);
    expect((a as PetriScheduler).budget).toBe(2);

    // Two executions of the same workflow through two schedulers: one compile.
    const wf = fakeWorkflow(linear);
    for (const s of [a, b]) {
      const red = newRunExecutionData(wf.nodes.Trigger!, { startItems: items(1) });
      const host = new FakeHost(wf, red, {});
      await s.run(host, wf, red, fakeHooks(host.calls));
      expect(Object.keys(red.resultData.runData)).toEqual(['Trigger', 'A', 'B', 'C']);
    }
    expect(reg.cache.size).toBe(1);
    expect(reg.cache.misses).toBe(1);
    expect(reg.cache.hits).toBe(1);
  });

  it('a non-v1 workflow goes to a new instance of the injected StackScheduler', async () => {
    const registry = registrySpy();
    const reg = registerPetriScheduler({ setWorkflowSchedulerFactory: registry.set, nodeHelpers: fakeNodeHelpers, StackScheduler: FakeStackScheduler });
    const wf = fakeWorkflow(linear, { executionOrder: 'v0' });
    const red = newRunExecutionData(wf.nodes.Trigger!);
    const host = new FakeHost(wf, red, {});
    const before = FakeStackScheduler.instances;
    const s = reg.factory() as PetriScheduler;
    await s.run(host, wf, red, fakeHooks(host.calls));
    expect(FakeStackScheduler.instances).toBe(before + 1);
    expect(s.outcome).toBe('legacy');
    expect(host.calls).toEqual([]); // the fake legacy scheduler touches nothing
  });
});

describe('setupN8nVitest', () => {
  const deps = () => {
    const registry = registrySpy();
    return { registry, deps: { setWorkflowSchedulerFactory: registry.set, NodeHelpers: fakeNodeHelpers, StackScheduler: FakeStackScheduler } };
  };

  it('is inert unless N8N_EXECUTION_ENGINE is libpetri', () => {
    const { registry, deps: d } = deps();
    expect(setupN8nVitest(d, {})).toEqual({ engine: 'legacy', registration: null });
    expect(setupN8nVitest(d, { [ENGINE_ENV]: 'legacy' })).toEqual({ engine: 'legacy', registration: null });
    expect(registry.calls).toEqual([]);
  });

  it('registers under libpetri, reading the budget from N8N_LIBPETRI_BUDGET (default 1, invalid → 1)', () => {
    const { registry, deps: d } = deps();
    const r = setupN8nVitest(d, { [ENGINE_ENV]: 'libpetri' });
    expect(r.engine).toBe('libpetri');
    expect(registry.calls).toEqual([r.registration!.factory]);
    expect((r.registration!.factory() as PetriScheduler).budget).toBe(1);
    expect((setupN8nVitest(d, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_BUDGET: '3' }).registration!.factory() as PetriScheduler).budget).toBe(3);
    expect((setupN8nVitest(d, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_BUDGET: 'many' }).registration!.factory() as PetriScheduler).budget).toBe(1);
    expect((setupN8nVitest(d, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_BUDGET: '0' }).registration!.factory() as PetriScheduler).budget).toBe(1);
  });
});
