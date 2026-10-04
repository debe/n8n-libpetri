/**
 * The preload and the hook against the **built** dist. `hook/n8n-preload.mjs` (`--import`)
 * registers the scheduler before n8n's entry module runs; `hook/n8n-hook.cjs`, which n8n
 * `require()`s later, only confirms it (divergence row 40). The hook's `require()` of
 * `dist/n8n/boot.js` from CommonJS loads the whole ESM graph (libpetri included) synchronously,
 * which fails on any top-level `await` (`ERR_REQUIRE_ASYNC_MODULE`). Needs `npm run build`; CI
 * runs it after the build with `N8N_LIBPETRI_REQUIRE_DIST=1`, which turns a missing dist into a
 * failure instead of a skip.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTrees, HOOK_SOURCE, N8N_LOADER, tempDir } from './support.js';

const DIST_BOOT = fileURLToPath(new URL('../../dist/n8n/boot.js', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../hook/n8n-preload.mjs', import.meta.url));
const required = process.env.N8N_LIBPETRI_REQUIRE_DIST === '1';
const built = existsSync(DIST_BOOT);

afterEach(() => cleanupTrees());

/** A fake n8n package; its entry is `bin/n8n-main.cjs`, which says when it starts, then loads hook files as n8n does. */
function fakeN8n(seam: boolean): { root: string; entry: string } {
  const root = tempDir('n8n-libpetri-hookdist-');
  const n8nDir = join(root, 'node_modules', 'n8n');
  const core = join(n8nDir, 'node_modules', 'n8n-core');
  const wf = join(n8nDir, 'node_modules', 'n8n-workflow');
  mkdirSync(core, { recursive: true });
  mkdirSync(wf, { recursive: true });
  mkdirSync(join(n8nDir, 'bin'));
  writeFileSync(join(n8nDir, 'package.json'), JSON.stringify({ name: 'n8n', version: '9.9.10' }));
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'n8n-core', version: '9.9.9' }));
  // The seamed registry says what it was given, so a registration that never happens is visible.
  const registry = [
    'let factory = null;',
    'exports.setWorkflowSchedulerFactory = (f) => { factory = f; process.stdout.write(`factory set: ${typeof f}\\n`); };',
    'exports.getWorkflowSchedulerFactory = () => factory;',
    'exports.StackScheduler = class {};',
  ].join('\n');
  writeFileSync(join(core, 'index.js'), seam ? `${registry}\n` : 'exports.x = 1;\n');
  writeFileSync(join(wf, 'package.json'), JSON.stringify({ name: 'n8n-workflow', version: '9.9.8' }));
  writeFileSync(join(wf, 'index.js'), 'exports.NodeHelpers = {};\n');
  const entry = join(n8nDir, 'bin', 'n8n-main.cjs');
  writeFileSync(entry, `process.stdout.write('n8n entry runs\\n');\n${N8N_LOADER}`);
  return { root, entry };
}

function run(entry: string, env: NodeJS.ProcessEnv, preload = true): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      EXTERNAL_HOOK_FILES: HOOK_SOURCE,
      ...(preload ? { NODE_OPTIONS: `--import=${PRELOAD}` } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('hook/n8n-preload.mjs and hook/n8n-hook.cjs with the built dist', () => {
  it('has a dist to load when CI says it must', () => {
    if (required) expect(built, `${DIST_BOOT} is missing; run npm run build first`).toBe(true);
  });

  it.runIf(built)('registers before n8n\'s entry module runs, and the hook confirms it', () => {
    const r = run(fakeN8n(true).entry, { N8N_EXECUTION_ENGINE: 'libpetri', N8N_LIBPETRI_BUDGET: '2' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.startsWith('factory set: function\nn8n entry runs\n'), r.stdout).toBe(true);
    expect(r.stderr).toContain('[n8n-libpetri] scheduler registered: budget=2, n8n-core=9.9.9');
    expect(r.stderr).toContain(`[n8n-libpetri] hook confirmed the preload registration (${PRELOAD})`);
  });

  it.runIf(built)('registers when n8n is started through a bin symlink, as on a global npm or Docker install', () => {
    const { root, entry } = fakeN8n(true);
    mkdirSync(join(root, 'bin'));
    symlinkSync(entry, join(root, 'bin', 'n8n'));
    const r = run(join(root, 'bin', 'n8n'), { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.startsWith('factory set: function\nn8n entry runs\n'), r.stdout).toBe(true);
    expect(r.stderr).toContain('hook confirmed the preload registration');
  });

  it.runIf(built)('stops n8n when the hook finds no preload registration, naming NODE_OPTIONS', () => {
    const r = run(fakeN8n(true).entry, { N8N_EXECUTION_ENGINE: 'libpetri' }, false);
    expect(r.status).toBe(42);
    expect(r.stdout).not.toContain('factory set');
    expect(r.stderr).toContain('no scheduler was registered before n8n started');
    expect(r.stderr).toContain('NODE_OPTIONS');
  });

  it.runIf(built)('refuses a stock n8n-core before n8n\'s entry runs, naming the fix', () => {
    const r = run(fakeN8n(false).entry, { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('n8n entry runs');
    expect(r.stderr).toContain('has no scheduler seam');
    expect(r.stderr).toContain('n8n-libpetri install');
  });

  it.runIf(built)('refuses a typo before n8n\'s entry runs', () => {
    const r = run(fakeN8n(true).entry, { N8N_EXECUTION_ENGINE: 'libpetrx' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('n8n entry runs');
    expect(r.stderr).toContain("must be 'libpetri' or unset");
  });

  it.runIf(built)('leaves a Node process that is not n8n alone, though NODE_OPTIONS and the engine variable reach it', () => {
    const { root } = fakeN8n(true);
    const script = join(root, 'user-script.cjs');
    writeFileSync(script, "process.stdout.write('user script ran\\n');\n");
    const r = run(script, { N8N_EXECUTION_ENGINE: 'libpetri' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('user script ran\n');
    expect(r.stderr).toBe('');
  });

  it.runIf(built)('is inert with the engine variable unset: n8n runs, nothing registers, the dist is not loaded', () => {
    const r = run(fakeN8n(true).entry, {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('factory set');
    expect(r.stderr).toBe('');
  });
});
