// The ops page's view (`bun erga`, deploy/cli/ops-page.ts serves it): pure, the facts in and HTML out. On the left, the
// primaries of .erga/config.json, each with its staging instances. On the right, the chosen primary's tabs, the job line
// under them, and the chosen tab. Deploys: the feature branches, then the clone's log with a column for each of the
// primary's instances and "live" at the commit it runs. Logs: a job's output. History: the jobs of the primary and its
// staging instances. Setup: the checklist of `bun erga setup`.

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import type { Config, Entry } from "./config";
import { type Alive, activeJobs, deploysTo, type JobState, jobState, type Line, type Run } from "./job-state";

/** What an instance answered last: the commit it runs and its health, or why it gave none. */
export interface Answer {
  version: string | null;
  healthy: boolean | null;
  error?: string;
}

/** A job's record in .erga/jobs/ (deploy/cli/deploy.ts, startJob), as the page reads it: its state, and what it says. */
export interface JobRecord extends JobState {
  /** Its file's name, without .jsonl. */
  id: string;
  command: string;
  from: string;
  started: string;
  error?: string;
  ended?: string;
  /** Its output, as it came (the last OUT_LINES lines). */
  out: string[];
}

const OUT_LINES = 2000;

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
  /** GitHub answered with its branches (git ls-remote); false: `branches` is as the clone last saw them. */
  github: boolean;
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
  /** The host of the setup in progress (.erga/setup.json, `bun erga setup <host>`), or "". */
  setup: string;
  /** The command that this page started (job-state.ts, stepRun). */
  run: Run;
}

/** A job record from its file's lines, or null if it has no start line. */
export function jobOf(text: string, alive: Alive, id = ""): JobRecord | null {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Line;
      } catch {
        return {};
      }
    });
  const state = jobState(lines, alive);
  if (!state) return null;
  const head = lines[0];
  const end = lines.find((l) => l.result == "ok" || l.result == "failed");
  return {
    ...state,
    id,
    command: String(head.command),
    from: typeof head.from == "string" ? head.from : "terminal",
    started: String(head.started ?? ""),
    ...(end ? { ended: String(end.ended ?? "") } : {}),
    ...(typeof end?.error == "string" ? { error: end.error } : {}),
    out: lines.flatMap((l) => (typeof l.out == "string" ? [l.out] : [])).slice(-OUT_LINES),
  };
}

export interface Group {
  primary: Entry;
  staging: Entry[];
}

/**
 * Each primary with its staging instances, in the file's order. A staging instance whose primary has no entry stands
 * alone. The setup's host, before setup writes its entry, comes last, with no facts and no token.
 */
export function groupsOf(config: Config, setup = ""): Group[] {
  const hosts = new Set(config.instances.map((e) => e.host));
  const primaries = config.instances.filter((e) => !e.stagingOf || !hosts.has(e.stagingOf));
  const groups = primaries.map((p) => ({ primary: p, staging: config.instances.filter((e) => e.stagingOf == p.host && p != e) }));
  if (setup && !hosts.has(setup))
    groups.push({
      primary: {
        host: setup,
        account: "",
        worker: "",
        database: "",
        app: { kind: "workers.dev" },
        pages: { kind: "shared" },
        vars: {},
        token: "",
      },
      staging: [],
    });
  return groups;
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
    const st = e.token ? stateOf(answers[e.host]) : { cls: "", what: "not registered yet: bun erga setup" };
    return `<span class="${cls}" title="${esc(`${e.host}: ${st.what}`)}"><i class="light ${st.cls}"></i><span>${esc(e.host)}</span></span>`;
  };
  return `<ul class="primaries">${groups
    .map(
      (g) =>
        `<li><a class="group${g == chosen ? " sel" : ""}" href="#${esc(g.primary.host)}"${g == chosen ? ' aria-current="true"' : ""}>${item(g.primary, "primary")}${g.staging.map((s) => item(s, "staging")).join("")}</a></li>`
    )
    .join("")}</ul>`;
}

/** The jobs of the group's instances, newest first. */
const jobsOf = (g: Group, jobs: JobRecord[]) => {
  const hosts = [g.primary.host, ...g.staging.map((s) => s.host)];
  return jobs.filter((j) => hosts.includes(j.host)).sort((a, b) => b.started.localeCompare(a.started));
};

/** A job's light (its class) and its state in words: "done 5 minutes ago · from a terminal". */
function jobLook(job: JobRecord, now: number): { cls: string; what: string } {
  const from = `from ${job.from == "page" ? "this page" : `a ${job.from}`}`;
  const end = Date.parse(job.ended ?? "") || Date.parse(job.started) || now;
  const what =
    job.phase == "running"
      ? from
      : job.phase == "ok"
        ? `done ${timeAgo(end, now)} · ${from}`
        : job.phase == "failed"
          ? `failed ${timeAgo(end, now)}${job.error ? `: ${job.error}` : ""} · ${from}`
          : `stopped · ${from}`;
  return { cls: job.phase, what };
}

