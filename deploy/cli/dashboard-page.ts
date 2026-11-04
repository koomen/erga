// The dashboard's page (`bun erga dashboard`, deploy/cli/dashboard.ts): the old Ops page of the control Worker
// (its page and script at commit 7f0db52e), with the same markup and look, drawn from
// what `bun erga` reads (State, deploy/cli/flow.ts). Pure: a State in, HTML out.
//
// Status: one card for each server (its release, its health, its branch's last run, Log and Retry), and GitHub's.
// Git Repository: how to clone and push, Merge staging into main and Cut release, the feature branches (Merge,
// Delete), then the log: staging's commits that main does not have (a hollow orange dot), then main's (a green
// dot), with a column for each server: "live" beside the commit it runs, and its last run beside that run's commit.

import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo";
import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import { type Branch, type Commit, nextVersion, type Run, type State } from "./flow";

type Server = State["servers"][number];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
/** "just now", "5m ago", "yesterday", then the date: the old page's times. */
export function ago(t: number | undefined, now: number): string {
  if (!t) return "";
  const s = (t - now) / 1000;
  if (s > -60) return "just now";
  if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
  if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
  if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}
/** "now", "5m", "2h", "3d": a deploy's time in its column. */
const short = (t: number, now: number) => {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
};
const label = (name: string) => name[0].toUpperCase() + name.slice(1);
const sha7 = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);
/** A run's id, from its address (…/actions/runs/<id>). */
export const runId = (r: Run | null) => (r ? (/\/runs\/(\d+)/.exec(r.url)?.[1] ?? "") : "");
/** A run's state, in the old page's words. */
function runState(r: Run): "deploying" | "deployed" | "failed" | "cancelled" {
  if (r.status != "completed") return "deploying";
  if (r.conclusion == "success") return "deployed";
  return r.conclusion == "cancelled" ? "cancelled" : "failed";
}
/** Whether a server runs `sha` (its version is the commit's first 12 characters). */
const runs = (v: Server, sha: string) => !!v.version && sha.startsWith(v.version);

/** A server's state: its card's class and words. */
function serverState(v: Server, now: number): { cls: string; what: string; tip: string } {
  const r = v.run;
  const when = r ? " · " + ago(r.at, now) : "";
  if (r && runState(r) == "deploying") return { cls: "deploying", what: "deploying " + sha7(r.sha) + when, tip: r.status };
  if (r && runState(r) == "failed")
    return { cls: "failed", what: "deploy of " + sha7(r.sha) + " failed" + when, tip: "The run ended with " + r.conclusion + "." };
  if (v.healthy == null) return { cls: "", what: "no answer", tip: "https://" + v.host + " did not answer." };
  if (!v.healthy) return { cls: "failed", what: "unhealthy", tip: "GET /api/health did not answer ok." };
  return {
    cls: "deployed",
    what: "live" + (v.current ? "" : " · not " + v.branch + "'s head") + when,
    tip: "It runs " + (v.version ?? "?") + (v.current ? ", the head of " + v.branch + "." : ". " + v.branch + " has newer commits."),
  };
}

function envCard(v: Server, now: number): string {
  const st = serverState(v, now);
  const id = runId(v.run);
  const retry =
    st.cls == "failed" && id
      ? `<button class="env-retry" type="button" data-act="rerun" data-run="${id}" title="Runs the failed jobs of this run again">Retry</button>`
      : "";
  const log = id ? `<button class="env-log" type="button" data-log="${id}" data-server="${esc(v.name)}">Log</button>` : "";
  return `<div class="env ${st.cls}" id="env-${esc(v.name)}"><div class="env-top"><b>${esc(label(v.name))}</b><a class="host" href="https://${esc(v.host)}" target="_blank" rel="noopener">${esc(v.host)}</a></div><span class="st" title="${esc(st.tip)}"><i></i><span>${esc(st.what)}</span></span><span class="env-more"><code class="env-commit">${esc(sha7(v.version))}</code>${retry}${log}</span></div>`;
}

function githubCard(s: State): string {
  const repo = esc(s.repo);
  return `<div class="env deployed" id="env-github"><div class="env-top"><b>GitHub</b><a class="host" href="https://github.com/${repo}" target="_blank" rel="noopener">${repo}</a></div><span class="st"><i></i><span>main ${esc(sha7(s.heads.main))} · staging ${esc(sha7(s.heads.staging))}</span></span><span class="env-more"><span class="env-commit">read ${esc(ago(s.at, s.at))}</span><a class="env-log" href="https://github.com/${repo}/actions" target="_blank" rel="noopener">Actions</a></span></div>`;
}

