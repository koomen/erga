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
import type { ViewRequest, ViewResult } from "./agent-log";
import { changesBetween } from "./merge";

export interface RemotePageConfig {
  frame: HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  kind: Kind;
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
}

const EMPTY: Snapshot = { title: "", canPause: false, paused: false, fmt: { rect: null, blocker: null, has: { strong: false, em: false, code: false }, link: null } };

export class RemotePage {
  /** The text and the page's selection, as the shell (and the room) has them. */
  state: EditorState;
  readonly kind: Kind;
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
    this.state = EditorState.create({ doc: config.text });
    window.addEventListener("message", (e) => {
      if (e.source != this.frame.contentWindow || e.origin != config.origin || typeof e.data?.type != "string") return;
      this.receive(e.data as FromFrame);
    });
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
        // A frame that (re)loads starts from the shell's state.
        this.ready = true;
        this.authority.reset();
        const timescale = (globalThis as { __ergaTimescale?: number }).__ergaTimescale;
        this.post({ type: "init", kind: this.kind, state: this.state.toJSON(), version: this.authority.version, markdownHead: c.markdownHead, self: c.self, tracking: this.tracking, ...(timescale ? { timescale } : {}) });
        for (const q of this.queue.splice(0)) this.post(q);
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
  async detach(): Promise<{ state: EditorState; column: number }> {
    const id = this.nextId++;
    const reply = await this.request<Extract<FromFrame, { type: "detached" }>>({ type: "detach", id }, 3000);
    this.detached = true;
    const fallback = () => EditorState.create({ doc: this.state.doc, selection: this.state.selection, extensions: this.config.extensions });
    if (!reply) return { state: fallback(), column: 0 };
    let state: EditorState;
    try { state = EditorState.fromJSON(reply.state, { extensions: this.config.extensions }, { history: historyField }); } catch { return { state: fallback(), column: 0 }; }
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
    return { state, column: Number.isFinite(reply.column) ? reply.column : 0 };
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
    const reply = await this.request<Extract<FromFrame, { type: "captured" }>>({ type: "capture", id: this.nextId++, req, ...(this.detached ? { text: this.state.doc.toString() } : {}) }, 20_000);
    const r = reply?.result;
    if (!r) return { width: 0, height: 0, errors: [], error: "The page didn't send a picture back in time." };
    return {
      ...(typeof r.png == "string" ? { png: r.png } : {}),
      width: Number(r.width) || 0, height: Number(r.height) || 0,
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e == "string").slice(0, 50) : [],
      ...(typeof r.note == "string" ? { note: r.note } : {}),
      ...(typeof r.error == "string" ? { error: r.error } : {}),
    };
  }
}

function isSnapshot(s: unknown): s is Snapshot {
  const v = s as Snapshot;
  return !!v && typeof v.title == "string" && typeof v.canPause == "boolean" && typeof v.paused == "boolean" && !!v.fmt && typeof v.fmt.has == "object"
    && (v.fmt.rect == null || ["left", "top", "width", "bottom"].every((k) => Number.isFinite((v.fmt.rect as Record<string, number>)[k])))
    && (v.fmt.blocker == null || typeof v.fmt.blocker == "string") && (v.fmt.link == null || typeof v.fmt.link == "string");
}

