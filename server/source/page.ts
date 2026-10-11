// The Source page, /admin/source, for admins with admin
// access: the one place to manage Erga's own source and its deploys. It has
// the layout every admin page shares: the breadcrumb, Share
// with agent, the admin's agent and the sidebar. /source, /admin/factory and
// /admin/deploys redirect here.
//
// The dashboard:
//
// One list: staging's history, newest first (staging is always at or ahead
// of main, so it holds every commit main has). When staging is far ahead, a
// break ("… N more commits only on staging …") leaves commits out: above it,
// staging's head and the 10 before it; below it, the 5 commits just after
// main's head, then main's head and the 5 before it. The break shows only
// when it leaves at least one commit out (17 or more ahead). Beside it, one dot column,
// with no header: every commit listed is on staging; a solid green circle is
// on main too, a hollow orange circle only on staging. Then two deploy
// columns, staging and production: each target's deploys (GET
// /api/deploys?history=100), one beside each commit it deployed: its state
// as plain text (live, deployed, failed, cancelled, or running) and when.
// A commit deployed more than once shows one deploy: the running one, else
// the live one, else the newest (a redeploy cancels the attempt before it).
// Only the live deploy has a background. Each target's status is in its column's head. Any deploy opens
// its log, past or live (GET /api/deploys/<name>/log?deploy=<id>, then
// { type: "deploy-log" } events). Merge moves main forward to staging's
// head, or to the commit a row's "Merge to here" names. Also how to clone and
// push, and the GitHub mirror's status (beside Merge; a click opens a dialog:
// the mirror's state and Push now, or how to turn it on). It updates by
// itself (/api/events) and follows the system's light or dark.

import { esc, page as plainPage, type Session } from "../routes";
import { adminResponse } from "../admin/layout";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  origin: string;
  mirrorUrl: string;
  /** This server's Worker, for the GitHub mirror's setup steps; null when it isn't one of Erga's targets. */
  worker: string | null;
}

