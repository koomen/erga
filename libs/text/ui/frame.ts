// The page editor, in the document's own page: the viewer's page holds the page in its frame, on the document's own
// origin (<id>-<owner>.<pages domain>), and the page's first script (client/inline/reader.ts) loads this one into it
// when the viewer says "edit" (its one word, erga-mode: mode.ts). From then on the editor is the page's own: it opens
// the document's socket itself, from this origin, with the edit key (server/documents/edit-key.ts), holds its own
// replica of the room (collab.ts), sends every edit there and applies everyone else's, shows where the others' carets
// are and shows its own to them. It does everything that needs the page's DOM: typing, selections, marks and carets,
// its own controls (controls.ts: the style bar, the link bar), the comments (comments.ts), files dropped on the page
// (uploads.ts: the viewer sends their bytes, and each shows as on its way meanwhile, pending.ts), on the page as it is, which the pages origin served from the text (shared/page-html.ts). It asks the
// viewer for one thing: the page loaded again (erga-reload), for a change it can't show in place; and it tells the
// viewer its alerts (alerts.ts). When the viewer says "standby", it stops, and the page carries on as it is: its
// replica stays in the room, with no presence there, so the next "edit" waits for nothing (the first "standby" brings
// it into the room ahead). When the viewer says "view", it leaves the room too.
//
// Trap: in the frame, a `setTimeout` can wait for seconds in a tab that isn't in front. Code that must run soon after
// an edit here (the replica kept in IndexedDB, the page in the copy) runs at once, and joins what comes meanwhile.

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { history, historyField } from "./history";
import { PageEditor, type HeldInput, type TypingAgent } from "./editor";
import { LOADING_AGAIN, signsDark } from "./drop";
import { pageAlerts } from "./alerts";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { clampZoom, type Shows, type Zoomed } from "../../../client/common/zoom";
import { elementOf } from "../../../client/common/uploads";
import { Collab } from "./collab";
import { mountControls, noteOnPage, type Controls } from "./controls";
import { mountComments, type Comments } from "./comments";
import { mountSlash, pickImages, type Slash } from "./slash";
import { watchUnsaved } from "./unsaved";
import { imageSize, pathFor } from "./uploads";
import { mountPending } from "./pending";
import { apiCode, runPageEdit, warm } from "./page-edits";
import type { EditMode } from "./mode";
import { step, type Editing, type FrameEvent, type State } from "./frame-state";
import { changesBetween } from "../../../document/model/merge";
import { baseName, encodePath } from "../../../document/model/pages";
import { assets, authors, files, roomInfo, stamp } from "../../../document/model/content";
import { colorFor, type Author } from "../../../shared/author";
import type { UploadsMessage } from "../../../shared/room-socket";
import { sourceNear } from "../../../shared/feedback-context";
import { sourceDigest } from "../../../shared/page-html";
import { sleep } from "../../../shared/time";
import { isAppShortcut, isMac } from "../../../client/common/app-keys";
import { placeOf } from "../../../client/common/link-target";
import { keepOffline } from "../../../client/common/offline";
import { keepPage } from "./offline-page";
import { agentLabel } from "../../../shared/attribution";
import { afterPause } from "./pause";
// (window.__ergaReader: the page's first script, which loads this one.)
import type {} from "../../../client/common/reader-api";

declare global {
  interface Window {
    ergaFrame?: unknown;
    __ergaTimescale?: number;
  }
}

/** What the editor's state needs: the lean undo/redo history (history.ts). */
performance.mark("erga:frame-js");
const docExtensions: Extension[] = [history()];

// (Only in a document's page on Erga: its first script is there, and says where the viewer is.)
if (!window.__ergaReader) throw new Error("erga/text runs in a document's page on Erga");
const reader = window.__ergaReader.config;
/** The shell's origin (the app's): the only one this frame takes its word from. */
const SHELL = reader.shell;
const tell = (m: unknown) => window.parent?.postMessage(m, SHELL);
/** The document's files, under this origin (the token in the address opens them). */
const BASE = reader.prefix;
/** This page's own folder there: where its relative links and assets resolve. */
const HERE = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
/** The digest of the text the page shows now: the one the pages origin made it from, then (out of the editor) the last the editor showed. */
let shown = reader.src;

