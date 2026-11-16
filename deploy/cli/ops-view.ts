// The ops page's view (`bun erga`, deploy/cli/ops-page.ts serves it): pure, the facts in and HTML out. On the left, the
// instances of .erga/config.json, each with the branch it tracks. On the right, the chosen instance's tabs, the job line
// under them, and the chosen tab. Deploys: the feature branches, each in one row with its tests' state (gate.ts), its
// proof and its Merge button, which only a passed run of the tests opens; then the clone's log with a column for
// each instance that tracks the chosen one's repository, and "live" at the commit it runs. Logs: a job's output.
// History: the jobs of those instances, and the merges and promotes. With auto-deploy on (`bun erga --auto-deploy`), each
// column's head shows its instance's state (auto-state.ts), and the page says why a stopped one stopped.

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import { type Auto, autoText, REWRITTEN } from "./auto-state";
import { type Config, type Entry, repoName } from "./config";
import type { Answer, Branch as StatusBranch, Commit as StatusCommit } from "./flow";
import { secondsOf, TARGET_S, type Test, type TestRun, testOf, testText } from "./gate";
import { type Alive, activeJobs, deploysTo, type JobState, jobState, type Line, type Run } from "./job-state";
import { GITHUB, isStale, type Polls } from "./poll-state";

/** A job's record in .erga/jobs/ (deploy/cli/jobs.ts, startJob), as the page reads it: its state, and what it says. */
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

/** A commit and a branch (flow.ts), with the fields that the page shows and `bun erga status` does not: git gives them all. */
export type Commit = StatusCommit & { author: string; at: number };
export type Branch = StatusBranch & { author: string; tree: string | null };

/** What the clone shows, as the last fetch left it. */
export interface Git {
  /** origin/staging's and origin/main's commits, newest first. */
  log: Commit[];
  branches: Branch[];
  /** The branch the feature branches are counted against. */
  base: string;
  main: string | null;
  staging: string | null;
  /** The instances' commits that are not in `log`, and whether the clone has each one. */
  elsewhere: Record<string, boolean>;
}

