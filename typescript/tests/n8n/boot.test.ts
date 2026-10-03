/**
 * `bootFromEnv` (`src/n8n/boot.ts`), the boot path the `EXTERNAL_HOOK_FILES` shim and the
 * testbed preload share, against a fake n8n whose n8n-core is a CommonJS module with or
 * without patch 0002's seam. Each case names one row of `tasks/inject-plan.md` decision 8.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BootError, bootFromEnv, ENGINE_ENV, readKnobs, REGISTERED_LINE } from '../../src/n8n/boot.js';
import { JOURNAL_FILE, RECORD_FILE, STATE_DIR, sha256 } from '../../src/install/record.js';
import { ENGINE_ENTERED_DIAGNOSTIC, PetriScheduler } from '../../src/scheduler/index.js';
import { cleanupTrees, tempDir } from '../install/support.js';

interface FakeN8n {
  readonly n8nDir: string;
  readonly coreDir: string;
  /** Reads what the fake registry holds, through the same CJS instance n8n would use. */
  readonly registered: () => (() => unknown) | null;
}

function fakeN8n(options: { seam?: boolean } = {}): FakeN8n {
  const root = tempDir('n8n-libpetri-boot-');
  const n8nDir = join(root, 'node_modules', 'n8n');
  const coreDir = join(n8nDir, 'node_modules', 'n8n-core');
  const workflowDir = join(n8nDir, 'node_modules', 'n8n-workflow');
  mkdirSync(join(n8nDir, 'bin'), { recursive: true });
  mkdirSync(join(coreDir, 'dist'), { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(n8nDir, 'package.json'), JSON.stringify({ name: 'n8n', version: '9.9.10' }));
  writeFileSync(join(n8nDir, 'bin', 'n8n'), '');
  writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ name: 'n8n-core', version: '9.9.9', main: 'dist/index' }));
  writeFileSync(
    join(coreDir, 'dist', 'index.js'),
    options.seam === false
      ? 'exports.WorkflowExecute = class {};\n'
      : [
          'let factory = null;',
          'exports.setWorkflowSchedulerFactory = (next) => { factory = next; };',
          'exports.getRegistered = () => factory;',
          'exports.StackScheduler = class StackScheduler { run() {} };',
          '',
        ].join('\n'),
  );
  writeFileSync(join(workflowDir, 'package.json'), JSON.stringify({ name: 'n8n-workflow', version: '9.9.8', main: 'index.js' }));
  writeFileSync(join(workflowDir, 'index.js'), 'exports.NodeHelpers = { getNodeParameters: () => ({}) };\n');
  const req = createRequire(join(n8nDir, 'package.json'));
  return { n8nDir, coreDir, registered: () => (req('n8n-core') as { getRegistered?: () => (() => unknown) | null }).getRegistered?.() ?? null };
}

function boot(n8n: FakeN8n, env: NodeJS.ProcessEnv) {
  const messages: string[] = [];
  const result = bootFromEnv({ env, resolveFrom: join(n8n.n8nDir, 'bin', 'n8n'), onDiagnostic: (m) => messages.push(m), loader: '/hook.cjs' });
  return { result, messages };
}

afterEach(() => cleanupTrees());

