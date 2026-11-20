// The ops page's view (`bun erga`, deploy/cli/ops-page.ts serves it): pure, the facts in and HTML out. On the left, the
// instances of .erga/config.json, each with the branch it tracks and one word when it is not at its branch's head, and
// whether auto-deploy is on. The right side is about the chosen instance only, and names no other one: the view that
// the instance's own page in the app draws too (shared/ops-view.ts: its tabs, its job line, its commits with Deploy
// and Roll back, its logs and its history), here with one line of its own sources' checks, an upstream's commits, and
// the Deploy and Roll back buttons as `bun erga deploy` and `bun erga rollback`. The page shows no feature branch and merges
// nothing: `bun erga status` lists the branches, and `bun erga merge` merges. Under the instances, the list has the
// verify suite's entry (#verify): the runs on real platforms, with their prerequisites (verify-view.ts).

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { type InstanceView, instanceHtml, sha7 } from "../../shared/ops-view";
import { plural, timeAgo } from "../../shared/time";
import { type Auto, REWRITTEN } from "./auto-state";
import { type Config, type Entry, repoName, upstreamName } from "./config";
import type { Answer, Commit as StatusCommit } from "./flow";
import type { TestRun } from "./gate";
import { type Alive, activeJobs, type JobState, jobState, type Line, type Run } from "./job-state";
import { isStale, type Polls } from "./poll-state";
import { type VerifyFacts, verifyHtml, verifySide } from "./verify-view";

/**
 * A job, as the page shows it: its state, and what it says. A deploy or a rollback comes from its instance's own
 * record (running.ts, recordOf); a merge or a promote from this machine's .erga/jobs/ (jobs.ts, startJob).
 */
