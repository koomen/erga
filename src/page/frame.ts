// The host frame: the page editor, on the document's own origin (see
// bridge.ts). It renders the page in a frame of its own (same origin, so
// the editor can reach into it as before), and does everything that needs
// the page's DOM: typing, selections, marks and carets, pausing, and the
// agent's screenshots. Everything else is the shell's (main.ts), which it
// reaches only by message, and only the shell may command it.

import { ChangeSet, EditorState } from "@codemirror/state";
import { historyField } from "@codemirror/commands";
import { domToPng } from "modern-screenshot";
import { PageEditor } from "./editor";
import { Relay, docExtensions, isAppShortcut, stateJSON, type Backdrop, type FromFrame, type Snapshot, type ToFrame } from "./bridge";
import type { ViewRequest, ViewResult } from "./agent-log";

declare global {
  interface Window { ergaFrame?: unknown; __ergaTimescale?: number }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The shell's origin (erga.dev): the only one this frame takes orders from, or sends to. */
const SHELL = document.querySelector<HTMLMetaElement>('meta[name="erga-shell"]')!.content;
/** The document's files, under this frame's address (which carries the token that opens them). */
const BASE = location.pathname.replace(/\/?$/, "/") + "doc/";

const post = (m: FromFrame) => window.parent.postMessage(m, SHELL);

// The page itself: scripts, forms and the rest, as on any web page. It's on
// this origin, which holds nothing but this document.
const frame = document.createElement("iframe");
frame.id = "page";
frame.title = "Document";
frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
document.body.append(frame);

let page: PageEditor | null = null;
let relay: Relay | null = null;
/** In the source view the shell holds the text; edits here would go nowhere. */
let detached = false;
let restoreScroll: number | null = null;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source != window.parent || e.origin != SHELL) return;
  const m = e.data as ToFrame;
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
    case "render": restoreScroll = frame.contentWindow?.scrollY ?? 0; page.render(); return;
    case "focus": page.focus(); return;
    case "reveal": page.reveal(m.pos); return;
    case "peers": page.setPeers(m.peers); return;
    case "detach": detach(m.id); return;
    case "attach":
      relay.reset(m.version);
      detached = false;
      page.setState(stateFrom(m.state));
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

const stateFrom = (json: unknown) => EditorState.fromJSON(json, { extensions: docExtensions(page!.kind) }, { history: historyField });

