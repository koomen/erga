// The factory's board, /admin/factory (experimental): the local task
// queue's board (development/task-queue/index.html) inside Erga. Columns
// Queued, Working, Ready to merge, Merging and Merged; a card per task, its
// detail on a click (the ask, the summary, the preview, the branch, the log,
// the screenshots), with Merge, Discard and new instructions; live, over
// /api/factory/events. The header says where the VMs run and whether a
// Claude plan is signed in, and signs one in (a `claude setup-token` token).

const STYLE = `
  :root {
    --bg: #f7f8fa; --panel: #eceef2; --card: #ffffff; --ink: #1b2330; --muted: #5b6676; --line: #dde2ea;
    --accent: #1f5f8b; --ok: #1f7a4d; --warn: #b26a00; --bad: #b3261e; --shadow: 0 1px 2px rgba(20,28,40,.06), 0 2px 8px rgba(20,28,40,.04);
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg: #12161d; --panel: #1a2029; --card: #222a35; --ink: #e4e8ee; --muted: #9aa5b4; --line: #2c3440;
      --accent: #7fb6e0; --ok: #4cc38a; --warn: #f0a742; --bad: #ff7b72; --shadow: 0 1px 2px rgba(0,0,0,.4); color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 14px 72px 8px 24px; min-height: 56px; }
  .crumbs { display: flex; align-items: baseline; gap: 8px; font-size: 15px; }
  .crumbs a { color: var(--muted); text-decoration: none; } .crumbs a:hover { color: var(--ink); }
  .crumbs .brand { font-weight: 700; color: var(--ink); }
  .crumbs .sep { color: var(--muted); }
  .crumbs .here { font-weight: 600; }
  .tag { font: 600 10px/1 ui-sans-serif, -apple-system, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--warn); border: 1px solid currentColor; border-radius: 999px; padding: 3px 7px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
  .pill { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; background: var(--card); }
  .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .pill.on::before { background: var(--ok); } .pill.off::before { background: var(--bad); }
  button.pill { cursor: pointer; font: inherit; font-size: 12px; } button.pill:hover { border-color: var(--muted); color: var(--ink); }
  .notice { margin: 4px 24px 8px; padding: 10px 14px; border-radius: 8px; background: var(--panel); color: var(--muted); font-size: 13px; }
  .notice a { color: var(--accent); }
  main { display: grid; grid-template-columns: repeat(5, minmax(180px, 1fr)); gap: 14px; padding: 8px 24px 24px; align-items: start; }
  @media (max-width: 1150px) { main { grid-template-columns: repeat(3, minmax(200px, 1fr)); } }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; padding: 8px 16px 16px; } header { padding: 12px 64px 8px 16px; } .notice { margin: 4px 16px 8px; } }
  .col { background: var(--panel); border-radius: 10px; padding: 10px; min-height: 120px; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 2px 4px 10px; min-height: 26px; display: flex; justify-content: space-between; align-items: center; }
  .col h2 button { text-transform: none; letter-spacing: 0; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 4px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; box-shadow: var(--shadow); cursor: pointer; }
  .card:hover { border-color: var(--muted); }
  .card.failed { border-left: 3px solid var(--bad); }
  .card.merging { border-left: 3px solid var(--warn); }
  .top { display: flex; gap: 8px; align-items: baseline; }
  .id { color: var(--muted); font: 12px ui-monospace, monospace; }
  .title { font-weight: 600; flex: 1; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .meta code, .branch { font: 11px ui-monospace, monospace; }
  .last { color: var(--muted); font-size: 12px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .err { color: var(--bad); font-size: 12px; margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 7.5em; overflow: hidden; }
  .thumbs { display: flex; gap: 6px; margin-top: 8px; overflow: hidden; }
  .thumbs img { height: 54px; border-radius: 4px; border: 1px solid var(--line); object-fit: cover; max-width: 96px; }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  button, .btn { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 6px; padding: 4px 10px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
  button:hover, .btn:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) button.primary { color: #0d1218; } }
  button.danger { color: var(--bad); }
  button.confirm { background: var(--bad); border-color: var(--bad); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .spin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--warn); border-right-color: transparent; border-radius: 50%; animation: s .8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); width: min(900px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 0; }
  dialog.small { width: min(560px, calc(100vw - 32px)); }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .dlg { padding: 18px 22px 22px; }
  .dlg-head { display: flex; align-items: flex-start; gap: 12px; }
  .dlg h3 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .status { font: 600 11px/1 ui-sans-serif, -apple-system, sans-serif; text-transform: uppercase; letter-spacing: .05em; padding: 4px 8px; border-radius: 999px; border: 1px solid currentColor; color: var(--muted); white-space: nowrap; }
  .status.working { color: var(--accent); } .status.complete, .status.merged { color: var(--ok); } .status.merging { color: var(--warn); } .status.failed { color: var(--bad); }
  .links { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin-top: 8px; font-size: 13px; }
  .links a { color: var(--accent); text-decoration: none; } .links a:hover { text-decoration: underline; }
  .links .muted { color: var(--muted); font-size: 12px; }
  .dlg section { margin-top: 18px; }
  .dlg h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--panel); border-radius: 8px; padding: 10px 12px; font-size: 14px; line-height: 1.5; }
  .shots { display: grid; gap: 12px; }
  .shots figure { margin: 0; } .shots img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  .shots figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .log { font: 12px/1.5 ui-monospace, monospace; max-height: 260px; overflow: auto; background: var(--panel); border-radius: 6px; padding: 8px 10px; }
  .log div { white-space: pre-wrap; overflow-wrap: anywhere; } .log time { color: var(--muted); margin-right: 8px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input, textarea { width: 100%; font: inherit; font-size: 14px; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; align-items: center; }
  .row .why { color: var(--bad); font-size: 12px; margin-right: auto; }
  ol.steps { margin: 8px 0 0; padding-left: 1.3em; color: var(--ink); } ol.steps li { margin: 4px 0; }
  code { font: 12px ui-monospace, monospace; background: var(--panel); border-radius: 4px; padding: 1px 4px; }
  .fine { color: var(--muted); font-size: 12px; margin-top: 10px; }
`;

