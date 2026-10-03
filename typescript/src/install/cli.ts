/**
 * The installer's command lines: `install`, `uninstall`, `status` and `env`
 * (`tasks/inject-plan.md` decisions 10 and 11). `src/cli/main.ts` dispatches to them.
 */
import type { CliOutput } from '../cli/io.js';
import { parseFlags, UsageError } from '../cli/flags.js';
import { install, uninstall } from './apply.js';
import { EXIT, InstallError } from './errors.js';
import type { FileOps } from './fs-ops.js';
import { locate, type LocateOptions } from './locate.js';
import { loadManifests, manifestFor } from './manifest.js';
import { defaultSeamsDir, hookPath, packageRoot } from './package-root.js';
import { renderStatus, status, statusExitCode } from './status.js';

export const INSTALL_COMMANDS = ['install', 'uninstall', 'status', 'env'] as const;
export type InstallCommand = (typeof INSTALL_COMMANDS)[number];

export const INSTALL_USAGE = `usage:
  n8n-libpetri install   [--n8n <dir|bin>] [--allow-unverified] [--allow-npx] [--json]
  n8n-libpetri uninstall [--n8n <dir|bin>] [--allow-npx] [--json]
  n8n-libpetri status    [--n8n <dir|bin>] [--allow-npx] [--json]
  n8n-libpetri env

install    adds the scheduler seam (n8n's patches 0001/0002, rebuilt for the installed release)
           to the n8n-core an installed n8n loads, after checking every file's sha256
uninstall  restores the stock files byte for byte from the backups install kept
status     stock | stock-unsupported | installed | modified | orphaned | interrupted, and
           whether this shell's environment activates the engine
           (interrupted: a run stopped midway; uninstall finishes the way back to stock)
env        prints the two variables that activate it:  eval "$(n8n-libpetri env)"

--n8n <path>        n8n's package directory, a prefix above it, or its bin/n8n
                    (default: n8n on PATH, then $(npm root -g)/n8n)
--allow-unverified  install seams whose release-neutrality record is not yet filled in
--allow-npx         accept an n8n inside npm's npx cache
--seams <dir>       use seams from <dir> instead of the shipped ones
--json              print the result as JSON

exit codes (these commands): 0 ok, 1 refused (unknown version, hash mismatch, no neutrality
record, npx path, two n8n-core copies, held lock), 2 usage, 3 inconsistent state (modified,
orphaned, interrupted), 4 permission denied. The verifier's exit 3 ("no solver resolved") is
a different command's code.
`;

export interface InstallCliDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly npmRoot?: LocateOptions['npmRoot'];
  readonly seamsDir?: string;
  readonly hook?: string;
  readonly toolVersion?: string;
  readonly ops?: FileOps;
}

