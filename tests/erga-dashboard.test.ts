// `bun erga dashboard` (deploy/cli/dashboard.ts, dashboard-page.ts): the page drawn from a fake state, and its actions,
// which only this machine's page may start (the run's token), run against a fake: nothing reaches GitHub.

import { afterAll, expect, test } from "bun:test";
import { actionRefusal, type Job, serveDashboard } from "../deploy/cli/dashboard";
import { liveHtml, pageHtml } from "../deploy/cli/dashboard-page";
import { stateOf } from "../deploy/cli/flow";

const M = "a".repeat(40),
  S = "b".repeat(40);
const NOW = Date.parse("2026-11-04T12:00:00Z");
const commit = (i: number, kind: string) => ({
  sha: String(i).padStart(40, kind),
  subject: `Commit ${kind}${i}`,
  at: NOW - i * 60_000,
  author: "Pete",
});

function fakeState(waiting = 2) {
  return stateOf({
    repo: "koomen/erga",
    at: NOW,
    heads: { main: M, staging: S },
    servers: [
      { name: "production", host: "erga.dev", branch: "main", version: M.slice(0, 12), healthy: true },
      { name: "staging", host: "staging.erga.dev", branch: "staging", version: "c".repeat(12), healthy: true },
    ],
    runs: [
      {
        sha: M,
        branch: "main",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/koomen/erga/actions/runs/11",
        at: NOW - 3_600_000,
      },
      {
        sha: S,
        branch: "staging",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/koomen/erga/actions/runs/22",
        at: NOW - 60_000,
      },
    ],
    branches: [
      {
        name: "clean-one",
        sha: "1".repeat(40),
        ahead: 1,
        behind: 0,
        conflicts: [],
        at: NOW - 120_000,
        subject: "A clean change",
        author: "Pete",
      },
      { name: "clashes", sha: "2".repeat(40), ahead: 2, behind: 3, conflicts: ["AGENTS.md"], at: NOW, subject: "A clash" },
    ],
    waiting: [{ ...commit(0, "b"), sha: S }, ...Array.from({ length: waiting - 1 }, (_, i) => commit(i + 1, "b"))],
    log: [{ sha: M, subject: "On main", at: NOW - 7_200_000, author: "Pete" }],
    tags: [{ name: "v0.1.0", sha: M }],
  });
}

test("the page, drawn from a fake state: the servers, the branches and the log, as the old Ops page had them", () => {
  const html = liveHtml(fakeState(), NOW);
  // A card for each server: production live, staging's last run failed (Retry and Log).
  expect(html).toContain('<div class="env deployed" id="env-production">');
  expect(html).toContain('<div class="env failed" id="env-staging">');
  expect(html).toContain('data-act="rerun" data-run="22"');
  // The branches: a clean one can merge, a clash can't, and says where.
  expect(html).toContain('<span class="f-state clean">Merges cleanly</span>');
  expect(html).toContain("Conflicts in 1 file: AGENTS.md");
  expect(html).toMatch(/data-act="merge-open" data-branch="clean-one" data-message="A clean change">/);
  expect(html).toMatch(/data-act="merge-open" data-branch="clashes" data-message=""\s*disabled>/);
  // The log: staging's own commits first (hollow), then main's (solid), with "live" in production's column and the
  // release tag; staging's column comes first.
  expect(html).toContain('class="row staging-only"');
  expect(html).toContain('class="row on-main"');
  expect(html).toContain('<span class="w">live</span>');
  expect(html).toContain('v0.1.0 <span class="chan">latest</span>');
  expect(html.indexOf('<b>staging</b><span class="host">')).toBeLessThan(html.indexOf('<b>production</b><span class="host">'));
  expect(html).toContain("staging is 2 commits ahead of production");
  // No break in a short log; a break with the count when staging is 17 or more ahead.
  expect(html).not.toContain('class="gap"');
  expect(liveHtml(fakeState(20), NOW)).toContain("… 4 more commits only on staging …");
  // The page carries this run's token, and the script.
  expect(pageHtml({ token: "T0k", live: html, script: "/*s*/" })).toContain('<meta name="erga-token" content="T0k">');
});

