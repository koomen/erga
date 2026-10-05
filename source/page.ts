// The Source page, /admin/source (worker/source.ts), for admins with admin
// access unlocked: the one place to manage Erga's own source, its deploys and
// the factory. Three parts, on one page: the factory's task board
// (factory/page.ts), the source and deploy dashboard (below), and the
// factory's agent (factory/agent.ts; its panel is src/page/factory-agent.ts,
// built to /factory-agent.js), with "Share with agent" for an outside agent
// (the icon in the header bar, upper right, as in the editor).
// On a wide window the agent sits on the left, as in the editor, and the
// board and the dashboard are beside it, one above the other; narrower, tabs
// show one at a time. Each part's stylesheet is scoped to its pane
// (scopeCss). /source, /admin/factory and /admin/deploys redirect here.
//
// The dashboard:
//
// One list: staging's history, newest first (staging is always at or ahead
// of main, so it holds every commit main has). Beside it, one dot column,
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
// head, or to the commit a row's "Merge to here" names. Also the GitHub
// mirror and how to clone and push. It updates by itself (/api/events) and
// follows the system's light or dark.

import { appPage, esc, ICON, type Session } from "../front";
import { BOARD_SCRIPT, BOARD_STYLE, boardMarkup } from "../factory/page";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether the factory is on (the `factory` setting). */
  factory: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  origin: string;
  mirrorUrl: string;
}

const SOURCE_STYLE = `
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; }
  .pane-head { justify-content: space-between; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  #merge-hint { margin: -4px 0 10px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  @media (max-width: 640px) { .pane-head { flex-direction: column; align-items: stretch; gap: 10px; } .merge-row { justify-content: space-between; } .merge-row .count { white-space: normal; flex: 1; min-width: 0; } #merge-hint { margin-top: -6px; text-align: left; } }
  .card { border: 1px solid var(--rule); border-radius: 12px; padding: 6px 10px 10px; min-width: 0; background: var(--bg); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 4px 6px; font-size: 12px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  /* The dots: circles only. Hollow orange, only on staging; solid green, on main. */
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; flex: none; }
  .dot.staging-only { background: var(--bg); border: 2px solid var(--only-staging); }
  .dot.on-main { background: var(--on-main); border: 2px solid var(--on-main); }
  .grid { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto 70px 132px 132px; align-items: center; }
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
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); grid-column: 1 / -1; }
  .older { grid-column: 1 / -1; padding: 8px 4px 0; font-size: 12px; color: var(--soft); display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
  .older span { display: inline-flex; align-items: center; gap: 6px; }
  .older .dep { display: inline-grid; width: auto; }
  @media (max-width: 760px) { .grid { grid-template-columns: 22px minmax(0, 1fr) auto 80px 80px; } .who, .grid > .head.who-h, .row time, .grid > .head.time-h { display: none; } .target { max-width: 82px; } .target b { font-size: 10.5px; } .target .st span { display: none; }
    .dep { font-size: 11.5px; padding: 0 5px; } .dep .at { display: none; } }
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

/** The source pane: the commits with their deploys, Merge, the mirror, how to clone; or how to set it up. */
function sourceMarkup(c: SourcePageConfig): string {
  if (!c.ready) {
    return `<div class="pane-head"><div><h2>Source and deploys</h2><p class="sub">Erga's own repository and its deploys.</p></div></div>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. README.md (Erga's own source) has the steps:</p>
  <ol><li>Make the Artifacts repo <code>erga</code> in the namespace <code>erga</code>.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`;
  }
  const remote = `${c.origin}/git/erga.git`;
  const target = (name: string, label: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Deploys aren't set up yet"><b>${label}</b><span class="st"><i></i><span>not set up</span></span></button></div>`;
  return `
  <div class="pane-head">
    <div><h2>Source and deploys</h2><p class="sub">Push to staging, or merge a task: staging deploys itself. Then move main up to it: main deploys to production.</p></div>
    <div class="merge-row"><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div>
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
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
`;
}

