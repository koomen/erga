// The ops page's view (deploy/cli/ops-view.ts): a job record read from its lines, the primaries with their staging
// instances, and the Deploys tab drawn from fake facts, with its Merge and Deploy buttons. The page's server
// (deploy/cli/ops-page.ts) starts their jobs with a fake `bun erga`: nothing merges or deploys.

import { expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { type Run, stepRun } from "../deploy/cli/job-state";
import { type Branch, type Facts, groupsOf, jobOf, viewHtml } from "../deploy/cli/ops-view";
import { startPolls } from "../deploy/cli/poll-state";
import { runOf } from "./helpers/pass.ts";

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

test("the view: each primary with its staging instances, the job line, and live at each instance's commit", () => {
  const config = { instances: [entry("example.net"), entry("erga.example.org"), entry("staging.example.net", "example.net")] };
  expect(groupsOf(config).map((g) => [g.primary.host, g.staging.map((s) => s.host)])).toEqual([
    ["example.net", ["staging.example.net"]],
    ["erga.example.org", []],
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
    setup: "",
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    proofs: {},
  };
  const html = viewHtml(facts, "staging.example.net", NOW);
  // A staging instance's name chooses its primary.
  expect(html).toContain('<a class="group sel" href="#example.net"');
  expect(html).toContain('<a class="job ok"');
  expect(html).toContain("done 5 minutes ago · from a terminal");
  // Staging's column comes first; the primary's live mark has its deploy's time; its commit and those before it are green.
  expect(html).toMatch(/data-sha="3{40}">.*data-host="staging.example.net"/);
  expect(html).toMatch(/data-sha="1{40}">.*data-host="example.net".*<span class="at">5m<\/span>/);
  expect(html).toContain('<div class="row off" data-sha="2');
  expect(html).toContain('<div class="row on" data-sha="1');
  // An instance that runs a commit the clone does not have: the page says so.
  const other = viewHtml(facts, "erga.example.org", NOW);
  expect(other).toContain("erga.example.org runs 999999999999, which this clone does not have. git fetch gets it.");
  expect(other).toContain("No job yet.");
});

test("Logs shows the job that runs, else the last one, or the one the hash names; History lists the group's jobs", () => {
  const config = { instances: [entry("example.net"), entry("staging.example.net", "example.net"), entry("erga.example.org")] };
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
    setup: "",
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    proofs: {},
  };
  const logs = viewHtml(facts, "example.net/logs", NOW);
  expect(logs).toContain('<section class="logs" data-job="runs"');
  expect(logs).toContain("<span>out of runs</span>");
  expect(logs).toContain('<a class="tab" role="tab" href="#example.net/logs" aria-selected="true">Logs</a>');
  expect(viewHtml(facts, "example.net/logs/old", NOW)).toContain('<section class="logs" data-job="old"');
  // The newest job of all, for the page's switch to its primary.
  expect(logs).toContain('data-newest="other" data-newest-primary="erga.example.org"');
  const history = viewHtml(facts, "example.net/history", NOW);
  expect([...history.matchAll(/class="h-row [^"]*" href="[^"]*" data-job="(\w+)"/g)].map((m) => m[1])).toEqual(["runs", "old"]);
  expect(history).toContain('<span class="h-took">30 s</span>');
  expect(history).toContain('<span class="h-took">1 h 0 min</span>');
  // An unknown tab is Deploys.
  expect(viewHtml(facts, "example.net/nope", NOW)).toContain('data-tab="deploys"');
});

test("Setup: the setup's host shows before it has an entry, and opens on its checklist; another primary says how to start one", () => {
  const config = { instances: [entry("example.net")] };
  const facts: Facts = {
    config,
    answers: {},
    git: { error: "no git" },
    jobs: [],
    setup: "new.example.com",
    run: { at: "idle" },
    polls: startPolls(),
    runs: [],
    proofs: {},
  };
  expect(groupsOf(config, facts.setup).map((g) => [g.primary.host, g.primary.token])).toEqual([
    ["example.net", "t"],
    ["new.example.com", ""],
  ]);
  const html = viewHtml(facts, "new.example.com", NOW);
  expect(html).toContain('data-tab="setup"');
  expect(html).toContain('<div class="setup" data-host="new.example.com"></div>');
  expect(html).toContain('title="new.example.com: not registered yet: bun erga setup"');
  const other = viewHtml(facts, "example.net/setup", NOW);
  expect(other).toContain("example.net is registered.");
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
  // The tree of its merge: none when it has no merge.
  tree: more.ahead == 0 || more.conflicts?.length ? null : `tree-${name}`,
  ...more,
});
const deploys = (more: Partial<Facts> = {}, staging = "3", production = "1"): Facts => ({
  config: { instances: [entry("example.net"), entry("staging.example.net", "example.net")] },
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
  setup: "",
  run: { at: "idle" },
  polls: startPolls(),
  // Every test passed on the merge of clean.
  runs: [runOf("tree-clean")],
  proofs: {},
  ...more,
});
/** The page's own command as it starts: a merge of a branch, or a deploy of commit n...n to staging.example.net. */
const starts = (kind: "merge" | "deploy", what: string): Run =>
  kind == "merge"
    ? stepRun(
        { at: "idle" },
        {
          type: "start",
          command: `bun erga merge ${what}`,
          job: { kind, host: "staging.example.net", commit: null, branch: what, phase: "starting" },
        }
      )
    : stepRun(
        { at: "idle" },
        {
          type: "start",
          command: `bun erga deploy ${what.repeat(12)} staging.example.net`,
          job: { kind, host: "staging.example.net", commit: what.repeat(40), branch: null, phase: "starting" },
        }
      );
/** The Merge button of a branch: its tip, and whether it is disabled. */
const mergeOf = (html: string, name: string) => {
  const m = new RegExp(`<span class="tip"(?: title="([^"]*)")?><button class="btn" type="button" data-merge="${name}"( disabled)?>`).exec(
    html
  );
  return m && { tip: m[1] ?? "", disabled: !!m[2] };
};

test("Merge: a button on each feature branch, with a field for the message; disabled, with a tip, when it can't merge", () => {
  const html = viewHtml(deploys(), "example.net", NOW);
  expect(mergeOf(html, "clean")).toEqual({ tip: "", disabled: false });
  expect(html).toContain('<form class="f-merge" data-branch="clean" hidden><input name="message" value="The last commit of clean"');
  expect(mergeOf(html, "clash")).toEqual({ tip: "It conflicts with staging. Rebase it on origin/staging, and push it.", disabled: true });
  expect(mergeOf(html, "done")).toEqual({ tip: "Nothing to merge: staging has its commits.", disabled: true });
  // While a job runs, or one this page started, no branch merges.
  const job = jobOf(line(start), () => true)!;
  expect(mergeOf(viewHtml(deploys({ jobs: [job] }), "example.net", NOW), "clean")).toEqual({
    tip: "Another job runs: bun erga deploy example.net. Wait for it to end.",
    disabled: true,
  });
  expect(mergeOf(viewHtml(deploys({ run: starts("merge", "clash") }), "example.net", NOW), "clean")?.disabled).toBe(true);
});

/** A branch's row, in the view's HTML. */
const featureOf = (html: string, name: string) =>
  html.split('<li class="feature"').find((li) => /data-branch="([\w-]+)"/.exec(li)?.[1] == name) ?? "";

test("a branch's row shows one test state, and only a passed run of its merge's tree opens Merge", () => {
  const row = (runs: Facts["runs"]) => {
    const html = viewHtml(deploys({ runs }), "example.net", NOW);
    return { html: featureOf(html, "clean"), merge: mergeOf(html, "clean") };
  };
  // No record of the tree: it waits in the queue. A record of another tree of the branch: the row says it is stale.
  const waiting = row([]);
  expect(waiting.html).toContain('data-test="waiting"><i class="light wait"></i>Tests wait in the queue</span>');
  expect(waiting.merge).toEqual({ tip: "The tests must pass first. Its run waits in the queue.", disabled: true });
  const stale = row([runOf("tree-before", { branch: "clean" })]);
  expect(stale.html).toContain("Tests wait in the queue (the last run, passed, is stale)");
  expect(stale.merge?.disabled).toBe(true);
  const running = row([runOf("tree-clean", { state: "running", ended: undefined })]);
  expect(running.html).toContain(
    'data-test="running"><i class="light run"></i>Tests run, <b class="f-slow" title="Over the target of 60 s for bun run test">600 s</b></span>'
  );
  expect(running.merge).toEqual({ tip: "The tests must pass first. They run now.", disabled: true });
  const passed = row([runOf("tree-clean")]);
  expect(passed.html).toContain('data-test="passed"><i class="light ok"></i>Tests passed in 24 s</span>');
  // A run over the target of 60 s: its time is in the warning colour.
  expect(row([runOf("tree-clean", { ended: "2026-11-05T11:51:01.000Z" })]).html).toContain(
    'Tests passed in <b class="f-slow" title="Over the target of 60 s for bun run test">61 s</b></span>'
  );
  expect(row([runOf("tree-clean", { ended: "2026-11-05T11:51:00.000Z" })]).html).toContain("Tests passed in 60 s</span>");
  expect(passed.merge).toEqual({ tip: "", disabled: false });
  // A failed run opens to its failed tests, what the failed step said, and its log.
  const names = ["e2e/smoke/a.e2e.ts: typing shows", "e2e/smoke/b.e2e.ts: undo works"];
  const failed = row([runOf("tree-clean", { state: "failed", failed: names, note: "== smoke run: FAILED (9 s)" })]);
  expect(failed.html).toContain('data-test="failed"><i class="light bad"></i>2 tests failed in 24 s</span>');
  expect(failed.html).toContain(
    `<details class="f-fails"><summary>What failed</summary><ul><li>${names[0]}</li><li>${names[1]}</li></ul><pre>== smoke run: FAILED (9 s)</pre>`
  );
  expect(failed.html).toContain("The log: <code>/tmp/erga-tests.log</code>");
  expect(failed.merge).toEqual({
    tip: "Its tests failed. The task&#39;s agent repairs them on the branch, and pushes it.",
    disabled: true,
  });
  // A run with no failed browser test (the typecheck failed): what that step said.
  const broke = row([runOf("tree-clean", { state: "failed", note: "== typecheck: FAILED (9 s)" })]);
  expect(broke.html).toContain("Tests failed in 24 s</span>");
  expect(broke.html).toContain("<summary>What failed</summary><pre>== typecheck: FAILED (9 s)</pre>");
  // A branch with a conflict has no merge to test; and the page has no other box of tests or times.
  const all = viewHtml(deploys(), "example.net", NOW);
  expect(featureOf(all, "clash")).not.toContain("f-test");
  expect(all).not.toContain("tests-head");
});

/** The row of a commit, in the view's HTML. */
const rowOf = (html: string, n: string) =>
  new RegExp(`<div class="row \\w+" data-sha="${n.repeat(40)}">.*?</div>(?=<div class="row|</div>)`).exec(html)?.[0] ?? "";

test("Deploy: each commit row has a button in each instance's column, except where that instance runs the commit", () => {
  const html = viewHtml(deploys(), "example.net", NOW);
  const hosts = (n: string) => [...rowOf(html, n).matchAll(/data-deploy data-host="([^"]+)"/g)].map((m) => m[1]);
  expect(hosts("3")).toEqual(["example.net"]);
  expect(hosts("2")).toEqual(["staging.example.net", "example.net"]);
  expect(hosts("1")).toEqual(["staging.example.net"]);
  // Its question names the host and the commit; the page shows it only in the cell under the mouse or
  // with the focus (ops-page.css, .deps.here).
  expect(rowOf(html, "2")).toContain(
    `<span class="deps here"><span class="tip"><button class="btn" type="button" data-deploy data-host="staging.example.net" data-sha="${"2".repeat(40)}" data-ask="Deploy 2222222 Change 2 to staging.example.net?"`
  );
  expect(html).toContain('<div class="confirm" id="deploy-confirm" popover>');
  // The old button of a production that is behind is gone: no row has more than its two columns.
  expect(html.match(/data-deploy /g)?.length).toBe(4);
  // While a job runs, each is disabled and says why.
  const busy = viewHtml(deploys({ run: starts("merge", "clean") }), "example.net", NOW);
  expect(busy).toContain(
    '<span class="tip" title="Another job runs: bun erga merge clean. Wait for it to end."><button class="btn" type="button" data-deploy'
  );
  expect(busy.match(/data-deploy [^>]* disabled>/g)?.length).toBe(4);
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
  writeFileSync(
    join(dir, ".erga/config.json"),
    JSON.stringify({ instances: [entry("example.net"), entry("staging.example.net", "example.net")] })
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
    // No test record of its merge yet: the server refuses the merge, as the button does.
    const early = await post("/api/merge", { branch: "a-feature", message: "A feature" });
    expect([early.status, ((await early.json()) as { error: string }).error]).toEqual([
      409,
      "The tests must pass first. Its run waits in the queue.",
    ]);
    writePass(join(dir, ".erga"), "HEAD", dir);
    for (let i = 0; i < 100 && !(await view()).includes('data-merge="a-feature">Merge'); i++) await Bun.sleep(20);
    expect(await view()).toContain('data-merge="a-feature">Merge');
    expect((await post("/api/merge", { branch: "a-feature", message: "A feature" }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/merge", { branch: "nope", message: "x" })).status).toBe(409);
    expect((await post("/api/merge", { branch: "a-feature", message: " " })).status).toBe(409);
    // A message of any length: here, eleven words, as a prefilled subject can be.
    const long = "A feature, all of it, with more words than ten here";
    expect((await post("/api/merge", { branch: "a-feature", message: long })).status).toBe(202);
    expect(runs).toEqual([["merge", "a-feature", "-m", long]]);
    // While it runs: no second job, and the buttons say why.
    const busy = await post("/api/deploy", { host: "example.net", sha: git("rev-parse", "HEAD~1") });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("Another job runs: bun erga merge a-feature. Wait for it to end.");
    expect(await view()).toContain('title="Another job runs: bun erga merge a-feature. Wait for it to end."');
    // The Deploys tab's job line shows it before its job record does.
    expect(await view()).toContain('data-tab="deploys"');
    expect(await view()).toContain(
      '<div class="job running"><i class="light"></i><code>bun erga merge a-feature</code><span>starts · from this page</span></div>'
    );
    // It stops before its job record: the page shows its last words.
    end({ code: 1, out: "FAIL  staging.lock is locked\n" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect(await view()).toContain('<p class="note bad failed">bun erga merge a-feature stopped: FAIL  staging.lock is locked</p>');
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

test("while its job runs, a button says so with a spinner: Merging… on its branch, Deploying… in its cell", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  // The page started the merge, and then its job record runs: the branch's button says Merging…, disabled.
  const merging = `<span class="tip" title="It merges now. The job line and Logs show its output."><button class="btn" type="button" data-merge="clean" aria-busy="true" disabled>${SPIN}Merging…</button></span>`;
  expect(viewHtml(deploys({ run: starts("merge", "clean") }), "example.net", NOW)).toContain(merging);
  const record = jobOf(line({ ...start, command: "bun erga merge clean", host: "staging.example.net" }), () => true)!;
  const html = viewHtml(deploys({ jobs: [record] }), "example.net", NOW);
  expect(html).toContain(merging);
  // The other buttons wait, and say why; no other button spins.
  expect(mergeOf(html, "clash")?.disabled).toBe(true);
  expect(html.match(/class="spin"/g)?.length).toBe(1);
  // A deploy: only its cell says Deploying…, and it stays shown with no hover.
  const deploying = viewHtml(deploys({ run: starts("deploy", "2") }), "example.net", NOW);
  expect(rowOf(deploying, "2")).toContain(
    `<span class="deps here busy"><span class="tip" title="It deploys now. The job line and Logs show its output."><button class="btn" type="button" data-deploy data-host="staging.example.net"`
  );
  expect(rowOf(deploying, "2")).toContain(`aria-busy="true" disabled>${SPIN}Deploying…</button>`);
  expect(deploying.match(/class="spin"/g)?.length).toBe(1);
  expect(deploying).toContain(`${SPIN}Deploying…`);
  // The instance answers the new commit before the job ends: the cell still says Deploying…, not live.
  const answered = viewHtml(deploys({ run: starts("deploy", "2") }, "2"), "example.net", NOW);
  expect(rowOf(answered, "2")).toContain(`${SPIN}Deploying…`);
  expect(rowOf(answered, "2")).not.toContain("live");
  // The job ends: the buttons are as before.
  const done = jobOf(line({ ...start, command: "bun erga merge clean" }) + line({ result: "ok", ended: start.started }), () => true)!;
  const after = viewHtml(deploys({ jobs: [done] }), "example.net", NOW);
  expect(after).not.toContain("spin");
  expect(mergeOf(after, "clean")).toEqual({ tip: "", disabled: false });
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
  expect(html.match(/data-deploy [^>]* disabled>/g)?.length).toBe(4);
});

test("a merge: staging's cell says Deploying… until the merge ends, after the push of staging, not live", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  const two = "2".repeat(40);
  const merge = line({ ...start, command: "bun erga merge clean", host: "staging.example.net" }) + line({ commit: two });
  // Staging answers the merged commit while the merge still runs (its deploy record ended; staging is not pushed yet).
  const deploy = merge + line({ result: "ok", ended: start.started });
  const html = viewHtml(deploys({ jobs: [jobOf(merge, () => true)!, jobOf(deploy, () => true)!] }, "2"), "example.net", NOW);
  expect(rowOf(html, "2")).toMatch(new RegExp(`data-host="staging.example.net" data-sha="${two}"[^]*?${SPIN}Deploying…`));
  expect(rowOf(html, "2")).not.toContain("live");
  // The merge ends: live.
  const ended = viewHtml(deploys({ jobs: [jobOf(deploy, () => true)!] }, "2"), "example.net", NOW);
  expect(rowOf(ended, "2")).toContain("live");
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
    // A page load checks nothing again: GitHub's fetch keeps its minute, an instance its 5 seconds (poll-state.ts).
    await fetch(`${at}/`);
    expect(calls.sort()).toEqual(["ask", "fetch"]);
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch's proof is a link beside Merge: old when the branch has a newer commit, and named when there is none", () => {
  const sha = (name: string) => /data-branch="(\w+)"/.exec(name);
  const of = (html: string, name: string) => html.split('<li class="feature"').find((li) => sha(li)?.[1] == name) ?? "";
  const clean = branch("clean");
  const html = viewHtml(
    deploys({
      proofs: { clean: { sha: clean.sha, at: "2026-11-05T11:00:00.000Z" }, clash: { sha: "0".repeat(40), at: "2026-11-05T10:00:00.000Z" } },
    }),
    "example.net",
    NOW
  );
  expect(of(html, "clean")).toContain('<a class="f-proof" href="/proof/clean/" target="_blank"');
  expect(of(html, "clean")).toContain(">Proof</a>");
  expect(of(html, "clash")).toContain(">Proof (old)</a>");
  // A branch with nothing to merge needs no proof.
  expect(of(viewHtml(deploys(), "example.net", NOW), "clean")).toContain("No proof");
  expect(of(viewHtml(deploys(), "example.net", NOW), "done")).not.toContain("f-proof");
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
  const view = async () => (await fetch(`http://127.0.0.1:${page.server.port}/view?hash=example.net`)).text();
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
    expect(featureOf(await view(), "new")).toContain("Tests wait in the queue");
    finish(trees.old, "failed");
    await until(() => started.length == 2);
    expect(started).toEqual(["old", "new"]);
    expect(featureOf(await view(), "old")).toContain('data-test="failed"');
    finish(newer, "passed");
    await until(async () => featureOf(await view(), "new").includes('data-test="passed"'));
    // Each has its record: nothing more runs. The failed branch gets a commit: its merge is a new tree, and it runs again.
    git("checkout", "--quiet", "--detach", "origin/old");
    const repaired = commit("repair.txt");
    git("update-ref", "refs/remotes/origin/old", "HEAD");
    await until(() => started.length == 3);
    expect(started).toEqual(["old", "new", "old"]);
    expect(featureOf(await view(), "old")).toContain("the last run, failed, is stale");
    finish(repaired, "passed");
    await until(async () => featureOf(await view(), "old").includes('data-test="passed"'));
    expect(started.length).toBe(3);
  } finally {
    end();
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
