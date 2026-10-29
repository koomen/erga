// The page editor, in the document's own page (see bridge.ts): the viewer's
// page holds the page in its frame, on the document's own origin, and the
// page loads this script into itself when someone goes into the editor
// (server/pages/reader.ts). It does everything that needs the page's DOM:
// typing, selections, marks and carets, pausing, and the agent's screenshots,
// on the page as it is, which the pages origin served with the text's marks
// (shared/page-html.ts). Everything else is the shell's, which it reaches only by
// message, and only the shell may command it. Out of the editor, it stops,
// and the page carries on as it is.

import { ChangeSet, EditorState, Transaction, type Extension } from "@codemirror/state";
import { history, historyField } from "@codemirror/commands";
import { PageEditor, type LinkInfo } from "./editor";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { Relay, isAppShortcut, stateJSON, type Backdrop, type FromFrame, type Snapshot, type ToFrame } from "./bridge";
import { catchZoomGestures, clampZoom } from "./zoom";
import { evaluateIn } from "./evaluate";
import { LivePage } from "./live-page-tab";
import { changesBetween } from "../../document/merge";
import { baseName, encodePath } from "../../document/pages";
import { sourceDigest } from "../../shared/page-html";
import { evalTimeout, type ColorScheme, type RenderedFont, type ViewRequest, type ViewResult } from "../../shared/agent-log";
import { sleep } from "../../shared/time";

declare global {
  interface Window {
    ergaFrame?: unknown; __ergaTimescale?: number;
    /** The viewer's script in the page (server/pages/reader.ts): its config, and what tells it the page's steps may have changed. */
    __ergaReader?: { config: { shell: string; prefix: string; src: string }; changed?(): void; placed?(): void };
  }
}

/**
 * What the frame's editor state needs: the history (undo, shared with the
 * source view). No language: the frame has no CodeMirror view to highlight
 * (its build has an inert stand-in for the view's module: client/page-editor/frame-view.ts),
 * and the page is parsed by the page editor itself. The source view, in the
 * shell, has the HTML language. (Here, not in bridge.ts: the shell's main
 * script imports bridge.ts, and @codemirror/commands would bring the view.)
 */
performance.mark("erga:frame-js");
const docExtensions: Extension[] = [history()];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const reader = window.__ergaReader!.config;
/** The shell's origin (erga.dev): the only one this frame takes orders from, or sends to. */
const SHELL = reader.shell;
/** The document's files, under this origin (the token in the address opens them). */
const BASE = reader.prefix;
/** This page's own folder there: where its relative links and assets resolve. */
const HERE = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
/** The digest of the text the page shows now: the one the pages origin made it from, then (out of the editor) the last the editor showed. */
let shown = reader.src;

const post = (m: FromFrame) => window.parent.postMessage(m, SHELL);

// The live page, for the agent's page_console, page_network, page_events, page_inspect, page_click and page_key
// (live-page.ts). A stack frame of a script from where this one is (the app's /_erga/: this module and its chunks) is the editor's code.
const SELF = new URL(".", import.meta.url).href;
const live = new LivePage(BASE, SELF);

let page: PageEditor | null = null;
/** Files dropped or pasted on the page that the shell is adding to the document's files: where they go in (mapped through the edits meanwhile). */
const drops = new Map<number, { at: number; point: { x: number; y: number } }>();
let dropSeq = 0;
let relay: Relay | null = null;
/** In the source view the shell holds the text; edits here would go nowhere. */
let detached = false;
let restoreScroll: number | null = null;
/** What stops what the editor added to the page besides its own (its caret, the watches the shell's controls follow). */
let unwatch: (() => void)[] = [];
/** The shell asked for the editor: the page loads this only when it does (or opened in the editor: ?erga-edit). */
let asked = true;

