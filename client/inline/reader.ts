// The script that goes first into a document's page, before the page's own (server/pages/reader.ts, readerPage). It
// tells the viewer by postMessage what it needs: where the page is scrolled to and where the pointer is (the fade), its
// background (the band and the canvas around the frame), and which of the document's pages it shows. It follows the
// viewer's asks (the editor), and sends links that leave the
// document to the viewer, which opens them. `C`: the viewer's origin, where the document's files are, and the editor's
// half for whoever may edit.
//
// Trap: an element's load event never comes to the window, though its error event does (the browser stops a load at the
// document). A listener for an image that loads is on the document.
//
// Trap: the page that loads again in this one's place (its address says erga-keep) is out of sight until it shows the
// view this one had (`place`), and the viewer shows it only when it says so (erga-placed). A new wait there needs its
// end, and its event for `soon`: `check` runs on no frame without one.
//
// Trap: the view is saved only while the page shows, never as it goes (pagehide). A browser with a process for each
// site (every person's; the document's files are on another site than the viewer) says that a frame that goes is
// scrolled to 0, and that view took the kept one's place: the next load opened at the page's top.
//
// Trap: `check` (the colour, the canvas, the scroll, the hash) runs only after an event that `soon` hears (a DOM change,
// a size, a load, a transition's start), never on each frame. A new thing the viewer must hear of needs its event
// there. A change made only through the CSSOM (`insertRule`) reaches the viewer at the next such event.

import type { ReaderConfig } from "../../shared/page-html";
import type { ToolAsk } from "../common/reader-api";
import { copyOf } from "../../libs/text/ui/clipboard-read";
import { linkTarget, placeOf } from "../common/link-target";
import { TOP_ROOM, topRoom, type Seat } from "../common/top-room";
import { readView, showView, viewOf, type View } from "../common/page-view";
import { isAppShortcut, isMac } from "../common/app-keys";
import { catchZoomGestures, drawnLevel, REST_MS, zoomKey } from "../common/zoom";
import { makeErgaLLM, type LlmAnswer, type LlmOp } from "../common/page-llm";

