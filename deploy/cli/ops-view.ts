// The ops page's view (`bun erga`, deploy/cli/ops-page.ts serves it): pure, the facts in and HTML out. On the left, the
// instances of .erga/config.json, each with the branch it tracks and one word when it is not at its branch's head, and
// whether auto-deploy is on. The right side is about the chosen instance only, and names no other one: its tabs, its
// job line (the command that runs, or its last one), and the chosen tab. Deploys: the commits of its branch, green
// where it is live and orange where it is not yet, with a Deploy button on a row, and one line of its own sources'
// checks; the live row has Roll back. An instance that names an upstream shows the upstream's commits that its branch
// lacks as orange rows on top, and a tag at each of the two heads. Logs: a job's output. History: its deploys and rollbacks. The page shows no feature branch and merges
// nothing: `bun erga status` lists the branches, and `bun erga merge` merges. Under the instances, the list has the
// verify suite's entry (#verify): the runs on real platforms, with their prerequisites (verify-view.ts).

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import { type Auto, REWRITTEN } from "./auto-state";
import { type Config, type Entry, repoName, upstreamName } from "./config";
import type { Answer, Commit as StatusCommit } from "./flow";
import type { TestRun } from "./gate";
import { type Alive, activeJobs, deploysTo, type JobState, jobState, type Line, type Run } from "./job-state";
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

/** Whether the instance runs `sha` (it answers the commit's first 12 characters). */
const runs = (a: Answer | undefined, sha: string) => !!a?.version && sha.startsWith(a.version);