// The page's zoom, as the shell sets it (zoom.ts): the shell draws the page's frame `zoom` times larger and gives it a
// viewport that much smaller, as the browser's own zoom would, so the page lays itself out again to fit. Clicks and the
// caret stay right, as the browser maps them through the scale; what this frame tells the shell in its own coordinates
// (the pointer, the selection's rectangle) is scaled to match (`z`).
let zoom = 1;
const z = (n: number) => n * zoom;
/** The link for the shell's link bar, its rectangle in the shell's coordinates. */
const linkIn = (l: LinkInfo | null): LinkInfo | null => l && { ...l, rect: l.rect && { left: z(l.rect.left), top: z(l.rect.top), width: z(l.rect.width), bottom: z(l.rect.bottom) } };
function setZoom(level: number) {
  const next = clampZoom(level);
  if (next == zoom) return;
  // The same place in the page stays at the top, as near as the page's new layout allows, once it has it.
  const el = document.documentElement, at = el.scrollHeight > 0 ? scrollY / el.scrollHeight : 0;
  zoom = next;
  if (at) addEventListener("resize", () => scrollTo(scrollX, at * el.scrollHeight), { once: true });
  queueSnapshot();
}

/** Tells the shell the editor is here, once it's asked and the page has loaded (its scripts have built what they build on load). */
function tellReady() {
  if (!asked || page) return;
  if (document.readyState != "complete") { addEventListener("load", tellReady, { once: true }); return; }
  post({ type: "ready" });
}
tellReady();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  const m = e.data as ToFrame | { type: "erga-edit" };
  // The shell asks for the editor (again: out of the editor and back, or it missed our "ready", sent before it was listening).
  if (m.type == "erga-edit") { asked = true; tellReady(); return; }
  if (m.type == "init") return start(m);
  if (m.type == "stop") return stop(m.id);
  if (m.type == "reload") { goAgain?.(); return; }
  if (m.type == "live") {
    const answer = page ? live.answer(m.req).catch((e: Error) => ({ error: `The page couldn't answer: ${e.message}` })) : Promise.resolve({ error: "The editor hasn't started in this tab yet." });
    answer.then((result) => post({ type: "lived", id: m.id, result }));
    return;
  }
  if (!page || !relay) return;
  switch (m.type) {
    case "external": {
      const mine = relay.remote(ChangeSet.fromJSON(m.changes));
      page.applyExternal(mine, m.author);
      if (relay.idle && page.state.doc.length != m.length) post({ type: "resync" });
      if (page.stale) post({ type: "stale" });
      return;
    }
    case "ack": relay.accepted(); sendSelection(); return;
    case "reject": relay.refused(); return;
    case "authorship": page.recordAuthorship(ChangeSet.fromJSON(m.changes), m.author); return;
    case "tracking": page.setTracking(m.on); return;
    case "paused": page.setPaused(m.on); queueSnapshot(); return;
    // (The page loads again, made from the text: reload.)
    case "render": page.render(); return;
    case "zoom": setZoom(m.level); return;
    case "pageZoom": {
      const win = window as Window & { ergaZoom?: unknown };
      if (typeof win.ergaZoom == "function" && Number.isFinite(m.by)) {
        try { (win.ergaZoom as (by: number) => void)(m.by); }
        catch (e) { post({ type: "notice", message: `window.ergaZoom(${m.by}) threw: ${e instanceof Error ? e.message : String(e)}` }); }
      }
      return;
    }
    // The shell focuses this frame as it asks (Remote.focus): if this frame lost the focus since, something that opened
    // after the ask has it (the pages card, the agent's box), and keeps it.
    // (The shell's focus can reach this window a moment after its word: then, as it does.)
    case "focus": if (document.hasFocus()) page.focus(); else addEventListener("focus", () => page?.focus(), { once: true }); return;
    case "reveal": page.reveal(m.pos); return;
    case "peers": page.setPeers(m.peers); return;
    case "detach": detach(m.id); return;
    case "attach":
      relay.reset(m.version);
      detached = false;
      page.setState(stateFrom(m.state));
      page.hold(false);
      return;
    case "style": {
      const why = m.op == "toggle" ? page.toggleStyle(m.style) : m.op == "clear" ? page.clearStyles() : page.setLink(m.edit);
      post({ type: "styled", id: m.id, why });
      queueSnapshot();
      return;
    }
    case "uploaded": {
      const d = drops.get(m.id);
      if (!d) return;
      drops.delete(m.id);
      const paths = Array.isArray(m.paths) ? m.paths.filter((p): p is string => typeof p == "string") : [];
      // From this page's folder (a page in blog/ reaches images/ as ../images/).
      const up = "../".repeat(HERE.startsWith(BASE) ? HERE.slice(BASE.length).split("/").filter(Boolean).length : 0);
      const items = paths.map((p) => ({ href: up + encodePath(p), name: baseName(p), image: p.startsWith("images/") }));
      if (items.length && !page.insertFiles(d.at, items))
        page.dropError(
          d.point,
          `The text where it was dropped changed meanwhile. It's in the document's files (${paths.join(", ")}): drop it again.`
        );
      else if (m.error) page.dropError(d.point, m.error);
      return;
    }
    case "capture":
      captureView(m.req, m.text).catch((err: Error): ViewResult => ({ width: 0, height: 0, errors: [], error: `Couldn't capture the page: ${err.message}` }))
        .then((result) => post({ type: "captured", id: m.id, result }));
      return;
  }
});

