// Auto-deploy's state for one instance (deploy/cli/auto-state.ts), a pure step: a new head of its branch is due, a due
// one deploys when no job runs, a commit that lands during the deploy goes next, a failed deploy stays failed until a
// new commit or a deploy by hand, a head that was tried before is not tried again, and a branch that was written
// again stops it.

import { expect, test } from "bun:test";
import { type Auto, type AutoEvent, autoText, stepAuto } from "../deploy/cli/auto-state";

const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
/** What the page sees: the branch's head, and the commit that the instance runs (as it answers: 12 characters). */
const seen = (head: string | null, runs: string | null, more: { tried?: boolean; rewritten?: boolean } = {}): AutoEvent => ({
  type: "seen",
  head,
  runs: runs?.slice(0, 12) ?? null,
  tried: false,
  rewritten: false,
  ...more,
});
/** The states after each event, and each deploy that a step asked for. */
const run = (from: Auto, ...events: AutoEvent[]) => {
  const deploys: string[] = [];
  const states = events.map((e) => {
    const r = stepAuto(from, e);
    from = r.auto;
    if (r.deploy) deploys.push(r.deploy);
    return from.at;
  });
  return { auto: from, states, deploys };
};
const IDLE: Auto = { at: "idle", done: null };

test("a new head is due, deploys when no job runs, and the instance is idle again when its deploy ends", () => {
  const r = run(
    IDLE,
    seen(A, A),
    seen(B, A),
    seen(B, A),
    { type: "free" },
    seen(B, A, { tried: true }),
    { type: "ended", ok: true },
    seen(B, B)
  );
  expect(r.states).toEqual(["idle", "due", "due", "deploying", "deploying", "idle", "idle"]);
  expect(r.deploys).toEqual([B]);
  // A free slot starts nothing for an instance that is not due.
  expect(stepAuto(IDLE, { type: "free" })).toEqual({ auto: IDLE, deploy: null });
});

test("without the branch's head or the instance's commit, nothing is due", () => {
  expect(run(IDLE, seen(null, A), seen(B, null)).states).toEqual(["idle", "idle"]);
  // A due head that its repository no longer answers stays due: the deploy asks the repository itself.
  expect(run({ at: "due", head: B }, seen(null, A)).auto).toEqual({ at: "due", head: B });
});

test("a commit that lands during a deploy goes next: only the newest one", () => {
  const r = run(
    IDLE,
    seen(A, "0".repeat(40)),
    { type: "free" },
    seen(B, "0".repeat(40)),
    seen(C, A),
    { type: "ended", ok: true },
    { type: "free" }
  );
  expect(r.states).toEqual(["due", "deploying", "deploying", "deploying", "due", "deploying"]);
  expect(r.deploys).toEqual([A, C]);
  expect(r.auto).toEqual({ at: "deploying", head: C, newer: null });
  // While a head is due, a newer head takes its place.
  expect(run({ at: "due", head: A }, seen(B, "0".repeat(40))).auto).toEqual({ at: "due", head: B });
});

test("a failed deploy stays failed, with its reason: no retry; a new commit or a deploy by hand starts again", () => {
  const failed = run(IDLE, seen(B, A), { type: "free" }, { type: "ended", ok: false, why: "1 test failed" });
  expect(failed.auto).toEqual({ at: "failed", head: B, why: "1 test failed" });
  expect(failed.deploys).toEqual([B]);
  // The same head, tried: nothing deploys, whatever happens.
  expect(run(failed.auto, seen(B, A, { tried: true }), { type: "free" }, seen(B, A, { tried: true })).deploys).toEqual([]);
  expect(run(failed.auto, seen(B, A, { tried: true }), { type: "free" }).auto).toEqual(failed.auto);
  // A new commit: due again.
  expect(run(failed.auto, seen(C, A)).auto).toEqual({ at: "due", head: C });
  // A deploy by hand: the instance runs the head.
  expect(run(failed.auto, seen(B, B, { tried: true })).auto).toEqual({ at: "idle", done: B });
  // A newer commit that landed during the failed deploy goes next.
  expect(run({ at: "deploying", head: A, newer: B }, { type: "ended", ok: false, why: "x" }).auto).toEqual({ at: "due", head: B });
});

test("a head that was tried before is not tried again: after a restart, or after a rollback", () => {
  // A job record of this instance has the head (it deployed, and the instance was rolled back; or it failed).
  const r = run(IDLE, seen(B, A, { tried: true }), { type: "free" });
  expect(r.states).toEqual(["idle", "idle"]);
  expect(r.deploys).toEqual([]);
  expect(run(IDLE, seen(C, A)).auto).toEqual({ at: "due", head: C });
  // The page remembers the head that it deployed: a rollback after it deploys nothing, also with no job record.
  const rolledBack = run(IDLE, seen(B, A), { type: "free" }, { type: "ended", ok: true }, seen(B, A), { type: "free" });
  expect(rolledBack.auto).toEqual({ at: "idle", done: B });
  expect(rolledBack.deploys).toEqual([B]);
});

test("a branch that was written again stops: the new head does not have the commit that runs", () => {
  const r = run(IDLE, seen(B, A, { rewritten: true }), { type: "free" });
  expect(r.auto.at).toBe("failed");
  expect((r.auto as { why: string }).why).toContain("was written again");
  expect(r.deploys).toEqual([]);
  // A deploy by hand accepts it.
  expect(run(r.auto, seen(B, B)).auto).toEqual({ at: "idle", done: B });
});

test("each state in a few words, for the page", () => {
  const at = { head: B, runs: A.slice(0, 12) };
  expect(autoText(IDLE, { head: A, runs: A.slice(0, 12) })).toBe("idle");
  expect(autoText(IDLE, { head: null, runs: null })).toBe("idle");
  expect(autoText(IDLE, at)).toBe("waits for a new commit");
  expect(autoText({ at: "due", head: B }, at)).toBe("bbbbbbb is next");
  expect(autoText({ at: "deploying", head: B, newer: null }, at)).toBe("deploys bbbbbbb");
  expect(autoText({ at: "failed", head: B, why: "x" }, at)).toBe("failed at bbbbbbb");
});
