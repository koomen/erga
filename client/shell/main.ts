// The page editor's shell: the controls around the document's page while editing, and its one word to the editor in
// the page (edit, with the edit key, or view: page-frame.ts). The editor is the page's own (libs/text/ui/frame.ts): it
// joins the document's room itself. The shell joins it too, for what it shows: who's here, the source view (⌘⇧P, with
// its own undo history), the pages and the name, and your agent's events (your agent runs in its own object; its
// conversation is yours alone, and its edits arrive through the room like anyone's).
//
// This file loads the document and wires the shell's parts (client/shell/), which share one object (shell.ts).

import { Collab, type EarlySocket, type SocketEvent } from "../../libs/text/ui/collab";
import { EditorSelection, EditorState } from "@codemirror/state";
import { mountPageFrame } from "./page-frame";
import { isMac, type Keys } from "../common/app-keys";
import { describeProblem } from "./problems";
import { colorFor, files, roomInfo, type Author } from "../../document/content";
import type { Attachment } from "../../shared/attach";
import { isPage, pageUrl } from "../../document/pages";
import { live } from "../live/client";
import { restoredFor } from "../live/restore";
import { applyZoom, catchZoomGestures, clampZoom, zoomFactor, zoomKey, type ZoomBy } from "../common/zoom";
import { fastClick } from "../common/fast-click";
import { asUser } from "../common/tools";
import { mountLayout } from "../agent/layout";
import { BASE, $, store, type Shell } from "./shell";
import { mountEditor } from "./editor";
import { mountNaming } from "./naming";
import { mountRoom } from "./room";
import { mountPeople } from "./people";
import { barEdge } from "../common/quick";
import { mountChrome } from "./chrome";
import { mountSharing } from "./sharing";
import { mountToast } from "./toast";
import { mountViews } from "./views";
import { mountPageRequests } from "./page-requests";
import { awaitHello } from "./opening";
import { editorContext } from "./agent-context";
import { keepOffline, rememberOrigin } from "../common/offline";

declare global {
  interface Window {
    ergaPage?: unknown;
    ergaShell?: { ready(): void };
    /** The document's socket and start, as the page opened them while it parsed (server/pages/viewer.ts, ergaConnect). */
    ergaSocket?: EarlySocket;
    ergaStart?: Promise<ArrayBuffer | null>;
    /** The edit key's answer, asked for with them (null: no answer). */
    ergaKey?: Promise<Response | null>;
  }
}
/** What the editor keeps of itself across a reload for a new release. */
interface EditorKept {
  /** The page it was on: the rest applies only to the same one. */
  path: string;
  /** Where the page was scrolled to (the page opens there again: server/pages/viewer.ts, ?erga-y). */
  scroll: number;
  mode: "text" | "html";
  pages: boolean;
  settings: boolean;
  help: boolean;
  /** Files attached to the agent's next message. */
  files: Attachment[];
  /** Everything the tab held of the room (Collab.held: the source view's edits), merged after the reload in case one hadn't reached it. */
  held?: { epoch: string; update: string };
}
/**
 * The editor's look, kept across a reload for the document's page to open with from its first frame (server/pages/viewer.ts,
 * editingHead): the window's size it was for, the classes on <html> and <body> that place things (of SHELL_HTML,
 * SHELL_BODY), <html>'s style (the layout's variables, layout.ts; the page's colour), and the controls this script fills
 * in as it starts (SHELL_PARTS, by id: the title, the pencil, the avatars), as they were, so none appears late and moves
 * the others. (Only those this script sets afresh as it starts, never adds to: not the agent's conversation.)
 */
interface ShellKept { width: number; height: number; html: string[]; body: string[]; style: string; parts: Record<string, string> }
const SHELL_HTML = ["page-dark", "page-light", "page-white"],
  SHELL_BODY = ["agent-open", "agent-right", "layout-narrow"];
const SHELL_PARTS = ["nav-docs", "people", "btn-docs", "btn-edit", "me"];


