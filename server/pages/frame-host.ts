// The frame's host page on a document's pages origin: a page that holds the document's
// own page in an iframe and serves its files from the token's view of them. Served by
// documents/pages-origin.ts; versioned by its own text (HOST_VERSION), so a change here
// reaches every open viewer.


export const HOST_STYLE = "html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;background:transparent}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent;visibility:hidden}iframe.on{visibility:visible}html.wait iframe,html.placing iframe{visibility:hidden}";

/** The frame's host page's version: a digest of its code (FNV-1a), which changes whenever that does. */
const versionOf = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

/**
 * What a document's page may do in its frame, in the viewer and the editor alike (frame.ts makes the editor's the same).
 *
 * allow-same-origin stays, with allow-scripts: the page keeps its pages origin, which holds nothing but this one
 * document, and this host page (and the page editor, frame.ts) reach into it there (its scroll, its colours, its
 * steps; typing and carets). So the page's script can remove its own sandbox and act as this host page: Chrome warns
 * about that, rightly, and it changes nothing. The boundary is the origin: the page can't reach erga.dev, its cookies
 * or another document's origin, and the shell (client/remote.ts, viewer.ts) treats every message from here as the
 * page's own. Without allow-same-origin the page would lose its own storage and the editor couldn't edit it.
 */
export const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

/**
 * What a document's page as it renders (#view) may do beyond its sandbox: nothing. It's what a viewer's frame gets.
 */
export const PAGE_ALLOW = "autoplay 'none'; fullscreen 'none'";

/**
 * What an editor's frame may pass on to the editable page (client/frame.ts): autoplay, for the agent's page_click
 * (it gives no activation of its own, so the page's media plays on the tab's). Never full screen.
 */
export const EDITOR_ALLOW = "autoplay";

/** Where the frame's host page shows the page as it renders from: what viewers see, which the document serves at pub/. */
export const VIEW_FILES = "pub";

/**
 * The frame's host page, on the document's own origin: it shows the page as
 * it renders (#view) until the document's page asks for the editor
 * ("erga-edit"). Then it loads the editor's half, which renders
 * the editable page in a frame of its own (#page) and calls ergaHost.ready;
 * the editable page takes the plain one's place, scrolled to the same spot.
 * Back to viewing ("erga-view"), the plain page loads afresh behind it and
 * takes its place again the same way, the editor carrying on unseen.
 */