const SOURCE_STYLE = `
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; }
  .pane-head { justify-content: space-between; }
  .head-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .head-actions:not(:has(> :not([hidden]))) { display: none; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  .merge-row[hidden], #merge-hint:empty { display: none; }
  #merge-hint { margin: -4px 0 10px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  @media (max-width: 640px) { .pane-head { flex-direction: column; align-items: stretch; gap: 10px; } .merge-row { justify-content: space-between; } .merge-row .count { white-space: normal; flex: 1; min-width: 0; } #merge-hint { margin-top: -6px; text-align: left; } }
  .card { padding: 0 0 10px; min-width: 0; background: var(--bg); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 4px 6px; font-size: 12px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  /* The dots: circles only. Hollow orange, only on staging; solid green, on main. */
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; flex: none; }
  .dot.staging-only { background: var(--bg); border: 2px solid var(--only-staging); }
  .dot.on-main { background: var(--on-main); border: 2px solid var(--on-main); }
  .grid { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto 100px 132px 132px; align-items: center; }
  .grid > .head { position: sticky; top: 0; z-index: 2; background: var(--bg); height: 44px; display: flex; align-items: flex-end; padding-bottom: 6px; box-sizing: border-box; border-bottom: 1px solid var(--rule);
    font-size: 11.5px; font-weight: 600; letter-spacing: .02em; color: var(--soft); white-space: nowrap; }
  .grid > .head.deploy { justify-content: flex-start; padding-left: 2px; }
  .target { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 144px; border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .target:hover { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .target b { font-weight: 650; color: var(--fg-strong); font-size: 11.5px; }
  .target .st { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; font-size: 11.5px; }
  .target .st i { width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); }
  .target.deployed .st i { background: var(--on-main); }
  .target.failed .st { color: var(--bad); }
  .target.failed .st i { background: var(--bad); }
  .target.cancelled .st i { background: transparent; border: 1.5px dashed var(--chrome); width: 4px; height: 4px; }
  .target.building .st i, .target.deploying .st i { background: transparent; border: 2px solid var(--only-staging); border-right-color: transparent; width: 5px; height: 5px; animation: spin .8s linear infinite; }
  .target[disabled] { cursor: default; }
  .target[disabled]:hover { background: transparent; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .row { display: contents; }
  .row > * { height: var(--row); display: flex; align-items: center; transition: background-color .15s; }
  .row:hover > * { background: color-mix(in srgb, var(--chrome) 8%, transparent); }
  .rail { position: relative; justify-content: center; }
  .rail::before, .rail::after { content: ""; position: absolute; left: calc(50% - 1px); width: 2px; height: 50%; display: none; opacity: .4; }
  .rail::before { top: 0; } .rail::after { bottom: 0; }
  .rail::before, .rail::after { background: var(--only-staging); }
  .rail.on-main::before, .rail.on-main::after { background: var(--on-main); }
  .rail.up::before, .rail.down::after { display: block; }
  .rail .dot { position: relative; z-index: 1; }
  .subj { min-width: 0; padding: 0 8px 0 6px; gap: 8px; }
  .subj span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--fg-strong); }
  .row.on-main .subj span { color: var(--fg); }
  .subj .here { flex: none; display: none; height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); cursor: pointer; }
  .row.staging-only:hover .subj .here, .subj .here:focus-visible { display: inline-flex; align-items: center; }
  .who { padding: 0 8px; font-size: 12px; color: var(--soft); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sha { padding: 0 6px; font: 11.5px var(--font-mono); color: var(--chrome); }
  .row time { margin: 0; justify-content: flex-end; padding-right: 8px; font-size: 12px; color: var(--soft); }
  /* A deploy, beside the commit it deployed: its state as plain text, then when. Colour only where it says something:
     muted for deployed, red for failed, orange with a turning dot while it runs, struck through for cancelled.
     Only the live one has a background: a low-contrast rounded rectangle. */
  .deps { min-width: 0; padding: 0 6px 0 2px; }
  .dep { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 22px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent;
    color: var(--soft); font: 500 12px var(--font-text); text-align: left; white-space: nowrap; cursor: pointer; }
  .dep:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .dep:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .dep .w { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .dep .at { font-size: 11.5px; color: var(--chrome); font-variant-numeric: tabular-nums; }
  .dep.live { background: color-mix(in srgb, var(--on-main) 11%, transparent); color: var(--on-main); font-weight: 600; }
  .dep.live:hover { background: color-mix(in srgb, var(--on-main) 16%, transparent); }
  .dep.live .at { color: color-mix(in srgb, var(--on-main) 70%, var(--soft)); }
  .dep.failed .w { color: var(--bad); }
  .dep.cancelled .w { color: var(--chrome); text-decoration: line-through; text-decoration-thickness: 1px; }
  .dep.building .w, .dep.deploying .w { color: var(--only-staging); }
  .dep.building .w::before, .dep.deploying .w::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--only-staging); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  #mirror-pill { height: 28px; font-size: 12.5px; padding: 0 10px; }
  #mirror-pill.off { color: var(--bad); }
  #mirror-pill[hidden] { display: none; }
  /* The break, when staging is far ahead of main: a dashed rail and how many commits it leaves out. */
  .gap { display: contents; }
  .gap > * { height: var(--row); display: flex; align-items: center; }
  .gap .rail::before { content: ""; position: absolute; left: calc(50% - 1px); top: 0; bottom: 0; width: 0; height: auto; display: block; border-left: 2px dashed var(--only-staging); background: none; opacity: .5; }
  .gap .gap-text { grid-column: 2 / -1; padding: 0 6px; font: 12.5px var(--font-text); color: var(--soft); border-block: 1px dashed var(--rule); box-sizing: border-box; }
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); grid-column: 1 / -1; }
  @media (max-width: 760px) { .grid { grid-template-columns: 22px minmax(0, 1fr) auto 80px 80px; } .who, .grid > .head.who-h, .row time, .grid > .head.time-h { display: none; } .target { max-width: 82px; } .target b { font-size: 10.5px; } .target .st span { display: none; }
    .dep { font-size: 11.5px; padding: 0 5px; } .dep .at { display: none; } }
  .boxes { display: grid; grid-template-columns: 1fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 760px) { .boxes { grid-template-columns: 1fr; } }
  .box { border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .box h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .box h2 .pill { margin-left: auto; height: 28px; font-size: 12.5px; padding: 0 10px; }
  .box p { margin: 0 0 6px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  .box p.error { color: var(--bad); }
  .box a { color: inherit; }
  pre { margin: 6px 0 8px; padding: 10px 12px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
  .setup ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: var(--fg); }
  .setup li { margin: 4px 0; }
  .setup code, .box code { font: 12.5px var(--font-mono); }
  dialog#deploy-log { width: min(820px, calc(100vw - 32px)); padding: 0; }
  #deploy-log .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
  #deploy-log h2 { margin: 0; font-size: 15px; }
  #deploy-log .meta { font-size: 12.5px; color: var(--soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #deploy-log .meta b { font-weight: 600; }
  #deploy-log .meta .live-on { color: var(--on-main); }
  #deploy-log .meta .bad { color: var(--bad); }
  #deploy-log .close { margin-left: auto; height: 30px; }
  #deploy-log pre { margin: 0; border-radius: 0 0 12px 12px; height: min(60vh, 520px); overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  #deploy-log pre .t { color: var(--chrome); }
  #deploy-log pre .s { color: var(--soft); }
`;

