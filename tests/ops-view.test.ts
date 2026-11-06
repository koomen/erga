// The ops page's view (deploy/cli/ops-view.ts): a job record read from its lines, the primaries with their staging
// instances, and the Deploys tab drawn from fake facts, with its Merge and Deploy buttons. The page's server
// (deploy/cli/ops-page.ts) starts their jobs with a fake `bun erga`: nothing merges or deploys.

import { expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { type Branch, type Facts, groupsOf, jobOf, viewHtml } from "../deploy/cli/ops-view";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const entry = (host: string, stagingOf?: string): Entry => ({
  host,
  ...(stagingOf ? { stagingOf } : {}),
  account: "a",
  worker: "w",
  database: "d",
  app: { kind: "workers.dev" },
  pages: { kind: "shared" },
  vars: {},
  token: "t",
});
const line = (x: object) => `${JSON.stringify(x)}\n`;
const start = { command: "bun erga deploy erga.dev", host: "erga.dev", from: "terminal", pid: 7, started: "2026-11-05T11:00:00.000Z" };

test("a job runs while it has no result and its process lives", () => {
  expect(jobOf(line(start), () => true)?.running).toBe(true);
  // Its process stopped with no result: it does not run.
  expect(jobOf(line(start), () => false)?.running).toBe(false);
  const ended = jobOf(
    line(start) + line({ commit: "c".repeat(40) }) + line({ result: "failed", error: "health", ended: "2026-11-05T11:01:00.000Z" }),
    () => true
  );
  expect(ended).toMatchObject({ running: false, result: "failed", error: "health", commit: "c".repeat(40) });
  expect(jobOf("not json\n", () => true)).toBeNull();
});

test("the view: each primary with its staging instances, the job line, and live at each instance's commit", () => {
  const config = { instances: [entry("erga.dev"), entry("erga.koomen.dev"), entry("staging.erga.dev", "erga.dev")] };
  expect(groupsOf(config).map((g) => [g.primary.host, g.staging.map((s) => s.host)])).toEqual([
    ["erga.dev", ["staging.erga.dev"]],
    ["erga.koomen.dev", []],
  ]);
  const log = ["3", "2", "1"].map((n, i) => ({ sha: n.repeat(40), subject: `Change ${n}`, author: "Pete", at: NOW - i * 3_600_000 }));
  const facts: Facts = {
    config,
    answers: {
      "erga.dev": { version: "1".repeat(12), healthy: true },
      "staging.erga.dev": { version: "3".repeat(12), healthy: true },
      "erga.koomen.dev": { version: "9".repeat(12), healthy: true },
    },
    git: { log, branches: [], base: "staging", main: "1".repeat(40), elsewhere: { ["9".repeat(12)]: false } },
    jobs: [jobOf(line(start) + line({ commit: "1".repeat(40) }) + line({ result: "ok", ended: "2026-11-05T11:55:00.000Z" }), () => true)!],
    setup: "",
    starting: "",
    failed: "",
  };
  const html = viewHtml(facts, "staging.erga.dev", NOW);
  // A staging instance's name chooses its primary.
  expect(html).toContain('<a class="group sel" href="#erga.dev"');
  expect(html).toContain('<a class="job ok"');
  expect(html).toContain("done 5 minutes ago · from a terminal");
  // Staging's column comes first; the primary's live mark has its deploy's time; its commit and those before it are green.
  expect(html).toMatch(/data-sha="3{40}">.*data-host="staging.erga.dev"/);
  expect(html).toMatch(/data-sha="1{40}">.*data-host="erga.dev".*<span class="at">5m<\/span>/);
  expect(html).toContain('<div class="row off" data-sha="2');
  expect(html).toContain('<div class="row on" data-sha="1');
  // An instance that runs a commit the clone does not have: the page says so.
  const other = viewHtml(facts, "erga.koomen.dev", NOW);
  expect(other).toContain("erga.koomen.dev runs 999999999999, which this clone does not have. git fetch gets it.");
  expect(other).toContain("No job yet.");
});

test("Logs shows the job that runs, else the last one, or the one the hash names; History lists the group's jobs", () => {
  const config = { instances: [entry("erga.dev"), entry("staging.erga.dev", "erga.dev"), entry("erga.koomen.dev")] };
  const job = (id: string, host: string, started: string, more = "") =>
    jobOf(line({ ...start, command: `bun erga deploy ${host}`, host, started }) + line({ out: `out of ${id}` }) + more, () => true, id)!;
  const done = (ended: string) => line({ result: "ok", ended });
  const facts: Facts = {
    config,
    answers: {},
    git: { error: "no git" },
    jobs: [
      job("old", "erga.dev", "2026-11-05T10:00:00.000Z", done("2026-11-05T10:00:30.000Z")),
      job("runs", "staging.erga.dev", "2026-11-05T11:00:00.000Z"),
      job("other", "erga.koomen.dev", "2026-11-05T11:30:00.000Z", done("2026-11-05T11:31:00.000Z")),
    ],
    setup: "",
    starting: "",
    failed: "",
  };
  const logs = viewHtml(facts, "erga.dev/logs", NOW);
  expect(logs).toContain('<section class="logs" data-job="runs"');
  expect(logs).toContain("<span>out of runs</span>");
  expect(logs).toContain('<a class="tab" role="tab" href="#erga.dev/logs" aria-selected="true">Logs</a>');
  expect(viewHtml(facts, "erga.dev/logs/old", NOW)).toContain('<section class="logs" data-job="old"');
  // The newest job of all, for the page's switch to its primary.
  expect(logs).toContain('data-newest="other" data-newest-primary="erga.koomen.dev"');
  const history = viewHtml(facts, "erga.dev/history", NOW);
  expect([...history.matchAll(/class="h-row [^"]*" href="[^"]*" data-job="(\w+)"/g)].map((m) => m[1])).toEqual(["runs", "old"]);
  expect(history).toContain('<span class="h-took">30 s</span>');
  expect(history).toContain('<span class="h-took">1 h 0 min</span>');
  // An unknown tab is Deploys.
  expect(viewHtml(facts, "erga.dev/nope", NOW)).toContain('data-tab="deploys"');
});

test("Setup: the setup's host shows before it has an entry, and opens on its checklist; another primary says how to start one", () => {
  const config = { instances: [entry("erga.dev")] };
  const facts: Facts = {
    config,
    answers: {},
    git: { error: "no git" },
    jobs: [],
    setup: "new.example.com",
    starting: "",
    failed: "",
  };
  expect(groupsOf(config, facts.setup).map((g) => [g.primary.host, g.primary.token])).toEqual([
    ["erga.dev", "t"],
    ["new.example.com", ""],
  ]);
  const html = viewHtml(facts, "new.example.com", NOW);
  expect(html).toContain('data-tab="setup"');
  expect(html).toContain('<div class="setup" data-host="new.example.com"></div>');
  expect(html).toContain('title="new.example.com: not registered yet: bun erga setup"');
  const other = viewHtml(facts, "erga.dev/setup", NOW);
  expect(other).toContain("erga.dev is registered.");
  expect(other).toContain('The setup of <a href="#new.example.com/setup">new.example.com</a> is in progress.');
  expect(other).not.toContain('class="setup"');
});

test("the ops page's server serves the Setup tab's checklist, and takes a POST only from its own origin", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  const dir = mkdtempSync(join(tmpdir(), "erga-ops-setup-"));
  const page = serveOpsPage({ dir, cwd: dir, port: 0, ask: async () => ({ version: null, healthy: null }) });
  const at = `http://127.0.0.1:${page.server.port}`;
  try {
    expect(await (await fetch(`${at}/setup/panel`)).text()).toContain('<form data-s="answers">');
    expect(await (await fetch(`${at}/setup.js`)).text()).toContain("window.ergaSetup");
    expect(await (await fetch(`${at}/`)).text()).toContain('<script src="/setup.js"></script>');
    const say = (origin: string) =>
      fetch(`${at}/setup/api/messages`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    expect((await say("https://evil.example")).status).toBe(403);
    // Its own origin passes the check: the route answers (an empty message is refused by the route itself).
    expect((await say(at)).status).toBe(400);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
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
  ...more,
});
const deploys = (more: Partial<Facts> = {}, staging = "3", production = "1"): Facts => ({
  config: { instances: [entry("erga.dev"), entry("staging.erga.dev", "erga.dev")] },
  answers: {
    "erga.dev": { version: production.repeat(12), healthy: true },
    "staging.erga.dev": { version: staging.repeat(12), healthy: true },
  },
  git: {
    log: commits,
    branches: [branch("clean"), branch("clash", { conflicts: ["a.ts"] }), branch("done", { ahead: 0 })],
    base: "staging",
    main: "1".repeat(40),
    elsewhere: {},
  },
  jobs: [],
  setup: "",
  starting: "",
  failed: "",
  ...more,
});
/** The Merge button of a branch: its tip, and whether it is disabled. */
const mergeOf = (html: string, name: string) => {
  const m = new RegExp(`<span class="tip"(?: title="([^"]*)")?><button class="btn" type="button" data-merge="${name}"( disabled)?>`).exec(
    html
  );
  return m && { tip: m[1] ?? "", disabled: !!m[2] };
};

test("Merge: a button on each feature branch, with a field for the message; disabled, with a tip, when it can't merge", () => {
  const html = viewHtml(deploys(), "erga.dev", NOW);
  expect(mergeOf(html, "clean")).toEqual({ tip: "", disabled: false });
  expect(html).toContain('<form class="f-merge" data-branch="clean" hidden><input name="message" value="The last commit of clean"');
  expect(mergeOf(html, "clash")).toEqual({ tip: "It conflicts with staging. Rebase it on origin/staging, and push it.", disabled: true });
  expect(mergeOf(html, "done")).toEqual({ tip: "Nothing to merge: staging has its commits.", disabled: true });
  // While a job runs, or one this page started, no branch merges.
  const job = jobOf(line(start), () => true)!;
  expect(mergeOf(viewHtml(deploys({ jobs: [job] }), "erga.dev", NOW), "clean")).toEqual({
    tip: "Another job runs: bun erga deploy erga.dev. Wait for it to end.",
    disabled: true,
  });
  expect(mergeOf(viewHtml(deploys({ starting: "bun erga merge clean" }), "erga.dev", NOW), "clean")?.disabled).toBe(true);
});

test("Deploy: in production's column, on the row of staging's commit, only when production is behind it", () => {
  const html = viewHtml(deploys(), "erga.dev", NOW);
  // Staging's live mark, then the button in production's column: the same row.
  expect(html).toMatch(
    /data-sha="3{40}">.*data-host="staging.erga.dev".*<button class="btn" type="button" data-deploy popovertarget="deploy-confirm">Deploy<\/button>.*<\/div><div class="row off" data-sha="2/
  );
  // The question names the host and the commit.
  expect(html).toContain('<div class="confirm" id="deploy-confirm" popover data-host="erga.dev" data-sha="' + "3".repeat(40) + '">');
  expect(html).toContain("<p>Deploy <code>3333333</code> Change 3 to <b>erga.dev</b>?</p>");
  // Production runs staging's commit, or a newer one: no button.
  expect(viewHtml(deploys({}, "3", "3"), "erga.dev", NOW)).not.toContain("data-deploy");
  expect(viewHtml(deploys({}, "2", "3"), "erga.dev", NOW)).not.toContain("data-deploy");
  // Staging not healthy: the button is there, disabled, and says why.
  const sick = deploys();
  sick.answers["staging.erga.dev"].healthy = false;
  expect(viewHtml(sick, "erga.dev", NOW)).toContain(
    '<span class="tip" title="Not healthy: staging.erga.dev. Fix staging first."><button class="btn" type="button" data-deploy popovertarget="deploy-confirm" disabled>'
  );
});

test("the page's server: Merge and Deploy start their `bun erga` command, one job at a time, only from the page", async () => {
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
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [entry("erga.dev"), entry("staging.erga.dev", "erga.dev")] }));
  const version = { "erga.dev": git("rev-parse", "HEAD~2").slice(0, 12), "staging.erga.dev": git("rev-parse", "HEAD~1").slice(0, 12) };
  const runs: string[][] = [];
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
  const view = async () => (await fetch(`${at}/view?hash=erga.dev`)).text();
  try {
    for (let i = 0; i < 100 && !(await view()).includes("data-deploy"); i++) await Bun.sleep(20);
    expect(await view()).toContain('data-merge="a-feature">Merge');
    expect((await post("/api/merge", { branch: "a-feature", message: "A feature" }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/merge", { branch: "nope", message: "x" })).status).toBe(409);
    expect((await post("/api/merge", { branch: "a-feature", message: " " })).status).toBe(409);
    expect((await post("/api/merge", { branch: "a-feature", message: "A feature, all of it" })).status).toBe(202);
    expect(runs).toEqual([["merge", "a-feature", "-m", "A feature, all of it"]]);
    // While it runs: no second job, and the buttons say why.
    const busy = await post("/api/deploy", { host: "erga.dev", sha: git("rev-parse", "HEAD~1") });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("Another job runs: bun erga merge a-feature. Wait for it to end.");
    expect(await view()).toContain('title="Another job runs: bun erga merge a-feature. Wait for it to end."');
    // It stops before its job record: the page shows its last words.
    end({ code: 1, out: "FAIL  staging.lock is locked\n" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect(await view()).toContain('<p class="note bad failed">bun erga merge a-feature stopped: FAIL  staging.lock is locked</p>');
    // Deploy: only staging's commit, as the button showed it.
    expect((await post("/api/deploy", { host: "erga.dev", sha: git("rev-parse", "HEAD") })).status).toBe(409);
    expect((await post("/api/deploy", { host: "erga.dev", sha: git("rev-parse", "HEAD~1") })).status).toBe(202);
    expect(runs.at(-1)).toEqual(["deploy", "erga.dev"]);
  } finally {
    end({ code: 0, out: "" });
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
