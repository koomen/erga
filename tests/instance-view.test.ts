// The view of one instance's deploys (shared/ops-view.ts), as a page with no list of instances draws it (the app's
// /admin/ops): no heading of its own, a commit whose release GitHub does not have takes no deploy, and a job that the
// app asked for says so. tests/ops-view.test.ts covers the rest, through the ops page of a machine. And its
// stylesheet: every rule is under .ops-view, so that a page that loads it keeps its own look.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { type InstanceView, instanceHtml, type ViewJob } from "../shared/ops-view";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const sha = (n: number) => String(n).repeat(40);
const job = (more: Partial<ViewJob>): ViewJob => ({
  id: "1",
  commit: sha(2),
  phase: "ok",
  command: `deploy ${sha(2).slice(0, 12)}`,
  from: "app, by ada",
  started: "2026-11-05T11:00:00.000Z",
  ended: "2026-11-05T11:01:04.000Z",
  out: ["Worker: done"],
  ...more,
});
const view = (more: Partial<InstanceView> = {}): InstanceView => ({
  host: "erga.example.com",
  heading: false,
  repo: "github.com/example/erga",
  branch: "main",
  commits: [
    { sha: sha(4), subject: "Change 4 <b>", at: NOW - 60_000, release: "none" },
    { sha: sha(3), subject: "Change 3", at: NOW - 3_600_000, release: "released" },
    { sha: sha(2), subject: "Change 2", at: NOW - 7_200_000, release: "released" },
    { sha: sha(1), subject: "Change 1", at: NOW - 9_000_000, release: "refused" },
  ],
  none: "",
  runs: sha(2).slice(0, 12),
  lost: "",
  jobs: [job({})],
  starting: null,
  failed: null,
  busy: false,
  deploying: [],
  rolling: false,
  rollbackNote: "No branch moves.",
  href: (tab, id) => `/admin/ops?tab=${tab}${id ? `&job=${id}` : ""}`,
  ...more,
});
/** The row of a commit: its cell's text, and whether it has a button. */
const rowOf = (html: string, n: number) => new RegExp(`<div class="row \\w+" data-sha="${sha(n)}">.*?</div>`).exec(html)![0];

test("a page with its own heading: no heading here, and each tab and job at the address that the page gives", () => {
  const html = instanceHtml(view(), "", "", NOW);
  expect(html).not.toContain("<h2");
  expect(html).toContain('<p class="tracks-line">Tracks <code>github.com/example/erga</code> <code>main</code>.</p>');
  expect(html).toContain('<a class="tab" role="tab" href="/admin/ops?tab=history" aria-selected="false">History</a>');
  expect(html).toContain('<a class="job ok" href="/admin/ops?tab=logs&amp;job=1" title="done 59 minutes ago · from the app, by ada">');
  expect(instanceHtml(view({ heading: true }), "", "", NOW)).toContain('<h2 class="title">erga.example.com</h2>');
});

test("a commit takes a deploy only when GitHub has its release; the live one has Roll back", () => {
  const html = instanceHtml(view(), "deploys", "", NOW);
  // The head: GitHub has no release of it yet, so it has no button, and its subject is escaped.
  expect(rowOf(html, 4)).toContain('<span class="dep wait">no release yet</span>');
  expect(rowOf(html, 4)).toContain("Change 4 &lt;b&gt;");
  expect(rowOf(html, 4)).not.toContain("<button");
  expect(rowOf(html, 3)).toContain(`data-deploy data-host="erga.example.com" data-sha="${sha(3)}"`);
  expect(rowOf(html, 2)).toContain('<span class="w">live</span><span class="at">59m</span>');
  expect(rowOf(html, 2)).toContain("data-rollback");
  expect(rowOf(html, 1)).toContain('<span class="dep wait">refused</span>');
  expect(rowOf(html, 1)).not.toContain("<button");
  // A commit with no author has an empty cell for it.
  expect(rowOf(html, 3)).toContain('<span class="who"></span>');
});

test("an ask that waits is the job line; the page with no commits says why, and still shows the jobs", () => {
  const waits = instanceHtml(
    view({ starting: { command: "rollback", what: "asked by ada · the deployer starts it" }, busy: true }),
    "",
    "",
    NOW
  );
  expect(waits).toContain(
    '<div class="job running"><i class="light"></i><code>rollback</code><span>asked by ada · the deployer starts it</span></div>'
  );
  expect(rowOf(waits, 3)).toContain("disabled");
  const local = view({ commits: null, none: "This server deploys from a machine." });
  expect(instanceHtml(local, "deploys", "", NOW)).toContain('<div class="none">This server deploys from a machine.</div>');
  expect(instanceHtml(local, "history", "", NOW)).toContain('<span class="h-from">app, by ada</span>');
  expect(instanceHtml(local, "logs", "1", NOW)).toContain("<span>Worker: done</span>");
});

test("every rule of the view's stylesheet is under .ops-view", () => {
  const css = readFileSync(new URL("../assets/ops/ops-view.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Each rule's selectors: what is before a "{" that opens declarations (not an at-rule's block, not a keyframe's step).
  const loose: string[] = [];
  for (const m of css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").matchAll(/([^{}]+)\{/g))
    for (const selector of m[1].trim().startsWith("@") ? [] : m[1].split(","))
      if (!/^(:root\S* )?\.ops-view( |$)/.test(selector.trim())) loose.push(selector.trim());
  expect(loose).toEqual([]);
  expect(css).toContain(".ops-view .main {");
});
