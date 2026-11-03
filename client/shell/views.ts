// Two views of the document: the page itself, and the file's source (its HTML), editable. ⌘⇧P goes between them.

import { EditorSelection, EditorState, Transaction, type ChangeSet } from "@codemirror/state";
import { changesBetween } from "../../document/merge";
import { live } from "../live/client";
import { $, type Mode, type Shell } from "./shell";

export function mountViews(shell: Shell) {
  // The source view edits this tab's replica of the room, as the page's editor edits its own: both land in the same
  // file. Its code (source-view.ts: CodeMirror's view and html-code.ts) loads the first time it opens.
  let sourceCode: Promise<typeof import("./source-view")> | null = null;
  const loadSource = () =>
    (sourceCode ??= import("./source-view").then(
      (m) => (shell.source = m),
      (e) => {
        sourceCode = null;
        // A chunk that isn't there any more is a new release: the page asks the server, and reloads (live.ts).
        live((l) => l.check("a request failed"));
        throw e;
      }
    ));
  const sourceHooks = {
    edited(changes: ChangeSet) {
      shell.collab.push(changes);
      shell.chrome.hideChrome();
    },
    moved: () => shell.people.queueCursor(),
  };

  // The page's editor stops while the source view is open (the page shows the file's last state), and starts again from
  // the room's text after. The source view's state, kept for the next time it opens (its undo history, brought to the
  // room's text then). A switch asked for meanwhile waits its turn.
  let kept: EditorState | null = null;
  let switching: Promise<void> = Promise.resolve();
  function setMode(next: Mode) {
    switching = switching.then(() => switchMode(next));
  }
  async function switchMode(next: Mode) {
    if (next == shell.mode) return;
    if (next != "text") {
      let code: typeof import("./source-view");
      try {
        code = await loadSource();
      } catch {
        shell.toast.flash("Couldn't open the source: check your connection and try again.", 4000);
        return;
      }
      const text = shell.collab.current(),
        sel = shell.currentSelection().main;
      const at = (n: number) => Math.min(n, text.length);
      let state = kept;
      if (state && state.doc.toString() != text)
        state = state.update({
          changes: changesBetween(state.doc.toString(), text),
          annotations: Transaction.addToHistory.of(false),
        }).state;
      state = (state ?? EditorState.create({ doc: text, extensions: code.sourceExtensions(sourceHooks) })).update({
        selection: EditorSelection.single(at(sel.anchor), at(sel.head)),
      }).state;
      shell.page.stop();
      shell.mode = next;
      shell.sourceView = code.openSource($("source"), state);
      // This tab's caret is the source view's while it's open.
      shell.collab.present();
      $("source").hidden = false;
      document.body.classList.add("source");
      shell.sourceView.focus();
    } else {
      kept = shell.sourceView?.state ?? null;
      shell.sourceView?.destroy();
      shell.sourceView = null;
      shell.collab.leave();
      shell.mode = next;
      $("source").hidden = true;
      document.body.classList.remove("source");
      shell.page.start();
      shell.page.focus();
    }
    shell.people.queuePeers();
  }
  /** ⌘⇧P: between the page and the file's own source. */
  const toggleSource = (force?: boolean) => setMode((typeof force == "boolean" ? force : shell.mode == "text") ? "html" : "text");
  return { setMode, toggleSource, switched: () => switching };
}

export type Views = ReturnType<typeof mountViews>;
