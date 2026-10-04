// The Source page, /source (worker/source.ts), for admins: the one place to
// manage Erga's own source and its deploys.
//
// One list: staging's history, newest first (staging is always at or ahead
// of main, so it holds every commit main has). Beside it, two dot columns,
// as the task queue board's Branches column draws them: staging (a hollow
// orange circle for a commit only on staging, a solid green one for a commit
// main has too) and main (a solid green circle where main has the commit).
// Then two deploy columns, staging and production: which commit each has
// live, and each target's status (GET /api/deploys) in the column's head,
// which opens that deploy's live log (GET /api/deploys/<name>/log, then
// { type: "deploy-log" } events). Merge moves main forward to staging's
// head, or to the commit a row's "Merge to here" names. Also the GitHub
// mirror and how to clone and push. It updates by itself (/api/events) and
// follows the system's light or dark.

import { appPage, esc, type Session } from "../front";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  origin: string;
  mirrorUrl: string;
}

const STYLE = `
  main { max-width: 1120px; }
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; }
  .crumbs .brand { position: static; }
  .crumbs .here { display: flex; align-items: center; font-size: 13.5px; font-weight: 500; color: var(--fg); }
  .crumbs .here::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; }
  header { align-items: center; margin-bottom: 24px; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  #merge-hint { margin: -12px 0 14px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  @media (max-width: 640px) { header { flex-direction: column; align-items: stretch; gap: 14px; } .merge-row { justify-content: space-between; } .merge-row .count { white-space: normal; flex: 1; min-width: 0; } #merge-hint { margin-top: -6px; text-align: left; } }
  .card { border: 1px solid var(--rule); border-radius: 12px; padding: 6px 10px 10px; min-width: 0; background: var(--bg); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 4px 6px; font-size: 12px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  /* The dots: circles only. Hollow orange, only on staging; solid green, on main. */
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; flex: none; }
  .dot.staging-only { background: var(--bg); border: 2px solid var(--only-staging); }
  .dot.on-main { background: var(--on-main); border: 2px solid var(--on-main); }
  .grid { display: grid; grid-template-columns: 22px 22px minmax(0, 1fr) auto auto 70px 116px 116px; align-items: center; }
  .grid > .head { position: sticky; top: 0; z-index: 2; background: var(--bg); height: 44px; display: flex; align-items: flex-end; padding-bottom: 6px; box-sizing: border-box; border-bottom: 1px solid var(--rule);
    font-size: 11.5px; font-weight: 600; letter-spacing: .02em; color: var(--soft); white-space: nowrap; }
  .grid > .head.lane { justify-content: center; writing-mode: vertical-rl; transform: rotate(180deg); align-items: center; padding: 4px 0; height: 44px; font-size: 10.5px; }
  .grid > .head.deploy { justify-content: center; }
  .target { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; max-width: 112px; border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .target:hover { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .target b { font-weight: 650; color: var(--fg-strong); font-size: 11.5px; }
  .target .st { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; font-size: 11.5px; }
  .target .st i { width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); }
  .target.deployed .st i { background: var(--on-main); }
  .target.failed .st { color: var(--bad); }
  .target.failed .st i { background: var(--bad); }
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
  .rail.s::before, .rail.s::after { background: var(--only-staging); }
  .rail.m::before, .rail.m::after { background: var(--on-main); }
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
  .live { justify-content: center; }
  .pill-live { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--bg); background: var(--on-main); white-space: nowrap; }
  .pill-live.busy { color: var(--only-staging); background: transparent; box-shadow: inset 0 0 0 1.5px var(--only-staging); }
  .pill-live.failed { color: var(--bad); background: transparent; box-shadow: inset 0 0 0 1.5px var(--bad); }
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); grid-column: 1 / -1; }
  .older { grid-column: 1 / -1; padding: 8px 4px 0; font-size: 12px; color: var(--soft); }
  @media (max-width: 760px) { .grid { grid-template-columns: 22px 22px minmax(0, 1fr) auto 64px 64px; } .who, .grid > .head.who-h, .row time, .grid > .head.time-h { display: none; } .target { max-width: 62px; } .target b { font-size: 10.5px; } .target .st span { display: none; } .pill-live { padding: 0 6px; font-size: 10.5px; } }
  .boxes { display: grid; grid-template-columns: 1fr 1.3fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 760px) { .boxes { grid-template-columns: 1fr; } }
  .box { border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .box h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .box h2 .pill { margin-left: auto; height: 28px; font-size: 12.5px; padding: 0 10px; }
  .box p { margin: 0 0 6px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  .box p.error { color: var(--bad); }
  .box a { color: inherit; }
  .state { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--fg); }
  .state i { width: 7px; height: 7px; border-radius: 50%; background: var(--on-main); }
  .state.error i { background: var(--bad); }
  .state.off i { background: var(--chrome); }
  .state.pushing i { background: transparent; border: 2px solid var(--on-main); border-right-color: transparent; width: 5px; height: 5px; animation: spin .8s linear infinite; }
  pre { margin: 6px 0 8px; padding: 10px 12px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
  .moves { margin: 18px 2px 0; font-size: 12.5px; color: var(--soft); }
  .moves b { font-weight: 600; color: var(--fg); }
  .setup ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: var(--fg); }
  .setup li { margin: 4px 0; }
  .setup code, .box code { font: 12.5px var(--font-mono); }
  dialog#log { width: min(820px, calc(100vw - 32px)); padding: 0; }
  #log .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
  #log h2 { margin: 0; font-size: 15px; }
  #log .meta { font-size: 12.5px; color: var(--soft); }
  #log .close { margin-left: auto; height: 30px; }
  #log pre { margin: 0; border-radius: 0 0 12px 12px; height: min(60vh, 520px); overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  #log pre .t { color: var(--chrome); }
  #log pre .s { color: var(--soft); }
`;

