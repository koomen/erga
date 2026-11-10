// The page editor, in the document's own page: the viewer's page holds the page in its frame, on the document's own
// origin (<id>-<owner>.erga-pages.dev), and the page's first script (client/inline/reader.ts) loads this one into it
// when the viewer says "edit" (its one word, erga-mode: mode.ts). From then on the editor is the page's own: it opens
// the document's socket itself, from this origin, with the edit key (server/documents/edit-key.ts), holds its own
// replica of the room (collab.ts), sends every edit there and applies everyone else's, shows where the others' carets
// are and shows its own to them. It does everything that needs the page's DOM: typing, selections, marks and carets,
// its own controls (controls.ts: the style bar, the link bar), the comments (comments.ts), files dropped on the page
// (uploads.ts), on the page as it is, which the pages origin served from the text (shared/page-html.ts). It sends the
// viewer nothing. When the viewer says "view", it stops, and the page carries on as it is.
//
// Trap: in the frame, a `setTimeout` can wait for seconds in a tab that isn't in front. Code that must run soon after
// an edit here (the replica kept in IndexedDB, the page in the copy) runs at once, and joins what comes meanwhile.

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { history, historyField } from "@codemirror/commands";
import { PageEditor, type HeldInput, type TypingAgent } from "./editor";
import { LOADING_AGAIN } from "./drop";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { clampZoom } from "../../../client/common/zoom";
import { Collab } from "./collab";
import { mountControls, noteOnPage, type Controls } from "./controls";
import { mountComments, type Comments } from "./comments";
import { mountSlash, pickImages, type Slash } from "./slash";
import { watchUnsaved } from "./unsaved";
import { addFiles } from "./uploads";
import { apiCode, runPageEdit, warm } from "./page-edits";
import type { EditMode } from "./mode";
import { step, type Editing, type FrameEvent, type State } from "./frame-state";
import { changesBetween } from "../../../document/merge";
import { baseName, encodePath } from "../../../document/pages";
import { assets, authors, colorFor, files, roomInfo, type Author } from "../../../document/content";
import { sourceDigest } from "../../../shared/page-html";
import { sleep } from "../../../shared/time";
import { isAppShortcut } from "../../../client/common/app-keys";
import { placeOf } from "../../../client/common/link-target";
import { keepOffline } from "../../../client/common/offline";
import { keepPage } from "./offline-page";
import { agentLabel } from "../../../shared/attribution";
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

/** The editor's one state (frame-state.ts): the viewer's last word, edit with its key and where the document is, in it. */
let state: State = { phase: "idle", run: 0 };
/** The viewer's last word, if it is edit. */
const editing = (): Editing | null => ("mode" in state ? state.mode : null);
let collab: Collab | null = null;
let page: PageEditor | null = null;
let controls: Controls | null = null;
let comments: Comments | null = null;
/** The note for edits that are not on the server yet (unsaved.ts). */
let unsaved: ReturnType<typeof watchUnsaved> | null = null;
/** The "/" menu of blocks (slash.ts). */
let slash: Slash | null = null;
/** The shell's word on comments (erga-comments: shown or hidden); the page's first script kept the last one. Shown by default. */
let commentsShown = (window.__ergaReader?.comments as { show?: unknown } | undefined)?.show !== false;
/** The editor's state as it stopped (undo history and all), for the way back in. */
let kept: EditorState | null = null;
/** The page went full screen under the running editor (the viewer's erga-full; the editor stops for it): back in, the text is left. */
let wasFull = false;
/** Files dropped or pasted on the page on their way into the document's files: where they go in (mapped through the edits meanwhile). */
const drops = new Set<{ at: number; point: { x: number; y: number } }>();
/** The paths of the files this editor is putting into the document's files for a drop. */
const sent = new Set<string>();
/** What stops what the editor added to the page besides its own (its caret, its watches). */
let unwatch: (() => void)[] = [];
/** The level the shell draws the page at (zoom.ts): the frame scaled; the controls keep their own size. */
let zoom = 1;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  if (e.data?.type == "erga-mode") setMode(e.data as EditMode);
  else if (e.data?.type == "erga-full") wasFull ||= e.data.on === true && !!page;
  else if (e.data?.type == "erga-comments") {
    commentsShown = e.data.show !== false;
    comments?.show(commentsShown);
  }
});

