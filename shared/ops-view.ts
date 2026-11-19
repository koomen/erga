// The view of one instance's deploys: pure, the facts in and HTML out. Two pages draw with it, so an instance looks
// the same on both: the ops page of a machine (`bun erga`, deploy/cli/ops-view.ts, which adds the list of instances)
// and the instance's own page in the app (/admin/ops). Its look is assets/ops/ops-view.css.
//
// Its tabs, its job line (the command that runs, or its last one), and the chosen tab. Deploys: the commits of its
// branch, green where it is live and orange where it is not yet, with a Deploy button on a row; the live row has Roll
// back. An instance that names an upstream shows the upstream's commits that its branch lacks as orange rows on top,
// and a tag at each of the two heads. Logs: a job's output. History: its deploys and rollbacks.
//
// The page that draws it starts the jobs: a button here only carries what it asks for (data-deploy, data-rollback,
// with data-host, data-sha, data-ask and data-note), and the page's script asks the question and sends it.

import { esc } from "./html";
import { plural, timeAgo } from "./time";

/** A commit of the instance's branch. `release`: GitHub's release of it, where the page knows (none yet, or refused: no deploy). */
export interface ViewCommit {
  sha: string;
  subject: string;
  author?: string;
  at: number;
  release?: "released" | "none" | "refused";
}

/** A deploy or a rollback of the instance, as the view shows it. */
export interface ViewJob {
  id: string;
  /** The commit it deploys: null before the job knows it, and for a rollback. */
  commit: string | null;
  /** stopped: it ended with no result. */
  phase: "starting" | "running" | "ok" | "failed" | "stopped";
  command: string;
  /** Where its command came from: "terminal", "page" (the page that shows it), "auto-deploy", "app, by <login>". */
  from: string;
  started: string;
  ended?: string;
  error?: string;
  /** Its output's lines. */
  out: string[];
}

export interface InstanceView {
  host: string;
  /** false: no heading with the host's name (the page has its own). */
  heading?: boolean;
  repo: string;
  branch: string;
  /** The instance's upstream: its name, its head, its commits that the instance's branch lacks (newest first), and how many the branch has that it lacks. */
  upstream?: { name: string; head: string; behind: ViewCommit[]; ahead: number };
  /** HTML after what it tracks, in the same line. */
  tracksMore?: string;
  /** The branch's commits, newest first, down to the one that runs. null: the page has none, and `none` says why. */
  commits: ViewCommit[] | null;
  none: string;
  /** The commit that the instance runs (its first 12 characters), or null. */
  runs: string | null;
  /** What to say when the commit that runs is not among `commits`. */
  lost: string;
  /** The instance's deploys and rollbacks, newest first. */
  jobs: ViewJob[];
  /** A command that the page started, before its job shows: the command, and where it is ("starts · from this page"). */
  starting: { command: string; what: string } | null;
  /** Why the page's own command stopped before its job. */
  failed: string | null;
  /** A job runs (of this instance, or one that keeps it busy): the buttons are off. */
  busy: boolean;
  /** The commits that a deploy of this instance, running or starting, deploys. */
  deploying: string[];
  /** A rollback of this instance runs or starts. */
  rolling: boolean;
  /** The words under the rollback's question. */
  rollbackNote: string;
  /** HTML above the commits, and under them. */
  top?: string;
  bottom?: string;
  /** The address of a tab ("deploys", "logs", "history"), or of a job's log. */
  href: (tab: string, job?: string) => string;
}

