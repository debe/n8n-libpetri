/**
 * `n8n-libpetri status`: what state an n8n-core is in, and whether this shell would activate
 * the engine (`tasks/inject-plan.md` decision 10).
 *
 * - `stock`: no seam, and every file matches a shipped manifest's `before`; `install` would work
 *   (without `--allow-unverified` only when the manifest's neutrality record passed).
 * - `stock-unsupported`: no seam, but no manifest for this n8n-core version or its files differ.
 * - `installed`: the record's files all hash to what was written.
 * - `modified`: there is a record but some files changed since (each one is listed).
 * - `orphaned`: the seam is present with no record, so nothing can restore the stock files.
 * - `interrupted`: a journal without a record, an install or uninstall that stopped midway;
 *   `uninstall` finishes the way back to stock from the backups.
 *
 * A state directory with neither a record nor a journal is what a run killed before it
 * changed any file leaves; the state is still `stock`, with a line saying `uninstall` removes
 * it. A lock is reported with whether its holder still runs.
 *
 * The first three exit 0, the last three 3 (inconsistent state).
 */
import { existsSync, realpathSync } from 'node:fs';
import { interruptedRun, seamWithoutRecord } from './apply.js';
import { EXIT, type ExitCode } from './errors.js';
import type { Located } from './locate.js';
import type { LoadedManifest, NeutralityRecord } from './manifest.js';
import { describeMismatch, stockMismatches } from './plan.js';
import { describeHolder, holderState, readLock } from './lock.js';
import { driftedFiles, readJournal, readRecord, STATE_DIR, stateDir } from './record.js';

export type InstallState = 'stock' | 'stock-unsupported' | 'installed' | 'modified' | 'orphaned' | 'interrupted';

export interface EnvironmentReport {
  /** `N8N_EXECUTION_ENGINE` as set in this environment. */
  readonly engine: string | null;
  /** True when it is `libpetri`; false when unset or empty; an error string otherwise. */
  readonly active: boolean | string;
  /** The `EXTERNAL_HOOK_FILES` entries. */
  readonly hookFiles: readonly string[];
  /** Whether one of them is this package's hook. */
  readonly hookListed: boolean;
  readonly hook: string;
}

export interface StatusReport {
  readonly state: InstallState;
  readonly n8nDir: string;
  readonly n8nVersion: string | null;
  readonly coreDir: string;
  readonly coreVersion: string;
  /** Whether this package ships seams for the n8n-core version. */
  readonly listed: boolean;
  readonly neutrality: NeutralityRecord | null;
  /** Installed without a neutrality record (`--allow-unverified`). */
  readonly unverified: boolean;
  readonly installedBy: string | null;
  /** One line per finding: a mismatching or drifted file, the reason for the state. */
  readonly details: readonly string[];
  readonly environment: EnvironmentReport;
}

export function environmentReport(env: NodeJS.ProcessEnv, hook: string): EnvironmentReport {
  const engine = env.N8N_EXECUTION_ENGINE;
  const active = engine === undefined || engine === '' ? false : engine === 'libpetri' ? true : `N8N_EXECUTION_ENGINE='${engine}' is not 'libpetri'; the hook refuses to start n8n`;
  const separator = env.EXTERNAL_HOOK_FILES_SEPARATOR || ':';
  const hookFiles = (env.EXTERNAL_HOOK_FILES ?? '').split(separator).map((s) => s.trim()).filter((s) => s !== '');
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const ours = real(hook);
  return { engine: engine ?? null, active, hookFiles, hookListed: hookFiles.some((f) => real(f) === ours), hook };
}

