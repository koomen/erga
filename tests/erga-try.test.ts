// `bun erga try <branch>` (deploy/cli/try.ts), in a clone of a bare origin, with GitHub's run faked: the branch's merge
// with staging goes onto verify as one commit, under a lock that is a ref on the origin, one try at a time; the lock
// goes at the end, and an old one is taken over.

import { expect, test } from "bun:test";
import { LOCK, LOCK_MS, lockStep, type Run, tryBranch } from "../deploy/cli/try";
import { commit, gitWorld, sh } from "./helpers/git-world.ts";

// (git commit-tree takes the person from the environment: the tests' machine may have none.)
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

const DONE: Run = { status: "completed", conclusion: "success", url: "https://github.example/run/1" };
const REPO = "Example/Erga";

/** A clone whose origin has staging and the branch `task`, one commit ahead of it. */
function world() {
  const w = gitWorld("erga-try-");
  sh(w.clone, "git", "switch", "--quiet", "-c", "task");
  const task = commit(w.clone, "b.txt", "the task's change");
  sh(w.clone, "git", "push", "--quiet", "origin", "task");
  /** A ref of the origin: its commit, or "". */
  const at = (ref: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: w.origin }).stdout.toString().trim();
  return { ...w, task, at, of: (format: string, ref: string) => sh(w.origin, "git", "log", "-1", `--format=${format}`, ref) };
}

/** A try in the clone: what it said, its result or its error. No pause takes time. */
async function attempt(clone: string, branch: string | undefined, o: Partial<Parameters<typeof tryBranch>[0]> = {}) {
  const said: string[] = [];
  try {
    const r = await tryBranch({
      branch,
      clone,
      repo: REPO,
      log: (l) => said.push(l),
      runOf: async () => DONE,
      pause: async () => {},
      ...o,
    });
    return { said: said.join("\n"), sha: r.sha, release: r.release, error: "" };
  } catch (e) {
    return { said: said.join("\n"), sha: "", release: "", error: (e as Error).message };
  }
}

test("the lock: none is taken, a young one is waited for until it is 30 minutes old, an old one is taken over", () => {
  expect(lockStep(null, 1_000_000)).toEqual({ take: "" });
  expect(lockStep({ sha: "abc", at: 1_000_000, by: "x" }, 1_000_000 + LOCK_MS - 1)).toEqual({ wait: 1_000_000 + LOCK_MS });
  expect(lockStep({ sha: "abc", at: 1_000_000, by: "x" }, 1_000_000 + LOCK_MS)).toEqual({ take: "abc" });
});

test("a try puts the branch's merge with staging on verify as one commit, holds the lock while GitHub runs it, and frees it", async () => {
  const w = world();
  // staging moved since the branch started: the commit on verify is the merge, on staging's head.
  sh(w.clone, "git", "switch", "--quiet", "staging");
  const staging = commit(w.clone, "c.txt", "another task");
  sh(w.clone, "git", "push", "--quiet", "origin", "staging");
  const seen: { lock: string; verify: string }[] = [];
  // No run yet, then a run that goes on, then its end.
  const answers: (Run | null)[] = [null, { ...DONE, status: "in_progress", conclusion: null }, DONE];
  const r = await attempt(w.clone, "task", {
    runOf: async (sha) => {
      seen.push({
        lock: w.at(LOCK) && w.of("%s", LOCK),
        verify: sha == w.at("refs/heads/verify") ? "the try's commit" : w.at("refs/heads/verify"),
      });
      return answers.shift()!;
    },
  });
  expect(r.error).toBe("");
  // GitHub was asked until its run ended, and each time the lock was there, with the try's name, and verify at the commit.
  expect(seen.length).toBe(3);
  expect(new Set(seen.map((s) => s.verify))).toEqual(new Set(["the try's commit"]));
  expect(seen[0].lock).toMatch(/^bun erga try task, by \S+ on \S+$/);
  expect(w.at("refs/heads/verify")).toBe(r.sha);
  expect(w.of("%P", "refs/heads/verify")).toBe(staging);
  expect(w.of("%s", "refs/heads/verify")).toBe("the task's change");
  expect(sh(w.origin, "git", "ls-tree", "--name-only", "refs/heads/verify").split("\n")).toEqual(["a.txt", "b.txt", "c.txt"]);
  // The package is verify's own, in small letters, at the commit.
  expect(r.release).toBe(`ghcr.io/example/erga-verify:${r.sha}`);
  expect(r.said).toContain(`PASS  GitHub tested and built ${r.sha.slice(0, 12)}`);
  expect(r.said).toContain(DONE.url);
  expect(w.at(LOCK)).toBe("");
  // The branches stay where they were.
  expect([w.at("refs/heads/staging"), w.at("refs/heads/task")]).toEqual([staging, w.task]);
});

