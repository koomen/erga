// The factory's board (experimental), a part of /admin/factory (source/page.ts,
// which puts it beside the source dashboard and the factory's agent). Columns
// Queued, Working, Ready to merge and Merging (with "needs agent": a merge the task's Claude Code
// is finishing, Merge off, with the reason; merged tasks leave the board, and the Factory page
// shows staging); a card per task, its
// detail on a click (the ask, the summary, the preview, the branch, the log,
// the screenshots, at the top in a grid, a click to enlarge one, the arrow keys for the previous and next one, Escape to shrink it), with Merge, Discard and new instructions; live, over
// /api/factory/events. Dependencies between tasks as on the local board: a
// chip on the card ("waiting for #12"), blocked tasks at the bottom of
// Queued, Merge off with the reason (a task starts by itself: no Start), and a Dependencies section
// in the detail view to add and remove them. The pane's head says where the VMs run and whether a
// Claude plan is signed in, and signs one in (a `claude setup-token` token).
//
// The parts: BOARD_STYLE (scoped to the board's pane by source/page.ts, in Erga's own colours),
// boardMarkup and BOARD_SCRIPT. The script tells the page's agent panel which task is open
// (window.ergaBoard).

import { STALL_MS } from "./stall";

export const BOARD_STYLE = `
  :root { --ink: var(--fg-strong); --muted: var(--soft); --line: var(--rule); --card: var(--bg); --panel: color-mix(in srgb, var(--chrome) 9%, var(--bg));
    --accent: var(--caret); --ok: #1f7a4d; --warn: #b26a00; --bad: #b3261e; --shadow: 0 1px 2px rgba(0,0,0,.05); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ok: #4cc38a; --warn: #f0a742; --bad: #ff7b72; --shadow: 0 1px 2px rgba(0,0,0,.4); } }
  :root[data-theme="dark"] { --ok: #4cc38a; --warn: #f0a742; --bad: #ff7b72; --shadow: 0 1px 2px rgba(0,0,0,.4); }
  .pills { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
  .pill { height: 26px; font-size: 12px; font-weight: 500; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 0; padding: 0; background: none; box-shadow: none; }
  .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .pill.on::before { background: var(--ok); } .pill.off::before { background: var(--bad); }
  .pill.pushing::before { width: 5px; height: 5px; background: transparent; border: 2px solid var(--ok); border-right-color: transparent; animation: pill-spin .8s linear infinite; }
  @keyframes pill-spin { to { transform: rotate(360deg); } }
  button.pill { cursor: pointer; font: inherit; font-size: 12px; } button.pill:hover { color: var(--ink); }
  .notice { margin: 0 0 10px; padding: 10px 14px; border-radius: 8px; background: var(--panel); color: var(--muted); font-size: 13px; }
  .notice a { color: var(--accent); }
  .board { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; align-items: start; }
  @media (max-width: 900px) { .board { grid-template-columns: repeat(2, minmax(160px, 1fr)); } }
  @media (max-width: 560px) { .board { grid-template-columns: 1fr; } .col { min-height: 0; } }
  .col { background: var(--panel); border-radius: 10px; padding: 10px; min-height: 120px; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 2px 4px 10px; min-height: 26px; display: flex; justify-content: space-between; align-items: center; }
  .col h2 button { text-transform: none; letter-spacing: 0; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 4px; border: 0; text-align: left; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px; margin-bottom: 6px; min-width: 0; box-shadow: var(--shadow); cursor: pointer; }
  .card:hover { border-color: var(--muted); }
  .card.failed { border-left: 3px solid var(--bad); }
  .card.merging { border-left: 3px solid var(--warn); }
  .card.needs-agent { border-left: 3px solid var(--bad); }
  .card .agent-now { margin-top: 2px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
  .id { color: var(--muted); font: 11px ui-monospace, monospace; flex: none; }
  .title { font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
  .card .title { font-size: 13px; }
  /* On the card's title line: failed or needs agent, and the last update as a short time ("5m"). */
  .when { flex: none; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .flag { flex: none; color: var(--bad); font-size: 11px; font-weight: 600; }
  /* Stalled (factory/stall.ts): working or needs agent, and no new log line in 5 minutes. Not "blocked", which is a dependency. */
  .stalled-badge { flex: none; color: var(--warn); font-size: 11px; font-weight: 600; border: 1px solid currentColor; border-radius: 999px; padding: 1px 6px; line-height: 14px; white-space: nowrap; }
  h3 .stalled-badge { font-size: 11px; vertical-align: 2px; }
  .card.stalled { border-left: 3px solid var(--warn); }
  .stalled-note { color: var(--warn); font-size: 13px; margin-top: 8px; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); border-radius: 6px; }
  .last { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .last .chip { margin-right: 6px; vertical-align: 1px; }
  .err { color: var(--bad); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .thumbs { display: flex; gap: 4px; margin-top: 4px; overflow: hidden; }
  .thumbs img { height: 40px; border-radius: 4px; border: 1px solid var(--line); object-fit: cover; max-width: 72px; }
  .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  .actions [data-btn="merge"] { margin-left: auto; }
  /* On a card, only the steps that work (see actions): small buttons at their own width, the main step (or a spinner)
     on the right. They wrap to a second row rather than squeeze, so a label never overflows. */
  .card .actions { gap: 4px; margin-top: 4px; }
  .card .actions > * { flex: none; font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 5px; white-space: nowrap; }
  .card .actions > .primary, .card .actions > .busy { margin-left: auto; }
  .card .actions > .primary { font-weight: 600; }
  .busy { display: inline-flex; align-items: center; gap: 6px; color: var(--warn); font-weight: 500; }
  .card .actions > .busy { padding: 1px 0; }
  button, .btn { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 6px; padding: 4px 10px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
  button:hover, .btn:hover { border-color: var(--muted); }
  button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) button.primary:not(:disabled), :root:not([data-theme="light"]) .btn.primary { color: #0d1218; } }
  :root[data-theme="dark"] button.primary:not(:disabled), :root[data-theme="dark"] .btn.primary { color: #0d1218; }
  button.danger { color: var(--bad); }
  button.danger[data-act="arm"] { color: var(--ink); }
  button.confirm { background: var(--bad); border-color: var(--bad); color: #fff; }
  /* Off: no fill, a dashed border and faint text, so it can't pass for a button that works. */
  button:disabled, button.primary:disabled, button.danger:disabled { background: transparent; border-style: dashed; border-color: var(--line); color: var(--muted); opacity: .6; cursor: not-allowed; }
  button:disabled:hover { border-color: var(--line); }
  .spin { display: inline-block; flex: none; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid var(--warn); border-right-color: transparent; border-radius: 50%; animation: s .8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  dialog { border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); width: min(900px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 0; font-size: 14px; }
  dialog h3 { color: var(--ink); }
  dialog.small { width: min(560px, calc(100vw - 32px)); }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .dlg { padding: 18px 22px 22px; }
  .dlg-head { display: flex; align-items: flex-start; gap: 12px; }
  .dlg h3 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .status { font: 600 11px/1 ui-sans-serif, -apple-system, sans-serif; text-transform: uppercase; letter-spacing: .05em; padding: 4px 8px; border-radius: 999px; border: 1px solid currentColor; color: var(--muted); white-space: nowrap; }
  .status.working { color: var(--accent); } .status.complete, .status.merged { color: var(--ok); } .status.merging { color: var(--warn); } .status.failed, .status.needs-agent { color: var(--bad); }
  .links { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin-top: 8px; font-size: 13px; }
  .links a { color: var(--accent); text-decoration: none; } .links a:hover { text-decoration: underline; }
  .links .muted { color: var(--muted); font-size: 12px; }
  .dlg section { margin-top: 18px; }
  .dlg h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--panel); border-radius: 8px; padding: 10px 12px; font-size: 14px; line-height: 1.5; }
  .shots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .shots figure { margin: 0; min-width: 0; cursor: zoom-in; } .shots img { display: block; width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  .shots figure:not(.big) img { aspect-ratio: 16 / 10; object-fit: cover; object-position: top; }
  .shots figure.big { grid-column: 1 / -1; grid-row: 1; cursor: zoom-out; }
  .shots figure.big img { max-height: calc(100vh - 140px); object-fit: contain; background: var(--panel); }
  .shots figure:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
  .shots figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .log { font: 12px/1.5 ui-monospace, monospace; max-height: 260px; overflow: auto; background: var(--panel); border-radius: 6px; padding: 8px 10px; }
  .log div { white-space: pre-wrap; overflow-wrap: anywhere; } .log time { color: var(--muted); margin: 0 8px 0 0; font-size: inherit; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input, textarea { flex: none; width: 100%; font: inherit; font-size: 14px; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; align-items: center; }
  .row .why { color: var(--bad); font-size: 12px; margin-right: auto; }
  .row .why.sent { color: var(--muted); }
  .dlg .hint { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
  ol.steps { margin: 8px 0 0; padding-left: 1.3em; color: var(--ink); } ol.steps li { margin: 4px 0; }
  code { font: 12px ui-monospace, monospace; background: var(--panel); border-radius: 4px; padding: 1px 4px; }
  .fine { color: var(--muted); font-size: 12px; margin-top: 10px; }

  /* Dependencies (as on the local board): a chip on the card saying what it waits for; blocked queued cards sit back. */
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); background: var(--panel); white-space: nowrap; }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; }
  .chip.start { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .chip.stuck { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .chip.stuck::before { background: currentColor; }
  /* A local task (no VM: a local agent runs it): a chip with its machine, on the card's top line. */
  .chip.local { flex: 0 1 auto; min-width: 0; max-width: 130px; overflow: hidden; text-overflow: ellipsis; color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .chip.local::before { border-radius: 2px; flex: none; }
  .card.blocked { background: color-mix(in srgb, var(--card) 55%, var(--panel)); border-style: dashed; box-shadow: none; }
  .card.blocked .title { color: var(--muted); }
  .actions-why { font-size: 11px; color: var(--muted); margin-top: 4px; }
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
  select { appearance: auto; font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 6px; padding: 4px 6px; max-width: 100%; }
  .dep-add select.which { flex: 1; min-width: 160px; }
  .deps-note { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .deps-note a { color: var(--accent); cursor: pointer; }
  .deps-note.bad { color: var(--bad); }
  .new-deps { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .new-deps select { width: 100%; font-size: 13px; padding: 6px; }
  @media (max-width: 560px) { .new-deps { grid-template-columns: 1fr; } }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); background: var(--ink); color: var(--bg); font-size: 13px; padding: 8px 14px; border-radius: 8px; box-shadow: var(--shadow); z-index: 30; }
`;

