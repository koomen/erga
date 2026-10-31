// The page editor runs on a domain of its own, apart from the shell. The
// shell (main.ts, on erga.dev) holds everything that acts as you: the
// session, the room, the agent. The page, which anyone who can edit the
// document may have written, runs on its document's own origin
// (<id>-<owner>.erga-pages.dev, or <id>-<owner>.localhost locally) with no
// cookies, in the shell's frame, and the page editor runs inside it there
// (frame.ts). The two talk only through the messages below, and the shell checks
// every one: the most a page can do is edit its own document, as whoever
// has it open.
//
// The text: the shell is the authority. It numbers every change it accepts
// (`version`): the frame's own edits, offered with `push`, and everyone
// else's from the room, which it sends as `external`. The frame offers one
// push at a time, against the version it has seen. One made against an
// older version is refused, and by then the changes it missed are on their
// way (messages arrive in order), so the frame rebases its edits over them
// and offers them again (`Relay`). The shell never transforms anything, and
// both sides end up with the same text.

import { ChangeSet, EditorSelection, type EditorState } from "@codemirror/state";
import type { HeldInput, InlineStyle, LinkEdit, LinkInfo, MarkAuthor, Peer } from "./editor";
import type { ViewRequest, ViewResult } from "../../shared/agent-log";
import type { LiveRequest, LiveResult } from "../../shared/live-page";
import { zoomKey, type ZoomBy } from "./zoom";

/** The parts of a keydown the shell's shortcuts look at. */
export interface Keys { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

/**
 * The shell's own shortcuts, as a key pressed in
 * the page must be recognised there: the frame stops them and passes them on.
 */
export function isAppShortcut(e: Keys, isMac: boolean): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey, key = e.key.toLowerCase();
  if (e.key == "Escape") return true;
  if (!mod) return false;
  // The page's zoom (zoom.ts): the shell sets it.
  if (zoomKey(e, isMac)) return true;
  if (e.shiftKey) return key == "p";
  return key == "j" || key == "k" || key == "/" || key == "?" || key == "s";
}

/** What the format bar shows for the page's selection. */
export interface Fmt {
  /** The selection's rectangle in the frame's coordinates, or null with nothing to style. */
  rect: { left: number; top: number; width: number; bottom: number } | null;
  /** Why styles can't apply here, if they can't. */
  blocker: string | null;
  has: Record<InlineStyle, boolean>;
  /** The selection's text (its start: for a new link's text). */
  text: string;
  /** The link the selection or the caret is in (the caret's shows the link bar). */
  link: LinkInfo | null;
}

/** The page's state, as the shell shows it in its own controls. */
export interface Snapshot {
  title: string;
  canPause: boolean;
  paused: boolean;
  /** The page zooms itself (window.ergaZoom: a canvas's camera), so the editor's zoom goes to it. */
  zoomsItself?: boolean;
  fmt: Fmt;
  /** Where the page is scrolled to (kept across a reload for a new release: live.ts). */
  scrollY?: number;
}

/** The page's background, as the shell paints its own canvas to match. */
export interface Backdrop { color: string; image: string }

