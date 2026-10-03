/**
 * Compares the legs `scripts/testbed/diff-engines-v2.sh` ran (`tasks/v2-seam-plan.md` step 12):
 * engine v2 in a live n8n server with `--settlement=off` (patched, nothing registered: n8n's
 * default answers), `primary` (the net-backed policy answers), `shadow` (n8n answers, ours is
 * compared) and `primary-shadowed` (ours answers, n8n's is compared).
 *
 * Everything here is an **integration result** (decision 12). It is not a conformance number, not
 * a policy-entering case count, not a neutrality leg and not settlement evidence, and no wall clock
 * in it is a result of any of those kinds.
 *
 * Inputs, per leg directory: `sql.json` (`dump-v2.mjs`: executions and step rows, read over SQL
 * from the engine's data plane), `settlement.jsonl` (the preload's ledger: diagnostics, shadow
 * reports and, under `--timing`, one `settlement` record per `step:settled` event) and `runs/*.json`
 * (`run.mjs`'s captures, which give each run's workflow name and execution id).
 *
 * What is compared, each execution against the `off` leg's first run of the same workflow:
 * - the execution status, the row count, the fate multiset (node name, iteration, status), the
 *   filled output slots per row, the normalised outputs per row (an error is reduced to its name and
 *   message; nothing else is normalised), and the `ended` lastStep (from the timing record whose
 *   handler called `announceEnd`);
 * - the `off` leg's own repeats against its first run, so a difference that n8n's default shows
 *   between two of its own runs is reported as run-to-run variation, not as a policy effect.
 *
 * What is checked, per leg:
 * - **Policy calls against settled non-failed rows.** Every completed or skipped row is one
 *   `step:settled` event, and its handler calls `decideSuccessors` unless it returns first: the
 *   execution had already ended (`step-settled-handler.ts`, `isLiveExecutionStatus`), or
 *   `hasFailedSteps` found a failure and the handler failed the execution. Each settlement without a
 *   call is attributed to one of those, or counted as unexplained, which is a finding.
 * - **Shadow verdicts.** `disagree` and `candidate-threw` are findings. A `race` (F2's named races:
 *   a failed row, or a cancelled row and no failed one, in the rows either side read) is excluded
 *   and counted.
 * - **Policy errors** (`settlement policy error`) are findings; a `CodecError` among them is F6's
 *   reading.
 * - **F3, second half.** An execution that ends `running` (or `queued`) under a leg where the `off`
 *   leg's run of the same workflow ended.
 * - **Snapshot binding** (step 12's rerun). Each settlement record carries the policy's `snapshot`
 *   events emitted inside its handler. Every `reused` token must have its `stored` in the same
 *   record: a snapshot taken by another handler is the binding failure the safety argument rules
 *   out, and is a finding. `overrun` events (the scoped read's probe found a loop two passes on) are
 *   counted.
 * - **Stale verdicts.** A shadow `stale` (the side that reused its snapshot said false, the fresh side
 *   true) is the safe direction of the argument: counted and reported, not a finding.
 * - **Latency by pass.** Over the Loop Over Items, the policy's and the handler's p50 / p95 per
 *   settlement and the most round trips, by quarter of the loop's passes (the settled row's
 *   iteration), so a cost that grows with the passes shows.
 * - **F4.** Over the Loop Over Items executions: the most round trips the policy made in one
 *   settlement under `primary` (more than 3 fires F4), and the p95 of the policy's time per
 *   settlement under `primary` against twice the p95 of n8n's whole handler under `off`. Two
 *   stricter ratios are reported beside it and do not decide F4: policy against policy, and handler
 *   against handler.
 *
 *   npx tsx tests/testbed/compare-v2.ts <out-dir> <leg> [<leg> ...]     # the first leg is the reference
 *
 * Writes `<out-dir>/report.md` and `<out-dir>/summary.json`, prints the report, and exits 1 on a
 * finding: a shadow disagreement or candidate throw, a policy error, an unexplained settlement
 * without a policy call, F3, F4, or a data difference on a workflow whose `off` runs agree with
 * each other.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- inputs ---------------------------------------------------------------------------------------

export interface SqlStep {
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: string;
  readonly filledOutputSlots: readonly boolean[];
  readonly outputs: unknown;
  readonly error: { name?: string; message?: string } | null;
}

export interface SqlExecution {
  readonly id: string;
  readonly status: string;
  readonly responseKind: string | null;
  readonly nodes: readonly { id: string; name: string }[];
  readonly steps: readonly SqlStep[];
}

export interface PolicyCall {
  readonly method: 'decideSuccessors' | 'isFinished';
  readonly ms: number;
  readonly readerCalls: number;
  readonly roundTrips: number;
  /** The answer: queue and skip counts, or the boolean (absent in ledgers written before the live phases). */
  readonly result?: { queue: number; skip: number } | boolean | null;
  /** The rows the call read held a cancelled row and no failed one (divergence row 36's row set). */
  readonly cancelSeen?: boolean;
}