/** The job line: the job that runs on one of the group's instances, else the group's last job. */
function jobLine(g: Group, mine: JobRecord[], run: Run, now: number): string {
  const job = mine.find((j) => j.phase == "running") ?? mine[0];
  // A command that this page started, before its job record shows.
  if (run.at == "starting" && job?.phase != "running")
    return `<div class="job running"><i class="light"></i><code>${esc(run.command)}</code><span>starts · from this page</span></div>`;
  if (!job) return `<div class="job none">No job yet. A deploy or a rollback of ${esc(g.primary.host)} shows here as it runs.</div>`;
  const st = jobLook(job, now);
  return `<a class="job ${st.cls}" href="#${esc(g.primary.host)}/logs/${esc(job.id)}" title="${esc(st.what)}"><i class="light"></i><code>${esc(job.command)}</code><span>${esc(st.what)}</span></a>`;
}

/** "45 s", "3 min 5 s", "1 h 2 min". */
const took = (job: JobRecord, now: number) => {
  const end = job.phase == "running" ? now : Date.parse(job.ended ?? "");
  const s = Math.round((end - Date.parse(job.started)) / 1000);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s} s`;
  return s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
};

/** Logs: the output of the job that the hash names, else of the job that runs, else of the last one. */
function logs(g: Group, mine: JobRecord[], id: string, now: number): string {
  const job = mine.find((j) => j.id == id) ?? mine.find((j) => j.phase == "running") ?? mine[0];
  if (!job) return `<p class="note">No job yet. The output of a deploy or a rollback of ${esc(g.primary.host)} shows here as it runs.</p>`;
  const st = jobLook(job, now);
  const lines = job.out.map((l) => `<span>${esc(l)}</span>`).join("\n");
  const end = job.error ? `\n<span class="bad">${esc(job.error)}</span>` : "";
  return `<section class="logs" data-job="${esc(job.id)}" aria-label="The job's output"><div class="log-head"><code>${esc(job.command)}</code><span class="when">${esc(new Date(Date.parse(job.started) || now).toLocaleString())}</span><span class="state ${st.cls}">${esc(job.phase == "running" ? "runs" : st.cls == "ok" ? "done" : st.cls)}${took(job, now) ? ` · ${took(job, now)}` : ""}</span></div><pre class="log">${lines || (job.phase == "running" ? "<span>No output yet.</span>" : "<span>No output.</span>")}${end}</pre></section>`;
}

/** History: the jobs of the primary and its staging instances, newest first. */
function history(g: Group, mine: JobRecord[], now: number): string {
  if (!mine.length)
    return `<p class="note">No job yet. Each deploy and rollback of ${esc(g.primary.host)} and its staging instances shows here.</p>`;
  const rows = mine
    .map((j) => {
      const st = jobLook(j, now);
      const result = j.phase == "running" ? "runs" : j.phase == "ok" ? "done" : j.phase;
      return `<a class="h-row ${st.cls}" href="#${esc(g.primary.host)}/logs/${esc(j.id)}" data-job="${esc(j.id)}"><span class="h-state"><i class="light"></i>${result}</span><code class="h-cmd" title="${esc(j.error ?? j.command)}">${esc(j.command)}</code><span class="h-host">${esc(j.host)}</span><span class="h-from">${esc(j.from == "page" ? "this page" : j.from)}</span><time datetime="${esc(j.started)}" title="${esc(j.started)}">${esc(timeAgo(Date.parse(j.started) || now, now))}</time><span class="h-took">${esc(took(j, now))}</span></a>`;
    })
    .join("");
  return `<section class="history" aria-label="Jobs"><div class="h-row h-head"><span>Result</span><span>Command</span><span>Instance</span><span>From</span><span>Started</span><span>Took</span></div>${rows}</section>`;
}

/** The command of the job that runs (or that this page starts), or "": while one runs, the page starts no other. */
export const busyWith = (f: Pick<Facts, "jobs" | "run">) => activeJobs(f.jobs, f.run)[0]?.command ?? "";

/** Why the branch can't merge now, or null. */
export function mergeBlock(b: Branch, base: string, busy: string): string | null {
  if (!b.ahead) return `Nothing to merge: ${base} has its commits.`;
  if (b.conflicts.length) return `It conflicts with ${base}. Rebase it on origin/${base}, and push it.`;
  if (busy) return `Another job runs: ${busy}. Wait for it to end.`;
  return null;
}

/** A button with the page's look; a disabled one says why in its tip. */
const button = (label: string, attrs: string, block: string | null = null) =>
  `<span class="tip"${block ? ` title="${esc(block)}"` : ""}><button class="btn" type="button" ${attrs}${block ? " disabled" : ""}>${label}</button></span>`;

/** A button's label while its own job runs: a small spinner, and the word. */
const running = (word: string) => `<i class="spin" aria-hidden="true"></i>${word}…`;
const MERGING = "It merges now. The job line and Logs show its output.";
const DEPLOYING = "It deploys now. The job line and Logs show its output.";

function branches(git: Git, active: JobState[], busy: string, now: number): string {
  const list = git.branches.length
    ? git.branches
        .map((b) => {
          const state = !b.ahead
            ? `<span class="f-state">On ${esc(git.base)} already</span>`
            : b.conflicts.length
              ? `<span class="f-state bad" title="${esc(b.conflicts.join(", "))}">Conflicts in ${plural(b.conflicts.length, "file")}: ${esc(b.conflicts.join(", "))}</span>`
              : `<span class="f-state ok">Merges cleanly</span>`;
          const merge = active.some((j) => j.kind == "merge" && j.branch == b.name)
              ? button(running("Merging"), `data-merge="${esc(b.name)}" aria-busy="true"`, MERGING)
              : button("Merge", `data-merge="${esc(b.name)}"`, mergeBlock(b, git.base, busy));
          const form = `<form class="f-merge" data-branch="${esc(b.name)}" hidden><input name="message" value="${esc(b.subject)}" aria-label="The message of the commit on ${esc(git.base)}" autocomplete="off"><button class="btn">Merge</button><button class="btn quiet" type="button" data-cancel>Cancel</button><span class="err" role="alert"></span></form>`;
          return `<li class="feature" data-branch="${esc(b.name)}"><div class="f-top"><code class="f-name">${esc(b.name)}</code><span class="f-count">${plural(b.ahead, "commit")} ahead · ${b.behind} behind ${esc(git.base)}</span>${state}${merge}</div><div class="f-last"><span class="f-subject">${esc(b.subject)}</span> · ${esc(b.author)} · ${esc(timeAgo(b.at, now))} · <code>${esc(sha7(b.sha))}</code></div>${form}</li>`;
        })
        .join("")
    : `<li class="feature none">No feature branches in this clone.</li>`;
  const note = git.github
    ? ""
    : `<p class="note">GitHub did not answer <code>git ls-remote</code>: this list is as the clone last saw it, and can show branches that GitHub deleted.</p>`;
  return `<section class="box" aria-labelledby="features-head"><h3 id="features-head">Feature branches</h3>${note}<ul class="features">${list}</ul></section>`;
}

/** The time of the last good deploy of `sha` to `host`, from the job records. */
const deployedAt = (jobs: JobRecord[], host: string, sha: string) =>
  jobs
    .filter((j) => j.host == host && j.phase == "ok" && j.commit && j.commit.startsWith(sha.slice(0, 12)))
    .map((j) => Date.parse(j.ended ?? ""))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

/** The Deploy button of a row, in an instance's column: `bun erga deploy <commit> <host>`, after its question. */
function deployButton(e: Entry, primary: string, c: Commit, busy: string, deploying: boolean): string {
  const note = e.stagingOf
    ? `It keeps its copy of ${primary}'s data.`
    : "After a healthy deploy, main moves to it if main does not have it.";
  const data = `data-deploy data-host="${esc(e.host)}" data-sha="${esc(c.sha)}" data-ask="${esc(`Deploy ${sha7(c.sha)} ${c.subject} to ${e.host}?`)}" data-note="${esc(note)}" aria-label="${esc(`Deploy ${sha7(c.sha)} to ${e.host}`)}"`;
  if (deploying) return `<span class="deps here busy">${button(running("Deploying"), `${data} aria-busy="true"`, DEPLOYING)}</span>`;
  return `<span class="deps here">${button("Deploy", data, busy ? `Another job runs: ${busy}. Wait for it to end.` : null)}</span>`;
}

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
  const active = activeJobs(f.jobs, f.run);
  const busy = active[0]?.command ?? "";
  const body = rows
    .map((c, i) => {
      const kind = isOn(i) ? "on" : "off";
      const marks = cols
        .map((e) => {
          // Its own deploy stays "Deploying…" until the job ends, even when the instance answers the new commit before.
          const deploying = active.some((j) => deploysTo(j, c.sha, e.host, !!e.stagingOf));
          if (!runs(answer(e), c.sha) || deploying) return deployButton(e, g.primary.host, c, busy, deploying);
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
    <div class="confirm" id="deploy-confirm" popover><p data-s="ask"></p><p class="soft" data-s="note"></p><div class="acts"><button class="btn" type="button" data-go>Deploy</button><button class="btn quiet" type="button" popovertarget="deploy-confirm" popovertargetaction="hide">Cancel</button></div><p class="err" role="alert"></p></div>
  </section>`;
}

/**
 * Setup: the checklist of the setup in progress, when it is this primary's (deploy/own/page.ts fills the box, and the
 * page's script keeps it when the page draws again, so a form keeps what the person types). Else, how to start one.
 */
function setupTab(g: Group, setup: string): string {
  if (g.primary.host == setup) return `<div class="setup" data-host="${esc(setup)}"></div>`;
  const other = setup ? ` The setup of <a href="#${esc(setup)}/setup">${esc(setup)}</a> is in progress.` : "";
  return `<p class="note">${esc(g.primary.host)} is ${g.primary.token ? "registered" : "not registered yet"}. A new instance starts with <code>bun erga setup &lt;host&gt;</code>: its checklist then shows here.${other}</p>`;
}

/** The tabs of a primary, by their name in the hash (#<primary>/<tab>). */
const TABS: Record<string, string> = { setup: "Setup", deploys: "Deploys", logs: "Logs", history: "History" };

/** The newest job of all, for the page's script: when another one starts, the page switches to its primary. */
function newest(groups: Group[], jobs: JobRecord[]): string {
  const job = jobs.reduce<JobRecord | null>((a, j) => (!a || j.started > a.started ? j : a), null);
  const g = job && chosenOf(groups, job.host);
  return job && g ? ` data-newest="${esc(job.id)}" data-newest-primary="${esc(g.primary.host)}"` : "";
}

/** The live part of the page: the sidebar and the chosen primary. `name` is the page's hash: <host>[/<tab>[/<job>]]. */
export function viewHtml(f: Facts, name: string, now = Date.now()): string {
  if ("error" in f.config)
    return `<aside class="side"></aside><section class="main"><p class="note bad">${esc(f.config.error)}</p></section>`;
  const [host = "", wanted = "", id = ""] = name.split("/");
  const groups = groupsOf(f.config, f.setup);
  const g = chosenOf(groups, host);
  const sidebar = `<aside class="side" aria-label="Instances"><h2 class="side-head">Instances</h2>${side(groups, g, f.answers)}</aside>`;
  if (!g)
    return `${sidebar}<section class="main"><p class="note">No instance is registered in this clone's .erga/config.json. Add one: <code>bun erga register &lt;host&gt;</code></p></section>`;
  // A primary that setup has not registered yet opens on its Setup tab.
  const tab = TABS[wanted] ? wanted : g.primary.host == f.setup && !g.primary.token ? "setup" : "deploys";
  const tabs = `<nav class="tabs" role="tablist">${Object.entries(TABS)
    .map(([k, t]) => `<a class="tab" role="tab" href="#${esc(g.primary.host)}/${k}" aria-selected="${k == tab}">${t}</a>`)
    .join("")}</nav>`;
  const mine = jobsOf(g, f.jobs);
  const body =
    tab == "logs"
      ? logs(g, mine, id, now)
      : tab == "history"
        ? history(g, mine, now)
        : tab == "setup"
          ? setupTab(g, f.setup)
          : "error" in f.git
            ? `<p class="note bad">${esc(f.git.error)}</p>`
            : branches(f.git, activeJobs(f.jobs, f.run), busyWith(f), now) + log(g, { ...f, git: f.git }, now);
  return `${sidebar}<section class="main" data-primary="${esc(g.primary.host)}" data-tab="${tab}"${newest(groups, f.jobs)}><h2 class="title">${esc(g.primary.host)}</h2>${tabs}${jobLine(g, mine, f.run, now)}${f.run.at == "failed" ? `<p class="note bad failed">${esc(f.run.why)}</p>` : ""}<div class="tab-body">${body}</div></section>`;
}

/** The whole page: Erga's bar, the live part, and the page's script. */
export function pageHtml(live: string, script: string, code: string): string {
  return `<!doctype html><html lang="en" class="page-light page-white"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="ops-code" content="${esc(code)}">
<title>Ops · Erga</title>${FAVICON_LINK}
<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/bars.css"><link rel="stylesheet" href="/ops-page.css">
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");function t(){var d=m.matches,c=document.documentElement.classList;c.toggle("page-dark",d);c.toggle("page-light",!d);c.toggle("page-white",!d)}t();m.addEventListener("change",t)})()</script>
</head><body>
<nav class="erga-crumbs erga-bar erga-bar-l" aria-label="Breadcrumbs"><a class="erga-brand" href="/"><span>${WORDMARK}</span></a><h1 class="erga-here" aria-current="page"><span>Ops</span></h1></nav>
<p class="gone" id="gone" hidden>bun erga stopped. Run it again, and this page follows.</p>
<div class="ops" id="ops">${live}</div>
<script src="/setup.js"></script><script>${script}</script>
</body></html>`;
}
