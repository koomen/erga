// Each person's agent panel, on every page for someone signed in (server/pages/agent.ts has its markup; the circle grows
// into it: client/inline/agent-toggle.ts). The panel is the editor's (the same markup, styles and conversation,
// agent-chat.ts), talking to the person's own agent in their PersonAgent object (agents/person/agent.ts,
// agents/person/sessions.ts):
//
//   GET  /api/agent              the state: on or off (and why), the model, the conversation so far
//   POST /api/agent              { text, context }: a message; context is the page note (the page open, what is selected)
//   POST /api/agent/abort|reset|model
//   /api/agent/events            { type: "agent", ev } for this person's agent (a WebSocket)
//   GET|DELETE /api/agent/conversation   the conversation, kept on the server (read on mount); a new one
//
// The conversation follows the person from page to page, browser to browser and sign-in to sign-in: the server keeps
// it. Built by client/build.ts to agent.js.

import { chat } from "./agent-chat";
import { fileRefs, type Attachment } from "../../shared/attach";
import { attachments } from "./attach-ui";
import type { Log, LogEvent } from "../../shared/agent-log";
import { backoff, live, transient } from "../live/client";
import { restoredFor } from "../live/restore";
import { sleep } from "../../shared/time";

interface AgentState { enabled: boolean; reason?: string; model?: string | null; choice?: string | null; models?: { id: string; label: string }[]; log?: Log }

const $ = (id: string) => document.getElementById(id)!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } },
};

const VERBS: Record<string, [string, string]> = {
  list_settings: ["Reading the settings", "Read the settings"],
  set_setting: ["Changing", "Changed"],
  reset_setting: ["Resetting", "Reset"],
  list_setting_changes: ["Reading the change log", "Read the change log"],
  list_api_keys: ["Reading the API keys' status", "Read the API keys' status"],
  list_users: ["Listing the users", "Listed the users"],
  add_user: ["Adding", "Added"],
  set_user_role: ["Changing the role of", "Changed the role of"],
  set_user_deploy: ["Changing the deploy role of", "Changed the deploy role of"],
  remove_user: ["Removing", "Removed"],
  list_source: ["Listing", "Listed"],
  read_source: ["Reading", "Read"],
  search_source: ["Searching the source for", "Searched the source for"],
  source_log: ["Reading the log of", "Read the log of"],
};

const input = $("agent-input") as HTMLTextAreaElement, send = $("agent-send") as HTMLButtonElement, hint = $("agent-hint");
const talk = chat({ logEl: $("agent-log"), jump: $("agent-jump") as HTMLButtonElement, verbs: VERBS, imageAlt: "The screenshot the agent looked at" });
const log = talk.log;
let off: string | null = "Connecting to the agent…";
let hintTimer = 0;
// Files to go with the next message: dropped on the panel, pasted, or picked.
const att = attachments({ pane: $("agent"), form: $("agent-form"), input, hint: (t) => showHint(t), changed: () => renderBusy() });

function showHint(text: string, sticky = false) {
  clearTimeout(hintTimer);
  delete hint.dataset.off;
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
  if (att.reading) return "Reading the attached files…";
  if (!log.busy && !input.value.trim() && !att.files.length) return "Type a message to send it.";
  return null;
}
function renderBusy() {
  const stop = log.busy && !input.value.trim() && !att.files.length && !att.reading;
  const why = off ?? (stop ? null : blocker());
  send.textContent = stop ? "Stop" : "Send";
  send.classList.toggle("stop", stop);
  send.setAttribute("aria-disabled", String(!!why));
  send.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
  $("agent-fab").classList.toggle("busy", log.busy);
  input.placeholder = off ? "The agent is off" : log.busy ? "Add to what the agent is doing…" : "Ask the agent…";
  // (Drawn again only when it changed: the key field below it keeps what's typed.)
  if (off) { if (hint.dataset.off != off || hint.hidden) { showHint(off, true); hint.dataset.off = off; } keyField(); }
  else if (hint.classList.contains("sticky")) hideHint();
}

/**
 * The agent is off for want of an Anthropic API key (none, or one this server can't open): the admin pastes it here,
 * in the panel, and the agent starts. The key goes to POST /admin/credentials, as on the API keys page; never into
 * the conversation.
 */
function keyField() {
  if (!off || !/Anthropic API key/.test(off) || hint.querySelector("form")) return;
  const form = document.createElement("form");
  form.className = "agent-key";
  const field = Object.assign(document.createElement("input"), { type: "password", name: "value", placeholder: "sk-ant-…", autocomplete: "off", required: true });
  field.setAttribute("aria-label", "Anthropic API key");
  const save = Object.assign(document.createElement("button"), { type: "submit", textContent: "Save key" });
  const said = Object.assign(document.createElement("span"), { className: "agent-key-said" });
  form.append(field, save, said);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    save.disabled = true;
    said.textContent = "Saving…";
    const r = await fetch(`/admin/credentials${location.search}`, { method: "POST", body: new URLSearchParams({ name: "anthropic", value: field.value }) }).catch(() => null);
    const body = r ? ((await r.json().catch(() => null)) as { error?: string } | null) : null;
    save.disabled = false;
    if (!r?.ok) { said.textContent = body?.error ?? "Couldn't save it."; return; }
    field.value = "";
    said.textContent = "Saved. Starting the agent…";
    void load();
  });
  hint.append(form);
}

/** The page note: what the person has open (the breadcrumbs, the document's address), so "this" means something. */
function context(): string | null {
  const trail = [...document.querySelectorAll(".erga-crumbs > :not(.erga-brand)")]
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(" › ");
  const doc = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content;
  const page = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content;
  return `Open: ${trail || document.title} (${location.pathname}).${doc ? ` The document ${doc}${page ? `, its file ${page}` : ""}.` : ""}`;
}

