// The room: the connection's state, everyone else's edits as they land, the page rendered again when it must be, and
// the events on the document's socket.

import { Transaction, type ChangeSet } from "@codemirror/state";
import type { SocketEvent } from "../../libs/text/ui/collab";
import type { DocName, Hello } from "../../document/api";
import type { LogEvent } from "../../shared/agent-log";
import type { LiveRequest } from "../../shared/live-page";
import { live } from "../live/client";
import type { Shell } from "./shell";
import { esc } from "../../shared/html";

/** What the note says while the room can't be reached. */
export const OFFLINE_NOTE = "Offline. Your edits will sync when you reconnect.";

export function mountRoom(shell: Shell) {

  // The room writes files to disk as edits land; there's nothing to save here. Without a connection, edits stay in this
  // tab and in this browser (collab.ts, `keep`), and sync on return. A short break (the server restarting, a redeploy)
  // passes unseen: the room reconnects by itself. A longer one, or the browser offline, shows one quiet line (live.ts's
  // note), which goes when the room is back.
  let connected = true;
  function connectionChanged(now: boolean) {
    // (The body's erga-listening class: this tab hears its agent, and open_page counts it. Set by the hello: socketEvent.)
    if (!now) document.body.classList.remove("erga-listening");
    if (now == connected) return;
    connected = now;
    live((l) => l.connection("room", now, OFFLINE_NOTE));
  }

  /**
   * Someone else's edit (a person, an agent, the disk), against the text as it is: into the source view, if it's open,
   * out of its undo history. The page's editor has a replica of its own, and takes it there.
   */
  function applyRemote(changes: ChangeSet) {
    if (shell.sourceView) shell.sourceView.dispatch({ changes, annotations: Transaction.addToHistory.of(false), userEvent: "external" });
    shell.people.queuePeers();
  }

  /** The problems this page view has shown (client/shell/problems.ts): each once. */
  const shownProblems = new Set<string>();

  // Your agent's events and its requests to look at the page come to your tabs only, on the document's socket (as
  // text, beside the room's messages: collab.ts). Events sent while it was down are gone: each time it's back (or the
  // document opens for it again), the host says hello afresh, with the document's name and tree, and then the agent's
  // state with its transcript, which this catches up from.
  let greeted = false;
  function socketEvent(m: SocketEvent) {
    const msg = m as {
      type: string;
      ev?: LogEvent;
      id?: string;
      req?: LiveRequest;
      name?: DocName;
      moved?: { from: string; to: string };
      deleted?: string;
      path?: string;
      kind?: "document" | "project";
    };
    if (msg.type == "hello") {
      const h = m as Hello;
      // The body's erga-listening class: this tab hears its agent (and open_page counts it). Tests wait on it.
      document.body.classList.add("erga-listening");
      if (h.info.docName && shell.docName) shell.naming.showName(h.info.docName);
      if (greeted) { shell.docSettings?.event("versions"); shell.docSettings?.event("home"); shell.docSettings?.event("tree"); }
      greeted = true;
      shell.naming.applyKind(h.tree.kind);
      stillHere(h.tree);
    }
    // Your agent's changes to this document (its tools run here, as your agent): Undo's count in its panel.
    else if (msg.type == "agent" && msg.ev?.t == "undoable") window.dispatchEvent(new Event("erga:agent-tool"));
    else if (msg.type == "live" && msg.id && msg.req) shell.requests.answerLive(msg.id, msg.req);
    else if (msg.type == "name" && msg.name) shell.naming.showName(msg.name);
    else if (msg.type == "versions" || msg.type == "home") shell.docSettings?.event(msg.type);
    else if (msg.type == "access") shell.sharing?.accessChanged();
    else if (msg.type == "tree") { shell.naming.applyKind(msg.kind); treeChanged(msg); shell.docSettings?.event("tree"); }
    // Your agent (or an external one, as you) opened another page: go there (open_page).
    else if (msg.type == "open" && msg.path && msg.path != shell.info!.path) shell.openPage(msg.path);
  }

  // The document's file tree changed (anyone's doing: document/pages.ts). Whatever shows the tree hears it as an
  // "erga-tree" event on window (the event's detail is the message: { type: "tree", moved?, deleted? }) and
  // fetches it again (the tree, document/pages.ts, does both). This page, moved, goes to where it went; deleted, to the document's own.
  function treeChanged(msg: { moved?: { from: string; to: string }; deleted?: string }) {
    window.dispatchEvent(new CustomEvent("erga-tree", { detail: { type: "tree", ...msg } }));
    const under = (p: string) => shell.pagePath == p || shell.pagePath.startsWith(`${p}/`);
    if (msg.moved && under(msg.moved.from)) shell.goTo(shell.addressOf(msg.moved.to + shell.pagePath.slice(msg.moved.from.length)), true);
    else if (msg.deleted && under(msg.deleted)) shell.goTo(shell.addressOf(null), true);
  }
  /**
   * Whether this page is still there, by the tree the hello brings (a move or delete may have gone by while the
   * socket was down): if it moved, to where it went (the host remembers the latest moves); if it's gone, to the first page.
   */
  function stillHere(t: Hello["tree"]) {
    if (t.entries.some((e) => e.path == shell.pagePath)) return;
    let at = shell.pagePath;
    for (const m of t.moved ?? []) if (at == m.from || at.startsWith(`${m.from}/`)) at = m.to + at.slice(m.from.length);
    shell.goTo(shell.addressOf(t.entries.some((e) => e.path == at) ? at : null), true);
  }
  return {
    connectionChanged,
    applyRemote,
    socketEvent,
    shownProblems,
    get connected() {
      return connected;
    },
  };
}

export type Room = ReturnType<typeof mountRoom>;