test("an action needs this machine, this server's name, this page's origin and the run's token", () => {
  const ok = { port: 4748, ip: "127.0.0.1", host: "localhost:4748", origin: "http://localhost:4748", token: "secret", given: "secret" };
  expect(actionRefusal(ok)).toBeNull();
  expect(actionRefusal({ ...ok, origin: null })).toBeNull();
  expect(actionRefusal({ ...ok, ip: "::1" })).toBeNull();
  expect(actionRefusal({ ...ok, ip: "192.168.1.20" })).toBe("Only this machine may act.");
  expect(actionRefusal({ ...ok, host: "evil.example:4748" })).toBe("Wrong host.");
  expect(actionRefusal({ ...ok, origin: "https://evil.example" })).toBe("Wrong origin.");
  expect(actionRefusal({ ...ok, given: null })).toContain("No token");
  expect(actionRefusal({ ...ok, given: "secreT" })).toContain("No token");
});

const started: { job: Job; argv: string[] }[] = [];
const { server, token } = serveDashboard({
  port: 0,
  repo: "koomen/erga",
  read: async () => fakeState(),
  run: (job, argv, onEnd) => {
    started.push({ job, argv });
    job.lines.push("PASS  fake");
    job.done = true;
    job.ok = true;
    onEnd();
  },
});
afterAll(() => server.stop(true));
const root = `http://127.0.0.1:${server.port}`;
const act = (body: unknown, headers: Record<string, string> = { "X-Erga-Token": token }) =>
  fetch(`${root}/api/action`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the server: the page has the token; an action without it, or from another site, runs nothing", async () => {
  const page = await (await fetch(`${root}/`)).text();
  expect(page).toContain(`content="${token}"`);
  expect(await (await fetch(`${root}/view`)).text()).toContain("clean-one");

  expect((await act({ action: "promote" }, {})).status).toBe(403);
  expect((await act({ action: "promote" }, { "X-Erga-Token": "wrong" })).status).toBe(403);
  expect((await act({ action: "promote" }, { "X-Erga-Token": token, Origin: "https://evil.example" })).status).toBe(403);
  expect((await fetch(`${root}/api/log?run=1`)).status).toBe(403);
  expect(started).toEqual([]);
});

test("the server: each button runs its bun erga command, and only a real feature branch or version", async () => {
  expect((await act({ action: "merge", branch: "main" })).status).toBe(400);
  expect((await act({ action: "merge", branch: "--force" })).status).toBe(400);
  expect((await act({ action: "release", version: "1.0" })).status).toBe(400);
  expect((await act({ action: "rollback", server: "koomen" })).status).toBe(400);
  expect(started).toEqual([]);

  const r = await act({ action: "merge", branch: "clean-one", message: "One change" });
  expect(r.status).toBe(200);
  const { job } = (await r.json()) as { job: number };
  expect(started.at(-1)!.argv.slice(-4)).toEqual(["merge", "clean-one", "-m", "One change"]);
  const out = (await (await fetch(`${root}/api/job?id=${job}`, { headers: { "X-Erga-Token": token } })).json()) as Job;
  expect(out).toMatchObject({ done: true, ok: true, lines: ["$ bun erga merge clean-one -m One change", "PASS  fake"] });

  await act({ action: "rollback", server: "production" });
  expect(started.at(-1)!.argv.slice(-3)).toEqual(["rollback", "production", "--yes"]);
  await act({ action: "promote" });
  expect(started.at(-1)!.argv.slice(-1)).toEqual(["promote"]);
  await act({ action: "rerun", run: "22" });
  expect(started.at(-1)!.argv).toEqual(["gh", "run", "rerun", "22", "--failed", "-R", "koomen/erga"]);
});
