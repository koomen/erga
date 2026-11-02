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
import { agentPrompt } from "../common/agent-prompt";
import { showCopied } from "../common/copied";

interface AgentState {
  enabled: boolean;
  reason?: string;
  model?: string | null;
  choice?: string | null;
  models?: { id: string; label: string; key?: "own" | "server" }[];
  log?: Log;
}

const $ = (id: string) => document.getElementById(id)!;
/** An address of the agent's API, as whoever this tab is (local development's ?user=, kept). */
const USER = new URLSearchParams(location.search).get("user")?.trim();
const asUser = (path: string) => (USER ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(USER)}` : path);
/** A request to the agent's API, as whoever this tab is. */
const call = (path: string, init?: RequestInit) => fetch(asUser(path), init);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } },
};

const VERBS: Record<string, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"],
  ls: ["Listing", "Listed"],
  find: ["Finding files", "Found files"],
  grep: ["Searching", "Searched"],
  view_page: ["Looking at the page", "Looked at the page"],
  evaluate_page: ["Inspecting the page", "Inspected the page"],
  page_console: ["Reading the page's console", "Read the page's console"],
  page_network: ["Reading the page's requests", "Read the page's requests"],
  page_events: ["Reading the page's events", "Read the page's events"],
  page_inspect: ["Inspecting the live page", "Inspected the live page"],
  page_click: ["Clicking on the page", "Clicked on the page"],
  page_key: ["Pressing a key on the page", "Pressed a key on the page"],
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

/** The document the page has open, if any: the document tools' own when the agent names none. */
const DOC = document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')?.content ?? null;
/** Its host, for someone who may edit it (meta erga-base): the agent's edits there, which Undo takes back. */
const BASE = document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')?.content ?? null;
const input = $("agent-input") as HTMLTextAreaElement,
  send = $("agent-send") as HTMLButtonElement,
  hint = $("agent-hint");
const talk = chat({
  logEl: $("agent-log"),
  jump: $("agent-jump") as HTMLButtonElement,
  verbs: VERBS,
  imageAlt: "The screenshot the agent looked at",
  externalTip: "An agent you shared this page with, working as your agent",
});
const log = talk.log;
let off: string | null = "Connecting to the agent…";
/** The live voice session (voice mode, below), or null when it's off. `sent` counts the session's results already sent, of `results` heard so far. */
let voice: { rec: Recognition; before: string; sent: number; results: number; heard: string; partial: boolean; timer: number } | null = null;
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
  if (voice) return "Voice mode is on: what you say is sent when you pause.";
  if (att.reading) return "Reading the attached files…";
  if (!log.busy && !input.value.trim() && !att.files.length) return "Type a message to send it.";
  return null;
}
function renderBusy() {
  // In voice mode the button can't send, so while the agent works it's Stop.
  const stop = log.busy && (!!voice || (!input.value.trim() && !att.files.length && !att.reading));
  const why = off ?? (stop ? null : blocker());
  send.textContent = stop ? "Stop" : "Send";
  send.classList.toggle("stop", stop);
  send.setAttribute("aria-disabled", String(!!why));
  send.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
  $("agent-fab").classList.toggle("busy", log.busy);
  input.placeholder = off
    ? "The agent is off"
    : voice
      ? "Listening… pause to send"
      : log.busy
        ? "Add to what the agent is doing…"
        : "Ask the agent…";
  // (Drawn again only when it changed: the key field below it keeps what's typed.)
  if (off) {
    if (hint.dataset.off != off || hint.hidden) {
      showHint(off, true);
      hint.dataset.off = off;
    }
    noKeyLinks();
  } else if (hint.classList.contains("sticky")) hideHint();
}

/**
 * The agent is off for want of a key (none it can use, or one this server can't open): the panel says so, with two
 * links. "add an LLM provider key" opens Settings (client/agent/settings-dialog.ts), where the person pastes their own;
 * "connect your own agent" shows the one-line prompt for an outside agent (the same as Share with an agent), and copies it.
 */
function noKeyLinks() {
  if (!off || !/API key/.test(off) || hint.querySelector(".agent-no-key")) return;
  hint.textContent = "";
  hint.insertAdjacentHTML(
    "beforeend",
    `<span class="agent-no-key">To enable the agent, <a href="#settings">add an LLM provider key</a>. Or <a href="#connect" class="agent-connect-link">connect your own agent</a>.</span>`
  );
  hint.querySelector(".agent-connect-link")!.addEventListener("click", (e) => {
    e.preventDefault();
    const link = e.currentTarget as HTMLElement;
    let box = hint.querySelector<HTMLElement>(".agent-connect");
    if (!box) {
      box = document.createElement("div");
      box.className = "agent-connect";
      box.innerHTML = `<p>Paste this into your agent (Claude Code, Codex, any MCP app). It signs you in, then works in Erga as you.</p><pre></pre><button type="button">Copy prompt</button>`;
      const prompt = agentPrompt(document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? location.pathname);
      box.querySelector("pre")!.textContent = prompt;
      const copy = box.querySelector("button")!;
      copy.addEventListener(
        "click",
        () =>
          void navigator.clipboard.writeText(prompt).then(
            () => showCopied(copy),
            () => {}
          )
      );
      hint.append(box);
    }
    void navigator.clipboard.writeText(box.querySelector("pre")!.textContent ?? "").then(
      () => showCopied(link),
      () => {}
    );
  });
}

/** The page note: what the person has open (the breadcrumbs, the document's address; in the editor, the selection), so "this" means something. */
function context(): string | null {
  const trail = [...document.querySelectorAll(".erga-crumbs > :not(.erga-brand)")]
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(" › ");
  const doc = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content;
  const page = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content;
  const editor = window.ergaPage as { agentContext?: () => string | null } | undefined;
  const editing = document.body.classList.contains("erga-editing") ? editor?.agentContext?.() : null;
  return `Open: ${trail || document.title} (${location.pathname}).${doc ? ` The document ${doc}${page ? `, its file ${page}` : ""}${editing ? ", in the editor" : ""}.` : ""}${editing ? `\n${editing}` : ""}`;
}

async function ask(text: string, ctx: string | null, files: Attachment[] = []) {
  const sent = talk.pending(text, fileRefs(files));
  // While the server restarts (a redeploy) it doesn't answer, or its gateway says so: the message waits and goes once it's back.
  let res: Response | Error = new Error("not sent");
  for (let i = 0, until = Date.now() + 45_000; ; i++) {
    res = await call("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, context: ctx, files, doc: DOC }),
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
  if (why || (!text && !files.length)) {
    // Off: the panel says why again (with its links, when a key is missing).
    if (off) {
      delete hint.dataset.off;
      renderBusy();
    } else showHint(why ?? "Type a message to send it.");
    input.focus();
    return;
  }
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
  if (send.classList.contains("stop")) call("/api/agent/abort", { method: "POST" });
  else sendNow();
});
$("agent-reset").addEventListener("click", () => {
  call("/api/agent/conversation", { method: "DELETE" }).then(
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
  sel.id = "agent-model-select";
  sel.setAttribute("aria-label", "Model");
  // A model the person's own key runs says so; the others run on the server's keys.
  for (const o of m.models) sel.append(new Option(o.key == "own" ? `${o.label} (your key)` : o.label, o.id, false, o.id == m.choice));
  sel.title = "The model your agent runs on; a switch applies from your next message";
  sel.addEventListener("pointerdown", () => sel.classList.add("by-pointer"));
  sel.addEventListener("keydown", () => sel.classList.remove("by-pointer"));
  sel.addEventListener("change", async () => {
    const r = (await call("/api/agent/model", {
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
  const kept = call("/api/agent/conversation")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) as Promise<{ log?: Log } | null>;
  let again = false;
  const a = (await call("/api/agent")
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
  // The editor's buttons that ask the agent (the toast's fix: client/shell/toast.ts) follow its state.
  window.dispatchEvent(new Event("erga:agent-state"));
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
  const ws = new WebSocket(`${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${asUser("/api/agent/events")}`);
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
    let m: { type?: string; ev?: LogEvent } & Partial<AgentState>;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    // The model switched, from another tab of the person's.
    if (m.type == "model") renderModel({ ...m, enabled: true });
    if (m.type == "agent" && m.ev) {
      heard++;
      talk.apply(m.ev);
      renderBusy();
      // A tool call done: the document open may have changed (Undo's count).
      if (m.ev.t == "tool" && m.ev.status != "running") window.dispatchEvent(new Event("erga:agent-tool"));
    }
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

// ---------------------------------------------------------------- the document open

// Undo takes back the agent's last change to the document open (one tool call), whoever has typed since: your own ⌘Z
// never undoes the agent's edits. The document's host keeps each person's agent's changes (document/host.ts).
const undoBtn = $("agent-undo") as HTMLButtonElement;
let undoable = 0;
function renderUndo() {
  const why = !undoable ? "Your agent hasn't changed this document since it opened" : null;
  undoBtn.setAttribute("aria-disabled", String(!!why));
  undoBtn.dataset.tip = why ?? `Undo the agent's last change (${undoable} to go)`;
}
async function readUndo() {
  if (!BASE) return;
  const a = (await fetch(`${BASE}${asUser("/api/agent/undo")}`).then(
    (r) => (r.ok ? r.json() : null),
    () => null
  )) as { count?: number } | null;
  undoable = a?.count ?? 0;
  renderUndo();
}
undoBtn.hidden = !BASE;
if (BASE) {
  undoBtn.addEventListener("click", async () => {
    if (!undoable) {
      showHint(undoBtn.dataset.tip ?? "");
      return;
    }
    const r = await fetch(`${BASE}${asUser("/api/agent/undo")}`, { method: "POST" }).catch(() => null);
    if (!r?.ok) showHint("Couldn't undo the agent's change. Try again.");
    void readUndo();
  });
  // After each of the agent's tool calls, and as the panel opens.
  window.addEventListener("erga:agent-tool", () => void readUndo());
  window.addEventListener("erga:agent-shown", () => void readUndo());
  void readUndo();
}

