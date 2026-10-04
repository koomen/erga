// The factory's board, /admin/factory (experimental): the local task
// queue's board (development/task-queue/index.html) inside Erga. Columns
// Queued, Working, Ready to merge, Merging and Merged; a card per task, its
// detail on a click (the ask, the summary, the preview, the branch, the log,
// the screenshots), with Merge, Discard and new instructions; live, over
// /api/factory/events. Dependencies between tasks as on the local board: a
// chip on the card ("waiting for #12"), blocked tasks at the bottom of
// Queued, Merge (and Start) off with the reason, and a Dependencies section
// in the detail view to add and remove them. The header says where the VMs run and whether a
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
  @media (max-width: 760px) { main { grid-template-columns: 1fr; padding: 8px 16px 16px; } header { padding: 12px 64px 8px 16px; } .pills { margin-left: 0; } .notice { margin: 4px 16px 8px; } }
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

  /* Dependencies (as on the local board): a chip on the card saying what it waits for; blocked queued cards sit back. */
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); background: var(--panel); white-space: nowrap; }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; }
  .chip.start { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .chip.stuck { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .chip.stuck::before { background: currentColor; }
  .card.blocked { background: color-mix(in srgb, var(--card) 55%, var(--panel)); border-style: dashed; box-shadow: none; }
  .card.blocked .title { color: var(--muted); }
  .actions .why { font-size: 11px; color: var(--muted); align-self: center; }
  .deps { display: grid; gap: 6px; }
  .dep { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 10px; background: var(--panel); border-radius: 6px; }
  .dep .kind { font-size: 11px; color: var(--muted); width: 84px; flex: none; }
  .dep a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); text-decoration: none; cursor: pointer; }
  .dep a:hover { text-decoration: underline; }
  .dep .status { font-size: 10px; padding: 3px 6px; }
  .dep .met { color: var(--ok); font-size: 12px; }
  .dep .x { border: 0; background: none; color: var(--muted); font-size: 15px; padding: 0 4px; cursor: pointer; }
  .dep .x:hover { color: var(--bad); }
  .dep-add { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  select { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 6px; padding: 4px 6px; max-width: 100%; }
  .dep-add select.which { flex: 1; min-width: 160px; }
  .deps-note { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .deps-note a { color: var(--accent); cursor: pointer; }
  .deps-note.bad { color: var(--bad); }
  .new-deps { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .new-deps select { width: 100%; font-size: 13px; padding: 6px; }
  @media (max-width: 560px) { .new-deps { grid-template-columns: 1fr; } }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); background: var(--ink); color: var(--bg); font-size: 13px; padding: 8px 14px; border-radius: 8px; box-shadow: var(--shadow); z-index: 10; }
`;

const SCRIPT = `
const COLUMNS = [
  { title: "Queued", statuses: ["queued"] },
  { title: "Working", statuses: ["working", "failed"] },
  { title: "Ready to merge", statuses: ["complete"] },
  { title: "Merging", statuses: ["merging"] },
  { title: "Merged", statuses: ["merged"] },
];
let tasks = [], info = null, openId = null, depError = null;
const STATUS = { queued: "queued", working: "working", complete: "ready to merge", merging: "merging", merged: "merged", failed: "failed", discarded: "discarded" };
const ids = (list) => list.map((id) => "#" + id).join(", ").replace(/, ([^,]*)$/, " and $1");
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

/**
 * Why Merge is off, or null: a dependency not merged yet. One that is merging (ahead of this one in the
 * merge queue) doesn't stop it: the factory checks again when this one's turn comes.
 */
function mergeBlocked(t) {
  const b = t.blockedBy;
  if (!b) return null;
  if (b.stuck.length) return b.reason[0].toUpperCase() + b.reason.slice(1);
  const notYet = b.merge.filter((id) => tasks.find((x) => x.id == id)?.status != "merging");
  return notYet.length ? "Can't merge until " + ids(notYet) + " merge" + (notYet.length == 1 ? "s" : "") : null;
}
/** The card's chip: what the task waits for, in a few words. */
function depChip(t) {
  const b = t.blockedBy;
  if (!b) return "";
  if (b.stuck.length) return '<span class="chip stuck" title="' + esc(b.reason) + '">blocked by ' + ids(b.stuck) + '</span>';
  if (b.start.length) return '<span class="chip start" title="' + esc(b.reason) + '">waiting for ' + ids(b.start) + '</span>';
  return '<span class="chip merge" title="' + esc(b.reason) + '">merges after ' + ids(b.merge) + '</span>';
}
const waitsToStart = (t) => t.status == "queued" && !!(t.blockedBy?.start.length || t.blockedBy?.stuck.length);

function actions(t, inDialog) {
  const b = [];
  if (t.url && !inDialog && !["merged", "discarded"].includes(t.status)) b.push('<a class="btn" href="/api/factory/tasks/' + t.id + '/open" target="_blank" onclick="event.stopPropagation()">Open preview</a>');
  if (t.status == "queued" && !t.vm) {
    const why = t.blockedBy?.start.length ? (t.blockedBy.stuck.length ? t.blockedBy.reason[0].toUpperCase() + t.blockedBy.reason.slice(1) : "Starts when " + ids(t.blockedBy.start) + " merge" + (t.blockedBy.start.length == 1 ? "s" : "")) : null;
    if (why) b.push('<button disabled title="' + esc(why) + '">Start</button><span class="why">' + esc(why) + '</span>');
    else if (t.starting) b.push('<button disabled><span class="spin"></span> Starting…</button>');
    else b.push('<button class="primary" data-act="start" data-id="' + t.id + '">Start</button>');
  }
  if (t.status == "complete") {
    const why = mergeBlocked(t);
    b.push(why ? '<button class="primary" disabled title="' + esc(why) + '">Merge</button><span class="why">' + esc(why) + '</span>' : '<button class="primary" data-act="merge" data-id="' + t.id + '">Merge</button>');
  }
  if (t.status == "merging") b.push('<button disabled><span class="spin"></span> ' + (t.log.at(-1)?.message.includes("waiting for") ? "Waiting to merge…" : "Merging…") + '</button>');
  if (!["merging", "merged", "discarded"].includes(t.status))
    b.push(armed.has(t.id) ? '<button class="confirm" data-act="discard" data-id="' + t.id + '">Discard branch?</button>' : '<button class="danger" data-act="arm" data-id="' + t.id + '">Discard</button>');
  return b.length ? '<div class="actions">' + b.join("") + '</div>' : "";
}

function card(t) {
  const last = t.log[t.log.length - 1];
  const thumbs = t.screenshots.slice(-3).map((s) => '<img src="/api/factory/shots/' + esc(s.file) + '" alt="' + esc(s.caption) + '" loading="lazy">').join("");
  return '<div class="card ' + t.status + (waitsToStart(t) ? " blocked" : "") + '" data-open="' + t.id + '">' +
    '<div class="top"><span class="id">#' + t.id + '</span><span class="title">' + esc(t.title) + '</span></div>' +
    '<div class="meta">' + depChip(t) + '<code>' + esc(t.branch) + '</code><span>' + (t.status == "merged" ? "merged " + ago(t.mergedAt) : ago(t.updatedAt)) + '</span>' + (t.status == "failed" ? "<span>failed</span>" : "") + '</div>' +
    (t.error ? '<div class="err">' + esc(t.error) + '</div>' : last && t.status != "merged" && !waitsToStart(t) ? '<div class="last">' + esc(last.message) + '</div>' : "") +
    (thumbs && t.status != "merged" ? '<div class="thumbs">' + thumbs + '</div>' : "") +
    actions(t, false) + '</div>';
}

function render() {
  $("board").innerHTML = COLUMNS.map((c) => {
    let list = tasks.filter((t) => c.statuses.includes(t.status));
    list.sort((a, b) => (b.mergedAt || b.updatedAt).localeCompare(a.mergedAt || a.updatedAt));
    if (c.title == "Merged") list = list.slice(0, 20);
    // Queued: the ones that can start first; the ones waiting on others below them.
    if (c.title == "Queued") list.sort((a, b) => waitsToStart(a) - waitsToStart(b));
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
    depsSection(t) +
    (t.summary ? '<section><h4>Summary</h4><div class="text">' + esc(t.summary) + '</div></section>' : "") +
    '<section><h4>The ask</h4><div class="text">' + esc(t.description) + '</div></section>' +
    (revisable ? '<section><h4>More instructions</h4><textarea id="instructions" placeholder="What Claude Code should change next">' + esc(keep) + '</textarea><div class="row"><span class="why" id="revise-why"></span><button class="primary" data-act="revise" data-id="' + t.id + '">Send to Claude Code</button></div></section>' : "") +
    (shots ? '<section><h4>Screenshots</h4><div class="shots">' + shots + '</div></section>' : "") +
    '<section><h4>Log</h4><div class="log" id="log">' + log + '</div></section></div>';
  const l = $("log"); if (l) l.scrollTop = l.scrollHeight;
  if (!d.open) d.showModal();
}

/**
 * The detail view's Dependencies: what the task starts and merges after (each a link to that task, with its
 * status, and × to remove it), the tasks that wait on this one, and a way to add one. Not while merging or done.
 */
function depsSection(t) {
  const editable = !["merging", "merged", "discarded"].includes(t.status) && info && info.enabled;
  const rows = [...(t.startAfter || []).map((id) => ["startAfter", id]), ...(t.mergeAfter || []).map((id) => ["mergeAfter", id])];
  const needed = tasks.filter((x) => !["merged", "discarded"].includes(x.status) && ((x.startAfter || []).includes(t.id) || (x.mergeAfter || []).includes(t.id)));
  if (!rows.length && !needed.length && !editable) return "";
  const row = ([kind, id]) => {
    const d = tasks.find((x) => x.id == id);
    return '<div class="dep"><span class="kind">' + (kind == "startAfter" ? "Starts after" : "Merges after") + '</span><a data-open="' + id + '" title="Open #' + id + '"><span class="id">#' + id + '</span> ' + esc(d ? d.title : "(unknown task)") + '</a>' +
      (d && d.status == "merged" ? '<span class="met" title="Merged: met">✓ merged</span>' : '<span class="status ' + (d ? d.status : "") + '">' + (d ? STATUS[d.status] : "gone") + '</span>') +
      (editable ? '<button class="x" data-act="undep" data-id="' + t.id + '" data-kind="' + kind + '" data-dep="' + id + '" title="Remove this dependency" aria-label="Remove this dependency">×</button>' : "") + '</div>';
  };
  const taken = new Set([t.id, ...(t.startAfter || []), ...(t.mergeAfter || [])]);
  const options = tasks.filter((x) => !taken.has(x.id) && x.status != "discarded" && x.status != "merged").sort((a, b) => b.id - a.id);
  const add = editable && options.length ? '<div class="dep-add"><select id="dep-kind" aria-label="Kind of dependency"><option value="startAfter">Start after</option><option value="mergeAfter">Merge after</option></select><select id="dep-id" class="which" aria-label="Task">' + options.map((x) => '<option value="' + x.id + '">#' + x.id + ' ' + esc(x.title) + '</option>').join("") + '</select><button data-act="dep" data-id="' + t.id + '">Add</button></div>' : "";
  const b = t.blockedBy;
  return '<section><h4>Dependencies</h4>' +
    (b ? '<div class="deps-note' + (b.stuck.length ? " bad" : "") + '" style="margin:0 0 6px">' + esc(b.reason[0].toUpperCase() + b.reason.slice(1)) + '</div>' : "") +
    (rows.length ? '<div class="deps">' + rows.map(row).join("") + '</div>' : '<div class="deps-note" style="margin:0">None: it can start and merge on its own.</div>') +
    (needed.length ? '<div class="deps-note">Needed by ' + needed.map((x) => '<a data-open="' + x.id + '">#' + x.id + ' ' + esc(x.title) + '</a>').join(", ") + '</div>' : "") +
    add + (depError && depError.id == t.id ? '<div class="deps-note bad" id="dep-why">' + esc(depError.msg) + '</div>' : "") + '</section>';
}

async function setDeps(id, changes) {
  try { upsert(await api("/tasks/" + id, { method: "PATCH", json: changes })); depError = null; }
  catch (err) { depError = { id, msg: err.message }; }
  if (openId == id) renderDialog();
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function newTask() {
  const d = $("form");
  d.innerHTML = '<form class="dlg" id="new-form" method="dialog"><div class="dlg-head"><h3>New task</h3></div>' +
    '<label for="t-title">Title</label><input id="t-title" required maxlength="200" placeholder="Short and imperative: Add a dark theme to Documents">' +
    '<label for="t-desc">The ask</label><textarea id="t-desc" placeholder="What you want, in a few plain sentences, and any context Claude Code can\\'t find itself."></textarea>' +
    newDeps() +
    '<p class="fine">The factory makes the branch task/&lt;id&gt;-… from staging, starts a VM, and Claude Code does the work there' + (info && info.claude.signedIn ? "." : ". No Claude plan is signed in: a scripted stand-in makes a small change instead.") + '</p>' +
    '<div class="row"><span class="why" id="new-why"></span><button type="button" data-act="cancel">Cancel</button><button class="primary" id="create" type="submit">Add task</button></div></form>';
  d.showModal();
  $("t-title").focus();
  $("new-form").onsubmit = async (e) => {
    e.preventDefault();
    $("create").disabled = true;
    try {
      const json = { title: $("t-title").value, description: $("t-desc").value };
      if ($("t-start") && $("t-start").value) json.startAfter = [Number($("t-start").value)];
      if ($("t-merge") && $("t-merge").value) json.mergeAfter = [Number($("t-merge").value)];
      const t = await api("/tasks", { method: "POST", json });
      upsert(t); d.close();
    } catch (err) { $("new-why").textContent = err.message; $("create").disabled = false; }
  };
}

/** The new-task form's dependencies: one task to start after and one to merge after (more in the detail view). */
function newDeps() {
  const open = tasks.filter((x) => !["merged", "discarded"].includes(x.status)).sort((a, b) => b.id - a.id);
  if (!open.length) return "";
  const opts = '<option value="">None</option>' + open.map((x) => '<option value="' + x.id + '">#' + x.id + ' ' + esc(x.title) + '</option>').join("");
  return '<div class="new-deps"><div><label for="t-start">Start after</label><select id="t-start">' + opts + '</select></div><div><label for="t-merge">Merge after</label><select id="t-merge">' + opts + '</select></div></div>' +
    '<p class="fine">Start after: no VM until that task is merged; then it starts by itself. Merge after: it works now, but Merge stays off until that task is merged.</p>';
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
    else if (act == "start") { el.disabled = true; upsert(await api("/tasks/" + id + "/start", { method: "POST" })); }
    else if (act == "dep" || act == "undep") {
      const t = tasks.find((x) => x.id == id);
      const kind = act == "dep" ? $("dep-kind").value : el.dataset.kind;
      const dep = Number(act == "dep" ? $("dep-id").value : el.dataset.dep);
      const now = t[kind] || [];
      el.disabled = true;
      await setDeps(id, { [kind]: act == "dep" ? [...now, dep] : now.filter((x) => x != dep) });
    }
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
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type == "task") upsert(m.task);
    else if (m.type == "unblocked" || m.type == "blocked") toast("#" + m.id + " " + m.type + ": " + m.title + " (" + m.why.split(":")[0] + ")");
  };
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
<div id="toast" role="status" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
