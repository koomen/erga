// The page editor: the page itself is the editing surface. The page's HTML
// source is the model, an EditorState with its change sets and undo
// history. The editor runs in the page's own window
// (frame.ts), which the pages origin served from the same text with its
// manuscript elements marked (shared/page-html.ts); they're found by the
// deterministic analysis in manuscript.ts, which gives every text node a source range.
//
// Two regimes. Each manuscript unit is its own contenteditable host: click
// into one and it behaves like an editor (caret, selection, typing), and the
// arrow keys carry the caret from one unit to the next so the page still
// reads as one document. Everything else is an ordinary web page: buttons,
// links and widgets work as they would anywhere, and clicking them places no
// caret. Every input event in a unit is cancelled and turned into a
// transaction on the source; the DOM is then patched: text nodes in place,
// a unit's inner HTML when its inline structure changed, sibling elements
// when a paragraph was split or joined, and the whole page only as a last
// resort (it loads again: onReload). IME composition is the one case where the browser edits the DOM
// first; the text is read back into the model when it ends.

// Its parts, each a layer of the class over the one before, are in libs/text/ui/: core.ts (the state, and
// positions between the source and the DOM), marks.ts (marks and other people's carets), render.ts (the page and
// its patches), edit.ts (edits and history), format.ts (styles and links), markdown.ts (Markdown shortcuts),
// clipboard.ts (paste and copy) and input.ts (keys, input, the pointer). The rules that make each key's change to the
// source are the library's API (libs/text/api/).

import type { ChangeSet } from "@codemirror/state";
import type { HeldInput, LinkEdit, LinkInfo, TypingAgent, PageEditorConfig, PageUpdate, Peer } from "./types";
import type { InlineStyle } from "../api/source";
import { noHistory } from "./core";
import { EditorInput } from "./input";

export type { HeldInput, InlineStyle, LinkEdit, LinkInfo, TypingAgent, PageEditorConfig, PageUpdate, Peer };

export class PageEditor extends EditorInput {
  constructor(config: PageEditorConfig) {
    super(config);
    this.held = [...(config.held ?? [])];
    // (They wait for the page to have the focus: the caller hands them over, handOver.)
    if (this.held.length) this.holding = true;
    if (config.onUpdate) this.listeners.push(config.onUpdate);
    this.render();
  }

  /** The selection now, in the source: the DOM's, which is ahead of the model until selectionchange fires. */
  selectionNow(): { from: number; to: number } {
    const { from, to } = this.currentSelection();
    return { from, to };
  }

  /** DOM ranges over the page's text of source [from, to): the comments' highlights (comments.ts). */
  textRanges(from: number, to: number): Range[] {
    return this.doc && !this.rendering ? this.rangesIn(from, to) : [];
  }

  /**
   * Applies changes made elsewhere (a collaborator, an agent, an edit on
   * disk) on top of the current document, with no highlight: an agent's new
   * text plays as typing behind its caret (marks.ts). The caret stays where it was, and focus
   * stays wherever it is. They stay out of this editor's undo history, which
   * is mapped over them: ⌘Z only ever undoes your own edits.
   */
  applyExternal(changes: ChangeSet, agent: TypingAgent | null = null): void {
    if (changes.empty) return;
    const tr = this.state.update({ changes, annotations: noHistory(), userEvent: "external" });
    const oldSrc = this.src;
    const oldUnits = this.units;
    this.carrySrc(changes, tr.startState.doc, tr.newDoc);
    this.state = tr.state;
    this.mapMarks(changes);
    // (Read first: a change that replaces the block with the caret takes the focus with it, and this puts it back.)
    const hadFocus = this.hasFocus;
    this.keepView(() => this.applyChanges(tr, oldUnits, oldSrc), changes);
    if (hadFocus) this.syncDOMSelection(true);
    this.changed();
    this.notify({ docChanged: true, selectionSet: false, rendered: false, changes, remote: true });
    if (this.staleSince == null && this.unshown) this.staleSince = oldSrc;
    // The view stays where the reader put it: a change off screen is not followed (reveal finds a peer on request).
    if (agent) this.playTyping(changes, agent);
    this.paintMarks();
  }
}
