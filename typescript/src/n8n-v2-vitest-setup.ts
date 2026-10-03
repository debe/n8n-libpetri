/**
 * The vitest setup entry for the engine v2 settlement leg (`tasks/v2-seam-plan.md` step 10).
 * `scripts/run-conformance.sh` generates a shim inside the n8n package under test
 * (`.n8n-libpetri-v2-setup.mjs`) that imports `@n8n/engine`'s settlement registry from where the
 * package's own tests load it, and hands it to {@link SettlementVitestSession.registerFile}:
 *
 * - `@n8n/engine`'s own tests load the engine from `src`, so the shim imports
 *   `src/execution/settlement-policy-registry.ts` (and `settlement-policy.ts`);
 * - the compat package and `packages/cli` resolve `@n8n/engine` to its built `dist`, so the shim
 *   imports the package.
 *
 * A registry set on the wrong instance is accepted and never read (F5): the runtime the tests build
 * keeps n8n's default policy, every case passes, and the leg would measure n8n under our name. So
 * the session counts, per case, how often the registered policy was **entered** (its
 * `settlement policy entered` diagnostic), and writes one JSONL record per case and per file to
 * the ledger `N8N_SETTLEMENT_LEDGER` names. `conformance/v2/entered.ts` joins the ledger with
 * the leg's junit: the leg's headline is policy-entering cases passed, never a raw pass count.
 *
 * Registering is gated on `N8N_SETTLEMENT_POLICY=libpetri`, so the same shim is inert otherwise.
 * `N8N_SETTLEMENT_MODE` picks `register.ts`'s mode (default `primary`); in the shadow modes every
 * shadow report that is not an agreement is written to the ledger too.
 */
import { appendFileSync } from 'node:fs';

import { assertNever } from './internal/assert.js';
import { messageOf } from './internal/errors.js';
import type { V2SettlementRegistry } from './n8n/v2-host.js';
import type { SettlementDiagnostic, SettlementMethod } from './settlement/policy.js';
import { registerSettlementPolicy, SETTLEMENT_MODES } from './settlement/register.js';
import type { SettlementMode } from './settlement/register.js';
import type { ShadowReport } from './settlement/shadow.js';

/** `libpetri` registers the net-backed policy; anything else leaves n8n's default in place. */
export const SETTLEMENT_POLICY_ENV = 'N8N_SETTLEMENT_POLICY';
/** `register.ts`'s mode; default `primary`. */
export const SETTLEMENT_MODE_ENV = 'N8N_SETTLEMENT_MODE';
/** The JSONL file the session appends its records to. Unset: nothing is written. */
export const SETTLEMENT_LEDGER_ENV = 'N8N_SETTLEMENT_LEDGER';

/** What the registered policy did inside one window (a case, or a file outside its cases). */
export interface SettlementCounts {
  /** `settlement policy entered`, per method. */
  readonly decideSuccessors: number;
  readonly isFinished: number;
  /** `settlement policy race` (decision 8's named races). */
  readonly races: number;
  /** `settlement policy error`: the policy threw. */
  readonly errors: number;
  /** Shadow reports by verdict, in the shadow modes; all 0 in `primary`. */
  readonly agree: number;
  readonly disagree: number;
  readonly shadowRace: number;
  readonly candidateThrew: number;
  /** A reused `isFinished` said false where the fresh side said true (`shadow.ts`): counted, not an agreement. */
  readonly stale: number;
}

/** One line of the ledger. */
export type SettlementLedgerRecord =
  | {
    readonly kind: 'case';
    /** The test file relative to the package root, as junit's `classname`. */
    readonly file: string;
    /** The describe path and the title joined with ` > `, as junit's `name`. */
    readonly name: string;
    readonly state: string;
    readonly counts: SettlementCounts;
  }
  | {
    readonly kind: 'file';
    readonly file: string;
    /** Whether the policy was set on the registry this file's runtime reads. */
    readonly registered: boolean;
    /** Why not, when it was not. */
    readonly reason: string | null;
    readonly mode: SettlementMode;
    /** What happened in this file outside every case window: `beforeAll`, `afterAll`, late work. */
    readonly outside: SettlementCounts;
  }
  | {
    readonly kind: 'error';
    readonly file: string;
    /** The case the error fell in, `null` outside every case. */
    readonly name: string | null;
    readonly method: SettlementMethod;
    readonly errorName: string;
    readonly error: string;
  }
  | {
    readonly kind: 'shadow';
    readonly file: string;
    readonly name: string | null;
    readonly report: Omit<ShadowReport, 'primaryRows' | 'candidateRows'> & { readonly rows: number };
  };

/** The subset of a vitest task the session reads. */
export interface TaskLike {
  readonly name: string;
  readonly suite?: TaskLike | undefined;
  readonly file?: { readonly name: string } | undefined;
  readonly result?: { readonly state?: string } | undefined;
  /** Set on the file task only. */
  readonly filepath?: string | undefined;
}

export interface SettlementVitestSession {
  /** `libpetri` when the environment asks for the net-backed policy. */
  readonly engine: 'libpetri' | 'default';
  readonly mode: SettlementMode;
  /**
   * Called once per test file, before its cases: sets the policy on `engine`'s registry, or
   * records why it could not (`reason`; the shim's import failed). Returns whether it registered.
   */
  registerFile(file: string, engine: V2SettlementRegistry | null, reason?: string): boolean;
  /** From the shim's `beforeEach`: opens the case's window. */
  beginCase(task: TaskLike): void;
  /** From the shim's `afterEach`: closes it and writes the case's record. */
  endCase(task: TaskLike): void;
  endFile(file: string): void;
}

