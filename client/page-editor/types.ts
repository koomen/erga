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

/** Something wrong with the document that the user can see, and how the agent could fix it. */
export interface PageProblem {
  /** Identifies the problem across renders (the same error, the same missing file). */
  key: string;
  message: string;
  /** A prompt asking the agent to fix it. */
  fix: string;
}

/** A key or input that came while the editor couldn't take it (see hold, render), to apply once it can. */
export type HeldInput = { key: string; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } | { input: string; data: string | null };

/** Who made a change, for its marks: a name and a colour. */
export interface MarkAuthor { name: string; color: string }

/** Someone else in the document: their caret (and selection) as source positions. */
export interface Peer {
  key: number;
  name: string;
  color: string;
  anchor: number;
  /** The other end of their selection, if they have one. */
  head: number | null;
  agent?: boolean;
  /** What an agent is doing ("editing index.html"), shown on its label. */
  activity?: string | null;
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
  /** A pointer moved inside the page. */
  onPointer?: (e: MouseEvent) => void;
  /**
   * Something the user asked for couldn't be done; say why. When the
   * document itself is at fault, `fix` is a prompt that asks the agent to
   * repair it, and the shell offers it as a button.
   */
  onNotice?: (message: string, fix?: string) => void;
  /**
   * The page looks broken without anyone asking: its script threw, or a
   * file it refers to didn't load. Reported once per render per problem.
   */
  onProblem?: (problem: PageProblem) => void;
  /** Whoever is using this editor, for the marks on their own edits while tracking. */
  self?: MarkAuthor;
  /** The page is paused (it loaded again while it was: setPaused). */
  paused?: boolean;
  /** Keys and input that came while the page loaded again (the shell held them), to apply first, in order. */
  held?: HeldInput[];
  /**
   * The page must be made afresh from the text (the first time, from another text; or a change it can't patch in): it
   * loads again. `view`: the text on the window's top line (its source position in the text now, and how far down the
   * window its line is), for the page that comes to show it there again (restoreView).
   */
  onReload: (view: { pos: number; top: number } | null) => void;
}

/** Inline styles the editor can apply to a selection. */
export type InlineStyle = "strong" | "em" | "code";

/** The link the link bar shows: its address, its text, whether it opens in this tab, and its rectangle in the frame. */
export interface LinkInfo {
  href: string;
  text: string;
  self: boolean;
  rect: { left: number; top: number; width: number; bottom: number } | null;
}
/**
 * A change to a link (setLink): an empty url takes it off; text and self, when given, replace its own. `at` is the
 * selection the link bar opened on, which the change applies to even if the caret has moved since (a click elsewhere).
 */
export interface LinkEdit { url: string; text?: string; self?: boolean; at?: { anchor: number; head: number } }