export function status(located: Located, manifests: ReadonlyMap<string, LoadedManifest>, env: NodeJS.ProcessEnv, hook: string): StatusReport {
  const { coreDir } = located;
  const loaded = manifests.get(located.coreVersion);
  const base = {
    n8nDir: located.n8nDir,
    n8nVersion: located.n8nVersion ?? null,
    coreDir,
    coreVersion: located.coreVersion,
    listed: loaded !== undefined,
    neutrality: loaded?.manifest.neutrality ?? null,
    environment: environmentReport(env, hook),
  };
  const lock = lockLine(stateDir(coreDir));
  const record = readRecord(coreDir);
  if (record !== null) {
    const drifted = driftedFiles(coreDir, record);
    return {
      ...base,
      state: drifted.length === 0 ? 'installed' : 'modified',
      unverified: record.unverified,
      installedBy: `n8n-libpetri ${record.tool.version} at ${record.installedAt}`,
      details: [...drifted.map((d) => `${d.path}: sha256 ${d.found ?? 'missing'}, installed ${d.expected}`), ...lock],
    };
  }
  const nothing = { unverified: false, installedBy: null };
  const journal = readJournal(coreDir);
  if (journal !== null) {
    return { ...base, ...nothing, state: 'interrupted', details: [`${interruptedRun(journal)}; \`n8n-libpetri uninstall\` restores the stock files from the backups`, ...lock] };
  }
  if (seamWithoutRecord(coreDir, loaded)) {
    return { ...base, ...nothing, state: 'orphaned', details: ['the scheduler seam is present but n8n-libpetri has no record of installing it; reinstall n8n to get the stock files back', ...lock] };
  }
  const leftover = existsSync(stateDir(coreDir))
    ? [`${STATE_DIR}/ is left from a run that stopped before it changed any file; \`n8n-libpetri uninstall\` removes it`, ...lock]
    : [];
  if (loaded === undefined) {
    return { ...base, ...nothing, state: 'stock-unsupported', details: [`no seams for n8n-core ${located.coreVersion}`, ...leftover] };
  }
  const mismatches = stockMismatches(coreDir, loaded);
  return { ...base, ...nothing, state: mismatches.length === 0 ? 'stock' : 'stock-unsupported', details: [...mismatches.map(describeMismatch), ...leftover] };
}

/** One line for a lock in the state directory, or none. */
function lockLine(state: string): string[] {
  let holder;
  try {
    holder = readLock(state);
  } catch {
    return [];
  }
  if (holder === null) return [];
  switch (holderState(holder)) {
    case 'alive': return [`an n8n-libpetri run (${describeHolder(holder)}) holds the lock and is still running`];
    case 'dead': return [`a lock is left by ${describeHolder(holder)}, which no longer runs; the next install or uninstall takes it over`];
    case 'unknown': return [`a lock is held by ${describeHolder(holder)}; whether it still runs cannot be told from here`];
  }
}

export function statusExitCode(report: StatusReport): ExitCode {
  return report.state === 'modified' || report.state === 'orphaned' || report.state === 'interrupted' ? EXIT.inconsistent : EXIT.ok;
}

/** The human-readable report. */
export function renderStatus(r: StatusReport): string {
  const lines = [
    `state: ${r.state}`,
    `n8n: ${r.n8nVersion ?? '?'} at ${r.n8nDir}`,
    `n8n-core: ${r.coreVersion} at ${r.coreDir}`,
    `seams: ${r.listed ? `shipped for n8n-core ${r.coreVersion}` : 'none for this version'}${r.listed ? (r.neutrality?.passed ? `, neutrality record ${r.neutrality.date}` : ', no neutrality record yet') : ''}`,
  ];
  if (r.installedBy !== null) lines.push(`installed by: ${r.installedBy}${r.unverified ? ' (with --allow-unverified)' : ''}`);
  for (const d of r.details) lines.push(`  ${d}`);
  const e = r.environment;
  lines.push(`environment: N8N_EXECUTION_ENGINE=${e.engine ?? '(unset)'}${typeof e.active === 'string' ? ` (${e.active})` : ''}; EXTERNAL_HOOK_FILES ${e.hookListed ? 'lists' : 'does not list'} ${e.hook}`);
  if (r.state === 'installed' && (e.active !== true || !e.hookListed)) {
    lines.push(`  n8n started from this shell runs its own loop; \`eval "$(n8n-libpetri env)"\` sets both variables`);
  }
  if ((r.state === 'stock' || r.state === 'stock-unsupported') && e.active === true && e.hookListed) {
    lines.push('  n8n started from this shell refuses to start: the hook finds no scheduler seam');
  }
  if (r.state === 'stock') {
    lines.push(r.neutrality?.passed
      ? '  `n8n-libpetri install` would patch this n8n-core'
      : `  \`n8n-libpetri install\` refuses these seams without --allow-unverified (${r.neutrality === null ? 'no neutrality record' : 'a failed neutrality record'})`);
  }
  return `${lines.join('\n')}\n`;
}
