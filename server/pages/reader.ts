// A document's page, as everyone sees it: one frame on the viewer (pages/viewer.ts), which holds the page on the
// document's own pages origin (documents/pages-origin.ts), served with the source marks the editor needs
// (shared/page.ts). It loads once: reading it, and editing it. Going into the editor loads the editor's half into the
// page itself (client/frame.ts, from the app's origin, pinned by its integrity), which finds the text there by its
// marks; going back out stops it, and the page stays as it is, its scripts and media carrying on.
//
// This script goes into the page first (before the page's own), and tells the viewer by postMessage what it needs:
// where the page is scrolled to and where the pointer is (the fade), its background (the band and the canvas around
// the frame), its steps (a presentation), and which of the document's pages it shows. It follows the viewer's asks (a
// step, a step's picture, the editor), and sends links that leave the document to the viewer, which opens them.
//
// What it sends is the page's own word: the page's scripts can send the same (the viewer checks every message as
// coming from the page). It sends nothing secret, and to the viewer's origin only. The page's origin holds nothing but
// this one document: that's the boundary (PAGE_SANDBOX).

import { EVENT_TYPES, liveWatch } from "../../shared/live-page.ts";
import { EDITING_API, insertHead, PROBLEM_WATCH, TEXT_GUARD } from "../../shared/page.ts";
import { asset, frameScripts } from "./assets.ts";

/**
 * What a document's page may do in its frame, for readers and editors alike.
 *
 * allow-same-origin stays, with allow-scripts: the page keeps its pages origin, which holds nothing but this one
 * document, and the editor's half reaches into it there (typing and carets). So the page's script can remove its own
 * sandbox: Chrome warns about that, rightly, and it changes nothing. The boundary is the origin: the page can't reach
 * erga.dev, its cookies or another document's origin, and the viewer (viewer.ts, client/remote.ts) treats every
 * message from it as the page's own. Its own storage is its own, as on any site.
 */
export const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

/** What a reader's page may do beyond its sandbox: nothing. */
export const PAGE_ALLOW = "autoplay 'none'; fullscreen 'none'";

/**
 * What an editor's page may do beyond its sandbox: autoplay, for the agent's page_click (it gives no activation of its
 * own, so the page's media plays on the tab's). Never full screen: the agent can't use it, and a page in full screen
 * could pass for Erga. (The frame is the same one viewing and editing: what it may do is decided as the viewer loads,
 * opened in the editor or not.)
 */
export const EDITOR_ALLOW = "autoplay; fullscreen 'none'";

/** What the script needs: the viewer's origin, where the document's files are (with the token), and its text's digest. */
export interface ReaderConfig {
  /** The viewer's origin (the token names it): the only one it talks to. */
  shell: string;
  /** The path the document's files are under on this origin: /t/<token>/. */
  prefix: string;
  /** The digest of the text the page was made from (shared/page.ts, sourceDigest): the editor checks it has the same. */
  src: string;
  /** For whoever may edit: the editor's half (frame.js), its chunks and their integrity. */
  editor?: { src: string; integrity: string; preload: string[]; map: Record<string, string> };
}