const SOURCE_SCRIPT = `
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
    const commits = staging?.commits ?? [];
    document.getElementById("loading")?.remove();
    const groups = Object.fromEntries(TARGETS.map((n) => [n, byCommit(n)]));
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
      const next = commits[i + 1];
      const up = i > 0, down = !!next || x.parents.length > 0;
      const title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + (x.inMain ? " · on main" : " · only on staging");
      r.innerHTML =
        '<span class="rail ' + (up ? "up " : "") + (down ? "down " : "") + (x.inMain ? "on-main" : "") + '"><i class="dot ' + kind + '" title="' + (x.inMain ? "On main (and staging)" : "Only on staging") + '"></i></span>' +
        '<span class="subj" title="' + esc(title) + '"><span>' + esc(x.subject) + "</span>" + (x.inMain ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit">Merge to here</button>') + "</span>" +
        '<span class="who">' + esc(x.author) + '</span><code class="sha">' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + "</time>" +
        TARGETS.map((n) => '<span class="deps" data-target="' + n + '">' + deployCell(n, x.sha, groups[n]) + "</span>").join("");
      grid.insertBefore(r, prev ? prev.nextSibling : document.getElementById("target-production").parentElement.nextSibling);
      prev = r;
    });
    // Deploys of commits further down than the list goes, and where a target is live if it's there.
    const older = TARGETS.map((n) => {
      const t = targetOf(n), away = [...groups[n].entries()].filter(([sha]) => !want.has(sha));
      if (!t) return "";
      if (away.length) return '<span><b>' + esc(n) + "</b> " + away.length + " older commit" + (away.length == 1 ? "" : "s") + " deployed, latest " + badge(n, shown(away[0][1])) + "</span>";
      const live = t.deployed ?? (t.state == "deployed" ? t.commit : null);
      return live && !want.has(live) && !t.history ? "<span>" + esc(n) + " is live on " + esc(live.slice(0, 7)) + ", further down</span>" : "";
    }).filter(Boolean);
    if (older.length && commits.length) grid.insertAdjacentHTML("beforeend", '<div class="older">' + older.join("") + "</div>");
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
      deploys = r && r.ok ? await r.json().catch(() => null) : null;
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
      if (ev.deployId == open.deployId) { open.heard = Date.now(); append(ev.lines || []); open.shown += (ev.lines || []).length; }
      else if (!open.pinned) { open.heard = Date.now(); refreshLog(false); }
    }
  };
  load(); loadDeploys();
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
 * A pane's stylesheet, scoped to the pane (`scope`, an id selector), so the board's and the dashboard's rules
 * (both have a .card, a .row, a .dep...) never meet. A width query measures the pane, not the window
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
  main.admin { max-width: none; padding: 62px max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left)); }
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; }
  .crumbs .brand { position: static; }
  .crumbs a.here-link { color: var(--soft); text-decoration: none; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; }
  .crumbs a.here-link:hover { color: var(--fg-strong); }
  .crumbs > :not(.brand)::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  .crumbs .here { display: flex; align-items: center; font-size: 13.5px; font-weight: 500; color: var(--fg); }
  /* The header bar: left of your avatar (account.ts), as the editor's icons are; it scrolls with the page, as the avatar does. */
  .chrome-top { position: absolute; right: calc(max(16px, env(safe-area-inset-right)) + 38px); }
  /* The agent on the left, as in the editor; the board and the dashboard beside it, one above the other. */
  .workspace { display: grid; grid-template-columns: minmax(300px, 370px) minmax(0, 1fr); gap: 20px; align-items: start; }
  .agent-pane { position: sticky; top: 16px; height: calc(100vh - 78px); height: calc(100dvh - 78px); min-height: 420px; display: flex; flex-direction: column; min-width: 0;
    border: 1px solid var(--panel-border); border-radius: 18px; background: var(--bg); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.07), 0 1px 3px rgba(0, 0, 0, 0.05); font: 14px/1.55 var(--font-text); color: var(--fg); overflow: hidden; }
  .agent-pane .agent-head .title { white-space: nowrap; }
  .agent-pane .agent-head .share { margin-left: auto; }
  .panes { min-width: 0; display: flex; flex-direction: column; gap: 28px; }
  .pane { container-type: inline-size; min-width: 0; }
  .pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .pane-head h2 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  .pane-head .sub { margin: 2px 0 0; font-size: 13px; }
  .pane-note { margin: -4px 0 10px; font-size: 13px; color: var(--soft); }
  .tabs { display: none; }
  /* Narrower, one at a time: tabs for the board, the dashboard and the agent. */
  @media (max-width: 999.98px) {
    main.admin { padding-top: 58px; }
    .workspace { display: block; }
    .tabs { display: flex; gap: 4px; padding: 4px; margin: 0 0 14px; border: 1px solid var(--rule); border-radius: 12px; background: var(--bg); position: sticky; top: max(8px, env(safe-area-inset-top)); z-index: 6; }
    .tabs button { flex: 1; height: 34px; border: 0; border-radius: 9px; background: transparent; color: var(--soft); font: 550 13.5px var(--font-text); cursor: pointer; }
    .tabs button[aria-selected="true"] { background: var(--fg-strong); color: var(--bg); }
    .panes { display: block; }
    .pane, .agent-pane { display: none; }
    body[data-tab="tasks"] #tasks, body[data-tab="source"] #source-pane { display: block; }
    body[data-tab="agent"] .agent-pane { display: flex; position: static; height: calc(100dvh - 150px); min-height: 360px; }
  }
  /* Share with agent: the factory token's dialog. */
  dialog#share-dlg { width: min(560px, calc(100vw - 32px)); }
  #share-dlg p { margin: 0 0 12px; font-size: 13.5px; color: var(--soft); }
  #share-dlg .make { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: end; margin-bottom: 12px; }
  #share-dlg .make label { margin: 0; }
  #share-dlg .make input, #share-dlg .make select { width: 100%; height: 34px; box-sizing: border-box; border: 1px solid var(--rule); border-radius: 8px; padding: 0 10px; background: var(--bg); color: var(--fg-strong); font: inherit; font-size: 13.5px; }
  #share-dlg .make select { padding-right: 26px; }
  @media (max-width: 520px) { #share-dlg .make { grid-template-columns: 1fr 1fr; } #share-dlg .make .grow { grid-column: 1 / -1; } }
  #share-prompt { display: block; width: 100%; height: 170px; box-sizing: border-box; margin: 0 0 10px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--code-bg); color: var(--fg); font: 12px/1.5 var(--font-mono); resize: vertical; }
  #share-prompt[hidden] { display: none; }
  #share-dlg .buttons { align-items: center; }
  #share-status { margin-right: auto; font-size: 12.5px; color: var(--soft); }
  #share-dlg h3 { margin: 16px 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--soft); }
  #share-tokens { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  #share-tokens li { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid var(--rule); }
  #share-tokens li .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); }
  #share-tokens li .when { color: var(--soft); font-size: 12px; white-space: nowrap; }
  #share-tokens li.ended .what { color: var(--soft); text-decoration: line-through; }
  #share-tokens li button { height: 26px; padding: 0 10px; font-size: 12px; }
  #share-tokens .none { color: var(--soft); border: 0; }
`;

