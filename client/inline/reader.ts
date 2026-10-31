// The script that goes first into a document's page, before the page's own (server/pages/reader.ts, readerPage). It
// tells the viewer by postMessage what it needs: where the page is scrolled to and where the pointer is (the fade), its
// background (the band and the canvas around the frame), its steps (a presentation), and which of the document's pages
// it shows. It follows the viewer's asks (a step, a step's picture, the editor), and sends links that leave the
// document to the viewer, which opens them. `C`: the viewer's origin, where the document's files are, and the editor's
// half for whoever may edit.

import type { ReaderConfig } from "../../shared/page-html";
import { copyOf, placeOf } from "../page-editor/clipboard-html";

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
/** A presentation's steps, as the page says them (agents/document/PROMPT.md, "Presentations"). */
type Steps = {
  count(): unknown;
  go(n: number): void;
  current(): unknown;
  label?(i: number): unknown;
  image?(i: number, size: { width: number; height: number }): unknown;
  slide?(i: number): unknown;
};
type StepsMessage = {
  count: number;
  current: number;
  labels: string[];
  images: boolean;
  slides: number[] | null;
  rev?: number;
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
  // ⌘K (Ctrl+K off a Mac) here opens the viewer's quick search (client/common/quick-search.ts); the editor's bridge passes it on while editing.
  addEventListener("keydown", (e) => {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() != "k" || editing()) return;
    e.preventDefault();
    tell({ type: "erga-quick-search" });
  });
  window.__ergaReader = {
    config: C,
    changed: () => {
      rev++;
      said = "";
      tellSteps();
    },
    placed: () => {
      placed();
    },
  };
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
    if (loading || !editor) return;
    loading = true;
    const head = document.head || root;
    editor.preload.forEach((href) => {
      const l = document.createElement("link");
      l.rel = "modulepreload";
      l.href = href;
      l.crossOrigin = "anonymous";
      l.setAttribute("data-erga", "");
      if (editor.map[href]) l.integrity = editor.map[href];
      head.append(l);
    });
    const s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "anonymous";
    s.src = editor.src;
    s.setAttribute("data-erga", "");
    if (editor.integrity) s.integrity = editor.integrity;
    head.append(s);
  }
  if (/[?&]erga-edit(=|&|$)/.test(location.search)) load();
  // The fade: where the page is scrolled to, and the pointer over it, at most once a frame.
  let scrolled: string | null = null,
    pointer: { x: number; y: number } | null = null;
  function report() {
    const at = scrollX + "," + scrollY;
    if (at !== scrolled) {
      scrolled = at;
      tell({ type: "erga-scroll", y: Math.max(0, Math.round(scrollY)), sx: scrollX, sy: scrollY });
    }
  }
  addEventListener("scroll", report, { passive: true });
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
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType != "mouse") tell({ type: "erga-pointer", x: e.clientX, y: e.clientY, tap: true });
    },
    { capture: true, passive: true }
  );
  // Links, reading (the editor follows its own: client/page-editor/frame.ts). To another of the document's pages: in this frame, as
  // the link says. Out of the document: a new tab, unless the link names its own target; "_self" takes the whole tab.
  // The viewer opens both, on the reader's click.
  document.addEventListener("click", (e) => {
    if (editing() || e.defaultPrevented || e.button != 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element | null;
    const a = target && target.closest ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a || a.hasAttribute("download") || !/^https?:$/.test(a.protocol)) return;
    if (a.origin == location.origin && a.pathname.indexOf(C.prefix) == 0) return;
    const t = (a.getAttribute("target") || "").toLowerCase();
    if (!t || t == "_blank") {
      e.preventDefault();
      tell({ type: "erga-go", url: a.href, tab: "new" });
    } else if (t == "_self" || t == "_top" || t == "_parent") {
      e.preventDefault();
      tell({ type: "erga-go", url: a.href });
    }
  });
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
  const STEP_MAX = 1000;
  let band: string | null = null,
    canvasSaid = "",
    said = "null",
    shape = "",
    rev = 0,
    polled = 0,
    listening = false,
    hash: string | null = null;
  (function watch() {
    try {
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
      // The page's place in its own address (#3: agents/document/PROMPT.md, rule 14), for the tab's address.
      if (location.hash != hash) {
        hash = location.hash;
        tell({ type: "erga-hash", hash });
      }
      const now = Date.now();
      if (now - polled > 300) {
        polled = now;
        tellSteps();
      }
    } catch {}
    requestAnimationFrame(watch);
  })();
  // A presentation (agents/document/PROMPT.md, "Presentations"): the page says it has steps (window.ergaSteps).
  function steps(): Steps | null {
    const p = (window as Window & { ergaSteps?: Steps }).ergaSteps;
    return p && typeof p.count == "function" && typeof p.go == "function" && typeof p.current == "function" ? p : null;
  }
  function whole(x: unknown, max: number) {
    const n = Math.floor(Number(x));
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
  }
  function tellSteps() {
    const p = steps();
    let m: StepsMessage | null = null;
    if (p && !listening) {
      listening = true;
      addEventListener("ergastep", () => {
        tellSteps();
      });
      addEventListener("keydown", (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key != "ArrowLeft" && e.key != "ArrowRight")) return;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
        setTimeout(() => {
          if (!e.defaultPrevented) step({ by: e.key == "ArrowLeft" ? -1 : 1 });
        });
      });
    }
    if (p)
      try {
        const count = whole(p.count(), STEP_MAX),
          labels: string[] = [],
          slides: number[] | null = typeof p.slide == "function" ? [] : null;
        for (let i = 0; i < count; i++) {
          const l = typeof p.label == "function" ? p.label(i) : "";
          labels.push(typeof l == "string" ? l.replace(/\s+/g, " ").trim().slice(0, 200) : "");
          // The slide each step is on (the parts of a slide that builds up), never one before the step before's.
          if (slides) slides.push(Math.max(i ? slides[i - 1] : 0, whole(p.slide!(i), STEP_MAX)));
        }
        m = { count, current: whole(p.current(), Math.max(0, count - 1)), labels, images: typeof p.image == "function", slides };
      } catch {
        m = null;
      }
    const now = m ? m.count + "\n" + m.labels.join("\n") + "\n" + m.slides : "";
    if (now != shape) {
      shape = now;
      rev++;
    }
    if (m) m.rev = rev;
    const text = JSON.stringify(m);
    if (text != said) {
      said = text;
      tell({ type: "erga-steps", steps: m });
    }
  }
  function step(to: { by?: number; to?: unknown }) {
    const p = steps();
    if (!p) return;
    try {
      const count = whole(p.count(), STEP_MAX),
        at = whole(p.current(), STEP_MAX);
      const n = to.by ? at + (to.by > 0 ? 1 : -1) : whole(to.to, STEP_MAX);
      if (n >= 0 && n < count && n != at) p.go(n);
    } catch {}
    tellSteps();
  }
  function stepImage(m: { step?: unknown; rev?: unknown; width?: unknown; height?: unknown }) {
    const p = steps(),
      at = rev,
      n = whole(m.step, STEP_MAX);
    if (!p || typeof p.image != "function" || m.rev !== at) return;
    const answer = (blob: unknown) => {
      const b = blob as Blob | null;
      const ok = b && typeof b.type == "string" && /^image\//.test(b.type) && b.size < 4e6;
      tell({ type: "erga-step-image", step: n, rev: at, blob: ok ? b : null });
    };
    const size = { width: whole(m.width, 1600) || 320, height: whole(m.height, 1600) || 180 };
    Promise.resolve()
      .then(() => p.image!(n, size))
      .then((r: unknown) => {
        const x = r as { toBlob?: (done: (b: Blob | null) => void, type: string) => void; arrayBuffer?: unknown } | string | null;
        if (!x) return null;
        if (typeof x == "string") return fetch(x).then((res) => res.blob());
        if (typeof x.toBlob == "function")
          return new Promise((done) => {
            x.toBlob!(done, "image/png");
          });
        if (typeof x.arrayBuffer == "function") return x;
        return null;
      })
      .then(answer, () => {
        answer(null);
      });
  }
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
    if (type == "erga-step") step(e.data);
    else if (type == "erga-step-image") stepImage(e.data);
    else if (type == "erga-edit") load();
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
