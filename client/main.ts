// The page editor's shell: joins the document's room (its Durable Object,
// cloudflare/document-object.ts) as one participant among others, renders the document in the
// page editor, sends every edit to the room as you type and applies everyone
// else's (people and their agents) as they land, shows who's here and where
// their carets are, and offers quiet chrome:
// shortcuts and a toggle to the source, which shares the document state and
// undo history. It also hosts the agent panel (⌘J): your agent runs in the
// host, its conversation is yours alone (your other tabs show it too), and
// its edits arrive through the room like anyone's.
//
// This file loads the document and wires the shell's parts (client/shell/), which share one object (shell.ts).

import type { SocketEvent } from "./collab";
import { Collab } from "./collab";
import type { MarkAuthor } from "./editor";
import { RemotePage } from "./remote";
import type { Backdrop, Keys } from "./bridge";
import { colorFor, files, type Author } from "../document/content";
import type { Attachment } from "../shared/attach";
import { BASE } from "./base";
import { isPage, pageUrl } from "../document/pages";
import { live } from "./live-client";
import { restoredFor } from "./restore";
import { applyZoom, catchZoomGestures, clampZoom, zoomFactor, zoomKey, type ZoomBy } from "./zoom";
import { fastClick } from "../shared/fast-click";
import { $, editing, isMac, store, type Shell } from "./shell/shell";
import { mountNaming } from "./shell/naming";
import { mountRoom } from "./shell/room";
import { mountPeople } from "./shell/people";
import { mountChrome } from "./shell/chrome";
import { mountSharing } from "./shell/sharing";
import { mountToast } from "./shell/toast";
import { mountStyleBar } from "./shell/style-bar";
import { mountViews } from "./shell/views";
import { mountPageRequests } from "./shell/page-requests";
import { mountAgent } from "./shell/agent";
import { mountPause } from "./shell/pause";

declare global {
  interface Window { ergaPage?: unknown; ergaShell?: { ready(): void; loadedEditing?: boolean } }
}
/** What the editor keeps of itself across a reload for a new release. */
interface EditorKept {
  /** The page it was on: the rest applies only to the same one. */
  path: string;
  selection: { anchor: number; head: number };
  scroll: number;
  mode: "text" | "html";
  pages: boolean;
  settings: boolean;
  help: boolean;
  /** Files attached to the agent's next message. */
  files: Attachment[];
  /** Everything the tab held of the room (Collab.held), merged after the reload in case an edit hadn't reached it. */
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
const SHELL_HTML = ["page-dark", "page-light", "erga-faded"], SHELL_BODY = ["agent-open", "agent-right", "layout-narrow"];
const SHELL_PARTS = ["nav-docs", "people", "btn-clone", "btn-edit", "me", "agent-model", "agent-input", "agent-voice", "agent-send"];


(async () => {
  // The start, step by step, as performance marks (erga:main, erga:hello, erga:synced, erga:frame-asked; the frame's
  // erga:frame-js, erga:init, erga:rendered): DevTools' Performance panel and a script can read where the time went.
  performance.mark("erga:main");

  const KEYS = { settings: "erga:settings:v1" };
  const settings: { track: boolean; agent: boolean } = { track: false, agent: true, ...store.json(KEYS.settings) };
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));
  /** The parts of the shell, and what they share: filled in below, as each is ready. */
  const shell = { settings, saveSettings, mode: "text", sourceView: null, source: null, docSettings: null, docName: null, docKind: "project" } as Partial<Shell> as Shell;

  // ---------------------------------------------------------------- colours

