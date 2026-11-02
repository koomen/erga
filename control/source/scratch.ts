// A merge's scratch refs (refs.ts SCRATCH): Artifacts sends only what a branch's head reaches, so a merge (and a
// fork's seed) sets a ref on the commit it needs, fetches, and deletes the ref. Artifacts can be busy for a moment, at
// the delete too, so the delete is tried again; and a ref a merge left (the Worker stopped, Artifacts stayed busy) is
// deleted the next time the Ops page reads the branches. A ref's name holds the time it was made, so only refs older
// than SCRATCH_KEPT go: a merge that runs now keeps its own.

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { emptyPack, ZERO } from "./git.ts";
import { receivePack, transient, type Remote } from "./remote.ts";
import { SCRATCH } from "./refs.ts";

/** How old a scratch ref is before the sweep deletes it: a merge's fetch takes seconds. */
const SCRATCH_KEPT = 10 * 60_000;
/** A push that failed for a moment is tried again 3 times, 0.5, 1 and 2 seconds later. */
export const RETRY = { schedule: Schedule.exponential("500 millis"), times: 3, while: transient };

/** `push` run again while Artifacts is busy (RETRY). */
export const retried = <T>(push: () => Promise<T>): Promise<T> =>
  Effect.runPromise(Effect.tryPromise({ try: push, catch: (e) => e as Error }).pipe(Effect.retry(RETRY)));

/** Deletes the ref `ref` at `commit`; what Artifacts refused, or "ok". */
async function drop(remote: Remote, ref: string, commit: string): Promise<string> {
  const r = await retried(() => receivePack(remote, [{ ref, old: commit, new: ZERO }], null));
  return r.unpack != "ok" ? r.unpack : (r.refs.get(ref) ?? "no answer");
}

/** Runs `work` with a scratch ref on `commit` (none when `commit` is null), and deletes the ref after, however it ends. */
export async function withScratch<T>(remote: Remote, commit: string | null, work: () => Promise<T>, now = Date.now()): Promise<T> {
  if (!commit) return work();
  const ref = `${SCRATCH}${now.toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  try {
    // Not tried again here: a check is, whole (features.ts); a Merge that fails says so, and Merge again tries it.
    await receivePack(remote, [{ ref, old: ZERO, new: commit }], await emptyPack());
    return await work();
  } finally {
    await drop(remote, ref, commit).catch(() => {});
  }
}

/** Deletes the scratch refs in `refs` older than SCRATCH_KEPT, and those named before their names held a time. */
export async function sweepScratch(remote: Remote, refs: Map<string, string>, now = Date.now()): Promise<string[]> {
  const stale = [...refs].filter(([ref]) => {
    if (!ref.startsWith(SCRATCH)) return false;
    const made = /^([0-9a-z]+)-/.exec(ref.slice(SCRATCH.length));
    return !made || now - parseInt(made[1], 36) > SCRATCH_KEPT;
  });
  const gone: string[] = [];
  for (const [ref, commit] of stale) if ((await drop(remote, ref, commit).catch(() => "")) == "ok") gone.push(ref);
  return gone;
}
