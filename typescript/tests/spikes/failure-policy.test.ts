/**
 * The derived facts behind the `onFailure` chain (ADR 0009), measured rather than asserted.
 *
 * Four questions this file answers, each of which the design rests on:
 *
 * 1. **Is the chain per activation?** `X/tries` is not — nothing produces it, so a node that
 *    activates twice gets its leftover allowance where n8n gives it a fresh one. The chain is,
 *    by construction, and the structural check here is what says so.
 * 2. **What does unrolling cost?** `X_run` carries the routing spec, so *k* attempts multiply
 *    its flat branches by *k* and a deadline adds one each. The table is the input to the
 *    "force split routing above depth *n*" decision, the same trade ADR 0004's M6 amendment
 *    priced for outputs.
 * 3. **Is a uniform chain n8n's `retryOnFail`?** It should run the node the same number of
 *    times for the same failures.
 * 4. **Does the deadline actually fire, and is a late write discarded?** IO-013 AC5 is the
 *    reason the net stays correct without per-node cancellation, so it is worth observing on
 *    the real executor rather than trusting the spec text.
 */
import { describe, expect, it } from 'vitest';
import { enumerateBranches } from 'libpetri';
import { compile, forwardAllActions } from '../../src/compiler/index.js';
import type {
  ActionBinder, CompiledWorkflow, ExecutionPolicy, FailureStep, NodeGadget,
} from '../../src/compiler/index.js';
import { conn, node, workflow } from '../fixtures/workflows.js';
import { runCompiled, started } from '../compiler/support.js';
import { sleep } from './support.js';

const ITEMS = { items: [{ json: { n: 1 } }] };

/** Trigger → A(if) → Ok | Fallback, with the policy on `A`. */
function fixture(policy: ExecutionPolicy | undefined): CompiledWorkflow {
  return compile(workflow('policy', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'if', [200, 0], policy === undefined ? {} : { executionPolicy: policy }),
    node('Ok', 'set', [400, 0]),
    node('Fallback', 'set', [400, 100]),
  ], [
    conn('Trigger', 0, 'A', 0), conn('A', 0, 'Ok', 0), conn('A', 1, 'Fallback', 0),
  ], 'Trigger'));
}

const uniform = (attempts: number): FailureStep[] => [
  ...Array.from({ length: attempts - 1 }, (): FailureStep => ({ action: 'retry', waitMs: 0 })),
  { action: 'stop' },
];

/** The success outcome the placeholder writes: every connected edge empty, plus `X/routed`. */
function routeEmpty(ctx: { output: (p: never, v: unknown) => void }, g: NodeGadget): void {
  for (const out of g.outputs) {
    for (const e of out.edges) ctx.output(e.empty as never, null);
  }
  ctx.output(g.routed as never, null);
}

/**
 * `A`'s run fails its first `failures` attempts, then succeeds. `delayMs` makes every attempt
 * slow, which is how the deadline is exercised.
 */
function runsOf(failures: number, delayMs = 0, writeBeforeSleeping = false): ActionBinder {
  let seen = 0;
  // Every other node forwards data, so `A` actually receives an activation rather than the
  // empty the default placeholder would route and skip on.
  const base = forwardAllActions();
  return (info, map) => {
    if (info.node !== 'A' || info.role !== 'run') return base(info, map);
    const g = map.node('A');
    const attempt = g.attempts.find((a) => a.index === (info.attempt ?? 1))!;
    return async (ctx) => {
      const value = ctx.input(attempt.running);
      const fails = seen++ < failures;
      // IO-013 AC5: a write the action makes *before* the budget expires is discarded with the
      // firing. Writing first and sleeping after is how that becomes observable.
      if (writeBeforeSleeping && fails) ctx.output(attempt.failed as never, value);
      if (delayMs > 0) await sleep(delayMs);
      if (fails) {
        if (!writeBeforeSleeping) ctx.output(attempt.failed as never, value);
      } else {
        routeEmpty(ctx as never, g);
      }
      ctx.output(g.idle as never, null);
    };
  };
}

