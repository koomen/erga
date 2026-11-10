// Each person's agent panel, on every page for someone signed in (server/pages/agent.ts has its markup; the circle grows
// into it: client/inline/agent-toggle.ts). The panel is the editor's (the same markup, styles and conversation,
// agent-chat.ts), talking to the person's own agent in their PersonAgent object (agents/person/agent.ts,
// agents/person/sessions.ts):
//
//   GET  /api/agent              the state: on or off (and why), the model, the conversation so far (?fresh: the
//                                settings read now, after a key changed; else they may be up to 5 s old)
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
import { canSend, type SendPath } from "./send-gate";
import type { Log, LogEvent } from "../../shared/agent-log";
import { backoff, live, transient } from "../live/client";
import { socketStep, type PhaseEvent, type SocketPhase } from "../../shared/socket-phase";
import { restoredFor } from "../live/restore";
import { sleep } from "../../shared/time";
import { agentPrompt } from "../common/agent-prompt";
import { showCopied } from "../common/copied";
import { panelStep, savePanel, type PanelPhase } from "../common/agent-panel";

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
const call = (path: string, init?: RequestInit) => fetch(asUser(path), { ...init, credentials: "same-origin" });
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private window */ } },
};

const VERBS: Record<string, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  document_api: ["Reading the page's edits", "Read the page's edits"],
  call_edit: ["Editing the page", "Edited the page"],
  write: ["Writing", "Wrote"],
  ls: ["Listing", "Listed"],
  grep: ["Searching", "Searched"],
  view_page: ["Looking at the page", "Looked at the page"],
  page: ["Looking at the page", "Looked at the page"],
  documents: ["Listing the documents", "Listed the documents"],
  eval_in_page: ["Running code in the page", "Ran code in the page"],
  page_log: ["Reading the live page", "Read the live page"],
  page_input: ["Acting on the page", "Acted on the page"],
  settings: ["Reading the settings", "Read the settings"],
  set_setting: ["Changing", "Changed"],
  people: ["Reading the users", "Read the users"],
  set_user: ["Changing the users:", "Changed the users:"],
  set_access: ["Changing the access rules:", "Changed the access rules:"],
  sign_in: ["Reading how people sign in", "Read how people sign in"],
  set_sign_in: ["Changing sign-in:", "Changed sign-in:"],
  deploy_homepage: ["Deploying the homepage", "Deployed the homepage"],
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
/**
 * The live voice session (voice mode, below), or null when it's off. `sent` counts the session's results already sent, of
 * `results` heard so far; `due`: a pause came while the message couldn't go (a file still read), so it goes once it can.
 */
let voice: {
  rec: Recognition;
  before: string;
  sent: number;
  results: number;
  heard: string;
  partial: boolean;
  timer: number;
  due: boolean;
} | null = null;
let hintTimer = 0;
// Files to go with the next message: dropped on the panel, pasted, or picked.
const att = attachments({
  pane: $("agent"),
  form: $("agent-form"),
  input,
  hint: (t) => showHint(t),
  changed: () => {
    renderBusy();
    if (voice?.due) voiceSend();
  },
});

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
/** Why a message can't go by this path now (send-gate.ts), or null if it can. */
const gate = (path: SendPath, text: string) => canSend(path, { off, voice: !!voice, reading: att.reading, text, files: att.files.length });
/** Why Send can't send right now, or null if it can. */
const blocker = () => gate("box", input.value);
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
  const trail = [...document.querySelectorAll(".erga-crumbs > :not(.erga-brand, .erga-sep)")]
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(" › ");
  const doc = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content;
  const page = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content;
  const editor = window.ergaPage as { agentContext?: () => string | null } | undefined;
  const editing = document.body.classList.contains("erga-editing") ? editor?.agentContext?.() : null;
  return `Open: ${trail || document.title} (${location.pathname}).${doc ? ` The document ${doc}${page ? `, its file ${page}` : ""}${editing ? ", in the editor" : ""}.` : ""}${editing ? `\n${editing}` : ""}`;
}

