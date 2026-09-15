/**
 * One `PetriScheduler` instance, two `run()`s: the second starts from nothing. n8n constructs
 * one scheduler per execution, but the registry hands out whatever the factory returns, and a
 * close function inherited from an earlier execution would be awaited by a later one.
 */
import { PetriScheduler } from '../../src/scheduler/index.js';
import { linear } from '../fixtures/workflows.js';
import { FakeHost, fakeHooks, fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData, type NodeScript } from './support.js';

const START = items({ n: 1 });

describe('a second run() on the same instance', () => {
  it('does not inherit the previous run\'s close function, compiled workflow or outcome', async () => {
    const scheduler = new PetriScheduler({ nodeHelpers: fakeNodeHelpers, legacy: () => { throw new Error('no'); } });
    const wf = fakeWorkflow(linear);
    const closing: NodeScript = () => ({ data: [items({ a: 1 })], closeFunction: async () => {} });

    const first = newRunExecutionData(wf.nodes.Trigger!, { startItems: START });
    const firstHost = new FakeHost(wf, first, { A: closing });
    await scheduler.run(firstHost, wf, first, fakeHooks(firstHost.calls));
    expect(scheduler.closeFunction).toBeInstanceOf(Promise);
    expect(scheduler.outcome).toBe('completed');
    expect(scheduler.compiled).toBeDefined();

    // Nothing to run: n8n's loop never enters, so nothing of the first run may show through.
    const second = newRunExecutionData(wf.nodes.Trigger!, { startItems: START, emptyStack: true });
    const secondHost = new FakeHost(wf, second, {});
    await scheduler.run(secondHost, wf, second, fakeHooks(secondHost.calls));
    expect(scheduler.outcome).toBe('nothing-to-run');
    expect(scheduler.closeFunction).toBeUndefined();
    expect(scheduler.compiled).toBeUndefined();
  });
});
