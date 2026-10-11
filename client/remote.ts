// The shell's hold on the page editor, which runs in a frame on the
// document's own origin (frame.ts; why, in bridge.ts). It keeps the shell's
// copy of the text (the room's, exactly) and numbers every change, takes the
// frame's edits when they fit, and mirrors the page's state for the shell's
// controls. Everything the frame sends is checked: the page itself could
// have sent it.

import { EditorState, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
import { historyField } from "@codemirror/commands";
import { Authority, changesFrom, selectionFrom, stateJSON, type Backdrop, type FromFrame, type Keys, type Snapshot, type ToFrame } from "./bridge";
import type { InlineStyle, Kind, MarkAuthor, PageProblem, Peer } from "./editor";
import { EVAL_MAX_JSON, viewWait, type ViewRequest, type ViewResult } from "../shared/agent-log";
import { changesBetween } from "../document/merge";

export interface RemotePageConfig {
  frame: HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  kind: Kind;
  /** The folder the page is in, inside the document ("" at its root): where its relative links and assets resolve. */
  dir?: string;
  text: string;
  markdownHead: string;
  self: MarkAuthor;
  tracking: boolean;
  /** The extensions of the shell's own state (the source view's), for states that come back from the frame. */
  extensions: Extension;
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
  /** Where the caret starts, and where the page is scrolled to once it renders (a reload for a new release kept them: live.ts). */
  selection?: { anchor: number; head: number };
  scroll?: number;
  /** A link on the page to another of the document's pages was followed (its path in the document). */
  onOpen?: (path: string) => void;
}

const EMPTY: Snapshot = { title: "", column: 0, canPause: false, paused: false, fmt: { rect: null, blocker: null, has: { strong: false, em: false, code: false }, link: null } };

export class RemotePage {
  /** The text and the page's selection, as the shell (and the room) has them. */
  state: EditorState;
  kind: Kind;
  private readonly frame: HTMLIFrameElement;
  private readonly authority = new Authority();
  private snapshot: Snapshot = EMPTY;
  private tracking: boolean;
  /** While the source view holds the text: the frame is set aside until `attach`. */
  private detached = false;
  private ready = false;
  private queue: ToFrame[] = [];
  private nextId = 1;
  private waiting = new Map<number, (m: FromFrame) => void>();

  constructor(private readonly config: RemotePageConfig) {
    this.kind = config.kind;
    this.frame = config.frame;
    this.tracking = config.tracking;
    const sel = config.selection && selectionFrom(config.selection.anchor, config.selection.head, config.text.length);
    this.state = EditorState.create({ doc: config.text, ...(sel ? { selection: sel } : {}) });
    window.addEventListener("message", (e) => {
      if (e.source != this.frame.contentWindow || e.origin != config.origin || typeof e.data?.type != "string") return;
      // The frame's host page is up (again: it reloaded): ask it for the editor afresh.
      if (e.data.type == "erga-host") { this.ready = false; this.start(); return; }
      this.receive(e.data as FromFrame);
    });
  }

  /**
   * Asks the frame for the editor (server/routes.ts: its host page shows the page as
   * it renders until then): it answers "ready" once the editor is loaded.
   */
  start(): void {
    this.frame.contentWindow?.postMessage({ type: "erga-edit" }, this.config.origin);
  }

  /**
   * Another of the document's pages, in place of this one (the shell went to it without a reload): the shell's state
   * is its text from now on, and the frame's (it renders it from its top, with an undo history of its own). Its numbering
   * moves on by one, so an edit of the last page still on its way from the frame never fits the new one.
   */
  load(page: { kind: Kind; dir: string; text: string; extensions: Extension }): void {
    const c = this.config;
    this.kind = page.kind;
    c.kind = page.kind;
    c.dir = page.dir;
    c.extensions = page.extensions;
    c.scroll = undefined;
    this.state = EditorState.create({ doc: page.text });
    this.authority.reset(this.authority.version + 1);
    this.snapshot = EMPTY;
    this.detached = false;
    // What was queued for the last page is of no use; a frame not up yet starts on the new one (its init).
    this.queue = [];
    if (this.ready) this.post({ type: "page", kind: page.kind, dir: page.dir, state: this.state.toJSON(), version: this.authority.version });
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
        this.post({ type: "init", kind: this.kind, dir: c.dir ?? "", state: this.state.toJSON(), version: this.authority.version, markdownHead: c.markdownHead, self: c.self, tracking: this.tracking, ...(timescale ? { timescale } : {}), ...(c.scroll ? { scroll: c.scroll } : {}) });
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
      case "activity": if (m.kind == "focus" || m.kind == "key") c.onActivity(m.kind); return;
      case "open": if (typeof m.path == "string" && m.path.length < 1000) c.onOpen?.(m.path); return;
      case "detached": case "styled": case "captured":
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
        return;
    }
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
   * all, once its edits are in. Until `attach`, the shell's text is the source view's.
   */
  async detach(): Promise<{ state: EditorState }> {
    const id = this.nextId++;
    const reply = await this.request<Extract<FromFrame, { type: "detached" }>>({ type: "detach", id }, 3000);
    this.detached = true;
    const fallback = () => EditorState.create({ doc: this.state.doc, selection: this.state.selection, extensions: this.config.extensions });
    if (!reply) return { state: fallback() };
    let state: EditorState;
    try { state = EditorState.fromJSON(reply.state, { extensions: this.config.extensions }, { history: historyField }); } catch { return { state: fallback() }; }
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

  /** Back from the source view: the page carries on from its state. */
  attach(state: EditorState): void {
    this.state = EditorState.create({ doc: state.doc, selection: state.selection });
    this.detached = false;
    this.authority.reset();
    this.post({ type: "attach", state: stateJSON(state, historyField), version: this.authority.version });
  }

  // ------------------------------------------------------------ the page

  get isTracking(): boolean { return this.tracking; }
  setTracking(on: boolean): void { this.tracking = on; this.post({ type: "tracking", on }); }
  get canPause(): boolean { return this.snapshot.canPause; }
  get isPaused(): boolean { return this.snapshot.paused; }
  /** Pauses or resumes the page; false if it can't be paused. */
  setPaused(on: boolean): boolean {
    if (on && !this.snapshot.canPause) return false;
    this.snapshot = { ...this.snapshot, paused: on };
    this.post({ type: "paused", on });
    return true;
  }
  title(): string { return this.snapshot.title; }
  /** The width of the page's text column. */
  get column(): number { return this.snapshot.column; }
  /** Where the page is scrolled to, as it last said. */
  get scrollY(): number { const y = Number(this.snapshot.scrollY); return Number.isFinite(y) && y > 0 ? y : 0; }
  render(): void { this.post({ type: "render" }); }
  focus(): void { this.frame.focus(); this.post({ type: "focus" }); }
  reveal(pos: number): void { this.post({ type: "reveal", pos }); }
  setPeers(peers: Peer[]): void { this.post({ type: "peers", peers }); }

  /** The selection's rectangle in the frame's coordinates, or null with nothing to style. */
  selectionRect() { return this.snapshot.fmt.rect; }
  styleBlocker(): string | null { return this.snapshot.fmt.blocker; }
  hasStyle(style: InlineStyle): boolean { return this.snapshot.fmt.has[style]; }
  linkAt(): string | null { return this.snapshot.fmt.link; }
  toggleStyle(style: InlineStyle) { return this.style({ op: "toggle", style }); }
  clearStyles() { return this.style({ op: "clear" }); }
  setLink(url: string) { return this.style({ op: "link", url }); }
  private async style(op: { op: "toggle"; style: InlineStyle } | { op: "clear" } | { op: "link"; url: string }): Promise<string | null> {
    const reply = await this.request<Extract<FromFrame, { type: "styled" }>>({ type: "style", id: this.nextId++, ...op } as ToFrame & { id: number }, 3000);
    return reply && typeof reply.why == "string" ? reply.why.slice(0, 500) : null;
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
  return !!v && typeof v.title == "string" && Number.isFinite(v.column) && typeof v.canPause == "boolean" && typeof v.paused == "boolean" && !!v.fmt && typeof v.fmt.has == "object"
    && (v.fmt.rect == null || ["left", "top", "width", "bottom"].every((k) => Number.isFinite((v.fmt.rect as Record<string, number>)[k])))
    && (v.fmt.blocker == null || typeof v.fmt.blocker == "string") && (v.fmt.link == null || typeof v.fmt.link == "string");
}

