// The ops page's view (deploy/cli/ops-view.ts): a job record read from its lines, the instances with the branch each
// tracks, and the Deploys tab drawn from fake facts, with its Deploy buttons. The page has no feature branch and no
// Merge: `bun erga merge` merges. The page's server (deploy/cli/ops-page.ts) starts a deploy with a fake `bun erga`:
// nothing deploys.

import { expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { type Run, stepRun } from "../deploy/cli/job-state";
import { type Branch, columnsOf, type Facts, jobOf, viewHtml } from "../deploy/cli/ops-view";
import { startPolls } from "../deploy/cli/poll-state";
import { runOf } from "./helpers/pass.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const entry = (host: string, branch = "main", more: Partial<Entry> = {}): Entry => ({
  host,
  repo: "example.net/team/erga",
  branch,
  ...more,
  account: "a",
  worker: "w",
  database: "d",
  app: { kind: "workers.dev" },
  pages: { kind: "shared" },
  vars: {},
});
const line = (x: object) => `${JSON.stringify(x)}\n`;
const start = {
  command: "bun erga deploy example.net",
  host: "example.net",
  from: "terminal",
  pid: 7,
  started: "2026-11-05T11:00:00.000Z",
};

test("a job runs while it has no result and its process lives", () => {
  expect(jobOf(line(start), () => true)?.phase).toBe("running");
  // Its process stopped with no result: it does not run.
  expect(jobOf(line(start), () => false)?.phase).toBe("stopped");
  const ended = jobOf(
    line(start) + line({ commit: "c".repeat(40) }) + line({ result: "failed", error: "health", ended: "2026-11-05T11:01:00.000Z" }),
    () => true
  );
  expect(ended).toMatchObject({ phase: "failed", error: "health", commit: "c".repeat(40) });
  expect(jobOf("not json\n", () => true)).toBeNull();
});

test("the view: each instance with its branch, a column for each one of the same repository, the job line, and live at each one's commit", () => {
  const config = {
    instances: [
      entry("example.net"),
      entry("erga.example.org", "main", { repo: "example.org/team/erga" }),
      entry("staging.example.net", "staging"),
    ],
  };
  expect(config.instances.map((e) => columnsOf(config, e).map((c) => c.host))).toEqual([
    ["example.net", "staging.example.net"],
    ["erga.example.org"],
    ["example.net", "staging.example.net"],
  ]);
  const log = ["3", "2", "1"].map((n, i) => ({ sha: n.repeat(40), subject: `Change ${n}`, author: "Pete", at: NOW - i * 3_600_000 }));
  const facts: Facts = {
    config,
    answers: {
      "example.net": { version: "1".repeat(12), healthy: true },
      "staging.example.net": { version: "3".repeat(12), healthy: true },
      "erga.example.org": { version: "9".repeat(12), healthy: true },
    },
    git: { log, branches: [], base: "staging", main: "1".repeat(40), staging: "3".repeat(40), elsewhere: { ["9".repeat(12)]: false } },
    jobs: [jobOf(line(start) + line({ commit: "1".repeat(40) }) + line({ result: "ok", ended: "2026-11-05T11:55:00.000Z" }), () => true)!],
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    auto: null,
    heads: {},
  };
  const html = viewHtml(facts, "example.net", NOW);
  // The sidebar is a flat list: each instance, with the branch it tracks under its name. No instance stands under another.
  expect(
    [...html.matchAll(/<a class="group( sel)?" href="#([^"]+)"[^>]*>.*?<span class="tracks"[^>]*><span>(\w+)<\/span>/g)].map((m) =>
      m.slice(1).map((x) => x ?? "")
    )
  ).toEqual([
    [" sel", "example.net", "main"],
    ["", "erga.example.org", "main"],
    ["", "staging.example.net", "staging"],
  ]);
  expect(html).not.toMatch(/class="(primary|staging|primaries)"/);
  expect(html).toContain("Tracks <code>example.net/team/erga</code> <code>main</code>.");
  // Each column's head is its instance's branch.
  expect([...html.matchAll(/<div class="head col"[^>]*><b>(\w+)<\/b><span class="host">([^<]+)</g)].map((m) => m.slice(1))).toEqual([
    ["main", "example.net"],
    ["staging", "staging.example.net"],
  ]);
  expect(html).toContain('<a class="job ok"');
  expect(html).toContain("done 5 minutes ago · from a terminal");
  // The chosen instance's live mark has its deploy's time; its commit and those before it are green.
  expect(html).toMatch(/data-sha="3{40}">.*data-host="staging.example.net"/);
  expect(html).toMatch(/data-sha="1{40}">.*data-host="example.net".*<span class="at">5m<\/span>/);
  expect(html).toContain('<div class="row off" data-sha="2');
  expect(html).toContain('<div class="row on" data-sha="1');
  // Each instance is chosen by its own name.
  const other2 = viewHtml(facts, "staging.example.net", NOW);
  expect(other2).toContain('<a class="group sel" href="#staging.example.net"');
  expect(other2).toContain("Tracks <code>example.net/team/erga</code> <code>staging</code>.");
  // An instance of another repository has the log to itself. It runs a commit the clone does not have: the page says so.
  const other = viewHtml(facts, "erga.example.org", NOW);
  expect([...other.matchAll(/<div class="head col"/g)].length).toBe(1);
  expect(other).toContain("erga.example.org runs 999999999999, which this clone does not have. git fetch gets it.");
  expect(other).toContain("No job yet.");
});

