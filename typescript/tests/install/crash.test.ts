/**
 * `install` and `uninstall` killed at every filesystem mutation they make (`crash-child.ts`
 * SIGKILLs itself just before the Nth one), against a synthetic tree. At every kill point:
 *
 * 1. n8n-core stays loadable: a replaced file that is already patched never requires a
 *    created file that is not there (the patched `workflow-execute.js` and `index.js`
 *    require `scheduler-registry.js` and its siblings).
 * 2. `status` names a state the installer can leave (`stock`, `installed`, `interrupted`),
 *    never `modified` or `orphaned`.
 * 3. `uninstall`, run next, exits 0 and leaves n8n-core byte-identical to the stock tree:
 *    no state directory, no temp files, although the killed run left a lock behind.
 * 4. After a killed install, `install` again either works or names `uninstall` as the way
 *    back (exit 3), and that way back works.
 *
 * Integration-shaped (one child process per kill point), so the kill points run in parallel.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstallCli } from '../../src/install/cli.js';
import { EXIT } from '../../src/install/errors.js';
import { loadManifests } from '../../src/install/manifest.js';
import { sha256, STATE_DIR } from '../../src/install/record.js';
import { CORE_VERSION, captureIo, cleanupTrees, makeSeams, makeTree, snapshot, type Tree } from './support.js';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

interface ChildResult {
  readonly killed: boolean;
  readonly code: number | null;
  readonly mutations: number | null;
  readonly stderr: string;
}

function child(command: 'install' | 'uninstall', tree: Tree, seamsDir: string, killAt: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    // `node --import tsx` rather than the tsx binary, whose wrapper process would hide the signal.
    const p = spawn(process.execPath, ['--import', 'tsx', CHILD, command, tree.n8nDir, seamsDir, String(killAt)], { cwd: PACKAGE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (_code, signal) => {
      const last = out.trim().split('\n').pop() ?? '';
      const parsed = last.startsWith('{') ? (JSON.parse(last) as { code: number; mutations: number }) : null;
      resolve({ killed: signal === 'SIGKILL', code: parsed?.code ?? null, mutations: parsed?.mutations ?? null, stderr: err });
    });
  });
}

async function pool<T, R>(items: readonly T[], width: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  }));
  return out;
}

function cli(command: 'install' | 'uninstall' | 'status', tree: Tree, seamsDir: string) {
  const io = captureIo();
  const code = runInstallCli(command, ['--n8n', tree.n8nDir, '--seams', seamsDir], io, { hook: '/h.cjs', toolVersion: '0.0.0-test', env: { PATH: '' }, npmRoot: () => undefined });
  return { code, out: io.out.join(''), err: io.err.join('') };
}

/** Invariant 1: every patched replaced file finds every created code file it requires. */
function loadable(tree: Tree, seamsDir: string): string | null {
  const { manifest } = loadManifests(seamsDir).get(CORE_VERSION)!;
  const hash = (p: string) => (existsSync(join(tree.coreDir, p)) ? sha256(readFileSync(join(tree.coreDir, p))) : null);
  const patched = manifest.files.filter((f) => f.before !== null && hash(f.path) === f.after);
  if (patched.length === 0) return null;
  const missing = manifest.files.filter((f) => f.before === null && hash(f.path) !== f.after);
  return missing.length === 0 ? null : `${patched.map((f) => f.path).join(', ')} patched while ${missing.map((f) => f.path).join(', ')} not in place`;
}

const width = 6;
const MAX_POINTS = 120;

afterEach(() => cleanupTrees());

