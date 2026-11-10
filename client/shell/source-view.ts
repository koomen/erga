// The source view: a page's HTML in CodeMirror, editable, on the viewer's own replica of the room, with an undo
// history of its own (views.ts goes between it and the page with ⌘⇧P).
// Its code (CodeMirror's view, and html-code.ts: the HTML's colors, closing
// tags and indents) is a chunk of its own, which main.ts imports
// the first time the view opens: the editor takes input long before anyone
// needs it.

import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightSpecialChars, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { Peer } from "../../libs/text/ui/editor";
import { htmlCode, htmlEnter } from "./html-code";

/** Other people's carets and selections in the source view (the page draws its own, see PageEditor.setPeers): `view.dispatch({ effects: setPeers.of(peers) })`. */
export const setPeers = StateEffect.define<Peer[]>();

class PeerCaret extends WidgetType {
  constructor(readonly peer: Peer) {
    super();
  }
  eq(other: PeerCaret) {
    return other.peer.name == this.peer.name && other.peer.color == this.peer.color && other.peer.label?.label == this.peer.label?.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-peer" + (this.peer.agent ? " is-agent" : "");
    el.style.setProperty("--c", this.peer.color);
    const name = document.createElement("span");
    name.className = "cm-peer-name";
    name.textContent = this.peer.label?.label ?? this.peer.name;
    if (this.peer.label) name.title = this.peer.label.title;
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
/** What the view tells the editor: its own edits (to go to the room), and that its text or selection changed. */
export interface SourceHooks {
  edited(changes: ChangeSet): void;
  moved(): void;
}

/** What the source view's state is made with. */
export function sourceExtensions(hooks: SourceHooks): Extension {
  return [
      peersField,
      history(),
      htmlCode,
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([htmlEnter, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      htmlLook,
      // The view's own edits go to the room; edits from the room come in marked "external".
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) if (tr.docChanged && !tr.isUserEvent("external")) hooks.edited(tr.changes);
        if (u.docChanged || u.selectionSet) hooks.moved();
      }),
  ];
}

/** The view, open in `parent` on `state`. */
export const openSource = (parent: HTMLElement, state: EditorState) => new EditorView({ parent, state });
