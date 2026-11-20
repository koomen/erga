// The server's side of its own deploys (server/directory/deploys.ts, server/operations/deploys.ts, /admin/deploy), on the
// whole app in memory, with the deployer's side played by the deployer's own code (deploy/deployer/instance.ts,
// control.ts) on the same database: what one side writes, the other reads. A server with no deployer says so and has
// no ask; with one, an admin's ask becomes the deployer's job, and the page and the operations show it as it goes.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { opsOf, toolsFor } from "../agents/tools.ts";
import { recordOf } from "../deploy/cli/running";
import { DeployError } from "../deploy/deployer/cloudflare-api";
import { type Commit, readControl, startOf, takeAsk, writeLook } from "../deploy/deployer/control";
import { LEASE_MS, NoTable, openJob, readJobs, type Sql, writeSpec } from "../deploy/deployer/instance";
import type { Spec } from "../deploy/deployer/spec";
import { DEPLOYER_MS } from "../server/directory/index.ts";
import { OPERATIONS } from "../server/operations/index.ts";
import { runTool, server } from "./helpers/app";

const run = Effect.runPromise;
const sha = (n: number) => String(n).repeat(40);
const NOW = Date.now();
const COMMITS: Commit[] = [
  { sha: sha(4), title: "Change 4 <b>", at: NOW - 60_000, release: "none" },
  { sha: sha(3), title: "Change 3", at: NOW - 3_600_000, release: "released" },
  { sha: sha(2), title: "Change 2", at: NOW - 7_200_000, release: "released" },
  { sha: sha(1), title: "Change 1", at: NOW - 9_000_000, release: "refused" },
];
const SPEC: Spec = {
  repo: "github.com/example/erga",
  branch: "main",
  target: {
    kind: "cloudflare",
    account: "0123456789abcdef0123456789abcdef",
    worker: "erga",
    database: "erga",
    app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
    pages: { kind: "zone", zoneName: "example-pages.com" },
  },
  settings: {},
  secrets: [],
};

/** A server that runs commit 2, and the deployer's way to its database. `deployer`: one looked at GitHub just now. */
async function world(o: { deployer?: boolean } = {}) {
  const s = server();
  s.platform.deploy.version = sha(2).slice(0, 12);
  const sql: Sql = (text, params) =>
    Effect.try({
      try: () =>
        s.sql.db
          .query(text)
          .all(...params)
          .map((r) => String(Object.values(r as object)[0])),
      catch: (e) => (/no such table/.test((e as Error).message) ? new NoTable() : new DeployError({ message: (e as Error).message })),
    });
  await run(writeSpec(sql, SPEC));
  if (o.deployer !== false) await run(writeLook(sql, { head: sha(4), error: null, commits: COMMITS }));
  /** The page's live part, as the page's script reads it again. */
  const page = async (query = "") => ((await (await s.fetch(`/admin/deploy/view${query}`)).json()) as { html: string }).html;
  return { s, sql, page };
}

