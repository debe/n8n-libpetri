/**
 * The verify command line's words → {@link ParsedArgs}. The flags and what they mean are
 * listed in `verify/cli.ts`'s module doc; each value flag's word is checked in `flag-values.ts`.
 */
import { parseFlags, UsageError } from '../../cli/flags.js';
import { PROPERTY_NAMES } from '../types.js';
import type { CompileProfile } from '../../compiler/index.js';
import type { PropertyName, SmtFallbackMode, VerifyOptions } from '../types.js';
import type { ProfileChoice } from '../workflow-json.js';
import { budgetOf, maxClassesOf, mutexPairOf, profileOf, propertyOf, smtFallbackOf, timeoutOf } from './flag-values.js';

export const USAGE =
  'usage: n8n-libpetri verify <workflow.json> [--profile auto|v1|engineV2] [--budget k] [--property NAME]...\n' +
  '                          [--timeout ms]\n' +
  '                          [--max-classes n] [--smt-fallback auto|off|force] [--node-types FILE]\n' +
  '                          [--start NODE] [--trigger NODE] [--mutex A,B]... [--all-pairs] [--no-semiflows]\n' +
  '                          [--strict] [--json] [--out FILE] [--quiet]\n' +
  "  profile: auto by default, read off the workflow as n8n does: settings.engineType 'v2' is engineV2, anything else v1\n" +
  '           --budget, --start, --mutex, --all-pairs and the v1 families need v1; --trigger needs engineV2\n' +
  `  properties: ${PROPERTY_NAMES.join(', ')}\n` +
  '  exit: 0 clean, 1 violation (or unknown/bounded under --strict), 2 usage, 3 no usable z3 (v1) or no check decided (engineV2)';

/** What {@link parseArgs} read off the command line. */
export interface ParsedArgs {
  readonly file: string;
  /**
   * The profile asked for: one named, or `'auto'` (the default), which only the workflow
   * itself can resolve. {@link withProfile} resolves it and checks the profile's flags.
   */
  readonly profile: ProfileChoice;
  /** The options for `verify()`; `profile` is set once it is known, named or resolved. */
  readonly options: VerifyOptions;
  readonly nodeTypesFile: string | null;
  readonly startNode: string | undefined;
  readonly json: boolean;
  readonly out: string | null;
  readonly quiet: boolean;
  readonly strict: boolean;
}

/** What the words read so far have set; every field starts at its default. */
interface Flags {
  readonly files: string[];
  readonly properties: PropertyName[];
  readonly pairs: Array<readonly [string, string]>;
  profile?: ProfileChoice;
  budget?: number;
  timeoutMs?: number;
  maxClasses?: number;
  smtFallback?: SmtFallbackMode;
  nodeTypesFile: string | null;
  startNode?: string;
  trigger?: string;
  allPairs: boolean;
  semiflows: boolean;
  json: boolean;
  out: string | null;
  quiet: boolean;
  strict: boolean;
}

/**
 * The {@link VerifyOptions} the flags ask for; an unset flag leaves `verify()` its default,
 * except the profile, which is always stated once known: a named one here, `auto` by
 * {@link withProfile} once the workflow is read, so the description and the compile read the
 * same one and the report states it.
 */
function optionsOf(f: Flags, profile: CompileProfile | undefined): VerifyOptions {
  const mutualExclusion = f.allPairs ? 'all-pairs' as const : f.pairs.length > 0 ? f.pairs : undefined;
  // No `--property` means "the defaults", which `selectProperties` widens with
  // mutual exclusion when a pair was named.
  const selected = f.properties.length > 0 ? f.properties : undefined;
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(f.trigger === undefined ? {} : { trigger: f.trigger }),
    ...(f.budget === undefined ? {} : { budget: f.budget }),
    ...(f.timeoutMs === undefined ? {} : { timeoutMs: f.timeoutMs }),
    ...(f.maxClasses === undefined ? {} : { maxClasses: f.maxClasses }),
    ...(f.smtFallback === undefined ? {} : { smtFallback: f.smtFallback }),
    ...(selected === undefined ? {} : { properties: selected }),
    ...(mutualExclusion === undefined ? {} : { mutualExclusion }),
    semiflowInvariants: f.semiflows,
  };
}

