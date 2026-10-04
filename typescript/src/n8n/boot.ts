/**
 * Registers `PetriScheduler` in a running n8n process from its environment — the one boot path
 * both registering loaders share (`tasks/inject-plan.md` decisions 7 and 8):
 *
 * - `hook/n8n-preload.mjs`, the `--import` preload an installed n8n carries in `NODE_OPTIONS`
 *   ({@link preloadFromEnv}); and
 * - `scripts/testbed/preload.mjs`, the `--import` preload of the source-built testbed
 *   ({@link bootFromEnv}).
 *
 * `hook/n8n-hook.cjs`, the `EXTERNAL_HOOK_FILES` entry, registers nothing: it only calls
 * {@link confirmBooted}. Keeping the env parsing and the seam check here means the loaders
 * cannot drift.
 *
 * **Registered before n8n runs anything** (divergence row 40). n8n `start` arms the
 * `WaitTracker`, which resumes executions that went overdue while n8n was down, before it loads
 * hook files, so a scheduler registered from the hook file can come too late for them. The
 * preload runs before n8n's entry module, so nothing of n8n has run when it registers; that
 * order is Node's, not a race. The hook file then only confirms ({@link confirmBooted}): with
 * the engine requested and no preload registration it refuses to start n8n.
 *
 * **Activation** is `N8N_EXECUTION_ENGINE`: unset or empty does nothing; `libpetri` registers
 * the scheduler; any other value throws, so a typo cannot silently run n8n's own loop under a
 * setting that claims otherwise. Stock n8n reads no such variable.
 *
 * **No fallback.** Everything below throws rather than continuing: an n8n-core without patch
 * 0002's `setWorkflowSchedulerFactory`, or one whose patched files no longer hash to what the
 * installer wrote, or a bad knob. n8n's `ExternalHooks.init` turns the throw into a refusal to
 * start, which is the point: a process that quietly ran the stack loop while its operator
 * believed it ran the net is worse than one that does not boot.
 *
 * **Same module instance.** `n8n-core` and `n8n-workflow` are resolved with `createRequire` from
 * n8n's own entry file, so the registry written here is the one n8n's `WorkflowExecute` reads:
 * Node resolves symlinks (npm, pnpm, Docker) to one realpath, one CJS instance.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { driftedFiles, readJournal, readRecord } from '../install/record.js';
import { registerPetriScheduler, type PetriSchedulerRegistration } from '../scheduler/register.js';
import type { NodeHelpersLike, SetWorkflowSchedulerFactory, WorkflowScheduler } from './host.js';

export const ENGINE_ENV = 'N8N_EXECUTION_ENGINE';
export const ENGINE_VALUE = 'libpetri';
/** Overrides where `n8n-core` is resolved from: a file inside n8n's package (testbed: `packages/cli/package.json`). */
export const RESOLVE_FROM_ENV = 'N8N_LIBPETRI_RESOLVE_FROM';
export const KNOB_ENV = {
  budget: 'N8N_LIBPETRI_BUDGET',
  maxAgentRounds: 'N8N_LIBPETRI_MAX_AGENT_ROUNDS',
  maxAgentToolCalls: 'N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS',
} as const;
/** The prefix of every line this package writes to n8n's stderr; the launchers grep it. */
export const LOG_PREFIX = '[n8n-libpetri]';
/** The boot line. A registered engine is not an entered one: `ENGINE_ENTERED_DIAGNOSTIC` is the second claim. */
export const REGISTERED_LINE = 'scheduler registered';

/** A refusal to boot, with the sentence that says how to fix it. */
export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

export interface BootOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * A file inside n8n's package to resolve `n8n-core` from. Default: `N8N_LIBPETRI_RESOLVE_FROM`,
   * then the realpath of `process.argv[1]` (n8n's `bin/n8n`), then {@link mainFilename}.
   */
  readonly resolveFrom?: string;
  /** `require.main.filename` as the CJS hook sees it; the last resort for {@link resolveFrom}. */
  readonly mainFilename?: string;
  /** Where the diagnostics go. Default: stderr, one `[n8n-libpetri] …` line each. */
  readonly onDiagnostic?: (message: string) => void;
  /** What the boot line names as the loader (`loader=…`). */
  readonly loader?: string;
}

export interface Knobs {
  readonly budget: number;
  readonly maxAgentRounds: number | undefined;
  readonly maxAgentToolCalls: number | undefined;
}

export type BootResult =
  | { readonly status: 'inert' }
  | {
      readonly status: 'registered';
      readonly coreDir: string;
      readonly coreVersion: string;
      readonly knobs: Knobs;
      readonly installed: boolean;
      readonly registration: PetriSchedulerRegistration;
    };

/** The parts of `n8n-core` the boot path reads. */
interface CoreModule {
  readonly setWorkflowSchedulerFactory?: SetWorkflowSchedulerFactory;
  readonly getWorkflowSchedulerFactory?: () => unknown;
  readonly StackScheduler?: new () => WorkflowScheduler;
}

