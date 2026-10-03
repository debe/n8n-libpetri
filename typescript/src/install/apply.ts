/**
 * `n8n-libpetri install` and `uninstall` (`tasks/inject-plan.md` decision 10).
 *
 * Every file the installer touches is replaced through a temp file and a rename, so at any
 * instant each one is either stock or as written, never torn. What can be cut short is the
 * sequence, so both runs are ordered to keep n8n-core loadable at every point of it and to
 * leave a journal that lets `uninstall` finish the way back from wherever a run stopped:
 *
 * - The patched `workflow-execute.js` and `index.js` require the files the seam creates. Install
 *   therefore writes the created files first and the replaced ones after them; uninstall
 *   restores the replaced files first and removes the created ones after them. Stopped
 *   anywhere, a patched file never requires a file that is not there.
 * - Install takes the lock, writes the journal, backs up the originals and verifies the copies,
 *   writes the files, then the record, and removes the journal. Any failure it sees restores
 *   what it wrote and removes the state directory. A target already installed from the same
 *   seams is left alone (exit 0).
 * - Uninstall takes the lock, checks every recorded file and the backups it needs, turns the
 *   record into a journal, restores, removes and verifies, then removes the state directory.
 *   The result is byte-identical to the stock release.
 *
 * A run that is killed (SIGKILL, a closed container) leaves the journal, the backups and a
 * lock whose holder is gone. `status` reports `interrupted`; `uninstall` takes the stale lock
 * over (`lock.ts`), accepts each file being stock or as written, finishes the restore and
 * removes the temp files the run left. A run killed before its journal left only the state
 * directory; `uninstall` removes it and `install` starts over in it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT, InstallError, inconsistent, isPermissionError, refused } from './errors.js';
import { nodeFileOps, sweepTemps, type FileOps } from './fs-ops.js';
import type { Located } from './locate.js';
import { acquireLock, describeHolder, type Lock } from './lock.js';
import { requireNeutrality, type LoadedManifest } from './manifest.js';
import { planInstall, type InstallPlan } from './plan.js';
import {
  BACKUP_DIR, JOURNAL_FILE, LOCK_FILE, RECORD_FILE, driftedFiles, readJournal, readRecord, sha256, sha256File, stateDir,
  type InstallJournal, type InstallRecord, type RecordedFile,
} from './record.js';

/** A file whose presence means the scheduler seam is in n8n-core (patch 0002's registry). */
export const SEAM_MARKER = 'dist/execution-engine/scheduler-registry.js';

export interface InstallOptions {
  readonly located: Located;
  readonly loaded: LoadedManifest;
  readonly allowUnverified?: boolean;
  readonly toolVersion: string;
  readonly ops?: FileOps;
  readonly now?: () => Date;
}

export type InstallResult =
  | { readonly status: 'installed'; readonly record: InstallRecord; readonly plan: InstallPlan; readonly staleLock: string | null }
  | { readonly status: 'already-installed'; readonly record: InstallRecord };

export interface UninstallOptions {
  readonly located: Located;
  readonly ops?: FileOps;
}

export type UninstallResult =
  /** `leftover`: a state directory from a run killed before it changed any file was removed. */
  | { readonly status: 'not-installed'; readonly leftover: boolean; readonly staleLock: string | null }
  | {
    readonly status: 'uninstalled';
    readonly restored: readonly string[];
    readonly removed: readonly string[];
    /** Finished from a journal (a run that stopped midway) rather than from a record. */
    readonly interrupted: boolean;
    readonly staleLock: string | null;
  };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Turns a filesystem permission failure into exit 4, naming who owns the directory. */
function permission(e: unknown, where: string, note = ''): never {
  if (e instanceof InstallError) throw e;
  if (isPermissionError(e)) {
    let owner = '';
    try {
      const st = statSync(where);
      owner = ` (owned by uid ${st.uid}; you are uid ${process.getuid?.() ?? '?'})`;
    } catch {
      // unreadable too
    }
    throw new InstallError(`permission denied: ${e.message.replace(/^[A-Z]+: /, '')}; ${where} is not writable${owner}. Run as its owner, or with sudo for a global install${note}`, EXIT.permission);
  }
  throw e;
}

