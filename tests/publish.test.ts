// deploy/publish.ts: a commit from this machine into Erga's source (staging,
// then main, only forward) and the servers told, against a local bare repo
// standing in for Artifacts and a stand-in for the servers' hooks.
//
//   bun test tests/publish.test.ts

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchErga, pushToErga, type Deps } from "../deploy/publish";

const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode != 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "erga-publish-"));
  const remote = join(root, "erga.git"), work = join(root, "work");
  sh(root, "init", "-q", "--bare", "-b", "main", remote);
  sh(root, "init", "-q", "-b", "main", work);
  const commit = (msg: string, file = "f.txt") => { writeFileSync(join(work, file), msg); sh(work, "add", "."); sh(work, "commit", "-qm", msg); return sh(work, "rev-parse", "HEAD"); };
  const told: { target: string; branch: string; commit: string }[] = [];
  const deps: Deps = {
    cwd: work,
    remote: async () => ({ url: remote }),
    tell: async (target, body) => { told.push({ target, branch: body.branch, commit: body.commit }); return { ok: target != "production" || !failProd.on, said: failProd.on ? "This server couldn't read main's head in its repository." : "ok" }; },
    log: () => {},
  };
  const failProd = { on: false };
  const head = (b: string) => sh(remote, "rev-parse", "-q", "--verify", `refs/heads/${b}`);
  return { remote, work, commit, told, deps, head, failProd };
}

describe("deploy/publish.ts", () => {
  test("into an empty repo: staging, then main; both servers told", async () => {
    const t = setup();
    const a = t.commit("one");
    const r = await pushToErga(t.deps, "HEAD");
    expect(r.state).toBe("pushed");
    expect(t.head("staging")).toBe(a);
    expect(t.head("main")).toBe(a);
    expect(t.told).toEqual([{ target: "staging", branch: "staging", commit: a }, { target: "production", branch: "main", commit: a }]);
  });

  test("forward only; up to date tells nobody", async () => {
    const t = setup();
    t.commit("one");
    await pushToErga(t.deps, "HEAD");
    const b = t.commit("two");
    expect((await pushToErga(t.deps, "HEAD")).state).toBe("pushed");
    expect(t.head("main")).toBe(b);
    t.told.length = 0;
    const again = await pushToErga(t.deps, "HEAD");
    expect(again.state).toBe("up-to-date");
    expect(t.told).toEqual([]);
  });

  test("Erga ahead (a merge on /source): nothing to do; the fetch gives erga/staging to merge", async () => {
    const t = setup();
    const a = t.commit("one");
    const b = t.commit("two");
    sh(t.work, "push", "-q", t.remote, `${b}:refs/heads/staging`, `${b}:refs/heads/main`);
    sh(t.work, "reset", "-q", "--hard", a);
    const r = await pushToErga(t.deps, "HEAD");
    expect(r.state).toBe("behind");
    expect(t.head("main")).toBe(b);
    expect(t.told).toEqual([]);
    expect(await fetchErga(t.deps)).toEqual(["erga/staging"]);
    expect(sh(t.work, "rev-parse", "erga/staging")).toBe(b);
  });

  test("diverged from Erga's staging: refused, nothing moves", async () => {
    const t = setup();
    const a = t.commit("one");
    const s = t.commit("only on staging");
    sh(t.work, "push", "-q", t.remote, `${s}:refs/heads/staging`, `${a}:refs/heads/main`);
    sh(t.work, "reset", "-q", "--hard", a);
    t.commit("only here", "g.txt");
    const r = await pushToErga(t.deps, "HEAD");
    expect(r.state).toBe("diverged");
    expect(r.said[0]).toContain("merge erga/staging");
    expect(t.head("staging")).toBe(s);
    expect(t.head("main")).toBe(a);
    // Merged in (as the task queue does), it goes.
    sh(t.work, "merge", "-q", "--no-edit", s);
    expect((await pushToErga(t.deps, "HEAD")).state).toBe("pushed");
    expect(t.head("main")).toBe(sh(t.work, "rev-parse", "HEAD"));
  });

  test("a server that doesn't take it is named", async () => {
    const t = setup();
    t.commit("one");
    t.failProd.on = true;
    const r = await pushToErga(t.deps, "HEAD");
    expect(r.state).toBe("untold");
    expect(r.untold).toEqual(["production"]);
    expect(r.said.join(" ")).toContain("erga.dev didn't take it");
  });
});