export interface SnapshotEvent {
  readonly method: 'decideSuccessors' | 'isFinished';
  readonly event: 'stored' | 'reused' | 'overrun';
  readonly token: number;
}

export interface SettlementRecord {
  readonly kind: 'settlement';
  /** The policy's `snapshot` diagnostics emitted inside this handler (absent before step 12's rerun). */
  readonly snapshots?: readonly SnapshotEvent[];
  readonly executionId: string;
  readonly stepId: string;
  readonly ms: number;
  readonly step: { nodeId: string; iteration: number; status: string } | null;
  readonly executionStatus: string | null;
  /** The handler's first `hasFailedSteps` answer, `null` when it did not ask. */
  readonly failedFound: boolean | null;
  readonly store: number;
  readonly policy: readonly PolicyCall[];
  readonly ended: { status: string; responseKind: string | null; lastStep: { nodeId: string; nodeName: string | null; iteration: number; status: string } } | null;
  readonly threw: string | null;
  /**
   * On the preload's `performance.now()` clock (absent before the live phases): the handler's start
   * and end, when its `loadExecution` answered (the liveness read), when the policy's first read
   * started, and when `createSteps` was called, with the keys it created.
   */
  readonly t0?: number;
  readonly t1?: number;
  readonly tLoaded?: number | null;
  readonly tRead?: number | null;
  readonly tCreate?: number | null;
  /** The rows `createSteps` inserted, with each row's status as asked (and its id, in ledgers since the review of the live phases). */
  readonly created?: readonly { nodeId: string; iteration: number; status: string | null; id?: string }[] | null;
}

/** One `CancelExecutionService.cancel`, on the same clock as the settlement records. */
export interface CancelRecord {
  readonly kind: 'cancel';
  readonly executionId: string;
  readonly t0: number;
  readonly t1: number;
  /** When the compare-and-set answered, and whether this request's write won it. */
  readonly tCas: number | null;
  readonly won: boolean | null;
  /** When `cancelPendingSteps` answered; `null` when the CAS lost and it was not called. */
  readonly tPending: number | null;
  readonly status: string | null;
  readonly threw: string | null;
}

/**
 * One `TypeOrmStepStore.cancelStep` (only `StepReadyHandler` calls it, cancelling a row it claimed for
 * an ended execution), on the same clock. `won` is whether the row's `running` →
 * `cancelled` transition took. Absent from ledgers written before the review of the live phases.
 */
export interface CancelStepRecord {
  readonly kind: 'cancel-step';
  readonly executionId: string | null;
  readonly stepId: string;
  readonly t: number;
  readonly won: boolean;
}

export interface ShadowRecord {
  readonly kind: 'shadow';
  readonly report: {
    readonly method: string;
    readonly executionId: string;
    readonly verdict: 'agree' | 'disagree' | 'race' | 'candidate-threw' | 'stale';
    readonly reused?: 'primary' | 'candidate' | null;
    /** Each side's answer (the boolean for `isFinished`). */
    readonly primary?: unknown;
    readonly candidate?: unknown;
    readonly race: 'failure' | 'cancel' | null;
    readonly skew: boolean;
    readonly primaryMs: number;
    readonly candidateMs: number;
    readonly primaryReads: number;
    readonly candidateReads: number;
  };
}

export interface DiagnosticRecord {
  readonly kind: 'entered' | 'race' | 'error' | 'registered' | 'off' | 'timing';
  readonly executionId?: string;
  readonly method?: string;
  readonly name?: string;
  readonly error?: string;
  readonly race?: string;
  readonly mode?: string;
}

export type LedgerRecord = SettlementRecord | ShadowRecord | DiagnosticRecord | CancelRecord | CancelStepRecord;

/** The execution a ledger record is about, or `null` for a process-wide one (`registered`, `timing`). */
export function executionOf(record: LedgerRecord): string | null {
  if (record.kind === 'shadow') return record.report.executionId;
  return record.executionId ?? null;
}

export interface Run {
  readonly workflow: string;
  readonly executionId: string;
  readonly elapsedMs: number;
  readonly restStatus: string;
}

export interface Leg {
  readonly label: string;
  readonly runs: readonly Run[];
  readonly executions: ReadonlyMap<string, SqlExecution>;
  readonly ledger: readonly LedgerRecord[];
  readonly serverVersion: string | null;
}

