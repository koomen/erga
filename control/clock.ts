// The control Worker's waits (polls, retries, a deploy's wait for its new
// version) are Effect Schedules, and they wait on Effect's Clock. A test, and
// the mock Cloudflare, give a sleep of their own so the waits go by at once:
// `clockOf` is the Clock that sleeps with it.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** How a caller waits: by default, the real time. */
export type Sleep = (ms: number) => Promise<void>;

/** The Clock that tells the real time and sleeps with `sleep`. */
export function clockOf(sleep: Sleep): Clock.Clock {
  const real = Clock.Clock.defaultValue();
  return {
    currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe(),
    currentTimeMillis: real.currentTimeMillis,
    currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
    currentTimeNanos: real.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (d) => Effect.promise(() => sleep(Duration.toMillis(d))),
  };
}

/** Runs `effect` as a promise; with `sleep`, on the Clock that sleeps with it. */
export const runWith = <A, E>(sleep: Sleep | undefined, effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(sleep ? Effect.provideService(effect, Clock.Clock, clockOf(sleep)) : effect);