/** Sends a message, with the tab's own id for it (sends.ts): Try again sends it again with the same id. */
function ask(text: string, ctx: string | null, files: Attachment[] = []) {
  const id = crypto.randomUUID();
  const post = () => void postMessage(id, { text, context: ctx, files, doc: DOC, id }, files.length > 0);
  talk.pending(id, text, fileRefs(files), post);
  post();
}
async function postMessage(id: string, body: object, withFiles: boolean) {
  // While the server restarts (a redeploy) it doesn't answer, or its gateway says so: the message waits and goes once it's back.
  let res: Response | Error = new Error("not sent");
  for (let i = 0, until = Date.now() + 45_000; ; i++) {
    res = await call("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(withFiles ? 60_000 : 15_000),
    }).catch((e: Error) => e);
    if (res instanceof Response ? res.ok || !transient(res) : res.name == "TimeoutError" || !transient(res)) break;
    if (Date.now() + backoff(i) > until) break;
    await sleep(backoff(i));
  }
  if (!(res instanceof Response) || !res.ok) {
    const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string; error?: string } | null)?.reason ?? `the server answered ${res.status}` : res.name == "TimeoutError" ? "the server didn't answer in time" : "the server didn't answer";
    talk.failed(id, reason);
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

/** The conversation in the panel: as the tab's last page left it, until load() reads it. */
let phase: PanelPhase = "as-left";
// Events heard: one that comes while load() asks for the conversation may be newer than its answer, so load() asks again (up to 5 times).
let heard = 0, down = 0, downTimer = 0;
async function load(tries = 0, fresh = false): Promise<void> {
  const was = heard;
  clearTimeout(downTimer);
  // The conversation from where the server keeps it, whether the agent is on or not.
  const kept = call("/api/agent/conversation")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) as Promise<{ log?: Log } | null>;
  let again = false;
  const a = (await call(fresh ? "/api/agent?fresh" : "/api/agent")
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
  if (heard != was && tries < 5) return load(tries + 1, fresh);
  off = a.enabled ? null : `The agent is off: ${a.reason ?? "the server did not start it"}.`;
  // The editor's buttons that ask the agent (the toast's fix: client/shell/toast.ts) follow its state.
  window.dispatchEvent(new Event("erga:agent-state"));
  renderModel(a);
  if (l) { log.items = l.items; log.busy = l.busy; log.undoable = l.undoable; }
  talk.render();
  phase = panelStep(phase, { t: "loaded" }).state;
  renderBusy();
}