describe('killed mid-run', () => {
  it('install: at every mutation, n8n-core stays loadable and uninstall returns it to the stock bytes', async () => {
    const seamsDir = makeSeams();
    // How many mutations a whole install makes.
    const dry = await child('install', makeTree(), seamsDir, 0);
    expect(dry.code, dry.stderr).toBe(EXIT.ok);
    const total = dry.mutations!;
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThan(MAX_POINTS);

    const points = Array.from({ length: total }, (_, i) => i + 1);
    const failures = await pool(points, width, async (killAt) => {
      const tree = makeTree();
      const stock = snapshot(tree.coreDir);
      const r = await child('install', tree, seamsDir, killAt);
      const problems: string[] = [];
      if (!r.killed) problems.push(`not killed (code ${r.code}): ${r.stderr}`);
      const broken = loadable(tree, seamsDir);
      if (broken !== null) problems.push(`unloadable: ${broken}`);
      const s = cli('status', tree, seamsDir);
      const state = /^state: (\S+)$/m.exec(s.out)?.[1];
      if (!['stock', 'installed', 'interrupted'].includes(state ?? '')) problems.push(`status ${state}: ${s.out}`);

      // Path A: install again (exit 0, or exit 3 naming uninstall), then uninstall.
      const again = cli('install', tree, seamsDir);
      if (again.code !== EXIT.ok && !(again.code === EXIT.inconsistent && again.err.includes('n8n-libpetri uninstall'))) {
        problems.push(`install again: ${again.code} ${again.err}`);
      }
      const un = cli('uninstall', tree, seamsDir);
      if (un.code !== EXIT.ok) problems.push(`uninstall: ${un.code} ${un.err}`);
      if (JSON.stringify(snapshot(tree.coreDir)) !== JSON.stringify(stock)) problems.push(`not stock after uninstall: ${JSON.stringify(snapshot(tree.coreDir))}`);
      if (existsSync(join(tree.coreDir, STATE_DIR))) problems.push('state directory left');
      // ...and a clean install works afterwards.
      const fresh = cli('install', tree, seamsDir);
      if (fresh.code !== EXIT.ok) problems.push(`fresh install: ${fresh.code} ${fresh.err}`);
      return problems.length === 0 ? null : `kill at ${killAt}/${total} (status ${state}): ${problems.join('; ')}`;
    });
    expect(failures.filter((f) => f !== null)).toEqual([]);
  }, 180_000);

  it('install: uninstall straight after the kill (no second install) also returns the stock bytes', async () => {
    const seamsDir = makeSeams();
    const total = (await child('install', makeTree(), seamsDir, 0)).mutations!;
    const points = Array.from({ length: total }, (_, i) => i + 1);
    const failures = await pool(points, width, async (killAt) => {
      const tree = makeTree();
      const stock = snapshot(tree.coreDir);
      await child('install', tree, seamsDir, killAt);
      const un = cli('uninstall', tree, seamsDir);
      const problems: string[] = [];
      if (un.code !== EXIT.ok) problems.push(`uninstall: ${un.code} ${un.err}`);
      if (JSON.stringify(snapshot(tree.coreDir)) !== JSON.stringify(stock)) problems.push('not stock after uninstall');
      if (existsSync(join(tree.coreDir, STATE_DIR))) problems.push('state directory left');
      return problems.length === 0 ? null : `kill at ${killAt}/${total}: ${problems.join('; ')}`;
    });
    expect(failures.filter((f) => f !== null)).toEqual([]);
  }, 180_000);

  it('uninstall: at every mutation, n8n-core stays loadable and a second uninstall finishes the way back', async () => {
    const seamsDir = makeSeams();
    const probe = makeTree();
    expect(cli('install', probe, seamsDir).code).toBe(EXIT.ok);
    const dry = await child('uninstall', probe, seamsDir, 0);
    expect(dry.code, dry.stderr).toBe(EXIT.ok);
    const total = dry.mutations!;
    expect(total).toBeGreaterThan(10);
    expect(total).toBeLessThan(MAX_POINTS);

    const points = Array.from({ length: total }, (_, i) => i + 1);
    const failures = await pool(points, width, async (killAt) => {
      const tree = makeTree();
      const stock = snapshot(tree.coreDir);
      const problems: string[] = [];
      if (cli('install', tree, seamsDir).code !== EXIT.ok) return `kill at ${killAt}: setup install failed`;
      const r = await child('uninstall', tree, seamsDir, killAt);
      if (!r.killed) problems.push(`not killed (code ${r.code}): ${r.stderr}`);
      const broken = loadable(tree, seamsDir);
      if (broken !== null) problems.push(`unloadable: ${broken}`);
      const s = cli('status', tree, seamsDir);
      const state = /^state: (\S+)$/m.exec(s.out)?.[1];
      if (!['stock', 'installed', 'interrupted'].includes(state ?? '')) problems.push(`status ${state}: ${s.out}`);
      const un = cli('uninstall', tree, seamsDir);
      if (un.code !== EXIT.ok) problems.push(`uninstall again: ${un.code} ${un.err}`);
      if (JSON.stringify(snapshot(tree.coreDir)) !== JSON.stringify(stock)) problems.push(`not stock: ${JSON.stringify(snapshot(tree.coreDir))}`);
      if (existsSync(join(tree.coreDir, STATE_DIR))) problems.push('state directory left');
      return problems.length === 0 ? null : `kill at ${killAt}/${total} (status ${state}): ${problems.join('; ')}`;
    });
    expect(failures.filter((f) => f !== null)).toEqual([]);
  }, 180_000);
});
