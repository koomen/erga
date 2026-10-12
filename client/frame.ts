// The host frame: the page editor, on the document's own origin (see
// bridge.ts). It renders the page in a frame of its own (same origin, so
// the editor can reach into it as before), and does everything that needs
// the page's DOM: typing, selections, marks and carets, pausing, and the
// agent's screenshots. Everything else is the shell's, which it
// reaches only by message, and only the shell may command it.

import { ChangeSet, EditorState } from "@codemirror/state";
import { historyField } from "@codemirror/commands";
import { domToPng } from "modern-screenshot";
import { PageEditor } from "./editor";
import { drawCaret } from "./caret";
import { watchMoves } from "./moves";
import { listenAsEditor } from "./text-guard";
import { Relay, docExtensions, isAppShortcut, stateJSON, type Backdrop, type FromFrame, type Snapshot, type ToFrame } from "./bridge";
import { catchZoomGestures, clampZoom } from "./zoom";
import { EVAL_MAX_JSON, evalTimeout, type ColorScheme, type RenderedFont, type ViewRequest, type ViewResult } from "../shared/agent-log";

declare global {
  interface Window { ergaFrame?: unknown; __ergaTimescale?: number; ergaHost?: { ready(): void; changed?(): void } }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The shell's origin (erga.dev): the only one this frame takes orders from, or sends to. */
const SHELL = document.querySelector<HTMLMetaElement>('meta[name="erga-shell"]')!.content;
/** The document's files, under this frame's address (which carries the token that opens them). */
const BASE = location.pathname.replace(/\/?$/, "/") + "doc/";

const post = (m: FromFrame) => window.parent.postMessage(m, SHELL);

// The page itself: scripts, forms and the rest, as on any web page. It's on
// this origin, which holds nothing but this document. It starts out of sight,
// behind the page as it renders (the host page's #view, server/pages/frame-host.ts), and takes
// its place once it has rendered (ergaHost.ready).
const frame = document.createElement("iframe");
frame.id = "page";
frame.title = "Document";
frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
document.body.append(frame);
// Your caret on the page, wider than the browser's own; in the frame of each render too (onUpdate).
drawCaret(frame);
/** The frame the page is in now: a render loads the page afresh into a new one, which takes this one's place. */
const cur = () => page?.frameElement ?? frame;

let page: PageEditor | null = null;
let relay: Relay | null = null;
/** In the source view the shell holds the text; edits here would go nowhere. */
let detached = false;
let restoreScroll: number | null = null;

// The page's zoom, as the shell sets it (zoom.ts): its frame (and the next one, as a render takes its place) is drawn
// `zoom` times larger and given a viewport that much smaller, as the browser's own zoom would, so the page lays itself
// out again to fit. Clicks and the caret stay right, as the browser maps them through the scale; what this frame tells
// the shell in its own coordinates (the pointer, the selection's rectangle) is scaled to match (`z`).
let zoom = 1;
const zoomStyle = document.createElement("style");
document.head.append(zoomStyle);
const z = (n: number) => n * zoom;
function setZoom(level: number) {
  const next = clampZoom(level);
  if (next == zoom) return;
  const win = cur().contentWindow, el = cur().contentDocument?.documentElement;
  // The same place in the page stays at the top, as near as the page's new layout allows.
  const at = win && el && el.scrollHeight > 0 ? win.scrollY / el.scrollHeight : 0;
  zoom = next;
  zoomStyle.textContent = zoom == 1 ? "" : `#page, #view { width: ${100 / zoom}%; height: ${100 / zoom}%; transform: scale(${zoom}); transform-origin: 0 0; }`;
  if (win && el && at) win.scrollTo(win.scrollX, at * el.scrollHeight);
  remeasure = true;
  queueSnapshot();
}
// The zoom gestures in this frame's own document (while the page renders afresh); the page's are caught in watchPage.
catchZoomGestures(window, (by) => post({ type: "zoom", zoom: by }));

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  const m = e.data as ToFrame | { type: "erga-edit" };
  // The shell asks for the editor: it may have missed our "ready", sent before it was listening.
  if (m.type == "erga-edit") { if (!page) post({ type: "ready" }); return; }
  if (m.type == "init") return start(m);
  if (!page || !relay) return;
  switch (m.type) {
    case "external": {
      const mine = relay.remote(ChangeSet.fromJSON(m.changes));
      page.applyExternal(mine, m.author);
      if (relay.idle && page.state.doc.length != m.length) post({ type: "resync" });
      if (page.stale) post({ type: "stale" });
      return;
    }
    case "ack": relay.accepted(); sendSelection(); return;
    case "reject": relay.refused(); return;
    case "authorship": page.recordAuthorship(ChangeSet.fromJSON(m.changes), m.author); return;
    case "tracking": page.setTracking(m.on); return;
    case "paused": page.setPaused(m.on); queueSnapshot(); return;
    // (The editor keeps the reader's place across it.)
    case "render": page.render(); return;
    case "zoom": setZoom(m.level); return;
    // The shell focuses this frame as it asks (Remote.focus): if this frame lost the focus since, something that opened
    // after the ask has it (the pages card, the agent's box), and keeps it.
    case "focus": if (document.hasFocus()) page.focus(); return;
    case "reveal": page.reveal(m.pos); return;
    case "peers": page.setPeers(m.peers); return;
    case "detach": detach(m.id); return;
    case "page": {
      relay.reset(m.version);
      detached = false;
      restoreScroll = null;
      page.open(stateFrom(m.state, m.kind), m.kind, setBase(m.dir));
      page.hold(false);
      return;
    }
    case "attach":
      relay.reset(m.version);
      detached = false;
      page.setState(stateFrom(m.state));
      page.hold(false);
      return;
    case "style": {
      const why = m.op == "toggle" ? page.toggleStyle(m.style) : m.op == "clear" ? page.clearStyles() : page.setLink(m.url);
      post({ type: "styled", id: m.id, why });
      queueSnapshot();
      return;
    }
    case "capture":
      captureView(m.req, m.text).catch((err: Error): ViewResult => ({ width: 0, height: 0, errors: [], error: `Couldn't capture the page: ${err.message}` }))
        .then((result) => post({ type: "captured", id: m.id, result }));
      return;
  }
});
post({ type: "ready" });

