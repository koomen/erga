// The page editor: the page itself is the editing surface. The page's HTML source is the model, an EditorState with
// its change sets and undo history. The editor runs in the page's own window (frame.ts), which the pages origin served
// from the same text with its manuscript elements marked (shared/page-html.ts); they're found by the deterministic
// analysis in manuscript.ts, which gives every text node a source range.
//
// One editing host: the page's <body> is contenteditable, and everything that is not editable text (widgets, pictures,
// scripts' parts, data-erga-noedit regions) is marked as a contenteditable="false" island so the browser moves the
// caret and selection naturally across blocks while buttons, links and widgets work as usual. Every input event in
// manuscript is cancelled and turned into a transaction on the source; the DOM is then patched in place (text runs
// directly, smallest enclosing region via mirror.ts, or a full reload via onReload when a script or unpatchable
// structure changed). IME composition is the one case where the browser edits the DOM first; the text is read back
// into the model when it ends.
//
// PageEditor is one flat class owning an EditorCore state bag (core.ts) and delegating to plain module functions in
// libs/text/ui/: core.ts (state and DOM/source positions), marks.ts (typing playback and peer carets), render.ts (mount,
// patch, reconciliation, teardown), edit.ts (transactions, history, page edits), format.ts (styles and links),
// markdown.ts (slash menu and table-row adapter), clipboard.ts (paste, cut, copy), and input.ts (DOM events, held
// input, drops). The pure editing, formatting, list, block and Markdown rules live in Layer 1 (libs/text/api/).

import type { ChangeSet, EditorSelection, EditorState } from "@codemirror/state";
import type { HeldInput, LinkEdit, LinkInfo, PageEditorConfig, PageUpdate, Peer, TypingAgent } from "./types";
import type { InlineStyle } from "../api/source";
import type { BlockType } from "../api/block-type";
import type { DropFile, PagePlace } from "./drop";
import {
  analyze,
  carrySrc,
  coordsAtPos,
  createCore,
  domAtPos,
  focus,
  hasFocus,
  leaveText,
  noHistory,
  notify,
  posFromDOM,
  readSelection,
  setReadOnly,
  src,
  syncDOMSelection,
  type EditorCore,
} from "./core";
import { mapMarks, paintMarks, playTyping, rangesIn, setPeers } from "./marks";
import { applyChanges, changed, isStale, keepView, render, restoreView, teardown, topText, upToDate } from "./render";
import { currentSelection, deleteChar, enter, indentItem, insertText, make, redo, replaceRange, takePageEdits, undo } from "./edit";
import {
  blockType,
  clearStyles,
  hasStyle,
  linkAt,
  selectedText,
  selectionRect,
  setBlockType,
  setLink,
  styleBlocker,
  toggleStyle,
} from "./format";
import { slashBlock, slashText } from "./markdown";
import { bind, dropEdit, handOver, insertFiles, placeAt, release, takeHeld, unbind } from "./input";

export type { HeldInput, InlineStyle, LinkEdit, LinkInfo, PageEditorConfig, PageUpdate, Peer, TypingAgent };

export class PageEditor {
  readonly core: EditorCore;

  constructor(config: PageEditorConfig) {
    this.core = createCore(config);
    if (config.headless) {
      const a = analyze(this.core, src(this.core));
      this.core.units = a.units;
      this.core.tree = a.tree;
    } else {
      this.render();
    }
  }

  get state(): EditorState {
    return this.core.state;
  }

  set state(next: EditorState) {
    this.core.state = next;
  }

  get lastUndoRedo(): boolean {
    return this.core.lastUndoRedo;
  }

  get readOnly(): boolean {
    return this.core.readOnly;
  }

  get stale(): boolean {
    return isStale(this.core);
  }

  get upToDate(): boolean {
    return upToDate(this.core);
  }

  get hasFocus(): boolean {
    return hasFocus(this.core);
  }

  render(): void {
    render(
      this.core,
      () => {
        takePageEdits(this.core);
        bind(this.core);
      },
      () => release(this.core)
    );
  }

  stop(): void {
    if (this.core.stopped) return;
    this.core.stopped = true;
    unbind(this.core);
    teardown(this.core);
  }

  restoreView(view: { pos: number; top: number }): void {
    restoreView(this.core, view);
  }

  topText(): { pos: number; top: number } | null {
    return topText(this.core);
  }

  focus(): void {
    focus(this.core);
  }

  leaveText(): void {
    leaveText(this.core);
  }

  setReadOnly(on: boolean): void {
    setReadOnly(this.core, on);
  }

  readSelection(): EditorSelection | null {
    return readSelection(this.core);
  }

  /** The selection now, in the source: the DOM's, which is ahead of the model until selectionchange fires. */
  selectionNow(): { from: number; to: number } {
    const { from, to } = currentSelection(this.core);
    return { from, to };
  }