test("Logs shows the job that runs, else the last one, or the one the hash names; History lists the jobs of the columns' instances", () => {
  const config = {
    instances: [
      entry("example.net"),
      entry("staging.example.net", "staging"),
      entry("erga.example.org", "main", { repo: "example.org/team/erga" }),
    ],
  };
  const job = (id: string, host: string, started: string, more = "") =>
    jobOf(line({ ...start, command: `bun erga deploy ${host}`, host, started }) + line({ out: `out of ${id}` }) + more, () => true, id)!;
  const done = (ended: string) => line({ result: "ok", ended });
  const facts: Facts = {
    config,
    answers: {},
    git: { error: "no git" },
    jobs: [
      job("old", "example.net", "2026-11-05T10:00:00.000Z", done("2026-11-05T10:00:30.000Z")),
      job("runs", "staging.example.net", "2026-11-05T11:00:00.000Z"),
      job("other", "erga.example.org", "2026-11-05T11:30:00.000Z", done("2026-11-05T11:31:00.000Z")),
    ],
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    auto: null,
    heads: {},
  };
  const logs = viewHtml(facts, "example.net/logs", NOW);
  expect(logs).toContain('<section class="logs" data-job="runs"');
  expect(logs).toContain("<span>out of runs</span>");
  expect(logs).toContain('<a class="tab" role="tab" href="#example.net/logs" aria-selected="true">Logs</a>');
  expect(viewHtml(facts, "example.net/logs/old", NOW)).toContain('<section class="logs" data-job="old"');
  // The newest job of all, for the page's switch to an instance that it does not show.
  expect(logs).toContain('data-newest="other" data-newest-host="erga.example.org"');
  const history = viewHtml(facts, "example.net/history", NOW);
  expect([...history.matchAll(/class="h-row [^"]*" href="[^"]*" data-job="(\w+)"/g)].map((m) => m[1])).toEqual(["runs", "old"]);
  expect(history).toContain('<span class="h-took">30 s</span>');
  // A job that auto-deploy started says so.
  const auto = jobOf(
    line({ ...start, from: "auto-deploy" }) + line({ result: "ok", ended: "2026-11-05T11:55:00.000Z" }),
    () => true,
    "auto-1"
  )!;
  const withAuto = viewHtml({ ...facts, jobs: [auto] }, "example.net/history", NOW);
  expect(withAuto).toContain('<span class="h-from">auto-deploy</span>');
  expect(viewHtml({ ...facts, jobs: [auto] }, "example.net", NOW)).toContain("done 5 minutes ago · from auto-deploy");
  expect(history).toContain('<span class="h-took">1 h 0 min</span>');
  // An unknown tab is Deploys.
  expect(viewHtml(facts, "example.net/nope", NOW)).toContain('data-tab="deploys"');
});

