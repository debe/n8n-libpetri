/**
 * Shared helpers and fixtures for the `verify` suite.
 *
 * Every solver-backed suite goes through {@link describeZ3}, which skips with the reason in
 * the suite name when no usable z3 resolves; `tests/z3-gate.test.ts` turns that skip into a
 * failure under `CI`, so a run whose proofs never ran cannot pass unnoticed.
 *
 * The timeouts here are deliberately short. `docs/verification.md` measures what each
 * property costs; the tests only need the queries that close in well under a second to
 * close, and a short per-query timeout is what keeps the suite's runtime bounded when a
 * query is one of the ones that does not close at all.
 */
import { z3Available } from 'libpetri/verification';
import { conn, node, workflow } from '../fixtures/workflows.js';
import type {
  MainConnection, NetMapView, NodeDescription, NodeGadget, NodeTypeShape, WorkflowDescription,
} from '../../src/compiler/index.js';
import type { PropertyCheck, VerificationReport } from '../../src/verify/index.js';

/** Whether a usable `z3` resolves (`LIBPETRI_Z3` or `PATH`, >= 4.8.0; VER-013). */
export const Z3_AVAILABLE = z3Available();

/** `describe` for suites that run the solver. */
export function describeZ3(name: string, fn: () => void): void {
  if (Z3_AVAILABLE) describe(name, fn);
  else describe.skip(`${name} [skipped: no usable z3 >= 4.8.0 on PATH or LIBPETRI_Z3]`, fn);
}

/**
 * Per-query timeout for the suite. Every query the tests assert a verdict on returns in
 * < 1 s (measured in `docs/verification.md`); the ones that do not close are asserted only
 * as "not violated", so a short timeout keeps the file fast without weakening anything.
 */
export const TEST_TIMEOUT_MS = 5_000;

/** vitest per-case budget: a handful of queries plus the invariant computation. */
export const CASE_TIMEOUT_MS = 180_000;

export function checksOf(report: VerificationReport, property: string): PropertyCheck[] {
  return report.checks.filter((c) => c.property === property);
}

export function checkFor(report: VerificationReport, property: string, subject: string): PropertyCheck | undefined {
  return report.checks.find(
    (c) => c.property === property && ('node' in c.subject ? c.subject.node === subject : false));
}

/** A short digest of a report for an assertion message. */
export function digest(report: VerificationReport): string {
  return report.checks
    .map((c) => `${c.property} ${JSON.stringify(c.subject)} -> ${c.verdict}${c.reason === null ? '' : ` (${c.reason})`}`)
    .join('\n');
}

// ==================== fixtures ====================

/**
 * The stranding shape: input 0 of `M` has two producers, input 1 has one. The join's slot
 * discipline serialises input 0's arrivals (ADR 0003), so the second arrival waits for a
 * second arrival on input 1 that no producer can ever make — `M/ready_0` holds a token in a
 * quiescent marking. This is the arrival-count mismatch of divergence #2.
 */
export const unbalancedJoin: WorkflowDescription = workflow('unbalanced-join', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, -100]),
  node('B', 'set', [200, 100]),
  node('M', 'merge', [400, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0),
  conn('A', 0, 'M', 0), conn('B', 0, 'M', 0), conn('Trigger', 0, 'M', 1),
], 'Trigger');

/**
 * Two disconnected components. `Orphan` and `OrphanChild` are not reachable from the start
 * node, so no marking ever puts a token on their `running` place: both are dead nodes.
 */
export const orphanBranch: WorkflowDescription = workflow('orphan-branch', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('Orphan', 'set', [0, 200]),
  node('OrphanChild', 'set', [200, 200]),
], [
  conn('Trigger', 0, 'A', 0), conn('Orphan', 0, 'OrphanChild', 0),
], 'Trigger');

/** Trigger → A (retryOnFail, maxTries 4) → B: `A/tries` is seeded with 3. */
export const retryFour: WorkflowDescription = workflow('retry-four', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 4, waitBetweenTries: 10 }),
  node('B', 'set', [400, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0),
], 'Trigger');

/**
 * The `[live]` sample of the dead-nodes family in {@link file://./measure.ts}: the last node
 * in canvas order that the start node can actually reach.
 *
 * `measure.ts` used to take the last node outright. On the `orphan` fixture that is
 * `OrphanChild`, which is **dead** — so the two rows `docs/verification.md` printed as
 * `unreachable(OrphanChild/running) [live]` were a deadness proof under a liveness label,
 * and the conclusion drawn from their ~650 ms was about the wrong query. The honest live
 * sample there is `A`, one hop from the trigger.
 *
 * `undefined` when nothing is reachable, in which case the family has no live sample at all
 * and the row is skipped rather than mislabelled.
 */
export function liveSampleNode(map: NetMapView): NodeGadget | undefined {
  return [...map.nodes].reverse().find((g) => g.reachable);
}

// ==================== generated workflows (for the measurements) ====================

const SET: NodeTypeShape = { inputCount: 1, outputCount: 1 };
const TRIGGER: NodeTypeShape = { inputCount: 0, outputCount: 1 };
const MERGE: NodeTypeShape = { inputCount: 2, outputCount: 1 };
const IF: NodeTypeShape = { inputCount: 1, outputCount: 2, outputNames: ['true', 'false'] };

/**
 * `layers` diamonds in series: every layer is `IF -> {A, B} -> Merge`, so the workflow has
 * `4 * layers + 1` nodes, one join per layer and a branch structure a real workflow has.
 * Used by `tests/verify/measure.ts` for the medium and large sizes.
 */
export function generateWorkflow(layers: number, name = `generated-${layers}`): WorkflowDescription {
  const nodes: NodeDescription[] = [node('Trigger', 'trigger', [0, 0])];
  const connections: MainConnection[] = [];
  const shapes = new Map<string, NodeTypeShape>([['Trigger', TRIGGER]]);
  let previous = 'Trigger';
  for (let i = 0; i < layers; i++) {
    const gate = `If${i}`;
    const left = `A${i}`;
    const right = `B${i}`;
    const join = `Merge${i}`;
    const x = (i + 1) * 200;
    nodes.push(
      node(gate, 'if', [x, 0]),
      node(left, 'set', [x + 50, -100]),
      node(right, 'set', [x + 50, 100]),
      node(join, 'merge', [x + 100, 0]),
    );
    shapes.set(gate, IF);
    shapes.set(left, SET);
    shapes.set(right, SET);
    shapes.set(join, MERGE);
    connections.push(
      { from: previous, outputIndex: 0, to: gate, inputIndex: 0 },
      { from: gate, outputIndex: 0, to: left, inputIndex: 0 },
      { from: gate, outputIndex: 1, to: right, inputIndex: 0 },
      { from: left, outputIndex: 0, to: join, inputIndex: 0 },
      { from: right, outputIndex: 0, to: join, inputIndex: 1 },
    );
    previous = join;
  }
  return {
    name,
    nodes,
    connections,
    startNode: 'Trigger',
    nodeTypes: (n) => shapes.get(n.name)!,
  };
}