const stateFrom = (json: unknown) => EditorState.fromJSON(json, { extensions: docExtensions }, { history: historyField });

function start(m: Extract<ToFrame, { type: "init" }>) {
  performance.mark("erga:init");
  if (page) return;
  if (m.timescale) window.__ergaTimescale = m.timescale;
  if (typeof m.zoom == "number") setZoom(m.zoom);
  // Where the page was scrolled to before a reload for a new release: there once it renders.
  // (Its images may still be loading, so the page may not be that long yet: tried again for a moment, until it gets
  // there or someone else scrolls it.)
  if (typeof m.scroll == "number" && Number.isFinite(m.scroll) && m.scroll > 0 && Math.abs(scrollY - m.scroll) >= 2) {
    const y = restoreScroll = m.scroll, until = Date.now() + 3000;
    let last: number | null = null;
    const again = () => {
      if (Date.now() > until || !page) return;
      if (restoreScroll != null) { setTimeout(again, 100); return; }
      if (Math.abs(scrollY - y) < 2 || (last != null && Math.abs(scrollY - last) >= 2)) return;
      scrollTo(0, y);
      last = scrollY;
      setTimeout(again, 100);
    };
    setTimeout(again, 100);
  }
  if (m.frame) live.pageFrame = m.frame;
  relay = new Relay(m.version, (version, changes) => post({ type: "push", version, changes: changes.toJSON() }));
  // The state this page's editor had (with its undo history), brought to the shell's text: before the page loaded again,
  // or before the editor stopped (out of the editor and back). Else the shell's.
  let state = stateFrom(m.state), view = m.view ?? null;
  if (m.carry) {
    try {
      let carried = stateFrom(m.carry);
      const from = carried.doc.toString(), to = state.doc.toString();
      if (from != to) {
        const tr = carried.update({ changes: changesBetween(from, to), annotations: Transaction.addToHistory.of(false) });
        if (view) view = { pos: tr.changes.mapPos(view.pos, 1), top: view.top };
        carried = tr.state;
      }
      state = carried;
    } catch { /* the shell's, then */ }
  }
  detached = false;
  page = new PageEditor({
    win: window,
    source: shown,
    state,
    base: HERE,
    self: m.self,
    held: m.held,
    paused: m.paused,
    onReload: reload,
    onUpdate(u) {
      if (u.changes && !u.remote && !detached) relay!.local(u.changes);
      if (u.changes) for (const d of drops.values()) d.at = u.changes.mapPos(d.at, 1);
      if (u.docChanged || u.selectionSet) sendSelection();
      // A presentation's pictures of its steps are out of date once its text changes.
      if (u.docChanged) { window.__ergaReader?.changed?.(); queueBackdrop(); }
      // (The editor takes the page as it's made: once it's this frame's.)
      if (u.rendered) queueMicrotask(() => {
        if (!page) return;
        live.attach(window);
        unwatch.push(drawCaret(window as Window & typeof globalThis, () => zoom));
        watchPage();
        watchBackdrop();
        syncBackdrop(true);
        performance.mark("erga:rendered");
        if (restoreScroll != null) { scrollTo(0, restoreScroll); restoreScroll = null; }
        // Made afresh: the line the reader was on, where it was (the viewer's script had it near there: ?erga-y).
        if (view) { window.__ergaReader?.placed?.(); page.restoreView(view); view = null; }
        // The page had the focus as it loaded again: it has it again, for the keys held meanwhile.
        if (m.focus) { m.focus = false; page.focus(); page.hold(false); }
      });
      queueSnapshot(u.rendered);
    },
    onKey: (e) => {
      if (!isAppShortcut(e, isMac)) return false;
      post({ type: "key", keys: { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } });
      return true;
    },
    onNotice: (message, fix) => post({ type: "notice", message, fix }),
    onProblem: (p) => post({ type: "problem", key: p.key, message: p.message, fix: p.fix }),
    onPointer: (e) => post({ type: "pointer", kind: "move", x: z(e.clientX), y: z(e.clientY) }),
    onDropFiles(files, at, point) {
      const id = ++dropSeq;
      drops.set(id, { at, point });
      post({ type: "upload", id, files: files.slice(0, 50) });
    },
  });
  if (m.tracking) page.setTracking(true);
  window.ergaFrame = { page, get relay() { return relay; }, get zoom() { return zoom; } };
}