const stateFrom = (json: unknown, kind = page!.kind) => EditorState.fromJSON(json, { extensions: docExtensions(kind) }, { history: historyField });
/**
 * The page's own folder (`dir`, in the document), so its relative links and assets resolve as they would on disk:
 * the editor's base for it, which is this page's <base> too (server/pages/frame-host.ts set it to the document's folder): Chrome's preload
 * scanner resolves the srcdoc page's files against it, not against the <base> the page itself gets, so a page in a folder
 * asked for each of its relative files at the document's root first (404s), at every render and every capture.
 */
function setBase(dir: string | undefined): string {
  const base = BASE + (dir ? dir.split("/").map(encodeURIComponent).join("/") + "/" : "");
  document.querySelector("base")?.setAttribute("href", base);
  return base;
}

function start(m: Extract<ToFrame, { type: "init" }>) {
  if (page) return;
  if (m.timescale) window.__ergaTimescale = m.timescale;
  if (typeof m.zoom == "number") setZoom(m.zoom);
  // Where the page was scrolled to before a reload for a new release: there once it renders.
  // (Its images may still be loading, so the page may not be that long yet: tried again for a moment, until it gets
  // there or someone else scrolls it.)
  if (typeof m.scroll == "number" && Number.isFinite(m.scroll) && m.scroll > 0) {
    const y = restoreScroll = m.scroll, until = Date.now() + 3000;
    let last: number | null = null;
    const again = () => {
      const w = cur().contentWindow;
      if (Date.now() > until || !w) return;
      if (!cur().dataset.ready || restoreScroll != null) { setTimeout(again, 100); return; }
      if (Math.abs(w.scrollY - y) < 2 || (last != null && Math.abs(w.scrollY - last) >= 2)) return;
      w.scrollTo(0, y);
      last = w.scrollY;
      setTimeout(again, 100);
    };
    setTimeout(again, 100);
  }
  relay = new Relay(m.version, (version, changes) => post({ type: "push", version, changes: changes.toJSON() }));
  const state = EditorState.fromJSON(m.state, { extensions: docExtensions(m.kind) }, { history: historyField });
  const base = setBase(m.dir);
  page = new PageEditor({
    frame,
    kind: m.kind,
    state,
    base,
    markdownHead: m.markdownHead,
    self: m.self,
    onUpdate(u) {
      if (u.changes && !u.remote && !detached) relay!.local(u.changes);
      if (u.docChanged || u.selectionSet) sendSelection();
      // A presentation's pictures of its steps are out of date once its text changes.
      if (u.docChanged) { window.ergaHost?.changed?.(); queueBackdrop(); }
      if (u.rendered) {
        drawCaret(cur());
        watchPage();
        watchBackdrop();
        syncBackdrop(true);
        // (Shown first: the host page puts it where the plain page was scrolled, which a kept position then overrides.)
        if (!cur().dataset.ready) { cur().dataset.ready = "1"; window.ergaHost?.ready(); }
        if (restoreScroll != null) { cur().contentWindow?.scrollTo(0, restoreScroll); restoreScroll = null; }
      }
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
  });
  if (m.tracking) page.setTracking(true);
  window.ergaFrame = { page, get relay() { return relay; } };
}

/** This frame's selection, for the shell to share as your caret: only when it's in the shell's terms (no edits in flight). */
function sendSelection() {
  if (!page || !relay?.idle || detached) return;
  const sel = page.state.selection.main;
  post({ type: "selection", version: relay.version, anchor: sel.anchor, head: sel.head });
}

/** What the shell's controls show, at most once a frame. */
let snapshotQueued = false, renderedSince = false, column = 0, remeasure = true;
function queueSnapshot(rendered = false) {
  renderedSince ||= rendered;
  remeasure ||= rendered;
  if (snapshotQueued) return;
  snapshotQueued = true;
  requestAnimationFrame(() => {
    snapshotQueued = false;
    if (!page) return;
    const rect = page.selectionRect();
    if (remeasure) { column = measureColumn(); remeasure = false; }
    const snapshot: Snapshot = {
      title: page.title(),
      column,
      canPause: page.canPause,
      paused: page.isPaused,
      fmt: {
        rect: rect && { left: z(rect.left), top: z(rect.top), width: z(rect.width), bottom: z(rect.bottom) },
        blocker: page.styleBlocker(),
        has: { strong: page.hasStyle("strong"), em: page.hasStyle("em"), code: page.hasStyle("code") },
        link: page.linkAt(),
      },
      scrollY: Math.round(cur().contentWindow?.scrollY ?? 0),
    };
    post({ type: "update", rendered: renderedSince, snapshot });
    renderedSince = false;
  });
}

/** Leaving for the source view: once our edits are in, the state goes to the shell (undo history and all). */
function detach(id: number) {
  if (!page || !relay) return;
  if (!relay.idle) { setTimeout(() => detach(id), 10); return; }
  detached = true;
  page.hold(true);
  post({ type: "detached", id, state: stateJSON(page.state, historyField), version: relay.version });
}

/** The page's text column, so the source view can match it. */
function measureColumn(): number {
  const d = cur().contentDocument, win = cur().contentWindow;
  let left = Infinity, right = -Infinity;
  for (const el of d?.querySelectorAll("[data-erga-id]") ?? []) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < (win?.innerWidth ?? 1e9)) { left = Math.min(left, r.left); right = Math.max(right, r.right); }
  }
  return right - left;
}

