/**
 * The last step of a script entry: turn a command line's result into the process exit code.
 */

/**
 * Runs `run` and sets `process.exitCode` to what it returns. A run that throws or rejects is
 * not an input error — each command line reports those itself, as exit 2 with a sentence —
 * but a defect, so its **stack** goes to stderr, for the one person who can fix it, and the
 * exit code is 2. It never calls `process.exit`: pending stdout is flushed first.
 *
 * No top-level `await` either, here or in a caller: a fixtures module that imports the
 * conformance barrel imports `differ-cli.ts` back, and a pending top-level await in that
 * cycle deadlocks.
 */
export function exitWith(run: () => number | Promise<number>): void {
  void new Promise<number>((resolve) => { resolve(run()); }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}
