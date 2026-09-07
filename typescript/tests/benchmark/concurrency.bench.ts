/**
 * The evidence for the project's central claim (README "What formalisation provides",
 * milestone M3): *n8n completes
 * one branch before starting the next, so two independent 500 ms HTTP calls take ~1 s; under
 * a net both transitions are enabled at once.*
 *
 * Nothing here is a pass/fail gate. Every number is a wall-clock measurement with real
 * timers on a `FakeHost` whose `runNode` sleeps, so the figures are dominated by the sleeps
 * exactly as a real workflow is dominated by its HTTP calls. Run with `npm run bench`; the
 * numbers as measured on the development machine are in `docs/differential.md`.
 *
 * Four groups:
 *
 * 1. **fan-out** — `Trigger` into `width` independent {@link NODE_MS} branches, at k = 1, 2
 *    and 4, against n8n's own loop. The expectation is `ceil(width / k) * NODE_MS`, so
 *    width 2 at k = 2 is one node time and width 8 at k = 1 is eight.
 * 2. **deep chain** — the same total work with no parallelism available, to show what the
 *    budget costs when there is nothing to win (it should cost nothing).
 * 3. **scheduling overhead** — a 100-node chain with 0 ms actions, both engines, warm and
 *    cold cache. The difference between the two engines divided by 100 is what one node of
 *    net machinery costs; everything else in the figure is the host work n8n does anyway.
 * 4. **compile** — a 185-node workflow through `compile()` and then `PrecompiledNet`
 *    (n8n's own pre-execution validation of a workflow that size is the ~48 s figure the
 *    plan flags; this measures only ours).
 *
 * Tolerance: a sleep-driven measurement on a loaded machine runs long, never short, so read
 * the numbers as upper bounds and compare *ratios* between rows, not absolutes. The
 * `iterations: 1` groups are the ones whose runtime is seconds; timer jitter on them is
 * a few milliseconds against node times of hundreds, i.e. under 2 %.
 */
import { bench, describe } from 'vitest';
import type { IRunData } from 'n8n-workflow';
import { compile, type MainConnection, type NodeDescription, type WorkflowDescription } from '../../src/compiler/index.js';
import { runReference, type DifferFixture } from '../../src/conformance/index.js';
import { CompiledWorkflowCache } from '../../src/scheduler/index.js';
import { execute, items, passThrough, sleep, type NodeScript } from '../scheduler/support.js';
import { SHAPES, conn, node, workflow, type ShapeName } from '../fixtures/workflows.js';

/** One "HTTP call". The claim in the README is stated at 500 ms. */
const NODE_MS = 500;

const START = items({ i: 0 });

/** Run once per bench iteration: nothing is shared but the compiled-workflow cache. */
const ONE_SHOT = { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 } as const;

function build(name: string, nodes: readonly NodeDescription[], connections: readonly MainConnection[]): WorkflowDescription {
  return { ...workflow(name, nodes, connections, 'Trigger'), nodeTypes: (n) => SHAPES[n.type as ShapeName] };
}

/** `Trigger` into `width` independent leaves. */
function fanOutOf(width: number): WorkflowDescription {
  return build(`fan-out-${width}`, [
    node('Trigger', 'trigger', [0, 0]),
    ...Array.from({ length: width }, (_, i) => node(`N${i}`, 'set', [200, i * 100])),
  ], Array.from({ length: width }, (_, i) => conn('Trigger', 0, `N${i}`, 0)));
}

/** `Trigger` → `N0` → … → `N(length-1)`: no parallelism is available at any budget. */
function chainOf(length: number): WorkflowDescription {
  return build(`chain-${length}`, [
    node('Trigger', 'trigger', [0, 0]),
    ...Array.from({ length }, (_, i) => node(`N${i}`, 'set', [(i + 1) * 100, 0])),
  ], [
    conn('Trigger', 0, 'N0', 0),
    ...Array.from({ length: length - 1 }, (_, i) => conn(`N${i}`, 0, `N${i + 1}`, 0)),
  ]);
}

/** 185 nodes: a trigger and 46 four-node chains — the size the plan names. */
function wide(branches: number, depth: number): WorkflowDescription {
  const nodes: NodeDescription[] = [node('Trigger', 'trigger', [0, 0])];
  const connections: MainConnection[] = [];
  for (let b = 0; b < branches; b++) {
    for (let d = 0; d < depth; d++) {
      nodes.push(node(`B${b}D${d}`, 'set', [(d + 1) * 200, b * 100]));
      connections.push(d === 0 ? conn('Trigger', 0, `B${b}D0`, 0) : conn(`B${b}D${d - 1}`, 0, `B${b}D${d}`, 0));
    }
  }
  return build(`wide-${branches}x${depth}`, nodes, connections);
}

const slow: NodeScript = async ({ executionData }) => {
  await sleep(NODE_MS);
  return { data: [executionData.data.main?.[0] ?? []] };
};

