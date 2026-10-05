// The factory's agent panel on /admin/source (source/page.ts), and its
// "Share with agent" card. The panel is the editor's (the same markup,
// styles and conversation, agent-chat.ts), talking to the admin's own agent
// session in the Factory object (factory/agent.ts, worker/factory.ts):
//
//   GET  /api/factory/agent            the state: on or off (and why), the model, the conversation so far
//   POST /api/factory/agent            { text, context }: a message; context says which task is open on the board
//   POST /api/factory/agent/abort|reset|model
//   /api/factory/events                { type: "agent", ev } for this admin's agent (the board's events too)
//
// Share with agent is the editor's card (share-agent.ts), with a factory
// token (POST /api/factory/tokens) in the prompt to paste into an outside
// agent; New token revokes the old one. Built by build.sh to factory-agent.js.

import { chat } from "./agent-chat";
import { shareWithAgent } from "./share-agent";
import type { Log, LogEvent } from "./agent-log";

interface AgentState { enabled: boolean; reason?: string; model?: string | null; choice?: string | null; models?: { id: string; label: string }[]; log?: Log }
declare global { interface Window { ergaBoard?: { openTask(): number | null; title(id: number): string | null; open(id: number): void } } }

const $ = (id: string) => document.getElementById(id)!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } },
};

const VERBS: Record<string, [string, string]> = {
  factory_status: ["Checking the factory", "Checked the factory"],
  list_tasks: ["Reading the board", "Read the board"],
  get_task: ["Reading", "Read"],
  view_screenshot: ["Looking at a screenshot of", "Looked at a screenshot of"],
  create_task: ["Queueing", "Queued"],
  set_dependencies: ["Changing the dependencies of", "Changed the dependencies of"],
  instruct_task: ["Sending instructions to", "Sent instructions to"],
};

const input = $("agent-input") as HTMLTextAreaElement, send = $("agent-send") as HTMLButtonElement, hint = $("agent-hint");
const talk = chat({ logEl: $("agent-log"), jump: $("agent-jump") as HTMLButtonElement, verbs: VERBS, imageAlt: "The screenshot the agent looked at" });
const log = talk.log;
let off: string | null = "Connecting to the agent…";
let hintTimer = 0;

function showHint(text: string, sticky = false) {
  clearTimeout(hintTimer);
  hint.textContent = text;
  hint.hidden = false;
  hint.classList.toggle("sticky", sticky);
  if (!sticky) hintTimer = window.setTimeout(hideHint, 2600);
}
function hideHint() {
  clearTimeout(hintTimer);
  hint.hidden = true;
  hint.classList.remove("sticky");
}
/** Why Send can't send right now, or null if it can. Never a silent no. */
function blocker(): string | null {
  if (off) return off;
  if (!log.busy && !input.value.trim()) return "Type a message to send it.";
  return null;
}
function renderBusy() {
  const stop = log.busy && !input.value.trim();
  const why = off ?? (stop ? null : blocker());
  send.textContent = stop ? "Stop" : "Send";
  send.classList.toggle("stop", stop);
  send.setAttribute("aria-disabled", String(!!why));
  send.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
  input.placeholder = off ? "The agent is off" : log.busy ? "Add to what the agent is doing…" : "Ask the agent…";
  if (off) showHint(off, true);
  else if (hint.classList.contains("sticky")) hideHint();
}

/** What the admin has open, so "this task" means something to the agent. */
function context(): string | null {
  const id = window.ergaBoard?.openTask() ?? null;
  return id != null ? `The admin has task #${id} open on the board: ${window.ergaBoard?.title(id) ?? ""}` : null;
}

async function ask(text: string, ctx: string | null) {
  const sent = talk.pending(text);
  const res = await fetch("/api/factory/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context: ctx }), signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
  if (!(res instanceof Response) || !res.ok) {
    const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string; error?: string } | null)?.reason ?? `the server answered ${res.status}` : res.name == "TimeoutError" ? "the server didn't answer in time" : "the server didn't answer";
    sent.fail(reason, () => ask(text, ctx));
  }
  renderBusy();
}
function sendNow() {
  const text = input.value.trim();
  const why = blocker();
  if (why || !text) { showHint(why ?? "Type a message to send it.", !!off); input.focus(); return; }
  input.value = "";
  store.set(DRAFT, null);
  sizeInput();
  ask(text, context());
}

// The box sizes itself with field-sizing: content, and its wrapper eases to the new height (as in the editor).
const field = $("agent-field");
const fieldSizing = CSS.supports("field-sizing", "content");
function sizeInput() {
  if (!fieldSizing) { input.style.height = "auto"; input.style.height = input.scrollHeight + 2 + "px"; }
  renderBusy();
}
new ResizeObserver(() => { const h = input.offsetHeight; if (h) field.style.height = h + "px"; }).observe(input);

