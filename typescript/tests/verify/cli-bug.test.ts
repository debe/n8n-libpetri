/**
 * A programming error inside `verify()` is not an input error. `runCli` classifies what it can
 * — a bad flag, an unreadable file, a workflow the compiler refuses — as exit 2 with a
 * sentence; a `TypeError` or `ReferenceError` is neither, and swallowing it as "usage error"
 * drops the stack the one person who can fix it needs. It propagates instead, and `main.ts`
 * prints the stack for a rejected run.
 *
 * Own file because `vi.mock` is hoisted and applies to every test in the module.
 */
import { runCli } from '../../src/verify/cli.js';
import type { CliIo } from '../../src/verify/cli.js';

vi.mock('../../src/verify/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/verify/verify.js')>();
  return {
    ...real,
    verify: async () => { throw new TypeError('verifier.sinkPlacesWhen is not a function'); },
  };
});

const WORKFLOW = JSON.stringify({
  nodes: [{ id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }],
  connections: {},
});

it('a TypeError from verify() propagates with its stack instead of becoming exit 2', async () => {
  let err = '';
  const io: CliIo = {
    readFile: () => WORKFLOW,
    writeFile: () => {},
    stdout: () => {},
    stderr: (t) => { err += t; },
  };
  await expect(runCli(['verify', 'wf.json', '--quiet'], io)).rejects.toThrow(TypeError);
  expect(err).not.toContain('sinkPlacesWhen');
});