  // There is no dark mode: the documents shown here are rendered as their
  // authors made them, and most don't support one. The shell is always
  // light (data-theme="light" pins style.css). The
  // floating cards are the editor's light cards, or its dark ones on a dark
  // page: never a colour of the page's. The header's text and
  // icons turn light on a dark page too.
  // The shell paints its canvas with the page's background colour (and its
  // gradient or image over that: server/pages/viewer.ts, BAND_BOOT), so opening the agent
  // never reveals a strip of a different colour. The page's background is its
  // root's, or its body's when the root has none, as the browser itself would
  // paint it. The page reports its colour: for one that's only a
  // gradient, the gradient's colour at the top.
  // The first one is what the agent's opening uncovers on the way into the editor (openAgentOnEntry), so that waits for it.
  // It lands at once, as every later one does: the band above the page shows it too, and must keep
  // up with the page.
  let backdropKnown!: () => void;
  const backdropReady = new Promise<void>((done) => (backdropKnown = done));
  let backdropSeen = false;
  function applyBackdrop(b: Backdrop) {
    if (!shell.info) return;
    const first = !backdropSeen;
    backdropSeen = true;
    const color = b.color && CSS.supports("color", b.color) ? b.color : "#ffffff";
    const root = document.documentElement.style;
    if (color) root.setProperty("--page-bg", color); else root.removeProperty("--page-bg");
    const rgb = (color || getComputedStyle(document.documentElement).getPropertyValue("--bg")).match(/[\d.]+/g)?.map(Number);
    const dark = !!rgb && rgb.length >= 3 && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
    document.documentElement.classList.toggle("page-dark", !!color && dark);
    document.documentElement.classList.toggle("page-light", !!color && !dark);
    // Remembered so the next load paints it before the page arrives, not white first.
    store.set("erga:backdrop:v1", JSON.stringify({ bg: color, tone: color ? (dark ? "page-dark" : "page-light") : "" }));
    if (first) backdropKnown();
  }

  // ---------------------------------------------------------------- load

  const frame = $("frame") as HTMLIFrameElement;
  // Who this tab is: whoever's signed in. In local development a tab can be
  // someone else, ?user=Ada (only the dev server honours it), so every
  // request it makes says so. Tabs that are the same person share an agent
  // and its conversation.
  const asked = new URLSearchParams(location.search).get("user")?.trim();
  const as = asked ? `?user=${encodeURIComponent(asked)}` : "";
  // What this page kept of itself before it reloaded for a new release, if it did.
  const back = restoredFor<EditorKept>("editor");