/**
 * The page made afresh from the text (a change the editor can't patch in, or a page made from another text): once the
 * shell has this editor's edits, its state (undo history and all) goes to the shell, which hands it to the editor in the
 * page as it loads again, scrolled where it was. The page's scripts run again: on purpose.
 */
let reloading = false, goAgain: (() => void) | null = null;
function reload(view: { pos: number; top: number } | null) {
  if (reloading) return;
  reloading = true;
  const go = () => {
    if (relay && !relay.idle) { setTimeout(go, 10); return; }
    // The shell says when (reload: once the room has the edits), or after a while all the same.
    goAgain = () => {
      goAgain = null;
      const y = Math.round(scrollY);
      location.replace(location.pathname + "?erga-edit" + (y > 0 ? `&erga-y=${y}` : ""));
    };
    setTimeout(() => goAgain?.(), 4000);
    if (page && relay) post({ type: "reloading", state: stateJSON(page.state, historyField), version: relay.version, view, focus: document.hasFocus() });
    else goAgain();
  };
  // (After the change in hand: the render it asked for comes in the middle of it, before its selection and its push.)
  setTimeout(go);
}

/** Out of the editor: once the shell has this editor's edits, its state goes to the shell (for the way back in), and the editor stops; the page stays as it is. */
function stop(id: number) {
  asked = false;
  const go = () => {
    if (!page || !relay) { post({ type: "stopped", id, state: null, version: 0 }); return; }
    if (!relay.idle) { setTimeout(go, 10); return; }
    post({ type: "stopped", id, state: stateJSON(page.state, historyField), version: relay.version });
    // What the page shows now: this text, if the editor has shown all of it.
    shown = page.upToDate ? sourceDigest(page.state.doc.toString()) : "";
    page.stop();
    for (const f of unwatch.splice(0)) f();
    backdropObserver?.disconnect();
    page = null;
    relay = null;
    window.ergaFrame = undefined;
  };
  go();
}

/** This frame's selection, for the shell to share as your caret: only when it's in the shell's terms (no edits in flight). */
function sendSelection() {
  if (!page || !relay?.idle || detached) return;
  const sel = page.state.selection.main;
  post({ type: "selection", version: relay.version, anchor: sel.anchor, head: sel.head });
}

/** What the shell's controls show, at most once a frame. */
let snapshotQueued = false, renderedSince = false;
function queueSnapshot(rendered = false) {
  renderedSince ||= rendered;
  if (snapshotQueued) return;
  snapshotQueued = true;
  requestAnimationFrame(() => {
    snapshotQueued = false;
    if (!page) return;
    const rect = page.selectionRect();
    const snapshot: Snapshot = {
      title: page.title(),
      canPause: page.canPause,
      paused: page.isPaused,
      zoomsItself: typeof (window as Window & { ergaZoom?: unknown }).ergaZoom == "function",
      fmt: {
        rect: rect && { left: z(rect.left), top: z(rect.top), width: z(rect.width), bottom: z(rect.bottom) },
        blocker: page.styleBlocker(),
        has: { strong: page.hasStyle("strong"), em: page.hasStyle("em"), code: page.hasStyle("code") },
        text: rect ? page.selectedText().slice(0, 500) : "",
        link: linkIn(page.linkAt()),
      },
      scrollY: Math.round(scrollY),
    };
    post({ type: "update", rendered: renderedSince, snapshot });
    renderedSince = false;
  });
}

/** Leaving for the source view: once our edits are in, the state goes to the shell (undo history and all). */
function detach(id: number) {
  if (!page || !relay) return;
  if (!relay.idle) { setTimeout(() => detach(id), 10); return; }
  detached = true;
  page.hold(true);
  post({ type: "detached", id, state: stateJSON(page.state, historyField), version: relay.version });
}

