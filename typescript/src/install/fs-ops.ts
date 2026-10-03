/**
 * The two writes the installer makes, behind an interface so a test can fail one midway and
 * watch the rollback (`tests/install/installer.test.ts`).
 */
import { chmodSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface FileOps {
  /** Writes `bytes` to a temp file in the same directory, then renames it over `path`. */
  readonly writeAtomic: (path: string, bytes: Uint8Array, mode: number) => void;
  /** Removes a file; absent is fine. */
  readonly remove: (path: string) => void;
}

/** The temp file {@link nodeFileOps.writeAtomic} writes `path` through. */
export const tempPathFor = (path: string, pid: number = process.pid): string =>
  join(dirname(path), `.${basename(path)}.n8n-libpetri-${pid}.tmp`);

const TEMP = /^\.(.+)\.n8n-libpetri-\d+\.tmp$/;

/**
 * Removes the temp files a killed run left beside `paths` (any pid). A temp file is only ever
 * a copy in flight; the rename that would have made it the real file never happened.
 * Returns the removed paths.
 */
export function sweepTemps(paths: readonly string[]): string[] {
  const byDir = new Map<string, Set<string>>();
  for (const p of paths) {
    const names = byDir.get(dirname(p)) ?? new Set<string>();
    names.add(basename(p));
    byDir.set(dirname(p), names);
  }
  const removed: string[] = [];
  for (const [dir, names] of byDir) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const target = TEMP.exec(e)?.[1];
      if (target === undefined || !names.has(target)) continue;
      rmSync(join(dir, e), { force: true });
      removed.push(join(dir, e));
    }
  }
  return removed;
}

export const nodeFileOps: FileOps = {
  writeAtomic: (path, bytes, mode) => {
    const tmp = tempPathFor(path);
    try {
      writeFileSync(tmp, bytes, { mode });
      // writeFileSync's mode is filtered by the umask; the original's mode is what is wanted.
      chmodSync(tmp, mode);
      renameSync(tmp, path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // never created
      }
      throw e;
    }
  },
  remove: (path) => rmSync(path, { force: true }),
};
