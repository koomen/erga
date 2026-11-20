// Auto-deploy (`bun erga --auto-deploy`): for each instance, one state value and one pure step. The ops page's server
// (ops-page.ts) keeps the values, tells each one what it sees (the head of the branch that the instance tracks, as its
// repository last answered, and the commit that the instance runs), and starts `bun erga deploy <head> <host>` when a
// step asks for it: one job at a time. The job's end is an event back in. The deploy is the same command as a
// person's, with the same gate: it runs no commit whose tests did not pass (gate.ts).
//
// A head is tried one time. A deploy that failed stays failed: no retry. The instance's own jobs say which heads were
// tried (deploy/deployer/instance.ts), so a restart of the page, or `bun erga rollback`, does not deploy the same commit again. A new commit
// on the branch, or a deploy by hand, starts it again. An instance that a deployer in its own account deploys (its row
// says that one looked in the last minutes, with auto-deploy on) is left to that deployer: one deployer at a time.
// When that deployer stops looking, or its switch goes off, this page's auto-deploy has the instance again.
// A branch that was written again (a force push: its head does
// not have the commit that runs) stops too: a person accepts it with `bun erga deploy <host>`.

/** idle: nothing to do. due: `head` waits for the one job slot. deploying: its job runs. failed: it stopped at `head`. */
export type Auto =
  /** `done`: the last head that this page handled (it deployed it, or found that the instance runs it). */
  | { at: "idle"; done: string | null }
  | { at: "due"; head: string }
  /** `newer`: a head that landed while the deploy runs: it goes next. */
  | { at: "deploying"; head: string; newer: string | null }
  | { at: "failed"; head: string; why: string }
  /** A deployer in the instance's own account deploys it: this page's auto-deploy leaves it (one deployer at a time). */
  | { at: "cloud" };

export type AutoEvent =
  /**
   * What the page sees now. `head`: the branch's head (null: its repository gave none). `runs`: the commit that the
   * instance answers, its first 12 characters (null: no answer). `tried`: a job record of this instance has the head.
   * `rewritten`: the head does not have the commit that runs in its history. `cloud`: the instance's own row says that
   * a deployer in its account looked in the last minutes, with auto-deploy on.
   */
  | { type: "seen"; head: string | null; runs: string | null; tried: boolean; rewritten: boolean; cloud: boolean }
  /** No job runs: a due instance may start its deploy. */
  | { type: "free" }
  /** The deploy that this instance started ended. `why`: its error. */
  | { type: "ended"; ok: boolean; why?: string };

export const startAuto = (): Auto => ({ at: "idle", done: null });

/** Why an instance whose branch was written again stopped. A new commit does not start it again: a deploy by hand does. */
export const REWRITTEN = "Its branch was written again: the new head does not have the commit that runs.";

/** The new state, and the commit to deploy now, or null. */
export function stepAuto(s: Auto, e: AutoEvent): { auto: Auto; deploy: string | null } {
  const to = (auto: Auto, deploy: string | null = null) => ({ auto, deploy });
  switch (e.type) {
    case "free":
      return s.at == "due" ? to({ at: "deploying", head: s.head, newer: null }, s.head) : to(s);
    case "ended":
      if (s.at != "deploying") return to(s);
      if (s.newer) return to({ at: "due", head: s.newer });
      return to(e.ok ? { at: "idle", done: s.head } : { at: "failed", head: s.head, why: e.why ?? "The deploy failed." });
    case "seen": {
      // The cloud's deployer has the instance: nothing is due here. (A deploy that this page started ends first.)
      if (e.cloud && s.at != "deploying") return to({ at: "cloud" });
      if (s.at == "cloud") return stepAuto(startAuto(), e);
      if (!e.head || !e.runs) return to(s);
      if (s.at == "deploying") return to(e.head == s.head ? s : { ...s, newer: e.head });
      // The instance runs the head, or the head was tried before (by this page, or a job record has it): nothing to
      // do. A failed head stays failed.
      if (e.head.startsWith(e.runs)) return to({ at: "idle", done: e.head });
      if (s.at == "failed" && s.head == e.head) return to(s);
      if (s.at == "idle" && s.done == e.head) return to(s);
      if (e.tried) return to({ at: "idle", done: e.head });
      if (e.rewritten) return to({ at: "failed", head: e.head, why: REWRITTEN });
      return to({ at: "due", head: e.head });
    }
  }
}