/** The source pane: the commits with their deploys, Merge, how to clone; or how to set it up. */
function sourceMarkup(c: SourcePageConfig): string {
  if (!c.ready) {
    return `<div class="pane-head"><h2>git log</h2></div>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. The steps:</p>
  <ol><li>Make the Artifacts repo <code>erga</code> in the namespace <code>erga</code>.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`;
  }
  const remote = `${c.origin}/git/erga.git`;
  const target = (name: string, label: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Deploys aren't set up yet"><b>${label}</b><span class="st"><i></i><span>not set up</span></span></button></div>`;
  return `
  <div class="pane-head">
    <div class="head-title"><h2>git log</h2></div>
    <div class="head-actions"><button class="pill" id="mirror-pill" type="button" hidden>GitHub</button><div class="merge-row" id="merge-row" hidden><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div></div>
  </div>
  <p class="hint" id="merge-hint" role="status"></p>
  <section class="card" aria-label="Commits">
    <div class="legend"><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main too</span></div>
    <div class="grid" id="grid">
      <div class="head"></div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head"></div><div class="head time-h"></div>
      ${target("staging", "staging")}${target("production", "production")}
      <div class="none" id="loading">Loading…</div>
    </div>
  </section>
  <section class="boxes">
    <div class="box" id="clone">
      <h2>Clone and push</h2>
      <pre><code>git remote add erga ${esc(remote)}
git fetch erga
git push erga HEAD:staging</code></pre>
      <p>Git asks for a username and password: any username, and an agent token from <a href="/settings">Settings</a> as the password (admins only). main only follows staging: merge here, or push one of staging's commits to main.</p>
    </div>
  </section>
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
`;
}

const SOURCE_SCRIPT = `
(() => {
  // The admin pages are one page: what keeps running stops when another admin page is shown.
  const pageView = window.ergaView;
  const setInterval = (f, ms) => { const t = window.setInterval(f, ms); pageView.onLeave(() => clearInterval(t)); return t; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
  const ago = (t) => {
    if (!t) return "";
    const s = (t - Date.now()) / 1000;
    if (s > -60) return "just now";
    if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
    if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
    if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const TARGETS = ["staging", "production"];
  /** When staging is far ahead of main: how many of its newest commits show above the break, and how many of main's below it. */
  const GAP_TOP = 11, GAP_MAIN = 6;
  let view = null, deploys = null, busy = false, drawn = false;
  const grid = document.getElementById("grid");
  const running = (state) => state == "building" || state == "deploying";
  const short = (t) => {
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    if (s < 30 * 86400) return Math.round(s / 86400) + "d";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const took = (r) => { const ms = (r.ended ?? Date.now()) - r.started; return ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; };
  const targetOf = (name) => deploys?.targets?.find((t) => t.name == name) ?? null;
  /** A target's deploys by commit, newest first. */
  function byCommit(name) {
    const m = new Map();
    for (const r of targetOf(name)?.history ?? []) { if (!m.has(r.commit)) m.set(r.commit, []); m.get(r.commit).push(r); }
    return m;
  }
  /** The one deploy a commit shows in a target's column: the running one, else the live one, else the newest. */
  function shown(list) {
    if (running(list[0].state)) return list[0];
    return list.find((r) => r.live) ?? list[0];
  }
  const WORD = { building: "building", deploying: "deploying", deployed: "deployed", failed: "failed", cancelled: "cancelled" };
  function badge(name, r) {
    const t = targetOf(name);
    const tip = (r.live ? "Live on " + (t?.host ?? name) + ". " : "") + r.state[0].toUpperCase() + r.state.slice(1) + " · " + r.commit.slice(0, 7) + " · " + r.trigger + "\\n" +
      "Started " + new Date(r.started).toLocaleString() + (r.ended ? ", took " + took(r) : ", running for " + took(r)) + (r.error ? "\\n" + r.error : "") + "\\nClick for its log.";
    return '<button class="dep ' + esc(r.state) + (r.live ? " live" : "") + '" type="button" data-target="' + name + '" data-deploy="' + esc(r.id) + '" title="' + esc(tip) + '">' +
      '<span class="w">' + esc(r.live ? "live" : WORD[r.state] || r.state) + '</span><span class="at">' + short(r.started) + "</span></button>";
  }
  /** What a target shows on a commit's row: one deploy, or nothing. */
  function deployCell(name, sha, groups) {
    const list = groups.get(sha);
    if (list) return badge(name, shown(list));
    // A server without the history: whether the commit is live, as before.
    const t = targetOf(name);
    if (t && !t.history && (t.deployed ?? (t.state == "deployed" ? t.commit : null)) == sha) return '<span class="dep live" title="Live on ' + esc(t.host) + '"><span class="w">live</span><span class="at"></span></span>';
    return "";
  }

  function render() {
    if (!view) return;
    const staging = view.branches.find((b) => b.name == "staging"), main = view.branches.find((b) => b.name == "main");
    // Staging far ahead of main: its head and the GAP_TOP - 1 commits before it, a break that counts the commits left out,
    // the commits just after main's head (afterMain), then main's head and the GAP_MAIN - 1 behind it, so the list shows
    // where production is. The break only when commits are left out; else staging's log, as always.
    const recent = staging?.commits ?? [], ahead = staging?.ahead ?? 0, after = staging?.afterMain ?? [];
    const only = recent.filter((x) => !x.inMain), top = only.slice(0, GAP_TOP);
    const hidden = Math.max(0, ahead - top.length - after.length);
    const commits = hidden && after.length ? [...top, ...after.map((x) => ({ ...x, inMain: false })), ...(main?.commits ?? []).slice(0, GAP_MAIN).map((x) => ({ ...x, inMain: true }))] : recent;
    document.getElementById("loading")?.remove();
    const groups = Object.fromEntries(TARGETS.map((n) => [n, byCommit(n)]));
    // One row per commit, kept: a new commit fades in at the top, the oldest goes at the bottom.
    const rows = new Map([...grid.querySelectorAll(".row")].map((r) => [r.dataset.sha, r]));
    const want = new Set(commits.map((x) => x.sha));
    for (const [sha, r] of rows) if (!want.has(sha)) r.remove();
    grid.querySelector(".none.empty")?.remove();
    grid.querySelector(".gap")?.remove();
    if (!commits.length) { grid.insertAdjacentHTML("beforeend", '<div class="none empty">No commits yet. Push one: git push erga HEAD:staging</div>'); }
    let prev = null;
    commits.forEach((x, i) => {
      let r = rows.get(x.sha);
      if (!r) { r = document.createElement("div"); r.dataset.sha = x.sha; }
      const kind = x.inMain ? "on-main" : "staging-only";
      const next = commits[i + 1];
      r.className = "row " + kind;
      const up = i > 0, down = !!next || x.parents.length > 0, gapAfter = hidden && after.length && i == top.length - 1;
      const title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + (x.inMain ? " · on main" : " · only on staging");
      const tail = '<span class="who">' + esc(x.author) + '</span><code class="sha">' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + "</time>";
      r.innerHTML =
        '<span class="rail ' + (up ? "up " : "") + (down ? "down " : "") + (x.inMain ? "on-main" : "") + '"><i class="dot ' + kind + '" title="' + (x.inMain ? "On main (and staging)" : "Only on staging") + '"></i></span>' +
        '<span class="subj" title="' + esc(title) + '"><span>' + esc(x.subject) + "</span>" + (x.inMain ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit: production deploys it">Merge to here</button>') + "</span>" + tail +
        TARGETS.map((n) => '<span class="deps" data-target="' + n + '">' + deployCell(n, x.sha, groups[n]) + "</span>").join("");
      grid.insertBefore(r, prev ? prev.nextSibling : document.getElementById("target-production").parentElement.nextSibling);
      prev = r;
      if (gapAfter) {
        const g = document.createElement("div");
        g.className = "gap";
        const n = hidden.toLocaleString() + " more commit" + (hidden == 1 ? "" : "s");
        g.innerHTML = '<span class="rail"></span><span class="gap-text" title="' + n + ' only on staging, not shown. Below: the commit main is at, which production deploys.">… ' + n + " only on staging …</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
    });
    drawn = true;
    const mergeBtn = document.getElementById("merge");
    // Nothing at all while main is at staging: no count, no button, no space. While a merge runs the button stays, disabled.
    if (!busy) document.getElementById("merge-row").hidden = !ahead;
    document.getElementById("ahead").textContent = !staging?.commit ? "" : ahead ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge" : "";
    if (!busy) mergeBtn.disabled = !ahead;
    mergeBtn.title = "Moves main to staging's head: production deploys it.";
    // The GitHub mirror, beside Merge. Its title has the URL and any error; a click opens its dialog.
    const m = view.mirror, mp = document.getElementById("mirror-pill");
    if (mp) {
      mp.hidden = false;
      mp.className = "pill " + (m.state == "off" ? "" : m.state == "pushing" ? "pushing" : m.error ? "off" : "on");
      mp.textContent = "GitHub: " + (m.state == "off" ? "off" : m.state == "pushing" ? "pushing…" : m.error ? "behind" : m.lastPushAt ? "up to date" : "not pushed yet");
      const where = String(m.url || "").includes("/__github/") ? "A pretend GitHub, in the dev server (local development never pushes to the real one)" : String(m.url || "").replace(/^https?:\\/\\//, "").replace(/\\.git$/, "");
      mp.title = (m.state == "off" ? "Off: the server has no GITHUB_MIRROR_TOKEN. Click for how to turn it on." : (m.lastPushAt ? "Last pushed " + ago(m.lastPushAt) + (m.lastPushBy ? ", for " + m.lastPushBy : "") : "Not pushed yet") + (m.error ? ". " + m.error : "") + ". Click to push now.") + (where ? "\\n" + where : "");
      mp.setAttribute("aria-haspopup", "dialog");
      renderMirror(where);
    }
  }
  /** The mirror's dialog: how to turn it on while it's off; its state, any error, and Push now while it's on. */
  function renderMirror(where) {
    const m = view?.mirror, d = document.getElementById("mirror-dlg");
    if (!m || !d) return;
    const off = m.state == "off";
    document.getElementById("mirror-off").hidden = !off;
    document.getElementById("mirror-on").hidden = off;
    const push = document.getElementById("mirror-push");
    push.hidden = off;
    push.disabled = m.state == "pushing";
    push.textContent = m.state == "pushing" ? "Pushing…" : "Push now";
    if (off) return;
    document.getElementById("mirror-state").textContent = "GitHub sync is on. " + (m.state == "pushing" ? "It pushes now." : m.lastPushAt ? "Last pushed " + ago(m.lastPushAt) + (m.lastPushBy ? ", for " + m.lastPushBy : "") + "." : "Not pushed yet.");
    document.getElementById("mirror-where").textContent = where ? "Where: " + where : "";
    const err = document.getElementById("mirror-error");
    err.hidden = !m.error;
    err.textContent = m.error || "";
  }

  function renderTargets() {
    for (const n of TARGETS) {
      const b = document.getElementById("target-" + n), t = targetOf(n);
      b.className = "target " + (t ? t.state : "");
      b.disabled = !t;
      b.title = t ? (t.host + ": " + t.state + (t.deployed ? ", live on " + t.deployed.slice(0, 7) : "") + (t.error ? " (" + t.error + ")" : "") + ". Click for the latest deploy's log.") : "Deploys aren't set up yet";
      const what = !t ? "not set up" : { idle: "idle", building: "building", deploying: "deploying", deployed: "live", failed: "failed", cancelled: "cancelled" }[t.state] || t.state;
      b.querySelector(".st span").textContent = what + (t?.at ? " · " + ago(t.at) : "");
    }
    render();
  }

  async function load() {
    try {
      const r = await fetch("/api/source/branches", { headers: { Accept: "application/json" } });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      if (pageView.signal.aborted) return;
      view = body; render();
    } catch (e) {
      const l = document.getElementById("loading");
      if (l) l.textContent = e.message;
    }
  }
  // Each change is an event, many while a deploy runs: the status and history are asked for at most every half second.
  let asking = null, again = false;
  async function loadDeploys() {
    if (asking) { again = true; return asking; }
    asking = (async () => {
      const r = await fetch("/api/deploys?history=100", { headers: { Accept: "application/json" } }).catch(() => null);
      // No answer, or a 5xx (a server restarting into its new version): keep what's shown, and the poll below asks again.
      const body = r && r.ok ? await r.json().catch(() => null) : null;
      if (pageView.signal.aborted) return;
      if (body || (r && r.status < 500)) deploys = body;
      renderTargets();
      if (open && !open.pinned) { const t = targetOf(open.target); if (t?.deployId && t.deployId != open.deployId) refreshLog(false); }
      await new Promise((ok) => setTimeout(ok, 500));
    })();
    await asking;
    asking = null;
    if (again) { again = false; loadDeploys(); }
  }

  // A deploy's log: the latest one's from a column's head (it follows the next deploy), or any one's from its badge.
  const dlg = document.getElementById("deploy-log"), pre = document.getElementById("log-lines");
  let open = null; // { target, deployId, pinned: a chosen deploy, shown: lines shown, state, heard: when an event last came }
  const line = (l) => '<span class="t">' + esc(new Date(l.at).toLocaleTimeString()) + "</span> " + (l.step ? '<span class="s">[' + esc(l.step) + "]</span> " : "") + esc(l.text) + "\\n";
  function append(lines) {
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.insertAdjacentHTML("beforeend", lines.map(line).join(""));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
  async function openLog(name, deployId) {
    const t = targetOf(name);
    document.getElementById("log-title").textContent = (t?.host ?? name) + " deploy log";
    document.getElementById("log-meta").textContent = "";
    pre.textContent = "Loading…";
    open = { target: name, deployId: deployId ?? null, pinned: !!deployId, shown: 0, state: null, heard: 0 };
    if (!dlg.open) dlg.showModal();
    await refreshLog(true);
  }
  /** The log as the server has it now: what's new since what's shown (or all of it, for another deploy). */
  async function refreshLog(first) {
    if (!open) return;
    const name = open.target, want = open.pinned ? open.deployId : null;
    const r = await fetch("/api/deploys/" + name + "/log" + (want ? "?deploy=" + encodeURIComponent(want) : "")).catch(() => null);
    const log = r && r.ok ? await r.json().catch(() => null) : null;
    if (pageView.signal.aborted) return;
    if (!open || open.target != name) return;
    if (!log || !log.deployId) { if (first) { pre.textContent = r && r.status == 404 ? "This deploy isn't in the history any more." : "No deploy log yet."; } return; }
    const lines = log.lines || [];
    if (first || log.deployId != open.deployId) { pre.textContent = ""; open.shown = 0; }
    open.deployId = log.deployId; open.state = log.state;
    const meta = document.getElementById("log-meta");
    meta.innerHTML = [log.commit ? "<b>" + esc(log.commit.slice(0, 7)) + "</b>" : "",
      log.live ? '<span class="live-on">live</span>' : '<span class="' + (log.state == "failed" ? "bad" : "") + '">' + esc(log.state) + "</span>",
      log.trigger ? esc(log.trigger) : "", log.started ? esc(new Date(log.started).toLocaleString()) + (log.ended ? " · took " + took(log) : "") : ""].filter(Boolean).join(" · ");
    meta.title = log.error || "";
    if (lines.length > open.shown) { append(lines.slice(open.shown)); open.shown = lines.length; }
    if (first) pre.scrollTop = pre.scrollHeight;
  }
  // Live lines come as events only from the server running the deploy (staging's runs on staging's own server):
  // while the deploy shown runs and no events arrive, ask for the log every two seconds.
  setInterval(() => {
    if (!open || !dlg.open) return;
    const t = targetOf(open.target);
    if (!(running(open.state) || (!open.pinned && running(t?.state)))) return;
    if (Date.now() - open.heard < 2500) return;
    refreshLog(false);
  }, 2000);
  for (const n of TARGETS) document.getElementById("target-" + n).addEventListener("click", () => openLog(n));
  document.getElementById("log-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => { open = null; });
  grid.addEventListener("click", (e) => {
    const d = e.target.closest("button[data-deploy]");
    if (d) { openLog(d.dataset.target, d.dataset.deploy); return; }
  });

  const hint = document.getElementById("merge-hint"), mergeBtn = document.getElementById("merge");
  async function merge(commit) {
    busy = true; mergeBtn.disabled = true; hint.className = "hint"; hint.textContent = "Merging…";
    try {
      const r = await fetch("/api/source/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main", ...(commit ? { commit } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The merge failed (HTTP " + r.status + ").");
      hint.textContent = "";
    } catch (e) { hint.className = "hint error"; hint.textContent = e.message; }
    busy = false;
    await load();
  }
  mergeBtn.addEventListener("click", () => merge(null));
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-merge]");
    if (b) return merge(b.dataset.merge);
  });
  const mirrorDlg = document.getElementById("mirror-dlg");
  document.getElementById("mirror-pill")?.addEventListener("click", () => {
    document.getElementById("mirror-status").textContent = "";
    render();
    if (!mirrorDlg.open) mirrorDlg.showModal();
  });
  document.getElementById("mirror-close").addEventListener("click", () => mirrorDlg.close());
  document.getElementById("mirror-push").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    const status = document.getElementById("mirror-status");
    status.textContent = "Pushing…";
    const r = await fetch("/api/source/mirror", { method: "POST" }).catch(() => null);
    const body = r ? await r.json().catch(() => null) : null;
    status.textContent = !r || !r.ok ? (body?.error || "Couldn't push.") : "";
    await load();
  });

  // Live: an event says what changed; a reconnect reloads everything. A stream the server answers with an error
  // (a server restarting into its new version) the browser closes for good: open it again.
  let heard = 0;
  function listen() {
    if (pageView.signal.aborted) return;
    const events = new EventSource("/api/events");
    pageView.onLeave(() => events.close());
    events.onopen = () => { load(); loadDeploys(); };
    events.onerror = () => { if (events.readyState == EventSource.CLOSED) setTimeout(listen, 3000); };
    events.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type == "source") { load(); loadDeploys(); } // a move starts a deploy, here or on another server
      if (ev.type == "deploys") { heard = Date.now(); loadDeploys(); }
      if (ev.type == "deploy-log" && open && ev.target == open.target) {
        if (ev.deployId == open.deployId) { open.heard = Date.now(); append(ev.lines || []); open.shown += (ev.lines || []).length; }
        else if (!open.pinned) { open.heard = Date.now(); refreshLog(false); }
      }
    };
  }
  listen();
  load(); loadDeploys();
  // Events don't tell everything: another server's deploy (erga.dev's page shows staging's, run by staging's server)
  // sends this page none, and a server that deploys itself cuts the stream and can miss its last change. So while
  // a deploy shows running (or the status didn't load) and no event came lately, ask for the status every two seconds.
  setInterval(() => {
    if (asking || Date.now() - heard < 2500) return;
    if (!deploys || deploys.targets?.some((t) => running(t.state) || t.history?.some((r) => running(r.state)))) loadDeploys();
  }, 2000);
  setInterval(() => { render(); renderTargets(); }, 30000);
})();
`;

/** Splits a selector list at its top-level commas (not those inside :is(...) and the like). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch == "(" || ch == "[") depth++;
    else if (ch == ")" || ch == "]") depth--;
    else if (ch == "," && !depth) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** One selector, inside `scope`: ":root" and "body" become the scope itself (":root:not(...) x" keeps its test on the root). */
function scoped(sel: string, scope: string): string {
  if (sel.startsWith(":root") || sel == "body" || sel.startsWith("body ")) {
    const sp = sel.search(/\s/);
    const head = sp < 0 ? sel : sel.slice(0, sp), rest = sp < 0 ? "" : sel.slice(sp);
    return head == ":root" || head == "body" ? `${scope}${rest}` : `${head} ${scope}${rest}`;
  }
  return `${scope} ${sel}`;
}

/**
 * A pane's stylesheet, scoped to the pane (`scope`, an id selector), so its rules (a .card, a .row, a .dep...)
 * never meet the layout's. A width query measures the pane, not the window
 * (@media max-width becomes @container), as the pane is narrower beside the agent. @keyframes stay as they are.
 */
export function scopeCss(css: string, scope: string): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth && j < css.length) { if (css[j] == "{") depth++; else if (css[j] == "}") depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith("@keyframes")) out.push(`${prelude} {${body}}`);
    else if (prelude.startsWith("@media")) out.push(`${prelude.replace(/^@media\s*\(((?:max|min)-width)/, "@container ($1")} {${scopeCss(body, scope)}}`);
    else if (prelude) out.push(`${selectors(prelude).map((s) => scoped(s, scope)).join(", ")} {${body}}`);
    i = j;
  }
  return out.join("\n");
}