/** Shell → frame. */
export type ToFrame =
  /**
   * `scroll`: where to scroll the page once it first renders (the page reloaded for a new release kept it: live.ts).
   * `carry`: the state the page's editor had, undo history and all (before the page loaded again, or the editor stopped),
   * which the frame brings to `state`'s text and carries on from; `drops`, with it: the files dropped on the page before
   * it loaded again that are still on their way into the document (frame.ts), which go in on this one.
   */
  | {
      type: "init";
      state: unknown;
      version: number;
      self: MarkAuthor;
      tracking: boolean;
      timescale?: number;
      scroll?: number;
      zoom?: number;
      carry?: unknown;
      drops?: unknown;
      view?: { pos: number; top: number };
      held?: HeldInput[];
      focus?: boolean;
      frame?: { sandbox: string | null; allow: string | null };
      paused?: boolean;
      check?: boolean;
    }
  | { type: "external"; changes: unknown; author: MarkAuthor | null; length: number }
  | { type: "ack" }
  | { type: "reject" }
  | { type: "authorship"; changes: unknown; author: MarkAuthor | null }
  | { type: "tracking"; on: boolean }
  | { type: "paused"; on: boolean }
  | { type: "render" }
  /** The level to draw the page at (zoom.ts). */
  | { type: "zoom"; level: number }
  /** A zoom for a page that zooms itself: `by` times closer, or 0 for its own first view (window.ergaZoom). */
  | { type: "pageZoom"; by: number }
  | { type: "focus" }
  /** Escape, with nothing of the shell's to close: the focus off the text, but still in the page (the page's own keys). */
  | { type: "leave" }
  | { type: "reveal"; pos: number }
  | { type: "peers"; peers: Peer[] }
  /** Leaving the page for the source view: the frame answers with its state, undo history and all, once its edits are in. */
  | { type: "detach"; id: number }
  /** Back from the source view: the state to carry on from. */
  | { type: "attach"; state: unknown; version: number }
  /** The page may load again now (it said it would: reloading): the room has every edit, so the page comes made from them. */
  | { type: "reload" }
  /** Out of the editor: the frame answers with its state, undo history and all, once its edits are in, and stops. */
  | { type: "stop"; id: number }
  | { type: "style"; id: number; op: "toggle"; style: InlineStyle }
  | { type: "style"; id: number; op: "clear" }
  | { type: "style"; id: number; op: "link"; edit: LinkEdit }
  | { type: "capture"; id: number; req: ViewRequest; text?: string; dir?: string }
  /** The agent's request to the live page (shared/live-page.ts). */
  | { type: "live"; id: number; req: LiveRequest }
  /** The files the frame sent (upload) are in the document's files at these paths, in order; `error` says why the others aren't. */
  | { type: "uploaded"; id: number; paths: string[]; error: string | null };

/** Frame → shell. Nothing here is trusted: the page can send any of it. */
export type FromFrame =
  | { type: "ready" }
  | { type: "push"; version: number; changes: unknown }
  /** The frame's selection, when it has no edits in flight (so it's in the shell's terms). */
  | { type: "selection"; version: number; anchor: number; head: number }
  | { type: "update"; rendered: boolean; snapshot: Snapshot }
  | { type: "backdrop"; backdrop: Backdrop }
  /** Patching can't show the latest change; the page needs rendering again. */
  | { type: "stale" }
  /** The frame's text doesn't match the shell's: send it whole. */
  | { type: "resync" }
  | { type: "notice"; message: string; fix?: string }
  | { type: "problem"; key: string; message: string; fix: string }
  | { type: "key"; keys: Keys }
  /** A zoom gesture on the page (a pinch, ctrl with the wheel): the shell sets the level. */
  | { type: "zoom"; zoom: ZoomBy }
  | { type: "pointer"; kind: "move" | "down" | "up"; x: number; y: number }
  | { type: "activity"; kind: "focus" | "key" }
  | { type: "detached"; id: number; state: unknown; version: number }
  /** The editor stopped (stop): its state for the way back in, or null if it hadn't started. */
  | { type: "stopped"; id: number; state: unknown; version: number }
  /** The page loads again, made from the text (a change the editor can't patch in): its editor's state, for the editor in the page that comes. */
  | {
      type: "reloading";
      state: unknown;
      version: number;
      view: { pos: number; top: number } | null;
      focus: boolean;
      drops?: { id: number; at: number; point: { x: number; y: number } }[];
    }
  /** Keys typed on the page as it was about to load again (after `reloading`): before the ones the shell held since. */
  | { type: "held"; held: HeldInput[] }
  | { type: "styled"; id: number; why: string | null }
  | { type: "captured"; id: number; result: ViewResult }
  | { type: "lived"; id: number; result: LiveResult }
  /** A link to another of the document's pages, followed on the page: the shell goes to it. */
  | { type: "open"; path: string }
  /** Files dropped or pasted on the page (at most 50), for the shell to add to the document's files. */
  | { type: "upload"; id: number; files: File[] };

