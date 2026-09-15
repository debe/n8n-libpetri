/**
 * The differ CLI's command line: `<fixtures-module> [--budget N]… [--fixture NAME]…
 * [--out FILE] [--title T]`, parsed into {@link DifferArgs} or into the usage error that
 * exits 2.
 */
import { parseFlags, UsageError } from '../../cli/flags.js';

export const DIFFER_USAGE =
  'usage: differ-cli <fixtures-module> [--budget N]… [--fixture NAME]… [--out FILE] [--title T]';

/** The differ's command line, parsed. */
export interface DifferArgs {
  readonly modulePath: string;
  /** Every `--budget`, in order; empty for each fixture's own (default 1, 2 and 4). */
  readonly budgets: readonly number[];
  /** Every `--fixture`; empty for all of them. */
  readonly only: readonly string[];
  /** `--out`; `undefined` for stdout. */
  readonly out: string | undefined;
  readonly title: string;
}

/** A command line that cannot run: `usage` is what goes to stderr before exit 2. */
export interface DifferUsageError {
  readonly usage: string;
}

/** Parse `argv`; a flag error, a missing fixtures module or a bad budget is a usage error. */
export function parseDifferArgs(argv: readonly string[]): DifferArgs | DifferUsageError {
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
    return { usage: `${e.message}\n${DIFFER_USAGE}\n` };
  }
  if (modulePath === undefined) return { usage: `${DIFFER_USAGE}\n` };
  if (budgets.some((b) => !Number.isInteger(b) || b < 1)) {
    return { usage: `--budget must be a positive integer\n${DIFFER_USAGE}\n` };
  }
  return { modulePath, budgets, only, out, title };
}
