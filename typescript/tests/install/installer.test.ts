/**
 * `n8n-libpetri install | uninstall | status` against synthetic n8n trees (`support.ts`):
 * every refusal and state of `tasks/inject-plan.md` decision 10, with the exit codes it names.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { install } from '../../src/install/apply.js';
import { runInstallCli, renderEnv, type InstallCliDeps } from '../../src/install/cli.js';
import { EXIT } from '../../src/install/errors.js';
import { nodeFileOps, type FileOps } from '../../src/install/fs-ops.js';
import { locate } from '../../src/install/locate.js';
import { loadManifests } from '../../src/install/manifest.js';
import { JOURNAL_FILE, LOCK_FILE, RECORD_FILE, readRecord, sha256, STATE_DIR } from '../../src/install/record.js';
import { CORE_VERSION, DIST, PATCHED, captureIo, cleanupTrees, makeSeams, makeTree, snapshot, tempDir, type Tree } from './support.js';

const HOOK = '/opt/n8n-libpetri/hook/n8n-hook.cjs';

function run(command: 'install' | 'uninstall' | 'status' | 'env', argv: string[], deps: InstallCliDeps & { seamsDir: string }) {
  const io = captureIo();
  const code = runInstallCli(command, argv, io, { hook: HOOK, toolVersion: '0.0.0-test', env: { PATH: '' }, npmRoot: () => undefined, ...deps });
  return { code, out: io.out.join(''), err: io.err.join('') };
}

function seamsAndTree(options: Parameters<typeof makeTree>[0] = {}, seams: Parameters<typeof makeSeams>[0] = {}): { tree: Tree; seamsDir: string } {
  return { tree: makeTree(options), seamsDir: makeSeams(seams) };
}

const installed = (tree: Tree) => readRecord(tree.coreDir);

/** A pid that no longer runs: a child that has exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

const CREATED = ['stack-scheduler.js', 'scheduler-registry.js', 'workflow-scheduler.js'];

/** Whether every patched replaced file finds the created files it requires. */
function loadable(tree: Tree): boolean {
  const patched = ['workflow-execute.js', 'index.js'].some((f) => readFileSync(join(tree.coreDir, DIST, f), 'utf8') === PATCHED[f]);
  return !patched || CREATED.every((f) => existsSync(join(tree.coreDir, DIST, f)) && readFileSync(join(tree.coreDir, DIST, f), 'utf8') === PATCHED[f]);
}

afterEach(() => cleanupTrees());

describe('install → status → uninstall', () => {
  it('installs into a stock tree, reports installed, and uninstalls back to the exact stock bytes', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);

    const before = run('status', ['--n8n', tree.n8nDir], { seamsDir });
    expect(before.code).toBe(EXIT.ok);
    expect(before.out).toMatch(/^state: stock$/m);

    const inst = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(inst.err).toBe('');
    expect(inst.code).toBe(EXIT.ok);
    expect(inst.out).toContain(`installed the scheduler seam into n8n-core ${CORE_VERSION}`);
    for (const [name, text] of Object.entries(PATCHED)) {
      expect(sha256(readFileSync(join(tree.coreDir, DIST, name))), name).toBe(sha256(Buffer.from(text)));
      expect(existsSync(join(tree.coreDir, DIST, `${name}.map`)), `${name}.map`).toBe(true);
    }
    // Type declarations are never touched.
    expect(readFileSync(join(tree.coreDir, DIST, 'workflow-execute.d.ts'), 'utf8')).toContain('WorkflowExecute');
    const record = installed(tree)!;
    expect(record.version).toBe(CORE_VERSION);
    expect(record.unverified).toBe(false);
    expect(record.files).toHaveLength(10);

    const after = run('status', ['--n8n', tree.n8nDir, '--json'], { seamsDir });
    expect(after.code).toBe(EXIT.ok);
    expect(JSON.parse(after.out)).toMatchObject({ state: 'installed', coreVersion: CORE_VERSION, coreDir: tree.coreDir, n8nDir: tree.n8nDir });

    const un = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
    expect(un.err).toBe('');
    expect(un.code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(stock);
    expect(existsSync(join(tree.coreDir, STATE_DIR))).toBe(false);

    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).out).toContain('nothing to uninstall');
  });

  it('preserves each replaced file\'s mode', () => {
    const { tree, seamsDir } = seamsAndTree();
    chmodSync(join(tree.coreDir, DIST, 'index.js'), 0o640);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(statSync(join(tree.coreDir, DIST, 'index.js')).mode & 0o777).toBe(0o640);
  });

  it('does nothing on a second install from the same seams', () => {
    const { tree, seamsDir } = seamsAndTree();
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    const once = snapshot(tree.coreDir);
    const again = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(again.code).toBe(EXIT.ok);
    expect(again.out).toContain('already installed');
    expect(snapshot(tree.coreDir)).toEqual(once);
  });

  it('installs no maps where the target ships none, and uninstalls to the same bytes', () => {
    const { tree, seamsDir } = seamsAndTree({ maps: false });
    const stock = snapshot(tree.coreDir);
    const inst = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(inst.code).toBe(EXIT.ok);
    expect(inst.out).toContain('ships no source maps');
    expect(existsSync(join(tree.coreDir, DIST, 'stack-scheduler.js.map'))).toBe(false);
    expect(installed(tree)!.files).toHaveLength(5);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });

  it('works through a pnpm symlink layout, patching the realpath n8n loads', () => {
    const { tree, seamsDir } = seamsAndTree({ layout: 'pnpm' });
    expect(tree.coreDir).toContain('.pnpm');
    const stock = snapshot(tree.coreDir);
    expect(locate({ n8n: tree.n8nDir }).coreDir).toBe(tree.coreDir);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toMatch(/^state: installed$/m);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });
});