/** Tells the shell what happens in the page that its controls follow: pointers, keys, focus, the selection moving. */
function watchPage() {
  const d = document, win = window as Window & typeof globalThis;
  const on = (target: Document | Window, type: string, f: (e: Event) => void, opts?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, f, opts);
    unwatch.push(() => target.removeEventListener(type, f, opts));
  };
  unwatch.push(listenAsEditor(d, "pointerdown", (e) => { const p = e as PointerEvent; post({ type: "pointer", kind: "down", x: z(p.clientX), y: z(p.clientY) }); }, true));
  unwatch.push(listenAsEditor(d, "mouseup", (e) => { const p = e as MouseEvent; post({ type: "pointer", kind: "up", x: z(p.clientX), y: z(p.clientY) }); }, true));
  unwatch.push(catchZoomGestures(win, (by) => post({ type: "zoom", zoom: by })));
  on(d, "keydown", () => post({ type: "activity", kind: "key" }), true);
  on(win, "focus", () => post({ type: "activity", kind: "focus" }), true);
  on(d, "scroll", () => queueSnapshot(), { passive: true });
  // The format bar follows selected text that moves another way: a scroll in an element, a pan of the page's own (moves.ts).
  watchMoves(d, win, () => { if (page && d.getSelection()?.isCollapsed === false) queueSnapshot(); });
  on(d, "selectionchange", () => queueSnapshot());
  // A link to another of the document's pages, outside the text being edited (a menu, say): the shell goes
  // there, to that page's editor. Links in the text itself aren't followed (⌘-click opens them in a tab).
  on(d, "click", (e) => {
    const c = e as MouseEvent;
    if (c.defaultPrevented || c.button || c.metaKey || c.ctrlKey || c.shiftKey || c.altKey) return;
    const a = (c.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.isContentEditable || (a.target && a.target != "_self") || a.getAttribute("href")!.startsWith("#")) return;
    let url: URL;
    try { url = new URL(a.href); } catch { return; }
    if (url.origin != location.origin || !url.pathname.startsWith(BASE)) return;
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(BASE.length)); } catch { return; }
    // A page, or an address like a folder's ("blog/"); not a stylesheet or an image.
    if (/\.[^./]+$/.test(path) && !/\.(html|md)$/i.test(path)) return;
    c.preventDefault();
    post({ type: "open", path });
  });
  on(win, "resize", () => queueSnapshot());
  // The shell's shortcuts, from anywhere on the page.
  on(win, "keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.defaultPrevented || !isAppShortcut(k, isMac)) return;
    k.preventDefault();
    post({ type: "key", keys: { key: k.key, metaKey: k.metaKey, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey } });
  });
}

