// The room: the connection's state, everyone else's edits as they land, the page rendered again when it must be, and
// the events on the document's socket.

import { Transaction, type ChangeSet } from "@codemirror/state";
import type { MarkAuthor } from "../page-editor/editor";
import type { SocketEvent } from "./collab";
import type { Author } from "../../document/content";
import type { AgentState, DocName, Hello, ModelState } from "../../document/api";
import type { LogEvent, ViewRequest } from "../../shared/agent-log";
import { live } from "../live/client";
import { ms } from "../page-editor/timescale";
import { $, type Shell } from "./shell";
import { esc } from "../../shared/html";

export function mountRoom(shell: Shell) {

  const status = $("status");
  let statusTimer = 0;
  function setStatus(text: string, kind?: string) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = "status show" + (kind ? " " + kind : "");
    if (kind != "error") statusTimer = window.setTimeout(() => status.classList.remove("show"), ms(1600));
  }
  // The room writes files to disk as edits land; there's nothing to save
  // here. Without a connection, edits stay in this tab and sync on return.
  // A short break (the server restarting, a redeploy) passes unseen: the room
  // reconnects by itself and live.js shows a quiet "Reconnecting…" if it
  // takes a few seconds. Only a long one says more.
  let connected = true, offlineTimer = 0, saidOffline = false;
  const OFFLINE_NOTE_MS = 20_000;
  function connectionChanged(now: boolean) {
    // (The body's erga-listening class: this tab hears its agent, and open_page counts it. Set by the hello: socketEvent.)
    if (!now) document.body.classList.remove("erga-listening");
    if (now == connected) return;
    connected = now;
    live((l) => l.connection("room", now));
    clearTimeout(offlineTimer);
    if (!now) offlineTimer = window.setTimeout(() => { saidOffline = true; setStatus("Offline: your edits are kept in this tab and sync when the host is back", "error"); }, OFFLINE_NOTE_MS);
    else if (saidOffline) { saidOffline = false; setStatus("Back online; edits synced"); }
  }

  /** Someone else's author entry as the marks show it. */
  const markAuthor = (a: Author | null): MarkAuthor | null => a ? { name: a.kind == "disk" ? "Edited on disk" : a.name, color: a.color } : null;

  // Edits from anyone else (a collaborator, an agent, a change on disk)
  // arrive as changes against the current text and are applied in place,
  // marked in their author's colour. They stay out of the undo history:
  // ⌘Z only takes back your own edits.
  function applyRemote(changes: ChangeSet, author: Author | null) {
    if (shell.sourceView) {
      shell.sourceView.dispatch({ changes, annotations: Transaction.addToHistory.of(false), userEvent: "external" });
      shell.page.recordAuthorship(changes, markAuthor(author));
    }
    // The page takes it when it isn't set aside for the source view.
    shell.page.applyExternal(changes, markAuthor(author));
    shell.people.queuePeers();
  }

  // Changes the editor can't make in place (another file in the folder: a
  // stylesheet, a script; or a script in the page itself) need the page
  // rendered again. While the agent is working that waits for the end of its
  // turn, so a half-built script never runs; a pill says it's pending and
  // offers to refresh now. Otherwise it happens straight away. Either way the
  // new page renders out of sight and takes the old one's place scrolled to
  // the same text. Everything else shows as it's made.
  let reloadTimer = 0;
  // Whether any agent in the room (yours or anyone's) is mid-turn: a
  // structural re-render waits for it, so half-built changes never render.
  let agentIsBusy = false;
  const shownProblems = new Set<string>();
  let refreshPending = false;
  const refreshPill = $("refresh-pill");
  function refreshPage() {
    refreshPending = false;
    refreshPill.hidden = true;
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      if (shell.mode != "text") return; // the page renders afresh on the way back
      shell.page.render();
    }, 120);
  }
  function needRefresh() {
    if (!agentIsBusy) { refreshPage(); return; }
    refreshPending = true;
    renderRefreshPill();
  }
  function renderRefreshPill() {
    refreshPill.hidden = !refreshPending;
    if (!refreshPending) return;
    const who = shell.people.busyAgents();
    const names = who.length ? who.join(" and ") : "the agent";
    refreshPill.querySelector("span")!.innerHTML =
      `Page changes will show when ${esc(names)} ${who.length > 1 ? "finish" : "finishes"} · <b>Refresh now</b>`;
    refreshPill.title = `${names} changed more than text; the page re-renders when ${who.length > 1 ? "they finish" : "it finishes"}.`;
  }
  function setAgentBusy(busy: boolean) {
    if (busy == agentIsBusy) { renderRefreshPill(); return; }
    agentIsBusy = busy;
    if (!busy && refreshPending) refreshPage();
    else renderRefreshPill();
  }
  refreshPill.addEventListener("click", refreshPage);

  // Your agent's events and its requests to look at the page come to your tabs only, on the document's socket (as
  // text, beside the room's messages: collab.ts). Events sent while it was down are gone: each time it's back (or the
  // document opens for it again), the host says hello afresh, with the document's name and tree, and then the agent's
  // state with its transcript, which this catches up from.
  let greeted = false;
  function socketEvent(m: SocketEvent) {
    const msg = m as { type: string; ev?: LogEvent; id?: string; req?: ViewRequest; name?: DocName; moved?: { from: string; to: string }; deleted?: string; path?: string; state?: AgentState; kind?: "document" | "project" };
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
    else if (msg.type == "agent-state" && msg.state) shell.agent.agentState(msg.state);
    else if (msg.type == "agent" && msg.ev) shell.agent.agentEvent(msg.ev);
    else if (msg.type == "model") shell.agent.renderModel(msg as unknown as ModelState);
    else if (msg.type == "view" && msg.id && msg.req?.live) shell.requests.answerLive(msg.id, msg.req.live);
    else if (msg.type == "view" && msg.id) shell.requests.answerView(msg.id, msg.req ?? {});
    else if (msg.type == "name" && msg.name) shell.naming.showName(msg.name);
    else if (msg.type == "versions" || msg.type == "home") shell.docSettings?.event(msg.type);
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
    connectionChanged, applyRemote, needRefresh, setAgentBusy, socketEvent, shownProblems, get connected() { return connected; },
    dropRefresh() { refreshPending = false; renderRefreshPill(); },
  };
}

export type Room = ReturnType<typeof mountRoom>;
