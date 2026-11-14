// The page editor's types: what it tells its listeners, what it takes, and the people and links it shows.

import type { ChangeSet, EditorState } from "@codemirror/state";

export interface PageUpdate {
  state: EditorState;
  docChanged: boolean;
  selectionSet: boolean;
  /** The page was rendered again from scratch. */
  rendered: boolean;
  /** What changed in the document, if it did. */
  changes: ChangeSet | null;
  /** The change came from elsewhere (`applyExternal`), not from this editor. */
  remote: boolean;
}

/** A key or input that came while the editor couldn't take it (see hold, render), to apply once it can. */
export type HeldInput = { key: string; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } | { input: string; data: string | null };

/** An agent whose edit the page plays as typing, behind its caret (marks.ts, playTyping): its name and colour. */
export interface TypingAgent {
  name: string;
  color: string;
  /** Its label at its caret while its text plays (Peer.label). */
  label?: { label: string; title: string };
}

/** Someone else in the document: their caret (and selection) as source positions. */
export interface Peer {
  key: number;
  name: string;
  color: string;
  anchor: number;
  /** The other end of their selection, if they have one. */
  head: number | null;
  agent?: boolean;
  /** An agent's label at its caret, short ("Claude Code · looking"), and the full line for its tooltip (shared/attribution.ts, agentLabel). */
  label?: { label: string; title: string };
}

export interface PageEditorConfig {
  /** The page's window: the editor runs in it, on the page as the pages origin served it. */
  win: Window;
  /** The digest of the text the page was made from (shared/page-html.ts): the editor takes the page only if its text is the same. */
  source: string;
  state: EditorState;
  /** Where the document's relative URLs resolve, e.g. "/doc/". */
  base: string;
  onUpdate?: (u: PageUpdate) => void;
  /** Unhandled keydowns inside the page (for app-level shortcuts). */
  onKey?: (e: KeyboardEvent) => boolean;
  /**
   * Why something can't be done. `fix`: a request the agent can do for it (the viewer offers "Fix with agent"); with
   * `draft`, the start of a request that the person completes ("Change the text “42” to: ").
   */
  onNotice?: (message: string, fix?: string, draft?: boolean) => void;
  /**
   * Files dropped or pasted on the text, at source position `at`: the caller gives each its path in the document's
   * files and puts them on the page (insertFiles); their bytes follow.
   */
  onDropFiles?: (files: File[], at: number) => void;
  /** Files dropped or pasted that can't go in (the place takes none, the page loads again): why. */
  onDropRefused?: (why: string) => void;
  /**
   * One of the page's own edits (ergaEditor.call), on `html`: the change its API gives (its module, run in the page:
   * page-edits.ts), or why not.
   */
  pageEdit?: (
    html: string,
    edit: string,
    input: unknown
  ) => Promise<{ changes: { from: number; to: number; insert: string }[]; caret?: { at: number; select: boolean } } | { error: string }>;
  /** Checks after each change that the page shows its HTML, and logs a difference as an error (the tests: check.ts). */
  check?: boolean;
  /** Keys and input that came while the page loaded again (the shell held them), to apply first, in order. */
  held?: HeldInput[];
  /**
   * The page must be made afresh from the text (the first time, from another text; or a change it can't patch in): it
   * loads again. `view`: the text on the window's top line (its source position in the text now, and how far down the
   * window its line is), for the page that comes to show it there again (restoreView).
   */
  onReload: (view: { pos: number; top: number } | null) => void;
}

/**
 * The link the link bar shows: its address, its text, whether it opens in this tab, and its rectangle in the frame.
 * `inside`: a selection, or a caret with link text on both sides (not at the link's start or end).
 */
export interface LinkInfo {
  href: string;
  text: string;
  self: boolean;
  inside: boolean;
  rect: { left: number; top: number; width: number; bottom: number } | null;
}
/**
 * A change to a link (setLink): an empty url takes it off; text and self, when given, replace its own. `at` is the
 * selection the link bar opened on, which the change applies to even if the caret has moved since (a click elsewhere).
 */
export interface LinkEdit { url: string; text?: string; self?: boolean; at?: { anchor: number; head: number } }
