/**
 * One run of an `engineV2` net on libpetri's `PrecompiledNetExecutor`, read back as engine v2's
 * step rows (`tasks/v2-profile-plan.md` step 10). This is the net side of the lockstep leg and of
 * the per-firing leg of the differential (`tasks/v2-differential.mts`).
 *
 * **Rows come from what the net wrote, not from the policy.** The executor records each firing's
 * output tokens as `token-added` events immediately before its `transition-completed` (libpetri
 * 7.0.0, `PrecompiledNetExecutor`), so every firing's written place set is known, and a row is
 * derived from it:
 *
 * | firing | row |
 * |---|---|
 * | `X_start`, `B_start_*` | a new row of the node, `running`: the step is in flight |
 * | `X_skip`, `B_skip_*` | a new row, `skipped` |
 * | `X_run` writing `_halt` | the node's latest row `failed` |
 * | `X_run` otherwise | the latest row `completed`; a slot is filled when every `live` its edges write is among the written places |
 * | `X_route_o` | slot `o` of the latest row, by the same test |
 * | `B_run` | loop slot filled when it wrote no `B/ended`; else done slot filled when its edges' `live` were written |
 *
 * The slot test is exact under collapsed routing: the compiler splits a node whose fillings would
 * write one place set twice (step 5), so the written set has one filling, and it is the largest
 * set of slots whose `live` places it contains. A slot without edges is never observed and reads
 * unfilled; no planner reads it.
 *
 * A net run has no `queued` rows: the net does not tell a queued step from a running one, both
 * being a token on `X/running`.
 *
 * **Row-set points.** An executor trace passes through markings that are no row set: a transition
 * in flight (its inputs taken, nothing written yet) and a split run whose routes have not all
 * fired (`X/ok_o` marked). After every completed firing where neither holds, the run records a
 * {@link NetPoint}: the rows so far and the executor's marking.
 */
import { InMemoryEventStore, PrecompiledNetExecutor } from 'libpetri';
import type { Place, Token } from 'libpetri';
import { DONE_SLOT, InternalCompilerError, LOOP_SLOT } from '../../compiler/index.js';
import type { ActionBinder, CompiledWorkflow, SettlementEdge, SettlementGadget } from '../../compiler/index.js';
import type { StepRow } from '../../codec/v2/step-rows.js';

/** Tokens per place name; unmarked places are absent. */
export type PlaceCounts = Record<string, number>;

/** A point of a net run where the net's state is a row set. */
export interface NetPoint {
  /** The firings completed before this point. */
  readonly firings: number;
  /** Every row so far, a snapshot. */
  readonly rows: readonly StepRow[];
  /** The executor's marking here, from its token events. */
  readonly marking: PlaceCounts;
}

/** One {@link runV2}. */
export interface NetRun {
  /** The final rows, grouped by node in first-row order, each node's in iteration order. */
  readonly rows: readonly StepRow[];
  /** Every row-set point, the initial marking first. */
  readonly points: readonly NetPoint[];
  /** Firings completed. */
  readonly firings: number;
  /** Whether the final marking holds `_halt`: some run failed. */
  readonly halted: boolean;
  /** The final marking. */
  readonly marking: PlaceCounts;
}

/** The counts of a marking as the executors take it. */
export function countsOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): PlaceCounts {
  const out: PlaceCounts = {};
  for (const [p, tokens] of marking) if (tokens.length > 0) out[p.name] = tokens.length;
  return out;
}

type MutableRow = { -readonly [K in keyof StepRow]: StepRow[K] } & { filledOutputSlots: boolean[] };

/** Whether a filled slot's edges were written: every consumer's `live` among `written`, and at least one edge. */
function slotWritten(edges: readonly SettlementEdge[], written: ReadonlySet<string>): boolean {
  return edges.length > 0 && edges.every((e) => written.has(e.live.name));
}

function slotEdges(g: SettlementGadget, index: number): readonly SettlementEdge[] {
  return g.outputs.find((o) => o.index === index)?.edges ?? [];
}

/** `filledOutputSlots` with a slot per index up to the highest connected output, all unfilled. */
function emptySlots(g: SettlementGadget): boolean[] {
  const width = g.batch !== null ? 2 : g.outputs.reduce((n, o) => Math.max(n, o.index + 1), 0);
  return Array.from({ length: width }, () => false);
}