/** The script, as text. */
export const readerScript = (config: ReaderConfig) => `(function () {
  var C = ${JSON.stringify(config).replace(/</g, "\\u003c")};
  // Only as the viewer's document: not opened by itself, nor in a frame inside the page.
  if (parent == window || parent != top) return;
  var P = parent, root = document.documentElement;
  function tell(m) { try { P.postMessage(m, C.shell); } catch (e) {} }
  function editing() { return root.hasAttribute("data-erga-editing"); }
  window.__ergaReader = { config: C, changed: function () { rev++; said = ""; tellSteps(); }, placed: function () { placed(); } };
  tell({ type: "erga-hello" });
  // Which of the document's pages this is ("" for its own page).
  var page = location.pathname.indexOf(C.prefix) == 0 ? location.pathname.slice(C.prefix.length) : "";
  try { page = decodeURIComponent(page); } catch (e) {}
  if (!page || /\\.html$/i.test(page)) tell({ type: "erga-nav", path: page || "" });
  // The page stops dead at its top and bottom.
  var still = document.createElement("style");
  still.setAttribute("data-erga", "");
  still.textContent = "html { overscroll-behavior: none; }";
  (document.head || root).append(still);
  // Reloaded in the editor scrolled down the page (?erga-y=, viewer.ts): it opens where it was, out of sight until it's
  // there (its content may still be coming), or as far as it goes once it has loaded (a shorter page now), or after a moment.
  var startY = Number((/[?&]erga-y=(\\d+)/.exec(location.search) || [])[1]) || 0, placing = null;
  function placed() { startY = 0; if (placing) { placing.remove(); placing = null; } }
  function place() {
    if (!startY || !document.body) return;
    scrollTo(0, startY);
    if (Math.abs(scrollY - startY) < 2 || (document.readyState == "complete" && scrollY + innerHeight >= root.scrollHeight - 2)) placed();
  }
  if (startY) {
    placing = document.createElement("style");
    placing.setAttribute("data-erga", "");
    placing.textContent = "html { visibility: hidden !important; }";
    (document.head || root).append(placing);
    setTimeout(placed, 1500);
  }
  // The editor's half, into this page: at once when the viewer opened the page in the editor (?erga-edit), else when it
  // asks. (Its chunks' integrity is the import map's, before this script: readerPage puts it there.)
  var loading = false;
  function load() {
    if (loading || !C.editor) return;
    loading = true;
    var head = document.head || root;
    C.editor.preload.forEach(function (href) { var l = document.createElement("link"); l.rel = "modulepreload"; l.href = href; l.crossOrigin = "anonymous"; l.setAttribute("data-erga", ""); if (C.editor.map[href]) l.integrity = C.editor.map[href]; head.append(l); });
    var s = document.createElement("script");
    s.type = "module"; s.crossOrigin = "anonymous"; s.src = C.editor.src; s.setAttribute("data-erga", "");
    if (C.editor.integrity) s.integrity = C.editor.integrity;
    head.append(s);
  }
  if (/[?&]erga-edit(=|&|$)/.test(location.search)) load();
  // The fade: where the page is scrolled to, and the pointer over it, at most once a frame.
  var scrolled = null, pointer = null;
  function report() {
    var at = scrollX + "," + scrollY;
    if (at !== scrolled) { scrolled = at; tell({ type: "erga-scroll", y: Math.max(0, Math.round(scrollY)), sx: scrollX, sy: scrollY }); }
  }
  addEventListener("scroll", report, { passive: true });
  document.addEventListener("pointermove", function (e) {
    if (e.pointerType != "mouse") return;
    if (!pointer) requestAnimationFrame(function () { tell({ type: "erga-pointer", x: pointer.x, y: pointer.y }); pointer = null; });
    pointer = { x: e.clientX, y: e.clientY };
  }, { capture: true, passive: true });
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType != "mouse") tell({ type: "erga-pointer", x: e.clientX, y: e.clientY, tap: true });
  }, { capture: true, passive: true });
  // Links, reading (the editor follows its own: client/frame.ts). To another of the document's pages: in this frame, as
  // the link says. Out of the document: a new tab, unless the link names its own target; "_self" takes the whole tab.
  // The viewer opens both, on the reader's click.
  document.addEventListener("click", function (e) {
    if (editing() || e.defaultPrevented || e.button != 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || a.hasAttribute("download") || !/^https?:$/.test(a.protocol)) return;
    if (a.origin == location.origin && a.pathname.indexOf(C.prefix) == 0) return;
    var t = (a.getAttribute("target") || "").toLowerCase();
    if (!t || t == "_blank") { e.preventDefault(); tell({ type: "erga-go", url: a.href, tab: "new" }); }
    else if (t == "_self" || t == "_top" || t == "_parent") { e.preventDefault(); tell({ type: "erga-go", url: a.href }); }
  });
  // The band above the page takes its background (its own colour; else a gradient's colour at the top), and the canvas
  // around the frame its background's layers: what the browser gives the canvas (the root's, or the body's when the
  // root has none), placed against the root's box. An image goes as its file, fetched here; one that can't be is left out.
  function clear(c) { return /^(transparent|rgba\\([^)]*,\\s*0\\))$/.test(c); }
  function solid(cs) {
    var c = cs.backgroundColor;
    if (!clear(c)) return c;
    var img = cs.backgroundImage, stops = img && img != "none" && /gradient/.test(img) ? img.match(/rgba?\\([^)]*\\)/g) : null;
    if (stops) return /^linear-gradient\\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0];
    return "";
  }
  function ready() { return !!document.body || document.readyState != "loading"; }
  function colour() {
    if (!ready()) return null;
    var c = solid(getComputedStyle(root));
    if (!c && document.body) c = solid(getComputedStyle(document.body));
    return c;
  }
  function layers(v) {
    var out = [], depth = 0, quote = "", from = 0;
    for (var i = 0; i < v.length; i++) {
      var ch = v[i];
      if (quote) { if (ch == "\\\\") i++; else if (ch == quote) quote = ""; }
      else if (ch == '"' || ch == "'") quote = ch;
      else if (ch == "(") depth++;
      else if (ch == ")") depth--;
      else if (ch == "," && !depth) { out.push(v.slice(from, i).trim()); from = i + 1; }
    }
    out.push(v.slice(from).trim());
    return out;
  }
  var pictures = {};
  function picture(u) {
    if (u in pictures) return pictures[u];
    pictures[u] = undefined;
    fetch(u).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      pictures[u] = b && /^image\\//.test(b.type) && b.size < 4e6 ? b : null;
    }, function () { pictures[u] = null; });
    return undefined;
  }
  function canvas() {
    if (!ready()) return null;
    var cs = getComputedStyle(root);
    if (cs.backgroundImage == "none" && clear(cs.backgroundColor) && document.body) cs = getComputedStyle(document.body);
    var c = { color: clear(cs.backgroundColor) ? "" : cs.backgroundColor, image: "", files: [], urls: [] };
    if (cs.backgroundImage == "none") return c;
    var images = layers(cs.backgroundImage), sizes = layers(cs.backgroundSize), repeats = layers(cs.backgroundRepeat), tile = false;
    for (var i = 0; i < images.length; i++) {
      var m = /^url\\("((?:[^"\\\\]|\\\\.)*)"\\)$/.exec(images[i]);
      if (m) {
        var file = picture(m[1]);
        if (file === undefined) return null;
        if (!file) { images[i] = "none"; continue; }
        images[i] = 'url("erga-file:' + c.files.length + '")';
        c.files.push(file); c.urls.push(m[1]);
      } else if (!/^(repeating-)?(linear|radial|conic)-gradient\\(/.test(images[i])) { images[i] = "none"; continue; }
      var size = sizes[i % sizes.length], whole = /^(cover|contain|100%( 100%| auto)?|auto( 100%| auto)?)$/.test(size) && !(m && /^auto( auto)?$/.test(size));
      if ((!whole || /^repeating-/.test(images[i])) && repeats[i % repeats.length] != "no-repeat") tile = true;
    }
    if (images.every(function (v) { return v == "none"; })) return c;
    var r = root.getBoundingClientRect(), fixed = /fixed/.test(cs.backgroundAttachment);
    c.image = images.join(", "); c.size = cs.backgroundSize; c.position = cs.backgroundPosition; c.repeat = cs.backgroundRepeat;
    c.tile = tile; c.fixed = fixed;
    c.x = fixed ? 0 : r.left + scrollX; c.y = fixed ? 0 : r.top + scrollY;
    c.w = fixed ? innerWidth : r.width; c.h = fixed ? innerHeight : r.height;
    return c;
  }
  var band = null, canvasSaid = "", STEP_MAX = 1000, said = "null", shape = "", rev = 0, polled = 0, listening = false;
  (function watch() {
    try {
      if (startY) place();
      var c = colour(), cv = c != null ? canvas() : null;
      if (cv) {
        var key = JSON.stringify(cv);
        delete cv.urls;
        if (key != canvasSaid) { canvasSaid = key; tell({ type: "erga-canvas", canvas: cv }); }
      }
      if (c != null && c !== band) { band = c; tell({ type: "erga-band", color: c }); }
      if (c != null) report();
      var now = Date.now();
      if (now - polled > 300) { polled = now; tellSteps(); }
    } catch (e) {}
    requestAnimationFrame(watch);
  })();
  // A presentation (editor-agent/PROMPT.md, "Presentations"): the page says it has steps (window.ergaSteps).
  function steps() {
    var p = window.ergaSteps;
    return p && typeof p.count == "function" && typeof p.go == "function" && typeof p.current == "function" ? p : null;
  }
  function whole(n, max) { n = Math.floor(Number(n)); return isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; }
  function tellSteps() {
    var p = steps(), m = null;
    if (p && !listening) {
      listening = true;
      addEventListener("ergastep", function () { tellSteps(); });
      addEventListener("keydown", function (e) {
        var t = e.target;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key != "ArrowLeft" && e.key != "ArrowRight")) return;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
        setTimeout(function () { if (!e.defaultPrevented) step({ by: e.key == "ArrowLeft" ? -1 : 1 }); });
      });
    }
    if (p) try {
      var count = whole(p.count(), STEP_MAX), labels = [];
      for (var i = 0; i < count; i++) {
        var l = typeof p.label == "function" ? p.label(i) : "";
        labels.push(typeof l == "string" ? l.replace(/\\s+/g, " ").trim().slice(0, 200) : "");
      }
      m = { count: count, current: whole(p.current(), Math.max(0, count - 1)), labels: labels, images: typeof p.image == "function" };
    } catch (e) { m = null; }
    var now = m ? m.count + "\\n" + m.labels.join("\\n") : "";
    if (now != shape) { shape = now; rev++; }
    if (m) m.rev = rev;
    var text = JSON.stringify(m);
    if (text != said) { said = text; tell({ type: "erga-steps", steps: m }); }
  }
  function step(to) {
    var p = steps();
    if (!p) return;
    try {
      var count = whole(p.count(), STEP_MAX), at = whole(p.current(), STEP_MAX);
      var n = to.by ? at + (to.by > 0 ? 1 : -1) : whole(to.to, STEP_MAX);
      if (n >= 0 && n < count && n != at) {
        if (to.by > 0 && typeof p.next == "function") p.next();
        else if (to.by < 0 && typeof p.back == "function") p.back();
        else p.go(n);
      }
    } catch (e) {}
    tellSteps();
  }
  function stepImage(m) {
    var p = steps(), at = rev, n = whole(m.step, STEP_MAX);
    if (!p || typeof p.image != "function" || m.rev !== at) return;
    var answer = function (blob) {
      var ok = blob && typeof blob.type == "string" && /^image\\//.test(blob.type) && blob.size < 4e6;
      tell({ type: "erga-step-image", step: n, rev: at, blob: ok ? blob : null });
    };
    var size = { width: whole(m.width, 1600) || 320, height: whole(m.height, 1600) || 180 };
    Promise.resolve().then(function () { return p.image(n, size); }).then(function (r) {
      if (!r) return null;
      if (typeof r == "string") return fetch(r).then(function (res) { return res.blob(); });
      if (typeof r.toBlob == "function") return new Promise(function (done) { r.toBlob(done, "image/png"); });
      if (typeof r.arrayBuffer == "function") return r;
      return null;
    }).then(answer, function () { answer(null); });
  }
  addEventListener("message", function (e) {
    if (e.source != P || e.origin != C.shell || !e.data) return;
    var type = e.data.type;
    if (type == "erga-step") step(e.data);
    else if (type == "erga-step-image") stepImage(e.data);
    else if (type == "erga-edit") load();
    else if (type == "erga-prefetch" && C.editor && !loading) {
      [C.editor.src].concat(C.editor.preload).forEach(function (href) { var l = document.createElement("link"); l.rel = "prefetch"; l.href = href; l.crossOrigin = "anonymous"; l.setAttribute("data-erga", ""); (document.head || root).append(l); });
    }
  });
})();`;

