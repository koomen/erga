// Auto-deploy on the ops page's server (`bun erga --auto-deploy`, deploy/cli/ops-page.ts), with fake repositories, instances
// and a fake `bun erga`: an instance that does not run its branch's head gets `bun erga deploy <head> <host>`, one job
// at a time, from "auto-deploy"; a failed one stays failed, with its reason on its page; a head that a job record has is not
// tried again; a branch that was written again stops; and without --auto-deploy nothing deploys. The state's rules are
// tests/auto-state.test.ts.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../deploy/cli/config";
import { serveOpsPage } from "../deploy/cli/ops-page";

const entry = (host: string, branch: string): Entry => ({
  host,
  repo: "example.net/team/erga",
  branch,
  account: "a",
  worker: "w",
  database: "d",
  app: { kind: "workers.dev" },
  pages: { kind: "shared" },
  vars: {},
});

/** A clone with three commits in a line, and one apart from them. */
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-auto-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const commit = (m: string) => (
    git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "--allow-empty", "-m", m), git("rev-parse", "HEAD")
  );
  const [c1, c2, c3] = [commit("Change 1"), commit("Change 2"), commit("Change 3")];
  git("checkout", "--quiet", "--detach", c1);
  const side = commit("A commit that the branch no longer has");
  mkdirSync(join(dir, ".erga/jobs"), { recursive: true });
  return { dir, c1, c2, c3, side };
}