/**
 * Runs `compiled` bound to `actions` to quiescence on `PrecompiledNetExecutor`, from its initial
 * marking, and reads the trace back as rows (see the module doc). Throws if an action fails,
 * because the settlement actions never do.
 */
export async function runV2(compiled: CompiledWorkflow, actions: ActionBinder): Promise<NetRun> {
  const store = new InMemoryEventStore();
  const bound = compiled.withActions(actions);
  const initial = compiled.initialMarking(null);
  const executor = new PrecompiledNetExecutor(bound.net, initial, { eventStore: store, program: bound.program });
  await executor.run();

  const halt = compiled.netMap.halt.name;
  const marking = countsOf(initial);
  const rows = new Map<string, MutableRow[]>();
  const routesPending = new Map<string, number>();
  const written: string[] = [];
  let inFlight = 0;
  let firings = 0;
  const snapshot = (): StepRow[] =>
    [...rows.values()].flat().map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] }));
  const points: NetPoint[] = [{ firings: 0, rows: [], marking: { ...marking } }];

  for (const e of store.events()) {
    switch (e.type) {
      case 'token-added':
        marking[e.placeName] = (marking[e.placeName] ?? 0) + 1;
        written.push(e.placeName);
        continue;
      case 'token-removed':
        marking[e.placeName] = (marking[e.placeName] ?? 0) - 1;
        if (marking[e.placeName] === 0) delete marking[e.placeName];
        continue;
      case 'transition-started':
        inFlight++;
        continue;
      case 'transition-failed':
        throw new Error(`runV2: transition '${e.transitionName}' failed: ${e.errorMessage}`);
      case 'transition-completed':
        break;
      default:
        continue;
    }
    inFlight--;
    firings++;
    // The completing firing's own outputs are the `token-added` events just before it.
    const wrote = new Set(written.slice(written.length - e.producedTokens.length));
    written.length = 0;
    const info = compiled.netMap.transition(e.transitionName);
    if (info === undefined) throw new InternalCompilerError(`internal: transition '${e.transitionName}' is not in the NetMap`);
    const g = compiled.netMap.settlement(info.node);
    const own = rows.get(g.id) ?? [];
    rows.set(g.id, own);
    const latest = own[own.length - 1];
    switch (info.role) {
      case 'start':
      case 'skip':
        own.push({ nodeId: g.id, iteration: own.length, status: info.role === 'start' ? 'running' : 'skipped', filledOutputSlots: [] });
        break;
      case 'run': {
        if (latest === undefined || latest.status !== 'running') {
          throw new InternalCompilerError(`internal: '${e.transitionName}' completed with no running row of '${g.node}'`);
        }
        if (wrote.has(halt)) {
          latest.status = 'failed';
          break;
        }
        latest.status = 'completed';
        latest.filledOutputSlots = emptySlots(g);
        if (g.batch !== null) {
          if (!wrote.has(g.batch.ended.name)) latest.filledOutputSlots[LOOP_SLOT] = true;
          else latest.filledOutputSlots[DONE_SLOT] = slotWritten(slotEdges(g, DONE_SLOT), wrote);
        } else if (g.routing === 'split') {
          routesPending.set(g.id, g.outputs.length);
        } else {
          for (const o of g.outputs) latest.filledOutputSlots[o.index] = slotWritten(o.edges, wrote);
        }
        break;
      }
      case 'route': {
        if (latest === undefined || latest.status !== 'completed') {
          throw new InternalCompilerError(`internal: '${e.transitionName}' routed with no completed row of '${g.node}'`);
        }
        latest.filledOutputSlots[info.port] = slotWritten(slotEdges(g, info.port), wrote);
        routesPending.set(g.id, (routesPending.get(g.id) ?? 0) - 1);
        break;
      }
      default:
        throw new InternalCompilerError(`internal: an engineV2 net has no '${info.role}' transition ('${e.transitionName}')`);
    }
    if (inFlight === 0 && [...routesPending.values()].every((n) => n === 0)) {
      points.push({ firings, rows: snapshot(), marking: { ...marking } });
    }
  }
  return { rows: snapshot(), points, firings, halted: (marking[halt] ?? 0) > 0, marking: { ...marking } };
}