  /** DOM ranges over the page's text of source [from, to): the comments' highlights (comments.ts). */
  textRanges(from: number, to: number): Range[] {
    return this.core.doc && !this.core.rendering ? rangesIn(this.core, from, to) : [];
  }

  syncDOMSelection(force = false): void {
    syncDOMSelection(this.core, force);
  }

  posFromDOM(node: Node, offset: number): number | null {
    return posFromDOM(this.core, node, offset);
  }

  domAtPos(pos: number, side = 1): { node: Node; offset: number } | null {
    return domAtPos(this.core, pos, side);
  }

  coordsAtPos(pos: number, side = 1): DOMRect | null {
    return coordsAtPos(this.core, pos, side);
  }

  setPeers(peers: Peer[]): void {
    setPeers(this.core, peers);
  }

  insertText(text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
    return insertText(this.core, text, range, userEvent);
  }

  replaceRange(from: number, to: number, text: string, userEvent: string): boolean {
    return replaceRange(this.core, from, to, text, userEvent);
  }

  deleteChar(forward: boolean): boolean {
    return deleteChar(this.core, forward);
  }

  enter(shift: boolean): boolean {
    return enter(this.core, shift);
  }

  indentItem(out: boolean): boolean {
    return indentItem(this.core, out);
  }

  make(changes: { from: number; to: number; insert: string }[], userEvent = "input.page", caret?: { at: number; select: boolean }): void {
    make(this.core, changes, userEvent, caret);
  }

  undo(): boolean {
    return undo(this.core);
  }

  redo(): boolean {
    return redo(this.core);
  }

  styleBlocker(): string | null {
    return styleBlocker(this.core);
  }

  hasStyle(style: InlineStyle): boolean {
    return hasStyle(this.core, style);
  }

  toggleStyle(style: InlineStyle): string | null {
    return toggleStyle(this.core, style);
  }

  clearStyles(): string | null {
    return clearStyles(this.core);
  }

  blockType(): BlockType | "mixed" | null {
    return blockType(this.core);
  }

  setBlockType(to: BlockType): string | null {
    return setBlockType(this.core, to);
  }

  linkAt(): LinkInfo | null {
    return linkAt(this.core);
  }

  setLink(edit: LinkEdit): string | null {
    return setLink(this.core, edit);
  }

  selectedText(): string {
    return selectedText(this.core);
  }

  selectionRect(): DOMRect | null {
    return selectionRect(this.core);
  }

  slashText(): string | null {
    return slashText(this.core);
  }

  slashBlock(kind: "heading" | "list" | "todo" | "quote" | "code" | "table" | "image" | "divider"): number | false {
    return slashBlock(this.core, kind);
  }

  handOver(): void {
    handOver(this.core);
  }

  takeHeld(): HeldInput[] {
    return takeHeld(this.core);
  }

  placeAt(x: number, y: number, files: DropFile[], final: boolean): PagePlace | null {
    return placeAt(this.core, x, y, files, final);
  }

  dropEdit(edit: string, input: unknown): Promise<string | null> {
    return dropEdit(this.core, edit, input);
  }

  insertFiles(at: number, items: { href: string; name: string; image: boolean; width?: number; height?: number }[]): boolean {
    return insertFiles(this.core, at, items);
  }

  /**
   * Applies changes made elsewhere (a collaborator, an agent, an edit on disk) on top of the current document, with no
   * highlight: an agent's new text plays as typing behind its caret (marks.ts). The caret stays where it was, and focus
   * stays wherever it is. They stay out of this editor's undo history, which is mapped over them: ⌘Z only ever undoes
   * your own edits.
   */
  applyExternal(changes: ChangeSet, agent: TypingAgent | null = null): void {
    if (changes.empty) return;
    const ed = this.core;
    const tr = ed.state.update({ changes, annotations: noHistory(), userEvent: "external" });
    const oldSrc = src(ed);
    const oldUnits = ed.units;
    carrySrc(ed, changes, tr.startState.doc, tr.newDoc);
    ed.state = tr.state;
    mapMarks(ed, changes);
    // (Read first: a change that replaces the block with the caret takes the focus with it, and this puts it back.)
    const hadFocus = hasFocus(ed);
    keepView(ed, () => applyChanges(ed, tr, oldUnits, oldSrc), changes);
    if (hadFocus) syncDOMSelection(ed, true);
    changed(ed);
    notify(ed, { docChanged: true, selectionSet: false, rendered: false, changes, remote: true });
    if (ed.staleSince == null && ed.unshown) ed.staleSince = oldSrc;
    // The view stays where the reader put it: a change off screen is not followed.
    if (agent) playTyping(ed, changes, agent);
    paintMarks(ed);
  }
}