/** "now", "5m", "2h", "3d". */
const short = (t: number, now: number) => {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
export const sha7 = (sha: string) => sha.slice(0, 7);

/** Where a job came from, in words: "from a terminal", "from this page", "from the app, by ada". */
const fromWords = (from: string) =>
  `from ${from == "page" ? "this page" : from == "auto-deploy" ? from : from.startsWith("app") ? `the ${from}` : `a ${from}`}`;

/** A job's light (its class) and its state in words: "done 5 minutes ago · from a terminal". */
function jobLook(job: ViewJob, now: number): { cls: string; what: string } {
  const from = fromWords(job.from);
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
function jobLine(v: InstanceView, now: number): string {
  const job = v.jobs.find((j) => j.phase == "running") ?? v.jobs[0];
  // A command that the page started, before its job shows.
  if (v.starting && job?.phase != "running")
    return `<div class="job running"><i class="light"></i><code>${esc(v.starting.command)}</code><span>${esc(v.starting.what)}</span></div>`;
  if (!job) return `<div class="job none">No job yet. A deploy or a rollback of ${esc(v.host)} shows here as it runs.</div>`;
  const st = jobLook(job, now);
  return `<a class="job ${st.cls}" href="${esc(v.href("logs", job.id))}" title="${esc(st.what)}"><i class="light"></i><code>${esc(job.command)}</code><span>${esc(st.what)}</span></a>`;
}

/** "45 s", "3 min 5 s", "1 h 2 min". */
const took = (job: ViewJob, now: number) => {
  const end = job.phase == "running" ? now : Date.parse(job.ended ?? "");
  const s = Math.round((end - Date.parse(job.started)) / 1000);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s} s`;
  return s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
};

/** Logs: the output of the job that `id` names, else of the job that runs, else of the last one. */
function logs(v: InstanceView, id: string, now: number): string {
  const job = v.jobs.find((j) => j.id == id) ?? v.jobs.find((j) => j.phase == "running") ?? v.jobs[0];
  if (!job) return `<p class="note">No job yet. The output of a deploy or a rollback of ${esc(v.host)} shows here as it runs.</p>`;
  const st = jobLook(job, now);
  const lines = job.out.map((l) => `<span>${esc(l)}</span>`).join("\n");
  const end = job.error ? `\n<span class="bad">${esc(job.error)}</span>` : "";
  return `<section class="logs" data-job="${esc(job.id)}" aria-label="The job's output"><div class="log-head"><code>${esc(job.command)}</code><span class="when">${esc(new Date(Date.parse(job.started) || now).toLocaleString())}</span><span class="state ${st.cls}">${esc(job.phase == "running" ? "runs" : st.cls == "ok" ? "done" : st.cls)}${took(job, now) ? ` · ${took(job, now)}` : ""}</span></div><pre class="log">${lines || (job.phase == "running" ? "<span>No output yet.</span>" : "<span>No output.</span>")}${end}</pre></section>`;
}

/** History: the jobs, newest first. */
function history(v: InstanceView, now: number): string {
  if (!v.jobs.length) return `<p class="note">No job yet. Each deploy and rollback of ${esc(v.host)} shows here.</p>`;
  const rows = v.jobs
    .map((j) => {
      const st = jobLook(j, now);
      const result = j.phase == "running" ? "runs" : j.phase == "ok" ? "done" : j.phase;
      return `<a class="h-row ${st.cls}" href="${esc(v.href("logs", j.id))}" data-job="${esc(j.id)}"><span class="h-state"><i class="light"></i>${result}</span><code class="h-cmd" title="${esc(j.error ?? j.command)}">${esc(j.command)}</code><span class="h-from">${esc(j.from == "page" ? "this page" : j.from)}</span><time datetime="${esc(j.started)}" title="${esc(j.started)}">${esc(timeAgo(Date.parse(j.started) || now, now))}</time><span class="h-took">${esc(took(j, now))}</span></a>`;
    })
    .join("");
  return `<section class="history" aria-label="Jobs"><div class="h-row h-head"><span>Result</span><span>Command</span><span class="h-from">From</span><span>Started</span><span class="h-took">Took</span></div>${rows}</section>`;
}

/** A button with the page's look; a disabled one says why in its tip. */
const button = (label: string, attrs: string, block: string | null = null) =>
  `<span class="tip"${block ? ` title="${esc(block)}"` : ""}><button class="btn" type="button" ${attrs}${block ? " disabled" : ""}>${label}</button></span>`;

/** A button's label while its own job runs: a small spinner, and the word. */
const running = (word: string) => `<i class="spin" aria-hidden="true"></i>${word}…`;
const DEPLOYING = "It deploys now. The job line and Logs show its output.";
const ROLLING = "It rolls back now. The job line and Logs show its output.";

/** A button that is off while a job runs: the page says no more, since the job can be another instance's. */
const BUSY = "Another job runs. Wait for it to end.";

/** The time of the last good deploy of `sha`, from the jobs. */
const deployedAt = (jobs: ViewJob[], sha: string) =>
  jobs
    .filter((j) => j.phase == "ok" && j.commit && j.commit.startsWith(sha.slice(0, 12)))
    .map((j) => Date.parse(j.ended ?? ""))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

/** The Deploy button of a row, which carries its question. `show`: always, not only under the mouse. */
function deployButton(v: InstanceView, c: ViewCommit, deploying: boolean, show: boolean): string {
  const note = `${v.host} tracks ${v.branch}. No branch moves.`;
  const data = `data-deploy data-host="${esc(v.host)}" data-sha="${esc(c.sha)}" data-ask="${esc(`Deploy ${sha7(c.sha)} ${c.subject} to ${v.host}?`)}" data-note="${esc(note)}" aria-label="${esc(`Deploy ${sha7(c.sha)} to ${v.host}`)}"`;
  if (deploying) return `<span class="deps here busy">${button(running("Deploying"), `${data} aria-busy="true"`, DEPLOYING)}</span>`;
  return `<span class="deps here${show ? " show" : ""}">${button("Deploy", data, v.busy ? BUSY : null)}</span>`;
}

/** The cell of a commit that no deploy takes: GitHub has no release of it yet, or one that the deployer refuses. */
const noRelease = (c: ViewCommit) =>
  c.release == "refused"
    ? `<span class="deps" title="GitHub's release of this commit is not one release of Erga's: the deployer refuses it."><span class="dep wait">refused</span></span>`
    : `<span class="deps" title="GitHub has no release of this commit yet: its tests and its build run, or they failed."><span class="dep wait">no release yet</span></span>`;

/**
 * The live row's cell: the "live" mark with the time of its deploy, and the Roll back button, which takes the mark's
 * place under the mouse or with the focus, and carries its question. While the rollback runs, the cell says so.
 */
function liveCell(v: InstanceView, at: string): string {
  if (v.rolling) return `<span class="deps here busy">${button(running("Rolling back"), 'aria-busy="true"', ROLLING)}</span>`;
  const ask = `Roll back ${v.host} to the version from before its last deploy?`;
  const back = `<span class="tip"${v.busy ? ` title="${esc(BUSY)}"` : ""}><button class="btn quiet" type="button" data-rollback data-host="${esc(v.host)}" data-ask="${esc(ask)}" data-note="${esc(v.rollbackNote)}" aria-label="${esc(`Roll back ${v.host}`)}"${v.busy ? " disabled" : ""}>Roll back</button></span>`;
  return `<span class="deps here back"><span class="dep live" data-host="${esc(v.host)}" title="${esc(`${v.host} runs this commit`)}"><span class="w">live</span><span class="at">${at}</span></span>${back}</span>`;
}

/** How many of an upstream's commits the list shows: the others are one line with their count. */
const UPSTREAM_ROWS = 15;

/**
 * The instance's commits, in one column. Green (a filled dot): live on the instance, the commit that it runs and those
 * before it. Orange (a ring): not on it yet. On top, the commits of its upstream that its branch lacks: no deploy
 * takes them, so they have no button. Then its branch's commits, with "live" at the commit that runs, with Roll back; a
 * Deploy button on each other row under the mouse, and always on the newest row that takes a deploy while it is not live. With an
 * upstream, a tag marks each of the two heads; the line breaks between the two when each has commits that the other
 * lacks.
 */
function commits(v: InstanceView, now: number): string {
  const head = `<h3 class="c-head">Commits</h3>`;
  if (!v.commits?.length)
    return `<section class="commits" aria-label="Commits">${head}<div class="grid" style="--cols: 1"><div class="none">${esc(v.none)}</div></div></section>`;
  const rows = v.commits;
  const on = v.runs ? rows.findIndex((c) => c.sha.startsWith(v.runs!)) : -1;
  const note = v.runs && on < 0 ? `<p class="note">${esc(v.lost)}</p>` : "";
  // The upstream: its commits that the branch lacks, and where its head is.
  const u = v.upstream;
  const above = u ? u.behind.slice(0, UPSTREAM_ROWS) : [];
  const apart = !!u && u.behind.length > 0 && u.ahead > 0;
  const total = above.length + rows.length;
  const tag = (text: string, tip: string) => `<span class="ref" title="${esc(tip)}">${esc(text)}</span>`;
  const upTag = (c: ViewCommit) => (u && c.sha == u.head ? tag(u.name, `${u.name}, the upstream, is at this commit`) : "");
  const row = (c: ViewCommit, n: number, kind: string, tip: string, tags: string, cell: string, cut: "above" | "below" | "") =>
    `<div class="row ${kind}" data-sha="${esc(c.sha)}"><span class="rail${n && cut != "above" ? " up" : ""}${n < total - 1 && cut != "below" ? " down" : ""} ${kind}" title="${esc(tip)}"><i class="dot ${kind}"></i></span><span class="subj" title="${esc(c.subject)}">${tags}${esc(c.subject)}</span><span class="who">${esc(c.author ?? "")}</span><code class="sha">${esc(sha7(c.sha))}</code><time>${esc(timeAgo(c.at, now))}</time>${cell}</div>`;
  const upstream = above
    .map((c, i) =>
      row(
        c,
        i,
        "off",
        `On ${u!.name}, not on ${v.branch} yet`,
        upTag(c),
        `<span class="deps" title="${esc(`Not on ${v.branch}, the branch that ${v.host} tracks`)}"></span>`,
        apart && i == above.length - 1 ? "below" : ""
      )
    )
    .join("");
  const more =
    u && u.behind.length > above.length
      ? `<div class="more">${esc(`and ${plural(u.behind.length - above.length, "more commit")} of ${u.name}`)}</div>`
      : "";
  // The newest commit that takes a deploy: the head, or the first one under it that GitHub has a release of.
  const first = rows.findIndex((c) => !c.release || c.release == "released");
  const body = rows
    .map((c, i) => {
      const kind = on >= 0 && i >= on ? "on" : "off";
      // Its own deploy stays "Deploying…" until the job ends, even when the instance answers the new commit before.
      const deploying = v.deploying.some((d) => d.slice(0, 12) == c.sha.slice(0, 12));
      const at = deployedAt(v.jobs, c.sha);
      const live = !!v.runs && c.sha.startsWith(v.runs);
      const cell =
        !live || deploying
          ? c.release && c.release != "released" && !deploying
            ? noRelease(c)
            : deployButton(v, c, deploying, i == first)
          : liveCell(v, at ? short(at, now) : "");
      const tip = kind == "on" ? `Live on ${v.host}` : `On ${v.branch}, not on ${v.host} yet`;
      const tags = (u && i == 0 ? tag(v.branch, `${v.branch}, the branch that ${v.host} tracks, is at this commit`) : "") + upTag(c);
      return row(c, above.length + i, kind, tip, tags, cell, apart && i == 0 ? "above" : "");
    })
    .join("");
  return `${note}<section class="commits" aria-label="Commits">${head}<div class="grid" style="--cols: 1">${upstream}${more}${body}</div>
    <div class="confirm" id="deploy-confirm" popover><p data-s="ask"></p><p class="soft" data-s="note"></p><div class="acts"><button class="btn" type="button" data-go>Deploy</button><button class="btn quiet" type="button" popovertarget="deploy-confirm" popovertargetaction="hide">Cancel</button></div><p class="err" role="alert"></p></div>
  </section>`;
}

/** The tabs of an instance, by their name in its address. */
const TABS: Record<string, string> = { deploys: "Deploys", logs: "Logs", history: "History" };

/** The instance: its name, what it tracks, its tabs, its job line, and the tab `wanted` (else Deploys). `id`: the job whose log Logs shows. */
export function instanceHtml(v: InstanceView, wanted: string, id: string, now = Date.now()): string {
  const tab = TABS[wanted] ? wanted : "deploys";
  const tabs = `<nav class="tabs" role="tablist">${Object.entries(TABS)
    .map(([k, t]) => `<a class="tab" role="tab" href="${esc(v.href(k))}" aria-selected="${k == tab}">${t}</a>`)
    .join("")}</nav>`;
  const body = tab == "logs" ? logs(v, id, now) : tab == "history" ? history(v, now) : (v.top ?? "") + commits(v, now) + (v.bottom ?? "");
  const failed = v.failed ? `<p class="note bad failed">${esc(v.failed)}</p>` : "";
  const title = v.heading === false ? "" : `<h2 class="title">${esc(v.host)}</h2>`;
  return `<section class="main" data-host="${esc(v.host)}" data-tab="${tab}">${title}<p class="tracks-line">Tracks <code>${esc(v.repo)}</code> <code>${esc(v.branch)}</code>.${v.tracksMore ?? ""}</p>${tabs}${jobLine(v, now)}${failed}<div class="tab-body">${body}</div></section>`;
}