function status(s: State, now: number): string {
  return `<section class="ops-section" id="status" aria-labelledby="status-head">
    <h2 id="status-head">Status</h2>
    <h3>Environments</h3>
    <div class="envs">${s.servers.map((v) => envCard(v, now)).join("")}</div>
    <h3>GitHub</h3>
    <div class="services">${githubCard(s)}</div>
  </section>`;
}

function featureState(b: Branch): string {
  if (b.ahead == 0) return `<span class="f-state merged">On staging already</span>`;
  if (b.conflicts == null) return `<span class="f-state">Not checked</span>`;
  if (b.conflicts.length) {
    const files = b.conflicts.join(", ");
    return `<span class="f-state conflicts" title="${esc(files)}">Conflicts in ${plural(b.conflicts.length, "file")}: ${esc(files)}</span>`;
  }
  return `<span class="f-state clean">Merges cleanly</span>`;
}

function feature(b: Branch, now: number): string {
  const clean = b.ahead > 0 && !!b.conflicts && !b.conflicts.length;
  const name = esc(b.name);
  return `<li class="feature" data-branch="${name}">
      <div class="f-top"><code class="f-name">${name}</code><span class="f-count">${plural(b.ahead, "commit")} ahead · ${b.behind} behind staging</span>${featureState(b)}</div>
      <div class="f-last"><span class="f-subject">${esc(b.subject)}</span>${b.author ? ` · ${esc(b.author)}` : ""} · <span class="f-time">${esc(timeAgo(b.at, now))}</span> · <code>${esc(sha7(b.sha))}</code></div>
      <div class="f-actions"><button class="pill" type="button" data-act="check" title="Reads the branches again, and checks each merge again">Check again</button><button class="new" type="button" data-act="merge-open" data-branch="${name}" data-message="${esc(b.ahead == 1 ? b.subject : "")}"${clean ? "" : " disabled"}>Merge</button><button class="pill" type="button" data-act="delete" data-branch="${name}" title="Deletes the branch on GitHub">Delete</button></div>
    </li>`;
}

/** The log's deploy columns, as the old page had them: staging's server first, then main's. */
const columns = (s: State) => [...s.servers.filter((v) => v.branch == "staging"), ...s.servers.filter((v) => v.branch != "staging")];

type Row = (Commit & { tag?: string }) & { kind: "staging-only" | "on-main" };

function deployCell(v: Server, c: Row, now: number): string {
  const r = v.run && v.run.sha == c.sha ? v.run : null;
  const live = runs(v, c.sha);
  if (!r && !live) return "";
  const state = r ? runState(r) : "deployed";
  const word = live ? "live" : state;
  const tip =
    (live ? "Live on " + v.host + ". " : "") +
    (r ? "Its run: " + (r.conclusion || r.status) + " · " + sha7(r.sha) + "\nClick for its log." : "");
  const at = r ? short(r.at, now) : "";
  const cls = `dep ${state}${live ? " live" : ""}`;
  const inner = `<span class="w">${esc(word)}</span><span class="at">${esc(at)}</span>`;
  return r
    ? `<button class="${cls}" type="button" data-log="${runId(r)}" data-server="${esc(v.name)}" title="${esc(tip)}">${inner}</button>`
    : `<span class="${cls}" title="${esc(tip)}">${inner}</span>`;
}

function row(c: Row, i: number, last: boolean, s: State, now: number): string {
  const kind = c.kind == "on-main" ? "on main" : "only on staging";
  const rel = c.tag
    ? `<span class="rel" title="Release ${esc(c.tag)}">${esc(c.tag)}${c.tag == s.latestRelease ? ' <span class="chan">latest</span>' : ""}</span>`
    : "";
  const when = c.at ? new Date(c.at) : null;
  const tip = `${c.subject}\n${c.sha.slice(0, 10)}${c.author ? " · " + c.author : ""}${when ? " · " + when.toLocaleString("en") : ""} · ${kind}`;
  return `<div data-sha="${esc(c.sha)}" class="row ${c.kind}"><span class="rail${i ? " up" : ""}${last ? "" : " down"} ${c.kind}"><i class="dot ${c.kind}" title="${kind[0].toUpperCase() + kind.slice(1)}"></i></span><span class="subj" title="${esc(tip)}"><span>${esc(c.subject)}</span>${rel}</span><span class="who">${esc(c.author ?? "")}</span><code class="sha">${esc(sha7(c.sha))}</code><time${when ? ` datetime="${when.toISOString()}"` : ""}>${esc(ago(c.at, now))}</time>${columns(
    s
  )
    .map((v) => `<span class="deps" data-target="${esc(v.name)}">${deployCell(v, c, now)}</span>`)
    .join("")}</div>`;
}

