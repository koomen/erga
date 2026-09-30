// The page editor's shell: loads the document from the local host
// (open.ts), renders it in the page editor, saves edits back to disk as you
// type, follows edits made on disk, and offers the same quiet chrome as the
// Markdown editor: theme, shortcuts, a word count, and a toggle to the source
// in the Markdown editor, which shares the document state and undo history.

import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import { PageEditor, type Kind } from "./editor";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

declare global {
  interface Window { scratchPage?: unknown }
}

interface DocInfo { name: string; kind: Kind; text: string; dir: string }

(async () => {
  const $ = (id: string) => document.getElementById(id)!;

  const KEYS = { settings: "scratchwork-editor:settings:v1" };
  const store = {
    get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
  };
  const settings: { theme: string | null; stat: string } = Object.assign({ theme: null, stat: "words" }, store.json(KEYS.settings));
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));

  // ---------------------------------------------------------------- theme

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolvedTheme = () => settings.theme || (media.matches ? "dark" : "light");
  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme) root.setAttribute("data-theme", settings.theme);
    else root.removeAttribute("data-theme");
    root.classList.toggle("is-dark", resolvedTheme() == "dark");
    // The Markdown template follows the shell's theme; HTML pages have their own.
    const doc = frame.contentDocument;
    if (doc?.documentElement && info?.kind == "md") {
      if (settings.theme) doc.documentElement.setAttribute("data-theme", settings.theme);
      else doc.documentElement.removeAttribute("data-theme");
    }
  }
  function toggleTheme() {
    settings.theme = resolvedTheme() == "dark" ? "light" : "dark";
    saveSettings();
    applyTheme();
  }
  media.addEventListener("change", applyTheme);

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
    applyTheme();
    return;
  }
  const markdownHead = `<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/style.css"><style>
    body { padding: 0; }
    .prose { padding-top: 12vh; padding-bottom: 40vh; }
    .prose li > p { margin: 0; }
    .prose ul.loose li > p { margin: 0 0 0.6em; }
    .prose [data-sw-id]:empty::before, .prose .sw-empty:empty::before { content: ""; }
  </style>${settings.theme ? `<script>document.documentElement.setAttribute("data-theme", ${JSON.stringify(settings.theme)})</script>` : ""}`;

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
      EditorView.updateListener.of((u) => { if (u.docChanged) { scheduleSave(); hideChrome(); } if (u.docChanged || u.selectionSet) renderStat(); }),
    ],
  });
  let lastSaved = info.text;
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
        const res = await fetch("/api/doc", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        if (!res.ok) throw new Error(await res.text());
        lastSaved = text;
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
  window.addEventListener("pagehide", () => { if (currentState().doc.toString() != lastSaved) navigator.sendBeacon?.("/api/doc?beacon=1", JSON.stringify({ text: currentState().doc.toString() })); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });

  // Edits made on disk (an agent, another editor) arrive over SSE.
  const events = new EventSource("/api/events");
  events.onmessage = (ev) => {
    let msg: { text?: string } = {};
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (typeof msg.text != "string") return;
    if (currentState().doc.toString() != lastSaved) return; // our unsaved edits win; the save overwrites
    lastSaved = msg.text;
    if (sourceView) {
      sourceView.dispatch({ changes: { from: 0, to: sourceView.state.doc.length, insert: msg.text }, annotations: Transaction.addToHistory.of(false) });
    } else {
      page.replaceAll(msg.text);
    }
    setStatus("Updated from disk");
  };

  // ---------------------------------------------------------------- stats

  function counts(text: string) {
    const words = (text.match(/\S+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return { words, chars: text.length, minutes: Math.max(1, Math.round(words / 230)) };
  }
  const fmt = (n: number) => n.toLocaleString();
  const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n == 1 ? one : many}`;
  const STATS = ["words", "chars", "minutes"];
  function renderStat() {
    const all = counts(sourceView ? sourceView.state.doc.toString() : page.manuscriptText());
    const s = currentState().selection.main;
    const sel = sourceView && !s.empty ? counts(sourceView.state.sliceDoc(s.from, s.to)) : null;
    let label: string;
    if (settings.stat == "chars") label = sel ? `${fmt(sel.chars)} / ${plural(all.chars, "character", "characters")}` : plural(all.chars, "character", "characters");
    else if (settings.stat == "minutes") label = all.words == 0 ? "0 min read" : `${all.minutes} min read`;
    else label = sel ? `${fmt(sel.words)} / ${plural(all.words, "word", "words")}` : plural(all.words, "word", "words");
    $("stat").textContent = label;
  }

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
        hideChrome();
      }
      if (u.rendered) {
        applyTheme();
        const t = page.title();
        document.title = t ? `${t} · ${info!.name}` : info!.name;
        page.focus();
      }
      renderStat();
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
    renderStat();
  }

  // ---------------------------------------------------------------- shortcuts & wiring

  function appShortcut(e: KeyboardEvent): boolean {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") { toggleSource(); return true; }
    if (mod && e.shiftKey && key == "l") { toggleTheme(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { toggleHelp(); return true; }
    if (mod && !e.shiftKey && key == "s") { saveNow().then((ok) => flash(ok ? "Saved to disk" : "Could not save")); return true; }
    if (e.key == "Escape") {
      if (!help.hidden) toggleHelp(false);
      else if (sourceView) toggleSource(false);
      else hideChrome();
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", (e) => {
    if (appShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-source").addEventListener("click", () => toggleSource());
  $("btn-help").addEventListener("click", () => toggleHelp());
  $("stat").addEventListener("click", () => {
    settings.stat = STATS[(STATS.indexOf(settings.stat) + 1) % STATS.length];
    saveSettings();
    renderStat();
  });
  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  document.addEventListener("mousedown", (e) => {
    if (!help.hidden && !help.contains(e.target as Node) && !$("btn-help").contains(e.target as Node)) toggleHelp(false);
  });
  frame.addEventListener("load", () => {
    frame.contentDocument?.addEventListener("mousedown", () => { if (!help.hidden) toggleHelp(false); });
  });

  applyTheme();
  renderStat();
  window.scratchPage = { page, toggleSource, saveNow, get state() { return currentState(); } };
})();