/** The editor's one state (frame-state.ts): the viewer's last word, edit or standby with its key and where the document is, in it. */
let state: State = { phase: "idle", run: 0 };
/** The viewer's last word, if it is edit or standby. */
const editing = (): Editing | null => ("mode" in state ? state.mode : null);
let collab: Collab | null = null;
let page: PageEditor | null = null;
let controls: Controls | null = null;
let comments: Comments | null = null;
/** Tells the viewer's save mark of the edits that are not on the server yet (unsaved.ts). */
let unsaved: ReturnType<typeof watchUnsaved> | null = null;
/** The "/" menu of blocks (slash.ts). */
let slash: Slash | null = null;
/** The shell's word on comments (erga-comments: shown or hidden); the page's first script kept the last one. Shown by default. */
let commentsShown = (window.__ergaReader?.comments as { show?: unknown } | undefined)?.show !== false;
/** The editor's state as it stopped (undo history and all), for the way back in. */
let kept: EditorState | null = null;
/** The page went full screen under the running editor (the viewer's erga-full; the editor stops for it): back in, the text is left. */
let wasFull = false;
/** The editor's alerts, in the viewer's card. */
const alerts = pageAlerts(window, SHELL);
/** Files dropped or pasted on the page on their way into the document's files: where they go in (mapped through the edits meanwhile). */
const drops = new Set<{ at: number }>();
/** The files on their way, on their elements here (the viewer and the room say which). */
const pending = mountPending(window, {
  base: location.origin + BASE,
  act: (path, action) => window.parent?.postMessage({ type: "erga-upload-act", path, action }, SHELL),
});
// (The viewer says which files are on their way, as they change; this editor, new on the page, asks one time.)
window.parent?.postMessage({ type: "erga-uploads-ask" }, SHELL);
/** The paths of the files that were on their way while this page was open: when one comes, its elements load it in place. */
const awaited = new Set<string>();
/** The files this editor put on the page that are still on their way, each with its address there: Undo cancels one. */
const placed = new Map<string, string>();
/** What stops what the editor added to the page besides its own (its caret, its watches). */
let unwatch: (() => void)[] = [];
/** The level the shell draws the page at (zoom.ts): the frame scaled; the controls keep their own size. */
let zoom = 1;
/** The part of the page that shows on the screen (mode.ts): the comments stand in it. */
let shows: Shows = { left: 0, right: Infinity };
/** How much of the window's bottom the viewer's alerts take, in px: the controls' notes sit over them. */
let notes = 0;
function setNotes(px: unknown) {
  notes = typeof px == "number" && px > 0 ? px : 0;
  controls?.lift(notes);
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  if (e.data?.type == "erga-mode") setMode(e.data as EditMode);
  else if (e.data?.type == "erga-zoomed") setZoom(e.data as Zoomed);
  else if (e.data?.type == "erga-leave") leave();
  else if (e.data?.type == "erga-out") {
    signedOut = true;
    collab?.signedOut();
  } else if (e.data?.type == "erga-notes") setNotes(e.data.notes);
  else if (e.data?.type == "erga-full") wasFull ||= e.data.on === true && !!page;
  else if (e.data?.type == "erga-uploads-of" && e.data.files) {
    const files = (e.data as UploadsMessage).files;
    for (const path of Object.keys(files)) awaited.add(path);
    pending.setOthers(files);
  } else if (e.data?.type == "erga-uploads" && Array.isArray(e.data.files)) {
    const files = e.data.files as Parameters<typeof pending.setOwn>[0];
    for (const f of files) awaited.add(f.path);
    for (const path of placed.keys()) if (!files.some((f) => f.path == path)) placed.delete(path);
    pending.setOwn(files);
    for (const path of Array.isArray(e.data.landed) ? (e.data.landed as string[]) : []) pending.arrived(path);
  } else if (e.data?.type == "erga-upload-remove" && typeof e.data.path == "string") {
    const me = editing()?.me;
    const path = e.data.path;
    placed.delete(path);
    if (collab && me) {
      const doc = collab.doc;
      doc.transact(() => {
        for (const [pg, text] of files(doc)) {
          if (!/\.html?$/i.test(pg)) continue;
          const at = elementOf(text.toString(), "../".repeat(pg.split("/").length - 1) + encodePath(path));
          if (!at) continue;
          text.delete(at.from, at.to - at.from);
          stamp(doc, me);
        }
      });
    }
  } else if (e.data?.type == "erga-comments") {
    commentsShown = e.data.show !== false;
    comments?.show(commentsShown);
  }
  // The comment box, in the viewer (client/common/comment-box.ts): its height, what it sent, and the answer.
  else if (typeof e.data?.type == "string" && e.data.type.startsWith("erga-comment-")) comments?.fromShell(e.data);
});

