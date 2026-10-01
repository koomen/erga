// The page editor's shell: loads the document from the local host
// (open.ts), renders it in the page editor, saves edits back to disk as you
// type, follows edits made on disk, and offers the same quiet chrome as the
// Markdown editor: shortcuts and a toggle to the source
// in the Markdown editor, which shares the document state and undo history.
// It also hosts the agent panel (⌘J): messages go to the host, which runs the
// agent; its edits come back as changes on disk and are merged into the page.

import { EditorState, type ChangeSet } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, keymap, drawSelection, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import { PageEditor, type Kind } from "./editor";
import { rebase } from "./merge";
import { emptyLog, reduce, type Log, type LogEvent, type LogItem } from "./agent-log";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

declare global {
  interface Window { scratchPage?: unknown }
}

interface DocInfo { name: string; kind: Kind; text: string; dir: string; version: number }

(async () => {
  const $ = (id: string) => document.getElementById(id)!;

  const KEYS = { settings: "scratchwork-editor:settings:v1" };
  const store = {
    get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
  };
  const settings: { track: boolean; agent: boolean } = { track: false, agent: false, ...store.json(KEYS.settings) };
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));

  // An agent pane left open stays open across reloads: put it back before
  // the first paint, without the open animation.
  if (settings.agent) {
    document.body.classList.add("no-motion", "agent-open");
    ($("agent") as HTMLElement).inert = false;
    $("agent-fab").setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-motion")));
  }

  // ---------------------------------------------------------------- colours

  // There is no dark mode: the documents shown here are rendered as their
  // authors made them, and most don't support one. The shell and the Markdown
  // template are always light (data-theme="light" pins style.css), and the
  // floating controls take their colours from the page under them.
  // The shell paints its canvas with the page's background and tints the
  // floating UI to match (see page.html), so opening the agent never reveals
  // a strip of a different colour. The page's background is its root's, or
  // its body's when the root has none, as the browser itself would paint it.
  let backdropObserver: MutationObserver | null = null;
  function syncBackdrop() {
    const d = frame.contentDocument, win = frame.contentWindow;
    if (!d?.documentElement || !win || !info) return;
    const transparent = (cs: CSSStyleDeclaration) => cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
    let cs = win.getComputedStyle(d.documentElement);
    if (transparent(cs) && d.body) cs = win.getComputedStyle(d.body);
    const root = document.documentElement.style;
    const fallback = info.kind == "md" ? "" : "#ffffff";
    const color = transparent(cs) ? fallback : cs.backgroundColor;
    if (color) root.setProperty("--page-bg", color); else root.removeProperty("--page-bg");
    if (cs.backgroundImage != "none") root.setProperty("--page-bg-image", cs.backgroundImage); else root.removeProperty("--page-bg-image");
    const rgb = (color || getComputedStyle(document.documentElement).getPropertyValue("--bg")).match(/[\d.]+/g)?.map(Number);
    const dark = !!rgb && rgb.length >= 3 && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
    document.body.classList.toggle("page-dark", !!color && dark);
    document.body.classList.toggle("page-light", !!color && !dark);
    // Follow the page if its own script switches themes.
    if (!backdropObserver) backdropObserver = new MutationObserver(() => syncBackdrop());
    backdropObserver.disconnect();
    backdropObserver.observe(d.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (d.body) backdropObserver.observe(d.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  }


  // ---------------------------------------------------------------- load

  const frame = $("frame") as HTMLIFrameElement;
  let info: DocInfo | null = null;
  try {
    const res = await fetch("/api/doc");
    if (!res.ok) throw new Error(await res.text());
    info = (await res.json()) as DocInfo;
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Nothing to edit here.</p><p>Open a page with <code>bun wip/editor/open.ts ./path/to/site</code></p></div>`;
    return;
  }
  const markdownHead = `<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/style.css"><style>
    body { padding: 0; }
    .prose { padding-top: 12vh; padding-bottom: 40vh; }
    .prose li > p { margin: 0; }
    .prose ul.loose li > p { margin: 0 0 0.6em; }
    .prose [data-sw-id]:empty::before, .prose .sw-empty:empty::before { content: ""; }
  </style><script>document.documentElement.setAttribute("data-theme", "light")</script>`;

  // One CodeMirror state serves both the page editor and the source view, so
  // the undo history is shared and either view's edits land in the same file.
  const sourceTheme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--fg)", fontSize: "var(--text-size)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", padding: "14vh var(--gutter) 45vh" },
    ".cm-content": { caretColor: "var(--caret)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--caret)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
    ".cm-line": { padding: "0" },
  });
  const sourceHighlight = HighlightStyle.define([
    { tag: t.heading, fontWeight: "650", color: "var(--fg-strong)" },
    { tag: t.strong, fontWeight: "650" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: [t.processingInstruction, t.meta, t.punctuation, t.angleBracket, t.documentMeta], color: "var(--mark)" },
    { tag: [t.tagName, t.attributeName], color: "var(--soft)" },
    { tag: [t.string, t.attributeValue, t.url, t.link], color: "var(--soft)" },
    { tag: t.monospace, color: "var(--fg)" },
    { tag: t.comment, color: "var(--mark)", fontStyle: "italic" },
  ]);
  let state = EditorState.create({
    doc: info.text,
    extensions: [
      history(),
      info.kind == "md" ? markdown({ base: markdownLanguage }) : html(),
      EditorView.lineWrapping,
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      syntaxHighlighting(sourceHighlight),
      sourceTheme,
      EditorView.updateListener.of((u) => { if (u.docChanged) { scheduleSave(); if (!applyingExternal) hideChrome(); } }),
    ],
  });
  // The last text the editor and the disk agreed on, and the host's version of it.
  let lastSaved = info.text;
  let version = info.version;
  document.title = info.name;

  // ---------------------------------------------------------------- save

  const status = $("status");
  let saveTimer = 0;
  let statusTimer = 0;
  let saving: Promise<void> | null = null;
  function setStatus(text: string, kind?: string) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = "status show" + (kind ? " " + kind : "");
    if (kind != "error") statusTimer = window.setTimeout(() => status.classList.remove("show"), 1600);
  }
  async function saveNow(): Promise<boolean> {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const text = currentState().doc.toString();
    if (text == lastSaved) return true;
    if (saving) await saving;
    saving = (async () => {
      try {
        const res = await fetch("/api/doc", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, version }) });
        if (res.status == 409) {
          // The file changed since our version (the agent, most likely): take
          // that change in, keep ours on top, and save again.
          const r = (await res.json()) as { text: string; version: number };
          mergeExternal(r.text, r.version);
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const r = (await res.json()) as { version: number };
        if (r.version > version) { version = r.version; lastSaved = text; }
        if (status.classList.contains("error")) setStatus("Saved");
      } catch (e) {
        setStatus("Not saved: " + ((e as Error).message || "the editor's host is gone"), "error");
      }
    })();
    await saving;
    saving = null;
    if (currentState().doc.toString() != lastSaved) scheduleSave();
    return lastSaved == text;
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = window.setTimeout(saveNow, 400); };
  window.addEventListener("pagehide", () => { if (currentState().doc.toString() != lastSaved) navigator.sendBeacon?.("/api/doc?beacon=1", JSON.stringify({ text: currentState().doc.toString(), version })); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });

  // Edits made on disk (the agent, another editor) are merged into the open
  // document as small changes on top of any edits not saved yet, so neither
  // side's work is lost; they are undoable like any edit.
  let applyingExternal = false;
  function mergeExternal(text: string, v: number) {
    if (v <= version) return;
    const changes: ChangeSet = rebase(lastSaved, currentState().doc.toString(), text);
    lastSaved = text;
    version = v;
    applyingExternal = true;
    try {
      if (sourceView) sourceView.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "external" });
      else page.applyExternal(changes);
    } finally { applyingExternal = false; }
    if (currentState().doc.toString() != lastSaved) scheduleSave();
  }

  // Other files in the folder (styles, scripts, images) changed: render the
  // page again so it picks them up, keeping the scroll position.
  let reloadTimer = 0;
  let restoreScroll: number | null = null;
  function reloadAssets() {
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      restoreScroll = frame.contentWindow?.scrollY ?? 0;
      page.render();
    }, 120);
  }

  const events = new EventSource("/api/events");
  events.onmessage = (ev) => {
    let msg: { type?: string; text?: string; version?: number; paths?: string[]; ev?: LogEvent } = {};
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type == "doc" && typeof msg.text == "string" && typeof msg.version == "number") mergeExternal(msg.text, msg.version);
    else if (msg.type == "files") reloadAssets();
    else if (msg.type == "agent" && msg.ev) agentEvent(msg.ev);
  };

  // ---------------------------------------------------------------- chrome

  const WAKE_PX = 30, WAKE_MS = 400, TYPING_GRACE_MS = 600;
  let chromeHidden = false;
  let anchor: { x: number; y: number; t: number } | null = null;
  let lastKeyAt = 0;
  function hideChrome() {
    if (chromeHidden || !$("help").hidden) return;
    chromeHidden = true;
    anchor = null;
    document.body.classList.add("chrome-hidden");
  }
  function showChrome() {
    if (!chromeHidden) return;
    chromeHidden = false;
    document.body.classList.remove("chrome-hidden");
  }
  function pointerMoved(e: MouseEvent) {
    if (!chromeHidden) return;
    const now = performance.now();
    if (now - lastKeyAt < TYPING_GRACE_MS) { anchor = null; return; }
    if (!anchor || now - anchor.t > WAKE_MS) { anchor = { x: e.clientX, y: e.clientY, t: now }; return; }
    if (Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > WAKE_PX) showChrome();
  }
  window.addEventListener("keydown", () => { lastKeyAt = performance.now(); }, true);
  window.addEventListener("mousemove", pointerMoved, { passive: true });

  const help = $("help");
  function toggleHelp(force?: boolean) {
    const open = typeof force == "boolean" ? force : help.hidden;
    help.hidden = !open;
    if (open) showChrome();
  }
  if (!isMac) {
    for (const k of help.querySelectorAll("kbd")) {
      if (k.textContent == "⌘") k.textContent = "Ctrl";
      else if (k.textContent == "⌥") k.textContent = "Alt";
      else if (k.textContent == "⇧") k.textContent = "Shift";
    }
    for (const b of document.querySelectorAll<HTMLElement>("[data-tip]")) b.dataset.tip = b.dataset.tip!.replace("⌘⇧", "Ctrl+Shift+").replace("⌘", "Ctrl+");
  }
  const toast = $("toast");
  let toastTimer = 0;
  function flash(text: string) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1400);
  }

  // ---------------------------------------------------------------- the page editor

  const currentState = () => (sourceView ? sourceView.state : page.state);

  const page = new PageEditor({
    frame,
    kind: info.kind,
    state,
    base: "/doc/",
    markdownHead,
    onUpdate(u) {
      if (u.docChanged) {
        scheduleSave();
        if (!applyingExternal) hideChrome();
      }
      if (u.rendered) {
        syncBackdrop();
        const t = page.title();
        document.title = t ? `${t} · ${info!.name}` : info!.name;
        if (restoreScroll != null) { frame.contentWindow?.scrollTo(0, restoreScroll); restoreScroll = null; }
        if (!agentPanel.contains(document.activeElement)) page.focus();
      }
    },
    onKey: (e) => appShortcut(e),
    onPointer: (e) => {
      const r = frame.getBoundingClientRect();
      pointerMoved(new MouseEvent("mousemove", { clientX: e.clientX + r.left, clientY: e.clientY + r.top }));
    },
  });

  // ---------------------------------------------------------------- source view

  // ⌘⇧P shows the file itself in the Markdown editor. The two views share
  // one state, so undo history carries across, and edits in either land in
  // the same file.
  let sourceView: EditorView | null = null;
  function toggleSource(force?: boolean) {
    const next = typeof force == "boolean" ? force : !sourceView;
    if (next == !!sourceView) return;
    if (next) {
      sourceView = new EditorView({ parent: $("source"), state: page.state });
      $("source").hidden = false;
      document.body.classList.add("source");
      $("btn-source").setAttribute("aria-pressed", "true");
      sourceView.focus();
    } else {
      const s = sourceView!.state;
      sourceView!.destroy();
      sourceView = null;
      $("source").hidden = true;
      document.body.classList.remove("source");
      $("btn-source").setAttribute("aria-pressed", "false");
      page.setState(s);
      page.focus();
    }
  }

  // ---------------------------------------------------------------- the agent

  const agentPanel = $("agent");
  const agentLog = $("agent-log");
  const agentInput = $("agent-input") as HTMLTextAreaElement;
  const agentSend = $("agent-send") as HTMLButtonElement;
  const log: Log = emptyLog();
  let logEls: HTMLElement[] = [];
  const agentHint = $("agent-hint");
  // Why the agent can't take a message right now, shown in the panel until it can.
  let agentOff: string | null = "Connecting to the agent…";
  let hintTimer = 0;

  const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const inline = (s: string) => escapeHtml(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const TOOL_VERBS: Record<string, [string, string]> = {
    read: ["Reading", "Read"], edit: ["Editing", "Edited"], write: ["Writing", "Wrote"],
    ls: ["Listing", "Listed"], find: ["Finding files", "Found files"], grep: ["Searching", "Searched"],
  };
  /** A failed tool call that a later call on the same file got past is history, not an error. */
  const retried = (i: number) => {
    const item = log.items[i];
    if (item.kind != "tool" || item.status != "error") return false;
    return log.items.slice(i + 1).some((x) => x.kind == "tool" && x.status == "done" && x.path == item.path && (x.name == item.name || x.name == "write"));
  };
  function renderItem(item: LogItem, i: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "msg-" + item.kind;
    if (item.kind == "user" || item.kind == "thinking" || item.kind == "error") el.textContent = item.text;
    else if (item.kind == "assistant") el.innerHTML = inline(item.text);
    else {
      const [doing, done] = TOOL_VERBS[item.name] ?? [item.name, item.name];
      const what = item.path ? ` <code>${escapeHtml(item.path)}</code>` : "";
      if (retried(i)) {
        el.classList.add("retried");
        el.title = item.detail ?? "";
        el.innerHTML = `<span>${doing}${what} didn't apply; retried</span>`;
      } else {
        el.classList.add(item.status);
        el.innerHTML = `<span>${item.status == "running" ? doing : item.status == "error" ? `${doing} failed:` : done}${what}${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ""}</span>`;
      }
    }
    return el;
  }
  function renderLog() {
    agentLog.textContent = "";
    logEls = log.items.map((it, i) => renderItem(it, i));
    agentLog.append(...logEls);
    agentLog.scrollTop = agentLog.scrollHeight;
    renderBusy();
  }
  /** Why Send can't send right now, or null if it can. Never a silent no. */
  function sendBlocker(): string | null {
    if (agentOff) return agentOff;
    if (!log.busy && !agentInput.value.trim()) return "Type a message to send it.";
    return null;
  }
  function renderBusy() {
    const stop = log.busy && !agentInput.value.trim();
    const why = sendBlocker();
    agentSend.textContent = stop ? "Stop" : "Send";
    agentSend.classList.toggle("stop", stop);
    // aria-disabled rather than disabled: a disabled button gets no hover or
    // click, so it could never say why it's disabled.
    agentSend.setAttribute("aria-disabled", String(!!why));
    agentSend.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
    agentInput.placeholder = agentOff ? "The agent is off" : log.busy ? "Add to what the agent is doing…" : "Ask the agent…";
    if (agentOff) showHint(agentOff, true);
    else if (agentHint.classList.contains("sticky")) hideHint();
    $("agent-fab").classList.toggle("busy", log.busy);
  }
  function showHint(text: string, sticky = false) {
    clearTimeout(hintTimer);
    agentHint.textContent = text;
    agentHint.hidden = false;
    agentHint.classList.toggle("sticky", sticky);
    if (!sticky) hintTimer = window.setTimeout(hideHint, 2600);
  }
  function hideHint() {
    clearTimeout(hintTimer);
    agentHint.hidden = true;
    agentHint.classList.remove("sticky");
  }
  function agentEvent(ev: LogEvent) {
    const nearBottom = agentLog.scrollHeight - agentLog.scrollTop - agentLog.clientHeight < 60;
    const before = log.items.length;
    const i = reduce(log, ev);
    if (ev.t == "reset") { renderLog(); return; }
    if (i >= 0) {
      const el = renderItem(log.items[i], i);
      if (i < before) { logEls[i].replaceWith(el); logEls[i] = el; }
      else { agentLog.append(el); logEls[i] = el; }
    }
    // A success may turn earlier failures on the same file into retries.
    if (ev.t == "tool" && ev.status == "done") {
      for (let j = 0; j < i; j++) if (retried(j) && !logEls[j].classList.contains("retried")) { const el = renderItem(log.items[j], j); logEls[j].replaceWith(el); logEls[j] = el; }
    }
    if (nearBottom) agentLog.scrollTop = agentLog.scrollHeight;
    renderBusy();
  }

  /** Where the user is in the document, so "this" and "here" mean something to the agent. */
  function editorContext(): string {
    const s = currentState();
    const sel = s.selection.main;
    const line = s.doc.lineAt(sel.from);
    if (!sel.empty) {
      const endLine = s.doc.lineAt(sel.to).number;
      const text = s.sliceDoc(sel.from, sel.to);
      return `The user has selected lines ${line.number}-${endLine} of ${info!.name}:\n${text.length > 4000 ? text.slice(0, 4000) + "\n[...]" : text}`;
    }
    const text = line.text.length > 400 ? line.text.slice(0, 400) + "[...]" : line.text;
    return `The user's caret is on line ${line.number} of ${info!.name}: ${text}`;
  }

  async function sendToAgent() {
    const text = agentInput.value.trim();
    const why = sendBlocker();
    if (why || !text) {
      showHint(why ?? "Type a message to send it.", !!agentOff);
      agentInput.focus();
      return;
    }
    agentInput.value = "";
    sizeInput();
    // The agent reads the file from disk: make sure it has what's on screen.
    await saveNow();
    const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context: editorContext() }) }).catch(() => null);
    if (!res?.ok) agentEvent({ t: "error", text: "Could not reach the agent." });
    renderBusy();
  }
  function sizeInput() {
    agentInput.style.height = "auto";
    agentInput.style.height = agentInput.scrollHeight + 2 + "px";
    renderBusy();
  }
  function toggleAgent(force?: boolean) {
    const open = typeof force == "boolean" ? force : !document.body.classList.contains("agent-open");
    agentPanel.inert = !open;
    document.body.classList.toggle("agent-open", open);
    $("agent-fab").setAttribute("aria-expanded", String(open));
    settings.agent = open;
    saveSettings();
    if (open) { showChrome(); agentInput.focus(); agentLog.scrollTop = agentLog.scrollHeight; }
    else if (sourceView) sourceView.focus();
    else page.focus();
  }

  agentInput.addEventListener("input", () => { if (!agentHint.classList.contains("sticky")) hideHint(); sizeInput(); });
  agentInput.addEventListener("keydown", (e) => {
    if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendToAgent(); }
  });
  $("agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (agentSend.classList.contains("stop")) fetch("/api/agent/abort", { method: "POST" });
    else sendToAgent();
  });
  $("agent-reset").addEventListener("click", () => { fetch("/api/agent/reset", { method: "POST" }); agentInput.focus(); });
  $("agent-close").addEventListener("click", () => toggleAgent(false));
  $("agent-fab").addEventListener("click", () => toggleAgent(true));
  fetch("/api/agent").then((r) => {
    if (!r.ok) throw new Error(r.status == 404 ? "this host was started before the agent existed; restart open.ts" : `the host answered ${r.status}`);
    return r.json();
  }).then((a: { enabled: boolean; model?: string; reason?: string; log?: Log }) => {
    agentOff = a.enabled ? null : `The agent is off: ${a.reason ?? "the host did not start it"}.`;
    $("agent-model").textContent = a.enabled ? a.model ?? "" : "off";
    if (a.log) { log.items = a.log.items; log.busy = a.log.busy; }
    renderLog();
  }).catch((e: Error) => {
    agentOff = `The agent is off: ${e.message}.`;
    $("agent-model").textContent = "off";
    renderLog();
  });

  // ---------------------------------------------------------------- shortcuts & wiring

  function appShortcut(e: KeyboardEvent): boolean {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") { toggleSource(); return true; }
    if (mod && !e.shiftKey && key == "j") { toggleAgent(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { toggleHelp(); return true; }
    if (mod && !e.shiftKey && key == "s") { saveNow().then((ok) => flash(ok ? "Saved to disk" : "Could not save")); return true; }
    if (e.key == "Escape") {
      if (!help.hidden) toggleHelp(false);
      else if (agentPanel.contains(document.activeElement)) toggleAgent(false);
      else if (sourceView) toggleSource(false);
      else hideChrome();
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", (e) => {
    if (appShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  $("btn-source").addEventListener("click", () => toggleSource());
  // Track changes: keep every change marked, as a growing diff, instead of
  // letting the agent's edits fade once seen.
  function setTracking(on: boolean) {
    settings.track = on;
    saveSettings();
    page.setTracking(on);
    const b = $("btn-track");
    b.setAttribute("aria-pressed", String(on));
    b.dataset.tip = on ? "Tracking changes (click to stop)" : "Track changes";
    flash(on ? "Tracking changes from here" : "Stopped tracking changes");
  }
  $("btn-track").addEventListener("click", () => setTracking(!page.isTracking));
  if (settings.track) { page.setTracking(true); $("btn-track").setAttribute("aria-pressed", "true"); $("btn-track").dataset.tip = "Tracking changes (click to stop)"; }
  $("btn-help").addEventListener("click", () => toggleHelp());
  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  document.addEventListener("mousedown", (e) => {
    if (!help.hidden && !help.contains(e.target as Node) && !$("btn-help").contains(e.target as Node)) toggleHelp(false);
  });
  frame.addEventListener("load", () => {
    frame.contentDocument?.addEventListener("mousedown", () => { if (!help.hidden) toggleHelp(false); });
  });

  window.scratchPage = { page, toggleSource, saveNow, get state() { return currentState(); } };
})();
