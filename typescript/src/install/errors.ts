/**
 * The installer's exit codes (`tasks/inject-plan.md` decision 10). They are its own: the
 * verifier's exit 3 means "no solver resolved", the installer's means "inconsistent state".
 */
export const EXIT = {
  ok: 0,
  /** Refused: unknown version, hash mismatch, no neutrality record, npx path, two copies, held lock. */
  refused: 1,
  usage: 2,
  /** The target is in a state the installer did not leave it in: modified, orphaned, interrupted. */
  inconsistent: 3,
  /** The filesystem said no (`EACCES`/`EPERM`/`EROFS`). */
  permission: 4,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A refusal with the sentence that names the remedy, and the exit code it maps to. */
export class InstallError extends Error {
  constructor(message: string, readonly exitCode: ExitCode) {
    super(message);
    this.name = 'InstallError';
  }
}

export const refused = (message: string): InstallError => new InstallError(message, EXIT.refused);
export const inconsistent = (message: string): InstallError => new InstallError(message, EXIT.inconsistent);

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Whether `e` is a filesystem permission failure. */
export function isPermissionError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && PERMISSION_CODES.has((e as NodeJS.ErrnoException).code ?? '');
}
