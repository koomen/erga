// The room: the connection's state, and the events on the document's socket.

import type { RoomStatus, SocketEvent } from "./shell-room";
import type { Hello } from "../../document/api/api";
import type { DocName } from "../../document/model/names";
import type { LogEvent } from "../../shared/agent-log";
import type { LiveRequest } from "../../shared/live-page";
import { live } from "../live/client";
import type { Shell } from "./shell";
import { DELETED_NOTE, type UploadsMessage } from "../../shared/room-socket";

export function mountRoom(shell: Shell) {

  // The room writes files to disk as edits land; there's nothing to save here. Without a connection, edits stay in this
  // tab and in this browser (collab.ts, `keep`), and sync on return. A short break (the server restarting, a redeploy)
  // passes unseen: the room reconnects by itself, and nothing says so. Only edits that are not on the server yet show,
  // as the save mark's red x, until they are (libs/text/ui/unsaved.ts). A deleted document's room never comes
  // back: live.ts's note says so, at once.
  let status: RoomStatus = "up";
  function connectionChanged(now: RoomStatus) {
    // (The body's erga-listening class: this tab hears its agent, and open_page counts it. Set by the hello: socketEvent.)
    if (now != "up") document.body.classList.remove("erga-listening");
    if (now == status) return;
    status = now;
    // (Down, it says nothing: the save mark shows only edits that are not on the server yet. libs/text/ui/unsaved.ts)
    live((l) => l.connection("room", now, now == "gone" ? DELETED_NOTE : null));
  }

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
      pages?: number;
      entries?: Hello["tree"]["entries"];
    };
    if (msg.type == "hello") {
      const h = m as Hello;
      // The body's erga-listening class: this tab hears its agent (and open_page counts it). Tests wait on it.
      document.body.classList.add("erga-listening");
      shell.treeEntries = h.tree.entries;
      if (h.info.docName && shell.docName) shell.naming.showName(h.info.docName);
      if (greeted) {
        shell.docSettings?.event("versions");
        shell.docSettings?.event("publishing");
        shell.docSettings?.event("tree");
      }
      greeted = true;
      shell.naming.setPages(h.tree.pages);
      stillHere(h.tree);
    }
    // Your agents' changes to this document (the document's operations, run as you via them): Undo's count in the panel.
    else if (msg.type == "undoable") window.dispatchEvent(new Event("erga:agent-tool"));
    else if (msg.type == "live" && msg.id && msg.req) shell.requests.answerLive(msg.id, msg.req);
    else if (msg.type == "name" && msg.name) shell.naming.showName(msg.name);
    else if (msg.type == "versions" || msg.type == "publishing") shell.docSettings?.event(msg.type);
    else if (msg.type == "access") shell.sharing?.accessChanged();
    else if (msg.type == "uploads") shell.uploads.heard((m as unknown as UploadsMessage).files);
    else if (msg.type == "tree") {
      if (Array.isArray(msg.entries)) shell.treeEntries = msg.entries;
      if (msg.pages != null) shell.naming.setPages(msg.pages);
      treeChanged(msg);
      shell.docSettings?.event("tree");
    }
    // Your agent (or an external one, as you) opened another page: go there (open_page).
    else if (msg.type == "open" && msg.path && msg.path != shell.pagePath) shell.openPage(msg.path);
  }

  // The document's file tree changed (anyone's doing: document/model/pages.ts). Whatever shows the tree hears it as an
  // "erga-tree" event on window (the event's detail is the message: { type: "tree", moved?, deleted? }) and
  // fetches it again (the tree, document/model/pages.ts, does both). This page, moved, goes to where it went; deleted, to the document's own.
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
    socketEvent,
    get connected() {
      return status == "up";
    },
  };
}

export type Room = ReturnType<typeof mountRoom>;