describe('refusals', () => {
  it('refuses a tampered stock file, names it and the hash found, and writes nothing', () => {
    const { tree, seamsDir } = seamsAndTree();
    writeFileSync(join(tree.coreDir, DIST, 'index.js'), 'tampered\n');
    const stock = snapshot(tree.coreDir);
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain(`${DIST}/index.js has sha256 ${sha256(Buffer.from('tampered\n'))}`);
    expect(snapshot(tree.coreDir)).toEqual(stock);
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toMatch(/^state: stock-unsupported$/m);
  });

  it('checks only the files the seam touches: a change elsewhere in n8n-core is neither refused nor undone', () => {
    // The documented scope (docs/install.md): the installer verifies the files it replaces and
    // the names it creates, not the rest of n8n-core.
    const { tree, seamsDir } = seamsAndTree();
    const other = join(tree.coreDir, DIST, 'workflow-execute.d.ts');
    writeFileSync(other, `${readFileSync(other, 'utf8')}// local change\n`);
    const edited = snapshot(tree.coreDir);
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toMatch(/^state: stock$/m);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(edited);
  });

  it('refuses an unknown n8n-core version and names the supported n8n versions', () => {
    const { tree, seamsDir } = seamsAndTree({ coreVersion: '1.2.3' });
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('n8n-core 1.2.3 (n8n 9.9.10) is not supported; supported: n8n 9.9.10 (n8n-core 9.9.9)');
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toMatch(/^state: stock-unsupported$/m);
  });

  it('refuses seams without a neutrality record unless --allow-unverified, and records that it was given', () => {
    const { tree, seamsDir } = seamsAndTree({}, { neutrality: null });
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('no neutrality record');
    expect(existsSync(join(tree.coreDir, STATE_DIR))).toBe(false);

    const ok = run('install', ['--n8n', tree.n8nDir, '--allow-unverified'], { seamsDir });
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.err).toContain('without a release-neutrality record');
    expect(installed(tree)!.unverified).toBe(true);
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toContain('(with --allow-unverified)');
  });

  it('refuses a failed neutrality record the same way', () => {
    const { tree, seamsDir } = seamsAndTree({}, { neutrality: { date: '2026-10-03', passed: false, summary: 'x' } });
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).err).toContain('a failed neutrality record');
  });

  it('refuses an n8n inside npm\'s npx cache unless --allow-npx', () => {
    const { tree, seamsDir } = seamsAndTree({ npx: true });
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain("npm's npx cache");
    expect(run('install', ['--n8n', tree.n8nDir, '--allow-npx'], { seamsDir }).code).toBe(EXIT.ok);
  });

  it('refuses a tree with two n8n-core copies, whatever their versions', () => {
    const { tree, seamsDir } = seamsAndTree({ secondCore: CORE_VERSION });
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('contains 2 copies of n8n-core');
  });

  it('refuses while another run holds the lock', () => {
    const { tree, seamsDir } = seamsAndTree();
    mkdirSync(join(tree.coreDir, STATE_DIR));
    writeFileSync(join(tree.coreDir, STATE_DIR, LOCK_FILE), 'pid 1\n');
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('holds');
    expect(r.err).toContain('pid 1');
    expect(existsSync(join(tree.coreDir, DIST, 'stack-scheduler.js'))).toBe(false);
  });

  it('refuses a lock whose holder still runs, or runs on another host; takes over one whose holder is gone', () => {
    const { tree, seamsDir } = seamsAndTree();
    const state = join(tree.coreDir, STATE_DIR);
    mkdirSync(state);
    writeFileSync(join(state, LOCK_FILE), `pid ${process.ppid} host ${hostname()}\n`);
    const live = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(live.code).toBe(EXIT.refused);
    expect(live.err).toContain(`(pid ${process.ppid} on host ${hostname()}, which is still running)`);

    writeFileSync(join(state, LOCK_FILE), `pid ${deadPid()} host elsewhere.example\n`);
    const remote = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
    expect(remote.code).toBe(EXIT.refused);
    expect(remote.err).toContain('whether it still runs cannot be told from host');
    expect(remote.err).toContain('if none is running, remove that file');

    const dead = deadPid();
    writeFileSync(join(state, LOCK_FILE), `pid ${dead} host ${hostname()}\n`);
    const ok = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.err).toContain(`note: took over the lock left by pid ${dead} on host ${hostname()}, which no longer runs`);
    expect(existsSync(join(state, LOCK_FILE))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('exits 4 on a read-only n8n-core and names the directory', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);
    chmodSync(join(tree.coreDir, DIST), 0o555);
    chmodSync(tree.coreDir, 0o555);
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.permission);
    expect(r.err).toContain('permission denied');
    expect(r.err).toContain('not writable');
    chmodSync(tree.coreDir, 0o755);
    chmodSync(join(tree.coreDir, DIST), 0o755);
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });

  it('rejects unknown flags and stray words as usage (exit 2)', () => {
    const { tree, seamsDir } = seamsAndTree();
    expect(run('install', ['--n8n', tree.n8nDir, '--bogus'], { seamsDir }).code).toBe(EXIT.usage);
    expect(run('status', ['extra'], { seamsDir }).code).toBe(EXIT.usage);
    expect(run('uninstall', ['--allow-unverified'], { seamsDir }).code).toBe(EXIT.usage);
    expect(run('install', ['--n8n'], { seamsDir }).code).toBe(EXIT.usage);
  });

  it('refuses when no n8n can be found, and says how to name one', () => {
    const seamsDir = makeSeams();
    const r = run('status', [], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('--n8n');
  });
});

