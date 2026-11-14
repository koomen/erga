// A file on its way, on the element that shows it: the document has the element (an image, a video, a link) from the
// drop, and the file's bytes come after. Until they are there, the editor draws a placeholder over each element of the
// page whose address is the file's: this tab's own file with its picture (from the file itself), how far it is, the
// time left and Cancel; a file from another tab or an agent as a neutral box with its name. A file that can't go in
// keeps its reason and its fixes on it. It finds the elements by their address, so it works on any page.
//
// The placeholders are the editor's own elements on the page's <html>, outside the text (drop.ts, PARTS): the page's
// elements and its source stay as they are. When the bytes are there, the element loads them in place.

import type { PageFile } from "../../../client/common/uploads";
import type { Pending } from "../../../shared/room-socket";
import { agentLabel } from "../../../shared/attribution";
import { ICON, PARTS, partsLayer } from "./drop";

const STYLE = `${PARTS}
.ph { border-radius: 4px; overflow: hidden; background: center / 100% 100% no-repeat; }
.ph::before { content: ""; position: absolute; inset: 0; background: color-mix(in srgb, var(--bg) 52%, transparent); }
.ph.wait::before { background: var(--code); }
.ph.wait { border: 1px solid var(--rule); display: grid; place-items: center; }
.ph svg { position: relative; width: 28px; height: 28px; color: var(--chrome); fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.ph.link svg, .ph.small svg { display: none; }
.ph .track { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: color-mix(in srgb, var(--chrome) 30%, transparent); }
.ph .track::before { content: ""; display: block; height: 100%; width: calc(var(--p) * 100%); background: var(--caret); }
.ph.error { box-shadow: inset 0 0 0 1.5px var(--bad); }
.ph.error::before { background: color-mix(in srgb, var(--bg) 70%, transparent); }
.ph.error .track, .ph.idle .track, .ph.landed::before { display: none; }
.badge { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 4px 0 8px; border-radius: 999px; white-space: nowrap;
  background: var(--panel-bg); border: 1px solid var(--panel-border); box-shadow: var(--shadow); -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px); font: 500 12px/1 var(--font); color: var(--fg); font-variant-numeric: tabular-nums; pointer-events: auto; }
.badge.plain { padding-right: 10px; }
.badge span { color: var(--soft); font-weight: 400; }
.badge .ring { width: 14px; height: 14px; border-radius: 50%; flex: none;
  background: conic-gradient(var(--caret) calc(var(--p) * 360deg), color-mix(in srgb, var(--chrome) 35%, transparent) 0);
  -webkit-mask: radial-gradient(circle, transparent 4.2px, #000 4.7px); mask: radial-gradient(circle, transparent 4.2px, #000 4.7px); }
.badge .x { all: unset; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; color: var(--soft);
  font: 400 15px/1 var(--font); cursor: pointer; }
.badge .x:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); color: var(--fg); }
.badge.error { display: grid; height: auto; padding: 10px 12px; border-radius: 12px; gap: 8px;
  border-color: color-mix(in srgb, var(--bad) 45%, var(--panel-border)); white-space: normal; width: max-content;
  max-width: min(380px, calc(100vw - 24px)); line-height: 1.4; }
.badge.error .btns { display: flex; gap: 6px; }
.badge.error b { font-weight: 600; color: var(--bad); }
.badge.error .text { font: 400 12.5px/1.4 var(--font); color: var(--fg); }
.badge button:not(.x) { flex: none; height: 26px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--rule); background: transparent;
  color: var(--fg); font: 500 12.5px/1 var(--font); white-space: nowrap; cursor: pointer; }
.badge button.primary { background: color-mix(in srgb, var(--fg) 92%, #000); color: var(--bg); border-color: transparent; font-weight: 600; }
[hidden] { display: none !important; }
`;

/** A badge needs this much of an image to sit on it. */
const BADGE_W = 150,
  BADGE_H = 56;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** What one element shows of its file. */
interface Shown {
  ph: HTMLElement;
  badge: HTMLElement;
  /** What the badge was drawn from. */
  drawn: string;
}

export interface PendingOptions {
  /** The address of the document's files on this origin, with its last "/": an element's address under it is a file's path. */
  base: string;
  /** A button on a file: "cancel", or one of its fixes ("remove", "retry", "raise"). */
  act: (path: string, action: string) => void;
}

