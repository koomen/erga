// The agent's panel (⌘J): your agent runs in the host, its conversation is yours alone (your other tabs show it too),
// and its edits arrive through the room like anyone's.

import type { AgentState, ModelState } from "../../document/api";
import type { Log, LogEvent } from "../../shared/agent-log";
import { fileRefs, type Attachment } from "../../shared/attach";
import { FIX_REPORTED, pageReport } from "../../shared/page-report";
import { chat } from "../agent/agent-chat";
import { attachments } from "../agent/attach-ui";
import { mountLayout } from "../agent/layout";
import { backoff, transient } from "../live/client";
import { ms } from "../page-editor/timescale";
import { $, store, type Shell } from "./shell";
import { sleep } from "../../shared/time";

export function mountAgent(shell: Shell) {
  const agentPanel = $("agent"),
    agentCard = agentPanel.querySelector<HTMLElement>(".agent-card")!;
  // Where the agent and the steps list sit around the document, and how wide the agent is.
  mountLayout(agentPanel, agentPanel.querySelector<HTMLElement>(".agent-head")!);
  const agentLog = $("agent-log");
  const agentInput = $("agent-input") as HTMLTextAreaElement;
  const agentSend = $("agent-send") as HTMLButtonElement;
  const agentHint = $("agent-hint");
  // Why the agent can't take a message right now, shown in the panel until it can.
  let agentOff: string | null = "Connecting to the agent…";
  /** The live voice session (voice mode, below), or null when it's off. `sent` counts the session's results already sent, of `results` heard so far. */
  let voice: { rec: Recognition; before: string; sent: number; results: number; heard: string; partial: boolean; timer: number } | null = null;
  let hintTimer = 0;

  // The conversation as the log shows it (agent-chat.ts, which the admin's panel shares).
  const agentChat = chat({
    logEl: agentLog, jump: $("agent-jump") as HTMLButtonElement,
    verbs: { read: ["Reading", "Read"], edit: ["Editing", "Edited"], write: ["Writing", "Wrote"], ls: ["Listing", "Listed"], find: ["Finding files", "Found files"], grep: ["Searching", "Searched"], view_page: ["Looking at the page", "Looked at the page"], evaluate_page: ["Inspecting the page", "Inspected the page"], page_console: ["Reading the page's console", "Read the page's console"], page_network: ["Reading the page's requests", "Read the page's requests"], page_events: ["Reading the page's events", "Read the page's events"], page_inspect: ["Inspecting the live page", "Inspected the live page"], page_click: ["Clicking on the page", "Clicked on the page"], page_key: ["Pressing a key on the page", "Pressed a key on the page"] },
    externalTip: "An agent you shared this page with, working as your agent",
  });
  const log: Log = agentChat.log;
  const follow = agentChat.follow;
  // Files to go with the next message: dropped on the panel, pasted, or picked (attach-ui.ts, as on the admin pages).
  const agentFiles = attachments({ pane: agentPanel, form: $("agent-form"), input: agentInput, hint: (t) => showHint(t), changed: () => renderBusy() });
  function renderLog() {
    agentChat.render();
    renderBusy();
  }
  /** Why Send can't send right now, or null if it can. Never a silent no. */
  function sendBlocker(): string | null {
    if (agentOff) return agentOff;
    if (voice) return "Voice mode is on: what you say is sent when you pause.";
    if (agentFiles.reading) return "Reading the attached files…";
    if (!log.busy && !agentInput.value.trim() && !agentFiles.files.length) return "Type a message to send it.";
    return null;
  }
  function renderBusy() {
    // In voice mode the button can't send, so while the agent works it's Stop.
    const stop = log.busy && (!!voice || (!agentInput.value.trim() && !agentFiles.files.length && !agentFiles.reading));
    const why = agentOff ?? (stop ? null : sendBlocker());
    agentSend.textContent = stop ? "Stop" : "Send";
    agentSend.classList.toggle("stop", stop);
    // aria-disabled rather than disabled: a disabled button gets no hover or
    // click, so it could never say why it's disabled.
    agentSend.setAttribute("aria-disabled", String(!!why));
    agentSend.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
    agentInput.placeholder = agentOff ? "The agent is off" : voice ? "Listening… pause to send" : log.busy ? "Add to what the agent is doing…" : "Ask the agent…";
    if (agentOff) showHint(agentOff, true);
    else if (agentHint.classList.contains("sticky")) hideHint();
    $("agent-fab").classList.toggle("busy", log.busy);
  }
  function showHint(text: string, sticky = false) {
    clearTimeout(hintTimer);
    agentHint.textContent = text;
    agentHint.hidden = false;
    agentHint.classList.toggle("sticky", sticky);
    if (!sticky) hintTimer = window.setTimeout(hideHint, ms(2600));
  }
  function hideHint() {
    clearTimeout(hintTimer);
    agentHint.hidden = true;
    agentHint.classList.remove("sticky");
  }
  function agentEvent(ev: LogEvent) {
    agentChat.apply(ev);
    if (ev.t == "busy") shell.room.setAgentBusy(ev.busy || shell.people.busyAgents().length > 0);
    if (ev.t == "undoable") renderUndo();
    renderBusy();
  }

  /** Where the user is in the document, so "this" and "here" mean something to the agent. */
  function editorContext(): string {
    const at = shell.addressOf(shell.info!.path).replace(/[?#].*$/, "");
    return `The user has the page ${shell.info!.path} open (${at}).\n${viewContext()}\n${caretContext()}`;
  }
  /** How the user sees the page: view_page renders at this size and in this mode unless asked otherwise. */
  function viewContext(): string {
    const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const w = shell.frame.clientWidth, h = shell.frame.clientHeight;
    return `${w && h ? `Their window shows the page at ${w}×${h} CSS pixels` : "Their window shows the source, not the page"}, in ${scheme} mode.`;
  }
  function caretContext(): string {
    const s = shell.currentState();
    const sel = s.selection.main;
    const line = s.doc.lineAt(sel.from);
    if (!sel.empty) {
      const endLine = s.doc.lineAt(sel.to).number;
      const text = s.sliceDoc(sel.from, sel.to);
      return `The user has selected lines ${line.number}-${endLine} of ${shell.info!.name}:\n${text.length > 4000 ? text.slice(0, 4000) + "\n[...]" : text}`;
    }
    const text = line.text.length > 400 ? line.text.slice(0, 400) + "[...]" : line.text;
    return `The user's caret is on line ${line.number} of ${shell.info!.name}: ${text}`;
  }

  async function sendToAgent() {
    const text = agentInput.value.trim();
    const files = agentFiles.files;
    const why = sendBlocker();
    if (why || (!text && !files.length)) {
      showHint(why ?? "Type a message to send it.", !!agentOff);
      agentInput.focus();
      return;
    }
    agentInput.value = "";
    saveDraft();
    agentFiles.clear();
    sizeInput();
    await ask(text, editorContext(), files);
  }
  // A message shows in the log the moment it's sent, dimmed until the host
  // echoes it back as the conversation's (which replaces it). If it can't be
  // sent, it says so, with a way to try again: never a send that silently
  // goes nowhere.
  async function ask(text: string, context: string | null, files: Attachment[] = []) {
    const sent = agentChat.pending(text, fileRefs(files));
    // The agent reads the shared doc; `after` makes the host wait until the
    // room has every edit this tab had made (they travel over the WebSocket).
    // While the host restarts (a redeploy) it doesn't answer, or its gateway says so: the message waits and goes once it's back.
    let res: Response | Error = new Error("not sent");
    for (let i = 0, until = Date.now() + 45_000; ; i++) {
      res = await fetch(shell.api("/api/agent"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context, after: shell.collab.vector(), files }), signal: AbortSignal.timeout(files.length ? 60_000 : 15_000) }).catch((e: Error) => e);
      if (res instanceof Response ? res.ok || !transient(res) : res.name == "TimeoutError" || !transient(res)) break;
      if (Date.now() + backoff(i) > until) break;
      await sleep(backoff(i));
    }
    if (!(res instanceof Response) || !res.ok) {
      const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string } | null)?.reason ?? `the host answered ${res.status}` : res.name == "TimeoutError" ? "the editor's host didn't answer in time" : "the editor's host didn't answer";
      sent.fail(reason, () => ask(text, context, files));
    }
    renderBusy();
  }
  // Voice mode: what you say is dictated into the box and sent when you
  // pause, through the browser's speech recognition (Chrome sends the audio
  // to Google; Safari to Apple). While the agent works, each send steers it,
  // as typing does. The browser's own final results come at every breath, so
  // a pause is our own: no new words for PAUSE_MS. Then everything heard is
  // sent, words not yet final included, and if there were any the session is
  // restarted so they can't arrive again later.
  type Recognition = EventTarget & {
    continuous: boolean; interimResults: boolean; lang: string;
    start(): void; stop(): void; abort(): void;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
  };
  const Speech = ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;
  const PAUSE_MS = 1000;
  const agentVoice = $("agent-voice") as HTMLButtonElement;
  agentVoice.hidden = !Speech;
  function listenVoice(before: string) {
    const rec = new Speech!();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    const v = voice = { rec, before, sent: 0, results: 0, heard: "", partial: false, timer: 0 };
    rec.onresult = (e) => {
      if (voice != v) return;
      let heard = "", partial = false;
      for (let i = v.sent; i < e.results.length; i++) {
        heard += e.results[i][0].transcript;
        if (!e.results[i].isFinal) partial = true;
      }
      Object.assign(v, { heard, partial, results: e.results.length });
      agentInput.value = (v.before + " " + heard).trim();
      sizeInput();
      clearTimeout(v.timer);
      v.timer = window.setTimeout(voiceSend, ms(PAUSE_MS));
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
    if (agentOff) { showHint(agentOff, true); return; } // kept in the box until the agent's back
    v.before = "";
    v.heard = "";
    agentInput.value = "";
    saveDraft();
    const files = agentFiles.files;
    agentFiles.clear();
    sizeInput();
    ask(text, editorContext(), files);
    // Words sent before they were final would come back final: start afresh.
    if (v.partial) { v.partial = false; v.rec.abort(); }
    else v.sent = v.results;
  }
  function startVoice() {
    if (!Speech || voice) return;
    agentVoice.setAttribute("aria-pressed", "true");
    agentInput.readOnly = true;
    listenVoice(agentInput.value.trim());
    renderBusy();
  }
  /** Leaves voice mode; anything heard since the last send stays in the box, to edit or send. */
  function stopVoice() {
    const v = voice;
    if (!v) return;
    voice = null;
    clearTimeout(v.timer);
    v.rec.abort();
    agentVoice.setAttribute("aria-pressed", "false");
    agentInput.readOnly = false;
    saveDraft();
    renderBusy();
    if (document.body.classList.contains("agent-open")) agentInput.focus();
  }
  agentVoice.addEventListener("click", () => voice ? stopVoice() : startVoice());
  /** A "Fix with agent" button of the shell's own (the pause card's): opens the panel and sends its prompt. */
  function fixWithAgent(prompt: string) {
    toggleAgent(true);
    ask(prompt, null);
  }
  /**
   * The toast's "Fix with agent": the problem as the page editor reported it. The page editor shares its origin with the
   * page, so the page's own script can write that report (an error's message, or the whole of it): it goes to the
   * agent as a report in the <editor> block, which the agent reads as data. What the person asks is the shell's words.
   */
  function fixReported(report: string, key?: string) {
    if (key) shell.room.shownProblems.delete(key);
    toggleAgent(true);
    ask(FIX_REPORTED, `${editorContext()}\n${pageReport(report)}`);
  }
  // The box sizes itself with field-sizing: content; its wrapper follows the
  // box's height through a ResizeObserver, and CSS eases the wrapper. Without
  // field-sizing (older browsers) the box is sized here instead, unanimated.
  const agentField = $("agent-field");
  const fieldSizing = CSS.supports("field-sizing", "content");
  function sizeInput() {
    if (!fieldSizing) {
      agentInput.style.height = "auto";
      agentInput.style.height = agentInput.scrollHeight + 2 + "px";
    }
    renderBusy();
  }
  let fieldSized = false;
  new ResizeObserver(() => {
    const h = agentInput.offsetHeight;
    if (!h) return; // the pane is collapsed
    // The first height (say, a restored draft) is set without easing.
    if (!fieldSized) { agentField.style.transition = "none"; agentField.style.height = h + "px"; void agentField.offsetHeight; agentField.style.transition = ""; fieldSized = true; }
    else agentField.style.height = h + "px";
  }).observe(agentInput);
  /** Opens or closes the pane, animated, without remembering it (toggleAgent remembers). (Its "e" button is in it, not inert.) */
  function showAgent(open: boolean) {
    agentCard.inert = !open;
    document.body.classList.toggle("agent-open", open);
    $("agent-fab").setAttribute("aria-expanded", String(open));
  }
  function toggleAgent(force?: boolean) {
    const open = typeof force == "boolean" ? force : !document.body.classList.contains("agent-open");
    showAgent(open);
    shell.settings.agent = open;
    shell.saveSettings();
    if (!open) stopVoice(); // the mic never listens behind a closed panel
    if (open) { shell.chrome.showChrome(); agentInput.focus(); follow(true); }
    else if (shell.sourceView) shell.sourceView.focus();
    else shell.page.focus();
  }

  // An unsent message survives a reload (kept in this browser only).
  const DRAFT_KEY = "erga:agent-draft:v1";
  function saveDraft() {
    if (agentInput.value) store.set(DRAFT_KEY, agentInput.value);
    else try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }
  const draft = store.get(DRAFT_KEY);
  if (draft) { agentInput.value = draft; sizeInput(); }
  agentInput.addEventListener("input", () => { if (!agentHint.classList.contains("sticky")) hideHint(); sizeInput(); saveDraft(); });
  agentInput.addEventListener("keydown", (e) => {
    if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendToAgent(); }
  });
  $("agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (agentSend.classList.contains("stop")) fetch(shell.api("/api/agent/abort"), { method: "POST" });
    else sendToAgent();
  });
  $("agent-reset").addEventListener("click", () => { fetch(shell.api("/api/agent/reset"), { method: "POST" }); agentInput.focus(); });
  // Takes back the agent's last change (one tool call), whoever has typed
  // since: your own ⌘Z never undoes the agent's edits.
  const agentUndo = $("agent-undo") as HTMLButtonElement;
  function undoBlocker(): string | null {
    if (agentOff) return agentOff;
    if (!log.undoable) return "Your agent hasn't changed anything to undo.";
    return null;
  }
  function renderUndo() {
    const why = undoBlocker();
    agentUndo.setAttribute("aria-disabled", String(!!why));
    agentUndo.dataset.tip = why ?? `Undo the agent's last change (${log.undoable} to go)`;
    agentUndo.setAttribute("aria-label", agentUndo.dataset.tip);
  }
  agentUndo.addEventListener("click", async () => {
    const why = undoBlocker();
    if (why) { showHint(why); return; }
    const r = await fetch(shell.api("/api/agent/undo"), { method: "POST" }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!r.ok) showHint("There was nothing left to undo.");
  });
  $("agent-close").addEventListener("click", () => toggleAgent(false));
  $("agent-fab").addEventListener("click", () => toggleAgent(true));
  // Which model the agent runs on: a menu when there's a choice (Sonnet 5.5 or
  // Opus 5.5 fast), plain text otherwise. The choice is per person, kept by the host.
  function renderModel(m: Partial<ModelState> | null) {
    const agentModel = $("agent-model");
    agentModel.textContent = "";
    if (!m) { agentModel.textContent = "off"; return; }
    if (!m.models?.length || !m.choice) { agentModel.textContent = m.model ?? ""; return; }
    const sel = document.createElement("select");
    sel.id = "agent-model-select";
    sel.setAttribute("aria-label", "Model");
    for (const o of m.models) sel.append(new Option(o.label, o.id, false, o.id == m.choice));
    sel.title = "The model your agent runs on; a switch applies from your next message";
    // A select counts as focus-visible even after a click, so the ring is ours
    // to show: for the keyboard, not for whoever just used the mouse.
    sel.addEventListener("pointerdown", () => sel.classList.add("by-pointer"));
    sel.addEventListener("keydown", () => sel.classList.remove("by-pointer"));
    sel.addEventListener("change", async () => {
      const want = sel.value;
      const res = await fetch(shell.api("/api/agent/model"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: want }), signal: AbortSignal.timeout(10_000) })
        .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Partial<ModelState> & { reason?: string } }))
        .catch(() => ({ ok: false, body: { reason: "the editor's host didn't answer" } as Partial<ModelState> & { reason?: string } }));
      if (!res.ok) { sel.value = m.choice!; showHint(`Couldn't switch models: ${res.body.reason ?? "the host refused"}.`); return; }
      renderModel(res.body);
      shell.toast.flash(log.busy ? `${sel.selectedOptions[0]?.text}: from your next message` : `Switched to ${sel.selectedOptions[0]?.text}`);
    });
    agentModel.append(sel);
  }
  /** The agent's state and its transcript, as the host sends it after each hello (document.ts, joinRoom). */
  function agentState(a: AgentState) {
    agentOff = a.enabled ? null : `The agent is off: ${a.reason ?? "the host did not start it"}.`;
    renderModel(a.enabled ? a : null);
    if (a.log) { log.items = a.log.items; log.busy = a.log.busy; log.undoable = a.log.undoable; shell.room.setAgentBusy(a.log.busy || shell.people.busyAgents().length > 0); }
    renderLog();
    renderUndo();
    shell.toast.syncFix();
  }
  return {
    agentState, agentEvent, renderModel, toggleAgent, showAgent, stopVoice, fixWithAgent, fixReported, editorContext, log,
    files: agentFiles, get off() { return agentOff; }, get voice() { return voice; },
  };
}

export type Agent = ReturnType<typeof mountAgent>;
