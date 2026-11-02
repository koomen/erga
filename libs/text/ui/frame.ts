// The page editor, in the document's own page: the viewer's page holds the page in its frame, on the document's own
// origin (<id>-<owner>.erga-pages.dev), and the page's first script (client/inline/reader.ts) loads this one into it
// when the viewer says "edit" (its one message, erga-mode, with the edit key). From then on the editor is the page's:
// it opens the document's socket itself, from this origin, with the key (documents/edit-key.ts), holds its own
// replica of the room (collab.ts), sends every edit there and applies everyone else's, shows where the others' carets
// are and shows its own to them. It does everything that needs the page's DOM: typing, selections, marks and carets,
// and pausing, on the page as it is, which the pages origin served from the text (shared/page-html.ts). When the
// viewer says "view", it stops, and the page carries on as it is.

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { history, historyField } from "@codemirror/commands";
import { PageEditor, type HeldInput, type LinkInfo, type MarkAuthor, type Peer } from "./editor";
import { LOADING_AGAIN } from "./drop";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { isAppShortcut, stateJSON, type Backdrop, type EditMode, type FromFrame, type Snapshot, type ToFrame } from "./bridge";
import { catchZoomGestures, clampZoom } from "./zoom";
import { Collab } from "./collab";
import { changesBetween } from "../../../document/merge";
import { baseName, encodePath } from "../../../document/pages";
import type { Author } from "../../../document/content";
import { sourceDigest } from "../../../shared/page-html";
import { sleep } from "../../../shared/time";
import { linkTarget, placeOf } from "../../../client/common/link-target";
// (window.__ergaReader: the page's first script, which loads this one.)
import type {} from "../../../client/common/reader-api";

declare global {
  interface Window {
    ergaFrame?: unknown;
    __ergaTimescale?: number;
  }
}

/**
 * What the editor's state needs: the history (undo). No language: the frame has no CodeMirror view to highlight (its
 * build has an inert stand-in for the view's module: libs/text/ui/frame-view.ts), and the page editor parses the page
 * itself.
 */
performance.mark("erga:frame-js");
const docExtensions: Extension[] = [history()];

type Editing = Extract<EditMode, { mode: "edit" }>;

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

/** The viewer's last word, edit (with the key, and where the room is), or null for view. */
let mode: Editing | null = null;
let collab: Collab | null = null;
let page: PageEditor | null = null;
/** The editor's state as it stopped (undo history and all), for the way back in. */
let kept: EditorState | null = null;
/** Files dropped or pasted on the page that the shell is adding to the document's files: where they go in (mapped through the edits meanwhile). */
const drops = new Map<number, { at: number; point: { x: number; y: number } }>();
let dropSeq = 0;
/** What stops what the editor added to the page besides its own (its caret, the watches the shell's controls follow). */
let unwatch: (() => void)[] = [];

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

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  const m = e.data as ToFrame;
  if (m.type == "erga-mode") return setMode(m);
  if (!page) return;
  switch (m.type) {
    case "paused":
      page.setPaused(m.on);
      queueSnapshot();
      return;
    // (The page loads again, made from the text: reload.)
    case "render": page.render(); return;
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
  }
});

/** The viewer says edit or view. Edit again: a new key (for the next socket), or another zoom. */
function setMode(m: EditMode) {
  if (m.mode == "view") {
    mode = null;
    stop();
    return;
  }
  mode = m;
  if (m.timescale) window.__ergaTimescale = m.timescale;
  if (typeof m.zoom == "number") setZoom(m.zoom);
  if (!collab) void start();
}

// The word that loaded this script (the page's first script kept it).
const first = window.__ergaReader?.mode as EditMode | undefined;
if (first?.type == "erga-mode") queueMicrotask(() => setMode(first));

const stateFrom = (json: unknown) => EditorState.fromJSON(json, { extensions: docExtensions }, { history: historyField });

