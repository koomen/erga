// Work that runs later, in a fiber of its own, which can be stopped before it runs: the document's timers (its idle
// close, its versions' cut), as Effect fibers, so a test's clock and an interruption reach them.

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Runs `then` in `ms`, in a fiber of its own; `more`, asked then, may wait
 * longer first (again and again: while an agent works, its milliseconds).
 */
export function later(ms: number, then: () => void, more: () => number = () => 0): Fiber.Fiber<void> {
  const run = Effect.gen(function* () {
    yield* Effect.sleep(ms);
    for (let wait = more(); wait > 0; wait = more()) yield* Effect.sleep(wait);
    then();
  });
  return Effect.runFork(run);
}

/** A fiber of `later` that hasn't run yet doesn't. */
export const stop = (fiber: Fiber.Fiber<void>) => void Effect.runFork(Fiber.interrupt(fiber));
