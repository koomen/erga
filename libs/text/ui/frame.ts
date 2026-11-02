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
import { LOADING_AGAIN } from "./drop";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { Relay, isAppShortcut, stateJSON, type Backdrop, type FromFrame, type Snapshot, type ToFrame } from "./bridge";
import { catchZoomGestures, clampZoom } from "./zoom";
import { captureView } from "./capture";
import { LivePage } from "./live-page-tab";
import { changesBetween } from "../../../document/merge";
import { baseName, encodePath } from "../../../document/pages";
import { sourceDigest } from "../../../shared/page-html";
import { linkTarget, placeOf } from "../../../client/common/link-target";
import type { ViewResult } from "../../../shared/agent-log";

declare global {
  interface Window {
    ergaFrame?: unknown; __ergaTimescale?: number;
    /** The viewer's script in the page (server/pages/reader.ts): its config, and what tells it the page's steps may have changed. */
    __ergaReader?: { config: { shell: string; prefix: string; src: string; address?: string }; changed?(): void; placed?(): void };
  }
}

/**
 * What the frame's editor state needs: the history (undo, shared with the
 * source view). No language: the frame has no CodeMirror view to highlight
 * (its build has an inert stand-in for the view's module: libs/text/ui/frame-view.ts),
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
/** Out of step with the shell: its text, whole, is on its way (attach); the changes before it don't fit. */
let resyncing = false;
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
      if (resyncing) return;
      // A change that doesn't fit this text: the two sides are out of step. The room's text, whole, puts it right (attach).
      let mine: ChangeSet | null = null;
      try {
        mine = relay.remote(ChangeSet.fromJSON(m.changes));
      } catch {
        /* out of step */
      }
      if (!mine || mine.length != page.state.doc.length) {
        console.warn(
          `page editor: a change for a text of ${m.length} characters doesn't fit this one (${page.state.doc.length}); resyncing`
        );
        resyncing = true;
        post({ type: "resync" });
        return;
      }
      page.applyExternal(mine, m.author);
      if (relay.idle && page.state.doc.length != m.length) post({ type: "resync" });
      if (page.stale) post({ type: "stale" });
      return;
    }
    case "ack":
      relay.accepted();
      sendSelection();
      return;
    case "reject":
      relay.refused();
      return;
    case "paused":
      page.setPaused(m.on);
      queueSnapshot();
      return;
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
    case "focus":
      if (document.hasFocus()) page.focus();
      else addEventListener("focus", () => page?.focus(), { once: true });
      return;
    case "leave":
      page.leaveText();
      return;
    case "reveal":
      page.reveal(m.pos);
      return;
    case "peers":
      page.setPeers(m.peers);
      return;
    case "detach":
      detach(m.id);
      return;
    case "attach":
      resyncing = false;
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
      // Another page of the document (dir: its folder) renders at its own address, at its start.
      (async () =>
        m.dir != null
          ? captureView(m.req, page!.renderedHtml(m.text, BASE + encodePath(m.dir)), "")
          : captureView(m.req, page!.renderedHtml(m.text), location.hash))()
        .catch((err: Error): ViewResult => ({ width: 0, height: 0, errors: [], error: `Couldn't capture the page: ${err.message}` }))
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
  // The state this page's editor had (with its undo history), brought to the room's text: before the page loaded again,
  // or before the editor stopped (out of the editor and back). Else the one the shell sent.
  let state = stateFrom(m.state), view = m.view ?? null;
  if (m.carry) {
    try {
      let carried = stateFrom(m.carry);
      const from = carried.doc.toString(), to = state.doc.toString();
      // The files dropped before the page loaded again, still on their way into the document: they go in here.
      const carriedDrops = Array.isArray(m.drops)
        ? (m.drops as { id: unknown; at: unknown; point: { x: unknown; y: unknown } | null }[])
        : [];
      for (const d of carriedDrops)
        if (
          Number.isInteger(d?.id) &&
          Number.isInteger(d.at) &&
          (d.at as number) <= from.length &&
          Number.isFinite(d.point?.x) &&
          Number.isFinite(d.point?.y)
        )
          drops.set(d.id as number, { at: d.at as number, point: { x: d.point!.x as number, y: d.point!.y as number } });
      dropSeq = Math.max(dropSeq, ...drops.keys());
      if (from != to) {
        const tr = carried.update({ changes: changesBetween(from, to), annotations: Transaction.addToHistory.of(false) });
        if (view) view = { pos: tr.changes.mapPos(view.pos, 1), top: view.top };
        for (const d of drops.values()) d.at = tr.changes.mapPos(d.at, 1);
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
    held: m.held,
    paused: m.paused,
    check: m.check,
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
        // A live page that reacts to input (it defines ergaPause) opens with its keys its own, as after Escape: a click on
        // text starts editing. Not when it loads again, nor paused: the caret stays where it was.
        if (!m.carry && !page.isPaused && page.canPause) page.leaveText();
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
      // (Its state has gone to the shell already: what's dropped now would have nowhere to go in.)
      if (reloading) return page?.dropError(point, LOADING_AGAIN);
      const id = ++dropSeq;
      drops.set(id, { at, point });
      post({ type: "upload", id, files: files.slice(0, 50) });
    },
  });
  window.ergaFrame = {
    page,
    get relay() {
      return relay;
    },
    get zoom() {
      return zoom;
    },
    get reloading() {
      return reloading;
    },
  };
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
      // The keys typed since go to the shell, which holds the ones after them too: the page that comes applies them all.
      const held = page?.takeHeld() ?? [];
      if (held.length) post({ type: "held", held });
      const y = Math.round(scrollY);
      // With the page's place in its own address (#3: agents/document/PROMPT.md, rule 14). (A reload: going to the same
      // address with a hash only goes to the place.)
      window.history.replaceState(null, "", location.pathname + "?erga-edit" + (y > 0 ? `&erga-y=${y}` : "") + location.hash);
      location.reload();
    };
    setTimeout(() => goAgain?.(), 4000);
    if (page && relay)
      post({
        type: "reloading",
        state: stateJSON(page.state, historyField),
        version: relay.version,
        view,
        focus: document.hasFocus(),
        drops: [...drops].map(([id, d]) => ({ id, ...d })),
      });
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
        has: { strong: page.hasStyle("strong"), em: page.hasStyle("em"), code: page.hasStyle("code"), u: page.hasStyle("u") },
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
  // Links, read as Erga addresses (client/common/link-target.ts). A link to another of the document's pages, outside the
  // text being edited (a menu, say): the shell goes there, to that page's editor. Any other web address: the shell
  // opens it, in a new tab unless the link says "_self" or "_top" (never in this frame). Links in the text itself aren't
  // followed; a ⌘-click (Ctrl-click), a Shift-click or the middle button opens any link in a new tab, as in the viewer.
  const follow = (e: Event) => {
    const c = e as MouseEvent;
    if (c.defaultPrevented || c.altKey || c.button != (c.type == "auxclick" ? 1 : 0)) return;
    const a = (c.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    const p = placeOf(win, reader);
    if (!a || !p || a.hasAttribute("download")) return;
    let url: URL;
    try { url = new URL(a.href); } catch { return; }
    const to = linkTarget(url, p);
    if (to.kind == "none" || to.kind == "file") return;
    const t = a.target.toLowerCase(),
      tab = c.type == "auxclick" || (isMac ? c.metaKey : c.ctrlKey) || c.shiftKey || t == "_blank",
      here = !t || t == "_self" || t == "_top" || t == "_parent";
    if (!tab && (a.isContentEditable || !here || a.getAttribute("href")!.startsWith("#"))) return;
    c.preventDefault();
    if (to.kind == "page" && !tab) {
      post({ type: "open", path: to.path || "index.html" });
      return;
    }
    const go = to.kind == "page" ? to.public : to.url;
    if (go) window.parent.postMessage({ type: "erga-go", url: go, tab: tab || !t ? "new" : undefined }, SHELL);
  };
  on(d, "click", follow);
  on(d, "auxclick", follow);
  on(win, "resize", () => queueSnapshot());
  // The shell's shortcuts, from anywhere on the page.
  on(win, "keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.defaultPrevented || k.isComposing || !isAppShortcut(k, isMac)) return;
    k.preventDefault();
    post({ type: "key", keys: { key: k.key, metaKey: k.metaKey, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey } });
  });
}

// The page's background, so the shell can paint its canvas to match: its
// root's, or its body's when the root has none, as the browser would. Read
// after every change applied to the page (an edit in place can change a
// style rule: mirror.ts), after a render, when a stylesheet loads, and when
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