/** The tabs on a phone: which pane shows, remembered in this browser and in the address (#tasks, #source, #agent). */
const TABS_SCRIPT = `
(() => {
  const tabs = ["tasks", "source", "agent"];
  let tab = location.hash.slice(1);
  if (!tabs.includes(tab)) { try { tab = localStorage.getItem("erga:admin-source-tab") || "tasks"; } catch { tab = "tasks"; } }
  if (!tabs.includes(tab)) tab = "tasks";
  const show = (t) => {
    document.body.dataset.tab = t;
    for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab == t));
    try { localStorage.setItem("erga:admin-source-tab", t); } catch {}
    if (t == "agent") window.dispatchEvent(new Event("erga:agent-shown"));
  };
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.addEventListener("click", () => { show(b.dataset.tab); history.replaceState(null, "", "#" + b.dataset.tab); });
  show(tab);
})();
`;

/** /admin/source: the factory's board, the source and deploy dashboard, and the factory's agent, on one page (admins, unlocked). */
export function adminSourcePage(c: SourcePageConfig): Response {
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="/">Erga</a><a class="here-link" href="/admin">Admin</a><span class="here" aria-current="page">Source</span></nav>`;
  // The header bar, upper right, as the editor's (page.html, .chrome-top): Share with agent, the same icon button.
  const bar = `<div class="chrome chrome-top" role="toolbar" aria-label="Controls"><button type="button" class="icon-btn" id="btn-share" aria-label="Share the factory with an agent" data-tip="Share with an agent" aria-haspopup="dialog" aria-expanded="false" aria-controls="share-dlg">${ICON.agent}</button></div>`;
  const page = (body: string, status = 200) => new Response(appPage("Source", PAGE_STYLE + scopeCss(BOARD_STYLE, "#tasks") + scopeCss(SOURCE_STYLE, "#source-pane"), `${crumbs}${body}`), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (!c.admin) return page(`<main><p class="empty">There's nothing here. <a href="/">Back to the start</a>.</p></main>`, 404);
  return page(`${bar}
<main class="admin">
  <div class="tabs" role="tablist" aria-label="Show"><button type="button" role="tab" data-tab="tasks">Tasks</button><button type="button" role="tab" data-tab="source">Source</button><button type="button" role="tab" data-tab="agent">Agent</button></div>
  <div class="workspace">
  <aside class="agent-pane" id="agent" aria-label="Agent">
    <div class="agent-head">
      <span class="title">Agent</span><span class="model" id="agent-model"></span>
      <button type="button" class="icon-btn" id="agent-reset" aria-label="New conversation" data-tip="New conversation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div class="agent-log" id="agent-log" data-empty="Say what you want built. The agent queues it as factory tasks, with their dependencies, and can read tasks, their logs, previews and screenshots, and send them more instructions. You merge." aria-live="polite" tabindex="-1"></div>
    <button type="button" class="agent-jump" id="agent-jump" hidden>↓ Jump to latest</button>
    <p class="agent-hint" id="agent-hint" role="status" hidden></p>
    <form class="agent-compose" id="agent-form">
      <div class="agent-field" id="agent-field"><textarea id="agent-input" rows="1" placeholder="Ask the agent…" aria-label="Message the agent"></textarea></div>
      <button type="submit" class="agent-send" id="agent-send">Send</button>
    </form>
  </aside>
  <div class="panes">
    <section class="pane" id="tasks" aria-label="Tasks">${boardMarkup({ enabled: c.factory })}</section>
    <section class="pane" id="source-pane" aria-label="Source and deploys">${sourceMarkup(c)}</section>
  </div>
  </div>
  <dialog id="share-dlg" aria-labelledby="share-title">
    <h2 id="share-title">Share the factory with an agent</h2>
    <p>Make a token, then paste the prompt into an agent that can run commands (Claude Code, Codex…). It can queue tasks, read them and send them more instructions, as your agent. It can't merge, discard or start tasks, push or deploy.</p>
    <div class="make">
      <label class="grow">Label<input id="share-label" maxlength="60" value="Claude Code" autocomplete="off"></label>
      <label>Lasts<select id="share-hours"><option value="1">1 hour</option><option value="4" selected>4 hours</option><option value="12">12 hours</option></select></label>
      <button type="button" class="primary" id="share-make">Make token</button>
    </div>
    <textarea id="share-prompt" readonly spellcheck="false" aria-label="Prompt for the other agent" hidden></textarea>
    <div class="buttons"><span id="share-status" role="status" aria-live="polite"></span><button type="button" id="share-copy" hidden>Copy prompt</button><button type="button" id="share-close">Close</button></div>
    <h3>Factory tokens</h3>
    <ul id="share-tokens"><li class="none">None yet.</li></ul>
    <p style="margin-top:10px">A token ends by itself; Revoke ends it now. Revoking the admin key you unlocked with ends it too.</p>
  </dialog>
</main>
<script>${TABS_SCRIPT}</script>
<script>${BOARD_SCRIPT}</script>
${c.ready ? `<script>${SOURCE_SCRIPT}</script>` : ""}
<script src="/factory-agent.js" defer></script>`);
}