export function sourcePage(c: SourcePageConfig): Response {
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="/">Erga</a><span class="here" aria-current="page">Source</span></nav>`;
  const html = (body: string, status = 200) => new Response(appPage("Source", STYLE, `${crumbs}<main>${body}</main>`), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (!c.admin) return html(`<p class="empty">There's nothing here. <a href="/">Back to the start</a>.</p>`, 404);
  if (!c.ready) {
    return html(`<header><div><h1>Source</h1><p class="sub">Erga's own repository and its deploys.</p></div></header>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. README.md (Erga's own source) has the steps:</p>
  <ol><li>Make the Artifacts repo <code>erga</code> in the namespace <code>erga</code>.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`);
  }
  const remote = `${c.origin}/git/erga.git`;
  const target = (name: string, label: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Deploys aren't set up yet"><b>${label}</b><span class="st"><i></i><span>not set up</span></span></button></div>`;
  return html(`
  <header>
    <div><h1>Source</h1><p class="sub">Erga's own repository and its deploys. Push to staging; staging deploys itself. Then move main up to it: main deploys to production.</p></div>
    <div class="merge-row"><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div>
  </header>
  <p class="hint" id="merge-hint" role="status"></p>
  <section class="card" aria-label="Commits">
    <div class="legend"><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main</span></div>
    <div class="grid" id="grid">
      <div class="head lane" title="staging">staging</div><div class="head lane" title="main">main</div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head"></div><div class="head time-h"></div>
      ${target("staging", "staging")}${target("production", "production")}
      <div class="none" id="loading">Loading…</div>
    </div>
  </section>
  <section class="boxes">
    <div class="box" id="mirror">
      <h2>GitHub mirror <button class="pill" id="mirror-now" type="button" hidden>Push now</button></h2>
      <p><span class="state off" id="mirror-state"><i></i><span class="what">Loading…</span></span></p>
      <p id="mirror-url">${esc(c.mirrorUrl)}</p>
      <p class="error" id="mirror-error" hidden></p>
    </div>
    <div class="box" id="clone">
      <h2>Clone and push</h2>
      <pre><code>git remote add erga ${esc(remote)}
git fetch erga
git push erga HEAD:staging</code></pre>
      <p>Git asks for a username and password: any username, and an agent token from <a href="/settings">Settings</a> as the password (admins only). main only follows staging: merge here, or push one of staging's commits to main.</p>
    </div>
  </section>
  <p class="moves" id="moves"></p>
  <dialog id="log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
<script>
(() => {
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
  let view = null, deploys = null, busy = false, drawn = false;
  const grid = document.getElementById("grid");

  /** What a target shows on a commit's row: live, deploying, failed, or nothing. */
  function liveCell(t, sha) {
    if (!t) return "";
    const live = t.deployed ?? (t.state == "deployed" ? t.commit : null);
    if ((t.state == "building" || t.state == "deploying") && t.commit == sha) return '<span class="pill-live busy">' + t.state + "</span>";
    if (t.state == "failed" && t.commit == sha && live != sha) return '<span class="pill-live failed">failed</span>';
    return live == sha ? '<span class="pill-live" title="Live on ' + esc(t.host) + '">live</span>' : "";
  }
  const targetOf = (name) => deploys?.targets?.find((t) => t.name == name) ?? null;

  function render() {
    if (!view) return;
    const staging = view.branches.find((b) => b.name == "staging"), main = view.branches.find((b) => b.name == "main");
    const commits = staging?.commits ?? [];
    document.getElementById("loading")?.remove();
    // One row per commit, kept: a new commit fades in at the top, the oldest goes at the bottom.
    const rows = new Map([...grid.querySelectorAll(".row")].map((r) => [r.dataset.sha, r]));
    const want = new Set(commits.map((x) => x.sha));
    for (const [sha, r] of rows) if (!want.has(sha)) r.remove();
    grid.querySelector(".none.empty")?.remove();
    grid.querySelector(".older")?.remove();
    if (!commits.length) { grid.insertAdjacentHTML("beforeend", '<div class="none empty">No commits yet. Push one: git push erga HEAD:staging</div>'); }
    let prev = null;
    commits.forEach((x, i) => {
      let r = rows.get(x.sha);
      if (!r) { r = document.createElement("div"); r.dataset.sha = x.sha; }
      const kind = x.inMain ? "on-main" : "staging-only";
      r.className = "row " + kind;
      const next = commits[i + 1], prevC = commits[i - 1];
      const sUp = i > 0, sDown = !!next || x.parents.length > 0;
      const mUp = x.inMain && prevC?.inMain, mDown = x.inMain && (next ? next.inMain : x.parents.length > 0);
      const title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + (x.inMain ? " · on main" : " · only on staging");
      r.innerHTML =
        '<span class="rail s ' + (sUp ? "up " : "") + (sDown ? "down " : "") + (x.inMain ? "on-main" : "") + '"><i class="dot ' + kind + '" data-lane="staging"></i></span>' +
        '<span class="rail m ' + (mUp ? "up " : "") + (mDown ? "down" : "") + '">' + (x.inMain ? '<i class="dot on-main" data-lane="main"></i>' : "") + "</span>" +
        '<span class="subj" title="' + esc(title) + '"><span>' + esc(x.subject) + "</span>" + (x.inMain ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit">Merge to here</button>') + "</span>" +
        '<span class="who">' + esc(x.author) + '</span><code class="sha">' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + "</time>" +
        TARGETS.map((n) => '<span class="live" data-target="' + n + '">' + liveCell(targetOf(n), x.sha) + "</span>").join("");
      grid.insertBefore(r, prev ? prev.nextSibling : document.getElementById("target-production").parentElement.nextSibling);
      prev = r;
    });
    // A target live on a commit older than the list shows.
    const older = TARGETS.map((n) => targetOf(n)).filter((t) => t && (t.deployed ?? t.commit) && !want.has(t.deployed ?? t.commit));
    if (older.length && commits.length) grid.insertAdjacentHTML("beforeend", '<div class="older">' + older.map((t) => esc(t.name) + " is live on " + esc((t.deployed ?? t.commit).slice(0, 7)) + ", further down").join(" · ") + "</div>");
    drawn = true;
    const ahead = staging?.ahead ?? 0, mergeBtn = document.getElementById("merge");
    if (!busy) mergeBtn.disabled = !ahead;
    document.getElementById("ahead").textContent = !staging?.commit ? "" : ahead ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge" : "main is at staging";
    const m = view.mirror, st = document.getElementById("mirror-state"), err = document.getElementById("mirror-error");
    st.className = "state " + (m.state == "off" ? "off" : m.state == "pushing" ? "pushing" : m.error ? "error" : "ok");
    st.querySelector(".what").textContent = m.state == "off" ? "Off: the server has no GITHUB_MIRROR_TOKEN" : m.state == "pushing" ? "Pushing…" : m.error ? "Behind" + (m.lastPushAt ? " · last pushed " + ago(m.lastPushAt) : "") : m.lastPushAt ? "Up to date · pushed " + ago(m.lastPushAt) : "Not pushed yet";
    document.getElementById("mirror-url").innerHTML = String(m.url || "").includes("/__github/") ? "A pretend GitHub, in the dev server (local development never pushes to the real one)" : /^https?:/.test(m.url || "") ? '<a href="' + esc(String(m.url).replace(/\\.git$/, "")) + '">' + esc(String(m.url).replace(/^https?:\\/\\//, "").replace(/\\.git$/, "")) + "</a>" : esc(m.url || "");
    err.hidden = !m.error; err.textContent = m.error || "";
    document.getElementById("mirror-now").hidden = m.state == "off";
    document.getElementById("moves").innerHTML = view.moves.slice(0, 3).map((mv) => "<b>" + esc(mv.branch) + "</b> moved to " + mv.new.slice(0, 7) + " by " + esc(mv.by) + " (" + (mv.how == "merge" ? "merge" : "push") + ") " + ago(mv.at)).join(" · ");
  }

  function renderTargets() {
    for (const n of TARGETS) {
      const b = document.getElementById("target-" + n), t = targetOf(n);
      b.className = "target " + (t ? t.state : "");
      b.disabled = !t;
      b.title = t ? (t.host + ": " + t.state + (t.error ? " (" + t.error + ")" : "") + ". Click for the log.") : "Deploys aren't set up yet";
      const what = !t ? "not set up" : { idle: "idle", building: "building", deploying: "deploying", deployed: "live", failed: "failed" }[t.state] || t.state;
      b.querySelector(".st span").textContent = what + (t?.at ? " · " + ago(t.at) : "");
    }
    render();
  }

  async function load() {
    try {
      const r = await fetch("/api/source/branches", { headers: { Accept: "application/json" } });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      view = body; render();
    } catch (e) {
      const l = document.getElementById("loading");
      if (l) l.textContent = e.message;
    }
  }
  async function loadDeploys() {
    const r = await fetch("/api/deploys", { headers: { Accept: "application/json" } }).catch(() => null);
    deploys = r && r.ok ? await r.json().catch(() => null) : null;
    renderTargets();
  }

  // The deploy log, live.
  const dlg = document.getElementById("log"), pre = document.getElementById("log-lines");
  let open = null; // { target, deployId, shown: lines shown, state, heard: when an event last came }
  const line = (l) => '<span class="t">' + esc(new Date(l.at).toLocaleTimeString()) + "</span> " + (l.step ? '<span class="s">[' + esc(l.step) + "]</span> " : "") + esc(l.text) + "\\n";
  function append(lines) {
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.insertAdjacentHTML("beforeend", lines.map(line).join(""));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
  async function openLog(name) {
    const t = targetOf(name);
    document.getElementById("log-title").textContent = (t?.host ?? name) + " deploy log";
    pre.textContent = "Loading…";
    open = { target: name, deployId: null, shown: 0, state: null, heard: 0 };
    if (!dlg.open) dlg.showModal();
    await refreshLog(true);
  }
  const running = (state) => state == "building" || state == "deploying";
  /** The log as the server has it now: what's new since what's shown (or all of it, for another deploy). */
  async function refreshLog(first) {
    if (!open) return;
    const name = open.target;
    const r = await fetch("/api/deploys/" + name + "/log").catch(() => null);
    const log = r && r.ok ? await r.json().catch(() => null) : null;
    if (!open || open.target != name) return;
    if (!log) { if (first) { pre.textContent = "No deploy log yet."; document.getElementById("log-meta").textContent = ""; } return; }
    const lines = log.lines || [];
    if (first || log.deployId != open.deployId) { pre.textContent = ""; open.shown = 0; }
    open.deployId = log.deployId; open.state = log.state;
    document.getElementById("log-meta").textContent = [log.commit ? log.commit.slice(0, 7) : "", log.state].filter(Boolean).join(" · ");
    if (lines.length > open.shown) { append(lines.slice(open.shown)); open.shown = lines.length; }
    if (first) pre.scrollTop = pre.scrollHeight;
  }
  // Live lines come as events only from the server running the deploy (staging's runs on staging's own server):
  // while a deploy runs and no events arrive, ask for the log every two seconds.
  setInterval(() => {
    if (!open || !dlg.open) return;
    const t = targetOf(open.target);
    if (!(running(open.state) || running(t?.state))) return;
    if (Date.now() - open.heard < 2500) return;
    refreshLog(false);
  }, 2000);
  for (const n of TARGETS) document.getElementById("target-" + n).addEventListener("click", () => openLog(n));
  document.getElementById("log-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => { open = null; });

  const hint = document.getElementById("merge-hint"), mergeBtn = document.getElementById("merge");
  async function merge(commit) {
    busy = true; mergeBtn.disabled = true; hint.className = "hint"; hint.textContent = "Merging…";
    try {
      const r = await fetch("/api/source/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main", ...(commit ? { commit } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The merge failed (HTTP " + r.status + ").");
      hint.textContent = body.upToDate ? "Nothing to merge: main is there already." : "Merged: main is now " + body.commit.slice(0, 7) + ".";
    } catch (e) { hint.className = "hint error"; hint.textContent = e.message; }
    busy = false;
    await load();
  }
  mergeBtn.addEventListener("click", () => merge(null));
  grid.addEventListener("click", (e) => { const b = e.target.closest("button[data-merge]"); if (b) merge(b.dataset.merge); });
  document.getElementById("mirror-now").addEventListener("click", async (e) => {
    e.target.disabled = true;
    await fetch("/api/source/mirror", { method: "POST" }).catch(() => {});
    e.target.disabled = false;
    load();
  });

  // Live: an event says what changed; a reconnect reloads everything.
  const events = new EventSource("/api/events");
  events.onopen = () => { load(); loadDeploys(); };
  events.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type == "source") load();
    if (ev.type == "deploys") loadDeploys();
    if (ev.type == "deploy-log" && open && ev.target == open.target) {
      open.heard = Date.now();
      if (open.deployId && ev.deployId != open.deployId) refreshLog(false);
      else { append(ev.lines || []); open.shown += (ev.lines || []).length; }
    }
  };
  load(); loadDeploys();
  setInterval(() => { render(); renderTargets(); }, 30000);
})();
</script>`);
}
