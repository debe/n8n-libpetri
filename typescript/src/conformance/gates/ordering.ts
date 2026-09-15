/**
 * The **ordering report**, not a gate: the `executionIndex` sequences side by side, every
 * move attributed by the register's rules (`attribution.ts`), and
 * `resultData.lastNodeExecuted` compared as the order fact it is.
 */
import { attribute, attributeLastNodeExecuted, type Attribution, type AttributionContext } from '../attribution.js';
import type { EngineRun } from '../engines.js';
import type { DataComparison } from '../gate-data.js';
import { orderingContext } from './ordering-context.js';
import { oneSidedOf, ordersOf, rankMoves } from './ranks.js';

export interface OrderDifference {
  readonly activation: string;
  readonly n8nRank: number | null;
  readonly libpetriRank: number | null;
  readonly attribution: Attribution;
}

/**
 * `resultData.lastNodeExecuted`: the name n8n's error reporting and "Retry execution" read.
 * It is a function of the execution order alone, so a difference is attributed to row #5 —
 * but only when both engines name a node that actually ran in both. A name that belongs to
 * a node one engine never ran is a real defect and stays unattributed
 * (`attributeLastNodeExecuted`).
 */
export interface LastNodeExecuted {
  readonly n8n: string | undefined;
  readonly libpetri: string | undefined;
  readonly equal: boolean;
  readonly attribution: Attribution | null;
}

export interface OrderingReport {
  readonly n8n: readonly string[];
  readonly libpetri: readonly string[];
  readonly equal: boolean;
  readonly differences: readonly OrderDifference[];
  readonly unattributed: number;
  /** Mechanisms observed that no `docs/divergences.md` row names yet. */
  readonly novelMechanisms: readonly string[];
  readonly lastNodeExecuted: LastNodeExecuted;
}

function lastNodeExecutedOf(reference: EngineRun, candidate: EngineRun, ctx: AttributionContext): LastNodeExecuted {
  const n8n = reference.runExecutionData.resultData.lastNodeExecuted;
  const libpetri = candidate.runExecutionData.resultData.lastNodeExecuted;
  return {
    n8n,
    libpetri,
    equal: n8n === libpetri,
    attribution: attributeLastNodeExecuted(
      { n8n, libpetri }, { n8n: reference.runData, libpetri: candidate.runData }, ctx),
  };
}

/** Mechanisms the differences name that the register does not, sorted. */
function novelMechanismsIn(differences: readonly OrderDifference[]): string[] {
  const novel = new Set<string>();
  for (const { attribution: a } of differences) {
    if (a.kind === 'divergence' && a.novel) novel.add(a.mechanism);
  }
  return [...novel].sort();
}

/** Build the ordering report and attribute every rank difference. */
export function compareOrdering(
  reference: EngineRun,
  candidate: EngineRun,
  data: DataComparison,
  orInputNodes: ReadonlySet<string> = new Set(),
): OrderingReport {
  const orders = ordersOf(reference.runData, candidate.runData);
  const ctx = orderingContext(reference, candidate, data, orInputNodes, oneSidedOf(orders));
  const differences = rankMoves(orders).map((m): OrderDifference => ({
    activation: m.activation,
    n8nRank: m.n8nRank ?? null,
    libpetriRank: m.libpetriRank ?? null,
    attribution: attribute(m.activation, m.movedAgainst, ctx),
  }));
  const lastNodeExecuted = lastNodeExecutedOf(reference, candidate, ctx);
  const withLast = lastNodeExecuted.attribution === null
    ? differences
    : [...differences, { activation: 'resultData.lastNodeExecuted', n8nRank: null, libpetriRank: null, attribution: lastNodeExecuted.attribution }];
  return {
    n8n: orders.n8n,
    libpetri: orders.libpetri,
    equal: differences.length === 0 && lastNodeExecuted.equal,
    differences: withLast,
    unattributed: withLast.filter((d) => d.attribution.kind === 'unattributed').length,
    novelMechanisms: novelMechanismsIn(withLast),
    lastNodeExecuted,
  };
}
