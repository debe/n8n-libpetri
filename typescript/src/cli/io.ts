/**
 * What a command line reads and writes, injected so a run is testable without a process.
 *
 * `n8n-libpetri verify` and `tsx src/conformance/cli.ts` read their inputs through
 * {@link CliIo}; `tsx src/conformance/differ-cli.ts` loads a module instead of reading a
 * file, so it takes {@link CliOutput} plus its own loader.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Where a command line's results go: a file (`--out`), stdout, stderr. */
export interface CliOutput {
  readonly writeFile: (path: string, content: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** A command line that reads its inputs as text files. */
export interface CliIo extends CliOutput {
  readonly readFile: (path: string) => string;
}

/** Real files and streams, for a command line whose inputs are not files. */
export const nodeOutput: CliOutput = {
  writeFile: (p, c) => writeFileSync(p, c),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

/** Real files and streams. A script entry runs its `runCli` against this. */
export const nodeIo: CliIo = {
  ...nodeOutput,
  readFile: (p) => readFileSync(p, 'utf8'),
};
