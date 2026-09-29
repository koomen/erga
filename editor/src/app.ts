// Scratchwork editor concept: a quiet, full-page Markdown writing surface.
// The editor (src/state.ts, src/view/, src/markdown/) is written from
// scratch; this file adds the Markdown formatting commands, the fading
// controls, autosave, theme and preview. Bundled by build.sh into editor.js.

import { EditorState, type TransactionSpec } from "./state";
import { EditorSelection } from "./selection";
import type { Doc } from "./text";
import { EditorView, type ViewUpdate } from "./view/view";
import type { KeyBinding } from "./view/keymap";
import { isMac } from "./view/dom";
import { iterate, type Node } from "./markdown/tree";
import { insertNewlineContinueMarkup, deleteMarkupBackward, pasteURLAsLink } from "./markdown/commands";
import { defaultKeymap, historyKeymap, indentWithTab } from "./commands";

declare global {
  interface Window {
    Vendor?: { marked: { parse(text: string, opts: object): string }; DOMPurify: { sanitize(html: string): string } };
    scratchEditor?: unknown;
  }
}

(() => {
  const V = window.Vendor;
  if (!V) {
    document.body.textContent = "vendor/vendor.js did not load. Run ./vendor/build.sh (see README.md).";
    return;
  }
  const { marked, DOMPurify } = V;
  const $ = (id: string) => document.getElementById(id)!;

  // ---------------------------------------------------------------- storage

  const KEYS = {
    doc: "scratchwork-editor:doc:v1",
    view: "scratchwork-editor:view:v1", // selection + scroll, restored on reload
    settings: "scratchwork-editor:settings:v1", // theme, which stat to show
  };
  const store = {
    get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
  };
  const settings: { theme: string | null; stat: string } = Object.assign({ theme: null, stat: "words" }, store.json(KEYS.settings));
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));

  const WELCOME = `# A quiet place to write

This is a concept for the Scratchwork editor. Type Markdown and it stays pleasant to read: headings grow, **bold** is bold, *italics* lean, and the syntax characters stay put but fade into the background.

## What it does

- Saves to this browser as you type. There is no save button.
- The controls fade away while you write and come back when you move the mouse.
- Light and dark themes, a word count, and a preview of the rendered page.
- Select some text to make it bold, italic or a link. Or paste a URL over it.

> Press ⌘/ for keyboard shortcuts, or select everything and start over.

Inline \`code\` and [links](https://scratchwork.dev) look like this. Click into a link to edit it.
`;

  // ---------------------------------------------------------------- links

  // [label](url) reads as a plain link: the view hides the brackets and URL
  // until the selection or caret is inside it (see markdown/highlight.ts).
  // A caret resting at either edge keeps it rendered. ⌘-click opens the URL.
  const SAFE_HREF = /^(https?:|mailto:)/i;
  const inlineLink = (node: Node) => {
    const marks = node.getChildrenNamed("LinkMark");
    const url = node.getChild("URL");
    // [label](url) only: not [label][ref], [label], or images.
    return marks.length >= 4 && url ? { open: marks[0], close: marks[1], url } : null;
  };

  function openLinkOnModClick(e: MouseEvent): boolean {
    const el = (e.target as Element).closest?.(".md-link-rendered") as HTMLElement | null;
    if (!el || !(isMac ? e.metaKey : e.ctrlKey) || !SAFE_HREF.test(el.dataset.href!)) return false;
    e.preventDefault();
    window.open(el.dataset.href, "_blank", "noopener");
    return true;
  }

  // ---------------------------------------------------------------- commands

  const dispatchUser = (view: EditorView, spec: TransactionSpec) => {
    view.dispatch(view.state.update(spec, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };

  // Is [from, to) wrapped in marker, outside (wrappedAround) or inside
  // (wrappedWithin) the range? A lone * next to ** is bold, not italic, unless
  // it's *** (bold italic).
  const leadingStars = (s: string) => /^\**/.exec(s)![0].length;
  const trailingStars = (s: string) => /\**$/.exec(s)![0].length;
  const italicRuns = (a: number, b: number) => a >= 1 && b >= 1 && a !== 2 && b !== 2;
  function wrappedAround(doc: Doc, from: number, to: number, marker: string) {
    const n = marker.length;
    if (doc.sliceString(from - n, from) !== marker || doc.sliceString(to, to + n) !== marker) return false;
    return marker !== "*" || italicRuns(trailingStars(doc.sliceString(from - 3, from)), leadingStars(doc.sliceString(to, to + 3)));
  }
  function wrappedWithin(text: string, marker: string) {
    const n = marker.length;
    if (text.length < 2 * n || !text.startsWith(marker) || !text.endsWith(marker)) return false;
    return marker !== "*" || italicRuns(leadingStars(text.slice(0, 3)), trailingStars(text.slice(-3)));
  }

  // Wrap each selection in a marker (**, *, `), or unwrap it if already wrapped.
  const toggleWrap = (marker: string) => (view: EditorView) => dispatchUser(view, view.state.changeByRange((range) => {
    const { from, to } = range;
    const n = marker.length;
    const doc = view.state.doc;
    const text = doc.sliceString(from, to);
    if (wrappedAround(doc, from, to, marker)) {
      return {
        changes: [{ from: from - n, to: from }, { from: to, to: to + n }],
        range: EditorSelection.range(from - n, to - n),
      };
    }
    if (wrappedWithin(text, marker)) {
      return {
        changes: [{ from, to: from + n }, { from: to - n, to }],
        range: EditorSelection.range(from, to - 2 * n),
      };
    }
    return {
      changes: [{ from, insert: marker }, { from: to, insert: marker }],
      range: EditorSelection.range(from + n, to + n),
    };
  }));

  // Set the heading level of every selected line; the same level again clears it.
  const setHeading = (level: number) => (view: EditorView) => {
    const { state } = view;
    const changes: { from: number; to: number; insert: string }[] = [];
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to;) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        if (seen.has(line.number)) continue;
        seen.add(line.number);
        const m = /^(#{1,6})\s+/.exec(line.text);
        const current = m ? m[1].length : 0;
        const prefix = level === 0 || level === current ? "" : "#".repeat(level) + " ";
        changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
      }
    }
    return dispatchUser(view, { changes });
  };

  // [selection](|) or [|]()
  const insertLink = (view: EditorView) => dispatchUser(view, view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    const cursor = text ? range.from + text.length + 3 : range.from + 1;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(cursor) };
  }));

  const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;
  function pasteLinks(event: ClipboardEvent, view: EditorView): boolean {
    const url = (event.clipboardData?.getData("text/plain") || "").trim();
    const { main } = view.state.selection;
    if (!URL_RE.test(url) || main.empty || view.state.selection.ranges.length > 1) return false;
    const text = view.state.sliceDoc(main.from, main.to);
    if (text.includes("\n")) return false;
    event.preventDefault();
    return dispatchUser(view, {
      changes: { from: main.from, to: main.to, insert: `[${text}](${url})` },
      selection: { anchor: main.from + text.length + url.length + 4 },
    });
  }

  const formattingKeys: KeyBinding[] = [
    { key: "Mod-b", run: toggleWrap("**") },
    { key: "Mod-i", run: toggleWrap("*") },
    { key: "Mod-e", run: toggleWrap("`") },
    { key: "Mod-k", run: (v) => linkCommand(v) },
    { key: "Mod-Alt-1", run: setHeading(1) },
    { key: "Mod-Alt-2", run: setHeading(2) },
    { key: "Mod-Alt-3", run: setHeading(3) },
    { key: "Mod-Alt-0", run: setHeading(0) },
  ];

  // Enter continues lists and quotes; Backspace removes their markup.
  const markdownKeymap: KeyBinding[] = [
    { key: "Enter", run: insertNewlineContinueMarkup },
    { key: "Backspace", run: deleteMarkupBackward },
  ];

  // ---------------------------------------------------------------- stats & title

  function counts(text: string) {
    // Count tokens that contain a letter or digit, so "#", "-" and "**" aren't words.
    const words = (text.match(/\S+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return { words, chars: text.length, minutes: Math.max(1, Math.round(words / 230)) };
  }
  const fmt = (n: number) => n.toLocaleString();
  const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
  const STATS = ["words", "chars", "minutes"];

  function renderStat(state: EditorState) {
    const all = counts(state.doc.toString());
    const sel = state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join(" ");
    const part = sel ? counts(sel) : null;
    let label;
    if (settings.stat === "chars") {
      label = part ? `${fmt(part.chars)} / ${plural(all.chars, "character", "characters")}` : plural(all.chars, "character", "characters");
    } else if (settings.stat === "minutes") {
      label = all.words === 0 ? "0 min read" : `${all.minutes} min read`;
    } else {
      label = part ? `${fmt(part.words)} / ${plural(all.words, "word", "words")}` : plural(all.words, "word", "words");
    }
    $("stat").textContent = label;
  }

  function renderTitle(state: EditorState) {
    for (const line of state.doc.lines) {
      const text = line.replace(/^#{1,6}\s+/, "").replace(/[*_`~[\]]/g, "").trim();
      if (text) { document.title = text.length > 60 ? text.slice(0, 57) + "…" : text; return; }
    }
    document.title = "Untitled";
  }

  // ---------------------------------------------------------------- autosave

  const status = $("status");
  let saveTimer = 0;
  let statusTimer = 0;
  let lastSaved: string | null = null;

  function setStatus(text: string, kind?: string) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = "status show" + (kind ? " " + kind : "");
    if (kind !== "error") statusTimer = window.setTimeout(() => status.classList.remove("show"), 1600);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const text = view.state.doc.toString();
    const { anchor, head } = view.state.selection.main;
    store.set(KEYS.view, JSON.stringify({ anchor, head, scrollY: Math.round(window.scrollY) }));
    if (text === lastSaved) return true;
    if (!store.set(KEYS.doc, text)) {
      setStatus("Not saved: this browser's storage is full or blocked", "error");
      return false;
    }
    lastSaved = text;
    if (status.classList.contains("error")) setStatus("Saved");
    return true;
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = window.setTimeout(saveNow, 400); };

  // ---------------------------------------------------------------- chrome

  // Controls are visible on load, fade out once you start typing, and return on
  // deliberate mouse movement. Trackpad jitter under resting palms and the
  // synthetic mousemoves browsers fire when text reflows under the pointer must
  // not count, so movement is ignored right after a keystroke and only a real
  // gesture (net travel of WAKE_PX within WAKE_MS) brings the controls back.
  const WAKE_PX = 30;
  const WAKE_MS = 400;
  const TYPING_GRACE_MS = 600;
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
  window.addEventListener("keydown", () => { lastKeyAt = performance.now(); }, true);
  window.addEventListener("mousemove", (e) => {
    if (!chromeHidden) return;
    const now = performance.now();
    if (now - lastKeyAt < TYPING_GRACE_MS) { anchor = null; return; }
    if (!anchor || now - anchor.t > WAKE_MS) { anchor = { x: e.clientX, y: e.clientY, t: now }; return; }
    if (Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > WAKE_PX) showChrome();
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { anchor = null; });

  // ------------------------------------------------------------ format bar

  // Select text and a small bar offers bold, italic and link. It waits until a
  // mouse drag ends, and the link button swaps the buttons for a URL field.
  const bar = $("format-bar");
  const barLinkForm = $("format-link") as HTMLFormElement;
  const barUrl = $("format-url") as HTMLInputElement;
  let dragging = false;
  let editingLink = false;
  let barFrame = 0;

  function barWanted() {
    const sel = view.state.selection;
    const { main } = sel;
    return !document.body.classList.contains("previewing") && !dragging && view.hasFocus &&
      !main.empty && sel.ranges.length === 1 && view.state.sliceDoc(main.from, main.to).trim() !== "";
  }
  // Measure after the update has been drawn.
  function scheduleBar() {
    cancelAnimationFrame(barFrame);
    barFrame = requestAnimationFrame(updateBar);
  }
  function updateBar() {
    if (editingLink) return placeBar();
    if (!barWanted()) { bar.hidden = true; return; }
    const { state } = view;
    const { main } = state.selection;
    const text = state.sliceDoc(main.from, main.to);
    const on = (marker: string) => wrappedAround(state.doc, main.from, main.to, marker) || wrappedWithin(text, marker);
    $("fmt-bold").setAttribute("aria-pressed", String(on("**")));
    $("fmt-italic").setAttribute("aria-pressed", String(on("*")));
    $("fmt-link").setAttribute("aria-pressed", String(linkAround(state, main.from, main.to) !== null));
    bar.hidden = false;
    placeBar();
  }
  // Centred above a one-line selection, left-aligned above a longer one, and
  // below it when there's no room above.
  function placeBar() {
    const { main } = view.state.selection;
    const start = view.coordsAtPos(main.from, 1);
    const end = view.coordsAtPos(main.to, -1);
    if (!start || !end) { bar.hidden = true; return; }
    const w = bar.offsetWidth, h = bar.offsetHeight, pad = 8;
    const oneLine = Math.abs(start.top - end.top) < 4;
    const center = oneLine ? (start.left + end.right) / 2 : start.left + w / 2 - 12;
    const left = Math.max(pad, Math.min(window.innerWidth - w - pad, center - w / 2));
    let top = start.top - h - 10;
    if (top < pad) top = end.bottom + 10;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  // The [label](url) link that contains the selection, if any.
  function linkAround(state: EditorState, from: number, to: number) {
    let found: { node: Node; open: Node; close: Node; url: Node } | null = null;
    iterate(state.tree, {
      from, to,
      enter(n) {
        if (found) return false;
        if (n.name !== "Link") return;
        const link = inlineLink(n);
        if (link && n.from <= from && n.to >= to) found = { node: n, ...link };
        return false;
      },
    });
    return found as { node: Node; open: Node; close: Node; url: Node } | null;
  }

  function openLinkInput() {
    const { state } = view;
    const { main } = state.selection;
    const link = linkAround(state, main.from, main.to);
    editingLink = true;
    bar.classList.add("editing-link");
    barLinkForm.hidden = false;
    barUrl.value = link ? state.sliceDoc(link.url.from, link.url.to) : "";
    bar.hidden = false;
    placeBar();
    barUrl.focus();
    barUrl.select();
    return true;
  }
  function closeLinkInput(refocus: boolean) {
    if (!editingLink) return;
    editingLink = false;
    bar.classList.remove("editing-link");
    barLinkForm.hidden = true;
    if (refocus) view.focus();
    scheduleBar();
  }
  // Wrap the selection, change an existing link's URL, or (empty URL) unlink.
  function applyLink(url: string) {
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[/#]/.test(url)) url = `https://${url}`;
    const { state } = view;
    const { main } = state.selection;
    const link = linkAround(state, main.from, main.to);
    closeLinkInput(false);
    view.focus();
    if (link) {
      if (!url) {
        const label = state.sliceDoc(link.open.to, link.close.from);
        dispatchUser(view, {
          changes: { from: link.node.from, to: link.node.to, insert: label },
          selection: EditorSelection.single(link.node.from, link.node.from + label.length),
        });
      } else {
        const end = link.node.to + url.length - (link.url.to - link.url.from);
        dispatchUser(view, { changes: { from: link.url.from, to: link.url.to, insert: url }, selection: EditorSelection.single(end) });
      }
    } else if (url) {
      const insert = `[${state.sliceDoc(main.from, main.to)}](${url})`;
      dispatchUser(view, { changes: { from: main.from, to: main.to, insert }, selection: EditorSelection.single(main.from + insert.length) });
    }
  }
  // ⌘K with text selected opens the bar's URL field; otherwise it types [](…).
  function linkCommand(v: EditorView) {
    return barWanted() ? openLinkInput() : insertLink(v);
  }

  function wireFormatBar() {
    for (const b of bar.querySelectorAll("button")) b.addEventListener("mousedown", (e) => e.preventDefault());
    $("fmt-bold").addEventListener("click", () => toggleWrap("**")(view));
    $("fmt-italic").addEventListener("click", () => toggleWrap("*")(view));
    $("fmt-link").addEventListener("click", () => openLinkInput());
    barLinkForm.addEventListener("submit", (e) => { e.preventDefault(); applyLink(barUrl.value.trim()); });
    barUrl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeLinkInput(true); }
    });
    barUrl.addEventListener("blur", () => setTimeout(() => {
      if (editingLink && !bar.contains(document.activeElement)) closeLinkInput(false);
    }, 0));
    view.contentDOM.addEventListener("mousedown", () => { dragging = true; bar.hidden = true; });
    window.addEventListener("mouseup", () => { if (dragging) { dragging = false; scheduleBar(); } });
    window.addEventListener("scroll", () => { if (!bar.hidden) placeBar(); }, { passive: true });
    window.addEventListener("resize", scheduleBar);
  }

  // ---------------------------------------------------------------- editor

  const stored = store.get(KEYS.doc);
  const initialDoc = stored === null ? WELCOME : stored;
  lastSaved = stored;

  function reactToChanges(u: ViewUpdate) {
    if (u.docChanged) {
      scheduleSave();
      renderTitle(u.state);
      if (u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("undo") || tr.isUserEvent("redo"))) {
        hideChrome();
      }
    } else if (u.selectionSet) {
      scheduleSave();
    }
    if (u.docChanged || u.selectionSet) renderStat(u.state);
    if (u.docChanged || u.selectionSet || u.focusChanged) scheduleBar();
  }

  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({ doc: initialDoc }),
    contentAttributes: { spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", "aria-label": "Document" },
    placeholder: "Start writing…",
    // A soft fade instead of an on/off blink; the caret stays solid while you type.
    cursorBlinkRate: 1100,
    keymap: [...formattingKeys, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab],
    handlers: { paste: [pasteURLAsLink, pasteLinks], mousedown: [openLinkOnModClick] },
    linkTitle: (href) => `${href}\n${isMac ? "⌘" : "Ctrl"}-click to open`,
    // Keep the line you're writing comfortably above the bottom edge.
    scrollMargins: () => ({ top: 80, bottom: Math.round(window.innerHeight * 0.3) }),
    updateListeners: [reactToChanges],
  });
  // Web fonts change the width of list prefixes; re-measure once they land.
  document.fonts?.ready.then(() => view.remeasure());

  wireFormatBar();

  // Restore where you were.
  const saved = store.json(KEYS.view);
  if (saved && stored !== null) {
    const len = view.state.doc.length;
    const clamp = (n: number) => Math.max(0, Math.min(len, n | 0));
    view.dispatch({ selection: { anchor: clamp(saved.anchor), head: clamp(saved.head) } });
    requestAnimationFrame(() => window.scrollTo(0, saved.scrollY || 0));
  } else if (stored === null) {
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }
  renderTitle(view.state);
  renderStat(view.state);
  view.focus();

  // Another tab edited the same document: take its version (last writer wins).
  window.addEventListener("storage", (e) => {
    if (e.key !== KEYS.doc || e.newValue === null || e.newValue === view.state.doc.toString()) return;
    lastSaved = e.newValue;
    const { anchor, head } = view.state.selection.main;
    const len = e.newValue.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: e.newValue },
      selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) },
    });
    if (previewing) renderPreview();
  });

  window.addEventListener("pagehide", saveNow);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
  window.addEventListener("scroll", () => { if (!saveTimer) saveTimer = window.setTimeout(saveNow, 800); }, { passive: true });

  // Clicking empty page space (outside the editor) still puts you in the document.
  $("page").addEventListener("mousedown", (e) => {
    if (previewing || e.target !== $("page")) return;
    e.preventDefault();
    view.focus();
  });

  // ---------------------------------------------------------------- theme

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolvedTheme = () => settings.theme || (media.matches ? "dark" : "light");
  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme) root.setAttribute("data-theme", settings.theme);
    else root.removeAttribute("data-theme");
    root.classList.toggle("is-dark", resolvedTheme() === "dark");
    $("btn-theme").setAttribute("aria-label", resolvedTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  function toggleTheme() {
    settings.theme = resolvedTheme() === "dark" ? "light" : "dark";
    saveSettings();
    applyTheme();
  }
  media.addEventListener("change", applyTheme);
  applyTheme();

  // ---------------------------------------------------------------- preview

  let previewing = false;
  const preview = $("preview");
  const editorEl = $("editor");

  function renderPreview() {
    const text = view.state.doc.toString();
    preview.innerHTML = text.trim()
      ? DOMPurify.sanitize(marked.parse(text, { gfm: true }))
      : '<p class="empty">Nothing to preview yet.</p>';
    for (const a of preview.querySelectorAll("a[href]")) {
      (a as HTMLAnchorElement).target = "_blank";
      (a as HTMLAnchorElement).rel = "noopener noreferrer";
    }
  }

  function togglePreview(force?: boolean) {
    const next = typeof force === "boolean" ? force : !previewing;
    if (next === previewing) return;
    const max = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = window.scrollY / max();
    previewing = next;
    if (previewing) {
      saveNow();
      renderPreview();
      editorEl.hidden = true;
      preview.hidden = false;
    } else {
      preview.hidden = true;
      editorEl.hidden = false;
      view.remeasure();
    }
    document.body.classList.toggle("previewing", previewing);
    $("btn-preview").setAttribute("aria-pressed", String(previewing));
    window.scrollTo(0, ratio * max());
    if (!previewing) view.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- help, toast

  const help = $("help");
  function toggleHelp(force?: boolean) {
    const open = typeof force === "boolean" ? force : help.hidden;
    help.hidden = !open;
    if (open) showChrome();
  }
  if (!isMac) {
    for (const k of help.querySelectorAll("kbd")) {
      if (k.textContent === "⌘") k.textContent = "Ctrl";
      else if (k.textContent === "⌥") k.textContent = "Alt";
      else if (k.textContent === "⇧") k.textContent = "Shift";
    }
    for (const b of document.querySelectorAll<HTMLElement>("[data-tip]")) {
      b.dataset.tip = b.dataset.tip!.replace("⌘⇧", "Ctrl+Shift+").replace("⌘", "Ctrl+");
    }
  }

  const toast = $("toast");
  let toastTimer = 0;
  function flash(text: string) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1400);
  }

  // ---------------------------------------------------------------- wiring

  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-preview").addEventListener("click", () => togglePreview());
  $("btn-help").addEventListener("click", () => toggleHelp());
  $("stat").addEventListener("click", () => {
    settings.stat = STATS[(STATS.indexOf(settings.stat) + 1) % STATS.length];
    saveSettings();
    renderStat(view.state);
  });
  // Keep the pointer's clicks on controls from stealing the caret.
  for (const b of document.querySelectorAll(".chrome button")) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
  }
  document.addEventListener("mousedown", (e) => {
    if (!help.hidden && !help.contains(e.target as globalThis.Node) && !$("btn-help").contains(e.target as globalThis.Node)) toggleHelp(false);
  });

  // App-level shortcuts work in both editing and preview.
  window.addEventListener("keydown", (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && e.shiftKey && key === "p") { handled(); togglePreview(); }
    else if (mod && e.shiftKey && key === "l") { handled(); toggleTheme(); }
    else if (mod && !e.shiftKey && (key === "/" || key === "?")) { handled(); toggleHelp(); }
    else if (mod && !e.shiftKey && key === "s") {
      handled();
      flash(saveNow() ? "Saved in this browser" : "Could not save");
    } else if (e.key === "Escape" && !e.defaultPrevented) {
      if (!help.hidden) toggleHelp(false);
      else if (previewing) togglePreview(false);
      else hideChrome();
    }
  }, true);

  // Handy when poking at the concept from the console or a test driver.
  window.scratchEditor = { view, togglePreview, toggleTheme, showChrome, hideChrome };
})();