/** A state as it crosses: text, selection and undo history. */
export const stateJSON = (state: EditorState, historyField: unknown) => state.toJSON({ history: historyField as never });

/**
 * The frame's side of the text (see the top of this file): its edits not
 * yet accepted, rebased over everyone else's as they arrive.
 */
export class Relay {
  /** How many of the shell's changes this side has seen. */
  version: number;
  /** Offered, not yet accepted. */
  private inflight: ChangeSet | null = null;
  /** Made since, not yet offered. */
  private buffer: ChangeSet | null = null;

  constructor(version: number, private readonly send: (version: number, changes: ChangeSet) => void) {
    this.version = version;
  }

  get idle(): boolean { return !this.inflight && !this.buffer; }

  /** An edit made here, against the text as it is here. */
  local(changes: ChangeSet): void {
    if (changes.empty) return;
    this.buffer = this.buffer ? this.buffer.compose(changes) : changes;
    this.flush();
  }

  /**
   * One of the shell's changes, against the text as the shell has it.
   * Returns it as it applies here, after this side's own edits.
   */
  remote(changes: ChangeSet): ChangeSet {
    let theirs = changes;
    // Ours stay first at a shared position (the shell's change is mapped "before" them), as @codemirror/collab does.
    if (this.inflight) { const ours = this.inflight.map(theirs); theirs = theirs.map(this.inflight, true); this.inflight = ours; }
    if (this.buffer) { const ours = this.buffer.map(theirs); theirs = theirs.map(this.buffer, true); this.buffer = ours; }
    this.version++;
    return theirs;
  }

  /** The shell took our offer: it's change number `version` now. */
  accepted(): void {
    this.inflight = null;
    this.version++;
    this.flush();
  }

  /** The shell had moved on; what we missed has been rebased over already, so offer it again. */
  refused(): void {
    if (!this.inflight) return;
    this.buffer = this.buffer ? this.inflight.compose(this.buffer) : this.inflight;
    this.inflight = null;
    this.flush();
  }

  /** Starts again from the shell's state (after the source view, or a resync). */
  reset(version: number): void {
    this.version = version;
    this.inflight = this.buffer = null;
  }

  private flush(): void {
    if (this.inflight || !this.buffer) return;
    this.inflight = this.buffer;
    this.buffer = null;
    this.send(this.version, this.inflight);
  }
}

/** The shell's side: the changes it has numbered, and whether an offer fits. */
export class Authority {
  version = 0;
  /** Recent changes, from `version - log.length` on, to catch a state up that missed some. */
  private log: ChangeSet[] = [];

  /** Records a change the shell made (the room's) or accepted (the frame's). */
  record(changes: ChangeSet): void {
    this.version++;
    this.log.push(changes);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  /** The changes since `version`, or null if they're no longer kept. */
  since(version: number): ChangeSet[] | null {
    const n = this.version - version;
    if (n < 0 || n > this.log.length) return null;
    return this.log.slice(this.log.length - n);
  }

  /** Starts numbering afresh from `version` (when the frame takes a whole state). */
  reset(version = this.version): void {
    this.version = version;
    this.log = [];
  }
}

/** Parses a change set the frame sent, if it's well formed and fits a text of `length`. */
export function changesFrom(json: unknown, length: number): ChangeSet | null {
  try {
    const c = ChangeSet.fromJSON(json);
    return c.length == length ? c : null;
  } catch { return null; }
}

/** A selection the frame sent, if it fits a text of `length`. */
export function selectionFrom(anchor: unknown, head: unknown, length: number): EditorSelection | null {
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= length;
  return ok(anchor) && ok(head) ? EditorSelection.single(anchor, head) : null;
}
