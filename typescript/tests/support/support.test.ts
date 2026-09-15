/**
 * Pins the shared test helpers where a misreading has already cost a test author time:
 * `execute()`'s start node, and what {@link tokensResting} counts.
 */
import type { WorkflowDescription } from '../../src/compiler/index.js';
import { linear } from '../fixtures/workflows.js';
import { execute, tokensResting } from '../scheduler/support.js';

describe('the shared test helpers', () => {
  it('execute() refuses a fixture that names neither startNodes nor startNode', async () => {
    const { startNode: _startNode, startNodes: _startNodes, ...rest } = linear;
    const unstarted: WorkflowDescription = { ...rest, name: 'no-start-node' };
    await expect(execute(unstarted)).rejects.toThrow(
      "fixture 'no-start-node' names no start node (startNodes or startNode)");
  });

  it('execute() refuses a fixture whose start node is not one of its nodes', async () => {
    const misnamed: WorkflowDescription = { ...linear, name: 'misnamed-start', startNode: 'Nowhere' };
    await expect(execute(misnamed)).rejects.toThrow(
      "fixture 'misnamed-start' starts at 'Nowhere', which is not one of its nodes");
  });

  it('tokensResting counts events only: a seeded budget that all came back reads 0, not the seed', async () => {
    const run = await execute(linear, {}, { budget: 2 });
    expect(run.error).toBeUndefined();
    expect(tokensResting(run.store, '_budget')).toBe(0);
  });
});