// The agent's events, to this person only; a reconnect reads the whole conversation again. They come over a
// WebSocket, not an EventSource: over HTTP/1.1 an EventSource holds one of the browser's six connections to the host
// while the page is open, and with a few tabs open every later request waits. A socket that closes (the server
// restarts) is made again, a little later each time.
let socketPhase: SocketPhase = { at: "stopped" };
let retry = 0;
const socketNext = socketStep();
/** An event of the socket's: its new phase, and what that asks for (shared/socket-phase.ts). */
function go(e: PhaseEvent): void {
  const next = socketNext(socketPhase, e);
  socketPhase = next.phase;
  if (socketPhase.at != "backoff") clearTimeout(retry);
  for (const f of next.effects) {
    if (f.do == "connect") connect();
    else if (f.do == "retry") retry = window.setTimeout(() => go({ type: "timer" }), backoff(f.tries));
    else if (f.do == "up" || f.do == "down") {
      const state = f.do;
      live((l) => l.connection("agent", state));
      if (state == "up") load();
    }
  }
}
function connect() {
  const ws = new WebSocket(`${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${asUser("/api/agent/events")}`);
  ws.onopen = () => go({ type: "opened" });
  ws.onclose = () => go({ type: "closed" });
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
load().then(() => go({ type: "start" }));

// The panel as this page leaves it, for the tab's next page: client/inline/agent-toggle.ts draws it there before the
// page paints, so the conversation doesn't empty and come back from page to page. Until this page has loaded the
// conversation, its panel shows the tab's copy, which stays as it is (client/common/agent-panel.ts).
window.addEventListener("pagehide", () => {
  const l = $("agent-log"),
    model = $("agent-model");
  const { save } = panelStep(phase, {
    t: "leave",
    drawn: {
      person: $("agent").dataset.person ?? "",
      log: talk.drawn(),
      model: model.innerHTML,
      choice: model.querySelector("select")?.value,
      top: l.scrollTop,
      bottom: l.scrollHeight - l.scrollTop - l.clientHeight <= 8,
    },
  });
  if (save) savePanel({ drawn: save });
});

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
// never undoes the agent's edits. Redo puts back what Undo took back, until the agent changes the document again. The
// document's host keeps each person's agent's changes (document/host.ts).
const undoBtn = $("agent-undo") as HTMLButtonElement,
  redoBtn = $("agent-redo") as HTMLButtonElement;
let undoable = 0,
  redoable = 0;
function renderUndo() {
  const why = !undoable ? "Your agent hasn't changed this document since it opened" : null;
  undoBtn.setAttribute("aria-disabled", String(!!why));
  undoBtn.dataset.tip = why ?? `Undo the agent's last change (${undoable} to go)`;
  const whyNot = !redoable ? "Nothing to redo" : null;
  redoBtn.setAttribute("aria-disabled", String(!!whyNot));
  redoBtn.dataset.tip = whyNot ?? `Redo the agent's last undone change (${redoable} to go)`;
}
async function readUndo() {
  if (!BASE) return;
  const a = (await fetch(`${BASE}${asUser("/api/agent/undo")}`).then(
    (r) => (r.ok ? r.json() : null),
    () => null
  )) as { count?: number; redo?: number } | null;
  undoable = a?.count ?? 0;
  redoable = a?.redo ?? 0;
  renderUndo();
}
undoBtn.hidden = redoBtn.hidden = !BASE;
if (BASE) {
  const wire = (btn: HTMLButtonElement, which: "undo" | "redo", count: () => number) =>
    btn.addEventListener("click", async () => {
      if (!count()) {
        showHint(btn.dataset.tip ?? "");
        return;
      }
      const r = await fetch(`${BASE}${asUser(`/api/agent/${which}`)}`, { method: "POST" }).catch(() => null);
      if (!r?.ok) showHint(`Couldn't ${which} the agent's change. Try again.`);
      void readUndo();
    });
  wire(undoBtn, "undo", () => undoable);
  wire(redoBtn, "redo", () => redoable);
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
  const v = (voice = { rec, before, sent: 0, results: 0, heard: "", partial: false, timer: 0, due: false });
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
    v.due = false;
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
  rec.onend = () => {
    if (voice != v) return;
    listenVoice((v.before + " " + v.heard).trim());
    if (voice) voice.due = v.due;
  };
  try { rec.start(); } catch { stopVoice(); }
}
function voiceSend() {
  const v = voice;
  if (!v) return;
  const text = (v.before + " " + v.heard).trim();
  if (!text) return;
  // Kept in the box until it can go: the agent back on, the files read (then it goes by itself).
  const why = gate("voice", text);
  v.due = !!why;
  if (why) {
    showHint(why, why == off);
    return;
  }
  v.before = "";
  v.heard = "";
  input.value = "";
  store.set(DRAFT, null);
  const files = att.files;
  att.clear();
  sizeInput();
  ask(text, context(), files);
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
    const why = gate("editor", text);
    if (why) showHint(why, why == off);
    else ask(text, ctx ?? context());
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

// Settings (client/agent/settings-dialog.ts) and Send feedback (client/agent/feedback-dialog.ts): dialogs on any page,
// each loaded the first time it's asked for. The account menu's Settings and Send feedback, and any link to
// "#settings" or "#feedback", open them; so does an address that ends with one. A key saved or removed in Settings
// gives the agent other models: the panel reads them again.
const DIALOGS: Record<string, () => void> = {
  "#settings": () => void import("./settings-dialog").then((m) => m.openSettings()),
  "#feedback": () => void import("./feedback-dialog").then((m) => m.openFeedback()),
};
const openDialog = (hash: string) => {
  if (location.hash == hash) history.replaceState(history.state, "", location.pathname + location.search);
  DIALOGS[hash]();
};
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    const hash = a && new URL((a as HTMLAnchorElement).href, location.href).hash;
    if (!hash || !DIALOGS[hash] || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openDialog(hash);
  },
  true
);
window.addEventListener("hashchange", () => DIALOGS[location.hash] && openDialog(location.hash));
if (DIALOGS[location.hash]) openDialog(location.hash);
window.addEventListener("erga:agent-keys", () => void load(0, true));
