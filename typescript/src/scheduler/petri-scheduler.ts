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
 * 5. After quiescence the marking is classified and written back (`finish`), in this order:
 *    - a halt (`_halt` / `_halted`): n8n's `handleNodeExecutionError` pushed the failed
 *      entry and its loop `break`s, leaving every entry it had not popped on the stack, so
 *      the activations `_halt_reap` cleared (snapshotted when the halt branch was written)
 *      are encoded back after it — that stack is what "Retry execution" replays;
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
import { Marking, PrecompiledNetExecutor, type EventStore, type Place, type Token } from 'libpetri';
import type { ExecutionBaseError, IRunExecutionData, Workflow } from 'n8n-workflow';
import { decodeExecutionData, encodeMarking, type EncodeMode } from '../codec.js';
import {
  analyse, compile, structuralHash, type CompiledWorkflow, type PlaceRole, type WorkflowDescription,
} from '../compiler/index.js';
import { describeWorkflow } from '../n8n/adapter.js';
import type {
  ExecutionDataState, NodeHelpersLike, SchedulerHooks, SchedulerHost, WorkflowScheduler,
} from '../n8n/host.js';
import { ENV_KEY, schedulerActions, type ExecutionEnv, type SchedulerState } from './actions.js';
import { CompiledWorkflowCache } from './cache.js';
import type { StoppedPayload } from './payloads.js';

export interface PetriSchedulerOptions {
  /** `NodeHelpers` from `n8n-workflow` (injected; not a runtime dependency). */
  readonly nodeHelpers: NodeHelpersLike;
  /** Creates the legacy `StackScheduler` a non-v1 workflow is delegated to. */
  readonly legacy: () => WorkflowScheduler;
  /** Concurrency budget `k` (`_budget` tokens). Default 1 (sequential n8n). */
  readonly budget?: number;
  /** Compiled-workflow LRU shared across executions. A private one when omitted. */
  readonly cache?: CompiledWorkflowCache;
  /** libpetri event store attached to every execution (`InMemoryEventStore` for tests). */
  readonly eventStore?: EventStore;
  /** Receives the compiler's and the codec's diagnostics, and the scheduler's own. */
  readonly onDiagnostic?: (message: string) => void;
}

/** How a `run()` ended. `fatal`: it rejected, as n8n's loop would have. */
export type SchedulerOutcome =
  | 'legacy' | 'nothing-to-run' | 'completed' | 'paused' | 'cancelled' | 'halted' | 'stranded' | 'fatal';

/**
 * The places `_halt_reap` clears with reset arcs (`compile.ts`, README "Retries, halt,
 * cancellation"): everything a pending activation can sit on before it starts.
 */
const REAPED_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'in-data', 'in-empty', 'edge-data', 'edge-empty', 'ready', 'hasdata',
]);

export class PetriScheduler implements WorkflowScheduler {
  private readonly state: SchedulerState = {
    executionError: undefined, closeFunction: undefined, fatal: undefined, haltMarking: undefined,
    waitingNode: undefined,
  };
  private readonly cache: CompiledWorkflowCache;
  /** Diagnostics of the last `run()`, in order. */
  readonly diagnostics: string[] = [];
  /** The compiled workflow of the last `run()` (for tests and tooling). */
  compiled: CompiledWorkflow | undefined;
  /** How the last `run()` ended. */
  outcome: SchedulerOutcome | undefined;

  constructor(private readonly options: PetriSchedulerOptions) {
    this.cache = options.cache ?? new CompiledWorkflowCache();
  }

