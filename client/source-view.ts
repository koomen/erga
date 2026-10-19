// The source view: a page's HTML in CodeMirror, editable, with the page's
// state and undo history (main.ts goes between it and the page with ⌘⇧P).
// Its code (CodeMirror's view, the HTML language with its CSS and
// JavaScript, the highlighting) is a chunk of its own, which main.ts imports
// the first time the view opens: the editor takes input long before anyone
// needs it.

import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightSpecialChars, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import type { Peer } from "./editor";
import type { SourceState } from "./remote";

/** The field the view's undo history is in (the frame's state carries the same, so ⌘Z goes on across a switch). */
export const sourceHistory = historyField as StateField<unknown>;

/** Other people's carets and selections in the source view (the page draws its own, see PageEditor.setPeers): `view.dispatch({ effects: setPeers.of(peers) })`. */
export const setPeers = StateEffect.define<Peer[]>();

class PeerCaret extends WidgetType {
  constructor(readonly peer: Peer) { super(); }
  eq(other: PeerCaret) { return other.peer.name == this.peer.name && other.peer.color == this.peer.color && other.peer.activity == this.peer.activity; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-peer" + (this.peer.agent ? " is-agent" : "");
    el.style.setProperty("--c", this.peer.color);
    const name = document.createElement("span");
    name.className = "cm-peer-name";
    name.textContent = this.peer.activity ? `${this.peer.name} · ${this.peer.activity}` : this.peer.name;
    el.append(name);
    return el;
  }
  ignoreEvent() { return true; }
}

const peersField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setPeers)) continue;
      const len = tr.state.doc.length, ranges = [];
      for (const p of e.value) {
        const at = Math.min(p.head ?? p.anchor, len);
        if (p.head != null && p.head != p.anchor) {
          const from = Math.min(p.anchor, p.head, len), to = Math.min(Math.max(p.anchor, p.head), len);
          if (to > from) ranges.push(Decoration.mark({ attributes: { style: `background-color: color-mix(in srgb, ${p.color} 18%, transparent)` } }).range(from, to));
        }
        ranges.push(Decoration.widget({ widget: new PeerCaret(p), side: 1 }).range(at));
      }
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The view reads like code: smaller monospace, a fixed left margin, no right margin and no wrapping; long lines
// scroll sideways.
const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%" },
  ".cm-content": { caretColor: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  // As wide as the page's caret: 2px, more in large type.
  ".cm-cursor, .cm-dropCursor": { borderLeft: "max(2px, 0.085em) solid var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
  ".cm-line": { padding: "0" },
});
const htmlLook: Extension = [baseTheme, EditorView.theme({
  "&": { fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", padding: "max(64px, 9vh) 0 40vh 56px" },
  ".cm-content": { paddingRight: "24px" },
})];
const sourceHighlight = HighlightStyle.define([
  { tag: [t.processingInstruction, t.meta, t.punctuation, t.angleBracket, t.documentMeta], color: "var(--mark)" },
  { tag: [t.tagName, t.attributeName], color: "var(--soft)" },
  { tag: [t.string, t.attributeValue, t.url, t.link], color: "var(--soft)" },
  { tag: t.comment, color: "var(--mark)", fontStyle: "italic" },
]);

/** What the view tells the editor: its own edits (to go to the room), and that its text or selection changed. */
export interface SourceHooks {
  edited(changes: ChangeSet): void;
  moved(): void;
}

/**
 * The source view's state: the frame hands over its own state (undo history and all) when the view opens, made with
 * these, and takes it back when it closes.
 */
export function sourceState(hooks: SourceHooks): SourceState {
  return {
    history: sourceHistory,
    extensions: [
      peersField,
      history(),
      html(),
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      syntaxHighlighting(sourceHighlight),
      htmlLook,
      // The view's own edits go to the room; edits from the room come in marked "external".
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) if (tr.docChanged && !tr.isUserEvent("external")) hooks.edited(tr.changes);
        if (u.docChanged || u.selectionSet) hooks.moved();
      }),
    ],
  };
}

/** The view, open in `parent` on `state`. */
export const openSource = (parent: HTMLElement, state: EditorState) => new EditorView({ parent, state });
