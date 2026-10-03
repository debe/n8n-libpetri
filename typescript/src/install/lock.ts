/**
 * The installer's lock, `<n8n-core>/.n8n-libpetri/lock`: one `install` or `uninstall` at a time.
 *
 * The lock is created whole: its text is written to a temp file first and then hard-linked to
 * `lock`, which fails if the name exists, so no reader ever sees an empty lock. It names the
 * holder (`pid <n> host <hostname>`), and a lock whose holder is gone is taken over. A process
 * killed mid-run (SIGKILL, OOM, a closed container) never releases its lock. Without that
 * takeover, the recovery its own message names (`n8n-libpetri uninstall`) would be refused too.
 *
 * Whether the holder is gone can be told only on the same host. On another host (a shared
 * volume, a different container's hostname) the lock is treated as held, and the refusal
 * says how to remove it by hand.
 */
import { linkSync, openSync, closeSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { refused } from './errors.js';
import { LOCK_FILE } from './record.js';

export interface LockHolder {
  readonly pid: number | null;
  /** Null for a lock written before the host was recorded. */
  readonly host: string | null;
  /** The lock's text as read. */
  readonly raw: string;
}

/** `alive`: the holder runs. `dead`: it does not. `unknown`: it cannot be told from here. */
export type HolderState = 'alive' | 'dead' | 'unknown';

export interface Lock {
  readonly release: () => void;
  /** The holder of a stale lock this run took over, if any. */
  readonly tookOver: LockHolder | null;
}

export function parseLock(raw: string): LockHolder {
  const pid = /\bpid (\d+)\b/.exec(raw)?.[1];
  const host = /\bhost (\S+)/.exec(raw)?.[1];
  return { pid: pid === undefined ? null : Number(pid), host: host ?? null, raw };
}

/** The lock's holder, or null when there is no lock. */
export function readLock(state: string): LockHolder | null {
  try {
    return parseLock(readFileSync(join(state, LOCK_FILE), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Whether the holder still runs. Signal 0 checks for a process without sending anything. */
export function holderState(holder: LockHolder, here: string = hostname()): HolderState {
  if (holder.pid === null || !Number.isSafeInteger(holder.pid) || holder.pid <= 0) return 'unknown';
  if (holder.host !== null && holder.host !== here) return 'unknown';
  if (holder.pid === process.pid) return 'alive';
  try {
    process.kill(holder.pid, 0);
    return 'alive';
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

export function describeHolder(holder: LockHolder): string {
  if (holder.pid === null) return holder.raw.trim() === '' ? 'an empty lock' : `'${holder.raw.trim()}'`;
  return `pid ${holder.pid}${holder.host === null ? '' : ` on host ${holder.host}`}`;
}

function heldBy(lock: string, holder: LockHolder, state: HolderState): never {
  const why = state === 'alive'
    ? 'which is still running'
    : `and whether it still runs cannot be told from host ${hostname()}`;
  throw refused(`another n8n-libpetri run holds ${lock} (${describeHolder(holder)}, ${why}); if none is running, remove that file`);
}

/** Creates `lock` holding `text`, or returns false when it exists. */
function create(lock: string, tmp: string, text: string): boolean {
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, lock);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A filesystem without hard links: an exclusive create, then the text.
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch (o) {
      if ((o as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw o;
    }
    writeSync(fd, text);
    closeSync(fd);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Takes the lock in `state` (which must exist), taking over a lock whose holder is gone.
 * Throws a refusal (exit 1) when a live or unknown holder has it.
 */
export function acquireLock(state: string): Lock {
  const lock = join(state, LOCK_FILE);
  const text = `pid ${process.pid} host ${hostname()}\n`;
  const tmp = join(state, `.${LOCK_FILE}.${process.pid}.tmp`);
  let tookOver: LockHolder | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(lock, tmp, text)) {
      return {
        tookOver,
        release: () => {
          try {
            unlinkSync(lock);
          } catch {
            // already gone with the state directory
          }
        },
      };
    }
    const holder = readLock(state);
    if (holder === null) continue; // released in between
    const verdict = holderState(holder);
    if (verdict !== 'dead') heldBy(lock, holder, verdict);
    // Move the stale lock aside, then check that what moved is the lock judged stale: two
    // runs recovering at once must not both win.
    const aside = join(state, `.${LOCK_FILE}.stale.${process.pid}`);
    try {
      renameSync(lock, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const moved = readFileSync(aside, 'utf8');
    if (moved !== holder.raw) {
      try {
        linkSync(aside, lock);
      } catch {
        // the other run already took it
      }
      rmSync(aside, { force: true });
      heldBy(lock, parseLock(moved), 'alive');
    }
    rmSync(aside, { force: true });
    tookOver = holder;
  }
  throw refused(`could not take ${lock}: other n8n-libpetri runs keep taking it`);
}