  get executionError(): ExecutionBaseError | undefined {
    return this.state.executionError;
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
   * on a miss, and the program itself compiles lazily on first access (CONC-020).
   */
  compileDescription(description: WorkflowDescription): CompiledWorkflow {
    const key = CompiledWorkflowCache.key(structuralHash(analyse(description)), this.budget);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const fresh = compile(description, { budget: this.budget, actions: schedulerActions() });
    this.cache.set(key, fresh);
    return fresh;
  }

  async run(
    host: SchedulerHost,
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
    hooks: SchedulerHooks,
  ): Promise<void> {
    this.diagnostics.length = 0;
    this.state.executionError = undefined;
    this.state.fatal = undefined;
    this.state.haltMarking = undefined;
    this.state.waitingNode = undefined;

    if (workflow.settings.executionOrder !== 'v1') {
      this.outcome = 'legacy';
      const legacy = this.options.legacy();
      try {
        await legacy.run(host, workflow, runExecutionData, hooks);
      } finally {
        this.state.executionError = legacy.executionError;
        this.state.closeFunction = legacy.closeFunction;
      }
      return;
    }

    const executionData = runExecutionData.executionData;
    if (executionData === undefined || !host.isExecutionStackNotEmpty()) {
      // `executionLoop: while (host.isExecutionStackNotEmpty())` never enters.
      this.outcome = 'nothing-to-run';
      return;
    }

    const description = describeWorkflow(workflow, runExecutionData, { nodeHelpers: this.options.nodeHelpers, mode: host.mode });
    const compiled = this.compileDescription(description);
    this.compiled = compiled;
    for (const d of compiled.diagnostics) this.diagnostic(`compile: ${d}`);

    const initial = decodeExecutionData(compiled, executionData, {
      runData: runExecutionData.resultData.runData,
      onDiagnostic: (m) => this.diagnostic(`decode: ${m}`),
    });
    // n8n pops every entry it runs; the net took them all at once.
    while (host.isExecutionStackNotEmpty()) host.popExecutionStack();

    let executor: PrecompiledNetExecutor | undefined;
    const env: ExecutionEnv = {
      host, workflow, runExecutionData, hooks, state: this.state, diagnostic: (m) => this.diagnostic(m),
      snapshotMarking: () => executor?.getMarking(),
    };
    const contexts = new Map<string, unknown>([[ENV_KEY, env]]);
    executor = new PrecompiledNetExecutor(compiled.net, initial, {
      program: compiled.program,
      executionContextProvider: () => contexts,
      ...(this.options.eventStore === undefined ? {} : { eventStore: this.options.eventStore }),
    });

    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      executor!.close();
    };
    let marking: Marking;
    if (host.abortSignal.aborted) onAbort();
    else host.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      marking = await executor.run();
    } finally {
      host.abortSignal.removeEventListener('abort', onAbort);
    }

