// The ops page's view (deploy/cli/ops-view.ts): a job record read from its lines, the list of the instances, and the
// right side, which is about the chosen instance only: its job line, the commits of its branch with its Deploy buttons,
// its Logs and its History, drawn from fake facts. The page's server (deploy/cli/ops-page.ts) starts a deploy with a
// fake `bun erga`: nothing deploys.

import { expect, test } from "bun:test";
import type { Entry } from "../deploy/cli/config";
import { type Run, stepRun } from "../deploy/cli/job-state";
import { type Facts, type JobRecord, jobOf, viewHtml } from "../deploy/cli/ops-view";
import { REWRITTEN } from "../deploy/cli/auto-state";
import { startPolls, stepPolls } from "../deploy/cli/poll-state";
import { runOf } from "./helpers/pass.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const entry = (host: string, branch = "main", more: Partial<Entry> = {}): Entry => ({
  host,
  repo: "example.com/team/erga",
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

/** staging has five commits; main has the first three of them. */
const STAGING = ["5", "4", "3", "2", "1"].map((n, i) => ({
  sha: n.repeat(40),
  subject: `Change ${n}`,
  author: "Pete",
  at: NOW - i * 3_600_000,
}));
const MAIN = STAGING.slice(2);
const HOSTS = ["example.net", "staging.example.net", "notes.example.org"];
/**
 * Three instances. example.net tracks main and runs its head (3). staging.example.net tracks staging and runs 4: its
 * head (5) is not deployed. notes.example.org tracks main and runs 2: one commit behind.
 */
const facts = (more: Partial<Facts> = {}): Facts => ({
  config: { instances: [entry("example.net"), entry("staging.example.net", "staging"), entry("notes.example.org")] },
  answers: {
    "example.net": { version: "3".repeat(12), healthy: true },
    "staging.example.net": { version: "4".repeat(12), healthy: true },
    "notes.example.org": { version: "2".repeat(12), healthy: true },
  },
  logs: { "example.net": MAIN, "staging.example.net": STAGING, "notes.example.org": MAIN },
  heads: { "example.net": "3".repeat(40), "staging.example.net": "5".repeat(40), "notes.example.org": "3".repeat(40) },
  upstreams: {},
  jobs: [],
  run: { at: "idle" },
  polls: startPolls(),
  runs: [],
  auto: null,
  verify: { state: null, runs: [], kept: {}, busy: "", error: "" },
  ...more,
});
/** A job's record: a deploy of commit n...n to `host` (or another command), done unless `more` says otherwise. */
const job = (id: string, host: string, n: string, more: { command?: string; from?: string; ends?: string | null; started?: string } = {}) =>
  jobOf(
    line({
      ...start,
      command: more.command ?? `bun erga deploy ${n.repeat(12)} ${host}`,
      host,
      from: more.from ?? "terminal",
      started: more.started ?? start.started,
    }) +
      (n ? line({ commit: n.repeat(40) }) : "") +
      line({ out: `out of ${id}` }) +
      (more.ends === null ? "" : line({ result: "ok", ended: more.ends ?? "2026-11-05T11:55:00.000Z" })),
    () => true,
    id
  )!;
/** The page's own command as it starts: a deploy of commit n...n to `host`. */
const starts = (n: string, host = "staging.example.net"): Run =>
  stepRun(
    { at: "idle" },
    {
      type: "start",
      command: `bun erga deploy ${n.repeat(12)} ${host}`,
      job: { kind: "deploy", host, commit: n.repeat(40), branch: null, phase: "starting" },
    }
  );
/** A merge that runs, from a terminal: its job record. */
const merging = () => jobOf(line({ ...start, command: "bun erga merge clean", host: "staging" }), () => true, "merge-1")!;
/** The right side of the page, and the list on the left. */
const right = (html: string) => html.slice(html.indexOf('<section class="main"'));
const left = (html: string) => html.slice(0, html.indexOf('<section class="main"'));
/** The row of a commit, in the view's HTML. */
const rowOf = (html: string, n: string) =>
  new RegExp(`<div class="row \\w+" data-sha="${n.repeat(40)}">.*?</div>(?=<div class="row|</div>)`).exec(html)?.[0] ?? "";
/** Whether the HTML names the host: a name counts only when it stands alone (erga.example.net does not name example.net). */
const names = (html: string, host: string) => new RegExp(`(^|[^\\w.-])${host.replaceAll(".", "\\.")}([^\\w.-]|$)`).test(html);
/** Each instance's word in the list, by its host; "": none. */
const words = (html: string) =>
  Object.fromEntries(
    [
      ...left(html)
        .split('<p class="side-auto"')[0]
        .matchAll(/href="#([^"]+)".*?<\/a>/g),
    ].map((m) => [m[1], /class="g-state \w+"[^>]*>([^<]*)</.exec(m[0])?.[1] ?? ""])
  );

