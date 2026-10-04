/**
 * The hook against the **built** dist: `require()` of `dist/n8n/boot.js` from CommonJS loads
 * the whole ESM graph (libpetri included) synchronously, which fails on any top-level `await`
 * (`ERR_REQUIRE_ASYNC_MODULE`). Needs `npm run build`; CI runs it after the build with
 * `N8N_LIBPETRI_REQUIRE_DIST=1`, which turns a missing dist into a failure instead of a skip.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTrees, HOOK_SOURCE, N8N_LOADER, tempDir } from './support.js';

const DIST_BOOT = fileURLToPath(new URL('../../dist/n8n/boot.js', import.meta.url));
const required = process.env.N8N_LIBPETRI_REQUIRE_DIST === '1';
const built = existsSync(DIST_BOOT);

afterEach(() => cleanupTrees());

function fakeN8n(seam: boolean): string {
  const root = tempDir('n8n-libpetri-hookdist-');
  const core = join(root, 'node_modules', 'n8n', 'node_modules', 'n8n-core');
  const wf = join(root, 'node_modules', 'n8n', 'node_modules', 'n8n-workflow');
  mkdirSync(core, { recursive: true });
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(root, 'node_modules', 'n8n', 'package.json'), JSON.stringify({ name: 'n8n', version: '9.9.10' }));
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'n8n-core', version: '9.9.9' }));
  // The seamed setter says what it was given, so a registration that never happens is visible.
  const setter = 'exports.setWorkflowSchedulerFactory = (f) => { process.stdout.write(`factory set: ${typeof f}\\n`); };';
  writeFileSync(join(core, 'index.js'), seam ? `${setter} exports.StackScheduler = class {};\n` : 'exports.x = 1;\n');
  writeFileSync(join(wf, 'package.json'), JSON.stringify({ name: 'n8n-workflow', version: '9.9.8' }));
  writeFileSync(join(wf, 'index.js'), 'exports.NodeHelpers = {};\n');
  writeFileSync(join(root, 'n8n-main.cjs'), N8N_LOADER);
  return root;
}

function run(root: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(root, 'n8n-main.cjs')], {
    env: { PATH: process.env.PATH, EXTERNAL_HOOK_FILES: HOOK_SOURCE, N8N_LIBPETRI_RESOLVE_FROM: join(root, 'node_modules', 'n8n', 'package.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('hook/n8n-hook.cjs with the built dist', () => {
  it('has a dist to load when CI says it must', () => {
    if (required) expect(built, `${DIST_BOOT} is missing; run npm run build first`).toBe(true);
  });

  it.runIf(built)('boots the real dist from CommonJS and registers against a seamed n8n-core', () => {
    const r = run(fakeN8n(true), { N8N_EXECUTION_ENGINE: 'libpetri', N8N_LIBPETRI_BUDGET: '2' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('factory set: function\n');
    expect(r.stderr).toContain('[n8n-libpetri] scheduler registered: budget=2, n8n-core=9.9.9');
  });

  it.runIf(built)('refuses a stock n8n-core through the real dist, naming the fix', () => {
    const r = run(fakeN8n(false), { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.status).toBe(42);
    expect(r.stderr).toContain('has no scheduler seam');
    expect(r.stderr).toContain('n8n-libpetri install');
  });

  it.runIf(built)('refuses a typo through the real dist', () => {
    const r = run(fakeN8n(true), { N8N_EXECUTION_ENGINE: 'libpetrx' });
    expect(r.status).toBe(42);
    expect(r.stderr).toContain("must be 'libpetri' or unset");
  });
});
