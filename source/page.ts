// The Source page, /source (worker/source.ts), for admins: Erga's own
// repository at a glance. Two lanes, staging and main, each with its last
// 25 commits as dots on a line (as the task queue board's Branches column
// draws main), which of staging's commits main has, each branch's deploy
// (GET /api/deploys), the GitHub mirror, the Merge button, and how to clone
// and push. It updates by itself (/api/events) and follows the system's
// light or dark.

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
  main { max-width: 1080px; }
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; }
  .crumbs .brand { position: static; }
  .crumbs .here { display: flex; align-items: center; font-size: 13.5px; font-weight: 500; color: var(--fg); }
  .crumbs .here::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  :root { --lane-main: #1f7a4d; --lane-staging: #b26a00; --bad: #c2410c; --row: 30px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --lane-main: #4cc38a; --lane-staging: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --lane-main: #4cc38a; --lane-staging: #f0a742; --bad: #ff8a65; }
  header { align-items: center; margin-bottom: 28px; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  #merge-hint { margin: -16px 0 18px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  .lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 760px) { .lanes { grid-template-columns: 1fr; } }
  .card { border: 1px solid var(--rule); border-radius: 12px; padding: 14px 14px 10px; min-width: 0; background: var(--bg); }
  .card > h2 { display: flex; align-items: center; gap: 10px; margin: 0 2px 4px; font-size: 15px; font-weight: 650; color: var(--fg-strong); }
  .card > h2 .swatch { width: 10px; height: 10px; border-radius: 50%; background: var(--lane); flex: none; }
  .card > h2 code { margin-left: auto; font: 12px var(--font-mono); color: var(--soft); font-weight: 400; }
  .card[data-branch=main] { --lane: var(--lane-main); }
  .card[data-branch=staging] { --lane: var(--lane-staging); }
  .deploy { display: flex; align-items: center; gap: 7px; margin: 0 2px 10px; min-height: 20px; font-size: 12.5px; color: var(--soft); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .deploy .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); }
  .deploy.deployed .dot { background: var(--lane-main); }
  .deploy.failed { color: var(--bad); }
  .deploy.failed .dot { background: var(--bad); }
  .deploy.building .dot, .deploy.deploying .dot { background: transparent; border: 2px solid var(--lane-staging); border-right-color: transparent; width: 6px; height: 6px; animation: spin .8s linear infinite; }
  .deploy a { color: inherit; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .legend { display: flex; gap: 14px; margin: 0 2px 8px; font-size: 11.5px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--lane-main); }
  .legend i.s { background: var(--lane-staging); }
  ol.graph { list-style: none; margin: 0; padding: 0; -webkit-mask-image: linear-gradient(#000 calc(100% - 4 * var(--row)), transparent); mask-image: linear-gradient(#000 calc(100% - 4 * var(--row)), transparent); }
  ol.graph li { display: flex; align-items: center; gap: 2px; height: var(--row); border-radius: 6px; overflow: hidden; transition: height .35s ease, opacity .35s ease, background-color .15s; }
  ol.graph li.enter, ol.graph li.leave { height: 0; opacity: 0; }
  ol.graph li:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .rail { position: relative; width: 18px; height: 100%; flex: none; }
  .rail::before, .rail::after { content: ""; position: absolute; left: 8px; width: 2px; height: 50%; background: var(--lane); opacity: .35; display: none; }
  .rail::before { top: 0; } .rail::after { bottom: 0; }
  .rail.up::before, .rail.down::after { display: block; }
  .rail i { position: absolute; left: 4px; top: calc(50% - 5px); width: 10px; height: 10px; border-radius: 50%; background: var(--lane); z-index: 1; box-sizing: border-box; }
  li.in-main .rail i { background: var(--lane-main); }
  .card[data-branch=staging] li.in-main .rail i { background: var(--bg); box-shadow: inset 0 0 0 2px var(--lane-main); }
  li.merge .rail i { border-radius: 3px; transform: rotate(45deg) scale(.85); }
  .subj { flex: 1; min-width: 0; padding: 0 8px 0 4px; font-size: 13.5px; color: var(--fg-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card[data-branch=staging] li.in-main .subj { color: var(--soft); }
  .who { flex: none; font-size: 12px; color: var(--soft); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ol.graph code { flex: none; font: 11.5px var(--font-mono); color: var(--chrome); padding: 0 6px; }
  ol.graph time { flex: none; margin: 0; width: 64px; text-align: right; font-size: 12px; color: var(--soft); }
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); }
  .boxes { display: grid; grid-template-columns: 1fr 1.3fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 760px) { .boxes { grid-template-columns: 1fr; } .who { display: none; } }
  .box { border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .box h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .box h2 .pill { margin-left: auto; height: 28px; font-size: 12.5px; padding: 0 10px; }
  .box p { margin: 0 0 6px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  .box p.error { color: var(--bad); }
  .box a { color: inherit; }
  .state { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--fg); }
  .state .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--lane-main); }
  .state.error .dot { background: var(--bad); }
  .state.off .dot { background: var(--chrome); }
  .state.pushing .dot { background: transparent; border: 2px solid var(--lane-main); border-right-color: transparent; width: 6px; height: 6px; animation: spin .8s linear infinite; }
  pre { margin: 6px 0 8px; padding: 10px 12px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
  .moves { margin: 22px 2px 0; font-size: 12.5px; color: var(--soft); }
  .moves b { font-weight: 600; color: var(--fg); }
  .setup ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: var(--fg); }
  .setup li { margin: 4px 0; }
  .setup code, .box code { font: 12.5px var(--font-mono); }
`;

export function sourcePage(c: SourcePageConfig): Response {
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="/">Erga</a><span class="here" aria-current="page">Source</span></nav>`;
  const html = (body: string, status = 200) => new Response(appPage("Source", STYLE, `${crumbs}<main>${body}</main>`), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (!c.admin) return html(`<p class="empty">There's nothing here. <a href="/">Back to the start</a>.</p>`, 404);
  if (!c.ready) {
    return html(`<header><div><h1>Source</h1><p class="sub">Erga's own repository, hosted by Erga.</p></div></header>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. README.md (Erga's own source) has the steps:</p>
  <ol><li>Make the Artifacts namespace <code>erga</code> and the repo <code>erga</code> in it.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`);
  }
  const remote = `${c.origin}/git/erga.git`;
  return html(`
  <header>
    <div><h1>Source</h1><p class="sub">Erga's own repository, hosted by Erga on Cloudflare Artifacts. Push to staging, try it there, then merge it into main.</p></div>
    <div class="merge-row"><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div>
  </header>
  <p class="hint" id="merge-hint" role="status"></p>
  <section class="lanes" aria-label="Branches">
    ${["staging", "main"].map((b) => `<article class="card" data-branch="${b}">
      <h2><span class="swatch"></span>${b}<code class="head"></code></h2>
      <div class="deploy" id="deploy-${b}"><span class="dot"></span><span class="what">Deploys: not set up yet</span></div>
      ${b == "staging" ? `<div class="legend"><span><i class="s"></i>only on staging</span><span><i></i>on main too</span></div>` : `<div class="legend"><span><i></i>on main</span></div>`}
      <ol class="graph"><li class="none">Loading…</li></ol>
    </article>`).join("")}
  </section>
  <section class="boxes">
    <div class="box" id="mirror">
      <h2>GitHub mirror <button class="pill" id="mirror-now" type="button" hidden>Push now</button></h2>
      <p><span class="state off" id="mirror-state"><span class="dot"></span><span class="what">Loading…</span></span></p>
      <p id="mirror-url">${esc(c.mirrorUrl)}</p>
      <p class="error" id="mirror-error" hidden></p>
    </div>
    <div class="box" id="clone">
      <h2>Clone and push</h2>
      <pre><code>git remote add erga ${esc(remote)}
git fetch erga
git push erga HEAD:staging</code></pre>
      <p>Git asks for a username and password: any username, and an agent token from <a href="/settings">Settings</a> as the password (admins only). main takes fast-forward pushes only; merge staging into main here.</p>
    </div>
  </section>
  <p class="moves" id="moves"></p>
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
  let view = null, deploys = null, drawn = { staging: false, main: false }, busy = false;

  function lane(b) {
    const card = document.querySelector('.card[data-branch="' + b.name + '"]');
    card.querySelector(".head").textContent = b.commit ? b.commit.slice(0, 7) : "";
    const graph = card.querySelector("ol.graph");
    if (!b.commits.length) { graph.innerHTML = '<li class="none">No commits yet. Push one: git push erga HEAD:' + b.name + '</li>'; drawn[b.name] = false; return; }
    graph.querySelectorAll("li.none").forEach((li) => li.remove());
    // One row per commit, kept: a new commit slides in at the top, the oldest fades out at the bottom.
    const rows = new Map([...graph.children].filter((li) => !li.classList.contains("leave")).map((li) => [li.dataset.sha, li]));
    const want = new Set(b.commits.map((x) => x.sha));
    for (const [sha, li] of rows) if (!want.has(sha)) {
      if (!drawn[b.name]) { li.remove(); continue; }
      li.classList.add("leave"); setTimeout(() => li.remove(), 400);
    }
    let prev = null;
    b.commits.forEach((x, i) => {
      let li = rows.get(x.sha);
      const fresh = !li;
      if (fresh) { li = document.createElement("li"); li.dataset.sha = x.sha; if (drawn[b.name]) li.classList.add("enter"); }
      li.className = [li.classList.contains("enter") ? "enter" : "", x.inMain ? "in-main" : "", x.parents.length > 1 ? "merge" : ""].filter(Boolean).join(" ");
      li.title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + (b.name == "staging" ? (x.inMain ? " · on main" : " · only on staging") : "");
      li.innerHTML = '<span class="rail ' + (i > 0 ? "up " : "") + (i < b.commits.length - 1 || x.parents.length ? "down" : "") + '"><i></i></span><span class="subj">' + esc(x.subject) + '</span><span class="who">' + esc(x.author) + '</span><code>' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + '</time>';
      graph.insertBefore(li, prev ? prev.nextSibling : graph.firstChild);
      if (fresh && drawn[b.name]) { li.offsetHeight; li.classList.remove("enter"); }
      prev = li;
    });
    drawn[b.name] = true;
  }

  function render() {
    if (!view) return;
    view.branches.forEach(lane);
    const staging = view.branches.find((b) => b.name == "staging"), ahead = staging?.ahead ?? 0;
    const merge = document.getElementById("merge");
    if (!busy) merge.disabled = !ahead;
    document.getElementById("ahead").textContent = !staging?.commit ? "" : ahead ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge" : "main has everything on staging";
    const m = view.mirror, st = document.getElementById("mirror-state"), err = document.getElementById("mirror-error");
    st.className = "state " + (m.state == "off" ? "off" : m.state == "pushing" ? "pushing" : m.error ? "error" : "ok");
    st.querySelector(".what").textContent = m.state == "off" ? "Off: the server has no GITHUB_MIRROR_TOKEN" : m.state == "pushing" ? "Pushing…" : m.error ? "Behind" + (m.lastPushAt ? " · last pushed " + ago(m.lastPushAt) : "") : m.lastPushAt ? "Up to date · pushed " + ago(m.lastPushAt) : "Not pushed yet";
    document.getElementById("mirror-url").innerHTML = String(m.url || "").includes("/__github/") ? "A pretend GitHub, in the dev server (local development never pushes to the real one)" : /^https?:/.test(m.url || "") ? '<a href="' + esc(String(m.url).replace(/\\.git$/, "")) + '">' + esc(String(m.url).replace(/^https?:\\/\\//, "").replace(/\\.git$/, "")) + "</a>" : esc(m.url || "");
    err.hidden = !m.error; err.textContent = m.error || "";
    document.getElementById("mirror-now").hidden = m.state == "off";
    document.getElementById("moves").innerHTML = view.moves.slice(0, 3).map((mv) => "<b>" + esc(mv.branch) + "</b> moved to " + mv.new.slice(0, 7) + " by " + esc(mv.by) + " (" + (mv.how == "merge" ? "merge" : "push") + ") " + ago(mv.at)).join(" · ");
  }

  function renderDeploys() {
    for (const b of ["staging", "main"]) {
      const el = document.getElementById("deploy-" + b), t = deploys?.targets?.find((x) => x.branch == b);
      el.className = "deploy " + (t ? t.state : "");
      if (!t) { el.querySelector(".what").textContent = "Deploys: not set up yet"; el.title = ""; continue; }
      const what = { idle: "not deployed yet", building: "building", deploying: "deploying", deployed: "deployed", failed: "failed" }[t.state] || t.state;
      el.querySelector(".what").innerHTML = '<a href="https://' + esc(t.host) + '">' + esc(t.host) + "</a> · " + esc(what) + (t.commit ? " " + t.commit.slice(0, 7) : "") + (t.at ? " · " + ago(t.at) : "");
      el.title = t.error || (t.log || []).slice(-3).join("\\n");
    }
  }

  async function load() {
    try {
      const r = await fetch("/api/source/branches", { headers: { Accept: "application/json" } });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      view = body; render();
    } catch (e) {
      for (const g of document.querySelectorAll("ol.graph")) if (!g.querySelector("li[data-sha]")) g.innerHTML = '<li class="none">' + esc(e.message) + "</li>";
    }
  }
  async function loadDeploys() {
    const r = await fetch("/api/deploys", { headers: { Accept: "application/json" } }).catch(() => null);
    deploys = r && r.ok ? await r.json().catch(() => null) : null;
    renderDeploys();
  }

  const hint = document.getElementById("merge-hint"), mergeBtn = document.getElementById("merge");
  mergeBtn.addEventListener("click", async () => {
    busy = true; mergeBtn.disabled = true; hint.className = "hint"; hint.textContent = "Merging…";
    try {
      const r = await fetch("/api/source/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main" }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The merge failed (HTTP " + r.status + ").");
      hint.textContent = body.upToDate ? "Nothing to merge: main has everything on staging." : "Merged: main is now " + body.commit.slice(0, 7) + (body.fastForward ? " (a fast-forward)." : " (a merge commit).");
    } catch (e) { hint.className = "hint error"; hint.textContent = e.message; }
    busy = false;
    await load();
  });
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
  };
  load(); loadDeploys();
  setInterval(() => { for (const t of document.querySelectorAll("ol.graph time")) t.textContent = ago(Date.parse(t.dateTime)); render(); renderDeploys(); }, 30000);
})();
</script>`);
}
