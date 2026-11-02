// The page editor runs on a domain of its own, apart from the shell. The shell (client/shell/main.ts, on erga.dev)
// holds everything that acts as you: the session, the agent. The page, which anyone who can edit the document may have
// written, runs on its document's own origin (<id>-<owner>.erga-pages.dev, or <id>-<owner>.localhost locally) with no
// cookies, in the shell's frame, and the page editor runs inside it there (frame.ts). The editor has the text itself:
// its own socket to the document, with the edit key the shell gives it (erga-mode). The two talk only through the
// messages below about the shell's own controls, and the shell checks every one.

import type { EditorState } from "@codemirror/state";
import type { InlineStyle, LinkEdit, LinkInfo } from "./editor";
import type { Author } from "../../../document/content";
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
  if (e.shiftKey) return key == "p" || key == "k";
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

/**
 * The shell's one word about editing: edit or view. Edit says where the document's socket is (`room`), the edit key
 * that opens it (documents/edit-key.ts: the shell gives a new one before the last ends, for the next socket), who this
 * tab is (`me`: the room attributes the edits to the key's person, this is how the editor shows them), which of the
 * document's pages this is (`path`), this tab's own mark (`tab`: its presence in the room carries it, so the shell
 * knows its own frame's caret), the zoom it draws the page at, and what the tests set (`timescale`, `check`).
 */
export type EditMode =
  | {
      type: "erga-mode";
      mode: "edit";
      room: string;
      key: string;
      me: Author;
      path: string;
      tab: string;
      zoom?: number;
      paused?: boolean;
      timescale?: number;
      check?: boolean;
    }
  | { type: "erga-mode"; mode: "view" };

/** Shell → frame. */
export type ToFrame =
  | EditMode
  | { type: "paused"; on: boolean }
  | { type: "render" }
  /** A zoom for a page that zooms itself: `by` times closer, or 0 for its own first view (window.ergaZoom). */
  | { type: "pageZoom"; by: number }
  | { type: "focus" }
  /** Escape, with nothing of the shell's to close: the focus off the text, but still in the page (the page's own keys). */
  | { type: "leave" }
  | { type: "reveal"; pos: number }
  | { type: "style"; id: number; op: "toggle"; style: InlineStyle }
  | { type: "style"; id: number; op: "clear" }
  | { type: "style"; id: number; op: "link"; edit: LinkEdit }
  /** The files the frame sent (upload) are in the document's files at these paths, in order; `error` says why the others aren't. */
  | { type: "uploaded"; id: number; paths: string[]; error: string | null };

/** Frame → shell. Nothing here is trusted: the page can send any of it. */
export type FromFrame =
  /** The page's selection, in its text (the link bar's changes go there). */
  | { type: "selection"; anchor: number; head: number }
  | { type: "update"; rendered: boolean; snapshot: Snapshot }
  | { type: "backdrop"; backdrop: Backdrop }
  /** Patching can't show the latest change; the page needs rendering again. */
  | { type: "stale" }
  | { type: "notice"; message: string; fix?: string }
  | { type: "problem"; key: string; message: string; fix: string }
  | { type: "key"; keys: Keys }
  /** A zoom gesture on the page (a pinch, ctrl with the wheel): the shell sets the level. */
  | { type: "zoom"; zoom: ZoomBy }
  | { type: "pointer"; kind: "move" | "down" | "up"; x: number; y: number }
  | { type: "activity"; kind: "focus" | "key" }
  | { type: "styled"; id: number; why: string | null }
  /** A link to another of the document's pages, followed on the page: the shell goes to it. */
  | { type: "open"; path: string }
  /** Files dropped or pasted on the page (at most 50), for the shell to add to the document's files. */
  | { type: "upload"; id: number; files: File[] };

/** A state as it crosses: text, selection and undo history. */
export const stateJSON = (state: EditorState, historyField: unknown) => state.toJSON({ history: historyField as never });