const commits = ["3", "2", "1"].map((n, i) => ({ sha: n.repeat(40), subject: `Change ${n}`, author: "Pete", at: NOW - i * 3_600_000 }));
const branch = (name: string, more: Partial<Branch> = {}): Branch => ({
  name,
  sha: "f".repeat(40),
  subject: `The last commit of ${name}`,
  author: "Pete",
  at: NOW,
  ahead: 1,
  behind: 0,
  conflicts: [],
  // The tree of its merge: none when it has no merge.
  tree: more.ahead == 0 || more.conflicts?.length ? null : `tree-${name}`,
  ...more,
});
const deploys = (more: Partial<Facts> = {}, staging = "3", production = "1"): Facts => ({
  config: { instances: [entry("example.net"), entry("staging.example.net", "staging")] },
  answers: {
    "example.net": { version: production.repeat(12), healthy: true },
    "staging.example.net": { version: staging.repeat(12), healthy: true },
  },
  git: {
    log: commits,
    branches: [branch("clean"), branch("clash", { conflicts: ["a.ts"] }), branch("done", { ahead: 0 })],
    base: "staging",
    main: "1".repeat(40),
    staging: "3".repeat(40),
    elsewhere: {},
  },
  jobs: [],
  run: { at: "idle" },
  polls: startPolls(),
  // Every test passed on the merge of clean.
  runs: [runOf("tree-clean")],
  auto: null,
  heads: {},
  ...more,
});
/** The page's own command as it starts: a deploy of commit n...n to staging.example.net. */
const starts = (what: string): Run =>
  stepRun(
    { at: "idle" },
    {
      type: "start",
      command: `bun erga deploy ${what.repeat(12)} staging.example.net`,
      job: { kind: "deploy", host: "staging.example.net", commit: what.repeat(40), branch: null, phase: "starting" },
    }
  );
/** A merge that runs, from a terminal: its job record. */
const merging = () => jobOf(line({ ...start, command: "bun erga merge clean", host: "staging" }), () => true, "merge-1")!;

test("the page has no feature branch, no Merge, no proof link and no legend", () => {
  // Three pushed branches, a passed run and a proof are in the clone: the page shows none of them.
  const html = viewHtml(deploys(), "example.net", NOW);
  for (const gone of ["Feature branches", "clean", "clash", "data-merge", "f-merge", "f-proof", "Tests passed", 'class="legend"'])
    expect(html, gone).not.toContain(gone);
  expect(html).toContain('<section class="commits"');
});

/** The row of a commit, in the view's HTML. */
const rowOf = (html: string, n: string) =>
  new RegExp(`<div class="row \\w+" data-sha="${n.repeat(40)}">.*?</div>(?=<div class="row|</div>)`).exec(html)?.[0] ?? "";

