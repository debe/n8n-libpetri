/**
 * Command line: `tsx src/conformance/differ-cli.ts <fixtures-module> [--budget N]…
 * [--fixture NAME]… [--out FILE] [--title T]`.
 *
 * `<fixtures-module>` is any module whose default export (or `DIFFER_FIXTURES` export) is
 * an array of {@link DifferFixture}; `tests/conformance/differ-fixtures.ts` is the one this
 * repository ships. Each fixture is run through both engines at every `--budget` (default
 * 1, 2 and 4), and the Markdown report goes to stdout or to `--out`.
 *
 * Exit 0 when no run failed (a `divergent` run — every difference attributed to a
 * `docs/divergences.md` row — is not a failure) **and** no run produced an ordering
 * mechanism the register does not name, 1 otherwise, 2 on a usage error. A novel mechanism
 * is not a `fail` verdict — the data gate and happens-before are intact — but it is a
 * behaviour with no row, and `docs/divergences.md` says nothing is skipped silently, so a
 * CI leg driving this command must not go green on one.
 */
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffFixture, renderDiffReport, type DifferFixture, type DiffResult } from './differ.js';

export interface DifferCliIo {
  readonly load: (specifier: string) => Promise<unknown>;
  readonly writeFile: (path: string, content: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Runs one fixture at one budget; {@link diffFixture} unless a test substitutes one. */
  readonly diff?: (fixture: DifferFixture, budget: number) => Promise<DiffResult>;
}

export const DIFFER_USAGE =
  'usage: differ-cli <fixtures-module> [--budget N]… [--fixture NAME]… [--out FILE] [--title T]';

/** Pull the fixture array out of a loaded module. */
export function fixturesOf(module: unknown): readonly DifferFixture[] {
  const shape = module as { default?: unknown; DIFFER_FIXTURES?: unknown };
  const candidate = Array.isArray(shape.default) ? shape.default : shape.DIFFER_FIXTURES;
  if (!Array.isArray(candidate)) {
    throw new Error('fixtures module must default-export (or export as DIFFER_FIXTURES) an array of DifferFixture');
  }
  return candidate as readonly DifferFixture[];
}

export async function runDifferCli(argv: readonly string[], io: DifferCliIo): Promise<number> {
  const budgets: number[] = [];
  const only: string[] = [];
  let modulePath: string | undefined;
  let out: string | undefined;
  let title = 'Differential report';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === '--budget') budgets.push(Number.parseInt(value(), 10));
      else if (arg === '--fixture') only.push(value());
      else if (arg === '--out') out = value();
      else if (arg === '--title') title = value();
      else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
      else if (modulePath === undefined) modulePath = arg;
      else throw new Error('only one fixtures module');
    } catch (e) {
      io.stderr(`${(e as Error).message}\n${DIFFER_USAGE}\n`);
      return 2;
    }
  }
  if (modulePath === undefined) {
    io.stderr(`${DIFFER_USAGE}\n`);
    return 2;
  }
  if (budgets.some((b) => !Number.isInteger(b) || b < 1)) {
    io.stderr(`--budget must be a positive integer\n${DIFFER_USAGE}\n`);
    return 2;
  }
  const fixtures = fixturesOf(await io.load(modulePath));
  const selected = only.length === 0 ? fixtures : fixtures.filter((f) => only.includes(f.name));
  if (selected.length === 0) {
    io.stderr(`no fixture matched ${only.join(', ')}\n`);
    return 2;
  }
  const results: DiffResult[] = [];
  for (const fixture of selected) {
    for (const budget of budgets.length > 0 ? budgets : (fixture.budgets ?? [1, 2, 4])) {
      results.push(await (io.diff ?? diffFixture)(fixture, budget));
    }
  }
  const report = renderDiffReport(results, title);
  if (out === undefined) io.stdout(report);
  else io.writeFile(out, report);
  const failed = results.filter((r) => r.verdict === 'fail');
  const divergent = results.filter((r) => r.verdict === 'divergent');
  const novel = [...new Set(results.flatMap((r) => r.novelMechanisms))].sort();
  io.stderr(
    `${results.length - failed.length - divergent.length} pass, ${divergent.length} divergent, ` +
    `${failed.length} fail${failed.length > 0 ? `: ${failed.map((r) => `${r.fixture}@k=${r.requestedBudget}`).join(', ')}` : ''}` +
    `${novel.length > 0 ? `; ${novel.length} ordering mechanism(s) with no row in docs/divergences.md: ${novel.join(', ')}` : ''}\n`,
  );
  return failed.length === 0 && novel.length === 0 ? 0 : 1;
}

/** A path (relative to the cwd or absolute) loads as a file URL; anything else as a package. */
const nodeIo: DifferCliIo = {
  load: async (specifier) => await import(
    isAbsolute(specifier) || specifier.startsWith('.') || specifier.includes('/')
      ? pathToFileURL(resolve(specifier)).href
      : specifier
  ),
  writeFile: (p, c) => writeFileSync(p, c),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

// No top-level `await`: a fixtures module that imports `src/conformance/index.js` imports
// this module back, and a still-pending top-level await here would deadlock that cycle.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDifferCli(process.argv.slice(2), nodeIo).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { nodeIo.stderr(`${String(error)}\n`); process.exitCode = 1; },
  );
}
