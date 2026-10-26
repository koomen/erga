// The shell's hold on the page editor, which runs in the page, in the shell's
// frame on the document's own origin (frame.ts; why, in bridge.ts). It keeps the shell's
// copy of the text (the room's, exactly) and numbers every change, takes the
// frame's edits when they fit, and mirrors the page's state for the shell's
// controls. Everything the frame sends is checked: the page itself could
// have sent it.

import { EditorState, Transaction, type ChangeSet, type Extension, type StateField } from "@codemirror/state";
import {
  Authority,
  changesFrom,
  selectionFrom,
  stateJSON,
  type Backdrop,
  type FromFrame,
  type Keys,
  type Snapshot,
  type ToFrame,
} from "../page-editor/bridge";
import type { HeldInput, InlineStyle, LinkEdit, LinkInfo, MarkAuthor, PageProblem, Peer } from "../page-editor/editor";
import { EVAL_MAX_JSON, viewWait, type ViewRequest, type ViewResult } from "../../shared/agent-log";
import type { LiveRequest, LiveResult } from "../../shared/live-page";
import { changesBetween } from "../../document/merge";
import { clampZoom, type ZoomBy } from "../page-editor/zoom";
import { sleep } from "../../shared/time";

export interface RemotePageConfig {
  frame: HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  /** The address of the document's files there (with the token that opens them): another of its pages is at its path under it. */
  files: string;
  text: string;
  self: MarkAuthor;
  tracking: boolean;
  /** An edit made on the page, accepted: the shell's text has it now. */
  onLocal: (changes: ChangeSet) => void;
  /** The page's caret moved (the shell's state has the new selection). */
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
  /** Where the caret starts, and where the page is scrolled to once it renders (a reload for a new release kept them: live.ts). */
  selection?: { anchor: number; head: number };
  scroll?: number;
  /** A link on the page to another of the document's pages was followed (its path in the document). */
  onOpen?: (path: string) => void;
  /** Resolves once the room has every edit this tab made (the page that loads again is made from the room's text). */
  flushed?: () => Promise<unknown>;
}

/** What the source view's state is made with: its extensions, and the field its undo history is in. */
export interface SourceState { extensions: Extension; history: StateField<unknown> }

const EMPTY: Snapshot = { title: "", canPause: false, paused: false, fmt: { rect: null, blocker: null, has: { strong: false, em: false, code: false }, text: "", link: null } };

export class RemotePage {
  /** The text and the page's selection, as the shell (and the room) has them. */
  state: EditorState;
  private readonly frame: HTMLIFrameElement;
  private readonly authority = new Authority();
  private snapshot: Snapshot = EMPTY;
  private tracking: boolean;
  /** The level the page is drawn at (zoom.ts). */
  private zoom = 1;
  /** While the source view holds the text: the frame is set aside until `attach`. */
  private detached = false;
  private ready = false;
  /** In the editor: the page in the frame runs the editor (it asks the page for it as the page comes: start). */
  private active = false;
  /** The page's editor's last state (undo history and all), for the next one: as the page loads again, or back into the editor. */
  private carry: unknown = null;
  /** And where the reader was on the page that loads again (the text on its top line), to show there again. */
  private carryView: { pos: number; top: number } | null = null;
  /** While the page loads again with the focus: what holds the keys meanwhile (here, in the shell), and the keys. */
  private sink: HTMLTextAreaElement | null = null;
  private held: HeldInput[] = [];
  private queue: ToFrame[] = [];
  private nextId = 1;
  private waiting = new Map<number, (m: FromFrame) => void>();

  constructor(private readonly config: RemotePageConfig) {
    this.frame = config.frame;
    this.tracking = config.tracking;
    const sel = config.selection && selectionFrom(config.selection.anchor, config.selection.head, config.text.length);
    this.state = EditorState.create({ doc: config.text, ...(sel ? { selection: sel } : {}) });
    window.addEventListener("message", (e) => {
      if (e.source != this.frame.contentWindow || e.origin != config.origin || typeof e.data?.type != "string") return;
      // A page in the frame (again: it loaded again, or went to another page): its editor, if in the editor.
      if (e.data.type == "erga-hello") { this.ready = false; if (this.active) this.ask(); return; }
      this.receive(e.data as FromFrame);
    });
  }

  /** Into the editor: the page in the frame loads it (server/pages/reader.ts), and answers "ready" once it's there. */
  start(): void {
    this.active = true;
    this.ask();
  }

