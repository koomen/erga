// The viewer, live (server/pages/viewer.ts): the document's page shows each change while it's open, whoever makes it
// (an editor, their agent, an agent over the API). The page listens on the document's own socket as a watcher
// (<base>/api/room?watch=view: it never joins the room), which says the version viewers see now as it opens and as it
// changes (Document.tellView, at most every 2 s). A version other than the one shown loads the page again in its frame,
// where it was scrolled to (?erga-y: the reader puts it back there). Not while the editor is open in this page, nor in
// a hidden tab: it catches up when it shows. A dropped socket comes back by itself, and hears the version first. A
// deleted document (4404), or one no longer theirs (4403), never comes back, and the page says so (shared/socket-phase.ts).

import { backoff, live } from "../live/client";
import { socketStep, type PhaseEvent, type SocketPhase } from "../../shared/socket-phase";
import { DELETED_NOTE, PING, PONG } from "../../shared/room-socket";
import { DONE_MS, QUIET_MS, writerName, writerStep, writerText, type WriterEvent, type WriterPhase } from "../common/writer-phase";

export default function viewerLive(base: string): void {
  // (The version is in a meta, not an argument: the page's build is its scripts, server/live.ts.)
  const ver = document.querySelector<HTMLMetaElement>('meta[name="erga-ver"]')!.content;
  let shown = ver,
    wanted = ver,
    y = 0,
    last = 0,
    heard = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    socket: WebSocket | null = null,
    phase: SocketPhase = { at: "connecting", tries: 0 },
    retry: ReturnType<typeof setTimeout> | undefined;
  // Where the reader is scrolled to, as the page in the frame tells (server/pages/reader.ts).
  addEventListener("message", (e) => {
    if (window.ergaFrames.from(e) && e.data?.type == "erga-scroll") y = Number(e.data.y) || 0;
  });
  // (erga-commenting: a commenter's page shows each change in place itself, viewer-comment.ts.)
  const editing = () => document.body.classList.contains("erga-editing") || document.body.classList.contains("erga-commenting");
  /** Loads the version wanted, if it isn't the one shown: now, or once the last load is 2 s old. */
  function show() {
    if (wanted == shown || document.hidden || editing()) return;
    const wait = last + 2000 - Date.now();
    clearTimeout(timer);
    if (wait > 0) {
      timer = setTimeout(show, wait);
      return;
    }
    last = Date.now();
    shown = wanted;
    // A reader's files are at an address with the version in it (server/documents/view.ts): the new version's address.
    const pages = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]');
    if (pages) pages.content = pages.content.replace(/\/@[^/]+\/$/, "/@" + wanted + "/");
    // In place of the entry shown (location.replace; the frame's src would add an entry to the tab's history, and Back
    // would show the old version of the same page).
    window.ergaFrames.frame.contentWindow!.location.replace(window.ergaFrames.src() + (y > 0 ? "?erga-y=" + y : "") + location.hash);
  }
  document.addEventListener("visibilitychange", show);
  // Who writes (an experiment): a small pill at the top of the page while changes come, then "Updated now", then gone
  // (client/common/writer-phase.ts). Never over the text, which gets no highlight.
  let writing: WriterPhase = { at: "none" };
  function writer(e: WriterEvent) {
    const next = writerStep(writing, e);
    writing = next.phase;
    for (const f of next.effects) setTimeout(() => writer({ type: f.wait, n: f.n }), f.wait == "quiet" ? QUIET_MS : DONE_MS);
    let pill = document.getElementById("erga-writer");
    const text = writerText(writing);
    if (!pill && text) {
      pill = Object.assign(document.createElement("p"), { id: "erga-writer" });
      pill.setAttribute("role", "status");
      document.body.append(pill);
    }
    if (!pill) return;
    pill.hidden = !text;
    pill.textContent = text ?? "";
    pill.classList.toggle("on", writing.at == "writing");
  }
  // A deleted document, or one no longer theirs to open, never comes back.
  const step = socketStep({ final: { 4404: "deleted", 4403: "unshared" } });
  /** An event of the socket's: its new phase, and what that asks for. */
  function go(e: PhaseEvent) {
    const next = step(phase, e);
    phase = next.phase;
    if (phase.at != "backoff") clearTimeout(retry);
    for (const f of next.effects) {
      if (f.do == "connect") connect();
      else if (f.do == "retry") retry = setTimeout(() => go({ type: "timer" }), backoff(f.tries));
      else if (f.do == "up" || f.do == "down") live((l) => l.connection("view", f.do));
      else if (f.do == "end")
        live((l) => l.connection("view", "gone", f.why == "deleted" ? DELETED_NOTE : "This document is no longer shared with you."));
    }
  }
  function connect() {
    const user = new URLSearchParams(location.search).get("user");
    const ws = new WebSocket(
      (location.protocol == "https:" ? "wss://" : "ws://") +
        location.host +
        base +
        "/api/room?watch=view" +
        (user ? "&user=" + encodeURIComponent(user) : "")
    );
    socket = ws;
    heard = Date.now();
    ws.onopen = () => {
      if (socket == ws) go({ type: "opened" });
    };
    ws.onmessage = (e) => {
      heard = Date.now();
      if (typeof e.data != "string" || e.data == PONG) return;
      try {
        const m = JSON.parse(e.data) as { type?: string; ver?: string; by?: string };
        if (m.type == "view" && m.ver) {
          // Someone changed it (not the version it hears as the socket opens): the pill says who writes.
          if (m.ver != wanted && typeof m.by == "string" && m.by && !editing())
            writer({ type: "change", by: writerName(m.by.slice(0, 200)) });
          wanted = m.ver;
          show();
        }
      } catch {
        /* not ours */
      }
    };
    ws.onclose = (e) => {
      if (socket != ws) return;
      socket = null;
      go({ type: "closed", code: e.code });
    };
  }
  connect();
  // An idle socket can die without a close: a ping now and then, and one with no answer for a while is closed.
  setInterval(() => {
    if (!socket || socket.readyState != WebSocket.OPEN) return;
    if (Date.now() - heard > 75_000) return socket.close();
    socket.send(PING);
  }, 30_000);
}