// The page's background, so the shell can paint its canvas to match: its
// root's, or its body's when the root has none, as the browser would. Read
// after every change applied to the page (an edit in place can change a
// style rule: morph.ts), after a render, when a stylesheet loads, and when
// the page's own script switches themes (a class or style on <html> or
// <body>); said again only when it changed, at most once a task.
let backdropObserver: MutationObserver | null = null, backdropSaid = "", backdropQueued = false;
function syncBackdrop(always = false) {
  const d = document, win = window;
  if (!page) return;
  if (!d?.documentElement || !win) return;
  const transparent = (cs: CSSStyleDeclaration) => cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
  let cs = win.getComputedStyle(d.documentElement);
  if (transparent(cs) && d.body) cs = win.getComputedStyle(d.body);
  // (A page that's only a gradient: the gradient's colour at the top, as the header sits there; the gradient itself is
  // the viewer's script's to tell, server/pages/reader.ts canvas.)
  const clear = /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor), img = cs.backgroundImage;
  const stops = clear && /gradient/.test(img) ? img.match(/rgba?\([^)]*\)/g) : null;
  const top = stops ? (/^linear-gradient\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0]) : "";
  const backdrop: Backdrop = { color: clear ? top : cs.backgroundColor, image: img == "none" ? "" : img };
  const said = JSON.stringify(backdrop);
  if (!always && said == backdropSaid) return;
  backdropSaid = said;
  post({ type: "backdrop", backdrop });
}
/** The background read once the change in hand is made (before the browser paints it), however many changes it has. */
function queueBackdrop() {
  if (backdropQueued) return;
  backdropQueued = true;
  queueMicrotask(() => { backdropQueued = false; syncBackdrop(); });
}
/** Follows the page: its script's theme switches, and its stylesheets as they load. */
function watchBackdrop() {
  const d = document as Document & { ergaBackdrop?: boolean };
  if (!d?.documentElement) return;
  backdropObserver ??= new MutationObserver(() => queueBackdrop());
  backdropObserver.disconnect();
  backdropObserver.observe(d.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (d.body) backdropObserver.observe(d.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (d.ergaBackdrop) return;
  d.ergaBackdrop = true;
  // (A stylesheet's load event doesn't bubble: heard on its way down.)
  d.addEventListener("load", (e) => { if ((e.target as Element).localName == "link") queueBackdrop(); }, true);
}

// The agent asks to see the page. This frame renders the latest version
// (edits still waiting for the end of the agent's turn included) in a
// hidden frame and draws it to an image, which the browser renders itself
// (modern-screenshot: the DOM through an SVG foreignObject), with any
// errors the page's scripts threw. No server-side browser: whoever has the
// editor open is the agent's eyes. It renders at the user's size and in
// their light or dark mode unless the agent asks for others, waits (up to
// LOAD_WAIT) for the page's web fonts and images, and says which fonts the
// text rendered in, so a fallback font shows as one.
const CATCH_ERRORS = `<script>window.__ergaErrors=[];addEventListener("error",function(e){__ergaErrors.push(String(e.message))});addEventListener("unhandledrejection",function(e){__ergaErrors.push("Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason))});(function(){var ce=console.error;console.error=function(){__ergaErrors.push("console.error: "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)}})()</script>`;
/**
 * Light or dark mode for the hidden frame, when the agent asks for the one
 * the browser doesn't prefer (a frame can't be given its own preference):
 * every prefers-color-scheme query the page can reach, in its stylesheets,
 * its elements' media attributes and its scripts' matchMedia, answers for
 * `scheme` instead.
 */
const schemeQuery = (scheme: ColorScheme, media: string) =>
  media.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, s: string) => s.toLowerCase() == scheme ? "(min-width: 0px)" : "(min-width: 1000000px)");
const forceSchemeScript = (scheme: ColorScheme) =>
  `<script>(function(){var mm=window.matchMedia;window.matchMedia=function(q){return mm.call(window,String(q).replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(light|dark)\\s*\\)/gi,function(_,s){return s.toLowerCase()==${JSON.stringify(scheme)}?"(min-width: 0px)":"(min-width: 1000000px)"}))}})()</script>`;