const runsStarted = (store: Parameters<typeof started>[0]): string[] =>
  started(store, (n) => n.startsWith('id:A/run'));

describe('the chain is per activation, where the counter is not', () => {
  it('nothing produces X/tries, so n8n retryOnFail spends its allowance per execution', () => {
    // The finding the unrolled shape exists to avoid: `X/tries` is seeded once by
    // `initialMarking` and consumed by `X_retry_wait`; no transition writes it back, so a
    // second activation of the same node inherits whatever the first left.
    const c = compile(workflow('retry', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 3 }),
    ], [conn('Trigger', 0, 'A', 0)], 'Trigger'));
    const tries = c.netMap.node('A').tries!;
    const producers = [...c.net.transitions].filter(
      (t) => t.outputSpec !== null && [...enumerateBranches(t.outputSpec)].some((b) => b.has(tries)));
    expect(producers).toEqual([]);
  });

  it('every chain token is created and consumed inside one attempt', () => {
    const c = fixture({ onFailure: uniform(3) });
    const g = c.netMap.node('A');
    for (const attempt of g.attempts) {
      const writes = [...c.net.transitions].filter(
        (t) => t.outputSpec !== null
          && [...enumerateBranches(t.outputSpec)].some((b) => b.has(attempt.failed)));
      const reads = [...c.net.transitions].filter(
        (t) => t.inputSpecs.some((i) => i.place === attempt.failed));
      // Exactly one producer (its own run) and one consumer (its own step): the position
      // cannot be inherited by a later activation, because no other transition touches it.
      expect(writes.map((t) => t.name)).toEqual([`id:A/run${attempt.index === 1 ? '' : `_${attempt.index}`}`]);
      expect(reads.map((t) => t.name)).toEqual([`id:A/attempt_${attempt.index}`]);
    }
  });
});

describe('what unrolling costs', () => {
  it('tables flat branches and net size against the policy-free node', () => {
    const rows: Array<Record<string, number | string>> = [];
    const measure = (label: string, c: CompiledWorkflow): void => {
      const runs = [...c.net.transitions].filter((t) => /\/run(_\d+)?$/.test(t.name) && t.name.startsWith('id:A/'));
      const branches = runs.reduce(
        (n, t) => n + (t.outputSpec === null ? 0 : enumerateBranches(t.outputSpec).length), 0);
      rows.push({
        shape: label,
        runTransitions: runs.length,
        flatBranches: branches,
        places: c.net.places.size,
        transitions: c.net.transitions.size,
      });
    };
    measure('no policy', fixture(undefined));
    for (const k of [2, 3, 5]) {
      measure(`${k} attempts`, fixture({ onFailure: uniform(k) }));
      measure(`${k} attempts + deadline`, fixture({ timeoutMs: 30_000, onFailure: uniform(k) }));
    }
    // eslint-disable-next-line no-console
    console.table(rows);

    // The shape of the growth, pinned so a regression in the encoding is visible: one run
    // transition per attempt, and the deadline adds exactly one branch to each.
    const plain = rows.find((r) => r.shape === '3 attempts')!;
    const timed = rows.find((r) => r.shape === '3 attempts + deadline')!;
    expect(plain['runTransitions']).toBe(3);
    expect(timed['flatBranches']).toBe((plain['flatBranches'] as number) + 3);
    // The deadline costs one place and one transition per attempt (`timedout_i`, `timeout_i`).
    expect(timed['places']).toBe((plain['places'] as number) + 3);
    expect(timed['transitions']).toBe((plain['transitions'] as number) + 3);
  });
});

