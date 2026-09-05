/**
 * Shared helpers for the spike suite.
 *
 * Every spike builds a tiny hand-written net that *is* the gadget under test and runs it
 * on `PrecompiledNetExecutor` (the production executor; never the Bitmap reference) or
 * hands it to `SmtVerifier`. `runNet()` runs to natural quiescence (EXEC-040) with an
 * `InMemoryEventStore` attached so firing order is observable through
 * `transition-started` events (EVT-006). It never passes a timeout to `run()`.
 *
 * `nodeGadget()` is the per-node gadget as it actually validates on libpetri 4.1.0 —
 * see the note on `X_route` below for the one deviation from the README shape and the
 * spike (`out-spec.test.ts`) that pins why.
 */
import {
  InMemoryEventStore, PrecompiledNet, PrecompiledNetExecutor, Transition, tokenOf,
  and, delayed, one, outPlace, place, xor,
  type Marking, type NetEvent, type Out, type PetriNet, type Place, type Token, type TransitionFailed,
} from 'libpetri';
import { z3Available } from 'libpetri/verification';

// ==================== z3 gating ====================

/** Whether a usable `z3` resolves (`LIBPETRI_Z3` or `PATH`, >= 4.8.0; VER-013). */
export const Z3_AVAILABLE = z3Available();

/**
 * `describe` for suites that run the solver. Without z3 the suite is skipped with the
 * reason in its name; `tests/z3-gate.test.ts` turns that skip into a failure under `CI`.
 */
export function describeZ3(name: string, fn: () => void): void {
  if (Z3_AVAILABLE) describe(name, fn);
  else describe.skip(`${name} [skipped: no usable z3 >= 4.8.0 on PATH or LIBPETRI_Z3]`, fn);
}

// ==================== Running ====================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `n` unit tokens (the value of a marker / budget / free-slot token is irrelevant). */
export function units(n = 1): Token<null>[] {
  return Array.from({ length: n }, () => tokenOf(null));
}

export type Initial = Map<Place<any>, Token<any>[]>;

/** Merges initial markings; later entries append to earlier ones on the same place. */
export function marking(...parts: Array<Initial | Array<[Place<any>, Token<any>[]]>>): Initial {
  const out: Initial = new Map();
  for (const part of parts) {
    for (const [p, tokens] of part) {
      out.set(p, [...(out.get(p) ?? []), ...tokens]);
    }
  }
  return out;
}

export interface RunResult {
  readonly marking: Marking;
  readonly store: InMemoryEventStore;
  readonly elapsedMs: number;
}

/**
 * Runs `net` from `initial` to quiescence on `PrecompiledNetExecutor` with the program
 * compiled once per call (or reused when passed), recording every event.
 */
export async function runNet(net: PetriNet, initial: Initial, program?: PrecompiledNet): Promise<RunResult> {
  const store = new InMemoryEventStore();
  const executor = new PrecompiledNetExecutor(net, initial, {
    eventStore: store,
    program: program ?? PrecompiledNet.compile(net),
  });
  const t0 = performance.now();
  const m = await executor.run();
  return { marking: m, store, elapsedMs: performance.now() - t0 };
}

// ==================== Observation ====================

/** Transition names in `transition-started` order (EVT-006), optionally filtered. */
export function started(store: InMemoryEventStore, filter?: (name: string) => boolean): string[] {
  const names: string[] = [];
  for (const e of store.events()) {
    if (e.type === 'transition-started' && (filter === undefined || filter(e.transitionName))) {
      names.push(e.transitionName);
    }
  }
  return names;
}

/** Every `transition-failed` event (EVT-008). */
export function failed(store: InMemoryEventStore): TransitionFailed[] {
  return store.events().filter((e): e is TransitionFailed => e.type === 'transition-failed');
}

/** Index of the n-th (1-based) event satisfying `pred`, or -1. */
export function nthIndex(store: InMemoryEventStore, pred: (e: NetEvent) => boolean, n: number): number {
  let seen = 0;
  const events = store.events();
  for (let i = 0; i < events.length; i++) {
    if (pred(events[i]!)) {
      seen++;
      if (seen === n) return i;
    }
  }
  return -1;
}

export function isStartOf(name: string): (e: NetEvent) => boolean {
  return (e) => e.type === 'transition-started' && e.transitionName === name;
}

export function isCompletionOf(name: string): (e: NetEvent) => boolean {
  return (e) => e.type === 'transition-completed' && e.transitionName === name;
}

/**
 * Highest number of tokens a place held at any one moment, replayed from the
 * `token-added` / `token-removed` stream on top of `initialCount`.
 */