test("Deploy: a commit row has a button in an instance's column when the commit is on its branch and it does not run it", () => {
  const html = viewHtml(deploys(), "example.net", NOW);
  const hosts = (n: string) => [...rowOf(html, n).matchAll(/data-deploy data-host="([^"]+)"/g)].map((m) => m[1]);
  // main is at commit 1: example.net, which tracks main, takes no commit after it. staging is at commit 3.
  expect(hosts("3")).toEqual([]);
  expect(hosts("2")).toEqual(["staging.example.net"]);
  expect(hosts("1")).toEqual(["staging.example.net"]);
  expect(rowOf(html, "3")).toContain('<span class="deps" title="Not on main, the branch that example.net tracks"></span>');
  // After a promote, main is at commit 3: example.net takes it.
  const promoted = deploys();
  const at3 = viewHtml({ ...promoted, git: { ...promoted.git, main: "3".repeat(40) } } as Facts, "example.net", NOW);
  expect([...rowOf(at3, "3").matchAll(/data-deploy data-host="([^"]+)"/g)].map((m) => m[1])).toEqual(["example.net"]);
  expect(rowOf(at3, "3")).toContain('data-note="example.net tracks main. No branch moves."');
  // Its question names the host and the commit; the page shows it only in the cell under the mouse or
  // with the focus (ops-page.css, .deps.here).
  expect(rowOf(html, "2")).toContain(
    `<span class="deps here"><span class="tip"><button class="btn" type="button" data-deploy data-host="staging.example.net" data-sha="${"2".repeat(40)}" data-ask="Deploy 2222222 Change 2 to staging.example.net?"`
  );
  expect(html).toContain('<div class="confirm" id="deploy-confirm" popover>');
  expect(html.match(/data-deploy /g)?.length).toBe(2);
  // While a job runs, each is disabled and says why.
  const busy = viewHtml(deploys({ jobs: [merging()] }), "example.net", NOW);
  expect(busy).toContain(
    '<span class="tip" title="Another job runs: bun erga merge clean. Wait for it to end."><button class="btn" type="button" data-deploy'
  );
  expect(busy.match(/data-deploy [^>]* disabled>/g)?.length).toBe(2);
});

test("the page's server: Deploy starts its `bun erga` command, one job at a time, only from the page; it has no merge", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  // A clone: main at the first commit, staging at the second, a feature branch on top.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-buttons-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet");
  for (const m of ["Change 1", "Change 2", "A feature"])
    git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "--allow-empty", "-m", m);
  git("update-ref", "refs/remotes/origin/main", "HEAD~2");
  git("update-ref", "refs/remotes/origin/staging", "HEAD~1");
  git("update-ref", "refs/remotes/origin/a-feature", "HEAD");
  mkdirSync(join(dir, ".erga"));
  writeFileSync(
    join(dir, ".erga/config.json"),
    JSON.stringify({ instances: [entry("example.net"), entry("staging.example.net", "staging")] })
  );
  const version = {
    "example.net": git("rev-parse", "HEAD~2").slice(0, 12),
    "staging.example.net": git("rev-parse", "HEAD~1").slice(0, 12),
  };
  const runs: string[][] = [];
  const { writePass } = await import("./helpers/pass.ts");
  let end = (_: { code: number; out: string }) => {};
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    ask: async (e) => ({ version: version[e.host as keyof typeof version], healthy: true }),
    run: (args) => {
      runs.push(args);
      return { pid: 999_999, done: new Promise((done) => (end = done)) };
    },
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const post = (path: string, body: object, origin = at) =>
    fetch(`${at}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const view = async () => (await fetch(`${at}/view?hash=example.net`)).text();
  try {
    for (let i = 0; i < 100 && !(await view()).includes("dep live"); i++) await Bun.sleep(20);
    // The page merges nothing: the address is not there, whatever the branch's tests say.
    writePass(join(dir, ".erga"), "HEAD", dir);
    expect((await post("/api/merge", { branch: "a-feature", message: "A feature" })).status).toBe(404);
    expect(runs).toEqual([]);
    expect((await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD~1") }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD~1") })).status).toBe(202);
    expect(runs).toEqual([["deploy", git("rev-parse", "HEAD~1").slice(0, 12), "example.net"]]);
    // While it runs: no second job, and the buttons say why.
    const busy = await post("/api/deploy", { host: "staging.example.net", sha: git("rev-parse", "HEAD~2") });
    expect(busy.status).toBe(409);
    const command = `bun erga deploy ${git("rev-parse", "HEAD~1").slice(0, 12)} example.net`;
    expect(((await busy.json()) as { error: string }).error).toBe(`Another job runs: ${command}. Wait for it to end.`);
    expect(await view()).toContain(`title="Another job runs: ${command}. Wait for it to end."`);
    // The Deploys tab's job line shows it before its job record does.
    expect(await view()).toContain('data-tab="deploys"');
    expect(await view()).toContain(
      `<div class="job running"><i class="light"></i><code>${command}</code><span>starts · from this page</span></div>`
    );
    // It stops before its job record: the page shows its last words.
    end({ code: 1, out: "FAIL  example.net.lock is locked\n" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect(await view()).toContain(`<p class="note bad failed">${command} stopped: FAIL  example.net.lock is locked</p>`);
    // Deploy: a commit of the log, to an instance that does not run it.
    expect((await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD") })).status).toBe(409);
    expect((await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD~2") })).status).toBe(409);
    expect((await post("/api/deploy", { host: "nope.dev", sha: git("rev-parse", "HEAD~1") })).status).toBe(409);
    expect((await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD~1") })).status).toBe(202);
    expect(runs.at(-1)).toEqual(["deploy", git("rev-parse", "HEAD~1").slice(0, 12), "example.net"]);
    end({ code: 0, out: "" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect((await post("/api/deploy", { host: "staging.example.net", sha: git("rev-parse", "HEAD~2") })).status).toBe(202);
    expect(runs.at(-1)).toEqual(["deploy", git("rev-parse", "HEAD~2").slice(0, 12), "staging.example.net"]);
  } finally {
    end({ code: 0, out: "" });
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tests that a merge or a deploy runs get no ERGA_JOB_FROM, so their own job records say a terminal", async () => {
  const { testEnv } = await import("../deploy/cli/jobs");
  const { sh } = await import("../deploy/root");
  const page = process.env.ERGA_JOB_FROM;
  process.env.ERGA_JOB_FROM = "page";
  try {
    expect(sh(["sh", "-c", 'echo "${ERGA_JOB_FROM:-none}"'], { env: testEnv() }).out).toBe("none");
    expect(sh(["sh", "-c", 'echo "${ERGA_JOB_FROM:-none}"']).out).toBe("page");
  } finally {
    if (page == undefined) delete process.env.ERGA_JOB_FROM;
    else process.env.ERGA_JOB_FROM = page;
  }
});

test("while its deploy runs, its cell says Deploying… with a spinner", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  // A deploy: only its cell says Deploying…, and it stays shown with no hover.
  const deploying = viewHtml(deploys({ run: starts("2") }), "example.net", NOW);
  expect(rowOf(deploying, "2")).toContain(
    `<span class="deps here busy"><span class="tip" title="It deploys now. The job line and Logs show its output."><button class="btn" type="button" data-deploy data-host="staging.example.net"`
  );
  expect(rowOf(deploying, "2")).toContain(`aria-busy="true" disabled>${SPIN}Deploying…</button>`);
  expect(deploying.match(/class="spin"/g)?.length).toBe(1);
  expect(deploying).toContain(`${SPIN}Deploying…`);
  // The instance answers the new commit before the job ends: the cell still says Deploying…, not live.
  const answered = viewHtml(deploys({ run: starts("2") }, "2"), "example.net", NOW);
  expect(rowOf(answered, "2")).toContain(`${SPIN}Deploying…`);
  expect(rowOf(answered, "2")).not.toContain("live");
  // A merge that runs spins nothing on the page: the buttons wait.
  const waits = viewHtml(deploys({ jobs: [merging()] }), "example.net", NOW);
  expect(waits).not.toContain("spin");
});

test("a terminal's deploy says Deploying… in its cell, from its record's host and commit, whatever its flags", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  const two = "2".repeat(40);
  // Each command that main.ts builds, for a deploy of commit 2 that staging (or production) already answers.
  for (const [command, host] of [
    [`bun erga deploy ${two.slice(0, 12)} staging.example.net --no-tests`, "staging.example.net"],
    [`bun erga deploy ${two.slice(0, 12)} staging.example.net --fresh`, "staging.example.net"],
    ["bun erga deploy example.net", "example.net"],
    ["bun erga deploy main example.net", "example.net"],
    [`bun erga deploy ${two.slice(0, 12)} https://staging.example.net`, "staging.example.net"],
  ]) {
    const record = jobOf(line({ ...start, command, host }) + line({ commit: two }), () => true)!;
    const html = viewHtml(deploys({ jobs: [record] }, "2", "2"), "example.net", NOW);
    const cell = new RegExp(`<span class="deps here busy">[^]*?data-host="${host}" data-sha="${two}"[^]*?${SPIN}Deploying…`);
    expect(rowOf(html, "2"), command).toMatch(cell);
    expect(html.match(/class="spin"/g)?.length, command).toBe(1);
  }
  // Before its record names the commit, no cell says Deploying…; every button waits.
  const early = jobOf(line({ ...start, command: "bun erga deploy example.net", host: "example.net" }), () => true)!;
  const html = viewHtml(deploys({ jobs: [early] }), "example.net", NOW);
  expect(html).not.toContain("spin");
  expect(html.match(/data-deploy [^>]* disabled>/g)?.length).toBe(2);
});

