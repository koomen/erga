// The ops page's view (`bun erga`, deploy/cli/ops-page.ts serves it): pure, the facts in and HTML out. On the left, the
// primaries of .erga/config.json, each with its staging instances. On the right, the chosen primary's tabs (Deploys
// now; Setup, Logs and History come with plan to-do 11), the job line under them, and the Deploys tab: the feature
// branches, then the clone's log with a column for each of the primary's instances and "live" at the commit it runs.

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import type { Config, Entry } from "./config";

/** What an instance answered last: the commit it runs and its health, or why it gave none. */
export interface Answer {
  version: string | null;
  healthy: boolean | null;
  error?: string;
}

/** A job's record in .erga/jobs/ (deploy/cli/deploy.ts, startJob), as the page reads it. */
export interface JobRecord {
  command: string;
  host: string;
  from: string;
  started: string;
  commit?: string;
  result?: "ok" | "failed";
  error?: string;
  ended?: string;
  /** No result yet, and its process lives. */
  running: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  at: number;
}

export interface Branch extends Commit {
  name: string;
  ahead: number;
  behind: number;
  conflicts: string[];
}

/** What the clone shows, as it is: no fetch. */
export interface Git {
  /** origin/staging's and origin/main's commits, newest first. */
  log: Commit[];
  branches: Branch[];
  /** The branch the feature branches are counted against. */
  base: string;
  main: string | null;
  /** The instances' commits that are not in `log`, and whether the clone has each one. */
  elsewhere: Record<string, boolean>;
}

export interface Facts {
  config: Config | { error: string };
  answers: Record<string, Answer>;
  git: Git | { error: string };
  jobs: JobRecord[];
}

/** A job record from its file's lines, or null if it has no start line. */
export function jobOf(text: string, alive: (pid: number) => boolean): JobRecord | null {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  const head = lines[0];
  if (typeof head?.command != "string" || typeof head.host != "string") return null;
  const job: JobRecord = {
    command: head.command,
    host: head.host,
    from: typeof head.from == "string" ? head.from : "terminal",
    started: String(head.started ?? ""),
    running: false,
  };
  for (const l of lines.slice(1)) {
    if (typeof l.commit == "string") job.commit = l.commit;
    if (l.result == "ok" || l.result == "failed") {
      job.result = l.result as "ok" | "failed";
      job.ended = String(l.ended ?? "");
      if (typeof l.error == "string") job.error = l.error;
    }
  }
  job.running = !job.result && typeof head.pid == "number" && alive(head.pid);
  return job;
}

export interface Group {
  primary: Entry;
  staging: Entry[];
}

/** Each primary with its staging instances, in the file's order. A staging instance whose primary has no entry stands alone. */
export function groupsOf(config: Config): Group[] {
  const hosts = new Set(config.instances.map((e) => e.host));
  const primaries = config.instances.filter((e) => !e.stagingOf || !hosts.has(e.stagingOf));
  return primaries.map((p) => ({ primary: p, staging: config.instances.filter((e) => e.stagingOf == p.host && p != e) }));
}

/** The group a hash names (a primary or one of its staging instances), else the first. */
export const chosenOf = (groups: Group[], name: string) =>
  groups.find((g) => g.primary.host == name || g.staging.some((s) => s.host == name)) ?? groups[0] ?? null;

/** Whether the instance runs `sha` (it answers the commit's first 12 characters). */
const runs = (a: Answer | undefined, sha: string) => !!a?.version && sha.startsWith(a.version);

/** The log's rows: at least 15, and down to the oldest commit that an instance of the group runs. */
export function rowsOf(log: Commit[], versions: (string | null)[]): Commit[] {
  let last = 14;
  for (const v of versions) {
    const i = v ? log.findIndex((c) => c.sha.startsWith(v)) : -1;
    if (i > last) last = i;
  }
  return log.slice(0, last + 1);
}

