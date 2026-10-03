/**
 * Compares the three live phases `scripts/testbed/diff-engines-v2.sh` runs after its sequential
 * manual runs, on the same server per leg: the paths ADR 0014 "Open" listed as unexercised.
 *
 * - **webhook**: production webhook requests, one at a time, answered with the last node
 *   (`responseMode: lastNode`, engine v2's `runEnd`) or by a Respond to Webhook node
 *   (`responseNode`, `stepResponse`). The HTTP status, headers and body are compared, and so are the
 *   rows the run left in the data plane.
 * - **concurrent**: a batch of manual runs and webhook requests in flight at once, so settlements of
 *   different executions interleave in one engine process.
 * - **cancel**: a manual run stopped through `POST /rest/executions/:id/stop` after a swept delay, so
 *   some cancels land while a settlement is in flight (divergence rows 35 and 36).
 *
 * Everything here is an **integration result** (`tasks/v2-seam-plan.md` decision 12). It is not a
 * conformance number, not a policy-entering case count, not a neutrality leg and not settlement
 * evidence, and no wall clock or latency in it is a result of any of those kinds.
 *
 * **How a run is compared.** Runs are not paired one to one: under concurrency the `off` leg's own
 * runs need not agree with each other (which sink ended a run, for one). For each workflow, the `off`
 * leg's runs in the phase form the reference pool, with the request tag replaced by `<tag>`; for the
 * concurrent phase, the `off` leg's sequential and webhook-phase runs of the workflow join the pool.
 * On a field where the pool is constant, every run of every leg must equal it, or it is a finding.
 * On a field where the pool varies, each leg's distribution is reported and nothing is a finding. The
 * fields: execution status, row count, fates, filled slots, normalised outputs and the `ended`
 * lastStep (`compare-v2.ts`' `observe`), and for webhook runs the HTTP status, the headers other
 * than the volatile ones, and the body.
 *
 * **The ending is judged from the ledger, not from the pool.** Which settlement ends a run (its
 * lastStep, and under `runEnd` the HTTP body) is the one field that depends on the policy, and the
 * `off` pool is only a sample of interleavings: when it happens to be constant, an ending n8n's
 * default would produce just as well on another interleaving differs from it. So in a leg where ours
 * answers, every run's ending is accounted from its own settlements (`endingAccount`):
 * - **n8n ends here too**: the ending settlement's `isFinished` said true, and no earlier settlement
 *   of the run reused its snapshot and said false. A reused true implies a fresh count says true on
 *   the same rows (row 39's theorem, `tasks/v2-seam-plan.md`, "Step 12, rerun"), and n8n's default
 *   reads afresh, so on this interleaving it ends the run at the same settlement.
 * - **row 39**: an earlier settlement reused its snapshot and said false, so n8n's fresh count could
 *   have said true there and ended the run earlier. Where a shadow check ran beside it, its fresh
 *   answer decides: `false` removes the occasion, `true` confirms it (`stale`).
 * - **failure path**: the run ended `failed`; who writes that ending is row 37's question, not this.
 * - **unaccounted** (a finding): more than one settlement ended the run, or one ended it `completed`
 *   without an `isFinished` that said true.
 * A lastStep off a constant pool is then a note when the run's ending is accounted, and the body
 * difference of that run is a note with it when the body is the ending step's first item
 * (`bodyFollowsEnding`); otherwise both are findings. A `runEnd` body that is not the ending step's
 * first item is a finding in every leg. In a leg where n8n's default answers (`off`, `shadow`), a
 * lastStep or body off the pool is n8n's own interleaving and is a note (`N8N_ANSWERS`).
 *
 * **What is checked, per phase and leg.** Policy calls against settled non-failed rows
 * (`accountCalls`), executions left live, shadow verdicts (`disagree` and `candidate-threw` are
 * findings; `stale` and `race` are counted), `settlement policy error` (a finding), snapshot binding
 * (`crossed` is a finding) and overruns, and latency per settlement. For the concurrent phase, how
 * many executions were in flight at once, how often consecutive settlements belonged to different
 * executions, and per round how the schedule fell (`roundSchedule`): the client's start spread, the
 * window in which every execution was in flight, and the contiguous settlement blocks, whose
 * sequence says whether two rounds ran the same schedule. For the cancel phase, per run: the stop
 * response (a refusal must be n8n's "Only running or waiting executions can be stopped" for a run
 * that ended otherwise), the end status (`cancelled` when the stop was accepted), no row `queued`,
 * `running` or `waiting` left, and where the cancel's compare-and-set landed against the settlement
 * of that execution then in flight (before its liveness read, between that read and the policy's
 * first read, between that read and `createSteps`, after `createSteps`, or with none in flight); the
 * named races; the rows created after the cancel, and how they were cancelled (`cancelledAtClaim`);
 * the policy calls that read a cancelled row set, with what they answered; and the shadow `stale`
 * verdicts that row 36's second clause explains (`staleDuringCancel`).
 *
 *   npx tsx tests/testbed/compare-v2-live.ts <out-dir> <leg> [<leg> ...]   # the first leg is the reference
 *
 * Writes `<out-dir>/live-report.md` and `<out-dir>/live-summary.json`, prints the report, and exits 1
 * on a finding.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountCalls, binding, canonical, latency, observe } from './compare-v2.js';
import type {
  CallAccount, CancelRecord, CancelStepRecord, DiagnosticRecord, Distribution, LedgerRecord, Observed, SettlementRecord, ShadowRecord, SqlExecution,
} from './compare-v2.js';

// ---- inputs ---------------------------------------------------------------------------------------

export type Phase = 'webhook' | 'concurrent' | 'cancel';
export const PHASES: readonly Phase[] = ['webhook', 'concurrent', 'cancel'];

export interface Http {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly elapsedMs: number;
}

/** One `drive-v2.mjs` capture. */
export interface Capture {
  readonly phase: Phase;
  readonly key: string;
  readonly workflow: string;
  /** Manual runs. */
  readonly executionId?: string;
  readonly restStatus?: string;
  /** Webhook runs: the request's tag, and what came back. */
  readonly tag?: string;
  readonly responseMode?: string;
  readonly http?: Http;
  /** Cancel runs. */
  readonly delayMs?: number;
  readonly stop?: { status: number; ok: boolean; body: unknown };
  readonly elapsedMs?: number;
  /** Concurrent runs: the round, and when the client started the run, in ms from the round's start. */
  readonly round?: number;
  readonly startedAtMs?: number;
}

export interface LiveLeg {
  readonly label: string;
  readonly captures: readonly Capture[];
  /** Every execution of the live phases (`live-sql.json`). */
  readonly executions: ReadonlyMap<string, SqlExecution>;
  readonly ledger: readonly LedgerRecord[];
  /** The sequential phase's runs of the leg, for the concurrent phase's reference pool. */
  readonly sequential: readonly { workflow: string; execution: SqlExecution }[];
}

// ---- resolving a capture to its execution ---------------------------------------------------------

/**
 * The execution a capture is about: its id when it has one, otherwise the one execution whose rows
 * hold `"tag":"<tag>"` (the Webhook node's output, and every node that copied it). Throws when the
 * tag matches no execution or more than one.
 */
export function resolveExecution(capture: Capture, executions: ReadonlyMap<string, SqlExecution>): SqlExecution | null {
  if (capture.executionId !== undefined) return executions.get(capture.executionId) ?? null;
  if (capture.tag === undefined) return null;
  const needle = `"tag":${JSON.stringify(capture.tag)}`;
  const found = [...executions.values()].filter((e) => e.steps.some((s) => JSON.stringify(s.outputs ?? null).includes(needle)));
  if (found.length > 1) throw new Error(`tag ${capture.tag} matches ${found.length} executions: ${found.map((e) => e.id).join(', ')}`);
  return found[0] ?? null;
}