/** The log's rows: staging's own commits (a break in the middle when there are 17 or more), then main's. */
function logRows(s: State, now: number): string {
  const own: Row[] = s.waiting.map((c) => ({ ...c, kind: "staging-only" }));
  const main: Row[] = s.log.map((c) => ({ ...c, kind: "on-main" }));
  const cut = own.length >= 17;
  const all = cut ? [...own.slice(0, 11), ...own.slice(-5), ...main] : [...own, ...main];
  if (!all.length) return `<div class="none">No commits yet.</div>`;
  const out = all.map((c, i) => row(c, i, i == all.length - 1, s, now));
  if (cut)
    out.splice(
      11,
      0,
      `<div class="gap"><span class="rail"></span><span class="gap-text">… ${own.length - 16} more commits only on staging …</span></div>`
    );
  return out.join("");
}

function target(v: Server, now: number): string {
  const st = serverState(v, now);
  const id = runId(v.run);
  return `<div class="head deploy"><button class="target ${st.cls}" type="button" data-log="${id}" data-server="${esc(v.name)}"${id ? "" : " disabled"} title="${esc(v.host + ": " + st.what + ". Click for the last run's log.")}"><b>${esc(v.name)}</b><span class="host">${esc(v.host)}</span><span class="st"><i></i><span>${esc(st.what.replace(/^deploy of \w+ /, ""))}</span></span></button></div>`;
}

function repo(s: State, now: number): string {
  const repoName = esc(s.repo);
  const ahead = s.waiting.length;
  const copy = `git clone https://github.com/${s.repo}.git\nbun erga start <branch>\ngit push origin HEAD:<branch>`;
  const tagged = !!s.log[0]?.tag;
  const next = nextVersion(s.latestRelease, "patch");
  const version = "version" in next ? next.version : "";
  return `<section class="ops-section" id="repo" aria-labelledby="repo-head">
  <div class="pane-head"><div class="head-title"><h2 id="repo-head">Git Repository</h2></div></div>
  <p class="repo-note">Erga's source repository is on GitHub: <a href="https://github.com/${repoName}" target="_blank" rel="noopener">${repoName}</a>. Only <code>bun erga</code> moves staging and main.</p>
  <div class="repo-tools">
  <div class="box clone" id="clone">
    <h2>Clone and push<button class="pill" type="button" id="clone-copy" data-copy="${esc(copy)}" title="Copies the three commands">Copy</button></h2>
    <pre><code>${esc(copy)}</code></pre>
    <ul class="facts"><li>A feature branch never deploys. Merge puts it on staging as one commit.</li><li>main only follows staging. Merge it here.</li></ul>
  </div>
  <div class="box actions"><h2>Branches and releases</h2>
    <p class="state"><span id="ahead">${ahead ? `staging is ${plural(ahead, "commit")} ahead of production` : "staging and production are the same"}</span><span id="release-state">${s.latestRelease ? "Latest release: " + esc(s.latestRelease) : "No release yet"}</span></p>
    <div class="repo-buttons"><button class="new" id="merge" type="button" data-act="promote-open" data-head="${esc(sha7(s.heads.staging))}" data-count="${ahead}"${ahead ? "" : " disabled"} title="${ahead ? "Moves main to staging's head: production deploys it." : "Nothing to merge: main is at staging's head."}">Merge staging into main</button><button class="pill" id="release-pill" type="button" data-act="release-open" data-version="${esc(version)}" data-head="${esc(sha7(s.heads.main))}"${tagged || !s.log.length ? " disabled" : ""} title="${tagged ? "main's head has a release already." : "A version tag on main's head, and a GitHub release."}">Cut release</button></div>
  </div>
  </div>
  <section class="box features" id="features" aria-labelledby="features-head">
    <h2 id="features-head">Feature branches</h2>
    <p class="features-note">Larger work goes on a branch of its own: <code>git push origin HEAD:&lt;name&gt;</code>. A feature branch never deploys. Merge puts all its changes on staging as one commit.</p>
    <ul class="feature-list" id="feature-list">${s.branches.length ? s.branches.map((b) => feature(b, now)).join("") : `<li class="feature-none">No feature branches. Push one: <code>git push origin HEAD:&lt;name&gt;</code>.</li>`}</ul>
  </section>
  <section class="card" aria-label="Commits">
    <div class="legend"><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main too</span></div>
    <div class="grid" id="grid" style="--deploys: ${s.servers.length}">
      <div class="head"></div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head sha-h"></div><div class="head time-h"></div>
      ${columns(s)
        .map((v) => target(v, now))
        .join("")}
      ${logRows(s, now)}
    </div>
  </section>
  </section>`;
}

