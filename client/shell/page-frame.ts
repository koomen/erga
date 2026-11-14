// The document's page, in the viewer's one frame on its own origin: the viewer's one word to the editor in it (edit,
// with the edit key, or view: libs/text/ui/mode.ts), the zoom the frame is drawn at, and what the page's first script
// (client/inline/reader.ts, Erga's) tells the viewer while editing: the viewer's shortcuts pressed in the page, a press
// on it, a zoom gesture, the wheel sideways on a zoomed page, a link to another of the document's pages, the page's
// problems. The editor itself asks for one thing: the page loaded again (erga-reload), which the viewer does with the
// page's view kept (viewer-frames.ts).
// Everything that comes from the page is checked: the page itself could have sent it.

import type { EditMode } from "../../libs/text/ui/mode";
import type { Word } from "./editor-state";
import type { Keys } from "../common/app-keys";
import { clampZoom, type ZoomBy } from "../common/zoom";
import type { RawProblem } from "./problems";

/** What "edit" says, but the zoom and the tests' settings, which this adds. */
export type EditWord = Omit<Extract<EditMode, { mode: "edit" }>, "type" | "mode" | "zoom" | "tall" | "pinched" | "timescale" | "check">;

export interface PageFrameConfig {
  /** The frame now: a load of the page again puts a new one in its place (client/inline/viewer-frames.ts). */
  frame: () => HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  /** The address of the document's files there (with the token that opens them): another of its pages is at its path under it. */
  files: string;
  /** What the page was told last (editor-state.ts decides it): it's told again when it loads again. */
  told: () => Word;
  /** What "edit" says now, with `key`: where the document is, who this tab is, the page and this tab's mark. */
  edit: (key: string) => EditWord;
  onKey: (keys: Keys) => void;
  /** A press on the page. */
  onPress: () => void;
  /** The pointer moved over the page, in the viewer's coordinates. */
  onPointer: (x: number, y: number) => void;
  onActivity: (kind: "focus" | "key") => void;
  /** A zoom gesture on the page, at `x` in the viewer's coordinates. */
  onZoom: (zoom: ZoomBy, x: number) => void;
  /** The wheel went sideways on the zoomed page, which has nothing to scroll that way: `dx` px on the screen. */
  onPan: (dx: number) => void;
  /** A link on the page to another of the document's pages was followed (its path in the document). */
  onOpen: (path: string) => void;
  /** The page said whether it zooms itself (window.ergaZoom). */
  onZooms: () => void;
  /** A problem the page reported (`base`: the page's folder on its origin, for the names of its files). */
  onProblem: (problem: RawProblem, base: string) => void;
}