// ---- observations ---------------------------------------------------------------------------------

/** Headers that change with the moment or with the body's byte count, not with what was answered. */
export const VOLATILE_HEADERS: ReadonlySet<string> = new Set(['date', 'etag', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

export interface LiveObserved extends Observed {
  readonly httpStatus: string;
  readonly httpHeaders: string;
  readonly httpBody: string;
}

export type LiveField = keyof LiveObserved;
export const LIVE_FIELDS: readonly LiveField[] = ['status', 'rows', 'fates', 'slots', 'outputs', 'lastStep', 'httpStatus', 'httpHeaders', 'httpBody'];

/** Every occurrence of `tag` replaced by `<tag>`, so runs with different tags compare. */
export function untag(text: string, tag: string | undefined): string {
  return tag === undefined || tag === '' ? text : text.split(tag).join('<tag>');
}

export function observeLive(execution: SqlExecution, settlements: readonly SettlementRecord[], capture: Pick<Capture, 'tag' | 'http'>): LiveObserved {
  const o = observe(execution, settlements);
  const t = (s: string) => untag(s, capture.tag);
  const http = capture.http;
  const headers = http === undefined
    ? 'none'
    : canonical(Object.fromEntries(Object.entries(http.headers).filter(([k]) => !VOLATILE_HEADERS.has(k.toLowerCase())).sort()));
  return {
    status: o.status,
    rows: o.rows,
    fates: o.fates,
    slots: o.slots,
    outputs: o.outputs.map(t),
    lastStep: o.lastStep,
    httpStatus: http === undefined ? 'none' : String(http.status),
    httpHeaders: headers,
    httpBody: http === undefined ? 'none' : t(http.body),
  };
}

const valueOf = (o: LiveObserved, f: LiveField) => canonical(o[f]);

/**
 * The legs in which n8n's `defaultSettlementPolicy` answers. Which settlement ends a run (its
 * lastStep, and under `runEnd` the body) depends on interleaving there too, and the `off` pool need
 * not have seen every interleaving a slower leg produces (in `shadow` each call also runs ours, which
 * shifts the step worker against the handler). A difference on those two fields in these legs is
 * n8n's own variation, a note; in a leg where ours answers it is a note only when the run's ending is
 * accounted (`endingAccount`).
 */
export const N8N_ANSWERS: ReadonlySet<string> = new Set(['off', 'shadow']);

// ---- row 39 ---------------------------------------------------------------------------------------

/**
 * Whether the settlement's `isFinished` answered from the snapshot its `decideSuccessors` read: the
 * policy's own `reused` event, or, in a ledger without snapshot events, a call that read nothing. The
 * event decides when present, because in a shadow leg the call's round trips include the other side's.
 */
export function reusedIsFinished(r: SettlementRecord): boolean {
  if (r.snapshots !== undefined && r.snapshots.length > 0) return r.snapshots.some((e) => e.method === 'isFinished' && e.event === 'reused');
  return r.policy.some((c) => c.method === 'isFinished' && c.roundTrips === 0);
}

/**
 * Whether a lastStep that differs from `expected` (an `observe` lastStep, `"<status> <node>@<i>
 * <step status>"`) is row 39's moved ending: the settlement of `expected`'s step called
 * `isFinished`, read nothing, was answered `false`, did not end the run, and a later settlement of
 * the execution did.
 */
export function endingMoved(execution: SqlExecution, settlements: readonly SettlementRecord[], expected: string): boolean {
  const m = /^\S+ (.+)@(\d+) \S+$/.exec(expected);
  if (!m) return false;
  const [, nodeName, iteration] = m;
  const ids = new Set(execution.nodes.filter((n) => n.name === nodeName).map((n) => n.id));
  const own = settlements.filter((r) => r.executionId === execution.id);
  const at = own.find((r) => r.step !== null && ids.has(r.step.nodeId) && r.step.iteration === Number(iteration));
  if (at === undefined || at.ended !== null) return false;
  const reusedFalse = reusedIsFinished(at) && at.policy.some((c) => c.method === 'isFinished' && c.result === false);
  if (!reusedFalse) return false;
  const ender = own.find((r) => r.ended !== null);
  return ender !== undefined && (ender.t0 === undefined || at.t0 === undefined || ender.t0 > at.t0);
}

// ---- shadow reports, linked to their settlement ---------------------------------------------------

export interface ShadowLinks {
  readonly bySettlement: ReadonlyMap<SettlementRecord, readonly ShadowRecord[]>;
  /** Reports with no settlement record of their execution right after them. */
  readonly unlinked: readonly ShadowRecord[];
}

/**
 * Each shadow report with the settlement it was made in. The shadow policy reports inside the call,
 * before the call returns (`createShadowPolicy`), the instrument writes a settlement's record when its
 * handler ends, and in-process handlers run one at a time (`InMemoryWorkQueue`). So a report belongs
 * to the next settlement record in the ledger, which must be of the report's execution; a report
 * without one is unlinked.
 */
export function linkShadows(ledger: readonly LedgerRecord[]): ShadowLinks {
  const bySettlement = new Map<SettlementRecord, ShadowRecord[]>();
  const unlinked: ShadowRecord[] = [];
  let pending: ShadowRecord[] = [];
  for (const r of ledger) {
    if (r.kind === 'shadow') { pending.push(r); continue; }
    if (r.kind !== 'settlement') continue;
    const mine = pending.filter((s) => s.report.executionId === r.executionId);
    if (mine.length > 0) bySettlement.set(r, mine);
    unlinked.push(...pending.filter((s) => s.report.executionId !== r.executionId));
    pending = [];
  }
  unlinked.push(...pending);
  return { bySettlement, unlinked };
}

/** The answer of the side that read afresh in a settlement's shadowed `isFinished`, if one was linked. */
export function freshIsFinished(links: ShadowLinks, r: SettlementRecord): boolean | undefined {
  const report = (links.bySettlement.get(r) ?? []).find((s) => s.report.method === 'isFinished')?.report;
  if (report === undefined) return undefined;
  const fresh = report.reused === 'primary' ? report.candidate : report.primary;
  return typeof fresh === 'boolean' ? fresh : undefined;
}

// ---- the ending, judged from the ledger -----------------------------------------------------------

export type EndingKind = 'n8n ends here too' | 'row 39' | 'failure path' | 'no ending' | 'unaccounted';
export const ENDING_KINDS: readonly EndingKind[] = ['n8n ends here too', 'row 39', 'failure path', 'no ending', 'unaccounted'];

export interface EndingAccount {
  readonly kind: EndingKind;
  /** How the ending settlement's `isFinished` said true: from its reused snapshot, or reading afresh. */
  readonly enderTrue: 'reused' | 'fresh' | null;
  /**
   * Earlier settlements of the run whose `isFinished` reused its snapshot and said false, less those
   * where a shadow check's fresh count also said false: each is where n8n's default could have ended
   * the run instead.
   */
  readonly occasions: number;
  /** Of those, the ones where a shadow check's fresh count said true: n8n's default would have ended there. */
  readonly confirmed: number;
  readonly why: string;
}

/**
 * How the run's ending came about, from its own settlements in ledger order (see the module doc,
 * "The ending is judged from the ledger"). `fresh` gives the fresh side's `isFinished` answer at a
 * settlement where a shadow check ran beside it.
 */
export function endingAccount(
  execution: SqlExecution,
  settlements: readonly SettlementRecord[],
  fresh: (r: SettlementRecord) => boolean | undefined = () => undefined,
): EndingAccount {
  const own = settlements.filter((r) => r.executionId === execution.id);
  const enders = own.filter((r) => r.ended !== null);
  const none = { enderTrue: null, occasions: 0, confirmed: 0 } as const;
  if (enders.length === 0) return { kind: 'no ending', ...none, why: 'no settlement ended the run' };
  if (enders.length > 1) return { kind: 'unaccounted', ...none, why: `${enders.length} settlements ended the run` };
  const ender = enders[0]!;
  if (ender.ended!.status === 'failed') return { kind: 'failure path', ...none, why: 'the run ended failed' };
  if (!ender.policy.some((c) => c.method === 'isFinished' && c.result === true)) {
    return { kind: 'unaccounted', ...none, why: `the ending settlement ended the run ${ender.ended!.status} without an isFinished that said true` };
  }
  const enderTrue = reusedIsFinished(ender) ? 'reused' : 'fresh';
  const before = own.slice(0, own.indexOf(ender));
  const occasions = before.filter((r) => reusedIsFinished(r) && r.policy.some((c) => c.method === 'isFinished' && c.result === false) && fresh(r) !== false);
  const confirmed = occasions.filter((r) => fresh(r) === true).length;
  return occasions.length === 0
    ? { kind: 'n8n ends here too', enderTrue, occasions: 0, confirmed: 0, why: `the ending settlement's isFinished said true (${enderTrue}) and no earlier reused false` }
    : { kind: 'row 39', enderTrue, occasions: occasions.length, confirmed, why: `${occasions.length} earlier settlements reused their snapshot and said false (${confirmed} confirmed by a fresh count that said true)` };
}

/**
 * Whether a `runEnd` answer is the ending step's first output item, which is what n8n's `lastNode`
 * response sends (`responseData: firstEntryJson`). `null` when it does not apply: no HTTP answer, not
 * `runEnd`, not a 2xx, or no settlement ended the run.
 */
export function bodyFollowsEnding(execution: SqlExecution, settlements: readonly SettlementRecord[], http: Http | undefined): boolean | null {
  if (http === undefined || execution.responseKind !== 'runEnd' || http.status < 200 || http.status >= 300) return null;
  const ender = settlements.find((r) => r.executionId === execution.id && r.ended !== null);
  if (ender === undefined) return null;
  const { nodeId, iteration } = ender.ended!.lastStep;
  const outputs = execution.steps.find((s) => s.nodeId === nodeId && s.iteration === iteration)?.outputs;
  const slot = Array.isArray(outputs) ? outputs[0] : undefined;
  const first = Array.isArray(slot) ? (slot[0] as { json?: unknown } | undefined) : undefined;
  if (first === undefined) return false;
  try {
    return canonical(JSON.parse(http.body)) === canonical(first.json);
  } catch {
    return false;
  }
}

// ---- concurrency ----------------------------------------------------------------------------------

export interface Interleaving {
  readonly executions: number;
  /** Most executions whose first-to-last settlement spans overlap at one instant. */
  readonly maxInFlight: number;
  readonly settlements: number;
  /** Consecutive settlements (by start) that belong to different executions. */
  readonly switches: number;
}

export function interleaving(records: readonly SettlementRecord[]): Interleaving {
  const timed = records.filter((r) => r.t0 !== undefined && r.t1 !== undefined).sort((a, b) => a.t0! - b.t0!);
  const spans = new Map<string, { from: number; to: number }>();
  for (const r of timed) {
    const s = spans.get(r.executionId);
    if (s === undefined) spans.set(r.executionId, { from: r.t0!, to: r.t1! });
    else { s.from = Math.min(s.from, r.t0!); s.to = Math.max(s.to, r.t1!); }
  }
  const edges = [...spans.values()].flatMap((s) => [[s.from, 1], [s.to, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, maxInFlight = 0;
  for (const [, d] of edges) { live += d; maxInFlight = Math.max(maxInFlight, live); }
  let switches = 0;
  for (let i = 1; i < timed.length; i++) if (timed[i]!.executionId !== timed[i - 1]!.executionId) switches++;
  return { executions: spans.size, maxInFlight, settlements: timed.length, switches };
}

/** One concurrent round: how its schedule fell. */
export interface RoundSchedule {
  readonly round: number;
  readonly executions: number;
  /** Latest minus earliest client start in the round, in ms; `null` when the captures carry none. */
  readonly startSpreadMs: number | null;
  /**
   * The window in which every execution of the round was in flight: the earliest last settlement's end
   * minus the latest first settlement's start, in ms. Negative when there is no such instant.
   */
  readonly commonOverlapMs: number;
  /** Maximal runs of consecutive settlements (by start) of one execution. */
  readonly blocks: number;
  /** The workflows of those blocks in order. Two rounds with the same sequence ran the same schedule. */
  readonly sequence: string;
  /** Per workflow, the blocks of each of its executions in the round, sorted. */
  readonly blocksPerExecution: Readonly<Record<string, readonly number[]>>;
}

export function roundSchedule(round: number, records: readonly SettlementRecord[], members: readonly { executionId: string; workflow: string; startedAtMs?: number }[]): RoundSchedule {
  const workflowOf = new Map(members.map((m) => [m.executionId, m.workflow]));
  const timed = records.filter((r) => workflowOf.has(r.executionId) && r.t0 !== undefined && r.t1 !== undefined).sort((a, b) => a.t0! - b.t0!);
  const spans = new Map<string, { from: number; to: number }>();
  for (const r of timed) {
    const s = spans.get(r.executionId);
    if (s === undefined) spans.set(r.executionId, { from: r.t0!, to: r.t1! });
    else { s.from = Math.min(s.from, r.t0!); s.to = Math.max(s.to, r.t1!); }
  }
  const sequence: string[] = [];
  const perExecution = new Map<string, number>();
  for (let i = 0; i < timed.length; i++) {
    const id = timed[i]!.executionId;
    if (i > 0 && timed[i - 1]!.executionId === id) continue;
    sequence.push(workflowOf.get(id)!);
    perExecution.set(id, (perExecution.get(id) ?? 0) + 1);
  }
  const blocksPerExecution: Record<string, number[]> = {};
  for (const [id, n] of perExecution) (blocksPerExecution[workflowOf.get(id)!] ??= []).push(n);
  for (const list of Object.values(blocksPerExecution)) list.sort((a, b) => a - b);
  const starts = members.flatMap((m) => (m.startedAtMs === undefined ? [] : [m.startedAtMs]));
  const ends = [...spans.values()];
  return {
    round,
    executions: spans.size,
    startSpreadMs: starts.length === 0 ? null : Math.max(...starts) - Math.min(...starts),
    commonOverlapMs: ends.length === 0 ? Number.NaN : Math.min(...ends.map((s) => s.to)) - Math.max(...ends.map((s) => s.from)),
    blocks: sequence.length,
    sequence: sequence.join(' > '),
    blocksPerExecution,
  };
}

// ---- cancel ---------------------------------------------------------------------------------------

export type Landing =
  | 'no settlement in flight'
  | 'before the liveness read'
  | 'between the liveness read and the policy read'
  | 'between the policy read and createSteps'
  | 'after the policy read, no createSteps'
  | 'after createSteps';
export const LANDINGS: readonly Landing[] = [
  'no settlement in flight', 'before the liveness read', 'between the liveness read and the policy read',
  'between the policy read and createSteps', 'after the policy read, no createSteps', 'after createSteps',
];

/** Where the cancel's compare-and-set (`at`) landed against the execution's settlement then in flight. */
export function landing(at: number, settlements: readonly SettlementRecord[]): { landing: Landing; settlement: SettlementRecord | null } {
  const inFlight = settlements.find((r) => r.t0 !== undefined && r.t1 !== undefined && r.t0 <= at && at <= r.t1);
  if (inFlight === undefined) return { landing: 'no settlement in flight', settlement: null };
  const { tLoaded, tRead, tCreate } = inFlight;
  if (tLoaded === null || tLoaded === undefined || at < tLoaded) return { landing: 'before the liveness read', settlement: inFlight };
  if (tRead === null || tRead === undefined || at < tRead) {
    // A handler that returned before planning (an ended execution, a failure found) has no read.
    return { landing: tCreate !== null && tCreate !== undefined && at >= tCreate ? 'after createSteps' : 'between the liveness read and the policy read', settlement: inFlight };
  }
  if (tCreate === null || tCreate === undefined) return { landing: 'after the policy read, no createSteps', settlement: inFlight };
  return { landing: at < tCreate ? 'between the policy read and createSteps' : 'after createSteps', settlement: inFlight };
}

/** n8n's refusal of a stop for a run that is no longer running or waiting (`ExecutionService.stop`). */
export const ENDED_REFUSAL = 'Only running or waiting executions can be stopped';

export interface CancelAccount {
  readonly runs: number;
  readonly accepted: number;
  /**
   * The stop was refused with n8n's `ENDED_REFUSAL` and the run ended other than `cancelled`. A
   * refusal for any other reason, or on a run that ended `cancelled`, is broken.
   */
  readonly endedFirst: number;
  readonly byLanding: Readonly<Record<Landing, number>>;
  /** Cancels whose CAS landed after the liveness read and before `createSteps` (or before the handler planned nothing). */
  readonly inWindow: number;
  /** Of those, the ones whose `cancelPendingSteps` answered before the policy's first read. */
  readonly pendingBeforeRead: number;
  /** Rows `createSteps` inserted after the cancel's CAS, by asked status. */
  readonly createdAfterCancel: { queued: number; skipped: number };
  /**
   * Of the queued ones whose row ended `cancelled`, those only `StepReadyHandler`'s `cancelStep` can
   * have cancelled: the ledger's `cancel-step` record names the row, or, in a ledger without those
   * records, `createSteps` was called after `cancelPendingSteps` answered, so the bulk update's
   * statement had finished before the insert began.
   */
  readonly cancelledAtClaim: number;
  /** Ended `cancelled` with no `cancel-step` record, in a ledger that has them: `cancelPendingSteps`' bulk update. */
  readonly cancelledByBulk: number;
  /**
   * Ended `cancelled` in a ledger without `cancel-step` records, with `createSteps` called before
   * `cancelPendingSteps` answered: either path, which the instrument does not tell apart.
   */
  readonly cancelledEitherPath: number;
  /** Policy calls whose reads held a cancelled row and no failed one, and what they answered. */
  readonly cancelSeen: { decide: number; decidePlanned: number; isFinished: number; isFinishedTrue: number };
  /** `isFinished` said finished in a settlement that did not end the run, on a cancelled execution. */
  readonly finishedLostToCancel: number;
  readonly raceDiagnostics: number;
  /**
   * Shadow `stale` verdicts that row 36's second clause explains, each checked on its own settlement
   * (`linkShadows`): that settlement reused its snapshot in `isFinished`, the cancel's CAS landed inside
   * it, and the execution's final rows hold a `cancelled` row. The fresh count said true, and n8n's
   * count can only reach its total when every row is settled (`countExpectedSettledSteps`: rows are
   * unique per node and pass and never unsettle), so the rows it read were the final ones, a
   * `cancelled` row among them: it read after the cancel, and counted a row the cancel had cancelled.
   * n8n's `finishExecution` then loses to the cancel. The shadow check names a race only from rows a
   * side read, and a count returns no rows, so it labels these `stale`.
   */
  readonly staleDuringCancel: number;
  /** The run's other `stale` verdicts: row 39's occasion, a step that settled between the snapshot and `isFinished`. */
  readonly staleOther: number;
  /** Runs whose end status or leftover rows break the invariants (findings). */
  readonly broken: readonly string[];
}

const PENDING = new Set(['queued', 'running', 'waiting']);

export function accountCancels(captures: readonly Capture[], executions: ReadonlyMap<string, SqlExecution>, ledger: readonly LedgerRecord[]): CancelAccount {
  const settlements = ledger.filter((r): r is SettlementRecord => r.kind === 'settlement');
  const cancels = ledger.filter((r): r is CancelRecord => r.kind === 'cancel');
  /** The rows `StepReadyHandler` cancelled at claim, by id, when the instrument recorded them. */
  const claimRecorded = ledger.some((r) => r.kind === 'cancel-step');
  const claimed = new Set(ledger.filter((r): r is CancelStepRecord => r.kind === 'cancel-step' && r.won).map((r) => r.stepId));
  const links = linkShadows(ledger);
  const byLanding = Object.fromEntries(LANDINGS.map((l) => [l, 0])) as Record<Landing, number>;
  let accepted = 0, endedFirst = 0, inWindow = 0, pendingBeforeRead = 0, finishedLostToCancel = 0, raceDiagnostics = 0;
  let cancelledAtClaim = 0, cancelledByBulk = 0, cancelledEitherPath = 0, staleDuringCancel = 0, staleOther = 0;
  const createdAfterCancel = { queued: 0, skipped: 0 };
  const cancelSeen = { decide: 0, decidePlanned: 0, isFinished: 0, isFinishedTrue: 0 };
  const broken: string[] = [];

  for (const c of captures) {
    const e = c.executionId === undefined ? undefined : executions.get(c.executionId);
    if (e === undefined) { broken.push(`${c.key}: execution ${c.executionId ?? '?'} is not in the data plane dump`); continue; }
    const left = e.steps.filter((s) => PENDING.has(s.status));
    if (left.length > 0) broken.push(`${c.key}: ${left.length} rows left ${[...new Set(left.map((s) => s.status))].join('/')} in a ${e.status} execution`);
    if (PENDING.has(e.status)) broken.push(`${c.key}: execution ended \`${e.status}\``);
    if (c.stop?.ok === true) {
      accepted++;
      if (e.status !== 'cancelled') broken.push(`${c.key}: the stop was accepted but the execution is \`${e.status}\``);
    } else if (c.stop === undefined) {
      broken.push(`${c.key}: no stop response was captured`);
    } else {
      const body = typeof c.stop.body === 'string' ? c.stop.body : JSON.stringify(c.stop.body ?? null);
      if (e.status === 'cancelled') broken.push(`${c.key}: the stop was refused (${c.stop.status}) but the execution is \`cancelled\``);
      else if (!body.includes(ENDED_REFUSAL)) broken.push(`${c.key}: the stop was refused (${c.stop.status}) for another reason than the run having ended: ${clip(body, 160)}`);
      else endedFirst++;
    }

    const own = settlements.filter((r) => r.executionId === e.id);
    const won = cancels.find((r) => r.executionId === e.id && r.won === true && r.tCas !== null);
    for (const r of own) {
      for (const call of r.policy) {
        if (call.cancelSeen !== true) continue;
        if (call.method === 'decideSuccessors') {
          cancelSeen.decide++;
          if (typeof call.result === 'object' && call.result !== null && call.result.queue + call.result.skip > 0) cancelSeen.decidePlanned++;
        } else {
          cancelSeen.isFinished++;
          if (call.result === true) cancelSeen.isFinishedTrue++;
        }
      }
    }
    raceDiagnostics += ledger.filter((r) => r.kind === 'race' && (r as DiagnosticRecord).executionId === e.id && (r as DiagnosticRecord).race === 'cancel').length;

    // Each stale verdict on its own settlement: row 36's second clause only where that settlement
    // reused its snapshot, the cancel's CAS landed inside it, and a cancelled row is among the rows
    // the fresh count must have read (see `staleDuringCancel`).
    const hasCancelledRow = e.steps.some((s) => s.status === 'cancelled');
    for (const r of own) {
      for (const shadow of links.bySettlement.get(r) ?? []) {
        if (shadow.report.verdict !== 'stale') continue;
        const inside = won !== undefined && r.t0 !== undefined && r.t1 !== undefined && r.t0 <= won.tCas! && won.tCas! <= r.t1;
        if (inside && reusedIsFinished(r) && hasCancelledRow) staleDuringCancel++;
        else staleOther++;
      }
    }
    staleOther += links.unlinked.filter((s) => s.report.executionId === e.id && s.report.verdict === 'stale').length;
    if (won === undefined) continue;

    const at = won.tCas!;
    const l = landing(at, own);
    byLanding[l.landing]++;
    if (l.landing === 'between the liveness read and the policy read' || l.landing === 'between the policy read and createSteps' || l.landing === 'after the policy read, no createSteps') {
      inWindow++;
      if (won.tPending !== null && l.settlement?.tRead !== null && l.settlement?.tRead !== undefined && won.tPending < l.settlement.tRead) pendingBeforeRead++;
    }
    const createdQueued = new Map<string, { id?: string; tCreate: number }>();
    for (const r of own) {
      if (r.tCreate === null || r.tCreate === undefined || r.tCreate < at) continue;
      for (const row of r.created ?? []) {
        if (row.status === 'queued') { createdAfterCancel.queued++; createdQueued.set(`${row.nodeId}@${row.iteration}`, { ...(row.id === undefined ? {} : { id: row.id }), tCreate: r.tCreate }); }
        else if (row.status === 'skipped') createdAfterCancel.skipped++;
      }
      if (r.ended === null && r.policy.some((p) => p.method === 'isFinished' && p.result === true)) finishedLostToCancel++;
    }
    for (const s of e.steps) {
      const row = s.status === 'cancelled' ? createdQueued.get(`${s.nodeId}@${s.iteration}`) : undefined;
      if (row === undefined) continue;
      if (claimRecorded) {
        if (row.id !== undefined && claimed.has(row.id)) cancelledAtClaim++;
        else cancelledByBulk++;
      } else if (won.tPending !== null && row.tCreate > won.tPending) cancelledAtClaim++;
      else cancelledEitherPath++;
    }
  }
  return {
    runs: captures.length, accepted, endedFirst, byLanding, inWindow, pendingBeforeRead, createdAfterCancel,
    cancelledAtClaim, cancelledByBulk, cancelledEitherPath, cancelSeen, finishedLostToCancel, raceDiagnostics, staleDuringCancel, staleOther, broken,
  };
}

// ---- loading ------------------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadLiveLeg(dir: string, label: string): LiveLeg {
  const captures: Capture[] = [];
  for (const phase of PHASES) {
    const d = join(dir, phase);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) captures.push(readJson<Capture>(join(d, f)));
  }
  const live = existsSync(join(dir, 'live-sql.json')) ? readJson<{ executions: SqlExecution[] }>(join(dir, 'live-sql.json')).executions : [];
  const ledgerPath = join(dir, 'settlement.jsonl');
  const ledger = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRecord)
    : [];
  const sequential: { workflow: string; execution: SqlExecution }[] = [];
  if (existsSync(join(dir, 'sql.json')) && existsSync(join(dir, 'runs'))) {
    const seq = new Map(readJson<{ executions: SqlExecution[] }>(join(dir, 'sql.json')).executions.map((e) => [e.id, e]));
    for (const f of readdirSync(join(dir, 'runs')).filter((x) => x.endsWith('.json')).sort()) {
      const run = readJson<{ workflow: string; executionId: string }>(join(dir, 'runs', f));
      const e = seq.get(run.executionId);
      if (e !== undefined) sequential.push({ workflow: run.workflow, execution: e });
    }
  }
  return { label, captures, executions: new Map(live.map((e) => [e.id, e])), ledger, sequential };
}

// ---- the report ---------------------------------------------------------------------------------

export interface PhaseSummary {
  readonly phase: Phase;
  readonly legs: Readonly<Record<string, {
    readonly runs: number;
    readonly calls: Pick<CallAccount, 'settledNonFailed' | 'decideCalls' | 'isFinishedCalls' | 'endedFirst' | 'failureFirst' | 'unexplained'>;
    readonly shadow: Readonly<Record<string, number>>;
    readonly races: { failure: number; cancel: number };
    readonly errors: number;
    readonly binding: ReturnType<typeof binding>;
    readonly handlerMs: Distribution;
    readonly policyMs: Distribution;
    readonly maxRoundTrips: number;
    readonly interleaving?: Interleaving;
    readonly schedules?: readonly RoundSchedule[];
    readonly cancel?: Omit<CancelAccount, 'broken'>;
    /** Runs whose lastStep was off a constant pool and attributed to row 39. */
    readonly row39: number;
    /** Every run's ending, in a leg where ours answers (`endingAccount`); absent where n8n's default answers. */
    readonly endings?: Readonly<Record<EndingKind, number>> & { readonly reusedTrue: number; readonly confirmed: number };
  }>>;
  /** Per workflow and field, each leg's value counts, where the pool varies or a leg differs from it. */
  readonly distributions: readonly { workflow: string; field: LiveField; byLeg: Readonly<Record<string, Readonly<Record<string, number>>>> }[];
}

export interface LiveSummary {
  readonly legs: readonly string[];
  readonly phases: readonly PhaseSummary[];
  readonly findings: readonly string[];
  readonly notes: readonly string[];
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The concurrent phase's rounds of one leg, each with its schedule (captures without a round are left out). */
export function schedulesOf(runs: readonly { capture: Capture; execution: SqlExecution | null }[], settlements: readonly SettlementRecord[]): RoundSchedule[] {
  const rounds = new Map<number, { executionId: string; workflow: string; startedAtMs?: number }[]>();
  for (const { capture, execution } of runs) {
    if (execution === null || capture.round === undefined) continue;
    const list = rounds.get(capture.round) ?? [];
    rounds.set(capture.round, list);
    list.push({ executionId: execution.id, workflow: capture.workflow, ...(capture.startedAtMs === undefined ? {} : { startedAtMs: capture.startedAtMs }) });
  }
  return [...rounds].sort(([a], [b]) => a - b).map(([round, members]) => roundSchedule(round, settlements, members));
}

const fmt = (x: number) => (Number.isNaN(x) ? '–' : x < 10 ? x.toFixed(2) : x.toFixed(1));
const dist = (d: Distribution) => `${fmt(d.p50)} / ${fmt(d.p95)} / ${fmt(d.p99)} / ${fmt(d.max)} (n ${d.n})`;

export function compareLive(legs: readonly LiveLeg[]): { markdown: string; summary: LiveSummary } {
  const [reference] = legs;
  if (reference === undefined) throw new Error('compareLive: no legs');
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);
  const findings: string[] = [];
  const notes: string[] = [];
  const phases: PhaseSummary[] = [];
  const linksOf = new Map(legs.map((l) => [l.label, linkShadows(l.ledger)]));
  const freshOf = (leg: LiveLeg) => (r: SettlementRecord) => freshIsFinished(linksOf.get(leg.label)!, r);

  out('# diff-engines-v2: the live phases (webhook, concurrent, cancel)');
  out();
  out('Integration results from the live testbed (decision 12). Not conformance numbers, not policy-entering');
  out('case counts, not neutrality legs, not settlement evidence. Latencies and wall clocks are what this run');
  out('measured on one machine.');
  out();
  out(`Legs: ${legs.map((l) => `\`${l.label}\``).join(', ')}. Reference pool: \`${reference.label}\`.`);
  out();

  for (const phase of PHASES) {
    const present = legs.filter((l) => l.captures.some((c) => c.phase === phase));
    if (present.length === 0) continue;
    out(`## Phase: ${phase}`);
    out();

    // Resolve every capture of the phase to its execution.
    const resolved = new Map<string, { capture: Capture; execution: SqlExecution | null }[]>();
    for (const leg of legs) {
      const list: { capture: Capture; execution: SqlExecution | null }[] = [];
      for (const capture of leg.captures.filter((c) => c.phase === phase)) {
        let execution: SqlExecution | null = null;
        try {
          execution = resolveExecution(capture, leg.executions);
        } catch (error) {
          findings.push(`${phase} / ${leg.label} / ${capture.key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (execution === null) findings.push(`${phase} / ${leg.label} / ${capture.key}: no execution found in the data plane`);
        list.push({ capture, execution });
      }
      resolved.set(leg.label, list);
    }
    const settlementsOf = (leg: LiveLeg, ids: ReadonlySet<string>) => leg.ledger.filter((r): r is SettlementRecord => r.kind === 'settlement' && ids.has(r.executionId));
    const idsOf = (leg: LiveLeg) => new Set((resolved.get(leg.label) ?? []).flatMap(({ execution }) => (execution ? [execution.id] : [])));

    // 1. outcomes against the reference pool (not for cancel, whose outcome is timing by design)
    const distributions: PhaseSummary['distributions'][number][] = [];
    const row39 = new Map<string, number>(legs.map((l) => [l.label, 0]));
    const endings = new Map<string, Record<EndingKind, number> & { reusedTrue: number; confirmed: number }>();
    if (phase !== 'cancel') {
      out('### Outcomes against the reference pool');
      out();
      out('| workflow | leg | runs | statuses | HTTP statuses | fields off the constant pool | row 39 (attributed) |');
      out('|---|---|---:|---|---|---|---:|');
      const workflows = [...new Set(legs.flatMap((l) => (resolved.get(l.label) ?? []).map((r) => r.capture.workflow)))].sort();
      for (const workflow of workflows) {
        const refSettlements = settlementsOf(reference, idsOf(reference));
        const pool: LiveObserved[] = (resolved.get(reference.label) ?? [])
          .filter((r) => r.capture.workflow === workflow && r.execution !== null)
          .map((r) => observeLive(r.execution!, refSettlements, r.capture));
        if (phase === 'concurrent') {
          // The reference leg's sequential runs and webhook-phase runs of the workflow are in the pool too.
          const seqSettlements = reference.ledger.filter((r): r is SettlementRecord => r.kind === 'settlement');
          for (const s of reference.sequential.filter((s) => s.workflow === workflow)) pool.push(observeLive(s.execution, seqSettlements, {}));
          for (const w of reference.captures.filter((c) => c.phase === 'webhook' && c.workflow === workflow)) {
            const e = (() => { try { return resolveExecution(w, reference.executions); } catch { return null; } })();
            if (e !== null) pool.push(observeLive(e, seqSettlements, w));
          }
        }
        if (pool.length === 0) {
          findings.push(`${phase} / ${workflow}: no run in the reference leg \`${reference.label}\``);
          continue;
        }
        // Manual runs and webhook runs of one workflow do not mix; a pool member without HTTP is not
        // compared on the HTTP fields.
        const constant = new Map<LiveField, string>();
        for (const f of LIVE_FIELDS) {
          const values = new Set(pool.map((o) => valueOf(o, f)).filter((v) => !(f.startsWith('http') && v === '"none"')));
          if (values.size === 1) constant.set(f, [...values][0]!);
        }
        const byField = new Map<LiveField, Map<string, Map<string, number>>>();
        for (const leg of legs) {
          const runs = (resolved.get(leg.label) ?? []).filter((r) => r.capture.workflow === workflow && r.execution !== null);
          const settlements = settlementsOf(leg, idsOf(leg));
          const off = new Map<LiveField, number>();
          let attributed = 0;
          const ours = !N8N_ANSWERS.has(leg.label);
          const tally = endings.get(leg.label) ?? { ...(Object.fromEntries(ENDING_KINDS.map((k) => [k, 0])) as Record<EndingKind, number>), reusedTrue: 0, confirmed: 0 };
          if (ours) endings.set(leg.label, tally);
          for (const { capture, execution } of runs) {
            const o = observeLive(execution!, settlements, capture);
            const account = endingAccount(execution!, settlements, freshOf(leg));
            const follows = bodyFollowsEnding(execution!, settlements, capture.http);
            if (follows === false) findings.push(`${phase} / ${workflow} / ${leg.label} / ${capture.key}: the runEnd body is not the ending step's first output item`);
            if (ours) {
              tally[account.kind]++;
              if (account.kind === 'n8n ends here too' && account.enderTrue === 'reused') tally.reusedTrue++;
              tally.confirmed += account.confirmed;
              if (account.kind === 'unaccounted') findings.push(`${phase} / ${workflow} / ${leg.label} / ${capture.key}: ending unaccounted: ${account.why}`);
            }
            const lastStepOff = constant.has('lastStep') && valueOf(o, 'lastStep') !== constant.get('lastStep');
            const moved = lastStepOff && endingMoved(execution!, settlements, JSON.parse(constant.get('lastStep')!) as string);
            if (ours && lastStepOff && (moved || account.kind === 'row 39')) attributed++;
            // Why an ending off the pool is not a finding in this run, or null when it is one.
            const endingNote = (f: LiveField): string | null => {
              if (f === 'httpBody' && follows !== true) return null;
              if (!ours) return "n8n's default answers in this leg, so this is its own interleaving, not a policy effect";
              if (moved) return 'row 39: the ending moved to a later settlement';
              if (account.kind === 'row 39') return `row 39: ${account.why}, where n8n's fresh count could have ended the run`;
              if (account.kind === 'n8n ends here too') return `n8n's default ends this interleaving here too: ${account.why}; a reused true implies a fresh count says true on the same rows`;
              if (account.kind === 'failure path') return 'the run ended failed: the handler\'s failure path writes that ending at whichever settlement first sees the failure (row 37)';
              return null;
            };
            for (const f of LIVE_FIELDS) {
              const v = valueOf(o, f);
              const perLeg = byField.get(f) ?? new Map<string, Map<string, number>>();
              byField.set(f, perLeg);
              const counts = perLeg.get(leg.label) ?? new Map<string, number>();
              perLeg.set(leg.label, counts);
              counts.set(v, (counts.get(v) ?? 0) + 1);
              const want = constant.get(f);
              if (want === undefined || v === want) continue;
              if (f.startsWith('http') && capture.http === undefined) continue;
              off.set(f, (off.get(f) ?? 0) + 1);
              const msg = `${phase} / ${workflow} / ${leg.label} / ${capture.key}: ${f} differs from the reference pool. pool: ${clip(want, 200)}; this run: ${clip(v, 200)}`;
              const why = f === 'lastStep' || f === 'httpBody' ? endingNote(f) : null;
              if (why !== null) notes.push(`${msg} (${why})`);
              else findings.push(msg);
            }
          }
          row39.set(leg.label, (row39.get(leg.label) ?? 0) + attributed);
          const statuses = [...new Set(runs.map((r) => r.execution!.status))].join(', ');
          const https = [...new Set(runs.flatMap((r) => (r.capture.http ? [String(r.capture.http.status)] : [])))].join(', ') || '–';
          const offText = off.size === 0 ? 'none' : [...off].map(([f, n]) => `${f} (${n} of ${runs.length})`).join(', ');
          out(`| ${workflow} | ${leg.label} | ${runs.length} | ${statuses} | ${https} | ${offText} | ${attributed} |`);
        }
        for (const [field, perLeg] of byField) {
          const varies = !constant.has(field) || [...perLeg.values()].some((c) => c.size > 1 || [...c.keys()].some((v) => v !== constant.get(field)));
          if (!varies) continue;
          if (field.startsWith('http') && [...perLeg.values()].every((c) => [...c.keys()].every((v) => v === '"none"'))) continue;
          distributions.push({ workflow, field, byLeg: Object.fromEntries([...perLeg].map(([l, c]) => [l, Object.fromEntries(c)])) });
        }
      }
      out();
      if (endings.size > 0) {
        out('### Endings under ours, judged from the ledger');
        out();
        out('Every run of a leg where ours answers. "n8n ends here too": the ending settlement\'s `isFinished` said true and no');
        out('earlier settlement reused its snapshot and said false; a reused true implies a fresh count says true on the same');
        out('rows, so n8n\'s default ends this interleaving at the same settlement. "row 39": an earlier settlement reused its');
        out('snapshot and said false, where n8n\'s fresh count could have said true; "confirmed" counts those a shadow check\'s');
        out('fresh count did say true at. These judge each run on its own interleaving; `off`\'s pool is a different sample.');
        out();
        out('| leg | runs | n8n ends here too (of which the true was reused) | row 39 (occasions confirmed) | failure path | no ending | unaccounted |');
        out('|---|---:|---|---|---:|---:|---:|');
        for (const [label, t] of endings) {
          const runs = ENDING_KINDS.reduce((n, k) => n + t[k], 0);
          out(`| ${label} | ${runs} | ${t['n8n ends here too']} (${t.reusedTrue}) | ${t['row 39']} (${t.confirmed}) | ${t['failure path']} | ${t['no ending']} | ${t.unaccounted} |`);
        }
        out();
      }
      if (distributions.length > 0) {
        out('### Distributions where the pool varies or a leg differs from it');
        out();
        out('| workflow | field | ' + legs.map((l) => l.label).join(' | ') + ' |');
        out('|---|---|' + legs.map(() => '---').join('|') + '|');
        for (const d of distributions) {
          const cell = (label: string) => Object.entries(d.byLeg[label] ?? {}).sort().map(([v, n]) => `${clip(JSON.parse(v) as string, 60)} ×${n}`).join('; ') || '–';
          out(`| ${d.workflow} | ${d.field} | ${legs.map((l) => cell(l.label)).join(' | ')} |`);
        }
        out();
      }
    }

    // 2. per-leg accounting
    out('### Policy calls, verdicts and snapshot binding');
    out();
    out('| leg | runs | settled non-failed rows | `decideSuccessors` | `isFinished` | no call: ended first / failure first / unexplained | shadow agree / disagree / stale / race / threw | races: failure / cancel | errors | snapshots stored / reused / crossed / overruns |');
    out('|---|---:|---:|---:|---:|---|---|---|---:|---|');
    const legSummaries: Record<string, PhaseSummary['legs'][string]> = {};
    for (const leg of legs) {
      const ids = idsOf(leg);
      const runs = resolved.get(leg.label) ?? [];
      const settlements = settlementsOf(leg, ids);
      const accounts = runs.flatMap(({ execution }) => (execution ? [accountCalls(execution, settlements)] : []));
      const sum = (k: keyof CallAccount) => accounts.reduce((n, a) => n + a[k], 0);
      const shadows = leg.ledger.filter((r): r is ShadowRecord => r.kind === 'shadow' && ids.has(r.report.executionId));
      const verdict = (v: string) => shadows.filter((s) => s.report.verdict === v).length;
      const races = leg.ledger.filter((r): r is DiagnosticRecord => r.kind === 'race' && ids.has(r.executionId ?? ''));
      const errors = leg.ledger.filter((r): r is DiagnosticRecord => r.kind === 'error' && ids.has(r.executionId ?? ''));
      const b = binding(settlements);
      const names = new Map([...leg.executions.values()].flatMap((e) => e.nodes.map((n) => [n.id, n.name] as const)));
      const l = latency(settlements, names);
      const shadow = { agree: verdict('agree'), disagree: verdict('disagree'), stale: verdict('stale'), race: verdict('race'), 'candidate-threw': verdict('candidate-threw') };
      out(`| ${leg.label} | ${runs.length} | ${sum('settledNonFailed')} | ${sum('decideCalls')} | ${sum('isFinishedCalls')} | ${sum('endedFirst')} / ${sum('failureFirst')} / ${sum('unexplained')} | ${shadow.agree} / ${shadow.disagree} / ${shadow.stale} / ${shadow.race} / ${shadow['candidate-threw']} | ${races.filter((r) => r.race === 'failure').length} / ${races.filter((r) => r.race === 'cancel').length} | ${errors.length} | ${b.stored} / ${b.reused} / ${b.crossed} / ${b.overruns} |`);
      for (const [i, a] of accounts.entries()) {
        const e = runs.filter((r) => r.execution !== null)[i]!.execution!;
        if (a.unexplained > 0) findings.push(`${phase} / ${leg.label}: execution ${e.id} has ${a.unexplained} settlements of non-failed steps without a policy call and without a named reason`);
        if (a.threw > 0) findings.push(`${phase} / ${leg.label}: execution ${e.id} has ${a.threw} settlements whose handler threw`);
        if (a.decideCalls < a.settledNonFailed - a.endedFirst - a.failureFirst) findings.push(`${phase} / ${leg.label}: execution ${e.id} has ${a.decideCalls} decideSuccessors calls for ${a.settledNonFailed} settled non-failed rows, ${a.endedFirst + a.failureFirst} of them excused`);
      }
      if (phase !== 'cancel') {
        for (const { execution } of runs) if (execution && PENDING.has(execution.status)) findings.push(`F3: ${phase} / ${leg.label}: execution ${execution.id} ended \`${execution.status}\``);
      }
      if (shadow.disagree > 0) findings.push(`${phase} / ${leg.label}: ${shadow.disagree} shadow disagreements (F2)`);
      if (shadow['candidate-threw'] > 0) findings.push(`${phase} / ${leg.label}: ${shadow['candidate-threw']} shadow candidate throws`);
      for (const r of errors) findings.push(`${phase} / ${leg.label}: settlement policy error ${r.name}: ${r.error}${r.name === 'CodecError' ? ' (F6 reading)' : ''}`);
      if (b.crossed > 0) findings.push(`${phase} / ${leg.label}: ${b.crossed} reused snapshots crossed from another handler (binding B)`);
      if (shadow.stale > 0) {
        notes.push(phase === 'cancel'
          ? `${phase} / ${leg.label}: ${shadow.stale} shadow \`stale\` verdicts (a reused isFinished said false where the fresh side said true); the cancel table splits them into those row 36's second clause explains and the rest (row 39)`
          : `${phase} / ${leg.label}: ${shadow.stale} shadow \`stale\` verdicts (a reused isFinished said false where the fresh side said true; the safe direction, row 39)`);
      }
      legSummaries[leg.label] = {
        runs: runs.length,
        calls: { settledNonFailed: sum('settledNonFailed'), decideCalls: sum('decideCalls'), isFinishedCalls: sum('isFinishedCalls'), endedFirst: sum('endedFirst'), failureFirst: sum('failureFirst'), unexplained: sum('unexplained') },
        shadow, races: { failure: races.filter((r) => r.race === 'failure').length, cancel: races.filter((r) => r.race === 'cancel').length },
        errors: errors.length, binding: b, handlerMs: l.handlerMs, policyMs: l.policyMs, maxRoundTrips: l.roundTrips.max,
        row39: row39.get(leg.label) ?? 0,
        ...(endings.has(leg.label) ? { endings: endings.get(leg.label)! } : {}),
        ...(phase === 'concurrent' ? { interleaving: interleaving(settlements), schedules: schedulesOf(runs, settlements) } : {}),
      };
    }
    out();

    // 3. latency, and interleaving
    out('### Latency per settlement (p50 / p95 / p99 / max)');
    out();
    out(`| leg | handler ms | policy ms | most policy round trips in one settlement |${phase === 'concurrent' ? ' executions / most in flight at once / settlements / switches between executions |' : ''}`);
    out(`|---|---|---|---:|${phase === 'concurrent' ? '---|' : ''}`);
    for (const leg of legs) {
      const s = legSummaries[leg.label]!;
      const il = s.interleaving;
      out(`| ${leg.label} | ${dist(s.handlerMs)} | ${dist(s.policyMs)} | ${Number.isNaN(s.maxRoundTrips) ? '–' : s.maxRoundTrips} |${il ? ` ${il.executions} / ${il.maxInFlight} / ${il.settlements} / ${il.switches} |` : ''}`);
    }
    out();
    if (phase === 'concurrent') {
      out('"Most in flight at once" counts executions whose first-to-last settlement spans overlap; "switches" counts');
      out('consecutive settlements, by start, that belong to different executions. In-process, the engine\'s');
      out('`InMemoryWorkQueue` hands the orchestration queue to one handler at a time, so settlement handlers never');
      out('overlap each other: what interleaves is the settlements of different executions, and each handler with the');
      out('step worker and with HTTP requests (a stop, a webhook).');
      out();
      out('### The schedule, per round');
      out();
      out('| leg | rounds | distinct block sequences | distinct blocks-per-execution profiles | blocks per round | client start spread, ms (max) | window with every execution in flight, ms (min–max) | contiguous blocks per execution, by workflow |');
      out('|---|---:|---:|---:|---|---:|---|---|');
      for (const leg of legs) {
        const rounds = legSummaries[leg.label]!.schedules ?? [];
        if (rounds.length === 0) continue;
        const per = new Map<string, Map<number, number>>();
        for (const r of rounds) for (const [w, list] of Object.entries(r.blocksPerExecution)) {
          const m = per.get(w) ?? new Map<number, number>();
          per.set(w, m);
          for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
        }
        const blocksText = [...per].sort(([a], [b]) => (a < b ? -1 : 1)).map(([w, m]) => `${w.replace(/^V2 /, '')} ${[...m].sort(([a], [b]) => a - b).map(([n, k]) => `${n} ×${k}`).join(', ')}`).join('; ');
        const spreads = rounds.flatMap((r) => (r.startSpreadMs === null ? [] : [r.startSpreadMs]));
        const overlaps = rounds.map((r) => r.commonOverlapMs);
        out(`| ${leg.label} | ${rounds.length} | ${new Set(rounds.map((r) => r.sequence)).size} | ${new Set(rounds.map((r) => canonical(r.blocksPerExecution))).size} | ${rounds.map((r) => r.blocks).join(', ')} | ${spreads.length === 0 ? '–' : fmt(Math.max(...spreads))} | ${fmt(Math.min(...overlaps))}–${fmt(Math.max(...overlaps))} | ${blocksText} |`);
      }
      out();
      out('A block is a maximal run of consecutive settlements of one execution. Rounds with the same block sequence ran');
      out('the same schedule. Sequences that differ only in the order executions arrive within a wave, with the same');
      out('blocks per execution, are the same FIFO schedule permuted: the number of settlements and switches then overstates');
      out('how many distinct interleavings were exercised.');
      out();
    }

    // 4. cancel
    if (phase === 'cancel') {
      out('### Cancels against the settlement in flight');
      out();
      out('| leg | runs | stop accepted / refused (ended first) | ' + LANDINGS.join(' | ') + ' |');
      out('|---|---:|---|' + LANDINGS.map(() => '---:').join('|') + '|');
      const accountsByLeg = new Map<string, CancelAccount>();
      for (const leg of legs) {
        const runs = resolved.get(leg.label) ?? [];
        const a = accountCancels(runs.map((r) => r.capture), leg.executions, leg.ledger);
        accountsByLeg.set(leg.label, a);
        out(`| ${leg.label} | ${a.runs} | ${a.accepted} / ${a.endedFirst} | ${LANDINGS.map((l) => a.byLanding[l]).join(' | ')} |`);
        for (const b of a.broken) findings.push(`cancel / ${leg.label}: ${b}`);
        const { broken: _broken, ...rest } = a;
        legSummaries[leg.label] = { ...legSummaries[leg.label]!, cancel: rest };
      }
      out();
      out('| leg | in the window (liveness read .. createSteps) | of which `cancelPendingSteps` answered before the policy\'s first read | `race` cancel diagnostics | policy calls on a cancelled row set: decide (planned) / isFinished (true) | rows created after the cancel: queued / skipped | of the queued, ended `cancelled`: at claim / by the bulk update / either | isFinished true, CAS lost to the cancel | shadow `stale`: row 36\'s second clause / other |');
      out('|---|---:|---:|---:|---|---|---|---:|---|');
      for (const leg of legs) {
        const a = accountsByLeg.get(leg.label)!;
        out(`| ${leg.label} | ${a.inWindow} | ${a.pendingBeforeRead} | ${a.raceDiagnostics} | ${a.cancelSeen.decide} (${a.cancelSeen.decidePlanned}) / ${a.cancelSeen.isFinished} (${a.cancelSeen.isFinishedTrue}) | ${a.createdAfterCancel.queued} / ${a.createdAfterCancel.skipped} | ${a.cancelledAtClaim} / ${a.cancelledByBulk} / ${a.cancelledEitherPath} | ${a.finishedLostToCancel} | ${a.staleDuringCancel} / ${a.staleOther} |`);
      }
      out();
      out('A landing is where the cancel\'s compare-and-set answered against the settlement handler of that execution then');
      out('running, on one clock (`performance.now()` in the server). The window of divergence row 36 is from the');
      out('handler\'s liveness read to its `createSteps`. A policy call "on a cancelled row set" read a cancelled row and no');
      out('failed one; each call reads only what it asks for, so n8n\'s default can miss a cancelled row it did not ask about.');
      out('A queued row created after the cancel and found `cancelled` was cancelled "at claim" (`StepReadyHandler`,');
      out('`cancelStep`) when the ledger\'s `cancel-step` record names it, or, in a ledger without those records, when');
      out('`createSteps` was called after `cancelPendingSteps` answered; "by the bulk update" when the ledger has those');
      out('records and none names it; "either" when the ledger has none and `createSteps` was called first, which the');
      out('instrument cannot tell apart.');
      out('A shadow `stale` verdict is "row 36\'s second clause" when, on the settlement it was made in, `isFinished` reused');
      out('its snapshot, the cancel\'s compare-and-set landed inside the settlement, and the execution\'s final rows hold a');
      out('`cancelled` row: n8n\'s fresh count said true, which it can only do on the final rows, so it read after the cancel');
      out('and counted a row the cancel had cancelled. The shadow check cannot see that as a race because a count returns no');
      out('rows. The other `stale` verdicts are row 39\'s occasion.');
      out();
    }

    phases.push({ phase, legs: legSummaries, distributions });
  }

  out('## Findings');
  out();
  out(findings.length === 0 ? 'None.' : findings.map((f) => `- ${f}`).join('\n'));
  out();
  out('## Notes');
  out();
  out(notes.length === 0 ? 'None.' : notes.map((n) => `- ${n}`).join('\n'));
  out();
  return { markdown: lines.join('\n'), summary: { legs: legs.map((l) => l.label), phases, findings, notes } };
}

function main(argv: readonly string[]): number {
  const [dir, ...labels] = argv;
  if (dir === undefined || labels.length === 0) {
    console.error('usage: tsx tests/testbed/compare-v2-live.ts <out-dir> <leg> [<leg> ...]   (the first leg is the reference)');
    return 2;
  }
  const legs = labels.map((label) => loadLiveLeg(join(dir, label), label));
  const { markdown, summary } = compareLive(legs);
  writeFileSync(join(dir, 'live-report.md'), `${markdown}\n`);
  writeFileSync(join(dir, 'live-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(markdown);
  return summary.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