test("a run that fails, or that GitHub never starts: the try says so with the run's address, and frees the lock", async () => {
  const w = world();
  const failed = await attempt(w.clone, "task", { runOf: async () => ({ ...DONE, conclusion: "failure" }) });
  expect(failed.error).toMatch(/GitHub's run of [0-9a-f]{12} ended with failure: https:\/\/github\.example\/run\/1/);
  expect(w.at(LOCK)).toBe("");
  // No run: it waits until its lock is 30 minutes old, less the time of two looks, and no longer.
  let t = Date.now();
  const start = t;
  const none = await attempt(w.clone, "task", {
    runOf: async () => {
      throw new Error("gh api failed: no network");
    },
    now: () => t,
    pause: async (ms) => void (t += ms),
  });
  expect(none.error).toMatch(/GitHub started no run for [0-9a-f]{12} in 30 minutes\. gh api failed: no network/);
  expect(t - start).toBeGreaterThan(LOCK_MS - 60_000);
  expect(t - start).toBeLessThanOrEqual(LOCK_MS);
  expect(w.at(LOCK)).toBe("");
});

test("a second try waits for the first one's lock, and goes when the first ends", async () => {
  const w = world();
  let end = (_: Run) => {};
  const firstRun = new Promise<Run>((r) => (end = r));
  let holds = () => {};
  const held = new Promise<void>((r) => (holds = r));
  const first = attempt(w.clone, "task", { runOf: () => (holds(), firstRun) });
  await held;
  const firstLock = w.at(LOCK);
  expect(firstLock).not.toBe("");
  // git itself refuses a second lock: a push that asks for "no ref there" (what a try that looked too early sends).
  const raced = Bun.spawnSync(["git", "push", `--force-with-lease=${LOCK}:`, "origin", `HEAD:${LOCK}`], { cwd: w.clone });
  expect([raced.exitCode != 0, /stale info|rejected/.test(raced.stderr.toString())]).toEqual([true, true]);
  expect(w.at(LOCK)).toBe(firstLock);
  let waits = 0;
  const second = await attempt(w.clone, "task", {
    // Its first look finds the lock: then the first try ends, and frees it.
    pause: async () => {
      if (!waits++) {
        expect(w.at(LOCK)).toBe(firstLock);
        end(DONE);
        await first;
      }
    },
  });
  expect(waits).toBe(1);
  expect(second.said).toMatch(/verify is in use: bun erga try task, by \S+ on \S+\. It is free at \S+ at the latest\. This try waits\./);
  expect([(await first).error, second.error]).toEqual(["", ""]);
  expect(w.at("refs/heads/verify")).toBe(second.sha);
  expect(w.at(LOCK)).toBe("");
});

test("a lock older than 30 minutes is taken over; a try whose own lock was taken over leaves the other's", async () => {
  const w = world();
  /** A lock on the origin, made at `time`, as another machine's try left it. */
  const lockAt = (time: number, by: string) => {
    const tree = sh(w.origin, "git", "hash-object", "-t", "tree", "-w", "/dev/null");
    const date = `${Math.floor(time / 1000)} +0000`;
    const made = Bun.spawnSync(["git", "commit-tree", tree, "-m", by], {
      cwd: w.origin,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
      .stdout.toString()
      .trim();
    sh(w.origin, "git", "update-ref", LOCK, made);
    return made;
  };
  const old = lockAt(Date.now() - LOCK_MS - 5000, "bun erga try gone, by x on y");
  let other = "";
  const r = await attempt(w.clone, "task", {
    runOf: async () => {
      // The try has its own lock in the old one's place. Then it is slow, and another machine's try takes it over.
      expect(w.at(LOCK)).not.toBe(old);
      expect(w.of("%s", LOCK)).toMatch(/^bun erga try task/);
      other = lockAt(Date.now(), "bun erga try other, by x on y");
      return DONE;
    },
  });
  expect(r.error).toBe("");
  expect(r.said).not.toContain("verify is in use");
  expect(w.at(LOCK)).toBe(other);
});

test("what a try refuses: no name, a branch that only bun erga moves, one that GitHub does not have, nothing ahead, a conflict", async () => {
  const w = world();
  const refused = async (branch: string | undefined) => {
    const r = await attempt(w.clone, branch);
    // Nothing moved, and no lock stays.
    expect([branch, w.at("refs/heads/verify"), w.at(LOCK)]).toEqual([branch, "", ""]);
    return r.error;
  };
  expect(await refused(undefined)).toBe("Name the branch: bun erga try <branch>.");
  expect(await refused("staging")).toContain("staging is not a feature branch");
  expect(await refused("nowhere")).toContain("There is no branch nowhere on GitHub");
  sh(w.clone, "git", "push", "--quiet", "origin", "origin/staging:refs/heads/same");
  expect(await refused("same")).toContain("has no commits that staging does not have");
  // staging and the branch change the same line.
  sh(w.clone, "git", "switch", "--quiet", "staging");
  commit(w.clone, "b.txt", "staging's own line");
  sh(w.clone, "git", "push", "--quiet", "origin", "staging");
  expect(await refused("task")).toBe(
    "task conflicts with staging in b.txt. Rebase it on origin/staging, fix the conflicts, push it, and try again."
  );
});
