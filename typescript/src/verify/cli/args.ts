/**
 * The verify command line's words → {@link ParsedArgs}. The flags and what they mean are
 * listed in `verify/cli.ts`'s module doc; each value flag's word is checked in `flag-values.ts`.
 */
import { parseFlags, UsageError } from '../../cli/flags.js';
import { PROPERTY_NAMES } from '../types.js';
import type { CompileProfile } from '../../compiler/index.js';
import type { PropertyName, SmtFallbackMode, VerifyOptions } from '../types.js';
import { budgetOf, maxClassesOf, mutexPairOf, profileOf, propertyOf, smtFallbackOf, timeoutOf } from './flag-values.js';

export const USAGE =
  'usage: n8n-libpetri verify <workflow.json> [--profile v1|engineV2] [--budget k] [--property NAME]...\n' +
  '                          [--timeout ms]\n' +
  '                          [--max-classes n] [--smt-fallback auto|off|force] [--node-types FILE]\n' +
  '                          [--start NODE] [--trigger NODE] [--mutex A,B]... [--all-pairs] [--no-semiflows]\n' +
  '                          [--strict] [--json] [--out FILE] [--quiet]\n' +
  `  properties: ${PROPERTY_NAMES.join(', ')}\n` +
  '  exit: 0 clean, 1 violation (or unknown/bounded under --strict), 2 usage, 3 no usable z3';

/** What {@link parseArgs} read off the command line. */
export interface ParsedArgs {
  readonly file: string;
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
  profile?: CompileProfile;
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

/** The {@link VerifyOptions} the flags ask for; an unset flag leaves `verify()` its default. */
function optionsOf(f: Flags): VerifyOptions {
  const mutualExclusion = f.allPairs ? 'all-pairs' as const : f.pairs.length > 0 ? f.pairs : undefined;
  // No `--property` means "the defaults", which `selectProperties` widens with
  // mutual exclusion when a pair was named.
  const selected = f.properties.length > 0 ? f.properties : undefined;
  return {
    ...(f.profile === undefined ? {} : { profile: f.profile }),
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
  // Under engineV2 the start is the trigger that fired, which n8n's converter is handed by name.
  if (f.trigger !== undefined && f.profile !== 'engineV2') {
    throw new UsageError('--trigger names the fired trigger of --profile engineV2; a v1 run starts from --start');
  }
  if (f.startNode !== undefined && f.profile === 'engineV2') {
    throw new UsageError('--start is the v1 start node; under --profile engineV2 name the fired trigger with --trigger');
  }
  return {
    file: f.files[0]!,
    options: optionsOf(f),
    nodeTypesFile: f.nodeTypesFile,
    startNode: f.startNode,
    json: f.json,
    out: f.out,
    quiet: f.quiet,
    strict: f.strict,
  };
}
