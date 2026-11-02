// The shell's hold on the page editor, which runs in the page, in the shell's frame on the document's own origin
// (frame.ts; why, in bridge.ts). It has no text: the page's editor has its own socket and replica. It says edit, with
// the edit key, or view (erga-mode), and mirrors the page's state for the shell's controls. Everything the frame sends
// is checked: the page itself could have sent it.

import { EditorSelection } from "@codemirror/state";
import type { Backdrop, EditMode, FromFrame, Keys, Snapshot, ToFrame } from "../../libs/text/ui/bridge";
import type { InlineStyle, LinkEdit, LinkInfo, PageProblem } from "../../libs/text/ui/editor";
import { clampZoom, type ZoomBy } from "../../libs/text/ui/zoom";

/** What "edit" says, but the zoom and the tests' settings, which the page adds. */
export type EditWord = Omit<Extract<EditMode, { mode: "edit" }>, "type" | "mode" | "zoom" | "paused" | "timescale" | "check">;

export interface RemotePageConfig {
  frame: HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  /** The address of the document's files there (with the token that opens them): another of its pages is at its path under it. */
  files: string;
  /** What "edit" says now: where the room is, a key that holds, the page and this tab's mark. */
  edit: () => Promise<EditWord | null>;
  /** The page's caret moved (`selection` has it). */
  onSelection: () => void;
  /** The page's state changed (`rendered`: it was drawn afresh). */
  onUpdate: (rendered: boolean) => void;
  onKey: (keys: Keys) => void;
  onNotice: (message: string, fix?: string) => void;
  onProblem: (p: PageProblem) => void;
  /** Pointer activity on the page, in the shell's coordinates. */
  onPointer: (kind: "move" | "down" | "up", x: number, y: number) => void;
  onActivity: (kind: "focus" | "key") => void;
  onBackdrop: (b: Backdrop) => void;
  /** The page needs rendering again to show the latest change. */
  onStale: () => void;
  /** A zoom gesture on the page (zoom.ts): the shell sets the level (setZoom). */
  onZoom?: (zoom: ZoomBy) => void;
  /** A link on the page to another of the document's pages was followed (its path in the document). */
  onOpen?: (path: string) => void;
  /** Files dropped or pasted on the page, for the document's files (uploads.ts): the paths they got, in order, and why the rest didn't go in. */
  onFiles?: (files: File[]) => Promise<{ paths: string[]; error: string | null }>;
}

const EMPTY: Snapshot = {
  title: "",
  canPause: false,
  paused: false,
  fmt: { rect: null, blocker: null, has: { strong: false, em: false, code: false, u: false }, text: "", link: null },
};

export class RemotePage {
  /** The page's selection, in its text (the link bar's changes go there). */
  selection = EditorSelection.single(0);
  private readonly frame: HTMLIFrameElement;
  private snapshot: Snapshot = EMPTY;
  /** The level the page is drawn at (zoom.ts). */
  private zoom = 1;
  /** The page is paused (it stays so when it loads again). */
  private paused = false;
  /** In the editor: the page in the frame runs the editor. */
  private active = false;
  private nextId = 1;
  private waiting = new Map<number, (m: FromFrame) => void>();

  constructor(private readonly config: RemotePageConfig) {
    this.frame = config.frame;
    window.addEventListener("message", (e) => {
      if (e.source != this.frame.contentWindow || e.origin != config.origin || typeof e.data?.type != "string") return;
      // A page in the frame (again: it loaded again, or went to another page): the editor in it, if in the editor.
      if (e.data.type == "erga-hello") {
        this.snapshot = EMPTY;
        if (this.active) void this.say();
        return;
      }
      this.receive(e.data as FromFrame);
    });
  }

  /** Into the editor: the page in the frame loads it (client/inline/reader.ts), and it opens its own socket. */
  start(): void {
    this.active = true;
    void this.say();
  }

  /** Out of the editor: the editor in the page stops (the page stays as it is, and the editor keeps its state). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    void this.say();
  }

  /** In the editor, the word again: a new key for the editor's next socket (it's checked as a socket opens). */
  renew(): void {
    if (this.active) void this.say();
  }

