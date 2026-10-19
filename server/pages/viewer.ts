// The viewer's scripts and styles (documents/view.ts puts them on the page): the band
// above the document, the editor's boot, the steps, the fade, the buttons.

import { FAVICON_LINK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { crumbsFont, esc, link, viewCrumbs } from "./chrome.ts";
import { EDITOR_ALLOW, HOST_VERSION, PAGE_ALLOW, PAGE_SANDBOX } from "./frame-host.ts";
import { NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu } from "./templates.ts";

/** The viewer's Clone button (a copy of your own, at `href`): also the homepage's. */
export const cloneButton = (href: string) => `<a href="${esc(href)}" class="erga-view-button erga-clone-button" aria-label="Clone: make your own copy" data-tip="Clone"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0345) translate(-12 -13.25)" stroke-width="1.5467"><g transform="translate(0 1.25)"><rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2"/><path d="M15.25 8.75V6.5a1.75 1.75 0 0 0-1.75-1.75H6.5A1.75 1.75 0 0 0 4.75 6.5v7c0 .97.78 1.75 1.75 1.75h2.25"/></g></g></svg></a>`;

/** The viewer's pencil (Edit, the editor at `href`), blue while editing: also the homepage's. */
export const editButton = (href: string, editing: boolean) => `<a href="${esc(href)}" class="erga-view-button erga-edit-button" aria-label="Edit" aria-pressed="${editing}" data-tip="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0512) translate(-11.885 -13.365)" stroke-width="1.5221"><g transform="translate(0 1.25)"><path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/></g></g></svg></a>`;

/**
 * For whoever may edit, at the top of a document's page: opened with #edit, it
 * fetches the editor's files at once. (The page's background, remembered
 * from last time, is BAND_HEAD's.)
 *
 * Reloaded in the editor (by hand, or for a new release), the page opens as
 * the editor was, from its first frame, rather than as the viewer until the
 * editor's code has come: its layout (the agent's pane open or not, the
 * document beside it: what the editor kept, main.ts's "shell", restore.ts)
 * and its controls, from the copy of the editor's page this tab keeps
 * (EDIT_BOOT, erga:editor-html), its stylesheets holding the first frame
 * until they're in. The controls wait, inert, for the editor's code
 * (erga-restored; if that never comes, the viewer's controls come back),
 * and the document opens where it was scrolled to (FRAME_SRC). Only for
 * the window's same size, and at the same address.
 */
/** Where a tab keeps its copy of the editor's page (EDIT_BOOT), for a reload in the editor to open with (EDITING_HEAD). */
export const EDITOR_COPY = "erga:editor-html";

/** What a page kept for its reload (client/restore.ts, RESTORE_KEY: the same, which tests/restore-key.test.ts checks). */
export const RESTORE_KEY = "erga:live:restore";

export const EDITING_HEAD = `if (location.hash == "#edit") {
  for (const [href, as] of [["/editor.html", "fetch"], ["/page.js", "script"], ["/style.css", "style"], ["/fonts/inter.css", "style"]]) {
    const l = Object.assign(document.createElement("link"), { rel: "preload", href, as });
    if (as == "fetch") l.crossOrigin = "anonymous";
    document.head.append(l);
  }
  try {
    const s = JSON.parse(sessionStorage.getItem("${RESTORE_KEY}") || "null"), me = performance.timeOrigin;
    const shell = s?.keep?.shell, html = sessionStorage.getItem("${EDITOR_COPY}"), root = document.documentElement;
    if (shell && html && s.url == location.pathname + location.search && (s.used == null || s.used == me) && s.at <= me + 1000 && me - s.at < 60000
      && (!s.hand || performance.getEntriesByType("navigation")[0]?.type == "reload") && shell.width == innerWidth && shell.height == innerHeight) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      window.ergaRestored = { html, doc, body: shell.body, parts: shell.parts, editor: s.keep.editor };
      root.dataset.theme = "light";
      root.style.cssText += ";" + shell.style;
      root.classList.add(...shell.html);
      // Written into the page as it parses, in their order, so the first frame waits for them as for its own.
      document.write([...doc.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => { el.dataset.ergaRestored = ""; return el.outerHTML; }).join(""));
    }
  } catch (e) {}
}`;

/** ... and as its body starts: editing, from the first frame; reloaded in the editor, with its controls (EDITING_HEAD). */
export const EDITING_BODY = `if (location.hash == "#edit") {
  document.body.classList.add("erga-editing");
  const r = window.ergaRestored;
  if (r) {
    document.body.classList.add(...r.body, "erga-restored", "erga-editor-ready", "no-motion");
    const wrap = Object.assign(document.createElement("div"), { id: "erga-editor", inert: true });
    for (const el of r.doc.body.children) if (el.id != "frame" && el.tagName != "SCRIPT") wrap.append(document.importNode(el, true));
    for (const [id, html] of Object.entries(r.parts || {})) {
      const t = document.createElement("template");
      t.innerHTML = html;
      const was = wrap.querySelector("#" + CSS.escape(id)), now = t.content.firstElementChild;
      if (was && now?.id == id) was.replaceWith(now);
    }
    document.body.append(wrap);
  }
}`;

/**
 * The frame, for whoever may edit: opened with #edit, its host page starts on its half of the editor at once (pagesDoor);
 * reloaded in the editor, scrolled where it was (&y=, HOST_SCRIPT).
 */
export const FRAME_SRC = `{
  const f = document.getElementById("frame"), kept = window.ergaRestored?.editor, y = kept?.mode == "text" ? Math.round(kept.scroll) : 0;
  f.src = f.dataset.src + (location.hash == "#edit" ? "&edit=1" + (y > 0 ? "&y=" + y : "") : "");
}`;

/**
 * Which of the document's pages is shown, for everyone on a document's page
 * (viewDocument): the frame says when the page in it goes to another of the
 * document's pages (a link followed: HOST_SCRIPT), and the address bar
 * follows, without a reload: /<owner>/<slug>/<page>, #edit kept
 * while editing. `ergaPageAddress()` is the page's address now.
 */
export const NAV_SCRIPT = `(() => {
  const frame = document.getElementById("frame");
  const pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const meta = (name) => document.querySelector('meta[name="' + name + '"]');
  const suffix = (file) => {
    let s = file.replace(/\\.html$/i, "");
    s = s == "index" ? "" : s.replace(/\\/index$/, "");
    return s ? "/" + s.split("/").map(encodeURIComponent).join("/") : "";
  };
  window.ergaPageAddress = () => meta("erga-address").content + (meta("erga-page") ? suffix(meta("erga-page").content) : "");
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages || e.data?.type != "erga-nav") return;
    // A page's path in the document; "" for the document's own.
    const path = e.data.path;
    if (typeof path != "string" || (path && !/\\.html$/i.test(path)) || path.length > 1000 || (path && path.split("/").some((p) => !p || p == ".." || p.startsWith(".")))) return;
    let m = meta("erga-page");
    if (!m) { m = document.head.appendChild(document.createElement("meta")); m.name = "erga-page"; m.content = ""; }
    if (m.content == path || (!path && !suffix(m.content))) return;
    m.content = path;
    // Viewing at the front page's address (/), its first page stays there.
    if (location.pathname == "/" && !suffix(path)) return;
    const here = ergaPageAddress();
    if (location.pathname != here) history.replaceState(history.state, "", here + location.search + location.hash);
    document.querySelector(".erga-view-buttons a[aria-pressed]")?.setAttribute("href", here + location.search + "#edit");
  });
  // A link its author set to open in this tab (target="_self", frame-host.ts) that leaves the document: the whole
  // tab goes there, on the reader's click only.
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages || e.data?.type != "erga-go") return;
    const url = String(e.data.url ?? "");
    if (!/^https?:\\/\\//i.test(url) || url.length > 4000 || navigator.userActivation?.isActive === false) return;
    location.assign(url);
  });
})();`;

/**
 * The band at the top of a document's page (viewDocument), where the
 * controls are: the document's frame starts below it, so they never cover
 * the document, and it takes the document's own background, so it reads as
 * part of the page: its colour, and over that its gradient or image
 * (.erga-canvas, which has the frame's box; BAND_BOOT paints it). --band-h is the controls' row
 * (34px, at max(12px, the notch)) and a 10px gap; the editor's client/editor.html
 * keeps the frame there too. Until the frame says (BAND_BOOT), the colour
 * is the one this document had last time on this browser, and the
 * controls' tone (light or dark text) with it.
 */
export const BAND_STYLE = `:root { --band-h: calc(max(12px, env(safe-area-inset-top)) + 44px); }
html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; }
html { background: var(--page-bg, var(--band, #fff)); }
#frame { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); border: 0; display: block; background: transparent; }
.erga-canvas { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); pointer-events: none; }
.erga-canvas > div { position: absolute; left: 0; top: 0; }
.erga-canvas :is(i, b) { position: absolute; display: block; }
.erga-canvas b { overflow: hidden; }
.erga-canvas i { box-sizing: content-box; background-origin: content-box; }`;

/** Sets the band's colour (ergaBand(id, colour)), or the one remembered for document `id` (ergaBand(id)); and the controls' tone to suit. Answers the tone. */
export const BAND_HEAD = `window.ergaBand = function (id, color) {
  var key = "erga:band:v1:" + id, root = document.documentElement, tone = "";
  try {
    if (color === undefined) { var b = JSON.parse(localStorage.getItem(key) || "null"); color = b && typeof b.bg == "string" ? b.bg : ""; }
  } catch (e) { color = ""; }
  if (color && !(window.CSS && CSS.supports("color", color))) color = "";
  var rgb = color.match(/[\\d.]+/g);
  if (color && /^rgba?\\(/.test(color) && rgb && rgb.length >= 3) tone = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45 ? "page-dark" : "page-light";
  if (color) root.style.setProperty("--band", color); else root.style.removeProperty("--band");
  root.classList.toggle("page-dark", tone == "page-dark");
  root.classList.toggle("page-light", tone == "page-light");
  if (arguments.length > 1) try { localStorage.setItem(key, JSON.stringify({ bg: color, tone: tone })); } catch (e) {}
  return tone;
};`;

/** The band's colour, as the frame's host page tells it (pagesDoor, HOST_SCRIPT); answered once painted, so a first visit's page shows only under its own colour. */
export const BAND_BOOT = `(() => {
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const id = document.querySelector('meta[name="erga-doc"]').content;
  // The page's canvas (HOST_SCRIPT, canvasOf), behind the frame, reaching out from it over the band and the room beside
  // the page, and scrolled with the page. Its layers are placed against the page's root box (the <i>'s content box), as
  // the browser places the canvas's. A pattern ("tile") carries on in its tiles all round; anything else (a gradient
  // across the page) carries on as the page's edges: the edge's row or column of pixels (a <b> that shows only that line),
  // stretched out (scaled) over the band and the room beside. Below, it repeats, as the page itself does there. Until the
  // frame says, the canvas this document had last time on this browser, if it was gradients only.
  const room = document.querySelector(".erga-canvas"), sheet = room.firstElementChild, KEY = "erga:canvas:v1:" + id, FAR = 4000;
  let canvas = null, urls = [], sx = 0, sy = 0;
  const px = (n) => (Number.isFinite(n) ? n : 0) + "px";
  // (At the page's scale, when the editor zooms it: client/zoom.ts.)
  function scrolled() {
    const k = canvas ? canvas.zoom : 1, at = canvas && !canvas.fixed ? \`translate(\${px(-sx * k)}, \${px(-sy * k)})\` : "";
    sheet.style.transformOrigin = "0 0";
    sheet.style.transform = k == 1 ? at : \`\${at} scale(\${k})\`;
  }
  function paintCanvas(c, files) {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    sheet.replaceChildren();
    canvas = null;
    if (!c || typeof c.image != "string" || !c.image) return scrolled();
    let image = c.image;
    // Its images: the files sent (erga-file:n), each at an address of this page's own; nothing else.
    // (Gradients and colours only besides: no escapes, which could spell url( another way, and no other function.)
    const rest = image.replace(/url\\("erga-file:\\d+"\\)/g, "");
    if (/[\\\\]/.test(rest) || (rest.match(/[\\w-]+(?=\\()/g) || []).some((f) => !/^(repeating-)?(linear|radial|conic)-gradient$|^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|calc)$/i.test(f)) || /\\(/.test(rest.replace(/[\\w-]+\\(/g, ""))) return scrolled();
    image = image.replace(/url\\("erga-file:(\\d+)"\\)/g, (_, n) => {
      const f = files?.[n];
      if (!(f instanceof Blob) || !/^image\\//.test(f.type)) return "none";
      const u = URL.createObjectURL(f);
      urls.push(u);
      return \`url("\${u}")\`;
    });
    const look = { backgroundColor: c.color, backgroundImage: image, backgroundSize: c.size, backgroundPosition: c.position, backgroundRepeat: c.repeat };
    const ok = { backgroundColor: "color", backgroundImage: "background-image", backgroundSize: "background-size", backgroundPosition: "background-position", backgroundRepeat: "background-repeat" };
    for (const k in look) if (typeof look[k] != "string" || (look[k] && !CSS.supports(ok[k], look[k]))) look[k] = "";
    if (!look.backgroundImage) return scrolled();
    const x = Number(c.x), y = Number(c.y), w = Math.max(1, Number(c.w) || 0), h = Math.max(1, Number(c.h) || 0);
    const sheetOf = (at, l, t, extra) => {
      const i = document.createElement("i");
      Object.assign(i.style, look, { left: px(l), top: px(t), width: px(w), height: px(h) }, extra);
      at.append(i);
      return i;
    };
    if (c.tile) sheetOf(sheet, x, y, { padding: px(FAR), margin: px(-FAR) });
    else {
      sheetOf(sheet, x, y, { paddingBottom: px(FAR) });
      // Each edge: [left, top, width, height] of the line it shows, where the page is drawn in it, and which way it stretches.
      for (const [l, t, bw, bh, dx, origin, scale] of [
        [x, y - 1, w, 1, 0, "50% 100%", \`scaleY(\${FAR})\`],
        [x - 1, y, 1, h, 0, "100% 50%", \`scaleX(\${FAR})\`],
        [x + w, y, 1, h, 1 - w, "0 50%", \`scaleX(\${FAR})\`],
        [x - 1, y - 1, 1, 1, 0, "100% 100%", \`scale(\${FAR})\`],
        [x + w, y - 1, 1, 1, 1 - w, "0 100%", \`scale(\${FAR})\`],
      ]) {
        const b = document.createElement("b");
        Object.assign(b.style, { left: px(l), top: px(t), width: px(bw), height: px(bh), transformOrigin: origin, transform: scale });
        sheetOf(b, dx, 0);
        sheet.append(b);
      }
    }
    const zoom = Number(c.zoom);
    canvas = { fixed: !!c.fixed, zoom: zoom >= 0.25 && zoom <= 5 ? zoom : 1 };
    scrolled();
  }
  try { const kept = JSON.parse(localStorage.getItem(KEY) || "null"); if (kept) paintCanvas(kept, []); } catch (e) {}
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages) return;
    if (e.data?.type == "erga-scroll") { sx = Number(e.data.sx) || 0; sy = Number(e.data.sy) || 0; return scrolled(); }
    if (e.data?.type == "erga-canvas") {
      const c = e.data.canvas;
      paintCanvas(c, c?.files);
      try { if (c && !c.files?.length) localStorage.setItem(KEY, JSON.stringify({ ...c, files: [] })); else localStorage.removeItem(KEY); } catch (e) {}
      return;
    }
    if (e.data?.type != "erga-band") return;
    const c = e.data.color;
    if (typeof c != "string" || c.length > 200 || /url\\(/i.test(c)) return;
    window.ergaBand(id, c);
    requestAnimationFrame(() => frame.contentWindow.postMessage({ type: "erga-band-ok" }, pages));
  });
})();`;

/**
 * Going into the editor and back, on a document's page (viewDocument), for
 * those who may: the pencil, the editor's eye, the browser's back and
 * forward, or a page opened with #edit. Only the address's #edit changes, never the page.
 * The first time, the editor's controls and styles (client/editor.html, served as
 * /editor.html) are added to the page, then its code, which joins
 * the room; the frame loads its half and swaps the plain page for
 * the editable one, at the same place (pagesDoor). The editor's controls fade
 * in over the viewer's once it's ready (main.ts calls ergaShell.ready), and
 * out again on the way back; the editor keeps running meanwhile, so going back
 * in is immediate. Viewing, it fetches the editor's files while the browser is
 * idle, so that first time is quick too.
 */
export const EDIT_BOOT = `(() => {
  const frame = document.getElementById("frame"), body = document.body;
  const pages = new URL(document.querySelector('meta[name="erga-pages"]').content, location.href).origin;
  let hostUp = false, wanted = null, editor = null, ready = false;
  // Reloaded in the editor, its controls are up already (EDITING_BODY), shown as if it were ready (but inert) until it is:
  // last on the page, as they'd be added below.
  const restored = window.ergaRestored;
  if (restored) {
    body.append(document.getElementById("erga-editor"));
    // (The editor's code not there in a while: the viewer's controls, with the pencil waiting, as on any way in.)
    setTimeout(() => { if (!ready) { body.classList.remove("erga-restored", "no-motion"); sync(); } }, 8000);
  }
  const toFrame = (type) => frame.contentWindow.postMessage({ type }, pages);
  // The frame's host page is up (or up again): what it was asked before then goes now.
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages || e.data?.type != "erga-host") return;
    hostUp = true;
    if (wanted) toFrame(wanted);
  });
  const ask = (type) => { wanted = type; if (hostUp) toFrame(type); };
  const sync = () => {
    const wrap = document.getElementById("erga-editor");
    body.classList.toggle("erga-editor-ready", ready || (!!restored && body.classList.contains("erga-restored") && body.classList.contains("erga-editing")));
    if (wrap) wrap.inert = !(ready && body.classList.contains("erga-editing"));
  };
  // The document's details, asked for as soon as editing starts, alongside the editor's files: that wakes its room too.
  const base = document.querySelector('meta[name="erga-base"]').content;
  const user = new URLSearchParams(location.search).get("user")?.trim();
  const info = () => { const url = base + "/api/doc" + (user ? "?user=" + encodeURIComponent(user) : ""); return { url, response: fetch(url) }; };
  const load = () => editor ??= (async () => {
    window.ergaDocInfo = info();
    document.head.append(Object.assign(document.createElement("link"), { rel: "preload", as: "script", href: "/page.js" }));
    const html = await (await fetch("/editor.html")).text();
    // This tab's copy, for a reload to open with (EDITING_HEAD).
    try { sessionStorage.setItem("${EDITOR_COPY}", html); } catch (e) {}
    // Reloaded with this very page's copy: its controls are the ones up already. Otherwise (a new release, say) they're the
    // new page's, which take the copy's place once their stylesheets are in.
    if (!restored || restored.html != html) {
      const d = new DOMParser().parseFromString(html, "text/html");
      document.documentElement.dataset.theme = "light";
      await Promise.all([...d.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => {
        el = document.importNode(el, true);
        const loaded = el.tagName == "LINK" && new Promise((done) => { el.onload = el.onerror = done; });
        document.head.append(el);
        return loaded;
      }));
      for (const el of document.querySelectorAll("[data-erga-restored], #erga-editor")) el.remove();
      const wrap = document.createElement("div");
      wrap.id = "erga-editor";
      for (const el of d.body.children) if (el.id != "frame" && el.tagName != "SCRIPT") wrap.append(document.importNode(el, true));
      body.append(wrap);
    }
    sync();
    body.append(Object.assign(document.createElement("script"), { src: "/page.js" }));
  })();
  // Editing, unless on the way out (erga-closing: the editor's own actions closing back into the pencil, client/editor.html).
  const editing = () => body.classList.contains("erga-editing") && !body.classList.contains("erga-closing");
  let closing = 0;
  function go(edit, push) {
    // The editor already running on another page (the viewer went to it since): that page's editor, loaded afresh.
    if (edit && window.ergaPage?.pagePath != null && window.ergaPage.pagePath != (document.querySelector('meta[name="erga-page"]')?.content || window.ergaPage.pagePath)) {
      history.replaceState(null, "", ergaPageAddress() + location.search + "#edit");
      location.reload();
      return;
    }
    if (push) history.pushState(null, "", (location.pathname == "/" ? "/" : ergaPageAddress()) + location.search + (edit ? "#edit" : ""));
    if (edit == editing() && push !== null) return;
    clearTimeout(closing);
    body.classList.remove("erga-closing");
    if (!edit && ready && body.classList.contains("erga-editing") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Out of the editor: its own actions close back into the pencil first (client/editor.html, .edit-group, 420ms), with the editor's
      // row still up; then the viewer's, the same buttons in the same places, takes over.
      body.classList.add("erga-closing");
      closing = setTimeout(() => { body.classList.remove("erga-closing", "erga-editing"); sync(); }, 420);
    } else body.classList.toggle("erga-editing", edit);
    document.querySelector(".erga-edit-button")?.setAttribute("aria-pressed", String(edit));
    ask(edit ? "erga-edit" : "erga-view");
    window.ergaPage?.setEditing(edit);
    sync();
    if (edit) load();
  }
  // Whether the page was opened in the editor (with #edit), rather than switched into it: main.ts restores
  // the agent as it was left only then, and otherwise opens it the way it does on any later switch.
  window.ergaShell = {
    ready() {
      ready = true;
      sync();
      // Its controls run now; what moves moves again from the next frame.
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("erga-restored", "no-motion")));
    },
    loadedEditing: editing(),
  };
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.(".erga-edit-button, #btn-edit");
    if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.id != "btn-edit", true);
  });
  // Back and forward, or #edit typed or taken off the address: editing follows it.
  const follow = () => go(location.hash == "#edit", false);
  addEventListener("popstate", follow);
  addEventListener("hashchange", follow);
  // Viewing, the editor's files are fetched ahead, at low priority, and its room woken (its details asked for): sooner when the
  // pointer or focus comes to the pencil, else once the document has loaded (its frame and everything in it) and the browser is
  // idle, so it never competes with the document itself.
  let fetched = false;
  const prefetch = () => {
    if (fetched || editor) return;
    fetched = true;
    for (const href of ["/editor.html", "/page.js", "/style.css", "/fonts/inter.css"]) document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href }));
    if (hostUp) toFrame("erga-prefetch"); else wanted ??= "erga-prefetch";
    info().response.catch(() => {});
  };
  for (const type of ["pointerover", "focusin"]) document.addEventListener(type, (e) => { if (e.target.closest?.(".erga-edit-button")) prefetch(); });
  if (editing()) go(true, null);
  else {
    const idle = () => (window.requestIdleCallback ?? setTimeout)(prefetch);
    if (document.readyState == "complete") idle(); else addEventListener("load", idle, { once: true });
  }
})();`;

/**
 * A presentation's steps, on a document's page (viewDocument), viewing and
 * editing alike: the frame's host page says when the page shown has steps
 * (HOST_SCRIPT: erga-steps; editor-agent/PROMPT.md, "Presentations"), and this
 * shows back and forward under the page, the step it's at, and a list of the
 * steps that opens over its right side. The arrow keys step too, pressed here
 * or in the page (the host page's), except in text. The list shows each step's
 * picture where the page draws them (erga-step-image), kept until the page
 * changes (another rev: an edit, another page), else its number and label.
 */
export const STEPS_BOOT = `(() => {
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const svg = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  const bar = document.createElement("div"), panel = document.createElement("div");
  bar.className = "erga-steps"; bar.hidden = true;
  bar.innerHTML = '<button type="button" class="erga-steps-toggle" aria-label="Steps" aria-expanded="false">' + svg("M5 6.5h14M5 12h14M5 17.5h14") + '</button>'
    + '<button type="button" class="erga-steps-back" aria-label="Back">' + svg("M14.5 6.5L9 12l5.5 5.5") + '</button>'
    + '<span class="erga-steps-at" aria-live="polite"></span>'
    + '<button type="button" class="erga-steps-next" aria-label="Forward">' + svg("M9.5 6.5L15 12l-5.5 5.5") + '</button>';
  // The list under a head: the editor docks it beside the page, and the head is where it's dragged from.
  panel.className = "erga-steps-panel"; panel.hidden = true; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Steps");
  panel.innerHTML = '<div class="erga-steps-head">Steps</div><ol class="erga-steps-list"></ol>';
  const list = panel.querySelector("ol");
  document.body.append(panel, bar);
  const [toggle, back, next] = bar.querySelectorAll("button"), at = bar.querySelector(".erga-steps-at");
  // What the page says (null: no steps), the list's shape it was built for, and the steps' pictures: step -> { url, rev }.
  let steps = null, shape = "", pics = new Map(), asked = new Set(), timer = 0;
  const send = (m) => frame.contentWindow?.postMessage(m, pages);
  const open = () => !panel.hidden;
  const items = () => panel.querySelectorAll(".erga-step");
  const drop = () => { for (const p of pics.values()) URL.revokeObjectURL(p.url); pics.clear(); asked.clear(); };
  function picture(i) {
    const box = items()[i]?.querySelector(".erga-step-pic"), p = pics.get(i);
    if (!box) return;
    if (p) { let img = box.querySelector("img"); if (!img) { box.textContent = ""; img = box.appendChild(document.createElement("img")); img.alt = ""; } if (img.src != p.url) img.src = p.url; }
    else if (box.querySelector("img") || !box.textContent) box.textContent = String(i + 1);
  }
  // The pictures of the steps in sight in the list, of this rev, that it hasn't yet: asked for once the page has stopped changing.
  function ask() {
    clearTimeout(timer);
    if (!steps?.images || !open()) return;
    timer = setTimeout(() => {
      const r = frame.getBoundingClientRect(), w = 384, h = Math.round(w * (r.height / r.width || 9 / 16)), view = list.getBoundingClientRect();
      items().forEach((el, i) => {
        const b = el.getBoundingClientRect(), key = steps.rev + ":" + i;
        if (b.bottom < view.top - 200 || b.top > view.bottom + 200 || pics.get(i)?.rev == steps.rev || asked.has(key)) return;
        asked.add(key);
        send({ type: "erga-step-image", step: i, rev: steps.rev, width: w, height: h });
      });
    }, pics.size ? 400 : 0);
  }
  function build() {
    list.textContent = "";
    panel.classList.toggle("erga-steps-plain", !steps.images);
    steps.labels.forEach((label, i) => {
      const li = list.appendChild(document.createElement("li")), b = li.appendChild(document.createElement("button"));
      b.type = "button"; b.className = "erga-step"; b.dataset.step = i;
      b.setAttribute("aria-label", (label ? label + ", " : "") + "step " + (i + 1) + " of " + steps.count);
      b.appendChild(document.createElement("span")).className = "erga-step-pic";
      const name = b.appendChild(document.createElement("span")), n = name.appendChild(document.createElement("b"));
      name.className = "erga-step-name"; n.textContent = i + 1;
      name.appendChild(document.createElement("span")).textContent = label || "Step " + (i + 1);
      picture(i);
    });
  }
  function current() {
    items().forEach((el, i) => { if (i == steps.current) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
    if (open()) items()[steps.current]?.scrollIntoView({ block: "nearest" });
  }
  function update(s) {
    const was = steps;
    steps = s && s.count > 0 ? s : null;
    bar.hidden = !steps;
    if (!steps) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); shape = ""; drop(); return; }
    // Other steps: the old pictures may be of other steps. Otherwise they stay up until the new ones come.
    const now = steps.count + "\\n" + steps.labels.join("\\n") + "\\n" + steps.images;
    if (now != shape) { shape = now; drop(); build(); }
    at.textContent = (steps.current + 1) + " / " + steps.count;
    bar.title = steps.labels[steps.current] || "";
    back.disabled = steps.current <= 0;
    next.disabled = steps.current >= steps.count - 1;
    current();
    if (!was || was.rev != steps.rev) ask();
    place();
  }
  // Under the page and over its right side (its left, if the editor's layout has the list left of the page), wherever the editor puts
  // the frame (the agent beside it), out of sight with it. Docked beside the page in the editor, the editor places the list.
  function place() {
    if (!steps) return;
    const r = frame.getBoundingClientRect(), hidden = getComputedStyle(frame).visibility == "hidden" || !r.width;
    bar.style.visibility = panel.style.visibility = hidden ? "hidden" : "";
    bar.style.left = r.left + r.width / 2 + "px";
    bar.style.bottom = Math.max(12, innerHeight - r.bottom + 14) + "px";
    const docked = panel.classList.contains("erga-docked") && document.body.classList.contains("erga-editing");
    let left = false;
    try { const o = JSON.parse(localStorage.getItem("erga:layout:v1") || "null")?.order; left = Array.isArray(o) && o.indexOf("picker") < o.indexOf("doc"); } catch {}
    panel.style.left = docked || !left ? "" : Math.max(8, r.left + 12) + "px";
    panel.style.right = docked ? "" : left ? "auto" : Math.max(8, innerWidth - r.right + 12) + "px";
    panel.style.top = docked ? "" : r.top + 12 + "px";
    // The pictures' shape is the frame's, as it is now (it changes with the window).
    panel.style.setProperty("--ar", r.width && r.height ? r.width + " / " + r.height : "16 / 9");
    panel.style.maxHeight = docked ? "" : Math.max(80, innerHeight - Math.max(12, innerHeight - r.bottom + 14) - 50 - r.top - 12) + "px";
  }
  function show(on) {
    panel.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) { place(); current(); ask(); }
  }
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source != frame.contentWindow || e.origin != pages || !m) return;
    if (m.type == "erga-steps") {
      const s = m.steps, ok = s && Number.isInteger(s.count) && s.count >= 0 && s.count <= 1000 && Number.isInteger(s.current) && Number.isInteger(s.rev)
        && Array.isArray(s.labels) && s.labels.length == s.count && s.labels.every((l) => typeof l == "string" && l.length <= 200);
      update(ok ? { count: s.count, current: Math.min(s.current, s.count - 1), labels: s.labels, images: s.images === true, rev: s.rev } : null);
    } else if (m.type == "erga-step-image" && steps && m.rev == steps.rev && Number.isInteger(m.step) && m.step < steps.count) {
      const old = pics.get(m.step);
      if (old) URL.revokeObjectURL(old.url);
      if (m.blob instanceof Blob && /^image\\//.test(m.blob.type)) pics.set(m.step, { url: URL.createObjectURL(m.blob), rev: m.rev });
      else pics.delete(m.step);
      picture(m.step);
    }
  });
  const go = (m) => { if (steps) send({ type: "erga-step", ...m }); };
  back.addEventListener("click", () => go({ by: -1 }));
  next.addEventListener("click", () => go({ by: 1 }));
  toggle.addEventListener("click", () => show(!open()));
  panel.addEventListener("click", (e) => { const b = e.target.closest?.(".erga-step"); if (b) go({ to: Number(b.dataset.step) }); });
  list.addEventListener("scroll", ask, { passive: true });
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!steps || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key == "Escape" && open()) { show(false); return; }
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.closest?.(".cm-editor"))) return;
    e.preventDefault();
    go({ by: e.key == "ArrowLeft" ? -1 : 1 });
  });
  new ResizeObserver(place).observe(frame);
  addEventListener("resize", place);
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  frame.addEventListener("transitionend", place);
})();`;

export const STEPS_STYLE = `
<style>
  .erga-steps, .erga-steps-panel { --st-bg: rgba(255, 255, 255, .95); --st-fg: #3f3f46; --st-soft: #8a8a94; --st-hover: rgba(161, 161, 169, .18);
    position: fixed; z-index: 25; box-sizing: border-box; background: var(--st-bg); color: var(--st-fg);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .06), 0 4px 18px rgba(0, 0, 0, .14); font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  html.page-dark :is(.erga-steps, .erga-steps-panel) { --st-bg: rgba(31, 31, 35, .95); --st-fg: #e4e4e9; --st-soft: #8f8f99; --st-hover: rgba(161, 161, 169, .2);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 4px 18px rgba(0, 0, 0, .4); }
  .erga-steps[hidden], .erga-steps-panel[hidden] { display: none; }
  .erga-steps { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; transform: translateX(-50%); }
  .erga-steps button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  .erga-steps button:hover:not(:disabled) { background: var(--st-hover); }
  .erga-steps button:disabled { opacity: .3; cursor: default; }
  :is(.erga-steps button, .erga-step):focus-visible { outline: 2px solid #3b7cf0; outline-offset: -2px; }
  .erga-steps button[aria-expanded="true"] { color: #3b7cf0; }
  .erga-steps svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .erga-steps-at { min-width: 54px; padding: 0 2px; text-align: center; font-variant-numeric: tabular-nums; }
  .erga-steps-panel { display: flex; flex-direction: column; width: min(208px, 55vw); overflow: hidden; border-radius: 12px; }
  .erga-steps-head { flex: none; padding: 10px 12px 2px; color: var(--st-soft); font-size: 12px; font-weight: 600; }
  .erga-steps-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 6px; list-style: none; overflow-y: auto; overscroll-behavior: contain; }
  .erga-step { display: block; width: 100%; padding: 5px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .erga-step:hover { background: var(--st-hover); }
  .erga-step-pic { display: grid; place-items: center; width: 100%; aspect-ratio: var(--ar, 16 / 9); overflow: hidden; border-radius: 5px;
    background: var(--st-hover); color: var(--st-soft); font-size: 22px; font-weight: 600; }
  .erga-step-pic img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .erga-step[aria-current="step"] .erga-step-pic { outline: 2px solid #3b7cf0; outline-offset: 1px; }
  .erga-step-name { display: flex; gap: 6px; margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.3; }
  .erga-step-name b { color: var(--st-soft); font-weight: 500; font-variant-numeric: tabular-nums; }
  .erga-step-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .erga-steps-plain .erga-step-pic { display: none; }
  .erga-steps-plain .erga-step-name { margin: 0; }
  .erga-steps-plain .erga-step[aria-current="step"] { color: #3b7cf0; }
  .erga-steps-plain .erga-step[aria-current="step"] b { color: inherit; }
  /* On a phone the agent covers the page: the steps go with it. */
  @media (max-width: 640px) { body.agent-open :is(.erga-steps, .erga-steps-panel) { display: none; } }
</style>`;

/**
 * The viewer's controls (Clone, Edit, who you are) fade once the page is
 * scrolled, on a document's page (viewDocument, FADE_BOOT) and on the
 * homepage alike: whole at the top of the page, faded (VIEW_STYLE,
 * FADED) anywhere below it, and whole again while the pointer is within
 * FADE_NEAR px of them, one of them has keyboard focus or your menu is open.
 * On a touch screen, with no pointer to come near, a tap near them brings
 * them back until the page scrolls again. It's a function of those alone:
 * the same scroll and pointer give the same look, and no timer changes it.
 *
 * `ergaFade(target, root)` (a page script) puts the class erga-faded on
 * `target` while they're faded; `root` is the document or shadow root they're
 * in. Its caller tells it where the page is scrolled to (scroll(y)) and where
 * the pointer is, in the window's coordinates (pointer(x, y, tap)), or that it
 * left the window (leave()).
 */
export const FADE_NEAR = 100;

/** How see-through the faded controls are: faint, but still there to find. */
export const FADED = 0.2;

export const FADE = `function ergaFade(target, root) {
  var NEAR = ${FADE_NEAR}, y = 0, mouse = null, tap = false, CONTROLS = ".erga-view-buttons, .erga-account, .erga-crumbs";
  // How far (x, y) is from the nearest control (the account's button, not its menu).
  function distance(x, y) {
    var best = Infinity;
    root.querySelectorAll(".erga-view-buttons > *, .erga-account-btn").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      best = Math.min(best, Math.hypot(dx, dy));
    });
    return best;
  }
  function focused() {
    var a = root.activeElement;
    try { return !!(a && a.closest && a.closest(CONTROLS) && a.matches(":focus-visible")); } catch (e) { return false; }
  }
  function update() {
    var whole = y <= 0 || tap || (mouse && distance(mouse.x, mouse.y) <= NEAR) || focused() || !!root.querySelector('.erga-account-btn[aria-expanded="true"]');
    target.classList.toggle("erga-faded", !whole);
  }
  root.addEventListener("focusin", update);
  root.addEventListener("focusout", function () { setTimeout(update); });
  // The account's menu opening or closing.
  new MutationObserver(update).observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
  addEventListener("resize", update);
  update();
  return {
    scroll: function (to) { to = Math.max(0, Number(to) || 0); if (to != y) tap = false; y = to; update(); },
    pointer: function (x, py, isTap) {
      if (!isFinite(x) || !isFinite(py)) return;
      if (isTap) tap = distance(x, py) <= NEAR; else mouse = { x: x, y: py };
      update();
    },
    leave: function () { mouse = null; update(); },
    update: update,
  };
}`;

/**
 * The fade (FADE) on a document's page: the page scrolls in the frame, on its
 * own origin, so the frame's host page says where it's scrolled to and where
 * the pointer is over it (HOST_SCRIPT: erga-scroll, erga-pointer). The pointer
 * over the band and the controls is this page's own.
 */
export const FADE_BOOT = `(() => {
  ${FADE}
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const fade = ergaFade(document.documentElement, document);
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source != frame.contentWindow || e.origin != pages || !m) return;
    if (m.type == "erga-scroll") fade.scroll(m.y);
    else if (m.type == "erga-pointer") { const r = frame.getBoundingClientRect(); fade.pointer(Number(m.x) + r.left, Number(m.y) + r.top, m.tap === true); }
  });
  document.addEventListener("pointermove", (e) => { if (e.pointerType == "mouse") fade.pointer(e.clientX, e.clientY, false); }, { passive: true });
  document.addEventListener("pointerdown", (e) => { if (e.pointerType != "mouse") fade.pointer(e.clientX, e.clientY, true); }, { passive: true });
  // Out of the window (not into the frame, which then says where the pointer is).
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    const r = frame.getBoundingClientRect();
    if (e.clientX > r.left + 1 && e.clientX < r.right - 1 && e.clientY > r.top + 1 && e.clientY < r.bottom - 1) return;
    fade.leave();
  });
})();`;

export const VIEW_STYLE = `
<style>
  /* The editor's look (client/style.css, .icon-btn): small icons. Right of them is who you are. Upper left, for
     someone signed in, the breadcrumbs (viewCrumbs), where the editor's are (client/editor.html, .chrome-nav) and as they look. */
  :is(.erga-view-buttons, .erga-crumbs) { --chrome: #a1a1a9; --chrome-hover: #3f3f46; --fg: #1c1c1f; --fg-strong: #0d0d0f; --soft: #6b6b73;
    position: fixed; top: max(12px, env(safe-area-inset-top)); z-index: 1000; display: flex; align-items: center;
    font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .erga-view-buttons { right: max(56px, calc(env(safe-area-inset-right) + 40px)); gap: 2px; }
  .erga-crumbs { left: max(14px, env(safe-area-inset-left)); height: 34px; min-width: 0; max-width: calc(100vw - 200px); margin: 0; font-size: 13.5px; }
  /* Each step's box and arrow as the editor's, so going into the editor and out moves nothing. */
  .erga-crumbs, .erga-crumbs > * { align-items: baseline; line-height: 34px; }
  .erga-crumbs > * { display: flex; height: 34px; text-decoration: none; }
  .erga-crumbs > :not(:last-child)::after { content: "›"; color: var(--chrome); opacity: 0.55; font-size: 13.5px; font-weight: 400; letter-spacing: normal; }
  .erga-brand { flex: none; padding: 0 6px; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); }
  .erga-brand::after { margin: 0 -6px 0 10px; }
  .erga-crumbs a.erga-crumb { flex: none; padding: 0 10px; color: var(--soft); }
  .erga-crumb::after { margin: 0 -6px 0 12px; }
  .erga-crumbs .erga-here { padding: 0 8px; }
  .erga-crumbs a:hover { opacity: 0.7; }
  .erga-crumbs a:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 1px; border-radius: 8px; }
  .erga-crumbs .erga-here { min-width: 0; color: var(--fg); }
  .erga-crumbs .erga-here span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 520px) { .erga-crumbs a.erga-crumb { display: none; } .erga-crumbs .erga-here { padding: 0 6px; } }
  /* On the band (BAND_STYLE), in the document's own colour: light or dark text to suit it, whatever the system's mode. */
  html.page-dark :is(.erga-view-buttons, .erga-crumbs) { --chrome: #8a8a94; --chrome-hover: #e4e4e9; --fg: #ececf1; --fg-strong: #ececf1; --soft: #a1a1aa; }
  html.page-light .erga-account { --acc-bg: #fff; --acc-fg: #1c1c1f; --acc-soft: #6b6b73; --acc-chrome: #a1a1a9; --acc-ring: #e6e6ea; --acc-hover: rgba(161, 161, 169, .14); }
  html.page-dark .erga-account { --acc-bg: #1f1f23; --acc-fg: #ececf1; --acc-soft: #8f8f99; --acc-chrome: #8a8a94; --acc-ring: #2f2f35; --acc-hover: rgba(161, 161, 169, .16); }
  html:is(.page-dark, .page-light) .erga-account-btn:not(.erga-account-out) { box-shadow: 0 0 0 2px var(--band, var(--acc-bg)); }
  .erga-view-button { position: relative; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--chrome);
    transition: color 150ms ease, background-color 150ms ease; }
  .erga-view-button:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  /* Editing (or on the way into it), the pencil is blue, as the editor's own is. */
  .erga-view-button[aria-pressed="true"] { color: #3b7cf0; }
  /* On the way into the editor the first time, while its code arrives, the pencil breathes (only if that takes a moment). */
  body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: erga-edit-wait 700ms ease-in-out 250ms infinite alternate; }
  @keyframes erga-edit-wait { to { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: none; opacity: 0.6; } }
  .erga-view-button svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .erga-view-button::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); white-space: pre; font-size: 12px;
    font-weight: 400; line-height: 1.3; letter-spacing: .01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .erga-view-button:hover::after { opacity: 1; } }
  /* Into the editor and out (EDIT_BOOT): the controls you're going to are there at once, whole, and the ones you're leaving fade
     out; so those in both (the pencil, your avatar, the breadcrumbs) never go see-through. */
  #erga-editor { opacity: 0; transition: opacity 200ms ease; }
  body.erga-editing.erga-editor-ready #erga-editor { opacity: 1; transition: none; }
  body:not(.erga-editing) #nav-docs { visibility: hidden; }
  .erga-view-buttons, .erga-account, .erga-crumbs { transition: none; }
  /* Editing, the editor's own breadcrumbs, just under the viewer's while those fade, take the clicks. */
  body.erga-editing .erga-crumbs { pointer-events: none; }
  body.erga-editing.erga-editor-ready :is(.erga-view-buttons, .erga-account, .erga-crumbs) { opacity: 0; visibility: hidden; transition: opacity 200ms ease, visibility 0s 200ms; }
  /* Faded once the page is scrolled (FADE): the controls themselves, not the band behind them nor your open menu. Quick and
     smooth, and with no motion at all for those who ask for less: just the change. */
  .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: opacity 180ms ease, color 150ms ease, background-color 150ms ease; }
  html.erga-faded :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  :host(.erga-faded) :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  @media (prefers-reduced-motion: reduce) { .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: color 150ms ease, background-color 150ms ease; } }
  /* On a phone they'd sit over the text the whole way down: they stay at the top instead. */
  @media (max-width: 640px), (max-height: 480px) {
    .erga-view-buttons, .erga-crumbs { position: absolute; }
  }
</style>`;

/**
 * The viewer's page around a document's frame (documents/view.ts decides what goes in: who may
 * edit, the frame's host and token, the metas). The document shows at once in the frame; editing
 * is loaded on top of it (EDIT_BOOT) only when someone goes into it, by the pencil or at #edit.
 */
export function viewerPage(o: { title: string; docId: string; origin: string; host: string; index: string | null; meta: string; session: Session | null; editable: boolean; landing: boolean; clone: string; edit: string }): Response {
  // Its page by name when it's known (the front page's, or another of its pages), else the folder, which its host answers with its page.
  const src = `${o.host}?view=${o.index ? encodeURIComponent(o.index) : ""}&v=${HOST_VERSION}`;
  // Opened with #edit (which only the browser sees), for whoever may edit: the page is the editor's from its first moment
  // (EDITING_HEAD, EDITING_BODY), the frame starts on its half of the editor at once (&edit=1), and the editor's files are
  // fetched as the page parses, rather than one after another once its script runs (EDIT_BOOT).
  const opening = o.editable ? `<script>${EDITING_HEAD}</script>` : "";
  // For someone who may edit, it passes autoplay on, for the editor's page (client/frame.ts): the agent's page_click
  // gives no activation of its own, so the page's media plays on the tab's. For anyone else, nothing: the page's script
  // can act as the frame's host page (its origin), so what the frame may do, the page may. Full screen for no one.
  const frame = `<iframe id="frame" class="erga-view" ${o.editable ? "data-src" : "src"}="${esc(src)}" title="${esc(o.title)}" sandbox="${PAGE_SANDBOX}" allow="${o.editable ? EDITOR_ALLOW : PAGE_ALLOW}"></iframe>`;
  // The band above the document (and, editing, the room the agent opens) takes the page's background: remembered from this
  // document's last visit, before anything has loaded, then as the frame tells it (BAND_BOOT).
  const backdrop = `<script>${BAND_HEAD}ergaBand(${JSON.stringify(o.docId)});</script>`;
  const session = o.session;
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${esc(o.title)}</title>
${FAVICON_LINK}
<meta name="erga-doc" content="${esc(o.docId)}">
<link rel="preconnect" href="${esc(o.origin)}">
${o.meta}${backdrop}${crumbsFont(session)}<style>${BAND_STYLE}</style>${opening}
<body>${o.editable ? `<script>${EDITING_BODY}</script>` : ""}
<div class="erga-canvas" aria-hidden="true"><div></div></div>${frame}${o.editable ? `<script>${FRAME_SRC}</script>` : ""}
${viewCrumbs(session, o.landing ? null : o.title)}<div class="erga-view-buttons">${newDocButton("erga-view-button")}${o.clone}${o.edit}</div>${newDocMenu((path) => link(path, session), !!session && !session.test && !session.agent)}${VIEW_STYLE}${NEW_DOC_STYLE}<script>${NEW_DOC_SCRIPT}ergaNewDoc(document);</script><script>${NAV_SCRIPT}</script><script>${BAND_BOOT}</script><script>${FADE_BOOT}</script>${STEPS_STYLE}<script>${STEPS_BOOT}</script>${o.editable ? `<script>${EDIT_BOOT}</script>` : ""}
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Link: `<${o.origin}>; rel=preconnect` } });
}
