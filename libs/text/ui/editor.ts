// The page editor: the page itself is the editing surface. The page's HTML
// source is the model, an EditorState with the same change sets and undo
// history as the source view. The editor runs in the page's own window
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

import type { ChangeSet, EditorState } from "@codemirror/state";
import * as M from "../../../shared/manuscript";
import { changesBetween } from "../../../document/merge";
import type { HeldInput, LinkEdit, LinkInfo, TypingAgent, PageEditorConfig, PageUpdate, Peer } from "./types";
import type { InlineStyle } from "../api/source";
import { noHistory } from "./core";
import { EditorInput } from "./input";

export type { HeldInput, InlineStyle, LinkEdit, LinkInfo, TypingAgent, PageEditorConfig, PageUpdate, Peer };

export class PageEditor extends EditorInput {
  constructor(config: PageEditorConfig) {
    super(config);
    this.held = [...(config.held ?? [])];
    // (They wait for the page to have the focus: the caller hands them over, hold(false).)
    if (this.held.length) this.holding = true;
    if (config.onUpdate) this.listeners.push(config.onUpdate);
    this.render();
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

  /**
   * Adopts a state edited elsewhere (the source view). Edits to the text
   * blocks only are patched in, so the page stays as it is and takes a click
   * or a key at once (a render replaces the page, and loses any meanwhile);
   * anything else that patching can't show (a script, say) makes the page afresh: it loads again.
   */
  setState(state: EditorState): void {
    if (state == this.state) return;
    const oldSrc = this.src, oldUnits = this.units, src = state.doc.toString();
    const changes = src != oldSrc ? changesBetween(oldSrc, src) : null;
    // A click on the page after it was handed over (it shows again before the shell's message comes) put the caret: it stands.
    const clicked = this.holding && this.pointerSeq != this.heldPointer && this.doc && !this.rendering ? this.readSelection() : null;
    this.state = clicked ? state.update({ selection: changes ? clicked.map(changes) : clicked, annotations: noHistory() }).state : state;
    this.srcOf = { doc: this.state.doc, src };
    this.typing = [];
    if (!this.doc || this.rendering) { this.render(); return; }
    if (changes) this.keepView(() => this.applyChanges({ changes }, oldUnits, oldSrc), changes);
    if (this.unshown) this.render();
    if (this.rendering) return; // Patching couldn't show it: the render does.
    const head = this.state.selection.main.head;
    const first = this.units.find((u) => u.runs.some((r) => r.editable && /\S/.test(r.text))) ?? this.units[0];
    if (first && !M.unitAt(this.units, head)) this.state = this.state.update({ selection: { anchor: M.textStart(first) }, annotations: noHistory() }).state;
    if (this.hasFocus) this.syncDOMSelection(true);
    if (changes) this.changed();
    this.notify({ docChanged: !!changes, selectionSet: true, rendered: false, changes: null, remote: false });
    this.paintMarks();
  }
}