export function mountPending(win: Window, o: PendingOptions) {
  const doc = win.document;
  /** This tab's files, the others' (from other tabs and agents), and each own file's picture, by path. */
  let own = new Map<string, PageFile>(),
    others = new Map<string, Pending>();
  const pictures = new Map<string, string>();
  /** A file that just came: its placeholder keeps the picture until the element shows the bytes. */
  const landed = new Map<Element, number>();
  /** The images of the document's files that didn't load: one with a size shows as a box of it (its file may be on its way). */
  const missing = new Set<Element>();
  const shown = new Map<Element, Shown>();
  let dark = false,
    frame = 0;
  /**
   * Each image on its way has its size on the page before its bytes: a style of the page's own (an adopted stylesheet,
   * never a change of the page's elements) gives it a picture in place of the one it can't load yet: this tab's file
   * itself, or an empty one of the size its element says.
   */
  let sheet: CSSStyleSheet | null = null,
    styled = "";
  function size(live: [Element, string][]) {
    const css = live
      .flatMap(([el, path]) => {
        const src = el.localName == "img" ? el.getAttribute("src") : null,
          w = Number(el.getAttribute("width")),
          h = Number(el.getAttribute("height"));
        const url =
          pictures.get(path) ??
          (w > 0 && h > 0 ? `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E` : null);
        return src && url ? [`img[src="${src.replace(/["\\]/g, "\\$&")}"] { content: url("${url}") !important; }`] : [];
      })
      .join("\n");
    if (css == styled) return;
    styled = css;
    if (!sheet) {
      sheet = new (win as Window & typeof globalThis).CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(css);
  }

  /** The file's path an element shows, or null: not a file of this document. */
  const pathOf = (el: Element): string | null => {
    const raw = el.localName == "a" ? (el as HTMLAnchorElement).href : (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    if (!raw || !raw.startsWith(o.base)) return null;
    try {
      return decodeURIComponent(raw.slice(o.base.length).split(/[?#]/)[0]);
    } catch {
      return null;
    }
  };
  const elements = (): [Element, string][] =>
    [...doc.querySelectorAll("img, video, audio, a[href]")].flatMap((el): [Element, string][] => {
      const path = pathOf(el);
      return path && (own.has(path) || others.has(path) || landed.has(el) || (missing.has(el) && el.isConnected)) ? [[el, path]] : [];
    });

  function make(): Shown {
    const box = partsLayer(doc, "erga-pending", STYLE);
    const ph = doc.createElement("div"),
      badge = doc.createElement("div");
    box.append(ph, badge);
    badge.addEventListener("mousedown", (e) => e.preventDefault());
    return { ph, badge, drawn: "" };
  }

  /** Each placeholder at its element, as its file is now; then again at the next frame, while there are some. */
  function place() {
    frame = 0;
    const live = elements();
    size(live);
    const box = live.length || shown.size ? partsLayer(doc, "erga-pending", STYLE) : null;
    box?.classList.toggle("dark", dark);
    for (const [el, s] of shown)
      if (!live.some(([e]) => e == el)) {
        s.ph.remove();
        s.badge.remove();
        shown.delete(el);
      }
    for (const [el, path] of live) {
      const s = shown.get(el) ?? make();
      shown.set(el, s);
      const mine = own.get(path),
        theirs = mine ? undefined : others.get(path),
        r = el.getBoundingClientRect(),
        link = el.localName == "a";
      // (A link's box, a little larger than its text.)
      const x = r.left + win.scrollX - (link ? 2 : 0),
        y = r.top + win.scrollY,
        w = r.width + (link ? 4 : 0),
        h = r.height + (link ? 3 : 0);
      const roomy = !link && w >= BADGE_W && h >= BADGE_H;
      const p = mine ? mine.p : theirs?.got != null && theirs.size ? Math.min(1, theirs.got / theirs.size) : 0;
      const problem = mine?.problem;
      const picture = pictures.get(path);
      s.ph.className = `ph${link ? " link" : ""}${problem ? " error" : ""}${!mine && !landed.has(el) && !link ? " wait" : ""}${roomy ? "" : " small"}${landed.has(el) ? " landed" : ""}${mine || theirs ? "" : " idle"}`;
      s.ph.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;${link ? "border-radius:3px;" : ""}${picture && !link ? `background-image:url("${picture}");` : ""}`;
      const pct = `${Math.round(p * 100)}%`;
      const drawn = JSON.stringify([
        mine ? [pct, mine.text, problem] : theirs ? [pct, theirs.name, theirs.via, path] : s.ph.className,
        roomy,
      ]);
      if (drawn != s.drawn) {
        s.drawn = drawn;
        s.ph.innerHTML = `${!mine && !link && !landed.has(el) ? ICON.image.replace("<svg ", '<svg stroke-width="1.6" ') : ""}<div class="track"></div>`;
        s.badge.dataset.path = path;
        if (problem) {
          s.badge.className = "badge error";
          s.badge.innerHTML = `<div class="text"><b>${esc(problem.lead)}</b> ${esc(problem.text)}</div><div class="btns">${problem.actions
            .map((a) => `<button type="button" data-action="${esc(a.id)}"${a.primary ? ' class="primary"' : ""}>${esc(a.label)}</button>`)
            .join("")}</div>`;
        } else if (mine) {
          s.badge.className = "badge";
          s.badge.innerHTML = `<i class="ring"></i>${pct}<span>${esc(mine.text)}</span><button type="button" class="x" data-action="cancel" aria-label="Cancel" title="Cancel">×</button>`;
        } else if (theirs) {
          s.badge.className = "badge plain";
          s.badge.innerHTML = `<i class="ring"></i>${pct}<span>${esc(path.slice(path.lastIndexOf("/") + 1))} · from ${esc(agentLabel(theirs, null, false).label)}</span>`;
        } else s.badge.innerHTML = "";
      }
      s.ph.style.setProperty("--p", String(p));
      // The badge on an image that has room for it; a problem's under a link, or on the image's foot.
      s.badge.hidden = !s.badge.innerHTML || (!problem && !roomy);
      if (s.badge.hidden) continue;
      let left = x + 10,
        top = y + h - 41;
      if (problem) {
        const bw = s.badge.offsetWidth,
          bh = s.badge.offsetHeight;
        left = Math.max(win.scrollX + 12, Math.min(roomy ? x + 10 : x, win.scrollX + win.innerWidth - bw - 12));
        top = roomy && h > bh + 40 ? y + h - bh - 13 : y + h + (link ? 7 : 10);
      }
      s.badge.style.cssText = `--p:${p};left:${left}px;top:${top}px`;
    }
    // Again at the next frame while a file is on its way (the page moves under it); a box of an image that is only
    // missing moves when the page's height does.
    if (own.size || others.size || landed.size) frame = win.requestAnimationFrame(place);
    else if (!shown.size) doc.querySelector("erga-pending")?.remove();
  }
  const queue = () => void (frame ||= win.requestAnimationFrame(place));

  /** The file is in the document's files now: each element that shows it loads it, and its placeholder goes when it has. */
  function arrived(path: string) {
    for (const el of doc.querySelectorAll("img, video, audio, source")) {
      if (pathOf(el) != path) continue;
      const media = el as HTMLImageElement;
      // (The same address again: the element asks for it again. Its picture stays over it until it has loaded.)
      const gone = () => {
        win.clearTimeout(landed.get(el));
        landed.delete(el);
        if (![...landed.keys()].some((e) => pathOf(e) == path)) drop(path);
        queue();
      };
      landed.set(el, win.setTimeout(gone, 5000));
      media.addEventListener("load", gone, { once: true });
      media.addEventListener("error", gone, { once: true });
      media.setAttribute("src", media.getAttribute("src") ?? "");
    }
    if (![...landed.keys()].some((e) => pathOf(e) == path)) drop(path);
  }
  /** A file's picture is no more needed. */
  function drop(path: string) {
    if (own.has(path)) return;
    const url = pictures.get(path);
    if (url) URL.revokeObjectURL(url);
    pictures.delete(path);
  }

  // An image of the document's files that fails to load, and one that loads after all.
  const failed = (e: Event) => {
    const el = e.target as Element | null;
    if (el?.localName != "img" || !pathOf(el) || !el.getAttribute("width") || !el.getAttribute("height")) return;
    missing.add(el);
    queue();
  };
  const loaded = (e: Event) => void (missing.delete(e.target as Element) && queue());
  const resized = new (win as Window & typeof globalThis).ResizeObserver(() => missing.size && queue());
  if (doc.body) resized.observe(doc.body);
  doc.addEventListener("error", failed, true);
  doc.addEventListener("load", loaded, true);

  const onClick = (e: Event) => {
    const b = (e.target as Element).closest?.("[data-action]"),
      path = b?.closest<HTMLElement>(".badge")?.dataset.path;
    if (b && path) o.act(path, b.getAttribute("data-action")!);
  };

  return {
    /**
     * This tab's files on their way (the viewer says: client/shell/uploads.ts), each with its bytes the first time. One
     * that is no more among them has arrived (the viewer says so: `arrived`), or was cancelled.
     */
    setOwn(files: (PageFile & { file?: File })[]) {
      const next = new Map(files.map((f) => [f.path, f]));
      for (const f of files)
        if (f.file && !pictures.has(f.path) && f.file.type.startsWith("image/")) pictures.set(f.path, URL.createObjectURL(f.file));
      const gone = [...own.keys()].filter((p) => !next.has(p));
      own = next;
      for (const p of gone) drop(p);
      partsLayer(doc, "erga-pending", STYLE).onclick = onClick;
      // (At once: an image dropped just now has its size before the page is painted again.)
      win.cancelAnimationFrame(frame);
      place();
    },
    /** A file of this tab's, at the drop, before the viewer has said a word of it. */
    add(path: string, file: File) {
      this.setOwn([...own.values(), { path, p: 0, text: "", file }]);
    },
    /** The files on their way from anyone (the room says: document/waits.ts). */
    setOthers(files: Record<string, Pending>) {
      const next = new Map(Object.entries(files));
      const gone = [...others.keys()].filter((p) => !next.has(p) && !own.has(p));
      others = next;
      for (const p of gone) arrived(p);
      queue();
    },
    /** The file at `path` is in the document's files now. */
    arrived,
    dark(on: boolean) {
      dark = on;
      queue();
    },
    stop() {
      win.cancelAnimationFrame(frame);
      resized.disconnect();
      doc.removeEventListener("error", failed, true);
      doc.removeEventListener("load", loaded, true);
      sheet?.replaceSync("");
      doc.querySelector("erga-pending")?.remove();
      for (const url of pictures.values()) URL.revokeObjectURL(url);
    },
  };
}

export type PendingFiles = ReturnType<typeof mountPending>;