  /** Tells the page edit (with what it needs) or view. */
  private async say(): Promise<void> {
    if (!this.active) {
      this.post({ type: "erga-mode", mode: "view" });
      return;
    }
    const word = await this.config.edit();
    if (!word || !this.active) return;
    const { __ergaTimescale: timescale, __ergaCheck: check } = globalThis as { __ergaTimescale?: number; __ergaCheck?: boolean };
    this.post({
      type: "erga-mode",
      mode: "edit",
      ...word,
      zoom: this.zoom,
      ...(this.paused ? { paused: true } : {}),
      ...(timescale ? { timescale } : {}),
      ...(check ? { check } : {}),
    });
  }

  /**
   * Another of the document's pages, in place of this one (the shell went to it without a reload): the frame goes to
   * it (its address under the document's files, in place of this one's: no new entry in the tab's history), whose
   * editor starts afresh there.
   */
  load(path: string): void {
    this.selection = EditorSelection.single(0);
    this.snapshot = EMPTY;
    this.frame.contentWindow?.location.replace(this.config.files + path.split("/").map(encodeURIComponent).join("/"));
  }

  // ------------------------------------------------------------ messages

  private post(m: ToFrame): void {
    // A frame whose page hasn't come yet (its first, empty document is this origin's): the page says hello when it comes.
    try { void this.frame.contentWindow?.location.href; return; } catch { /* the page's own origin: it's there */ }
    this.frame.contentWindow?.postMessage(m, this.config.origin);
  }

