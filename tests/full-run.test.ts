// The whole suite after a merge (deploy/cli/full-run.ts), on a real clone with a fake suite: its state file, the
// names of the failed tests from e2e's report, one run at a time, and a run that waited is skipped for a newer commit.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../deploy/cli/deploy";
import { fullPath, fullRun, readFullRuns, resultOf, type Suite } from "../deploy/cli/full-run";

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** A clone whose origin/staging has two commits: [first, head]. */
function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "erga-fullrun-")));
  const [origin, clone] = [join(top, "origin.git"), join(top, "clone")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, clone);
  sh(clone, "git", "switch", "--quiet", "-c", "staging");
  const commit = (text: string) => {
    writeFileSync(join(clone, "a.txt"), text);
    sh(clone, "git", "add", "-A");
    sh(clone, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
    return sh(clone, "git", "rev-parse", "HEAD");
  };
  const shas = [commit("one"), commit("two")];
  sh(clone, "git", "push", "--quiet", "origin", "staging");
  return { clone, dir: join(clone, ".erga"), shas };
}

const result = (status: string, title: string, selected = true) => ({
  file: "e2e/full/a.e2e.ts",
  titlePath: ["group", title],
  status,
  selected,
});
const REPORT = {
  run: { results: [result("passed", "one"), result("failed", "two"), result("timedOut", "three"), result("skipped", "four", false)] },
};

test("the failed tests of e2e's report, by file and title; a test that did not run does not count", () => {
  expect(resultOf(REPORT)).toEqual({ total: 3, failed: ["e2e/full/a.e2e.ts: group › two", "e2e/full/a.e2e.ts: group › three"] });
  expect(resultOf(null)).toEqual({ total: 0, failed: [] });
});

test("a run tests the commit in a folder of its own, and its file says running, then the result", async () => {
  const w = world();
  let during = "";
  const run: Suite = (at) => {
    during = `${readFullRuns(w.dir)[0].state} ${readFileSync(join(at, "a.txt"), "utf8")} ${sh(at, "git", "rev-parse", "HEAD") == w.shas[0]}`;
    return { ok: false, out: "2 failed\nFAILED (9 s)", report: REPORT };
  };
  const said: string[] = [];
  const r = await fullRun({ dir: w.dir, clone: w.clone, sha: w.shas[0], log: (l) => said.push(l), run });
  expect(during).toBe("running one true");
  expect([r.state, r.total, r.failed.length]).toEqual(["failed", 3, 2]);
  expect(said.join("\n")).toContain("FAIL  e2e/full/a.e2e.ts: group › two");
  expect(JSON.parse(readFileSync(fullPath(w.dir, w.shas[0]), "utf8"))).toEqual(r);
  expect(readFileSync(r.log, "utf8")).toContain("FAILED (9 s)");
  // The scratch folder is gone, and the lock is free.
  expect(sh(w.clone, "git", "worktree", "list").split("\n").length).toBe(1);
  expect(existsSync(join(w.dir, "jobs", "full-suite.lock"))).toBe(false);

  const passed = await fullRun({
    dir: w.dir,
    clone: w.clone,
    sha: w.shas[1],
    log: () => {},
    run: () => ({ ok: true, out: "all passing (1 s)", report: REPORT }),
  });
  expect([passed.state, passed.failed]).toEqual(["passed", []]);
  expect(readFullRuns(w.dir).map((x) => x.state)).toEqual(["failed", "passed"]);
  // A run that broke before a test result says why.
  const broke = await fullRun({
    dir: w.dir,
    clone: w.clone,
    sha: w.shas[1],
    log: () => {},
    run: () => ({ ok: false, out: "bun install failed: no network", report: null }),
  });
  expect([broke.state, broke.note]).toEqual(["failed", "bun install failed: no network"]);
});

test("one run at a time: a run that waited is skipped when staging has a newer commit, and runs when it is the head", async () => {
  const w = world();
  let ran = 0;
  const run: Suite = () => (ran++, { ok: true, out: "all passing (1 s)", report: REPORT });
  const waits = async (sha: string) => {
    const free = takeLock(w.dir, "full-suite", "bun erga full other");
    const p = fullRun({ dir: w.dir, clone: w.clone, sha, log: () => {}, run, waitMs: 5 });
    await Bun.sleep(0);
    expect(readFullRuns(w.dir).find((x) => x.sha == sha)?.state).toBe("waiting");
    free();
    return p;
  };
  const old = await waits(w.shas[0]);
  expect([old.state, old.note, ran]).toEqual(["skipped", `staging moved to ${w.shas[1].slice(0, 12)} before its turn`, 0]);
  expect((await waits(w.shas[1])).state).toBe("passed");
  expect(ran).toBe(1);
});

test("a run with no end whose process is gone has stopped", async () => {
  const w = world();
  await fullRun({
    dir: w.dir,
    clone: w.clone,
    sha: w.shas[0],
    log: () => {},
    run: () => ({ ok: true, out: "all passing", report: REPORT }),
  });
  const file = fullPath(w.dir, w.shas[0]);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "running", ended: undefined }));
  expect(readFullRuns(w.dir, () => true)[0].state).toBe("running");
  expect(readFullRuns(w.dir, () => false)[0].state).toBe("stopped");
});