export interface Facts {
  config: Config | { error: string };
  answers: Record<string, Answer>;
  git: Git | { error: string };
  jobs: JobRecord[];
  /** The command that this page started (job-state.ts, stepRun). */
  run: Run;
  /** The checks of GitHub and of each instance (poll-state.ts). */
  polls: Polls;
  /** The records of the tests' runs (test-run.ts, readRuns), each under the tree it tested. */
  runs: TestRun[];
  /** Each branch's proof page (bun erga proof): the commit it shows, and when it was made. */
  proofs: Record<string, { sha: string; at: string }>;
  /** Auto-deploy: each instance's state, by its host; null: the mode is off. */
  auto: Record<string, Auto> | null;
  /** The head of the branch that each instance tracks, by its host, as its repository last answered (auto-deploy asks it). */
  heads: Record<string, string | null>;
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

/** The log's columns: each instance that tracks the chosen one's repository, in the file's order. */
export const columnsOf = (config: Config, chosen: Entry): Entry[] =>
  config.instances.filter((e) => repoName(e.repo) == repoName(chosen.repo));

/** Whether the instance runs `sha` (it answers the commit's first 12 characters). */
const runs = (a: Answer | undefined, sha: string) => !!a?.version && sha.startsWith(a.version);

/** The log's rows: at least 15, and down to the oldest commit that an instance of the columns runs. */
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

function side(config: Config, chosen: Entry | null, f: Facts, now: number): string {
  if (!config.instances.length) return `<p class="none">No instances.</p>`;
  const item = (e: Entry) => {
    const source = f.polls.sources[e.host];
    const st = !e.token
      ? { cls: "", what: "not registered yet: bun erga setup" }
      : source && isStale(source, now)
        ? { cls: "stale", what: `stale: ${source.error ?? "no answer yet"}` }
        : stateOf(f.answers[e.host]);
    const tracks = `tracks ${e.repo} ${e.branch}${e.copyOf ? `, on a copy of ${e.copyOf}'s data` : ""}`;
    return `<span class="host" title="${esc(`${e.host}: ${st.what}`)}"><i class="light ${st.cls}"></i><span>${esc(e.host)}</span></span><span class="tracks" title="${esc(tracks)}"><span>${esc(e.branch)}</span></span>`;
  };
  return `<ul class="instances">${config.instances
    .map(
      (e) =>
        `<li><a class="group${e == chosen ? " sel" : ""}" href="#${esc(e.host)}"${e == chosen ? ' aria-current="true"' : ""}>${item(e)}</a></li>`
    )
    .join("")}</ul>`;
}

/** The jobs of the columns' instances, and the jobs that move a branch (a merge, a promote), newest first. */
const jobsOf = (cols: Entry[], jobs: JobRecord[]) =>
  jobs
    .filter((j) => j.kind == "merge" || j.kind == "promote" || cols.some((e) => e.host == j.host))
    .sort((a, b) => b.started.localeCompare(a.started));

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
  if (run.at == "starting" && job?.phase != "running")
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
  if (!mine.length) return `<p class="note">No job yet. Each deploy and rollback of ${esc(g.host)}, and each merge, shows here.</p>`;
  const rows = mine
    .map((j) => {
      const st = jobLook(j, now);
      const result = j.phase == "running" ? "runs" : j.phase == "ok" ? "done" : j.phase;
      return `<a class="h-row ${st.cls}" href="#${esc(g.host)}/logs/${esc(j.id)}" data-job="${esc(j.id)}"><span class="h-state"><i class="light"></i>${result}</span><code class="h-cmd" title="${esc(j.error ?? j.command)}">${esc(j.command)}</code><span class="h-host">${esc(j.host)}</span><span class="h-from">${esc(j.from == "page" ? "this page" : j.from)}</span><time datetime="${esc(j.started)}" title="${esc(j.started)}">${esc(timeAgo(Date.parse(j.started) || now, now))}</time><span class="h-took">${esc(took(j, now))}</span></a>`;
    })
    .join("");
  return `<section class="history" aria-label="Jobs"><div class="h-row h-head"><span>Result</span><span>Command</span><span>Instance</span><span>From</span><span>Started</span><span>Took</span></div>${rows}</section>`;
}

/** The command of the job that runs (or that this page starts), or "": while one runs, the page starts no other. */
export const busyWith = (f: Pick<Facts, "jobs" | "run">) => activeJobs(f.jobs, f.run)[0]?.command ?? "";