  private request<T extends FromFrame>(m: ToFrame & { id: number }, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(m.id); resolve(null); }, timeoutMs);
      this.waiting.set(m.id, (reply) => { clearTimeout(timer); resolve(reply as T); });
      this.post(m);
    });
  }

  private receive(m: FromFrame): void {
    const c = this.config;
    switch (m.type) {
      case "selection": {
        const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
        if (ok(m.anchor) && ok(m.head)) {
          this.selection = EditorSelection.single(m.anchor, m.head);
          c.onSelection();
        }
        return;
      }
      case "update":
        if (isSnapshot(m.snapshot)) this.snapshot = m.snapshot;
        c.onUpdate(!!m.rendered);
        return;
      case "backdrop":
        if (typeof m.backdrop?.color == "string" && typeof m.backdrop.image == "string") c.onBackdrop(m.backdrop);
        return;
      case "stale": c.onStale(); return;
      case "notice": if (typeof m.message == "string") c.onNotice(m.message.slice(0, 500), typeof m.fix == "string" ? m.fix.slice(0, 2000) : undefined); return;
      case "problem":
        if (typeof m.key == "string" && typeof m.message == "string" && typeof m.fix == "string") c.onProblem({ key: m.key.slice(0, 500), message: m.message.slice(0, 500), fix: m.fix.slice(0, 2000) });
        return;
      case "key": if (m.keys && typeof m.keys.key == "string") c.onKey({ key: m.keys.key, metaKey: !!m.keys.metaKey, ctrlKey: !!m.keys.ctrlKey, shiftKey: !!m.keys.shiftKey, altKey: !!m.keys.altKey }); return;
      case "pointer": {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !["move", "down", "up"].includes(m.kind)) return;
        const r = this.frame.getBoundingClientRect();
        c.onPointer(m.kind, m.x + r.left, m.y + r.top);
        return;
      }
      case "zoom": {
        const z = m.zoom as { step?: unknown; by?: unknown } | undefined;
        if (z?.step === 1 || z?.step === -1) c.onZoom?.({ step: z.step });
        else if (typeof z?.by == "number" && z.by > 0.5 && z.by < 2) c.onZoom?.({ by: z.by });
        return;
      }
      case "activity": if (m.kind == "focus" || m.kind == "key") c.onActivity(m.kind); return;
      case "open": if (typeof m.path == "string" && m.path.length < 1000) c.onOpen?.(m.path); return;
      case "upload": {
        const files = Array.isArray(m.files) ? m.files.filter((f): f is File => f instanceof File).slice(0, 50) : [];
        if (!Number.isInteger(m.id) || !files.length || !c.onFiles) return;
        void c
          .onFiles(files)
          .catch((e: Error) => ({ paths: [], error: `Couldn't add the file: ${e.message}` }))
          .then((r) => this.post({ type: "uploaded", id: m.id, paths: r.paths, error: r.error }));
        return;
      }
      case "styled":
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        return;
    }
  }

  // ------------------------------------------------------------ the page

  get canPause(): boolean {
    return this.snapshot.canPause;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  /** The page zooms itself (window.ergaZoom), so the editor's zoom goes to it, not to the frame. */
  get zoomsItself(): boolean { return this.snapshot.zoomsItself === true; }
  /** Zooms a page that zooms itself: `by` times closer, or 0 for its own first view. */
  zoomItself(by: number): void {
    this.post({ type: "pageZoom", by });
  }
  /** Pauses or resumes the page; false if it can't be paused. */
  setPaused(on: boolean): boolean {
    if (on && !this.snapshot.canPause) return false;
    this.paused = on;
    this.post({ type: "paused", on });
    return true;
  }
  title(): string { return this.snapshot.title; }
  /** Where the page is scrolled to, as it last said. */
  get scrollY(): number { const y = Number(this.snapshot.scrollY); return Number.isFinite(y) && y > 0 ? y : 0; }
  render(): void { this.post({ type: "render" }); }
  get zoomLevel(): number { return this.zoom; }
  /**
   * Draws the page at `level` (1 is 100%): its frame scaled (client/styles/editor.css, html.erga-zoomed), and the editor in
   * it told, for what it says in the shell's terms.
   */
  setZoom(level: number): void {
    const z = clampZoom(level);
    if (z == this.zoom) return;
    this.zoom = z;
    // At once, as the browser's own zoom: not the frame's move as the agent's panel opens (its width's transition).
    const root = document.documentElement, f = this.frame;
    f.style.transition = "none";
    if (z == 1) root.style.removeProperty("--erga-zoom"); else root.style.setProperty("--erga-zoom", String(z));
    root.classList.toggle("erga-zoomed", z != 1);
    void f.offsetWidth;
    f.style.transition = "";
    this.renew();
  }
  focus(): void {
    this.frame.focus();
    this.post({ type: "focus" });
  }
  leaveText(): void {
    this.post({ type: "leave" });
  }
  reveal(pos: number): void {
    this.post({ type: "reveal", pos });
  }

  /** The selection's rectangle in the frame's coordinates, or null with nothing to style. */
  selectionRect() { return this.snapshot.fmt.rect; }
  styleBlocker(): string | null { return this.snapshot.fmt.blocker; }
  hasStyle(style: InlineStyle): boolean { return this.snapshot.fmt.has[style]; }
  linkAt(): LinkInfo | null { return this.snapshot.fmt.link; }
  selectedText(): string { return this.snapshot.fmt.text; }
  toggleStyle(style: InlineStyle) { return this.style({ op: "toggle", style }); }
  clearStyles() { return this.style({ op: "clear" }); }
  setLink(edit: LinkEdit) { return this.style({ op: "link", edit }); }
  private async style(op: { op: "toggle"; style: InlineStyle } | { op: "clear" } | { op: "link"; edit: LinkEdit }): Promise<string | null> {
    const reply = await this.request<Extract<FromFrame, { type: "styled" }>>({ type: "style", id: this.nextId++, ...op } as ToFrame & { id: number }, 3000);
    return reply && typeof reply.why == "string" ? reply.why.slice(0, 500) : null;
  }
}

function isSnapshot(s: unknown): s is Snapshot {
  const v = s as Snapshot;
  const isRect = (r: unknown) => r == null || ["left", "top", "width", "bottom"].every((k) => Number.isFinite((r as Record<string, number>)[k]));
  const l = v?.fmt?.link;
  return !!v && typeof v.title == "string" && typeof v.canPause == "boolean" && typeof v.paused == "boolean" && !!v.fmt && typeof v.fmt.has == "object"
    && isRect(v.fmt.rect) && typeof v.fmt.text == "string" && (v.fmt.blocker == null || typeof v.fmt.blocker == "string")
    && (l == null || (typeof l.href == "string" && typeof l.text == "string" && typeof l.self == "boolean" && isRect(l.rect)));
}