export interface SettlementVitestOptions {
  readonly env?: Record<string, string | undefined>;
  /** Appends one line to the ledger. Default: `appendFileSync` on `N8N_SETTLEMENT_LEDGER`. */
  readonly append?: (line: string) => void;
  /** Human-readable lines (registration, errors). Default: `process.stderr.write`. */
  readonly log?: (line: string) => void;
}

const ZERO: SettlementCounts = {
  decideSuccessors: 0, isFinished: 0, races: 0, errors: 0, agree: 0, disagree: 0, shadowRace: 0, candidateThrew: 0, stale: 0,
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The junit name of a case: its describe path and title joined with ` > `, without the file. */
export function junitNameOf(task: TaskLike): string {
  const parts = [task.name];
  // Up the describe chain to the file task, which is not part of the name. A top-level describe's
  // `suite` may be the file task or absent, depending on the vitest version: stop at either.
  for (let s = task.suite; s !== undefined && s !== task.file && s.filepath === undefined; s = s.suite) parts.unshift(s.name);
  return parts.join(' > ');
}

/** The session the generated shim drives (see the module doc). */
export function createSettlementVitestSession(options: SettlementVitestOptions = {}): SettlementVitestSession {
  const env = options.env ?? process.env;
  const engine = env[SETTLEMENT_POLICY_ENV] === 'libpetri' ? 'libpetri' : 'default';
  const requested = env[SETTLEMENT_MODE_ENV] ?? 'primary';
  if (!(SETTLEMENT_MODES as readonly string[]).includes(requested)) {
    throw new RangeError(`${SETTLEMENT_MODE_ENV}='${requested}' is not one of ${SETTLEMENT_MODES.join(', ')}`);
  }
  const mode = requested as SettlementMode;
  const ledgerPath = env[SETTLEMENT_LEDGER_ENV];
  const append = options.append
    ?? (ledgerPath === undefined || ledgerPath === '' ? () => {} : (line: string) => appendFileSync(ledgerPath, line));
  const log = options.log ?? ((line: string) => { process.stderr.write(line); });
  const write = (record: SettlementLedgerRecord): void => append(`${JSON.stringify(record)}\n`);

  let file = '';
  let caseName: string | null = null;
  let current: Mutable<SettlementCounts> = { ...ZERO };
  let outside: Mutable<SettlementCounts> = { ...ZERO };
  let registered = false;
  let reason: string | null = null;
  const window = (): Mutable<SettlementCounts> => (caseName === null ? outside : current);

  const onDiagnostic = (d: SettlementDiagnostic): void => {
    const w = window();
    switch (d.kind) {
      case 'entered': w[d.method] += 1; break;
      case 'race': w.races += 1; break;
      case 'error':
        w.errors += 1;
        write({ kind: 'error', file, name: caseName, method: d.method, errorName: d.name, error: d.error });
        log(`[n8n-libpetri] settlement policy error in ${file}: ${d.name}: ${d.error.split('\n')[0] ?? ''}\n`);
        break;
      case 'registered': break;
    }
  };
  const onShadowReport = (r: ShadowReport): void => {
    const w = window();
    switch (r.verdict) {
      case 'agree': w.agree += 1; return;
      case 'disagree': w.disagree += 1; break;
      case 'race': w.shadowRace += 1; break;
      case 'candidate-threw': w.candidateThrew += 1; break;
      case 'stale': w.stale += 1; break;
      default: assertNever(r.verdict, 'shadow verdict');
    }
    const { primaryRows, candidateRows, ...rest } = r;
    write({ kind: 'shadow', file, name: caseName, report: { ...rest, rows: Math.max(primaryRows.length, candidateRows.length) } });
  };

  return {
    engine,
    mode,
    registerFile(name, registry, why) {
      file = name;
      caseName = null;
      current = { ...ZERO };
      outside = { ...ZERO };
      registered = false;
      reason = null;
      if (engine !== 'libpetri') return false;
      if (registry === null) {
        reason = why ?? 'no registry';
        log(`[n8n-libpetri] settlement policy NOT registered in ${name}: ${reason}\n`);
        return false;
      }
      try {
        registerSettlementPolicy(registry, { mode, onDiagnostic, ...(mode === 'primary' ? {} : { onShadowReport }) });
        registered = true;
      } catch (e) {
        reason = messageOf(e);
        log(`[n8n-libpetri] settlement policy NOT registered in ${name}: ${reason}\n`);
      }
      return registered;
    },
    beginCase(task) {
      current = { ...ZERO };
      caseName = junitNameOf(task);
    },
    endCase(task) {
      const name = caseName ?? junitNameOf(task);
      if (engine === 'libpetri') {
        write({ kind: 'case', file: task.file?.name ?? file, name, state: task.result?.state ?? 'unknown', counts: { ...current } });
      }
      caseName = null;
      current = { ...ZERO };
    },
    endFile(name) {
      if (engine !== 'libpetri') return;
      write({ kind: 'file', file: name || file, registered, reason, mode, outside: { ...outside } });
      const entered = outside.decideSuccessors + outside.isFinished;
      if (entered > 0 || outside.errors > 0) {
        log(`[n8n-libpetri] settlement policy entered ${entered} time(s) outside any case in ${name || file}\n`);
      }
    },
  };
}