test("the right side is about the chosen instance only: it names no other instance, in text or in a tooltip", () => {
  // Every other instance has a job: one that ended, one that runs, one that the page starts; a merge and a promote too.
  const busy = facts({
    jobs: [
      job("d1", "example.net", "3"),
      job("d2", "staging.example.net", "4"),
      job("d3", "notes.example.org", "2"),
      job("runs", "notes.example.org", "3", { ends: null, from: "auto-deploy" }),
      merging(),
      job("p1", "main", "", { command: "bun erga promote" }),
    ],
    auto: {
      "example.net": { at: "idle", done: null },
      "staging.example.net": { at: "due", head: "5".repeat(40) },
      "notes.example.org": { at: "deploying", head: "3".repeat(40), newer: null },
    },
  });
  for (const f of [
    facts(),
    busy,
    facts({ run: starts("5") }),
    facts({ run: { at: "failed", host: "staging.example.net", why: "bun erga deploy 555555555555 staging.example.net stopped: no" } }),
  ])
    for (const host of HOSTS)
      for (const tab of ["", "/logs", "/history"]) {
        const html = right(viewHtml(f, host + tab, NOW));
        // erga.example.net would hold example.net: a name counts only when it stands alone.
        for (const other of HOSTS.filter((h) => h != host)) expect(names(html, other), `${host}${tab} names ${other}`).toBe(false);
        expect(html, `${host}${tab}`).not.toMatch(/bun erga (merge|promote)/);
      }
  // A button that is off for another instance's job says only that a job runs.
  const off = right(viewHtml(busy, "staging.example.net", NOW));
  expect(off).toContain('<span class="tip" title="Another job runs. Wait for it to end."><button class="btn" type="button" data-deploy');
  expect(off.match(/data-deploy [^>]* disabled>/g)?.length).toBe(4);
  // The page's own failed command shows on its instance's page only.
  const failed = facts({
    run: { at: "failed", host: "staging.example.net", why: "bun erga deploy 555555555555 staging.example.net stopped: no" },
  });
  expect(right(viewHtml(failed, "staging.example.net", NOW))).toContain('<p class="note bad failed">');
  expect(right(viewHtml(failed, "example.net", NOW))).not.toContain("note bad failed");
});

test("the list: each instance with its branch, one word when it is not at its branch's head, and auto-deploy one time", () => {
  const html = viewHtml(facts(), "example.net", NOW);
  // A flat list: each instance, with the branch it tracks under its name.
  expect(
    [...html.matchAll(/<a class="group( sel)?" href="#([^"]+)"[^>]*>.*?<span class="tracks"[^>]*><span>(\w+)<\/span>/g)].map((m) =>
      m.slice(1).map((x) => x ?? "")
    )
  ).toEqual([
    [" sel", "example.net", "main"],
    ["", "staging.example.net", "staging"],
    ["", "notes.example.org", "main"],
  ]);
  expect(words(html)).toEqual({ "example.net": "", "staging.example.net": "1 behind", "notes.example.org": "1 behind" });
  // A deploy that runs, an auto-deploy that stopped, a repository that gave no answer.
  const polls = stepPolls(stepPolls(startPolls(), { type: "sources", names: ["repo example.com/team/erga"], now: 0 }).polls, {
    type: "answer",
    name: "repo example.com/team/erga",
    now: 1000,
    error: "fatal: could not read",
  }).polls;
  expect(words(viewHtml(facts({ run: starts("5") }), "example.net", NOW))["staging.example.net"]).toBe("deploying");
  expect(
    words(viewHtml(facts({ jobs: [job("r", "notes.example.org", "3", { ends: null })] }), "example.net", NOW))["notes.example.org"]
  ).toBe("deploying");
  expect(
    words(viewHtml(facts({ auto: { "notes.example.org": { at: "failed", head: "3".repeat(40), why: "no" } } }), "example.net", NOW))[
      "notes.example.org"
    ]
  ).toBe("failed");
  expect(Object.values(words(viewHtml(facts({ polls }), "example.net", NOW)))).toEqual([
    "can&#39;t read",
    "can&#39;t read",
    "can&#39;t read",
  ]);
  // Auto-deploy is a fact of the whole page: one line under the list, and nothing on the right side.
  const on = viewHtml(facts({ auto: {} }), "example.net", NOW);
  expect(left(on)).toContain('<p class="side-auto"><i class="light ok"></i><span>Auto-deploy is on</span></p>');
  expect(left(html)).toContain("<span>Auto-deploy is off</span>");
  expect(right(on)).not.toMatch(/auto-deploy/i);
  expect(right(html)).toContain("Tracks <code>example.com/team/erga</code> <code>main</code>.</p>");
  expect(viewHtml(facts(), "staging.example.net", NOW)).toContain('<a class="group sel" href="#staging.example.net"');
});