    const fatal = this.state.fatal;
    this.state.fatal = undefined;
    this.outcome = this.finish(compiled, marking, executionData, host, workflow, cancelled);
    if (fatal !== undefined) {
      // The mirrored loop would have rejected `run()` mid-way; the action took the halt (or,
      // for a node whose `onError` gives `X_run` no halt branch, the stopped) alternative so
      // the net quiesced and the pending state was written back first.
      this.outcome = 'fatal';
      throw fatal;
    }
  }

  /**
   * Classifies the quiescent marking and writes back what n8n owns. In order: a halt (the
   * host pushed the failed entry, the snapshot taken before the reap carries the rest), a
   * pause (`_pause` / `X/waiting` / `X/stopped`), a cancellation, natural quiescence.
   */
  private finish(
    compiled: CompiledWorkflow,
    marking: Marking,
    executionData: ExecutionDataState,
    host: SchedulerHost,
    workflow: Workflow,
    cancelled: boolean,
  ): SchedulerOutcome {
    const shared = compiled.netMap.shared;
    const node = (name: string) => workflow.nodes[name];
    const diag = (m: string) => this.diagnostic(m);

    if (marking.tokenCount(shared.halted) > 0 || marking.tokenCount(shared.halt) > 0) {
      // n8n's `handleNodeExecutionError` pushed the failed entry and its loop `break`s, so
      // everything it had not popped stays on the stack — the entries `ExecutionService`
      // replays on "Retry execution". `_halt_reap` destroyed those tokens here, so they come
      // from the snapshot taken when the halt branch was written, merged with what the
      // in-flight actions deposited afterwards (EXEC-040: they finish, and their routes are
      // not halt-inhibited).
      const pushed = [...executionData.nodeExecutionStack];
      encodeMarking(compiled, this.haltPending(compiled, marking), executionData, { mode: 'cancelled', node, onDiagnostic: diag });
      const pending = executionData.nodeExecutionStack;
      executionData.nodeExecutionStack = [...pushed, ...pending];
      if (pending.length > 0) {
        this.diagnostic(`halted: ${pending.length} pending activation(s) written back to nodeExecutionStack ` +
          `(${pending.map((e) => e.node.name).join(', ')})`);
      }
      return 'halted';
    }

    const waitingNodes = compiled.netMap.nodes.filter((g) => marking.tokenCount(g.waiting) > 0).map((g) => g.node);
    let destinationStopped = false;
    let stoppedBeforeRun = false;
    for (const g of compiled.netMap.nodes) {
      for (const t of marking.peekTokens(g.stopped)) {
        if ((t.value as StoppedPayload).ran) destinationStopped = true;
        else stoppedBeforeRun = true;
      }
    }
    if (marking.tokenCount(shared.pause) > 0 || waitingNodes.length > 0 || destinationStopped || stoppedBeforeRun) {
      // A cancellation that arrives while the net is paused leaves the tokens `close()`
      // caught between `X_run` and `X_route` (ENV-013), which only mode `cancelled` can
      // encode — it routes them as `X_route` would have. Encoding those in mode `pause`
      // is a `CodecError`, and the pending state would be lost with it.
      const mode: EncodeMode = cancelled ? 'cancelled' : 'pause';
      encodeMarking(compiled, marking, executionData, { mode, node, onDiagnostic: diag });
      if (destinationStopped) {
        // After the destination node n8n keeps popping: an entry outside the run filter is
        // dropped at lines 74–76 without running. The pause left those entries pending;
        // drop them through the same predicate. A waiting node stays: it must re-run.
        executionData.nodeExecutionStack = executionData.nodeExecutionStack.filter(
          (e) => waitingNodes.includes(e.node.name) || !host.isNodeFilteredOut(e.node.name));
      }
      // Only `ran: false` stops (the host's `shouldStopExecuting()` was true when `X_run`
      // fired, e.g. the workflow timeout) without a Wait or a destination stop is a
      // cancellation: n8n's loop `return`s and leaves the entry on the stack.
      if (cancelled) return 'cancelled';
      return waitingNodes.length > 0 || destinationStopped ? 'paused' : 'cancelled';
    }
    if (cancelled) {
      encodeMarking(compiled, marking, executionData, { mode: 'cancelled', node, onDiagnostic: diag });
      return 'cancelled';
    }
    const mode: EncodeMode = 'stranded';
    const before = this.diagnostics.length;
    encodeMarking(compiled, marking, executionData, { mode, node, onDiagnostic: diag });
    return this.diagnostics.length > before ? 'stranded' : 'completed';
  }

  /**
   * What was pending when the execution halted: the quiescent marking plus, on every place
   * `_halt_reap` clears with a reset arc, the tokens the snapshot still had. The two are
   * disjoint — the reap emptied those places, so anything the final marking holds on them
   * arrived after it — and the snapshot's are the older ones, hence first in the FIFO.
   * Places the reap leaves alone (`X/retry`, `X/waiting`, `X/stopped`) are taken from the
   * final marking only, so a token that merely moved is never counted twice.
   */
  private haltPending(compiled: CompiledWorkflow, marking: Marking): Marking {
    const snapshot = this.state.haltMarking;
    this.state.haltMarking = undefined;
    if (snapshot === undefined) return marking;
    const merged = Marking.empty();
    const add = (place: Place<unknown>, tokens: readonly Token<unknown>[]): void => {
      for (const t of tokens) merged.addToken(place, t);
    };
    for (const p of compiled.netMap.places) {
      if (REAPED_ROLES.has(p.role)) add(p.place, snapshot.peekTokens(p.place));
      add(p.place, marking.peekTokens(p.place));
    }
    return merged;
  }
}
