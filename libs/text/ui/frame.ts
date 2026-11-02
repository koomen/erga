// The page editor, in the document's own page: the viewer's page holds the page in its frame, on the document's own
// origin (<id>-<owner>.erga-pages.dev), and the page's first script (client/inline/reader.ts) loads this one into it
// when the viewer says "edit" (its one word, erga-mode: mode.ts). From then on the editor is the page's own: it opens
// the document's socket itself, from this origin, with the edit key (server/documents/edit-key.ts), holds its own
// replica of the room (collab.ts), sends every edit there and applies everyone else's, shows where the others' carets
// are and shows its own to them. It does everything that needs the page's DOM: typing, selections, marks and carets,
// its own controls (controls.ts: the style bar, the link bar, pause), files dropped on the page (uploads.ts), on the
// page as it is, which the pages origin served from the text (shared/page-html.ts). It sends the viewer nothing. When
// the viewer says "view", it stops, and the page carries on as it is.

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { history, historyField } from "@codemirror/commands";
import { PageEditor, type HeldInput, type MarkAuthor, type Peer } from "./editor";
import { LOADING_AGAIN } from "./drop";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { clampZoom } from "../../../client/common/zoom";
import { Collab } from "./collab";
import { mountControls, type Controls } from "./controls";
import { addFiles } from "./uploads";
import type { EditMode } from "./mode";
import { changesBetween } from "../../../document/merge";
import { baseName, encodePath } from "../../../document/pages";
import { assets, files, type Author } from "../../../document/content";
import { sourceDigest } from "../../../shared/page-html";
import { sleep } from "../../../shared/time";
import { isAppShortcut } from "../../../client/common/app-keys";
import { placeOf } from "../../../client/common/link-target";
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
// (Only in a document's page on Erga: its first script is there, and says where the viewer is.)
if (!window.__ergaReader) throw new Error("erga/text runs in a document's page on Erga");
const reader = window.__ergaReader.config;
/** The shell's origin (erga.dev): the only one this frame takes its word from. */
const SHELL = reader.shell;
/** The document's files, under this origin (the token in the address opens them). */
const BASE = reader.prefix;
/** This page's own folder there: where its relative links and assets resolve. */
const HERE = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
/** The digest of the text the page shows now: the one the pages origin made it from, then (out of the editor) the last the editor showed. */
let shown = reader.src;

/** The viewer's last word, edit (with the key, and where the document is), or null for view. */
let mode: Editing | null = null;
let collab: Collab | null = null;
let page: PageEditor | null = null;
let controls: Controls | null = null;
/** The editor's state as it stopped (undo history and all), for the way back in. */
let kept: EditorState | null = null;
/** Files dropped or pasted on the page on their way into the document's files: where they go in (mapped through the edits meanwhile). */
const drops = new Set<{ at: number; point: { x: number; y: number } }>();
/** The paths of the files this editor is putting into the document's files for a drop. */
const sent = new Set<string>();
/** What stops what the editor added to the page besides its own (its caret, its watches). */
let unwatch: (() => void)[] = [];
/** The level the shell draws the page at (zoom.ts): the frame scaled; the controls keep their own size. */
let zoom = 1;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL || e.data?.type != "erga-mode") return;
  setMode(e.data as EditMode);
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

function setZoom(level: number) {
  const next = clampZoom(level);
  if (next == zoom) return;
  // The same place in the page stays at the top, as near as the page's new layout allows, once it has it.
  const el = document.documentElement, at = el.scrollHeight > 0 ? scrollY / el.scrollHeight : 0;
  zoom = next;
  if (at) addEventListener("resize", () => scrollTo(scrollX, at * el.scrollHeight), { once: true });
  controls?.queue();
}

// The word that loaded this script (the page's first script kept it).
const first = window.__ergaReader?.mode as EditMode | undefined;
if (first?.type == "erga-mode") queueMicrotask(() => setMode(first));

const stateFrom = (json: unknown) => EditorState.fromJSON(json, { extensions: docExtensions }, { history: historyField });
/** A state as it's kept: text, selection and undo history. */
const stateJSON = (state: EditorState) => state.toJSON({ history: historyField });