describe('rollback', () => {
  it('restores every file when a write fails after the second one, and leaves no state behind', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);
    let writes = 0;
    const failing: FileOps = {
      ...nodeFileOps,
      writeAtomic: (path, bytes, mode) => {
        // The journal is write 1; files are writes 2.. ; fail on the third file.
        if (++writes === 4) throw new Error('disk full (injected)');
        nodeFileOps.writeAtomic(path, bytes, mode);
      },
    };
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir, ops: failing });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('disk full (injected)');
    expect(writes).toBe(4);
    expect(snapshot(tree.coreDir)).toEqual(stock);
    expect(existsSync(join(tree.coreDir, STATE_DIR))).toBe(false);
    // And a clean install works afterwards.
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
  });

  it('writes the created files before the replaced ones that require them', () => {
    const { tree, seamsDir } = seamsAndTree();
    const order: string[] = [];
    const watching: FileOps = { ...nodeFileOps, writeAtomic: (path, bytes, mode) => { order.push(path.slice(tree.coreDir.length + 1)); nodeFileOps.writeAtomic(path, bytes, mode); } };
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir, ops: watching }).code).toBe(EXIT.ok);
    const files = order.filter((p) => p.startsWith(DIST) && p.endsWith('.js'));
    const lastCreated = Math.max(...['stack-scheduler.js', 'scheduler-registry.js', 'workflow-scheduler.js'].map((f) => files.indexOf(`${DIST}/${f}`)));
    const firstReplaced = Math.min(...['workflow-execute.js', 'index.js'].map((f) => files.indexOf(`${DIST}/${f}`)));
    expect(lastCreated).toBeLessThan(firstReplaced);
    expect(installed(tree)!.files.map((f) => f.path)).toEqual(order.filter((p) => p.startsWith(DIST)));
  });

  for (const [what, failAt] of [['the first restore', { write: 2, remove: 0 }], ['a removal after the restores', { write: 0, remove: 3 }]] as const) {
    it(`uninstall: an I/O error at ${what} exits 3, keeps n8n-core loadable, and a second uninstall finishes`, () => {
      const { tree, seamsDir } = seamsAndTree();
      const stock = snapshot(tree.coreDir);
      expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
      let writes = 0;
      let removes = 0;
      const eio = () => Object.assign(new Error('EIO: i/o error, rename (injected)'), { code: 'EIO' });
      const failing: FileOps = {
        writeAtomic: (path, bytes, mode) => {
          // Write 1 is the uninstall journal; restores follow.
          if (++writes === failAt.write) throw eio();
          nodeFileOps.writeAtomic(path, bytes, mode);
        },
        remove: (path) => {
          // Remove 1 is the record; created files follow.
          if (++removes === failAt.remove) throw eio();
          nodeFileOps.remove(path);
        },
      };
      const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir, ops: failing });
      expect(u.code).toBe(EXIT.inconsistent);
      expect(u.err).toContain('EIO: i/o error');
      expect(u.err).toContain('run `n8n-libpetri uninstall` again');
      expect(loadable(tree)).toBe(true);
      expect(existsSync(join(tree.coreDir, STATE_DIR, LOCK_FILE))).toBe(false);
      const s = run('status', ['--n8n', tree.n8nDir], { seamsDir });
      expect(s.out).toMatch(/^state: interrupted$/m);
      expect(s.out).toContain('an uninstall stopped before it finished');
      // Install names the way back instead of claiming a change after install.
      const i = run('install', ['--n8n', tree.n8nDir], { seamsDir });
      expect(i.code).toBe(EXIT.inconsistent);
      expect(i.err).toContain('run `n8n-libpetri uninstall` to restore the stock files');
      const again = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
      expect(again.err).toBe('');
      expect(again.code).toBe(EXIT.ok);
      expect(snapshot(tree.coreDir)).toEqual(stock);
    });
  }

  it('uninstall: an I/O error before anything changed exits 3 and says nothing was changed', () => {
    const { tree, seamsDir } = seamsAndTree();
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    const before = snapshot(tree.coreDir);
    const failing: FileOps = { ...nodeFileOps, writeAtomic: () => { throw Object.assign(new Error('EIO: i/o error (injected)'), { code: 'EIO' }); } };
    const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir, ops: failing });
    expect(u.code).toBe(EXIT.inconsistent);
    expect(u.err).toContain('nothing was changed');
    expect(snapshot(tree.coreDir)).toEqual(before);
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toMatch(/^state: installed$/m);
  });

  it('uninstall: a permission error midway exits 4 and says to run uninstall again', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    let writes = 0;
    const failing: FileOps = {
      ...nodeFileOps,
      writeAtomic: (path, bytes, mode) => {
        if (++writes === 3) throw Object.assign(new Error('EACCES: permission denied (injected)'), { code: 'EACCES' });
        nodeFileOps.writeAtomic(path, bytes, mode);
      },
    };
    const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir, ops: failing });
    expect(u.code).toBe(EXIT.permission);
    expect(u.err).toContain('run `n8n-libpetri uninstall` again');
    expect(loadable(tree)).toBe(true);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });

  it('rebuilds nothing when a shipped delta is damaged', () => {
    const { tree, seamsDir } = seamsAndTree();
    const delta = join(seamsDir, CORE_VERSION, 'index.js.delta.json');
    writeFileSync(delta, readFileSync(delta, 'utf8').replace('"insert":"', '"insert":"X'));
    const stock = snapshot(tree.coreDir);
    const r = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('index.js.delta.json is damaged');
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });
});