/** "now", "5m", "2h", "3d". */
const short = (t: number, now: number) => {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const sha7 = (sha: string) => sha.slice(0, 7);

/** An instance's light and its words: healthy, not healthy, or no answer (with why). */
function stateOf(a: Answer | undefined): { cls: string; what: string } {
  if (!a) return { cls: "", what: "asking…" };
  if (a.error) return { cls: "bad", what: a.error };
  if (a.healthy === false) return { cls: "bad", what: `runs ${a.version ?? "?"}, not healthy` };
  return { cls: "ok", what: `runs ${a.version ?? "no known commit"}` };
}

function side(groups: Group[], chosen: Group | null, answers: Record<string, Answer>): string {
  if (!groups.length) return `<p class="none">No instances.</p>`;
  const item = (e: Entry, cls: string) => {
    const st = stateOf(answers[e.host]);
    return `<span class="${cls}" title="${esc(`${e.host}: ${st.what}`)}"><i class="light ${st.cls}"></i><span>${esc(e.host)}</span></span>`;
  };
  return `<ul class="primaries">${groups
    .map(
      (g) =>
        `<li><a class="group${g == chosen ? " sel" : ""}" href="#${esc(g.primary.host)}"${g == chosen ? ' aria-current="true"' : ""}>${item(g.primary, "primary")}${g.staging.map((s) => item(s, "staging")).join("")}</a></li>`
    )
    .join("")}</ul>`;
}

/** The job line: the job that runs on one of the group's instances, else the group's last job. */
function jobLine(g: Group, jobs: JobRecord[], now: number): string {
  const hosts = [g.primary.host, ...g.staging.map((s) => s.host)];
  const mine = jobs.filter((j) => hosts.includes(j.host)).sort((a, b) => b.started.localeCompare(a.started));
  const job = mine.find((j) => j.running) ?? mine[0];
  if (!job) return `<div class="job none">No job yet. A deploy or a rollback of ${esc(g.primary.host)} shows here as it runs.</div>`;
  const from = `from ${job.from == "page" ? "this page" : `a ${job.from}`}`;
  const end = Date.parse(job.ended ?? "") || Date.parse(job.started) || now;
  const what = job.running
    ? from
    : job.result == "ok"
      ? `done ${timeAgo(end, now)} · ${from}`
      : job.result == "failed"
        ? `failed ${timeAgo(end, now)}${job.error ? `: ${job.error}` : ""} · ${from}`
        : `stopped · ${from}`;
  const cls = job.running ? "running" : (job.result ?? "stopped");
  return `<div class="job ${cls}" title="${esc(what)}"><i class="light"></i><code>${esc(job.command)}</code><span>${esc(what)}</span></div>`;
}

function branches(git: Git, now: number): string {
  const list = git.branches.length
    ? git.branches
        .map((b) => {
          const state = !b.ahead
            ? `<span class="f-state">On ${esc(git.base)} already</span>`
            : b.conflicts.length
              ? `<span class="f-state bad" title="${esc(b.conflicts.join(", "))}">Conflicts in ${plural(b.conflicts.length, "file")}: ${esc(b.conflicts.join(", "))}</span>`
              : `<span class="f-state ok">Merges cleanly</span>`;
          return `<li class="feature"><div class="f-top"><code class="f-name">${esc(b.name)}</code><span class="f-count">${plural(b.ahead, "commit")} ahead · ${b.behind} behind ${esc(git.base)}</span>${state}</div><div class="f-last"><span class="f-subject">${esc(b.subject)}</span> · ${esc(b.author)} · ${esc(timeAgo(b.at, now))} · <code>${esc(sha7(b.sha))}</code></div></li>`;
        })
        .join("")
    : `<li class="feature none">No feature branches in this clone.</li>`;
  return `<section class="box" aria-labelledby="features-head"><h3 id="features-head">Feature branches</h3><ul class="features">${list}</ul></section>`;
}

/** The time of the last good deploy of `sha` to `host`, from the job records. */
const deployedAt = (jobs: JobRecord[], host: string, sha: string) =>
  jobs
    .filter((j) => j.host == host && j.result == "ok" && j.commit && j.commit.startsWith(sha.slice(0, 12)))
    .map((j) => Date.parse(j.ended ?? ""))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

function log(g: Group, f: Facts & { git: Git }, now: number): string {
  const git = f.git;
  const cols = [...g.staging, g.primary];
  const answer = (e: Entry) => f.answers[e.host];
  const rows = rowsOf(
    git.log,
    cols.map((e) => answer(e)?.version ?? null)
  );
  // Green: the commits that the primary runs (that commit and the ones before it); else main's.
  const top = answer(g.primary)?.version ?? git.main?.slice(0, 12) ?? null;
  const on = top ? rows.findIndex((c) => c.sha.startsWith(top)) : -1;
  const isOn = (i: number) => on >= 0 && i >= on;
  const notes = cols
    .map((e) => {
      const v = answer(e)?.version;
      if (!v || rows.some((c) => c.sha.startsWith(v))) return "";
      return git.elsewhere[v]
        ? `${e.host} runs ${v}, which is not on origin/staging or origin/main.`
        : `${e.host} runs ${v}, which this clone does not have. git fetch gets it.`;
    })
    .filter(Boolean);
  const head = cols
    .map((e) => {
      const st = stateOf(answer(e));
      return `<div class="head col" title="${esc(`${e.host}: ${st.what}`)}"><b>${e.stagingOf ? "staging" : "production"}</b><span class="host">${esc(e.host)}</span><span class="st"><i class="light ${st.cls}"></i>${esc(answer(e)?.error ? "no answer" : st.cls == "bad" ? "not healthy" : answer(e) ? "live" : "asking…")}</span></div>`;
    })
    .join("");
  const body = rows
    .map((c, i) => {
      const kind = isOn(i) ? "on" : "off";
      const marks = cols
        .map((e) => {
          if (!runs(answer(e), c.sha)) return `<span class="deps"></span>`;
          const at = deployedAt(f.jobs, e.host, c.sha);
          return `<span class="deps"><span class="dep live" data-host="${esc(e.host)}" title="${esc(`${e.host} runs this commit`)}"><span class="w">live</span><span class="at">${at ? short(at, now) : ""}</span></span></span>`;
        })
        .join("");
      return `<div class="row ${kind}" data-sha="${esc(c.sha)}"><span class="rail${i ? " up" : ""}${i < rows.length - 1 ? " down" : ""} ${kind}"><i class="dot ${kind}"></i></span><span class="subj" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="who">${esc(c.author)}</span><code class="sha">${esc(sha7(c.sha))}</code><time>${esc(timeAgo(c.at, now))}</time>${marks}</div>`;
    })
    .join("");
  return `<section class="commits" aria-label="Commits">
    <div class="legend"><span><i class="dot off"></i>not on ${esc(g.primary.host)} yet</span><span><i class="dot on"></i>on ${esc(g.primary.host)}</span></div>
    ${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    <div class="grid" style="--cols: ${cols.length}"><div class="head"></div><div class="head">Commit</div><div class="head who"></div><div class="head sha"></div><div class="head time"></div>${head}${body || `<div class="none">No commits on origin/staging or origin/main in this clone.</div>`}</div>
  </section>`;
}

/** The tabs of a primary. Plan to-do 11 adds Setup, Logs and History. */
const TABS = ["Deploys"];

/** The live part of the page: the sidebar and the chosen primary. `name` is the page's hash. */
export function viewHtml(f: Facts, name: string, now = Date.now()): string {
  if ("error" in f.config)
    return `<aside class="side"></aside><section class="main"><p class="note bad">${esc(f.config.error)}</p></section>`;
  const groups = groupsOf(f.config);
  const g = chosenOf(groups, name);
  const sidebar = `<aside class="side" aria-label="Instances"><h2 class="side-head">Instances</h2>${side(groups, g, f.answers)}</aside>`;
  if (!g)
    return `${sidebar}<section class="main"><p class="note">No instance is registered in this clone's .erga/config.json. Add one: <code>bun erga register &lt;host&gt;</code></p></section>`;
  const tabs = `<nav class="tabs" role="tablist">${TABS.map((t, i) => `<span class="tab" role="tab" aria-selected="${i == 0}">${t}</span>`).join("")}</nav>`;
  const deploys =
    "error" in f.git ? `<p class="note bad">${esc(f.git.error)}</p>` : branches(f.git, now) + log(g, { ...f, git: f.git }, now);
  return `${sidebar}<section class="main" data-primary="${esc(g.primary.host)}"><h2 class="title">${esc(g.primary.host)}</h2>${tabs}${jobLine(g, f.jobs, now)}<div class="tab-body">${deploys}</div></section>`;
}

/** The whole page: Erga's bar, the live part, and the page's script. */
export function pageHtml(live: string, script: string): string {
  return `<!doctype html><html lang="en" class="page-light page-white"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ops · Erga</title>${FAVICON_LINK}
<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/bars.css"><link rel="stylesheet" href="/ops-page.css">
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");function t(){var d=m.matches,c=document.documentElement.classList;c.toggle("page-dark",d);c.toggle("page-light",!d);c.toggle("page-white",!d)}t();m.addEventListener("change",t)})()</script>
</head><body>
<nav class="erga-crumbs erga-bar erga-bar-l" aria-label="Breadcrumbs"><a class="erga-brand" href="/"><span>${WORDMARK}</span></a><h1 class="erga-here" aria-current="page"><span>Ops</span></h1></nav>
<p class="gone" id="gone" hidden>bun erga stopped. Run it again, and this page follows.</p>
<div class="ops" id="ops">${live}</div>
<script>${script}</script>
</body></html>`;
}
