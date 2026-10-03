// The page editor runs on a domain of its own, apart from the shell. The
// shell (main.ts, on erga.dev) holds everything that acts as you: the
// session, the room, the agent. The page, which anyone who can edit the
// document may have written, runs on its document's own origin
// (<id>-<owner>.erga-pages.dev, or <id>-<owner>.localhost locally) with no
// cookies, inside a host frame (frame.ts) that runs the page editor next to
// it. The two talk only through the messages below, and the shell checks
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

import { ChangeSet, EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import type { InlineStyle, Kind, MarkAuthor, Peer } from "./editor";
import type { ViewRequest, ViewResult } from "./agent-log";

/** What the frame's editor state needs: the history (undo, shared with the source view) and the language (the Markdown commands read its tree). */
export const docExtensions = (kind: Kind): Extension[] => [history(), kind == "md" ? markdown({ base: markdownLanguage }) : html()];

/** The parts of a keydown the shell's shortcuts look at. */
export interface Keys { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

/**
 * The shell's own shortcuts (main.ts, appShortcut), as a key pressed in
 * the page must be recognised there: the frame stops them and passes them on.
 */
export function isAppShortcut(e: Keys, isMac: boolean): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey, key = e.key.toLowerCase();
  if (e.key == "Escape") return true;
  if (!mod) return false;
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
  link: string | null;
}

/** The page's state, as the shell shows it in its own controls. */
export interface Snapshot {
  title: string;
  /** The width of the page's text column, so the Markdown views can match it. */
  column: number;
  canPause: boolean;
  paused: boolean;
  fmt: Fmt;
}

/** The page's background, as the shell paints its own canvas to match. */
export interface Backdrop { color: string; image: string }

/** Shell → frame. */
export type ToFrame =
  | { type: "init"; kind: Kind; state: unknown; version: number; markdownHead: string; self: MarkAuthor; tracking: boolean; timescale?: number }
  | { type: "external"; changes: unknown; author: MarkAuthor | null; length: number }
  | { type: "ack" }
  | { type: "reject" }
  | { type: "authorship"; changes: unknown; author: MarkAuthor | null }
  | { type: "tracking"; on: boolean }
  | { type: "paused"; on: boolean }
  | { type: "render" }
  | { type: "focus" }
  | { type: "reveal"; pos: number }
  | { type: "peers"; peers: Peer[] }
  /** Leaving the page for the source view: the frame answers with its state, undo history and all, once its edits are in. */
  | { type: "detach"; id: number }
  /** Back from the source view: the state to carry on from. */
  | { type: "attach"; state: unknown; version: number }
  | { type: "style"; id: number; op: "toggle"; style: InlineStyle }
  | { type: "style"; id: number; op: "clear" }
  | { type: "style"; id: number; op: "link"; url: string }
  | { type: "capture"; id: number; req: ViewRequest; text?: string };

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
  | { type: "pointer"; kind: "move" | "down" | "up"; x: number; y: number }
  | { type: "activity"; kind: "focus" | "key" }
  | { type: "detached"; id: number; state: unknown; version: number }
  | { type: "styled"; id: number; why: string | null }
  | { type: "captured"; id: number; result: ViewResult };

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