describe('states', () => {
  it('reports modified, lists the file, and refuses to uninstall over it (exit 3)', () => {
    const { tree, seamsDir } = seamsAndTree();
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    writeFileSync(join(tree.coreDir, DIST, 'workflow-execute.js'), 'edited\n');
    const s = run('status', ['--n8n', tree.n8nDir], { seamsDir });
    expect(s.code).toBe(EXIT.inconsistent);
    expect(s.out).toMatch(/^state: modified$/m);
    expect(s.out).toContain(`${DIST}/workflow-execute.js: sha256 ${sha256(Buffer.from('edited\n'))}`);
    const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
    expect(u.code).toBe(EXIT.inconsistent);
    expect(readFileSync(join(tree.coreDir, DIST, 'workflow-execute.js'), 'utf8')).toBe('edited\n');
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.inconsistent);
  });

  it('reports orphaned for a seam with no record, and neither installs over it nor uninstalls it (exit 3)', () => {
    const { tree, seamsDir } = seamsAndTree();
    writeFileSync(join(tree.coreDir, DIST, 'scheduler-registry.js'), PATCHED['scheduler-registry.js']!);
    const s = run('status', ['--n8n', tree.n8nDir], { seamsDir });
    expect(s.code).toBe(EXIT.inconsistent);
    expect(s.out).toMatch(/^state: orphaned$/m);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.inconsistent);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.inconsistent);
  });

  it('refuses to uninstall when a backup is missing, and touches nothing', () => {
    const { tree, seamsDir } = seamsAndTree();
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    unlinkSync(join(tree.coreDir, STATE_DIR, 'backup', DIST, 'index.js'));
    const installedBytes = snapshot(tree.coreDir);
    const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
    expect(u.code).toBe(EXIT.inconsistent);
    expect(u.err).toContain(`the backup of ${DIST}/index.js is missing`);
    expect(u.err).toContain('Reinstall n8n');
    expect(snapshot(tree.coreDir)).toEqual(installedBytes);
  });

  it('reports an interrupted install and restores the stock files from its backups, as a real crash leaves it', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);
    expect(run('install', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    // What a kill between the last file and the record leaves: the journal, no record, the
    // killed run's lock, and a temp file beside a file it was writing.
    const state = join(tree.coreDir, STATE_DIR);
    const record = JSON.parse(readFileSync(join(state, RECORD_FILE), 'utf8')) as { version: string; files: unknown[] };
    writeFileSync(join(state, JOURNAL_FILE), JSON.stringify({ schema: 1, version: record.version, operation: 'install', files: record.files }));
    rmSync(join(state, RECORD_FILE));
    const dead = deadPid();
    writeFileSync(join(state, LOCK_FILE), `pid ${dead} host ${hostname()}\n`);
    writeFileSync(join(tree.coreDir, DIST, `.index.js.n8n-libpetri-${dead}.tmp`), 'half a file');
    // ...and one replaced file not yet written.
    writeFileSync(join(tree.coreDir, DIST, 'index.js'), readFileSync(join(state, 'backup', DIST, 'index.js')));

    const s = run('status', ['--n8n', tree.n8nDir], { seamsDir });
    expect(s.code).toBe(EXIT.inconsistent);
    expect(s.out).toMatch(/^state: interrupted$/m);
    expect(s.out).toContain('an install stopped before it wrote its record');
    expect(s.out).toContain(`a lock is left by pid ${dead}`);
    const again = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(again.code).toBe(EXIT.inconsistent);
    expect(again.err).toContain('run `n8n-libpetri uninstall`');
    const u = run('uninstall', ['--n8n', tree.n8nDir], { seamsDir });
    expect(u.err).toContain(`took over the lock left by pid ${dead}`);
    expect(u.code).toBe(EXIT.ok);
    expect(u.out).toContain('finishing a run that stopped midway');
    // Byte-identical: no lock, no journal, no temp file.
    expect(snapshot(tree.coreDir)).toEqual(stock);
    expect(existsSync(state)).toBe(false);
  });

  it('removes what a run killed before its journal left, and installs over it', () => {
    const { tree, seamsDir } = seamsAndTree();
    const stock = snapshot(tree.coreDir);
    const state = join(tree.coreDir, STATE_DIR);
    mkdirSync(join(state, 'backup'), { recursive: true });
    writeFileSync(join(state, LOCK_FILE), `pid ${deadPid()} host ${hostname()}\n`);
    writeFileSync(join(state, `.${JOURNAL_FILE}.n8n-libpetri-1.tmp`), '{');
    const s = run('status', ['--n8n', tree.n8nDir], { seamsDir });
    expect(s.code).toBe(EXIT.ok);
    expect(s.out).toMatch(/^state: stock$/m);
    expect(s.out).toContain('is left from a run that stopped before it changed any file; `n8n-libpetri uninstall` removes it');

    const u = run('uninstall', ['--n8n', tree.n8nDir, '--json'], { seamsDir });
    expect(u.code).toBe(EXIT.ok);
    expect(JSON.parse(u.out)).toMatchObject({ status: 'not-installed', leftover: true });
    expect(snapshot(tree.coreDir)).toEqual(stock);
    expect(existsSync(state)).toBe(false);

    // The same leftover under install: taken over and cleared, then a normal install.
    mkdirSync(join(state, 'backup'), { recursive: true });
    writeFileSync(join(state, LOCK_FILE), `pid ${deadPid()} host ${hostname()}\n`);
    writeFileSync(join(state, 'backup', 'junk'), 'x');
    const i = run('install', ['--n8n', tree.n8nDir], { seamsDir });
    expect(i.code).toBe(EXIT.ok);
    expect(existsSync(join(state, 'backup', 'junk'))).toBe(false);
    expect(existsSync(join(state, LOCK_FILE))).toBe(false);
    expect(run('uninstall', ['--n8n', tree.n8nDir], { seamsDir }).code).toBe(EXIT.ok);
    expect(snapshot(tree.coreDir)).toEqual(stock);
  });

  it('refuses to reinstall over an install from other seams', () => {
    const { tree, seamsDir } = seamsAndTree();
    const loaded = loadManifests(seamsDir).get(CORE_VERSION)!;
    install({ located: locate({ n8n: tree.n8nDir }), loaded, toolVersion: '0.0.0' });
    const other = { ...loaded, sha256: '0'.repeat(64) };
    expect(() => install({ located: locate({ n8n: tree.n8nDir }), loaded: other, toolVersion: '0.0.1' })).toThrow(/other seams/);
  });
});

