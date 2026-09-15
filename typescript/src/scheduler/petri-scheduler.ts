/**
 * `PetriScheduler`: the `WorkflowScheduler` (patch 0001) that runs one execution on the
 * compiled net instead of n8n's stack loop.
 *
 * Per `run(host, workflow, runExecutionData, hooks)`:
 * 1. `workflow.settings.executionOrder !== 'v1'` → the legacy `StackScheduler` (v0's
 *    ancestor forcing is out of scope, divergence #3); its `executionError` /
 *    `closeFunction` are copied over.
 * 2. The n8n `Workflow` is adapted (`src/n8n/adapter.ts`) and compiled once per
 *    `(structural hash, budget)` with the actions bound (`schedulerActions`); the
 *    `CompiledWorkflow` — net, program, actions — is cached in a small LRU. The hash is
 *    computed from the structural analysis alone, so a cache hit never builds a net.
 * 3. The initial marking is decoded from `runExecutionData.executionData` (the marking
 *    codec); the stack entries it decoded are popped through the host, as n8n pops what it
 *    runs, so the host's own `pushExecutionStack` on a stop error lands on an empty stack.
 * 4. `PrecompiledNetExecutor` runs to quiescence (EXEC-040) — never `run(timeoutMs)`;
 *    `host.abortSignal` → `executor.close()` (ENV-013) is the only cancellation. Per-execution
 *    state reaches the actions through `executionContextProvider` under `ENV_KEY`.
 * 5. After quiescence the marking is classified and written back (`finish`, in
 *    `write-back.ts`), in this order:
 *    - a halt (`_halt`, which nothing consumes): n8n's `handleNodeExecutionError` pushed the
 *      failed entry and its loop `break`s, leaving every entry it had not popped on the
 *      stack, so the activations still resting in the marking are encoded back after it —
 *      that stack is what "Retry execution" replays;
 *    - `_pause` / `X/waiting` / `X/stopped` → `encodeMarking` rewrites `executionData` so
 *      n8n saves and resumes it. After a destination-node stop the entries the run filter
 *      excludes are dropped through `host.isNodeFilteredOut`, the predicate n8n's loop
 *      applies when it pops them (`stack-scheduler.ts` lines 74–76); a Wait leaves the
 *      stack as it is, as n8n's `break` does. A cancellation racing the pause switches the
 *      mode to `cancelled`: `close()` (ENV-013) is what leaves the tokens between `X_run`
 *      and `X_route` that only that mode can encode;
 *    - a cancellation → mode `cancelled` (the pending entries go back on the stack, as n8n
 *      leaves them);
 *    - natural quiescence → mode `stranded`: every leftover in / ready / hasdata token
 *      becomes one of n8n's own stuck slots with a diagnostic (divergence #2), and the
 *      stack is emptied as n8n's is.
 *    Nothing else of `runExecutionData` is touched: n8n owns it.
 * 6. A fatal error (something the mirrored loop would have thrown out of `run()`, e.g. a
 *    hook rejecting) rejects `run()` exactly as n8n's does — after the net quiesced and the
 *    pending state was written back, which is the state n8n's loop leaves behind.
 */