/** What the editor keeps of itself in this tab, for the page that loads in its place (a reload: its own, or the viewer's). */
interface Carry {
  path: string;
  state: unknown;
  view: { pos: number; top: number } | null;
  held?: HeldInput[];
  focus?: boolean;
  drops?: { id: number; at: number; point: { x: number; y: number } }[];
  /** Everything its replica held of the room (Collab.held), merged in case an edit hadn't reached it. */
  room?: { epoch: string; update: string } | null;
}
const CARRY = `erga:carry:${location.pathname}`;
const carried = (): Carry | null => {
  try {
    const c = JSON.parse(sessionStorage.getItem(CARRY) ?? "null") as Carry | null;
    sessionStorage.removeItem(CARRY);
    return c && c.path == mode?.path ? c : null;
  } catch { return null; }
};
// The page loaded again with the focus (its editor kept that: Carry.focus): the keys typed before its editor is up
// (it joins the room first) are held here, and the editor applies them first, in order.
const early: HeldInput[] = [];
let holding: (() => void) | null = null;
try {
  if ((JSON.parse(sessionStorage.getItem(CARRY) ?? "null") as Carry | null)?.focus) {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.key == "Escape") return;
      e.preventDefault();
      early.push({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    };
    addEventListener("keydown", key, true);
    holding = () => removeEventListener("keydown", key, true);
  }
} catch {
  /* no storage */
}

const carry = (c: Carry) => {
  try {
    sessionStorage.setItem(CARRY, JSON.stringify(c));
  } catch {
    /* private mode: the page starts afresh */
  }
};

/** Someone else's author entry as the marks show it. */
const markAuthor = (a: Author | null): MarkAuthor | null =>
  a ? { name: a.kind == "disk" ? "Edited on disk" : a.name, color: a.color } : null;

