// The page editor's shell: joins the document's room (its Durable Object,
// worker/doc-host.ts) as one participant among others, renders the document in the
// page editor, sends every edit to the room as you type and applies everyone
// else's (people and their agents) as they land, shows who's here and where
// their carets are, and offers the same quiet chrome as the Markdown editor:
// shortcuts and a toggle to the source, which shares the document state and
// undo history. It also hosts the agent panel (⌘J): your agent runs in the
// host, its conversation is yours alone (your other tabs show it too), and
// its edits arrive through the room like anyone's.

import { EditorState, Compartment, StateEffect, StateField, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightSpecialChars, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import { ms, type InlineStyle, type MarkAuthor, type Peer } from "./editor";
import { RemotePage } from "./remote";
import type { Backdrop, Keys } from "./bridge";
import { changesBetween } from "./merge";
import { Collab, type Presence } from "./collab";
import { colorFor, type Author } from "../room/doc";
import { analyzeMarkdown } from "./markdown";
import TurndownService from "turndown";
import { emptyLog, reduce, type Log, type LogEvent, type LogItem, type ViewRequest, type ViewResult } from "./agent-log";
import type { AgentState, DocInfo, ModelState } from "../../api";
import { BASE } from "./base";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Other people's carets and selections in the source view, as CodeMirror
// decorations (the page draws its own, see PageEditor.setPeers).
const setPeersEffect = StateEffect.define<Peer[]>();
class PeerCaret extends WidgetType {
  constructor(readonly peer: Peer) { super(); }
  eq(other: PeerCaret) { return other.peer.name == this.peer.name && other.peer.color == this.peer.color && other.peer.activity == this.peer.activity; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-peer" + (this.peer.agent ? " is-agent" : "");
    el.style.setProperty("--c", this.peer.color);
    const name = document.createElement("span");
    name.className = "cm-peer-name";
    name.textContent = this.peer.activity ? `${this.peer.name} · ${this.peer.activity}` : this.peer.name;
    el.append(name);
    return el;
  }
  ignoreEvent() { return true; }
}
const peersField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setPeersEffect)) continue;
      const len = tr.state.doc.length, ranges = [];
      for (const p of e.value) {
        const at = Math.min(p.head ?? p.anchor, len);
        if (p.head != null && p.head != p.anchor) {
          const from = Math.min(p.anchor, p.head, len), to = Math.min(Math.max(p.anchor, p.head), len);
          if (to > from) ranges.push(Decoration.mark({ attributes: { style: `background-color: color-mix(in srgb, ${p.color} 18%, transparent)` } }).range(from, to));
        }
        ranges.push(Decoration.widget({ widget: new PeerCaret(p), side: 1 }).range(at));
      }
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

declare global {
  interface Window { ergaPage?: unknown }
}


