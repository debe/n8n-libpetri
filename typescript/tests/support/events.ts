/**
 * Readers over a libpetri `InMemoryEventStore`: which transitions started (EVT-006) or
 * failed (EVT-008), in what order, and what the `token-added` / `token-removed` stream says
 * a place held. Shared by the spike, compiler and scheduler suites; each suite's `support.ts`
 * re-exports these under the names it has always used (`transitionsStarted` is
 * {@link started}).
 */
import type { InMemoryEventStore, NetEvent, TransitionFailed } from 'libpetri';

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

/** Every `transition-failed` event (EVT-008) as `'<transition>: <error message>'`, for an assertion message. */
export function transitionsFailed(store: InMemoryEventStore): string[] {
  return failed(store).map((e) => `${e.transitionName}: ${e.errorMessage}`);
}

export function isStartOf(name: string): (e: NetEvent) => boolean {
  return (e) => e.type === 'transition-started' && e.transitionName === name;
}

export function isCompletionOf(name: string): (e: NetEvent) => boolean {
  return (e) => e.type === 'transition-completed' && e.transitionName === name;
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

/**
 * Highest number of tokens a place held at any one moment, replayed from the
 * `token-added` / `token-removed` stream on top of `initialCount`. The seeded initial
 * marking emits no events, so a seeded place's seed has to be passed in as `initialCount`.
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

/**
 * The number of `token-added` events on `place` minus the number of `token-removed` events —
 * a count of **events**, not the place's final token count.
 *
 * The seeded initial marking emits no `token-added` event, so the seed is not in the count:
 * on a seeded place the result is the net change over the run. A `_budget` seeded with `k`
 * units whose every unit came back reads **0**, not `k`; one with a unit still out reads -1.
 * Only on a place nothing seeds is it the number of tokens left resting there. The halted-run
 * assertions use it that way on `_halt`, which nothing seeds and nothing consumes
 * (`compiler/compile.ts`), in place of the `_halt_reap` firing they used to count. For the
 * final count of a seeded place, read the returned marking instead.
 */
export function tokensResting(store: InMemoryEventStore, place: string): number {
  let n = 0;
  for (const e of store.events()) {
    if (e.type === 'token-added' && e.placeName === place) n += 1;
    if (e.type === 'token-removed' && e.placeName === place) n -= 1;
  }
  return n;
}
