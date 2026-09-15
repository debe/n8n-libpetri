/**
 * Fake lifecycle hooks: every hook call is appended to the host's `calls` recorder, and a
 * hook can be made to reject for a chosen node.
 */
import type { SchedulerHooks } from '../../n8n/host.js';

/** Per hook, an error to reject with for a given node (`undefined` = the hook succeeds). */
export type HookFailures = Partial<Record<'nodeExecuteBefore' | 'nodeExecuteAfter', (node: string) => Error | undefined>>;

export function fakeHooks(calls: string[], failures: HookFailures = {}): SchedulerHooks {
  const hooks = {
    runHook: async (name: string, params: unknown[]) => {
      const node = String((params as [string])[0]);
      calls.push(`hook:${name}(${node})`);
      const error = failures[name as keyof HookFailures]?.(node);
      if (error !== undefined) throw error;
    },
  };
  return hooks as unknown as SchedulerHooks;
}
