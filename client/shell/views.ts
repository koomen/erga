// Two views of the document: the page itself, and the file's source (its HTML), editable, with the page's state and
// undo history. ⌘⇧P goes between them.

import type { ChangeSet, EditorState } from "@codemirror/state";
import { live } from "../live/client";
import { $, type Mode, type Shell } from "./shell";

export function mountViews(shell: Shell) {
  // One CodeMirror state serves both the page editor and the source view, so the undo history is shared and either
  // view's edits land in the same file. The source view's code (source-view.ts: CodeMirror's view and the HTML
  // language) loads the first time it opens. Its own edits go to the room.
  let sourceCode: Promise<typeof import("./source-view")> | null = null;
  const loadSource = () => sourceCode ??= import("./source-view").then((m) => (shell.source = m), (e) => {
    sourceCode = null;
    // A chunk that isn't there any more is a new release: the page asks the server, and reloads (live.ts).
    live((l) => l.check("a request failed"));
    throw e;
  });
  const sourceHooks = {
    edited(changes: ChangeSet) {
      shell.collab.push(changes);
      shell.page.recordAuthorship(changes, shell.self);
      shell.chrome.hideChrome();
    },
    moved: () => shell.people.queueCursor(),
  };

  // Opening the source view waits for the page to hand over its state; a switch asked for meanwhile waits its turn.
  let switching: Promise<void> = Promise.resolve();
  function setMode(next: Mode) {
    switching = switching.then(() => switchMode(next));
  }
  async function switchMode(next: Mode) {
    if (next == shell.mode) return;
    // Leave the current view; the source view hands the state back to the page.
    if (shell.sourceView) {
      const st = shell.sourceView.state;
      shell.sourceView.destroy();
      shell.sourceView = null;
      shell.page.attach(st, shell.source!.sourceHistory);
    }
    let handed: EditorState | null = null;
    if (next != "text") {
      let code: typeof import("./source-view");
      try { code = await loadSource(); } catch { shell.toast.flash("Couldn't open the source: check your connection and try again.", 4000); return; }
      handed = (await shell.page.detach(code.sourceState(sourceHooks))).state;
    }
    shell.mode = next;
    if (next == "text") {
      $("source").hidden = true;
      document.body.classList.remove("source");
      shell.page.focus();
    } else {
      shell.sourceView = shell.source!.openSource($("source"), handed!);
      $("source").hidden = false;
      document.body.classList.add("source");
      shell.sourceView.focus();
    }
    shell.people.queuePeers();
    shell.fmt.queueFmt();
  }
  /** ⌘⇧P: between the page and the file's own source. */
  const toggleSource = (force?: boolean) => setMode((typeof force == "boolean" ? force : shell.mode == "text") ? "html" : "text");
  return { setMode, toggleSource, switched: () => switching };
}

export type Views = ReturnType<typeof mountViews>;
