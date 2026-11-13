// The band's colour and the page's canvas on a document's page (server/pages/viewer.ts), as the page tells them
// (server/pages/reader.ts); the page shows once that's painted, so a first visit's page shows only under its own colour.

import { insetOf, seatOf } from "../common/top-room";

/** The page's canvas, as the page in the frame says it is (server/pages/reader.ts, canvas). */
type Canvas = {
  image?: unknown;
  color?: unknown;
  size?: unknown;
  position?: unknown;
  repeat?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  tile?: unknown;
  fixed?: unknown;
  zoom?: unknown;
  files?: unknown[];
};
type Look = {
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
};

export default function viewerBand(): void {
  const id = document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content;
  // The page's canvas (pages/reader.ts, canvas), behind the frame, reaching out from it over the band and the room beside
  // the page, and scrolled with the page. Its layers are placed against the page's root box (the <i>'s content box), as
  // the browser places the canvas's. A pattern ("tile") carries on in its tiles all round; anything else (a gradient
  // across the page) carries on as the page's edges: the edge's row or column of pixels (a <b> that shows only that line),
  // stretched out (scaled) over the band and the room beside. Below, it repeats, as the page itself does there. Until the
  // frame says, the canvas this document had last time on this browser, if it was gradients only.
  const room = document.querySelector(".erga-canvas")!,
    sheet = room.firstElementChild as HTMLElement,
    KEY = "erga:canvas:v1:" + id,
    FAR = 4000;
  let canvas: { fixed: boolean; zoom: number } | null = null,
    urls: string[] = [],
    sx = 0,
    sy = 0;
  const px = (n: number) => (Number.isFinite(n) ? n : 0) + "px";
  // (At the page's scale, when the editor zooms it: libs/text/ui/zoom.ts.)
  function scrolled() {
    const k = canvas ? canvas.zoom : 1,
      at = canvas && !canvas.fixed ? `translate(${px(-sx * k)}, ${px(-sy * k)})` : "";
    sheet.style.transformOrigin = "0 0";
    sheet.style.transform = k == 1 ? at : `${at} scale(${k})`;
  }
  function paintCanvas(c: Canvas | null, files: unknown[] | undefined) {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    sheet.replaceChildren();
    canvas = null;
    if (!c || typeof c.image != "string" || !c.image) return scrolled();
    let image = c.image;
    // Its images: the files sent (erga-file:n), each at an address of this page's own; nothing else.
    // (Gradients and colours only besides: no escapes, which could spell url( another way, and no other function.)
    const rest = image.replace(/url\("erga-file:\d+"\)/g, "");
    if (
      /[\\]/.test(rest) ||
      (rest.match(/[\w-]+(?=\()/g) || []).some(
        (f) => !/^(repeating-)?(linear|radial|conic)-gradient$|^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|calc)$/i.test(f)
      ) ||
      /\(/.test(rest.replace(/[\w-]+\(/g, ""))
    )
      return scrolled();
    image = image.replace(/url\("erga-file:(\d+)"\)/g, (_, n: string) => {
      const f = files?.[Number(n)];
      if (!(f instanceof Blob) || !/^image\//.test(f.type)) return "none";
      const u = URL.createObjectURL(f);
      urls.push(u);
      return `url("${u}")`;
    });
    const look = {
      backgroundColor: c.color,
      backgroundImage: image,
      backgroundSize: c.size,
      backgroundPosition: c.position,
      backgroundRepeat: c.repeat,
    } as Record<keyof Look, unknown>;
    const ok: Look = {
      backgroundColor: "color",
      backgroundImage: "background-image",
      backgroundSize: "background-size",
      backgroundPosition: "background-position",
      backgroundRepeat: "background-repeat",
    };
    for (const k in look) {
      const v = look[k as keyof Look];
      if (typeof v != "string" || (v && !CSS.supports(ok[k as keyof Look], v))) look[k as keyof Look] = "";
    }
    if (!look.backgroundImage) return scrolled();
    const x = Number(c.x),
      y = Number(c.y),
      w = Math.max(1, Number(c.w) || 0),
      h = Math.max(1, Number(c.h) || 0);
    const sheetOf = (at: HTMLElement, l: number, t: number, extra?: Partial<CSSStyleDeclaration>) => {
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
        [x, y - 1, w, 1, 0, "50% 100%", `scaleY(${FAR})`],
        [x - 1, y, 1, h, 0, "100% 50%", `scaleX(${FAR})`],
        [x + w, y, 1, h, 1 - w, "0 50%", `scaleX(${FAR})`],
        [x - 1, y - 1, 1, 1, 0, "100% 100%", `scale(${FAR})`],
        [x + w, y - 1, 1, 1, 1 - w, "0 100%", `scale(${FAR})`],
      ] as [number, number, number, number, number, string, string][]) {
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
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) || "null");
    if (kept) paintCanvas(kept, []);
  } catch {}
  // The room a scrolling page keeps at its top for the bars (client/common/top-room.ts): the band's height, in the page's
  // own pixels (the editor's zoom), told to the page as it starts and when either changes (in full screen too: the page
  // doesn't move as it goes in and out). With it, what the bars and the agent's panel cover of a frame over the whole
  // window (insetOf), for a page that keeps clear of them itself. The page says its seat (client/common/top-room.ts), and
  // its frame is below the band (erga-fills) or over the whole window (erga-whole: viewer-band.css), here and next time.
  const root = document.documentElement,
    probe = document.createElement("div");
  probe.style.cssText =
    "position: fixed; top: 0; width: 0; height: var(--band-h); padding: 0 var(--frame-r, 0px) 0 var(--frame-l, 0px); visibility: hidden; pointer-events: none";
  document.body.append(probe);
  let roomSaid = "";
  function tellRoom(again?: boolean) {
    const scale = ergaFrames.scale(),
      band = probe.offsetHeight,
      cs = getComputedStyle(probe),
      inset = insetOf(band, parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight), scale, root.classList.contains("erga-full")),
      room = { type: "erga-room", px: Math.round((band / scale) * 100) / 100, inset },
      said = JSON.stringify(room);
    if (!again && said == roomSaid) return;
    roomSaid = said;
    ergaFrames.send(room);
  }
  new MutationObserver(() => tellRoom()).observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  addEventListener("resize", () => tellRoom());
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e)) return;
    if (e.data?.type == "erga-hello") return tellRoom(true);
    if (e.data?.type == "erga-seat") {
      const seat = seatOf(e.data.seat == "below", e.data.seat == "whole");
      root.classList.toggle("erga-fills", seat == "below");
      root.classList.toggle("erga-whole", seat == "whole");
      try {
        if (seat != "under") localStorage.setItem("erga:seat:v1:" + id, seat);
        else localStorage.removeItem("erga:seat:v1:" + id);
      } catch {}
      return;
    }
    if (e.data?.type == "erga-scroll") {
      sx = Number(e.data.sx) || 0;
      sy = Number(e.data.sy) || 0;
      return scrolled();
    }
    if (e.data?.type == "erga-canvas") {
      const c = e.data.canvas;
      // (In the page's own terms: the shell draws it at the scale it draws the page, the editor's zoom.)
      if (c && typeof c == "object") c.zoom = ergaFrames.scale();
      paintCanvas(c, c?.files);
      try {
        if (c && !c.files?.length) localStorage.setItem(KEY, JSON.stringify({ ...c, files: [] }));
        else localStorage.removeItem(KEY);
      } catch {}
      return;
    }
    if (e.data?.type != "erga-band") return;
    const c = e.data.color;
    if (typeof c != "string" || c.length > 200 || /url\(/i.test(c)) return;
    window.ergaBand(id, c);
    // Painted: the page shows (it waited, on a first visit: viewer-band-wait.ts).
    requestAnimationFrame(() => document.documentElement.classList.remove("erga-band-wait"));
  });
}