/** Parses `argv` (without `node` and the script). Throws {@link UsageError} on a bad flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv[0] === 'verify' ? argv.slice(1) : argv;
  const f: Flags = {
    files: [], properties: [], pairs: [], nodeTypesFile: null,
    allPairs: false, semiflows: true, json: false, out: null, quiet: false, strict: false,
  };
  parseFlags(args, {
    values: {
      '--profile': (v) => { f.profile = profileOf(v); },
      '--budget': (v) => { f.budget = budgetOf(v); },
      '--timeout': (v) => { f.timeoutMs = timeoutOf(v); },
      '--property': (name) => { f.properties.push(propertyOf(name)); },
      '--max-classes': (v) => { f.maxClasses = maxClassesOf(v); },
      '--smt-fallback': (mode) => { f.smtFallback = smtFallbackOf(mode); },
      '--node-types': (v) => { f.nodeTypesFile = v; },
      '--start': (v) => { f.startNode = v; },
      '--trigger': (v) => { f.trigger = v; },
      '--mutex': (v) => { f.pairs.push(mutexPairOf(v)); },
      '--out': (v) => { f.out = v; },
    },
    switches: {
      '--all-pairs': () => { f.allPairs = true; },
      '--no-semiflows': () => { f.semiflows = false; },
      '--strict': () => { f.strict = true; },
      '--json': () => { f.json = true; },
      '--quiet': () => { f.quiet = true; },
    },
    positional: (word) => { f.files.push(word); },
  });
  if (f.files.length !== 1) throw new UsageError('exactly one workflow file is required');
  const choice = f.profile ?? 'auto';
  const parsed: ParsedArgs = {
    file: f.files[0]!,
    profile: choice,
    options: optionsOf(f, choice === 'auto' ? undefined : choice),
    nodeTypesFile: f.nodeTypesFile,
    startNode: f.startNode,
    json: f.json,
    out: f.out,
    quiet: f.quiet,
    strict: f.strict,
  };
  // A named profile's flags are checked now; `auto`'s once the workflow says which it is.
  if (choice !== 'auto') checkProfileFlags(parsed, choice, '');
  return parsed;
}

/**
 * `parsed` with its profile resolved to `profile` — `auto` read off the workflow, or the one
 * named — after checking the flags that exist under one profile only. Throws
 * {@link UsageError}; under `auto` the message says what the workflow set, since the fix may be
 * the flag or the workflow.
 */
export function withProfile(parsed: ParsedArgs, profile: CompileProfile): ParsedArgs {
  const why = parsed.profile !== 'auto' ? ''
    : profile === 'engineV2'
      ? " (--profile auto: the workflow sets settings.engineType 'v2')"
      : " (--profile auto: the workflow does not set settings.engineType 'v2')";
  checkProfileFlags(parsed, profile, why);
  return { ...parsed, options: { ...parsed.options, profile } };
}

/** Refuses each flag that `profile` does not have, naming the profile that does; `why` is appended. */
function checkProfileFlags(parsed: ParsedArgs, profile: CompileProfile, why: string): void {
  const { options, startNode } = parsed;
  // Under engineV2 the start is the trigger that fired, which n8n's converter is handed by name.
  if (options.trigger !== undefined && profile !== 'engineV2') {
    throw new UsageError(`--trigger names the fired trigger of --profile engineV2; a v1 run starts from --start${why}`);
  }
  if (startNode !== undefined && profile === 'engineV2') {
    throw new UsageError(
      `--start is the v1 start node; under --profile engineV2 name the fired trigger with --trigger, or pass --profile v1${why}`);
  }
  // The compiler refuses a budget under engineV2 as well; refused here first, because the fix is
  // a flag, not the workflow.
  if (options.budget !== undefined && profile === 'engineV2') {
    throw new UsageError(`--budget is the v1 concurrency budget and engine v2 has none; pass --profile v1 to use it${why}`);
  }
  // The same for the v1 mutual-exclusion pairs: `selectProperties` would add the family, which is
  // not ported to engineV2, so the check would be recorded not applicable and, without --strict,
  // the run would exit 0 having checked nothing it was asked to.
  const exclusion = options.mutualExclusion;
  if (exclusion !== undefined && profile === 'engineV2') {
    const flag = exclusion === 'all-pairs' ? '--all-pairs' : '--mutex';
    throw new UsageError(
      `${flag} asks the v1 mutual-exclusion family, which is not ported to engine v2; pass --profile v1 to use it${why}`);
  }
}