  // The document's socket (collab.ts), open since the page began (server/pages/viewer.ts): the room, and this person's
  // events. Its first message says who this tab is and what the document is called (the hello), then comes the room's
  // whole text. Presence, connection news and events before the shell is set up are picked up once it is (`started`).
  let started = false;
  const pending: SocketEvent[] = [];
  const collab: Collab = new Collab({
    onEvent: (msg) => { if (started) shell.room.socketEvent(msg); else pending.push(msg); },
    onRemote: (changes, author) => shell.room.applyRemote(changes, author),
    // Another page of the document is no part of this one (a page frames another only rarely): its edits leave this one be.
    onFiles: (paths) => { if (paths.some((p) => !/\.(html?|md)$/i.test(p))) shell.room.needRefresh(); },
    onPresence: () => { if (started) shell.people.presenceChanged(); },
    onStatus: (connected) => { if (started) shell.room.connectionChanged(connected); },
    onStale: () => {
      const w = $("welcome");
      w.hidden = false;
      w.classList.add("blocking");
      w.innerHTML = `<div><p>This page is out of date: the editor's host restarted without its saved history, so edits from this tab can't be merged safely.</p><p><button type="button" id="stale-reload">Reload</button></p></div>`;
      $("stale-reload").addEventListener("click", () => location.reload());
    },
  }, asked ? { user: asked } : {});
  try {
    const first = await Promise.race([collab.hello, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the room didn't answer")), 8000))]);
    shell.info = first.info;
    shell.docKind = first.tree.kind ?? "project";
    performance.mark("erga:hello");
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Nothing to edit here.</p><p>Open one from <a href="/docs">your documents</a>.</p></div>`;
    window.ergaShell?.ready();
    return;
  }

  // Which of the document's pages this is: the one the address named (the front door says, erga-page),
  // else the document's own. One room holds them all; this tab edits this one, and goes to another by its address.
  // (Another page opened in place, while editing, changes it: swapPage.)
  shell.pagePath = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || shell.info.path;
  shell.info = { ...shell.info, path: shell.pagePath, name: shell.pagePath };
  /** A page's address (the editor's, while editing), given its path in the document; the root page's for null. */
  const addressOf = (path: string | null) => {
    const doc = shell.docName?.address ?? document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? "";
    // A path that isn't a page file ("blog/", a folder) is an address as it is: the front door finds its page.
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
  const self: MarkAuthor = { name: me.name, color: me.color };
  // Your documents to go back to (test people have none), as whoever this tab is.
  $("nav-back").hidden = me.user.startsWith("test-");
  ($("nav-back") as HTMLAnchorElement).href = `/docs${as}`;
  ($("nav-brand") as HTMLAnchorElement).href = `/${as}`;
  // Clone, as the viewer's: the same address.
  const viewerClone = document.querySelector<HTMLAnchorElement>(".erga-clone-button");
  if (viewerClone) { ($("btn-clone") as HTMLAnchorElement).href = viewerClone.href; $("btn-clone").hidden = false; }
  // The editor's own page actions (client/editor.html, .edit-group) open out of the pencil while editing and close back into it: they
  // clip sideways while they move, and not once they're open and still (settled), so their tooltips reach past the group.
  const editGroup = $("edit-group"), body = document.body;
  const groupOpen = () => body.classList.contains("erga-editing") && body.classList.contains("erga-editor-ready") && !body.classList.contains("erga-closing");
  const syncGroup = () => {
    const open = groupOpen();
    editGroup.inert = !open;
    // (Open from the first frame, reloaded in the editor (server/pages/viewer.ts, erga-restored): settled at once.)
    if (!open || !editGroup.classList.contains("settled")) editGroup.classList.toggle("settled", open && (matchMedia("(prefers-reduced-motion: reduce)").matches || body.classList.contains("erga-restored")));
  };
  editGroup.addEventListener("transitionend", (e) => { if (e.target == editGroup && e.propertyName == "grid-template-columns" && groupOpen()) editGroup.classList.add("settled"); });
  new MutationObserver(syncGroup).observe(body, { attributes: true, attributeFilter: ["class"] });
  syncGroup();
  // The title in the breadcrumbs takes the room left of the controls (on a phone, little), and ends in an ellipsis.
  const navRoom = () => {
    const title = $("doc-title"), top = document.querySelector(".chrome-top");
    if (!top || title.hidden) return;
    title.style.setProperty("--room", `${Math.max(0, top.getBoundingClientRect().left - title.getBoundingClientRect().left - 8)}px`);
  };
  new ResizeObserver(navRoom).observe(document.querySelector(".chrome-top")!);
  new ResizeObserver(navRoom).observe($("nav-docs"));
  addEventListener("resize", navRoom);
  $("nav-docs").addEventListener("transitionend", navRoom);
  /** The host's endpoints, as this person. */
  const api = (path: string) => `${BASE}${path}${as}`;

  // Into the room as who this tab is, and the document's text (on its way already, or here).
  collab.join(me, info.path);
  let initialText: string;
  try {
    initialText = await collab.ready();
    performance.mark("erga:synced");
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Couldn't join the document: ${(e as Error).message}.</p><p>Is the server still running?</p></div>`;
    window.ergaShell?.ready();
    return;
  }
  document.title = info.docName?.title ?? info.name;

  const currentState = () => (shell.sourceView ? shell.sourceView.state : shell.page.state);
  Object.assign(shell, { collab, me, self, as, api, frame, docId: BASE.replace(/^\/d\//, ""), addressOf, goTo, openPage, swapPage, currentState });
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

  // The page editor runs in the page, in the frame, on the document's own origin: under the address the front door gave
  // this page (with the token that opens the document's files there).
  const pagesUrl = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]')?.content ?? "";
  const page = shell.page = new RemotePage({
    frame,
    origin: new URL(pagesUrl, location.href).origin,
    files: pagesUrl,
    text: initialText,
    self,
    tracking: settings.track,
    ...(back && back.path == shell.pagePath ? { selection: back.selection, scroll: back.scroll } : {}),
    onLocal(changes) {
      collab.push(changes);
      shell.chrome.hideChrome();
      shell.people.queueCursor();
      shell.people.queuePeers();
    },
    onSelection() { shell.people.queueCursor(); shell.people.queuePeers(); shell.fmt.queueFmt(); },
    onUpdate(rendered) {
      syncZoom();
      if (rendered) {
        shell.pause.syncPause();
        const t = page.title().slice(0, 200);
        document.title = shell.docName?.title ?? (t ? `${t} · ${shell.info.name}` : shell.info.name);
        // Not out of the agent panel or an open card (the pages and their menus, the title and address): the page rendering again mustn't take focus from them.
        if (!$("agent").contains(document.activeElement) && !document.activeElement?.closest(".help, .et-menu") && shell.mode == "text") page.focus();
        shell.people.queuePeers();
      }
      shell.fmt.queueFmt();
    },
    onKey: (keys) => { appShortcut(keys); },
    onNotice: (m, fix) => shell.toast.explain(m, fix),
    // Each problem once, until someone asks the agent to fix it (if it's still broken after, it says so again).
    onProblem: (p) => { if (shell.room.shownProblems.has(p.key)) return; shell.room.shownProblems.add(p.key); shell.toast.reportProblem(p.message, p.fix, p.key); },
    onPointer: (kind, x, y) => {
      if (kind == "move") { shell.chrome.pointerMoved(new MouseEvent("mousemove", { clientX: x, clientY: y })); return; }
      if (kind == "up") { shell.fmt.released(); return; }
      // A click on the page: as one anywhere else in the shell would.
      shell.toast.dismissExplanation(null);
      activate();
      shell.fmt.pressed();
      if (!$("help").hidden) shell.chrome.toggleHelp(false);
      if (!$("naming").hidden) shell.naming.toggleNaming(false);
      if (!$("pages").hidden) shell.naming.togglePages(false);
      if (!$("sharing").hidden) shell.sharing.toggleSharing(false);
      shell.pause.showPauseCard(false);
    },
    onActivity: (kind) => {
      activate();
      if (kind == "key") live((l) => l.activity());
      if (kind == "key") { shell.chrome.keyPressed(); shell.toast.dismissExplanation(null); }
    },
    onBackdrop: (b) => applyBackdrop(b),
    onStale: () => shell.room.needRefresh(),
    onOpen: (path) => openPage(path),
    flushed: () => collab.flushed(),
    onZoom: (by) => zoomPage(by),
  });
  if (editing()) page.start();
  performance.mark("erga:frame-asked");

  // ---------------------------------------------------------------- zoom

  // Zooming in the editor zooms the page, never the controls or the agent (zoom.ts): the keys, a pinch and ctrl with
  // the wheel, here in the shell or on the page (the frame sends them: onKey, onZoom). Each document keeps its level
  // on this browser. Viewing, the browser zooms the window as it always does. A page that zooms itself (window.ergaZoom:
  // a canvas's camera, with no limits of ours) gets them instead, and is drawn at 100%.
  const ZOOM_KEY = `erga:zoom:v1:${shell.docId}`;
  let zoomLevel = clampZoom(Number(store.get(ZOOM_KEY) ?? 1));
  const syncZoom = (on = editing()) => page.setZoom(on && !page.zoomsItself ? zoomLevel : 1);
  syncZoom();
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

  shell.fmt = mountStyleBar(shell);
  shell.views = mountViews(shell);
  shell.requests = mountPageRequests(shell);
  shell.agent = mountAgent(shell);

  // ---------------------------------------------------------------- shortcuts & wiring

  function appShortcut(e: Keys): boolean {
    if (!editing()) return false;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") { shell.views.toggleSource(); return true; }
    if (mod && !e.shiftKey && key == "j") { shell.agent.toggleAgent(); return true; }
    if (mod && !e.shiftKey && key == "k" && shell.mode == "text") { shell.fmt.openLink(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { shell.chrome.toggleHelp(); return true; }
    const zoom = zoomKey(e, isMac);
    if (zoom) { if (zoom == "reset") { if (page.zoomsItself) page.zoomItself(0); else setZoomLevel(1); } else zoomPage({ step: zoom }); return true; }
    if (mod && !e.shiftKey && key == "s") { shell.toast.flash(shell.room.connected ? "Saved: edits go to disk as you type" : "Offline: edits sync when the host is back", 2200); return true; }
    if (e.key == "Escape" && shell.fmt.linking) { shell.fmt.closeLink(); return true; }
    if (e.key == "Escape") {
      // Naming something in the pages tree, a question in it or one of its menus: Escape is theirs to cancel.
      if (document.activeElement?.closest(".et-input, .et-row.confirm, .et-menu")) return false;
      if (shell.docSettings?.escape()) { /* its menu, or itself, closed */ }
      else if (!$("account").hidden) { shell.people.toggleAccount(false); shell.people.accountBtn?.focus(); }
      else if (!$("help").hidden) shell.chrome.toggleHelp(false);
      else if (!$("naming").hidden) shell.naming.toggleNaming(false);
      else if (!$("pages").hidden) { shell.naming.togglePages(false); $("doc-title").focus(); }
      else if (!$("sharing").hidden) shell.sharing.toggleSharing(false);
      else if (!$("pause-card").hidden) shell.pause.showPauseCard(false);
      else if ($("agent").contains(document.activeElement)) shell.agent.toggleAgent(false);
      else if (shell.mode != "text") shell.views.setMode("text");
      else shell.chrome.hideChrome();
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", (e) => {
    if (appShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Track changes: keep every change marked, as a growing diff, instead of
  // letting the agent's edits fade once seen.
  function setTracking(on: boolean) {
    settings.track = on;
    saveSettings();
    page.setTracking(on);
    const b = $("btn-track");
    b.setAttribute("aria-pressed", String(on));
    b.dataset.tip = on ? "Tracking changes (click to stop)" : "Track changes";
    shell.toast.flash(on ? "Tracking changes from here" : "Stopped tracking changes");
  }
  $("btn-track").addEventListener("click", () => setTracking(!page.isTracking));
  if (settings.track) { page.setTracking(true); $("btn-track").setAttribute("aria-pressed", "true"); $("btn-track").dataset.tip = "Tracking changes (click to stop)"; }

  shell.pause = mountPause(shell);
  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  // The controls act as the press starts (shared/fast-click.ts): the top bar's, the title, the agent's open and close,
  // the text style bar (all but its link that opens a new tab) and Refresh. The agent's undo and reset keep their click.
  fastClick(document, `.chrome-top button, #doc-title, #agent-fab, #agent-close, #fmt button:not([data-link="open"]), #refresh-pill`);
  document.addEventListener("mousedown", (e) => {
    const at = e.target as Node;
    if (!$("help").hidden && !$("help").contains(at)) shell.chrome.toggleHelp(false);
    if (!$("sharing").hidden && !$("sharing").contains(at) && !$("btn-share").contains(at)) shell.sharing.toggleSharing(false);
    if (!$("account").hidden && !$("account").contains(at) && !shell.people.accountBtn?.contains(at)) shell.people.toggleAccount(false);
    if (!$("pause-card").hidden && !$("pause-card").contains(at) && !$("btn-pause").contains(at)) shell.pause.showPauseCard(false);
  });

  // Out of the editor and back in, without leaving the page: the
  // controls go out of sight, with anything open among them, and come back as they were.
  // Into the editor (or loading in it), the editor shows first, then the agent
  // grows out of its button, unless the user keeps it closed. The first time,
  // that's once the editor is ready (this runs before main.ts calls
  // ergaShell.ready) and the page has said what its background is, so the
  // room the page slides over to make is its colour, never the editor's white
  // (applyBackdrop); a page that never says gives up waiting after a moment.
  let entering = 0;
  function openAgentOnEntry() {
    if (!settings.agent) return;
    const mine = ++entering;
    void Promise.race([backdropReady, new Promise((r) => setTimeout(r, 2000))]).then(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => { if (mine == entering && editing()) shell.agent.showAgent(true); })));
  }
  function setEditing(on: boolean) {
    syncZoom(on);
    if (on) {
      // The editor in the page (it stopped on the way out: the page stays as it was).
      page.start();
      page.focus();
      openAgentOnEntry();
      return;
    }
    if (shell.mode != "text") shell.views.setMode("text");
    void page.stop();
    shell.chrome.toggleHelp(false); shell.sharing.toggleSharing(false); shell.naming.toggleNaming(false); shell.naming.togglePages(false); shell.people.toggleAccount(false); shell.pause.showPauseCard(false);
    shell.fmt.hideFmt();
    shell.agent.showAgent(false);
    shell.agent.stopVoice();
    shell.chrome.showChrome();
  }
  // Loaded in the editor (opened with ?edit: a link, a reload, back or forward), the pane is as it was left from the
  // page's first frame (server/pages/viewer.ts, LAYOUT_EARLY), unanimated, and stays so: nothing moves as this runs.
  // Switched into the editor from viewing is coming into it, and the agent grows out as above
  // (server/pages/viewer.ts says which, ergaShell.loadedEditing).
  if (!editing()) setEditing(false);
  else if (window.ergaShell?.loadedEditing !== false) shell.agent.showAgent(settings.agent);
  else openAgentOnEntry();

  // ---------------------------------------------------------------- a new release

  // The page reloads by itself for a new release of the editor, once the room has this tab's edits,
  // never while you drag or compose or speak, and comes back as it was: the page and its caret, where it was
  // scrolled to, the view (page or source), the cards that were open, the files attached to the next message.
  // (The agent's draft, the pane and its layout are kept in this browser anyway.) A reload by hand comes back
  // the same way, and so does the editor's look: the document's page opens with it from its first frame,
  // before this script has loaded.
  live((l) => {
    l.flush(() => collab.flushed());
    l.hold(() => shell.fmt.pointerDown ? "a pointer is down on the page" : shell.agent.voice ? "voice mode is on" : shell.agent.files.reading ? "files are being read" : null);
    l.keep("editor", (): EditorKept => {
      const sel = currentState().selection.main;
      return {
        path: shell.pagePath, selection: { anchor: sel.anchor, head: sel.head }, scroll: shell.mode == "text" ? page.scrollY : 0, mode: shell.mode,
        pages: !$("pages").hidden, settings: !!shell.docSettings?.isOpen(), help: !$("help").hidden,
        files: shell.agent.files.files, held: collab.held() ?? undefined,
      };
    }, { everyReload: true });
    l.keep("shell", (): ShellKept | null => {
      if (!editing() || shell.mode != "text") return null;
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
    if (back.files?.length) shell.agent.files.restore(back.files);
  }
  // ---------------------------------------------------------------- another page

  // Another of the document's pages, opened while editing (the pages card, a link on the page, your agent's open_page),
  // opens in place: the room holds every page already, so the editor takes the new page's text, and the frame goes to the
  // new page (RemotePage.load), whose editor starts from it. The frame's address changes in place (no entry in the tab's
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
    if (shell.mode != "text") { shell.views.setMode("text"); await shell.views.switched(); }
    const text = collab.setPath(path);
    if (text == null) { goTo(addressOf(path)); return; }
    shell.pagePath = path;
    shell.info = { ...shell.info, path, name: path };
    page.load({ path, text });
    // What was said of the last page was of it alone.
    shell.room.shownProblems.clear();
    shell.toast.clearProblems();
    shell.room.dropRefresh();
    shell.fmt.hideFmt();
    shell.naming.togglePages(false);
    let meta = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]');
    if (!meta) meta = document.head.appendChild(Object.assign(document.createElement("meta"), { name: "erga-page" }));
    meta.content = path;
    shell.naming.tree()?.setCurrent(path);
    shell.naming.viewHref(shell.docName!.address);
    if (push) window.history.pushState({ ...window.history.state, ergaPage: path }, "", addressOf(path));
    shell.people.queueCursor();
    shell.people.queuePeers();
  }
  // Each entry in the history says which page it is (one the pencil adds, going in or out, is stamped as it comes).
  const stamp = () => { if (typeof window.history.state?.ergaPage != "string") window.history.replaceState({ ...window.history.state, ergaPage: shell.pagePath }, ""); };
  stamp();
  addEventListener("popstate", () => {
    const to = window.history.state?.ergaPage;
    if (typeof to == "string") { if (to != shell.pagePath && !swapPage(to, false)) location.reload(); return; }
    // An entry that doesn't say (made before this page loaded): this page, unless its address is another's.
    if (shell.docName?.address && location.pathname != "/" && location.pathname != pageUrl(shell.docName.address, shell.pagePath)) location.reload();
  });

  started = true;
  shell.people.presenceChanged();
  shell.room.connectionChanged(collab.connected);
  // What came on the socket while the shell was being set up (its hello, the agent's state), in order.
  for (const m of pending.splice(0)) shell.room.socketEvent(m);
  window.ergaPage = { page, collab, toggleSource: shell.views.toggleSource, captureView: shell.requests.captureView, agentContext: shell.agent.editorContext, setEditing, get pagePath() { return shell.pagePath; }, openPage, get state() { return currentState(); } };
  window.ergaShell?.ready();
})();