test("a server with no deployer: the page and the read say that its deploys come from a machine, and nobody has the ask", async () => {
  const { s, sql, page } = await world({ deployer: false });
  const none = "No deployer in the cloud deploys localhost: its deploys come from a machine (bun erga deploy localhost).";
  // A deploy from a machine is in the instance's job log: the page shows it, with no commit, no button and no switch.
  const job = await run(openJob(sql, { kind: "deploy", command: "bun erga deploy localhost", source: "terminal" }));
  job.commit(sha(2));
  job.line("Worker: done");
  expect(await job.end({ at: "done" })).toBeNull();
  const html = await page();
  expect(html).toContain(`<div class="none">${none}</div>`);
  expect(html).toContain("<code>bun erga deploy localhost</code>");
  // Auto-deploy is a machine's then, which the server can't ask: it says what its job log knows, and how to get the switch.
  const how = "Install the cloud deployer to control it here (bun erga setup, with --deploys cloud).";
  const byHand = `Auto-deploy: not known. It runs on a machine (bun erga --auto-deploy), which this server can't ask: its last deploy came from a terminal, just now. ${how}`;
  expect(html).toContain(`<p class="lede">${byHand.replace("can't", "can&#39;t")}</p>`);
  expect(await (await s.fetch("/admin/deploy")).text()).toContain("localhost runs 222222222222.");
  expect(html).not.toMatch(/data-deploy|data-rollback|id="auto-deploy"/);
  expect(await page("?tab=logs")).toContain("<span>Worker: done</span>");
  const read = await runTool(s, "deploys");
  expect(read.result).toMatchObject({ runs: "222222222222", tracks: { repo: SPEC.repo, branch: "main" }, deployer: none, commits: [] });
  expect(read.result.autoDeploy).toBe(byHand);
  expect(read.result.jobs).toMatchObject([{ id: 1, kind: "deploy", from: "terminal", commit: sha(2), state: "done" }]);
  for (const action of ["deploy", "rollback", "auto"])
    expect(await runTool(s, "deploy", { action, on: true })).toMatchObject({ status: 403, error: none });
  expect(await run(readControl(sql))).toBeNull();
  // A deploy that a machine's auto-deploy started: it was on then, and the server does not say more.
  const auto = await run(openJob(sql, { kind: "deploy", command: "bun erga deploy localhost", source: "auto-deploy" }));
  expect(await auto.end({ at: "done" })).toBeNull();
  expect((await runTool(s, "deploys")).result.autoDeploy).toBe(
    `Auto-deploy: on at the last deploy (just now), from a machine (bun erga --auto-deploy). This server can't know whether it is on now. ${how}`
  );
  // An admin's agent has the read, and not the ask.
  const ops = (await toolsFor({ dir: s.dir, who: { login: "tester", admin: true } })).flatMap(opsOf);
  expect([ops.includes("deploys"), ops.includes("deploy")]).toEqual([true, false]);
  // A look that is old is no deployer: the page and the operations say the same again.
  await run(writeLook(sql, { head: sha(4), error: null, commits: COMMITS }));
  expect((await runTool(s, "deploys")).result.deployer).toMatchObject({ head: sha(4) });
  s.sql.db.run("UPDATE deploy_control SET looked = looked - ?", [DEPLOYER_MS + 1000]);
  expect((await runTool(s, "deploys")).result).toMatchObject({ deployer: none, commits: [] });
  expect((await runTool(s, "deploy", { action: "rollback" })).status).toBe(403);
});

test("a server with no spec yet says so; only an admin reads the page or the operations", async () => {
  const s = server();
  expect(await (await s.fetch("/admin/deploy")).text()).toContain("localhost has no deploy spec yet");
  expect((await runTool(s, "deploys")).result).toMatchObject({ tracks: null, jobs: [] });
  const { s: w } = await world();
  expect((await w.fetch("/admin/deploy?user=ada")).status).toBe(404);
  expect((await w.fetch("/admin/deploy/view?user=ada")).status).toBe(404);
  expect((await runTool(w, "deploys", {}, { user: "ada" })).status).toBe(403);
  expect((await runTool(w, "deploy", { action: "rollback" }, { user: "ada" })).status).toBe(403);
});

test("with a deployer: the page lists the commits that its look saw, and Deploy only where GitHub has a release", async () => {
  const { s, page } = await world();
  const html = await page();
  const row = (n: number) => new RegExp(`<div class="row \\w+" data-sha="${sha(n)}">.*?</div>`).exec(html)![0];
  expect(row(4)).toContain("no release yet");
  expect(row(4)).toContain("Change 4 &lt;b&gt;");
  expect(row(3)).toContain(`data-deploy data-host="localhost" data-sha="${sha(3)}"`);
  expect(row(2)).toContain('<span class="w">live</span>');
  expect(row(2)).toContain("data-rollback");
  expect(row(1)).toContain("refused");
  expect(html).toContain('<input type="checkbox" role="switch" id="auto-deploy">');
  expect(html).toContain("GitHub, by the deployer, just now");
  // No job and no ask: the page asks again each 10 seconds.
  expect(html).toContain('id="ops" data-wait="10000"');
  // The whole page has the live part in it, and its script, which draws that part again.
  expect(html).toStartWith('<ol class="rows" aria-label="Auto-deploy">');
  const whole = await (await s.fetch("/admin/deploy")).text();
  expect(whole).toContain(`<div id="deploy-live">${html}</div>`);
  expect(whole).toContain('<a href="/admin/deploy" aria-current="page">');
  const read = (await runTool(s, "deploys")).result;
  expect(read.commits.map((c: { commit: string; release: string; live?: boolean }) => [c.commit[0], c.release, !!c.live])).toEqual([
    ["4", "none", false],
    ["3", "released", false],
    ["2", "released", true],
    ["1", "refused", false],
  ]);
  expect(read.autoDeploy).toBe(false);
});