const PAGE_STYLE = `
  /* The dashboard, beside the agent. */
  .panes { min-width: 0; display: flex; flex-direction: column; gap: 28px; }
  .pane { container-type: inline-size; min-width: 0; }
  .pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .pane-head h2 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  .pane-head .sub { margin: 2px 0 0; font-size: 13px; }
  .pane-note { margin: -4px 0 10px; font-size: 13px; color: var(--soft); }
  /* The GitHub mirror: its state and Push now, or how to turn it on. */
  dialog#mirror-dlg { width: min(600px, calc(100vw - 32px)); }
  #mirror-dlg p { margin: 0 0 12px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  #mirror-dlg p.error { color: var(--bad, #c2410c); }
  #mirror-dlg ol { margin: 0 0 14px; padding-left: 22px; font-size: 13.5px; color: var(--fg); }
  #mirror-dlg li { margin: 0 0 10px; }
  #mirror-dlg li p { margin: 4px 0 0; }
  #mirror-dlg a { color: inherit; }
  #mirror-dlg code { font: 12.5px var(--font-mono); }
  #mirror-dlg pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  #mirror-dlg [hidden] { display: none; }
  #mirror-dlg .buttons { align-items: center; }
  #mirror-status { margin-right: auto; font-size: 12.5px; color: var(--soft); }
`;