/** Tells the shell what happens in the page that its controls follow: pointers, keys, focus, the selection moving. */
function watchPage() {
  const d = cur().contentDocument, win = cur().contentWindow;
  if (!d || !win || (d as Document & { ergaWatched?: boolean }).ergaWatched) return;
  (d as Document & { ergaWatched?: boolean }).ergaWatched = true;
  listenAsEditor(d, "pointerdown", (e) => { const p = e as PointerEvent; post({ type: "pointer", kind: "down", x: z(p.clientX), y: z(p.clientY) }); }, true);
  listenAsEditor(d, "mouseup", (e) => { const p = e as MouseEvent; post({ type: "pointer", kind: "up", x: z(p.clientX), y: z(p.clientY) }); }, true);
  catchZoomGestures(win, (by) => post({ type: "zoom", zoom: by }));
  d.addEventListener("keydown", () => post({ type: "activity", kind: "key" }), true);
  win.addEventListener("focus", () => post({ type: "activity", kind: "focus" }), true);
  d.addEventListener("scroll", () => queueSnapshot(), { passive: true });
  // The format bar follows selected text that moves another way: a scroll in an element, a pan of the page's own (moves.ts).
  watchMoves(d, win as Window & typeof globalThis, () => { if (d.getSelection()?.isCollapsed === false) queueSnapshot(); });
  d.addEventListener("selectionchange", () => queueSnapshot());
  // A link to another of the document's pages, outside the text being edited (a menu, say): the shell goes
  // there, to that page's editor. Links in the text itself aren't followed (⌘-click opens them in a tab).
  d.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.isContentEditable || (a.target && a.target != "_self") || a.getAttribute("href")!.startsWith("#")) return;
    let url: URL;
    try { url = new URL(a.href); } catch { return; }
    if (url.origin != location.origin || !url.pathname.startsWith(BASE)) return;
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(BASE.length)); } catch { return; }
    // A page, or an address like a folder's ("blog/"); not a stylesheet or an image.
    if (/\.[^./]+$/.test(path) && !/\.(html|md)$/i.test(path)) return;
    e.preventDefault();
    post({ type: "open", path });
  });
}
window.addEventListener("resize", () => { remeasure = true; queueSnapshot(); });
// While the page renders afresh, keys land on this frame's own document: the shell's shortcuts still reach it.
window.addEventListener("keydown", (e) => {
  if (!isAppShortcut(e, isMac)) return;
  e.preventDefault();
  post({ type: "key", keys: { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } });
});