// ---------------------------------------------------------------- voice mode

// What you say is dictated into the box and sent when you pause, through the browser's speech recognition (Chrome
// sends the audio to Google; Safari to Apple). While the agent works, each send steers it, as typing does. The
// browser's own final results come at every breath, so a pause is our own: no new words for PAUSE_MS. Then everything
// heard is sent, words not yet final included, and if there were any the session is restarted so they can't arrive
// again later.
type Recognition = EventTarget & {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
const Speech = ((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition) as (new () => Recognition) | undefined;
const PAUSE_MS = 1000;
const voiceBtn = $("agent-voice") as HTMLButtonElement;
voiceBtn.hidden = !Speech;
function listenVoice(before: string) {
  const rec = new Speech!();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language;
  const v = (voice = { rec, before, sent: 0, results: 0, heard: "", partial: false, timer: 0 });
  rec.onresult = (e) => {
    if (voice != v) return;
    let heard = "", partial = false;
    for (let i = v.sent; i < e.results.length; i++) {
      heard += e.results[i][0].transcript;
      if (!e.results[i].isFinal) partial = true;
    }
    Object.assign(v, { heard, partial, results: e.results.length });
    input.value = (v.before + " " + heard).trim();
    sizeInput();
    clearTimeout(v.timer);
    v.timer = window.setTimeout(voiceSend, PAUSE_MS * ((window as unknown as { ergaTimescale?: number }).ergaTimescale ?? 1));
  };
  rec.onerror = (e) => {
    if (voice != v) return;
    if (e.error == "not-allowed" || e.error == "service-not-allowed") { stopVoice(); showHint("Voice mode needs the microphone: allow it for this site, then try again.", true); }
    else if (e.error == "network") { stopVoice(); showHint("Voice mode couldn't reach the browser's speech service."); }
    else if (e.error == "audio-capture") { stopVoice(); showHint("Voice mode couldn't find a microphone."); }
    // "no-speech" and "aborted": the session ends and onend starts another.
  };
  // Recognition ends on its own (silence, a time limit); keep listening.
  rec.onend = () => { if (voice == v) listenVoice((v.before + " " + v.heard).trim()); };
  try { rec.start(); } catch { stopVoice(); }
}
function voiceSend() {
  const v = voice;
  if (!v) return;
  const text = (v.before + " " + v.heard).trim();
  if (!text) return;
  if (off) {
    showHint(off, true);
    return;
  } // kept in the box until the agent's back
  v.before = "";
  v.heard = "";
  input.value = "";
  store.set(DRAFT, null);
  const files = att.files;
  att.clear();
  sizeInput();
  void ask(text, context(), files);
  // Words sent before they were final would come back final: start afresh.
  if (v.partial) { v.partial = false; v.rec.abort(); }
  else v.sent = v.results;
}
function startVoice() {
  if (!Speech || voice) return;
  voiceBtn.setAttribute("aria-pressed", "true");
  input.readOnly = true;
  listenVoice(input.value.trim());
  renderBusy();
}
/** Leaves voice mode; anything heard since the last send stays in the box, to edit or send. */
function stopVoice() {
  const v = voice;
  if (!v) return;
  voice = null;
  clearTimeout(v.timer);
  v.rec.abort();
  voiceBtn.setAttribute("aria-pressed", "false");
  input.readOnly = false;
  store.set(DRAFT, input.value || null);
  renderBusy();
  if (document.body.classList.contains("agent-open")) input.focus();
}
voiceBtn.addEventListener("click", () => (voice ? stopVoice() : startVoice()));
// The mic never listens behind a closed panel.
new MutationObserver(() => {
  if (!document.body.classList.contains("agent-open")) stopVoice();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ---------------------------------------------------------------- for the editor

declare global {
  interface Window {
    /** The panel, for the editor's own "Fix with agent" buttons and its reload (client/shell/). */
    ergaAgentPanel?: {
      ask(text: string, context: string | null): void;
      readonly off: string | null;
      readonly busy: boolean;
      readonly voice: boolean;
      stopVoice(): void;
      files: typeof att;
    };
  }
}
window.ergaAgentPanel = {
  ask: (text, ctx) => {
    window.ergaAgent?.show(true);
    void ask(text, ctx ?? context());
  },
  get off() {
    return off;
  },
  get busy() {
    return log.busy;
  },
  get voice() {
    return !!voice;
  },
  stopVoice,
  files: att,
};

// Settings (client/agent/settings-dialog.ts): a dialog on any page, loaded the first time it's asked for. The account
// menu's Settings, and any link to "#settings", open it; so does an address that ends with #settings. A key saved or
// removed there gives the agent other models: the panel reads them again.
const settings = () => {
  if (location.hash == "#settings") history.replaceState(history.state, "", location.pathname + location.search);
  void import("./settings-dialog").then((m) => m.openSettings());
};
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a || new URL((a as HTMLAnchorElement).href, location.href).hash != "#settings" || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    settings();
  },
  true
);
window.addEventListener("hashchange", () => location.hash == "#settings" && settings());
if (location.hash == "#settings") settings();
window.addEventListener("erga:agent-keys", () => void load());