/** The GitHub mirror's dialog: the steps that turn it on shown while it's off; its state and Push now while it's on. */
function mirrorDialog(c: SourcePageConfig): string {
  const repo = /github\.com\/([^/]+\/[^/]+?)(\.git)?$/.exec(c.mirrorUrl)?.[1] ?? "koomen/erga";
  const name = c.worker ? ` --name ${c.worker}` : " --name <this server's Worker>";
  return `<dialog id="mirror-dlg" aria-labelledby="mirror-title">
    <h2 id="mirror-title">GitHub sync</h2>
    <div id="mirror-on" hidden>
      <p id="mirror-state"></p>
      <p id="mirror-where"></p>
      <p class="error" id="mirror-error" hidden></p>
      <p>After each push or merge, Erga pushes staging and main to GitHub by itself. Push now does it at once.</p>
    </div>
    <div id="mirror-off" hidden>
      <p>GitHub sync is off: this server has no <code>GITHUB_MIRROR_TOKEN</code>. With a token, Erga pushes staging and main to <a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener">github.com/${esc(repo)}</a> after each push or merge. To turn it on:</p>
      <ol>
        <li>Make a fine-grained token on GitHub: <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.
          <p>Resource owner: <code>${esc(repo.split("/")[0])}</code>. Repository access: only <code>${esc(repo)}</code>. Permissions: Contents, read and write. You must be able to push to that repository.</p></li>
        <li>Paste the token on <a href="/admin/api-keys">Admin › API keys</a> (GitHub mirror token). The server uses it within a minute. Or set it as a secret on this server's Worker. Paste the token when the command asks for it:
          <pre><code>bunx cf workers secrets update GITHUB_MIRROR_TOKEN${esc(name)}</code></pre>
          <p>Do this when no deploy runs: a new secret restarts the deploy pipeline.</p></li>
        <li>Come back to this page. The status changes to "GitHub: not pushed yet". Click it, then click Push now.</li>
      </ol>
      <p>To sync to a different repository, set <code>GITHUB_MIRROR_URL</code> in the deploy's environment, then deploy again. If GitHub's main has commits that Erga's main does not have, the sync stops for main. Pull those commits into Erga's main, and it continues.</p>
    </div>
    <div class="buttons"><span id="mirror-status" role="status" aria-live="polite"></span><button type="button" class="primary" id="mirror-push" hidden>Push now</button><button type="button" id="mirror-close" autofocus>Close</button></div>
  </dialog>`;
}

/** /admin/source: the source and deploy dashboard (admins). */
export function adminSourcePage(c: SourcePageConfig): Response {
  if (!c.admin) return plainPage("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return adminResponse({ session: c.session, title: "Source", here: "source", wide: true, style: PAGE_STYLE + scopeCss(SOURCE_STYLE, "#source-pane"), body: `
  <div class="panes">
    <section class="pane" id="source-pane" aria-label="git log">${sourceMarkup(c)}</section>
  </div>
  ${c.ready ? mirrorDialog(c) : ""}
${c.ready ? `<script>${SOURCE_SCRIPT}</script>` : ""}` });
}