/**
 * The live log's watch (shared/live-page.ts), from its function's own text, with a stand-in for the helper a bundler that
 * keeps names puts in it (esbuild's __name), which the page hasn't got.
 */
const LIVE_WATCH = () => `(function(){var __name=function(f){return f};(${liveWatch.toString()})(${JSON.stringify({ events: true, net: true, types: EVENT_TYPES })})})();`;

/** A script element's text, as nothing in it can close the element. */
const inline = (js: string) => js.replace(/<\/script/gi, "<\\/script");

/**
 * A page of the document as its pages origin serves it: its marked HTML (shared/page.ts, markPage) with, first in its
 * <head>, this script; for whoever may edit, before it, the editor's half's integrity (an import map: the browser checks
 * each of its modules against it, and it must come before any module loads), and after it, the scripts the editor needs
 * from the page's first moment (its problems and its live log, the text guard, ergaEditor).
 */
export function readerPage(marked: string, o: { shell: string; prefix: string; src: string; editor: boolean }): string {
  const editor = o.editor ? frameScripts(o.shell) : undefined;
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const head = (editor ? `<script type="importmap" data-erga>${json({ imports: {}, integrity: editor.map })}</script>` : "")
    + `<script data-erga>${inline(readerScript({ shell: o.shell, prefix: o.prefix, src: o.src, ...(editor ? { editor } : {}) }))}</script>`
    + (editor ? `<script data-erga>${PROBLEM_WATCH}</script><script data-erga>${inline(LIVE_WATCH())}</script><script data-erga>${inline(TEXT_GUARD)}</script><script data-erga>${EDITING_API}</script>` : "");
  return insertHead(marked, head);
}

/** The version of what the pages origin puts in a page: this script's and the editor's build's (frame.js's address names it). */
export const readerVersion = () => versionOf(readerScript({ shell: "", prefix: "", src: "" }) + PROBLEM_WATCH + TEXT_GUARD + EDITING_API + LIVE_WATCH() + asset("frame.js"));

/** A digest of text (FNV-1a), which changes whenever it does. */
const versionOf = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