export function maxSimultaneous(store: InMemoryEventStore, placeName: string, initialCount = 0): number {
  let now = initialCount;
  let max = initialCount;
  for (const e of store.events()) {
    if (e.type === 'token-added' && e.placeName === placeName) now++;
    else if (e.type === 'token-removed' && e.placeName === placeName) now--;
    if (now > max) max = now;
  }
  return max;
}

// ==================== The per-node gadget ====================

/** Places every node shares: the concurrency budget and the halt markers. */
export interface Shared {
  readonly budget: Place<null>;
  readonly halt: Place<null>;
  readonly halted: Place<null>;
}

export function shared(): Shared {
  return { budget: place<null>('_budget'), halt: place<null>('_halt'), halted: place<null>('_halted') };
}

/** What the node did: the `xor` branch `X_run`'s action writes (IO-012, IO-015). */
export type Branch =
  | { readonly kind: 'ok'; readonly value?: unknown }
  | { readonly kind: 'retry' }
  | { readonly kind: 'halt' };

/** The token on `X/ok`: `value` undefined means "fired, produced nothing" (an empty edge). */
export interface Outcome { readonly value?: unknown }

export interface RetrySpec {
  /** n8n `maxTries`; `X/tries` is seeded with `maxTries - 1`. */
  readonly maxTries: number;
  /** n8n `waitBetweenTries`: `X_retry_wait` is `delayed(waitMs)` (TIME-004). */
  readonly waitMs: number;
  /** What `X_exhausted` does: continue with an empty output (default) or halt the run. */
  readonly onExhausted?: 'continue' | 'halt';
}

export interface NodeSpec {
  readonly name: string;
  /** The edge place feeding `X_start`; a fresh `X/in` when omitted. */
  readonly input?: Place<any>;
  /** The data edge `X_route` writes on success; a fresh `X/out` when omitted. */
  readonly output?: Place<any>;
  /** `priority = depth(X)` on `X_start`, `depth(X) + 1` on `X_run` / `X_route` (README). Default 0. */
  readonly startPriority?: number;
  readonly runPriority?: number;
  /** The explicit `X/idle` mutex; on by default. Off only to show what it prevents. */
  readonly withIdle?: boolean;
  /** n8n `retryOnFail`; adds `X/tries`, `X_retry_wait` and `X_exhausted`. */
  readonly retry?: RetrySpec;
  /** The "node": receives the consumed input value, returns the branch to take. */
  readonly act: (value: unknown) => Promise<Branch>;
}

export interface NodeGadget {
  readonly name: string;
  readonly input: Place<any>;
  readonly output: Place<any>;
  readonly outputEmpty: Place<null>;
  readonly running: Place<any>;
  readonly ok: Place<Outcome>;
  readonly idle: Place<null>;
  readonly done: Place<null>;
  readonly retry: Place<any>;
  /** Present only with `retry`. */
  readonly tries: Place<null> | null;
  readonly start: Transition;
  readonly run: Transition;
  readonly route: Transition;
  readonly retryWait: Transition | null;
  readonly exhausted: Transition | null;
  /** All transitions in declaration order: start, run, route, [retryWait, exhausted]. */
  readonly transitions: Transition[];
  /** `X/idle` seeded with one token, `X/tries` with `maxTries - 1`. */
  readonly initial: Initial;
}

/**
 * ```
 * X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_halted) → outPlace(X/running)
 * X_run:        one(X/running) → and( xor( X/ok, [X/retry], and(_halt, _budget) ), X/idle )
 * X_route:      one(X/ok) → and( xor(out/data, out/empty), _budget, X/done )
 * X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
 *               timing delayed(waitMs) → outPlace(X/running)
 * X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, and(_halt, _budget) )
 * ```
 *
 * **Why `X_route` exists (deviation from the README shape).** The README puts the
 * per-edge `xor(data, empty)` specs *inside* the success branch of `X_run`'s outer
 * `xor(success, retry, halt)`. libpetri 4.1.0's `validateOutSpec` throws
 * `OutViolationError("XOR violation - no branch produced")` the moment it walks an
 * inner `xor` none of whose children was written — it does not return "unsatisfied" to
 * the enclosing branch the way `and` does — so the retry and halt branches are rejected
 * unless a branch-exclusive place (`X/done`) is declared before the inner `xor`, which
 * makes the `and` short-circuit first. That is validator evaluation order, not IO-015
 * (both pinned in `out-spec.test.ts`). Routing the success outcome through `X/ok` keeps
 * every `xor` at most one level deep: `X_run` chooses the outcome, `X_route` chooses per
 * edge.
 *
 * **Where the budget is refunded.** `_budget` is held from `X_start` until `X_route`
 * deposits the edges (success), or is refunded on the halt branch by `X_run` /
 * `X_exhausted`, and is held across `X_retry_wait`. Refunding in `X_route` — the same
 * completion that deposits the edge tokens — is what lets a successor's start and a
 * budget-blocked sibling's start re-enable in the same cycle, so priority alone decides
 * (`priority-depth.test.ts`). `budget + Σ(running + ok + retry) = k` is the semiflow.
 */
