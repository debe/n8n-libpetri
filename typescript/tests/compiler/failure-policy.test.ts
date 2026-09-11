/**
 * The `onFailure` chain (ADR 0009): parsing, resolution, and the structure it compiles to.
 *
 * The load-bearing facts, each pinned below:
 * - a node with no policy compiles exactly as before, so no existing verdict can move;
 * - the chain is *unrolled*, so every token it uses lives inside one activation — unlike
 *   `X/tries`, which is seeded per execution and refunded by nothing;
 * - the deadline's timeout child claims a place of its own, because IO-013 makes it an `Xor`
 *   sibling and IO-015 needs exactly one assignment to explain a write;
 * - the policy is part of the structural hash, so two workflows differing only in it never
 *   share a compiled net (the defect ADR 0008's boundary review found for tool wiring).
 */
import { describe, expect, it } from 'vitest';
import { PrecompiledNet } from 'libpetri';
import {
  analyse, compile, parseExecutionPolicy, PolicyError, structuralHash, POLICY_SCHEMA_VERSION,
} from '../../src/compiler/index.js';
import type { ExecutionPolicy, FailureStep, WorkflowDescription } from '../../src/compiler/index.js';
import { conn, node, workflow } from '../fixtures/workflows.js';

/** Trigger → A → (Ok | Fallback), with `A` carrying the policy. */
function withPolicy(policy: ExecutionPolicy | undefined, wireFallback = true): WorkflowDescription {
  return workflow('policy', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'if', [200, 0], policy === undefined ? {} : { executionPolicy: policy }),
    node('Ok', 'set', [400, 0]),
    ...(wireFallback ? [node('Fallback', 'set', [400, 100])] : []),
  ], [
    conn('Trigger', 0, 'A', 0),
    conn('A', 0, 'Ok', 0),
    ...(wireFallback ? [conn('A', 1, 'Fallback', 0)] : []),
  ], 'Trigger');
}

const RETRY_THEN_ROUTE: readonly FailureStep[] = [
  { action: 'retry', waitMs: 1000 },
  { action: 'route', output: 'false' },
];

describe('parseExecutionPolicy', () => {
  const v = POLICY_SCHEMA_VERSION;

  it('reads a chain and a deadline', () => {
    const { policy, diagnostics } = parseExecutionPolicy(
      { v, timeoutMs: 30_000, onFailure: [{ action: 'retry', waitMs: 500 }, { action: 'stop' }] },
      "node 'A'");
    expect(policy?.timeoutMs).toBe(30_000);
    expect(policy?.onFailure).toEqual([{ waitMs: 500, action: 'retry' }, { action: 'stop' }]);
    expect(diagnostics).toEqual([]);
  });

  it('ignores a policy at an unknown schema version rather than refusing the workflow', () => {
    // Forward compatibility: a workflow saved by a newer build must still run here.
    const { policy, diagnostics } = parseExecutionPolicy({ v: 99, onFailure: [] }, "node 'A'");
    expect(policy).toBeUndefined();
    expect(diagnostics).toEqual(["node 'A': executionPolicy v=99 is not v1; ignored"]);
  });

  it('ignores an unknown key at a known version, and says so', () => {
    const { policy, diagnostics } = parseExecutionPolicy(
      { v, onFailure: [{ action: 'stop' }], hedge: 3 }, "node 'A'");
    expect(policy?.onFailure).toHaveLength(1);
    expect(diagnostics).toEqual(["node 'A': unknown executionPolicy key 'hedge'; ignored"]);
  });

  it('truncates at the first terminal step and reports the unreachable rest', () => {
    // `[retry, route, stop]` is a chain one escalation too long, not a broken one: the route
    // ends the activation, so `stop` can never be reached. Diagnose, do not refuse.
    const { policy, diagnostics } = parseExecutionPolicy(
      { v, onFailure: [{ action: 'retry' }, { action: 'route', output: 1 }, { action: 'stop' }] },
      "node 'A'");
    expect(policy?.onFailure).toHaveLength(2);
    expect(diagnostics).toEqual([
      "node 'A'.onFailure: step 1 ('route') ends the activation, so step 2 cannot be reached; ignored",
    ]);
  });

  it('refuses a chain that never ends', () => {
    // Nothing would consume the last attempt's failure: the token strands.
    expect(() => parseExecutionPolicy({ v, onFailure: [{ action: 'retry' }] }, "node 'A'"))
      .toThrow(/all 'retry'/);
  });

  it.each([
    ['a step that is not an object', { onFailure: ['retry'] }, /must be an object/],
    ['an unknown action', { onFailure: [{ action: 'explode' }] }, /action must be one of/],
    ['a route with no output', { onFailure: [{ action: 'route' }] }, /output is required/],
    ['an output on a non-route', { onFailure: [{ action: 'stop', output: 1 }] }, /only valid on action 'route'/],
    ['a negative deadline', { timeoutMs: -1, onFailure: [{ action: 'stop' }] }, /positive integer/],
    ['an empty chain', { onFailure: [] }, /at least one step/],
  ])('rejects %s', (_what, raw, message) => {
    expect(() => parseExecutionPolicy({ v, ...raw }, "node 'A'")).toThrow(PolicyError);
    expect(() => parseExecutionPolicy({ v, ...raw }, "node 'A'")).toThrow(message);
  });
});