describe('locating n8n', () => {
  it('accepts the package directory, its bin, or a prefix above it', () => {
    const { tree } = seamsAndTree();
    expect(locate({ n8n: tree.n8nDir }).n8nDir).toBe(tree.n8nDir);
    expect(locate({ n8n: tree.bin }).n8nDir).toBe(tree.n8nDir);
    expect(locate({ n8n: join(tree.root, 'prefix') }).n8nDir).toBe(tree.n8nDir);
  });

  it('finds n8n on PATH through a bin symlink, then in npm root -g', () => {
    const { tree } = seamsAndTree();
    const bin = tempDir();
    symlinkSync(tree.bin, join(bin, 'n8n'));
    expect(locate({ path: `/nonexistent:${bin}`, npmRoot: () => undefined })).toMatchObject({ n8nDir: tree.n8nDir, via: 'path' });
    expect(locate({ path: '', npmRoot: () => join(tree.n8nDir, '..') })).toMatchObject({ n8nDir: tree.n8nDir, via: 'npm-root', coreVersion: CORE_VERSION });
  });
});

describe('status environment and env', () => {
  it('says whether this shell activates the engine', () => {
    const { tree, seamsDir } = seamsAndTree();
    run('install', ['--n8n', tree.n8nDir], { seamsDir });
    const off = run('status', ['--n8n', tree.n8nDir, '--json'], { seamsDir });
    expect(JSON.parse(off.out).environment).toMatchObject({ engine: null, active: false, hookListed: false });
    expect(run('status', ['--n8n', tree.n8nDir], { seamsDir }).out).toContain('runs its own loop');

    const on = run('status', ['--n8n', tree.n8nDir, '--json'], { seamsDir, env: { PATH: '', N8N_EXECUTION_ENGINE: 'libpetri', EXTERNAL_HOOK_FILES: `/x/other.js:${HOOK}` } });
    expect(JSON.parse(on.out).environment).toMatchObject({ engine: 'libpetri', active: true, hookListed: true, hookFiles: ['/x/other.js', HOOK] });

    const typo = run('status', ['--n8n', tree.n8nDir, '--json'], { seamsDir, env: { PATH: '', N8N_EXECUTION_ENGINE: 'libpetrx' } });
    expect(JSON.parse(typo.out).environment.active).toContain("is not 'libpetri'");
  });

  it('prints the two exports, appending to any hook files already set', () => {
    const r = run('env', [], { seamsDir: tempDir() });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toBe(renderEnv(HOOK));
    expect(r.out).toContain('export N8N_EXECUTION_ENGINE=libpetri\n');
    expect(r.out).toContain(`'${HOOK}'`);
    expect(r.out).toContain('${EXTERNAL_HOOK_FILES:+');
  });
});