// The page's background, so the shell can paint its canvas to match: its
// root's, or its body's when the root has none, as the browser would. Read
// after every change applied to the page (an edit in place can change a
// style rule: morph.ts), after a render, when a stylesheet loads, and when
// the page's own script switches themes (a class or style on <html> or
// <body>); said again only when it changed, at most once a task.
let backdropObserver: MutationObserver | null = null, backdropSaid = "", backdropQueued = false;
function syncBackdrop(always = false) {
  const d = cur().contentDocument, win = cur().contentWindow;
  if (!d?.documentElement || !win) return;
  const transparent = (cs: CSSStyleDeclaration) => cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
  let cs = win.getComputedStyle(d.documentElement);
  if (transparent(cs) && d.body) cs = win.getComputedStyle(d.body);
  // (A page that's only a gradient: the gradient's colour at the top, as the header sits there; the gradient itself is
  // the host page's to tell, server/pages/frame-host.ts canvasOf.)
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
/** Follows the page now in the frame (a render puts it in a new frame): its script's theme switches, and its stylesheets as they load. */
function watchBackdrop() {
  const d = cur().contentDocument as (Document & { ergaBackdrop?: boolean }) | null;
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

// The agent asks to see the page. This frame renders the latest version
// (edits still waiting for the end of the agent's turn included) in a
// hidden frame and draws it to an image, which the browser renders itself
// (modern-screenshot: the DOM through an SVG foreignObject), with any
// errors the page's scripts threw. No server-side browser: whoever has the
// editor open is the agent's eyes. It renders at the user's size and in
// their light or dark mode unless the agent asks for others, waits (up to
// LOAD_WAIT) for the page's web fonts and images, and says which fonts the
// text rendered in, so a fallback font shows as one.
const CATCH_ERRORS = `<script>window.__ergaErrors=[];addEventListener("error",function(e){__ergaErrors.push(String(e.message))});addEventListener("unhandledrejection",function(e){__ergaErrors.push("Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason))});(function(){var ce=console.error;console.error=function(){__ergaErrors.push("console.error: "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)}})()</script>`;
/**
 * Light or dark mode for the hidden frame, when the agent asks for the one
 * the browser doesn't prefer (a frame can't be given its own preference):
 * every prefers-color-scheme query the page can reach, in its stylesheets,
 * its elements' media attributes and its scripts' matchMedia, answers for
 * `scheme` instead.
 */
const schemeQuery = (scheme: ColorScheme, media: string) =>
  media.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, s: string) => s.toLowerCase() == scheme ? "(min-width: 0px)" : "(min-width: 1000000px)");