/** The viewer says edit or view. Edit again: a new key (for the next socket), or another zoom. */
function setMode(m: EditMode) {
  if (m.mode == "edit") {
    if (m.timescale) window.__ergaTimescale = m.timescale;
    if (typeof m.zoom == "number") setZoom(m.zoom);
  }
  send(m.mode == "view" ? { type: "view" } : { type: "edit", mode: m });
}

/** The state takes the event, and this does what the step says (frame-state.ts), in the run the step leaves it in. */
function send(e: FrameEvent) {
  const next = step(state, e);
  state = next.state;
  const run = state.run;
  for (const effect of next.effects)
    if (effect == "start") void start(run);
    else if (effect == "join") join(run);
    else if (effect == "retry") retry(run);
    else if (effect == "edit") enter();
    else if (effect == "flush") flush(run);
    else if (effect == "reload") reloadNow();
    else stop();
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
  /** Everything its replica held of the room (Collab.held), merged in case an edit hadn't reached it. */
  room?: { epoch: string; update: string } | null;
}
const CARRY = `erga:carry:${location.pathname}`;
const carried = (): Carry | null => {
  try {
    const c = JSON.parse(sessionStorage.getItem(CARRY) ?? "null") as Carry | null;
    sessionStorage.removeItem(CARRY);
    return c && c.path == editing()?.path ? c : null;
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
/** Lets go of the keys: the editor takes them, or it stops before it's up (then the page's own keys work again). */
let letGo = () => {};
try {
  if ((JSON.parse(sessionStorage.getItem(CARRY) ?? "null") as Carry | null)?.focus) {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.key == "Escape") return;
      e.preventDefault();
      early.push({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    };
    addEventListener("keydown", key, true);
    letGo = () => {
      removeEventListener("keydown", key, true);
      letGo = () => {};
    };
  }
} catch {
  /* no storage */
}

/** An agent's edit plays as typing, behind its caret; anyone else's shows as it comes. */
const typingAgent = (a: Author | null): TypingAgent | null =>
  a?.kind == "agent" ? { name: a.name, color: a.color, ...(collab ? { label: collab.agentLabel(a, "writing") } : {}) } : null;

/** Whether this origin holds nothing but this document: then the replica and the page are kept in this browser. */
let own = false;

/** Into the editor: once the page has loaded (its scripts have built what they build on load). */
async function start(run: number) {
  performance.mark("erga:init");
  // Erga's worker on this origin, for a reload offline (only an origin of this document's own has it: never a shared host).
  const offline = keepOffline(null);
  if (document.readyState != "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  own = await offline;
  send({ type: "loaded", run });
}

/** The page's own socket and replica, in the room. */
function join(run: number) {
  const m = editing()!;
  if (own) pageCopy ??= keepPage(SHELL, () => collab?.current() ?? "");
  const room = `${m.doc.replace(/^http/, "ws")}/api/room`;
  const c = (collab = new Collab({
    // (Only the room: the person's events, the agent's asks among them, are the viewer's to hear.)
    // (comments=1: it hears that the document's comments changed, and reads them again: comments.ts.)
    url: (q) => `${room}?${new URLSearchParams({ key: editing()?.key ?? m.key, comments: "1", ...Object.fromEntries(q) })}`,
    onEvent: (msg) => {
      if (msg.type == "comments") void comments?.refresh();
    },
    onRemote: (changes, author) => {
      if (!page) return;
      page.applyExternal(changes, typingAgent(author));
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
    ...(own ? { keep: m.doc } : {}),
  }));
  c.join(m.me, m.path, { tab: m.tab });
  void ready(c, run);
}

/** The first sync with the room. It keeps trying while the room doesn't answer (the socket connects again by itself). */
async function ready(c: Collab, run: number) {
  try {
    await c.ready();
    send({ type: "joined", run });
  } catch {
    send({ type: "failed", run });
  }
}

/** What says the room didn't answer yet, while the editor waits for it again. */
let roomNote: (() => void) | null = null;
function retry(run: number) {
  roomNote ??= noteOnPage(window, "The document's server didn't answer. Erga keeps trying: the editor opens once it does.");
  // (A second after: a page that isn't in the room yet fails at once.)
  const c = collab;
  setTimeout(() => {
    if (c && collab == c) void ready(c, run);
  }, 1000);
}

/** The editor on the page, from the room's text and what it carried over a reload. */
function enter() {
  roomNote?.();
  roomNote = null;
  const c = collab!;
  const back = carried();
  if (back?.room) c.merge(back.room);
  edit(c, editing()!, back);
  // The lock for source edits (document/room.ts): while someone holds it, the page is read-only, and says so; their
  // edits show as they land, and the page edits again once it's let go (no reload).
  const follow = () => {
    if (collab != c) return;
    const by = (roomInfo(c.doc).get("lock") as string | undefined) ?? null;
    // (A commenter's page is read-only always: mode.ts, `comment`.)
    const commenting = !!editing()?.comment;
    page?.setReadOnly(!!by || commenting);
    lockNote?.();
    lockNote =
      by && !commenting
        ? noteOnPage(window, `${by} is editing this page's source: you can read it, and edit it again once they're done.`)
        : null;
  };
  roomInfo(c.doc).observe(follow);
  follow();
}

/** This page in the browser's copy, made from the replica's text after each change (offline-page.ts), on an origin of its own. */
let pageCopy: ReturnType<typeof keepPage> | null = null;

/** What says the page is read-only while someone edits its source (the lock), and takes it off. */
let lockNote: (() => void) | null = null;

/** The editor on the page, from the room's text (`c`'s replica) and what it kept of itself, if it did. */
function edit(c: Collab, m: Editing, back: Carry | null) {
  let text = c.current();
  // (A commenter makes no edits.)
  if (!m.comment) unsaved = watchUnsaved(window, { flushed: () => (collab == c ? c.flushed() : Promise.resolve(false)), key: m.path });
  // The state this page's editor had (with its undo history), brought to the room's text: before the page loaded again,
  // or before the editor stopped (out of the editor and back). Else the room's text, afresh.
  let begin = EditorState.create({ doc: text, extensions: docExtensions }),
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
    begin = from;
    if (was != text) {
      const tr = from.update({ changes: changesBetween(was, text), annotations: Transaction.addToHistory.of(false) });
      if (view) view = { pos: tr.changes.mapPos(view.pos, 1), top: view.top };
      begin = tr.state;
    }
  }
  let focus = !!back?.focus;
  void pageCopy?.changed();
  letGo();
  page = new PageEditor({
    win: window,
    source: shown,
    state: begin,
    base: HERE,
    held: [...(back?.held ?? []), ...early.splice(0)],
    check: m.check,
    onReload: reload,
    onUpdate(u) {
      if (u.changes && !u.remote) {
        collab?.push(u.changes);
        unsaved?.edit();
      }
      if (u.changes) for (const d of drops) d.at = u.changes.mapPos(d.at, 1);
      if (u.docChanged || u.selectionSet) queueCursor();
      // A presentation's pictures of its steps are out of date once its text changes (libs/steps).
      if (u.docChanged) {
        void pageCopy?.changed();
        dispatchEvent(new Event("ergaedit"));
        queueDark();
      }
      // (The editor takes the page as it's made: once it's this frame's.)
      if (u.rendered)
        queueMicrotask(() => {
          if (!page) return;
          // A commenter has the comments alone: no caret, no style bar, and a "Comment" button at the selection.
          if (!m.comment) {
            unwatch.push(drawCaret(window as Window & typeof globalThis, () => zoom));
            const made = mountControls(window, page, {
              place: () => placeOf(window, reader),
              zoom: () => zoom,
              comment: () => comments?.compose(),
            });
            controls = made;
            unwatch.push(() => {
              made.remove();
              if (controls == made) controls = null;
            });
            const menu = mountSlash(window, { zoom: () => zoom, choose: slashChosen });
            slash = menu;
            unwatch.push(() => {
              menu.remove();
              if (slash == menu) slash = null;
            });
          }
          const drawn = mountComments(window, m.comment ? commenterPage(page) : page, {
            text: () => (collab ? (files(collab.doc).get(m.path) ?? null) : null),
            person,
            me: m.me.user,
            call: commentOp,
            explain: (message) => (controls ? controls.explain(message) : sayOnPage(message)),
            zoom: () => zoom,
            shown: commentsShown,
            button: !!m.comment,
          });
          comments = drawn;
          unwatch.push(() => {
            drawn.remove();
            if (comments == drawn) comments = null;
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
          // The page takes the focus it has (the viewer gives the frame the focus as it goes into the editor), with the
          // caret in its text: it had the focus as it loaded again, or has it now, for the keys held meanwhile.
          // (Not after full screen: the text is left, as after Escape, until a click on it.)
          if (wasFull) page.leaveText();
          else if (!m.comment && (focus || document.hasFocus())) page.focus();
          wasFull = false;
          // (The viewer stops its own reloads of the page: this shows each change in place. client/inline/viewer-live.ts.)
          if (m.comment) window.parent.postMessage({ type: "erga-commenting" }, SHELL);
          // (The keys held meanwhile go in now, whether or not it has the focus yet.)
          page.hold(false);
          focus = false;
        });
      controls?.queue();
      comments?.queue();
      if (u.docChanged || u.selectionSet) slash?.update(page?.slashText() ?? null);
    },
    onKey: (e) => {
      // The "/" menu's keys, while it is open.
      if (slash?.key(e)) return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // The link bar (⌘⇧K); Escape: the focus off the text, still in the page (its own keys work: a deck's arrows).
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() == "k") {
        controls?.openLink();
        return true;
      }
      // A comment on the selection (⌘⌥M; the Option key changes e.key: the key's code).
      if (mod && e.altKey && !e.shiftKey && (e.code == "KeyM" || e.key.toLowerCase() == "m")) {
        comments?.compose();
        return true;
      }
      if (e.key == "Escape" && !mod) {
        // (The link bar for the caret's link closes first: the caret stays in the link. Then an open comment.)
        if (controls?.linking) controls.closeLink();
        else if (!comments?.cancel()) page?.leaveText();
        return true;
      }
      // The viewer's own shortcuts: the page's first script passes them on (client/common/app-keys.ts).
      return isAppShortcut(e, isMac);
    },
    // A notice the agent can fix (a paragraph whose HTML is broken) goes to the viewer, which offers the fix: through the
    // page's problem watch (client/inline/page-problems.ts), Erga's own. Any other says why, here.
    onNotice: (message, fix, draft) => {
      if (m.comment) return;
      if (fix)
        (window as Window & { __ergaReport?: (p: unknown) => void }).__ergaReport?.({
          kind: "notice",
          message,
          fix,
          ...(draft ? { draft } : {}),
        });
      else controls?.explain(message);
    },
    // In the page: its change shows at once (page-edits.ts).
    pageEdit(html, edit, input) {
      const m = editing();
      const code = m && collab && apiCode(m.path, html, (p) => files(collab!.doc).get(p)?.toString());
      if (code == null)
        return Promise.resolve({
          error: 'the page names no API module of its own (<meta name="erga-api" content="api.js">) that the document has',
        });
      return runPageEdit(code, html, edit, input);
    },
    onDropFiles: dropFiles,
  });
  // The page's own API, imported before the person's first edit asks for it.
  warm(apiCode(m.path, text, (p) => files(c.doc).get(p)?.toString()));
  window.ergaFrame = {
    page,
    get zoom() {
      return zoom;
    },
    get reloading() {
      return state.phase == "reloading";
    },
  };
}

/** Files dropped or picked for the page: into the document's files, then onto the page at `at` (`point`: where an error shows). */
function dropFiles(list: File[], at: number, point: { x: number; y: number }) {
  // (Its state is on its way to the page that comes: what's dropped now would have nowhere to go in.)
  const m = editing();
  if (state.phase != "editing" || !m || !collab) return page?.dropError(point, LOADING_AGAIN);
  const d = { at, point };
  drops.add(d);
  const taken = new Set([...files(collab.doc).keys(), ...assets(collab.doc).keys()].map((p) => p.toLowerCase()));
  void addFiles(m.doc, m.key, list.slice(0, 50), taken, (p) => sent.add(p)).then(({ paths, error }) => {
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
}

/** The "/" menu's choice: the editor makes the block; for an image, the person picks files, which go in as dropped ones do. */
function slashChosen(kind: Parameters<PageEditor["slashBlock"]>[0]) {
  const at = page?.slashBlock(kind);
  if (kind != "image" || at == null || at === false) return;
  const r = document.getSelection()?.rangeCount ? document.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
  void pickImages(document).then((list) => {
    if (list.length) dropFiles(list, at, { x: r?.left ?? 0, y: r?.bottom ?? 0 });
  });
}

/** The page as a commenter's comments see it: the browser's own selection (the page has no caret), and no focus to give back. */
const commenterPage = (p: PageEditor) => ({
  selectionNow() {
    const s = p.readSelection()?.main;
    return s ? { from: s.from, to: s.to } : { from: 0, to: 0 };
  },
  textRanges: (from: number, to: number) => p.textRanges(from, to),
  focus() {},
});

/** A note on the page for a few seconds: where there are no controls to say it (a commenter's page). */
function sayOnPage(message: string) {
  setTimeout(noteOnPage(window, message), 5000);
}

/** Who a login is, for a comment: their name as the room knows it (each editor introduces themself), and their colour. */
function person(login: string) {
  const known = collab && [...authors(collab.doc).values()].find((a) => a.user == login && a.kind != "agent");
  return { name: known?.name ?? login, color: colorFor(login) };
}

/**
 * The comment ops, from the page (comments.ts): POST /api/tools/<op> on the viewer's origin with the edit key, which
 * names the person (server/api.ts, keyedComment). On this page, of this document.
 */
async function commentOp(op: "comment" | "comments", args: Record<string, unknown>) {
  const m = editing();
  if (!m) throw new Error("The editor stopped.");
  const url = new URL(m.doc),
    id = url.pathname.split("/").pop()!;
  const r = await fetch(`${url.origin}/api/tools/${op}?${new URLSearchParams({ doc: id, key: m.key })}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...args, document: id, page: m.path }),
  }).catch(() => null);
  const answer = (await r?.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null;
  if (!answer?.ok) throw new Error(answer?.error ?? "The server didn't answer. Check the connection, and try again.");
  return answer.result as Awaited<ReturnType<Parameters<typeof mountComments>[2]["call"]>>;
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
    const c = collab;
    const busy = c
      .others()
      .filter((p) => p.user.kind == "agent" && p.busy)
      .map((p) => agentLabel(p.user, null, false).label);
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
  // Loading again: the keys typed since it handed its state over (the new page can take long to come) go with it too.
  if (state.phase == "reloading" && leaving && page) {
    leaving.held = [...(leaving.held ?? []), ...page.takeHeld()];
    carry(leaving);
    return;
  }
  if (!page || !collab || state.phase != "editing") return;
  carry({
    path: state.mode.path,
    state: stateJSON(page.state),
    view: scrollY > 0 ? page.topText() : null,
    room: collab.held(),
  });
});

/**
 * The page made afresh from the text (a change the editor can't patch in, or a page made from another text): once the
 * room has this editor's edits, its state (undo history and all) is kept in this tab for the editor in the page that
 * loads in its place, scrolled where it was. The page's scripts run again: on purpose.
 */
/** Where the reader was in the text, for the page that loads in its place. */
let reloadView: { pos: number; top: number } | null = null;
/** What this page handed over as it loads again, until it goes. */
let leaving: Carry | null = null;
function reload(view: { pos: number; top: number } | null) {
  if (state.phase != "editing") return;
  reloadView = view;
  send({ type: "reload" });
}

function flush(run: number) {
  // (After the change in hand: the render it asked for comes in the middle of it, before its selection and its push.)
  setTimeout(async () => {
    // It loads again once the room has its edits (else it would come made from the text before them, and load again).
    await Promise.race([collab?.flushed(), sleep(3000)]);
    // (Offline, the page comes from the browser's copy: made from this text.)
    await pageCopy?.now();
    // (Out of the editor meanwhile: the page stays as it is.)
    send({ type: "flushed", run });
  });
}

function reloadNow() {
  const path = editing()!.path;
  if (page) carry((leaving = { path, state: stateJSON(page.state), view: reloadView, held: page.takeHeld(), focus: document.hasFocus() }));
  const y = Math.round(scrollY);
  // With the page's place in its own address (#3: agents/document/PROMPT.md, rule 11). (A reload: going to the same
  // address with a hash only goes to the place.)
  window.history.replaceState(null, "", location.pathname + "?erga-edit" + (y > 0 ? `&erga-y=${y}` : "") + location.hash);
  location.reload();
}

/**
 * Out of the editor: the editor stops (its state kept for the way back in), and leaves the room; the page stays as it
 * is. Keys held for an editor that never came up go back to the page.
 */
function stop() {
  stopEditor();
  letGo();
  early.length = 0;
  lockNote?.();
  lockNote = null;
  roomNote?.();
  roomNote = null;
  collab?.close();
  collab = null;
}

/** The editor stops, its state kept for the way back in; the page stays as it is. */
function stopEditor() {
  if (page) {
    kept = page.state;
    // What the page shows now: this text, if the editor has shown all of it.
    shown = page.upToDate ? sourceDigest(page.state.doc.toString()) : "";
    page.stop();
  }
  for (const f of unwatch.splice(0)) f();
  unsaved?.stop();
  unsaved = null;
  darkObserver?.disconnect();
  page = null;
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
    if (!page || !collab || editing()?.comment) return;
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
    if (page && collab) page.setPeers(collab.peers());
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
      (e) => {
        collab?.activate();
        // A press on the editor's own controls (their shadow root's host) is not one on the page: it keeps the bar.
        if (!/^erga-(controls|comments)$/.test((e.target as Element | null)?.localName ?? "")) controls?.pressed();
      },
      true
    )
  );
  unwatch.push(listenAsEditor(d, "mouseup", () => (controls?.released(), comments?.queue()), true));
  // (Focusing or using this tab's page makes it the one its person is shown by: Collab.activate.)
  on(d, "keydown", () => collab?.activate(), true);
  on(win, "focus", () => collab?.activate(), true);
  on(d, "scroll", () => (controls?.queue(), comments?.queue()), { passive: true });
  // The style bar follows selected text that moves another way: a scroll in an element, a pan of the page's own (moves.ts).
  watchMoves(d, win, () => {
    if (page && d.getSelection()?.isCollapsed === false) controls?.queue();
  });
  on(d, "selectionchange", () => (controls?.queue(), comments?.queue()));
  on(win, "resize", () => (controls?.queue(), comments?.queue()));
}

// The page's background, for the controls' look (dark on a dark page): its root's, or its body's when the root has
// none, as the browser would. Read after every change applied to the page, after a render, when a stylesheet loads,
// and when the page's own script switches themes (a class or style on <html> or <body>), at most once a task.
let darkObserver: MutationObserver | null = null,
  darkQueued = false;
function syncDark() {
  if (!page) return;
  const transparent = (cs: CSSStyleDeclaration) =>
    cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
  let cs = getComputedStyle(document.documentElement);
  if (transparent(cs) && document.body) cs = getComputedStyle(document.body);
  const rgb = cs.backgroundColor.match(/[\d.]+/g)?.map(Number);
  const clear = !rgb || rgb.length < 3 || rgb[3] === 0;
  const dark = !clear && (0.2126 * rgb![0] + 0.7152 * rgb![1] + 0.0722 * rgb![2]) / 255 < 0.45;
  controls?.dark(dark);
  slash?.dark(dark);
  comments?.dark(dark);
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