test("an admin's ask is the deployer's job: asked, taken, run, done; the page and the read follow it", async () => {
  const { s, sql, page } = await world();
  // The first 7 characters of a commit are enough.
  const asked = await runTool(s, "deploy", { action: "deploy", commit: sha(3).slice(0, 7) });
  expect(asked).toMatchObject({ status: 200, result: { asked: "deploy 333333333333", commit: sha(3), title: "Change 3" } });
  const waits = await page();
  expect(waits).toContain(
    '<div class="job running"><i class="light"></i><code>deploy 333333333333</code><span>asked by tester · the deployer starts it at its next look</span></div>'
  );
  expect(waits).toContain("Deploying…");
  expect(waits).toContain('id="ops" data-wait="1000"');
  expect((await runTool(s, "deploys")).result.asked).toMatchObject({ action: "deploy", commit: sha(3), by: "tester" });
  // The deployer's look: it reads the ask, takes the lock with the ask's job, and only then takes the ask.
  const ask = (await run(readControl(sql)))!.ask!;
  expect(ask).toMatchObject({ kind: "deploy", sha: sha(3), by: "tester" });
  const job = await run(openJob(sql, startOf(ask)));
  expect(await run(takeAsk(sql, ask))).toBe(true);
  job.commit(sha(3));
  job.line("Migrations: done, 0 applied");
  job.line("Worker...");
  // (A line is in the row once a write ended: the job's end waits for them all, so the read below sees both.)
  const runs = await page("?tab=logs");
  expect(runs).toContain('<a class="job running" href="/admin/deploy?tab=logs&amp;job=1" title="from the app, by tester">');
  expect(runs).toContain('id="ops" data-wait="1000"');
  // While it runs, no other ask.
  expect(await runTool(s, "deploy", { action: "rollback" })).toMatchObject({
    status: 409,
    error: "Another job runs: deploy 333333333333 (from app, by tester). Wait for it to end.",
  });
  job.line("Worker: done");
  expect(await job.end({ at: "done" })).toBeNull();
  const log = await page("?tab=logs&job=1");
  expect(log).toContain("<span>Migrations: done, 0 applied</span>\n<span>Worker...</span>\n<span>Worker: done</span>");
  expect(log).toContain('<span class="state ok">done');
  const history = await page("?tab=history");
  expect(history).toContain('<span class="h-from">app, by tester</span>');
  expect(history).toContain('id="ops" data-wait="10000"');
  expect((await runTool(s, "deploys")).result.jobs).toMatchObject([
    { id: 1, kind: "deploy", command: "deploy 333333333333", from: "app, by tester", commit: sha(3), state: "done" },
  ]);
  expect((await runTool(s, "deploys", { job: 1 })).result).toMatchObject({
    job: { id: 1, state: "done" },
    log: "Migrations: done, 0 applied\nWorker...\nWorker: done\n",
  });
  expect(await runTool(s, "deploys", { job: 9 })).toMatchObject({ status: 404, error: "There's no job 9: deploys lists them." });
});