describe('resolution against the node', () => {
  it('resolves a route by output name to its index', () => {
    const a = analyse(withPolicy({ onFailure: RETRY_THEN_ROUTE })).byName.get('A')!;
    expect(a.failure?.steps).toEqual([
      { attempt: 1, action: 'retry', waitMs: 1000, outputIndex: null },
      { attempt: 2, action: 'route', waitMs: null, outputIndex: 1 },
    ]);
  });

  it('refuses a route to an output nobody wired', () => {
    // The emission rule writes connected outputs only, so the step would have nowhere to put
    // its token — a policy that silently did nothing would be worse than one that refuses.
    expect(() => analyse(withPolicy({ onFailure: RETRY_THEN_ROUTE }, false)))
      .toThrow(/routes to output 1, which has no connection/);
  });

  it('refuses a route to a name the node type does not have', () => {
    expect(() => analyse(withPolicy({ onFailure: [{ action: 'route', output: 'nope' }] })))
      .toThrow(/does not name/);
  });

  it('refuses onFailure beside n8n retryOnFail', () => {
    const wf = workflow('clash', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], {
        retryOnFail: true, executionPolicy: { onFailure: [{ action: 'stop' }] },
      }),
    ], [conn('Trigger', 0, 'A', 0)], 'Trigger');
    expect(() => analyse(wf)).toThrow(/onFailure and retryOnFail both set/);
  });

  it('refuses a deadline with no chain to receive it', () => {
    expect(() => analyse(withPolicy({ timeoutMs: 1000 })))
      .toThrow(/timeoutMs needs an onFailure chain/);
  });
});

