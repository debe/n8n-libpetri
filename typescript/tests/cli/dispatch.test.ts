/**
 * `n8n-libpetri`'s first word (`src/cli/dispatch.ts`): the installer's four commands, `help`,
 * and everything else falling through to the verifier, so `n8n-libpetri <workflow.json>` and
 * `n8n-libpetri verify <workflow.json>` behave as they did before the installer existed.
 */
import { dispatch, USAGE } from '../../src/cli/dispatch.js';
import { renderEnv } from '../../src/install/cli.js';
import { USAGE as VERIFY_USAGE } from '../../src/verify/cli.js';
import { captureIo, cleanupTrees, makeSeams, makeTree } from '../install/support.js';

afterEach(() => cleanupTrees());

describe('dispatch', () => {
  it('routes install, uninstall and status to the installer, with its exit codes', async () => {
    const tree = makeTree();
    const seamsDir = makeSeams();
    const deps = { seamsDir, hook: '/h.cjs', toolVersion: '0', env: { PATH: '' }, npmRoot: () => undefined };
    const io = captureIo();
    expect(await dispatch(['status', '--n8n', tree.n8nDir], io, deps)).toBe(0);
    expect(io.out.join('')).toMatch(/^state: stock$/m);
    expect(await dispatch(['install', '--n8n', tree.n8nDir], io, deps)).toBe(0);
    expect(await dispatch(['uninstall', '--n8n', tree.n8nDir], io, deps)).toBe(0);
    expect(await dispatch(['install', '--n8n', tree.n8nDir, '--nope'], io, deps)).toBe(2);
  });

  it('prints the activation exports for env', async () => {
    const io = captureIo();
    expect(await dispatch(['env'], io, { hook: '/h.cjs' })).toBe(0);
    expect(io.out.join('')).toBe(renderEnv('/h.cjs'));
  });

  it('prints both usages for help, and each command\'s own for --help', async () => {
    const io = captureIo();
    expect(await dispatch(['help'], io)).toBe(0);
    expect(io.out.join('')).toBe(USAGE);
    expect(USAGE).toContain('n8n-libpetri install');
    expect(USAGE).toContain(VERIFY_USAGE);
    expect(USAGE).toContain('3 inconsistent state');
    const own = captureIo();
    expect(await dispatch(['install', '--help'], own)).toBe(0);
    expect(own.out.join('')).toContain('--allow-unverified');
  });

  it('falls through to verify for any other first word, keeping verify\'s exit codes', async () => {
    const io = captureIo();
    expect(await dispatch(['--bogus-flag'], io)).toBe(2);
    expect(io.err.join('')).toContain(VERIFY_USAGE);
    const missing = captureIo();
    expect(await dispatch(['verify', '/nonexistent/workflow.json'], missing)).toBe(2);
    expect(await dispatch(['/nonexistent/workflow.json'], captureIo())).toBe(2);
  });
});