test("what an ask refuses, a rollback, an ask in the place of one that waits, and the Auto-deploy switch", async () => {
  const { s, sql, page } = await world();
  const deploy = (commit?: string) => runTool(s, "deploy", { action: "deploy", ...(commit ? { commit } : {}) });
  // No commit: the head, which GitHub has no release of yet.
  expect(await deploy()).toMatchObject({
    status: 409,
    error: "GitHub has no release of 444444444444 yet: its tests and its build run, or they failed.",
  });
  expect(await deploy(sha(1))).toMatchObject({
    status: 409,
    error: "GitHub's release of 111111111111 is not one release of Erga's: the deployer refuses it.",
  });
  expect(await deploy(sha(2))).toMatchObject({ status: 409, error: "localhost runs 222222222222 already." });
  expect(await deploy(sha(5))).toMatchObject({ status: 404 });
  expect((await deploy(sha(5))).error).toContain("is not one of the last 4 commits of main");
  expect(await deploy("main; rm -rf /")).toMatchObject({ status: 400 });
  expect((await run(readControl(sql)))?.ask).toBeNull();
  // A rollback, then a deploy in its place: the deployer reads the last one, in the form that it takes.
  expect(await runTool(s, "deploy", { action: "rollback" })).toMatchObject({ status: 200, result: { asked: "rollback" } });
  expect((await run(readControl(sql)))?.ask).toMatchObject({ kind: "rollback", by: "tester" });
  expect((await deploy(sha(3))).status).toBe(200);
  expect((await run(readControl(sql)))?.ask).toMatchObject({ kind: "deploy", sha: sha(3) });
  // Who asked is one line, as the deployer needs it: an agent's ask says so.
  await s.dir.deploys.ask({ login: "Tester", admin: true, via: "agent\nfailed: no" }, { kind: "rollback" });
  expect((await run(readControl(sql)))?.ask).toMatchObject({ kind: "rollback", by: "tester, via agent failed: no" });
  expect(s.dir.deploys.ask({ login: "tester", admin: true }, { kind: "deploy", sha: "main" })).rejects.toThrow(
    "is not a commit's full name"
  );
  // The switch.
  expect(await runTool(s, "deploy", { action: "auto" })).toMatchObject({ status: 400, error: "auto needs on: true or false." });
  expect((await runTool(s, "deploy", { action: "auto", on: true })).result).toEqual({ autoDeploy: true });
  expect((await run(readControl(sql)))?.auto).toBe(true);
  expect(await page()).toContain('id="auto-deploy" checked>');
  expect((await runTool(s, "deploy", { action: "auto", on: false })).result).toEqual({ autoDeploy: false });
  expect((await run(readControl(sql)))?.auto).toBe(false);
  // The look does not touch what the app wrote, and the app's writes keep the look.
  await run(writeLook(sql, { head: sha(4), error: "GitHub answered 503.", commits: COMMITS }));
  expect((await run(readControl(sql)))?.ask).toMatchObject({ kind: "rollback" });
  expect(await page()).toContain('The deployer\'s look at GitHub, just now: <span class="s-err">GitHub answered 503.</span>');
  // What the person's own agent asks before it runs one.
  const asks = OPERATIONS.find((o) => o.name == "deploy")!.asks!;
  expect(asks({ action: "deploy", commit: "3333333" })).toBe("Deploy the commit 3333333 to this server");
  expect(asks({ action: "deploy" })).toBe("Deploy the head of its branch to this server");
  expect(asks({ action: "rollback" })).toBe("Roll this server back to the version from before its last deploy");
  expect(asks({ action: "auto", on: false })).toBe("Turn auto-deploy off for this server");
});

test("a job's state is the one that the ops page of a machine reads from the same row", async () => {
  const { s, sql } = await world();
  const start = { kind: "deploy", command: "bun erga deploy localhost", source: "terminal" } as const;
  const failed = await run(openJob(sql, start));
  await failed.end({ at: "failed", why: "the release was not healthy" });
  const done = await run(openJob(sql, { ...start, kind: "rollback" }));
  await done.end({ at: "done" });
  // A job that stopped with no end, long ago; and one that runs now.
  await run(openJob(sql, start));
  s.sql.db.run("UPDATE deploy_jobs SET alive = alive - ? WHERE id = 3", [LEASE_MS + 1000]);
  await run(openJob(sql, start));
  const now = Date.now();
  const mine = (await s.dir.deploys.state({ login: "tester", admin: true }, now)).jobs;
  const theirs = (await run(readJobs(sql))).map((j) => recordOf("localhost", j, "", now));
  expect(mine.map((j) => [j.id, j.phase, j.error, j.from])).toEqual(
    theirs.map((j) => [Number(j.id), j.phase as string, j.error ?? null, j.from])
  );
  expect(mine.map((j) => j.phase)).toEqual(["running", "stopped", "ok", "failed"]);
  expect(mine[3].error).toBe("the release was not healthy");
});