async function ask(text: string, ctx: string | null, files: Attachment[] = []) {
  const sent = talk.pending(text, fileRefs(files));
  // While the server restarts (a redeploy) it doesn't answer, or its gateway says so: the message waits and goes once it's back.
  let res: Response | Error = new Error("not sent");
  for (let i = 0, until = Date.now() + 45_000; ; i++) {
    res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, context: ctx, files }),
      signal: AbortSignal.timeout(files.length ? 60_000 : 15_000),
    }).catch((e: Error) => e);
    if (res instanceof Response ? res.ok || !transient(res) : res.name == "TimeoutError" || !transient(res)) break;
    if (Date.now() + backoff(i) > until) break;
    await sleep(backoff(i));
  }
  if (!(res instanceof Response) || !res.ok) {
    const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string; error?: string } | null)?.reason ?? `the server answered ${res.status}` : res.name == "TimeoutError" ? "the server didn't answer in time" : "the server didn't answer";
    sent.fail(reason, () => ask(text, ctx, files));
  }
  renderBusy();
}
function sendNow() {
  const text = input.value.trim();
  const files = att.files;
  const why = blocker();
  if (why || (!text && !files.length)) { showHint(why ?? "Type a message to send it.", !!off); input.focus(); return; }
  input.value = "";
  store.set(DRAFT, null);
  att.clear();
  sizeInput();
  ask(text, context(), files);
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
const DRAFT = "erga:factory-agent-draft:v1"; // its old name, so a draft from before survives
const draft = store.get(DRAFT);
if (draft) { input.value = draft; sizeInput(); }
input.addEventListener("input", () => { if (!hint.classList.contains("sticky")) hideHint(); sizeInput(); store.set(DRAFT, input.value || null); });
input.addEventListener("keydown", (e) => { if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); } });
$("agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (send.classList.contains("stop")) fetch("/api/agent/abort", { method: "POST" });
  else sendNow();
});
$("agent-reset").addEventListener("click", () => {
  fetch("/api/agent/conversation", { method: "DELETE" }).then(
    (r) => {
      if (!r.ok) showHint("Couldn't start a new conversation.");
    },
    () => showHint("Couldn't start a new conversation.")
  );
  input.focus();
});
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
    const r = (await fetch("/api/agent/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: sel.value }),
    })
      .then((r) => r.json())
      .catch(() => ({ ok: false }))) as AgentState & { ok: boolean };
    if (!r.ok) {
      sel.value = m.choice!;
      showHint("Couldn't switch models.");
      return;
    }
    showHint(log.busy ? `${sel.selectedOptions[0]?.text}: from your next message` : `Switched to ${sel.selectedOptions[0]?.text}`);
  });
  el.append(sel);
}

// Events heard: one that comes while load() asks for the conversation may be newer than its answer, so load() asks again (up to 5 times).
let heard = 0, down = 0, downTimer = 0;
async function load(tries = 0): Promise<void> {
  const was = heard;
  clearTimeout(downTimer);
  // The conversation from where the server keeps it, whether the agent is on or not.
  const kept = fetch("/api/agent/conversation")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) as Promise<{ log?: Log } | null>;
  let again = false;
  const a = (await fetch("/api/agent")
    .then(
      async (r) => {
        again = transient(r);
        return r.ok
          ? r.json()
          : Promise.reject(
              new Error(
                ((await r.json().catch(() => null)) as { error?: string } | null)?.error?.replace(/\.$/, "") ??
                  `the server answered ${r.status}`
              )
            );
      },
      (e: Error) => {
        again = transient(e);
        throw e;
      }
    )
    .catch((e: Error) => ({ enabled: false, reason: e.message }))) as AgentState;
  // The server restarting (a redeploy): ask again shortly, as the panel was, rather than call the agent off.
  if (!a.enabled && again && down < 8) { downTimer = window.setTimeout(() => load(), backoff(down++)); return; }
  down = 0;
  const l = (await kept)?.log ?? a.log;
  if (heard != was && tries < 5) return load(tries + 1);
  off = a.enabled ? null : `The agent is off: ${a.reason ?? "the server did not start it"}.`;
  renderModel(a);
  if (l) { log.items = l.items; log.busy = l.busy; log.undoable = l.undoable; }
  talk.render();
  renderBusy();
}

// The agent's events, to this person only; a reconnect reads the whole conversation again. They come over a
// WebSocket, not an EventSource: over HTTP/1.1 an EventSource holds one of the browser's six connections to the host
// while the page is open, and with a few tabs open every later request waits. A socket that closes (the server
// restarts) is made again, a little later each time.
let tries = 0;
function connect() {
  const ws = new WebSocket(`${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}/api/agent/events`);
  ws.onopen = () => {
    tries = 0;
    live((l) => l.connection("agent", true));
    load();
  };
  ws.onclose = () => {
    live((l) => l.connection("agent", false));
    setTimeout(connect, backoff(tries++));
  };
  ws.onmessage = (e) => {
    let m: { type?: string; ev?: LogEvent };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.type == "agent" && m.ev) { heard++; talk.apply(m.ev); renderBusy(); }
  };
}
load().then(connect);

// A new release: the page reloads at a quiet moment and comes back as it was. The draft, the panel and
// its layout are kept anyway; this keeps the files attached to the next message.
interface Kept { files?: Attachment[] }
live((l) => {
  l.hold(() => (att.reading ? "files are being read" : null));
  l.keep("agent", (): Kept => ({ files: att.files }));
});
const back = restoredFor<Kept>("agent");
if (back?.files?.length) att.restore(back.files);