test("the commits are the chosen instance's branch, in one column: green where it is live, orange where it is not yet", () => {
  // An instance on main shows no commit of staging.
  const main = right(viewHtml(facts({ jobs: [job("d1", "example.net", "3")] }), "example.net", NOW));
  expect([...main.matchAll(/<div class="row (\w+)" data-sha="(\d)/g)].map((m) => m[2] + m[1])).toEqual(["3on", "2on", "1on"]);
  expect(main).toContain('<div class="grid" style="--cols: 1">');
  expect(main).not.toContain("head col");
  // No feature branch, no Merge, no proof link and no legend: bun erga status and bun erga merge have them.
  for (const gone of ["Feature branches", "data-merge", "f-proof", 'class="legend"']) expect(main, gone).not.toContain(gone);
  expect(rowOf(main, "3")).toMatch(/<span class="dep live"[^>]*><span class="w">live<\/span><span class="at">5m<\/span>/);
  expect(rowOf(main, "3")).toContain('title="Live on example.net"');
  // An instance on staging, one commit behind its head: the head is orange, and its Deploy button shows always.
  const staging = right(viewHtml(facts(), "staging.example.net", NOW));
  expect([...staging.matchAll(/<div class="row (\w+)" data-sha="(\d)/g)].map((m) => m[2] + m[1])).toEqual([
    "5off",
    "4on",
    "3on",
    "2on",
    "1on",
  ]);
  expect(rowOf(staging, "5")).toContain('title="On staging, not on staging.example.net yet"');
  expect(rowOf(staging, "5")).toContain(
    `<span class="deps here show"><span class="tip"><button class="btn" type="button" data-deploy data-host="staging.example.net" data-sha="${"5".repeat(40)}" data-ask="Deploy 5555555 Change 5 to staging.example.net?"`
  );
  // An older commit: its button shows under the mouse or with the focus (ops-page.css, .deps.here).
  expect(rowOf(staging, "3")).toContain('<span class="deps here"><span class="tip"><button class="btn" type="button" data-deploy');
  expect(rowOf(staging, "3")).toContain('data-note="staging.example.net tracks staging. No branch moves."');
  expect(staging.match(/data-deploy /g)?.length).toBe(4);
  expect(staging).toContain('<div class="confirm" id="deploy-confirm" popover>');
  // It runs a commit that its branch does not have: the page says so, and no row is green.
  const lost = right(viewHtml(facts({ answers: { "example.net": { version: "9".repeat(12), healthy: true } } }), "example.net", NOW));
  expect(lost).toContain("example.net runs 999999999999, which main does not have in this clone.");
  expect(lost).not.toContain('class="row on"');
  // The commits are not here yet; or its repository gave no answer.
  expect(right(viewHtml(facts({ logs: {} }), "example.net", NOW))).toContain(
    '<div class="none">The commits of main are not here yet.</div>'
  );
});

test("an upstream: its commits that the branch lacks are orange rows on top, and a tag marks each of the two heads", () => {
  const up = (repo: string, branch: string) => ({ upstream: { repo, branch } });
  const config = {
    instances: [
      entry("example.net", "main", up("example.com/team/erga", "staging")),
      entry("staging.example.net", "staging", up("example.com/team/erga", "main")),
      entry("notes.example.org", "main", up("github.com/koomen/erga", "main")),
    ],
  };
  const others = ["9", "8"].map((n, i) => ({ sha: n.repeat(40), subject: `Upstream ${n}`, author: "Sam", at: NOW - i * 60_000 }));
  const f = facts({
    config,
    upstreams: {
      // main lacks two commits of staging; staging has main's head, and two commits of its own; the fork and Erga's main went apart.
      "example.net": { head: "5".repeat(40), behind: STAGING.slice(0, 2), ahead: 0 },
      "staging.example.net": { head: "3".repeat(40), behind: [], ahead: 2 },
      "notes.example.org": { head: "9".repeat(40), behind: others, ahead: 3 },
    },
  });
  const marks = (html: string) => [...html.matchAll(/<div class="row (\w+)" data-sha="(\d)/g)].map((m) => m[2] + m[1]);
  const tags = (html: string, n: string) =>
    [...rowOf(html, n).matchAll(/<span class="ref" title="([^"]*)">([^<]*)</g)].map((m) => `${m[2]}|${m[1]}`);
  // Behind: the upstream's commits on top, orange, with no Deploy; then the branch, from its tag down.
  const behind = right(viewHtml(f, "example.net", NOW));
  expect(behind).toContain("Tracks <code>example.com/team/erga</code> <code>main</code>. Upstream: <code>staging</code>.</p>");
  expect(marks(behind)).toEqual(["5off", "4off", "3on", "2on", "1on"]);
  expect(tags(behind, "5")).toEqual(["staging|staging, the upstream, is at this commit"]);
  expect(tags(behind, "3")).toEqual(["main|main, the branch that example.net tracks, is at this commit"]);
  expect(rowOf(behind, "5")).toContain('title="On staging, not on main yet"');
  expect(rowOf(behind, "5")).toContain('<span class="deps" title="Not on main, the branch that example.net tracks"></span>');
  expect(behind.match(/data-deploy /g)?.length).toBe(2);
  // The line joins them: the upstream's commits are the branch's next ones.
  expect(rowOf(behind, "4")).toContain('class="rail up down off"');
  expect(rowOf(behind, "3")).toContain('class="rail up down on"');
  // Ahead: no row comes from the upstream; its tag sits on the branch's commit that it is at.
  const ahead = right(viewHtml(f, "staging.example.net", NOW));
  expect(marks(ahead)).toEqual(["5off", "4on", "3on", "2on", "1on"]);
  expect(tags(ahead, "5")).toEqual(["staging|staging, the branch that staging.example.net tracks, is at this commit"]);
  expect(tags(ahead, "3")).toEqual(["main|main, the upstream, is at this commit"]);
  expect(rowOf(ahead, "5")).toContain("data-deploy");
  // Apart, with another repository: the line breaks between the upstream's commits and the branch's.
  const apart = right(viewHtml(f, "notes.example.org", NOW));
  expect(apart).toContain("Upstream: <code>github.com/koomen/erga</code> <code>main</code>.</p>");
  expect(marks(apart)).toEqual(["9off", "8off", "3off", "2on", "1on"]);
  expect(tags(apart, "9")).toEqual(["github.com/koomen/erga main|github.com/koomen/erga main, the upstream, is at this commit"]);
  expect(rowOf(apart, "8")).toContain('class="rail up off"');
  expect(rowOf(apart, "3")).toContain('class="rail down off"');
  // Far behind: the newest 15, and one line with the count of the others.
  const many = Array.from({ length: 18 }, (_, i) => ({
    sha: `${String.fromCharCode(97 + i)}`.repeat(40),
    subject: `U ${i}`,
    author: "Sam",
    at: NOW,
  }));
  const far = right(
    viewHtml(facts({ config, upstreams: { "example.net": { head: many[0].sha, behind: many, ahead: 0 } } }), "example.net", NOW)
  );
  expect(far.match(/class="row off"/g)?.length).toBe(15);
  expect(far).toContain('<div class="more">and 3 more commits of staging</div>');
  // No comparison yet, or no upstream: the branch's own commits, and no tag.
  expect(right(viewHtml(facts({ config }), "example.net", NOW))).not.toContain('class="ref"');
  expect(right(viewHtml(facts(), "example.net", NOW))).not.toContain("Upstream");
  // The rule holds: an upstream names branches and repositories, never an instance.
  for (const host of HOSTS)
    for (const other of HOSTS.filter((h) => h != host))
      expect(names(right(viewHtml(f, host, NOW)), other), `${host} names ${other}`).toBe(false);
});

test("Checked names the upstream's repository when it is another one", () => {
  const sources = ["repo example.com/team/erga", "repo github.com/koomen/erga", "notes.example.org"];
  let polls = stepPolls(startPolls(), { type: "sources", names: sources, now: NOW - 60_000 }).polls;
  for (const name of sources) polls = stepPolls(polls, { type: "answer", name, now: NOW - 42_000, error: null }).polls;
  const config = { instances: [entry("notes.example.org", "main", { upstream: { repo: "github.com/koomen/erga", branch: "main" } })] };
  expect(right(viewHtml(facts({ config, polls }), "notes.example.org", NOW))).toContain(
    '<span class="check ok" data-source="repo example.com/team/erga"><i class="light ok"></i>example.com/team/erga main, 42 s ago</span><span class="check ok" data-source="repo github.com/koomen/erga"><i class="light ok"></i>github.com/koomen/erga main, 42 s ago</span><span class="check ok" data-source="notes.example.org">'
  );
});

test("the job line, Logs and History are the chosen instance's deploys and rollbacks", () => {
  const f = facts({
    jobs: [
      job("old", "example.net", "2", { started: "2026-11-05T10:00:00.000Z", ends: "2026-11-05T10:00:30.000Z" }),
      job("back", "example.net", "", {
        command: "bun erga rollback example.net",
        started: "2026-11-05T10:30:00.000Z",
        ends: "2026-11-05T10:30:04.000Z",
      }),
      job("runs", "staging.example.net", "5", { ends: null, started: "2026-11-05T11:00:00.000Z" }),
      job("other", "notes.example.org", "2", { started: "2026-11-05T11:30:00.000Z" }),
      merging(),
    ],
  });
  // The job line: its own last job, though another instance's job runs.
  const page = right(viewHtml(f, "example.net", NOW));
  expect(page).toContain('<a class="job ok" href="#example.net/logs/back"');
  expect(page).toContain("<code>bun erga rollback example.net</code>");
  expect(right(viewHtml(f, "staging.example.net", NOW))).toContain('<a class="job running" href="#staging.example.net/logs/runs"');
  expect(right(viewHtml(facts(), "example.net", NOW))).toContain("No job yet.");
  // The page's own command, before its job record shows: on its instance's page.
  const own = facts({ run: starts("5") });
  expect(right(viewHtml(own, "staging.example.net", NOW))).toContain(
    '<div class="job running"><i class="light"></i><code>bun erga deploy 555555555555 staging.example.net</code><span>starts · from this page</span></div>'
  );
  expect(right(viewHtml(own, "example.net", NOW))).toContain("No job yet.");
  // Logs: the job that runs, else the last one, or the one the hash names.
  const logs = viewHtml(f, "example.net/logs", NOW);
  expect(logs).toContain('<section class="logs" data-job="back"');
  expect(logs).toContain("<span>out of back</span>");
  expect(logs).toContain('<a class="tab" role="tab" href="#example.net/logs" aria-selected="true">Logs</a>');
  expect(viewHtml(f, "example.net/logs/old", NOW)).toContain('<section class="logs" data-job="old"');
  expect(viewHtml(f, "example.net/logs/other", NOW)).toContain('<section class="logs" data-job="back"');
  // History: its jobs, newest first, with no Instance column.
  const history = viewHtml(f, "example.net/history", NOW);
  expect([...history.matchAll(/class="h-row [^"]*" href="[^"]*" data-job="(\w+)"/g)].map((m) => m[1])).toEqual(["back", "old"]);
  expect(history).toContain('<span class="h-took">30 s</span>');
  expect(history).toContain("<span>Result</span><span>Command</span><span>From</span><span>Started</span><span>Took</span>");
  expect(history).not.toContain("h-host");
  // A job that auto-deploy started says so.
  const auto = facts({ jobs: [job("a1", "example.net", "3", { from: "auto-deploy" })] });
  expect(viewHtml(auto, "example.net/history", NOW)).toContain('<span class="h-from">auto-deploy</span>');
  expect(viewHtml(auto, "example.net", NOW)).toContain("done 5 minutes ago · from auto-deploy");
  // An unknown tab is Deploys.
  expect(viewHtml(f, "example.net/nope", NOW)).toContain('data-tab="deploys"');
});

test("while its deploy runs, its cell says Deploying… with a spinner, on its instance's page", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  // The page started it: only its cell says Deploying…, and it stays shown with no hover.
  const deploying = right(viewHtml(facts({ run: starts("3") }), "staging.example.net", NOW));
  expect(rowOf(deploying, "3")).toContain(
    `<span class="deps here busy"><span class="tip" title="It deploys now. The job line and Logs show its output."><button class="btn" type="button" data-deploy data-host="staging.example.net"`
  );
  expect(rowOf(deploying, "3")).toContain(`aria-busy="true" disabled>${SPIN}Deploying…</button>`);
  expect(deploying.match(/class="spin"/g)?.length).toBe(1);
  // The instance answers the new commit before the job ends: the cell still says Deploying…, not live.
  const answered = facts({
    run: starts("3"),
    answers: { ...facts().answers, "staging.example.net": { version: "3".repeat(12), healthy: true } },
  });
  expect(rowOf(right(viewHtml(answered, "staging.example.net", NOW)), "3")).toContain(`${SPIN}Deploying…`);
  expect(rowOf(right(viewHtml(answered, "staging.example.net", NOW)), "3")).not.toContain("live");
  // A terminal's deploy: from its record's host and commit, whatever its flags.
  for (const command of [
    `bun erga deploy ${"3".repeat(12)} staging.example.net --no-tests`,
    "bun erga deploy staging.example.net",
    `bun erga deploy ${"3".repeat(12)} https://staging.example.net`,
  ]) {
    const html = right(
      viewHtml(facts({ jobs: [job("t", "staging.example.net", "3", { command, ends: null })] }), "staging.example.net", NOW)
    );
    expect(rowOf(html, "3"), command).toContain(`${SPIN}Deploying…`);
    expect(html.match(/class="spin"/g)?.length, command).toBe(1);
  }
  // Before its record names the commit, no cell says Deploying…; every button waits.
  const early = right(
    viewHtml(
      facts({ jobs: [job("e", "staging.example.net", "", { command: "bun erga deploy staging.example.net", ends: null })] }),
      "staging.example.net",
      NOW
    )
  );
  expect(early).not.toContain("spin");
  expect(early.match(/data-deploy [^>]* disabled>/g)?.length).toBe(4);
  // Another instance's deploy, or a merge, spins nothing here: the buttons wait.
  for (const jobs of [[job("o", "notes.example.org", "3", { ends: null })], [merging()]]) {
    const waits = right(viewHtml(facts({ jobs }), "staging.example.net", NOW));
    expect(waits).not.toContain("spin");
    expect(waits.match(/data-deploy [^>]* disabled>/g)?.length).toBe(4);
  }
});

test("Roll back: on the live row, in place of the live mark under the mouse; it says Rolling back… while it runs", () => {
  const SPIN = '<i class="spin" aria-hidden="true"></i>';
  const html = right(viewHtml(facts(), "staging.example.net", NOW));
  // The live row has the mark and the button; no other row has a Roll back.
  expect(rowOf(html, "4")).toContain(
    '<span class="deps here back"><span class="dep live" data-host="staging.example.net" title="staging.example.net runs this commit"><span class="w">live</span><span class="at"></span></span><span class="tip"><button class="btn quiet" type="button" data-rollback data-host="staging.example.net" data-ask="Roll back staging.example.net to the version from before its last deploy?" data-note="bun erga rollback staging.example.net. No branch moves. The next deploy goes forward again." aria-label="Roll back staging.example.net">Roll back</button></span></span>'
  );
  expect(html.match(/data-rollback/g)?.length).toBe(1);
  // While another job runs, it is off, and says only that a job runs.
  const off = right(viewHtml(facts({ jobs: [job("o", "notes.example.org", "3", { ends: null })] }), "staging.example.net", NOW));
  expect(rowOf(off, "4")).toContain(
    '<span class="tip" title="Another job runs. Wait for it to end."><button class="btn quiet" type="button" data-rollback'
  );
  expect(rowOf(off, "4")).toMatch(/data-rollback [^>]* disabled>/);
  // Its own rollback runs: the live row says so, and the list says "rolling back".
  const back = job("b", "staging.example.net", "", { command: "bun erga rollback staging.example.net", ends: null });
  const rolling = viewHtml(facts({ jobs: [back] }), "staging.example.net", NOW);
  expect(rowOf(right(rolling), "4")).toContain(`aria-busy="true" disabled>${SPIN}Rolling back…</button>`);
  expect(rowOf(right(rolling), "4")).not.toContain("dep live");
  expect(words(rolling)["staging.example.net"]).toBe("rolling back");
  // An instance whose commit the page does not know has no live row, and so no Roll back.
  expect(right(viewHtml(facts({ answers: {} }), "staging.example.net", NOW))).not.toContain("data-rollback");
});

test("auto-deploy that stopped for the instance says at which commit, and what starts it again", () => {
  const stopped = (why: string) =>
    right(viewHtml(facts({ auto: { "notes.example.org": { at: "failed", head: "3".repeat(40), why } } }), "notes.example.org", NOW));
  expect(stopped("1 test failed on 333.")).toContain(
    '<p class="note bad">Auto-deploy stopped at 3333333: 1 test failed on 333. A new commit on main starts it again, or Deploy on its row.</p>'
  );
  expect(stopped(REWRITTEN)).toContain("To accept the new head: bun erga deploy notes.example.org</p>");
  expect(
    right(viewHtml(facts({ auto: { "notes.example.org": { at: "failed", head: "3".repeat(40), why: "no" } } }), "example.net", NOW))
  ).not.toContain("Auto-deploy stopped");
});

test("Checked: one line with the chosen instance's own sources, its repository and itself", () => {
  let polls = stepPolls(startPolls(), {
    type: "sources",
    names: ["github", "repo example.com/team/erga", ...HOSTS],
    now: NOW - 60_000,
  }).polls;
  for (const name of ["github", "repo example.com/team/erga", ...HOSTS])
    polls = stepPolls(polls, { type: "answer", name, now: NOW - 42_000, error: null }).polls;
  const html = right(viewHtml(facts({ polls }), "example.net", NOW));
  expect(html).toContain(
    '<p class="checked" aria-label="Checks"><span>Checked:</span><span class="check ok" data-source="repo example.com/team/erga"><i class="light ok"></i>example.com/team/erga main, 42 s ago</span><span class="check ok" data-source="example.net"><i class="light ok"></i>example.net, 42 s ago</span></p>'
  );
  expect(html).not.toContain("Sources");
  expect(html).not.toContain('data-source="github"');
  // Its repository gave no answer: the line says why, and the commits say what the page can't show.
  const bad = stepPolls(polls, { type: "answer", name: "repo example.com/team/erga", now: NOW, error: "x" }).polls;
  const asked = stepPolls(bad, { type: "tick", now: NOW + 61_000 }).polls;
  const failed = stepPolls(asked, {
    type: "answer",
    name: "repo example.com/team/erga",
    now: NOW + 62_000,
    error: "fatal: Permission denied (publickey).",
  }).polls;
  const none = right(viewHtml(facts({ polls: failed, logs: {} }), "example.net", NOW + 62_000));
  expect(none).toContain(
    '<span class="check bad" data-source="repo example.com/team/erga"><i class="light bad"></i>example.com/team/erga main: <span class="s-err">fatal: Permission denied (publickey).</span></span>'
  );
  expect(none).toContain(
    '<div class="none">This machine can&#39;t read example.com/team/erga: fatal: Permission denied (publickey).</div>'
  );
});

test("the page's server: Deploy and Roll back start their `bun erga` command, one job at a time, only from the page; it has no merge", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  // A clone: main at the first commit, staging at the third.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-buttons-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet");
  for (const m of ["Change 1", "Change 2", "Change 3"])
    git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "--allow-empty", "-m", m);
  const [c1, c2, c3] = ["HEAD~2", "HEAD~1", "HEAD"].map((r) => git("rev-parse", r));
  mkdirSync(join(dir, ".erga"));
  writeFileSync(
    join(dir, ".erga/config.json"),
    JSON.stringify({ instances: [entry("example.net"), entry("staging.example.net", "staging")] })
  );
  // example.net runs main's head; staging.example.net runs the second commit of staging's three.
  const version = { "example.net": c1.slice(0, 12), "staging.example.net": c2.slice(0, 12) };
  const runs: string[][] = [];
  const onInstance: Record<string, JobRecord[]> = {};
  let end = (_: { code: number; out: string }) => {};
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    fetch: async () => null,
    heads: async () => ({ heads: { main: c1, staging: c3 }, error: null }),
    ask: async (e) => ({ version: version[e.host as keyof typeof version], healthy: true }),
    // Each instance's own record of its jobs: the page reads it from the instance, never from this machine's files.
    jobs: async (e) => onInstance[e.host] ?? [],
    run: (args) => {
      runs.push(args);
      return { pid: 999_999, done: new Promise((done) => (end = done)) };
    },
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const post = (path: string, body: object, origin = at) =>
    fetch(`${at}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const view = async (host = "staging.example.net") => (await fetch(`${at}/view?hash=${host}`)).text();
  try {
    for (let i = 0; i < 100 && !(await view()).includes("dep live"); i++) await Bun.sleep(20);
    // The page merges nothing: the address is not there.
    expect((await post("/api/merge", { branch: "a-feature", message: "A feature" })).status).toBe(404);
    expect(runs).toEqual([]);
    expect((await post("/api/deploy", { host: "staging.example.net", sha: c1 }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/deploy", { host: "staging.example.net", sha: c1 })).status).toBe(202);
    expect(runs).toEqual([["deploy", c1.slice(0, 12), "staging.example.net"]]);
    // While it runs: no second job. The server names the job; the page's buttons say only that one runs.
    const busy = await post("/api/deploy", { host: "staging.example.net", sha: c3 });
    expect(busy.status).toBe(409);
    const command = `bun erga deploy ${c1.slice(0, 12)} staging.example.net`;
    expect(((await busy.json()) as { error: string }).error).toBe(`Another job runs: ${command}. Wait for it to end.`);
    expect(await view()).toContain('title="Another job runs. Wait for it to end."');
    // Its instance's job line shows it before the instance's record does; another instance's page does not.
    expect(await view()).toContain('data-tab="deploys"');
    expect(await view()).toContain(
      `<div class="job running"><i class="light"></i><code>${command}</code><span>starts · from this page</span></div>`
    );
    expect(await view("example.net")).toContain("No job yet.");
    // It stops before its job starts on the instance: its instance's page shows its last words.
    end({ code: 1, out: "FAIL  staging.example.net.lock is locked\n" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect(await view()).toContain(`<p class="note bad failed">${command} stopped: FAIL  staging.example.net.lock is locked</p>`);
    expect(await view("example.net")).not.toContain("note bad failed");
    // Deploy: a commit of the instance's own branch, to an instance that does not run it.
    expect((await post("/api/deploy", { host: "example.net", sha: c3 })).status).toBe(409);
    expect((await post("/api/deploy", { host: "example.net", sha: c1 })).status).toBe(409);
    expect((await post("/api/deploy", { host: "nope.dev", sha: c1 })).status).toBe(409);
    expect((await post("/api/deploy", { host: "staging.example.net", sha: c3 })).status).toBe(202);
    expect(runs.at(-1)).toEqual(["deploy", c3.slice(0, 12), "staging.example.net"]);
    // Roll back: `bun erga rollback <host>`, with the same rules: only from the page, a registered instance, one job at a time.
    expect((await post("/api/rollback", { host: "example.net" })).status).toBe(409);
    // The deploy ends, with its job in the instance's own record: the page reads it there when the command ends, and
    // shows it as the instance's job line, its log and its history.
    const deployed = `bun erga deploy ${c3.slice(0, 12)} staging.example.net`;
    onInstance["staging.example.net"] = [
      {
        kind: "deploy",
        host: "staging.example.net",
        commit: c3,
        branch: null,
        phase: "ok",
        id: "7",
        command: deployed,
        from: "page",
        started: new Date().toISOString(),
        ended: new Date().toISOString(),
        out: ["Deploy to staging.example.net:", "Deployed: healthy."],
      },
    ];
    end({ code: 0, out: "" });
    for (let i = 0; i < 100 && (await view()).includes("Another job runs"); i++) await Bun.sleep(20);
    expect(await view()).toContain(`<a class="job ok" href="#staging.example.net/logs/7"`);
    expect(await view("staging.example.net/logs")).toContain(
      "<span>Deploy to staging.example.net:</span>\n<span>Deployed: healthy.</span>"
    );
    expect(await view("staging.example.net/history")).toContain(`<a class="h-row ok" href="#staging.example.net/logs/7" data-job="7">`);
    expect(await view("example.net/history")).toContain("No job yet.");
    expect((await post("/api/rollback", { host: "example.net" }, "https://evil.example")).status).toBe(403);
    expect((await post("/api/rollback", { host: "nope.dev" })).status).toBe(409);
    expect((await post("/api/rollback", { host: "example.net" })).status).toBe(202);
    expect(runs.at(-1)).toEqual(["rollback", "example.net"]);
    expect(await view("example.net")).toContain(
      '<div class="job running"><i class="light"></i><code>bun erga rollback example.net</code><span>starts · from this page</span></div>'
    );
  } finally {
    end({ code: 0, out: "" });
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the page's server asks for each upstream's head, and compares each instance's branch with it", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  // A clone: main at the first commit, staging at the third; Erga's main, another repository here, apart from both.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-upstream-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  // Each commit has a file of its own: git takes two commits with no change for the same patch.
  const commit = (m: string) => {
    writeFileSync(join(dir, `${m}.txt`), m);
    git("add", "-A");
    git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "-m", m);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  const [c1, c2, c3] = ["Change 1", "Change 2", "Change 3"].map(commit);
  git("checkout", "--quiet", "--detach", c1);
  const other = commit("A change of the other repository");
  mkdirSync(join(dir, ".erga"));
  const write = (fork: object) =>
    writeFileSync(
      join(dir, ".erga/config.json"),
      JSON.stringify({
        instances: [
          entry("example.net", "main", { upstream: { repo: "example.com/team/erga", branch: "staging" } }),
          entry("staging.example.net", "staging", { upstream: { repo: "example.com/team/erga", branch: "main" } }),
          entry("notes.example.org", "staging", fork),
        ],
      })
    );
  write({ upstream: { repo: "github.com/koomen/erga", branch: "main" } });
  const asked: string[] = [];
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    fetch: async () => null,
    heads: async (_cwd, repo, branches) => {
      asked.push(`${repo}: ${[...branches].sort().join(" ")}`);
      const heads: Record<string, string> = repo == "github.com/koomen/erga" ? { main: other } : { main: c1, staging: c3 };
      return { heads, error: null };
    },
    ask: async () => ({ version: c1.slice(0, 12), healthy: true }),
    jobs: async () => [],
  });
  const view = async (host: string) => (await fetch(`http://127.0.0.1:${page.server.port}/view?hash=${host}`)).text();
  const until = async (host: string, ok: (html: string) => boolean) => {
    for (let i = 0; i < 200 && !ok(await view(host)); i++) await Bun.sleep(20);
    return view(host);
  };
  /** Each row: its commit, green or orange, and its tags. */
  const marks = (html: string) =>
    html
      .split('<div class="row ')
      .slice(1)
      .map((r) =>
        `${/data-sha="(\w{7})/.exec(r)?.[1]} ${r.slice(0, r.indexOf('"'))} ${[...r.matchAll(/class="ref"[^>]*>([^<]*)</g)].map((m) => m[1]).join("+")}`.trim()
      );
  const [s1, s2, s3, so] = [c1, c2, c3, other].map((c) => c.slice(0, 7));
  try {
    // One check of each repository, for the tracked branches and the upstreams' together.
    const main = await until("example.net", (h) => h.includes('class="ref"'));
    expect(asked.sort()).toEqual(["example.com/team/erga: main staging", "github.com/koomen/erga: main"]);
    // main lacks staging's two commits: orange rows over its own head.
    expect(marks(main)).toEqual([`${s3} off staging`, `${s2} off`, `${s1} on main`]);
    // staging has main's head: no row from the upstream, and its tag on that commit.
    expect(marks(await until("staging.example.net", (h) => h.includes('class="ref"')))).toEqual([
      `${s3} off staging`,
      `${s2} off`,
      `${s1} on main`,
    ]);
    // Apart from another repository's branch: its commit on top, and the line broken under it.
    const apart = await until("notes.example.org", (h) => h.includes('class="ref"'));
    expect(marks(apart)).toEqual([`${so} off github.com/koomen/erga main`, `${s3} off staging`, `${s2} off`, `${s1} on`]);
    expect(apart).toContain(`data-sha="${other}"><span class="rail off"`);
    // The upstream goes (bun erga track --no-upstream): its rows and its tags go at once.
    write({});
    const none = await until("notes.example.org", (h) => !h.includes('class="ref"'));
    expect(none).not.toContain(other);
    expect(none).not.toContain("Upstream");
  } finally {
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

test("the page's server checks its sources at start, not on a page load, and the page shows the instance's own", async () => {
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
    heads: async () => (calls.push("heads"), { heads: {}, error: "fatal: could not read from the repository" }),
    ask: async () => (calls.push("ask"), { version: "1".repeat(12), healthy: true }),
    jobs: async () => [],
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const view = async () => (await fetch(`${at}/view?hash=example.net`)).text();
  const until = async (ok: (html: string) => boolean) => {
    for (let i = 0; i < 100 && !ok(await view()); i++) await Bun.sleep(20);
    return view();
  };
  try {
    const first = await until((h) => h.includes('class="check ok"') && h.includes("could not read"));
    // Its repository gave no answer, and the instance did. The fetch of the clone, for the tests' queue, is not on the page.
    expect(first).toContain('<span class="check bad" data-source="repo example.com/team/erga">');
    expect(first).toMatch(/<span class="check ok" data-source="example.net"><i class="light ok"><\/i>example.net, \d+ s ago<\/span>/);
    expect(first).not.toContain("unable to access GitHub");
    expect(first).toContain("This machine can&#39;t read example.com/team/erga: fatal: could not read from the repository");
    expect(calls.sort()).toEqual(["ask", "fetch", "heads"]);
    // A page load checks nothing again: a repository keeps its minute, an instance its 15 seconds (poll-state.ts).
    await fetch(`${at}/`);
    expect(calls.sort()).toEqual(["ask", "fetch", "heads"]);
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
    jobs: async () => [],
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