const forceSchemeScript = (scheme: ColorScheme) =>
  `<script>(function(){var mm=window.matchMedia;window.matchMedia=function(q){return mm.call(window,String(q).replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(light|dark)\\s*\\)/gi,function(_,s){return s.toLowerCase()==${JSON.stringify(scheme)}?"(min-width: 0px)":"(min-width: 1000000px)"}))}})()</script>`;
function forceScheme(d: Document, scheme: ColorScheme) {
  const w = d.defaultView as Window & typeof globalThis; // the page's own classes: instanceof is per window
  const rewrite = (rules: CSSRuleList) => {
    for (const r of rules) {
      if ((r instanceof w.CSSMediaRule || r instanceof w.CSSImportRule) && /prefers-color-scheme/i.test(r.media.mediaText)) r.media.mediaText = schemeQuery(scheme, r.media.mediaText);
      if (r instanceof w.CSSImportRule) { try { if (r.styleSheet) rewrite(r.styleSheet.cssRules); } catch { /* another site's */ } }
      else if ("cssRules" in r) rewrite((r as CSSGroupingRule).cssRules);
    }
  };
  for (const s of d.styleSheets) { try { rewrite(s.cssRules); } catch { /* another site's: out of reach */ } }
  for (const el of d.querySelectorAll<HTMLElement>("[media]")) {
    const m = el.getAttribute("media")!;
    if (/prefers-color-scheme/i.test(m)) el.setAttribute("media", schemeQuery(scheme, m));
  }
  // A page that lets the browser choose (color-scheme: light dark) gets the one asked for.
  const root = d.documentElement, cs = d.defaultView!.getComputedStyle(root).colorScheme;
  if (/light/.test(cs) && /dark/.test(cs)) root.style.setProperty("color-scheme", scheme);
}
const MAX_SHOT = 4000;
const LOAD_WAIT = 5000;
async function captureView(req: ViewRequest, text?: string): Promise<ViewResult> {
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? (cur().clientWidth || 1280))));
  const viewport = Math.round(Math.max(200, Math.min(MAX_SHOT, req.height ?? (cur().clientHeight || 800))));
  const prefers: ColorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const scheme = req.colorScheme ?? prefers;
  const forced = scheme != prefers;
  const shot = document.createElement("iframe");
  shot.setAttribute("sandbox", "allow-scripts allow-same-origin");
  shot.setAttribute("aria-hidden", "true");
  shot.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${viewport}px;border:0;`;
  const html = page!.renderedHtml(text);
  const head = CATCH_ERRORS + (forced ? forceSchemeScript(scheme) : "");
  shot.srcdoc = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + head) : head + html;
  document.body.append(shot);
  try {
    await new Promise<void>((resolve, reject) => { shot.onload = () => resolve(); setTimeout(() => reject(new Error("the page took too long to load")), 10_000); });
    const d = shot.contentDocument!, win = shot.contentWindow as (Window & { __ergaErrors?: string[] }) | null;
    if (forced) forceScheme(d, scheme);
    const unread = await embeddableFonts(d);
    const pending = await settle(d, Date.now() + LOAD_WAIT);
    await new Promise((r) => setTimeout(r, 600)); // let the page's own scripts draw
    if (req.evaluate != null) {
      const r = await evaluateIn(win!, String(req.evaluate), evalTimeout(req));
      return { width, height: viewport, ...r, errors: [...(win?.__ergaErrors ?? [])] };
    }
    const root = win!.getComputedStyle(d.documentElement), body = d.body ? win!.getComputedStyle(d.body) : null;
    const clear = (c: string) => /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
    const bg = !clear(root.backgroundColor) ? root.backgroundColor : body && !clear(body.backgroundColor) ? body.backgroundColor : scheme == "dark" && /dark/.test(root.colorScheme) ? "#121212" : "#ffffff";
    let target: Element = d.documentElement, w = width, h = viewport;
    const notes: string[] = [];
    if (req.selector) {
      let el: Element | null = null;
      try { el = d.querySelector(req.selector); } catch { return { width: 0, height: 0, errors: [], error: `${req.selector} isn't a valid CSS selector` }; }
      if (!el) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `Nothing on the page matches ${req.selector}` };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered` };
      target = el; w = Math.ceil(r.width); h = Math.min(MAX_SHOT, Math.ceil(r.height));
      if (r.height > MAX_SHOT) notes.push(`${req.selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.`);
    } else if (req.fullPage) {
      const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
      h = Math.min(MAX_SHOT, full);
      if (full > MAX_SHOT) notes.push(`The page is ${full}px tall; this shows the top ${MAX_SHOT}px.`);
    }
    if (unread.length) notes.push(`The picture may show fallback fonts where the page uses fonts from ${unread.join(", ")}: that stylesheet can't be read from the page (no CORS), so its fonts can't go into the picture.`);
    const fonts = renderedFonts(d, target);
    // An element is drawn at its own size, without the margins around it (they'd shift it inside the image).
    const url = await domToPng(target, target == d.documentElement ? { width: w, height: h, backgroundColor: bg, scale: 1 } : { backgroundColor: bg, scale: 1, style: { margin: "0" } });
    return {
      png: url.slice(url.indexOf(",") + 1), width: w, height: h, errors: win?.__ergaErrors ?? [],
      viewport: { width, height: viewport }, colorScheme: scheme, fonts,
      ...(pending.length ? { pending } : {}),
      ...(notes.length ? { note: notes.join("\n") } : {}),
    };
  } finally {
    shot.remove();
  }
}

/**
 * Stylesheets from other sites (Google Fonts, say) can't be read by the
 * page's scripts, so modern-screenshot can't put their fonts in the picture
 * and draws their text in a fallback. Their @font-face rules are fetched
 * (most font services allow it: CORS) and added to the page as its own.
 * Answers the ones that couldn't be read.
 */
async function embeddableFonts(d: Document): Promise<string[]> {
  const sheets = [...d.styleSheets].filter((s) => { try { void s.cssRules; return false; } catch { return !!s.href; } });
  const unread: string[] = [];
  await Promise.all(sheets.map(async (s) => {
    const href = s.href!;
    try {
      const res = await fetch(href, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(LOAD_WAIT) });
      if (!res.ok) throw new Error(String(res.status));
      const css = (await res.text()).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, _q, u: string) => `url("${new URL(u, href).href}")`);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      const faces = [...sheet.cssRules].filter((r) => r instanceof CSSFontFaceRule).map((r) => r.cssText);
      if (!faces.length) return;
      const style = d.createElement("style");
      style.dataset.ergaFonts = href;
      style.textContent = faces.join("\n");
      d.head.append(style);
    } catch {
      unread.push(new URL(href).host);
    }
  }));
  return [...new Set(unread)];
}

/**
 * Waits until the page's fonts and images have loaded, or `deadline`.
 * A web font loads only once some text needs it, so this lays the page out
 * first; lazy images load at once, since a whole-page picture shows them.
 * Answers what still hadn't loaded.
 */
async function settle(d: Document, deadline: number): Promise<string[]> {
  const imgs = [...d.images];
  for (const img of imgs) if (img.loading == "lazy") img.loading = "eager";
  const loading = () => [
    ...[...d.fonts].filter((f) => f.status == "loading").map((f) => ({ what: `font ${f.family.replace(/^["']|["']$/g, "")} ${f.weight} ${f.style}`, done: f.loaded.then(() => {}, () => {}) })),
    ...imgs.filter((i) => i.src && !i.complete).map((i) => ({ what: `image ${i.getAttribute("src")}`, done: i.decode().catch(() => {}) })),
  ];
  // Text laid out in a newly loaded font can need another (a bold or an italic): look again until nothing loads.
  for (let round = 0; round < 5; round++) {
    void d.documentElement.getBoundingClientRect();
    await Promise.race([new Promise((r) => requestAnimationFrame(r)), sleep(50)]); // a tab in the background gets no frames
    const now = loading();
    if (!now.length) { await Promise.race([d.fonts.ready, sleep(deadline - Date.now())]); if (!loading().length) break; continue; }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Promise.race([Promise.all(now.map((l) => l.done)), sleep(left)]);
  }
  return [...new Set(loading().map((l) => l.what))];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);

/**
 * The fonts the text under `root` rendered in: for each element with text of
 * its own, the first family in its font-family that the browser could use
 * (a web font that loaded, a font on this computer, or a generic one).
 */
function renderedFonts(d: Document, root: Element): RenderedFont[] {
  const win = d.defaultView!;
  const faces = new Map<string, FontFace[]>();
  for (const f of d.fonts) { const k = unquote(f.family).toLowerCase(); faces.set(k, [...(faces.get(k) ?? []), f]); }
  const ctx = d.createElement("canvas").getContext("2d");
  const installed = new Map<string, boolean>();
  const isInstalled = (family: string) => {
    if (!installed.has(family)) {
      // A font the computer has changes how wide text is, from at least one of two different fallbacks.
      const probe = "mmmmmmmmmmlli WQ@#0123456789";
      const width = (font: string) => { ctx!.font = font; return ctx!.measureText(probe).width; };
      installed.set(family, !!ctx && ["monospace", "serif"].some((g) => width(`72px "${family}", ${g}`) != width(`72px ${g}`)));
    }
    return installed.get(family)!;
  };
  const resolve = (stack: string): { family: string; wanted?: string } => {
    const families = stack.split(",").map((f) => unquote(f.trim())).filter(Boolean);
    for (const family of families) {
      const key = family.toLowerCase();
      if (GENERIC.has(key)) return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
      const own = faces.get(key);
      if (own ? own.some((f) => f.status == "loaded") : isInstalled(family)) return { family, ...(family != families[0] ? { wanted: families[0] } : {}) };
    }
    return { family: "the browser's default font", wanted: families[0] };
  };
  const by = new Map<string, RenderedFont>();
  const seen = new Set<Element>();
  const walk = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.nodeValue?.trim() || el.closest("script, style, noscript, template, title")) continue;
    seen.add(el);
    const cs = win.getComputedStyle(el);
    if (cs.display == "none" || cs.visibility == "hidden") continue;
    const r = resolve(cs.fontFamily);
    const key = `${r.family}|${r.wanted ?? ""}`;
    const f = by.get(key) ?? { family: r.family, ...(r.wanted ? { wanted: r.wanted } : {}), elements: 0, tags: [] };
    f.elements++;
    const tag = el.tagName.toLowerCase();
    if (f.tags.length < 5 && !f.tags.includes(tag)) f.tags.push(tag);
    by.set(key, f);
  }
  return [...by.values()].sort((a, b) => b.elements - a.elements).slice(0, 10);
}
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");


