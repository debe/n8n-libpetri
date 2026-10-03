/**
 * The `--import` preload that registers `PetriScheduler` with a **running** n8n process.
 *
 * `scripts/run-conformance.sh` wires the engine in through a vitest `setupFiles` shim; a server
 * has no such seam, so this is its equivalent. It is the server-side counterpart of
 * `typescript/src/n8n-vitest-setup.ts` and gates on the same variable, `N8N_EXECUTION_ENGINE`,
 * so the same launcher runs the legacy engine with this file inert.
 *
 * Three things make it work, and each is deliberate:
 *
 * 1. **`createRequire`, not `import`.** n8n-core builds to CommonJS (`"main": "dist/index"`) and
 *    n8n-libpetri is ESM-only. The registry has to be the *same module instance* the CLI loads,
 *    so we resolve `n8n-core` from `packages/cli`'s own resolution root. Node resolves pnpm's
 *    symlinks to their realpath (`--preserve-symlinks` is off by default), so that instance and
 *    the CLI's `require('n8n-core')` are one and the same CJS module.
 * 2. **`--import`, not `NODE_OPTIONS`.** `packages/cli/bin/n8n` never re-execs, so a preload on
 *    the command line covers the whole process. `NODE_OPTIONS` would additionally leak this file
 *    into the internal task-runner child, which never constructs a `WorkflowExecute`.
 * 3. **No fallback.** If anything here fails the preload throws and n8n does not start. A testbed
 *    that quietly falls back to n8n's stack loop while claiming to run the net is worse than one
 *    that refuses to boot.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ENGINE_ENV = 'N8N_EXECUTION_ENGINE';

if (process.env[ENGINE_ENV] === 'libpetri') {
  const resolveFrom = process.env.N8N_LIBPETRI_RESOLVE_FROM;
  const hook = process.env.N8N_LIBPETRI_HOOK;
  if (!resolveFrom) throw new Error('N8N_LIBPETRI_RESOLVE_FROM is not set (expected .n8n/packages/cli/package.json)');
  if (!hook) throw new Error('N8N_LIBPETRI_HOOK is not set (expected typescript/dist/index.js)');

  const req = createRequire(resolveFrom);
  const core = req('n8n-core');
  const { NodeHelpers } = req('n8n-workflow');

  // Patch 0002's seam. Its absence means `.n8n/packages/core/dist` was built from an unpatched
  // tree — the one failure mode that would otherwise look like a working legacy run.
  if (typeof core.setWorkflowSchedulerFactory !== 'function') {
    throw new Error(
      'n8n-core exports no setWorkflowSchedulerFactory: packages/core/dist predates patch 0002. ' +
        'Run scripts/verify-patch.sh, then rebuild packages/core.',
    );
  }

  const { registerPetriScheduler } = await import(pathToFileURL(hook).href);

  const integer = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
    return value;
  };

  registerPetriScheduler({
    setWorkflowSchedulerFactory: core.setWorkflowSchedulerFactory,
    StackScheduler: core.StackScheduler,
    nodeHelpers: NodeHelpers,
    budget: integer('N8N_LIBPETRI_BUDGET', 1),
    maxAgentRounds: integer('N8N_LIBPETRI_MAX_AGENT_ROUNDS', undefined),
    maxAgentToolCalls: integer('N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS', undefined),
    // stderr, not console: n8n installs its own logger over the console early in boot, and the
    // launcher greps this prefix out of .testbed/n8n.log to prove the engine was entered.
    onDiagnostic: (message) => process.stderr.write(`[n8n-libpetri] ${message}\n`),
  });

  // Two distinct claims, deliberately two lines. This one says the factory was *installed*,
  // which is true at boot. `ENGINE_ENTERED_DIAGNOSTIC` — emitted by the factory itself the
  // first time n8n constructs a scheduler through it — says the engine was *entered*, which
  // only an execution can establish. `docs/conformance-final.md` keeps the same distinction
  // for the same reason: a registered engine is not a run engine.
  process.stderr.write(
    `[n8n-libpetri] scheduler registered: budget=${integer('N8N_LIBPETRI_BUDGET', 1)}, hook=${hook}\n`,
  );
}

/*
 * Engine v2 (`n8n-testbed.sh --v2`, `tasks/v2-seam-plan.md` step 11). Independent of the branch
 * above: that one installs a scheduler for engine v1's `WorkflowExecute`, this one a settlement
 * policy for `@n8n/engine`, and a process may carry either, both or neither.
 *
 * The same three rules hold:
 * 1. `@n8n/engine` is resolved through `createRequire(packages/cli/package.json)`, so the registry
 *    set here is the one `EngineV2Runtime` reads: `createEngineRuntime` takes
 *    `settlementPolicy ?? getSettlementPolicy()` (patch 0004) from the module `packages/cli`'s
 *    `require('@n8n/engine')` returns, and both resolve the pnpm symlink to one realpath, one CJS
 *    instance. The registration runs before n8n's modules initialise, so the runtime the
 *    engine-v2 module builds at boot reads it.
 * 2. No fallback. An engine without `setSettlementPolicy` is a dist built without patch 0004,
 *    which would run n8n's own decisions under our name, so the preload throws and n8n does not
 *    start — in every mode, `off` included, since `off` is the patched-with-nothing-registered leg.
 * 3. Two claims, two lines. `settlement policy registered` is written by `register.ts` once the
 *    registry hands back what was set; `settlement policy entered` only by the policy itself when
 *    a settlement calls it. F5 is the first without the second.
 *
 * Every diagnostic and every shadow report is appended to `N8N_LIBPETRI_SETTLEMENT_LEDGER`
 * (JSONL), the record step 12 counts calls from. stderr gets `registered`, the first `entered` per
 * execution, every `race` and `error`, and every shadow report that is not an agreement, so the
 * log stays readable under a 1,000-pass loop.
 */