const SCRIPT = `
const COLUMNS = [
  { title: "Queued", statuses: ["queued"] },
  { title: "Working", statuses: ["working", "failed"] },
  { title: "Ready to merge", statuses: ["complete"] },
  { title: "Merging", statuses: ["merging"] },
  { title: "Merged", statuses: ["merged"] },
];
let tasks = [], info = null, openId = null;
const armed = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : new Date(iso).toLocaleDateString(); };
const api = async (path, opts = {}) => {
  const r = await fetch("/api/factory" + path, { method: opts.method || "GET", headers: opts.json !== undefined ? { "Content-Type": "application/json" } : {}, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.status);
  return body;
};

function actions(t, inDialog) {
  const b = [];
  if (t.url && !inDialog && !["merged", "discarded"].includes(t.status)) b.push('<a class="btn" href="/api/factory/tasks/' + t.id + '/open" target="_blank" onclick="event.stopPropagation()">Open preview</a>');
  if (t.status == "complete") b.push('<button class="primary" data-act="merge" data-id="' + t.id + '">Merge</button>');
  if (t.status == "merging") b.push('<button disabled><span class="spin"></span> ' + (t.log.at(-1)?.message.includes("waiting for") ? "Waiting to merge…" : "Merging…") + '</button>');
  if (!["merging", "merged", "discarded"].includes(t.status))
    b.push(armed.has(t.id) ? '<button class="confirm" data-act="discard" data-id="' + t.id + '">Discard branch?</button>' : '<button class="danger" data-act="arm" data-id="' + t.id + '">Discard</button>');
  return b.length ? '<div class="actions">' + b.join("") + '</div>' : "";
}

function card(t) {
  const last = t.log[t.log.length - 1];
  const thumbs = t.screenshots.slice(-3).map((s) => '<img src="/api/factory/shots/' + esc(s.file) + '" alt="' + esc(s.caption) + '" loading="lazy">').join("");
  return '<div class="card ' + t.status + '" data-open="' + t.id + '">' +
    '<div class="top"><span class="id">#' + t.id + '</span><span class="title">' + esc(t.title) + '</span></div>' +
    '<div class="meta"><code>' + esc(t.branch) + '</code><span>' + (t.status == "merged" ? "merged " + ago(t.mergedAt) : ago(t.updatedAt)) + '</span>' + (t.status == "failed" ? "<span>failed</span>" : "") + '</div>' +
    (t.error ? '<div class="err">' + esc(t.error) + '</div>' : last && t.status != "merged" ? '<div class="last">' + esc(last.message) + '</div>' : "") +
    (thumbs && t.status != "merged" ? '<div class="thumbs">' + thumbs + '</div>' : "") +
    actions(t, false) + '</div>';
}

function render() {
  $("board").innerHTML = COLUMNS.map((c) => {
    let list = tasks.filter((t) => c.statuses.includes(t.status));
    list.sort((a, b) => (b.mergedAt || b.updatedAt).localeCompare(a.mergedAt || a.updatedAt));
    if (c.title == "Merged") list = list.slice(0, 20);
    const add = c.title == "Queued" && info && info.enabled ? '<button id="new" data-act="new">New task</button>' : "";
    return '<section class="col" data-col="' + c.title.toLowerCase().replace(/\\W+/g, "-") + '"><h2><span>' + c.title + ' <span class="n">' + (list.length || "") + '</span></span>' + add + '</h2>' +
      (list.length ? list.map(card).join("") : '<div class="empty">' + (c.title == "Queued" ? "Nothing waiting" : "None") + '</div>') + '</section>';
  }).join("");
  if (openId != null) renderDialog();
}

function renderInfo() {
  if (!info) return;
  const vms = info.vms.runner == "docker" ? "VMs: Docker" : info.vms.runner == "sim" ? "VMs: simulated" : info.vms.runner ? "VMs: " + info.vms.runner : "No VMs";
  $("pills").innerHTML = '<span class="pill ' + (info.vms.runner ? "on" : "off") + '" title="' + esc(info.vms.why || "Where each task's VM runs") + '">' + esc(vms) + '</span>' +
    '<button class="pill ' + (info.claude.signedIn ? "on" : "off") + '" id="claude-pill" data-act="claude">' + (info.claude.signedIn ? "Claude: signed in" : "Claude: not signed in") + '</button>';
  $("notice").hidden = info.enabled;
  render();
}

function renderDialog() {
  const t = tasks.find((x) => x.id == openId);
  const d = $("dlg");
  if (!t) { d.close(); return; }
  const shots = t.screenshots.map((s) => '<figure><img src="/api/factory/shots/' + esc(s.file) + '" alt=""><figcaption>' + esc(s.caption) + '</figcaption></figure>').join("");
  const log = t.log.map((l) => '<div><time>' + new Date(l.at).toLocaleTimeString() + '</time>' + esc(l.message) + '</div>').join("");
  const revisable = ["complete", "failed"].includes(t.status);
  const keep = d.querySelector("#instructions")?.value || "";
  d.innerHTML = '<div class="dlg"><div class="dlg-head"><h3><span class="id">#' + t.id + '</span>' + esc(t.title) + ' <span class="status ' + t.status + '">' + (t.status == "complete" ? "ready to merge" : t.status) + '</span></h3><button data-act="close">Close</button></div>' +
    '<div class="links">' + (t.url && t.status != "merged" ? '<a href="/api/factory/tasks/' + t.id + '/open" target="_blank">Open preview ↗</a><span class="muted">' + esc(t.url) + '</span>' : "") +
    '<span class="branch">' + esc(t.branch) + (t.base ? " from staging at " + esc(t.base.slice(0, 10)) : "") + '</span>' +
    (t.mergeCommit ? '<span class="muted">merged as ' + esc(t.mergeCommit.slice(0, 10)) + '</span>' : "") + (t.vm ? '<span class="muted">VM ' + esc(t.vm) + '</span>' : "") + '</div>' +
    actions(t, true) +
    (t.error ? '<section><h4>Error</h4><div class="text" style="color:var(--bad)">' + esc(t.error) + '</div></section>' : "") +
    (t.summary ? '<section><h4>Summary</h4><div class="text">' + esc(t.summary) + '</div></section>' : "") +
    '<section><h4>The ask</h4><div class="text">' + esc(t.description) + '</div></section>' +
    (revisable ? '<section><h4>More instructions</h4><textarea id="instructions" placeholder="What Claude Code should change next">' + esc(keep) + '</textarea><div class="row"><span class="why" id="revise-why"></span><button class="primary" data-act="revise" data-id="' + t.id + '">Send to Claude Code</button></div></section>' : "") +
    (shots ? '<section><h4>Screenshots</h4><div class="shots">' + shots + '</div></section>' : "") +
    '<section><h4>Log</h4><div class="log" id="log">' + log + '</div></section></div>';
  const l = $("log"); if (l) l.scrollTop = l.scrollHeight;
  if (!d.open) d.showModal();
}

function newTask() {
  const d = $("form");
  d.innerHTML = '<form class="dlg" id="new-form" method="dialog"><div class="dlg-head"><h3>New task</h3></div>' +
    '<label for="t-title">Title</label><input id="t-title" required maxlength="200" placeholder="Short and imperative: Add a dark theme to Documents">' +
    '<label for="t-desc">The ask</label><textarea id="t-desc" placeholder="What you want, in a few plain sentences, and any context Claude Code can\\'t find itself."></textarea>' +
    '<p class="fine">The factory makes the branch task/&lt;id&gt;-… from staging, starts a VM, and Claude Code does the work there' + (info && info.claude.signedIn ? "." : ". No Claude plan is signed in: a scripted stand-in makes a small change instead.") + '</p>' +
    '<div class="row"><span class="why" id="new-why"></span><button type="button" data-act="cancel">Cancel</button><button class="primary" id="create" type="submit">Add task</button></div></form>';
  d.showModal();
  $("t-title").focus();
  $("new-form").onsubmit = async (e) => {
    e.preventDefault();
    $("create").disabled = true;
    try {
      const t = await api("/tasks", { method: "POST", json: { title: $("t-title").value, description: $("t-desc").value } });
      upsert(t); d.close();
    } catch (err) { $("new-why").textContent = err.message; $("create").disabled = false; }
  };
}

function claudeDialog() {
  const d = $("form"), c = info.claude;
  d.innerHTML = '<form class="dlg" id="claude-form" method="dialog"><div class="dlg-head"><h3>Claude sign-in</h3></div>' +
    (c.signedIn ? '<p>A Claude plan is signed in' + (c.by ? " (by " + esc(c.by) + ", " + ago(c.at) + ")" : "") + '. Every VM uses it, for the claude command only.</p>' : '<p>Sign in once with your Claude plan (Pro or Max). Every VM then uses the token.</p>') +
    '<ol class="steps"><li>On any computer with Claude Code, run <code>claude setup-token</code>.</li><li>Sign in with your Claude plan in the browser it opens.</li><li>Paste the token it prints (<code>sk-ant-…</code>) here. It lasts one year.</li></ol>' +
    '<label for="c-token">Token</label><input id="c-token" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat01-…">' +
    '<p class="fine">The server keeps it encrypted, and shows it to nobody, this page included. It goes only to the claude command in a task\\'s VM. The task\\'s own code can read it there: see README, The factory, for the risks.' + (c.canStore ? "" : " <b>This server has no FACTORY_KEY, so it can't store a token.</b>") + '</p>' +
    '<div class="row"><span class="why" id="c-why"></span>' + (c.signedIn ? '<button type="button" class="danger" data-act="forget">Sign out</button>' : "") + '<button type="button" data-act="cancel">Cancel</button><button class="primary" id="c-save" type="submit">Save</button></div></form>';
  d.showModal();
  $("claude-form").onsubmit = async (e) => {
    e.preventDefault();
    try { info.claude = await api("/claude", { method: "PUT", json: { token: $("c-token").value } }); d.close(); renderInfo(); }
    catch (err) { $("c-why").textContent = err.message; }
  };
}

function upsert(t) {
  const i = tasks.findIndex((x) => x.id == t.id);
  if (i >= 0) tasks[i] = t; else tasks.push(t);
  render();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act], [data-open]");
  if (!el) { if (e.target.tagName == "DIALOG") e.target.close(); return; }
  if (el.dataset.open && !el.dataset.act) { openId = Number(el.dataset.open); renderDialog(); return; }
  e.stopPropagation();
  const id = Number(el.dataset.id), act = el.dataset.act;
  try {
    if (act == "close") { openId = null; $("dlg").close(); }
    else if (act == "cancel") $("form").close();
    else if (act == "new") newTask();
    else if (act == "claude") claudeDialog();
    else if (act == "forget") { info.claude = await api("/claude", { method: "DELETE" }); $("form").close(); renderInfo(); }
    else if (act == "arm") { armed.add(id); render(); setTimeout(() => { armed.delete(id); render(); }, 4000); }
    else if (act == "discard") { armed.delete(id); upsert(await api("/tasks/" + id + "/discard", { method: "POST" })); }
    else if (act == "merge") upsert(await api("/tasks/" + id + "/merge", { method: "POST" }));
    else if (act == "revise") upsert(await api("/tasks/" + id + "/revise", { method: "POST", json: { instructions: $("instructions").value } }));
  } catch (err) {
    if (act == "revise") $("revise-why").textContent = err.message; else alert(err.message);
  }
});
$("dlg").addEventListener("close", () => { openId = null; });

async function load() {
  [info, tasks] = await Promise.all([api(""), api("/tasks")]);
  renderInfo();
}
function connect() {
  const es = new EventSource("/api/factory/events");
  es.onopen = () => { $("live").classList.add("on"); $("live").textContent = "live"; load(); };
  es.onerror = () => { $("live").classList.remove("on"); $("live").textContent = "reconnecting"; };
  es.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type == "task") upsert(m.task); };
}
load().then(connect);
setInterval(render, 30000);
`;

export function factoryPage(opts: { enabled: boolean; dev: boolean }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory · Erga</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <nav class="crumbs"><a class="brand" href="/docs">Erga</a><span class="sep">›</span><a href="/admin">Admin</a><span class="sep">›</span><span class="here">Factory</span></nav>
  <span class="tag">Experimental</span>
  <span class="pill" id="live">connecting</span>
  <div class="pills" id="pills"></div>
</header>
<div class="notice" id="notice" ${opts.enabled ? "hidden" : ""}>The factory is off. An admin turns it on with the <code>factory</code> setting on <a href="/admin">Admin settings</a>.</div>
<main id="board"></main>
<dialog id="dlg"></dialog>
<dialog id="form" class="small"></dialog>
<script>${SCRIPT}</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
