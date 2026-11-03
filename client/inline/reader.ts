// The script that goes first into a document's page, before the page's own (server/pages/reader.ts, readerPage). It
// tells the viewer by postMessage what it needs: where the page is scrolled to and where the pointer is (the fade), its
// background (the band and the canvas around the frame), and which of the document's pages it shows. It follows the
// viewer's asks (the editor), and sends links that leave the
// document to the viewer, which opens them. `C`: the viewer's origin, where the document's files are, and the editor's
// half for whoever may edit.

import type { ReaderConfig } from "../../shared/page-html";
import type { ToolAsk } from "../common/reader-api";
import { copyOf } from "../../libs/text/ui/clipboard-read";
import { linkTarget, placeOf } from "../common/link-target";
import { topRoom } from "../common/top-room";
import { isAppShortcut } from "../common/app-keys";
import { catchZoomGestures } from "../common/zoom";
import { makeErgaLLM, type LlmAnswer, type LlmOp } from "../common/page-llm";

/** The page's canvas, as it goes to the viewer (client/inline/viewer-band.ts draws it). */
type Canvas = {
  color: string;
  image: string;
  files: Blob[];
  urls?: string[];
  size?: string;
  position?: string;
  repeat?: string;
  tile?: boolean;
  fixed?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};
export default function reader(C: ReaderConfig): void {
  // Only as the viewer's document: not opened by itself, nor in a frame inside the page.
  if (parent == window || parent != top) return;
  const P = parent,
    root = document.documentElement;
  function tell(m: unknown) {
    try {
      P.postMessage(m, C.shell);
    } catch {}
  }
  function editing() {
    return root.hasAttribute("data-erga-editing");
  }
  // The page's model (client/common/page-llm.ts): each ask goes to the viewer, which calls Erga as the visitor
  // (client/inline/viewer-llm.ts) and answers it. A viewer that never answers: off, or an error.
  let llmId = 0;
  const llmWaits = new Map<number, (a: LlmAnswer) => void>();
  window.ergaLLM = makeErgaLLM(
    (o) =>
      new Promise((done) => {
        const id = ++llmId;
        llmWaits.set(id, done);
        let m: LlmOp;
        try {
          m = JSON.parse(JSON.stringify(o));
        } catch {
          llmWaits.delete(id);
          return done({ ok: false, error: "The ask isn't plain JSON.", code: "error" });
        }
        tell({ ...m, type: "erga-llm", id });
        setTimeout(
          () => {
            if (!llmWaits.delete(id)) return;
            done(
              o.op == "ask"
                ? { ok: false, error: "Erga didn't answer.", code: "error" }
                : { ok: true, result: { on: false, model: null, signedIn: false } }
            );
          },
          o.op == "ask" ? 120_000 : 10_000
        );
      })
  );
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  // The viewer's own keys, pressed here. Reading, ⌘K (Ctrl+K off a Mac) opens the viewer's quick search
  // (client/common/quick-search.ts). Editing, each of the viewer's shortcuts goes to it (client/common/app-keys.ts),
  // which the editor in the page leaves be; Escape stays the editor's too (the focus off the text).
  addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (editing()) {
        tell({ type: "erga-activity", kind: "key" });
        if (!isAppShortcut(e, mac)) return;
        if (e.key != "Escape") e.preventDefault();
        tell({ type: "erga-key", keys: { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } });
        return;
      }
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() != "k") return;
      e.preventDefault();
      tell({ type: "erga-quick-search" });
    },
    true
  );
  // Editing: the page's focus, and a zoom gesture on it (a pinch, ctrl with the wheel), for the viewer, which sets the
  // zoom (libs/text/ui/zoom.ts); whether the page zooms itself (window.ergaZoom: a canvas's camera), as the viewer's
  // zoom goes to it then.
  addEventListener("focus", () => editing() && tell({ type: "erga-activity", kind: "focus" }), true);
  catchZoomGestures(window, (by) => tell({ type: "erga-zoom", zoom: by }), editing);
  let zoomsSaid: boolean | null = null;
  const zooms = (again = false) => {
    const on = typeof (window as Window & { ergaZoom?: unknown }).ergaZoom == "function";
    if (on === zoomsSaid && !again) return;
    zoomsSaid = on;
    tell({ type: "erga-zooms", on });
  };
  addEventListener("load", () => zooms());
  window.__ergaReader = {
    config: C,
    // (The editor puts the page back where it was: with its room for the bars.)
    placed: () => {
      keepRoom();
      placed();
    },
    tools: (answer) => {
      toolsAnswer = answer;
      for (const ask of asks.splice(0)) answer(ask);
    },
  };
  // Erga's page tools (the agent's view_page, eval_in_page and the live page's), loaded when the viewer first asks for
  // one (only for whoever may edit: the editor's config names them); the asks wait for them meanwhile.
  let toolsAnswer: ((ask: ToolAsk) => void) | null = null,
    toolsLoading = false;
  const asks: ToolAsk[] = [];
  function askTools(ask: ToolAsk) {
    if (toolsAnswer) return toolsAnswer(ask);
    asks.push(ask);
    const tools = C.editor && C.editor.tools;
    if (toolsLoading || !tools) return;
    toolsLoading = true;
    addScript(tools);
  }
  tell({ type: "erga-hello" });
  // Which of the document's pages this is ("" for its own page).
  let page = location.pathname.indexOf(C.prefix) == 0 ? location.pathname.slice(C.prefix.length) : "";
  try {
    page = decodeURIComponent(page);
  } catch {}
  if (!page || /\.html$/i.test(page)) tell({ type: "erga-nav", path: page || "" });
  // The page stops dead at its top and bottom.
  const still = document.createElement("style");
  still.setAttribute("data-erga", "");
  still.textContent = "html { overscroll-behavior: none; }";
  (document.head || root).append(still);
  // The room for the bars at the top of a scrolling page (client/common/top-room.ts), measured again when the page's
  // styles may have changed (its head, its root's attributes), as it loads, the window's size, or the room the viewer asks for (its
  // band's height at its zoom); and whether the page fills the window, for the viewer, which keeps its frame below the
  // bars then.
  const room = topRoom(document);
  let roomDirty = true,
    fillsSaid: boolean | null = null;
  const dirty = () => {
    roomDirty = true;
  };
  const styles = new MutationObserver(dirty);
  styles.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  addEventListener("resize", dirty);
  addEventListener("load", dirty);
  // (At once as the page is parsed, before its deferred scripts and the editor run and measure it.)
  document.addEventListener("readystatechange", () => {
    dirty();
    keepRoom();
  });
  function keepRoom() {
    if (!roomDirty || !ready()) return;
    roomDirty = false;
    if (document.head) styles.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    const fills = room.update();
    if (fills !== fillsSaid) {
      fillsSaid = fills;
      tell({ type: "erga-fills", fills });
    }
  }
  // Reloaded in the editor scrolled down the page (?erga-y=, viewer.ts): it opens where it was, out of sight until it's
  // there (its content may still be coming), or as far as it goes once it has loaded (a shorter page now), or after a moment.
  let startY = Number((/[?&]erga-y=(\d+)/.exec(location.search) || [])[1]) || 0,
    placing: HTMLStyleElement | null = null;
  function placed() {
    startY = 0;
    if (placing) {
      placing.remove();
      placing = null;
    }
  }
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
  let loading = false;
  function load() {
    const editor = C.editor;
    // (A page that brings its own editor: it's there already, and hears the viewer's word itself.)
    if (loading || !editor || !editor.src) return;
    loading = true;
    addScript(editor);
  }
  /** One of Erga's scripts into this page, with its chunks (their integrity is the import map's, before this script). */
  function addScript(script: { src: string; integrity: string; preload: string[] }) {
    const head = document.head || root,
      map = C.editor ? C.editor.map : {};
    script.preload.forEach((href) => {
      const l = document.createElement("link");
      l.rel = "modulepreload";
      l.href = href;
      l.crossOrigin = "anonymous";
      l.setAttribute("data-erga", "");
      if (map[href]) l.integrity = map[href];
      head.append(l);
    });
    const s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "anonymous";
    s.src = script.src;
    s.setAttribute("data-erga", "");
    if (script.integrity) s.integrity = script.integrity;
    head.append(s);
  }
  if (/[?&]erga-edit(=|&|$)/.test(location.search)) load();
  // The fade: where the page is scrolled to, and the pointer over it, at most once a frame.
  let scrolled: string | null = null,
    pointer: { x: number; y: number } | null = null;
  function report() {
    // (A page's camera moves as a scroll does: whether it zooms itself may have changed with it.)
    if (editing()) zooms();
    const at = scrollX + "," + scrollY;
    if (at !== scrolled) {
      scrolled = at;
      tell({ type: "erga-scroll", y: Math.max(0, Math.round(scrollY)), sx: scrollX, sy: scrollY });
    }
  }
  addEventListener("scroll", report, { passive: true });
  document.addEventListener("scroll", () => editing() && zooms(), { passive: true });
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType != "mouse") return;
      if (!pointer)
        requestAnimationFrame(() => {
          tell({ type: "erga-pointer", x: pointer!.x, y: pointer!.y });
          pointer = null;
        });
      pointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true }
  );
  // (On the window, first: the text guard, after this script, keeps a press on the text from the page's handlers.)
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType != "mouse") tell({ type: "erga-pointer", x: e.clientX, y: e.clientY, tap: true });
      // Editing, a press on the page is one anywhere in the viewer: what it has open closes.
      if (editing()) tell({ type: "erga-press" });
    },
    { capture: true, passive: true }
  );
  // Links, read as Erga addresses (client/common/link-target.ts). To another of the document's pages: in this frame,
  // even when the link names it by its Erga address or says "_top". Out of the document: a new tab, unless the link
  // names its own target; "_self" takes the whole tab. A ⌘-, Ctrl- or Shift-click, or the middle button: a new tab, at
  // a page's public address (never the token's). The viewer opens new tabs and the whole tab, on the reader's click.
  // Editing, a link in the text being edited isn't followed (but with a modifier, into a new tab), nor a place in the
  // page (#id); another of the document's pages opens in the editor, as the viewer goes there (erga-open).
  function follow(e: MouseEvent) {
    if (e.defaultPrevented || e.altKey || e.button != (e.type == "auxclick" ? 1 : 0)) return;
    const target = e.target as Element | null;
    const a = target && target.closest ? target.closest<HTMLAnchorElement>("a[href]") : null;
    const p = placeOf(window, C);
    if (!a || !p || a.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      return;
    }
    const to = linkTarget(url, p);
    if (to.kind == "none" || to.kind == "file") return;
    const t = (a.getAttribute("target") || "").toLowerCase(),
      tab = e.type == "auxclick" || e.metaKey || e.ctrlKey || e.shiftKey || t == "_blank",
      here = !t || t == "_self" || t == "_top" || t == "_parent";
    if (editing()) {
      if (!tab && (a.isContentEditable || !here || a.getAttribute("href")!.charAt(0) == "#")) return;
      e.preventDefault();
      if (to.kind == "page" && !tab) tell({ type: "erga-open", path: to.path || "index.html" });
      else {
        const out = to.kind == "page" ? to.public : to.url;
        if (out) tell({ type: "erga-go", url: out, tab: tab || !t ? "new" : undefined });
      }
      return;
    }
    if (to.kind == "page" && !tab) {
      if (!here || (url.href == to.frame && t != "_top" && t != "_parent")) return;
      e.preventDefault();
      location.assign(to.frame);
      return;
    }
    const go = to.kind == "page" ? to.public : to.url;
    if (!go || (!tab && !here && t)) return;
    e.preventDefault();
    tell({ type: "erga-go", url: go, tab: tab || !t ? "new" : undefined });
  }
  document.addEventListener("click", follow);
  document.addEventListener("auxclick", follow);
  // The band above the page takes its background (its own colour; else a gradient's colour at the top), and the canvas
  // around the frame its background's layers: what the browser gives the canvas (the root's, or the body's when the
  // root has none), placed against the root's box. An image goes as its file, fetched here; one that can't be is left out.
  function clear(c: string) {
    return /^(transparent|rgba\([^)]*,\s*0\))$/.test(c);
  }
  function solid(cs: CSSStyleDeclaration) {
    const c = cs.backgroundColor;
    if (!clear(c)) return c;
    const img = cs.backgroundImage,
      stops = img && img != "none" && /gradient/.test(img) ? img.match(/rgba?\([^)]*\)/g) : null;
    if (stops) return /^linear-gradient\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0];
    return "";
  }
  function ready() {
    return !!document.body || document.readyState != "loading";
  }
  function colour() {
    if (!ready()) return null;
    let c = solid(getComputedStyle(root));
    if (!c && document.body) c = solid(getComputedStyle(document.body));
    return c;
  }
  function layers(v: string) {
    const out: string[] = [];
    let depth = 0,
      quote = "",
      from = 0;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (quote) {
        if (ch == "\\") i++;
        else if (ch == quote) quote = "";
      } else if (ch == '"' || ch == "'") quote = ch;
      else if (ch == "(") depth++;
      else if (ch == ")") depth--;
      else if (ch == "," && !depth) {
        out.push(v.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push(v.slice(from).trim());
    return out;
  }
  const pictures: Record<string, Blob | null | undefined> = {};
  function picture(u: string) {
    if (u in pictures) return pictures[u];
    pictures[u] = undefined;
    fetch(u)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (b) => {
          pictures[u] = b && /^image\//.test(b.type) && b.size < 4e6 ? b : null;
        },
        () => {
          pictures[u] = null;
        }
      );
    return undefined;
  }
  function canvas(): Canvas | null {
    if (!ready()) return null;
    let cs = getComputedStyle(root);
    if (cs.backgroundImage == "none" && clear(cs.backgroundColor) && document.body) cs = getComputedStyle(document.body);
    const c: Canvas = { color: clear(cs.backgroundColor) ? "" : cs.backgroundColor, image: "", files: [], urls: [] };
    if (cs.backgroundImage == "none") return c;
    const images = layers(cs.backgroundImage),
      sizes = layers(cs.backgroundSize),
      repeats = layers(cs.backgroundRepeat);
    let tile = false;
    for (let i = 0; i < images.length; i++) {
      const m = /^url\("((?:[^"\\]|\\.)*)"\)$/.exec(images[i]);
      if (m) {
        const file = picture(m[1]);
        if (file === undefined) return null;
        if (!file) {
          images[i] = "none";
          continue;
        }
        images[i] = 'url("erga-file:' + c.files.length + '")';
        c.files.push(file);
        c.urls!.push(m[1]);
      } else if (!/^(repeating-)?(linear|radial|conic)-gradient\(/.test(images[i])) {
        images[i] = "none";
        continue;
      }
      const size = sizes[i % sizes.length],
        whole = /^(cover|contain|100%( 100%| auto)?|auto( 100%| auto)?)$/.test(size) && !(m && /^auto( auto)?$/.test(size));
      if ((!whole || /^repeating-/.test(images[i])) && repeats[i % repeats.length] != "no-repeat") tile = true;
    }
    if (images.every((v) => v == "none")) return c;
    const r = root.getBoundingClientRect(),
      fixed = /fixed/.test(cs.backgroundAttachment);
    c.image = images.join(", ");
    c.size = cs.backgroundSize;
    c.position = cs.backgroundPosition;
    c.repeat = cs.backgroundRepeat;
    c.tile = tile;
    c.fixed = fixed;
    c.x = fixed ? 0 : r.left + scrollX;
    c.y = fixed ? 0 : r.top + scrollY;
    c.w = fixed ? innerWidth : r.width;
    c.h = fixed ? innerHeight : r.height;
    return c;
  }
  let band: string | null = null,
    canvasSaid = "",
    hash: string | null = null;
  (function watch() {
    try {
      keepRoom();
      if (startY) place();
      const c = colour(),
        cv = c != null ? canvas() : null;
      if (cv) {
        const key = JSON.stringify(cv);
        delete cv.urls;
        if (key != canvasSaid) {
          canvasSaid = key;
          tell({ type: "erga-canvas", canvas: cv });
        }
      }
      if (c != null && c !== band) {
        band = c;
        tell({ type: "erga-band", color: c });
      }
      if (c != null) report();
      // The page's place in its own address (#3: agents/document/PROMPT.md, rule 11), for the tab's address.
      if (location.hash != hash) {
        hash = location.hash;
        tell({ type: "erga-hash", hash });
      }
    } catch {}
    requestAnimationFrame(watch);
  })();
  // A file dragged from the computer onto the page never opens in its place (the editor puts it in: its drop). A
  // page that takes the drop itself has already stopped the browser's own.
  function stopFileDrop(e: DragEvent) {
    if (!e.defaultPrevented && e.dataTransfer && e.dataTransfer.types.indexOf("Files") >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    }
  }
  addEventListener("dragover", stopFileDrop);
  addEventListener("drop", stopFileDrop);
  // A copy out of the page (the editor has its own): its text with basic formatting only, never the page's fonts and
  // colours, its links and pictures as they work elsewhere, and Markdown as the plain text (clipboard-html.ts). Not
  // when the page wrote the clipboard itself (it stopped the browser's copy), nor out of a field.
  addEventListener("copy", (e) => {
    const field = document.activeElement;
    if (editing() || e.defaultPrevented || !e.clipboardData || (field && /^(INPUT|TEXTAREA)$/.test(field.tagName))) return;
    let out = null;
    try {
      out = copyOf(window, placeOf(window, C));
    } catch {}
    if (!out) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out.text);
    e.clipboardData.setData("text/html", out.html);
  });
  addEventListener("message", (e) => {
    if (e.source != P || e.origin != C.shell || !e.data) return;
    const type = e.data.type;
    const editor = C.editor;
    if (type == "erga-llm-answer" && llmWaits.has(e.data.id)) {
      const done = llmWaits.get(e.data.id)!;
      llmWaits.delete(e.data.id);
      done(e.data.answer);
    }
    // The viewer's word on editing (libs/text/ui/bridge.ts, EditMode): kept for the editor, which loads on the first edit.
    else if (type == "erga-mode") {
      window.__ergaReader!.mode = e.data;
      if (e.data.mode == "edit") {
        load();
        zooms(true);
      }
    }
    // The viewer's zoom, for a page that zooms itself (window.ergaZoom): `by` times closer, or 0 for its own first view.
    else if (type == "erga-page-zoom" && typeof e.data.by == "number" && isFinite(e.data.by)) {
      const z = (window as Window & { ergaZoom?: unknown }).ergaZoom;
      if (typeof z == "function")
        try {
          z(e.data.by);
        } catch (err) {
          console.error("window.ergaZoom threw:", err);
        }
    } else if (type == "erga-live") {
      if (typeof e.data.id == "number") askTools(e.data as ToolAsk);
    }
    else if (type == "erga-room" && typeof e.data.px == "number" && e.data.px >= 0 && e.data.px <= 400) {
      room.room = e.data.px;
      dirty();
    }
    // The document's public address, for the links in a copy: on the viewer's origin, as the token names it.
    else if (type == "erga-address" && typeof e.data.address == "string" && e.data.address.indexOf(C.shell + "/") == 0)
      C.address = e.data.address;
    else if (type == "erga-prefetch" && editor && !loading) {
      [editor.src].concat(editor.preload).forEach((href) => {
        const l = document.createElement("link");
        l.rel = "prefetch";
        l.href = href;
        l.crossOrigin = "anonymous";
        l.setAttribute("data-erga", "");
        (document.head || root).append(l);
      });
    }
  });
}