/** What the editor keeps of itself in this tab, for the page that loads in its place (a reload: its own, or the viewer's). */
interface Carry {
  path: string;
  state: unknown;
  view: { pos: number; top: number } | null;
  held?: HeldInput[];
  focus?: boolean;
  paused?: boolean;
  /** Everything its replica held of the room (Collab.held), merged in case an edit hadn't reached it. */
  room?: { epoch: string; update: string } | null;
}
const CARRY = `erga:carry:${location.pathname}`;
const carried = (): Carry | null => {
  try {
    const c = JSON.parse(sessionStorage.getItem(CARRY) ?? "null") as Carry | null;
    sessionStorage.removeItem(CARRY);
    return c && c.path == mode?.path ? c : null;
  } catch {
    return null;
  }
};
const carry = (c: Carry) => {
  try {
    sessionStorage.setItem(CARRY, JSON.stringify(c));
  } catch {
    /* private mode: the page starts afresh */
  }
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
  const room = `${m.doc.replace(/^http/, "ws")}/api/room`;
  const c = (collab = new Collab({
    // (Only the room: the person's events, the agent's asks among them, are the viewer's to hear.)
    url: (q) => `${room}?${new URLSearchParams({ key: mode?.key ?? m.key, ...Object.fromEntries(q) })}`,
    onEvent: () => {},
    onRemote: (changes, author) => {
      if (!page) return;
      page.applyExternal(changes, markAuthor(author));
      if (page.stale) refreshSoon();
      queuePeers();
    },
    // Another file of the folder (a stylesheet, a script, an image) changed: the page is made again from its files.
    // Not another page's text, which this page doesn't show, nor a file this editor puts in for a drop (`sent`): the
    // page doesn't use it until the editor puts it on the page.
    onFiles: (paths) => {
      if (paths.filter((p) => !/\.(html?|md)$/i.test(p) && !sent.delete(p)).length) refreshSoon();
    },
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
    state = from;
    if (was != text) {
      const tr = from.update({ changes: changesBetween(was, text), annotations: Transaction.addToHistory.of(false) });
      if (view) view = { pos: tr.changes.mapPos(view.pos, 1), top: view.top };
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
    paused: back?.paused,
    check: m.check,
    onReload: reload,
    onUpdate(u) {
      if (u.changes && !u.remote) collab?.push(u.changes);
      if (u.changes) for (const d of drops) d.at = u.changes.mapPos(d.at, 1);
      if (u.docChanged || u.selectionSet) queueCursor();
      // A presentation's pictures of its steps are out of date once its text changes.
      if (u.docChanged) {
        window.__ergaReader?.changed?.();
        queueDark();
      }
      // (The editor takes the page as it's made: once it's this frame's.)
      if (u.rendered)
        queueMicrotask(() => {
          if (!page) return;
          unwatch.push(drawCaret(window as Window & typeof globalThis, () => zoom));
          const made = mountControls(window, page, { place: () => placeOf(window, reader), zoom: () => zoom });
          controls = made;
          unwatch.push(() => {
            made.remove();
            if (controls == made) controls = null;
          });
          watchPage();
          watchDark();
          queuePeers();
          performance.mark("erga:rendered");
          // Made afresh: the line the reader was on, where it was (the viewer's script had it near there: ?erga-y).
          if (view) {
            window.__ergaReader?.placed?.();
            page.restoreView(view);
            view = null;
          }
          // A live page that reacts to input (it defines ergaPause) opens with its keys its own, as after Escape: a click
          // on text starts editing. Not when it loads again, nor paused: the caret stays where it was. Any other takes
          // the focus it has (the viewer gives the frame the focus as it goes into the editor), with the caret in its text.
          if (!back && !page.isPaused && page.canPause) page.leaveText();
          // The page had the focus as it loaded again, or has it now: its text has it, for the keys held meanwhile.
          else if (focus || document.hasFocus()) {
            page.focus();
            page.hold(false);
          }
          focus = false;
        });
      controls?.queue();
    },
    onKey: (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // The link bar (⌘⇧K); Escape: the focus off the text, still in the page (its own keys work: a deck's arrows).
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() == "k") {
        controls?.openLink();
        return true;
      }
      if (e.key == "Escape" && !mod) {
        // (The link bar for the caret's link closes first: the caret stays in the link.)
        if (controls?.linking) controls.closeLink();
        else page?.leaveText();
        return true;
      }
      // The viewer's own shortcuts: the page's first script passes them on (client/common/app-keys.ts).
      return isAppShortcut(e, isMac);
    },
    // A notice the agent can fix (a paragraph whose HTML is broken) goes to the viewer, which offers the fix: through the
    // page's problem watch (client/inline/page-problems.ts), Erga's own. Any other says why, here.
    onNotice: (message, fix) => {
      if (fix) (window as Window & { __ergaReport?: (p: unknown) => void }).__ergaReport?.({ kind: "notice", message, fix });
      else controls?.explain(message);
    },
    onDropFiles(list, at, point) {
      // (Its state is on its way to the page that comes: what's dropped now would have nowhere to go in.)
      if (reloading || !mode || !collab) return page?.dropError(point, LOADING_AGAIN);
      const d = { at, point };
      drops.add(d);
      const taken = new Set([...files(collab.doc).keys(), ...assets(collab.doc).keys()].map((p) => p.toLowerCase()));
      void addFiles(mode.doc, mode.key, list.slice(0, 50), taken, (p) => sent.add(p)).then(({ paths, error }) => {
        drops.delete(d);
        if (!page) return;
        // From this page's folder (a page in blog/ reaches images/ as ../images/).
        const up = "../".repeat(HERE.startsWith(BASE) ? HERE.slice(BASE.length).split("/").filter(Boolean).length : 0);
        const items = paths.map((p) => ({ href: up + encodePath(p), name: baseName(p), image: p.startsWith("images/") }));
        if (items.length && !page.insertFiles(d.at, items))
          page.dropError(
            d.point,
            `The text where it was dropped changed meanwhile. It's in the document's files (${paths.join(", ")}): drop it again.`
          );
        else if (error) page.dropError(d.point, error);
      });
    },
  });
  window.ergaFrame = {
    page,
    collab: c,
    get controls() {
      return controls;
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
 * The page made again from its files, for a change it can't show in place (another file of the folder, a script).
 * While an agent works that waits for the end of its turn, so a half-built script never runs; the pill says so, and
 * offers to show it now (controls.ts).
 */
let refreshing = false;
function refreshSoon() {
  if (refreshing) return;
  refreshing = true;
  const now = () => {
    refreshing = false;
    controls?.waiting(null);
    page?.render();
  };
  const go = () => {
    if (!refreshing) return;
    if (!page || !collab) {
      refreshing = false;
      return;
    }
    const busy = collab
      .others()
      .filter((p) => p.user.kind == "agent" && p.busy)
      .map((p) => p.user.name);
    if (busy.length) {
      controls?.waiting([...new Set(busy)], now);
      setTimeout(go, 300);
      return;
    }
    now();
  };
  go();
}

// Leaving the page (the tab reloads for a new release, or closes): what the editor holds goes with the tab, for the
// page that comes in its place.
addEventListener("pagehide", () => {
  if (!page || !collab || reloading || !mode) return;
  carry({
    path: mode.path,
    state: stateJSON(page.state),
    view: scrollY > 0 ? page.topText() : null,
    paused: page.isPaused,
    room: collab.held(),
  });
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
    if (page) carry({ path, state: stateJSON(page.state), view, held: page.takeHeld(), focus: document.hasFocus(), paused: page.isPaused });
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
  darkObserver?.disconnect();
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

/** Follows what happens in the page that the controls follow: presses, the selection moving, scrolls. */
function watchPage() {
  const d = document,
    win = window as Window & typeof globalThis;
  const on = (target: Document | Window, type: string, f: (e: Event) => void, opts?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, f, opts);
    unwatch.push(() => target.removeEventListener(type, f, opts));
  };
  unwatch.push(
    listenAsEditor(
      d,
      "pointerdown",
      () => {
        collab?.activate();
        controls?.pressed();
      },
      true
    )
  );
  unwatch.push(listenAsEditor(d, "mouseup", () => controls?.released(), true));
  // (Focusing or using this tab's page makes it the one its person is shown by: Collab.activate.)
  on(d, "keydown", () => collab?.activate(), true);
  on(win, "focus", () => collab?.activate(), true);
  on(d, "scroll", () => controls?.queue(), { passive: true });
  // The style bar follows selected text that moves another way: a scroll in an element, a pan of the page's own (moves.ts).
  watchMoves(d, win, () => {
    if (page && d.getSelection()?.isCollapsed === false) controls?.queue();
  });
  on(d, "selectionchange", () => controls?.queue());
  on(win, "resize", () => controls?.queue());
}

// The page's background, for the controls' look (dark on a dark page): its root's, or its body's when the root has
// none, as the browser would. Read after every change applied to the page, after a render, when a stylesheet loads,
// and when the page's own script switches themes (a class or style on <html> or <body>), at most once a task.
let darkObserver: MutationObserver | null = null,
  darkQueued = false;
function syncDark() {
  if (!page || !controls) return;
  const transparent = (cs: CSSStyleDeclaration) =>
    cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
  let cs = getComputedStyle(document.documentElement);
  if (transparent(cs) && document.body) cs = getComputedStyle(document.body);
  const rgb = cs.backgroundColor.match(/[\d.]+/g)?.map(Number);
  const clear = !rgb || rgb.length < 3 || rgb[3] === 0;
  controls.dark(!clear && (0.2126 * rgb![0] + 0.7152 * rgb![1] + 0.0722 * rgb![2]) / 255 < 0.45);
}
function queueDark() {
  if (darkQueued) return;
  darkQueued = true;
  queueMicrotask(() => {
    darkQueued = false;
    syncDark();
  });
}
function watchDark() {
  const d = document as Document & { ergaDark?: boolean };
  darkObserver ??= new MutationObserver(() => queueDark());
  darkObserver.disconnect();
  darkObserver.observe(d.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (d.body) darkObserver.observe(d.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  syncDark();
  if (d.ergaDark) return;
  d.ergaDark = true;
  // (A stylesheet's load event doesn't bubble: heard on its way down.)
  d.addEventListener(
    "load",
    (e) => {
      if ((e.target as Element).localName == "link") queueDark();
    },
    true
  );
}