  private ask(): void {
    // A frame whose page hasn't come yet (its first, empty document is this origin's): the page says hello when it comes.
    try { void this.frame.contentWindow?.location.href; return; } catch { /* the page's own origin: it's there */ }
    this.frame.contentWindow?.postMessage({ type: "erga-edit" }, this.config.origin);
  }

  /**
   * Out of the editor: the editor in the page stops once its edits are in (the page stays as it is), and its state
   * (undo history and all) is kept for the way back in.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (!this.ready) return;
    const id = this.nextId++;
    const reply = await this.request<Extract<FromFrame, { type: "stopped" }>>({ type: "stop", id }, 3000);
    if (reply?.state) this.carry = reply.state;
    if (!this.active) this.ready = false;
  }

  /**
   * Another of the document's pages, in place of this one (the shell went to it without a reload): the shell's state
   * is its text from now on, and the frame goes to it (its address under the document's files, in place of this one's:
   * no new entry in the tab's history), whose editor starts from that state, with an undo history of its own. Its
   * numbering moves on by one, so an edit of the last page still on its way from the frame never fits the new one.
   */
  load(page: { path: string; text: string }): void {
    const c = this.config;
    c.scroll = undefined;
    this.state = EditorState.create({ doc: page.text });
    this.authority.reset(this.authority.version + 1);
    this.snapshot = EMPTY;
    this.detached = false;
    this.carry = null;
    this.carryView = null;
    this.ready = false;
    // What was queued for the last page is of no use.
    this.queue = [];
    this.frame.contentWindow?.location.replace(c.files + page.path.split("/").map(encodeURIComponent).join("/"));
  }

  // ------------------------------------------------------------ messages

  private post(m: ToFrame): void {
    if (!this.ready && m.type != "init") { this.queue.push(m); return; }
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
      case "ready": {
        // A frame that (re)loads starts from the shell's state (once: it may say so twice.
        if (this.ready) return;
        this.ready = true;
        this.authority.reset();
        const timescale = (globalThis as { __ergaTimescale?: number }).__ergaTimescale;
        this.post({ type: "init", state: this.state.toJSON(), version: this.authority.version, self: c.self, tracking: this.tracking, ...(timescale ? { timescale } : {}), ...(c.scroll ? { scroll: c.scroll } : {}), ...(this.zoom != 1 ? { zoom: this.zoom } : {}), ...(this.carry ? { carry: this.carry } : {}), ...(this.carryView ? { view: this.carryView } : {}), ...(this.sink ? { held: this.held, focus: true } : {}), frame: { sandbox: this.frame.getAttribute("sandbox"), allow: this.frame.getAttribute("allow") }, ...(this.snapshot.paused ? { paused: true } : {}) });
        this.carry = null;
        this.carryView = null;
        if (this.sink) {
          // The keys held go to the page's editor with its start (above); the focus goes back to the page.
          const had = document.activeElement == this.sink;
          this.sink.remove();
          this.sink = null;
          this.held = [];
          if (had) this.frame.focus();
        }
        // Only the first frame: one that loads again later starts where it renders.
        c.scroll = undefined;
        // A focus asked for before the frame was up only if the frame still has it: focus moved on since (the pages
        // card opened, the agent's box) stays where it went.
        for (const q of this.queue.splice(0)) if (q.type != "focus" || document.activeElement == this.frame) this.post(q);
        return;
      }
      case "push": {
        if (this.detached || m.version != this.authority.version) { this.post({ type: "reject" }); return; }
        const changes = changesFrom(m.changes, this.state.doc.length);
        // An edit that doesn't fit isn't one the editor made: start the frame again from the shell's text.
        if (!changes) { this.resync(); return; }
        this.state = this.state.update({ changes }).state;
        this.authority.record(changes);
        this.post({ type: "ack" });
        c.onLocal(changes);
        return;
      }
      case "selection": {
        if (this.detached || m.version != this.authority.version) return;
        const sel = selectionFrom(m.anchor, m.head, this.state.doc.length);
        if (sel) { this.state = this.state.update({ selection: sel }).state; c.onSelection(); }
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
      case "resync": if (!this.detached) this.resync(); return;
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
      // The page loads again: its editor's state goes to the one in the page that comes (its init).
      case "reloading": {
        this.carry = m.state;
        // (Only keys that were going to the page anyway: the page itself can say this, and mustn't take the focus from the shell.)
        if (m.focus === true && document.activeElement == this.frame) this.holdKeys();
        // It loads again once the room has its edits (else it would come made from the text before them, and load again).
        void Promise.race([c.flushed?.(), sleep(3000)]).then(() => this.frame.contentWindow?.postMessage({ type: "reload" }, c.origin));
        const v = m.view;
        this.carryView = v && Number.isInteger(v.pos) && v.pos >= 0 && Number.isFinite(v.top) ? { pos: v.pos, top: v.top } : null;
        this.ready = false;
        return;
      }
      case "detached": case "styled": case "captured": case "lived": case "stopped":
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        return;
    }
  }