export const BOARD_SCRIPT = `
(() => {
// The admin pages are one page (src/page/admin-nav.ts): what keeps running stops when another admin page is shown.
const pageView = window.ergaView;
const setInterval = (f, ms) => { const t = window.setInterval(f, ms); pageView.onLeave(() => clearInterval(t)); return t; };
const COLUMNS = [
  { title: "Queued", statuses: ["queued"] },
  { title: "Working", statuses: ["working", "failed"] },
  { title: "Ready to merge", statuses: ["complete"] },
  { title: "Merging", statuses: ["merging", "needs agent"] },
];
let tasks = [], info = null, openId = null, depError = null, bigShot = null, live = "connecting";
const showLive = () => { const el = $("live"); if (el) { el.textContent = live; el.classList.toggle("on", live == "live"); } };
const STATUS = { queued: "queued", working: "working", complete: "ready to merge", merging: "merging", "needs agent": "needs agent", merged: "merged", failed: "failed", discarded: "discarded" };
/** A status as a class name ("needs agent": needs-agent). */
const cls = (s) => String(s || "").replace(/ /g, "-");
const ids = (list) => list.map((id) => "#" + id).join(", ").replace(/, ([^,]*)$/, " and $1");
const armed = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : new Date(iso).toLocaleDateString(); };
/** A short time since, for a card: "now", "5m", "3h", "2d", then the date. */
const short = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : s < 7 * 86400 ? Math.floor(s / 86400) + "d" : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
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
/**
 * How long the task's log has been quiet, in ms, if it is stalled: working or needs agent, and no new log line in
 * ${STALL_MS / 60000} minutes (factory/stall.ts, which the API's stalled is). Computed here, again on each redraw (every 30 s), so the
 * badge shows up while no event arrives, and clears with the event that brings a new log line.
 */
const stalledMs = (t) => {
  if (t.status != "working" && t.status != "needs agent") return 0;
  const ms = Date.now() - new Date(t.log.at(-1)?.at ?? t.updatedAt);
  return ms >= ${STALL_MS} ? ms : 0;
};
const quiet = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : ""); };
const stalledTip = (t, ms) => "No new log line for " + quiet(ms) + ", since " + new Date(t.log.at(-1)?.at ?? t.updatedAt).toLocaleTimeString() + "." +
  (t.local ? " The local agent may be gone (its machine asleep, say), or in one long step. Hand to a VM goes on from what it pushed." : " Claude Code may be hung, or in one long step.");
/** A local task's runner: who, on which machine. */
const runsWhere = (t) => t.local.by + " on " + t.local.machine;
const localChip = (t) => t.local ? '<span class="chip local" title="' + esc("A local task: no VM. " + runsWhere(t) + " runs it, and reports with the task command.") + '">local · ' + esc(t.local.machine) + '</span>' : "";
function stalledBadge(t) {
  const ms = stalledMs(t);
  return ms ? '<span class="stalled-badge" title="' + esc(stalledTip(t, ms)) + '">stalled ' + quiet(ms) + '</span>' : "";
}
const waitsToStart = (t) => t.status == "queued" && !!(t.blockedBy?.start.length || t.blockedBy?.stuck.length);

/**
 * The task's buttons. No Start: a task starts by itself, when it is added or when the tasks it waits for merge.
 * In the detail view (inDialog), all four, in one order: Preview, Restart, Discard, Merge
 * (on the right); one that doesn't apply to its status is off, and its tooltip and the line under them say why. An
 * off button has no data-act: it does nothing, and [data-act="…"] finds the buttons that work.
 * On a card, only the ones that work, the task's main step (Merge, or else Preview) filled and on the right,
 * and no off ones: the card's chip, flag or error says why a step waits. Restart is in the detail view only while the
 * task is ready to merge or merging, where it is rarely the next step. A running start or merge shows as a spinner.
 */
function actions(t, inDialog) {
  const off = (key, label, why, cls) => ({ key, html: '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-btn="' + key + '" disabled title="' + esc(why) + '">' + label + '</button>' });
  const on = (key, label, title, cls) => ({ key, on: true, html: (main) => '<button' + (cls || main ? ' class="' + [cls, main && "primary"].filter(Boolean).join(" ") + '"' : "") + ' data-btn="' + key + '" data-act="' + key + '" data-id="' + t.id + '"' + (title ? ' title="' + esc(title) + '"' : "") + '>' + label + '</button>' });
  const busy = (key, label, title, cls) => ({ key, busy: label, html: '<button' + (cls ? ' class="' + cls + '"' : "") + ' data-btn="' + key + '" disabled title="' + title + '"><span class="spin"></span> ' + label + '</button>' });
  const done = ["merged", "discarded"].includes(t.status);
  const gone = t.status == "merged" ? "The task is merged" : "The task is discarded";
  const b = [];
  // In the detail view, why the next step waits (a queued task's start, or Merge), under the buttons.
  let note = null;

  if (t.url && !done) b.push({ key: "preview", on: true, html: (main) => '<a class="btn' + (main ? " primary" : "") + '" data-btn="preview" href="/api/factory/tasks/' + t.id + '/open" target="_blank" title="Open the preview" onclick="event.stopPropagation()">Preview</a>' });
  else b.push(off("preview", "Preview", done ? gone + ": its preview is gone" : t.status == "queued" ? "No preview yet: the task hasn't started" : "No preview yet: Claude Code starts one when there's something to see"));

  // A queued task: why it waits (under the buttons), or a spinner while its VM starts.
  if (t.status == "queued" && !t.vm) {
    const why = t.blockedBy?.start.length ? (t.blockedBy.stuck.length ? t.blockedBy.reason[0].toUpperCase() + t.blockedBy.reason.slice(1) : "Starts when " + ids(t.blockedBy.start) + " merge" + (t.blockedBy.start.length == 1 ? "s" : "")) : null;
    if (why) note = why;
    else if (t.starting) b.push({ key: "start", busy: "Starting…", html: '<span class="busy" data-btn="start" title="The VM is starting"><span class="spin"></span>Starting…</span>' });
  }

  // Restart: any time once the task has run (working, merging and stuck too): its VM saves the work, then a fresh one starts.
  if (!done && !(t.status == "queued" && !t.vm)) {
    const why = t.blockedBy?.start.length ? "Can't restart until " + ids(t.blockedBy.start) + " merge" + (t.blockedBy.start.length == 1 ? "s" : "") : null;
    const stops = t.local ? "Stop waiting for " + runsWhere(t) + ": a fresh VM's Claude Code goes on from what it pushed to the branch, and its reports are refused from then on"
      : t.status == "working" ? "Stop Claude Code, save its work on the branch, and start it again in a fresh VM"
      : ["merging", "needs agent"].includes(t.status) ? "Stop the merge and Claude Code, save the work on the branch, and start the task again in a fresh VM"
      : "Run the task again on its branch, in a fresh VM";
    const label = t.local ? "Hand to a VM" : "Restart";
    b.push(why ? off("restart", label, why) : on("restart", label, stops));
  } else if (t.local && !done && !t.blockedBy?.start.length) b.push(on("restart", "Hand to a VM", "Hand the task to a VM: it starts in a fresh VM when nothing blocks it, and the local agent's reports are refused"));
  else b.push(off("restart", "Restart", done ? gone : "The task hasn't run yet"));

  if (!["merging", ...(done ? [t.status] : [])].includes(t.status))
    b.push({ key: "discard", on: true, html: () => armed.has(t.id) ? '<button class="confirm" data-btn="discard" data-act="discard" data-id="' + t.id + '">Discard branch?</button>' : '<button class="danger" data-btn="discard" data-act="arm" data-id="' + t.id + '" title="Delete the branch and stop the VM">Discard</button>' });
  else b.push(off("discard", "Discard", done ? gone : "The task is merging", "danger"));

  if (t.status == "complete") {
    const why = mergeBlocked(t);
    if (why) { b.push(off("merge", "Merge", why, "primary")); note = why; }
    else b.push(on("merge", "Merge", "Merge the branch into staging", "primary"));
  } else if (t.status == "needs agent") {
    b.push(off("merge", "Merge", t.local ? "The local agent is finishing the merge" : "Claude Code is finishing the merge", "primary"));
    note = t.local ? "Needs agent: " + runsWhere(t) + " is told to finish the merge in its checkout (task inbox); the merge then goes on by itself. Or hand the task to a VM"
      : "Needs agent: the task’s Claude Code is finishing the merge, which then goes on by itself";
  } else if (t.status == "merging") b.push(busy("merge", t.log.at(-1)?.message.includes("waiting for") ? "Waiting…" : "Merging…", "The merge is running", "primary"));
  else b.push(off("merge", "Merge", done ? gone : t.status == "failed" ? "The task failed: restart it, or send more instructions" : "The task isn't ready to merge yet", "primary"));

  const html = (x, main) => typeof x.html == "function" ? x.html(main) : x.html;
  if (inDialog) return '<div class="actions">' + b.map((x) => html(x, false)).join("") + '</div>' + (note ? '<div class="why actions-why">' + esc(note) + '</div>' : "");

  const quiet = ["complete", "merging"].includes(t.status) ? ["restart"] : [];
  const shown = b.filter((x) => x.on && !quiet.includes(x.key));
  const spin = b.find((x) => x.busy);
  // A running start or merge is the main step: the spinner takes its place.
  const main = spin ? null : ["merge", "preview"].map((k) => shown.find((x) => x.key == k)).find(Boolean);
  const rest = shown.filter((x) => x != main).map((x) => html(x, false));
  const end = spin ? '<span class="busy" data-btn="' + spin.key + '" title="' + (spin.key == "merge" ? "The merge is running" : "The VM is starting") + '"><span class="spin"></span>' + spin.busy + '</span>' : main ? html(main, true) : "";
  return rest.length || end ? '<div class="actions">' + rest.join("") + end + '</div>' : "";
}

function card(t) {
  const last = t.log[t.log.length - 1];
  const when = t.status == "merged" && t.mergedAt ? t.mergedAt : t.updatedAt;
  const thumbs = t.screenshots.slice(-3).map((s) => '<img src="/api/factory/shots/' + esc(s.file) + '" alt="' + esc(s.caption) + '" loading="lazy">').join("");
  return '<div class="card ' + cls(t.status) + (waitsToStart(t) ? " blocked" : "") + (stalledMs(t) ? " stalled" : "") + '" data-open="' + t.id + '">' +
    '<div class="top"><span class="id">#' + t.id + '</span><span class="title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' +
    localChip(t) + (t.status == "failed" ? '<span class="flag">failed</span>' : t.status == "needs agent" ? '<span class="flag">needs agent</span>' : "") + stalledBadge(t) +
    '<span class="when" title="' + esc((when == t.mergedAt ? "Merged " : "Last update ") + new Date(when).toLocaleString()) + '">' + short(when) + '</span></div>' +
    (t.error ? (depChip(t) ? '<div class="last">' + depChip(t) + '</div>' : "") + '<div class="err" title="' + esc(t.error) + '">' + esc(t.error) + '</div>' + (t.status == "needs agent" && last ? '<div class="agent-now" title="' + esc(last.message) + '">Now: ' + esc(last.message) + '</div>' : "")
      : depChip(t) || (last && t.status != "merged") ? '<div class="last"' + (last ? ' title="' + esc(last.message) + '"' : "") + '>' + depChip(t) + (last && t.status != "merged" && !waitsToStart(t) ? esc(last.message) : "") + '</div>' : "") +
    (thumbs && t.status != "merged" ? '<div class="thumbs">' + thumbs + '</div>' : "") +
    actions(t, false) + '</div>';
}

function render() {
  $("board").innerHTML = COLUMNS.map((c) => {
    let list = tasks.filter((t) => c.statuses.includes(t.status));
    // A stable order, by id (oldest first): a card moves only when its status changes, not as its task logs progress.
    list.sort((a, b) => a.id - b.id);
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
  const mirror = $("mirror-pill");
  const vms = info.vms.runner == "docker" ? "VMs: Docker" : info.vms.runner == "sim" ? "VMs: simulated" : info.vms.runner ? "VMs: " + info.vms.runner : "No VMs";
  $("pills").innerHTML = '<span class="pill" id="live">' + ($("live")?.textContent || "connecting") + '</span>' + '<span class="pill ' + (info.vms.runner ? "on" : "off") + '" title="' + esc(info.vms.why || "Where each task's VM runs") + '">' + esc(vms) + '</span>' +
    '<button class="pill ' + (info.claude.signedIn ? "on" : "off") + '" id="claude-pill" data-act="claude">' + (info.claude.signedIn ? "Claude: signed in" : "Claude: not signed in") + '</button>';
  // The fourth status, the GitHub mirror: the source pane's script keeps it up to date.
  if (mirror) $("pills").append(mirror);
  showLive();
  $("notice").hidden = info.enabled;
  render();
}

function renderDialog() {
  const t = tasks.find((x) => x.id == openId);
  const d = $("dlg");
  if (!t) { d.close(); return; }
  // Click a screenshot to enlarge it to the modal's width (on the first row), again to put it back in the grid.
  // The arrow keys go to the previous and next one, enlarged or not (see shotKey).
  const shots = t.screenshots.map((s) => '<figure data-act="shot" data-file="' + esc(s.file) + '" tabindex="0" role="button"' + (s.file == bigShot ? ' class="big"' : "") + ' title="' + (s.file == bigShot ? "Click or Escape to shrink" : "Click to enlarge") + ', arrow keys for the others"><img src="/api/factory/shots/' + esc(s.file) + '" alt=""><figcaption>' + esc(s.caption) + '</figcaption></figure>').join("");
  const log = t.log.map((l) => '<div><time>' + new Date(l.at).toLocaleTimeString() + '</time>' + esc(l.message) + '</div>').join("");
  // A working task takes them too: its Claude Code gets them when its current step ends.
  const revisable = ["complete", "failed", "working"].includes(t.status);
  const working = t.status == "working";
  const keep = d.querySelector("#instructions")?.value || "";
  // A redraw of the open task (a live update) keeps what the user is doing in it: see keepState.
  const restore = d.open && d.dataset.task == String(t.id) ? keepState(d) : () => {};
  d.dataset.task = t.id;
  d.innerHTML = '<div class="dlg"><div class="dlg-head"><h3><span class="id">#' + t.id + '</span>' + esc(t.title) + ' <span class="status ' + cls(t.status) + '">' + esc(STATUS[t.status] || t.status) + '</span> ' + stalledBadge(t) + '</h3><button data-act="close">Close</button></div>' +
    '<div class="links">' + (t.url && t.status != "merged" ? '<a href="/api/factory/tasks/' + t.id + '/open" target="_blank">Open preview ↗</a><span class="muted">' + esc(t.url) + '</span>' : "") +
    '<span class="branch">' + esc(t.branch) + (t.base ? " from staging at " + esc(t.base.slice(0, 10)) : "") + '</span>' +
    // Who added it (an admin, or their agent), and the person its commits are by (factory/author.ts).
    '<span class="muted person" title="Its commits are authored by this person; Erga factory commits them">Added by ' + esc(t.by) + (t.person ? ' · commits by ' + esc(t.person) : '') + '</span>' +
    // A local task: who runs it, where (no VM); or one that was handed to a VM.
    (t.local ? '<span class="local-where" title="A local task: no VM. Its agent reports with the task command; Hand to a VM gives it to a fresh VM.">' + localChip(t) + ' Runs locally: ' + esc(runsWhere(t)) + ', since ' + esc(new Date(t.local.since).toLocaleString()) + '</span>'
      : t.handedFrom ? '<span class="muted">Ran locally (' + esc(t.handedFrom) + '), then handed to a VM</span>' : "") +
    (t.mergeCommit ? '<span class="muted">merged as ' + esc(t.mergeCommit.slice(0, 10)) + '</span>' : "") + (t.vm ? '<span class="muted">VM ' + esc(t.vm) + '</span>' : "") + '</div>' +
    actions(t, true) +
    (stalledMs(t) ? '<div class="stalled-note" id="stalled-note">Stalled: ' + esc(stalledTip(t, stalledMs(t))) + '</div>' : "") +
    (shots ? '<section><h4>Screenshots</h4><div class="shots">' + shots + '</div></section>' : "") +
    (t.error ? '<section><h4>Error</h4><div class="text" style="color:var(--bad)">' + esc(t.error) + '</div></section>' : "") +
    depsSection(t) +
    (t.summary ? '<section><h4>Summary</h4><div class="text">' + esc(t.summary) + '</div></section>' : "") +
    '<section><h4>The ask</h4><div class="text">' + esc(t.description) + '</div></section>' +
    (revisable ? '<section><h4>More instructions</h4>' + (t.local ? '<p class="hint">' + esc(runsWhere(t)) + ' runs this task. It gets these instructions with <code>task inbox</code>, when a step ends.' + (t.waiting ? ' ' + t.waiting + (t.waiting == 1 ? ' instruction waits' : ' instructions wait') + ' for it now.' : '') + '</p>'
      : working ? '<p class="hint">Claude Code works on this task now. It gets these instructions when its current step ends, and keeps its work.' + (t.waiting ? ' ' + t.waiting + (t.waiting == 1 ? ' instruction waits' : ' instructions wait') + ' for it now.' : '') + '</p>' : '') + '<textarea id="instructions" placeholder="What ' + (t.local ? "the local agent" : "Claude Code") + ' should change next">' + esc(keep) + '</textarea><div class="row"><span class="why" id="revise-why"></span><button class="primary" data-act="revise" data-id="' + t.id + '">' + (t.local ? "Send to the local agent" : "Send to Claude Code") + '</button></div></section>' : "") +
    '<section><h4>Log</h4><div class="log" id="task-log">' + log + '</div></section></div>';
  const l = $("task-log"); if (l) l.scrollTop = l.scrollHeight;
  if (!d.open) d.showModal();
  restore();
}

/**
 * What the user has under way in the detail view, before a redraw: each field's text or choice (the instructions,
 * the dependency's kind and task), its size, scroll and selection, which field or button has the focus, the
 * dialog's scroll and why a send failed. Returns a function that puts it all back in the new view, so a live
 * update doesn't take the cursor out of the text the user is typing.
 */
function keepState(d) {
  const key = (el) => el.id ? "#" + el.id : el.dataset.act ? '[data-act="' + el.dataset.act + '"]' + (el.dataset.file ? '[data-file="' + CSS.escape(el.dataset.file) + '"]' : "") + (el.dataset.id ? '[data-id="' + el.dataset.id + '"]' : "") + (el.dataset.dep ? '[data-dep="' + el.dataset.dep + '"][data-kind="' + el.dataset.kind + '"]' : "") : null;
  const fields = [...d.querySelectorAll("input[id], textarea[id], select[id]")].map((el) => ({ key: key(el), value: el.value, height: el.style.height, top: el.scrollTop,
    sel: el.selectionStart != null ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : null }));
  const active = d.contains(document.activeElement) ? key(document.activeElement) : null;
  const why = d.querySelector("#revise-why")?.textContent || "";
  const top = d.scrollTop;
  return () => {
    for (const f of fields) {
      const el = d.querySelector(f.key);
      if (!el) continue;
      // A choice that is gone (a task that left the list) leaves the new view's default.
      if (el.tagName != "SELECT" || [...el.options].some((o) => o.value == f.value)) el.value = f.value;
      if (f.height) el.style.height = f.height;
      if (f.sel) el.setSelectionRange(...f.sel);
      el.scrollTop = f.top;
    }
    const w = d.querySelector("#revise-why"); if (w && why) w.textContent = why;
    const el = active && d.querySelector(active);
    if (el) el.focus({ preventScroll: true });
    d.scrollTop = top;
  };
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
      (d && d.status == "merged" ? '<span class="met" title="Merged: met">✓ merged</span>' : '<span class="status ' + (d ? cls(d.status) : "") + '">' + (d ? STATUS[d.status] : "gone") + '</span>') +
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
    try { info.claude = await api("/claude", { method: "PUT", json: { token: $("c-token").value.replace(/\\s+/g, "") } }); d.close(); renderInfo(); }
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
  if (!el) { if (e.target.id == "dlg" || e.target.id == "form") e.target.close(); return; }
  if (el.dataset.open && !el.dataset.act) { openId = Number(el.dataset.open); bigShot = null; renderDialog(); return; }
  e.stopPropagation();
  const id = Number(el.dataset.id), act = el.dataset.act;
  try {
    if (act == "close") { openId = null; $("dlg").close(); }
    else if (act == "shot") { bigShot = bigShot == el.dataset.file ? null : el.dataset.file; renderDialog(); $("dlg").querySelector(".shots figure.big")?.scrollIntoView({ block: "nearest" }); }
    else if (act == "cancel") $("form").close();
    else if (act == "new") newTask();
    else if (act == "claude") claudeDialog();
    else if (act == "forget") { info.claude = await api("/claude", { method: "DELETE" }); $("form").close(); renderInfo(); }
    else if (act == "arm") { armed.add(id); render(); setTimeout(() => { armed.delete(id); render(); }, 4000); }
    else if (act == "discard") { armed.delete(id); upsert(await api("/tasks/" + id + "/discard", { method: "POST" })); }
    else if (act == "restart") { el.disabled = true; upsert(await api("/tasks/" + id + "/restart", { method: "POST" })); }
    else if (act == "merge") upsert(await api("/tasks/" + id + "/merge", { method: "POST" }));
    else if (act == "dep" || act == "undep") {
      const t = tasks.find((x) => x.id == id);
      const kind = act == "dep" ? $("dep-kind").value : el.dataset.kind;
      const dep = Number(act == "dep" ? $("dep-id").value : el.dataset.dep);
      const now = t[kind] || [];
      el.disabled = true;
      await setDeps(id, { [kind]: act == "dep" ? [...now, dep] : now.filter((x) => x != dep) });
    }
    else if (act == "revise") {
      const was = tasks.find((x) => x.id == id)?.status;
      upsert(await api("/tasks/" + id + "/revise", { method: "POST", json: { instructions: $("instructions").value } }));
      // Sent to a working task: the box stays, empty, and says so.
      if (was == "working" && $("instructions")) { $("instructions").value = ""; $("revise-why").textContent = "Sent. Claude Code gets them when its current step ends."; $("revise-why").classList.add("sent"); }
    }
  } catch (err) {
    if (act == "revise") $("revise-why").textContent = err.message; else alert(err.message);
  }
}, { signal: pageView.signal });
$("dlg").addEventListener("close", () => { openId = null; bigShot = null; });
$("dlg").addEventListener("keydown", shotKey);

/**
 * The detail view's keys for its screenshots. Left and right go to the previous and next screenshot, around at
 * the ends: the enlarged one changes if one is enlarged, else the focus moves along the grid. Enter or Space
 * enlarges (or shrinks) the one that has the focus. Escape shrinks the enlarged one (it doesn't close the view).
 * The arrows do nothing in a field (the instructions, a choice), so they still move the cursor there.
 */
function shotKey(e) {
  const t = tasks.find((x) => x.id == openId);
  if (!t || !t.screenshots.length || e.altKey || e.ctrlKey || e.metaKey) return;
  const d = $("dlg");
  const show = (file, focus) => {
    bigShot = file; renderDialog();
    const f = d.querySelector('.shots figure[data-file="' + CSS.escape(focus) + '"]');
    if (f) { f.focus({ preventScroll: true }); f.scrollIntoView({ block: "nearest" }); }
  };
  if (e.key == "Escape") {
    if (!bigShot) return;
    e.preventDefault();
    show(null, bigShot);
    return;
  }
  const fig = e.target.closest(".shots figure");
  if ((e.key == "Enter" || e.key == " ") && fig) { e.preventDefault(); show(bigShot == fig.dataset.file ? null : fig.dataset.file, fig.dataset.file); return; }
  if (e.key != "ArrowLeft" && e.key != "ArrowRight" || e.target.closest("input, textarea, select, [contenteditable]")) return;
  const files = t.screenshots.map((s) => s.file), step = e.key == "ArrowRight" ? 1 : -1;
  const from = files.indexOf(bigShot || fig?.dataset.file);
  const next = files[from < 0 ? (step > 0 ? 0 : files.length - 1) : (from + step + files.length) % files.length];
  e.preventDefault();
  if (bigShot) show(next, next);
  else { const f = d.querySelector('.shots figure[data-file="' + CSS.escape(next) + '"]'); f.focus(); f.scrollIntoView({ block: "nearest" }); }
}

async function load() {
  [info, tasks] = await Promise.all([api(""), api("/tasks")]);
  if (pageView.signal.aborted) return;
  renderInfo();
}
// The board's live updates. A break (the server restarting, a redeploy) shows only if it lasts; the stream is made
// again if the browser gives up on it (an answer that isn't one, while the server restarts), a little later each time;
// back, the board is read again. live.js hears of it too (src/page/live.ts).
let tries = 0, liveTimer = 0;
function connect() {
  if (pageView.signal.aborted) return;
  const es = new EventSource("/api/factory/events");
  es.onopen = () => { tries = 0; clearTimeout(liveTimer); live = "live"; showLive(); load(); window.ergaLive?.connection("board", true); };
  es.onerror = () => {
    window.ergaLive?.connection("board", false);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (es.readyState != EventSource.OPEN) { live = "reconnecting"; showLive(); } }, 4000);
    if (es.readyState == EventSource.CLOSED) setTimeout(connect, Math.min(10000, 500 * 2 ** tries++));
  };
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type == "task") upsert(m.task);
    else if (m.type == "unblocked" || m.type == "blocked") toast("#" + m.id + " " + m.type + ": " + m.title + " (" + m.why.split(":")[0] + ")");
  };
  pageView.onLeave(() => { es.close(); window.ergaLive?.connection("board", null); });
}
load().then(connect);
setInterval(render, 30000);
// The page's agent panel (src/page/factory-agent.ts) asks which task is open, so "this task" means something to the agent.
window.ergaBoard = { openTask: () => openId, title: (id) => tasks.find((x) => x.id == id)?.title ?? null, open: (id) => { openId = id; renderDialog(); } };
pageView.onLeave(() => { delete window.ergaBoard; });
})();
`;

/** The board's pane: its head (where VMs run, the Claude sign-in), the notice, the columns, its dialogs. */
export function boardMarkup(opts: { enabled: boolean }): string {
  return `<div class="pane-head"><h2>Tasks</h2><div class="pills" id="pills"><span class="pill" id="live">connecting</span><button class="pill" id="mirror-pill" type="button" hidden>GitHub: loading…</button></div></div>
<div class="notice" id="notice" ${opts.enabled ? "hidden" : ""}>The factory is off. An admin turns it on with the <code>factory</code> setting on <a href="/admin">Settings</a>.</div>
<div class="board" id="board"></div>
<dialog id="dlg"></dialog>
<dialog id="form" class="small"></dialog>
<div id="toast" role="status" hidden></div>`;
}