// ---- per execution ------------------------------------------------------------------------------

/** What is compared of one execution. Every field is a string or a sorted list, so equality is `===` on its JSON. */
export interface Observed {
  readonly status: string;
  readonly rows: number;
  readonly fates: readonly string[];
  readonly slots: readonly string[];
  readonly outputs: readonly string[];
  readonly lastStep: string;
}

/** Canonical JSON: object keys sorted, array order kept. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Outputs as they are; an error reduced to its name and message (its stack is a build path). */
export function normalisedOutput(step: SqlStep): string {
  const error = step.error === null ? null : { name: step.error.name ?? null, message: step.error.message ?? null };
  return canonical({ outputs: step.outputs, error });
}

export function observe(execution: SqlExecution, settlements: readonly SettlementRecord[]): Observed {
  const name = new Map(execution.nodes.map((n) => [n.id, n.name]));
  const label = (s: { nodeId: string; iteration: number }) => `${name.get(s.nodeId) ?? s.nodeId}@${s.iteration}`;
  const ended = settlements.filter((r) => r.executionId === execution.id && r.ended !== null);
  const lastStep = ended.length === 0
    ? 'none'
    : ended.map((r) => `${r.ended!.status} ${label(r.ended!.lastStep)} ${r.ended!.lastStep.status}`).sort().join(' | ');
  return {
    status: execution.status,
    rows: execution.steps.length,
    fates: execution.steps.map((s) => `${label(s)} ${s.status}`).sort(),
    slots: execution.steps.map((s) => `${label(s)} [${s.filledOutputSlots.map((f) => (f ? 1 : 0)).join('')}]`).sort(),
    outputs: execution.steps.map((s) => `${label(s)} ${normalisedOutput(s)}`).sort(),
    lastStep,
  };
}

export type Field = keyof Observed;
export const FIELDS: readonly Field[] = ['status', 'rows', 'fates', 'slots', 'outputs', 'lastStep'];

/** The fields on which two observations differ, with the first differing entry of each. */
export function differences(reference: Observed, candidate: Observed): { field: Field; reference: string; candidate: string }[] {
  const out: { field: Field; reference: string; candidate: string }[] = [];
  for (const field of FIELDS) {
    const a = reference[field];
    const b = candidate[field];
    if (canonical(a) === canonical(b)) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      const onlyA = (a as string[]).filter((x) => !(b as string[]).includes(x));
      const onlyB = (b as string[]).filter((x) => !(a as string[]).includes(x));
      out.push({ field, reference: clip(onlyA.join('; ') || '(multiplicity)'), candidate: clip(onlyB.join('; ') || '(multiplicity)') });
    } else {
      out.push({ field, reference: String(a), candidate: String(b) });
    }
  }
  return out;
}

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---- policy calls against settled rows ------------------------------------------------------------

const LIVE = new Set(['queued', 'running', 'waiting']);

export interface CallAccount {
  /** Completed and skipped rows in SQL. */
  readonly settledNonFailed: number;
  /** Settlement records of completed or skipped steps. */
  readonly settlementsNonFailed: number;
  readonly decideCalls: number;
  readonly isFinishedCalls: number;
  /** Settlements of a non-failed step without a policy call, by reason. */
  readonly endedFirst: number;
  readonly failureFirst: number;
  readonly threw: number;
  readonly unexplained: number;
}

export function accountCalls(execution: SqlExecution, settlements: readonly SettlementRecord[]): CallAccount {
  const own = settlements.filter((r) => r.executionId === execution.id);
  const nonFailed = own.filter((r) => r.step !== null && (r.step.status === 'completed' || r.step.status === 'skipped'));
  let endedFirst = 0, failureFirst = 0, threw = 0, unexplained = 0;
  for (const r of nonFailed) {
    if (r.policy.some((c) => c.method === 'decideSuccessors')) continue;
    if (r.threw !== null) threw++;
    else if (r.executionStatus !== null && !LIVE.has(r.executionStatus)) endedFirst++;
    // The handler's only return between the live check and `decideSuccessors`.
    else if (r.failedFound === true) failureFirst++;
    else unexplained++;
  }
  return {
    settledNonFailed: execution.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length,
    settlementsNonFailed: nonFailed.length,
    decideCalls: own.reduce((n, r) => n + r.policy.filter((c) => c.method === 'decideSuccessors').length, 0),
    isFinishedCalls: own.reduce((n, r) => n + r.policy.filter((c) => c.method === 'isFinished').length, 0),
    endedFirst, failureFirst, threw, unexplained,
  };
}

// ---- latency ----------------------------------------------------------------------------------------

/** Nearest-rank percentile; `NaN` on an empty sample. */
export function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) return Number.NaN;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface Distribution { readonly n: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number }

