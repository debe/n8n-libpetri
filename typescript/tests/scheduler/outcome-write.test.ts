/**
 * The outcome writer runs inside the guard. An action that throws *after* `body()` resolved
 * — while turning the outcome into tokens — would reject the transition after the firing
 * consumed its tokens and its budget unit (EXEC-030): the net never quiesces properly and
 * `run()` rejects before the marking is written back. The deposits are therefore computed as a
 * list before anything is emitted, and a list that cannot be computed takes the same fallback
 * branch a fatal error does.
 */
import type { IExecuteData, INode, INodeExecutionData, ITaskData, ExecutionBaseError } from 'n8n-workflow';
import type { SchedulerHooks } from '../../src/n8n/host.js';
import { conn, node, workflow } from '../fixtures/workflows.js';
import { FakeHost, execute, items, ranNodes, tokensResting, transitionsFailed, transitionsStarted } from './support.js';

const START = items({ n: 1 });

type ErrorArgs = {
  executionNode: INode; executionData: IExecuteData; taskData: ITaskData; executionError: ExecutionBaseError;
  nodeSuccessData: INodeExecutionData[][] | null | undefined; runIndex: number; hooks: SchedulerHooks;
};

/** `Trigger` → `A` (continues past its error) → `B`. */
const continuing = workflow('outcome-write-continue', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0], { onError: 'continueRegularOutput' }),
  node('B', 'set', [400, 0]),
], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');

describe('the outcome writer runs inside the guard', () => {
  it.each([
    ['dereferences it, as n8n\'s does', false],
    ['tolerates it', true],
  ])('a handler that continues with a null nodeSuccessData, on a host that %s: run() rejects as n8n\'s does, after the net quiesced', async (_label, tolerant) => {
    // n8n's handler leaves `nodeSuccessData` null when it continues a node whose `main[0]` is
    // null, and its loop then throws out of `run()` at `normalizeNodeErrors(nodeSuccessData!)`,
    // after the node `try`. The scheduler hands its host the same value at the same call, so the
    // outcome does not depend on whether the host tolerates the null: the throw is `guarded`'s
    // fatal either way, the firing takes `A`'s stopped branch, and nothing it consumed is lost.
    class NullContinuingHost extends FakeHost {
      override async handleNodeExecutionError(args: ErrorArgs): Promise<{ continueExecution: boolean; nodeSuccessData: INodeExecutionData[][] | null | undefined }> {
        await super.handleNodeExecutionError(args);
        return { continueExecution: true, nodeSuccessData: null };
      }
      override normalizeNodeErrors(nodeSuccessData: INodeExecutionData[][]): void {
        if (tolerant && (nodeSuccessData === null || nodeSuccessData === undefined)) return;
        super.normalizeNodeErrors(nodeSuccessData);
      }
    }
    const r = await execute(continuing, { A: () => { throw new Error('A boom'); } }, {
      startItems: START,
      host: (wf, red, scripts, options) => new NullContinuingHost(wf, red, scripts, options),
    });
    expect(r.error).toBeInstanceOf(TypeError);
    expect(r.scheduler.outcome).toBe('fatal');
    expect(r.scheduler.executionError?.message).toBe((r.error as Error).message);
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(r.runData.B).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:B/start')).toHaveLength(0);
    // `A` has no halt branch, so the fatal takes the stopped one. The helper counts token
    // events and the seeded budget unit is not one, so a budget whose every unit came back reads 0.
    expect(tokensResting(r.store, 'id:A/stopped')).toBe(1);
    expect(tokensResting(r.store, 'id:A/running')).toBe(0);
    expect(tokensResting(r.store, '_budget')).toBe(0);
  });

  it('a handler that stops the execution on a node whose policy continues: the stopped branch stands in, the budget is not lost', async () => {
    // n8n's own handler never stops a `continueRegularOutput` node, so `X_run` has no halt
    // branch for it. A host that does stop it must still leave the net quiescent, with the
    // entry the handler pushed on n8n's stack and the halt error as the contract value.
    class StoppingHost extends FakeHost {
      override async handleNodeExecutionError(args: ErrorArgs): Promise<{ continueExecution: boolean; nodeSuccessData: INodeExecutionData[][] | null | undefined }> {
        const outcome = await super.handleNodeExecutionError(args);
        // n8n's stop path: the task data is upserted and the entry pushed back for a retry.
        this.upsertTaskData(args.executionNode.name, args.runIndex, args.taskData);
        this.pushExecutionStack(args.executionData);
        return { ...outcome, continueExecution: false };
      }
    }
    const r = await execute(continuing, { A: () => { throw new Error('A boom'); } }, {
      startItems: START,
      host: (wf, red, scripts, options) => new StoppingHost(wf, red, scripts, options),
    });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).not.toBe('fatal');
    expect(r.scheduler.executionError?.message).toBe('A boom');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(transitionsStarted(r.store, (n) => n === 'id:B/start')).toHaveLength(0);
    // The stopped branch: `X/stopped` holds the run and `_pause` is set. The helper counts token
    // events and the seeded budget unit is not one, so a budget whose every unit came back — the
    // net quiesced instead of losing the firing — reads 0.
    expect(tokensResting(r.store, 'id:A/stopped')).toBe(1);
    expect(tokensResting(r.store, '_pause')).toBe(1);
    expect(tokensResting(r.store, '_budget')).toBe(0);
    expect(tokensResting(r.store, 'id:A/running')).toBe(0);
    // Nothing is re-queued: the marking write-back owns n8n's stack and `ran: true` adds no entry,
    // so the host's own push does not survive it. n8n's handler never stops such a node, so no n8n
    // behaviour is at stake here; what is pinned is that the firing is not lost.
    expect(r.runExecutionData.executionData!.nodeExecutionStack).toEqual([]);
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'A'") && d.includes('no halt branch'))).toBe(true);
  });
});