function forceScheme(d: Document, scheme: ColorScheme) {
  const w = d.defaultView as Window & typeof globalThis; // the page's own classes: instanceof is per window
  const rewrite = (rules: CSSRuleList) => {
    for (const r of rules) {
      if ((r instanceof w.CSSMediaRule || r instanceof w.CSSImportRule) && /prefers-color-scheme/i.test(r.media.mediaText)) r.media.mediaText = schemeQuery(scheme, r.media.mediaText);
      if (r instanceof w.CSSImportRule) { try { if (r.styleSheet) rewrite(r.styleSheet.cssRules); } catch { /* another site's */ } }
      else if ("cssRules" in r) rewrite((r as CSSGroupingRule).cssRules);
    }
  };
  for (const s of d.styleSheets) { try { rewrite(s.cssRules); } catch { /* another site's: out of reach */ } }
  for (const el of d.querySelectorAll<HTMLElement>("[media]")) {
    const m = el.getAttribute("media")!;
    if (/prefers-color-scheme/i.test(m)) el.setAttribute("media", schemeQuery(scheme, m));
  }
  // A page that lets the browser choose (color-scheme: light dark) gets the one asked for.
  const root = d.documentElement, cs = d.defaultView!.getComputedStyle(root).colorScheme;
  if (/light/.test(cs) && /dark/.test(cs)) root.style.setProperty("color-scheme", scheme);
}
const MAX_SHOT = 4000;
const LOAD_WAIT = 5000;
async function captureView(req: ViewRequest, text?: string): Promise<ViewResult> {
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? (innerWidth || 1280))));
  const viewport = Math.round(Math.max(200, Math.min(MAX_SHOT, req.height ?? (innerHeight || 800))));
  const prefers: ColorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const scheme = req.colorScheme ?? prefers;
  const forced = scheme != prefers;
  const shot = document.createElement("iframe");
  shot.setAttribute("sandbox", "allow-scripts allow-same-origin");
  shot.setAttribute("aria-hidden", "true");
  // (The editor's own, in the page: data-erga, which its morph leaves be.)
  shot.setAttribute("data-erga", "");
  shot.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${viewport}px;border:0;`;
  const html = page!.renderedHtml(text);
  const head = CATCH_ERRORS + (forced ? forceSchemeScript(scheme) : "");
  shot.srcdoc = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + head) : head + html;
  document.body.append(shot);
  try {
    await new Promise<void>((resolve, reject) => { shot.onload = () => resolve(); setTimeout(() => reject(new Error("the page took too long to load")), 10_000); });
    const d = shot.contentDocument!, win = shot.contentWindow as (Window & { __ergaErrors?: string[] }) | null;
    if (forced) forceScheme(d, scheme);
    const unread = await embeddableFonts(d);
    const pending = await settle(d, Date.now() + LOAD_WAIT);
    await sleep(600); // let the page's own scripts draw
    if (req.evaluate != null) {
      const r = await evaluateIn(win!, String(req.evaluate), evalTimeout(req));
      return { width, height: viewport, ...r, errors: [...(win?.__ergaErrors ?? [])] };
    }
    const root = win!.getComputedStyle(d.documentElement), body = d.body ? win!.getComputedStyle(d.body) : null;
    const clear = (c: string) => /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
    const bg = !clear(root.backgroundColor) ? root.backgroundColor : body && !clear(body.backgroundColor) ? body.backgroundColor : scheme == "dark" && /dark/.test(root.colorScheme) ? "#121212" : "#ffffff";
    let target: Element = d.documentElement, w = width, h = viewport;
    const notes: string[] = [];
    if (req.selector) {
      let el: Element | null = null;
      try { el = d.querySelector(req.selector); } catch { return { width: 0, height: 0, errors: [], error: `${req.selector} isn't a valid CSS selector` }; }
      if (!el) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `Nothing on the page matches ${req.selector}` };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered` };
      target = el; w = Math.ceil(r.width); h = Math.min(MAX_SHOT, Math.ceil(r.height));
      if (r.height > MAX_SHOT) notes.push(`${req.selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.`);
    } else if (req.fullPage) {
      const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
      h = Math.min(MAX_SHOT, full);
      if (full > MAX_SHOT) notes.push(`The page is ${full}px tall; this shows the top ${MAX_SHOT}px.`);
    }
    if (unread.length) notes.push(`The picture may show fallback fonts where the page uses fonts from ${unread.join(", ")}: that stylesheet can't be read from the page (no CORS), so its fonts can't go into the picture.`);
    const fonts = renderedFonts(d, target);
    // An element is drawn at its own size, without the margins around it (they'd shift it inside the image).
    // (The screenshots' code loads the first time the agent asks for one.)
    const { domToPng } = await import("modern-screenshot");
    const url = await domToPng(target, target == d.documentElement ? { width: w, height: h, backgroundColor: bg, scale: 1 } : { backgroundColor: bg, scale: 1, style: { margin: "0" } });
    return {
      png: url.slice(url.indexOf(",") + 1), width: w, height: h, errors: win?.__ergaErrors ?? [],
      viewport: { width, height: viewport }, colorScheme: scheme, fonts,
      ...(pending.length ? { pending } : {}),
      ...(notes.length ? { note: notes.join("\n") } : {}),
    };
  } finally {
    shot.remove();
  }
}

/**
 * Stylesheets from other sites (Google Fonts, say) can't be read by the
 * page's scripts, so modern-screenshot can't put their fonts in the picture
 * and draws their text in a fallback. Their @font-face rules are fetched
 * (most font services allow it: CORS) and added to the page as its own.
 * Answers the ones that couldn't be read.
 */
async function embeddableFonts(d: Document): Promise<string[]> {
  const sheets = [...d.styleSheets].filter((s) => { try { void s.cssRules; return false; } catch { return !!s.href; } });
  const unread: string[] = [];
  await Promise.all(sheets.map(async (s) => {
    const href = s.href!;
    try {
      const res = await fetch(href, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(LOAD_WAIT) });
      if (!res.ok) throw new Error(String(res.status));
      const css = (await res.text()).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, _q, u: string) => `url("${new URL(u, href).href}")`);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      const faces = [...sheet.cssRules].filter((r) => r instanceof CSSFontFaceRule).map((r) => r.cssText);
      if (!faces.length) return;
      const style = d.createElement("style");
      style.dataset.ergaFonts = href;
      style.textContent = faces.join("\n");
      d.head.append(style);
    } catch {
      unread.push(new URL(href).host);
    }
  }));
  return [...new Set(unread)];
}

/**
 * Waits until the page's fonts and images have loaded, or `deadline`.
 * A web font loads only once some text needs it, so this lays the page out
 * first; lazy images load at once, since a whole-page picture shows them.
 * Answers what still hadn't loaded.
 */
async function settle(d: Document, deadline: number): Promise<string[]> {
  const imgs = [...d.images];
  for (const img of imgs) if (img.loading == "lazy") img.loading = "eager";
  const loading = () => [
    ...[...d.fonts].filter((f) => f.status == "loading").map((f) => ({ what: `font ${f.family.replace(/^["']|["']$/g, "")} ${f.weight} ${f.style}`, done: f.loaded.then(() => {}, () => {}) })),
    ...imgs.filter((i) => i.src && !i.complete).map((i) => ({ what: `image ${i.getAttribute("src")}`, done: i.decode().catch(() => {}) })),
  ];
  // Text laid out in a newly loaded font can need another (a bold or an italic): look again until nothing loads.
  for (let round = 0; round < 5; round++) {
    void d.documentElement.getBoundingClientRect();
    await Promise.race([new Promise((r) => requestAnimationFrame(r)), sleep(50)]); // a tab in the background gets no frames
    const now = loading();
    if (!now.length) { await Promise.race([d.fonts.ready, sleep(deadline - Date.now())]); if (!loading().length) break; continue; }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Promise.race([Promise.all(now.map((l) => l.done)), sleep(left)]);
  }
  return [...new Set(loading().map((l) => l.what))];
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);

/**
 * The fonts the text under `root` rendered in: for each element with text of
 * its own, the first family in its font-family that the browser could use
 * (a web font that loaded, a font on this computer, or a generic one).
 */
function renderedFonts(d: Document, root: Element): RenderedFont[] {
  const win = d.defaultView!;
  const faces = new Map<string, FontFace[]>();
  for (const f of d.fonts) { const k = unquote(f.family).toLowerCase(); faces.set(k, [...(faces.get(k) ?? []), f]); }
  const ctx = d.createElement("canvas").getContext("2d");
  const installed = new Map<string, boolean>();
  const isInstalled = (family: string) => {
    if (!installed.has(family)) {
      // A font the computer has changes how wide text is, from at least one of two different fallbacks.
      const probe = "mmmmmmmmmmlli WQ@#0123456789";
      const width = (font: string) => { ctx!.font = font; return ctx!.measureText(probe).width; };
      installed.set(family, !!ctx && ["monospace", "serif"].some((g) => width(`72px "${family}", ${g}`) != width(`72px ${g}`)));
    }
    return installed.get(family)!;
  };
  const resolve = (stack: string): { family: string; wanted?: string } => {
    const families = stack.split(",").map((f) => unquote(f.trim())).filter(Boolean);
    for (const family of families) {
      const key = family.toLowerCase();
      if (GENERIC.has(key)) return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
      const own = faces.get(key);
      if (own ? own.some((f) => f.status == "loaded") : isInstalled(family)) return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
    }
    return { family: "the browser's default font", wanted: families[0] };
  };
  const by = new Map<string, RenderedFont>();
  const seen = new Set<Element>();
  const walk = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.nodeValue?.trim() || el.closest("script, style, noscript, template, title")) continue;
    seen.add(el);
    const cs = win.getComputedStyle(el);
    if (cs.display == "none" || cs.visibility == "hidden") continue;
    const r = resolve(cs.fontFamily);
    const key = `${r.family}|${r.wanted ?? ""}`;
    const f = by.get(key) ?? { family: r.family, ...(r.wanted ? { wanted: r.wanted } : {}), elements: 0, tags: [] };
    f.elements++;
    const tag = el.tagName.toLowerCase();
    if (f.tags.length < 5 && !f.tags.includes(tag)) f.tags.push(tag);
    by.set(key, f);
  }
  return [...by.values()].sort((a, b) => b.elements - a.elements).slice(0, 10);
}
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