test("a merge deploys to no instance: no cell says Deploying…, and its job shows for each instance", () => {
  const two = "2".repeat(40);
  const merge = jobOf(line({ ...start, command: "bun erga merge clean", host: "staging" }) + line({ commit: two }), () => true, "merge-1")!;
  const html = viewHtml(deploys({ jobs: [merge] }), "example.net", NOW);
  expect(rowOf(html, "2")).not.toContain("Deploying…");
  expect(html).toContain('<a class="job running" href="#example.net/logs/merge-1"');
  // A promote's job too.
  const promote = jobOf(
    line({ ...start, command: "bun erga promote", host: "main" }) + line({ result: "ok", ended: start.started }),
    () => true,
    "p-1"
  )!;
  expect(viewHtml(deploys({ jobs: [promote] }), "staging.example.net/history", NOW)).toContain('data-job="p-1"');
});

test("the page's server checks GitHub and each instance at start, not on a page load, and shows each source", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  const dir = mkdtempSync(join(tmpdir(), "erga-ops-sources-"));
  mkdirSync(join(dir, ".erga"));
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [entry("example.net")] }));
  const calls: string[] = [];
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    fetch: async () => (calls.push("fetch"), "fatal: unable to access GitHub"),
    ask: async () => (calls.push("ask"), { version: "1".repeat(12), healthy: true }),
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const view = async () => (await fetch(`${at}/view?hash=example.net`)).text();
  const until = async (ok: (html: string) => boolean) => {
    for (let i = 0; i < 100 && !ok(await view()); i++) await Bun.sleep(20);
    return view();
  };
  try {
    const first = await until((h) => h.includes("healthy") && h.includes("unable to access"));
    expect(first).toContain('<li class="source bad" data-source="github">');
    expect(first).toMatch(/<li class="source ok" data-source="example.net">.*runs 111111111111 · healthy/);
    expect(calls.sort()).toEqual(["ask", "fetch"]);
    // A page load checks nothing again: GitHub's fetch keeps its minute, an instance its 15 seconds (poll-state.ts).
    await fetch(`${at}/`);
    expect(calls.sort()).toEqual(["ask", "fetch"]);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the page's server works the tests' queue: each branch's merge runs one time, one at a time, the oldest first; a new commit runs again", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  const { runPath } = await import("../deploy/cli/test-run");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-queue-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  let when = 1_800_000_000;
  /** A commit with one file more, at a later time; the result: its tree. */
  const commit = (file: string) => {
    writeFileSync(join(dir, file), file);
    git("add", "-A");
    const date = `${when++} +0000`;
    execFileSync("git", ["-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "-m", file], {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
    return git("rev-parse", "HEAD^{tree}");
  };
  git("init", "--quiet", "-b", "work");
  commit("base.txt");
  git("update-ref", "refs/remotes/origin/staging", "HEAD");
  const trees = { old: commit("old.txt") };
  git("update-ref", "refs/remotes/origin/old", "HEAD");
  git("reset", "--quiet", "--hard", "origin/staging");
  const newer = commit("new.txt");
  git("update-ref", "refs/remotes/origin/new", "HEAD");
  mkdirSync(join(dir, ".erga/tests"), { recursive: true });
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [entry("example.net")] }));
  // The fake suite: it notes the branch, and its end (the test's) writes the record of the tree, as `bun erga full` does.
  const started: string[] = [];
  let end = () => {};
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    ask: async () => ({ version: null, healthy: null }),
    fetch: async () => null,
    test: (branch) => {
      started.push(branch);
      return { pid: 999_999, done: new Promise((done) => (end = () => done({ code: 0, out: "" }))) };
    },
  });
  const until = async (is: () => boolean | Promise<boolean>) => {
    // The server sees a moved ref at its next 5 seconds' tick.
    for (let i = 0; i < 500 && !(await is()); i++) await Bun.sleep(20);
  };
  const finish = (tree: string, state: "passed" | "failed") => {
    writeFileSync(runPath(join(dir, ".erga"), tree), JSON.stringify(runOf(tree, { state, branch: started.at(-1) })));
    end();
  };
  try {
    await until(() => started.length == 1);
    expect(started).toEqual(["old"]);
    finish(trees.old, "failed");
    await until(() => started.length == 2);
    expect(started).toEqual(["old", "new"]);
    finish(newer, "passed");
    // Each has its record: nothing more runs (a run between would show in the order below). The failed branch gets a commit: its merge is a new tree, and it runs again.
    git("checkout", "--quiet", "--detach", "origin/old");
    const repaired = commit("repair.txt");
    git("update-ref", "refs/remotes/origin/old", "HEAD");
    await until(() => started.length == 3);
    expect(started).toEqual(["old", "new", "old"]);
    finish(repaired, "passed");
    expect(started.length).toBe(3);
  } finally {
    end();
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