export function nodeGadget(spec: NodeSpec, sh: Shared): NodeGadget {
  const n = spec.name;
  const withIdle = spec.withIdle ?? true;
  const input = spec.input ?? place<unknown>(`${n}/in`);
  const output = spec.output ?? place<unknown>(`${n}/out`);
  const outputEmpty = place<null>(`${output.name}_empty`);
  const running = place<unknown>(`${n}/running`);
  const ok = place<Outcome>(`${n}/ok`);
  const idle = place<null>(`${n}/idle`);
  const done = place<null>(`${n}/done`);
  const retry = place<unknown>(`${n}/retry`);
  const tries = spec.retry ? place<null>(`${n}/tries`) : null;
  const idleIn = withIdle ? [one(idle)] : [];
  const idleOut: Out[] = withIdle ? [outPlace(idle)] : [];
  const haltBranch = and(outPlace(sh.halt), outPlace(sh.budget));

  const start = Transition.builder(`${n}_start`)
    .inputs(one(input), one(sh.budget), ...idleIn)
    .inhibitors(sh.halt, sh.halted)
    .outputs(outPlace(running))
    .priority(spec.startPriority ?? 0)
    .action(async (ctx) => { ctx.output(running, ctx.input(input)); })
    .build();

  const run = Transition.builder(`${n}_run`)
    .inputs(one(running))
    .outputs(and(
      xor(outPlace(ok), ...(spec.retry ? [outPlace(retry)] : []), haltBranch),
      ...idleOut,
    ))
    .priority(spec.runPriority ?? 0)
    .action(async (ctx) => {
      const value = ctx.input(running);
      const branch = await spec.act(value);
      switch (branch.kind) {
        case 'ok':
          ctx.output(ok, { value: branch.value });
          break;
        case 'retry':
          if (!spec.retry) throw new Error(`${n}: retry branch taken on a node without retryOnFail`);
          ctx.output(retry, value);
          break;
        case 'halt':
          ctx.output(sh.halt, null);
          ctx.output(sh.budget, null);
          break;
      }
      if (withIdle) ctx.output(idle, null);
    })
    .build();

  const route = Transition.builder(`${n}_route`)
    .inputs(one(ok))
    .outputs(and(xor(outPlace(output), outPlace(outputEmpty)), outPlace(sh.budget), outPlace(done)))
    .priority(spec.runPriority ?? 0)
    .action(async (ctx) => {
      const { value } = ctx.input(ok);
      if (value === undefined) ctx.output(outputEmpty, null);
      else ctx.output(output, value);
      ctx.output(sh.budget, null);
      ctx.output(done, null);
    })
    .build();

  let retryWait: Transition | null = null;
  let exhausted: Transition | null = null;
  if (spec.retry && tries) {
    const onExhausted = spec.retry.onExhausted ?? 'continue';
    retryWait = Transition.builder(`${n}_retry_wait`)
      .inputs(one(retry), one(tries), ...idleIn)
      .inhibitors(sh.halt, sh.halted)
      .timing(delayed(spec.retry.waitMs))
      .outputs(outPlace(running))
      .priority(spec.startPriority ?? 0)
      .action(async (ctx) => { ctx.output(running, ctx.input(retry)); })
      .build();
    exhausted = Transition.builder(`${n}_exhausted`)
      .inputs(one(retry))
      .inhibitor(tries)
      .outputs(xor(outPlace(ok), haltBranch))
      .priority(spec.runPriority ?? 0)
      .action(async (ctx) => {
        if (onExhausted === 'continue') ctx.output(ok, {});
        else { ctx.output(sh.halt, null); ctx.output(sh.budget, null); }
      })
      .build();
  }

  const initial: Initial = new Map();
  if (withIdle) initial.set(idle, units());
  if (spec.retry && tries) initial.set(tries, units(spec.retry.maxTries - 1));

  return {
    name: n, input, output, outputEmpty, running, ok, idle, done, retry, tries,
    start, run, route, retryWait, exhausted,
    transitions: [start, run, route, ...(retryWait ? [retryWait] : []), ...(exhausted ? [exhausted] : [])],
    initial,
  };
}