/** The part of the page that each read draws again: Status and Git Repository. */
export function liveHtml(s: State | { error: string } | null, now = Date.now()): string {
  if (!s)
    return `<section class="ops-section"><h2 id="status-head">Status</h2><p class="repo-note">Reading GitHub and the servers…</p></section>`;
  if ("error" in s)
    return `<section class="ops-section"><h2 id="status-head">Status</h2><p class="repo-note error">${esc(s.error)}</p></section>`;
  return status(s, now) + repo(s, now);
}

const DIALOGS = `
  <dialog id="feature-dlg" aria-labelledby="feature-title">
    <h2 id="feature-title">Merge <code id="feature-name"></code> into staging</h2>
    <p>All of the branch's changes become one commit on staging, and staging deploys it. Then the branch is deleted. The tests run on the merged commit first.</p>
    <label>Commit message<textarea id="feature-message" spellcheck="true" placeholder="Empty: the branch's commit messages"></textarea></label>
    <div class="buttons"><span id="feature-status" role="status" aria-live="polite"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" id="feature-go">Merge</button></div>
  </dialog>
  <dialog id="promote-dlg" aria-labelledby="promote-title">
    <h2 id="promote-title">Merge staging into main</h2>
    <p>main moves to staging's head <code id="promote-head"></code> (<span id="promote-count"></span>), and production deploys it. It stops when staging's own run failed, or staging does not run its head.</p>
    <div class="buttons"><span role="status"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" id="promote-go">Merge</button></div>
  </dialog>
  <dialog id="release-dlg" aria-labelledby="release-title">
    <h2 id="release-title">Cut a release</h2>
    <p>A release is a version tag on main's head: <code id="release-head"></code>. GitHub makes a release with notes from the commits since the last tag.</p>
    <label>Version<input id="release-version" autocomplete="off" spellcheck="false"></label>
    <div class="buttons"><span id="release-status" role="status" aria-live="polite"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" id="release-go">Cut release</button></div>
  </dialog>
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill rollback" type="button" id="log-rollback" hidden>Roll back</button><button class="pill close" type="button" data-close autofocus>Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>`;

/** The whole page: the bars, the live part, the dialogs, and the page's script with this run's token. */
export function pageHtml(o: { token: string; live: string; script: string }): string {
  return `<!doctype html><html lang="en" class="page-light page-white"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="erga-token" content="${esc(o.token)}">
<title>Ops · Erga</title>${FAVICON_LINK}
<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/bars.css"><link rel="stylesheet" href="/dashboard.css">
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");function t(){var d=m.matches,c=document.documentElement.classList;c.toggle("page-dark",d);c.toggle("page-light",!d);c.toggle("page-white",!d)}t();m.addEventListener("change",t)})()</script>
</head><body>
<nav class="erga-crumbs erga-bar erga-bar-l" aria-label="Breadcrumbs"><a class="erga-brand" href="/"><span>${WORDMARK}</span></a><h1 class="erga-here" aria-current="page"><span>Ops</span></h1></nav>
<div class="admin-body"><main class="admin-main wide" id="admin-panes">
  <div class="panes"><section class="pane" id="source-pane" aria-label="Ops"><div id="live">${o.live}</div>${DIALOGS}
  </section></div>
</main></div>
<script>${o.script}</script>
</body></html>`;
}
