// The ops page's view (deploy/cli/ops-view.ts): a job record read from its lines, the primaries with their staging
// instances, and the Deploys tab drawn from fake facts.

import { expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { type Facts, groupsOf, jobOf, viewHtml } from "../deploy/cli/ops-view";

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
  const facts: Facts = { config, answers: {}, git: { error: "no git" }, jobs: [], setup: "new.example.com" };
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