function start(m: Extract<ToFrame, { type: "init" }>) {
  if (page) return;
  if (m.timescale) window.__ergaTimescale = m.timescale;
  relay = new Relay(m.version, (version, changes) => post({ type: "push", version, changes: changes.toJSON() }));
  const state = EditorState.fromJSON(m.state, { extensions: docExtensions(m.kind) }, { history: historyField });
  page = new PageEditor({
    frame,
    kind: m.kind,
    state,
    base: BASE,
    markdownHead: m.markdownHead,
    self: m.self,
    onUpdate(u) {
      if (u.changes && !u.remote && !detached) relay!.local(u.changes);
      if (u.docChanged || u.selectionSet) sendSelection();
      if (u.rendered) {
        if (restoreScroll != null) { frame.contentWindow?.scrollTo(0, restoreScroll); restoreScroll = null; }
        watchPage();
        syncBackdrop();
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
    onPointer: (e) => post({ type: "pointer", kind: "move", x: e.clientX, y: e.clientY }),
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
let snapshotQueued = false, renderedSince = false;
function queueSnapshot(rendered = false) {
  renderedSince ||= rendered;
  if (snapshotQueued) return;
  snapshotQueued = true;
  requestAnimationFrame(() => {
    snapshotQueued = false;
    if (!page) return;
    const rect = page.selectionRect();
    const snapshot: Snapshot = {
      title: page.title(),
      canPause: page.canPause,
      paused: page.isPaused,
      fmt: {
        rect: rect && { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom },
        blocker: page.styleBlocker(),
        has: { strong: page.hasStyle("strong"), em: page.hasStyle("em"), code: page.hasStyle("code") },
        link: page.linkAt(),
      },
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
  post({ type: "detached", id, state: stateJSON(page.state, historyField), version: relay.version, column: measureColumn() });
}

/** The page's text column, so the source view can match it. */
function measureColumn(): number {
  const d = frame.contentDocument, win = frame.contentWindow;
  let left = Infinity, right = -Infinity;
  for (const el of d?.querySelectorAll("[data-erga-id]") ?? []) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < (win?.innerWidth ?? 1e9)) { left = Math.min(left, r.left); right = Math.max(right, r.right); }
  }
  return right - left;
}

/** Tells the shell what happens in the page that its controls follow: pointers, keys, focus, the selection moving. */
function watchPage() {
  const d = frame.contentDocument, win = frame.contentWindow;
  if (!d || !win || (d as Document & { ergaWatched?: boolean }).ergaWatched) return;
  (d as Document & { ergaWatched?: boolean }).ergaWatched = true;
  d.addEventListener("pointerdown", (e) => post({ type: "pointer", kind: "down", x: e.clientX, y: e.clientY }), true);
  d.addEventListener("mouseup", (e) => post({ type: "pointer", kind: "up", x: e.clientX, y: e.clientY }), true);
  d.addEventListener("keydown", () => post({ type: "activity", kind: "key" }), true);
  win.addEventListener("focus", () => post({ type: "activity", kind: "focus" }), true);
  d.addEventListener("scroll", () => queueSnapshot(), { passive: true });
  d.addEventListener("selectionchange", () => queueSnapshot());
}
window.addEventListener("resize", () => queueSnapshot());

// The page's background, so the shell can paint its canvas to match: its
// root's, or its body's when the root has none, as the browser would.
let backdropObserver: MutationObserver | null = null;
function syncBackdrop() {
  const d = frame.contentDocument, win = frame.contentWindow;
  if (!d?.documentElement || !win) return;
  const transparent = (cs: CSSStyleDeclaration) => cs.backgroundImage == "none" && /^(transparent|rgba\([^)]*,\s*0\))$/.test(cs.backgroundColor);
  let cs = win.getComputedStyle(d.documentElement);
  if (transparent(cs) && d.body) cs = win.getComputedStyle(d.body);
  const backdrop: Backdrop = { color: transparent(cs) ? "" : cs.backgroundColor, image: cs.backgroundImage == "none" ? "" : cs.backgroundImage };
  post({ type: "backdrop", backdrop });
  // Follow the page if its own script switches themes.
  backdropObserver ??= new MutationObserver(() => syncBackdrop());
  backdropObserver.disconnect();
  backdropObserver.observe(d.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (d.body) backdropObserver.observe(d.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
}

// The agent asks to see the page. This frame renders the latest version
// (edits still waiting for the end of the agent's turn included) in a
// hidden frame and draws it to an image, which the browser renders itself
// (modern-screenshot: the DOM through an SVG foreignObject), with any
// errors the page's scripts threw. No server-side browser: whoever has the
// editor open is the agent's eyes.
const CATCH_ERRORS = `<script>window.__ergaErrors=[];addEventListener("error",function(e){__ergaErrors.push(String(e.message))});addEventListener("unhandledrejection",function(e){__ergaErrors.push("Unhandled rejection: "+String(e.reason&&e.reason.message||e.reason))});(function(){var ce=console.error;console.error=function(){__ergaErrors.push("console.error: "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)}})()</script>`;
const MAX_SHOT = 4000;
async function captureView(req: ViewRequest, text?: string): Promise<ViewResult> {
  const width = Math.round(Math.max(320, Math.min(2400, req.width ?? (frame.clientWidth || 1280))));
  const viewport = frame.clientHeight || 800;
  const shot = document.createElement("iframe");
  shot.setAttribute("sandbox", "allow-scripts allow-same-origin");
  shot.setAttribute("aria-hidden", "true");
  shot.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${viewport}px;border:0;`;
  const html = page!.renderedHtml(text);
  shot.srcdoc = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + CATCH_ERRORS) : CATCH_ERRORS + html;
  document.body.append(shot);
  try {
    await new Promise<void>((resolve, reject) => { shot.onload = () => resolve(); setTimeout(() => reject(new Error("the page took too long to load")), 10_000); });
    const d = shot.contentDocument!, win = shot.contentWindow as (Window & { __ergaErrors?: string[] }) | null;
    await d.fonts?.ready;
    await new Promise((r) => setTimeout(r, 600)); // let the page's own scripts draw
    const root = win!.getComputedStyle(d.documentElement), body = d.body ? win!.getComputedStyle(d.body) : null;
    const clear = (c: string) => /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
    const bg = !clear(root.backgroundColor) ? root.backgroundColor : body && !clear(body.backgroundColor) ? body.backgroundColor : "#ffffff";
    let target: Element = d.documentElement, w = width, h = viewport, note: string | undefined;
    if (req.selector) {
      let el: Element | null = null;
      try { el = d.querySelector(req.selector); } catch { return { width: 0, height: 0, errors: [], error: `${req.selector} isn't a valid CSS selector` }; }
      if (!el) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `Nothing on the page matches ${req.selector}` };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { width: 0, height: 0, errors: win?.__ergaErrors ?? [], error: `${req.selector} has no size (${Math.round(r.width)}×${Math.round(r.height)}); it may not have rendered` };
      target = el; w = Math.ceil(r.width); h = Math.min(MAX_SHOT, Math.ceil(r.height));
      if (r.height > MAX_SHOT) note = `${req.selector} is ${Math.round(r.height)}px tall; this shows the top ${MAX_SHOT}px.`;
    } else if (req.fullPage) {
      const full = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
      h = Math.min(MAX_SHOT, full);
      if (full > MAX_SHOT) note = `The page is ${full}px tall; this shows the top ${MAX_SHOT}px.`;
    }
    // An element is drawn at its own size, without the margins around it (they'd shift it inside the image).
    const url = await domToPng(target, target == d.documentElement ? { width: w, height: h, backgroundColor: bg, scale: 1 } : { backgroundColor: bg, scale: 1, style: { margin: "0" } });
    return { png: url.slice(url.indexOf(",") + 1), width: w, height: h, errors: win?.__ergaErrors ?? [], note };
  } finally {
    shot.remove();
  }
}