export const HOST_SCRIPT = `(function () {
  var SHELL = document.querySelector('meta[name="erga-shell"]').content, want = "view", loading = false;
  var view = document.getElementById("view"), src = view ? view.getAttribute("src") : "";
  var page = function () { return document.getElementById("page"); };
  // The page stops dead at its top and bottom, without the bounce that would show what's behind it (and pass on to the controls).
  function still(f) {
    try { var d = f.contentDocument, s = d.createElement("style"); s.textContent = "html { overscroll-behavior: none; }"; (d.head || d.documentElement).append(s); } catch (e) {}
  }
  // The page went to another of the document's pages (a link followed): the shell's address follows, and so
  // does the page shown again on the way back from editing.
  var DOC = location.pathname.replace(/\\/?$/, "/") + "${VIEW_FILES}/";
  function moved(f) {
    try {
      var p = f.contentWindow.location.pathname;
      if (p.indexOf(DOC) != 0) return;
      // pub/ itself is the document's own page ("").
      var path = decodeURIComponent(p.slice(DOC.length));
      if (path && !/\\.html$/i.test(path)) return;
      src = p;
      parent.postMessage({ type: "erga-nav", path: path }, SHELL);
    } catch (e) {}
  }
  // The shell's controls fade once the page is scrolled (FADE): it hears where the page shown is scrolled to, and where the
  // pointer is over it (in this page's coordinates; the shell places them), at most once a frame.
  // (Exactly too, sx and sy, for the canvas the shell paints around the frame: see canvasOf.)
  var scrolled = null, pointer = null;
  // The scale the editor draws the page at (client/zoom.ts: the page zoomed, not the controls): its points, in this page's terms.
  function scale(f) { var w = f.offsetWidth; return w ? f.getBoundingClientRect().width / w || 1 : 1; }
  function report(f) {
    try {
      if (!f.classList.contains("on")) return;
      var w = f.contentWindow, y = Math.max(0, Math.round(w.scrollY)), at = w.scrollX + "," + w.scrollY;
      if (at !== scrolled) { scrolled = at; parent.postMessage({ type: "erga-scroll", y: y, sx: w.scrollX, sy: w.scrollY }, SHELL); }
    } catch (e) {}
  }
  function follow(f) {
    try {
      var d = f.contentDocument, w = f.contentWindow;
      if (!d || d.ergaFollowed) return;
      d.ergaFollowed = true;
      w.addEventListener("scroll", function () { report(f); }, { passive: true });
      d.addEventListener("pointermove", function (e) {
        if (e.pointerType != "mouse" || !f.classList.contains("on")) return;
        if (!pointer) requestAnimationFrame(function () { parent.postMessage({ type: "erga-pointer", x: pointer.x, y: pointer.y }, SHELL); pointer = null; });
        var k = scale(f);
        pointer = { x: e.clientX * k, y: e.clientY * k };
      }, { capture: true, passive: true });
      // A reader's click on a link that leaves the document opens a new tab, unless the link names its own target. One its
      // author set to open in this tab (target="_self") takes the whole tab (the shell does it: viewer.ts), not this frame.
      // Only in the page as it renders (#view): the editor's page (#page) follows no link.
      d.addEventListener("click", function (e) {
        if (f.id != "view" || e.defaultPrevented || e.button != 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a || a.hasAttribute("download") || !/^https?:$/.test(a.protocol)) return;
        if (a.origin == location.origin && a.pathname.indexOf(DOC) == 0) return;
        var t = (a.getAttribute("target") || "").toLowerCase();
        if (!t) { a.target = "_blank"; if (!a.rel) a.rel = "noopener"; }
        else if (t == "_self") { e.preventDefault(); parent.postMessage({ type: "erga-go", url: a.href }, SHELL); }
      });
      d.addEventListener("pointerdown", function (e) {
        if (e.pointerType != "mouse" && f.classList.contains("on")) parent.postMessage({ type: "erga-pointer", x: e.clientX * scale(f), y: e.clientY * scale(f), tap: true }, SHELL);
      }, { capture: true, passive: true });
      report(f);
    } catch (e) {}
  }
  if (view) view.addEventListener("load", function () { view.ergaLoaded = true; still(view); moved(view); follow(view); });
  // Reloaded in the editor (&y=, FRAME_SRC): the page shown opens where it was scrolled to, out of sight until it's there
  // (its content may still be coming), or as far as it goes once it has loaded (a shorter page now), or after a moment.
  var startY = Number((/[?&]y=(\\d+)/.exec(location.search) || [])[1]) || 0;
  function placed() { startY = 0; document.documentElement.classList.remove("placing"); }
  function place(f) {
    try {
      var w = f.contentWindow, d = f.contentDocument;
      if (!d || !d.documentElement || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return;
      w.scrollTo(0, startY);
      if (Math.abs(w.scrollY - startY) < 2 || (f.ergaLoaded && w.scrollY + w.innerHeight >= d.documentElement.scrollHeight - 2)) placed();
    } catch (e) { placed(); }
  }
  if (startY) { document.documentElement.classList.add("placing"); setTimeout(placed, 1500); }
  // The band above the page (the document's page, viewDocument) takes the page's background: this tells the shell what it is,
  // on every frame it changes (a page of a multi-page document, a theme switch), as a solid colour (a gradient's first one).
  // The first time this page sees the document (nothing remembered here), the page waits out of sight until the shell has
  // painted that colour, so a dark page never shows under a white band; later, the shell remembers it too, so it shows at once.
  var band = null, known = null;
  try { known = localStorage.getItem("erga:band"); } catch (e) {}
  function reveal() { document.documentElement.classList.remove("wait"); }
  if (known == null) { document.documentElement.classList.add("wait"); setTimeout(reveal, 500); }
  // (Its own colour; else, for one that's only a gradient, the gradient's colour at the top.)
  function solid(cs) {
    var c = cs.backgroundColor;
    if (!clear(c)) return c;
    var img = cs.backgroundImage, stops = img && img != "none" && /gradient/.test(img) ? img.match(/rgba?\\([^)]*\\)/g) : null;
    if (stops) return /^linear-gradient\\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0];
    return "";
  }
  function colourOf(f) {
    var d = f.contentDocument, w = f.contentWindow;
    if (!d || !w || !d.documentElement || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return null;
    var c = solid(w.getComputedStyle(d.documentElement));
    if (!c && d.body) c = solid(w.getComputedStyle(d.body));
    return c;
  }
  // The page's canvas, so the shell paints the room around the frame (the band above it, the room beside it that the agent
  // opens) as the page would if it reached there (BAND_BOOT, paintCanvas): the background the browser gives the canvas (the
  // root's, or the body's when the root has none), its layers sized and placed against the root's box as the browser does,
  // in the page's own coordinates (the shell follows its scroll: erga-scroll). Gradients and images only: an image goes as
  // its file, once fetched here (the shell mustn't fetch the page's addresses as you); one that can't be is left out.
  // "tile": a layer repeats in tiles smaller than the page (a pattern), which carry on around it; else the page's edges do.
  var canvasSaid = "", pictures = {};
  function clear(c) { return /^(transparent|rgba\\([^)]*,\\s*0\\))$/.test(c); }
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
  /** An image's file: undefined while it's being fetched, null if it can't be. */
  function picture(u) {
    if (u in pictures) return pictures[u];
    pictures[u] = undefined;
    fetch(u).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      pictures[u] = b && /^image\\//.test(b.type) && b.size < 4e6 ? b : null;
    }, function () { pictures[u] = null; });
    return undefined;
  }
  function canvasOf(f) {
    var d = f.contentDocument, w = f.contentWindow, root = d && d.documentElement;
    if (!root || !w || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return null;
    var cs = w.getComputedStyle(root);
    if (cs.backgroundImage == "none" && clear(cs.backgroundColor) && d.body) cs = w.getComputedStyle(d.body);
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
    // (In the page's own terms, the frame's box too; the shell draws them at the page's scale, c.zoom.)
    var b = f.getBoundingClientRect(), k = scale(f), fr = { left: b.left / k, top: b.top / k, width: b.width / k, height: b.height / k };
    var r = root.getBoundingClientRect(), fixed = /fixed/.test(cs.backgroundAttachment);
    c.image = images.join(", "); c.size = cs.backgroundSize; c.position = cs.backgroundPosition; c.repeat = cs.backgroundRepeat;
    c.tile = tile; c.fixed = fixed; c.zoom = k;
    c.x = fixed ? fr.left : fr.left + r.left + w.scrollX; c.y = fixed ? fr.top : fr.top + r.top + w.scrollY;
    c.w = fixed ? fr.width : r.width; c.h = fixed ? fr.height : r.height;
    return c;
  }
  // A new page in a colour of its own (a link to another of the document's pages) waits out of sight in the same way, so
  // it never shows under the last page's band; a page that changes its own colour (a theme switch) stays in sight.
  var shown = null;
  (function watch() {
    try {
      var f = document.querySelector("iframe.on"), c = f ? colourOf(f) : null;
      if (f && startY) place(f);
      // The fade's too (above), from as soon as the page shown has a document (well before its load event, on a page with
      // large images), and again after it goes to another of the document's pages.
      if (f) follow(f);
      // (The canvas first: the shell has painted both once it answers the colour, erga-band-ok.)
      var cv = f && c != null ? canvasOf(f) : null;
      if (cv) {
        var key = JSON.stringify(cv);
        delete cv.urls;
        if (key != canvasSaid) { canvasSaid = key; parent.postMessage({ type: "erga-canvas", canvas: cv }, SHELL); }
      }
      if (c != null && c !== band) {
        if (band != null && shown && f.contentDocument != shown) { document.documentElement.classList.add("wait"); setTimeout(reveal, 300); }
        band = c;
        try { localStorage.setItem("erga:band", c); } catch (e) {}
        parent.postMessage({ type: "erga-band", color: c }, SHELL);
      }
      if (c != null) shown = f.contentDocument;
      // The steps, a few times a second besides when the page says (ergastep), for a page that forgets to.
      var now = Date.now();
      if (stepping && now - stepping.polled > 300) { stepping.polled = now; tellSteps(); }
    } catch (e) {}
    requestAnimationFrame(watch);
  })();
  function show(to) {
    var from = document.querySelector("iframe.on");
    if (from == to) return;
    try { if (from) to.contentWindow.scrollTo(from.contentWindow.scrollX, from.contentWindow.scrollY); } catch (e) {}
    to.classList.add("on");
    report(to);
    tellSteps();
    if (!from) return;
    from.classList.remove("on");
    if (from.id == "view") from.remove();
  }
  window.ergaHost = { ready: function () { if (want == "edit") show(page()); } };
  // A presentation (editor-agent/PROMPT.md, "Presentations"): the page shown says it has steps (window.ergaSteps). This tells
  // the shell how many, their labels and the current one (STEPS_BOOT shows them) whenever that changes, goes to a step or
  // draws one when the shell asks, and steps with the arrow keys pressed in the page. "rev" changes whenever a step's
  // picture may have changed: another page shown, the document edited (ergaHost.changed, frame.ts), different steps.
  var STEP_MAX = 1000, stepping = { doc: null, said: "null", shape: "", rev: 0, polled: 0 };
  function presentation() {
    var f = document.querySelector("iframe.on");
    try {
      var w = f && f.contentWindow, p = w && w.ergaSteps;
      return p && typeof p.count == "function" && typeof p.go == "function" && typeof p.current == "function" ? { w: w, d: w.document, p: p } : null;
    } catch (e) { return null; }
  }
  function whole(n, max) { n = Math.floor(Number(n)); return isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; }
  function stepsKey(e) {
    var t = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key != "ArrowLeft" && e.key != "ArrowRight")) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    // Once the page's own handlers have had it: a page that takes the key itself (preventDefault) keeps it.
    setTimeout(function () { if (!e.defaultPrevented) step({ by: e.key == "ArrowLeft" ? -1 : 1 }); });
  }
  function tellSteps() {
    var s = presentation(), m = null;
    // A page loaded afresh (another page, or the editor's render) is another window behind the same frame: listened to anew.
    if (s && s.d !== stepping.doc) {
      stepping.doc = s.d; stepping.rev++;
      s.w.addEventListener("ergastep", function () { tellSteps(); });
      s.w.addEventListener("keydown", stepsKey);
    }
    if (s) try {
      var count = whole(s.p.count(), STEP_MAX), labels = [];
      for (var i = 0; i < count; i++) {
        var l = typeof s.p.label == "function" ? s.p.label(i) : "";
        labels.push(typeof l == "string" ? l.replace(/\\s+/g, " ").trim().slice(0, 200) : "");
      }
      m = { count: count, current: whole(s.p.current(), Math.max(0, count - 1)), labels: labels, images: typeof s.p.image == "function" };
    } catch (e) { m = null; }
    var shape = m ? m.count + "\\n" + m.labels.join("\\n") : "";
    if (shape != stepping.shape) { stepping.shape = shape; stepping.rev++; }
    if (m) m.rev = stepping.rev;
    var said = JSON.stringify(m);
    if (said != stepping.said) { stepping.said = said; parent.postMessage({ type: "erga-steps", steps: m }, SHELL); }
  }
  function step(to) {
    var s = presentation();
    if (!s) return;
    try {
      var count = whole(s.p.count(), STEP_MAX), at = whole(s.p.current(), STEP_MAX);
      var n = to.by ? at + (to.by > 0 ? 1 : -1) : whole(to.to, STEP_MAX);
      if (n >= 0 && n < count && n != at) {
        if (to.by > 0 && typeof s.p.next == "function") s.p.next();
        else if (to.by < 0 && typeof s.p.back == "function") s.p.back();
        else s.p.go(n);
      }
    } catch (e) {}
    tellSteps();
  }
  // A step's picture, as a Blob (the shell makes its own address for it): the page answers a canvas, a Blob or an image's address.
  function stepImage(m) {
    var s = presentation(), rev = stepping.rev, n = whole(m.step, STEP_MAX);
    if (!s || typeof s.p.image != "function" || m.rev !== rev) return;
    var answer = function (blob) {
      var ok = blob && typeof blob.type == "string" && /^image\\//.test(blob.type) && blob.size < 4e6;
      parent.postMessage({ type: "erga-step-image", step: n, rev: rev, blob: ok ? blob : null }, SHELL);
    };
    var size = { width: whole(m.width, 1600) || 320, height: whole(m.height, 1600) || 180 };
    Promise.resolve().then(function () { return s.p.image(n, size); }).then(function (r) {
      if (!r) return null;
      if (typeof r == "string") return fetch(r).then(function (res) { return res.blob(); });
      if (typeof r.toBlob == "function") return new Promise(function (done) { r.toBlob(done, "image/png"); });
      if (typeof r.arrayBuffer == "function") return r;
      return null;
    }).then(answer, function () { answer(null); });
  }
  window.ergaHost.changed = function () { stepping.rev++; stepping.said = ""; tellSteps(); };
  addEventListener("message", function (e) {
    if (e.source != parent || e.origin != SHELL || !e.data) return;
    var type = e.data.type;
    if (type == "erga-band-ok") reveal();
    else if (type == "erga-edit") {
      want = "edit";
      if (!loading) { loading = true; var s = document.createElement("script"); s.src = "/frame.js"; document.body.append(s); }
      else if (page() && page().dataset.ready) show(page());
    } else if (type == "erga-view" && src) {
      want = "view";
      if (!page()) return;
      var old = document.getElementById("view");
      if (old) old.remove();
      var v = document.createElement("iframe");
      v.id = "view"; v.title = "Document"; v.setAttribute("sandbox", "${PAGE_SANDBOX}"); v.setAttribute("allow", "${PAGE_ALLOW}");
      v.onload = function () { still(v); moved(v); follow(v); if (want == "view") show(v); };
      v.src = src;
      document.body.prepend(v);
    } else if (type == "erga-step") step(e.data);
    else if (type == "erga-step-image") stepImage(e.data);
    else if (type == "erga-prefetch") {
      var l = document.createElement("link"); l.rel = "prefetch"; l.href = "/frame.js"; document.head.append(l);
    }
  });
  // Opened in the editor (?edit=1): its half starts loading now, without waiting to be asked.
  if (/[?&]edit=1(&|$)/.test(location.search)) { want = "edit"; loading = true; var s = document.createElement("script"); s.src = "/frame.js"; document.body.append(s); }
  parent.postMessage({ type: "erga-host" }, SHELL);
})();`;

export const HOST_VERSION = versionOf(HOST_STYLE + PAGE_SANDBOX + PAGE_ALLOW + HOST_SCRIPT + VIEW_FILES);
