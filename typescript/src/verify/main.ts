#!/usr/bin/env node
/**
 * The `n8n-libpetri` process entry point (`package.json` `bin`).
 *
 * Kept apart from `cli.ts` on purpose. The usual `import.meta.url === pathToFileURL(
 * process.argv[1]).href` guard does not survive bundling: with tsup's code splitting the
 * module body moves into a shared chunk, `import.meta.url` becomes the chunk's URL, and the
 * guard is never true — a CLI that silently prints nothing. A dedicated entry whose whole
 * body is the invocation has nothing to guard.
 */
import { nodeIo, runCli } from './cli.js';

runCli(process.argv.slice(2), nodeIo).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
