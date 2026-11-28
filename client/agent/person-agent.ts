// Each person's agent panel, on every page for someone signed in (server/pages/agent.ts has its markup; the circle grows
// into it: client/inline/agent-toggle.ts). The panel is the editor's (the same markup, styles and conversation,
// agent-chat.ts), talking to the person's own agent in their PersonAgent object (agents/person/agent.ts,
// agents/person/sessions.ts):
//
//   GET  /api/agent              the state: on or off (and why), the model, the conversation so far (?fresh: the
//                                settings read now, after a key changed; else they may be up to 5 s old)
//   POST /api/agent              { text, context, page? }: a message; context is the page note (the page open, what is
//                                selected), page the editor's context for a feedback (the setting feedback_context)
//   (each of them with ?doc=<the document's id> on a page of a document: that document's thread)
//   POST /api/agent/abort|reset|model|approve|deny
//   /api/agent/events            { type: "agent", ev } for this person's agent (a WebSocket)
//   GET|DELETE /api/agent/conversation   the conversation, kept on the server (read on mount); a new one
//
// The panel shows one thread: the document's own, on a page of a document (DOC), and one for the rest of Erga on
// every other page. Each request names the document (?doc=), so a page hears and changes only its thread; a turn that
// runs in another thread goes on there, and this panel shows nothing of it. A thread follows the person from browser
// to browser and sign-in to sign-in: the server keeps it. Built by client/build.ts to agent.js.

import { chat } from "./agent-chat";
import { classify, fileRefs, type Attachment } from "../../shared/attach";
import { attachments } from "./attach-ui";
import { canSend, type SendPath } from "./send-gate";
import { turnEnded, type Log, type LogEvent } from "../../shared/agent-log";
import { backoff, live, transient } from "../live/client";
import { liveSocket } from "../live/socket";
import { restoredFor } from "../live/restore";
import { sleep } from "../../shared/time";
import { agentPrompt } from "../common/agent-prompt";
import { showCopied } from "../common/copied";
import { asUser } from "../common/tools";
import {
  blockedStep,
  connectionStep,
  IDLE_BLOCKED,
  IDLE_CONNECTION,
  isLocalChoiceId,
  pageDoc,
  panelStep,
  savePanel,
  threadEventStep,
  type BlockedState,
  type ConnectionEvent,
  type ConnectionState,
  type PanelPhase,
} from "../common/agent-panel";
import { watchViewport } from "../common/viewport";
import { mountTurn, type TurnFacts } from "./turn-summary";
import { mountVoice, type VoiceControl } from "./voice";

interface AgentState {
  enabled: boolean;
  reason?: string;
  model?: string | null;
  choice?: string | null;
  thread?: string;
  disconnected?: boolean;
  models?: { id: string; label: string; group?: "local" | "embedded"; key?: "own" | "server"; agent?: string; disconnected?: boolean }[];
  log?: Log;
}

const $ = (id: string) => document.getElementById(id)!;
watchViewport();
/** The document the page has open, if any: its thread is the panel's, and its document tools' own when the agent names none. */
const DOC = pageDoc();
/** A path of the agent's API, for this page's thread. */
const inThread = (path: string) => (DOC ? `${path}${path.includes("?") ? "&" : "?"}doc=${encodeURIComponent(DOC)}` : path);
/** A request to the agent's API about this page's thread, as whoever this tab is. */
const call = (path: string, init?: RequestInit) => fetch(asUser(inThread(path)), { ...init, credentials: "same-origin" });
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
  set_publishing: ["Changing the document's domain", "Changed the document's domain"],
  publish_document: ["Publishing the document", "Published the document"],
  run_command: ["Running command", "Ran command"],
  read_file: ["Reading", "Read"],
  view_file: ["Reading", "Read"],
  edit_file: ["Editing", "Edited"],
  replace_file_content: ["Editing", "Edited"],
  multi_replace_file_content: ["Editing", "Edited"],
  write_file: ["Writing", "Wrote"],
  write_to_file: ["Writing", "Wrote"],
  list_dir: ["Listing", "Listed"],
  find_by_name: ["Finding", "Found"],
  grep_search: ["Searching", "Searched"],
  search_web: ["Searching the web", "Searched the web"],
  read_url_content: ["Reading page", "Read page"],
  call_mcp_tool: ["Calling tool", "Called tool"],
};