/** Why the branch can't merge now, or null: only a passed run of the tests, on the tree of its merge, opens it. */
export function mergeBlock(b: Branch, base: string, busy: string, test: Test): string | null {
  if (!b.ahead) return `Nothing to merge: ${base} has its commits.`;
  if (b.conflicts.length) return `It conflicts with ${base}. Rebase it on origin/${base}, and push it.`;
  if (test.at == "failed") return "Its tests failed. The task's agent repairs them on the branch, and pushes it.";
  if (test.at == "running") return "The tests must pass first. They run now.";
  if (test.at != "passed") return "The tests must pass first. Its run waits in the queue.";
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

/** A branch's tests in its row: a light and one line; a failed run opens to its failed tests, what the failed step said, and its log. */
function testCell(t: Test, now: number): { chip: string; more: string } {
  if (t.at == "none") return { chip: "", more: "" };
  const cls = { waiting: "wait", running: "run", passed: "ok", failed: "bad" }[t.at];
  const tip = t.at == "waiting" && t.before ? ' title="The branch or staging changed since that run: the merge is other code now."' : "";
  // A run's time, in the warning colour when it is over the suite's target.
  const slow = t.at != "waiting" && secondsOf(t.run, now) > TARGET_S;
  const text = esc(testText(t, now)).replace(/\d+ s$/, (time) =>
    slow ? `<b class="f-slow" title="Over the target of ${TARGET_S} s for bun run test">${time}</b>` : time
  );
  const chip = `<span class="f-test ${cls}" data-test="${t.at}"${tip}><i class="light ${cls}"></i>${text}</span>`;
  if (t.at != "failed") return { chip, more: "" };
  const list = t.run.failed.length ? `<ul>${t.run.failed.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const note = t.run.note ? `<pre>${esc(t.run.note)}</pre>` : "";
  const more = `<details class="f-fails"><summary>What failed</summary>${list}${note}<p class="soft">The log: <code>${esc(t.run.log)}</code></p></details>`;
  return { chip, more };
}

function branches(git: Git, f: Pick<Facts, "proofs" | "runs">, active: JobState[], busy: string, now: number): string {
  const list = git.branches.length
    ? git.branches
        .map((b) => {
          const test = testOf(b, f.runs);
          const cell = testCell(test, now);
          const state = !b.ahead
            ? `<span class="f-state">On ${esc(git.base)} already</span>`
            : b.conflicts.length
              ? `<span class="f-state bad" title="${esc(b.conflicts.join(", "))}">Conflicts in ${plural(b.conflicts.length, "file")}: ${esc(b.conflicts.join(", "))}</span>`
              : cell.chip;
          const merge = active.some((j) => j.kind == "merge" && j.branch == b.name)
            ? button(running("Merging"), `data-merge="${esc(b.name)}" aria-busy="true"`, MERGING)
            : button("Merge", `data-merge="${esc(b.name)}"`, mergeBlock(b, git.base, busy, test));
          // The proof page, to look at before the merge: old, when the branch got a commit after it.
          const p = f.proofs[b.name];
          const proof = !p
            ? b.ahead
              ? `<span class="f-proof none" title="The task's agent makes it: bun erga proof">No proof</span>`
              : ""
            : `<a class="f-proof${p.sha == b.sha ? "" : " old"}" href="/proof/${esc(encodeURIComponent(b.name.replaceAll("/", "~")))}/" target="_blank" title="${esc(p.sha == b.sha ? "Pictures of this commit, before and after" : `Made for ${sha7(p.sha)}: the branch has a newer commit`)}">${p.sha == b.sha ? "Proof" : "Proof (old)"}</a>`;
          const form = `<form class="f-merge" data-branch="${esc(b.name)}" hidden><input name="message" value="${esc(b.subject)}" aria-label="The message of the commit on ${esc(git.base)}" autocomplete="off"><button class="btn">Merge</button><button class="btn quiet" type="button" data-cancel>Cancel</button><span class="err" role="alert"></span></form>`;
          return `<li class="feature" data-branch="${esc(b.name)}"><div class="f-top"><code class="f-name">${esc(b.name)}</code><span class="f-count">${plural(b.ahead, "commit")} ahead · ${b.behind} behind ${esc(git.base)}</span>${state}${proof}${merge}</div><div class="f-last"><span class="f-subject">${esc(b.subject)}</span> · ${esc(b.author)} · ${esc(timeAgo(b.at, now))} · <code>${esc(sha7(b.sha))}</code></div>${cell.more}${form}</li>`;
        })
        .join("")
    : `<li class="feature none">No feature branches in this clone.</li>`;
  return `<section class="box" aria-labelledby="features-head"><h3 id="features-head">Feature branches</h3><ul class="features">${list}</ul></section>`;
}

/** "12 s ago", then as timeAgo. */
const ago = (t: number, now: number) => (now - t < 60_000 ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : timeAgo(t, now));

/**
 * Sources: what the page knows and from where. GitHub (the clone's fetch) and each instance of the columns, each with
 * its last check, what it answered, its error, and "stale" when it had no good answer for a few periods.
 */
function sources(cols: Entry[], f: Facts, now: number): string {
  const row = (name: string, label: string, said: string) => {
    const s = f.polls.sources[name];
    if (!s) return "";
    const stale = isStale(s, now);
    const when =
      s.at == "asking" && s.checked == null
        ? "checking…"
        : s.checked == null
          ? "not checked yet"
          : `checked ${ago(s.checked, now)}${s.at == "asking" ? " · checking…" : ""}`;
    const cls = stale ? "stale" : s.error ? "bad" : s.checked != null ? "ok" : "";
    const what = s.error
      ? `<span class="s-err">${esc(s.error)}</span>${s.good ? ` · last good ${esc(ago(s.good, now))}` : ""}`
      : s.checked != null
        ? esc(said)
        : "";
    return `<li class="source ${cls}" data-source="${esc(name)}"><i class="light ${cls}"></i><b>${esc(label)}</b><span class="s-when" title="${esc(s.checked ? new Date(s.checked).toLocaleString() : "")}">${esc(when)}</span>${stale ? `<span class="s-stale">stale</span>` : ""}<span class="s-what">${what}</span></li>`;
  };
  const git = "error" in f.git ? null : f.git;
  const heads = git
    ? [git.staging && `staging ${sha7(git.staging)}`, git.main && `main ${sha7(git.main)}`].filter(Boolean).join(" · ")
    : "";
  const instance = (e: Entry) => {
    const a = f.answers[e.host];
    return row(
      e.host,
      e.host,
      a ? `runs ${a.version ?? "no known commit"} · ${a.healthy == null ? "health unknown" : a.healthy ? "healthy" : "not healthy"}` : ""
    );
  };
  // Auto-deploy's check of the columns' repository: each tracked branch's head.
  const tracked = [...new Map(cols.map((e) => [e.branch, f.heads[e.host]])).entries()]
    .map(([branch, head]) => `${branch} ${head ? sha7(head) : "?"}`)
    .join(" · ");
  const repo = cols[0] ? row(repoSource(cols[0].repo), repoName(cols[0].repo), `git ls-remote: ${tracked}`) : "";
  return `<section class="box sources" aria-labelledby="sources-head"><h3 id="sources-head">Sources</h3><ul>${row(GITHUB, "GitHub", `git fetch: ${heads || "no staging or main"}`)}${repo}${cols.map(instance).join("")}</ul></section>`;
}

/** The time of the last good deploy of `sha` to `host`, from the job records. */
const deployedAt = (jobs: JobRecord[], host: string, sha: string) =>
  jobs
    .filter((j) => j.host == host && j.phase == "ok" && j.commit && j.commit.startsWith(sha.slice(0, 12)))
    .map((j) => Date.parse(j.ended ?? ""))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

/** The Deploy button of a row, in an instance's column: `bun erga deploy <commit> <host>`, after its question. */
function deployButton(e: Entry, c: Commit, busy: string, deploying: boolean): string {
  const note = e.copyOf ? `It keeps its copy of ${e.copyOf}'s data.` : `${e.host} tracks ${e.branch}. No branch moves.`;
  const data = `data-deploy data-host="${esc(e.host)}" data-sha="${esc(c.sha)}" data-ask="${esc(`Deploy ${sha7(c.sha)} ${c.subject} to ${e.host}?`)}" data-note="${esc(note)}" aria-label="${esc(`Deploy ${sha7(c.sha)} to ${e.host}`)}"`;
  if (deploying) return `<span class="deps here busy">${button(running("Deploying"), `${data} aria-busy="true"`, DEPLOYING)}</span>`;
  return `<span class="deps here">${button("Deploy", data, busy ? `Another job runs: ${busy}. Wait for it to end.` : null)}</span>`;
}

function log(g: Entry, cols: Entry[], f: Facts & { git: Git }, now: number): string {
  const git = f.git;
  const answer = (e: Entry) => f.answers[e.host];
  const rows = rowsOf(
    git.log,
    cols.map((e) => answer(e)?.version ?? null)
  );
  // Green: the commits that the chosen instance runs (that commit and the ones before it); else main's.
  const top = answer(g)?.version ?? git.main?.slice(0, 12) ?? null;
  const on = top ? rows.findIndex((c) => c.sha.startsWith(top)) : -1;
  const isOn = (i: number) => on >= 0 && i >= on;
  // A commit of the branch that an instance tracks: its head's row, and the rows after it (the log is one line). An
  // instance deploys no other commit. A branch whose head the page does not know: the deploy itself checks.
  const headRow = (e: Entry) => {
    const head = e.branch == "staging" ? git.staging : e.branch == "main" ? git.main : null;
    return head ? rows.findIndex((c) => c.sha == head) : 0;
  };
  const heads = new Map(cols.map((e) => [e.host, headRow(e)]));
  const onBranch = (e: Entry, i: number) => heads.get(e.host)! >= 0 && i >= heads.get(e.host)!;
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
      const a = f.auto?.[e.host];
      const auto = a
        ? `<span class="auto ${a.at}" data-auto-host="${esc(e.host)}" data-auto="${a.at}"${a.at == "failed" ? ` title="${esc(a.why)}"` : ""}>auto: ${esc(autoText(a, { head: f.heads[e.host] ?? null, runs: answer(e)?.version ?? null }))}</span>`
        : "";
      return `<div class="head col" title="${esc(`${e.host}: ${st.what}`)}"><b>${esc(e.branch)}</b><span class="host">${esc(e.host)}</span><span class="st"><i class="light ${st.cls}"></i>${esc(answer(e)?.error ? "no answer" : st.cls == "bad" ? "not healthy" : answer(e) ? "live" : "asking…")}</span>${auto}</div>`;
    })
    .join("");
  // Auto-deploy stopped for an instance: why, and what starts it again.
  const stopped = cols.flatMap((e) => {
    const a = f.auto?.[e.host];
    if (a?.at != "failed") return [];
    const next =
      a.why == REWRITTEN
        ? `To accept the new head: bun erga deploy ${e.host}`
        : `A new commit on ${e.branch} starts it again, or: bun erga deploy ${e.host}`;
    return [`Auto-deploy of ${e.host} stopped: ${a.why} ${next}`];
  });
  const active = activeJobs(f.jobs, f.run);
  const busy = active[0]?.command ?? "";
  const body = rows
    .map((c, i) => {
      const kind = isOn(i) ? "on" : "off";
      const marks = cols
        .map((e) => {
          // Its own deploy stays "Deploying…" until the job ends, even when the instance answers the new commit before.
          const deploying = active.some((j) => deploysTo(j, c.sha, e.host));
          if (!runs(answer(e), c.sha) || deploying)
            return onBranch(e, i) || deploying
              ? deployButton(e, c, busy, deploying)
              : `<span class="deps" title="${esc(`Not on ${e.branch}, the branch that ${e.host} tracks`)}"></span>`;
          const at = deployedAt(f.jobs, e.host, c.sha);
          return `<span class="deps"><span class="dep live" data-host="${esc(e.host)}" title="${esc(`${e.host} runs this commit`)}"><span class="w">live</span><span class="at">${at ? short(at, now) : ""}</span></span></span>`;
        })
        .join("");
      return `<div class="row ${kind}" data-sha="${esc(c.sha)}"><span class="rail${i ? " up" : ""}${i < rows.length - 1 ? " down" : ""} ${kind}"><i class="dot ${kind}"></i></span><span class="subj" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="who">${esc(c.author)}</span><code class="sha">${esc(sha7(c.sha))}</code><time>${esc(timeAgo(c.at, now))}</time>${marks}</div>`;
    })
    .join("");
  return `<section class="commits" aria-label="Commits">
    <div class="legend"><span><i class="dot off"></i>not on ${esc(g.host)} yet</span><span><i class="dot on"></i>on ${esc(g.host)}</span></div>
    ${stopped.map((n) => `<p class="note bad">${esc(n)}</p>`).join("")}${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    <div class="grid" style="--cols: ${cols.length}"><div class="head"></div><div class="head">Commit</div><div class="head who"></div><div class="head sha"></div><div class="head time"></div>${head}${body || `<div class="none">No commits on origin/staging or origin/main in this clone.</div>`}</div>
    <div class="confirm" id="deploy-confirm" popover><p data-s="ask"></p><p class="soft" data-s="note"></p><div class="acts"><button class="btn" type="button" data-go>Deploy</button><button class="btn quiet" type="button" popovertarget="deploy-confirm" popovertargetaction="hide">Cancel</button></div><p class="err" role="alert"></p></div>
  </section>`;
}

