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
  };
  const html = viewHtml(facts, "staging.erga.dev", NOW);
  // A staging instance's name chooses its primary.
  expect(html).toContain('<a class="group sel" href="#erga.dev"');
  expect(html).toContain('<div class="job ok"');
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