export interface JobRecord extends JobState {
  /** Its id on its instance; a record's file name, without .jsonl. */
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

/** A commit (flow.ts), with the fields that the page shows and `bun erga status` does not: git gives them all. */
export type Commit = StatusCommit & { author: string; at: number };

export interface Facts {
  config: Config | { error: string };
  answers: Record<string, Answer>;
  /** Each instance's commits, by its host, newest first: the log of the branch that it tracks, from its head. None: the clone does not have them yet. */
  logs: Record<string, Commit[]>;
  jobs: JobRecord[];
  /** The command that this page started (job-state.ts, stepRun). */
  run: Run;
  /** The checks of GitHub, of each repository and of each instance (poll-state.ts). */
  polls: Polls;
  /** The records of the tests' runs (test-run.ts, readRuns), each under the tree it tested. */
  runs: TestRun[];
  /** Auto-deploy: each instance's state, by its host; null: the mode is off. */
  auto: Record<string, Auto> | null;
  /** The head of the branch that each instance tracks, by its host, as its repository last answered. */
  heads: Record<string, string | null>;
  /**
   * Each instance's upstream, by its host, as the clone last compared the two branches (observe.ts, compare): the
   * upstream's head, its commits that the instance's branch lacks, newest first, and how many commits the branch has
   * that the upstream lacks. None: the instance names no upstream, or the clone does not have both branches yet.
   */
  upstreams: Record<string, { head: string; behind: Commit[]; ahead: number }>;
  /** The verify suite (`bun erga verify`): its prerequisites, its runs, and the page's own command for it (verify-view.ts). */
  verify: VerifyFacts;
}

/** The name of a repository's source in the checks (poll-state.ts). */
export const repoSource = (repo: string) => `repo ${repoName(repo)}`;

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

/** The instance a hash names, else the first. */
export const chosenOf = (config: Config, name: string): Entry | null =>
  config.instances.find((e) => e.host == name) ?? config.instances[0] ?? null;

/** The log's rows: at least 15, and down to the commit that the instance runs. */
export function rowsOf(log: Commit[], version: string | null): Commit[] {
  const i = version ? log.findIndex((c) => c.sha.startsWith(version)) : -1;
  return log.slice(0, Math.max(14, i) + 1);
}

/** An instance's light and its words: healthy, not healthy, or no answer (with why). */
function stateOf(a: Answer | undefined): { cls: string; what: string } {
  if (!a) return { cls: "", what: "asking…" };
  if (a.error) return { cls: "bad", what: a.error };
  if (a.healthy === false) return { cls: "bad", what: `runs ${a.version ?? "?"}, not healthy${a.health ? `: ${a.health}` : ""}` };
  return { cls: "ok", what: `runs ${a.version ?? "no known commit"}` };
}

/** An instance's word in the list, when it is not at its branch's head: what happens to it now, or how far it is behind. */
function wordOf(e: Entry, f: Facts): { cls: string; text: string; tip: string } | null {
  const job = activeJobs(f.jobs, f.run).find((j) => j.host == e.host && (j.kind == "deploy" || j.kind == "rollback"));
  if (job) return { cls: "deploying", text: job.kind == "deploy" ? "deploying" : "rolling back", tip: job.command };
  const repo = f.polls.sources[repoSource(e.repo)];
  if (repo?.error) return { cls: "unread", text: "can't read", tip: `${e.repo}: ${repo.error}` };
  const a = f.auto?.[e.host];
  if (a?.at == "failed") return { cls: "failed", text: "failed", tip: `Auto-deploy stopped at ${sha7(a.head)}: ${a.why}` };
  const v = f.answers[e.host]?.version;
  const n = v ? (f.logs[e.host]?.findIndex((c) => c.sha.startsWith(v)) ?? -1) : -1;
  return n > 0 ? { cls: "behind", text: `${n} behind`, tip: `${plural(n, "commit")} of ${e.branch} not deployed` } : null;
}

/** The list: each instance, and under it whether auto-deploy is on, a fact of the whole page. Then the verify suite's entry. */
function side(config: Config, chosen: Entry | null, f: Facts, now: number, verify: boolean): string {
  if (!config.instances.length) return `<p class="none">No instances.</p>${verifySide(f.verify, verify)}`;
  const item = (e: Entry) => {
    const source = f.polls.sources[e.host];
    const st =
      source && isStale(source, now) ? { cls: "stale", what: `stale: ${source.error ?? "no answer yet"}` } : stateOf(f.answers[e.host]);
    const w = wordOf(e, f);
    const word = w ? `<span class="g-state ${w.cls}" title="${esc(w.tip)}">${esc(w.text)}</span>` : "";
    return `<span class="host" title="${esc(`${e.host}: ${st.what}`)}"><i class="light ${st.cls}"></i><span>${esc(e.host)}</span></span><span class="tracks" title="${esc(`tracks ${e.repo} ${e.branch}`)}"><span>${esc(e.branch)}</span>${word}</span>`;
  };
  const auto = f.auto
    ? `<p class="side-auto"><i class="light ok"></i><span>Auto-deploy is on</span></p>`
    : `<p class="side-auto" title="bun erga --auto-deploy turns it on"><i class="light"></i><span>Auto-deploy is off</span></p>`;
  return `<ul class="instances">${config.instances
    .map(
      (e) =>
        `<li><a class="group${e == chosen ? " sel" : ""}" href="#${esc(e.host)}"${e == chosen ? ' aria-current="true"' : ""}>${item(e)}</a></li>`
    )
    .join("")}</ul>${auto}${verifySide(f.verify, verify)}`;
}

/** An instance's own jobs, its deploys and its rollbacks, newest first: no merge, no promote, no job of another instance. */
const jobsOf = (g: Entry, jobs: JobRecord[]) =>
  jobs.filter((j) => j.host == g.host && (j.kind == "deploy" || j.kind == "rollback")).sort((a, b) => b.started.localeCompare(a.started));

/** The command of the job that runs (or that this page starts), or "": while one runs, the page starts no other. */
export const busyWith = (f: Pick<Facts, "jobs" | "run">) => activeJobs(f.jobs, f.run)[0]?.command ?? "";

/** "12 s ago", then as timeAgo. */
const ago = (t: number, now: number) => (now - t < 60_000 ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : timeAgo(t, now));

/** The checks of the instance's own sources, in one line: its repository (its branch's head), its upstream's, and the instance itself. */
function checked(e: Entry, f: Facts, now: number): string {
  const item = (name: string, label: string) => {
    const s = f.polls.sources[name];
    if (!s) return "";
    const stale = isStale(s, now);
    const cls = stale ? "stale" : s.error ? "bad" : s.checked != null ? "ok" : "";
    const what = s.error
      ? `${esc(label)}: <span class="s-err">${esc(s.error)}</span>${stale ? `<span class="s-stale">stale</span>` : ""}`
      : `${esc(label)}, ${s.checked == null ? "checking…" : esc(ago(s.checked, now))}`;
    return `<span class="check ${cls}" data-source="${esc(name)}"><i class="light ${cls}"></i>${what}</span>`;
  };
  // The upstream's repository, when it is another one: one check of a repository gives the heads of all its branches.
  const up =
    e.upstream && repoName(e.upstream.repo) != repoName(e.repo)
      ? item(repoSource(e.upstream.repo), `${repoName(e.upstream.repo)} ${e.upstream.branch}`)
      : "";
  const items = item(repoSource(e.repo), `${repoName(e.repo)} ${e.branch}`) + up + item(e.host, e.host);
  return items ? `<p class="checked" aria-label="Checks"><span>Checked:</span>${items}</p>` : "";
}

/**
 * Auto-deploy stopped for the instance: at which commit, why, and what starts it again. No other place says that it
 * does not try again. Or it leaves the instance to the deployer in the instance's own account.
 */
function stopped(g: Entry, f: Facts): string {
  const a = f.auto?.[g.host];
  if (a?.at == "cloud")
    return `<p class="note">${esc("A deployer in this instance's own account deploys it: this page's auto-deploy leaves it. Deploy and Roll back here still work.")}</p>`;
  if (a?.at != "failed") return "";
  const next =
    a.why == REWRITTEN
      ? `To accept the new head: bun erga deploy ${g.host}`
      : `A new commit on ${g.branch} starts it again, or Deploy on its row.`;
  return `<p class="note bad">${esc(`Auto-deploy stopped at ${sha7(a.head)}: ${a.why} ${next}`)}</p>`;
}

/** The instance's upstream, after what it tracks: its branch, with its repository when that is another one. */
const upstreamLine = (g: Entry) =>
  g.upstream
    ? ` Upstream: ${g.upstream.repo == g.repo ? "" : `<code>${esc(g.upstream.repo)}</code> `}<code>${esc(g.upstream.branch)}</code>.`
    : "";

/** The live part of the page: the list and the chosen instance. `name` is the page's hash: <host>[/<tab>[/<job>]]. */
export function viewHtml(f: Facts, name: string, now = Date.now()): string {
  if ("error" in f.config)
    return `<aside class="side"></aside><section class="main"><p class="note bad">${esc(f.config.error)}</p></section>`;
  const [host = "", wanted = "", id = ""] = name.split("/");
  // #verify[/<setting>]: the verify suite's page, which is about no instance.
  const verify = host == "verify";
  const g = verify ? null : chosenOf(f.config, host);
  const sidebar = `<aside class="side" aria-label="Instances"><h2 class="side-head">Instances</h2>${side(f.config, g, f, now, verify)}</aside>`;
  if (verify) return `${sidebar}${verifyHtml(f.verify, wanted, now)}`;
  if (!g)
    return `${sidebar}<section class="main"><p class="note">No instance is registered in this clone's .erga/config.json. Add one: <code>bun erga register &lt;host&gt;</code></p></section>`;
  const active = activeJobs(f.jobs, f.run);
  const all = f.logs[g.host];
  const a = f.answers[g.host];
  const repo = f.polls.sources[repoSource(g.repo)];
  const u = g.upstream ? f.upstreams[g.host] : undefined;
  const view: InstanceView = {
    host: g.host,
    repo: g.repo,
    branch: g.branch,
    ...(u ? { upstream: { name: upstreamName({ repo: g.repo, upstream: g.upstream! }), ...u } } : {}),
    tracksMore: upstreamLine(g),
    commits: all?.length ? rowsOf(all, a?.version ?? null) : null,
    none: repo?.error ? `This machine can't read ${g.repo}: ${repo.error}` : `The commits of ${g.branch} are not here yet.`,
    runs: a?.version ?? null,
    lost: `${g.host} runs ${a?.version}, which ${g.branch} does not have in this clone.`,
    jobs: jobsOf(g, f.jobs),
    // A command that this page started, before its job record shows; one that stopped before its record says why here.
    starting: f.run.at == "starting" && f.run.job.host == g.host ? { command: f.run.command, what: "starts · from this page" } : null,
    failed: f.run.at == "failed" && f.run.host == g.host ? f.run.why : null,
    busy: active.length > 0,
    deploying: active.flatMap((j) => (j.kind == "deploy" && j.host == g.host && j.commit ? [j.commit] : [])),
    rolling: active.some((j) => j.kind == "rollback" && j.host == g.host),
    rollbackNote: `bun erga rollback ${g.host}. No branch moves. The next deploy goes forward again.`,
    top: stopped(g, f),
    bottom: checked(g, f, now),
    href: (tab, job) => `#${g.host}/${tab}${job ? `/${job}` : ""}`,
  };
  return `${sidebar}${instanceHtml(view, wanted, id, now)}`;
}

/** The whole page: Erga's bar, the live part, and the page's script. */
export function pageHtml(live: string, script: string, code: string): string {
  return `<!doctype html><html lang="en" class="page-light page-white"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="ops-code" content="${esc(code)}">
<title>Ops · Erga</title>${FAVICON_LINK}
<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/bars.css"><link rel="stylesheet" href="/ops-view.css"><link rel="stylesheet" href="/ops-page.css">
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");function t(){var d=m.matches,c=document.documentElement.classList;c.toggle("page-dark",d);c.toggle("page-light",!d);c.toggle("page-white",!d)}t();m.addEventListener("change",t)})()</script>
</head><body>
<nav class="erga-crumbs erga-bar erga-bar-l" aria-label="Breadcrumbs"><a class="erga-brand" href="/"><span>${WORDMARK}</span></a><h1 class="erga-here" aria-current="page"><span>Ops</span></h1></nav>
<p class="gone" id="gone" hidden>bun erga stopped. Run it again, and this page follows.</p>
<div class="ops ops-view" id="ops">${live}</div>
<script>${script}</script>
</body></html>`;
}
