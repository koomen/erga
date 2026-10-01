// The page editor's shell: loads the document from the local host
// (open.ts), renders it in the page editor, saves edits back to disk as you
// type, follows edits made on disk, and offers the same quiet chrome as the
// Markdown editor: shortcuts and a toggle to the source
// in the Markdown editor, which shares the document state and undo history.
// It also hosts the agent panel (⌘J): messages go to the host, which runs the
// agent; its edits come back as changes on disk and are merged into the page.

import { EditorState, Compartment, type ChangeSet, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, keymap, drawSelection, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import { PageEditor, type Kind, type InlineStyle } from "./editor";
import { rebase } from "./merge";
import { analyzeMarkdown } from "./markdown";
import TurndownService from "turndown";
import { emptyLog, reduce, type Log, type LogEvent, type LogItem, type ViewRequest, type ViewResult } from "./agent-log";
import { domToPng } from "modern-screenshot";

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
    document.documentElement.classList.toggle("page-dark", !!color && dark);
    document.documentElement.classList.toggle("page-light", !!color && !dark);
    // Remembered so the next load paints it before the page arrives (see page.html), not white first.
    store.set("scratchwork-editor:backdrop:v1", JSON.stringify({ bg: color, image: cs.backgroundImage != "none" ? cs.backgroundImage : "", tone: color ? (dark ? "page-dark" : "page-light") : "" }));
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
  // Two looks for the source views. Markdown reads like the page: its text
  // font, wrapped, in a column as wide as the page's own text (--md-col, set
  // when the view opens). HTML reads like code: smaller monospace, a fixed
  // left margin, no right margin and no wrapping; long lines scroll sideways.
  const baseTheme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%" },
    ".cm-content": { caretColor: "var(--caret)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--caret)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
    ".cm-line": { padding: "0" },
  });
  const markdownLook: Extension = [baseTheme, EditorView.lineWrapping, EditorView.theme({
    "&": { fontSize: "var(--text-size)" },
    ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.7", padding: "14vh max(20px, calc((100% - var(--md-col, 40rem)) / 2)) 45vh" },
  })];
  const htmlLook: Extension = [baseTheme, EditorView.theme({
    "&": { fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", padding: "max(64px, 9vh) 0 40vh 56px" },
    ".cm-content": { paddingRight: "24px" },
  })];
  const look = new Compartment();
  /** The page's text column, so the Markdown view can match it. */
  function measureColumn() {
    const d = frame.contentDocument, win = frame.contentWindow;
    let left = Infinity, right = -Infinity;
    for (const el of d?.querySelectorAll("[data-sw-id]") ?? []) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < (win?.innerWidth ?? 1e9)) { left = Math.min(left, r.left); right = Math.max(right, r.right); }
    }
    const w = right - left;
    $("source").style.setProperty("--md-col", w > 200 ? `${Math.round(w)}px` : "40rem");
  }
  const sourceHighlight = HighlightStyle.define([
    { tag: t.heading, fontWeight: "650", color: "var(--fg-strong)" },
    { tag: t.strong, fontWeight: "650" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: [t.processingInstruction, t.meta, t.punctuation, t.angleBracket, t.documentMeta], color: "var(--mark)" },
    { tag: [t.tagName, t.attributeName], color: "var(--soft)" },
    { tag: [t.string, t.attributeValue, t.url, t.link], color: "var(--soft)" },
    { tag: t.monospace, color: "var(--fg)", fontFamily: "var(--font-mono)", fontSize: "0.88em" },
    { tag: t.comment, color: "var(--mark)", fontStyle: "italic" },
  ]);
  let state = EditorState.create({
    doc: info.text,
    extensions: [
      history(),
      info.kind == "md" ? markdown({ base: markdownLanguage }) : html(),
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      syntaxHighlighting(sourceHighlight),
      look.of(info.kind == "md" ? markdownLook : htmlLook),
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
      refreshDerived();
      if (!sourceView && page.stale) needRefresh();
    } finally { applyingExternal = false; }
    if (currentState().doc.toString() != lastSaved) scheduleSave();
  }

  // Changes patching can't show (another file in the folder, or the page's
  // structure: a diagram, a script) need the page rendered again. While the
  // agent is working that waits for the end of its turn, so a half-built
  // change never renders; a pill says it's pending and offers to refresh now.
  // Otherwise it happens straight away.
  // Either way the scroll position is kept.
  let reloadTimer = 0;
  let restoreScroll: number | null = null;
  let agentIsBusy = false;
  let refreshPending = false;
  const refreshPill = $("refresh-pill");
  function refreshPage() {
    refreshPending = false;
    refreshPill.hidden = true;
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      if (mode != "text") return; // the page renders afresh on the way back
      restoreScroll = frame.contentWindow?.scrollY ?? 0;
      page.render();
    }, 120);
  }
  function needRefresh() {
    if (!agentIsBusy) { refreshPage(); return; }
    refreshPending = true;
    refreshPill.hidden = false;
  }
  refreshPill.addEventListener("click", refreshPage);

  const events = new EventSource("/api/events");
  events.onmessage = (ev) => {
    let msg: { type?: string; text?: string; version?: number; paths?: string[]; ev?: LogEvent; id?: string; req?: ViewRequest } = {};
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type == "doc" && typeof msg.text == "string" && typeof msg.version == "number") mergeExternal(msg.text, msg.version);
    else if (msg.type == "files") needRefresh();
    else if (msg.type == "agent" && msg.ev) agentEvent(msg.ev);
    else if (msg.type == "view" && msg.id) answerView(msg.id, msg.req ?? {});
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
  function flash(text: string, ms = 1400) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms);
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
      queueFmt();
    },
    onKey: (e) => appShortcut(e),
    onNotice: (m) => flash(m, 2600),
    onPointer: (e) => {
      const r = frame.getBoundingClientRect();
      pointerMoved(new MouseEvent("mousemove", { clientX: e.clientX + r.left, clientY: e.clientY + r.top }));
    },
  });

  // ---------------------------------------------------------------- style bar

  // Select text in the page and a small bar floats above it: bold, italic,
  // code, link. Buttons that can't apply say why (title), and so does a click.
  const fmt = $("fmt");
  const fmtLink = $("fmt-link") as HTMLInputElement;
  let pointerDown = false;
  let fmtQueued = false;
  function queueFmt() {
    if (fmtQueued) return;
    fmtQueued = true;
    requestAnimationFrame(() => { fmtQueued = false; renderFmt(); });
  }
  function hideFmt() {
    fmt.hidden = true;
    fmt.classList.remove("linking");
    fmtLink.hidden = true;
  }
  function renderFmt() {
    if (fmt.classList.contains("linking")) return;
    const rect = mode != "text" || pointerDown ? null : page.selectionRect();
    if (!rect) { hideFmt(); return; }
    const f = frame.getBoundingClientRect();
    const below = rect.top < 56;
    fmt.style.left = Math.max(110, Math.min(window.innerWidth - 110, f.left + rect.left + rect.width / 2)) + "px";
    fmt.style.top = f.top + (below ? rect.bottom : rect.top) + "px";
    fmt.classList.toggle("below", below);
    const why = page.styleBlocker();
    for (const b of fmt.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-disabled", String(!!why));
      b.dataset.why = why ?? "";
      if (b.dataset.style) b.setAttribute("aria-pressed", String(!why && page.hasStyle(b.dataset.style as InlineStyle)));
      if (b.dataset.act == "link") b.setAttribute("aria-pressed", String(!why && page.linkAt() != null));
      b.title = why ?? b.getAttribute("aria-label")!.replace(/ \((.+)\)$/, "  $1");
    }
    fmt.hidden = false;
  }
  function openLink() {
    const why = page.styleBlocker();
    if (why) { flash(why, 2600); return; }
    if (fmt.hidden) renderFmt();
    fmt.classList.add("linking");
    fmtLink.hidden = false;
    fmtLink.value = page.linkAt() ?? "";
    fmtLink.focus();
    fmtLink.select();
  }
  fmt.addEventListener("mousedown", (e) => { if (e.target != fmtLink) e.preventDefault(); });
  fmt.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.dataset.why) { flash(b.dataset.why, 2600); return; }
    if (b.dataset.style) {
      const why = page.toggleStyle(b.dataset.style as InlineStyle);
      if (why) flash(why, 2600);
      queueFmt();
    } else if (b.dataset.act == "link") openLink();
  });
  fmtLink.addEventListener("keydown", (e) => {
    if (e.key == "Enter") {
      e.preventDefault();
      fmt.classList.remove("linking");
      fmtLink.hidden = true;
      page.focus();
      const why = page.setLink(fmtLink.value.trim());
      if (why) flash(why, 2600);
      queueFmt();
    } else if (e.key == "Escape") {
      e.preventDefault();
      e.stopPropagation();
      fmt.classList.remove("linking");
      fmtLink.hidden = true;
      page.focus();
      queueFmt();
    }
  });
  fmtLink.addEventListener("blur", () => { if (fmt.classList.contains("linking")) { fmt.classList.remove("linking"); fmtLink.hidden = true; queueFmt(); } });
  frame.addEventListener("load", () => {
    const d = frame.contentDocument;
    if (!d) return;
    d.addEventListener("mousedown", () => { pointerDown = true; hideFmt(); }, true);
    d.addEventListener("mouseup", () => { pointerDown = false; queueFmt(); }, true);
    d.addEventListener("scroll", () => queueFmt(), { passive: true });
    d.addEventListener("selectionchange", () => queueFmt());
  });
  window.addEventListener("resize", () => queueFmt());

  // ---------------------------------------------------------------- views

  // Three views of the document: T, the page itself; *T*, Markdown; <T>,
  // HTML. The view in the file's own format is the file, editable, sharing
  // the page's state and undo history. The other is a read-only conversion
  // (an HTML file's text as Markdown, or the HTML a Markdown file renders
  // to): editing through a lossy conversion would rewrite the file in ways
  // nobody asked for, and the view says so.
  type Mode = "text" | "md" | "html";
  const MODE_NAMES: Record<Mode, string> = { text: "Page", md: "Markdown", html: "HTML" };
  let mode: Mode = "text";
  let sourceView: EditorView | null = null;
  let derivedView: EditorView | null = null;
  const modeEl = $("mode");
  const modeNote = $("mode-note");

  function htmlToMarkdown(src: string): string {
    const d = new DOMParser().parseFromString(src, "text/html");
    d.querySelectorAll("head, script, style, noscript, template, svg, canvas, iframe, button, input, select, textarea").forEach((e) => e.remove());
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", hr: "---" });
    return td.turndown(d.body).replace(/^(\s*)([-*]|\d+\.)[ ]{2,}/gm, "$1$2 ").trim() + "\n";
  }
  function markdownToHtml(src: string): string {
    return analyzeMarkdown(src).html
      .replace(/ data-sw-id="\d+"/g, "").replace(/ class="sw-empty"/g, "")
      .replace(/(<(?:ul|ol|blockquote|table|thead|tbody|tr)>)/g, "$1\n")
      .replace(/(<\/(?:h[1-6]|p|li|ul|ol|blockquote|pre|table|thead|tbody|tr|hr)>)/g, "$1\n");
  }
  const derivedText = (m: Mode) => (m == "md" ? htmlToMarkdown(page.state.doc.toString()) : markdownToHtml(page.state.doc.toString()));

  function setMode(next: Mode) {
    closeModeMenu();
    if (next == mode) return;
    // Leave the current view; the page's state is the one truth.
    if (derivedView) { derivedView.destroy(); derivedView = null; modeNote.hidden = true; }
    if (sourceView) {
      const st = sourceView.state;
      sourceView.destroy();
      sourceView = null;
      page.setState(st);
    }
    if (mode == "text") measureColumn();
    mode = next;
    if (next == "text") {
      $("source").hidden = true;
      document.body.classList.remove("source");
      page.focus();
    } else if (next == info!.kind) {
      sourceView = new EditorView({ parent: $("source"), state: page.state });
      $("source").hidden = false;
      document.body.classList.add("source");
      sourceView.focus();
    } else {
      derivedView = new EditorView({
        parent: $("source"),
        state: EditorState.create({
          doc: derivedText(next),
          extensions: [next == "md" ? markdown({ base: markdownLanguage }) : html(), EditorState.readOnly.of(true), EditorView.editable.of(false), highlightSpecialChars(), syntaxHighlighting(sourceHighlight), next == "md" ? markdownLook : htmlLook],
        }),
      });
      $("source").hidden = false;
      document.body.classList.add("source");
      modeNote.textContent = next == "md"
        ? "Read-only: this page's text as Markdown. The file is HTML, so edit it on the page (T) or as HTML (<T>)."
        : "Read-only: the HTML this Markdown renders to. Edit it on the page (T) or as Markdown (*T*).";
      modeNote.hidden = false;
    }
    renderMode();
    queueFmt();
  }
  /** Keeps a read-only conversion up to date when the file changes underneath it. */
  function refreshDerived() {
    if (derivedView) derivedView.dispatch({ changes: { from: 0, to: derivedView.state.doc.length, insert: derivedText(mode) } });
  }
  function renderMode() {
    for (const b of modeEl.querySelectorAll<HTMLButtonElement>("button")) {
      const m = b.dataset.mode as Mode;
      b.setAttribute("aria-checked", String(m == mode));
      const ro = m != "text" && m != info?.kind;
      b.title = `${MODE_NAMES[m]}${ro ? " (read-only)" : ""}${m == "text" || m == info?.kind ? "  ⌘⇧P" : ""}`;
      b.setAttribute("aria-label", b.title);
    }
  }
  function openModeMenu() { modeEl.classList.add("open"); showChrome(); }
  function closeModeMenu() { modeEl.classList.remove("open"); }
  modeEl.addEventListener("mousedown", (e) => e.preventDefault());
  modeEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!b) return;
    if (!modeEl.classList.contains("open")) openModeMenu();
    else setMode(b.dataset.mode as Mode);
  });
  document.addEventListener("mousedown", (e) => { if (!modeEl.contains(e.target as Node)) closeModeMenu(); });
  /** ⌘⇧P: between the page and the file's own source. */
  const toggleSource = (force?: boolean) => setMode((typeof force == "boolean" ? force : mode == "text") ? info!.kind : "text");

  // ---------------------------------------------------------------- view_page

  // The agent asks to see the page. This tab renders the latest version
  // (edits still waiting for the end of the agent's turn included) in a
  // hidden frame and draws it to an image, which the browser renders itself
  // (modern-screenshot: the DOM through an SVG foreignObject), then sends it
  // back with any errors the page's scripts threw. No server-side browser:
  // whoever has the editor open is the agent's eyes.
  const CATCH_ERRORS = `<script>window.__swErrors=[];addEventListener("error",function(e){__swErrors.push(String(e.message))});addEventListener("unhandledrejection",function(e){__swErrors.push("Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason))});(function(){var ce=console.error;console.error=function(){__swErrors.push("console.error: "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)}})()</script>`;
  const MAX_SHOT = 4000;
  async function captureView(req: ViewRequest): Promise<ViewResult> {
    const width = Math.round(Math.max(320, Math.min(2400, req.width ?? (frame.clientWidth || 1280))));
    const viewport = frame.clientHeight || 800;
    const shot = document.createElement("iframe");
    shot.setAttribute("sandbox", "allow-scripts allow-same-origin");
    shot.setAttribute("aria-hidden", "true");
    shot.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${viewport}px;border:0;`;
    const html = page.renderedHtml();
    shot.srcdoc = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + CATCH_ERRORS) : CATCH_ERRORS + html;
    document.body.append(shot);
    try {
      await new Promise<void>((resolve, reject) => { shot.onload = () => resolve(); setTimeout(() => reject(new Error("the page took too long to load")), 10_000); });
      const d = shot.contentDocument!, win = shot.contentWindow as (Window & { __swErrors?: string[] }) | null;
      await d.fonts?.ready;
      await new Promise((r) => setTimeout(r, 600)); // let the page's own scripts draw
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--page-bg").trim() || "#ffffff";
      let target: Element = d.documentElement, w = width, h = viewport, note: string | undefined;
      if (req.selector) {
        let el: Element | null = null;
        try { el = d.querySelector(req.selector); } catch { return { width: 0, height: 0, errors: [], error: `${req.selector} isn't a valid CSS selector` }; }
        if (!el) return { width: 0, height: 0, errors: win?.__swErrors ?? [], error: `Nothing on the page matches ${req.selector}` };
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { width: 0, height: 0, errors: win?.__swErrors ?? [], error: `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered` };
        target = el; w = Math.ceil(r.width); h = Math.min(MAX_SHOT, Math.ceil(r.height));
        if (r.height > MAX_SHOT) note = `${req.selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.`;
      } else if (req.fullPage) {
        const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
        h = Math.min(MAX_SHOT, full);
        if (full > MAX_SHOT) note = `The page is ${full}px tall; this shows the top ${MAX_SHOT}px.`;
      }
      // An element is drawn at its own size, without the margins around it (they'd shift it inside the image).
      const url = await domToPng(target, target == d.documentElement ? { width: w, height: h, backgroundColor: bg, scale: 1 } : { backgroundColor: bg, scale: 1, style: { margin: "0" } });
      return { png: url.slice(url.indexOf(",") + 1), width: w, height: h, errors: win?.__swErrors ?? [], note };
    } finally {
      shot.remove();
    }
  }
  async function answerView(id: string, req: ViewRequest) {
    const result = await captureView(req).catch((e: Error): ViewResult => ({ width: 0, height: 0, errors: [], error: `Couldn't capture the page: ${e.message}` }));
    await fetch("/api/agent/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...result }) }).catch(() => {});
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
    view_page: ["Looking at the page", "Looked at the page"],
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
        el.innerHTML = `<span>${item.status == "running" ? doing : item.status == "error" ? `${doing} failed:` : done}${what}${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ""}${item.image ? `<img class="shot" alt="What the agent saw" src="${item.image}">` : ""}</span>`;
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
    if (ev.t == "busy") {
      agentIsBusy = ev.busy;
      if (!ev.busy && refreshPending) refreshPage();
    }
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
    saveDraft();
    sizeInput();
    // The agent reads the file from disk: make sure it has what's on screen.
    await saveNow();
    const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context: editorContext() }) }).catch(() => null);
    if (!res?.ok) agentEvent({ t: "error", text: "Could not reach the agent." });
    renderBusy();
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

  // An unsent message survives a reload (kept in this browser only).
  const DRAFT_KEY = "scratchwork-editor:agent-draft:v1";
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
    if (a.log) { log.items = a.log.items; log.busy = a.log.busy; agentIsBusy = a.log.busy; }
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
    if (mod && !e.shiftKey && key == "k" && mode == "text") { openLink(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { toggleHelp(); return true; }
    if (mod && !e.shiftKey && key == "s") { saveNow().then((ok) => flash(ok ? "Saved to disk" : "Could not save")); return true; }
    if (e.key == "Escape") {
      if (!help.hidden) toggleHelp(false);
      else if (agentPanel.contains(document.activeElement)) toggleAgent(false);
      else if (modeEl.classList.contains("open")) closeModeMenu();
      else if (mode != "text") setMode("text");
      else hideChrome();
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", (e) => {
    if (appShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  renderMode();
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

  window.scratchPage = { page, toggleSource, saveNow, captureView, get state() { return currentState(); } };
})();