import type { ExecutionBaseError, IRunExecutionData, Workflow } from 'n8n-workflow';
import type { CompiledWorkflow, WorkflowDescription } from '../compiler/index.js';
import { describeWorkflow } from '../n8n/adapter.js';
import type { SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import type { ExecutionEnv, SchedulerState } from './actions.js';
import { CompiledWorkflowCache } from './cache.js';
import { budgetLowered, compileCached } from './compile-step.js';
import { runLegacy } from './legacy.js';
import { quiesce } from './quiescence.js';
import { initialState, resetState } from './run-state.js';
import type { PetriSchedulerOptions, SchedulerOutcome } from './scheduler-types.js';
import { finish } from './write-back.js';

export type { PetriSchedulerOptions, SchedulerOutcome } from './scheduler-types.js';

export class PetriScheduler implements WorkflowScheduler {
  private readonly state: SchedulerState = initialState();
  private readonly cache: CompiledWorkflowCache;
  /** Diagnostics of the last `run()`, in order. */
  readonly diagnostics: string[] = [];
  /** The compiled workflow of the last `run()` (for tests and tooling). */
  compiled: CompiledWorkflow | undefined;
  /** How the last `run()` ended. */
  outcome: SchedulerOutcome | undefined;

  /**
   * The most node runs (`X_run` actions, i.e. `host.runNode` calls) that were ever in flight
   * at once during the last `run()` — README "Concurrency". Bounded by the effective budget
   * k, because every such activation holds a `_budget` unit. It is a **lower bound** on the
   * `_budget + Σ_X(running + retry + in-flight) = k` semiflow rather than a reading of it: a node
   * waiting between retries and one recording an exhausted attempt each hold their unit
   * without running anything, so the tokens in flight can exceed this number.
   */
  get maxInFlight(): number {
    return this.state.maxInFlight;
  }

  constructor(private readonly options: PetriSchedulerOptions) {
    this.cache = options.cache ?? new CompiledWorkflowCache();
  }

  /**
   * The contract value patch 0001 documents as "the error of the node that stopped the
   * execution": the halt error if one activation ended the execution, otherwise what the
   * last activation to complete left in n8n's per-iteration field. Above k = 1 the halt wins
   * over every later completion, so a sibling that fails, retries or starts after the halt
   * can no longer erase it (see {@link SchedulerState.haltError}).
   */
  get executionError(): ExecutionBaseError | undefined {
    return this.state.haltError ?? this.state.leftoverError;
  }

  get closeFunction(): Promise<void> | undefined {
    return this.state.closeFunction;
  }

  get budget(): number {
    return this.options.budget ?? 1;
  }

  private diagnostic(message: string): void {
    this.diagnostics.push(message);
    this.options.onDiagnostic?.(message);
  }

  /**
   * Compile once per `(structural hash, budget)` with the actions bound; cached. The hash
   * is a function of the analysis, which is cheap; the net and its program are built only
   * on a miss, and the program itself compiles lazily on first access (CONC-020). The
   * analysis and the hash are computed once per call, for the key, and a miss compiles on
   * both rather than analysing and hashing the description again.
   */
  compileDescription(description: WorkflowDescription): CompiledWorkflow {
    return compileCached(this.cache, description, this.budget, this.options);
  }

  /** Everything a `run()` leaves behind is reset here (see {@link resetState}). */
  private reset(runExecutionData: IRunExecutionData): void {
    this.diagnostics.length = 0;
    this.compiled = undefined;
    this.outcome = undefined;
    resetState(this.state, runExecutionData.waitTill);
  }

  /** Step 2: the workflow adapted and compiled, and the compiler's findings reported. */
  private compileWorkflow(host: SchedulerHost, workflow: Workflow, runExecutionData: IRunExecutionData): CompiledWorkflow {
    const description = describeWorkflow(workflow, runExecutionData, { nodeHelpers: this.options.nodeHelpers, mode: host.mode });
    const compiled = this.compileDescription(description);
    this.compiled = compiled;
    for (const d of compiled.diagnostics) this.diagnostic(`compile: ${d}`);
    const lowered = budgetLowered(compiled);
    if (lowered !== undefined) this.diagnostic(lowered);
    return compiled;
  }

  async run(
    host: SchedulerHost,
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
    hooks: SchedulerHooks,
  ): Promise<void> {
    this.reset(runExecutionData);
    if (workflow.settings.executionOrder !== 'v1') {
      this.outcome = 'legacy';
      await runLegacy(this.options.legacy(), this.state, host, workflow, runExecutionData, hooks);
      return;
    }

    const executionData = runExecutionData.executionData;
    if (executionData === undefined || !host.isExecutionStackNotEmpty()) {
      // `executionLoop: while (host.isExecutionStackNotEmpty())` never enters.
      this.outcome = 'nothing-to-run';
      return;
    }

    const compiled = this.compileWorkflow(host, workflow, runExecutionData);
    const diagnostic = (m: string): void => this.diagnostic(m);
    const env: ExecutionEnv = { host, workflow, runExecutionData, hooks, state: this.state, diagnostic };
    const { marking, cancelled } = await quiesce(compiled, executionData, env, this.options.eventStore);

    const fatal = this.state.fatal;
    this.state.fatal = undefined;
    this.outcome = finish({ compiled, marking, executionData, host, workflow, cancelled, diagnostic });
    if (fatal !== undefined) {
      // The mirrored loop would have rejected `run()` mid-way; the action took the halt (or,
      // for a node whose `onError` gives `X_run` no halt branch, the stopped) alternative so
      // the net quiesced and the pending state was written back first.
      this.outcome = 'fatal';
      throw fatal;
    }
  }
}
