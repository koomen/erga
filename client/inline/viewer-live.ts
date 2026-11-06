// The viewer, live (server/pages/viewer.ts): the document's page shows each change while it's open, whoever makes it
// (an editor, their agent, an agent over the API). The page listens on the document's own socket as a watcher
// (<base>/api/room?watch=view: it never joins the room), which says the version viewers see now as it opens and as it
// changes (Document.tellView, at most every 2 s). A version other than the one shown loads the page again in its frame,
// where it was scrolled to (?erga-y: the reader puts it back there). Not while the editor is open in this page, nor in
// a hidden tab: it catches up when it shows. A dropped socket comes back by itself, and hears the version first. A
// deleted document (4404), or one no longer theirs (4403), never comes back, and the page says so (view-phase.ts).

import { backoff, live } from "../live/client";
import { viewStep, type ViewEvent, type ViewPhase } from "../common/view-phase";
import { DELETED_NOTE, PING, PONG } from "../../shared/room-socket";

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
    phase: ViewPhase = { at: "connecting", tries: 0 },
    retry: ReturnType<typeof setTimeout> | undefined;
  // Where the reader is scrolled to, as the page in the frame tells (server/pages/reader.ts).
  addEventListener("message", (e) => {
    if (window.ergaFrames.from(e) && e.data?.type == "erga-scroll") y = Number(e.data.y) || 0;
  });
  const editing = () => document.body.classList.contains("erga-editing");
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
    const f = window.ergaFrames.frame;
    f.src = window.ergaFrames.src() + (y > 0 ? "?erga-y=" + y : "") + location.hash;
  }
  document.addEventListener("visibilitychange", show);
  /** An event of the socket's: its new phase, and what that asks for. */
  function go(e: ViewEvent) {
    const next = viewStep(phase, e);
    phase = next.phase;
    if (phase.at != "backoff") clearTimeout(retry);
    for (const f of next.effects) {
      if (f.do == "connect") connect();
      else if (f.do == "retry") retry = setTimeout(() => go({ type: "timer" }), backoff(f.tries));
      else
        live((l) =>
          l.connection(
            "view",
            f.state,
            f.why == "deleted" ? DELETED_NOTE : f.why ? "This document is no longer shared with you." : undefined
          )
        );
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
        const m = JSON.parse(e.data) as { type?: string; ver?: string };
        if (m.type == "view" && m.ver) {
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