  /**
   * The page loads again with the focus: the keys typed meanwhile would go nowhere (a page that's going), so a stand-in
   * here takes them, and the page's editor applies them first once it's up (its init: held), as a key typed while the
   * page renders always was. The shell's own shortcuts still work meanwhile.
   */
  private holdKeys(): void {
    if (this.sink) return;
    const sink = this.sink = document.createElement("textarea");
    sink.tabIndex = -1;
    sink.setAttribute("aria-hidden", "true");
    sink.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;resize:none";
    sink.addEventListener("keydown", (e) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.key == "Escape") return;
      e.preventDefault();
      this.held.push({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    });
    sink.addEventListener("beforeinput", (e) => { e.preventDefault(); this.held.push({ input: e.inputType, data: e.data }); });
    document.body.append(sink);
    sink.focus({ preventScroll: true });
  }

  /** Starts the frame afresh from the shell's text (it loses its undo history, which no longer fits). */
  private resync(): void {
    console.warn("page editor: the frame is out of step with the room; resyncing");
    this.authority.reset();
    this.post({ type: "attach", state: this.state.toJSON(), version: this.authority.version });
  }

  // ------------------------------------------------------------ the text

  /** Someone else's edit, from the room: the shell's copy takes it now, the page as soon as it can. */
  applyExternal(changes: ChangeSet, author: MarkAuthor | null): void {
    // Set aside, the source view has the text; the frame gets it back whole (`attach`).
    if (changes.empty || this.detached) return;
    this.state = this.state.update({ changes }).state;
    this.authority.record(changes);
    this.post({ type: "external", changes: changes.toJSON(), author, length: this.state.doc.length });
  }

  /** An edit the page didn't make (the source view's), for the change marks. */
  recordAuthorship(changes: ChangeSet, author: MarkAuthor | null): void {
    this.post({ type: "authorship", changes: changes.toJSON(), author });
  }

  /**
   * Hands the text to the source view: the frame's state, undo history and
   * all, once its edits are in, made with the source view's extensions and its history's field (source-view.ts, which
   * loads the first time the view opens). Until `attach`, the shell's text is the source view's.
   */
  async detach(source: SourceState): Promise<{ state: EditorState }> {
    const id = this.nextId++;
    const reply = await this.request<Extract<FromFrame, { type: "detached" }>>({ type: "detach", id }, 3000);
    this.detached = true;
    const fallback = () => EditorState.create({ doc: this.state.doc, selection: this.state.selection, extensions: source.extensions });
    if (!reply) return { state: fallback() };
    let state: EditorState;
    try { state = EditorState.fromJSON(reply.state, { extensions: source.extensions }, { history: source.history }); } catch { return { state: fallback() }; }
    // Anything the frame hadn't seen yet when it answered.
    const missed = typeof reply.version == "number" ? this.authority.since(reply.version) : null;
    if (missed) for (const changes of missed) {
      if (changes.length != state.doc.length) { state = fallback(); break; }
      state = state.update({ changes, annotations: Transaction.addToHistory.of(false) }).state;
    }
    if (!missed || !state.doc.eq(this.state.doc)) {
      // Out of step: keep the history if the text can be brought in line, else start from the shell's text.
      try { state = state.update({ changes: changesBetween(state.doc.toString(), this.state.doc.toString()), annotations: Transaction.addToHistory.of(false) }).state; } catch { state = fallback(); }
    }
    return { state };
  }

  /** Back from the source view: the page carries on from its state (`history`: the field its undo history is in). */
  attach(state: EditorState, history: StateField<unknown>): void {
    this.state = EditorState.create({ doc: state.doc, selection: state.selection });
    this.detached = false;
    this.authority.reset();
    this.post({ type: "attach", state: stateJSON(state, history), version: this.authority.version });
  }