const SETTLEMENT_ENV = 'N8N_LIBPETRI_SETTLEMENT';
const settlement = process.env[SETTLEMENT_ENV];
// `--import` runs in every worker thread too (they inherit `execArgv`), and n8n starts some after
// boot. A worker thread has its own module graph, so a registration there lands on a second
// `@n8n/engine` instance no runtime reads, and its `registered` line would be a false second
// claim. Engine v2's runtime is built on the main thread (`EngineV2Runtime.initEngine`).
const { isMainThread } = await import('node:worker_threads');

if (settlement !== undefined && settlement !== '' && isMainThread) {
  const { appendFileSync } = await import('node:fs');
  const resolveFrom = process.env.N8N_LIBPETRI_RESOLVE_FROM;
  const hook = process.env.N8N_LIBPETRI_V2_HOOK;
  const ledger = process.env.N8N_LIBPETRI_SETTLEMENT_LEDGER;
  if (!resolveFrom) throw new Error('N8N_LIBPETRI_RESOLVE_FROM is not set (expected .n8n/packages/cli/package.json)');
  if (!hook) throw new Error('N8N_LIBPETRI_V2_HOOK is not set (expected typescript/dist/n8n-v2.js)');

  const modules = (process.env.N8N_ENABLED_MODULES ?? '').split(',').map((m) => m.trim());
  if (!modules.includes('engine-v2')) {
    throw new Error(`${SETTLEMENT_ENV} is set but N8N_ENABLED_MODULES does not name engine-v2; no runtime would read the policy`);
  }

  const engine = createRequire(resolveFrom)('@n8n/engine');
  for (const name of ['setSettlementPolicy', 'getSettlementPolicy', 'resetSettlementPolicy']) {
    if (typeof engine[name] !== 'function') {
      throw new Error(
        `@n8n/engine exports no ${name}: packages/@n8n/engine/dist predates patch 0004. ` +
          'Run scripts/verify-patch.sh, then rebuild the engine (n8n-testbed.sh does when dist is stale).',
      );
    }
  }
  if (typeof engine.defaultSettlementPolicy?.decideSuccessors !== 'function') {
    throw new Error('@n8n/engine exports no defaultSettlementPolicy: packages/@n8n/engine/dist predates patch 0003.');
  }

  // Buffered, flushed every 200 ms and synchronously at exit. A synchronous append per record would
  // sit inside the policy's own measured time (`entered` is emitted inside every call), and under
  // `--timing` that is a cost the `off` leg never pays, so the legs would not be like for like.
  const pending = [];
  const flush = () => {
    if (!ledger || pending.length === 0) return;
    const chunk = pending.splice(0).join('');
    try {
      appendFileSync(ledger, chunk);
    } catch {
      // The ledger never changes an answer.
    }
  };
  setInterval(flush, 200).unref();
  process.on('exit', flush);
  const record = (entry) => {
    if (!ledger) return;
    pending.push(`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  };
  const say = (line) => process.stderr.write(`[n8n-libpetri] ${line}\n`);
  // The timing instrument's per-settlement context, made here so the policy's `snapshot`
  // diagnostics (step 12's rerun: which settlement stored a snapshot, which reused it) land in the
  // settlement record of the handler they were emitted in.
  const timing = process.env.N8N_LIBPETRI_SETTLEMENT_TIMING === '1';
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage();

  if (settlement === 'off') {
    // Nothing registered: the runtime keeps n8n's `defaultSettlementPolicy`. The line is the
    // launcher's gate for this mode, and it says what was checked: the seam is in the dist.
    record({ kind: 'off', message: 'settlement policy off' });
    say('settlement policy off: patch 0004 is in @n8n/engine, nothing registered, n8n\'s default answers');
  } else {
    const { registerSettlementPolicy, SETTLEMENT_MODES } = await import(pathToFileURL(hook).href);
    if (!SETTLEMENT_MODES.includes(settlement)) {
      throw new Error(`${SETTLEMENT_ENV} must be off or one of ${SETTLEMENT_MODES.join(', ')}, got '${settlement}'`);
    }
    const announced = new Set();
    registerSettlementPolicy(engine, {
      mode: settlement,
      onDiagnostic: (d) => {
        if (d.kind === 'snapshot') {
          // Under --timing it goes into the handler's settlement record; an `overrun` is also a line.
          const ctx = als.getStore();
          if (ctx) ctx.snapshots.push({ method: d.method, event: d.event, token: d.token });
          if (!ctx || d.event === 'overrun') record(d);
          if (d.event === 'overrun') say(`settlement policy snapshot overrun: method=${d.method}, execution=${d.executionId}`);
          return;
        }
        record(d);
        if (d.kind === 'registered') {
          say(`${d.message}: mode=${d.mode}, hook=${hook}`);
        } else if (d.kind === 'entered') {
          if (announced.has(d.executionId)) return;
          announced.add(d.executionId);
          say(`${d.message}: method=${d.method}, execution=${d.executionId}`);
        } else if (d.kind === 'race') {
          say(`${d.message}: ${d.race}, method=${d.method}, execution=${d.executionId}`);
        } else if (d.kind === 'error') {
          say(`${d.message}: ${d.name}: ${d.error} (method=${d.method}, execution=${d.executionId})`);
        }
      },
      onShadowReport: (report) => {
        if (report.verdict === 'agree') {
          // Without the rows: under a 1,000-pass loop each report carries every row both sides
          // read, and an agreement is fully described by its answer and its costs.
          const { primaryRows, candidateRows, ...compact } = report;
          record({ kind: 'shadow', report: { ...compact, primaryRowCount: primaryRows.length, candidateRowCount: candidateRows.length } });
        } else {
          record({ kind: 'shadow', report });
          say(`settlement shadow ${report.verdict}: method=${report.method}, execution=${report.executionId}, settled=${JSON.stringify(report.settled)}${report.error ? `, error=${report.error}` : ''}`);
        }
      },
    });
  }

  if (timing) {
    await instrumentSettlements(engine, createRequire(resolveFrom), record, say, als);
  }
}

/*
 * The settlement timing instrument (`n8n-testbed.sh --timing`, `diff-engines-v2.sh`, plan step 12).
 * A measuring device, not a seam: it changes no answer and no order of calls, and it is installed the
 * same way in every mode, `off` included, so the legs are compared like for like.
 *
 * It wraps, on the module instance the runtime is built from:
 * - `StepSettledHandler.prototype.handle`: one record per `step:settled` event, with its wall time and
 *   an `AsyncLocalStorage` context that the wrappers below write into. Concurrent settlements keep
 *   their own contexts.
 * - `announceEnd`: the `ended` response's `status` and `lastStep`, captured as the handler computes it
 *   whether or not a response is sent (a manual run expects none, `responseExpectation.kind` `none`).
 * - every method of `TypeOrmStepStore` and `TypeOrmExecutionStore`: store calls per settlement, the
 *   step and execution the handler loaded, and what its first `hasFailedSteps` returned.
 * - the policy's `snapshot` diagnostics, emitted inside its calls, go into the same record
 *   (`snapshots`): which settlement stored a snapshot and which reused it, by token, so the
 *   comparator can check that a reused snapshot never crosses from one handler to another.
 * - the two methods of the policy the runtime holds (`getSettlementPolicy()` after registration; in
 *   `off` that is n8n's `defaultSettlementPolicy` object itself, wrapped in place, so the registry stays
 *   empty): each call's wall time, its reader calls, and its round trips, a reader call that reaches
 *   SQL. `loadLatestStepSummaries([])` and `loadStepSummariesByKeys([])` return `{}` in the store
 *   without a query, so they are reader calls and not round trips.
 *
 * For the concurrent and cancel phases (ADR 0014, "Open") it also records, on one clock
 * (`performance.now()`, this process):
 * - per settlement: when the handler started (`t0`) and ended (`t1`), when its `loadExecution`
 *   answered (`tLoaded`, the liveness read), when the policy's first read started (`tRead`), when
 *   `createSteps` was called (`tCreate`) and which keys it created (`created`, with each row's
 *   status as asked and its id);
 * - per policy call: its answer (`result`: queue and skip counts, or the boolean) and whether the
 *   rows it read held a cancelled row and no failed one (`cancelSeen`, the row set of divergence
 *   row 36; a call reads only what it asks for, so n8n's default can miss a cancelled row it did
 *   not ask about);
 * - per `CancelExecutionService.cancel` (the engine's side of `POST /rest/executions/:id/stop`): a
 *   `cancel` record with when it started, when its compare-and-set answered and whether it won
 *   (`tCas`, `won`), when `cancelPendingSteps` answered (`tPending`), and the status it returned;
 * - per `TypeOrmStepStore.cancelStep` (only `StepReadyHandler` calls it, cancelling a row it claimed
 *   after the execution ended): a `cancel-step` record with the row's id, its execution (from
 *   the settlement that created it) and whether the transition took. `cancelPendingSteps` is one bulk
 *   update, so without this record a row created after the cancel and found `cancelled` could have
 *   ended either way.
 * None of it changes an answer, an order of calls or a query.
 */
async function instrumentSettlements(engine, req, record, say, als) {
  const { StepSettledHandler } = req('@n8n/engine/dist/execution/step-settled-handler.js');
  const { TypeOrmStepStore } = req('@n8n/engine/dist/database/typeorm-step-store.js');
  const { TypeOrmExecutionStore } = req('@n8n/engine/dist/database/typeorm-execution-store.js');
  const { CancelExecutionService } = req('@n8n/engine/dist/execution/cancel-execution.service.js');
  for (const [name, value] of [['StepSettledHandler', StepSettledHandler], ['TypeOrmStepStore', TypeOrmStepStore], ['TypeOrmExecutionStore', TypeOrmExecutionStore], ['CancelExecutionService', CancelExecutionService]]) {
    if (typeof value !== 'function') throw new Error(`settlement timing: @n8n/engine/dist has no ${name}`);
  }
  for (const name of ['handle', 'announceEnd']) {
    if (typeof StepSettledHandler.prototype[name] !== 'function') throw new Error(`settlement timing: StepSettledHandler has no ${name}`);
  }

  const handle = StepSettledHandler.prototype.handle;
  StepSettledHandler.prototype.handle = async function timedHandle(event) {
    const ctx = {
      kind: 'settlement', store: 0, policy: [], snapshots: [], step: null, executionStatus: null, failedFound: null, ended: null,
      tLoaded: null, tRead: null, tCreate: null, created: null,
    };
    const t0 = performance.now();
    let threw = null;
    try {
      return await als.run(ctx, () => handle.call(this, event));
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      const t1 = performance.now();
      record({
        kind: 'settlement', executionId: event.executionId, stepId: event.stepId,
        ms: t1 - t0, step: ctx.step, executionStatus: ctx.executionStatus, failedFound: ctx.failedFound,
        store: ctx.store, policy: ctx.policy, snapshots: ctx.snapshots, ended: ctx.ended, threw,
        t0, t1, tLoaded: ctx.tLoaded, tRead: ctx.tRead, tCreate: ctx.tCreate, created: ctx.created,
      });
    }
  };

  // The engine's side of a stop request. Its own context, so the store wrappers below time its two
  // writes; a cancel is never inside a settlement's context (it arrives over HTTP).
  const cancel = CancelExecutionService.prototype.cancel;
  CancelExecutionService.prototype.cancel = async function timedCancel(executionId) {
    const ctx = { kind: 'cancel', tCas: null, won: null, tPending: null };
    const t0 = performance.now();
    let status = null;
    let threw = null;
    try {
      const result = await als.run(ctx, () => cancel.call(this, executionId));
      status = result?.status ?? null;
      return result;
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      record({ kind: 'cancel', executionId, t0, t1: performance.now(), tCas: ctx.tCas, won: ctx.won, tPending: ctx.tPending, status, threw });
    }
  };

  const announceEnd = StepSettledHandler.prototype.announceEnd;
  StepSettledHandler.prototype.announceEnd = function timedAnnounceEnd(execution, step, node, status) {
    const ctx = als.getStore();
    if (ctx) {
      ctx.ended = {
        status, responseKind: execution?.responseExpectation?.kind ?? null,
        lastStep: { nodeId: step.nodeId, nodeName: node?.name ?? null, iteration: step.iteration, status: step.status },
      };
    }
    return announceEnd.call(this, execution, step, node, status);
  };

  // The execution of each row a settlement created, so a `cancelStep` (which gets only the row's id)
  // can name it. Dropped when the row is cancelled at claim; a row that settles otherwise stays.
  const rowExecution = new Map();
  const wrapStore = (cls) => {
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      if (name === 'constructor') continue;
      const original = cls.prototype[name];
      if (typeof original !== 'function') continue;
      cls.prototype[name] = function timedStoreCall(...args) {
        const ctx = als.getStore();
        if (name === 'cancelStep') {
          // `StepReadyHandler` cancelling a row it claimed for an ended execution (row 35), recorded so
          // the comparator can tell it from `cancelPendingSteps`' bulk update. Whatever the context:
          // the step queue's dispatch loop runs in the context of whoever published to it while it was
          // idle, which can be a settlement handler. No settlement handler calls `cancelStep` itself.
          if (ctx?.kind === 'settlement') ctx.store++;
          return Promise.resolve(original.apply(this, args)).then((value) => {
            const stepId = args[0];
            record({ kind: 'cancel-step', executionId: rowExecution.get(stepId) ?? null, stepId, t: performance.now(), won: value === true });
            rowExecution.delete(stepId);
            return value;
          });
        }
        if (!ctx) return original.apply(this, args);
        if (ctx.kind === 'cancel') {
          const result = original.apply(this, args);
          if (name !== 'cancelExecution' && name !== 'cancelPendingSteps') return result;
          return Promise.resolve(result).then((value) => {
            if (name === 'cancelExecution') { ctx.tCas = performance.now(); ctx.won = value !== null && value !== undefined; }
            else ctx.tPending = performance.now();
            return value;
          });
        }
        ctx.store++;
        if (name === 'createSteps' && ctx.tCreate === null) ctx.tCreate = performance.now();
        const result = original.apply(this, args);
        if (name === 'createSteps') {
          const asked = new Map((args[1] ?? []).map((r) => [`${r.nodeId}@${r.iteration}`, r.status]));
          return Promise.resolve(result).then((value) => {
            const rows = (Array.isArray(value) ? value : []).map((r) => ({ nodeId: r.nodeId, iteration: r.iteration, status: asked.get(`${r.nodeId}@${r.iteration}`) ?? null, id: r.id }));
            for (const r of rows) if (r.id !== undefined) rowExecution.set(r.id, args[0]);
            ctx.created = [...(ctx.created ?? []), ...rows];
            return value;
          });
        }
        if (name === 'loadStep' || name === 'loadExecution' || name === 'hasFailedSteps') {
          return Promise.resolve(result).then((value) => {
            if (name === 'loadStep' && ctx.step === null && value) ctx.step = { nodeId: value.nodeId, iteration: value.iteration, status: value.status };
            if (name === 'loadExecution' && ctx.executionStatus === null && value) { ctx.executionStatus = value.status; ctx.tLoaded = performance.now(); }
            // The first answer is the handler's pre-planning check; a later one is
            // `finishExecutionIfDone`'s, which chooses the outcome.
            if (name === 'hasFailedSteps' && ctx.failedFound === null) ctx.failedFound = value === true;
            return value;
          });
        }
        return result;
      };
    }
  };
  wrapStore(TypeOrmStepStore);
  wrapStore(TypeOrmExecutionStore);

  // `seen` collects the statuses of every row the call read, for `cancelSeen`.
  const countingReader = (reader, call, ctx, seen) => {
    const first = () => { if (ctx && ctx.tRead === null) ctx.tRead = performance.now(); };
    const keep = (summaries) => {
      for (const s of Object.values(summaries ?? {})) seen.add(s.status);
      return summaries;
    };
    return {
      executionId: reader.executionId,
      loadLatestStepSummaries: async (nodeIds) => {
        call.readerCalls++;
        if (nodeIds.length > 0) { call.roundTrips++; first(); }
        return keep(await reader.loadLatestStepSummaries(nodeIds));
      },
      loadStepSummariesByKeys: async (keys) => {
        call.readerCalls++;
        if (keys.length > 0) { call.roundTrips++; first(); }
        return keep(await reader.loadStepSummariesByKeys(keys));
      },
      countSettledSteps: async () => {
        call.readerCalls++;
        call.roundTrips++;
        first();
        return await reader.countSettledSteps();
      },
    };
  };
  const summarise = (answer) => (typeof answer === 'boolean'
    ? answer
    : answer && Array.isArray(answer.toQueue) ? { queue: answer.toQueue.length, skip: answer.toSkip.length } : null);
  const active = engine.getSettlementPolicy();
  const timed = (method) => {
    const original = active[method].bind(active);
    return async (...args) => {
      const ctx = als.getStore();
      const call = { method, ms: 0, readerCalls: 0, roundTrips: 0, result: null, cancelSeen: false };
      const seen = new Set();
      const reader = args[args.length - 1];
      args[args.length - 1] = countingReader(reader, call, ctx?.kind === 'settlement' ? ctx : null, seen);
      const t0 = performance.now();
      try {
        const answer = await original(...args);
        call.result = summarise(answer);
        return answer;
      } finally {
        call.ms = performance.now() - t0;
        call.cancelSeen = seen.has('cancelled') && !seen.has('failed');
        if (ctx) ctx.policy.push(call);
      }
    };
  };
  active.decideSuccessors = timed('decideSuccessors');
  active.isFinished = timed('isFinished');

  const who = active === engine.defaultSettlementPolicy ? "n8n's defaultSettlementPolicy (nothing registered)" : 'the registered policy';
  record({ kind: 'timing', message: 'settlement timing installed', policy: who });
  say(`settlement timing installed: handler, stores and ${who}`);
}
