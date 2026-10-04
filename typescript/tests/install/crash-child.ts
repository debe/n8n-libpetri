/**
 * A child process for `crash.test.ts`: runs `install` or `uninstall` against a synthetic tree
 * and SIGKILLs itself just before its Nth filesystem mutation, as a closed container or the
 * OOM killer would. Nothing in the installer gets to clean up: no catch block, no `finally`.
 *
 *   tsx crash-child.ts <install|uninstall> <n8nDir> <seamsDir> <killAt>
 *
 * `killAt` 0 never kills. The last line of stdout is `{"code":…,"mutations":…}`.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [command, n8nDir, seamsDir, killAtRaw] = process.argv.slice(2);
const killAt = Number(killAtRaw);
let mutations = 0;
/**
 * Counting starts only once the installer is loaded. The loader's own writes are not the
 * installer's: on a tsx cache miss (the first run after an edit to an installer module) tsx
 * creates its cache directory with `mkdirSync`, so counting during the import would make the
 * dry run report one mutation more than the warm children make, and the last kill point would
 * never fire. `runInstallCli` is synchronous, so nothing loads while it runs.
 */
let armed = false;

/** Every `node:fs` call that changes the filesystem and that the installer makes. */
const MUTATORS = ['renameSync', 'rmSync', 'unlinkSync', 'linkSync', 'copyFileSync', 'writeFileSync', 'mkdirSync', 'chmodSync', 'openSync', 'writeSync'] as const;
const table = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of MUTATORS) {
  const original = table[name]!;
  table[name] = function patched(this: unknown, ...args: unknown[]) {
    if (armed && ++mutations === killAt) process.kill(process.pid, 'SIGKILL');
    return original.apply(this, args);
  };
}
// The installer imports these as ESM named bindings; this makes them see the patched ones.
syncBuiltinESMExports();

const { runInstallCli } = await import('../../src/install/cli.js');
armed = true;
const code = runInstallCli(
  command as 'install' | 'uninstall',
  ['--n8n', n8nDir!, '--seams', seamsDir!, ...(command === 'install' ? ['--allow-unverified'] : [])],
  {
    stdout: () => {},
    stderr: (t) => { process.stderr.write(t); },
    writeFile: () => {},
  },
  { hook: '/opt/n8n-libpetri/hook/n8n-hook.cjs', toolVersion: '0.0.0-test', env: { PATH: '' }, npmRoot: () => undefined },
);
process.stdout.write(`${JSON.stringify({ code, mutations })}\n`);