  // ------------------------------------------------------------ the page

  /** In the editor, and the editor in the page isn't up yet (the page loads again, or comes). */
  get loading(): boolean { return this.active && !this.ready; }
  get isTracking(): boolean { return this.tracking; }
  setTracking(on: boolean): void { this.tracking = on; this.post({ type: "tracking", on }); }
  get canPause(): boolean { return this.snapshot.canPause; }
  get isPaused(): boolean { return this.snapshot.paused; }
  /** The page zooms itself (window.ergaZoom), so the editor's zoom goes to it, not to the frame. */
  get zoomsItself(): boolean { return this.snapshot.zoomsItself === true; }
  /** Zooms a page that zooms itself: `by` times closer, or 0 for its own first view. */
  zoomItself(by: number): void { if (this.ready) this.post({ type: "pageZoom", by }); }
  /** Pauses or resumes the page; false if it can't be paused. */
  setPaused(on: boolean): boolean {
    if (on && !this.snapshot.canPause) return false;
    this.snapshot = { ...this.snapshot, paused: on };
    this.post({ type: "paused", on });
    return true;
  }
  title(): string { return this.snapshot.title; }
  /** Where the page is scrolled to, as it last said. */
  get scrollY(): number { const y = Number(this.snapshot.scrollY); return Number.isFinite(y) && y > 0 ? y : 0; }
  render(): void { this.post({ type: "render" }); }
  get zoomLevel(): number { return this.zoom; }
  /**
   * Draws the page at `level` (1 is 100%): its frame scaled (client/editor.html, html.erga-zoomed), and the editor in
   * it told, for what it says in the shell's terms (a frame not up yet starts at it: its init).
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
    if (this.ready) this.post({ type: "zoom", level: z });
  }
  focus(): void { this.frame.focus(); this.post({ type: "focus" }); }
  reveal(pos: number): void { this.post({ type: "reveal", pos }); }
  setPeers(peers: Peer[]): void { this.post({ type: "peers", peers }); }

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

  /** The agent's request to the live page (shared/live-page.ts): the frame answers from its logs, or acts. */
  async live(req: LiveRequest, wait: number): Promise<LiveResult> {
    const reply = await this.request<Extract<FromFrame, { type: "lived" }>>({ type: "live", id: this.nextId++, req }, wait);
    const r = reply?.result;
    // (The page could have sent anything: it goes to the agent as data, cut to size by the host.)
    return r && typeof r == "object" ? r : { error: "The page didn't answer in time." };
  }

  /** The agent's look at the page: the frame renders it, with `text` if the source view has newer. */
  async capture(req: ViewRequest): Promise<ViewResult> {
    const reply = await this.request<Extract<FromFrame, { type: "captured" }>>({ type: "capture", id: this.nextId++, req, ...(this.detached ? { text: this.state.doc.toString() } : {}) }, viewWait(req));
    const r = reply?.result;
    if (!r) return { width: 0, height: 0, errors: [], error: "The page didn't send a picture back in time." };
    return {
      ...(typeof r.png == "string" ? { png: r.png } : {}),
      width: Number(r.width) || 0, height: Number(r.height) || 0,
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e == "string").slice(0, 50) : [],
      ...(r.viewport && Number.isFinite(r.viewport.width) && Number.isFinite(r.viewport.height) ? { viewport: { width: Number(r.viewport.width), height: Number(r.viewport.height) } } : {}),
      ...(r.colorScheme == "light" || r.colorScheme == "dark" ? { colorScheme: r.colorScheme } : {}),
      ...(Array.isArray(r.fonts) ? { fonts: r.fonts.filter((f) => f && typeof f.family == "string").slice(0, 10).map((f) => ({ family: f.family.slice(0, 100), ...(typeof f.wanted == "string" ? { wanted: f.wanted.slice(0, 100) } : {}), elements: Number(f.elements) || 0, tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t == "string").slice(0, 5) : [] })) } : {}),
      ...(Array.isArray(r.pending) && r.pending.length ? { pending: r.pending.filter((p): p is string => typeof p == "string").slice(0, 20).map((p) => p.slice(0, 200)) } : {}),
      ...(typeof r.note == "string" ? { note: r.note } : {}),
      ...(typeof r.error == "string" ? { error: r.error } : {}),
      ...(typeof r.value == "string" ? { value: r.value.slice(0, EVAL_MAX_JSON + 100) } : {}),
    };
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