/** Into the editor: the page's own socket and replica, then the editor on the page, from the room's text. */
async function start() {
  performance.mark("erga:init");
  const m = mode!;
  // Once the page has loaded (its scripts have built what they build on load).
  if (document.readyState != "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  if (mode != m || collab) return;
  const room = m.room.replace(/^http/, "ws");
  const c = (collab = new Collab({
    // (Only the room: the person's events, the agent's asks among them, are the viewer's to hear.)
    url: (q) => `${room}?${new URLSearchParams({ key: mode?.key ?? m.key, ...Object.fromEntries(q) })}`,
    onEvent: () => {},
    onRemote: (changes, author) => {
      if (!page) return;
      page.applyExternal(changes, markAuthor(author));
      if (page.stale) post({ type: "stale" });
      queuePeers();
    },
    onFiles: () => {},
    onPresence: () => queuePeers(),
    onStatus: () => {},
    onStale: () => location.reload(),
  }));
  c.join(m.me, m.path, { tab: m.tab });
  let text: string;
  try {
    text = await c.ready();
  } catch {
    if (collab == c) {
      c.close();
      collab = null;
    }
    return;
  }
  if (collab != c) return;
  const back = carried();
  if (back?.room) c.merge(back.room);
  text = c.current();
  // The state this page's editor had (with its undo history), brought to the room's text: before the page loaded again,
  // or before the editor stopped (out of the editor and back). Else the room's text, afresh.
  let state = EditorState.create({ doc: text, extensions: docExtensions }),
    view = back?.view ?? null;
  const from = back
    ? (() => {
        try {
          return stateFrom(back.state);
        } catch {
          return null;
        }
      })()
    : kept;
  kept = null;
  if (from) {
    const was = from.doc.toString();
    for (const d of back?.drops ?? [])
      if (
        Number.isInteger(d?.id) &&
        Number.isInteger(d.at) &&
        d.at <= was.length &&
        Number.isFinite(d.point?.x) &&
        Number.isFinite(d.point?.y)
      )
        drops.set(d.id, { at: d.at, point: { x: d.point.x, y: d.point.y } });
    dropSeq = Math.max(dropSeq, ...drops.keys());
    state = from;
    if (was != text) {
      const tr = from.update({ changes: changesBetween(was, text), annotations: Transaction.addToHistory.of(false) });
      if (view) view = { pos: tr.changes.mapPos(view.pos, 1), top: view.top };
      for (const d of drops.values()) d.at = tr.changes.mapPos(d.at, 1);
      state = tr.state;
    }
  }
  let focus = !!back?.focus;
  holding?.();
  holding = null;
  page = new PageEditor({
    win: window,
    source: shown,
    state,
    base: HERE,
    held: [...(back?.held ?? []), ...early.splice(0)],
    paused: m.paused,
    check: m.check,
    onReload: reload,
    onUpdate(u) {
      if (u.changes && !u.remote) collab?.push(u.changes);
      if (u.changes) for (const d of drops.values()) d.at = u.changes.mapPos(d.at, 1);
      if (u.docChanged || u.selectionSet) {
        queueCursor();
        post({ type: "selection", anchor: page!.state.selection.main.anchor, head: page!.state.selection.main.head });
      }
      // A presentation's pictures of its steps are out of date once its text changes.
      if (u.docChanged) { window.__ergaReader?.changed?.(); queueBackdrop(); }
      // (The editor takes the page as it's made: once it's this frame's.)
      if (u.rendered) queueMicrotask(() => {
        if (!page) return;
        unwatch.push(drawCaret(window as Window & typeof globalThis, () => zoom));
        watchPage();
        watchBackdrop();
        syncBackdrop(true);
        queuePeers();
        performance.mark("erga:rendered");
        // Made afresh: the line the reader was on, where it was (the viewer's script had it near there: ?erga-y).
        if (view) { window.__ergaReader?.placed?.(); page.restoreView(view); view = null; }
        // A live page that reacts to input (it defines ergaPause) opens with its keys its own, as after Escape: a click on
        // text starts editing. Not when it loads again, nor paused: the caret stays where it was.
        if (!back && !page.isPaused && page.canPause) page.leaveText();
        // The page had the focus as it loaded again: it has it again, for the keys held meanwhile.
        if (focus) {
          focus = false;
          page.focus();
          page.hold(false);
        }
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
      // (Its state is on its way to the page that comes: what's dropped now would have nowhere to go in.)
      if (reloading) return page?.dropError(point, LOADING_AGAIN);
      const id = ++dropSeq;
      drops.set(id, { at, point });
      post({ type: "upload", id, files: files.slice(0, 50) });
    },
  });
  window.ergaFrame = {
    page,
    collab: c,
    get zoom() {
      return zoom;
    },
    get reloading() {
      return reloading;
    },
  };
}

// Leaving the page (the tab reloads for a new release, or closes): what the editor holds goes with the tab, for the
// page that comes in its place.
addEventListener("pagehide", () => {
  if (!page || !collab || reloading || !mode) return;
  carry({ path: mode.path, state: stateJSON(page.state, historyField), view: scrollY > 0 ? page.topText() : null, room: collab.held() });
});

/**
 * The page made afresh from the text (a change the editor can't patch in, or a page made from another text): once the
 * room has this editor's edits, its state (undo history and all) is kept in this tab for the editor in the page that
 * loads in its place, scrolled where it was. The page's scripts run again: on purpose.
 */
let reloading = false;
function reload(view: { pos: number; top: number } | null) {
  if (reloading || !mode) return;
  reloading = true;
  const path = mode.path;
  // (After the change in hand: the render it asked for comes in the middle of it, before its selection and its push.)
  setTimeout(async () => {
    // It loads again once the room has its edits (else it would come made from the text before them, and load again).
    await Promise.race([collab?.flushed(), sleep(3000)]);
    const held = page?.takeHeld() ?? [];
    if (page)
      carry({
        path,
        state: stateJSON(page.state, historyField),
        view,
        held,
        focus: document.hasFocus(),
        drops: [...drops].map(([id, d]) => ({ id, ...d })),
      });
    const y = Math.round(scrollY);
    // With the page's place in its own address (#3: agents/document/PROMPT.md, rule 14). (A reload: going to the same
    // address with a hash only goes to the place.)
    window.history.replaceState(null, "", location.pathname + "?erga-edit" + (y > 0 ? `&erga-y=${y}` : "") + location.hash);
    location.reload();
  });
}

/** Out of the editor: the editor stops (its state kept for the way back in), and leaves the room; the page stays as it is. */
function stop() {
  if (page) {
    kept = page.state;
    // What the page shows now: this text, if the editor has shown all of it.
    shown = page.upToDate ? sourceDigest(page.state.doc.toString()) : "";
    page.stop();
  }
  for (const f of unwatch.splice(0)) f();
  backdropObserver?.disconnect();
  page = null;
  collab?.close();
  collab = null;
  window.ergaFrame = undefined;
}

// This tab's caret, for everyone else, at most once a frame. It stays where you left it when you switch away, as a
// caret on paper would (but with another of your tabs in use since, that one's caret is shown instead).
let cursorQueued = false;
function queueCursor() {
  if (cursorQueued) return;
  cursorQueued = true;
  requestAnimationFrame(() => {
    cursorQueued = false;
    if (!page || !collab) return;
    const sel = page.state.selection.main;
    collab.setCursor(sel.anchor, sel.head);
  });
}

// Everyone else's caret on the page, with their name; an agent's, dashed, while it works. A person with several tabs
// open is shown by the one they used last, and your own other tabs not at all (Collab.shown).
let peersQueued = false;
function queuePeers() {
  if (peersQueued) return;
  peersQueued = true;
  requestAnimationFrame(() => {
    peersQueued = false;
    if (!page || !collab) return;
    const peers: Peer[] = [];
    for (const p of collab.shown()) {
      // An agent's caret shows while it works, so its edits read like a person's typing; once it's idle, a caret left
      // where it last edited would only linger and distract.
      const agent = p.user.kind == "agent";
      if (agent && !p.busy) continue;
      const at = collab.positions(p);
      if (!at) continue;
      peers.push({
        key: p.client,
        name: p.user.name,
        color: p.user.color,
        anchor: at.anchor,
        head: at.head,
        agent,
        activity: agent ? (p.activity ?? null) : null,
      });
    }
    page.setPeers(peers);
  });
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


/** Tells the shell what happens in the page that its controls follow: pointers, keys, focus, the selection moving. */
function watchPage() {
  const d = document, win = window as Window & typeof globalThis;
  const on = (target: Document | Window, type: string, f: (e: Event) => void, opts?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, f, opts);
    unwatch.push(() => target.removeEventListener(type, f, opts));
  };
  unwatch.push(
    listenAsEditor(
      d,
      "pointerdown",
      (e) => {
        const p = e as PointerEvent;
        collab?.activate();
        post({ type: "pointer", kind: "down", x: z(p.clientX), y: z(p.clientY) });
      },
      true
    )
  );
  unwatch.push(
    listenAsEditor(
      d,
      "mouseup",
      (e) => {
        const p = e as MouseEvent;
        post({ type: "pointer", kind: "up", x: z(p.clientX), y: z(p.clientY) });
      },
      true
    )
  );
  unwatch.push(catchZoomGestures(win, (by) => post({ type: "zoom", zoom: by })));
  // (Focusing or using this tab's page makes it the one its person is shown by: Collab.activate.)
  on(
    d,
    "keydown",
    () => {
      collab?.activate();
      post({ type: "activity", kind: "key" });
    },
    true
  );
  on(
    win,
    "focus",
    () => {
      collab?.activate();
      post({ type: "activity", kind: "focus" });
    },
    true
  );
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