test("About: the repository, the branch, the commit and its release tag, as the server knows them; the settings' read has the same", async () => {
  // GitHub's list of the repository's refs, as git reads it. v0.1.0 has a message: its own line, then its commit's.
  const refs = [
    "001e# service=git-upload-pack",
    `0000015b${sha(4)} HEAD\0multi_ack side-band-64k`,
    `003d${sha(4)} refs/heads/main`,
    `003e${sha(9)} refs/tags/v0.1.0`,
    `0041${sha(1)} refs/tags/v0.1.0^{}`,
    `003e${sha(2)} refs/tags/v0.9.0`,
    `003f${sha(2)} refs/tags/v0.10.0`,
    `003d${sha(2)} refs/tags/nightly`,
    "0000",
  ].join("\n");
  const asked: string[] = [];
  let github: "up" | "down" = "up";
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/info/refs")) return real(input, init);
    asked.push(String(input));
    if (github == "down") throw new TypeError("no network");
    return new Response(refs);
  }) as typeof fetch;
  try {
    const { s, sql } = await world();
    const about = async () =>
      /<section class="server" aria-label="Version">.*?<\/section>/s.exec(await (await s.fetch("/admin/about")).text())![0];
    const cell = (html: string, name: string) => new RegExp(`<dd data-about="${name}">(.*?)</dd>`, "s").exec(html)![1];
    const read = async () => (await runTool(s, "settings")).result.about;
    // The server runs commit 2, which the deployer's look saw: its full name, title and date. Its newest tag is the release.
    let html = await about();
    const out = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    expect(cell(html, "repository")).toBe(out("https://github.com/example/erga", "github.com/example/erga"));
    expect(cell(html, "branch")).toBe(out("https://github.com/example/erga/tree/main", "main"));
    expect(cell(html, "commit")).toStartWith(
      `${out(`https://github.com/example/erga/commit/${sha(2)}`, "<code>222222222222</code>")}<span>Change 2</span><span class="src">`
    );
    expect(cell(html, "release")).toBe(out("https://github.com/example/erga/releases/tag/v0.10.0", "v0.10.0"));
    expect(asked).toEqual(["https://github.com/example/erga.git/info/refs?service=git-upload-pack"]);
    expect(await read()).toEqual({
      repository: "github.com/example/erga",
      branch: "main",
      commit: { hash: sha(2), title: "Change 2", date: new Date(COMMITS[2].at).toISOString() },
      release: "v0.10.0",
    });
    // A tag with a message is its commit's; a commit with no tag has no release.
    s.platform.deploy.version = sha(1).slice(0, 12);
    expect((await read()).release).toBe("v0.1.0");
    s.platform.deploy.version = sha(3).slice(0, 12);
    expect(cell(await about(), "release")).toStartWith("no release<span");
    expect((await read()).release).toBe("no release");
    // No answer from GitHub: the release is not known, and the rest stays.
    github = "down";
    html = await about();
    expect(cell(html, "release")).toBe('not known<span class="src">GitHub did not give the repository&#39;s tags.</span>');
    expect(cell(html, "commit")).toContain("Change 3");
    expect((await read()).release).toBe("not known");
    // A commit that the look did not see: its full name from the job log, with no title; else the deploy's short name.
    s.platform.deploy.version = sha(7).slice(0, 12);
    expect((await read()).commit).toEqual({ hash: sha(7).slice(0, 12) });
    const job = await run(openJob(sql, { kind: "deploy", command: "bun erga deploy localhost", source: "terminal" }));
    job.commit(sha(7));
    expect(await job.end({ at: "done" })).toBeNull();
    expect((await read()).commit).toEqual({ hash: sha(7) });
    // Only an admin reads the page; the quick search and the sidebar have it.
    expect((await s.fetch("/admin/about?user=ada")).status).toBe(404);
    expect(await (await s.fetch("/admin/about")).text()).toContain('<a href="/admin/about" aria-current="page">');
    // A server with no spec and no release: nothing is known, and GitHub is not asked.
    asked.length = 0;
    const none = server();
    const bare = await (await none.fetch("/admin/about")).text();
    for (const name of ["repository", "branch", "commit", "release"]) expect(cell(bare, name)).toStartWith("not known");
    expect((await runTool(none, "settings")).result.about).toEqual({
      repository: "not known",
      branch: "not known",
      commit: "not known",
      release: "not known",
    });
    expect(asked).toEqual([]);
  } finally {
    globalThis.fetch = real;
  }
});