// An unsent message survives a reload (kept in this browser only).
const DRAFT = "erga:factory-agent-draft:v1";
const draft = store.get(DRAFT);
if (draft) { input.value = draft; sizeInput(); }
input.addEventListener("input", () => { if (!hint.classList.contains("sticky")) hideHint(); sizeInput(); store.set(DRAFT, input.value || null); });
input.addEventListener("keydown", (e) => { if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); } });
$("agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (send.classList.contains("stop")) fetch("/api/factory/agent/abort", { method: "POST" });
  else sendNow();
});
$("agent-reset").addEventListener("click", () => { fetch("/api/factory/agent/reset", { method: "POST" }); input.focus(); });
window.addEventListener("erga:agent-shown", () => { talk.follow(true); input.focus(); });

// Which model the agent runs on: a menu when there's a choice, plain text otherwise (as in the editor).
function renderModel(m: AgentState | null) {
  const el = $("agent-model");
  el.textContent = "";
  if (!m || !m.enabled) { el.textContent = "off"; return; }
  if (!m.models?.length || !m.choice) { el.textContent = m.model ?? ""; return; }
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Model");
  for (const o of m.models) sel.append(new Option(o.label, o.id, false, o.id == m.choice));
  sel.title = "The model your agent runs on; a switch applies from your next message";
  sel.addEventListener("pointerdown", () => sel.classList.add("by-pointer"));
  sel.addEventListener("keydown", () => sel.classList.remove("by-pointer"));
  sel.addEventListener("change", async () => {
    const r = await fetch("/api/factory/agent/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: sel.value }) }).then((r) => r.json()).catch(() => ({ ok: false })) as AgentState & { ok: boolean };
    if (!r.ok) { sel.value = m.choice!; showHint("Couldn't switch models."); return; }
    showHint(log.busy ? `${sel.selectedOptions[0]?.text}: from your next message` : `Switched to ${sel.selectedOptions[0]?.text}`);
  });
  el.append(sel);
}

async function load() {
  const a = await fetch("/api/factory/agent").then((r) => r.ok ? r.json() : Promise.reject(new Error(`the server answered ${r.status}`))).catch((e: Error) => ({ enabled: false, reason: e.message })) as AgentState;
  off = a.enabled ? null : `The agent is off: ${a.reason ?? "the server did not start it"}.`;
  renderModel(a);
  if (a.log) { log.items = a.log.items; log.busy = a.log.busy; log.undoable = a.log.undoable; }
  talk.render();
  renderBusy();
}

// The agent's events come with the board's, to this admin only; a reconnect reads the whole conversation again.
function connect() {
  const es = new EventSource("/api/factory/events");
  es.onopen = () => { load(); };
  es.onmessage = (e) => {
    let m: { type?: string; ev?: LogEvent };
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type == "agent" && m.ev) { talk.apply(m.ev); renderBusy(); }
  };
}
load().then(connect);

// ---------------------------------------------------------------- Share with agent

// A factory token is shown once (the server keeps only its hash): this page keeps it until New token, which revokes it.
const HOURS = 12;
let shared: string | null = null, expires = 0;
shareWithAgent({
  button: $("btn-share"),
  title: "Share the factory with an agent",
  intro: "Paste this into an agent that can run commands (Claude Code, Codex…), then explain what you want it to do.",
  note: `Anyone with this token can queue tasks, read them and send them more instructions, as your agent, for ${HOURS} hours. It can't merge, discard or start tasks, push or deploy. New token turns the old one off; so does revoking the admin key you unlocked with.`,
  async token(rotate) {
    if (rotate && shared) {
      const r = await fetch(`/api/factory/tokens/${shared}`, { method: "DELETE" }).catch(() => null);
      if (!r?.ok) throw new Error(r ? `the old one wasn't revoked (the server answered ${r.status})` : "the server didn't answer");
      shared = null;
    }
    const r = await fetch("/api/factory/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Share button", hours: HOURS }), signal: AbortSignal.timeout(10_000) })
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) as { token?: string; id?: string; expires?: number; error?: string } }))
      .catch((e: Error) => { throw new Error(e.name == "TimeoutError" ? "the server didn't answer in time" : "the server didn't answer"); });
    if (!r.ok || !r.body.token) throw new Error(r.body.error ?? `the server answered ${r.status}`);
    shared = r.body.id!;
    expires = r.body.expires!;
    return r.body.token;
  },
  prompt: (token) => promptFor(token, expires),
  dismiss: true,
});

function promptFor(token: string, expires: number): string {
  const origin = location.origin;
  return `I'd like your help with the factory on my Erga server, ${origin}: its task queue, where each task is a branch of Erga that Claude Code builds in a VM of its own. You can queue tasks, read them (status, log, preview, screenshots) and send them more instructions, working as my agent. You can't merge or discard them: I approve each merge myself.

API: ${origin}/api/factory
Token: ${token}
(It works until ${new Date(expires).toLocaleString()}.)

Send the token on every request, as the header "Authorization: Bearer ${token}". Start by reading the guide, which explains the API and how to write tasks:

curl -s -H "Authorization: Bearer ${token}" ${origin}/api/factory/guide

Once you've read the guide, await further instructions.`;
}