export function distribution(sample: readonly number[]): Distribution {
  return { n: sample.length, p50: percentile(sample, 50), p95: percentile(sample, 95), p99: percentile(sample, 99), max: sample.length ? Math.max(...sample) : Number.NaN };
}

export interface Latency {
  /** The whole `StepSettledHandler.handle`, every settlement. */
  readonly handlerMs: Distribution;
  /** The policy's time summed over one settlement, settlements that called it. */
  readonly policyMs: Distribution;
  /** Round trips summed over one settlement, settlements that called the policy. */
  readonly roundTrips: Distribution;
  /** Round trips of one policy call. */
  readonly roundTripsPerCall: Distribution;
  /** Settlements whose policy round trips exceed 3, with what each did. */
  readonly over3: readonly string[];
  /** Store calls (both stores) in one settlement, the policy's reads included: the reader is the step store's. */
  readonly storeCalls: Distribution;
}

export function latency(records: readonly SettlementRecord[], names: ReadonlyMap<string, string>): Latency {
  const withPolicy = records.filter((r) => r.policy.length > 0);
  const trips = (r: SettlementRecord) => r.policy.reduce((n, c) => n + c.roundTrips, 0);
  return {
    handlerMs: distribution(records.map((r) => r.ms)),
    policyMs: distribution(withPolicy.map((r) => r.policy.reduce((n, c) => n + c.ms, 0))),
    roundTrips: distribution(withPolicy.map(trips)),
    roundTripsPerCall: distribution(withPolicy.flatMap((r) => r.policy.map((c) => c.roundTrips))),
    over3: withPolicy.filter((r) => trips(r) > 3).map((r) =>
      `${r.step ? `${names.get(r.step.nodeId) ?? r.step.nodeId}@${r.step.iteration} ${r.step.status}` : r.stepId}: ` +
      r.policy.map((c) => `${c.method} ${c.roundTrips}`).join(' + ')),
    storeCalls: distribution(records.map((r) => r.store)),
  };
}

// ---- snapshot binding -------------------------------------------------------------------------------

export interface Binding {
  readonly stored: number;
  readonly reused: number;
  /** `reused` events whose `stored` is not in the same settlement record. */
  readonly crossed: number;
  readonly overruns: number;
  /** `isFinished` calls that made at least one round trip / none. */
  readonly isFinishedFresh: number;
  readonly isFinishedNoRead: number;
}

export function binding(records: readonly SettlementRecord[]): Binding {
  let stored = 0, reused = 0, crossed = 0, overruns = 0, isFinishedFresh = 0, isFinishedNoRead = 0;
  for (const r of records) {
    const events = r.snapshots ?? [];
    const own = new Set(events.filter((e) => e.event === 'stored').map((e) => e.token));
    for (const e of events) {
      if (e.event === 'stored') stored++;
      else if (e.event === 'overrun') overruns++;
      else {
        reused++;
        if (!own.has(e.token)) crossed++;
      }
    }
    for (const c of r.policy) {
      if (c.method !== 'isFinished') continue;
      if (c.roundTrips > 0) isFinishedFresh++;
      else isFinishedNoRead++;
    }
  }
  return { stored, reused, crossed, overruns, isFinishedFresh, isFinishedNoRead };
}

// ---- latency by pass ---------------------------------------------------------------------------------

export interface QuarterLatency {
  readonly quarter: number;
  /** Lowest and highest settled iteration in the quarter. */
  readonly from: number;
  readonly to: number;
  readonly policyMs: Distribution;
  readonly handlerMs: Distribution;
  readonly maxRoundTrips: number;
}

/** The records split into four quarters of the settled row's iteration, 0 .. the highest seen. */
export function byQuarter(records: readonly SettlementRecord[]): QuarterLatency[] {
  const withStep = records.filter((r) => r.step !== null);
  const top = withStep.reduce((m, r) => Math.max(m, r.step!.iteration), 0);
  const span = top + 1;
  const out: QuarterLatency[] = [];
  for (let q = 0; q < 4; q++) {
    const from = Math.ceil((q * span) / 4);
    const to = Math.ceil(((q + 1) * span) / 4) - 1;
    const inQ = withStep.filter((r) => r.step!.iteration >= from && r.step!.iteration <= to);
    const withPolicy = inQ.filter((r) => r.policy.length > 0);
    out.push({
      quarter: q + 1, from, to,
      policyMs: distribution(withPolicy.map((r) => r.policy.reduce((n, c) => n + c.ms, 0))),
      handlerMs: distribution(inQ.map((r) => r.ms)),
      maxRoundTrips: withPolicy.reduce((m, r) => Math.max(m, r.policy.reduce((n, c) => n + c.roundTrips, 0)), 0),
    });
  }
  return out;
}

