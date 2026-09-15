/**
 * The flag parser the command lines share, and the error that means "exit 2 with the usage
 * line".
 *
 * Deliberately small: every word is handled in order, a value flag takes the next word
 * whatever it looks like (`--out --json` writes to a file named `--json`), a word starting
 * with `--` that no handler names is an unknown option, and every other word is positional.
 * Validation stays in the handlers, so the first bad word on the line is the one reported.
 */

/** A bad flag, a missing value or a wrong argument count: exit 2, with the usage line. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** What {@link parseFlags} does with each word of the command line. */
export interface FlagSpec {
  /** Flags that take the next word as their value. A handler may throw {@link UsageError}. */
  readonly values?: Readonly<Record<string, (value: string) => void>>;
  /** Flags that take no value. */
  readonly switches?: Readonly<Record<string, () => void>>;
  /** Every word that is not a flag, in order. A handler may throw {@link UsageError}. */
  readonly positional: (word: string) => void;
}

/**
 * Walks `argv` (without `node` and the script) through `spec`. Throws {@link UsageError}
 * on an unknown `--` option or a value flag at the end of the line, and passes on whatever
 * a handler throws.
 */
export function parseFlags(argv: readonly string[], spec: FlagSpec): void {
  const values = spec.values ?? {};
  const switches = spec.switches ?? {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    // Own keys only: `toString` or `constructor` on the line is a positional, not a handler
    // inherited from Object.prototype.
    if (Object.hasOwn(values, word)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${word} needs a value`);
      values[word]!(value);
    } else if (Object.hasOwn(switches, word)) {
      switches[word]!();
    } else if (word.startsWith('--')) {
      throw new UsageError(`unknown option ${word}`);
    } else {
      spec.positional(word);
    }
  }
}