/**
 * What a registration leaves in the process for {@link confirmBooted}. Kept on `globalThis`
 * under a registered symbol, not in a module variable, so the CommonJS hook and the ESM preload
 * see one record whichever way each loaded this module.
 */
interface BootRecord {
  readonly loader: string | undefined;
  readonly coreDir: string;
  readonly factory: unknown;
  readonly currentFactory: (() => unknown) | undefined;
}

const BOOT_RECORD = Symbol.for('n8n-libpetri.boot');

const bootRecord = (): BootRecord | undefined => (globalThis as Record<symbol, BootRecord | undefined>)[BOOT_RECORD];

const stderrDiagnostic = (message: string): void => {
  // stderr, not console: n8n installs its own logger over the console early in boot.
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
};

/** Whether `N8N_EXECUTION_ENGINE` asks for the engine. Throws {@link BootError} on any other value. */
export function engineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ENGINE_ENV];
  if (value === undefined || value === '') return false;
  if (value === ENGINE_VALUE) return true;
  throw new BootError(`${ENGINE_ENV} must be '${ENGINE_VALUE}' or unset, got '${value}'`);
}

/** The three knobs, validated. Throws {@link BootError} on a value that is not a positive integer. */
export function readKnobs(env: NodeJS.ProcessEnv = process.env): Knobs {
  const integer = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
      throw new BootError(`${name} must be a positive integer, got '${raw}'`);
    }
    return value;
  };
  return {
    budget: integer(KNOB_ENV.budget) ?? 1,
    maxAgentRounds: integer(KNOB_ENV.maxAgentRounds),
    maxAgentToolCalls: integer(KNOB_ENV.maxAgentToolCalls),
  };
}

/** Where `n8n-core` is resolved from, in the documented order. */
export function resolveFromPath(options: BootOptions, env: NodeJS.ProcessEnv): string {
  const explicit = options.resolveFrom ?? env[RESOLVE_FROM_ENV];
  if (explicit !== undefined && explicit !== '') return explicit;
  const entry = process.argv[1];
  if (entry !== undefined && entry !== '') {
    try {
      return realpathSync(entry);
    } catch {
      // fall through to require.main
    }
  }
  if (options.mainFilename !== undefined) return options.mainFilename;
  throw new BootError(`cannot tell where n8n is installed; set ${RESOLVE_FROM_ENV} to a file inside n8n's package`);
}

/**
 * Reads the environment and, when it asks for the engine, registers `PetriScheduler` with the
 * n8n-core n8n itself loads. Returns what it did; throws {@link BootError} instead of falling back.
 */
export function bootFromEnv(options: BootOptions = {}): BootResult {
  const env = options.env ?? process.env;
  if (!engineRequested(env)) return { status: 'inert' };
  const knobs = readKnobs(env);
  const onDiagnostic = options.onDiagnostic ?? stderrDiagnostic;

  const from = resolveFromPath(options, env);
  const req = createRequire(from);
  let corePackage: string;
  try {
    corePackage = realpathSync(req.resolve('n8n-core/package.json'));
  } catch (e) {
    throw new BootError(`cannot resolve n8n-core from ${from}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const coreDir = dirname(corePackage);
  const coreVersion = (req(corePackage) as { version?: string }).version ?? 'unknown';
  const core = req('n8n-core') as CoreModule;
  const { NodeHelpers } = req('n8n-workflow') as { NodeHelpers?: NodeHelpersLike };

  // Patch 0002's seam. Without it n8n would run its own loop under our name.
  if (typeof core.setWorkflowSchedulerFactory !== 'function' || typeof core.StackScheduler !== 'function') {
    throw new BootError(
      `n8n-core ${coreVersion} at ${coreDir} has no scheduler seam (setWorkflowSchedulerFactory); run \`n8n-libpetri install\``,
    );
  }
  if (NodeHelpers === undefined) throw new BootError(`n8n-workflow resolved from ${from} exports no NodeHelpers`);

  // A partial install, or a file changed after install. No record is a source build (the
  // testbed's `.n8n`) or an orphaned seam; both carry the seam checked above.
  const record = readRecord(coreDir);
  if (record === null && readJournal(coreDir) !== null) {
    // An install or uninstall that stopped midway: some files are patched, some stock.
    throw new BootError(`n8n-core ${coreVersion} at ${coreDir} is part way through an n8n-libpetri install or uninstall; run \`n8n-libpetri uninstall\``);
  }
  if (record !== null) {
    const drifted = driftedFiles(coreDir, record);
    if (drifted.length > 0) {
      throw new BootError(
        `n8n-core ${coreVersion} at ${coreDir} no longer matches its n8n-libpetri install record ` +
          `(${drifted.map((d) => d.path).join(', ')}); run \`n8n-libpetri status\``,
      );
    }
  }

  const registration = registerPetriScheduler({
    setWorkflowSchedulerFactory: core.setWorkflowSchedulerFactory,
    StackScheduler: core.StackScheduler,
    nodeHelpers: NodeHelpers,
    budget: knobs.budget,
    ...(knobs.maxAgentRounds === undefined ? {} : { maxAgentRounds: knobs.maxAgentRounds }),
    ...(knobs.maxAgentToolCalls === undefined ? {} : { maxAgentToolCalls: knobs.maxAgentToolCalls }),
    onDiagnostic,
  });
  const getFactory = core.getWorkflowSchedulerFactory;
  (globalThis as Record<symbol, BootRecord | undefined>)[BOOT_RECORD] = {
    loader: options.loader,
    coreDir,
    factory: registration.factory,
    currentFactory: typeof getFactory === 'function' ? () => getFactory() : undefined,
  };
  onDiagnostic(
    `${REGISTERED_LINE}: budget=${knobs.budget}, n8n-core=${coreVersion}` +
      `${record === null ? '' : ' (installed)'}${options.loader === undefined ? '' : `, loader=${options.loader}`}`,
  );
  return { status: 'registered', coreDir, coreVersion, knobs, installed: record !== null, registration };
}

