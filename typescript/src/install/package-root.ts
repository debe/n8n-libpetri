/**
 * Where this package's shipped files are at run time: `seams/` and `hook/` beside `dist/`.
 *
 * Found by walking up from this module to the `package.json` named `n8n-libpetri`, not by a
 * fixed `../..`: with tsup's code splitting this code runs from a chunk at `dist/`'s root, and
 * under vitest from `src/install/`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'n8n-libpetri';

export interface PackageRoot {
  readonly dir: string;
  readonly version: string;
}

let cached: PackageRoot | undefined;

export function packageRoot(): PackageRoot {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
      if (json.name === PACKAGE_NAME) {
        cached = { dir, version: json.version ?? '0.0.0' };
        return cached;
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find the ${PACKAGE_NAME} package root above ${fileURLToPath(import.meta.url)}`);
    dir = up;
  }
}

/** The committed seams, one directory per supported n8n-core version. */
export const defaultSeamsDir = (): string => join(packageRoot().dir, 'seams', 'n8n-core');
/** The `EXTERNAL_HOOK_FILES` entry. */
export const hookPath = (): string => join(packageRoot().dir, 'hook', 'n8n-hook.cjs');
/** The `NODE_OPTIONS` `--import` preload that registers the scheduler; it ships beside the hook. */
export const preloadFor = (hook: string): string => join(dirname(hook), 'n8n-preload.mjs');