describe('behaviour on the production executor', () => {
  it('runs the node once per attempt and stops when the chain says stop', async () => {
    const c = fixture({ onFailure: uniform(3) }).withActions(runsOf(3));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    expect(runsStarted(store)).toEqual(['id:A/run', 'id:A/run_2', 'id:A/run_3']);
    // The terminal step is `stop`, so the execution halts and nothing downstream runs.
    expect(marking.tokenCount(c.netMap.shared.halt)).toBe(1);
    expect(marking.tokenCount(c.netMap.node('Ok').done)).toBe(0);
  });

  it('stops retrying as soon as an attempt succeeds', async () => {
    const c = fixture({ onFailure: uniform(3) }).withActions(runsOf(1));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    expect(runsStarted(store)).toEqual(['id:A/run', 'id:A/run_2']);
    expect(marking.tokenCount(c.netMap.shared.halt)).toBe(0);
    expect(marking.tokenCount(c.netMap.node('A').done)).toBe(1);
  });

  it('a uniform chain runs the node as often as n8n retryOnFail would', async () => {
    // `retryOnFail` with `maxTries: 3` runs the node three times; so does a three-attempt
    // chain. The chain additionally *chooses* what the third failure does.
    const c = fixture({ onFailure: uniform(3) }).withActions(runsOf(99));
    const { store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    expect(runsStarted(store)).toHaveLength(3);
  });
});

describe('the deadline (IO-013 / EXEC-022)', () => {
  it('takes the timeout arm when an attempt overruns, and funnels it into the failure', async () => {
    const c = fixture({ timeoutMs: 30, onFailure: [{ action: 'stop' }] })
      .withActions(runsOf(0, 200));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    const fired = started(store, (n) => n.startsWith('id:A/'));
    expect(fired).toContain('id:A/timeout_1');
    expect(fired).toContain('id:A/attempt_1');
    // The attempt never succeeded, so the chain's terminal ran: the execution is halted.
    expect(marking.tokenCount(c.netMap.shared.halt)).toBe(1);
    expect(marking.tokenCount(c.netMap.node('A').done)).toBe(0);
  });

  it('discards what the action wrote before the budget expired (IO-013 AC5)', async () => {
    // The action writes `failed_1` and *then* overruns. If the partial write survived, the
    // marking would hold both it and the timeout child and the firing would be ambiguous.
    const c = fixture({ timeoutMs: 30, onFailure: [{ action: 'stop' }] })
      .withActions(runsOf(1, 200, true));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    expect(started(store, (n) => n === 'id:A/timeout_1')).toHaveLength(1);
    // One failure reached the step, not two: the discarded write did not double it.
    expect(started(store, (n) => n === 'id:A/attempt_1')).toHaveLength(1);
    expect(marking.tokenCount(c.netMap.node('A').attempts[0]!.timedOut!)).toBe(0);
  });

  it('forwards the run payload into the timeout place, not a sentinel (IO-014)', async () => {
    // IO-013 AC3 gives the timeout child *sentinel* tokens. Without `forwardInput` the step
    // answering the expiry would receive `null` and have no `executionData` to act on — the
    // whole deadline would compile, fire, and then be unable to do anything useful.
    let seenInStep: unknown = 'never ran';
    const c = fixture({ timeoutMs: 30, onFailure: [{ action: 'stop' }] })
      .withActions((info, map) => {
        if (info.role === 'attempt' && info.node === 'A') {
          const g = map.node('A');
          const att = g.attempts.find((x) => x.index === info.attempt)!;
          return async (ctx) => {
            seenInStep = ctx.input(att.failed);
            ctx.output(map.shared.halt as never, null);
            ctx.output(map.shared.budget as never, null);
          };
        }
        return runsOf(0, 200)(info, map);
      });
    await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    // The very value `X_start` put on `X/running` came through the abandoned firing intact —
    // under the compiler's placeholders that is the trigger items, and under the scheduler it
    // is the `RunPayload` carrying `executionData`. A sentinel would be `null`.
    expect(seenInStep).toEqual(ITEMS);
  });

  it('leaves a fast attempt alone', async () => {
    const c = fixture({ timeoutMs: 500, onFailure: [{ action: 'stop' }] })
      .withActions(runsOf(0, 5));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'precompiled');
    expect(started(store, (n) => n === 'id:A/timeout_1')).toEqual([]);
    expect(marking.tokenCount(c.netMap.node('A').done)).toBe(1);
  });
});
