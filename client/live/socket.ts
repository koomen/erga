// A page's live socket and its owner: a WebSocket to this server that connects again after a failure. The phase is
// shared/socket-phase.ts's; this keeps it and does what it asks: connect, wait before the next try (backoff), close,
// and tell live.ts (client.ts: the corner's "Reconnecting…") that the connection is up, down or gone. The viewer
// (client/inline/viewer-live.ts), the live lists (client/common/live-rows.ts) and the agent panel
// (client/agent/person-agent.ts) each give it an address and what to do with what comes.

import { asUser } from "../common/tools";
import { PING, PONG } from "../../shared/room-socket";
import { socketStep, type PhaseEvent, type PhaseRules, type SocketPhase } from "../../shared/socket-phase";
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
    retry: ReturnType<typeof setTimeout> | undefined;
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
      else if (f.do == "end") live((l) => l.connection(o.name, "gone", o.ended?.(f.why)));
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
    let heard = Date.now();
    // An idle socket can die without a close: a ping now and then, and one with no answer for a while is closed.
    const ping = o.ping
      ? setInterval(() => {
          if (ws.readyState != WebSocket.OPEN) return;
          if (Date.now() - heard > 75_000) return ws.close();
          ws.send(PING);
        }, 30_000)
      : undefined;
    ws.onopen = () => {
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
      go({ type: "closed", code: e.code });
    };
  }
  return { start: () => go({ type: "start" }), stop: () => go({ type: "stop" }) };
}