(async () => {
  // The start, step by step, as performance marks (erga:main, erga:hello, erga:synced, erga:frame-asked; the frame's
  // erga:frame-js, erga:init, erga:rendered): DevTools' Performance panel and a script can read where the time went.
  performance.mark("erga:main");

  /** The parts of the shell, and what they share: filled in below, as each is ready. */
  const shell = {
    sourceView: null,
    source: null,
    docSettings: null,
    docName: null,
    docKind: "project",
  } as Partial<Shell> as Shell;
  /** Editing (shell.editor: once it's mounted). */
  const editing = () => shell.editor.state.editing;

  // ---------------------------------------------------------------- load

  const frame = $("frame") as HTMLIFrameElement;
  // Who this tab is: whoever's signed in. In local development a tab can be
  // someone else, ?user=Ada (only the dev server honours it), so every
  // request it makes says so. Tabs that are the same person share an agent
  // and its conversation.
  const as = asUser("");
  // What this page kept of itself before it reloaded for a new release, if it did.
  const back = restoredFor<EditorKept>("editor");

  // The document's socket (collab.ts), open since the page began (server/pages/viewer.ts): the room, and this person's
  // events. Its first message says who this tab is and what the document is called (the hello), then comes the room's
  // whole text. Presence, connection news and events before the shell is set up are picked up once it is (`started`).
  let started = false;
  const pending: SocketEvent[] = [];
  const early = window.ergaSocket,
    start =
      window.ergaStart ??
      fetch(`${BASE}/api/start${as}`).then(
        (r) => (r.ok ? r.arrayBuffer() : null),
        () => null
      );
  window.ergaSocket = window.ergaStart = undefined;
  // A start that brought nothing: whether the host says there's no such document (only its 404 says so).
  const missing = start.then(
    async (bytes) =>
      !bytes &&
      (await fetch(`${BASE}/api/start${as}`).then(
        (r) => r.status == 404,
        () => false
      ))
  );
  const collab: Collab = new Collab({
    url: (q) =>
      `${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${asUser(`${BASE}/api/room?${new URLSearchParams({ events: "1", ...Object.fromEntries(q) })}`)}`,
    start,
    early,
    // (Kept in this browser, as this person: the document opens from it with no connection.)
    keep: `${BASE}${as}`,
    onEvent: (msg) => { if (started) shell.room.socketEvent(msg); else pending.push(msg); },
    onRemote: (changes, author) => {
      shell.room.applyRemote(changes);
      // This person's own edit, made on the page (its editor has a replica of its own): the controls fade, as for typing.
      if (started && author?.kind == "person" && author.user == shell.me.user) shell.chrome.hideChrome();
    },
    // (The page's editor makes the page again for a change to another file: frame.ts, refreshSoon.)
    onFiles: () => {},
    onPresence: () => {
      if (started) shell.people.presenceChanged();
    },
    onStatus: (status) => {
      if (started) shell.room.connectionChanged(status);
      // (A key asked for again, if the last request had no answer.)
      if (started && status == "up") shell.editor.send({ type: "online" });
    },
    // The room lost the history this tab holds: the page loads again, and this tab's edits go in as edits (collab.ts, adopt).
    onStale: () => location.reload(),
  });
  // However long the room takes (opening.ts): a slow document isn't a missing one.
  const first = await awaitHello(collab.hello, missing);
  if (!first) return;
  shell.info = first.info;
  shell.docKind = first.tree.kind ?? "project";
  performance.mark("erga:hello");

  // Which of the document's pages the editor holds: the one the viewer shows (the meta erga-page, which
  // client/inline/viewer-nav.ts owns), else the document's own. One room holds them all; this tab edits this one, and
  // goes to another by its address. (Another page opened in place, while editing, changes it: swapPage.) The editor's
  // replica (collab) keeps it from then on; shell.pagePath reads it there.
  const firstPage = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || shell.info.path;
  Object.defineProperty(shell, "pagePath", { get: () => collab.pagePath || firstPage });
  /** A page's address (the editor's, while editing), given its path in the document; the root page's for null. */
  const addressOf = (path: string | null) => {
    const doc = shell.docName?.address ?? document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? "";
    // A path that isn't a page file ("blog/", a folder) is an address as it is: the app finds its page.
    const at = path == null ? doc : isPage(path) ? pageUrl(doc, path) : `${doc}/${path.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/")}`;
    return at.replace(/\/$/, "") + (as ? as + (editing() ? "&edit" : "") : editing() ? "?edit" : "");
  };
  /**
   * Goes to an address, once: the tree (after its own move or delete), the "tree" event and the catch-up on
   * reconnecting (stillHere) may all ask for the same one at once, and a second navigation would cut the first short.
   */
  let goingTo: string | null = null;
  const goTo = (url: string, replace = false) => {
    if (goingTo == url) return;
    goingTo = url;
    // Following this page to where it moved (or went), with the tree open: it stays open there.
    if (replace && !$("pages").hidden) { try { sessionStorage.setItem("erga:pages-open", BASE); } catch { /* private mode */ } }
    // (A navigation that doesn't unload this page, only its hash changing, can be asked for again later.)
    setTimeout(() => { if (goingTo == url) goingTo = null; }, 2000);
    if (replace) location.replace(url); else location.assign(url);
  };
  /**
   * Goes to another of the document's pages: in place while editing (swapPage), else to its address. Only a path inside
   * the document: the page's own script can ask (the frame's "open"), and "../.." would take this tab elsewhere on this site.
   */
  const openPage = (path: string) => {
    if (!path.replace(/\/$/, "").split("/").every((s) => s && s != "." && s != "..")) return;
    if (!swapPage(path)) goTo(addressOf(path));
  };

  // The host attributes your edits and your agent to who you are, so the tab takes that.
  const info = shell.info;
  const me: Author = { user: info.userId, name: info.user, color: colorFor(info.userId), kind: "person", ...(info.avatar ? { avatar: info.avatar } : {}) };
  // Your documents to go back to, as whoever this tab is; the wordmark goes there too.
  $("nav-back").hidden = false;
  ($("nav-back") as HTMLAnchorElement).href = `/docs${as}`;
  ($("btn-docs") as HTMLAnchorElement).href = `/docs${as}`;
  ($("nav-brand") as HTMLAnchorElement).href = `/docs${as}`;
  // The editor's own page actions (client/editor.html, .edit-group) open out of the pencil while editing and close back into it: they
  // clip sideways while they move, and not once they're open and still (settled), so their tooltips reach past the group.
  const editGroup = $("edit-group"), body = document.body;
  const groupOpen = () => body.classList.contains("erga-editing") && body.classList.contains("erga-editor-ready") && !body.classList.contains("erga-closing");
  // (getAnimations makes the transition the class change starts, if one does.)
  const moving = () => editGroup.getAnimations().some((a) => a instanceof CSSTransition && a.transitionProperty == "grid-template-columns");
  const syncGroup = () => {
    const open = groupOpen();
    editGroup.inert = !open;
    // Open with no transition (from the first frame, with reduced motion, reloaded in the editor: erga-restored): settled at once.
    if (!open || !editGroup.classList.contains("settled")) editGroup.classList.toggle("settled", open && !moving());
  };
  // (Or stopped on the way, open: a style change took the transition away.)
  for (const type of ["transitionend", "transitioncancel"] as const)
    editGroup.addEventListener(type, (e) => {
      if (e.target == editGroup && e.propertyName == "grid-template-columns" && groupOpen()) editGroup.classList.add("settled");
    });
  new MutationObserver(syncGroup).observe(body, { attributes: true, attributeFilter: ["class"] });
  syncGroup();
  // The title in the breadcrumbs takes the room left of the controls (on a phone, little), and ends in an ellipsis.
  const navRoom = () => {
    const title = $("doc-title"),
      top = document.querySelector<HTMLElement>(".chrome-top");
    if (!top || title.hidden) return;
    title.style.setProperty("--room", `${Math.max(0, barEdge(top, $("people")) - title.getBoundingClientRect().left - 8)}px`);
    tighten(top);
  };
  // On a phone at rest the others' stack takes room from the breadcrumbs: their middle, Documents, goes first (.tight),
  // then the title ends in an ellipsis (client/styles/editor.css). Erga's logo stays whole. (Open, the quick actions
  // hide the stack, and the breadcrumbs slide as before: client/common/quick.ts.)
  const phone = matchMedia("(max-width: 759.98px)");
  let backWidth = 0;
  function tighten(top: HTMLElement) {
    const nav = $("nav-docs"),
      back = $("nav-back");
    if (body.classList.contains("quick-open")) return;
    if (!phone.matches || back.hidden) return void nav.classList.remove("tight");
    const tight = nav.classList.contains("tight");
    if (!tight) backWidth = back.offsetWidth + (back.nextElementSibling as HTMLElement).offsetWidth;
    const parts = [...nav.children].reduce((w, el) => w + (el as HTMLElement).offsetWidth, 0) + 16 + (tight ? backWidth : 0);
    nav.classList.toggle("tight", parts > barEdge(top, $("people")) - nav.getBoundingClientRect().left - 8);
  }
  phone.addEventListener("change", navRoom);
  new ResizeObserver(navRoom).observe(document.querySelector(".chrome-top")!);
  new ResizeObserver(navRoom).observe($("people"));
  new ResizeObserver(navRoom).observe($("nav-docs"));
  addEventListener("resize", navRoom);
  $("nav-docs").addEventListener("transitionend", navRoom);
  /** The host's endpoints, as this person. */
  const api = (path: string) => `${BASE}${path}${as}`;

  // Into the room as who this tab is, and the document's text (on its way already, or here). Its presence is the page
  // editor's (frame.ts: its own replica), or the source view's while that's open (views.ts).
  collab.join(me, firstPage, null);
  try {
    await collab.ready();
    performance.mark("erga:synced");
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Couldn't join the document: ${(e as Error).message}.</p><p>Is the server still running?</p></div>`;
    window.ergaShell?.ready();
    return;
  }
  document.title = document.documentElement.dataset.pageTitle || (info.docName?.title ?? shell.pagePath);
  // Someone edits the source (the lock: document/room.ts): the source view gives way to the page, which says so and is
  // read-only meanwhile (libs/text/ui/frame.ts).
  roomInfo(collab.doc).observe(() => {
    if (roomInfo(collab.doc).get("lock") && shell.editor.state.view != "text") shell.views.setMode("text");
  });

  /**
   * The caret in the text, and the text: the source view's while it has them, else the page's: its editor's presence in
   * the room says where it is (it carries this tab's mark, `tab`).
   */
  const tab = Math.random().toString(36).slice(2, 10);
  const pageSelection = () => {
    const mine = collab.others().find((p) => (p as { tab?: unknown }).tab == tab);
    const at = mine && collab.positions(mine);
    return at ? EditorSelection.single(at.anchor, at.head ?? at.anchor) : EditorSelection.single(0);
  };
  const currentSelection = () => (shell.sourceView ? shell.sourceView.state.selection : pageSelection());
  const currentState = () => shell.sourceView?.state ?? EditorState.create({ doc: collab.current(), selection: currentSelection() });
  Object.assign(shell, {
    collab,
    me,
    as,
    api,
    frame,
    docId: BASE.replace(/^\/d\//, ""),
    addressOf,
    goTo,
    openPage,
    swapPage,
    currentSelection,
    currentState,
  });
  // Editing, as the viewer says (client/inline/viewer-edit-boot.ts: it tells setEditing from now on), and full screen.
  shell.editor = mountEditor(
    shell,
    document.body.classList.contains("erga-editing"),
    document.documentElement.classList.contains("erga-full")
  );
  shell.naming = mountNaming(shell);
  shell.room = mountRoom(shell);
  shell.people = mountPeople(shell);
  shell.chrome = mountChrome(shell);
  shell.sharing = mountSharing(shell);
  shell.toast = mountToast(shell);
  // Focusing or using this tab makes it the one you're shown by. Focus
  // lands on the frame's window when the caret is in the page.
  const activate = () => collab.activate();
  for (const type of ["focus", "pointerdown", "keydown"]) window.addEventListener(type, activate, true);

  // ---------------------------------------------------------------- the page editor

  // The page editor runs in the page, in the frame, on the document's own origin: under the address the app gave
  // this page (with the token that opens the document's files there).
  const pagesUrl = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]')?.content ?? "";
  const pagesOrigin = new URL(pagesUrl, location.href).origin;
  const page = (shell.page = mountPageFrame({
    frame,
    origin: pagesOrigin,
    files: pagesUrl,
    told: () => shell.editor.state.told,
    edit: (key) => ({ doc: `${location.origin}${BASE}`, key, me, path: shell.pagePath, tab }),
    onKey: (keys) => {
      appShortcut(keys, true);
    },
    // A notice the agent can fix (the editor's, through the page's problem watch), or the page's own problem: each once,
    // until someone asks the agent to fix it (if it's still broken after, it says so again).
    onProblem: (raw, base) => {
      if (raw.kind == "notice") {
        shell.toast.explain(raw.message, raw.fix, undefined, raw.draft);
        return;
      }
      const p = describeProblem(raw, base, pagesOrigin);
      if (!p || shell.room.shownProblems.has(p.key)) return;
      shell.room.shownProblems.add(p.key);
      shell.toast.reportProblem(p.message, p.fix, p.key);
    },
    onPointer: (x, y) => shell.chrome.pointerMoved(new MouseEvent("mousemove", { clientX: x, clientY: y })),
    // A press on the page: as one anywhere else in the shell would.
    onPress: () => {
      shell.toast.dismissExplanation(null);
      activate();
      // (Also a card that's waiting for what it shows, to open.)
      shell.chrome.closeCards();
      shell.people.stackPeople();
      shell.chrome.toggleQuick(false);
    },
    onActivity: (kind) => {
      activate();
      if (kind == "key") {
        live((l) => l.activity());
        shell.chrome.keyPressed();
        shell.toast.dismissExplanation(null);
      }
    },
    onOpen: (path) => openPage(path),
    onZoom: (by) => zoomPage(by),
    onZooms: () => syncZoom(),
  }));
  // This page and its files, kept in this browser for a reload with no connection (client/common/offline.ts).
  void keepOffline(location.href);
  rememberOrigin(pagesOrigin);
  // The page's editor starts, if it should (its edit key: client/shell/editor.ts).
  shell.editor.send({ type: "tick" });
  if (editing()) {
    // The page has the focus, for its editor (nothing else in the tab has it yet).
    if (!document.activeElement || document.activeElement == document.body) page.focus();
  }
  performance.mark("erga:frame-asked");
  // A file dropped on the shell around the page (not the agent's panel, which takes it) never opens in its place.
  for (const type of ["dragover", "drop"] as const)
    window.addEventListener(type, (e) => {
      if (!e.defaultPrevented && e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
      }
    });

  // ---------------------------------------------------------------- zoom

  // Zooming in the editor zooms the page, never the controls or the agent (zoom.ts): the keys, a pinch and ctrl with
  // the wheel, here in the shell or on the page (the frame sends them: onKey, onZoom). Each document keeps its level
  // on this browser. Viewing, the browser zooms the window as it always does. A page that zooms itself (window.ergaZoom:
  // a canvas's camera, with no limits of ours) gets them instead, and is drawn at 100%.
  // Zoomed, the bar shows the level (#btn-zoom); a click on it goes back to 100%, as ⌘0 (Ctrl+0) does.
  const ZOOM_KEY = `erga:zoom:v1:${shell.docId}`;
  let zoomLevel = clampZoom(Number(store.get(ZOOM_KEY) ?? 1));
  const zoomBtn = $("btn-zoom");
  zoomBtn.dataset.tip = `Back to 100% (${isMac ? "⌘0" : "Ctrl+0"})`;
  function syncZoom(on = editing()) {
    const level = on && !page.zoomsItself ? zoomLevel : 1,
      pct = `${Math.round(level * 100)}%`;
    page.setZoom(level);
    zoomBtn.hidden = level == 1;
    zoomBtn.textContent = pct;
    zoomBtn.setAttribute("aria-label", `Zoom ${pct}: back to 100%`);
  }
  syncZoom();
  zoomBtn.addEventListener("click", () => {
    setZoomLevel(1);
    page.focus();
  });
  function setZoomLevel(level: number) {
    zoomLevel = clampZoom(level);
    syncZoom();
    if (zoomLevel == 1) { try { localStorage.removeItem(ZOOM_KEY); } catch {} }
    else store.set(ZOOM_KEY, String(Math.round(zoomLevel * 1000) / 1000));
    shell.toast.flash(`Zoom ${Math.round(zoomLevel * 100)}%`);
  }
  function zoomPage(by: ZoomBy) {
    if (!editing()) return;
    if (page.zoomsItself) page.zoomItself(zoomFactor(by));
    else setZoomLevel(applyZoom(zoomLevel, by));
  }
  catchZoomGestures(window, zoomPage, editing);

  shell.views = mountViews(shell);
  shell.requests = mountPageRequests(shell);
  // Your agent (server/pages/agent.ts: the page has it, viewing and editing): here, where it sits around the page, and how wide.
  mountLayout($("agent"), $("agent").querySelector<HTMLElement>(".agent-head")!);
  const agentPanel = () => window.ergaAgentPanel;

  // ---------------------------------------------------------------- shortcuts & wiring

  /** `fromPage`: the key was pressed in the page (the frame sent it). */
  function appShortcut(e: Keys, fromPage = false): boolean {
    if (!editing()) return false;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") {
      shell.views.toggleSource();
      return true;
    }
    // (In the shell itself, the agent's own script hears ⌘J: client/inline/agent-toggle.ts.)
    if (fromPage && mod && !e.shiftKey && key == "j") {
      window.ergaAgent?.show(!window.ergaAgent.open());
      return true;
    }
    if (mod && !e.shiftKey && key == "k") {
      window.ergaQuickSearch?.();
      return true;
    }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) {
      shell.chrome.toggleHelp();
      return true;
    }
    const zoom = zoomKey(e, isMac);
    if (zoom) { if (zoom == "reset") { if (page.zoomsItself) page.zoomItself(0); else setZoomLevel(1); } else zoomPage({ step: zoom }); return true; }
    if (mod && !e.shiftKey && key == "s") { shell.toast.flash(shell.room.connected ? "Saved: edits go to disk as you type" : "Offline: edits sync when the host is back", 2200); return true; }
    if (e.key == "Escape" && shell.toast.closeProblem()) return true;
    if (e.key == "Escape") {
      // Naming something in the pages tree, a question in it or one of its menus: Escape is theirs to cancel.
      if (document.activeElement?.closest(".et-input, .et-row.confirm, .et-menu")) return false;
      if (shell.docSettings?.escape()) {
        /* its menu, or itself, closed */
      } else if (!$("account").hidden) {
        shell.people.toggleAccount(false);
        shell.chrome.toggleQuick(false);
        shell.people.accountBtn?.focus();
      } else if (!$("help").hidden) shell.chrome.toggleHelp(false);
      else if (!$("naming").hidden) shell.naming.toggleNaming(false);
      else if (!$("pages").hidden) { shell.naming.togglePages(false); $("doc-title").focus(); }
      // (Its box had the focus: the caret goes back to the text.)
      else if (!$("sharing").hidden) {
        shell.sharing.toggleSharing(false);
        if (shell.editor.state.view == "text") page.focus();
      } else if (shell.editor.state.view != "text") shell.views.setMode("text");
      // Nothing else to close: the controls fade (in the page, the editor takes the focus off the text itself).
      else shell.chrome.hideChrome();
      return true;
    }
    return false;
  }
  // (Not the quick search's keys: they're its own, client/common/quick-search.ts.)
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.target as Element).closest?.(".erga-qs") && appShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // Full screen (client/inline/viewer-full.ts) is for showing the page, not editing it: the page, not its source, and the
  // editor in it stops, so the page's own keys work (a deck's arrows); it starts again after.
  addEventListener("erga-full", (e) => {
    const on = (e as CustomEvent<{ on: boolean }>).detail.on;
    if (on && shell.editor.state.view != "text") shell.views.setMode("text");
    shell.editor.send({ type: "full", on });
  });

  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  // The controls act as the press starts (client/common/fast-click.ts): the top bar's, the title, the agent's open and
  // close. The agent's undo and reset keep their click. (The account corner's button, in the same bar, has its own:
  // client/inline/account-menu.ts. Two would click it twice on one press, and its menu would open and close.)
  fastClick(document, `.chrome-top button:not(.erga-account-btn), #doc-title, #agent-fab, #agent-close`);
  document.addEventListener("mousedown", (e) => {
    const at = e.target as Node;
    if (!$("help").hidden && !$("help").contains(at) && !$("btn-help").contains(at)) shell.chrome.toggleHelp(false);
    if (!$("sharing").hidden && !$("sharing").contains(at) && !$("btn-share").contains(at)) shell.sharing.toggleSharing(false);
    if (!$("account").hidden && !$("account").contains(at) && !shell.people.accountBtn?.contains(at)) shell.people.toggleAccount(false);
  });

  // Out of the editor and back in, without leaving the page: the
  // controls go out of sight, with anything open among them, and come back as they were. Your agent stays as it is:
  // it's the page's, viewing and editing alike (server/pages/agent.ts).
  function setEditing(on: boolean) {
    syncZoom(on);
    // The editor in the page starts or stops (on the way out the page stays as it was).
    shell.editor.send({ type: "editing", on });
    if (on) {
      page.focus();
      return;
    }
    if (shell.editor.state.view != "text") shell.views.setMode("text");
    shell.chrome.closeCards();
    shell.chrome.toggleQuick(false);
    shell.chrome.showChrome();
  }
  if (!editing()) setEditing(false);

  // ---------------------------------------------------------------- a new release

  // The page reloads by itself for a new release of the editor, once the room has this tab's edits,
  // never while you drag or compose or speak, and comes back as it was: the page and its caret, where it was
  // scrolled to, the view (page or source), the cards that were open, the files attached to the next message.
  // (The agent's draft, the pane and its layout are kept in this browser anyway.) A reload by hand comes back
  // the same way, and so does the editor's look: the document's page opens with it from its first frame,
  // before this script has loaded.
  live((l) => {
    l.flush(() => collab.flushed());
    l.hold(() => (agentPanel()?.voice ? "voice mode is on" : agentPanel()?.files.reading ? "files are being read" : null));
    l.keep(
      "editor",
      (): EditorKept => ({
        path: shell.pagePath,
        scroll: shell.editor.state.view == "text" ? page.scrollY : 0,
        mode: shell.editor.state.view,
        pages: !$("pages").hidden,
        settings: !!shell.docSettings?.isOpen(),
        help: !$("help").hidden,
        files: agentPanel()?.files.files ?? [],
        held: collab.held() ?? undefined,
      }),
      { everyReload: true }
    );
    l.keep("shell", (): ShellKept | null => {
        if (!editing() || shell.editor.state.view != "text") return null;
      const root = document.documentElement;
      return {
        width: innerWidth, height: innerHeight,
        html: SHELL_HTML.filter((c) => root.classList.contains(c)), body: SHELL_BODY.filter((c) => document.body.classList.contains(c)),
        style: root.style.cssText,
        parts: Object.fromEntries(SHELL_PARTS.map((id) => [id, document.getElementById(id)?.outerHTML ?? ""]).filter(([, html]) => html)),
      };
    }, { everyReload: true });
    // The first look at the editor's files: their builds, as it starts.
    l.check("the editor started");
  });
  if (back && back.path == shell.pagePath) {
    // Any edit that hadn't reached the room before the reload goes now (merged: nothing changes if it had).
    collab.merge(back.held);
    if (back.mode && back.mode != "text") shell.views.setMode(back.mode);
    if (back.pages) requestAnimationFrame(() => shell.naming.togglePages(true));
    if (back.settings) void shell.chrome.loadSettings().then((s) => s?.toggle(true));
    if (back.help) shell.chrome.toggleHelp(true);
    if (back.files?.length) agentPanel()?.files.restore(back.files);
  }
  // ---------------------------------------------------------------- another page

  // Another of the document's pages, opened while editing (the pages card, a link on the page, your agent's open_page),
  // opens in place: the room holds every page already, so the frame goes to the new page (page-frame.ts, load), whose
  // editor starts from its text. The frame's address changes in place (no entry in the tab's
  // history: Back would go through it first). The controls, the agent's pane and its conversation, and the cards stay as they are. The
  // address changes as it would have (a new entry in the history), and Back and Forward go between the pages the same way.
  // Anything else (viewing, a page the room hasn't got yet, a folder's address) is a page load.
  let swaps: Promise<void> = Promise.resolve();
  /** Opens `path` in place, if it can (else false: the caller loads its address). `push`: a new entry in the history. */
  function swapPage(path: string, push = true): boolean {
    if (!started || !editing() || !shell.docName?.address || !files(collab.doc).get(path)) return false;
    swaps = swaps.then(() => swapTo(path, push)).catch((e) => { console.error(e); location.assign(addressOf(path)); });
    return true;
  }
  async function swapTo(path: string, push: boolean) {
    if (path == shell.pagePath) return;
    // The page's source view gives the text back to the page first (the new page opens on the page itself).
    if (shell.editor.state.view != "text") {
      shell.views.setMode("text");
      await shell.views.switched();
    }
    const text = collab.setPath(path);
    if (text == null) { goTo(addressOf(path)); return; }
    page.load(path);
    // What was said of the last page was of it alone.
    shell.room.shownProblems.clear();
    shell.toast.clearProblems();
    shell.naming.togglePages(false);
    // The new page has the focus for its editor, unless the agent's box has it.
    if (!$("agent").contains(document.activeElement)) page.focus();
    // A new entry in the history, then the page shown (viewer-nav.ts: the address and the entry follow).
    if (push) window.history.pushState({ ...window.history.state, ergaPage: path }, "", addressOf(path));
    window.ergaShowPage(path);
    shell.naming.tree()?.setCurrent(path);
    shell.naming.viewHref(shell.docName!.address);
    shell.people.queueCursor();
    shell.people.queuePeers();
  }
  // Each entry in the history says which page it is (the pencil's and the viewer's say it as they're made:
  // viewer-edit-boot.ts, viewer-nav.ts). Viewing, the viewer follows Back and Forward alone.
  const stamp = () => { if (typeof window.history.state?.ergaPage != "string") window.history.replaceState({ ...window.history.state, ergaPage: shell.pagePath }, ""); };
  stamp();
  addEventListener("popstate", () => {
    if (!editing()) return;
    const to = window.history.state?.ergaPage;
    if (typeof to == "string") { if (to != shell.pagePath && !swapPage(to, false)) location.reload(); return; }
    // An entry that doesn't say (made before this page loaded): this page, unless its address is another's.
    if (shell.docName?.address && location.pathname != "/" && location.pathname != pageUrl(shell.docName.address, shell.pagePath)) location.reload();
  });

  started = true;
  shell.people.presenceChanged();
  shell.room.connectionChanged(collab.status);
  // What came on the socket while the shell was being set up (its hello, the agent's state), in order.
  for (const m of pending.splice(0)) shell.room.socketEvent(m);
  window.ergaPage = {
    page,
    collab,
    toggleSource: shell.views.toggleSource,
    agentContext: () => editorContext(shell),
    setEditing,
    get pagePath() {
      return shell.pagePath;
    },
    get state() {
      return currentState();
    },
  };
  window.ergaShell?.ready();
})();
