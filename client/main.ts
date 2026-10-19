// The page editor's shell: joins the document's room (its Durable Object,
// cloudflare/document-object.ts) as one participant among others, renders the document in the
// page editor, sends every edit to the room as you type and applies everyone
// else's (people and their agents) as they land, shows who's here and where
// their carets are, and offers quiet chrome:
// shortcuts and a toggle to the source, which shares the document state and
// undo history. It also hosts the agent panel (⌘J): your agent runs in the
// host, its conversation is yours alone (your other tabs show it too), and
// its edits arrive through the room like anyone's.

import { Transaction, type ChangeSet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { InlineStyle, MarkAuthor, Peer } from "./editor";
import { ms } from "./timescale";
import { RemotePage } from "./remote";
import type { Backdrop, Keys } from "./bridge";
import { changesBetween } from "../document/merge";
import { Collab, type Presence } from "./collab";
import { colorFor, files, type Author } from "../document/content";
import type { mountTree, TreeHandle } from "./pages-tree";
import { type Log, type LogEvent, type ViewRequest, type ViewResult } from "../shared/agent-log";
import { chat, escapeHtml } from "./agent-chat";
import { fileRefs, type Attachment } from "../shared/attach";
import { attachments } from "./attach-ui";
import type { AgentState, DocInfo, DocName, ModelState } from "../document/api";
import { BASE } from "./base";
import { shareWithAgent } from "./share-agent";
import type { Settings } from "./settings";
import { dirOf, isPage, pageUrl } from "../document/pages";
import { mountLayout } from "./layout";
import { backoff, live, transient } from "./live-client";
import { restoredFor } from "./restore";
import { applyZoom, catchZoomGestures, clampZoom, zoomFactor, zoomKey, type ZoomBy } from "./zoom";
import { liveWatch } from "./live-page";
import { ConsoleLog, queryConsole, shownInTab, type ConsoleLevel, type LiveRequest, type LiveResult } from "../shared/live-page";
import { FIX_REPORTED, pageReport } from "../shared/page-report";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// The editor's own console (this window's), from its first line: page_console gives it with the page's ("editor").
const shellConsole = new ConsoleLog(300);
liveWatch({ events: false, net: false, types: [] });
(window as Window & { __ergaLiveTake?: (sink: (kind: string, data: unknown) => void) => void }).__ergaLiveTake?.((kind, data) => {
  const c = data as { level: ConsoleLevel; text: string; at: number };
  if (kind == "console" && typeof c?.text == "string") shellConsole.add(c.level, c.text, "editor", c.at);
});

declare global {
  interface Window { ergaPage?: unknown; ergaShell?: { ready(): void; loadedEditing?: boolean }; ergaDocInfo?: { url: string; response: Promise<Response> } }
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
/** pages-tree.ts, once imported (a chunk of its own: pages-tree.js). */
type TreeModule = { mountTree: typeof mountTree };


(async () => {
  const $ = (id: string) => document.getElementById(id)!;

  const KEYS = { settings: "erga:settings:v1" };
  const store = {
    get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
  };
  // `agent`: whether the agent pane is open while editing. It starts open, and
  // stays as the user last left it: closed, it stays closed on the way in.
  const settings: { track: boolean; agent: boolean } = { track: false, agent: true, ...store.json(KEYS.settings) };
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));

  // The page this runs in is the document's page, viewing or
  // editing: the editor runs either way once loaded, its controls shown only
  // while editing (setEditing, below).
  const editing = () => document.body.classList.contains("erga-editing");

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
    if (!info) return;
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
  let info: DocInfo | null = null;
  // What this page kept of itself before it reloaded for a new release, if it did.
  const back = restoredFor<EditorKept>("editor");
  try {
    // The page asked for it already, as editing started, if it's for this same address.
    const early = window.ergaDocInfo;
    window.ergaDocInfo = undefined;
    const url = `${BASE}/api/doc${as}`;
    const res = early?.url == url ? await early.response : await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    info = (await res.json()) as DocInfo;
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Nothing to edit here.</p><p>Open one from <a href="/docs">your documents</a>.</p></div>`;
    window.ergaShell?.ready();
    return;
  }

  // Which of the document's pages this is: the one the address named (the front door says, erga-page),
  // else the document's own. One room holds them all; this tab edits this one, and goes to another by its address.
  // (Another page opened in place, while editing, changes it: swapPage.)
  let pagePath = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || info.path;
  info = { ...info, path: pagePath, name: pagePath };
  /** A page's address (the editor's, while editing), given its path in the document; the root page's for null. */
  const addressOf = (path: string | null) => {
    const doc = docName?.address ?? document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? "";
    // A path that isn't a page file ("blog/", a folder) is an address as it is: the front door finds its page.
    const at = path == null ? doc : isPage(path) ? pageUrl(doc, path) : `${doc}/${path.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/")}`;
    return at.replace(/\/$/, "") + as + (editing() ? "#edit" : "");
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
  /** The document's settings, once the gear has loaded them (loadSettings). */
  let docSettings: Settings | null = null;

  // Join the room and wait for the document's text. Presence and connection
  // news before the shell is set up is picked up once it is (`started`).
  let started = false;
  const collab: Collab = new Collab({
    me,
    path: info.path,
    onRemote: (changes, author) => applyRemote(changes, author),
    // Another page of the document is no part of this one (a page frames another only rarely): its edits leave this one be.
    onFiles: (paths) => { if (paths.some((p) => !/\.(html?|md)$/i.test(p))) needRefresh(); },
    onPresence: () => { if (started) presenceChanged(); },
    onStatus: (connected) => { if (started) connectionChanged(connected); },
    onStale: () => {
      const w = $("welcome");
      w.hidden = false;
      w.classList.add("blocking");
      w.innerHTML = `<div><p>This page is out of date: the editor's host restarted without its saved history, so edits from this tab can't be merged safely.</p><p><button type="button" id="stale-reload">Reload</button></p></div>`;
      $("stale-reload").addEventListener("click", () => location.reload());
    },
  }, asked ? { user: asked } : {});
  let initialText: string;
  try {
    initialText = await collab.ready();
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Couldn't join the document: ${(e as Error).message}.</p><p>Is the server still running?</p></div>`;
    window.ergaShell?.ready();
    return;
  }
  // One CodeMirror state serves both the page editor and the source view, so the undo history is shared and either
  // view's edits land in the same file. The source view's code (source-view.ts: CodeMirror's view and the HTML
  // language) loads the first time it opens. Its own edits go to the room.
  let sourceCode: Promise<typeof import("./source-view")> | null = null;
  let source: typeof import("./source-view") | null = null;
  const loadSource = () => sourceCode ??= import("./source-view").then((m) => (source = m), (e) => {
    sourceCode = null;
    // A chunk that isn't there any more is a new release: the page asks the server, and reloads (live.ts).
    live((l) => l.check("a request failed"));
    throw e;
  });
  const sourceHooks = {
    edited(changes: ChangeSet) {
      collab.push(changes);
      page.recordAuthorship(changes, self);
      hideChrome();
    },
    moved: () => queueCursor(),
  };
  document.title = info.docName?.title ?? info.name;

  // ---------------------------------------------------------------- title and address

  // The document's title, top left after the Documents link, and its address
  // in the address bar. Whoever renames it (anyone, any agent, or the title
  // following its first heading), every tab hears of it on the event channel
  // and follows: the title changes, and the address becomes the new one
  // (replaceState: the old one still leads here). The editor itself talks to
  // the host at /d/<id> (BASE), which a rename never changes.
  let docName: DocName | null = null;
  const titleBtn = $("doc-title"), naming = $("naming");
  // The pages card (below: togglePages) and its tree, once opened.
  const pagesCard = $("pages");
  let tree: TreeHandle | null = null;
  const namingForm = $("naming-form") as HTMLFormElement, namingStatus = $("naming-status");
  const titleIn = $("naming-title") as HTMLInputElement, slugIn = $("naming-slug") as HTMLInputElement;
  function showName(n: DocName) {
    docName = n;
    $("doc-title-text").textContent = n.title;
    titleBtn.hidden = false;
    titleBtn.setAttribute("aria-label", `${n.title}: its pages`);
    titleBtn.title = `${location.host}${n.address}`;
    document.title = n.title;
    tree?.setRootTitle(n.title);
    if (n.address) tree?.setBase(n.address);
    // The editor's own address is the page's, with #edit (without, it's the viewer, which the pencil, blue while editing, goes back to).
    if (!n.address) return;
    const at = viewHref(n.address);
    document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.setAttribute("content", n.address);
    // At the front page's address (/), it stays there.
    const here = location.pathname == "/" ? "/" : at;
    if (location.pathname != here) window.history.replaceState(window.history.state, "", here + location.search + location.hash);
  }
  /** The pencil, blue while editing, goes to this page in the viewer: its address (answered without the query). */
  function viewHref(address: string) {
    const view = $("btn-edit") as HTMLAnchorElement;
    const at = pageUrl(address, pagePath);
    view.href = at + as;
    view.hidden = false;
    return at;
  }
  if (info.docName) showName(info.docName);
  /** Asks for the name again (when the event channel connects: a rename may have gone by while it was down). */
  function refreshName() {
    if (!docName) return;
    fetch(api("/api/name")).then((r) => (r.ok ? r.json() : null)).then((n: DocName | null) => { if (n) showName(n); }, () => {});
  }
  const slugify = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  let slugTouched = false;
  const sayNaming = (text: string, error = false) => { namingStatus.textContent = text; namingStatus.classList.toggle("error", error); };
  const namingHint = () => sayNaming(!titleIn.value.trim() ? "Empty, the title follows the page's first heading."
    : !slugIn.value.trim() ? "Empty, the address follows the title."
    : !docName?.titleSet && titleIn.value.trim() == docName?.title ? "The title follows the page's first heading until you change it." : "");
  function toggleNaming(force?: boolean) {
    const open = typeof force == "boolean" ? force : naming.hidden;
    if (open && !docName) return;
    naming.hidden = !open;
    titleBtn.setAttribute("aria-expanded", String(open || !pagesCard.hidden));
    if (!open) return;
    togglePages(false);
    showChrome();
    toggleHelp(false);
    toggleSharing(false);
    toggleAccount(false);
    docSettings?.toggle(false);
    slugTouched = false;
    $("naming-prefix").textContent = `/${docName!.owner}/`;
    titleIn.value = docName!.title;
    slugIn.value = docName!.slug;
    namingHint();
    titleIn.focus();
    titleIn.select();
  }
  titleBtn.addEventListener("click", () => (naming.hidden ? togglePages() : toggleNaming(false)));
  $("naming-cancel").addEventListener("click", () => toggleNaming(false));
  // An address that follows the title follows it here too, until it's typed in.
  titleIn.addEventListener("input", () => { if (!docName!.slugSet && !slugTouched) slugIn.value = slugify(titleIn.value) || docName!.slug; namingHint(); });
  slugIn.addEventListener("input", () => { slugTouched = true; namingHint(); });
  document.addEventListener("pointerdown", (e) => { if (!naming.hidden && !naming.contains(e.target as Node) && !titleBtn.contains(e.target as Node)) toggleNaming(false); });
  namingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!docName) return;
    // Only what changed: a title left as it was keeps following the heading, if it did.
    const patch: { title?: string; slug?: string } = {};
    if (titleIn.value.trim() != docName.title) patch.title = titleIn.value.trim();
    if (slugTouched && slugIn.value.trim() != docName.slug) patch.slug = slugIn.value.trim();
    if (!("title" in patch) && !("slug" in patch)) return toggleNaming(false);
    sayNaming("Saving…");
    const r = await fetch(api("/api/name"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000) })
      .then(async (res) => (res.ok ? { name: (await res.json()) as DocName } : { error: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the host answered ${res.status}` }))
      .catch((err: Error) => ({ error: err.name == "TimeoutError" ? "the editor's host didn't answer" : err.message }));
    if ("error" in r) return sayNaming(r.error ?? "Couldn't rename it.", true);
    showName(r.name);
    toggleNaming(false);
  });

  // ---------------------------------------------------------------- pages

  // The document's pages: the title opens them, as a tree (document/pages.ts, built on
  // its own as pages-tree.js, so viewing never pays for it). Its first row is
  // the document itself, whose pencil renames it (the naming card above); the
  // rest are its other pages, folders and files. Pages open in the editor; the
  // tree follows changes from other tabs and agents (a "tree" event, or a file
  // coming or going in the room) and the titles of the pages as they're edited.
  // So the title opens it at once, the editor loads the script and mounts the
  // tree, still closed, once it's up and the tab is idle (or sooner, as the
  // pointer heads for the title); and it keeps the tree's last answer for the
  // tab, as Documents does (the same key), so the next page shows it straight
  // away and reads it again behind.
  let treeScript: Promise<TreeModule> | null = null;
  const loadTree = () => treeScript ??= import("./pages-tree").then((m): TreeModule => m, () => {
    treeScript = null;
    // (A chunk that isn't there any more is a new release: the page asks the server, and reloads: live.ts.)
    live((l) => l.check("a request failed"));
    throw new Error("Couldn't load the pages: check your connection and try again.");
  });
  const keptKey = () => `erga:docs-tree:${docName!.id}`;
  const kept = () => { try { return JSON.parse(sessionStorage.getItem(keptKey()) || "null") as Parameters<typeof mountTree>[1]["initial"]; } catch { return null; } };
  const keep = (a: { entries: unknown[]; canEdit: boolean }) => { try { sessionStorage.setItem(keptKey(), JSON.stringify({ entries: a.entries, canEdit: a.canEdit })); } catch { /* private mode */ } };
  /** The tree, mounted (closed or open) once its script is in: what opening it waits for, if anything. */
  let treeReady: Promise<TreeHandle> | null = null;
  const slot = $("pages-tree");
  function prepareTree(): Promise<TreeHandle> {
    if (!docName) return Promise.reject(new Error("no document"));
    return (treeReady ??= loadTree().then((t) => {
      if (tree) return tree;
      slot.replaceChildren();
      return (tree = t.mountTree(slot, {
        id: docName!.id, base: docName!.address, editing: true, query: as, showRoot: true, label: "Pages",
        rootTitle: docName!.title, titleOf: pageTitle, current: info!.path, hasRelativeLinks, initial: kept(), onChange: keep,
        onRenameRoot: () => toggleNaming(true),
        navigate: (url, o) => { if (o.replace || !o.path || !swapPage(o.path)) goTo(url, o.replace); },
      }));
    }, (e: Error) => { treeReady = null; throw e; }));
  }
  const ready = () => { prepareTree().catch(() => {}); };
  if (editing()) (window.requestIdleCallback ?? setTimeout)(ready);
  titleBtn.addEventListener("pointerenter", ready);
  titleBtn.addEventListener("focus", ready);
  titleBtn.addEventListener("pointerdown", ready);
  /** A page's title from its text, as the room has it: its first <h1>, else its <title>. */
  function pageTitle(path: string): string | null {
    const text = files(collab.doc).get(path)?.toString();
    if (!text) return null;
    const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text) ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (!m) return null;
    const t = new DOMParser().parseFromString(m[1].replace(/<[^>]*>/g, ""), "text/html").body.textContent?.replace(/\s+/g, " ").trim();
    return t ? t.slice(0, 120) : null;
  }
  /** Whether a document links to its styles, scripts or images by relative paths (a move may break those): read from the room. */
  function hasRelativeLinks(path: string): boolean | undefined {
    const text = files(collab.doc).get(path)?.toString();
    if (text == null) return undefined;
    const refs = [...text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']?([^"'\s>]+)|url\(\s*["']?([^"')]+)/gi)].map((m) => m[1] ?? m[2]);
    return refs.some((r) => !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\{)/i.test(r));
  }
  function togglePages(force?: boolean) {
    const open = typeof force == "boolean" ? force : pagesCard.hidden;
    if (open && !docName) return;
    if (open != pagesCard.hidden) return;
    pagesCard.hidden = !open;
    titleBtn.setAttribute("aria-expanded", String(open || !naming.hidden));
    if (!open) return;
    showChrome();
    toggleHelp(false);
    toggleSharing(false);
    toggleAccount(false);
    toggleNaming(false);
    docSettings?.toggle(false);
    if (tree) { tree.refresh(); tree.focus(); return; }
    // Its script isn't in yet (the tab wasn't idle, or it failed before): a quiet line until it is.
    slot.replaceChildren(Object.assign(document.createElement("p"), { className: "naming-status", textContent: "Loading pages…" }));
    prepareTree().then((t) => { if (!pagesCard.hidden) t.focus(); }, (e: Error) => {
      slot.replaceChildren(Object.assign(document.createElement("p"), { className: "naming-status error", textContent: e.message }));
      pagesCard.hidden = true; pagesCard.hidden = false;
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (!pagesCard.hidden && !pagesCard.contains(t) && !titleBtn.contains(t) && !t.closest?.(".et-menu")) togglePages(false);
  });
  // A file coming or going in the room (another tab, an agent) reads the tree again; a page's text changing may change its title.
  let treeTimer = 0, treeStale = false;
  files(collab.doc).observeDeep((events) => {
    if (!tree || pagesCard.hidden) return;
    treeStale ||= events.some((ev) => ev.target == files(collab.doc) && [...ev.changes.keys.values()].some((c) => c.action != "update"));
    clearTimeout(treeTimer);
    treeTimer = window.setTimeout(() => { if (treeStale) tree?.refresh({ quiet: true }); else tree?.retitle(); treeStale = false; }, treeStale ? 150 : 600);
  });
  // ?pages opens it straight away (a link to "this document's pages"), as does following this page to where it moved
  // while it was open (goTo): it stays open across the move.
  const reopen = (() => { try { const v = sessionStorage.getItem("erga:pages-open"); sessionStorage.removeItem("erga:pages-open"); return v == BASE; } catch { return false; } })();
  if ((reopen || new URLSearchParams(location.search).has("pages")) && editing()) requestAnimationFrame(() => togglePages(true));
  pagesCard.addEventListener("keydown", (e) => { if (e.key == "Escape" && !e.defaultPrevented) { e.preventDefault(); togglePages(false); titleBtn.focus(); } });

  // ---------------------------------------------------------------- the room

  const status = $("status");
  let statusTimer = 0;
  function setStatus(text: string, kind?: string) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = "status show" + (kind ? " " + kind : "");
    if (kind != "error") statusTimer = window.setTimeout(() => status.classList.remove("show"), ms(1600));
  }
  // The room writes files to disk as edits land; there's nothing to save
  // here. Without a connection, edits stay in this tab and sync on return.
  // A short break (the server restarting, a redeploy) passes unseen: the room
  // reconnects by itself and live.js shows a quiet "Reconnecting…" if it
  // takes a few seconds. Only a long one says more.
  let connected = true, offlineTimer = 0, saidOffline = false;
  const OFFLINE_NOTE_MS = 20_000;
  function connectionChanged(now: boolean) {
    if (now == connected) return;
    connected = now;
    live((l) => l.connection("room", now));
    clearTimeout(offlineTimer);
    if (!now) offlineTimer = window.setTimeout(() => { saidOffline = true; setStatus("Offline: your edits are kept in this tab and sync when the host is back", "error"); }, OFFLINE_NOTE_MS);
    else if (saidOffline) { saidOffline = false; setStatus("Back online; edits synced"); }
  }

  /** Someone else's author entry as the marks show it. */
  const markAuthor = (a: Author | null): MarkAuthor | null => a ? { name: a.kind == "disk" ? "Edited on disk" : a.name, color: a.color } : null;

  // Edits from anyone else (a collaborator, an agent, a change on disk)
  // arrive as changes against the current text and are applied in place,
  // marked in their author's colour. They stay out of the undo history:
  // ⌘Z only takes back your own edits.
  function applyRemote(changes: ChangeSet, author: Author | null) {
    if (sourceView) {
      sourceView.dispatch({ changes, annotations: Transaction.addToHistory.of(false), userEvent: "external" });
      page.recordAuthorship(changes, markAuthor(author));
    }
    // The shell's copy of the text takes it either way; the page does when it isn't set aside for the source view.
    page.applyExternal(changes, markAuthor(author));
    // The editor and the room must agree; if they ever don't, the room wins.
    const want = collab.current(), have = currentState().doc.toString();
    if (want != have) {
      console.warn("page editor: out of step with the room; resyncing");
      const fix = changesBetween(have, want);
      if (sourceView) sourceView.dispatch({ changes: fix, annotations: Transaction.addToHistory.of(false), userEvent: "external" });
      page.applyExternal(fix, null);
    }
    queuePeers();
  }

  // Changes the editor can't make in place (another file in the folder: a
  // stylesheet, a script; or a script in the page itself) need the page
  // rendered again. While the agent is working that waits for the end of its
  // turn, so a half-built script never runs; a pill says it's pending and
  // offers to refresh now. Otherwise it happens straight away. Either way the
  // new page renders out of sight and takes the old one's place scrolled to
  // the same text. Everything else shows as it's made.
  let reloadTimer = 0;
  // Whether any agent in the room (yours or anyone's) is mid-turn: a
  // structural re-render waits for it, so half-built changes never render.
  let agentIsBusy = false;
  const shownProblems = new Set<string>();
  let refreshPending = false;
  const refreshPill = $("refresh-pill");
  function refreshPage() {
    refreshPending = false;
    refreshPill.hidden = true;
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      if (mode != "text") return; // the page renders afresh on the way back
      page.render();
    }, 120);
  }
  function needRefresh() {
    if (!agentIsBusy) { refreshPage(); return; }
    refreshPending = true;
    renderRefreshPill();
  }
  function renderRefreshPill() {
    refreshPill.hidden = !refreshPending;
    if (!refreshPending) return;
    const who = busyAgents();
    const names = who.length ? who.join(" and ") : "the agent";
    refreshPill.querySelector("span")!.innerHTML = `Page changes will show when ${escapeHtml(names)} ${who.length > 1 ? "finish" : "finishes"} · <b>Refresh now</b>`;
    refreshPill.title = `${names} changed more than text; the page re-renders when ${who.length > 1 ? "they finish" : "it finishes"}.`;
  }
  function setAgentBusy(busy: boolean) {
    if (busy == agentIsBusy) { renderRefreshPill(); return; }
    agentIsBusy = busy;
    if (!busy && refreshPending) refreshPage();
    else renderRefreshPill();
  }
  refreshPill.addEventListener("click", refreshPage);

  // Your agent's events and its requests to look at the page come to your
  // tabs only, over a WebSocket: an EventSource would hold one of the
  // browser's six connections to the host per tab, and with a few tabs open
  // every later request (sending a message) would queue forever.
  let eventTries = 0;
  function listen() {
    const events = new WebSocket(`${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${api("/api/events")}`);
    events.onmessage = (ev) => {
      let msg: { type?: string; ev?: LogEvent; id?: string; req?: ViewRequest; name?: DocName; moved?: { from: string; to: string }; deleted?: string; path?: string } = {};
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type == "agent" && msg.ev) agentEvent(msg.ev);
      else if (msg.type == "model") renderModel(msg as unknown as ModelState);
      else if (msg.type == "view" && msg.id && msg.req?.live) answerLive(msg.id, msg.req.live);
      else if (msg.type == "view" && msg.id) answerView(msg.id, msg.req ?? {});
      else if (msg.type == "name" && msg.name) showName(msg.name);
      else if (msg.type == "versions" || msg.type == "home" || msg.type == "site") docSettings?.event(msg.type);
      else if (msg.type == "tree") treeChanged(msg);
      // Your agent (or an external one, as you) opened another page: go there (open_page).
      else if (msg.type == "open" && msg.path && msg.path != info!.path) openPage(msg.path);
    };
    // Events sent while the channel was down are gone; catch up from the transcript.
    // A rename missed meanwhile (or before it first opened) is caught up the same way.
    // The body's erga-listening class: the channel is up, so this tab hears its agent (and open_page counts it). Tests wait on it.
    events.onopen = () => { eventTries = 0; live((l) => l.connection("events", true)); document.body.classList.add("erga-listening"); if (opened) { loadAgent(); docSettings?.event("versions"); docSettings?.event("home"); docSettings?.event("site"); } opened = true; refreshName(); stillHere(); };
    // Down (the server restarted, a redeploy): again, a little later each time it fails.
    events.onclose = () => { live((l) => l.connection("events", false)); document.body.classList.remove("erga-listening"); setTimeout(listen, backoff(eventTries++)); };
  }
  let opened = false;
  listen();

  // The document's file tree changed (anyone's doing: document/pages.ts). Whatever shows the tree hears it as an
  // "erga-tree" event on window (the event's detail is the message: { type: "tree", moved?, deleted? }) and
  // fetches it again (the tree, document/pages.ts, does both). This page, moved, goes to where it went; deleted, to the document's own.
  function treeChanged(msg: { moved?: { from: string; to: string }; deleted?: string }) {
    window.dispatchEvent(new CustomEvent("erga-tree", { detail: { type: "tree", ...msg } }));
    const under = (p: string) => pagePath == p || pagePath.startsWith(`${p}/`);
    if (msg.moved && under(msg.moved.from)) goTo(addressOf(msg.moved.to + pagePath.slice(msg.moved.from.length)), true);
    else if (msg.deleted && under(msg.deleted)) goTo(addressOf(null), true);
  }
  /**
   * Whether this page is still there, once the event channel is up (a move or delete may have gone by while
   * it wasn't): if it moved, to where it went (the host remembers the latest moves); if it's gone, to the first page.
   */
  async function stillHere() {
    const t = await fetch(api("/api/tree")).then((r) => r.ok ? r.json() as Promise<{ entries: { path: string }[]; moved?: { from: string; to: string }[] }> : null, () => null);
    if (!t || t.entries.some((e) => e.path == pagePath)) return;
    let at = pagePath;
    for (const m of t.moved ?? []) if (at == m.from || at.startsWith(`${m.from}/`)) at = m.to + at.slice(m.from.length);
    goTo(addressOf(t.entries.some((e) => e.path == at) ? at : null), true);
  }

  // ---------------------------------------------------------------- presence

  // Everyone's caret on the page (or in the source view), with their name;
  // agents' carets sit where they last edited, dashed. The avatars at the
  // top say who's here and what each agent is doing. A person with several
  // tabs open is shown by the one they used last, and your own other tabs
  // not at all (Collab.shown).
  function busyAgents(): string[] {
    return collab.others().filter((p) => p.user.kind == "agent" && p.busy).map((p) => p.user.name);
  }
  function presenceChanged() {
    setAgentBusy(busyAgents().length > 0 || log.busy);
    renderPeople();
    queuePeers();
  }
  let peersQueued = false;
  function queuePeers() {
    if (peersQueued) return;
    peersQueued = true;
    requestAnimationFrame(() => { peersQueued = false; paintPeers(); });
  }
  function paintPeers() {
    const peers: Peer[] = [];
    for (const p of collab.shown()) {
      // Agents' carets aren't drawn: one left where an agent last edited
      // lingers on the page and distracts. Their avatars say what they're doing.
      if (p.user.kind == "agent") continue;
      const at = collab.positions(p);
      if (!at) continue;
      peers.push({ key: p.client, name: p.user.name, color: p.user.color, anchor: at.anchor, head: at.head, agent: false, activity: null });
    }
    if (sourceView && source) sourceView.dispatch({ effects: source.setPeers.of(peers) });
    else page.setPeers(peers);
  }
  // This tab's caret, for everyone else. It stays where you left it when
  // you switch away, as a caret on paper would (but with another of your
  // tabs in use since, that one's caret is shown instead).
  let cursorQueued = false;
  function queueCursor() {
    if (cursorQueued) return;
    cursorQueued = true;
    requestAnimationFrame(() => {
      cursorQueued = false;
      const sel = currentState().selection.main;
      collab.setCursor(sel.anchor, sel.head);
    });
  }

  const people = $("people"), meSlot = $("me");
  function renderPeople() {
    // One avatar per person: everyone else on the left of the controls, you
    // at the far right. A person's agent, once it has done
    // something, is a small badge on their avatar that spins while it works.
    const persons = new Map<string, Presence>(), agents = new Map<string, Presence>();
    for (const p of collab.shown()) {
      if (p.user.kind == "agent") {
        if (!p.busy && !p.cursor) continue;
        const prev = agents.get(p.user.user);
        if (!prev || (p.busy && !prev.busy)) agents.set(p.user.user, p);
      } else if (p.user.kind == "person") persons.set(p.user.user, p);
    }
    const all: { p: Presence; here: boolean }[] = [{ p: { client: -1, user: me } as Presence, here: true }, ...[...persons.values()].map((p) => ({ p, here: true }))];
    // An agent keeps working with its person's tabs closed: show them, faded, to carry it.
    for (const [user, a] of agents) {
      if (user != me.user && !persons.has(user)) all.push({ p: { client: -2, user: { user, name: a.user.name.replace(/[’']s agent$/, ""), color: a.user.color, kind: "person" } } as Presence, here: false });
    }
    people.textContent = meSlot.textContent = "";
    for (const { p, here } of all) {
      const wrap = document.createElement("span");
      wrap.className = "person";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "avatar" + (p.client == -1 ? " me" : "") + (here ? "" : " away");
      b.style.setProperty("--c", p.user.color);
      b.textContent = (p.user.name.trim()[0] ?? "?").toUpperCase();
      const picture = pictureOf(p.user);
      if (picture) {
        const img = document.createElement("img");
        img.src = picture;
        img.alt = "";
        img.draggable = false; // a click, not the browser's drag of the picture
        img.addEventListener("error", () => img.remove()); // the initial shows through
        b.append(img);
      }
      b.dataset.tip = p.client == -1 ? `You (${me.name})` : here ? p.user.name : `${p.user.name} (not here)`;
      if (p.client == -1) accountButton(b);
      else if (here) revealOnClick(b, p, " (not in the text yet)");
      else b.setAttribute("aria-disabled", "true");
      b.setAttribute("aria-label", b.dataset.tip);
      wrap.append(b);
      const a = agents.get(p.user.user);
      if (a) {
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "agent-badge" + (a.busy ? " busy" : "");
        badge.style.setProperty("--c", a.user.color);
        badge.innerHTML = `<span aria-hidden="true">✦</span>`;
        badge.dataset.tip = `${a.user.name}: ${a.busy ? a.activity ?? "working" : "idle"}`;
        revealOnClick(badge, a, " (hasn't edited yet)");
        badge.setAttribute("aria-label", badge.dataset.tip);
        wrap.append(badge);
      }
      (p.client == -1 ? meSlot : people).append(wrap);
    }
  }
  // Your avatar opens a small menu: who you are, Documents, Settings,
  // Deploy your own if the deploy_page setting lets you, Admin settings if you're an admin, Sign out (the same as every other page's upper
  // right, server/account-menu.ts). The front door says which links (meta erga-account).
  const account = $("account");
  const accountLinks = (() => {
    try { return JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="erga-account"]')?.content ?? "") as { docs?: string; settings?: string; deploy?: string; admin?: string; signOut?: string }; } catch { return null; }
  })();
  let accountBtn: HTMLElement | null = null;
  function accountButton(b: HTMLElement) {
    accountBtn = b;
    if (!accountLinks) { b.setAttribute("aria-disabled", "true"); return; }
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-controls", "account");
    b.setAttribute("aria-expanded", String(!account.hidden));
    b.addEventListener("click", () => toggleAccount());
  }
  function toggleAccount(force?: boolean) {
    const open = typeof force == "boolean" ? force : account.hidden;
    if (open && !accountLinks) return;
    account.hidden = !open;
    accountBtn?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    showChrome(); toggleHelp(false); toggleSharing(false); toggleNaming(false); togglePages(false); docSettings?.toggle(false);
    $("account-name").textContent = me.name;
    $("account-login").textContent = me.name.toLowerCase() == me.user ? "" : me.user;
    const set = (id: string, href: string | undefined) => { const a = $(id) as HTMLAnchorElement; a.hidden = !href; if (href) a.href = href; };
    set("account-docs", me.user.startsWith("test-") ? undefined : accountLinks!.docs);
    set("account-settings", me.user.startsWith("test-") ? undefined : accountLinks!.settings);
    set("account-deploy", accountLinks!.deploy);
    set("account-admin", accountLinks!.admin);
    set("account-out", accountLinks!.signOut);
  }
  /**
   * A participant's picture: only GitHub avatars, since anyone in the room
   * can put anything in their presence and we'd rather not fetch it.
   */
  function pictureOf(user: Author): string | null {
    try { return user.avatar && new URL(user.avatar).origin == "https://avatars.githubusercontent.com" ? user.avatar : null; } catch { return null; }
  }
  /** Clicking a participant scrolls to their caret; with none yet, the button says so. */
  function revealOnClick(b: HTMLElement, p: Presence, none: string) {
    const at = collab.positions(p);
    if (at) b.addEventListener("click", () => { page.reveal(at.head ?? at.anchor); });
    else { b.setAttribute("aria-disabled", "true"); b.dataset.tip += none; }
  }

  // ---------------------------------------------------------------- chrome

  const WAKE_PX = 30, WAKE_MS = 400, TYPING_GRACE_MS = 600;
  let chromeHidden = false;
  let anchor: { x: number; y: number; t: number } | null = null;
  let lastKeyAt = 0;
  function hideChrome() {
    if (chromeHidden || docSettings?.isOpen() || !$("help").hidden || !$("sharing").hidden || !$("naming").hidden || !$("account").hidden) return;
    chromeHidden = true;
    anchor = null;
    document.body.classList.add("chrome-hidden");
  }
  function showChrome() {
    if (!chromeHidden) return;
    chromeHidden = false;
    document.body.classList.remove("chrome-hidden");
  }
  function pointerMoved(e: MouseEvent) {
    if (!chromeHidden) return;
    const now = performance.now();
    if (now - lastKeyAt < TYPING_GRACE_MS) { anchor = null; return; }
    if (!anchor || now - anchor.t > WAKE_MS) { anchor = { x: e.clientX, y: e.clientY, t: now }; return; }
    if (Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > WAKE_PX) showChrome();
  }
  window.addEventListener("keydown", () => { lastKeyAt = performance.now(); }, true);
  window.addEventListener("mousemove", pointerMoved, { passive: true });

  // The on-screen keyboard. Where the browser lays it over the page instead
  // of resizing the window (Safari), --kb is its height, and the page, the
  // source view, the cards and the agent stop above it. Zoomed
  // in, the visual viewport is small for another reason: none of it is keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const keyboard = () => {
      const kb = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--kb", `${kb}px`);
    };
    vv.addEventListener("resize", keyboard);
    vv.addEventListener("scroll", keyboard);
  }

  const help = $("help");
  function toggleHelp(force?: boolean) {
    const open = typeof force == "boolean" ? force : help.hidden;
    help.hidden = !open;
    if (open) { showChrome(); toggleSharing(false); toggleNaming(false); togglePages(false); toggleAccount(false); docSettings?.toggle(false); }
  }

  // Share with an external agent: a prompt carrying this page's API and your
  // agent token (server/tokens.ts: the share button's, the same until rotated), which
  // lets the agent call your agent's tools here (document/host.ts, /api/ext) and act
  // as you on the rest of the server.
  const shareBtn = $("btn-share");
  function promptFor(token: string): string {
    const api = `${location.origin}${BASE}/api/ext`;
    return `I'd like your help editing "${info?.path ?? info?.name ?? "the document"}", an Erga document I have open in my editor. You can read and change it through the editor's API, working as my agent: your edits show up in my editor as you make them.

API: ${api}
Token: ${token}

Send the token on every request, as the header "Authorization: Bearer ${token}". Start by reading the API guide, which explains the tools and how to call them:

curl -s -H "Authorization: Bearer ${token}" ${api}

The same token works for the rest of Erga as me (my other documents, new ones, publishing a site): ${location.origin}/api/ext explains it, if I ask for that.

Once you've read the guide, await further instructions.`;
  }
  const { toggle: loadAgentShare } = shareWithAgent({
    into: $("sharing-agent"),
    title: "Share with an agent",
    intro: "Paste a prompt into Claude Code, Codex or another agent that can run commands. It edits this page as you.",
    note: `Anyone with this token can act as you on Erga: edit this document as your agent, and your other documents too. New token turns the old one off; <a href="/settings" target="_blank">your settings</a> lists and revokes them all.`,
    token: (rotate) => fetch(api("/api/share"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }), signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the host answered ${r.status}`))) as Promise<{ token: string }>)
      .then((r) => r.token, (e: Error) => Promise.reject(e.name == "TimeoutError" ? new Error("the editor's host didn't answer") : e)),
    prompt: promptFor,
  });

  // Share (#btn-share, the Share card): with people, then with an agent (above). With people: who may view or edit the
  // document, and anyone signed in with the link. Only its owner may (the front door says where, meta erga-share), so the
  // card's people half shows for them alone; each change is saved as it's made (/docs/share, as on My Documents' share dialog).
  const sharing = $("sharing");
  const sharingList = $("sharing-list"), sharingAdd = $("sharing-add") as HTMLFormElement;
  const sharingAnyone = $("sharing-anyone") as HTMLSelectElement, sharingStatus = $("sharing-status");
  const shareAt = document.querySelector<HTMLMetaElement>('meta[name="erga-share"]')?.content ?? "";
  const docId = BASE.replace(/^\/d\//, "");
  $("sharing-people").hidden = !shareAt;
  type Shared = { permissions: { login: string; role: string }[]; notUsers?: string[]; avatars?: Record<string, string> };
  const tellSharing = (text: string, error = false) => { sharingStatus.textContent = text; sharingStatus.classList.toggle("error", error); };
  async function shareCall(change?: { login: string; role: string }): Promise<Shared> {
    const r = await fetch(change ? shareAt : `${shareAt}${shareAt.includes("?") ? "&" : "?"}id=${docId}`,
      change ? { method: "POST", body: new URLSearchParams({ id: docId, ...change }), headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) } : { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body as Shared;
  }
  function renderSharing({ permissions, notUsers, avatars }: Shared) {
    sharingList.textContent = "";
    const pending = new Set(notUsers ?? []);
    let anyone = "none";
    for (const p of permissions) {
      if (p.login == "*") { anyone = p.role; continue; }
      const li = Object.assign(document.createElement("li"), { className: "share-grid" });
      const face = Object.assign(document.createElement("span"), { className: "face", textContent: p.login.slice(0, 1).toUpperCase() });
      face.setAttribute("aria-hidden", "true");
      face.style.setProperty("--c", colorFor(p.login));
      // Their picture, as the header's avatars show it; the initial stays under it, and shows if it doesn't load.
      const picture = avatars?.[p.login] && pictureOf({ avatar: avatars[p.login] } as Author);
      if (picture) {
        const img = Object.assign(document.createElement("img"), { src: picture, alt: "", draggable: false });
        img.addEventListener("error", () => img.remove());
        face.append(img);
      }
      li.append(face);
      const who = Object.assign(document.createElement("span"), { className: "who", textContent: p.login });
      if (p.login == me.user) who.append(Object.assign(document.createElement("small"), { textContent: "you" }));
      if (pending.has(p.login)) who.append(Object.assign(document.createElement("small"), { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" }));
      li.append(who);
      if (p.role == "owner") li.append(Object.assign(document.createElement("span"), { className: "fixed", textContent: "Owner" }), document.createElement("span"));
      else {
        const role = Object.assign(document.createElement("select"), { className: "role" });
        role.setAttribute("aria-label", `Role for ${p.login}`);
        for (const [v, t] of [["editor", "Can edit"], ["viewer", "Can view"]]) role.append(new Option(t, v, false, v == p.role));
        role.addEventListener("change", () => changeSharing(p.login, role.value));
        const x = Object.assign(document.createElement("button"), { type: "button", className: "remove", textContent: "×", title: `Stop sharing with ${p.login}` });
        x.setAttribute("aria-label", x.title);
        x.addEventListener("click", () => changeSharing(p.login, "none"));
        li.append(role, x);
      }
      sharingList.append(li);
    }
    sharingAnyone.value = anyone;
  }
  async function changeSharing(login: string, role: string): Promise<boolean> {
    tellSharing("Saving…");
    try { renderSharing(await shareCall({ login, role })); tellSharing(""); return true; }
    catch (e) { tellSharing((e as Error).message, true); return false; }
  }
  function toggleSharing(force?: boolean) {
    const open = typeof force == "boolean" ? force : sharing.hidden;
    sharing.hidden = !open;
    shareBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    showChrome(); toggleHelp(false); toggleNaming(false); togglePages(false); toggleAccount(false); docSettings?.toggle(false); showPauseCard(false);
    loadAgentShare(true);
    if (!shareAt) return;
    sharingAdd.reset();
    tellSharing("Loading…");
    (sharingAdd.elements.namedItem("login") as HTMLInputElement).focus();
    shareCall().then((d) => { renderSharing(d); tellSharing(""); }, (e: Error) => tellSharing(e.message, true));
  }
  shareBtn.addEventListener("click", () => toggleSharing());
  sharingAdd.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = sharingAdd.elements.namedItem("login") as HTMLInputElement;
    const login = input.value.trim().replace(/^@/, "");
    if (login && (await changeSharing(login, (sharingAdd.elements.namedItem("role") as HTMLSelectElement).value))) input.value = "";
  });
  sharingAnyone.addEventListener("change", () => changeSharing("*", sharingAnyone.value));
  const copied = $("sharing-copied"), linkHint = copied.textContent;
  let copiedTimer = 0;
  $("sharing-copy").addEventListener("click", async () => {
    const url = location.origin + (docName?.address ?? location.pathname);
    const ok = await navigator.clipboard.writeText(url).then(() => true, () => false);
    if (!ok) { tellSharing(url); return; }
    copied.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copied.textContent = linkHint; }, 2000);
  });
  // Document settings (publishing, versions, the homepage): the gear opens
  // them, a popover under it. Their code
  // loads only when the gear is reached for: hovered, focused or clicked.
  const settingsBtn = $("btn-settings");
  let settingsLoading: Promise<Settings | null> | null = null;
  function loadSettings(): Promise<Settings | null> {
    return settingsLoading ??= import("./settings").then(() => {
      docSettings = window.ergaSettings?.mount({
        docId, query: as, anchor: settingsBtn, admin: !!accountLinks?.admin,
        onToggle: (open) => { if (open) { showChrome(); toggleHelp(false); toggleSharing(false); toggleNaming(false); togglePages(false); toggleAccount(false); } },
      }) ?? null;
      return docSettings;
    }, () => {
      settingsLoading = null;
      live((l) => l.check("a request failed"));
      return null;
    });
  }
  for (const type of ["pointerenter", "focus"]) settingsBtn.addEventListener(type, () => void loadSettings(), { once: true });
  settingsBtn.addEventListener("click", async () => {
    const s = await loadSettings();
    if (s) s.toggle();
    else explain("Couldn't load the document's settings. Check your connection and try again.");
  });
  if (!isMac) {
    for (const k of help.querySelectorAll("kbd")) {
      if (k.textContent == "⌘") k.textContent = "Ctrl";
      else if (k.textContent == "⌥") k.textContent = "Alt";
      else if (k.textContent == "⇧") k.textContent = "Shift";
    }
    for (const b of document.querySelectorAll<HTMLElement>("[data-tip]")) b.dataset.tip = b.dataset.tip!.replace("⌘⇧", "Ctrl+Shift+").replace("⌘", "Ctrl+");
  }
  const toast = $("toast");
  let toastTimer = 0;
  let explaining = 0; // when an explanation went up, or 0
  /** A short confirmation ("Saved"): fades on its own. */
  function flash(text: string, duration = 1400) {
    explaining = 0;
    toast.classList.remove("actionable");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms(duration));
  }
  // An explanation (why something can't be done, or what's wrong with the
  // page) is there to be read: it stays at least EXPLAIN_MS, then until the
  // next click or keypress anywhere. When the document is at fault it never
  // sends you off to fix it by hand: it offers a button that asks the agent
  // to, with a prompt that names the problem.
  const EXPLAIN_MS = ms(5000);
  const problemQueue: { text: string; fix?: string; key?: string }[] = [];
  function explain(text: string, fix?: string, key?: string) {
    clearTimeout(toastTimer);
    toast.textContent = "";
    toast.append(Object.assign(document.createElement("span"), { className: "toast-text", textContent: text }));
    toast.classList.toggle("actionable", !!fix);
    if (fix) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-fix";
      b.textContent = "Fix with agent";
      // aria-disabled, not disabled: it can still say why it can't.
      if (agentOff) { b.setAttribute("aria-disabled", "true"); b.title = agentOff; }
      b.addEventListener("click", () => {
        if (agentOff) { explain(agentOff); return; }
        hideExplanation();
        fixReported(fix, key);
      });
      toast.append(b);
    }
    toast.classList.add("show");
    explaining = performance.now();
  }
  function hideExplanation() {
    explaining = 0;
    clearTimeout(toastTimer);
    // Only "show" goes: the note keeps its content and layout while it fades
    // (the next note replaces both), so nothing jumps on the way out.
    toast.classList.remove("show");
    // The next thing wrong with the page, if more than one thing is.
    const next = problemQueue.shift();
    if (next) toastTimer = window.setTimeout(() => explain(next.text, next.fix, next.key), 250);
  }
  function dismissExplanation(e: Event | null) {
    if (!explaining || (e && toast.contains(e.target as Node))) return;
    const left = EXPLAIN_MS - (performance.now() - explaining);
    clearTimeout(toastTimer);
    if (left > 0) { const shownAt = explaining; toastTimer = window.setTimeout(() => { if (explaining == shownAt) hideExplanation(); }, left); }
    else hideExplanation();
  }
  /** Something wrong with the page that nobody asked about: shown in turn, never on top of another. */
  function reportProblem(text: string, fix: string, key: string) {
    if (explaining || toast.classList.contains("show")) problemQueue.push({ text, fix, key });
    else explain(text, fix, key);
  }
  // Capture phase, before whatever the click or key does (which may explain something new).
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, dismissExplanation, true);
  // Focusing or using this tab makes it the one you're shown by. Focus
  // lands on the frame's window when the caret is in the page.
  const activate = () => collab.activate();
  for (const type of ["focus", "pointerdown", "keydown"]) window.addEventListener(type, activate, true);

  // ---------------------------------------------------------------- the page editor

  const currentState = () => (sourceView ? sourceView.state : page.state);

  // The page editor runs on the document's own origin: the
  // address the front door gave this page (with the token that opens the
  // document's files there), in the frame.
  const pagesUrl = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]')?.content ?? "";
  const page = new RemotePage({
    frame,
    origin: new URL(pagesUrl, location.href).origin,
    dir: dirOf(pagePath),
    text: initialText,
    self,
    tracking: settings.track,
    ...(back && back.path == pagePath ? { selection: back.selection, scroll: back.scroll } : {}),
    onLocal(changes) {
      collab.push(changes);
      hideChrome();
      queueCursor();
      queuePeers();
    },
    onSelection() { queueCursor(); queuePeers(); queueFmt(); },
    onUpdate(rendered) {
      syncZoom();
      if (rendered) {
        syncPause();
        const t = page.title().slice(0, 200);
        document.title = docName?.title ?? (t ? `${t} · ${info!.name}` : info!.name);
        // Not out of the agent panel or an open card (the pages and their menus, the title and address): the page rendering again mustn't take focus from them.
        if (!agentPanel.contains(document.activeElement) && !document.activeElement?.closest(".help, .et-menu") && mode == "text") page.focus();
        queuePeers();
      }
      queueFmt();
    },
    onKey: (keys) => { appShortcut(keys); },
    onNotice: (m, fix) => explain(m, fix),
    // Each problem once, until someone asks the agent to fix it (if it's still broken after, it says so again).
    onProblem: (p) => { if (shownProblems.has(p.key)) return; shownProblems.add(p.key); reportProblem(p.message, p.fix, p.key); },
    onPointer: (kind, x, y) => {
      if (kind == "move") { pointerMoved(new MouseEvent("mousemove", { clientX: x, clientY: y })); return; }
      if (kind == "up") { pointerDown = false; queueFmt(); return; }
      // A click on the page: as one anywhere else in the shell would.
      dismissExplanation(null);
      activate();
      pointerDown = true;
      linkDismissed = false;
      hideFmt();
      if (!help.hidden) toggleHelp(false);
      if (!naming.hidden) toggleNaming(false);
      if (!pagesCard.hidden) togglePages(false);
      if (!sharing.hidden) toggleSharing(false);
      showPauseCard(false);
    },
    onActivity: (kind) => {
      activate();
      if (kind == "key") live((l) => l.activity());
      if (kind == "key") { lastKeyAt = performance.now(); dismissExplanation(null); }
    },
    onBackdrop: (b) => applyBackdrop(b),
    onStale: () => needRefresh(),
    onOpen: (path) => openPage(path),
    onZoom: (by) => zoomPage(by),
  });
  page.start();

  // ---------------------------------------------------------------- zoom

  // Zooming in the editor zooms the page, never the controls or the agent (zoom.ts): the keys, a pinch and ctrl with
  // the wheel, here in the shell or on the page (the frame sends them: onKey, onZoom). Each document keeps its level
  // on this browser. Viewing, the browser zooms the window as it always does. A page that zooms itself (window.ergaZoom:
  // a canvas's camera, with no limits of ours) gets them instead, and is drawn at 100%.
  const ZOOM_KEY = `erga:zoom:v1:${docId}`;
  let zoomLevel = clampZoom(Number(store.get(ZOOM_KEY) ?? 1));
  const syncZoom = (on = editing()) => page.setZoom(on && !page.zoomsItself ? zoomLevel : 1);
  syncZoom();
  function setZoomLevel(level: number) {
    zoomLevel = clampZoom(level);
    syncZoom();
    if (zoomLevel == 1) { try { localStorage.removeItem(ZOOM_KEY); } catch {} }
    else store.set(ZOOM_KEY, String(Math.round(zoomLevel * 1000) / 1000));
    flash(`Zoom ${Math.round(zoomLevel * 100)}%`);
  }
  function zoomPage(by: ZoomBy) {
    if (!editing()) return;
    if (page.zoomsItself) page.zoomItself(zoomFactor(by));
    else setZoomLevel(applyZoom(zoomLevel, by));
  }
  catchZoomGestures(window, zoomPage, editing);

  // ---------------------------------------------------------------- style bar

  // Select text in the page and a small bar floats above it: bold, italic,
  // code, link, clear formatting. Buttons that can't apply say why (title), and so does a click.
  // The link button (⌘K) turns it into the link bar: the link's text, its address, where it opens. A caret
  // in a link (a click in one) shows the link bar too, with the focus left in the page, so typing goes on.
  const fmt = $("fmt");
  const fmtPanes = $("fmt-panes"), fmtStyle = $("fmt-style"), fmtLinkPane = $("fmt-link");
  const linkText = $("fmt-link-text") as HTMLInputElement, linkUrl = $("fmt-link-url") as HTMLInputElement;
  const linkTab = fmt.querySelector<HTMLButtonElement>("[data-link=tab]")!, linkRemove = fmt.querySelector<HTMLButtonElement>("[data-link=remove]")!;
  const coarse = matchMedia("(pointer: coarse)"), still = matchMedia("(prefers-reduced-motion: reduce)");
  let pointerDown = false;
  let fmtQueued = false;
  /** The link bar is open from a selection (the focus is in it), or from the caret in a link; or not open. */
  let linking: "selection" | "caret" | null = null;
  /** The link bar was closed while the caret is in a link: it stays closed until the caret leaves links, or a click. */
  let linkDismissed = false;
  /** The selection the link bar opened on: its changes go there, even after a click has moved the caret. */
  let linkSel: { anchor: number; head: number } | undefined;
  const pageSel = () => { const m = page.state.selection.main; return { anchor: m.anchor, head: m.head }; };
  let morphing = false;
  function queueFmt() {
    if (fmtQueued) return;
    fmtQueued = true;
    requestAnimationFrame(() => { fmtQueued = false; renderFmt(); });
  }
  function hideFmt() {
    fmt.hidden = true;
    linking = null;
    fmtStyle.hidden = false;
    fmtLinkPane.hidden = true;
  }
  function placeFmt(rect: { left: number; top: number; width: number; bottom: number }) {
    const f = frame.getBoundingClientRect();
    // On touch, the system's own copy and paste menu takes the space above a selection.
    const below = rect.top < 56 || coarse.matches;
    const half = (linking ? 300 : coarse.matches ? 220 : 200) / 2 + 10; // half the bar (its buttons are bigger on touch), and a margin
    fmt.style.left = Math.max(half, Math.min(window.innerWidth - half, f.left + rect.left + rect.width / 2)) + "px";
    fmt.style.top = f.top + (below ? rect.bottom : rect.top) + "px";
    fmt.classList.toggle("below", below);
  }
  /** Shows one pane: at once if the bar was hidden, else changing the other into it. */
  function showPane(pane: HTMLElement) {
    const from = pane == fmtStyle ? fmtLinkPane : fmtStyle;
    if (fmt.hidden) {
      from.hidden = true; pane.hidden = false; fmt.hidden = false;
      fmt.classList.remove("appear"); void fmt.offsetWidth; fmt.classList.add("appear");
    } else if (!pane.hidden && from.hidden) return;
    else morphFmt(from, pane);
  }
  function morphFmt(from: HTMLElement, to: HTMLElement) {
    morphing = true;
    const ms = still.matches ? 120 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--morph-ms")) || 240;
    const w0 = fmtPanes.offsetWidth, h0 = fmtPanes.offsetHeight;
    const icon0 = to == fmtLinkPane ? fmt.querySelector("[data-act=link] svg")!.getBoundingClientRect() : null;
    from.hidden = true; to.hidden = false;
    const w1 = fmtPanes.offsetWidth, h1 = fmtPanes.offsetHeight;
    from.hidden = false;
    fmt.classList.add("morphing");
    from.classList.add("out"); to.classList.add("in");
    fmtPanes.style.width = w0 + "px"; fmtPanes.style.height = h0 + "px";
    void fmtPanes.offsetWidth;
    fmtPanes.style.width = w1 + "px"; fmtPanes.style.height = h1 + "px";
    if (icon0 && !still.matches) requestAnimationFrame(() => {
      const svg = $("fmt-link-icon").querySelector("svg")!, icon1 = svg.getBoundingClientRect();
      svg.animate([{ transform: `translate(${icon0.left - icon1.left}px, ${icon0.top - icon1.top}px)`, color: "var(--caret)" }, { transform: "none" }],
        { duration: ms, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" });
    });
    setTimeout(() => {
      from.hidden = true;
      from.classList.remove("out"); to.classList.remove("in");
      fmt.classList.remove("morphing");
      fmtPanes.style.width = fmtPanes.style.height = "";
      morphing = false;
      queueFmt();
    }, ms * 1.25);
  }
  function renderFmt() {
    if (linking == "selection" || morphing || fmtLinkPane.contains(document.activeElement)) return;
    if (mode != "text" || pointerDown) { hideFmt(); return; }
    const rect = page.selectionRect(), link = page.linkAt();
    if (!link) linkDismissed = false;
    if (rect) {
      linking = null;
      placeFmt(rect);
      const why = page.styleBlocker();
      for (const b of fmtStyle.querySelectorAll<HTMLButtonElement>("button")) {
        b.setAttribute("aria-disabled", String(!!why));
        b.dataset.why = why ?? "";
        if (b.dataset.style) b.setAttribute("aria-pressed", String(!why && page.hasStyle(b.dataset.style as InlineStyle)));
        if (b.dataset.act == "link") b.setAttribute("aria-pressed", String(!why && link != null));
        b.title = why ?? b.getAttribute("aria-label")!.replace(/ \((.+)\)$/, "  $1");
      }
      showPane(fmtStyle);
    } else if (link?.rect && !linkDismissed) {
      linking = "caret";
      linkSel = pageSel();
      fillLink(link.text, link);
      placeFmt(link.rect);
      showPane(fmtLinkPane);
    } else hideFmt();
  }
  function setLinkTab(newTab: boolean) {
    linkTab.setAttribute("aria-checked", String(newTab));
    linkTab.querySelector(".fmt-label")!.textContent = newTab ? "Opens in a new tab" : "Opens in this tab";
  }
  function fillLink(text: string, link: { href: string; self: boolean } | null) {
    linkText.value = text;
    linkUrl.value = link?.href ?? "";
    linkRemove.hidden = !link;
    setLinkTab(!link?.self);
  }
  /** The link button, or ⌘K: the link bar for the selection, or the focus to the address of the caret's link. */
  function openLink() {
    if (linking) { linkUrl.focus(); linkUrl.select(); return; }
    const why = page.styleBlocker();
    if (why) { explain(why); return; }
    if (fmt.hidden) renderFmt();
    if (fmt.hidden) return;
    const link = page.linkAt();
    linking = "selection";
    linkSel = pageSel();
    fillLink(link?.text ?? page.selectedText(), link);
    const rect = page.selectionRect();
    if (rect) placeFmt(rect);
    showPane(fmtLinkPane);
    (link ? linkText : linkUrl).focus();
    (link ? linkText : linkUrl).select();
  }
  /** An address as typed: one with no scheme that looks like a site's gets https://. */
  function linkAddress(url: string): string {
    url = url.trim();
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || /^[#/?.]/.test(url)) return url;
    return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(url) ? "https://" + url : url;
  }
  /** Leaves the link bar: back to the style bar for a selection; for a caret, closed until the caret leaves links. */
  function closeLink() {
    if (linking == "caret") linkDismissed = true;
    linking = null;
    page.focus();
    if (linkDismissed) hideFmt();
    queueFmt();
  }
  function applyLink(edit: { url: string; text?: string; self?: boolean }) {
    const wasCaret = linking == "caret", at = linkSel;
    closeLink();
    page.setLink({ ...edit, at }).then((why) => {
      if (why) explain(why);
      if (wasCaret) linkDismissed = true;
      queueFmt();
    });
  }
  const applyFields = () => applyLink({ url: linkAddress(linkUrl.value), text: linkText.value, self: linkTab.getAttribute("aria-checked") != "true" });
  fmt.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });
  fmt.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.dataset.why) { explain(b.dataset.why); return; }
    if (b.dataset.style) page.toggleStyle(b.dataset.style as InlineStyle).then((why) => { if (why) explain(why); queueFmt(); });
    else if (b.dataset.act == "link") openLink();
    else if (b.dataset.act == "clear") page.clearStyles().then((why) => { if (why) explain(why); queueFmt(); });
    else if (b.dataset.link == "close") closeLink();
    else if (b.dataset.link == "remove") applyLink({ url: "" });
    else if (b.dataset.link == "open") {
      const url = linkAddress(linkUrl.value);
      if (/^(https?:|mailto:)/i.test(url)) window.open(url, "_blank", "noopener");
      else explain(url ? "Only web and email addresses open from here." : "Type an address to open it.");
    } else if (b.dataset.link == "tab") {
      const newTab = linkTab.getAttribute("aria-checked") != "true";
      setLinkTab(newTab);
      // On a link that's there, at once; a new link takes it with the rest.
      const link = page.linkAt();
      if (link) page.setLink({ url: link.href, self: !newTab, at: linkSel }).then((why) => { if (why) explain(why); else flash(newTab ? "The link opens in a new tab" : "The link opens in this tab"); });
    }
  });
  for (const input of [linkText, linkUrl]) input.addEventListener("keydown", (e) => {
    if (e.key == "Enter") { e.preventDefault(); applyFields(); }
  });
  // The focus leaving the link bar (a click on the page, say) applies what's in it.
  fmtLinkPane.addEventListener("focusout", (e) => {
    if (fmtLinkPane.contains(e.relatedTarget as Node | null) || !linking) return;
    applyFields();
  });
  window.addEventListener("resize", () => queueFmt());

  // ---------------------------------------------------------------- views

  // Two views of the document: the page itself, and the file's source (its
  // HTML), editable, with the page's state and undo history.
  // ⌘⇧P goes between them.
  type Mode = "text" | "html";
  let mode: Mode = "text";
  let sourceView: EditorView | null = null;

  // Opening the source view waits for the page to hand over its state; a switch asked for meanwhile waits its turn.
  let switching: Promise<void> = Promise.resolve();
  function setMode(next: Mode) {
    switching = switching.then(() => switchMode(next));
  }
  async function switchMode(next: Mode) {
    if (next == mode) return;
    // Leave the current view; the source view hands the state back to the page.
    if (sourceView) {
      const st = sourceView.state;
      sourceView.destroy();
      sourceView = null;
      page.attach(st, source!.sourceHistory);
    }
    let handed: EditorState | null = null;
    if (next != "text") {
      let code: typeof import("./source-view");
      try { code = await loadSource(); } catch { flash("Couldn't open the source: check your connection and try again.", 4000); return; }
      handed = (await page.detach(code.sourceState(sourceHooks))).state;
    }
    mode = next;
    if (next == "text") {
      $("source").hidden = true;
      document.body.classList.remove("source");
      page.focus();
    } else {
      sourceView = source!.openSource($("source"), handed!);
      $("source").hidden = false;
      document.body.classList.add("source");
      sourceView.focus();
    }
    queuePeers();
    queueFmt();
  }
  /** ⌘⇧P: between the page and the file's own source. */
  const toggleSource = (force?: boolean) => setMode((typeof force == "boolean" ? force : mode == "text") ? "html" : "text");

  // ---------------------------------------------------------------- view_page

  // The agent asks to see the page: the page editor's frame draws it,
  // with the latest edits, and the picture goes back to the agent.
  // No server-side browser: whoever has the editor open is the agent's eyes.
  const captureView = (req: ViewRequest) => page.capture(req);
  async function answerView(id: string, req: ViewRequest) {
    // Render only once this tab has every edit the agent had made when it asked.
    if (req.after) await collab.waitFor(req.after);
    const result = await captureView(req);
    await fetch(api("/api/agent/view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...result }) }).catch(() => {});
  }

  // ---------------------------------------------------------------- the live page

  // The agent's page_console, page_network, page_events, page_inspect, page_click and page_key: the page as it runs
  // in this tab (live-page.ts, in the frame). Every tab of the person's answers; the host takes the focused one's,
  // else a visible one's. page_inspect, page_click and page_key show a line here each time, so the person sees what
  // the agent does in their page.
  const liveBar = $("agent-live");
  const liveText = $("agent-live-text");
  let liveTimer = 0;
  /** The bar over the page: the agent's last action there, for a moment. */
  function renderLiveBar(line?: string) {
    clearTimeout(liveTimer);
    liveText.textContent = line ?? "";
    liveBar.hidden = !line;
    if (line) liveTimer = window.setTimeout(() => renderLiveBar(), ms(4000));
  }
  const lineFor = (req: LiveRequest) => req.kind == "click" ? `The agent clicked ${req.selector ?? `the point (${req.x}, ${req.y})`}`
    : req.kind == "key" ? `The agent pressed ${req.key}${req.selector ? ` on ${req.selector}` : ""}`
    : req.kind == "inspect" ? (req.expression ? `The agent inspected the page: ${req.expression.replace(/\s+/g, " ").slice(0, 80)}` : "The agent read the page's media and permissions")
    : "";
  async function answerLive(id: string, req: LiveRequest) {
    const tab = { page: pagePath, visible: document.visibilityState == "visible", focused: document.hasFocus() };
    if (shownInTab(req)) renderLiveBar(lineFor(req));
    const result: LiveResult = await page.live(req, (req.kind == "inspect" ? 20_000 : 8_000));
    if (req.kind == "console" && result.console) {
      // The page's entries and this window's, together.
      const r = queryConsole([...result.console.entries, ...queryConsole(shellConsole.entries(), { ...req, limit: 200 }).entries], req);
      result.console = { entries: r.entries, matched: Math.max(r.matched, result.console.matched), total: result.console.total + shellConsole.total, dropped: result.console.dropped + shellConsole.dropped };
    }
    if (req.kind == "inspect" && Array.isArray(result.inspect?.facts)) {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
      result.inspect!.facts = [{ frame: "the editor (the tab itself)", url: location.origin, userActivation: ua ? { isActive: ua.isActive, hasBeenActive: ua.hasBeenActive } : "not supported here", editorFrame: { sandbox: frame.getAttribute("sandbox"), allow: frame.getAttribute("allow") } }, ...result.inspect!.facts as unknown[]];
    }
    const declined = result.error != null;
    const rank = tab.focused ? 2 : tab.visible ? 1 : 0;
    await fetch(api("/api/agent/view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, width: 0, height: 0, errors: [], value: JSON.stringify({ ...result, tab }), declined, rank }) }).catch(() => {});
  }

  // ---------------------------------------------------------------- the agent

  const agentPanel = $("agent");
  // Where the agent and the steps list sit around the document, and how wide the agent is.
  mountLayout(agentPanel, agentPanel.querySelector<HTMLElement>(".agent-head")!);
  const agentLog = $("agent-log");
  const agentInput = $("agent-input") as HTMLTextAreaElement;
  const agentSend = $("agent-send") as HTMLButtonElement;
  const agentHint = $("agent-hint");
  // Why the agent can't take a message right now, shown in the panel until it can.
  let agentOff: string | null = "Connecting to the agent…";
  /** The live voice session (voice mode, below), or null when it's off. `sent` counts the session's results already sent, of `results` heard so far. */
  let voice: { rec: Recognition; before: string; sent: number; results: number; heard: string; partial: boolean; timer: number } | null = null;
  let hintTimer = 0;

  // The conversation as the log shows it (agent-chat.ts, which the admin's panel shares).
  const agentChat = chat({
    logEl: agentLog, jump: $("agent-jump") as HTMLButtonElement,
    verbs: { read: ["Reading", "Read"], edit: ["Editing", "Edited"], write: ["Writing", "Wrote"], ls: ["Listing", "Listed"], find: ["Finding files", "Found files"], grep: ["Searching", "Searched"], view_page: ["Looking at the page", "Looked at the page"], evaluate_page: ["Inspecting the page", "Inspected the page"], page_console: ["Reading the page's console", "Read the page's console"], page_network: ["Reading the page's requests", "Read the page's requests"], page_events: ["Reading the page's events", "Read the page's events"], page_inspect: ["Inspecting the live page", "Inspected the live page"], page_click: ["Clicking on the page", "Clicked on the page"], page_key: ["Pressing a key on the page", "Pressed a key on the page"] },
    externalTip: "An agent you shared this page with, working as your agent",
  });
  const log: Log = agentChat.log;
  const follow = agentChat.follow;
  // Files to go with the next message: dropped on the panel, pasted, or picked (attach-ui.ts, as on the admin pages).
  const agentFiles = attachments({ pane: agentPanel, form: $("agent-form"), input: agentInput, hint: (t) => showHint(t), changed: () => renderBusy() });
  function renderLog() {
    agentChat.render();
    renderBusy();
  }
  /** Why Send can't send right now, or null if it can. Never a silent no. */
  function sendBlocker(): string | null {
    if (agentOff) return agentOff;
    if (voice) return "Voice mode is on: what you say is sent when you pause.";
    if (agentFiles.reading) return "Reading the attached files…";
    if (!log.busy && !agentInput.value.trim() && !agentFiles.files.length) return "Type a message to send it.";
    return null;
  }
  function renderBusy() {
    // In voice mode the button can't send, so while the agent works it's Stop.
    const stop = log.busy && (!!voice || (!agentInput.value.trim() && !agentFiles.files.length && !agentFiles.reading));
    const why = agentOff ?? (stop ? null : sendBlocker());
    agentSend.textContent = stop ? "Stop" : "Send";
    agentSend.classList.toggle("stop", stop);
    // aria-disabled rather than disabled: a disabled button gets no hover or
    // click, so it could never say why it's disabled.
    agentSend.setAttribute("aria-disabled", String(!!why));
    agentSend.title = why ?? (stop ? "Stop the agent" : log.busy ? "Send (Enter); the agent will take it into account as it works" : "Send (Enter)");
    agentInput.placeholder = agentOff ? "The agent is off" : voice ? "Listening… pause to send" : log.busy ? "Add to what the agent is doing…" : "Ask the agent…";
    if (agentOff) showHint(agentOff, true);
    else if (agentHint.classList.contains("sticky")) hideHint();
    $("agent-fab").classList.toggle("busy", log.busy);
  }
  function showHint(text: string, sticky = false) {
    clearTimeout(hintTimer);
    agentHint.textContent = text;
    agentHint.hidden = false;
    agentHint.classList.toggle("sticky", sticky);
    if (!sticky) hintTimer = window.setTimeout(hideHint, ms(2600));
  }
  function hideHint() {
    clearTimeout(hintTimer);
    agentHint.hidden = true;
    agentHint.classList.remove("sticky");
  }
  function agentEvent(ev: LogEvent) {
    agentChat.apply(ev);
    if (ev.t == "busy") setAgentBusy(ev.busy || busyAgents().length > 0);
    if (ev.t == "undoable") renderUndo();
    renderBusy();
  }

  /** Where the user is in the document, so "this" and "here" mean something to the agent. */
  function editorContext(): string {
    const at = addressOf(info!.path).replace(/[?#].*$/, "");
    return `The user has the page ${info!.path} open (${at}).\n${viewContext()}\n${caretContext()}`;
  }
  /** How the user sees the page: view_page renders at this size and in this mode unless asked otherwise. */
  function viewContext(): string {
    const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const w = frame.clientWidth, h = frame.clientHeight;
    return `${w && h ? `Their window shows the page at ${w}×${h} CSS pixels` : "Their window shows the source, not the page"}, in ${scheme} mode.`;
  }
  function caretContext(): string {
    const s = currentState();
    const sel = s.selection.main;
    const line = s.doc.lineAt(sel.from);
    if (!sel.empty) {
      const endLine = s.doc.lineAt(sel.to).number;
      const text = s.sliceDoc(sel.from, sel.to);
      return `The user has selected lines ${line.number}-${endLine} of ${info!.name}:\n${text.length > 4000 ? text.slice(0, 4000) + "\n[...]" : text}`;
    }
    const text = line.text.length > 400 ? line.text.slice(0, 400) + "[...]" : line.text;
    return `The user's caret is on line ${line.number} of ${info!.name}: ${text}`;
  }

  async function sendToAgent() {
    const text = agentInput.value.trim();
    const files = agentFiles.files;
    const why = sendBlocker();
    if (why || (!text && !files.length)) {
      showHint(why ?? "Type a message to send it.", !!agentOff);
      agentInput.focus();
      return;
    }
    agentInput.value = "";
    saveDraft();
    agentFiles.clear();
    sizeInput();
    await ask(text, editorContext(), files);
  }
  // A message shows in the log the moment it's sent, dimmed until the host
  // echoes it back as the conversation's (which replaces it). If it can't be
  // sent, it says so, with a way to try again: never a send that silently
  // goes nowhere.
  async function ask(text: string, context: string | null, files: Attachment[] = []) {
    const sent = agentChat.pending(text, fileRefs(files));
    // The agent reads the shared doc; `after` makes the host wait until the
    // room has every edit this tab had made (they travel over the WebSocket).
    // While the host restarts (a redeploy) it doesn't answer, or its gateway says so: the message waits and goes once it's back.
    let res: Response | Error = new Error("not sent");
    for (let i = 0, until = Date.now() + 45_000; ; i++) {
      res = await fetch(api("/api/agent"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context, after: collab.vector(), files }), signal: AbortSignal.timeout(files.length ? 60_000 : 15_000) }).catch((e: Error) => e);
      if (res instanceof Response ? res.ok || !transient(res) : res.name == "TimeoutError" || !transient(res)) break;
      if (Date.now() + backoff(i) > until) break;
      await new Promise((r) => setTimeout(r, backoff(i)));
    }
    if (!(res instanceof Response) || !res.ok) {
      const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string } | null)?.reason ?? `the host answered ${res.status}` : res.name == "TimeoutError" ? "the editor's host didn't answer in time" : "the editor's host didn't answer";
      sent.fail(reason, () => ask(text, context, files));
    }
    renderBusy();
  }
  // Voice mode: what you say is dictated into the box and sent when you
  // pause, through the browser's speech recognition (Chrome sends the audio
  // to Google; Safari to Apple). While the agent works, each send steers it,
  // as typing does. The browser's own final results come at every breath, so
  // a pause is our own: no new words for PAUSE_MS. Then everything heard is
  // sent, words not yet final included, and if there were any the session is
  // restarted so they can't arrive again later.
  type Recognition = EventTarget & {
    continuous: boolean; interimResults: boolean; lang: string;
    start(): void; stop(): void; abort(): void;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
  };
  const Speech = ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;
  const PAUSE_MS = 1000;
  const agentVoice = $("agent-voice") as HTMLButtonElement;
  agentVoice.hidden = !Speech;
  function listenVoice(before: string) {
    const rec = new Speech!();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    const v = voice = { rec, before, sent: 0, results: 0, heard: "", partial: false, timer: 0 };
    rec.onresult = (e) => {
      if (voice != v) return;
      let heard = "", partial = false;
      for (let i = v.sent; i < e.results.length; i++) {
        heard += e.results[i][0].transcript;
        if (!e.results[i].isFinal) partial = true;
      }
      Object.assign(v, { heard, partial, results: e.results.length });
      agentInput.value = (v.before + " " + heard).trim();
      sizeInput();
      clearTimeout(v.timer);
      v.timer = window.setTimeout(voiceSend, ms(PAUSE_MS));
    };
    rec.onerror = (e) => {
      if (voice != v) return;
      if (e.error == "not-allowed" || e.error == "service-not-allowed") { stopVoice(); showHint("Voice mode needs the microphone: allow it for this site, then try again.", true); }
      else if (e.error == "network") { stopVoice(); showHint("Voice mode couldn't reach the browser's speech service."); }
      else if (e.error == "audio-capture") { stopVoice(); showHint("Voice mode couldn't find a microphone."); }
      // "no-speech" and "aborted": the session ends and onend starts another.
    };
    // Recognition ends on its own (silence, a time limit); keep listening.
    rec.onend = () => { if (voice == v) listenVoice((v.before + " " + v.heard).trim()); };
    try { rec.start(); } catch { stopVoice(); }
  }
  function voiceSend() {
    const v = voice;
    if (!v) return;
    const text = (v.before + " " + v.heard).trim();
    if (!text) return;
    if (agentOff) { showHint(agentOff, true); return; } // kept in the box until the agent's back
    v.before = "";
    v.heard = "";
    agentInput.value = "";
    saveDraft();
    const files = agentFiles.files;
    agentFiles.clear();
    sizeInput();
    ask(text, editorContext(), files);
    // Words sent before they were final would come back final: start afresh.
    if (v.partial) { v.partial = false; v.rec.abort(); }
    else v.sent = v.results;
  }
  function startVoice() {
    if (!Speech || voice) return;
    agentVoice.setAttribute("aria-pressed", "true");
    agentInput.readOnly = true;
    listenVoice(agentInput.value.trim());
    renderBusy();
  }
  /** Leaves voice mode; anything heard since the last send stays in the box, to edit or send. */
  function stopVoice() {
    const v = voice;
    if (!v) return;
    voice = null;
    clearTimeout(v.timer);
    v.rec.abort();
    agentVoice.setAttribute("aria-pressed", "false");
    agentInput.readOnly = false;
    saveDraft();
    renderBusy();
    if (document.body.classList.contains("agent-open")) agentInput.focus();
  }
  agentVoice.addEventListener("click", () => voice ? stopVoice() : startVoice());
  /** A "Fix with agent" button of the shell's own (the pause card's): opens the panel and sends its prompt. */
  function fixWithAgent(prompt: string) {
    toggleAgent(true);
    ask(prompt, null);
  }
  /**
   * The toast's "Fix with agent": the problem as the page editor reported it. The page editor shares its origin with the
   * page, so the page's own script can write that report (an error's message, or the whole of it): it goes to the
   * agent as a report in the <editor> block, which the agent reads as data. What the person asks is the shell's words.
   */
  function fixReported(report: string, key?: string) {
    if (key) shownProblems.delete(key);
    toggleAgent(true);
    ask(FIX_REPORTED, `${editorContext()}\n${pageReport(report)}`);
  }
  // The box sizes itself with field-sizing: content; its wrapper follows the
  // box's height through a ResizeObserver, and CSS eases the wrapper. Without
  // field-sizing (older browsers) the box is sized here instead, unanimated.
  const agentField = $("agent-field");
  const fieldSizing = CSS.supports("field-sizing", "content");
  function sizeInput() {
    if (!fieldSizing) {
      agentInput.style.height = "auto";
      agentInput.style.height = agentInput.scrollHeight + 2 + "px";
    }
    renderBusy();
  }
  let fieldSized = false;
  new ResizeObserver(() => {
    const h = agentInput.offsetHeight;
    if (!h) return; // the pane is collapsed
    // The first height (say, a restored draft) is set without easing.
    if (!fieldSized) { agentField.style.transition = "none"; agentField.style.height = h + "px"; void agentField.offsetHeight; agentField.style.transition = ""; fieldSized = true; }
    else agentField.style.height = h + "px";
  }).observe(agentInput);
  /** Opens or closes the pane, animated, without remembering it (toggleAgent remembers). */
  function showAgent(open: boolean) {
    agentPanel.inert = !open;
    document.body.classList.toggle("agent-open", open);
    $("agent-fab").setAttribute("aria-expanded", String(open));
  }
  function toggleAgent(force?: boolean) {
    const open = typeof force == "boolean" ? force : !document.body.classList.contains("agent-open");
    showAgent(open);
    settings.agent = open;
    saveSettings();
    if (!open) stopVoice(); // the mic never listens behind a closed panel
    if (open) { showChrome(); agentInput.focus(); follow(true); }
    else if (sourceView) sourceView.focus();
    else page.focus();
  }

  // An unsent message survives a reload (kept in this browser only).
  const DRAFT_KEY = "erga:agent-draft:v1";
  function saveDraft() {
    if (agentInput.value) store.set(DRAFT_KEY, agentInput.value);
    else try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }
  const draft = store.get(DRAFT_KEY);
  if (draft) { agentInput.value = draft; sizeInput(); }
  agentInput.addEventListener("input", () => { if (!agentHint.classList.contains("sticky")) hideHint(); sizeInput(); saveDraft(); });
  agentInput.addEventListener("keydown", (e) => {
    if (e.key == "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendToAgent(); }
  });
  $("agent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (agentSend.classList.contains("stop")) fetch(api("/api/agent/abort"), { method: "POST" });
    else sendToAgent();
  });
  $("agent-reset").addEventListener("click", () => { fetch(api("/api/agent/reset"), { method: "POST" }); agentInput.focus(); });
  // Takes back the agent's last change (one tool call), whoever has typed
  // since: your own ⌘Z never undoes the agent's edits.
  const agentUndo = $("agent-undo") as HTMLButtonElement;
  function undoBlocker(): string | null {
    if (agentOff) return agentOff;
    if (!log.undoable) return "Your agent hasn't changed anything to undo.";
    return null;
  }
  function renderUndo() {
    const why = undoBlocker();
    agentUndo.setAttribute("aria-disabled", String(!!why));
    agentUndo.dataset.tip = why ?? `Undo the agent's last change (${log.undoable} to go)`;
    agentUndo.setAttribute("aria-label", agentUndo.dataset.tip);
  }
  agentUndo.addEventListener("click", async () => {
    const why = undoBlocker();
    if (why) { showHint(why); return; }
    const r = await fetch(api("/api/agent/undo"), { method: "POST" }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!r.ok) showHint("There was nothing left to undo.");
  });
  $("agent-close").addEventListener("click", () => toggleAgent(false));
  $("agent-fab").addEventListener("click", () => toggleAgent(true));
  // Which model the agent runs on: a menu when there's a choice (Sonnet 5.5 or
  // Opus 5.5 fast), plain text otherwise. The choice is per person, kept by the host.
  function renderModel(m: Partial<ModelState> | null) {
    const agentModel = $("agent-model");
    agentModel.textContent = "";
    if (!m) { agentModel.textContent = "off"; return; }
    if (!m.models?.length || !m.choice) { agentModel.textContent = m.model ?? ""; return; }
    const sel = document.createElement("select");
    sel.id = "agent-model-select";
    sel.setAttribute("aria-label", "Model");
    for (const o of m.models) sel.append(new Option(o.label, o.id, false, o.id == m.choice));
    sel.title = "The model your agent runs on; a switch applies from your next message";
    // A select counts as focus-visible even after a click, so the ring is ours
    // to show: for the keyboard, not for whoever just used the mouse.
    sel.addEventListener("pointerdown", () => sel.classList.add("by-pointer"));
    sel.addEventListener("keydown", () => sel.classList.remove("by-pointer"));
    sel.addEventListener("change", async () => {
      const want = sel.value;
      const res = await fetch(api("/api/agent/model"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: want }), signal: AbortSignal.timeout(10_000) })
        .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Partial<ModelState> & { reason?: string } }))
        .catch(() => ({ ok: false, body: { reason: "the editor's host didn't answer" } as Partial<ModelState> & { reason?: string } }));
      if (!res.ok) { sel.value = m.choice!; showHint(`Couldn't switch models: ${res.body.reason ?? "the host refused"}.`); return; }
      renderModel(res.body);
      flash(log.busy ? `${sel.selectedOptions[0]?.text}: from your next message` : `Switched to ${sel.selectedOptions[0]?.text}`);
    });
    agentModel.append(sel);
  }
  let agentTries = 0, agentRetry = 0;
  function loadAgent() {
    clearTimeout(agentRetry);
    fetch(api("/api/agent")).then((r) => {
      if (!r.ok) throw Object.assign(new Error(r.status == 404 ? "this server doesn't have the agent" : `the host answered ${r.status}`), { again: transient(r) });
      return r.json();
    }, (e: Error) => { throw Object.assign(e, { again: transient(e) }); }).then((a: AgentState) => {
      agentTries = 0;
      agentOff = a.enabled ? null : `The agent is off: ${a.reason ?? "the host did not start it"}.`;
      renderModel(a.enabled ? a : null);
      if (a.log) { log.items = a.log.items; log.busy = a.log.busy; log.undoable = a.log.undoable; setAgentBusy(a.log.busy || busyAgents().length > 0); }
      renderLog();
      renderUndo();
    }).catch((e: Error & { again?: boolean }) => {
      // The host restarting (a redeploy): ask again shortly, as the agent was, rather than call it off.
      if (e.again && agentTries < 8) { agentRetry = window.setTimeout(loadAgent, backoff(agentTries++)); return; }
      agentOff = `The agent is off: ${e.message}.`;
      renderModel(null);
      renderLog();
      renderUndo();
    });
  }
  loadAgent();

  // ---------------------------------------------------------------- shortcuts & wiring

  function appShortcut(e: Keys): boolean {
    if (!editing()) return false;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") { toggleSource(); return true; }
    if (mod && !e.shiftKey && key == "j") { toggleAgent(); return true; }
    if (mod && !e.shiftKey && key == "k" && mode == "text") { openLink(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { toggleHelp(); return true; }
    const zoom = zoomKey(e, isMac);
    if (zoom) { if (zoom == "reset") { if (page.zoomsItself) page.zoomItself(0); else setZoomLevel(1); } else zoomPage({ step: zoom }); return true; }
    if (mod && !e.shiftKey && key == "s") { flash(connected ? "Saved: edits go to disk as you type" : "Offline: edits sync when the host is back", 2200); return true; }
    if (e.key == "Escape" && linking) { closeLink(); return true; }
    if (e.key == "Escape") {
      // Naming something in the pages tree, a question in it or one of its menus: Escape is theirs to cancel.
      if (document.activeElement?.closest(".et-input, .et-row.confirm, .et-menu")) return false;
      if (docSettings?.escape()) { /* its menu, or itself, closed */ }
      else if (!account.hidden) { toggleAccount(false); accountBtn?.focus(); }
      else if (!help.hidden) toggleHelp(false);
      else if (!naming.hidden) toggleNaming(false);
      else if (!pagesCard.hidden) { togglePages(false); titleBtn.focus(); }
      else if (!sharing.hidden) toggleSharing(false);
      else if (!$("pause-card").hidden) showPauseCard(false);
      else if (agentPanel.contains(document.activeElement)) toggleAgent(false);
      else if (mode != "text") setMode("text");
      else hideChrome();
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
    flash(on ? "Tracking changes from here" : "Stopped tracking changes");
  }
  $("btn-track").addEventListener("click", () => setTracking(!page.isTracking));
  if (settings.track) { page.setTracking(true); $("btn-track").setAttribute("aria-pressed", "true"); $("btn-track").dataset.tip = "Tracking changes (click to stop)"; }

  // Pausing the page: a page that reacts to clicks and keys (slides that
  // advance on click, a game) gets in the way of editing its text. If it
  // defines window.ergaPause (editor-agent/PROMPT.md, rule 10), the pause button
  // tells it to stop, and only the editor answers clicks until it resumes.
  // A page that can't be paused gets the button disabled, with a card that
  // offers to have the agent make it pausable.
  const PAUSE_FIX = "Make this page pausable in the editor, so people can edit its text without the page reacting to their clicks and keys. Follow the document rules: define window.ergaPause(paused), which the editor calls with true when someone pauses the page and false when they resume, and while it's paused have the page ignore clicks, keys and scrolling, and stop anything that changes the page on its own. If nothing on the page reacts to input, there's nothing to pause: say so rather than adding it.";
  /** Brings the button up to date with the page, which may have gained or lost window.ergaPause. */
  function syncPause() {
    const b = $("btn-pause"), can = page.canPause;
    if (!can && page.isPaused) page.setPaused(false);
    const on = page.isPaused;
    b.setAttribute("aria-disabled", String(!can));
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", !can ? "This page can't be paused" : on ? "Resume the page" : "Pause the page");
    // The disabled button explains itself with its card instead of a tooltip.
    if (can) b.dataset.tip = on ? "Paused: only the editor responds (click to resume)" : "Pause the page to edit it";
    else delete b.dataset.tip;
    if (can) showPauseCard(false);
  }
  let pauseCardTimer = 0;
  function showPauseCard(open: boolean) {
    clearTimeout(pauseCardTimer);
    const card = $("pause-card");
    if (open != (card.hidden == true)) return;
    card.hidden = !open;
    if (!open) return;
    showChrome(); toggleHelp(false); toggleSharing(false);
    const fix = $("pause-fix");
    // aria-disabled, not disabled: it can still say why it can't.
    fix.setAttribute("aria-disabled", String(!!agentOff));
    fix.title = agentOff ?? "";
  }
  // Hovering the disabled button opens the card; it stays while the pointer moves into it.
  // (A mouse only: a tap opens and closes it with the click below.)
  for (const el of [$("btn-pause"), $("pause-card")]) {
    el.addEventListener("pointerenter", (e) => { if (e.pointerType == "mouse") { syncPause(); if (!page.canPause) showPauseCard(true); } });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType == "mouse") { clearTimeout(pauseCardTimer); pauseCardTimer = window.setTimeout(() => showPauseCard(false), 300); } });
  }
  $("btn-pause").addEventListener("click", () => {
    syncPause();
    if (!page.canPause) { showPauseCard($("pause-card").hidden == true); return; }
    page.setPaused(!page.isPaused);
    syncPause();
    flash(page.isPaused ? "Paused: the page ignores clicks and keys while you edit" : "Resumed: the page responds again");
  });
  $("pause-fix").addEventListener("click", () => {
    if (agentOff) { explain(agentOff); return; }
    showPauseCard(false);
    fixWithAgent(PAUSE_FIX);
  });
  syncPause();
  for (const b of document.querySelectorAll(".chrome button")) b.addEventListener("mousedown", (e) => e.preventDefault());
  document.addEventListener("mousedown", (e) => {
    if (!help.hidden && !help.contains(e.target as Node)) toggleHelp(false);
    if (!sharing.hidden && !sharing.contains(e.target as Node) && !shareBtn.contains(e.target as Node)) toggleSharing(false);
    if (!account.hidden && !account.contains(e.target as Node) && !accountBtn?.contains(e.target as Node)) toggleAccount(false);
    if (!$("pause-card").hidden && !$("pause-card").contains(e.target as Node) && !$("btn-pause").contains(e.target as Node)) showPauseCard(false);
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
      requestAnimationFrame(() => requestAnimationFrame(() => { if (mine == entering && editing()) showAgent(true); })));
  }
  function setEditing(on: boolean) {
    syncZoom(on);
    if (on) {
      page.focus();
      openAgentOnEntry();
      return;
    }
    if (mode != "text") setMode("text");
    toggleHelp(false); toggleSharing(false); toggleNaming(false); togglePages(false); toggleAccount(false); showPauseCard(false);
    hideFmt();
    showAgent(false);
    stopVoice();
    showChrome();
  }
  // Loaded in the editor: a reload (or back/forward) keeps things as they
  // were, the pane put back as it was left, unanimated; arriving here from
  // elsewhere is coming into the editor, and the agent grows out as above.
  // Only a page opened with #edit is "loaded in the editor": one opened viewing (by a reload or not) and
  // switched into it is coming into the editor (server/pages/viewer.ts says which, ergaShell.loadedEditing).
  if (!editing()) setEditing(false);
  else if (window.ergaShell?.loadedEditing !== false && ["reload", "back_forward"].includes((performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "")) {
    if (settings.agent) {
      document.body.classList.add("no-motion");
      showAgent(true);
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-motion")));
    }
  } else openAgentOnEntry();

  // ---------------------------------------------------------------- a new release

  // The page reloads by itself for a new release of the editor, once the room has this tab's edits,
  // never while you drag or compose or speak, and comes back as it was: the page and its caret, where it was
  // scrolled to, the view (page or source), the cards that were open, the files attached to the next message.
  // (The agent's draft, the pane and its layout are kept in this browser anyway.) A reload by hand comes back
  // the same way, and so does the editor's look: the document's page opens with it from its first frame,
  // before this script has loaded.
  live((l) => {
    l.flush(() => collab.flushed());
    l.hold(() => pointerDown ? "a pointer is down on the page" : voice ? "voice mode is on" : agentFiles.reading ? "files are being read" : null);
    l.keep("editor", (): EditorKept => {
      const sel = currentState().selection.main;
      return {
        path: pagePath, selection: { anchor: sel.anchor, head: sel.head }, scroll: mode == "text" ? page.scrollY : 0, mode,
        pages: !pagesCard.hidden, settings: !!docSettings?.isOpen(), help: !help.hidden,
        files: agentFiles.files, held: collab.held() ?? undefined,
      };
    }, { everyReload: true });
    l.keep("shell", (): ShellKept | null => {
      if (!editing() || mode != "text") return null;
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
  if (back && back.path == pagePath) {
    // Any edit that hadn't reached the room before the reload goes now (merged: nothing changes if it had).
    collab.merge(back.held);
    if (back.mode && back.mode != "text") setMode(back.mode);
    if (back.pages) requestAnimationFrame(() => togglePages(true));
    if (back.settings) void loadSettings().then((s) => s?.toggle(true));
    if (back.help) toggleHelp(true);
    if (back.files?.length) agentFiles.restore(back.files);
  }
  // Back from Cloudflare's consent without its popup (a browser that blocked it): the settings open at Custom domain.
  {
    const q = new URL(location.href);
    if (q.searchParams.has("cloudflare") || q.searchParams.has("cloudflare_error")) {
      const error = q.searchParams.get("cloudflare_error");
      q.searchParams.delete("cloudflare");
      q.searchParams.delete("cloudflare_error");
      window.history.replaceState(window.history.state, "", q.pathname + q.search + q.hash);
      void loadSettings().then((s) => s?.consented(error));
    }
  }

  // ---------------------------------------------------------------- another page

  // Another of the document's pages, opened while editing (the pages card, a link on the page, your agent's open_page),
  // opens in place: the room holds every page already, so the editor takes the new page's text, and the frame renders it
  // (RemotePage.load), out of sight until it has loaded, the last page showing until then. The frame's own address stays
  // the first page's: a frame that changes address adds to the tab's history, and Back would go through that first. The controls, the agent's pane and its conversation, and the cards stay as they are. The
  // address changes as it would have (a new entry in the history), and Back and Forward go between the pages the same way.
  // Anything else (viewing, a page the room hasn't got yet, a folder's address) is a page load, as before.
  let swaps: Promise<void> = Promise.resolve();
  /** Opens `path` in place, if it can (else false: the caller loads its address). `push`: a new entry in the history. */
  function swapPage(path: string, push = true): boolean {
    if (!started || !editing() || !docName?.address || !files(collab.doc).get(path)) return false;
    swaps = swaps.then(() => swapTo(path, push)).catch((e) => { console.error(e); location.assign(addressOf(path)); });
    return true;
  }
  async function swapTo(path: string, push: boolean) {
    if (path == pagePath) return;
    // The page's source view gives the text back to the page first (the new page opens on the page itself).
    if (mode != "text") { setMode("text"); await switching; }
    const text = collab.setPath(path);
    if (text == null) { goTo(addressOf(path)); return; }
    pagePath = path;
    info = { ...info!, path, name: path };
    page.load({ dir: dirOf(path), text });
    // What was said of the last page was of it alone.
    shownProblems.clear();
    problemQueue.length = 0;
    if (explaining) hideExplanation();
    refreshPending = false;
    renderRefreshPill();
    hideFmt();
    togglePages(false);
    let meta = document.querySelector<HTMLMetaElement>('meta[name="erga-page"]');
    if (!meta) meta = document.head.appendChild(Object.assign(document.createElement("meta"), { name: "erga-page" }));
    meta.content = path;
    tree?.setCurrent(path);
    viewHref(docName!.address);
    if (push) window.history.pushState({ ...window.history.state, ergaPage: path }, "", addressOf(path));
    queueCursor();
    queuePeers();
  }
  // Each entry in the history says which page it is (one added as the hash changes, by the pencil, is stamped as it comes).
  const stamp = () => { if (typeof window.history.state?.ergaPage != "string") window.history.replaceState({ ...window.history.state, ergaPage: pagePath }, ""); };
  stamp();
  addEventListener("hashchange", stamp);
  addEventListener("popstate", () => {
    const to = window.history.state?.ergaPage;
    if (typeof to == "string") { if (to != pagePath && !swapPage(to, false)) location.reload(); return; }
    // An entry that doesn't say (made before this page loaded): this page, unless its address is another's.
    if (docName?.address && location.pathname != "/" && location.pathname != pageUrl(docName.address, pagePath)) location.reload();
  });

  started = true;
  presenceChanged();
  window.ergaPage = { page, collab, toggleSource, captureView, agentContext: editorContext, setEditing, get pagePath() { return pagePath; }, openPage, get state() { return currentState(); } };
  window.ergaShell?.ready();
})();