// evaluate_page: the agent's expression runs in the same throwaway render
// view_page draws, so it sees computed styles, fonts and sizes as the page
// has them. Nothing goes back to the document: the render is a copy of its
// text, removed once the result is out, and nothing reads its DOM back.
// The expression gets what the page's own scripts have, no more: this
// origin holds only the document. parent, top, opener and frameElement
// read as null in it, so it doesn't reach into the editor by mistake.
// Only the result's JSON comes back, cut to EVAL_MAX_JSON characters.
// The time limit can't stop an expression that never yields (while (true)):
// it stalls this tab, and the host gives up after viewWait.
async function evaluateIn(win: Window, expr: string, timeoutMs: number): Promise<{ value?: string; note?: string; error?: string }> {
  const W = win as Window & typeof globalThis;
  for (const k of ["parent", "opener", "frameElement"]) try { Object.defineProperty(W, k, { value: null, configurable: true }); } catch { /* not replaceable here */ }
  const params = ["parent", "top", "opener", "frameElement"];
  let fn: (...a: null[]) => Promise<unknown>;
  try { fn = new W.Function(...params, `return (async () => (${expr}\n))()`) as typeof fn; } catch {
    // Not one expression: statements, with their own return.
    try { fn = new W.Function(...params, `return (async () => {${expr}\n})()`) as typeof fn; } catch (e) { return { error: `The expression doesn't parse: ${(e as Error).message}` }; }
  }
  let timer = 0;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => fn(null, null, null, null)),
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new EvalTimeout()), timeoutMs); }),
    ]);
    const json = toJSON(value, W);
    if (json.length <= EVAL_MAX_JSON) return { value: json };
    return { value: json.slice(0, EVAL_MAX_JSON), note: `The result is ${json.length} characters of JSON; this is the first ${EVAL_MAX_JSON}. Return less (pick the properties you need).` };
  } catch (e) {
    if (e instanceof EvalTimeout) return { error: `The expression didn't finish within ${timeoutMs} ms.` };
    const err = e as { name?: unknown; message?: unknown } | null;
    return { error: `The expression threw: ${err && typeof err == "object" && "message" in err ? `${String(err.name ?? "Error")}: ${String(err.message)}` : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

class EvalTimeout extends Error {}

/**
 * A value from the page as JSON, whatever it is: elements become a short
 * description (<p#id.class>), lists and sets arrays, computed styles their
 * properties, cycles "[circular]". Stops early once it is far over the cap.
 */
function toJSON(value: unknown, W: Window & typeof globalThis): string {
  if (value === undefined) return "undefined";
  const seen = new WeakSet<object>();
  let budget = EVAL_MAX_JSON * 4;
  const plain = (x: unknown, depth: number): unknown => {
    if (budget-- <= 0) return "…";
    if (x === null || typeof x == "boolean" || typeof x == "string") return x;
    if (typeof x == "number") return Number.isFinite(x) ? x : String(x);
    if (typeof x == "bigint") return `${x}n`;
    if (typeof x == "undefined") return null;
    if (typeof x == "function") return `[function ${x.name || "anonymous"}]`;
    if (typeof x == "symbol") return x.toString();
    const o = x as object;
    if (seen.has(o)) return "[circular]";
    if (depth > 12) return "[too deep]";
    seen.add(o);
    try {
      if (o instanceof W.Element) return `<${o.localName}${o.id ? `#${o.id}` : ""}${[...o.classList].map((c) => `.${c}`).join("")}>`;
      if (o instanceof W.Node) return o.nodeType == 3 ? `#text ${JSON.stringify((o.textContent ?? "").slice(0, 80))}` : `[${o.nodeName}]`;
      if (o instanceof W.CSSStyleDeclaration) {
        const out: Record<string, string> = {};
        for (let i = 0; i < o.length; i++) out[o[i]] = o.getPropertyValue(o[i]);
        return out;
      }
      if (o instanceof W.FontFace) return { family: o.family, style: o.style, weight: o.weight, status: o.status };
      if (o instanceof W.Error) return { name: o.name, message: o.message };
      if (o instanceof W.Map) return plain(Object.fromEntries([...o.entries()].slice(0, 1000).map(([k, v]) => [String(k), v])), depth + 1);
      if (typeof (o as { toJSON?: unknown }).toJSON == "function") return plain((o as { toJSON(): unknown }).toJSON(), depth + 1);
      if (Array.isArray(o) || (Symbol.iterator in o && typeof o != "string")) {
        const out: unknown[] = [];
        for (const v of o as Iterable<unknown>) { if (out.length >= 1000 || budget <= 0) { out.push("…"); break; } out.push(plain(v, depth + 1)); }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) { if (budget <= 0) { out["…"] = "…"; break; } out[k] = plain((o as Record<string, unknown>)[k], depth + 1); }
      return out;
    } finally {
      seen.delete(o);
    }
  };
  return JSON.stringify(plain(value, 0)) ?? "undefined";
}