describe('the compiled chain', () => {
  it('leaves a policy-free node exactly as it was', () => {
    const before = compile(withPolicy(undefined));
    expect(before.netMap.node('A').attempts).toEqual([]);
    expect(before.netMap.node('A').attemptTimeoutMs).toBeNull();
    expect(before.netMap.node('A').transitions.attemptRuns).toEqual([]);
  });

  it('unrolls one running / failed pair per attempt, reusing X/running for the first', () => {
    const c = compile(withPolicy({ onFailure: RETRY_THEN_ROUTE }));
    const g = c.netMap.node('A');
    expect(g.attempts.map((a) => a.index)).toEqual([1, 2]);
    // The first attempt *is* the ordinary run, which is what keeps `X_start` unchanged.
    expect(g.attempts[0]!.running).toBe(g.running);
    expect(g.attempts.map((a) => a.failed.name)).toEqual(['id:A/failed_1', 'id:A/failed_2']);
    expect(g.attempts.map((a) => a.timedOut)).toEqual([null, null]);
    expect(g.transitions.attemptRuns).toEqual(['id:A/run', 'id:A/run_2']);
    expect(g.transitions.attemptSteps).toEqual(['id:A/attempt_1', 'id:A/attempt_2']);
    expect(g.transitions.attemptTimeouts).toEqual([]);
  });

  it('gives the deadline its own place and a funnel into the failure', () => {
    const c = compile(withPolicy({ timeoutMs: 30_000, onFailure: RETRY_THEN_ROUTE }));
    const g = c.netMap.node('A');
    expect(g.attemptTimeoutMs).toBe(30_000);
    expect(g.attempts.map((a) => a.timedOut?.name))
      .toEqual(['id:A/timedout_1', 'id:A/timedout_2']);
    expect(g.transitions.attemptTimeouts).toEqual(['id:A/timeout_1', 'id:A/timeout_2']);
    // The funnel is what makes "a timeout is another way an attempt fails" true in the net:
    // one step answers both, so the chain does not double.
    expect(g.transitions.attemptSteps).toHaveLength(2);
  });

  it('holds the budget across a retry wait and takes the delay from the step', () => {
    const c = compile(withPolicy({ onFailure: [{ action: 'retry', waitMs: 250 }, { action: 'stop' }] }));
    const step = [...c.net.transitions].find((t) => t.name === 'id:A/attempt_1')!;
    expect(step.timing).toEqual({ type: 'delayed', afterMs: 250 });
    // `_budget` is not among its outputs: the unit stays held, as n8n's retry loop holds it.
    expect(step.inhibitors.map((i) => i.place.name).sort()).toEqual(['_halt', '_pause']);
  });

  it('compiles to a valid net, deadline included', () => {
    // The real check on the `Out` specs: `PrecompiledNet.compile` validates CORE-043, and the
    // timeout sibling is exactly the shape a wrong nesting would break.
    for (const policy of [
      { onFailure: RETRY_THEN_ROUTE },
      { timeoutMs: 5_000, onFailure: RETRY_THEN_ROUTE },
      { onFailure: [{ action: 'stop' } as FailureStep] },
      { onFailure: [{ action: 'continue' } as FailureStep] },
      { timeoutMs: 100, onFailure: [{ action: 'retry' }, { action: 'retry' }, { action: 'continue' }] as FailureStep[] },
    ]) {
      const c = compile(withPolicy(policy));
      expect(() => PrecompiledNet.compile(c.net)).not.toThrow();
    }
  });

  it('counts every attempt as a place the node may be running in', () => {
    const c = compile(withPolicy({ onFailure: RETRY_THEN_ROUTE }));
    // `no-double-activation` and the mutual-exclusion pass ask "is this node running", which
    // an unrolled chain spreads across `X/running_i`.
    const names = c.runningPlaces.map((p) => p.name);
    expect(names).toContain('id:A/running');
    expect(names).toContain('id:A/running_2');
  });
});

describe('the scheduler binds the chain', () => {
  it('binds every attempt and deadline transition', async () => {
    const { schedulerActions } = await import('../../src/scheduler/index.js');
    const c = compile(withPolicy({ timeoutMs: 1000, onFailure: RETRY_THEN_ROUTE }));
    expect(() => c.withActions(schedulerActions())).not.toThrow();
  });

  it('still binds a policy-free workflow', async () => {
    const { schedulerActions } = await import('../../src/scheduler/index.js');
    expect(() => compile(withPolicy(undefined)).withActions(schedulerActions())).not.toThrow();
  });
});

describe('the structural hash', () => {
  const hashOf = (wf: WorkflowDescription): string => structuralHash(analyse(wf));

  it('separates two workflows that differ only in the policy', () => {
    expect(hashOf(withPolicy({ onFailure: RETRY_THEN_ROUTE })))
      .not.toBe(hashOf(withPolicy({ onFailure: [{ action: 'stop' }] })));
  });

  it('separates a declared deadline from none', () => {
    expect(hashOf(withPolicy({ onFailure: RETRY_THEN_ROUTE })))
      .not.toBe(hashOf(withPolicy({ timeoutMs: 1000, onFailure: RETRY_THEN_ROUTE })));
  });

  it('separates two delays', () => {
    expect(hashOf(withPolicy({ onFailure: [{ action: 'retry', waitMs: 1 }, { action: 'stop' }] })))
      .not.toBe(hashOf(withPolicy({ onFailure: [{ action: 'retry', waitMs: 2 }, { action: 'stop' }] })));
  });
});
