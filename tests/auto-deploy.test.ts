// Auto-deploy on the ops page's server (`bun erga --auto-deploy`, deploy/cli/ops-page.ts), with fake repositories, instances
// and a fake `bun erga`: an instance that does not run its branch's head gets `bun erga deploy <head> <host>`, one job
// at a time, from "auto-deploy"; a failed one stays failed, with its reason on the page; a head that a job record has is not
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
  /** Each instance's state, from its column's head. */
  const states = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/data-auto-host="([^"]+)" data-auto="(\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1].split(".")[0], `${m[2]}: ${m[3]}`])
    );
  try {
    // One check of the one repository, for both branches. The first instance in the file deploys; the next one waits.
    const first = await until((h) => h.includes('data-auto="deploying"'));
    expect(asked).toEqual([["example.net/team/erga", "main", "staging"]]);
    expect(started).toEqual([["deploy", c3.slice(0, 12), "a.example.net", "auto-deploy"]]);
    expect(states(first)).toEqual({
      a: `deploying: auto: deploys ${c3.slice(0, 7)}`,
      b: `due: auto: ${c2.slice(0, 7)} is next`,
      tried: "idle: auto: waits for a new commit",
      rewritten: `failed: auto: failed at ${c3.slice(0, 7)}`,
      silent: "idle: auto: idle",
      current: "idle: auto: idle",
    });
    expect(first).toContain("Auto-deploy is on.");
    expect(first).toContain(
      "Auto-deploy of rewritten.example.net stopped: Its branch was written again: the new head does not have the commit that runs. To accept the new head: bun erga deploy rewritten.example.net"
    );
    expect(first).toMatch(/data-source="repo example.net\/team\/erga">.*main [0-9a-f]{7} · staging [0-9a-f]{7}/);

    // Its deploy fails: it stays failed, with the reason, and the next instance's deploy starts.
    end({ code: 1, out: "FAIL  1 test failed on 333\n" });
    const second = await until((h) => h.includes(`deploys ${c2.slice(0, 7)}`));
    expect(started.slice(1)).toEqual([["deploy", c2.slice(0, 12), "b.example.net", "auto-deploy"]]);
    expect(states(second)).toMatchObject({
      a: `failed: auto: failed at ${c3.slice(0, 7)}`,
      b: `deploying: auto: deploys ${c2.slice(0, 7)}`,
    });
    expect(second).toContain("Auto-deploy of a.example.net stopped: FAIL  1 test failed on 333");
    expect(second).toContain("A new commit on main starts it again, or: bun erga deploy a.example.net");

    // It ends well: nothing more deploys. The failed head, the tried one and the rewritten branch are not tried again.
    runs["b.example.net"] = c2;
    end({ code: 0, out: "" });
    const last = await until((h) => !h.includes('data-auto="deploying"'));
    expect(states(last)).toMatchObject({ a: `failed: auto: failed at ${c3.slice(0, 7)}`, tried: "idle: auto: waits for a new commit" });
    expect(started.length).toBe(2);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without --auto-deploy, the page deploys nothing and asks no repository", async () => {
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
    for (let i = 0; i < 200 && !(await view()).includes("healthy"); i++) await Bun.sleep(20);
    const html = await view();
    expect(html).toContain("Auto-deploy is off: <code>bun erga --auto-deploy</code> turns it on.");
    expect(html).not.toContain("data-auto=");
    expect([started, asked]).toEqual([[], 0]);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
