/**
 * The two engines' execution orders and the rank arithmetic the ordering report is built
 * on: which activations moved, which activations each one passed, and which ran in one
 * engine only. Pure order — nothing here attributes a move.
 */
import type { IRunData } from 'n8n-workflow';
import type { EngineName } from '../engines.js';
import { activationKey } from '../trace.js';

/** The activations in `executionIndex` order — n8n's own `nodeExecutionOrder`. */
export function executionOrder(runData: IRunData): string[] {
  const rows: Array<{ key: string; index: number }> = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, runIndex) => {
      rows.push({ key: activationKey(node, runIndex), index: (task as { executionIndex?: number }).executionIndex ?? 0 });
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.key);
}

/** Both engines' execution orders, and each activation's rank in each. */
export interface Orders {
  readonly n8n: readonly string[];
  readonly libpetri: readonly string[];
  readonly n8nRank: ReadonlyMap<string, number>;
  readonly libpetriRank: ReadonlyMap<string, number>;
}

const rankOf = (seq: readonly string[]): Map<string, number> => new Map(seq.map((k, i) => [k, i]));

export function ordersOf(reference: IRunData, candidate: IRunData): Orders {
  const n8n = executionOrder(reference);
  const libpetri = executionOrder(candidate);
  return { n8n, libpetri, n8nRank: rankOf(n8n), libpetriRank: rankOf(libpetri) };
}

/** Activations only one engine ran, and which one. */
export function oneSidedOf(orders: Orders): Map<string, EngineName> {
  const oneSided = new Map<string, EngineName>();
  for (const key of orders.n8n) if (!orders.libpetriRank.has(key)) oneSided.set(key, 'n8n');
  for (const key of orders.libpetri) if (!orders.n8nRank.has(key)) oneSided.set(key, 'libpetri');
  return oneSided;
}

/** An activation both engines ran, with its rank in each. */
interface SharedRank {
  readonly key: string;
  readonly a: number;
  readonly b: number;
}

/** The activations both engines ran, with both ranks, in n8n's order: what a move is measured against. */
function sharedRanks(orders: Orders): SharedRank[] {
  const both: SharedRank[] = [];
  for (const [a, key] of orders.n8n.entries()) {
    const b = orders.libpetriRank.get(key);
    if (b !== undefined) both.push({ key, a, b });
  }
  return both;
}

/** An activation whose rank differs between the engines, or that only one of them ran. */
export interface RankMove {
  readonly activation: string;
  readonly n8nRank: number | undefined;
  readonly libpetriRank: number | undefined;
  /** The activations it passed, or that passed it; empty when it ran in one engine only. */
  readonly movedAgainst: readonly string[];
}

function movedAgainstOf(key: string, a: number | undefined, b: number | undefined, both: readonly SharedRank[]): string[] {
  if (a === undefined || b === undefined) return [];
  return both.filter((o) => o.key !== key && (o.a < a) !== (o.b < b)).map((o) => o.key);
}

/** Every activation whose rank differs, n8n's order first, then the net's own. */
export function rankMoves(orders: Orders): RankMove[] {
  const both = sharedRanks(orders);
  const moves: RankMove[] = [];
  for (const activation of new Set([...orders.n8n, ...orders.libpetri])) {
    const a = orders.n8nRank.get(activation);
    const b = orders.libpetriRank.get(activation);
    if (a === b) continue;
    moves.push({ activation, n8nRank: a, libpetriRank: b, movedAgainst: movedAgainstOf(activation, a, b, both) });
  }
  return moves;
}