/** Shell-quotes one word for `eval`. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function renderEnv(hook: string): string {
  return [
    'export N8N_EXECUTION_ENGINE=libpetri',
    // Appended, so a user's own hook files keep loading.
    `export EXTERNAL_HOOK_FILES="\${EXTERNAL_HOOK_FILES:+$EXTERNAL_HOOK_FILES\${EXTERNAL_HOOK_FILES_SEPARATOR:-:}}"${quote(hook)}`,
    '',
  ].join('\n');
}

const staleNote = (holder: string): string => `note: took over the lock left by ${holder}, which no longer runs\n`;

export function runInstallCli(command: InstallCommand, argv: readonly string[], out: CliOutput, deps: InstallCliDeps = {}): number {
  const env = deps.env ?? process.env;
  let n8n: string | undefined;
  let json = false;
  let allowNpx = false;
  let allowUnverified = false;
  let seamsDir = deps.seamsDir;
  try {
    parseFlags(argv, {
      values: {
        ...(command === 'env' ? {} : { '--n8n': (v: string) => { n8n = v; }, '--seams': (v: string) => { seamsDir = v; } }),
      },
      switches: {
        '--help': () => { throw new UsageError(''); },
        ...(command === 'env' ? {} : { '--json': () => { json = true; }, '--allow-npx': () => { allowNpx = true; } }),
        ...(command === 'install' ? { '--allow-unverified': () => { allowUnverified = true; } } : {}),
      },
      positional: (word) => { throw new UsageError(`unexpected argument ${word}`); },
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (e.message === '') {
      out.stdout(INSTALL_USAGE);
      return EXIT.ok;
    }
    out.stderr(`n8n-libpetri ${command}: ${e.message}\n${INSTALL_USAGE}`);
    return EXIT.usage;
  }

  const hook = deps.hook ?? hookPath();
  if (command === 'env') {
    out.stdout(renderEnv(hook));
    return EXIT.ok;
  }

  try {
    const located = locate({ ...(n8n === undefined ? {} : { n8n }), allowNpx, ...(deps.npmRoot === undefined ? {} : { npmRoot: deps.npmRoot }), ...(env.PATH === undefined ? {} : { path: env.PATH }) });
    const manifests = loadManifests(seamsDir ?? defaultSeamsDir());
    const toolVersion = deps.toolVersion ?? packageRoot().version;
    const ops = deps.ops === undefined ? {} : { ops: deps.ops };

    if (command === 'status') {
      const report = status(located, manifests, env, hook);
      out.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report));
      return statusExitCode(report);
    }
    if (command === 'install') {
      const loaded = manifestFor(manifests, located.coreVersion, located.n8nVersion);
      const result = install({ located, loaded, allowUnverified, toolVersion, ...ops });
      if (json) {
        out.stdout(`${JSON.stringify({ status: result.status, coreDir: located.coreDir, coreVersion: located.coreVersion, n8nVersion: located.n8nVersion ?? null, record: result.record }, null, 2)}\n`);
      } else if (result.status === 'already-installed') {
        out.stdout(`already installed: n8n-core ${located.coreVersion} at ${located.coreDir}; nothing to do\n`);
      } else {
        const unverified = result.record.unverified ? ' (unverified: no neutrality record)' : '';
        out.stdout(
          `installed the scheduler seam into n8n-core ${located.coreVersion} (n8n ${located.n8nVersion ?? '?'}) at ${located.coreDir}${unverified}\n` +
            result.plan.writes.map((w) => `  ${w.before === null ? 'created ' : 'replaced'} ${w.path}\n`).join('') +
            `${result.plan.maps ? '' : '  (this n8n-core ships no source maps, so none were installed)\n'}` +
            'n8n still runs its own loop until the engine is activated:\n' +
            `  eval "$(n8n-libpetri env)"   # N8N_EXECUTION_ENGINE=libpetri and EXTERNAL_HOOK_FILES=${hook}\n`,
        );
      }
      if (result.status === 'installed' && result.staleLock !== null) out.stderr(staleNote(result.staleLock));
      if (result.status === 'installed' && result.record.unverified) out.stderr('warning: installed seams without a release-neutrality record (--allow-unverified)\n');
      return EXIT.ok;
    }
    const result = uninstall({ located, ...ops }, manifests.get(located.coreVersion));
    if (json) {
      out.stdout(`${JSON.stringify({ ...result, coreDir: located.coreDir, coreVersion: located.coreVersion }, null, 2)}\n`);
    } else if (result.status === 'not-installed') {
      out.stdout(
        `nothing to uninstall: n8n-core ${located.coreVersion} at ${located.coreDir} has no n8n-libpetri install\n` +
          (result.leftover ? '  removed the state directory a run left when it stopped before changing any file\n' : ''),
      );
    } else {
      out.stdout(
        `restored the stock n8n-core ${located.coreVersion} at ${located.coreDir}${result.interrupted ? ' (finishing a run that stopped midway)' : ''}\n` +
          result.restored.map((p) => `  restored ${p}\n`).join('') +
          result.removed.map((p) => `  removed  ${p}\n`).join(''),
      );
    }
    if (result.staleLock !== null) out.stderr(staleNote(result.staleLock));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof InstallError) {
      out.stderr(`n8n-libpetri ${command}: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}
