/**
 * Finding the n8n installation and the one n8n-core it loads (`tasks/inject-plan.md` decision 10).
 *
 * n8n, in this order: `--n8n <dir|bin>`; the realpath of `n8n` on `PATH`, walking up to the
 * `package.json` named `n8n`; `$(npm root -g)/n8n`. n8n-core: resolved from n8n's own
 * `package.json` with `createRequire`, then its realpath, which is the module instance n8n
 * loads in every layout (npm's nested tree, pnpm's symlinks, the Docker image).
 *
 * Refused: a second n8n-core realpath anywhere under n8n's tree (which one runs would depend on
 * who requires it), and a path under npm's `_npx/` cache, which npm may replace at any time,
 * unless the caller accepts that.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { refused } from './errors.js';

export interface Located {
  /** n8n's package directory (realpath). */
  readonly n8nDir: string;
  readonly n8nVersion: string | undefined;
  /** The n8n-core package directory n8n resolves (realpath). */
  readonly coreDir: string;
  readonly coreVersion: string;
  /** How n8n was found, for `status`. */
  readonly via: 'flag' | 'path' | 'npm-root';
}

export interface LocateOptions {
  /** `--n8n`: n8n's package directory, a directory above it, or its `bin/n8n`. */
  readonly n8n?: string;
  readonly allowNpx?: boolean;
  /** Defaults to `process.env.PATH`. */
  readonly path?: string;
  /** `npm root -g`; injectable so tests never spawn npm. Return undefined when unknown. */
  readonly npmRoot?: () => string | undefined;
}

const readJson = (path: string): { name?: string; version?: string } => JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };

/** Walks up from `start` to the directory whose `package.json` is named `name`. */
function packageAbove(start: string, name: string): string | undefined {
  let dir = start;
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (readJson(pkg).name === name) return dir;
      } catch {
        // not JSON: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** n8n's package directory from what the user named: the package, its bin, or a prefix / project above it. */
function n8nFromFlag(given: string): string {
  const abs = resolve(given);
  if (!existsSync(abs)) throw refused(`--n8n ${given}: no such file or directory`);
  const real = realpathSync(abs);
  const isDir = statSync(real).isDirectory();
  const up = packageAbove(isDir ? real : dirname(real), 'n8n');
  if (up !== undefined) return up;
  if (isDir) {
    for (const candidate of [join(real, 'node_modules', 'n8n'), join(real, 'lib', 'node_modules', 'n8n')]) {
      if (existsSync(join(candidate, 'package.json')) && readJson(join(candidate, 'package.json')).name === 'n8n') return realpathSync(candidate);
    }
  }
  throw refused(`--n8n ${given}: no n8n package there (looked for a package.json named n8n at or above it, and under node_modules/)`);
}

function n8nOnPath(pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const bin = join(dir, 'n8n');
    if (!existsSync(bin)) continue;
    const found = packageAbove(dirname(realpathSync(bin)), 'n8n');
    if (found !== undefined) return found;
  }
  return undefined;
}

const defaultNpmRoot = (): string | undefined => {
  try {
    return execFileSync('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Every distinct n8n-core realpath under `n8nDir`: `node_modules/**\/n8n-core` and pnpm's `.pnpm/n8n-core@*`. */
export function coreCopies(n8nDir: string): string[] {
  const found = new Set<string>();
  const visit = (nodeModules: string, depth: number): void => {
    if (depth > 12 || !existsSync(nodeModules)) return;
    let entries: string[];
    try {
      entries = readdirSync(nodeModules);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(nodeModules, entry);
      if (entry === '.pnpm') {
        for (const store of safeReaddir(full)) {
          if (store.startsWith('n8n-core@')) addCore(join(full, store, 'node_modules', 'n8n-core'));
        }
        continue;
      }
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        for (const scoped of safeReaddir(full)) visitPackage(join(full, scoped), depth);
        continue;
      }
      if (entry === 'n8n-core') addCore(full);
      visitPackage(full, depth);
    }
  };
  const visitPackage = (dir: string, depth: number): void => {
    // Symlinked packages (pnpm) are not walked into: their realpaths are found from `.pnpm`.
    try {
      if (lstatSync(dir).isSymbolicLink()) return;
    } catch {
      return;
    }
    visit(join(dir, 'node_modules'), depth + 1);
  };
  const addCore = (dir: string): void => {
    try {
      if (existsSync(join(dir, 'package.json'))) found.add(realpathSync(dir));
    } catch {
      // dangling link
    }
  };
  visit(join(n8nDir, 'node_modules'), 0);
  return [...found].sort();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Locates n8n and its n8n-core, applying every refusal. */
export function locate(options: LocateOptions = {}): Located {
  let n8nDir: string | undefined;
  let via: Located['via'];
  if (options.n8n !== undefined) {
    n8nDir = n8nFromFlag(options.n8n);
    via = 'flag';
  } else {
    n8nDir = n8nOnPath(options.path ?? process.env.PATH);
    via = 'path';
    if (n8nDir === undefined) {
      const root = (options.npmRoot ?? defaultNpmRoot)();
      const candidate = root === undefined ? undefined : join(root, 'n8n');
      if (candidate !== undefined && existsSync(join(candidate, 'package.json'))) {
        n8nDir = realpathSync(candidate);
        via = 'npm-root';
      }
    }
    if (n8nDir === undefined) throw refused('cannot find n8n: not on PATH and not in `npm root -g`; name it with --n8n <dir>');
  }
  const n8nVersion = readJson(join(n8nDir, 'package.json')).version;

  if (!options.allowNpx && n8nDir.split(sep).includes('_npx')) {
    throw refused(`n8n at ${n8nDir} is in npm's npx cache, which npm replaces without notice; install n8n with npm i -g, or pass --allow-npx`);
  }

  let corePackage: string;
  try {
    corePackage = realpathSync(createRequire(join(n8nDir, 'package.json')).resolve('n8n-core/package.json'));
  } catch {
    throw refused(`n8n at ${n8nDir} does not resolve n8n-core; is this an n8n installation?`);
  }
  const coreDir = dirname(corePackage);
  const coreVersion = readJson(corePackage).version;
  if (coreVersion === undefined) throw refused(`${corePackage} has no version`);

  const copies = coreCopies(n8nDir);
  if (!copies.includes(coreDir)) copies.push(coreDir);
  if (copies.length > 1) {
    const versions = copies.map((c) => `${c} (${readJson(join(c, 'package.json')).version ?? '?'})`);
    throw refused(`n8n at ${n8nDir} contains ${copies.length} copies of n8n-core: ${versions.join(', ')}; which one runs depends on who requires it, so none is patched`);
  }
  return { n8nDir, n8nVersion, coreDir, coreVersion, via };
}