/** Its host, for someone who may edit it (meta erga-base): the agent's edits there, which Undo takes back. */
const BASE = document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')?.content ?? null;
const input = $("agent-input") as HTMLTextAreaElement,
  send = $("agent-send") as HTMLButtonElement,
  hint = $("agent-hint"),
  banner = $("agent-banner");
const talk = chat({
  logEl: $("agent-log"),
  jump: $("agent-jump") as HTMLButtonElement,
  verbs: VERBS,
  imageAlt: "The screenshot the agent looked at",
  externalTip: "An agent you shared this page with, working as your agent",
  answer: async (id, approve, choice) => {
    const r = await call(`/api/agent/${approve ? "approve" : "deny"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...(choice ? { choice } : {}) }),
    }).catch(() => null);
    if (r?.ok) return;
    const a = (await r?.json().catch(() => null)) as { reason?: string } | null;
    showHint(`Your answer didn't arrive: ${a?.reason ?? "the server didn't answer"}.`, true);
    // The call may still wait: the buttons work again.
    for (const b of $("agent-log").querySelectorAll<HTMLButtonElement>("button[data-answer]")) if (b.dataset.call == id) b.disabled = false;
  },
});
const log = talk.log;
let off: string | null = "Connecting to the agent…";
let hintTimer = 0;
/** The alert for a turn that failed while the panel was closed: it goes when the panel opens. */
const TURN_FAILED = "agent:turn";
// Files to go with the next message: dropped on the panel, pasted, or picked.
const att = attachments({
  pane: $("agent"),
  form: $("agent-form"),
  input,
  hint: (t) => showHint(t),
  // In the editor, a file that a message can't take (a PDF, a video) can go into the document's files, where the
  // agent reads it: an alert offers that (client/shell/uploads.ts sends it). Its path goes into the message.
  refuse(file, name) {
    const alerts = window.ergaAlerts,
      uploads = window.ergaUploads;
    if (!alerts || !uploads) return false;
    const key = `attach:${name}`;
    alerts.raise(
      {
        key,
        kind: "error",
        source: "agent",
        title: `“${name}” is not attached`,
        detail: classify(name, file.type) ? "it is too large for a message." : "a message takes images and text files only.",
        actions: [
          { id: "add", label: "Add it to the document for the agent", primary: true },
          { id: "remove", label: "Remove" },
        ],
      },
      (action) => {
        if (action == "add") {
          const [path] = uploads.addIn(file.type.startsWith("image/") ? "images" : "files", [new File([file], name, { type: file.type })]);
          input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? " " : ""}${path} `;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        }
        if (action == "add" || action == "remove") alerts.end(key);
      }
    );
    return true;
  },
  changed: () => renderBusy(),
});

// The end of a turn: what it changed here, with "See changes" and "Undo the turn" (turn-summary.ts).
const turn = BASE
  ? mountTurn({
      el: $("agent-turn"),
      diff: async () => {
        const r = await fetch(`${BASE}${asUser("/api/turn-diff")}`);
        if (!r.ok) throw new Error("Couldn't read the changes. Try again.");
        return ((await r.json()) as { diff: string }).diff;
      },
      undo: async () => {
        const r = await fetch(`${BASE}${asUser("/api/undo-turn")}`, { method: "POST" });
        return r.ok ? ((await r.json()) as { undone: number }).undone : 0;
      },
      changed: () => void readUndo(),
      hint: (t) => showHint(t),
    })
  : null;
let wasBusy: boolean | null = null;
/** The agent started or stopped (renderBusy calls it): the turn's line follows, with the counts as the turn left them. */
function busyChanged() {
  if (log.busy == wasBusy) return;
  // A turn that ended: the comment box hears it, for a thread that waits for a reply (client/common/comment-box.ts).
  if (wasBusy && !log.busy) window.dispatchEvent(new CustomEvent("erga:agent-turn-end", { detail: turnEnded(log) }));
  wasBusy = log.busy;
  turn?.busy(log.busy);
  if (!log.busy) void readUndo();
}
function showHint(text: string, sticky = false, error = false) {
  clearTimeout(hintTimer);
  delete hint.dataset.off;
  delete hint.dataset.voice;
  hint.textContent = text;
  hint.hidden = false;
  hint.classList.toggle("sticky", sticky);
  hint.classList.toggle("error", error);
  if (!sticky) hintTimer = window.setTimeout(hideHint, 2600);
}
function hideHint() {
  clearTimeout(hintTimer);
  delete hint.dataset.off;
  delete hint.dataset.voice;
  hint.hidden = true;
  hint.classList.remove("sticky", "error");
}
let holdAfterStop = false;
let voice: VoiceControl | null = null;
let blocked: BlockedState = IDLE_BLOCKED;
let conn: ConnectionState = IDLE_CONNECTION;
let connTimer = 0;
let hasEmbeddedModels = false;
const RECONNECTED_MS = 3_000;
const disconnectedReason = (): string | null => (conn.at == "disconnected" ? `${conn.label} is disconnected` : null);
function renderBanner() {
  $("agent-fab").classList.toggle("disconnected", conn.at == "disconnected");
  const isDisc = conn.at == "disconnected" && !conn.dismissed;
  const isRe = conn.at == "reconnected";
  if (!isDisc && !isRe) {
    banner.hidden = true;
    banner.className = "agent-banner";
    banner.textContent = "";
    return;
  }
  const label = conn.at == "disconnected" || conn.at == "reconnected" ? conn.label : "";
  banner.hidden = false;
  banner.className = `agent-banner ${isDisc ? "disconnected" : "reconnected"}`;
  banner.textContent = "";
  const dot = document.createElement("span");
  dot.className = "b-dot";
  dot.setAttribute("aria-hidden", "true");
  const body = document.createElement("span");
  body.className = "b-body";
  const title = document.createElement("span");
  title.className = "b-title";
  title.textContent = isDisc ? `Disconnected from ${label}` : `Reconnected to ${label}`;
  body.append(title);
  if (isDisc) {
    const detail = document.createElement("span");
    detail.className = "b-detail";
    if (hasEmbeddedModels) {
      detail.textContent = "Waiting to reconnect. Switch models above to use another agent.";
    } else {
      detail.append("Waiting to reconnect, or ");
      const link = document.createElement("a");
      link.href = "#settings";
      link.textContent = "add an LLM provider key";
      detail.append(link, ".");
    }
    body.append(detail);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "b-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => syncConnection({ t: "dismiss" }));
  banner.append(dot, body, close);
}
function syncConnection(ev: ConnectionEvent) {
  const res = connectionStep(conn, ev);
  conn = res.state;
  if (res.effect?.t == "cancel-clear") {
    clearTimeout(connTimer);
    connTimer = 0;
  } else if (res.effect?.t == "schedule-clear") {
    clearTimeout(connTimer);
    connTimer = window.setTimeout(() => {
      connTimer = 0;
      syncConnection({ t: "reconnected-timeout" });
    }, RECONNECTED_MS);
  }
  renderBanner();
}
/** Why a message can't go by this path now (send-gate.ts), or null if it can. */
const gate = (path: SendPath, text: string) =>
  canSend(path, { off, disconnected: disconnectedReason(), reading: att.reading, text, files: att.files.length });
/** Why Send can't send right now, or null if it can. */
const blocker = () => gate("box", input.value);
function renderBusy() {
  busyChanged();
  // At work: as the server says, or a message of this tab's on its way to it.
  const busy = log.busy || talk.sending();
  const askingIds = log.items.flatMap((it) => (it.kind == "tool" && it.status == "asking" ? [it.id] : []));
  const asking = askingIds.length > 0;
  const nextBlocked = blockedStep(blocked, { t: "sync", asking: askingIds, open: !!window.ergaAgent?.open() });
  blocked = nextBlocked.state;
  if (nextBlocked.expand) window.ergaAgent?.show(true, { focus: false, persist: false });
  const disc = disconnectedReason();
  const stop = !disc && busy && !input.value.trim() && !att.files.length && !att.reading;
  const why = off ?? disc ?? (stop ? null : blocker());
  send.textContent = stop ? "Stop" : "Send";
  send.classList.toggle("stop", stop);
  send.setAttribute("aria-disabled", String(!!why));
  send.title = why ?? (stop ? "Stop the agent" : busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
  $("agent-fab").classList.toggle("busy", busy);
  input.placeholder = off ? "The agent is off" : disc ? disc : busy ? "Add to this turn…" : "Ask the agent…";
  // (Drawn again only when it changed: the key field below it keeps what's typed.)
  if (off) {
    if (hint.dataset.off != off || hint.hidden) {
      showHint(off, true);
      hint.dataset.off = off;
    }
    noKeyLinks();
  } else if (hint.dataset.off) hideHint();
  const holdQueue = holdAfterStop && !busy;
  if (holdQueue) holdAfterStop = false;
  voice?.sync({ busy, asking, off: off ?? disc, readingFiles: att.reading, files: att.files.length, holdQueue });
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

/** What the editor's menu knows of the account (meta erga-account, server/documents/view.ts): {} on any other page. */
const accountMeta = (): Record<string, unknown> =>
  JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="erga-account"]')?.content ?? "{}");

/**
 * The editor's context for a feedback (shared/feedback-context.ts), while the server asks for it (the setting
 * feedback_context): it goes with each message, and the agent's send_feedback keeps the last one.
 */
function feedbackContext(): object | undefined {
  if (!accountMeta().feedbackContext || !document.body.classList.contains("erga-editing")) return undefined;
  return (window.ergaPage as { feedbackContext?: () => object } | undefined)?.feedbackContext?.();
}

/** Sends a message, with the tab's own id for it (sends.ts): Try again sends it again with the same id. */
function ask(text: string, ctx: string | null, files: Attachment[] = []) {
  const id = crypto.randomUUID();
  const page = feedbackContext();
  const post = () => void postMessage(id, { text, context: ctx, files, id, page }, files.length > 0);
  talk.pending(id, text, fileRefs(files), post);
  begin();
  post();
  // The agent shows at work from now, not from the server's first word of it.
  renderBusy();
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
function sendPrompt(text: string, clearInput = false): boolean {
  const files = att.files;
  const why = gate("box", text);
  if (why || (!text && !files.length)) {
    // Off or disconnected: surface the panel's status directly.
    if (off) {
      delete hint.dataset.off;
      renderBusy();
    } else if (disconnectedReason()) {
      syncConnection({ t: "remind" });
    } else showHint(why ?? "Type a message to send it.");
    return false;
  }
  holdAfterStop = false;
  if (clearInput) {
    voice?.manualSend();
    input.value = "";
  }
  store.set(DRAFT, clearInput ? null : input.value || null);
  att.clear();
  if (clearInput) sizeInput();
  ask(text, context(), files);
  return true;
}
function sendNow() {
  if (!sendPrompt(input.value.trim(), true)) input.focus();
}

// The box sizes itself with field-sizing: content, and its wrapper eases to the new height (as in the editor).
const field = $("agent-field");
const fieldSizing = CSS.supports("field-sizing", "content");
function sizeInput() {
  if (!fieldSizing) {
    if (!input.value) input.style.height = "";
    else {
      input.style.height = "auto";
      input.style.height = input.scrollHeight + 2 + "px";
    }
  }
  renderBusy();
}
// Persistent Voice Mode (client/agent/voice.ts): waveform button, Web Speech dictation, "send prompt" trigger, and queue.
voice = mountVoice({
  pane: $("agent"),
  form: $("agent-form"),
  field,
  input,
  sendBtn: send,
  fab: $("agent-fab"),
  send: (text) => {
    sendPrompt(text);
  },
  onInput: (draft) => {
    store.set(DRAFT, draft);
    sizeInput();
  },
  hint: (text, sticky, error) => {
    showHint(text, sticky, error);
    if (sticky) hint.dataset.voice = "1";
  },
  clearVoiceHint: () => {
    if (hint.dataset.voice) hideHint();
  },
});
// (In the next frame, not in the observer's own call: the wrapper's height changes the log's, which has an observer too
// (agent-chat.ts), and a size that an observer's call changes gives the window an error event, "ResizeObserver loop
// completed with undelivered notifications", in every browser.)
new ResizeObserver(() =>
  requestAnimationFrame(() => {
    const h = Math.ceil(input.getBoundingClientRect().height);
    if (h) field.style.height = h + "px";
  })
).observe(input);

// An unsent message survives a reload (kept in this browser only).
const DRAFT = "erga:factory-agent-draft:v1"; // its old name, so a draft from before survives
const draft = store.get(DRAFT);
if (draft) { input.value = draft; sizeInput(); }
input.addEventListener("input", () => {
  if (voice?.writing) return;
  if (!hint.classList.contains("sticky")) hideHint();
  sizeInput();
  store.set(DRAFT, input.value || null);
  voice?.inputEdited(input.value);
});
input.addEventListener("keydown", (e) => { if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); } });
$("agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (send.classList.contains("stop")) {
    holdAfterStop = true;
    call("/api/agent/abort", { method: "POST" });
  } else sendNow();
});
$("agent-reset").addEventListener("click", () => {
  if (disconnectedReason()) {
    syncConnection({ t: "remind" });
    return;
  }
  voice?.resetConversation();
  call("/api/agent/conversation", { method: "DELETE" }).then(
    (r) => {
      if (!r.ok) showHint("Couldn't start a new conversation.");
    },
    () => showHint("Couldn't start a new conversation.")
  );
  if (!matchMedia("(pointer: coarse)").matches) input.focus();
});
window.addEventListener("erga:agent-shown", (e) => {
  talk.follow(true);
  if ((e as CustomEvent<{ focus?: boolean }>).detail?.focus !== false) input.focus();
  window.ergaAlerts?.end(TURN_FAILED);
});

let activeThread: string | null = $("agent").dataset.thread || null;

function swapLog(l: Log) {
  log.items = l.items;
  log.busy = l.busy;
  log.undoable = l.undoable;
  talk.render();
}

function updateThreadChrome(choice?: string | null, label?: string | null, disconnected = false) {
  const isLocal = isLocalChoiceId(choice);
  const head = $("agent").querySelector(".agent-head");
  head?.classList.toggle("is-local", isLocal);
  head?.classList.toggle("is-disconnected", isLocal && disconnected);
  const logEl = $("agent-log");
  if (isLocal && label && !disconnected) logEl.dataset.threadNote = `Connected to ${label} · New thread`;
  else delete logEl.dataset.threadNote;
}

function applyThreadState(
  nextThread: string | undefined,
  nextLog: Log | undefined,
  choice?: string | null,
  label?: string | null,
  disconnected = false
) {
  const target = nextThread ?? activeThread ?? "embedded";
  const res = threadEventStep(activeThread, { t: "sync", thread: target });
  const switched = res.effect.action == "swap" && res.effect.switched;
  activeThread = res.thread;
  if (activeThread) $("agent").dataset.thread = activeThread;
  if (switched) {
    blocked = IDLE_BLOCKED;
    talk.clearPending();
    if (!hint.dataset.off && !hint.dataset.voice) hideHint();
    turn?.facts(null);
    void readUndo();
  }
  updateThreadChrome(choice, label, disconnected);
  if (nextLog) {
    if (switched) wasBusy = nextLog.busy;
    swapLog(nextLog);
  }
}

// Which model or connected local agent the panel talks to: connected agents show in a section above built-in models.
function renderModel(m: AgentState | null) {
  const el = $("agent-model");
  el.textContent = "";
  hasEmbeddedModels = !!m?.models?.some((o) => o.group != "local");
  if (!m || !m.enabled) { el.textContent = "off"; return; }
  if (!m.models?.length || !m.choice) { el.textContent = m.model ?? ""; return; }
  const sel = document.createElement("select");
  sel.id = "agent-model-select";
  sel.setAttribute("aria-label", "Model");
  const optionFor = (o: NonNullable<AgentState["models"]>[number]) =>
    new Option(
      o.disconnected ? `${o.label} (disconnected)` : o.key == "own" ? `${o.label} (your key)` : o.label,
      o.id,
      false,
      o.id == m.choice
    );
  const locals = m.models.filter((o) => o.group == "local");
  const embedded = m.models.filter((o) => o.group != "local");
  if (locals.length) {
    const lg = document.createElement("optgroup");
    lg.label = "Connected agents";
    for (const o of locals) lg.append(optionFor(o));
    sel.append(lg);
    if (embedded.length) {
      const eg = document.createElement("optgroup");
      eg.label = "Built-in models";
      for (const o of embedded) eg.append(optionFor(o));
      sel.append(eg);
    }
  } else {
    // A model the person's own key runs says so; the others run on the server's keys.
    for (const o of embedded) sel.append(optionFor(o));
  }
  sel.title = "The agent or model this panel uses; connected agents keep their own conversation";
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
    const nextChoice = r.choice ?? sel.value;
    const nextLabel = r.model ?? sel.selectedOptions[0]?.text ?? null;
    renderModel({ ...r, enabled: true });
    syncConnection({ t: "sync", choice: nextChoice, label: nextLabel, disconnected: !!r.disconnected });
    applyThreadState(r.thread, r.log, nextChoice, nextLabel, !!r.disconnected);
    renderBusy();
    showHint(log.busy ? `${nextLabel}: from your next message` : `Switched to ${nextLabel}`);
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
  const l = a.log ?? (await kept)?.log;
  if (heard != was && tries < 5) return load(tries + 1, fresh);
  off = a.enabled ? null : `The agent is off: ${a.reason ?? "the server did not start it"}.`;
  // The editor's buttons that ask the agent (an alert's fix: client/shell/alerts.ts) follow its state.
  window.dispatchEvent(new Event("erga:agent-state"));
  renderModel(a);
  syncConnection({
    t: "sync",
    choice: a.enabled ? (a.choice ?? null) : null,
    label: a.enabled ? (a.model ?? null) : null,
    disconnected: !!a.disconnected,
  });
  applyThreadState(a.thread, l, a.enabled ? a.choice : null, a.enabled ? a.model : null, !!a.disconnected);
  phase = panelStep(phase, { t: "loaded" }).state;
  renderBusy();
}

// The agent's events, to this person only; a reconnect reads the whole conversation again. They come over a
// WebSocket, not an EventSource: over HTTP/1.1 an EventSource holds one of the browser's six connections to the host
// while the page is open, and with a few tabs open every later request waits. A socket that closes (the server
// restarts) is made again, a little later each time.
const events = liveSocket({
  name: "agent",
  path: inThread("/api/agent/events"),
  ping: true,
  up: () => void load(),
  message(e) {
    let m: { type?: string; ev?: LogEvent } & Partial<AgentState>;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    // The model or connected local agent changed (a bridge connected/disconnected, or switched in another tab).
    if (m.type == "model") {
      heard++;
      if (m.enabled === false) {
        off = `The agent is off: ${m.reason ?? "the server did not start it"}.`;
        renderModel(null);
      } else {
        off = null;
        renderModel({ ...m, enabled: true });
      }
      syncConnection({
        t: "sync",
        choice: m.enabled === false ? null : (m.choice ?? null),
        label: m.enabled === false ? null : (m.model ?? null),
        disconnected: m.enabled !== false && !!m.disconnected,
      });
      applyThreadState(
        m.enabled === false ? "embedded" : m.thread,
        m.log,
        m.enabled === false ? null : m.choice,
        m.enabled === false ? null : m.model,
        m.enabled !== false && !!m.disconnected
      );
      window.dispatchEvent(new Event("erga:agent-state"));
      renderBusy();
    }
    if (m.type == "log" && m.log) {
      heard++;
      const step = threadEventStep(activeThread, { t: "log", thread: m.thread });
      if (step.effect.action == "resync") {
        void load();
        return;
      }
      activeThread = step.thread;
      if (activeThread) $("agent").dataset.thread = activeThread;
      swapLog(m.log);
      renderBusy();
    }
    if (m.type == "agent" && m.ev) {
      heard++;
      const step = threadEventStep(activeThread, { t: "agent", thread: m.thread });
      if (step.effect.action == "resync") {
        void load();
        return;
      }
      activeThread = step.thread;
      if (activeThread) $("agent").dataset.thread = activeThread;
      talk.apply(m.ev);
      renderBusy();
      // The agent stopped on an error, with its panel closed: in the editor, an alert says so (client/shell/alerts.ts).
      if (m.ev.t == "error" && !document.body.classList.contains("agent-open"))
        window.ergaAlerts?.raise(
          {
            key: TURN_FAILED,
            kind: "error",
            source: "agent",
            title: "Your agent stopped",
            detail: m.ev.text,
            actions: [{ id: "show", label: "Show" }],
          },
          (action) => {
            if (action == "show") window.ergaAgent?.show(true);
        });
      // A tool call done: the document open may have changed (Undo's count).
      if (m.ev.t == "tool" && m.ev.status != "running") window.dispatchEvent(new Event("erga:agent-tool"));
    }
  },
});
// The start. The socket's opening reads the conversation (`up`): what the agent did before the socket heard it.
// With the panel closed, that is the one read, and it waits until the page has loaded and the browser is idle, or
// until the panel opens: the page never waits for a panel nobody looks at. With the panel open, the conversation is
// read at once too; the socket still waits for the idle browser, so the editor's own sockets connect first (a browser
// opens its sockets to one host one at a time).
let begun = false;
function begin() {
  if (begun) return;
  begun = true;
  events.start();
}
if (document.body.classList.contains("agent-open")) void load();
else
  new MutationObserver((_, o) => {
    if (!document.body.classList.contains("agent-open")) return;
    o.disconnect();
    begin();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
{
  const idle = () => (window.requestIdleCallback ?? setTimeout)(begin);
  if (document.readyState == "complete") idle();
  else addEventListener("load", idle, { once: true });
}

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
      doc: DOC,
      log: talk.drawn(),
      model: model.innerHTML,
      choice: model.querySelector("select")?.value,
      thread: activeThread ?? undefined,
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
  l.hold(() => (voice?.armed ? "voice mode is on" : att.reading ? "files are being read" : null));
  l.keep("agent", (): Kept => ({ files: att.files }));
});
const back = restoredFor<Kept>("agent");
if (back?.files?.length) att.restore(back.files);

// ---------------------------------------------------------------- the document open

// Undo takes back the agent's last change to the document open (one tool call), whoever has typed since: your own ⌘Z
// never undoes the agent's edits. Redo puts back what Undo took back, until the agent changes the document again. The
// document's host keeps each person's agent's changes (document/api/host.ts).
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
  const a = (await fetch(`${BASE}${asUser("/api/undo")}`).then(
    (r) => (r.ok ? r.json() : null),
    () => null
  )) as { count?: number; redo?: number; turn?: TurnFacts | null } | null;
  undoable = a?.count ?? 0;
  redoable = a?.redo ?? 0;
  renderUndo();
  turn?.facts(a?.turn ?? null);
}
undoBtn.hidden = redoBtn.hidden = !BASE;
if (BASE) {
  const wire = (btn: HTMLButtonElement, which: "undo" | "redo", count: () => number) =>
    btn.addEventListener("click", async () => {
      if (!count()) {
        showHint(btn.dataset.tip ?? "");
        return;
      }
      const r = await fetch(`${BASE}${asUser(`/api/${which}`)}`, { method: "POST" }).catch(() => null);
      // (It can't now: another agent edits the document's source, say. The document says why.)
      const why = r?.ok ? ((await r.json().catch(() => null)) as { why?: string } | null)?.why : null;
      if (!r?.ok || why) showHint(why ?? `Couldn't ${which} the agent's change. Try again.`);
      void readUndo();
    });
  wire(undoBtn, "undo", () => undoable);
  wire(redoBtn, "redo", () => redoable);
  // After each of the agent's tool calls, and as the panel opens.
  window.addEventListener("erga:agent-tool", () => void readUndo());
  window.addEventListener("erga:agent-shown", () => void readUndo());
  void readUndo();
}

// ---------------------------------------------------------------- for the editor

declare global {
  interface Window {
    /** The panel, for the editor's own "Fix with agent" buttons and its reload (client/shell/). */
    ergaAgentPanel?: {
      ask(text: string, context: string | null): void;
      readonly off: string | null;
      readonly busy: boolean;
      files: typeof att;
    };
  }
}
window.ergaAgentPanel = {
  ask: (text, ctx) => {
    window.ergaAgent?.show(true);
    const why = gate("editor", text);
    if (why && why == disconnectedReason()) syncConnection({ t: "remind" });
    else if (why) showHint(why, why == off);
    else ask(text, ctx ?? context());
  },
  get off() {
    return off ?? disconnectedReason();
  },
  get busy() {
    return log.busy;
  },
  files: att,
};

// Settings (client/agent/settings-dialog.ts), Send feedback (client/agent/feedback-dialog.ts) and Keyboard shortcuts
// (client/common/shortcuts-dialog.ts): dialogs on any page, each loaded the first time it's asked for. The account
// menu's Settings and Send feedback, and any link to "#settings", "#feedback" or "#shortcuts" (the quick search's),
// open them; so does an address that ends with one. A key saved or removed in Settings
// gives the agent other models: the panel reads them again. Send feedback opens only where the server offers it (the
// setting feedback): its link is in the account menu (server/pages/account-menu.ts), or among the editor's (meta
// erga-account, server/documents/view.ts).
const feedbackOn = () => !!document.querySelector('.erga-account-menu a[href="#feedback"]') || "feedback" in accountMeta();
const DIALOGS: Record<string, () => void> = {
  "#settings": () => void import("./settings-dialog").then((m) => m.openSettings()),
  "#feedback": () => void (feedbackOn() && import("./feedback-dialog").then((m) => m.openFeedback())),
  "#shortcuts": () => void import("../common/shortcuts-dialog").then((m) => m.toggleShortcuts()),
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