/** The viewer says edit, standby or view. The same again: a new key (for the next socket). */
function setMode(m: EditMode) {
  if (m.mode == "view") return send({ type: "view" });
  if (m.timescale) window.__ergaTimescale = m.timescale;
  setNotes(m.notes);
  comments?.queue();
  send({ type: "told", mode: m });
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
    else if (effect == "rest") rest();
    else if (effect == "flush") flush(run);
    else if (effect == "reload") reloadNow();
    else stop();
  // (The note that the room didn't answer is for someone who waits for the editor.)
  if (editing()?.mode != "edit") {
    roomNote?.();
    roomNote = null;
  }
}

/** The viewer's word on the zoom (client/viewer/zoom.ts): the level, and the part of the page in sight. */
function setZoom(m: Zoomed) {
  const next = clampZoom(m.zoom);
  if (next == zoom && m.shows.left == shows.left && m.shows.right == shows.right) return;
  // (The page keeps its place itself, as its frame gets its new height: client/inline/reader.ts.)
  zoom = next;
  shows = m.shows;
  controls?.queue();
  comments?.queue();
}

/**
 * Editing, the page zoomed in keeps its width (client/common/zoom.ts, Keep), and only part of it shows across: a caret
 * that a key moved out of sight there brings the page across to it (erga-pan, px on the screen), as it scrolls down to it.
 */
let keyed = false;
function caretAcross() {
  const sel = getSelection();
  if (zoom <= 1 || !sel?.focusNode) return;
  const at = document.createRange();
  try {
    at.setStart(sel.focusNode, sel.focusOffset);
  } catch {
    return;
  }
  const r =
    at.getClientRects()[0] ?? (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode.parentElement)?.getBoundingClientRect();
  if (!r) return;
  const room = 24,
    dx = r.left < shows.left + room ? r.left - room - shows.left : r.left > shows.right - room ? r.left + room - shows.right : 0;
  if (dx) window.parent.postMessage({ type: "erga-pan", dx: dx * zoom, dy: 0 }, SHELL);
}

// The word that loaded this script (the page's first script kept it).
const first = window.__ergaReader?.mode as EditMode | undefined;
if (first?.type == "erga-mode") queueMicrotask(() => setMode(first));
const zoomedFirst = window.__ergaReader?.zoomed as Zoomed | undefined;
if (zoomedFirst?.type == "erga-zoomed") queueMicrotask(() => setZoom(zoomedFirst));

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
// (it joins the room first) are held, and the editor applies them first, in order. The page's first script holds
// them (client/inline/reader.ts): it is up before this one, when the viewer gives the page the keys.
const early: HeldInput[] = window.__ergaReader.keys.held;
/** Lets go of the keys: the editor takes them, or it stops before it's up (then the page's own keys work again). */
const letGo = window.__ergaReader.keys.letGo;

/** An agent's edit plays as typing, behind its caret; anyone else's shows as it comes. */
const typingAgent = (a: Author | null): TypingAgent | null =>
  a?.kind == "agent" ? { name: a.name, color: a.color, ...(collab ? { label: collab.agentLabel(a, "writing") } : {}) } : null;

/** Whether this origin holds nothing but this document: then the replica and the page are kept in this browser. */
let own = false;
/** The viewer says that this browser is signed out: the room's socket tries no more (collab.ts, signedOut). */
let signedOut = false;

/**
 * The room's text in one answer, asked for as the editor starts, before its other waits: the editor is up when it
 * comes, and the socket brings what changed since. (A key the host refuses: the socket's own sync.)
 */
let roomStart: Promise<ArrayBuffer | null> = Promise.resolve(null);