describe('bootFromEnv', () => {
  it('does nothing when N8N_EXECUTION_ENGINE is unset or empty, and resolves nothing', () => {
    const n8n = fakeN8n({ seam: false });
    expect(boot(n8n, {}).result).toEqual({ status: 'inert' });
    expect(boot(n8n, { [ENGINE_ENV]: '' }).result).toEqual({ status: 'inert' });
    // Inert even where the seam is missing: an unactivated process is stock n8n.
    expect(bootFromEnv({ env: {}, resolveFrom: '/nonexistent/x' })).toEqual({ status: 'inert' });
  });

  it('registers PetriScheduler with the n8n-core n8n resolves, and says so in one line', () => {
    const n8n = fakeN8n();
    const { result, messages } = boot(n8n, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_BUDGET: '3' });
    expect(result.status).toBe('registered');
    if (result.status !== 'registered') return;
    expect(result.coreVersion).toBe('9.9.9');
    expect(result.knobs).toEqual({ budget: 3, maxAgentRounds: undefined, maxAgentToolCalls: undefined });
    expect(result.installed).toBe(false);
    expect(messages).toEqual([`${REGISTERED_LINE}: budget=3, n8n-core=9.9.9, hook=/hook.cjs`]);
    // The factory n8n's registry now holds is ours, and entering it is the second claim.
    const factory = n8n.registered();
    expect(factory).toBe(result.registration.factory);
    expect(factory!()).toBeInstanceOf(PetriScheduler);
    expect(messages[1]).toBe(ENGINE_ENTERED_DIAGNOSTIC);
  });

  it('refuses an n8n-core without the seam, naming the version, the path and the fix', () => {
    const n8n = fakeN8n({ seam: false });
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri' })).toThrow(BootError);
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri' })).toThrow(/n8n-core 9\.9\.9 at .*n8n-core has no scheduler seam.*n8n-libpetri install/);
  });

  it('refuses when a file no longer hashes to what the installer wrote, and registers nothing', () => {
    const n8n = fakeN8n();
    const state = join(n8n.coreDir, STATE_DIR);
    mkdirSync(state);
    const write = (after: string) => writeFileSync(join(state, RECORD_FILE), JSON.stringify({
      schema: 1, tool: { name: 'n8n-libpetri', version: '0' }, package: 'n8n-core', version: '9.9.9', manifestSha256: '0'.repeat(64),
      sourcePatches: {}, installedAt: '2026-10-03T00:00:00.000Z', unverified: false, files: [{ path: 'dist/index.js', before: null, after }],
    }));
    write('f'.repeat(64));
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri' })).toThrow(/no longer matches its n8n-libpetri install record \(dist\/index\.js\).*n8n-libpetri status/);
    expect(n8n.registered()).toBeNull();

    // With the right hash it boots and says the n8n-core is an installed one.
    write(sha256(readFileSync(join(n8n.coreDir, 'dist', 'index.js'))));
    const { result, messages } = boot(n8n, { [ENGINE_ENV]: 'libpetri' });
    expect(result.status === 'registered' && result.installed).toBe(true);
    expect(messages[0]).toContain('n8n-core=9.9.9 (installed)');
  });

  it('refuses an n8n-core part way through an install or uninstall (a journal, no record)', () => {
    const n8n = fakeN8n();
    const state = join(n8n.coreDir, STATE_DIR);
    mkdirSync(state);
    writeFileSync(join(state, JOURNAL_FILE), JSON.stringify({ schema: 1, version: '9.9.9', operation: 'uninstall', files: [] }));
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri' })).toThrow(/part way through an n8n-libpetri install or uninstall.*n8n-libpetri uninstall/);
    expect(n8n.registered()).toBeNull();
    // The engine off, the hook resolves nothing: stock n8n starts whatever state n8n-core is in.
    expect(boot(n8n, {}).result).toEqual({ status: 'inert' });
  });

  it('throws on any other value, so a typo cannot silently run n8n\'s own loop', () => {
    const n8n = fakeN8n();
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetrx' })).toThrow("N8N_EXECUTION_ENGINE must be 'libpetri' or unset, got 'libpetrx'");
    expect(() => boot(n8n, { [ENGINE_ENV]: 'legacy' })).toThrow(BootError);
    expect(n8n.registered()).toBeNull();
  });

  it('refuses a knob that is not a positive integer before touching n8n', () => {
    const n8n = fakeN8n();
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_BUDGET: '0' })).toThrow("N8N_LIBPETRI_BUDGET must be a positive integer, got '0'");
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_MAX_AGENT_ROUNDS: '3x' })).toThrow(/N8N_LIBPETRI_MAX_AGENT_ROUNDS/);
    expect(() => boot(n8n, { [ENGINE_ENV]: 'libpetri', N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS: '-1' })).toThrow(/N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS/);
    expect(n8n.registered()).toBeNull();
    expect(readKnobs({ N8N_LIBPETRI_MAX_AGENT_ROUNDS: '12', N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS: '4' })).toEqual({ budget: 1, maxAgentRounds: 12, maxAgentToolCalls: 4 });
  });

  it('says where it looked when n8n-core cannot be resolved', () => {
    const dir = tempDir();
    expect(() => bootFromEnv({ env: { [ENGINE_ENV]: 'libpetri' }, resolveFrom: join(dir, 'x.js') })).toThrow(/cannot resolve n8n-core from/);
  });
});
