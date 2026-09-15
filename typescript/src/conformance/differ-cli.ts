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
 * mechanism the register does not name, 1 otherwise, 2 on a usage error or a fixtures module
 * that cannot be loaded. A novel mechanism is not a `fail` verdict — the data gate and
 * happens-before are intact — but it is a behaviour with no row, and `docs/divergences.md`
 * says nothing is skipped silently, so a CI leg driving this command must not go green on
 * one.
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { exitWith } from '../cli/exit.js';
import { parseFlags, UsageError } from '../cli/flags.js';
import { nodeOutput } from '../cli/io.js';
import type { CliOutput } from '../cli/io.js';
import { messageOf } from '../internal/errors.js';
import {
  diffFixture, fixtureStatics, novelMechanismsOf, renderDiffReport,
  type DifferFixture, type DiffResult, type FixtureStatics,
} from './differ.js';

export interface DifferCliIo extends CliOutput {
  readonly load: (specifier: string) => Promise<unknown>;
  /**
   * Runs one fixture at one budget; {@link diffFixture} unless a test substitutes one. The
   * statics are the fixture's, computed once for every budget it runs at.
   */
  readonly diff?: (fixture: DifferFixture, budget: number, statics: FixtureStatics) => Promise<DiffResult>;
}

const DIFFER_USAGE =
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
  try {
    parseFlags(argv, {
      values: {
        '--budget': (v) => { budgets.push(Number.parseInt(v, 10)); },
        '--fixture': (v) => { only.push(v); },
        '--out': (v) => { out = v; },
        '--title': (v) => { title = v; },
      },
      positional: (word) => {
        if (modulePath !== undefined) throw new UsageError('only one fixtures module');
        modulePath = word;
      },
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr(`${e.message}\n${DIFFER_USAGE}\n`);
    return 2;
  }
  if (modulePath === undefined) {
    io.stderr(`${DIFFER_USAGE}\n`);
    return 2;
  }
  if (budgets.some((b) => !Number.isInteger(b) || b < 1)) {
    io.stderr(`--budget must be a positive integer\n${DIFFER_USAGE}\n`);
    return 2;
  }
  // A module that cannot be found, does not evaluate, or exports no fixture array is an input
  // error: exit 2 naming it, like `n8n-libpetri verify` on an unreadable workflow.
  let fixtures: readonly DifferFixture[];
  try {
    fixtures = fixturesOf(await io.load(modulePath));
  } catch (e) {
    io.stderr(`${modulePath}: ${messageOf(e)}\n`);
    return 2;
  }
  const selected = only.length === 0 ? fixtures : fixtures.filter((f) => only.includes(f.name));
  if (selected.length === 0) {
    io.stderr(`no fixture matched ${only.join(', ')}\n`);
    return 2;
  }
  const results: DiffResult[] = [];
  const diff = io.diff ?? diffFixture;
  for (const fixture of selected) {
    const statics = fixtureStatics(fixture.workflow);
    for (const budget of budgets.length > 0 ? budgets : (fixture.budgets ?? [1, 2, 4])) {
      results.push(await diff(fixture, budget, statics));
    }
  }
  const report = renderDiffReport(results, title);
  if (out === undefined) io.stdout(report);
  else io.writeFile(out, report);
  const failed = results.filter((r) => r.verdict === 'fail');
  const divergent = results.filter((r) => r.verdict === 'divergent');
  const novel = novelMechanismsOf(results);
  io.stderr(
    `${results.length - failed.length - divergent.length} pass, ${divergent.length} divergent, ` +
    `${failed.length} fail${failed.length > 0 ? `: ${failed.map((r) => `${r.fixture}@k=${r.requestedBudget}`).join(', ')}` : ''}` +
    `${novel.length > 0 ? `; ${novel.length} ordering mechanism(s) with no row in docs/divergences.md: ${novel.join(', ')}` : ''}\n`,
  );
  return failed.length === 0 && novel.length === 0 ? 0 : 1;
}

/** A path (relative to the cwd or absolute) loads as a file URL; anything else as a package. */
const nodeIo: DifferCliIo = {
  ...nodeOutput,
  load: async (specifier) => await import(
    isAbsolute(specifier) || specifier.startsWith('.') || specifier.includes('/')
      ? pathToFileURL(resolve(specifier)).href
      : specifier
  ),
};

// No top-level `await`: a fixtures module that imports `src/conformance/index.js` imports
// this module back, and a still-pending top-level await here would deadlock that cycle.
// Not a tsup entry, and must not become one as is: under code splitting this guard compares
// a chunk's URL and is never true (see `src/verify/main.ts`) — give it a thin main first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitWith(() => runDifferCli(process.argv.slice(2), nodeIo));
}
