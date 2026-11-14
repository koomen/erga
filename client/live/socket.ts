// A page's live socket and its owner: a WebSocket to this server that connects again after a failure. The phase is
// shared/socket-phase.ts's; this keeps it and does what it asks: connect, wait before the next try (backoff), close,
// and tell live.ts (client.ts: the corner's "Reconnecting…") that the connection is up, down or gone. The viewer
// (client/inline/viewer-live.ts), the live lists (client/common/live-rows.ts) and the agent panel
// (client/agent/person-agent.ts) each give it an address and what to do with what comes.

import { asUser } from "../common/tools";
import { PING, PONG } from "../../shared/room-socket";
import { SIGNED_OUT, socketStep, type PhaseEvent, type PhaseRules, type SocketPhase } from "../../shared/socket-phase";
import { backoff, live } from "./client";

export interface LiveSocket {
  /** Its name for live.ts. */
  name: string;
  /** Its address on this host (local development's ?user= goes on it). */
  path: string;
  /** Which close codes end it for good (none without). */
  rules?: PhaseRules;
  /** The server answers a ping: an idle socket is pinged, and closed if it stays silent. */
  ping?: boolean;
  /** It opened, the first time and each time it comes back. */
  up?(ws: WebSocket): void;
  /** A message came (never a ping's answer). */
  message(e: MessageEvent): void;
  /** It ended for good (`why`: its rules' reason): what the corner says. */
  ended?(why: string): string;
}

/** A live socket, stopped: `start` connects it, and it stays connected until `stop`. */
export function liveSocket(o: LiveSocket): { start(): void; stop(): void } {
  const step = socketStep(o.rules);
  let phase: SocketPhase = { at: "stopped" },
    socket: WebSocket | null = null,
    retry: ReturnType<typeof setTimeout> | undefined,
    // This browser is signed out (live.ts): no new try. And when this socket last asked why it didn't open.
    out = false,
    asked = 0,
    hears = false;
  /** An event of the socket's: its new phase, and what that asks for. */
  function go(e: PhaseEvent): void {
    const next = step(phase, e);
    phase = next.phase;
    if (phase.at != "backoff") clearTimeout(retry);
    for (const f of next.effects) {
      if (f.do == "connect") connect();
      else if (f.do == "retry") retry = setTimeout(() => go({ type: "timer" }), backoff(f.tries));
      else if (f.do == "up") {
        if (socket) o.up?.(socket);
        live((l) => l.connection(o.name, "up"));
      } else if (f.do == "down") live((l) => l.connection(o.name, "down"));
      else if (f.do == "end")
        live((l) => (f.why == SIGNED_OUT ? l.connection(o.name, null) : l.connection(o.name, "gone", o.ended?.(f.why))));
      else if (f.do == "shut") {
        const ws = socket;
        socket = null;
        ws?.close();
        live((l) => l.connection(o.name, null));
      }
    }
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol == "https:" ? "wss" : "ws"}://${location.host}${asUser(o.path)}`);
    socket = ws;
    let heard = Date.now(),
      opened = false;
    // An idle socket can die without a close: a ping now and then, and one with no answer for a while is closed.
    const ping = o.ping
      ? setInterval(() => {
          if (ws.readyState != WebSocket.OPEN) return;
          if (Date.now() - heard > 75_000) return ws.close();
          ws.send(PING);
        }, 30_000)
      : undefined;
    ws.onopen = () => {
      opened = true;
      if (socket == ws) go({ type: "opened" });
    };
    ws.onmessage = (e) => {
      heard = Date.now();
      if (e.data != PONG) o.message(e);
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (socket != ws) return;
      socket = null;
      // It never opened, and the browser doesn't say why. The server does, to a plain request of the same address: 401
      // when this browser is signed out, which live.ts hears (at most one such request a minute; X-Erga-Check: the
      // worker leaves it to the network, client/inline/offline-sw.ts).
      if (!opened && !out && navigator.onLine && Date.now() - asked > 60_000) {
        asked = Date.now();
        void fetch(asUser(o.path), { credentials: "same-origin", headers: { "X-Erga-Check": "socket" } }).then(
          (r) => r.body?.cancel(),
          () => {}
        );
      }
      go({ type: "closed", code: e.code, out });
    };
  }
  return {
    start: () => {
      // (From its first start: a socket may be made where there is no window yet.)
      if (!hears)
        live((l) =>
          l.signedOut(() => {
            out = true;
            go({ type: "out" });
          })
        );
      hears = true;
      go({ type: "start" });
    },
    stop: () => go({ type: "stop" }),
  };
}