export function mountPageFrame(c: PageFrameConfig) {
  /** In the editor: the page in the frame runs the editor. */
  const active = () => c.told().mode == "edit";
  /** The level the page is drawn at (zoom.ts). */
  let zoom = 1;
  /** The height of the frame's place on the screen: what the frame, scaled, covers. */
  let tall = 0;
  /** The browser has the whole window zoomed (its own pinch): the page leaves a pinch to it (zoom.ts, the trap). */
  let pinched = false;
  /** The page zooms itself (window.ergaZoom), so the viewer's zoom goes to it, not to the frame. */
  let zoomsItself = false;

  const post = (m: unknown) => {
    // A frame whose page hasn't come yet (its first, empty document is this origin's): the page says hello when it comes.
    const frame = c.frame();
    try {
      void frame.contentWindow?.location.href;
      return;
    } catch {
      /* the page's own origin: it's there */
    }
    frame.contentWindow?.postMessage(m, c.origin);
  };

  /** Tells the page what it was told last: edit (with what it needs) or view. */
  function say(): void {
    const told = c.told();
    if (told.mode == "view") {
      post({ type: "erga-mode", mode: "view" } satisfies EditMode);
      return;
    }
    const { __ergaTimescale: timescale, __ergaCheck: check } = globalThis as { __ergaTimescale?: number; __ergaCheck?: boolean };
    post({
      type: "erga-mode",
      mode: "edit",
      ...c.edit(told.key),
      zoom,
      tall,
      pinched,
      ...(timescale ? { timescale } : {}),
      ...(check ? { check } : {}),
    } satisfies EditMode);
  }

  const num = (n: unknown): n is number => typeof n == "number" && Number.isFinite(n);
  window.addEventListener("message", (e) => {
    const frame = c.frame();
    if (e.source != frame.contentWindow || e.origin != c.origin || typeof e.data?.type != "string") return;
    const m = e.data as Record<string, unknown> & { type: string };
    // A page in the frame (again: it loaded again, or went to another page): the editor in it, if in the editor.
    if (m.type == "erga-hello") {
      zoomsItself = false;
      if (active()) say();
      // (The frame had the focus: the page that came in it has it, for its editor.)
      if (active() && document.activeElement == frame) frame.focus();
      return;
    }
    if (m.type == "erga-zooms" && zoomsItself != (m.on === true)) {
      zoomsItself = m.on === true;
      c.onZooms();
    }
    if (m.type == "erga-problem" && m.problem && typeof m.base == "string") {
      const p = m.problem as Record<string, unknown>;
      const s = (k: string, max: number) => (typeof p[k] == "string" ? (p[k] as string).slice(0, max) : null);
      if (p.kind == "resource" && s("tag", 50) && s("url", 2000))
        c.onProblem({ kind: "resource", tag: s("tag", 50)!, url: s("url", 2000)! }, m.base);
      else if (p.kind == "script" && s("message", 500) != null)
        c.onProblem(
          {
            kind: "script",
            message: s("message", 500)!,
            file: s("file", 2000) ?? "",
            line: num(p.line) ? p.line : 0,
            stack: s("stack", 4000) ?? undefined,
          },
          m.base
        );
      else if (p.kind == "notice" && s("message", 500) && s("fix", 2000))
        c.onProblem(
          { kind: "notice", message: s("message", 500)!, fix: s("fix", 2000)!, ...(p.draft === true ? { draft: true } : {}) },
          m.base
        );
    }
    if (!active()) return;
    switch (m.type) {
      // The page's editor asks for the page made again from its files (libs/text/ui/frame.ts, reloadNow): with its view kept.
      case "erga-reload":
        window.ergaFrames.reload("?erga-edit");
        return;
      case "erga-key": {
        const k = m.keys as Record<string, unknown> | undefined;
        if (k && typeof k.key == "string")
          c.onKey({ key: k.key, metaKey: !!k.metaKey, ctrlKey: !!k.ctrlKey, shiftKey: !!k.shiftKey, altKey: !!k.altKey });
        return;
      }
      case "erga-press":
        c.onPress();
        return;
      case "erga-pointer": {
        if (!num(m.x) || !num(m.y) || m.tap) return;
        const r = frame.getBoundingClientRect();
        c.onPointer(r.left + m.x * zoom, r.top + m.y * zoom);
        return;
      }
      case "erga-activity":
        if (m.kind == "focus" || m.kind == "key") c.onActivity(m.kind as "focus" | "key");
        return;
      case "erga-zoom": {
        const z = m.zoom as { step?: unknown; by?: unknown } | undefined;
        const x = frame.getBoundingClientRect().left + (num(m.x) ? m.x : frame.offsetWidth / 2) * zoom;
        if (z?.step === 1 || z?.step === -1) c.onZoom({ step: z.step }, x);
        else if (typeof z?.by == "number" && z.by > 0.5 && z.by < 2) c.onZoom({ by: z.by }, x);
        return;
      }
      case "erga-pan":
        if (num(m.dx) && Math.abs(m.dx) < 5000) c.onPan(m.dx * zoom);
        return;
      case "erga-open":
        if (typeof m.path == "string" && m.path.length < 1000) c.onOpen(m.path);
        return;
    }
  });

  return {
    /**
     * Tells the page what it was told last, as it changed. Edit: the page in the frame loads the editor
     * (client/inline/reader.ts), which opens its own socket; again, a new key for its next socket (it's checked as a socket
     * opens). View: the editor in the page stops (the page stays as it is, and the editor keeps its state).
     */
    say,
    /**
     * Another of the document's pages, in place of this one (the viewer went to it without a reload): the frame goes to
     * it (its address under the document's files, in place of this one's: no new entry in the tab's history), whose
     * editor starts afresh there.
     */
    load(path: string) {
      c.frame().contentWindow?.location.replace(c.files + path.split("/").map(encodeURIComponent).join("/"));
    },
    focus() {
      c.frame().focus();
    },
    get zoomsItself() {
      return zoomsItself;
    },
    /** Zooms a page that zooms itself: `by` times closer, or 0 for its own first view. */
    zoomItself(by: number) {
      post({ type: "erga-page-zoom", by });
    },
    /**
     * Draws the page at `level` (1 is 100%), moved `x` px sideways from the middle: its frame scaled (client/styles/editor.css,
     * html.erga-zoomed), and the editor in it told the level, for its controls (they keep their own size) and its place
     * (client/inline/reader.ts). `pinching`: a pinch is going on. `windowZoomed`: the browser has the window zoomed itself.
     */
    setZoom(level: number, x: number, pinching: boolean, windowZoomed: boolean) {
      const z = clampZoom(level),
        root = document.documentElement,
        was = `${zoom} ${tall} ${pinched}`;
      zoom = z;
      pinched = windowZoomed;
      if (z == 1) root.style.removeProperty("--erga-zoom");
      else root.style.setProperty("--erga-zoom", String(z));
      if (x) root.style.setProperty("--erga-x", `${Math.round(x * 100) / 100}px`);
      else root.style.removeProperty("--erga-x");
      root.classList.toggle("erga-zoomed", z != 1);
      root.classList.toggle("erga-zooming", pinching);
      tall = Math.round(c.frame().getBoundingClientRect().height * 100) / 100;
      if (was != `${zoom} ${tall} ${pinched}` && active()) say();
    },
  };
}

export type PageFrame = ReturnType<typeof mountPageFrame>;
