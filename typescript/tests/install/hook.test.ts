/**
 * `hook/n8n-hook.cjs`, the `EXTERNAL_HOOK_FILES` entry, loaded the way n8n loads a hook file:
 * a plain `require()` in a CommonJS process, then `loadHooks` over what it exports. The mirror
 * below is `ExternalHooks.init`/`loadHooks` from `packages/cli/src/external-hooks.ts` at
 * n8n@2.41.6. The dist it requires is replaced by a fake ESM module here, so this runs before
 * `npm run build`; `hook-dist.test.ts` runs the real dist once it is built.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTrees, HOOK_SOURCE, N8N_LOADER, tempDir } from './support.js';

function fakePackage(boot: string | null): string {
  const root = tempDir('n8n-libpetri-hook-');
  mkdirSync(join(root, 'hook'));
  copyFileSync(HOOK_SOURCE, join(root, 'hook', 'n8n-hook.cjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'n8n-libpetri', type: 'module' }));
  if (boot !== null) {
    mkdirSync(join(root, 'dist', 'n8n'), { recursive: true });
    writeFileSync(join(root, 'dist', 'n8n', 'boot.js'), boot);
  }
  return root;
}

function loadLikeN8n(root: string, env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const loader = join(root, 'n8n-main.cjs');
  writeFileSync(loader, N8N_LOADER);
  try {
    const stdout = execFileSync(process.execPath, [loader], { env: { PATH: process.env.PATH, EXTERNAL_HOOK_FILES: join(root, 'hook', 'n8n-hook.cjs'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { status: err.status, stdout: err.stdout.toString(), stderr: err.stderr.toString() };
  }
}

afterEach(() => cleanupTrees());

describe('hook/n8n-hook.cjs under n8n\'s loader', () => {
  it('is inert without N8N_EXECUTION_ENGINE: exports {}, registers no hooks, never loads the dist', () => {
    // No dist at all: requiring it would throw.
    const r = loadLikeN8n(fakePackage(null), {});
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ registered: {}, booted: null });
    expect(loadLikeN8n(fakePackage(null), { N8N_EXECUTION_ENGINE: '' }).status).toBe(0);
  });

  it('requires the ESM dist synchronously from CommonJS and calls bootFromEnv with n8n\'s entry and its own path', () => {
    const root = fakePackage('export function bootFromEnv(options) { globalThis.__n8nLibpetriBooted = options; }\n');
    const r = loadLikeN8n(root, { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { registered: object; booted: { mainFilename: string; loader: string } };
    expect(out.registered).toEqual({});
    expect(out.booted.loader).toBe(join(root, 'hook', 'n8n-hook.cjs'));
    expect(out.booted.mainFilename).toBe(join(root, 'n8n-main.cjs'));
  });

  it('stops n8n on a refusal, and writes the reason to stderr first (n8n keeps it only in the error\'s extra)', () => {
    const root = fakePackage("export function bootFromEnv() { throw new Error('n8n-core 1.0.0 at /x has no scheduler seam'); }\n");
    const r = loadLikeN8n(root, { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.status).toBe(42);
    expect(r.stderr).toContain('[n8n-libpetri] refusing to start n8n: n8n-core 1.0.0 at /x has no scheduler seam');
    expect(r.stderr).toContain('Problem loading external hook file');
  });
});