/** The page's canvas, as it goes to the viewer (client/inline/viewer-band.ts draws it). */
type Canvas = {
  color: string;
  image: string;
  files: Blob[];
  urls?: string[];
  size?: string;
  position?: string;
  repeat?: string;
  tile?: boolean;
  fixed?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
export default function reader(C: ReaderConfig): void {
  // Only as the viewer's document: not opened by itself, nor in a frame inside the page.
  if (parent == window || parent != top) return;
  const P = parent,
    root = document.documentElement;
  function tell(m: unknown) {
    try {
      P.postMessage(m, C.shell);
    } catch {}
  }
  function editing() {
    return root.hasAttribute("data-erga-editing");
  }
  // The page's model (client/common/page-llm.ts): each ask goes to the viewer, which calls Erga as the visitor
  // (client/inline/viewer-llm.ts) and answers it. A viewer that never answers: off, or an error.
  let llmId = 0;
  const llmWaits = new Map<number, (a: LlmAnswer) => void>();
  window.ergaLLM = makeErgaLLM(
    (o) =>
      new Promise((done) => {
        const id = ++llmId;
        llmWaits.set(id, done);
        let m: LlmOp;
        try {
          m = JSON.parse(JSON.stringify(o));
        } catch {
          llmWaits.delete(id);
          return done({ ok: false, error: "The ask isn't plain JSON.", code: "error" });
        }
        tell({ ...m, type: "erga-llm", id });
        setTimeout(
          () => {
            if (!llmWaits.delete(id)) return;
            done(
              o.op == "ask"
                ? { ok: false, error: "Erga didn't answer.", code: "error" }
                : { ok: true, result: { on: false, model: null, signedIn: false } }
            );
          },
          o.op == "ask" ? 120_000 : 10_000
        );
      })
  );
  // The viewer's own keys, pressed here. Reading, ⌘K (Ctrl+K off a Mac) opens the viewer's quick search
  // (client/common/quick-search.ts). Editing, each of the viewer's shortcuts goes to it (client/common/app-keys.ts),
  // which the editor in the page leaves be; Escape stays the editor's too (the focus off the text).
  addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      // Print (⌘P; Ctrl+P off a Mac): this page alone, whole. The browser's own would print the viewer around it, with
      // Erga's bars and only the part of the page on the screen.
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "p") {
        e.preventDefault();
        print();
        return;
      }
      // The editor, opened or closed (⌘⇧E; Ctrl+Shift+E off a Mac): the viewer does it, for whoever may edit (viewer-edit-boot.ts).
      if ((isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() == "e") {
        e.preventDefault();
        e.stopPropagation();
        tell({ type: "erga-edit-key" });
        return;
      }
      if (editing()) {
        tell({ type: "erga-activity", kind: "key" });
        if (!isAppShortcut(e, isMac)) return;
        // A zoom key: the page keeps its middle (keepZoomPlace, below). ⌘0 on a window the browser has zoomed itself is the
        // browser's too, for its own way back.
        const zoomed = zoomKey(e, isMac);
        if (zoomed) aimAt(innerWidth / 2, innerHeight / 2);
        if (e.key != "Escape" && !(zoomed == "reset" && pinched())) e.preventDefault();
        tell({ type: "erga-key", keys: { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } });
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() != "k") return;
      e.preventDefault();
      tell({ type: "erga-quick-search" });
    },
    true
  );
  // Editing: the page's focus, and a zoom gesture on it (a pinch, ctrl with the wheel), for the viewer, which sets the
  // zoom (libs/text/ui/zoom.ts); whether the page zooms itself (window.ergaZoom: a canvas's camera), as the viewer's
  // zoom goes to it then.
  addEventListener("focus", () => editing() && tell({ type: "erga-activity", kind: "focus" }), true);
  const said = () => window.__ergaReader?.mode as { mode?: string; zoom?: number; tall?: number; pinched?: boolean } | undefined;
  /** The browser has the whole window zoomed (its own pinch): a pinch stays the browser's (client/common/zoom.ts, the trap). */
  const pinched = () => said()?.pinched === true;
  catchZoomGestures(
    window,
    (by, e) => {
      aimAt(e.clientX, e.clientY);
      tell({ type: "erga-zoom", zoom: by, x: e.clientX, y: e.clientY });
    },
    (by) => editing() && !(pinched() && (!by || "by" in by))
  );
  // The editor's zoom (client/common/zoom.ts): the viewer draws this page's frame larger, and shorter by as much. The
  // page's point under the pointer (`aim`: of the pinch or the key that zooms, `y` px below the frame's top on the screen,
  // `part` of the way down its element `el`; else the middle) stays where it is on the screen, whatever the page lays
  // out again for its window's new height (the room at its top, a size in vh): the page scrolls as its window gets its
  // new height, before the browser paints it (a ResizeObserver's time, on a box of the window's size). `drawn`: the
  // level this page's scroll is for.
  //
  // Trap: the viewer's word (the level) and the window's new height come apart, in either order, and several levels may
  // pass between two of either. So the word says the height too (`tall`: the frame's place on the screen), and
  // drawnLevel (zoom.ts) says which level the page is at.
  let drawn: number | null = null,
    tall = 0,
    high = innerHeight,
    wide = innerWidth,
    aim: { y: number; el: Element; part: number; t: number } | null = null;
  const fresh = () => !!aim && performance.now() - aim.t < 400 && aim.el.isConnected;
  /** The zoom's point, from here on: the page's point at (x, y) in this window. One pinch keeps the point it began with. */
  function aimAt(x: number, y: number) {
    const on = y * (drawn ?? 1),
      t = performance.now();
    if (fresh() && Math.abs(aim!.y - on) < 3) return void (aim!.t = t);
    const el = document.elementFromPoint(x, y) ?? root,
      r = el.getBoundingClientRect();
    aim = { y: on, el, part: r.height ? (y - r.top) / r.height : 0, t };
  }
  /** Scrolls the zoom's point back to its place on the screen, with the page at `level`. */
  function holdAim(level: number) {
    const r = aim!.el.getBoundingClientRect();
    scrollBy({ top: r.top + aim!.part * r.height - aim!.y / level, behavior: "instant" });
  }
  const view = document.createElement("erga-view");
  view.style.cssText = "all: initial; position: fixed; inset: 0; visibility: hidden; pointer-events: none";
  function keepZoomPlace() {
    const h = innerHeight,
      m = said(),
      level = m?.mode == "edit" && m.zoom ? m.zoom : 1;
    if (m?.mode == "edit" && m.tall) tall = m.tall;
    if (drawn == null) {
      // (The first word: the frame is at its level from the start.)
      if (m) zoomRoom((drawn = level), true);
    } else {
      const pinch = fresh(),
        to = drawnLevel({ height: h, said: level, tall, drawn, pinch: pinch && h != high && innerWidth == wide });
      if (to != drawn) {
        if (pinch) holdAim(to);
        else scrollBy({ top: tall / 2 / drawn - tall / 2 / to, behavior: "instant" });
        // (Where the room at the page's top is in sight, at once. Else it waits for the zoom to rest: it lays out the whole page.)
        zoomRoom((drawn = to), scrollY < room.room);
      }
    }
    high = h;
    wide = innerWidth;
  }
  // The room for the bars at the page's top (below): the band's height on the screen, in this page's px at its level.
  let bars = TOP_ROOM,
    roomWait = 0;
  function zoomRoom(level: number, now: boolean) {
    clearTimeout(roomWait);
    if (!now) return void (roomWait = window.setTimeout(() => zoomRoom(drawn ?? 1, true), REST_MS));
    const px = Math.round((bars / level) * 100) / 100;
    if (px == room.room) return;
    roomShift += px - room.room;
    room.room = px;
    dirty();
    keepRoom();
  }
  new ResizeObserver(keepZoomPlace).observe(view);
  addEventListener("resize", keepZoomPlace);
  // Zoomed, the page is not as wide as its place in the viewer, which moves it sideways: the wheel that way, where the
  // page itself has nothing to scroll.
  addEventListener(
    "wheel",
    (e) => {
      // (A scroll: the zoom's point is where it was no more.)
      if (!e.ctrlKey) aim = null;
      const dx = (e.deltaX || (e.shiftKey ? e.deltaY : 0)) * (e.deltaMode == 1 ? 16 : 1);
      if (!dx || e.ctrlKey || e.defaultPrevented || !editing() || (drawn ?? 1) == 1) return;
      for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
        const more = el.scrollWidth - el.clientWidth;
        if (
          more > 1 &&
          (dx > 0 ? el.scrollLeft < more - 1 : el.scrollLeft > 1) &&
          (el == document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowX))
        )
          return;
      }
      tell({ type: "erga-pan", dx });
    },
    { passive: true }
  );
  let zoomsSaid: boolean | null = null;
  const zooms = (again = false) => {
    const on = typeof (window as Window & { ergaZoom?: unknown }).ergaZoom == "function";
    if (on === zoomsSaid && !again) return;
    zoomsSaid = on;
    tell({ type: "erga-zooms", on });
  };
  addEventListener("load", () => zooms());
  window.__ergaReader = {
    config: C,
    restyle,
    // (The editor puts the page back where it was: with its room for the bars.)
    placed: () => {
      keepRoom();
      placed();
    },
    tools: (answer) => {
      toolsAnswer = answer;
      for (const ask of asks.splice(0)) answer(ask);
    },
  };
  // Erga's page tools (the agent's view_page, eval_in_page and the live page's), loaded when the viewer first asks for
  // one (only for whoever may edit: the editor's config names them); the asks wait for them meanwhile.
  let toolsAnswer: ((ask: ToolAsk) => void) | null = null,
    toolsLoading = false;
  const asks: ToolAsk[] = [];
  function askTools(ask: ToolAsk) {
    if (toolsAnswer) return toolsAnswer(ask);
    asks.push(ask);
    const tools = C.editor && C.editor.tools;
    if (toolsLoading || !tools) return;
    toolsLoading = true;
    addScript(tools);
  }
  // Up. `deep`: this frame has entries of its own in the tab's history (a link to another of the document's pages was
  // followed in it), which a new frame in its place would lose: the viewer loads the page again in this one then.
  let entries = history.length;
  try {
    entries = (window as Window & { navigation?: { entries(): unknown[] } }).navigation?.entries().length ?? entries;
  } catch {
    /* as many as the tab has */
  }
  tell({ type: "erga-hello", deep: entries > 1 });
  // Which of the document's pages this is ("" for its own page).
  let page = location.pathname.indexOf(C.prefix) == 0 ? location.pathname.slice(C.prefix.length) : "";
  try {
    page = decodeURIComponent(page);
  } catch {}
  if (!page || /\.html$/i.test(page)) tell({ type: "erga-nav", path: page || "" });
  // The page's head (shared/page-head.ts): its title and icon, for the viewer's tab, once it's parsed and each time it
  // changes (an edit, or the page's script).
  let headSaid = "";
  const sayHead = () => {
    const icon = document.querySelector<HTMLLinkElement>('head link[rel~="icon" i]');
    const head = { title: document.title.trim(), icon: icon ? icon.href : "" };
    const said = JSON.stringify(head);
    if (said == headSaid) return;
    headSaid = said;
    tell({ type: "erga-head", ...head });
  };
  const watchHead = () => {
    sayHead();
    new MutationObserver(sayHead).observe(document.head || root, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.readyState == "loading") document.addEventListener("DOMContentLoaded", watchHead, { once: true });
  else watchHead();
  // The page stops dead at its top and bottom.
  const still = document.createElement("style");
  still.setAttribute("data-erga", "");
  // (And the editor's own parts on the page never print.)
  still.textContent =
    "html { overscroll-behavior: none; } @media print { erga-controls, erga-comments, erga-caret, erga-peers, erga-note, erga-drop-caret, erga-drop-image { display: none !important; } }";
  (document.head || root).append(still);
  // The room for the bars at the top of a scrolling page (client/common/top-room.ts), measured again when the page's
  // styles may have changed (its head, its root's attributes), as it loads, the window's size, or the room the viewer asks for (its
  // band's height at its zoom); and the page's seat, for the viewer, which places its frame by it: below the bars for a
  // page that fills the window, over the whole window for one that keeps clear of the bars itself (window.ergaInset,
  // which gets what they cover, and again as it changes).
  const room = topRoom(document);
  let roomDirty = true,
    roomShift = 0,
    seatSaid: Seat | null = null,
    insetGiven = "",
    // The page's scripts have run (a canvas's window.ergaInset is there), and the viewer has said what its bars cover.
    parsed = false,
    roomGiven = false;
  // A check of what the viewer hears of the page (`check`, below), on the next screen frame: one for all that changed.
  let due = false;
  function soon() {
    if (due) return;
    due = true;
    requestAnimationFrame(check);
  }
  const dirty = () => {
    roomDirty = true;
    soon();
  };
  const styles = new MutationObserver(dirty);
  styles.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  addEventListener("resize", dirty);
  addEventListener("load", dirty);
  // (The page's own scripts have run: window.ergaInset is there, if the page has one. The seat is said again: the one
  // said before them was `early`, a guess that the viewer takes only for a page it never saw.)
  document.addEventListener("DOMContentLoaded", () => {
    parsed = true;
    seatSaid = null;
    dirty();
  });
  // (At once as the page is parsed, before its deferred scripts and the editor run and measure it.)
  document.addEventListener("readystatechange", () => {
    dirty();
    keepRoom();
  });
  function keepRoom() {
    if (!roomDirty || !ready()) return;
    roomDirty = false;
    if (document.head) styles.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    const inset = (window as Window & { ergaInset?: unknown }).ergaInset,
      seat = room.update(typeof inset == "function");
    // The room got another height (the editor's zoom): the zoom's point stays where it is on the screen, and so does a
    // page scrolled down. (The browser's own scroll anchoring leaves a change of the root's padding alone.)
    if (roomShift && seat == "under") {
      if (fresh() && drawn) holdAim(drawn);
      else if (scrollY > 0) scrollBy({ top: roomShift, behavior: "instant" });
    }
    roomShift = 0;
    if (seat !== seatSaid) {
      seatSaid = seat;
      tell({ type: "erga-seat", seat, early: !parsed });
    }
    const given = JSON.stringify(room.inset);
    if (seat != "whole" || typeof inset != "function" || given == insetGiven) return;
    insetGiven = given;
    try {
      inset({ ...room.inset });
    } catch (err) {
      console.error("window.ergaInset threw:", err);
    }
  }
  // The page's view (client/common/page-view.ts): where the window and each element are scrolled to, and its
  // history.state. Kept in this tab as it changes; the page that loads in this one's place (erga-keep in its address:
  // an edit that needs the load, a reload by the person) opens with it. That page is out of sight until its own
  // scripts have run (a canvas's camera is where its address says), the viewer has said what its bars cover, and the
  // view is there (its content may still be coming), or as far as it goes once it has loaded, or after a moment. Then
  // it tells the viewer (erga-placed), which shows it in place of the old page (client/common/frame-swap.ts).
  const VIEW = "erga:view:" + page,
    moved = new Set<Element>();
  // (The load's key, which goes back to the viewer with erga-placed: it shows the page of its last load only.)
  const keep = (/[?&]erga-keep=([^&]*)/.exec(location.search) || [])[1];
  let keeping = keep !== undefined,
    want: View | null = null,
    placing: HTMLStyleElement | null = null;
  try {
    if (keeping) want = readView(sessionStorage.getItem(VIEW));
    else sessionStorage.removeItem(VIEW);
    if (want && want.state !== undefined) History.prototype.replaceState.call(history, want.state, "", location.href);
  } catch {
    /* no storage: the page opens at its start */
  }
  function placed() {
    if (!keeping) return;
    keeping = false;
    want = null;
    placing?.remove();
    // (For the editor, which may be up already: what is out of sight takes no focus. libs/text/ui/frame.ts.)
    dispatchEvent(new Event("ergaplaced"));
    // (Two frames on: the page has painted its view.)
    requestAnimationFrame(() => requestAnimationFrame(() => tell({ type: "erga-placed", keep })));
    soon();
  }
  function place() {
    if (!keeping || !parsed || !roomGiven) return;
    if (!want || showView(window, want, moved) || document.readyState == "complete") placed();
  }
  if (keeping) {
    placing = document.createElement("style");
    placing.setAttribute("data-erga", "");
    placing.textContent = "html { visibility: hidden !important; }";
    (document.head || root).append(placing);
    setTimeout(placed, 1500);
  }
  let saving = false;
  function save() {
    saving = false;
    if (keeping) return;
    try {
      sessionStorage.setItem(VIEW, JSON.stringify(viewOf(window, moved)));
    } catch {
      /* no storage, or it is full: the next page opens at its start */
    }
  }
  function saveSoon() {
    if (saving) return;
    saving = true;
    requestAnimationFrame(save);
  }
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof Element) moved.add(e.target);
      saveSoon();
    },
    { capture: true, passive: true }
  );
  // Stylesheets of the document changed (`paths`, in the document): their new rules take the old ones' place in the
  // page as it is, at once, so the page keeps its view and its scripts' state. `files`: where the document's files are
  // now (a reader's address has the version in it), else where this page's are. False when it can't (a path that is no
  // stylesheet linked from this page, or one with an @import): then the page loads again.
  let styling: Promise<boolean> = Promise.resolve(true);
  function restyle(paths: string[], files = location.origin + C.prefix): Promise<boolean> {
    // (One change after another: the newest rules go in last.)
    styling = styling.then(() => styled(paths, files));
    return styling;
  }
  async function styled(paths: string[], files: string): Promise<boolean> {
    const fileOf = (href: string) => {
      try {
        const u = new URL(href, location.href);
        return u.origin == location.origin && u.pathname.indexOf(C.prefix) == 0
          ? decodeURIComponent(u.pathname.slice(C.prefix.length))
          : null;
      } catch {
        return null;
      }
    };
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')];
    const jobs: Promise<[CSSStyleSheet, string[]] | null>[] = [];
    for (const path of paths) {
      const hit = links.filter((l) => fileOf(l.href) == path);
      if (!/\.css$/i.test(path) || !hit.length) return false;
      const text = fetch(files + path.split("/").map(encodeURIComponent).join("/"), { cache: "no-store" }).then((r) =>
        r.ok ? r.text() : null
      );
      for (const l of hit)
        jobs.push(
          text.then((t) => {
            if (t == null || !l.sheet || /@import/i.test(t)) return null;
            // (Parsed apart, as a sheet at the same address: a rule's own addresses mean the same.)
            const fresh = new CSSStyleSheet({ baseURL: l.href });
            fresh.replaceSync(t);
            return [l.sheet, [...fresh.cssRules].map((r) => r.cssText)];
          })
        );
    }
    try {
      const done = await Promise.all(jobs);
      if (done.some((d) => !d)) return false;
      for (const [sheet, rules] of done as [CSSStyleSheet, string[]][]) {
        while (sheet.cssRules.length) sheet.deleteRule(0);
        rules.forEach((r, i) => sheet.insertRule(r, i));
      }
    } catch {
      return false;
    }
    // (Through the CSSOM: no event says it. The room, the colour and the canvas may have changed.)
    dirty();
    return true;
  }
  // The editor's half, into this page: at once when the viewer opened the page in the editor (?erga-edit), else when it
  // asks. (Its chunks' integrity is the import map's, before this script: readerPage puts it there.)
  let loading = false;
  function load() {
    const editor = C.editor;
    // (A page that brings its own editor: it's there already, and hears the viewer's word itself.)
    if (loading || !editor || !editor.src) return;
    loading = true;
    addScript(editor);
  }
  /** One of Erga's scripts into this page, with its chunks (their integrity is the import map's, before this script). */
  function addScript(script: { src: string; integrity: string; preload: string[] }) {
    const head = document.head || root,
      map = C.editor ? C.editor.map : {};
    script.preload.forEach((href) => {
      const l = document.createElement("link");
      l.rel = "modulepreload";
      l.href = href;
      l.crossOrigin = "anonymous";
      l.setAttribute("data-erga", "");
      if (map[href]) l.integrity = map[href];
      head.append(l);
    });
    const s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "anonymous";
    s.src = script.src;
    s.setAttribute("data-erga", "");
    if (script.integrity) s.integrity = script.integrity;
    head.append(s);
  }
  if (/[?&]erga-edit(=|&|$)/.test(location.search)) load();
  // The fade: where the page is scrolled to, and the pointer over it, at most once a frame.
  let scrolled: string | null = null,
    pointer: { x: number; y: number } | null = null;
  function report() {
    // (Out of sight, on its way to its view: the viewer hears where it is once it is there.)
    if (keeping) return;
    // (A page's camera moves as a scroll does: whether it zooms itself may have changed with it.)
    if (editing()) zooms();
    const at = scrollX + "," + scrollY;
    if (at !== scrolled) {
      scrolled = at;
      tell({ type: "erga-scroll", y: Math.max(0, Math.round(scrollY)), sx: scrollX, sy: scrollY });
    }
  }
  addEventListener("scroll", report, { passive: true });
  document.addEventListener("scroll", () => editing() && zooms(), { passive: true });
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType != "mouse") return;
      if (!pointer)
        requestAnimationFrame(() => {
          tell({ type: "erga-pointer", x: pointer!.x, y: pointer!.y });
          pointer = null;
        });
      pointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true }
  );
  // (On the window, first: the text guard, after this script, keeps a press on the text from the page's handlers.)
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType != "mouse") tell({ type: "erga-pointer", x: e.clientX, y: e.clientY, tap: true });
      // Editing, a press on the page is one anywhere in the viewer: what it has open closes.
      if (editing()) tell({ type: "erga-press" });
    },
    { capture: true, passive: true }
  );
  // Links, read as Erga addresses (client/common/link-target.ts). To another of the document's pages: in this frame,
  // even when the link names it by its Erga address or says "_top". Out of the document: a new tab, unless the link
  // names its own target; "_self" takes the whole tab for an address of this Erga (another site: a new tab, always). A ⌘-, Ctrl- or Shift-click, or the middle button: a new tab, at
  // a page's public address (never the token's). The viewer opens new tabs and the whole tab, on the reader's click.
  // Editing, a link in the text being edited isn't followed (but with a modifier, into a new tab), nor a place in the
  // page (#id); another of the document's pages opens in the editor, as the viewer goes there (erga-open).
  function follow(e: MouseEvent) {
    if (e.defaultPrevented || e.altKey || e.button != (e.type == "auxclick" ? 1 : 0)) return;
    const target = e.target as Element | null;
    const a = target && target.closest ? target.closest<HTMLAnchorElement>("a[href]") : null;
    const p = placeOf(window, C);
    if (!a || !p || a.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      return;
    }
    const to = linkTarget(url, p);
    if (to.kind == "none" || to.kind == "file") return;
    const t = (a.getAttribute("target") || "").toLowerCase(),
      tab = e.type == "auxclick" || e.metaKey || e.ctrlKey || e.shiftKey || t == "_blank",
      here = !t || t == "_self" || t == "_top" || t == "_parent";
    if (editing()) {
      if (!tab && (a.isContentEditable || !here || a.getAttribute("href")!.charAt(0) == "#")) return;
      e.preventDefault();
      if (to.kind == "page" && !tab) tell({ type: "erga-open", path: to.path || "index.html" });
      else {
        const out = to.kind == "page" ? to.public : to.url;
        if (out) tell({ type: "erga-go", url: out, tab: tab || !t ? "new" : undefined });
      }
      return;
    }
    if (to.kind == "page" && !tab) {
      if (!here || (url.href == to.frame && t != "_top" && t != "_parent")) return;
      e.preventDefault();
      location.assign(to.frame);
      return;
    }
    const go = to.kind == "page" ? to.public : to.url;
    if (!go || (!tab && !here && t)) return;
    e.preventDefault();
    tell({ type: "erga-go", url: go, tab: tab || !t ? "new" : undefined });
  }
  document.addEventListener("click", follow);
  document.addEventListener("auxclick", follow);
  // The band above the page takes its background (its own colour; else a gradient's colour at the top), and the canvas
  // around the frame its background's layers: what the browser gives the canvas (the root's, or the body's when the
  // root has none), placed against the root's box. An image goes as its file, fetched here; one that can't be is left out.
  function clear(c: string) {
    return /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
  }
  function solid(cs: CSSStyleDeclaration) {
    const c = cs.backgroundColor;
    if (!clear(c)) return c;
    const img = cs.backgroundImage,
      stops = img && img != "none" && /gradient/.test(img) ? img.match(/rgba?\([^)]*\)/g) : null;
    if (stops) return /^linear-gradient\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0];
    return "";
  }
  function ready() {
    return !!document.body || document.readyState != "loading";
  }
  function colour() {
    if (!ready()) return null;
    let c = solid(getComputedStyle(root));
    if (!c && document.body) c = solid(getComputedStyle(document.body));
    return c;
  }
  function layers(v: string) {
    const out: string[] = [];
    let depth = 0,
      quote = "",
      from = 0;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (quote) {
        if (ch == "\\") i++;
        else if (ch == quote) quote = "";
      } else if (ch == '"' || ch == "'") quote = ch;
      else if (ch == "(") depth++;
      else if (ch == ")") depth--;
      else if (ch == "," && !depth) {
        out.push(v.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push(v.slice(from).trim());
    return out;
  }
  const pictures: Record<string, Blob | null | undefined> = {};
  function picture(u: string) {
    if (u in pictures) return pictures[u];
    pictures[u] = undefined;
    fetch(u)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (b) => {
          pictures[u] = b && /^image\//.test(b.type) && b.size < 4e6 ? b : null;
        },
        () => {
          pictures[u] = null;
        }
      )
      .then(soon);
    return undefined;
  }
  function canvas(): Canvas | null {
    if (!ready()) return null;
    let cs = getComputedStyle(root);
    if (cs.backgroundImage == "none" && clear(cs.backgroundColor) && document.body) cs = getComputedStyle(document.body);
    const c: Canvas = { color: clear(cs.backgroundColor) ? "" : cs.backgroundColor, image: "", files: [], urls: [] };
    if (cs.backgroundImage == "none") return c;
    const images = layers(cs.backgroundImage),
      sizes = layers(cs.backgroundSize),
      repeats = layers(cs.backgroundRepeat);
    let tile = false;
    for (let i = 0; i < images.length; i++) {
      const m = /^url\("((?:[^"\\]|\\.)*)"\)$/.exec(images[i]);
      if (m) {
        const file = picture(m[1]);
        if (file === undefined) return null;
        if (!file) {
          images[i] = "none";
          continue;
        }
        images[i] = 'url("erga-file:' + c.files.length + '")';
        c.files.push(file);
        c.urls!.push(m[1]);
      } else if (!/^(repeating-)?(linear|radial|conic)-gradient\(/.test(images[i])) {
        images[i] = "none";
        continue;
      }
      const size = sizes[i % sizes.length],
        whole = /^(cover|contain|100%( 100%| auto)?|auto( 100%| auto)?)$/.test(size) && !(m && /^auto( auto)?$/.test(size));
      if ((!whole || /^repeating-/.test(images[i])) && repeats[i % repeats.length] != "no-repeat") tile = true;
    }
    if (images.every((v) => v == "none")) return c;
    const r = root.getBoundingClientRect(),
      fixed = /fixed/.test(cs.backgroundAttachment);
    c.image = images.join(", ");
    c.size = cs.backgroundSize;
    c.position = cs.backgroundPosition;
    c.repeat = cs.backgroundRepeat;
    c.tile = tile;
    c.fixed = fixed;
    c.x = fixed ? 0 : r.left + scrollX;
    c.y = fixed ? 0 : r.top + scrollY;
    c.w = fixed ? innerWidth : r.width;
    c.h = fixed ? innerHeight : r.height;
    return c;
  }
  let band: string | null = null,
    canvasSaid = "",
    hash: string | null = null,
    push = false;
  // The page's place (its #hash) behaves as at the top of the tab: a new place (location.hash =, a link to "#x",
  // pushState of a hash) is a new entry in the tab's history (viewer-nav.ts), and never one in the frame's, so Back
  // goes through the page's places. replaceState stays a replace.
  const doc = (u: string | URL) => new URL(String(u), location.href).href.split("#")[0];
  history.pushState = function (state: unknown, title: string, url?: string | URL | null) {
    soon();
    saveSoon();
    if (url == null || doc(url) != doc(location.href)) return History.prototype.pushState.call(this, state, title, url);
    History.prototype.replaceState.call(this, state, title, url);
    push = true;
  };
  history.replaceState = function (state: unknown, title: string, url?: string | URL | null) {
    History.prototype.replaceState.call(this, state, title, url);
    soon();
    saveSoon();
  };
  type Navigate = Event & { navigationType: string; hashChange: boolean; destination: { url: string } };
  (window as Window & { navigation?: EventTarget }).navigation?.addEventListener("navigate", (ev) => {
    const e = ev as Navigate;
    if (e.navigationType != "push" || !e.hashChange || !e.cancelable) return;
    e.preventDefault();
    push = true;
    location.replace(e.destination.url);
  });
  // What the viewer hears of the page: its room, its colour and canvas, where it is scrolled to and its hash. Checked
  // when something can have changed (the events below), at most once a screen frame; a page at rest checks nothing.
  function check() {
    due = false;
    try {
      keepRoom();
      place();
      const c = colour(),
        cv = c != null ? canvas() : null;
      if (cv) {
        const key = JSON.stringify(cv);
        delete cv.urls;
        if (key != canvasSaid) {
          canvasSaid = key;
          tell({ type: "erga-canvas", canvas: cv });
        }
      }
      if (c != null && c !== band) {
        band = c;
        tell({ type: "erga-band", color: c });
      }
      if (c != null) report();
      // The page's place in its own address (#3: agents/document/PROMPT.md, rule 11), for the tab's address.
      if (location.hash != hash) {
        hash = location.hash;
        tell({ type: "erga-hash", hash, push });
      }
      push = false;
      // On the way to where it was scrolled, or its background changing over time: again on the next frame.
      const moving = (el: Element | null) => !!el && el.getAnimations().some((a) => a.playState == "running");
      if (keeping || moving(root) || moving(document.body)) soon();
    } catch {}
  }
  // The page's content, attributes and styles; its size; a stylesheet or a picture that loaded (a load doesn't bubble:
  // heard on its way down); a transition or an animation that starts; the window's size and colour scheme; its hash.
  new MutationObserver(soon).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  new ResizeObserver(soon).observe(root);
  document.addEventListener("readystatechange", soon);
  document.addEventListener("load", soon, true);
  document.addEventListener("transitionrun", soon);
  document.addEventListener("animationstart", soon);
  ["load", "pageshow", "resize", "hashchange", "popstate"].forEach((type) => addEventListener(type, soon));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", soon);
  soon();
  // A file dragged from the computer onto the page never opens in its place (the editor puts it in: its drop). A
  // page that takes the drop itself has already stopped the browser's own.
  function stopFileDrop(e: DragEvent) {
    if (!e.defaultPrevented && e.dataTransfer && e.dataTransfer.types.indexOf("Files") >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    }
  }
  addEventListener("dragover", stopFileDrop);
  addEventListener("drop", stopFileDrop);
  // A copy out of the page (the editor has its own): its text with basic formatting only, never the page's fonts and
  // colours, its links and pictures as they work elsewhere, and Markdown as the plain text (clipboard-html.ts). Not
  // when the page wrote the clipboard itself (it stopped the browser's copy), nor out of a field.
  addEventListener("copy", (e) => {
    const field = document.activeElement;
    if (editing() || e.defaultPrevented || !e.clipboardData || (field && /^(INPUT|TEXTAREA)$/.test(field.tagName))) return;
    let out = null;
    try {
      out = copyOf(window, placeOf(window, C));
    } catch {}
    if (!out) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out.text);
    e.clipboardData.setData("text/html", out.html);
  });
  // An image that fails to load, with a size in its element: its file may be on its way (an upload's element comes
  // before its bytes: libs/text/ui/pending.ts draws it for an editor). It keeps its place meanwhile: an empty picture
  // of that size, by a style of the page's own (never a change of its elements), until it loads after all.
  const boxes = new Map<string, string>();
  let boxSheet: CSSStyleSheet | null = null;
  const sized = (e: Event) => {
    const i = e.target as Element | null;
    if (i?.localName != "img") return;
    const src = i.getAttribute("src"),
      w = Number(i.getAttribute("width")),
      h = Number(i.getAttribute("height"));
    if (!src || /["\\\n]/.test(src)) return;
    if (e.type == "load" ? !boxes.delete(src) : !(w > 0 && h > 0)) return;
    if (e.type == "error")
      boxes.set(
        src,
        `img[src="${src}"] { content: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E"); background: rgba(128, 128, 128, 0.12); border-radius: 4px; }`
      );
    if (!boxSheet) document.adoptedStyleSheets = [...document.adoptedStyleSheets, (boxSheet = new CSSStyleSheet())];
    boxSheet.replaceSync([...boxes.values()].join("\n"));
  };
  // (On the document: an image's load never comes to the window, though its error does.)
  document.addEventListener("error", sized, true);
  document.addEventListener("load", sized, true);
  addEventListener("message", (e) => {
    if (e.source != P || e.origin != C.shell || !e.data) return;
    const type = e.data.type;
    const editor = C.editor;
    if (type == "erga-llm-answer" && llmWaits.has(e.data.id)) {
      const done = llmWaits.get(e.data.id)!;
      llmWaits.delete(e.data.id);
      done(e.data.answer);
    }
    // The viewer's word on editing (libs/text/ui/bridge.ts, EditMode): kept for the editor, which loads on the first edit.
    else if (type == "erga-mode") {
      window.__ergaReader!.mode = e.data;
      if (!view.isConnected) root.append(view);
      keepZoomPlace();
      if (e.data.mode == "edit") {
        load();
        zooms(true);
      }
    }
    // The viewer's word on comments (libs/text/ui/frame.ts hears it too, once it's loaded): kept for the editor.
    else if (type == "erga-comments") window.__ergaReader!.comments = e.data;
    // The viewer's zoom, for a page that zooms itself (window.ergaZoom): `by` times closer, or 0 for its own first view.
    else if (type == "erga-page-zoom" && typeof e.data.by == "number" && Number.isFinite(e.data.by)) {
      const z = (window as Window & { ergaZoom?: unknown }).ergaZoom;
      if (typeof z == "function")
        try {
          z(e.data.by);
        } catch (err) {
          console.error("window.ergaZoom threw:", err);
        }
    }
    // ⌘P in the viewer: this page prints itself.
    else if (type == "erga-print") print();
    // The viewer's frame has the focus: this page takes it (client/inline/viewer-frames.ts).
    else if (type == "erga-focus") focus();
    // The viewer says that stylesheets changed (client/inline/viewer-live.ts): in place, and whether that worked.
    else if (type == "erga-restyle" && Array.isArray(e.data.paths) && typeof e.data.files == "string") {
      const ok = e.data.files.indexOf(location.origin + "/") == 0 && e.data.paths.every((p: unknown) => typeof p == "string");
      void (ok ? restyle(e.data.paths, e.data.files) : Promise.resolve(false)).then((done) =>
        tell({ type: "erga-restyled", id: e.data.id, ok: done })
      );
    } else if (type == "erga-live") {
      if (typeof e.data.id == "number") askTools(e.data as ToolAsk);
    }
    else if (type == "erga-room" && typeof e.data.px == "number" && e.data.px >= 0 && e.data.px <= 400) {
      const side = (n: unknown) => (typeof n == "number" && n >= 0 && n <= 4000 ? n : 0),
        i = e.data.inset || {};
      if (bars != e.data.px) {
        bars = e.data.px;
        zoomRoom(drawn ?? 1, true);
      }
      room.inset = { top: side(i.top), right: side(i.right), bottom: side(i.bottom), left: side(i.left) };
      roomGiven = true;
      dirty();
    }
    // The tab's address got another hash (typed, Back, a link): the page's place follows, and the page gets its
    // hashchange. location.replace adds no entry to the frame's history, and `hash` keeps the frame from saying it back.
    else if (type == "erga-hash" && typeof e.data.hash == "string" && /^(#.{0,999})?$/s.test(e.data.hash)) {
      if (location.hash != e.data.hash) {
        hash = e.data.hash;
        location.replace(e.data.hash || "#");
      }
    }
    // The document's public address, for the links in a copy: on the viewer's origin, as the token names it.
    else if (type == "erga-address" && typeof e.data.address == "string" && e.data.address.indexOf(C.shell + "/") == 0)
      C.address = e.data.address;
    else if (type == "erga-prefetch" && editor && !loading) {
      [editor.src].concat(editor.preload).forEach((href) => {
        const l = document.createElement("link");
        l.rel = "prefetch";
        l.href = href;
        l.crossOrigin = "anonymous";
        l.setAttribute("data-erga", "");
        (document.head || root).append(l);
      });
    }
  });
}