(async () => {
  const $ = (id: string) => document.getElementById(id)!;

  const KEYS = { settings: "erga:settings:v1" };
  const store = {
    get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
  };
  const settings: { track: boolean; agent: boolean } = { track: false, agent: false, ...store.json(KEYS.settings) };
  const saveSettings = () => store.set(KEYS.settings, JSON.stringify(settings));

  // An agent pane left open stays open across reloads: put it back before
  // the first paint, without the open animation.
  if (settings.agent) {
    document.body.classList.add("no-motion", "agent-open");
    ($("agent") as HTMLElement).inert = false;
    $("agent-fab").setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-motion")));
  }

  // ---------------------------------------------------------------- colours

  // There is no dark mode: the documents shown here are rendered as their
  // authors made them, and most don't support one. The shell and the Markdown
  // template are always light (data-theme="light" pins style.css), and the
  // floating controls take their colours from the page under them.
  // The shell paints its canvas with the page's background and tints the
  // floating UI to match (see page.html), so opening the agent never reveals
  // a strip of a different colour. The page's background is its root's, or
  // its body's when the root has none, as the browser itself would paint it.
  // The page reports its background (frame.ts). Only colours and gradients
  // are taken: an image would be fetched from here, as you.
  function applyBackdrop(b: Backdrop) {
    if (!info) return;
    const color = b.color && CSS.supports("color", b.color) ? b.color : info.kind == "md" ? "" : "#ffffff";
    const image = b.image && !/url\(|image-set\(|image\(|element\(/i.test(b.image) && CSS.supports("background-image", b.image) ? b.image : "";
    const root = document.documentElement.style;
    if (color) root.setProperty("--page-bg", color); else root.removeProperty("--page-bg");
    if (image) root.setProperty("--page-bg-image", image); else root.removeProperty("--page-bg-image");
    const rgb = (color || getComputedStyle(document.documentElement).getPropertyValue("--bg")).match(/[\d.]+/g)?.map(Number);
    const dark = !!rgb && rgb.length >= 3 && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
    document.documentElement.classList.toggle("page-dark", !!color && dark);
    document.documentElement.classList.toggle("page-light", !!color && !dark);
    // Remembered so the next load paints it before the page arrives (see page.html), not white first.
    store.set("erga:backdrop:v1", JSON.stringify({ bg: color, image, tone: color ? (dark ? "page-dark" : "page-light") : "" }));
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
  try {
    const res = await fetch(`${BASE}/api/doc${as}`);
    if (!res.ok) throw new Error(await res.text());
    info = (await res.json()) as DocInfo;
  } catch (e) {
    $("welcome").hidden = false;
    $("welcome").innerHTML = `<div><p>Nothing to edit here.</p><p>Open one from <a href="/docs">your documents</a>.</p></div>`;
    return;
  }

  // The host attributes your edits and your agent to who you are, so the tab takes that.
  const me: Author = { user: info.userId, name: info.user, color: colorFor(info.userId), kind: "person", ...(info.avatar ? { avatar: info.avatar } : {}) };
  const self: MarkAuthor = { name: me.name, color: me.color };
  // Your documents to go back to (test people have none), as whoever this tab is.
  $("nav-docs").hidden = me.user.startsWith("test-");
  $("nav-docs").querySelector("a")!.href = `/docs${as}`;
  /** The host's endpoints, as this person. */
  const api = (path: string) => `${BASE}${path}${as}`;

  // Join the room and wait for the document's text. Presence and connection
  // news before the shell is set up is picked up once it is (`started`).
  let started = false;
  const collab: Collab = new Collab({
    path: info.path,
    me,
    onRemote: (changes, author) => applyRemote(changes, author),
    onFiles: () => needRefresh(),
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
    return;
  }
  const markdownHead = `<link rel="stylesheet" href="/fonts/inter.css"><link rel="stylesheet" href="/style.css"><style>
    body { padding: 0; }
    .prose { padding-top: 12vh; padding-bottom: 40vh; }
    .prose li > p { margin: 0; }
    .prose ul.loose li > p { margin: 0 0 0.6em; }
    .prose [data-erga-id]:empty::before, .prose .erga-empty:empty::before { content: ""; }
  </style><script>document.documentElement.setAttribute("data-theme", "light")</script>`;

  // One CodeMirror state serves both the page editor and the source view, so
  // the undo history is shared and either view's edits land in the same file.
  // Two looks for the source views. Markdown reads like the page: its text
  // font, wrapped, in a column as wide as the page's own text (--md-col, set
  // when the view opens). HTML reads like code: smaller monospace, a fixed
  // left margin, no right margin and no wrapping; long lines scroll sideways.
  const baseTheme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%" },
    ".cm-content": { caretColor: "var(--caret)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--caret)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
    ".cm-line": { padding: "0" },
  });
  const markdownLook: Extension = [baseTheme, EditorView.lineWrapping, EditorView.theme({
    "&": { fontSize: "var(--text-size)" },
    ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.7", padding: "14vh max(20px, calc((100% - var(--md-col, 40rem)) / 2)) 45vh" },
  })];
  const htmlLook: Extension = [baseTheme, EditorView.theme({
    "&": { fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", padding: "max(64px, 9vh) 0 40vh 56px" },
    ".cm-content": { paddingRight: "24px" },
  })];
  const look = new Compartment();
  /** The page's text column (as the frame measured it), so the Markdown view can match it. */
  function setColumn(w: number) {
    $("source").style.setProperty("--md-col", w > 200 ? `${Math.round(w)}px` : "40rem");
  }
  const sourceHighlight = HighlightStyle.define([
    { tag: t.heading, fontWeight: "650", color: "var(--fg-strong)" },
    { tag: t.strong, fontWeight: "650" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: [t.processingInstruction, t.meta, t.punctuation, t.angleBracket, t.documentMeta], color: "var(--mark)" },
    { tag: [t.tagName, t.attributeName], color: "var(--soft)" },
    { tag: [t.string, t.attributeValue, t.url, t.link], color: "var(--soft)" },
    { tag: t.monospace, color: "var(--fg)", fontFamily: "var(--font-mono)", fontSize: "0.88em" },
    { tag: t.comment, color: "var(--mark)", fontStyle: "italic" },
  ]);
  // The source view's state: the frame hands over its own (undo history and
  // all) when the view opens, and takes it back when it closes.
  const sourceExtensions: Extension = [
      peersField,
      history(),
      info.kind == "md" ? markdown({ base: markdownLanguage }) : html(),
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      syntaxHighlighting(sourceHighlight),
      look.of(info.kind == "md" ? markdownLook : htmlLook),
      // The source view's own edits go to the room; edits from the room come in marked "external".
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (!tr.docChanged || tr.isUserEvent("external")) continue;
          collab.push(tr.changes);
          page.recordAuthorship(tr.changes, self);
          hideChrome();
        }
        if (u.docChanged || u.selectionSet) queueCursor();
      }),
  ];
  document.title = info.name;

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
  let connected = true;
  function connectionChanged(now: boolean) {
    if (now == connected) return;
    connected = now;
    if (!now) setStatus("Offline: your edits are kept in this tab and sync when the host is back", "error");
    else setStatus("Back online; edits synced");
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
    refreshDerived();
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

  // Changes patching can't show (another file in the folder, or the page's
  // structure: a diagram, a script) need the page rendered again. While the
  // agent is working that waits for the end of its turn, so a half-built
  // change never renders; a pill says it's pending and offers to refresh now.
  // Otherwise it happens straight away.
  // Either way the scroll position is kept.
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
  function listen() {
    const events = new WebSocket(`${location.protocol == "https:" ? "wss:" : "ws:"}//${location.host}${api("/api/events")}`);
    events.onmessage = (ev) => {
      let msg: { type?: string; ev?: LogEvent; id?: string; req?: ViewRequest } = {};
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type == "agent" && msg.ev) agentEvent(msg.ev);
      else if (msg.type == "model") renderModel(msg as unknown as ModelState);
      else if (msg.type == "view" && msg.id) answerView(msg.id, msg.req ?? {});
    };
    // Events sent while the channel was down are gone; catch up from the transcript.
    events.onopen = () => { if (opened) loadAgent(); opened = true; };
    events.onclose = () => setTimeout(listen, 1000);
  }
  let opened = false;
  listen();

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
    if (sourceView) sourceView.dispatch({ effects: setPeersEffect.of(peers) });
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
        img.addEventListener("error", () => img.remove()); // the initial shows through
        b.append(img);
      }
      b.dataset.tip = p.client == -1 ? `You (${me.name})` : here ? p.user.name : `${p.user.name} (not here)`;
      if (p.client == -1) b.setAttribute("aria-disabled", "true");
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
    if (chromeHidden || !$("help").hidden || !$("share").hidden) return;
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
  // source view, the cards and the agent stop above it (page.html). Zoomed
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
    if (open) { showChrome(); toggleShare(false); }
  }

  // Share with an external agent: a prompt carrying this page's API and a
  // token that lets the agent call your agent's tools (host.ts, /api/ext).
  const share = $("share"), shareBtn = $("btn-share");
  const sharePrompt = $("share-prompt") as HTMLTextAreaElement, shareStatus = $("share-status");
  const shareCopy = $("share-copy"), shareRotate = $("share-rotate");
  let shareToken: string | null = null;
  function promptFor(token: string): string {
    const api = `${location.origin}${BASE}/api/ext`;
    return `I'd like your help editing "${info?.path ?? info?.name ?? "the document"}", an Erga document I have open in my editor. You can read and change it through the editor's API, working as my agent: your edits show up in my editor as you make them.

API: ${api}
Token: ${token}

Send the token on every request, as the header "Authorization: Bearer ${token}". Start by reading the API guide, which explains the tools and how to call them:

curl -s -H "Authorization: Bearer ${token}" ${api}

Once you've read it, await further instructions.`;
  }
  async function loadShare(rotate: boolean) {
    for (const b of [shareCopy, shareRotate]) { b.setAttribute("aria-disabled", "true"); b.title = "Getting a token…"; }
    shareStatus.textContent = rotate ? "Making a new token…" : "";
    const res = await fetch(api("/api/share"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }), signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the host answered ${r.status}`))) as Promise<{ token: string }>)
      .catch((e: Error) => e);
    if (res instanceof Error) {
      shareToken = null;
      sharePrompt.value = "";
      shareStatus.textContent = `Couldn't get a token: ${res.name == "TimeoutError" ? "the editor's host didn't answer" : res.message}.`;
      shareCopy.title = "There's no prompt to copy: getting a token failed.";
      shareRotate.removeAttribute("aria-disabled");
      shareRotate.title = "Try again";
      return;
    }
    shareToken = res.token;
    sharePrompt.value = promptFor(res.token);
    for (const b of [shareCopy, shareRotate]) { b.removeAttribute("aria-disabled"); b.title = ""; }
    shareRotate.title = "Turn this token off and make a new one";
    shareStatus.textContent = rotate ? "New token: the old one no longer works." : "";
  }
  function toggleShare(force?: boolean) {
    const open = typeof force == "boolean" ? force : share.hidden;
    share.hidden = !open;
    shareBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    showChrome();
    toggleHelp(false);
    if (!shareToken) loadShare(false);
  }
  shareBtn.addEventListener("click", () => toggleShare());
  shareCopy.addEventListener("click", async () => {
    if (!shareToken) { shareStatus.textContent = shareCopy.title || "Getting a token…"; return; }
    const copied = await navigator.clipboard.writeText(sharePrompt.value).then(() => true, () => false);
    if (!copied) { sharePrompt.focus(); sharePrompt.select(); }
    shareStatus.textContent = copied ? "Copied" : "Couldn't reach the clipboard: the prompt is selected, press ⌘C.";
  });
  shareRotate.addEventListener("click", () => { if (shareRotate.getAttribute("aria-disabled") != "true") loadShare(true); });
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
        fixWithAgent(fix, key);
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

  // The page editor runs on the document's own origin (bridge.ts): the
  // address the front door gave this page (with the token that opens the
  // document's files there), in the frame.
  const pagesUrl = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]')?.content ?? "";
  const page = new RemotePage({
    frame,
    origin: new URL(pagesUrl, location.href).origin,
    kind: info.kind,
    text: initialText,
    markdownHead,
    self,
    tracking: settings.track,
    extensions: sourceExtensions,
    onLocal(changes) {
      collab.push(changes);
      hideChrome();
      queueCursor();
      queuePeers();
    },
    onSelection() { queueCursor(); queuePeers(); queueFmt(); },
    onUpdate(rendered) {
      if (rendered) {
        syncPause();
        const t = page.title().slice(0, 200);
        document.title = t ? `${t} · ${info!.name}` : info!.name;
        if (!agentPanel.contains(document.activeElement) && mode == "text") page.focus();
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
      hideFmt();
      if (!help.hidden) toggleHelp(false);
      if (!share.hidden) toggleShare(false);
      showPauseCard(false);
    },
    onActivity: (kind) => {
      activate();
      if (kind == "key") { lastKeyAt = performance.now(); dismissExplanation(null); }
    },
    onBackdrop: (b) => applyBackdrop(b),
    onStale: () => needRefresh(),
  });
  frame.src = pagesUrl;

  // ---------------------------------------------------------------- style bar

  // Select text in the page and a small bar floats above it: bold, italic,
  // code, link, clear formatting. Buttons that can't apply say why (title), and so does a click.
  const fmt = $("fmt");
  const fmtLink = $("fmt-link") as HTMLInputElement;
  const coarse = matchMedia("(pointer: coarse)");
  let pointerDown = false;
  let fmtQueued = false;
  function queueFmt() {
    if (fmtQueued) return;
    fmtQueued = true;
    requestAnimationFrame(() => { fmtQueued = false; renderFmt(); });
  }
  function hideFmt() {
    fmt.hidden = true;
    fmt.classList.remove("linking");
    fmtLink.hidden = true;
  }
  function renderFmt() {
    if (fmt.classList.contains("linking")) return;
    const rect = mode != "text" || pointerDown ? null : page.selectionRect();
    if (!rect) { hideFmt(); return; }
    const f = frame.getBoundingClientRect();
    // On touch, the system's own copy and paste menu takes the space above a selection.
    const below = rect.top < 56 || coarse.matches;
    const half = coarse.matches ? 120 : 110; // half the bar (its buttons are bigger on touch), and a margin
    fmt.style.left = Math.max(half, Math.min(window.innerWidth - half, f.left + rect.left + rect.width / 2)) + "px";
    fmt.style.top = f.top + (below ? rect.bottom : rect.top) + "px";
    fmt.classList.toggle("below", below);
    const why = page.styleBlocker();
    for (const b of fmt.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-disabled", String(!!why));
      b.dataset.why = why ?? "";
      if (b.dataset.style) b.setAttribute("aria-pressed", String(!why && page.hasStyle(b.dataset.style as InlineStyle)));
      if (b.dataset.act == "link") b.setAttribute("aria-pressed", String(!why && page.linkAt() != null));
      b.title = why ?? b.getAttribute("aria-label")!.replace(/ \((.+)\)$/, "  $1");
    }
    fmt.hidden = false;
  }
  function openLink() {
    const why = page.styleBlocker();
    if (why) { explain(why); return; }
    if (fmt.hidden) renderFmt();
    fmt.classList.add("linking");
    fmtLink.hidden = false;
    fmtLink.value = page.linkAt() ?? "";
    fmtLink.focus();
    fmtLink.select();
  }
  fmt.addEventListener("mousedown", (e) => { if (e.target != fmtLink) e.preventDefault(); });
  fmt.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.dataset.why) { explain(b.dataset.why); return; }
    if (b.dataset.style) page.toggleStyle(b.dataset.style as InlineStyle).then((why) => { if (why) explain(why); queueFmt(); });
    else if (b.dataset.act == "link") openLink();
    else if (b.dataset.act == "clear") page.clearStyles().then((why) => { if (why) explain(why); queueFmt(); });
  });
  fmtLink.addEventListener("keydown", (e) => {
    if (e.key == "Enter") {
      e.preventDefault();
      fmt.classList.remove("linking");
      fmtLink.hidden = true;
      page.focus();
      page.setLink(fmtLink.value.trim()).then((why) => { if (why) explain(why); queueFmt(); });
    } else if (e.key == "Escape") {
      e.preventDefault();
      e.stopPropagation();
      fmt.classList.remove("linking");
      fmtLink.hidden = true;
      page.focus();
      queueFmt();
    }
  });
  fmtLink.addEventListener("blur", () => { if (fmt.classList.contains("linking")) { fmt.classList.remove("linking"); fmtLink.hidden = true; queueFmt(); } });
  window.addEventListener("resize", () => queueFmt());

  // ---------------------------------------------------------------- views

  // Three views of the document: T, the page itself; *T*, Markdown; <T>,
  // HTML. The view in the file's own format is the file, editable, sharing
  // the page's state and undo history. The other is a read-only conversion
  // (an HTML file's text as Markdown, or the HTML a Markdown file renders
  // to): editing through a lossy conversion would rewrite the file in ways
  // nobody asked for, and the view says so.
  type Mode = "text" | "md" | "html";
  const MODE_NAMES: Record<Mode, string> = { text: "Page", md: "Markdown", html: "HTML" };
  let mode: Mode = "text";
  let sourceView: EditorView | null = null;
  let derivedView: EditorView | null = null;
  const modeEl = $("mode");
  const modeNote = $("mode-note");

  function htmlToMarkdown(src: string): string {
    const d = new DOMParser().parseFromString(src, "text/html");
    d.querySelectorAll("head, script, style, noscript, template, svg, canvas, iframe, button, input, select, textarea").forEach((e) => e.remove());
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", hr: "---" });
    return td.turndown(d.body).replace(/^(\s*)([-*]|\d+\.)[ ]{2,}/gm, "$1$2 ").trim() + "\n";
  }
  function markdownToHtml(src: string): string {
    return analyzeMarkdown(src).html
      .replace(/ data-erga-id="\d+"/g, "").replace(/ class="erga-empty"/g, "")
      .replace(/(<(?:ul|ol|blockquote|table|thead|tbody|tr)>)/g, "$1\n")
      .replace(/(<\/(?:h[1-6]|p|li|ul|ol|blockquote|pre|table|thead|tbody|tr|hr)>)/g, "$1\n");
  }
  const derivedText = (m: Mode) => (m == "md" ? htmlToMarkdown(page.state.doc.toString()) : markdownToHtml(page.state.doc.toString()));

  // Opening the source view waits for the page to hand over its state; a switch asked for meanwhile waits its turn.
  let switching: Promise<void> = Promise.resolve();
  function setMode(next: Mode) {
    closeModeMenu();
    switching = switching.then(() => switchMode(next));
  }
  async function switchMode(next: Mode) {
    if (next == mode) return;
    // Leave the current view; the source view hands the state back to the page.
    if (derivedView) { derivedView.destroy(); derivedView = null; modeNote.hidden = true; }
    if (sourceView) {
      const st = sourceView.state;
      sourceView.destroy();
      sourceView = null;
      page.attach(st);
    }
    let handed: EditorState | null = null;
    if (next == info!.kind) handed = (await page.detach()).state;
    if (next != "text") setColumn(page.column);
    mode = next;
    if (next == "text") {
      $("source").hidden = true;
      document.body.classList.remove("source");
      page.focus();
      queuePeers();
    } else if (next == info!.kind) {
      sourceView = new EditorView({ parent: $("source"), state: handed! });
      $("source").hidden = false;
      document.body.classList.add("source");
      sourceView.focus();
      queuePeers();
    } else {
      derivedView = new EditorView({
        parent: $("source"),
        state: EditorState.create({
          doc: derivedText(next),
          extensions: [next == "md" ? markdown({ base: markdownLanguage }) : html(), EditorState.readOnly.of(true), EditorView.editable.of(false), highlightSpecialChars(), syntaxHighlighting(sourceHighlight), next == "md" ? markdownLook : htmlLook],
        }),
      });
      $("source").hidden = false;
      document.body.classList.add("source");
      modeNote.textContent = next == "md"
        ? "Read-only: this page's text as Markdown. The file is HTML, so edit it on the page (T) or as HTML (<T>)."
        : "Read-only: the HTML this Markdown renders to. Edit it on the page (T) or as Markdown (*T*).";
      modeNote.hidden = false;
    }
    renderMode();
    queueFmt();
  }
  /** Keeps a read-only conversion up to date when the file changes underneath it. */
  function refreshDerived() {
    if (derivedView) derivedView.dispatch({ changes: { from: 0, to: derivedView.state.doc.length, insert: derivedText(mode) } });
  }
  function renderMode() {
    for (const b of modeEl.querySelectorAll<HTMLButtonElement>("button")) {
      const m = b.dataset.mode as Mode;
      b.setAttribute("aria-checked", String(m == mode));
      const ro = m != "text" && m != info?.kind;
      b.title = `${MODE_NAMES[m]}${ro ? " (read-only)" : ""}${m == "text" || m == info?.kind ? "  ⌘⇧P" : ""}`;
      b.setAttribute("aria-label", b.title);
    }
  }
  function openModeMenu() { modeEl.classList.add("open"); showChrome(); }
  function closeModeMenu() { modeEl.classList.remove("open"); }
  modeEl.addEventListener("mousedown", (e) => e.preventDefault());
  modeEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!b) return;
    if (!modeEl.classList.contains("open")) openModeMenu();
    else setMode(b.dataset.mode as Mode);
  });
  document.addEventListener("mousedown", (e) => { if (!modeEl.contains(e.target as Node)) closeModeMenu(); });
  /** ⌘⇧P: between the page and the file's own source. */
  const toggleSource = (force?: boolean) => setMode((typeof force == "boolean" ? force : mode == "text") ? info!.kind : "text");

  // ---------------------------------------------------------------- view_page

  // The agent asks to see the page: the page editor's frame draws it
  // (frame.ts), with the latest edits, and the picture goes back to the agent.
  // No server-side browser: whoever has the editor open is the agent's eyes.
  const captureView = (req: ViewRequest) => page.capture(req);
  async function answerView(id: string, req: ViewRequest) {
    // Render only once this tab has every edit the agent had made when it asked.
    if (req.after) await collab.waitFor(req.after);
    const result = await captureView(req);
    await fetch(api("/api/agent/view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...result }) }).catch(() => {});
  }

  // ---------------------------------------------------------------- the agent

  const agentPanel = $("agent");
  const agentLog = $("agent-log");
  const agentInput = $("agent-input") as HTMLTextAreaElement;
  const agentSend = $("agent-send") as HTMLButtonElement;
  const log: Log = emptyLog();
  let logEls: HTMLElement[] = [];
  const agentHint = $("agent-hint");
  // Why the agent can't take a message right now, shown in the panel until it can.
  let agentOff: string | null = "Connecting to the agent…";
  /** The live voice session (voice mode, below), or null when it's off. `sent` counts the session's results already sent, of `results` heard so far. */
  let voice: { rec: Recognition; before: string; sent: number; results: number; heard: string; partial: boolean; timer: number } | null = null;
  let hintTimer = 0;

  const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const inline = (s: string) => escapeHtml(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const TOOL_VERBS: Record<string, [string, string]> = {
    read: ["Reading", "Read"], edit: ["Editing", "Edited"], write: ["Writing", "Wrote"],
    ls: ["Listing", "Listed"], find: ["Finding files", "Found files"], grep: ["Searching", "Searched"],
    view_page: ["Looking at the page", "Looked at the page"],
  };
  /** A failed tool call that a later call on the same file got past is history, not an error. */
  const retried = (i: number) => {
    const item = log.items[i];
    if (item.kind != "tool" || item.status != "error") return false;
    return log.items.slice(i + 1).some((x) => x.kind == "tool" && x.status == "done" && x.path == item.path && (x.name == item.name || x.name == "write"));
  };
  function renderItem(item: LogItem, i: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "msg-" + item.kind;
    if (item.kind == "user" || item.kind == "thinking" || item.kind == "error") el.textContent = item.text;
    else if (item.kind == "assistant") el.innerHTML = inline(item.text);
    else {
      const [doing, done] = TOOL_VERBS[item.name] ?? [item.name, item.name];
      const what = item.path ? ` <code>${escapeHtml(item.path)}</code>` : "";
      // A call from an agent you shared the page with (the share button) says so.
      const via = item.via == "external" ? `<span class="via" title="An agent you shared this page with, working as your agent">External agent:</span> ` : "";
      if (retried(i)) {
        el.classList.add("retried");
        el.title = item.detail ?? "";
        el.innerHTML = `<span>${via}${doing}${what} didn't apply; retried</span>`;
      } else {
        el.classList.add(item.status);
        el.innerHTML = `<span>${via}${item.status == "running" ? doing : item.status == "error" ? `${doing} failed:` : done}${what}${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ""}${item.image ? `<img class="shot" alt="What the agent saw" src="${item.image}">` : ""}</span>`;
      }
    }
    return el;
  }
  function renderLog() {
    agentLog.textContent = "";
    logEls = log.items.map((it, i) => renderItem(it, i));
    agentLog.append(...logEls);
    follow(true);
    renderBusy();
  }

  // The log follows the agent's output, as a terminal does, until you
  // scroll back to read something; scrolling to the bottom again (or the
  // "Jump to latest" button, or sending a message) picks it back up. It's
  // kept pinned whenever the log's content changes size, not just when an
  // event arrives, so text that wraps later or a screenshot that loads after
  // its event doesn't leave it behind.
  const agentJump = $("agent-jump") as HTMLButtonElement;
  let following = true, lastScrollTop = 0;
  const atBottom = () => agentLog.scrollHeight - agentLog.scrollTop - agentLog.clientHeight <= 8;
  function pin() {
    if (following) agentLog.scrollTop = agentLog.scrollHeight;
    else if (!atBottom()) agentJump.hidden = false;
  }
  function follow(on: boolean) {
    following = on;
    if (on) agentJump.hidden = true;
    pin();
  }
  // A wheel or touch moving up is you reading back: stop following at once,
  // before the next pin can pull you down again.
  agentLog.addEventListener("wheel", (e) => { if (e.deltaY < 0 && agentLog.scrollHeight > agentLog.clientHeight) following = false; }, { passive: true });
  agentLog.addEventListener("touchmove", () => { if (!atBottom()) following = false; }, { passive: true });
  agentLog.addEventListener("keydown", (e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) following = false; });
  agentLog.addEventListener("scroll", () => {
    if (atBottom()) follow(true);
    else if (following && agentLog.scrollTop < lastScrollTop) following = false; // dragged the scrollbar up
    lastScrollTop = agentLog.scrollTop;
  }, { passive: true });
  new MutationObserver(() => pin()).observe(agentLog, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(() => pin()).observe(agentLog);
  agentLog.addEventListener("load", () => pin(), true); // screenshots arrive after their event
  agentJump.addEventListener("click", () => follow(true));
  /** Why Send can't send right now, or null if it can. Never a silent no. */
  function sendBlocker(): string | null {
    if (agentOff) return agentOff;
    if (voice) return "Voice mode is on: what you say is sent when you pause.";
    if (!log.busy && !agentInput.value.trim()) return "Type a message to send it.";
    return null;
  }
  function renderBusy() {
    // In voice mode the button can't send, so while the agent works it's Stop.
    const stop = log.busy && (!!voice || !agentInput.value.trim());
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
    // The host's copy of a message sent from this tab takes the place of the dimmed one.
    if (ev.t == "user") {
      const i = pendingSends.findIndex((p) => p.text == ev.text);
      if (i >= 0) { pendingSends[i].el.remove(); pendingSends.splice(i, 1); }
    }
    const before = log.items.length;
    const i = reduce(log, ev);
    if (ev.t == "busy") setAgentBusy(ev.busy || busyAgents().length > 0);
    if (ev.t == "undoable") renderUndo();
    if (ev.t == "reset") { renderLog(); return; }
    if (i >= 0) {
      const el = renderItem(log.items[i], i);
      if (i < before) { logEls[i].replaceWith(el); logEls[i] = el; }
      else { agentLog.append(el); logEls[i] = el; }
    }
    // A success may turn earlier failures on the same file into retries.
    if (ev.t == "tool" && ev.status == "done") {
      for (let j = 0; j < i; j++) if (retried(j) && !logEls[j].classList.contains("retried")) { const el = renderItem(log.items[j], j); logEls[j].replaceWith(el); logEls[j] = el; }
    }
    pin();
    renderBusy();
  }

  /** Where the user is in the document, so "this" and "here" mean something to the agent. */
  function editorContext(): string {
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
    const why = sendBlocker();
    if (why || !text) {
      showHint(why ?? "Type a message to send it.", !!agentOff);
      agentInput.focus();
      return;
    }
    agentInput.value = "";
    saveDraft();
    sizeInput();
    await ask(text, editorContext());
  }
  // A message shows in the log the moment it's sent, dimmed until the host
  // echoes it back as the conversation's (which replaces it). If it can't be
  // sent, it says so, with a way to try again: never a send that silently
  // goes nowhere.
  const pendingSends: { text: string; el: HTMLElement }[] = [];
  async function ask(text: string, context: string | null) {
    const el = document.createElement("div");
    el.className = "msg-user pending";
    el.textContent = text;
    agentLog.append(el);
    const pending = { text, el };
    pendingSends.push(pending);
    // Asking something means you want to see the answer.
    follow(true);
    // The agent reads the shared doc; `after` makes the host wait until the
    // room has every edit this tab had made (they travel over the WebSocket).
    const res = await fetch(api("/api/agent"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context, after: collab.vector() }), signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
    if (!(res instanceof Response) || !res.ok) {
      const reason = res instanceof Response ? ((await res.json().catch(() => null)) as { reason?: string } | null)?.reason ?? `the host answered ${res.status}` : res.name == "TimeoutError" ? "the editor's host didn't answer in time" : "the editor's host didn't answer";
      pendingSends.splice(pendingSends.indexOf(pending), 1);
      el.classList.replace("pending", "failed");
      const note = document.createElement("span");
      note.className = "send-failed";
      note.textContent = `Not sent: ${reason}. `;
      const retry = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
      retry.addEventListener("click", () => { el.remove(); ask(text, context); });
      note.append(retry);
      el.append(note);
      pin();
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
    sizeInput();
    ask(text, editorContext());
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
  /** The "Fix with agent" button: opens the panel and sends the prompt that names the problem. */
  function fixWithAgent(prompt: string, key?: string) {
    if (key) shownProblems.delete(key);
    toggleAgent(true);
    ask(prompt, null);
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
  function toggleAgent(force?: boolean) {
    const open = typeof force == "boolean" ? force : !document.body.classList.contains("agent-open");
    agentPanel.inert = !open;
    document.body.classList.toggle("agent-open", open);
    $("agent-fab").setAttribute("aria-expanded", String(open));
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
  function loadAgent() {
    fetch(api("/api/agent")).then((r) => {
      if (!r.ok) throw new Error(r.status == 404 ? "this server doesn't have the agent" : `the host answered ${r.status}`);
      return r.json();
    }).then((a: AgentState) => {
      agentOff = a.enabled ? null : `The agent is off: ${a.reason ?? "the host did not start it"}.`;
      renderModel(a.enabled ? a : null);
      if (a.log) { log.items = a.log.items; log.busy = a.log.busy; log.undoable = a.log.undoable; setAgentBusy(a.log.busy || busyAgents().length > 0); }
      renderLog();
      renderUndo();
    }).catch((e: Error) => {
      agentOff = `The agent is off: ${e.message}.`;
      renderModel(null);
      renderLog();
      renderUndo();
    });
  }
  loadAgent();

  // ---------------------------------------------------------------- shortcuts & wiring

  function appShortcut(e: Keys): boolean {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key == "p") { toggleSource(); return true; }
    if (mod && !e.shiftKey && key == "j") { toggleAgent(); return true; }
    if (mod && !e.shiftKey && key == "k" && mode == "text") { openLink(); return true; }
    if (mod && !e.shiftKey && (key == "/" || key == "?")) { toggleHelp(); return true; }
    if (mod && !e.shiftKey && key == "s") { flash(connected ? "Saved: edits go to disk as you type" : "Offline: edits sync when the host is back", 2200); return true; }
    if (e.key == "Escape") {
      if (!help.hidden) toggleHelp(false);
      else if (!share.hidden) toggleShare(false);
      else if (!$("pause-card").hidden) showPauseCard(false);
      else if (agentPanel.contains(document.activeElement)) toggleAgent(false);
      else if (modeEl.classList.contains("open")) closeModeMenu();
      else if (mode != "text") setMode("text");
      else hideChrome();
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", (e) => {
    if (appShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  renderMode();
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
  $("btn-help").addEventListener("click", () => toggleHelp());

  // Pausing the page: a page that reacts to clicks and keys (slides that
  // advance on click, a game) gets in the way of editing its text. If it
  // defines window.ergaPause (DOCUMENT_PROMPT.md, rule 10), the pause button
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
    showChrome(); toggleHelp(false); toggleShare(false);
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
    if (!help.hidden && !help.contains(e.target as Node) && !$("btn-help").contains(e.target as Node)) toggleHelp(false);
    if (!share.hidden && !share.contains(e.target as Node) && !shareBtn.contains(e.target as Node)) toggleShare(false);
    if (!$("pause-card").hidden && !$("pause-card").contains(e.target as Node) && !$("btn-pause").contains(e.target as Node)) showPauseCard(false);
  });

  started = true;
  presenceChanged();
  window.ergaPage = { page, collab, toggleSource, captureView, get state() { return currentState(); } };
})();