test("auto-deploy: each instance behind its branch's head deploys it, one job at a time; failed, tried and rewritten ones stop", async () => {
  const { dir, c1, c2, c3, side } = world();
  const hosts = ["a", "b", "tried", "rewritten", "silent", "current"].map((n) => `${n}.example.net`);
  writeFileSync(
    join(dir, ".erga/config.json"),
    JSON.stringify({ instances: [entry(hosts[0], "main"), entry(hosts[1], "staging"), ...hosts.slice(2).map((h) => entry(h, "main"))] })
  );
  // A job record: the head of main was deployed to tried.example.net before, and failed.
  writeFileSync(
    join(dir, ".erga/jobs/2026-11-05T10-00-00-000Z-tried.example.net-1.jsonl"),
    [
      {
        command: "bun erga deploy tried.example.net",
        host: "tried.example.net",
        from: "terminal",
        pid: 1,
        started: "2026-11-05T10:00:00.000Z",
      },
      { commit: c3 },
      { result: "failed", error: "the health check fails", ended: "2026-11-05T10:01:00.000Z" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
  );
  const runs: Record<string, string | null> = {
    "a.example.net": c1,
    "b.example.net": c1,
    "tried.example.net": c2,
    "rewritten.example.net": side,
    "silent.example.net": null,
    "current.example.net": c3,
  };
  const asked: string[][] = [];
  const started: string[][] = [];
  let end = (_: { code: number; out: string }) => {};
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    autoDeploy: true,
    fetch: async () => null,
    heads: async (_cwd, repo, branches) => (asked.push([repo, ...branches]), { heads: { main: c3, staging: c2 }, error: null }),
    ask: async (e) => ({ version: runs[e.host]?.slice(0, 12) ?? null, healthy: runs[e.host] ? true : null }),
    run: (args, from) => {
      started.push([...args, from]);
      return { pid: 999_000 + started.length, done: new Promise((done) => (end = done)) };
    },
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const view = async (host = hosts[0]) => (await fetch(`${at}/view?hash=${host}`)).text();
  const until = async (ok: (html: string) => boolean) => {
    for (let i = 0; i < 200 && !ok(await view()); i++) await Bun.sleep(20);
    return view();
  };
  /** Each instance's word in the list, by the first part of its host: "" when it has none. (The verify suite's entry is after the list.) */
  const words = (html: string) =>
    Object.fromEntries(
      [...html.slice(0, html.indexOf('<p class="side-auto"')).matchAll(/href="#([^".]+)[^"]*".*?<\/a>/g)].map((m) => [
        m[1],
        /class="g-state \w+"[^>]*>([^<]*)</.exec(m[0])?.[1] ?? "",
      ])
    );
  try {
    // One check of the one repository, for both branches. The first instance in the file deploys; the next one waits.
    const first = await until((h) => h.includes(">deploying<"));
    expect(asked).toEqual([["example.net/team/erga", "main", "staging"]]);
    expect(started).toEqual([["deploy", c3.slice(0, 12), "a.example.net", "auto-deploy"]]);
    expect(words(first)).toEqual({ a: "deploying", b: "1 behind", tried: "1 behind", rewritten: "failed", silent: "", current: "" });
    expect(first).toContain("<span>Auto-deploy is on</span>");
    // An instance whose auto-deploy stopped says why on its own page, and no other page does.
    expect(await view("rewritten.example.net")).toContain(
      `Auto-deploy stopped at ${c3.slice(0, 7)}: Its branch was written again: the new head does not have the commit that runs. To accept the new head: bun erga deploy rewritten.example.net`
    );
    expect(first.slice(first.indexOf('<section class="main"'))).not.toContain("Auto-deploy stopped");
    expect(first).toContain('data-source="repo example.net/team/erga"');

    // Its deploy fails: it stays failed, with the reason, and the next instance's deploy starts.
    end({ code: 1, out: "FAIL  1 test failed on 333\n" });
    const second = await until((h) => words(h).b == "deploying");
    expect(started.slice(1)).toEqual([["deploy", c2.slice(0, 12), "b.example.net", "auto-deploy"]]);
    expect(words(second)).toMatchObject({ a: "failed", b: "deploying" });
    expect(second).toContain(
      `Auto-deploy stopped at ${c3.slice(0, 7)}: FAIL  1 test failed on 333 A new commit on main starts it again, or Deploy on its row.`
    );

    // It ends well: nothing more deploys. The failed head, the tried one and the rewritten branch are not tried again.
    runs["b.example.net"] = c2;
    end({ code: 0, out: "" });
    const last = await until((h) => !h.includes(">deploying<"));
    expect(words(last)).toMatchObject({ a: "failed", tried: "1 behind" });
    expect(started.length).toBe(2);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without --auto-deploy, the page deploys nothing: it asks the repository for the commits only", async () => {
  const { dir, c1, c3 } = world();
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [entry("a.example.net", "main")] }));
  const started: string[][] = [];
  let asked = 0;
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    fetch: async () => null,
    heads: async () => (asked++, { heads: { main: c3 }, error: null }),
    ask: async () => ({ version: c1.slice(0, 12), healthy: true }),
    run: (args) => (started.push(args), { pid: 1, done: new Promise(() => {}) }),
  });
  try {
    const view = async () => (await fetch(`http://127.0.0.1:${page.server.port}/view?hash=a.example.net`)).text();
    for (let i = 0; i < 200 && !(await view()).includes("2 behind"); i++) await Bun.sleep(20);
    const html = await view();
    expect(html).toContain("<span>Auto-deploy is off</span>");
    expect(html).toContain('class="g-state behind"');
    expect([started, asked]).toEqual([[], 1]);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository's heads: the clone keeps each tracked head under its own ref, and says why a repository gave none", async () => {
  const { repoHeads, trackedRef } = await import("../deploy/cli/observe");
  const { commit, gitWorld, sh } = await import("./helpers/git-world.ts");
  const { top, origin, clone, base } = gitWorld("erga-heads-");
  try {
    // Another clone pushes a commit: this clone has not fetched it.
    const other = join(top, "other");
    sh(top, "git", "clone", "--quiet", origin, other);
    const next = commit(other, "b.txt", "two");
    sh(other, "git", "push", "--quiet", "origin", "staging");
    const ref = trackedRef(origin, "staging");
    expect(ref).toMatch(/^refs\/erga\/[\w.-]+\/staging$/);
    expect(await repoHeads(clone, origin, ["staging", "nope"])).toEqual({ heads: { staging: next }, error: null });
    // The clone has the commit now, under a ref that no push sends; its checkout did not move.
    expect(sh(clone, "git", "rev-parse", ref)).toBe(next);
    expect(sh(clone, "git", "rev-parse", "HEAD")).toBe(base);
    expect(sh(clone, "git", "log", "--format=%s", "-n", "2", next)).toBe("two\none");
    // A repository that this machine can't read: git's own words.
    const none = await repoHeads(clone, join(top, "nowhere.git"), ["staging"]);
    expect(none.heads).toEqual({});
    expect(none.error).toContain("nowhere.git");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