/** Whether the scheduler seam is present without a record: someone else put it there. */
export function seamWithoutRecord(coreDir: string, loaded: LoadedManifest | undefined): boolean {
  if (existsSync(join(coreDir, SEAM_MARKER))) return true;
  return loaded?.manifest.files.some((f) => f.before === null && existsSync(join(coreDir, f.path))) ?? false;
}

/** The sentence for a journal without a record, by the run that wrote it. */
export function interruptedRun(journal: InstallJournal): string {
  return journal.operation === 'uninstall' ? 'an uninstall stopped before it finished' : 'an install stopped before it wrote its record';
}

const modeOf = (path: string, fallback: string): number => {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return statSync(fallback).mode & 0o7777;
  }
};

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Every path the seam could have written in `coreDir`, for the temp-file sweep. */
function seamPaths(coreDir: string, files: readonly { path: string }[], loaded?: LoadedManifest): string[] {
  const all = new Set<string>([SEAM_MARKER, ...files.map((f) => f.path)]);
  for (const f of loaded?.manifest.files ?? []) all.add(f.path);
  for (const m of loaded?.manifest.maps.files ?? []) all.add(m.path);
  return [...all].map((p) => join(coreDir, p));
}

interface Original {
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * Drives every file of `files` back to its stock bytes: replaced files first, created files
 * after them (see the module comment), then the temp files, then a check of every file.
 * `originals` must hold the stock bytes of every replaced file that is not stock now.
 */
function restoreStock(coreDir: string, files: readonly RecordedFile[], originals: ReadonlyMap<string, Original>, ops: FileOps, loaded?: LoadedManifest): { restored: string[]; removed: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  for (const f of files) {
    if (f.before === null) continue;
    const target = join(coreDir, f.path);
    if (sha256File(target) === f.before) continue;
    const original = originals.get(f.path);
    if (original === undefined) throw inconsistent(`no stock copy of ${f.path} to restore it from`);
    ops.writeAtomic(target, original.bytes, original.mode);
    restored.push(f.path);
  }
  for (const f of files) {
    if (f.before !== null) continue;
    const target = join(coreDir, f.path);
    if (!existsSync(target)) continue;
    ops.remove(target);
    removed.push(f.path);
  }
  sweepTemps(seamPaths(coreDir, files, loaded));
  for (const f of files) {
    const found = sha256File(join(coreDir, f.path));
    if (found !== f.before) throw inconsistent(`after restoring, ${f.path} has sha256 ${found ?? 'none'}, expected ${f.before ?? 'no file'}`);
  }
  return { restored, removed };
}

/** Takes the lock, mapping a filesystem refusal to exit 4. */
function lockState(state: string, coreDir: string): Lock {
  try {
    mkdirSync(state, { recursive: true });
    return acquireLock(state);
  } catch (e) {
    permission(e, existsSync(state) ? state : coreDir);
  }
}

export function install(options: InstallOptions): InstallResult {
  const { located, loaded } = options;
  const { coreDir } = located;
  const ops = options.ops ?? nodeFileOps;
  const unverified = requireNeutrality(loaded, options.allowUnverified ?? false);

  const existing = readRecord(coreDir);
  if (existing !== null) {
    const drifted = driftedFiles(coreDir, existing);
    if (drifted.length > 0) throw inconsistent(`n8n-core at ${coreDir} was changed after install (${drifted.map((d) => d.path).join(', ')}); run \`n8n-libpetri status\``);
    if (existing.manifestSha256 === loaded.sha256) return { status: 'already-installed', record: existing };
    throw inconsistent(`n8n-core at ${coreDir} is installed from other seams (n8n-libpetri ${existing.tool.version}); run \`n8n-libpetri uninstall\` first`);
  }
  const journal = readJournal(coreDir);
  if (journal !== null) {
    throw inconsistent(`in ${coreDir} ${interruptedRun(journal)}; run \`n8n-libpetri uninstall\` to restore the stock files${journal.operation === 'uninstall' ? '' : ', then install again'}`);
  }
  if (seamWithoutRecord(coreDir, loaded)) {
    throw inconsistent(`n8n-core at ${coreDir} already carries a scheduler seam that n8n-libpetri did not install; reinstall n8n to get the stock files back`);
  }

  const plan = planInstall(coreDir, loaded);
  const state = stateDir(coreDir);
  const lock = lockState(state, coreDir);
  try {
    if (readRecord(coreDir) !== null || readJournal(coreDir) !== null) {
      throw refused(`another n8n-libpetri run changed ${coreDir} while this one waited for the lock; run \`n8n-libpetri status\``);
    }
    // Whatever is here besides the lock is what a run killed before its journal left
    // (backups, a temp journal); nothing outside the state directory was changed by it.
    for (const entry of readdirSync(state)) if (entry !== LOCK_FILE) rmSync(join(state, entry), { recursive: true, force: true });
    sweepTemps(seamPaths(coreDir, plan.writes, loaded));
  } catch (e) {
    lock.release();
    permission(e, state);
  }

  // Created files first: the replaced ones require them (see the module comment).
  const order = [...plan.writes.filter((w) => w.before === null), ...plan.writes.filter((w) => w.before !== null)];
  const files: RecordedFile[] = order.map(({ path, before, after }) => ({ path, before, after }));
  const originals = new Map<string, Original>();
  try {
    const journalBody: InstallJournal = { schema: 1, version: loaded.manifest.version, operation: 'install', files };
    ops.writeAtomic(join(state, JOURNAL_FILE), json(journalBody), 0o644);
    for (const w of order) {
      if (w.before === null) continue;
      const target = join(coreDir, w.path);
      const backup = join(state, BACKUP_DIR, w.path);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(target, backup);
      if (sha256File(backup) !== w.before) throw refused(`the backup of ${w.path} does not match the original; nothing was written`);
      originals.set(w.path, { bytes: readFileSync(target), mode: modeOf(target, target) });
    }
    for (const w of order) {
      const target = join(coreDir, w.path);
      const mode = originals.get(w.path)?.mode ?? modeOf(target, join(coreDir, loaded.manifest.files[0]!.deltaSource));
      ops.writeAtomic(target, w.bytes, mode);
    }
    const record: InstallRecord = {
      schema: 1,
      tool: { name: 'n8n-libpetri', version: options.toolVersion },
      package: 'n8n-core',
      version: loaded.manifest.version,
      manifestSha256: loaded.sha256,
      sourcePatches: loaded.manifest.sourcePatches,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      unverified,
      files,
    };
    ops.writeAtomic(join(state, RECORD_FILE), json(record), 0o644);
    ops.remove(join(state, JOURNAL_FILE));
    lock.release();
    return { status: 'installed', record, plan, staleLock: lock.tookOver === null ? null : describeHolder(lock.tookOver) };
  } catch (e) {
    let failure: string | null = null;
    try {
      restoreStock(coreDir, files, originals, { writeAtomic: nodeFileOps.writeAtomic, remove: ops.remove }, loaded);
    } catch (r) {
      failure = message(r);
    }
    if (failure !== null) {
      lock.release();
      throw inconsistent(`install failed (${message(e)}) and the rollback failed too (${failure}); the backups and journal are kept in ${state}, run \`n8n-libpetri uninstall\``);
    }
    try {
      rmSync(state, { recursive: true, force: true });
    } catch {
      // What is left is a state directory over stock files: `uninstall` removes it.
      lock.release();
    }
    if (e instanceof InstallError || isPermissionError(e)) permission(e, coreDir);
    throw refused(`install failed (${message(e)}); every file it had written was restored, so n8n-core is stock again`);
  }
}

export function uninstall(options: UninstallOptions, loaded?: LoadedManifest): UninstallResult {
  const { coreDir } = options.located;
  const ops = options.ops ?? nodeFileOps;
  const state = stateDir(coreDir);
  if (!existsSync(state)) {
    if (seamWithoutRecord(coreDir, loaded)) {
      throw inconsistent(`n8n-core at ${coreDir} carries a scheduler seam but no n8n-libpetri install record, so there is nothing to restore from; reinstall n8n to get the stock files back`);
    }
    return { status: 'not-installed', leftover: false, staleLock: null };
  }

  const lock = lockState(state, coreDir);
  const staleLock = lock.tookOver === null ? null : describeHolder(lock.tookOver);
  // Set once the record is gone and files may change: from then on a failure leaves a journal
  // that the next `uninstall` finishes from.
  let changing = false;
  try {
    const record = readRecord(coreDir);
    const journal = record === null ? readJournal(coreDir) : null;
    if (record === null && journal === null) {
      if (seamWithoutRecord(coreDir, loaded)) {
        throw inconsistent(`n8n-core at ${coreDir} carries a scheduler seam but no n8n-libpetri install record, so there is nothing to restore from; reinstall n8n to get the stock files back`);
      }
      // A run killed before its journal: it changed nothing outside the state directory.
      sweepTemps(seamPaths(coreDir, [], loaded));
      rmSync(state, { recursive: true, force: true });
      return { status: 'not-installed', leftover: true, staleLock };
    }
    const files = record?.files ?? journal!.files;

    if (record !== null) {
      const drifted = driftedFiles(coreDir, record);
      if (drifted.length > 0) {
        throw inconsistent(`n8n-core at ${coreDir} was changed after install (${drifted.map((d) => `${d.path}: sha256 ${d.found ?? 'missing'}, installed ${d.expected}`).join('; ')}); not restoring over it. Reinstall n8n to get the stock files back`);
      }
    } else {
      // A run that stopped midway: each file is either still stock or already as written.
      const odd = files.filter((f) => {
        const found = sha256File(join(coreDir, f.path));
        return found !== f.after && found !== f.before;
      });
      if (odd.length > 0) throw inconsistent(`${interruptedRun(journal!)} and left ${odd.map((f) => f.path).join(', ')} in neither the stock nor the installed state; reinstall n8n`);
    }
    // A backup is needed for every replaced file that is not stock now.
    const originals = new Map<string, Original>();
    for (const f of files) {
      if (f.before === null) continue;
      const target = join(coreDir, f.path);
      if (sha256File(target) === f.before) continue;
      const backup = join(state, BACKUP_DIR, f.path);
      const bytes = existsSync(backup) ? readFileSync(backup) : undefined;
      if (bytes === undefined || sha256(bytes) !== f.before) {
        throw inconsistent(`the backup of ${f.path} is ${bytes === undefined ? 'missing' : 'damaged'} (${backup}); the stock file cannot be restored. Reinstall n8n (npm i -g n8n@<version>)`);
      }
      originals.set(f.path, { bytes, mode: modeOf(target, target) });
    }

    if (record !== null) {
      // From here on the record no longer describes the files: the journal does.
      const body: InstallJournal = { schema: 1, version: record.version, operation: 'uninstall', files };
      ops.writeAtomic(join(state, JOURNAL_FILE), json(body), 0o644);
      changing = true;
      ops.remove(join(state, RECORD_FILE));
    }
    changing = true;
    const { restored, removed } = restoreStock(coreDir, files, originals, ops, loaded);
    rmSync(state, { recursive: true, force: true });
    return { status: 'uninstalled', restored, removed, interrupted: record === null, staleLock };
  } catch (e) {
    lock.release();
    const kept = `; n8n-core is part way back to stock, and the journal and backups are kept in ${state}: run \`n8n-libpetri uninstall\` again`;
    if (e instanceof InstallError) {
      if (!changing || e.exitCode !== EXIT.inconsistent) throw e;
      throw inconsistent(`${e.message}${kept}`);
    }
    if (isPermissionError(e)) permission(e, coreDir, changing ? kept : '');
    throw inconsistent(`uninstall stopped (${message(e)})${changing ? kept : `; nothing was changed in ${coreDir}`}`);
  }
}
