// The page editor's shell: the controls around the document's page while editing, and its one word to the editor in
// the page (edit, with the edit key, or view: page-frame.ts). The editor is the page's own (libs/text/ui/frame.ts): it
// joins the document's Yjs room itself. The shell holds a lightweight JSON-only socket (?events=1&shell=1) for what it
// shows: who's here (presence), the pages and the name, and your agent's events (your agent runs in its own object; its
// conversation is yours alone, and its edits arrive through the room like anyone's).
//
// This file loads the document and wires the shell's parts (client/shell/), which share one object (shell.ts).

import { ShellRoom, type EarlySocket, type SocketEvent } from "./shell-room";
import { watchUnsaved } from "../../libs/text/ui/unsaved";
import { mountPageFrame } from "./page-frame";
import { mountCommentBox } from "../common/comment-box";
import { isMac, type Keys } from "../common/app-keys";
import { describeProblem } from "./problems";
import { colorFor, type Author } from "../../shared/author";
import type { Attachment } from "../../shared/attach";
import { isPage, pageUrl } from "../../document/model/pages";
import { live } from "../live/client";
import { restoredFor } from "../live/restore";
import { fastClick } from "../common/fast-click";
import { asUser } from "../common/tools";
import { mountLayout } from "../agent/layout";
import { BASE, $, type Shell } from "./shell";
import { mountEditor } from "./editor";
import { mountNaming } from "./naming";
import { mountRoom } from "./room";
import { mountPeople } from "./people";
import { barEdge } from "../common/quick";
import { mountChrome } from "./chrome";
import { mountSharing } from "./sharing";
import { mountToast } from "./toast";
import { mountAlerts } from "./alerts";
import { mountSaveMark, type At } from "../common/save-mark";
import { mountUploads } from "./uploads";
import { ms } from "../../libs/text/ui/timescale";
import { mountPageRequests } from "./page-requests";
import { awaitHello } from "./opening";
import { feedbackContext, keyPressed, messageContext } from "./agent-context";
import { keepOffline, rememberOrigin } from "../common/offline";

