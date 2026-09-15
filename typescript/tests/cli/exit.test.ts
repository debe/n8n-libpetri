/**
 * `exitWith`, the last line of every script entry: a run's result becomes the exit code, and
 * a run that throws or rejects is a defect — its stack on stderr, exit 2 — never a silent 0.
 */
import { exitWith } from '../../src/cli/exit.js';

describe('exitWith', () => {
  let before: typeof process.exitCode;
  let err: string;

  beforeEach(() => {
    before = process.exitCode;
    err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = before;
  });

  /** Lets the promise chain inside `exitWith` settle. */
  const settled = async (): Promise<void> => { await new Promise((r) => { setImmediate(r); }); };

  it('sets the code a synchronous run returns', async () => {
    exitWith(() => 1);
    await settled();
    expect(process.exitCode).toBe(1);
    expect(err).toBe('');
  });

  it('sets the code an asynchronous run resolves to', async () => {
    exitWith(async () => await Promise.resolve(3));
    await settled();
    expect(process.exitCode).toBe(3);
  });

  it('a run that throws synchronously exits 2 with its stack', async () => {
    exitWith(() => { throw new TypeError('x is not a function'); });
    await settled();
    expect(process.exitCode).toBe(2);
    expect(err).toContain('TypeError: x is not a function');
    expect(err).toContain('exit.test.ts');
  });

  it('a run that rejects exits 2 with its stack, and a non-Error is printed as is', async () => {
    exitWith(async () => { await Promise.resolve(); throw new Error('late'); });
    await settled();
    expect(process.exitCode).toBe(2);
    expect(err).toContain('Error: late');

    err = '';
    exitWith(() => Promise.reject('plain' as unknown as Error));
    await settled();
    expect(err).toBe('plain\n');
  });
});