export type PreloadResult = BootResult | { readonly status: 'not-n8n' };

export interface PreloadOptions extends BootOptions {
  /** The process's entry script; default `process.argv[1]`. */
  readonly entry?: string;
  /** Whether this is the main thread; the preload passes `worker_threads.isMainThread`. */
  readonly isMainThread: boolean;
}

/**
 * The realpath of `entry` when it is n8n's own command: the nearest `package.json` above that
 * realpath is named `n8n` (`bin/n8n` of an npm, pnpm, Docker or source install). Otherwise
 * `undefined`. A preload sees `process.argv[1]` before Node resolves the main module, so on a
 * global install it is still the `bin` symlink (`/usr/local/bin/n8n`), from which n8n-core does
 * not resolve; the realpath is n8n's own file.
 */
export function n8nEntry(entry: string | undefined): string | undefined {
  if (entry === undefined || entry === '') return undefined;
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    return undefined;
  }
  for (let dir = dirname(real); ; ) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === 'n8n' ? real : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The `--import` preload's boot (`hook/n8n-preload.mjs`). `NODE_OPTIONS` reaches every Node
 * process the environment does, so the preload registers only in n8n's own command on its main
 * thread: a script an Execute Command node starts, or a worker thread, is `not-n8n` and left
 * alone. n8n's task runners get neither variable (n8n passes them an allowlisted environment).
 *
 * The process is told before the value is checked, so a mistyped `N8N_EXECUTION_ENGINE` refuses
 * only n8n's own command and leaves every other process (`n8n-libpetri status`, npm) running.
 *
 * `N8N_LIBPETRI_RESOLVE_FROM`, when set, overrides the entry check: for a launcher whose
 * `argv[1]` is not n8n's `bin` (a process manager's fork wrapper), the main thread counts as
 * n8n and `n8n-core` is resolved from that file. It then applies to every main thread that
 * inherits the variable, so set it only in n8n's own environment.
 *
 * Throws {@link BootError} like {@link bootFromEnv}; thrown from a preload, n8n never starts.
 */
export function preloadFromEnv(options: PreloadOptions): PreloadResult {
  const env = options.env ?? process.env;
  const value = env[ENGINE_ENV];
  if (value === undefined || value === '') return { status: 'inert' };
  if (!options.isMainThread) return { status: 'not-n8n' };
  const override = env[RESOLVE_FROM_ENV];
  const from = override !== undefined && override !== '' ? override : n8nEntry(options.entry ?? process.argv[1]);
  if (from === undefined) return { status: 'not-n8n' };
  // bootFromEnv validates the value: a typo throws here, in n8n's own command only.
  return bootFromEnv({ ...options, resolveFrom: options.resolveFrom ?? from });
}

/** The line the hook writes when it finds the preload's registration in place. */
export const CONFIRMED_LINE = 'hook confirmed the preload registration';

/**
 * The hook file's check (`hook/n8n-hook.cjs`). By the time n8n loads hook files it may already
 * have resumed an overdue wait (row 40), so the hook does not register: it requires that the
 * preload did, and that n8n-core's registry still holds that factory. Otherwise it throws
 * {@link BootError}, which stops n8n.
 */
export function confirmBooted(options: { readonly env?: NodeJS.ProcessEnv; readonly onDiagnostic?: (message: string) => void } = {}): BootResult['status'] {
  const env = options.env ?? process.env;
  if (!engineRequested(env)) return 'inert';
  const record = bootRecord();
  if (record === undefined) {
    throw new BootError(
      `${ENGINE_ENV}=${ENGINE_VALUE} but no scheduler was registered before n8n started; add ` +
        '--import=<n8n-libpetri>/hook/n8n-preload.mjs to NODE_OPTIONS (`n8n-libpetri env` prints it). ' +
        'The hook file alone loads too late: n8n can resume an overdue wait before it loads hook files',
    );
  }
  if (record.currentFactory !== undefined && record.currentFactory() !== record.factory) {
    throw new BootError(`the scheduler registered at boot in n8n-core at ${record.coreDir} was replaced before n8n loaded its hook files`);
  }
  (options.onDiagnostic ?? stderrDiagnostic)(`${CONFIRMED_LINE}${record.loader === undefined ? '' : ` (${record.loader})`}`);
  return 'registered';
}
