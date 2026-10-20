// The viewer's half inside the document's own frame. The viewer (pages/viewer.ts) holds a document's page inline,
// in a frame of an opaque origin (srcdoc, sandboxed without allow-same-origin): its scripts reach nothing of
// erga.dev's, nor of any other document's, and the viewer can't reach into it either. So this script goes into the
// page first (before the page's own), and tells the viewer by postMessage what it needs: where the page is
// scrolled to and where the pointer is (the fade), its background (the band and the canvas around the frame), its
// steps (a presentation), and which of the document's pages it shows. It follows the viewer's asks (a step, a
// step's picture), and sends links that leave the document to the viewer, which opens them.
//
// The page's own files (its styles, scripts, images, other pages) come from the files address, /_f/<key>/
// (server/documents/files.ts): the srcdoc page has it as its <base>; a page the frame goes to is served from there
// with this script in it too.
//
// An opaque origin has no storage: localStorage, sessionStorage and document.cookie would throw. Here they're kept
// in memory, for as long as the page is open, so a page that uses them still runs.
//
// What it sends is the page's own word: the page's scripts can send the same (the viewer checks every message as
// coming from the page). It sends nothing secret, and to the frame's parent only.

/** What the frame of a page in the viewer may do: scripts, forms, dialogs and popups, and never its own origin (no allow-same-origin). */
export const READER_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

/** The script, as text: `config` is { page: the page's file, or null to read it from the frame's address; prefix: the files address's path }. */
export const readerScript = (config: { page: string | null; prefix: string }) => `(function () {
  var C = ${JSON.stringify(config).replace(/</g, "\\u003c")};
  // Storage that an opaque origin lacks: in memory, for this page's life.
  function memory() {
    var m = new Map();
    var s = {
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
      key: function (i) { var a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    };
    Object.defineProperty(s, "length", { get: function () { return m.size; } });
    return s;
  }
  for (var name of ["localStorage", "sessionStorage"]) {
    try { window[name].length; } catch (e) { try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e2) {} }
  }
  try { document.cookie; } catch (e) {
    var jar = {};
    try {
      Object.defineProperty(document, "cookie", { configurable: true,
        get: function () { return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; "); },
        set: function (v) { var kv = String(v).split(";")[0], i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } });
    } catch (e2) {}
  }
  if (parent == window) return;
  var P = parent;
  function tell(m) { try { P.postMessage(m, "*"); } catch (e) {} }
  // Which of the document's pages this is ("" for its own page).
  var page = C.page;
  if (page == null) {
    var p = location.pathname;
    page = p.indexOf(C.prefix) == 0 ? p.slice(C.prefix.length) : "";
    try { page = decodeURIComponent(page); } catch (e) {}
  }
  if (!page || /\\.html$/i.test(page)) tell({ type: "erga-nav", path: page || "" });
  // The page stops dead at its top and bottom.
  var still = document.createElement("style");
  still.textContent = "html { overscroll-behavior: none; }";
  (document.head || document.documentElement).append(still);
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
  // Links. Within this page (#part): scrolled to here (a srcdoc page's links resolve against its base). To another of
  // the document's pages: in this frame, as the link says. Out of the document: a new tab, unless the link names its
  // own target; "_self" takes the whole tab. The viewer opens both, on the reader's click.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button != 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) == "#") {
      e.preventDefault();
      var id = decodeURIComponent(href.slice(1)), el = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
      if (el) el.scrollIntoView(); else if (!id) scrollTo(0, 0);
      return;
    }
    if (!/^https?:$/.test(a.protocol)) return;
    var mine = a.pathname.indexOf(C.prefix) == 0 && a.origin == new URL(C.prefix, document.baseURI).origin;
    var t = (a.getAttribute("target") || "").toLowerCase();
    if (mine && (!t || t == "_self")) return;
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
  function ready() { return !!document.documentElement && (!!document.body || document.readyState != "loading"); }
  function colour() {
    if (!ready()) return null;
    var c = solid(getComputedStyle(document.documentElement));
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
    var root = document.documentElement;
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
    c.tile = tile; c.fixed = fixed; c.zoom = 1;
    c.x = fixed ? 0 : r.left + scrollX; c.y = fixed ? 0 : r.top + scrollY;
    c.w = fixed ? innerWidth : r.width; c.h = fixed ? innerHeight : r.height;
    return c;
  }
  var band = null, canvasSaid = "", STEP_MAX = 1000, said = "null", shape = "", rev = 0, polled = 0, listening = false;
  (function watch() {
    try {
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
    if (e.source != P || !e.data) return;
    if (e.data.type == "erga-step") step(e.data);
    else if (e.data.type == "erga-step-image") stepImage(e.data);
  });
})();`;

/**
 * A page of the document as the viewer's frame holds it: this script first (after the doctype, so the page keeps its
 * mode), and for a srcdoc page the files address as its <base>, so its relative addresses are its files'.
 */
export function readerPage(html: string, o: { base?: string; page: string | null; prefix: string }): string {
  const head = `${o.base ? `<base href="${o.base.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` : ""}<script>${readerScript({ page: o.page, prefix: o.prefix }).replace(/<\/script/gi, "<\\/script")}</script>`;
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + head + html.slice(doctype[0].length) : head + html;
}