/** The tabs of an instance, by their name in the hash (#<host>/<tab>). */
const TABS: Record<string, string> = { deploys: "Deploys", logs: "Logs", history: "History" };

/**
 * The newest job of all, for the page's script: when another one starts on an instance that the page does not show
 * (one that is not in the columns), the page switches to that instance.
 */
function newest(g: Entry, cols: Entry[], config: Config, jobs: JobRecord[]): string {
  const job = jobs.reduce<JobRecord | null>((a, j) => (!a || j.started > a.started ? j : a), null);
  if (!job) return "";
  const shown = cols.some((e) => e.host == job.host) || !config.instances.some((e) => e.host == job.host);
  return ` data-newest="${esc(job.id)}" data-newest-host="${esc(shown ? g.host : job.host)}"`;
}

/** The live part of the page: the sidebar and the chosen instance. `name` is the page's hash: <host>[/<tab>[/<job>]]. */
export function viewHtml(f: Facts, name: string, now = Date.now()): string {
  if ("error" in f.config)
    return `<aside class="side"></aside><section class="main"><p class="note bad">${esc(f.config.error)}</p></section>`;
  const [host = "", wanted = "", id = ""] = name.split("/");
  const g = chosenOf(f.config, host);
  const sidebar = `<aside class="side" aria-label="Instances"><h2 class="side-head">Instances</h2>${side(f.config, g, f, now)}</aside>`;
  if (!g)
    return `${sidebar}<section class="main"><p class="note">No instance is registered in this clone's .erga/config.json. Add one: <code>bun erga register &lt;host&gt;</code></p></section>`;
  const tab = TABS[wanted] ? wanted : "deploys";
  const tabs = `<nav class="tabs" role="tablist">${Object.entries(TABS)
    .map(([k, t]) => `<a class="tab" role="tab" href="#${esc(g.host)}/${k}" aria-selected="${k == tab}">${t}</a>`)
    .join("")}</nav>`;
  const cols = columnsOf(f.config, g);
  const mine = jobsOf(cols, f.jobs);
  const body =
    tab == "logs"
      ? logs(g, mine, id, now)
      : tab == "history"
        ? history(g, mine, now)
        : sources(cols, f, now) +
            ("error" in f.git
              ? `<p class="note bad">${esc(f.git.error)}</p>`
              : branches(f.git, f, activeJobs(f.jobs, f.run), busyWith(f), now) + log(g, cols, { ...f, git: f.git }, now));
  return `${sidebar}<section class="main" data-host="${esc(g.host)}" data-tab="${tab}"${newest(g, cols, f.config, f.jobs)}><h2 class="title">${esc(g.host)}</h2><p class="tracks-line">Tracks <code>${esc(g.repo)}</code> <code>${esc(g.branch)}</code>${g.copyOf ? `, on a copy of ${esc(g.copyOf)}'s data, for admins only` : ""}. ${f.auto ? "Auto-deploy is on." : "Auto-deploy is off: <code>bun erga --auto-deploy</code> turns it on."}</p>${tabs}${jobLine(g, mine, f.run, now)}${f.run.at == "failed" ? `<p class="note bad failed">${esc(f.run.why)}</p>` : ""}<div class="tab-body">${body}</div></section>`;
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