const scriptsFor = (w: WorkflowDescription, script: NodeScript): Record<string, NodeScript> =>
  Object.fromEntries(w.nodes.map((n) => [n.name, n.name === 'Trigger' ? passThrough : script]));

const fixtureOf = (w: WorkflowDescription, script: NodeScript): DifferFixture =>
  ({ name: w.name!, workflow: w, scripts: scriptsFor(w, script), options: { startItems: START } });

/**
 * Every driver here swallows a rejection by design (`execute()` catches into
 * `Execution.error`, `runLeg` into `EngineRun.error`), so a workflow neither engine can run
 * returns in a fraction of a millisecond and vitest bench would print that as an enormous
 * win over the working row. Measured: `runReference` on a non-v1 workflow returns in 0.5 ms
 * having run **no** nodes. So every row asserts what it measured before returning.
 */
function assertRan(w: WorkflowDescription, error: unknown, runData: IRunData, expectedInFlight?: number, actualInFlight?: number): void {
  const ran = Object.keys(runData).length;
  const wrong = error !== undefined
    ? `the run failed: ${String(error)}`
    : ran !== w.nodes.length
      ? `${ran} of ${w.nodes.length} nodes ran`
      : expectedInFlight !== undefined && actualInFlight !== expectedInFlight
        ? `maxInFlight ${String(actualInFlight)}, expected ${expectedInFlight}`
        : null;
  if (wrong === null) return;
  // `vitest bench` reports a throwing row as `NaN` with no samples rather than as a failure,
  // so the reason is written out as well: what must never happen is a *number* being printed
  // for a run that did not do the work.
  process.stderr.write(`bench guard — ${w.name}: ${wrong}\n`);
  throw new Error(`${w.name}: ${wrong}`);
}

async function runNet(
  w: WorkflowDescription, script: NodeScript, budget: number,
  cache?: CompiledWorkflowCache, expectedInFlight?: number,
): Promise<void> {
  const r = await execute(w, scriptsFor(w, script), {
    startItems: START, budget, ...(cache === undefined ? {} : { scheduler: { cache } }),
  });
  assertRan(w, r.error, r.runData, expectedInFlight, r.scheduler.maxInFlight);
}

/** n8n's own loop, with the same check: one node at a time, every node run. */
async function runN8n(w: WorkflowDescription, script: NodeScript): Promise<void> {
  const r = await runReference(fixtureOf(w, script));
  assertRan(w, r.error, r.runData);
}

// ==================== 1. fan-out: the claim ====================

for (const width of [2, 4, 8] as const) {
  describe(`fan-out ${width} x ${NODE_MS} ms`, () => {
    const w = fanOutOf(width);
    bench('n8n (sequential by construction)', async () => { await runN8n(w, slow); }, ONE_SHOT);
    for (const k of [1, 2, 4] as const) {
      // `maxInFlight` is the observable that separates real concurrency from a short run:
      // `min(k, width)` leaves start in the same cycle and sleep together.
      bench(`libpetri k=${k}`, async () => { await runNet(w, slow, k, undefined, Math.min(k, width)); }, ONE_SHOT);
    }
  });
}

// ==================== 2. deep chain: nothing to win ====================

describe(`chain 8 x ${NODE_MS} ms (no parallelism available)`, () => {
  const w = chainOf(8);
  bench('n8n', async () => { await runN8n(w, slow); }, ONE_SHOT);
  for (const k of [1, 2, 4] as const) {
    // Nothing to win and nothing to lose: one node is ever ready, at every budget.
    bench(`libpetri k=${k}`, async () => { await runNet(w, slow, k, undefined, 1); }, ONE_SHOT);
  }
});

// ==================== 3. scheduling overhead ====================

describe('scheduling overhead: 100-node chain, 0 ms actions', () => {
  const w = chainOf(100);
  const warm = new CompiledWorkflowCache(4);
  bench('n8n loop', async () => { await runN8n(w, passThrough); }, { iterations: 20, time: 0 });
  bench('libpetri k=1, warm cache', async () => { await runNet(w, passThrough, 1, warm); }, { iterations: 20, time: 0 });
  bench('libpetri k=1, cold cache (compiles every run)', async () => { await runNet(w, passThrough, 1); }, { iterations: 20, time: 0 });
  bench('libpetri k=4, warm cache', async () => { await runNet(w, passThrough, 4, warm); }, { iterations: 20, time: 0 });
});

// ==================== 4. compile ====================

describe('compile a 185-node workflow', () => {
  const w = wide(46, 4);
  bench('compile() — net + NetMap', () => { compile(w, { budget: 1 }); }, { iterations: 10, time: 0 });
  bench('compile() + PrecompiledNet', () => { compile(w, { budget: 1 }).program.transitionCount; }, { iterations: 10, time: 0 });
});