// ---- loading ------------------------------------------------------------------------------------

export function loadLeg(dir: string, label: string): Leg {
  const sql = JSON.parse(readFileSync(join(dir, 'sql.json'), 'utf8')) as { serverVersion?: string; executions: SqlExecution[] };
  const ledgerPath = join(dir, 'settlement.jsonl');
  // The live phases (`compare-v2-live.ts`) run on the same server after this one, so the ledger is
  // kept to this leg's executions: records about other executions are theirs to count.
  const mine = new Set(sql.executions.map((e) => e.id));
  const ledger = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRecord)
      .filter((r) => { const id = executionOf(r); return id === null || mine.has(id); })
    : [];
  const runsDir = join(dir, 'runs');
  const runs: Run[] = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const raw = JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as { workflow: string; executionId: string; elapsedMs: number; execution: { status: string } };
    return { workflow: raw.workflow, executionId: raw.executionId, elapsedMs: raw.elapsedMs, restStatus: raw.execution.status };
  });
  return { label, runs, executions: new Map(sql.executions.map((e) => [e.id, e])), ledger, serverVersion: sql.serverVersion ?? null };
}

const settlementsOf = (leg: Leg) => leg.ledger.filter((r): r is SettlementRecord => r.kind === 'settlement');
const shadowsOf = (leg: Leg) => leg.ledger.filter((r): r is ShadowRecord => r.kind === 'shadow');

// ---- the report ---------------------------------------------------------------------------------

export const LOOP_WORKFLOW = 'V2 Loop Over Items';

export interface Summary {
  readonly legs: readonly string[];
  readonly findings: readonly string[];
  readonly notes: readonly string[];
  readonly f3: boolean;
  readonly f4: { readonly fires: boolean; readonly maxRoundTrips: number; readonly policyP95: number; readonly offHandlerP95: number; readonly ratio: number; readonly policyVsPolicy: number; readonly handlerVsHandler: number } | null;
}

const ms = (x: number) => (Number.isNaN(x) ? '–' : x < 10 ? x.toFixed(2) : x.toFixed(1));
const dist = (d: Distribution, f = ms) => `${f(d.p50)} / ${f(d.p95)} / ${f(d.p99)} / ${f(d.max)} (n ${d.n})`;
const int = (x: number) => (Number.isNaN(x) ? '–' : String(x));