/** The log's rows: at least 15, and down to the commit that the instance runs. */
export function rowsOf(log: Commit[], version: string | null): Commit[] {
  const i = version ? log.findIndex((c) => c.sha.startsWith(version)) : -1;
  return log.slice(0, Math.max(14, i) + 1);
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

/** A job's light (its class) and its state in words: "done 5 minutes ago · from a terminal". */
function jobLook(job: JobRecord, now: number): { cls: string; what: string } {
  const from = `from ${job.from == "page" ? "this page" : job.from == "auto-deploy" ? job.from : `a ${job.from}`}`;
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

/** The job line: the job that runs, else the last job. */
function jobLine(g: Entry, mine: JobRecord[], run: Run, now: number): string {
  const job = mine.find((j) => j.phase == "running") ?? mine[0];
  // A command that this page started, before its job record shows.
  if (run.at == "starting" && run.job.host == g.host && job?.phase != "running")
    return `<div class="job running"><i class="light"></i><code>${esc(run.command)}</code><span>starts · from this page</span></div>`;
  if (!job) return `<div class="job none">No job yet. A deploy or a rollback of ${esc(g.host)} shows here as it runs.</div>`;
  const st = jobLook(job, now);
  return `<a class="job ${st.cls}" href="#${esc(g.host)}/logs/${esc(job.id)}" title="${esc(st.what)}"><i class="light"></i><code>${esc(job.command)}</code><span>${esc(st.what)}</span></a>`;
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
function logs(g: Entry, mine: JobRecord[], id: string, now: number): string {
  const job = mine.find((j) => j.id == id) ?? mine.find((j) => j.phase == "running") ?? mine[0];
  if (!job) return `<p class="note">No job yet. The output of a deploy or a rollback of ${esc(g.host)} shows here as it runs.</p>`;
  const st = jobLook(job, now);
  const lines = job.out.map((l) => `<span>${esc(l)}</span>`).join("\n");
  const end = job.error ? `\n<span class="bad">${esc(job.error)}</span>` : "";
  return `<section class="logs" data-job="${esc(job.id)}" aria-label="The job's output"><div class="log-head"><code>${esc(job.command)}</code><span class="when">${esc(new Date(Date.parse(job.started) || now).toLocaleString())}</span><span class="state ${st.cls}">${esc(job.phase == "running" ? "runs" : st.cls == "ok" ? "done" : st.cls)}${took(job, now) ? ` · ${took(job, now)}` : ""}</span></div><pre class="log">${lines || (job.phase == "running" ? "<span>No output yet.</span>" : "<span>No output.</span>")}${end}</pre></section>`;
}

/** History: the jobs, newest first. */
function history(g: Entry, mine: JobRecord[], now: number): string {
  if (!mine.length) return `<p class="note">No job yet. Each deploy and rollback of ${esc(g.host)} shows here.</p>`;
  const rows = mine
    .map((j) => {
      const st = jobLook(j, now);
      const result = j.phase == "running" ? "runs" : j.phase == "ok" ? "done" : j.phase;
      return `<a class="h-row ${st.cls}" href="#${esc(g.host)}/logs/${esc(j.id)}" data-job="${esc(j.id)}"><span class="h-state"><i class="light"></i>${result}</span><code class="h-cmd" title="${esc(j.error ?? j.command)}">${esc(j.command)}</code><span class="h-from">${esc(j.from == "page" ? "this page" : j.from)}</span><time datetime="${esc(j.started)}" title="${esc(j.started)}">${esc(timeAgo(Date.parse(j.started) || now, now))}</time><span class="h-took">${esc(took(j, now))}</span></a>`;
    })
    .join("");
  return `<section class="history" aria-label="Jobs"><div class="h-row h-head"><span>Result</span><span>Command</span><span>From</span><span>Started</span><span>Took</span></div>${rows}</section>`;
}

/** The command of the job that runs (or that this page starts), or "": while one runs, the page starts no other. */
export const busyWith = (f: Pick<Facts, "jobs" | "run">) => activeJobs(f.jobs, f.run)[0]?.command ?? "";

/** A button with the page's look; a disabled one says why in its tip. */
const button = (label: string, attrs: string, block: string | null = null) =>
  `<span class="tip"${block ? ` title="${esc(block)}"` : ""}><button class="btn" type="button" ${attrs}${block ? " disabled" : ""}>${label}</button></span>`;

/** A button's label while its own job runs: a small spinner, and the word. */
const running = (word: string) => `<i class="spin" aria-hidden="true"></i>${word}…`;
const DEPLOYING = "It deploys now. The job line and Logs show its output.";
const ROLLING = "It rolls back now. The job line and Logs show its output.";

/** "12 s ago", then as timeAgo. */
const ago = (t: number, now: number) => (now - t < 60_000 ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : timeAgo(t, now));

/** A button that is off while a job runs: the page says no more, since the job can be another instance's. */
const BUSY = "Another job runs. Wait for it to end.";

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

/** The time of the last good deploy of `sha` to `host`, from the job records. */
const deployedAt = (jobs: JobRecord[], host: string, sha: string) =>
  jobs
    .filter((j) => j.host == host && j.phase == "ok" && j.commit && j.commit.startsWith(sha.slice(0, 12)))
    .map((j) => Date.parse(j.ended ?? ""))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

/** The Deploy button of a row: `bun erga deploy <commit> <host>`, after its question. `show`: always, not only under the mouse. */
function deployButton(e: Entry, c: Commit, busy: boolean, deploying: boolean, show: boolean): string {
  const note = `${e.host} tracks ${e.branch}. No branch moves.`;
  const data = `data-deploy data-host="${esc(e.host)}" data-sha="${esc(c.sha)}" data-ask="${esc(`Deploy ${sha7(c.sha)} ${c.subject} to ${e.host}?`)}" data-note="${esc(note)}" aria-label="${esc(`Deploy ${sha7(c.sha)} to ${e.host}`)}"`;
  if (deploying) return `<span class="deps here busy">${button(running("Deploying"), `${data} aria-busy="true"`, DEPLOYING)}</span>`;
  return `<span class="deps here${show ? " show" : ""}">${button("Deploy", data, busy ? BUSY : null)}</span>`;
}

/**
 * The live row's cell: the "live" mark with the time of its deploy, and the Roll back button, which takes the mark's
 * place under the mouse or with the focus (`bun erga rollback <host>`, after its question). While the rollback runs,
 * the cell says so.
 */
function liveCell(e: Entry, at: string, busy: boolean, rolling: boolean): string {
  if (rolling) return `<span class="deps here busy">${button(running("Rolling back"), 'aria-busy="true"', ROLLING)}</span>`;
  const ask = `Roll back ${e.host} to the version from before its last deploy?`;
  const note = `bun erga rollback ${e.host}. No branch moves. The next deploy goes forward again.`;
  const back = `<span class="tip"${busy ? ` title="${esc(BUSY)}"` : ""}><button class="btn quiet" type="button" data-rollback data-host="${esc(e.host)}" data-ask="${esc(ask)}" data-note="${esc(note)}" aria-label="${esc(`Roll back ${e.host}`)}"${busy ? " disabled" : ""}>Roll back</button></span>`;
  return `<span class="deps here back"><span class="dep live" data-host="${esc(e.host)}" title="${esc(`${e.host} runs this commit`)}"><span class="w">live</span><span class="at">${at}</span></span>${back}</span>`;
}

/** How many of an upstream's commits the list shows: the others are one line with their count. */
const UPSTREAM_ROWS = 15;

/**
 * The instance's commits, in one column. Green (a filled dot): live on the instance, the commit that it runs and those
 * before it. Orange (a ring): not on it yet. On top, the commits of its upstream that its branch lacks: no deploy
 * takes them, so they have no button. Then its branch's commits, with "live" at the commit that runs, with Roll back; a
 * Deploy button on each other row under the mouse, and always on the head's row while the head is not live. With an
 * upstream, a tag marks each of the two heads; the line breaks between the two when each has commits that the other
 * lacks.
 */
function commits(g: Entry, f: Facts, now: number): string {
  const all = f.logs[g.host];
  const head = `<h3 class="c-head">Commits</h3>`;
  if (!all?.length) {
    const repo = f.polls.sources[repoSource(g.repo)];
    const why = repo?.error ? `This machine can't read ${g.repo}: ${repo.error}` : `The commits of ${g.branch} are not here yet.`;
    return `<section class="commits" aria-label="Commits">${head}<div class="grid" style="--cols: 1"><div class="none">${esc(why)}</div></div></section>`;
  }
  const a = f.answers[g.host];
  const rows = rowsOf(all, a?.version ?? null);
  const on = a?.version ? rows.findIndex((c) => c.sha.startsWith(a.version!)) : -1;
  const note =
    a?.version && on < 0 ? `<p class="note">${esc(`${g.host} runs ${a.version}, which ${g.branch} does not have in this clone.`)}</p>` : "";
  const active = activeJobs(f.jobs, f.run);
  const rolling = active.some((j) => j.kind == "rollback" && j.host == g.host);
  // The upstream: its commits that the branch lacks, and where its head is.
  const u = g.upstream ? f.upstreams[g.host] : undefined;
  const uName = g.upstream ? upstreamName({ repo: g.repo, upstream: g.upstream }) : "";
  const above = u ? u.behind.slice(0, UPSTREAM_ROWS) : [];
  const apart = !!u && u.behind.length > 0 && u.ahead > 0;
  const total = above.length + rows.length;
  const tag = (text: string, tip: string) => `<span class="ref" title="${esc(tip)}">${esc(text)}</span>`;
  const upTag = (c: Commit) => (u && c.sha == u.head ? tag(uName, `${uName}, the upstream, is at this commit`) : "");
  const row = (c: Commit, n: number, kind: string, tip: string, tags: string, cell: string, cut: "above" | "below" | "") =>
    `<div class="row ${kind}" data-sha="${esc(c.sha)}"><span class="rail${n && cut != "above" ? " up" : ""}${n < total - 1 && cut != "below" ? " down" : ""} ${kind}" title="${esc(tip)}"><i class="dot ${kind}"></i></span><span class="subj" title="${esc(c.subject)}">${tags}${esc(c.subject)}</span><span class="who">${esc(c.author)}</span><code class="sha">${esc(sha7(c.sha))}</code><time>${esc(timeAgo(c.at, now))}</time>${cell}</div>`;
  const upstream = above
    .map((c, i) =>
      row(
        c,
        i,
        "off",
        `On ${uName}, not on ${g.branch} yet`,
        upTag(c),
        `<span class="deps" title="${esc(`Not on ${g.branch}, the branch that ${g.host} tracks`)}"></span>`,
        apart && i == above.length - 1 ? "below" : ""
      )
    )
    .join("");
  const more =
    u && u.behind.length > above.length
      ? `<div class="more">${esc(`and ${plural(u.behind.length - above.length, "more commit")} of ${uName}`)}</div>`
      : "";
  const body = rows
    .map((c, i) => {
      const kind = on >= 0 && i >= on ? "on" : "off";
      // Its own deploy stays "Deploying…" until the job ends, even when the instance answers the new commit before.
      const deploying = active.some((j) => deploysTo(j, c.sha, g.host));
      const at = deployedAt(f.jobs, g.host, c.sha);
      const cell =
        !runs(a, c.sha) || deploying
          ? deployButton(g, c, active.length > 0, deploying, i == 0)
          : liveCell(g, at ? short(at, now) : "", active.length > 0, rolling);
      const tip = kind == "on" ? `Live on ${g.host}` : `On ${g.branch}, not on ${g.host} yet`;
      const tags = (u && i == 0 ? tag(g.branch, `${g.branch}, the branch that ${g.host} tracks, is at this commit`) : "") + upTag(c);
      return row(c, above.length + i, kind, tip, tags, cell, apart && i == 0 ? "above" : "");
    })
    .join("");
  return `${note}<section class="commits" aria-label="Commits">${head}<div class="grid" style="--cols: 1">${upstream}${more}${body}</div>
    <div class="confirm" id="deploy-confirm" popover><p data-s="ask"></p><p class="soft" data-s="note"></p><div class="acts"><button class="btn" type="button" data-go>Deploy</button><button class="btn quiet" type="button" popovertarget="deploy-confirm" popovertargetaction="hide">Cancel</button></div><p class="err" role="alert"></p></div>
  </section>`;
}

/** Auto-deploy stopped for the instance: at which commit, why, and what starts it again. No other place says that it does not try again. */
function stopped(g: Entry, f: Facts): string {
  const a = f.auto?.[g.host];
  if (a?.at != "failed") return "";
  const next =
    a.why == REWRITTEN
      ? `To accept the new head: bun erga deploy ${g.host}`
      : `A new commit on ${g.branch} starts it again, or Deploy on its row.`;
  return `<p class="note bad">${esc(`Auto-deploy stopped at ${sha7(a.head)}: ${a.why} ${next}`)}</p>`;
}

/** The tabs of an instance, by their name in the hash (#<host>/<tab>). */
const TABS: Record<string, string> = { deploys: "Deploys", logs: "Logs", history: "History" };

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
  const tab = TABS[wanted] ? wanted : "deploys";
  const tabs = `<nav class="tabs" role="tablist">${Object.entries(TABS)
    .map(([k, t]) => `<a class="tab" role="tab" href="#${esc(g.host)}/${k}" aria-selected="${k == tab}">${t}</a>`)
    .join("")}</nav>`;
  const mine = jobsOf(g, f.jobs);
  const body =
    tab == "logs"
      ? logs(g, mine, id, now)
      : tab == "history"
        ? history(g, mine, now)
        : stopped(g, f) + commits(g, f, now) + checked(g, f, now);
  // The page's own command that stopped before its job record: on its instance's page.
  const failed = f.run.at == "failed" && f.run.host == g.host ? `<p class="note bad failed">${esc(f.run.why)}</p>` : "";
  return `${sidebar}<section class="main" data-host="${esc(g.host)}" data-tab="${tab}"><h2 class="title">${esc(g.host)}</h2><p class="tracks-line">Tracks <code>${esc(g.repo)}</code> <code>${esc(g.branch)}</code>.${upstreamLine(g)}</p>${tabs}${jobLine(g, mine, f.run, now)}${failed}<div class="tab-body">${body}</div></section>`;
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
<script>${script}</script>
</body></html>`;
}
