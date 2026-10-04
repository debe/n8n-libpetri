/**
 * The install record: what `n8n-libpetri install` changed in one n8n-core directory, kept
 * inside that directory (`<n8n-core>/.n8n-libpetri/`, `tasks/inject-plan.md` decision 9).
 *
 * Living beside the files it describes is the point: `npm i -g n8n@<new>` replaces the
 * directory and the record together, so `status` then reports `stock` rather than an install
 * that no longer exists. Uninstall needs the backups kept here, because a copy/insert delta
 * cannot be reversed.
 *
 * The boot path (`n8n/boot.ts`) reads the record too, to refuse a process whose patched files
 * no longer hash to what the installer wrote; so this module depends on `node:` built-ins only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The directory the installer owns inside n8n-core. */
export const STATE_DIR = '.n8n-libpetri';
export const RECORD_FILE = 'install.json';
export const JOURNAL_FILE = 'journal.json';
export const LOCK_FILE = 'lock';
export const BACKUP_DIR = 'backup';

/** One file the installer wrote: replaced (`before` is the stock hash) or created (`before` null). */
export interface RecordedFile {
  /** Relative to the n8n-core directory, `/`-separated. */
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
}

export interface InstallRecord {
  readonly schema: 1;
  readonly tool: { readonly name: 'n8n-libpetri'; readonly version: string };
  readonly package: 'n8n-core';
  readonly version: string;
  /** sha256 of the manifest the install was made from. */
  readonly manifestSha256: string;
  readonly sourcePatches: Readonly<Record<string, string>>;
  readonly installedAt: string;
  /** True when the manifest had no neutrality record and `--allow-unverified` was given. */
  readonly unverified: boolean;
  /** Code files, then any source maps, in the order they were written. */
  readonly files: readonly RecordedFile[];
}

/**
 * Present while files are being changed: written by `install` before its first backup and
 * removed after the record, and written by `uninstall` (from the record, which it then
 * removes) before its first restore. A journal without a record is a run that stopped midway;
 * every file it lists is then either stock or as written, and `uninstall` finishes the way
 * back to stock from the backups.
 */
export interface InstallJournal {
  readonly schema: 1;
  readonly version: string;
  /** Which run wrote it. Absent in a journal from before uninstall wrote one: `install`. */
  readonly operation?: 'install' | 'uninstall';
  readonly files: readonly RecordedFile[];
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** sha256 of a file, or null when it does not exist. */
export function sha256File(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

export function stateDir(coreDir: string): string {
  return join(coreDir, STATE_DIR);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Whether `p` names a file inside the n8n-core directory: relative, `/`-separated, with no
 * empty, `.` or `..` segment. The same rule `validateManifest` applies to manifest paths.
 */
function isInsidePath(p: unknown): p is string {
  return typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0')
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Checks the files a record or journal lists. `uninstall` writes and removes at each path, so
 * a path that leaves n8n-core (`../`, absolute) would let whoever can write the state
 * directory have a more privileged `uninstall` write or delete outside it.
 */
function checkFiles(files: unknown, path: string): void {
  if (!Array.isArray(files)) throw new Error(`${path} is not an n8n-libpetri ${path.endsWith(JOURNAL_FILE) ? 'journal' : 'install record'}`);
  for (const f of files as Partial<RecordedFile>[]) {
    if (typeof f !== 'object' || f === null || !isInsidePath(f.path)) throw new Error(`${path} lists a path outside n8n-core: ${JSON.stringify(f)}`);
    if ((f.before !== null && !HEX64.test(String(f.before))) || !HEX64.test(String(f.after))) throw new Error(`${path} has a bad hash for ${f.path}`);
  }
}

/** The record, or null when none exists. Throws on a record that is not one. */
export function readRecord(coreDir: string): InstallRecord | null {
  const path = join(stateDir(coreDir), RECORD_FILE);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, 'utf8')) as InstallRecord;
  if (typeof record !== 'object' || record === null || record.schema !== 1) throw new Error(`${path} is not an n8n-libpetri install record`);
  checkFiles(record.files, path);
  return record;
}

/** The journal, or null when none exists. Throws on a journal that is not one. */
export function readJournal(coreDir: string): InstallJournal | null {
  const path = join(stateDir(coreDir), JOURNAL_FILE);
  if (!existsSync(path)) return null;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as InstallJournal;
  if (typeof journal !== 'object' || journal === null || journal.schema !== 1) throw new Error(`${path} is not an n8n-libpetri journal`);
  checkFiles(journal.files, path);
  return journal;
}

/** Each recorded file whose bytes are no longer what the installer wrote. */
export function driftedFiles(coreDir: string, record: InstallRecord): { path: string; expected: string; found: string | null }[] {
  const drifted: { path: string; expected: string; found: string | null }[] = [];
  for (const f of record.files) {
    const found = sha256File(join(coreDir, f.path));
    if (found !== f.after) drifted.push({ path: f.path, expected: f.after, found });
  }
  return drifted;
}