export function compare(legs: readonly Leg[]): { markdown: string; summary: Summary } {
  const [reference] = legs;
  if (reference === undefined) throw new Error('compare: no legs');
  const lines: string[] = [];
  const findings: string[] = [];
  const notes: string[] = [];
  const out = (s = '') => lines.push(s);

  out('# diff-engines-v2: engine v2 legs compared');
  out();
  out('Integration results from the live testbed (decision 12). Not conformance numbers, not policy-entering');
  out('case counts, not neutrality legs, not settlement evidence. Wall clocks and latencies are what this');
  out('run measured on one machine; they are not results of any of those kinds.');
  out();
  out(`Legs: ${legs.map((l) => `\`${l.label}\``).join(', ')}. Reference: \`${reference.label}\`, run 1 of each workflow.`);
  out(`Postgres: ${legs.map((l) => `${l.label} ${l.serverVersion ?? '?'}`).join(', ')}.`);
  out();

  const workflows = [...new Set(legs.flatMap((l) => l.runs.map((r) => r.workflow)))].sort();
  const observedOf = (leg: Leg, run: Run): Observed | null => {
    const e = leg.executions.get(run.executionId);
    return e === undefined ? null : observe(e, settlementsOf(leg));
  };

  // 1. data
  out('## Outcomes against the reference');
  out();
  out('| workflow | leg | runs | status | rows | lastStep (run 1) | differs from reference |');
  out('|---|---|---:|---|---:|---|---|');
  let f3 = false;
  for (const workflow of workflows) {
    const refRuns = reference.runs.filter((r) => r.workflow === workflow);
    const refObs = refRuns.map((r) => observedOf(reference, r));
    const ref = refObs[0];
    if (ref === undefined || ref === null) {
      findings.push(`${workflow}: no reference run in \`${reference.label}\``);
      continue;
    }
    // Run-to-run variation of n8n's own default.
    const selfFields = new Set<Field>();
    for (const o of refObs.slice(1)) if (o !== null) for (const d of differences(ref, o)) selfFields.add(d.field);
    if (selfFields.size > 0) notes.push(`${workflow}: \`${reference.label}\`'s own runs differ on ${[...selfFields].join(', ')}; a difference there under another leg is run-to-run variation, not a policy effect.`);

    for (const leg of legs) {
      const runs = leg.runs.filter((r) => r.workflow === workflow);
      const observed = runs.map((r) => observedOf(leg, r));
      const differing = new Map<Field, number>();
      for (const [i, o] of observed.entries()) {
        if (o === null) {
          findings.push(`${workflow} / ${leg.label}: execution ${runs[i]!.executionId} is not in the data plane dump`);
          continue;
        }
        if (LIVE.has(o.status) && !LIVE.has(ref.status)) {
          f3 = true;
          findings.push(`F3: ${workflow} / ${leg.label} run ${i + 1} ended \`${o.status}\` where \`${reference.label}\` ended \`${ref.status}\``);
        }
        for (const d of differences(ref, o)) {
          differing.set(d.field, (differing.get(d.field) ?? 0) + 1);
          if (leg === reference && i === 0) continue;
          const msg = `${workflow} / ${leg.label} run ${i + 1}: ${d.field} differs. reference: ${d.reference}; this run: ${d.candidate}`;
          if (selfFields.has(d.field)) notes.push(`${msg} (\`${reference.label}\` varies here too)`);
          else findings.push(msg);
        }
      }
      const first = observed.find((o) => o !== null) ?? null;
      const statuses = [...new Set(observed.filter((o) => o !== null).map((o) => o!.status))].join(', ');
      const differs = differing.size === 0 ? 'no' : [...differing].map(([f, n]) => `${f} (${n} of ${runs.length})`).join(', ');
      out(`| ${workflow} | ${leg.label} | ${runs.length} | ${statuses} | ${first?.rows ?? '–'} | ${first ? clip(first.lastStep, 70) : '–'} | ${differs} |`);
    }
  }
  out();
  out('Status, row count, fates, filled slots, normalised outputs and lastStep are compared per execution;');
  out('the last column names the fields that differ. `lastStep` is the `ended` response as `announceEnd` computed it; manual runs expect no response');
  out('(`responseExpectation.kind` `none`), so it is captured by the timing instrument, not received.');
  out();

  // 2. policy calls
  out('## Policy calls against settled non-failed rows');
  out();
  out('| leg | executions | settled non-failed rows | their settlements | `decideSuccessors` | `isFinished` | no call: ended first | no call: failure first | no call: threw | unexplained |');
  out('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const leg of legs) {
    const settlements = settlementsOf(leg);
    if (settlements.length === 0) {
      // A leg run without `--timing` has no settlement records: there is nothing to count calls from.
      out(`| ${leg.label} | ${leg.executions.size} | – | – | – | – | – | – | – | – |`);
      notes.push(`${leg.label}: no settlement records (not run with --timing); the policy-call check was skipped`);
      continue;
    }
    const accounts = [...leg.executions.values()].map((e) => ({ e, a: accountCalls(e, settlements) }));
    const sum = (k: keyof CallAccount) => accounts.reduce((n, { a }) => n + a[k], 0);
    out(`| ${leg.label} | ${accounts.length} | ${sum('settledNonFailed')} | ${sum('settlementsNonFailed')} | ${sum('decideCalls')} | ${sum('isFinishedCalls')} | ${sum('endedFirst')} | ${sum('failureFirst')} | ${sum('threw')} | ${sum('unexplained')} |`);
    for (const { e, a } of accounts) {
      if (a.unexplained > 0) findings.push(`${leg.label}: execution ${e.id} has ${a.unexplained} settlements of non-failed steps without a policy call and without a named reason`);
      if (a.threw > 0) findings.push(`${leg.label}: execution ${e.id} has ${a.threw} settlements whose handler threw`);
      if (a.settlementsNonFailed !== a.settledNonFailed) notes.push(`${leg.label}: execution ${e.id} has ${a.settledNonFailed} settled non-failed rows and ${a.settlementsNonFailed} settlements of them`);
      if (a.decideCalls < a.settledNonFailed - a.endedFirst - a.failureFirst) findings.push(`${leg.label}: execution ${e.id} has ${a.decideCalls} decideSuccessors calls for ${a.settledNonFailed} settled non-failed rows, ${a.endedFirst + a.failureFirst} of them excused`);
    }
    const entered = leg.ledger.filter((r) => r.kind === 'entered').length;
    const timed = settlements.reduce((n, r) => n + r.policy.length, 0);
    if (leg.ledger.some((r) => r.kind === 'registered') && entered !== timed) {
      notes.push(`${leg.label}: ${entered} \`entered\` diagnostics against ${timed} timed policy calls (shadow modes enter ours once per call too)`);
    }
  }
  out();
  out('A settlement of a completed or skipped row calls `decideSuccessors` unless the handler returns first:');
  out('the execution had already ended, or `hasFailedSteps` found a failure. Each settlement without a call is');
  out('attributed from the timing record (the execution status the handler loaded, and `announceEnd`).');
  out();

  // 3. diagnostics and shadow
  out('## Diagnostics and shadow verdicts');
  out();
  out('| leg | `entered` | `race` | `error` | shadow agree | disagree | stale (counted) | race (excluded, counted) | candidate threw | skew |');
  out('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const leg of legs) {
    const count = (k: string) => leg.ledger.filter((r) => r.kind === k).length;
    const shadows = shadowsOf(leg);
    const verdict = (v: string) => shadows.filter((s) => s.report.verdict === v).length;
    const races = shadows.filter((s) => s.report.verdict === 'race');
    const raceText = races.length === 0 ? '0' : `${races.length} (${['failure', 'cancel'].map((k) => `${k} ${races.filter((s) => s.report.race === k).length}`).join(', ')})`;
    out(`| ${leg.label} | ${count('entered')} | ${count('race')} | ${count('error')} | ${verdict('agree')} | ${verdict('disagree')} | ${verdict('stale')} | ${raceText} | ${verdict('candidate-threw')} | ${shadows.filter((s) => s.report.skew).length} |`);
    if (verdict('stale') > 0) notes.push(`${leg.label}: ${verdict('stale')} shadow \`stale\` verdicts: a reused isFinished said false where the fresh side said true (the safe direction)`);
    for (const r of leg.ledger) {
      if (r.kind === 'error') findings.push(`${leg.label}: settlement policy error ${(r as DiagnosticRecord).name}: ${(r as DiagnosticRecord).error}${(r as DiagnosticRecord).name === 'CodecError' ? ' (F6 reading)' : ''}`);
    }
    if (verdict('disagree') > 0) findings.push(`${leg.label}: ${verdict('disagree')} shadow disagreements (F2)`);
    if (verdict('candidate-threw') > 0) findings.push(`${leg.label}: ${verdict('candidate-threw')} shadow candidate throws`);
  }
  out();

  // 3b. snapshot binding
  out('## Snapshot reuse and binding');
  out();
  out('`stored` / `reused` count the policy\'s snapshot events inside handlers; a `reused` whose `stored` is in another');
  out('handler\'s record is `crossed`, the binding failure the safety argument rules out. `isFinished` calls are counted');
  out('by whether they made a round trip (n8n\'s default always does).');
  out();
  out('| leg | stored | reused | crossed | overruns | `isFinished` with a round trip | `isFinished` without |');
  out('|---|---:|---:|---:|---:|---:|---:|');
  for (const leg of legs) {
    const b = binding(settlementsOf(leg));
    out(`| ${leg.label} | ${b.stored} | ${b.reused} | ${b.crossed} | ${b.overruns} | ${b.isFinishedFresh} | ${b.isFinishedNoRead} |`);
    if (b.crossed > 0) findings.push(`${leg.label}: ${b.crossed} reused snapshots crossed from another handler (binding B)`);
  }
  out();

  // 4. latency
  out('## Latency per settlement (integration result, not F-numbers by themselves)');
  out();
  out('p50 / p95 / p99 / max in milliseconds, or in round trips. "policy" sums the policy calls of one settlement;');
  out('in the shadow legs that is both policies, the one that answers and the one compared. "store calls" counts');
  out('calls into both TypeORM stores in one settlement, the policy\'s reads included (its reader is the step store).');
  out();
  out('| scope | leg | handler ms | policy ms | policy round trips | round trips per call | store calls |');
  out('|---|---|---|---|---|---|---|');
  const loopLatency = new Map<string, Latency>();
  for (const scope of ['loop', 'other'] as const) {
    for (const leg of legs) {
      const ids = new Set(leg.runs.filter((r) => (r.workflow === LOOP_WORKFLOW) === (scope === 'loop')).map((r) => r.executionId));
      const records = settlementsOf(leg).filter((r) => ids.has(r.executionId));
      const names = new Map([...leg.executions.values()].flatMap((e) => e.nodes.map((n) => [n.id, n.name] as const)));
      const l = latency(records, names);
      if (scope === 'loop') loopLatency.set(leg.label, l);
      out(`| ${scope === 'loop' ? LOOP_WORKFLOW : 'every other workflow'} | ${leg.label} | ${dist(l.handlerMs)} | ${dist(l.policyMs)} | ${dist(l.roundTrips, int)} | ${dist(l.roundTripsPerCall, int)} | ${dist(l.storeCalls, int)} |`);
    }
  }
  out();

  // 4b. by pass
  out('## Loop Over Items latency by quarter of the passes');
  out();
  out('Per settlement, by the settled row\'s iteration: policy ms and handler ms as p50 / p95, and the most policy round trips.');
  out();
  out('| leg | quarter (passes) | policy p50 / p95 | handler p50 / p95 | most round trips |');
  out('|---|---|---|---|---:|');
  for (const leg of legs) {
    const ids = new Set(leg.runs.filter((r) => r.workflow === LOOP_WORKFLOW).map((r) => r.executionId));
    for (const q of byQuarter(settlementsOf(leg).filter((r) => ids.has(r.executionId)))) {
      out(`| ${leg.label} | ${q.quarter} (${q.from}–${q.to}) | ${ms(q.policyMs.p50)} / ${ms(q.policyMs.p95)} | ${ms(q.handlerMs.p50)} / ${ms(q.handlerMs.p95)} | ${q.maxRoundTrips} |`);
    }
  }
  out();

  // 5. F4
  let f4: Summary['f4'] = null;
  const primary = loopLatency.get('primary');
  const off = loopLatency.get('off');
  out('## F4');
  out();
  if (primary === undefined || off === undefined || primary.policyMs.n === 0 || off.handlerMs.n === 0) {
    out('Not evaluated: it needs the `off` and `primary` legs with Loop Over Items runs under `--timing`.');
    notes.push('F4 not evaluated: the off and primary legs with loop runs are both needed.');
  } else {
    const ratio = primary.policyMs.p95 / off.handlerMs.p95;
    const policyVsPolicy = primary.policyMs.p95 / off.policyMs.p95;
    const handlerVsHandler = primary.handlerMs.p95 / off.handlerMs.p95;
    const fires = primary.roundTrips.max > 3 || ratio > 2;
    f4 = { fires, maxRoundTrips: primary.roundTrips.max, policyP95: primary.policyMs.p95, offHandlerP95: off.handlerMs.p95, ratio, policyVsPolicy, handlerVsHandler };
    out(`- Round trips: at most **${primary.roundTrips.max}** in one settlement under \`primary\` (limit 3); ${primary.over3.length} settlements over 3.`);
    for (const s of primary.over3.slice(0, 10)) out(`  - ${s}`);
    out(`  - For comparison, n8n's default under \`off\`: at most ${off.roundTrips.max} in one settlement; ${off.over3.length} over 3.`);
    out(`- Latency: the policy's p95 per settlement under \`primary\` is ${ms(primary.policyMs.p95)} ms; n8n's handler p95 under \`off\` is ${ms(off.handlerMs.p95)} ms; ratio **${ratio.toFixed(2)}** (limit 2).`);
    out(`- Stricter readings, reported and not deciding F4: policy p95 against n8n's default policy p95 ${policyVsPolicy.toFixed(2)}; handler p95 under \`primary\` against under \`off\` ${handlerVsHandler.toFixed(2)}.`);
    out(`- **F4 ${fires ? 'fires' : 'does not fire'}.**`);
    if (fires) findings.push(`F4: max round trips ${primary.roundTrips.max} (limit 3), policy p95 / off handler p95 = ${ratio.toFixed(2)} (limit 2)`);
  }
  out();

  // 6. wall clocks
  out('## Wall clocks (what `run.mjs` printed; not results)');
  out();
  out(`| workflow | ${legs.map((l) => l.label).join(' | ')} |`);
  out(`|---|${legs.map(() => '---').join('|')}|`);
  for (const workflow of workflows) {
    out(`| ${workflow} | ${legs.map((l) => l.runs.filter((r) => r.workflow === workflow).map((r) => r.elapsedMs).join(', ') || '–').join(' | ')} |`);
  }
  out();

  out('## Findings');
  out();
  out(findings.length === 0 ? 'None.' : findings.map((f) => `- ${f}`).join('\n'));
  out();
  out('## Notes');
  out();
  out(notes.length === 0 ? 'None.' : notes.map((n) => `- ${n}`).join('\n'));
  out();

  return { markdown: lines.join('\n'), summary: { legs: legs.map((l) => l.label), findings, notes, f3, f4 } };
}

function main(argv: readonly string[]): number {
  const [dir, ...labels] = argv;
  if (dir === undefined || labels.length === 0) {
    console.error('usage: tsx tests/testbed/compare-v2.ts <out-dir> <leg> [<leg> ...]   (the first leg is the reference)');
    return 2;
  }
  const legs = labels.map((label) => loadLeg(join(dir, label), label));
  const { markdown, summary } = compare(legs);
  writeFileSync(join(dir, 'report.md'), `${markdown}\n`);
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(markdown);
  return summary.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