declare global {
  interface Window {
    ergaPage?: unknown;
    ergaShell?: { ready(): void };
    /** The shell's JSON-only socket, opened as the page parsed (client/inline/viewer-editing-head.ts, ergaConnect). */
    ergaSocket?: EarlySocket;
    /** The edit key's answer, asked for with it (null: no answer). */
    ergaKey?: Promise<Response | null>;
  }
}
/** What the editor keeps of itself across a reload for a new release. */
interface EditorKept {
  /** The page it was on: the rest applies only to the same one. */
  path: string;
  pages: boolean;
  settings: boolean;
  /** Files attached to the agent's next message. */
  files: Attachment[];
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
const SHELL_PARTS = ["nav-documents", "people", "btn-documents", "btn-edit", "me"];
/** What the save mark's card says of edits that the server does not have (libs/text/ui/unsaved.ts). */
const NOT_SAVED = {
  title: "Edits not saved yet",
  detail:
    "Erga can't reach the server. Your edits are safe in this browser: Erga tries again by itself, and saves them when the connection is back.",
};
/** And of a new title (the shell's own edit of the room: naming.ts). */
const TITLE_NOT_SAVED = {
  title: "Title not saved yet",
  detail:
    "Erga can't reach the server. The new title is safe in this browser: Erga tries again by itself, and saves it when the connection is back.",
};


(async () => {
  // The start, step by step, as performance marks (erga:main, erga:hello, erga:synced, erga:frame-asked; the frame's
  // erga:frame-js, erga:init, erga:rendered): DevTools' Performance panel and a script can read where the time went.
  performance.mark("erga:main");

  /** The parts of the shell, and what they share: filled in below, as each is ready. */
  const shell = {
    docSettings: null,
    docName: null,
  } as Partial<Shell> as Shell;
  /** Editing (shell.editor: once it's mounted). */
  const editing = () => shell.editor.state.editing;

  // ---------------------------------------------------------------- load

  // Who this tab is: whoever's signed in. In local development a tab can be
  // someone else, ?user=Ada (only the dev server honours it), so every
  // request it makes says so. Tabs that are the same person share an agent
  // and its conversation.
  const as = asUser("");
  // What this page kept of itself before it reloaded for a new release, if it did.
  const back = restoredFor<EditorKept>("editor");

  // The shell's lightweight JSON-only socket (shell-room.ts), open since the page began (viewer-editing-head.ts):
  // hello, this person's events, and JSON presence. Presence, connection news and events before the shell is set up are
  // picked up once it is (`started`).
  let started = false;
  const pending: SocketEvent[] = [];
  const early = window.ergaSocket;
  window.ergaSocket = undefined;
  // Checked only if the socket is refused: whether the host says there's no such document (404).
  const checkMissing = () =>
    fetch(`${BASE}/api/doc${as}`).then(
      (r) => r.status == 404,
      () => false
    );
  const socket = new ShellRoom({
    url: () => `${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${asUser(`${BASE}/api/room?events=1&shell=1`)}`,
    early,
    // (Kept in this browser, as this person: the shell opens from its cached hello with no connection.)
    keep: `${BASE}${as}`,
    onEvent: (msg) => {
      if (started) shell.room.socketEvent(msg);
      else pending.push(msg);
    },
    onPresence: () => {
      if (started) shell.people.presenceChanged();
    },
    onStatus: (status) => {
      if (started) shell.room.connectionChanged(status);
      // (A key asked for again, if the last request had no answer; and any offline title rename flushed.)
      if (started && status == "up") {
        shell.editor.send({ type: "online" });
        void shell.naming.flushTitle();
      }
    },
  });
  // However long the room takes (opening.ts): a slow document isn't a missing one.
  const first = await awaitHello(socket.hello, checkMissing);
  if (!first) return;
  shell.info = first.info;
  shell.treeEntries = first.tree.entries;
  shell.latestContext = null;
  performance.mark("erga:hello");
  // This page, its files, and the cached hello, kept in this browser for a reload with no connection (client/common/offline.ts).
  void keepOffline(location.href);
  socket.persist();

  // Which of the document's pages the editor holds: the one the viewer shows (the meta erga-page, which
  // client/viewer/nav.ts owns), else the document's own. Another page opened in place while editing changes it (swapTo).
  let pagePath = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || shell.info.path;
  Object.defineProperty(shell, "pagePath", { get: () => pagePath });
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
  ($("nav-back") as HTMLAnchorElement).href = `/documents${as}`;
  ($("btn-documents") as HTMLAnchorElement).href = `/documents${as}`;
  ($("nav-brand") as HTMLAnchorElement).href = `/documents${as}`;
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
  // The title in the breadcrumbs takes the room left of the controls (on a phone, quick.ts also compresses Documents ›).
  let navRaf = 0;
  const navRoom = () => {
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => {
      navRaf = 0;
      const title = $("doc-title"),
        top = document.querySelector<HTMLElement>(".chrome-top");
      if (!top || title.hidden) return;
      title.style.setProperty("--room", `${Math.max(0, barEdge(top, $("people")) - title.getBoundingClientRect().left - 8)}px`);
    });
  };
  const phone = matchMedia("(max-width: 759.98px)");
  phone.addEventListener("change", navRoom);
  new ResizeObserver(navRoom).observe(document.querySelector(".chrome-top")!);
  new ResizeObserver(navRoom).observe($("people"));
  new ResizeObserver(navRoom).observe($("nav-documents"));
  addEventListener("resize", navRoom);
  $("nav-documents").addEventListener("transitionend", navRoom);
  /** The host's endpoints, as this person. */
  const api = (path: string) => `${BASE}${path}${as}`;

  document.title = document.documentElement.dataset.pageTitle || (info.docName?.title ?? shell.pagePath);

  const tab = Math.random().toString(36).slice(2, 10);
  Object.assign(shell, {
    socket,
    me,
    as,
    api,
    docId: BASE.replace(/^\/d\//, ""),
    addressOf,
    goTo,
    openPage,
    swapPage,
  });
  // (Asked each time: a load of the page again puts a new frame in its place, client/inline/viewer-frames.ts.)
  Object.defineProperty(shell, "frame", { get: () => window.ergaFrames.frame });
  // Editing, as the viewer says (client/viewer/edit-boot.ts: it tells setEditing from now on), and full screen.
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
  shell.toast = mountToast();
  shell.alerts = mountAlerts(shell);
  // The save mark: each copy says how far its edits are (libs/text/ui/unsaved.ts), under a key of its own.
  // The mark is the gray check only when the server has them all.
  shell.save = mountSaveMark($("save-state"));
  const edits =
    (key: string, why = NOT_SAVED) =>
    (at: At) =>
      shell.save.set(key, at, why);
  // Pending title renames (naming.ts): while the server doesn't have one, the mark says so in words of its own.
  shell.unsaved = watchUnsaved(window, { flushed: () => shell.naming.flushTitle(), key: BASE, mark: edits("shell", TITLE_NOT_SAVED) });
  if (shell.naming.hasPending()) {
    shell.unsaved.edit();
    if (socket.connected) void shell.naming.flushTitle();
  }
  shell.uploads = mountUploads(shell);
  // Signed out (client/live/live.ts): the room's sockets, this one and the page's own, try no more.
  live((l) =>
    l.signedOut(() => {
      socket.signedOut();
      shell.naming.signedOut();
      page.signedOut();
    })
  );

  // ---------------------------------------------------------------- the page editor

  // The page editor runs in the page, in the frame, on the document's own origin: under the address the app gave
  // this page (with the token that opens the document's files there).
  const pagesUrl = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]')?.content ?? "";
  const pagesOrigin = new URL(pagesUrl, location.href).origin;
  const page = (shell.page = mountPageFrame({
    frame: () => window.ergaFrames.frame,
    origin: pagesOrigin,
    files: pagesUrl,
    told: () => shell.editor.state.told,
    edit: (key) => ({ doc: `${location.origin}${BASE}`, key, me, path: shell.pagePath, tab }),
    here: () => (document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || shell.info.path) == shell.pagePath,
    onKey: (keys) => {
      appShortcut(keys, true);
    },
    // The page's own problem, as an alert: once in a view of the page, until someone asks the agent to fix it (if it's
    // still broken after, it says so again).
    onProblem: (raw, base) => {
      const p = describeProblem(raw, base, pagesOrigin);
      if (!p) return;
      const say = () => shell.alerts.raise({ ...p, kind: "error", source: "page", once: true, life: "page" });
      // A file of the document that the page couldn't load may be on its way (an upload): then it is no problem. One
      // the document doesn't have at all may be an upload whose element came before its record: a moment tells.
      const files = new URL(pagesUrl, location.href);
      const url = raw.kind == "resource" && URL.canParse(raw.url, pagesOrigin + base) ? new URL(raw.url, pagesOrigin + base) : null;
      if (!url || url.origin != files.origin || !url.pathname.startsWith(files.pathname)) return say();
      const path = decodeURIComponent(url.pathname.slice(files.pathname.length));
      const comes = shell.uploads.awaits(path);
      if (comes == "no") say();
      else if (comes == "maybe") window.setTimeout(() => shell.uploads.awaits(path) == "maybe" && say(), ms(3000));
    },
    onSave: edits("page"),
    onAlert: (event) => shell.alerts.fromPage(event),
    onUpload: (files, point) => shell.uploads.add(files, point),
    onUploadAct: (path, action) => shell.uploads.act(path, action),
    onUploadsAsk: () => shell.uploads.asked(),
    onLoad: () => {
      shell.alerts.loaded();
      // (The page's editor is new: it says its edits' state again.)
      shell.save.set("page", "saved");
      document.body.classList.remove("has-steps");
    },
    onSteps: (on) => document.body.classList.toggle("has-steps", on),
    onPointer: (x, y) => {
      shell.chrome.pointerMoved(new MouseEvent("mousemove", { clientX: x, clientY: y }));
      shell.save.left();
    },
    // A press on the page: as one anywhere else in the shell would.
    onPress: () => {
      // (Also a card that's waiting for what it shows, to open.)
      shell.chrome.closeCards();
      shell.people.stackPeople();
      shell.chrome.toggleQuick(false);
      shell.save.close();
    },
    onPressed: keyPressed,
    onContext: (path, context) => {
      shell.latestContext = { path, context };
    },
    onActivity: (kind) => {
      if (kind == "edit") {
        shell.chrome.hideChrome();
        return;
      }
      if (kind == "key") {
        live((l) => l.activity());
        shell.chrome.keyPressed();
      }
    },
    onOpen: (path) => openPage(path),
  }));
  // The comment box, over the page, while it is in the editor: the page's comments ask for it.
  mountCommentBox(
    shell.docId,
    () => shell.pagePath,
    () => editing()
  );
  rememberOrigin(pagesOrigin);
  const coarse = () => matchMedia("(pointer: coarse)").matches;
  // The page's editor starts, if it should (its edit key: client/shell/editor.ts).
  shell.editor.send({ type: "tick" });
  if (editing() && !coarse()) {
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

  // The document's zoom is the viewer's (client/viewer/zoom.ts), viewing and editing alike: a key's change of the
  // level shows in the toast.
  addEventListener("erga-zoom-level", (e) =>
    shell.toast.flash(`Zoom ${Math.round((e as CustomEvent<{ level: number }>).detail.level * 100)}%`)
  );

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
      void import("../common/shortcuts-dialog").then((m) => m.toggleShortcuts());
      return true;
    }
    if (mod && !e.shiftKey && key == "s") {
      shell.toast.flash(shell.room.connected ? "Saved: edits go to disk as you type" : "Offline: edits sync when the host is back", 2200);
      return true;
    }
    // A dialog over the page (Settings, Send feedback, Keyboard shortcuts) is the browser's own: Escape closes it.
    if (e.key == "Escape" && document.querySelector("dialog:modal")) return false;
    if (e.key == "Escape" && (shell.save.close() || shell.alerts.close())) return true;
    if (e.key == "Escape") {
      // Naming something in the pages tree, a question in it or one of its menus, or the comment box: Escape is theirs to cancel.
      if (document.activeElement?.closest(".et-input, .et-row.confirm, .et-menu, erga-comment-box")) return false;
      if (shell.docSettings?.escape()) {
        /* its menu, or itself, closed */
      } else if (!$("account").hidden) {
        shell.people.toggleAccount(false);
        shell.chrome.toggleQuick(false);
        shell.people.accountBtn?.focus();
      } else if (!$("naming").hidden) shell.naming.toggleNaming(false);
      else if (!$("pages").hidden) { shell.naming.togglePages(false); $("doc-title").focus(); }
      // (Its box had the focus: the caret goes back to the text.)
      else if (!$("sharing").hidden) {
        shell.sharing.toggleSharing(false);
        page.focus();
      }
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

  // Full screen (client/viewer/full.ts) is for showing the page, not editing it: the editor in it stops, so the
  // page's own keys work (a deck's arrows); it starts again after.
  addEventListener("erga-full", (e) => shell.editor.send({ type: "full", on: (e as CustomEvent<{ on: boolean }>).detail.on }));

  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  // The controls act as the press starts (client/common/fast-click.ts): the top bar's, the title, the agent's open and
  // close. The agent's undo and reset keep their click. (The account corner's button, in the same bar, has its own:
  // client/inline/account-menu.ts. Two would click it twice on one press, and its menu would open and close.)
  fastClick(document, `.chrome-top button:not(.erga-account-btn), #doc-title, #agent-fab, #agent-close`);
  document.addEventListener("mousedown", (e) => {
    const at = e.target as Node;
    if (!$("sharing").hidden && !$("sharing").contains(at) && !$("btn-share").contains(at)) shell.sharing.toggleSharing(false);
    if (!$("account").hidden && !$("account").contains(at) && !shell.people.accountBtn?.contains(at)) shell.people.toggleAccount(false);
  });

  // Out of the editor and back in, without leaving the page: the
  // controls go out of sight, with anything open among them, and come back as they were. Your agent stays as it is:
  // it's the page's, viewing and editing alike (server/pages/agent.ts).
  function setEditing(on: boolean) {
    // The editor in the page starts or stops (on the way out the page stays as it was).
    shell.editor.send({ type: "editing", on });
    if (on) {
      if (!coarse()) page.focus();
      return;
    }
    shell.chrome.closeCards();
    shell.chrome.toggleQuick(false);
    shell.chrome.showChrome();
  }
  if (!editing()) setEditing(false);

  // ---------------------------------------------------------------- a new release

  // The page reloads by itself for a new release of the editor, once the room has this tab's edits,
  // never while you drag or compose, and comes back as it was: the page and its caret, where it was
  // scrolled to, the cards that were open, the files attached to the next message.
  // (The agent's draft, the pane and its layout are kept in this browser anyway.) A reload by hand comes back
  // the same way, and so does the editor's look: the document's page opens with it from its first frame,
  // before this script has loaded.
  live((l) => {
    l.flush(() => shell.naming.flushTitle());
    l.hold(() => (agentPanel()?.files.reading ? "files are being read" : null));
    l.keep(
      "editor",
      (): EditorKept => ({
        path: shell.pagePath,
        pages: !$("pages").hidden,
        settings: !!shell.docSettings?.isOpen(),
        files: agentPanel()?.files.files ?? [],
      }),
      { everyReload: true }
    );
    l.keep("shell", (): ShellKept | null => {
        if (!editing()) return null;
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
    if (back.pages) requestAnimationFrame(() => shell.naming.togglePages(true));
    if (back.settings) void shell.chrome.loadSettings().then((s) => s?.toggle(true));
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
    if (!started || !editing() || !shell.docName?.address || !shell.treeEntries.some((e) => e.path == path && e.type == "page"))
      return false;
    swaps = swaps
      .then(() => swapTo(path, push))
      .catch((e) => {
        console.error(e);
        location.assign(addressOf(path));
      });
    return true;
  }
  function swapTo(path: string, push: boolean) {
    if (path == pagePath) return;
    pagePath = path;
    shell.latestContext = null;
    page.load(path);
    // What was said of the last page was of it alone.
    shell.alerts.left();
    shell.naming.togglePages(false);
    shell.people.presenceChanged();
    // The new page has the focus for its editor, unless the agent's box has it.
    if (!$("agent").contains(document.activeElement)) page.focus();
    // A new entry in the history, then the page shown (client/viewer/nav.ts: the address and the entry follow).
    if (push) window.history.pushState({ ...window.history.state, ergaPage: path }, "", addressOf(path));
    window.ergaShowPage(path);
    shell.naming.tree()?.setCurrent(path);
    shell.naming.viewHref(shell.docName!.address);
  }
  // Each entry in the history says which page it is (the pencil's and the viewer's say it as they're made:
  // client/viewer/edit-boot.ts, client/viewer/nav.ts). Viewing, the viewer follows Back and Forward alone.
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
  shell.room.connectionChanged(socket.status);
  // What came on the socket while the shell was being set up (its hello, the agent's state), in order.
  for (const m of pending.splice(0)) shell.room.socketEvent(m);
  window.ergaPage = {
    page,
    room: shell.room,
    socket,
    agentContext: () => messageContext(shell),
    feedbackContext: () => feedbackContext(shell),
    setEditing,
    get pagePath() {
      return shell.pagePath;
    },
  };
  window.ergaShell?.ready();
})();