/** Into the editor: once the page has loaded (its scripts have built what they build on load). */
async function start(run: number) {
  performance.mark("erga:init");
  const m = editing()!;
  // On this page's own origin (a document's page calls no other): the document's address there, /d/<id>.
  const here = location.origin + new URL(m.doc).pathname;
  roomStart = fetch(`${here}/api/start?${new URLSearchParams({ key: m.key })}`).then(
    (r) => (r.ok ? r.arrayBuffer() : null),
    () => null
  );
  // Erga's worker on this origin, for a reload offline (only an origin of this document's own has it: never a shared
  // host; and not where the server says a worker can't work: server/documents/pages-origin.ts, workerFor).
  const offline = reader.worker ? keepOffline(null) : Promise.resolve(false);
  if (document.readyState != "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  own = await offline;
  send({ type: "loaded", run });
}

/** Exposed on the page's window while joined (in both edit and standby modes) for e2e inspection. */
const frameHandle = {
  get page() {
    return page;
  },
  get collab() {
    return collab;
  },
  get zoom() {
    return zoom;
  },
  get reloading() {
    return state.phase == "reloading";
  },
};

/** The page's own socket and replica, in the room. */
function join(run: number) {
  const m = editing()!;
  if (own) pageCopy ??= keepPage(SHELL, () => collab?.current() ?? "");
  // On this page's own origin (a document's page calls no other): the document's address there, /d/<id>.
  const here = location.origin + new URL(m.doc).pathname;
  const room = `${here.replace(/^http/, "ws")}/api/room`;
  const c = (collab = new Collab({
    start: roomStart,
    // (Only the room: the person's events, the agent's asks among them, are the viewer's to hear.)
    // (comments=1: it hears that the document's comments changed, and reads them again: comments.ts.)
    url: (q) => `${room}?${new URLSearchParams({ key: editing()?.key ?? m.key, comments: "1", ...Object.fromEntries(q) })}`,
    onEvent: (msg) => {
      if (msg.type == "comments") void comments?.refresh();
    },
    // (Standing by, the page is the viewer's to show: it loads each change itself, client/viewer/live.ts.)
    onRemote: (changes, author) => {
      if (!page) return;
      page.applyExternal(changes, typingAgent(author));
      if (page.stale) refreshSoon();
      queuePeers();
    },
    // Another file of the folder (a stylesheet, a script, an image) changed: a stylesheet's new rules go into the page
    // as it is (the page's first script: restyle), at once; for anything else the page is made again from its files.
    // Not another page's text, which this page doesn't show. A file that was on its way (a drop, an agent's file) is
    // loaded in place by the elements that show it (pending.ts).
    onFiles: (paths) => {
      if (!page) return;
      for (const p of paths) if (awaited.has(p)) pending.arrived(p);
      const changed = paths.filter((p) => !/\.(html?|md)$/i.test(p) && !awaited.has(p));
      if (!changed.length) return;
      void (window.__ergaReader?.restyle?.(changed) ?? Promise.resolve(false)).then((done) => {
        if (!done) refreshSoon();
        else controls?.queue();
      });
    },
    onPresence: () => queuePeers(),
    onStatus: () => {},
    // (Standing by, the page stays: it leaves the room, and the viewer's next word joins it afresh.)
    onStale: () => (editing()?.mode == "edit" ? location.reload() : send({ type: "view" })),
    ...(own ? { keep: m.doc } : {}),
  }));
  if (signedOut) c.signedOut();
  // (No presence yet: the editor brings it as it goes on the page.)
  c.join(m.me, m.path, null);
  window.ergaFrame = frameHandle;
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
  // (Standing by, nobody waits for it.)
  if (editing()?.mode == "edit")
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
  // In the room for the others from now on, with this tab's mark (the viewer knows its own page's caret by it).
  c.present({ tab: editing()!.tab });
  edit(c, editing()!, back);
  // The lock for source edits (document/room/room.ts): while someone holds it, the page is read-only, and says so; their
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
  unwatch.push(() => roomInfo(c.doc).unobserve(follow));
  follow();
}

/** This page in the browser's copy, made from the replica's text after each change (offline-page.ts), on an origin of its own. */
let pageCopy: ReturnType<typeof keepPage> | null = null;
/** After an edit, once the typing pauses: the page goes into the copy, and the controls take the page's tone again. */
const whenPaused = afterPause(() => {
  void pageCopy?.changed();
  queueDark();
});

/** What says the page is read-only while someone edits its source (the lock), and takes it off. */
let lockNote: (() => void) | null = null;

/** The editor on the page, from the room's text (`c`'s replica) and what it kept of itself, if it did. */
function edit(c: Collab, m: Editing, back: Carry | null) {
  let text = c.current();
  // (A commenter makes no edits.)
  if (!m.comment)
    unsaved = watchUnsaved(window, {
      flushed: () => (collab == c ? c.flushed() : Promise.resolve(false)),
      key: m.path,
      mark: (at) => window.parent?.postMessage({ type: "erga-save", at }, SHELL),
    });
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
      // A file's element left the text while its bytes are on their way (Undo, a deletion): its upload stops.
      if (u.docChanged && placed.size) {
        const text = u.state.doc.toString();
        for (const [path, href] of placed)
          if (!text.includes(`"${href}"`)) {
            placed.delete(path);
            window.parent?.postMessage({ type: "erga-upload-act", path, action: "gone" }, SHELL);
          }
      }
      if (u.docChanged && !u.remote) tell({ type: "erga-activity", kind: "edit" });
      if (u.docChanged || u.selectionSet) {
        queueCursor();
        queueContext(u.state);
      }
      // A presentation's pictures of its steps are out of date once its text changes (libs/steps).
      if (u.docChanged) {
        // (The page in the copy and the page's colours read the whole document: when the typing pauses, pause.ts.)
        whenPaused.ask();
        dispatchEvent(new Event("ergaedit"));
        const isUndoRedo = !u.remote && !!page?.lastUndoRedo;
        if (u.remote || isUndoRedo) dispatchEvent(new CustomEvent("erga-edited", { detail: { remote: !!u.remote, undo: isUndoRedo } }));
      }
      // (The editor takes the page as it's made: once it's this frame's.)
      if (u.rendered) {
        sendContext(u.state);
        queueMicrotask(() => {
          if (!page) return;
          // A commenter has the comments alone: no caret, no style bar, and a "Comment" button at the selection.
          if (!m.comment) {
            unwatch.push(drawCaret(window as Window & typeof globalThis, () => zoom));
            const made = mountControls(window, page, {
              place: () => placeOf(window, reader),
              zoom: () => zoom,
              comment: () => comments?.compose(),
              writing: () => !!comments?.writing(),
            });
            controls = made;
            made.lift(notes);
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
            shows: () => shows,
            shown: commentsShown,
            button: !!m.comment,
            box: (box) => window.parent?.postMessage({ type: "erga-comment-box", box }, SHELL),
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
          // Made afresh: the line the reader was on, where it was (the page's first script had it near there: erga-keep).
          if (view) {
            window.__ergaReader?.placed?.();
            page.restoreView(view);
            view = null;
          }
          // The page takes the focus it has (the viewer gives the frame the focus as it goes into the editor), with the
          // caret in its text: it had the focus as it loaded again, or has it now, for the keys held meanwhile.
          // (Not after full screen: the text is left, as after Escape, until a click on it.)
          if (wasFull) page.leaveText();
          else if (!m.comment && (focus || document.hasFocus())) {
            page.focus();
            // A page that loads again is out of sight until it has its view (client/inline/reader.ts), and the browser
            // gives no focus to what is out of sight: the text takes it as the page shows. Without it, text that comes
            // with no key (an input method, dictation) goes into the page past the editor.
            const shown = () => document.hasFocus() && page?.focus();
            addEventListener("ergaplaced", shown, { once: true });
            unwatch.push(() => removeEventListener("ergaplaced", shown));
          }
          wasFull = false;
          // (The viewer stops its own reloads of the page: this shows each change in place. client/viewer/live.ts.)
          if (m.comment) window.parent.postMessage({ type: "erga-commenting" }, SHELL);
          // (The keys held meanwhile go in now, whether or not it has the focus yet.)
          page.handOver();
          focus = false;
        });
      }
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
    // A notice the agent can fix (a paragraph whose HTML is broken) is an alert, with the fix as its button: what is
    // wrong in a few words, then the rest. Any other says why, here.
    onNotice: (message, fix) => {
      if (m.comment) return;
      if (!fix) return controls?.explain(message);
      const [, title, detail] = /^(.*?)(?:: |\. )(.+)$/s.exec(message) ?? [null, message.replace(/\.$/, ""), undefined];
      alerts.raise({ key: `notice:${message}`, kind: "error", source: "editor", title: title!, detail, fix });
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
    onDropFiles: (list, to) => void dropFiles(list, to),
    onDropRefused: notDropped,
  });
  // The page's own API, imported before the person's first edit asks for it.
  warm(apiCode(m.path, text, (p) => files(c.doc).get(p)?.toString()));
  window.ergaFrame = frameHandle;
}

/** Files dropped or pasted can't go in: an alert says why. */
function notDropped(why: string) {
  alerts.raise({ key: `drop:${why}`, kind: "error", source: "upload", title: "The file wasn't added", detail: why });
}

/**
 * Files dropped, pasted or picked for the page: each gets its path in the document's files and its element on the page
 * at once (an image with its size), and the viewer sends its bytes (client/shell/uploads.ts). Its element goes into
 * the text at `at`; or, dropped at a `point` that isn't the text's, where the page itself places it (its
 * window.ergaDrop names one of its own edits: drop.ts). A file with no place on the page goes to the document's files
 * all the same, and the viewer says so.
 */
async function dropFiles(list: File[], to: { at: number } | { point: { x: number; y: number } | null }) {
  // (Its state is on its way to the page that comes: what's dropped now would have nowhere to go in.)
  if (state.phase != "editing" || !editing() || !collab) return notDropped(LOADING_AGAIN);
  const place = "at" in to ? { at: to.at } : null;
  if (place) drops.add(place);
  const taken = new Set([...files(collab.doc).keys(), ...assets(collab.doc).keys(), ...awaited].map((p) => p.toLowerCase()));
  const named: { file: File; path: string; noPlace?: string }[] = list.slice(0, 50).map((file) => ({ file, path: pathFor(file, taken) }));
  for (const f of named) awaited.add(f.path);
  const sizes = await Promise.all(named.map((f) => imageSize(f.file)));
  if (place) drops.delete(place);
  if (!page) return;
  // From this page's folder (a page in blog/ reaches images/ as ../images/).
  const up = "../".repeat(HERE.startsWith(BASE) ? HERE.slice(BASE.length).split("/").filter(Boolean).length : 0);
  const items = named.map((f, i) => ({
    href: up + encodePath(f.path),
    name: baseName(f.path),
    image: f.path.startsWith("images/"),
    ...sizes[i],
  }));
  if (place) {
    if (!page.insertFiles(place.at, items)) return notDropped("The text where the file was dropped changed meanwhile. Drop it again.");
  } else {
    // The page's own place for them, now that their names and sizes are known; each goes in by the page's own edit.
    const point = "point" in to ? to.point : null;
    const where =
      point &&
      page.placeAt(
        point.x,
        point.y,
        items.map((i, n) => ({
          kind: i.image ? "image" : "file",
          type: named[n].file.type,
          name: i.name,
          width: i.width,
          height: i.height,
        })),
        true
      );
    let why = where ? null : "";
    for (const [n, i] of items.entries()) {
      why ??= await page.dropEdit(where!.edit, {
        ...where!.input,
        file: { src: i.href, name: i.name, width: i.width, height: i.height },
        index: n,
      });
      if (why != null) named[n].noPlace = why;
    }
  }
  named.forEach((f, i) => {
    if (f.noPlace != null) return;
    placed.set(f.path, items[i].href);
    pending.add(f.path, f.file);
  });
  window.parent?.postMessage({ type: "erga-upload", files: named, ...("point" in to && to.point ? { point: to.point } : {}) }, SHELL);
}

/** The "/" menu's choice: the editor makes the block; for an image, the person picks files, which go in as dropped ones do. */
function slashChosen(kind: Parameters<PageEditor["slashBlock"]>[0]) {
  const at = page?.slashBlock(kind);
  if (kind != "image" || at == null || at === false) return;
  void pickImages(document).then((list) => {
    if (list.length) void dropFiles(list, { at });
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
 * The comment ops, from the page (comments.ts): the read, resolve and reopen. POST /api/tools/<op> on this page's own
 * origin with the edit key, which names the person (server/api.ts, keyedComment). On this page, of this document. (A
 * comment, a reply and an edit go from the viewer's box, with the person's session: client/common/comment-box.ts.)
 */
async function commentOp(op: "comment" | "comments", args: Record<string, unknown>) {
  const m = editing();
  if (!m) throw new Error("The editor stopped.");
  const url = new URL(m.doc),
    id = url.pathname.split("/").pop()!;
  const r = await fetch(`/api/tools/${op}?${new URLSearchParams({ doc: id, key: m.key })}`, {
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
  if (leave() || !page || !collab || state.phase != "editing") return;
  carry({
    path: state.mode.path,
    state: stateJSON(page.state),
    view: scrollY > 0 ? page.topText() : null,
    room: collab.held(),
  });
});

/**
 * Loading again: the keys typed since it handed its state over go with it too. As this page goes, and before, when
 * the page that loads in its place is up and has the keys from then on (the viewer's erga-leave: this page still shows,
 * client/common/frame-swap.ts). False if it isn't loading again.
 */
function leave() {
  if (state.phase != "reloading") return false;
  // (One time: the page that comes takes what this one kept as its editor starts, and nothing after that.)
  if (leaving && page) carry({ ...leaving, held: [...(leaving.held ?? []), ...page.takeHeld()] });
  leaving = null;
  return true;
}

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
  // The viewer loads the page again, with its view kept (client/inline/viewer-frames.ts): this page shows until the
  // new one has the same view.
  window.parent.postMessage({ type: "erga-reload" }, SHELL);
}

/**
 * Out of the editor: the editor stops (its state kept for the way back in); the page stays as it is. Its replica stays
 * in the room, where nobody sees it. Keys held for an editor that never came up go back to the page.
 */
function rest() {
  stopEditor();
  letGo();
  early.length = 0;
  lockNote?.();
  lockNote = null;
  collab?.absent();
}

/** Out of the editor and out of the room. */
function stop() {
  rest();
  collab?.close();
  collab = null;
  window.ergaFrame = undefined;
}

/** The editor stops, its state kept for the way back in; the page stays as it is. */
function stopEditor() {
  if (contextTimer) {
    clearTimeout(contextTimer);
    contextTimer = 0;
  }
  contextAt = 0;
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
}

const CONTEXT_MS = 150;
let contextTimer = 0,
  contextAt = 0;
/** Posts the current caret/selection and nearby HTML context to the shell (for agent context and feedback). */
function sendContext(s = page?.state) {
  if (contextTimer) {
    clearTimeout(contextTimer);
    contextTimer = 0;
  }
  const m = editing();
  if (!s || !m) return;
  contextAt = Date.now();
  const sel = s.selection.main,
    startLine = s.doc.lineAt(sel.from),
    endLine = s.doc.lineAt(sel.to);
  tell({
    type: "erga-context",
    path: m.path,
    context: {
      line: startLine.number,
      endLine: endLine.number,
      ...(sel.empty ? {} : { selected: s.sliceDoc(sel.from, sel.to).slice(0, 4001) }),
      lineText: startLine.text.slice(0, 401),
      near: sourceNear(s.doc.toString(), sel.head),
    },
  });
}
function queueContext(s?: EditorState) {
  if (contextTimer) return;
  const wait = CONTEXT_MS - (Date.now() - contextAt);
  if (wait <= 0) sendContext(s);
  else contextTimer = window.setTimeout(() => sendContext(), wait);
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
  on(win, "focus", () => (collab?.activate(), controls?.queue()), true);
  // (The focus went to the window around the page: its comment box, say. The style bar waits: controls.ts.)
  on(win, "blur", () => (controls?.queue(), sendContext()));
  on(d, "scroll", () => (controls?.queue(), comments?.queue()), { passive: true });
  // The style bar follows selected text that moves another way: a scroll in an element, a pan of the page's own (moves.ts).
  unwatch.push(
    watchMoves(d, win, () => {
      if (page && d.getSelection()?.isCollapsed === false) controls?.queue();
    })
  );
  on(d, "selectionchange", () => (controls?.queue(), comments?.queue(), keyed && caretAcross(), sendContext()));
  // (A key moved it: the caret the editor puts as it starts, or a click's, moves nothing.)
  on(d, "keydown", () => ((keyed = true), win.setTimeout(() => (keyed = false), 300)), { capture: true });
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
  pending.dark(dark);
  signsDark(dark);
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
