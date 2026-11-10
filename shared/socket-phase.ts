// The phase of a page's live connection (a WebSocket that connects again after a failure): one value, and what each
// event does to it. Pure: the socket's owner does the effects it returns, and clears the backoff's timer each time the
// phase leaves backoff, so a timer that fires in any other phase does nothing. Every live connection uses it: the
// editor's room (libs/text/ui/collab.ts), the viewer's (client/inline/viewer-live.ts), the live lists'
// (client/common/live-rows.ts) and the agent panel's (client/agent/person-agent.ts). Each gives its rules: which close
// codes are final; its owner chooses the wait before the next try.
//
//   stopped --start--> connecting --opened--> open --ready--> open, ready
//   connecting | open --closed--> backoff --timer--> connecting
//                     --closed, a final code--> ended (it never comes back by itself)
//   connecting --closed, never in, after `refuseAfter` failures--> ended, "refused"
//   any --stop--> stopped

export type SocketPhase =
  | { at: "stopped" }
  | { at: "connecting"; tries: number }
  /** `ready`: the owner's first exchange on this socket is done (the room: its first sync). */
  | { at: "open"; ready: boolean }
  | { at: "backoff"; tries: number }
  | { at: "ended"; why: string };

export type PhaseEvent =
  | { type: "start" }
  | { type: "opened" }
  | { type: "ready" }
  /** The socket closed. `known`: the owner was in once (else a refusal looks the same as a failure). */
  | { type: "closed"; code?: number; known?: boolean }
  | { type: "timer" }
  | { type: "stop" };

export type PhaseEffect =
  | { do: "connect" }
  | { do: "up" }
  /** The connection is lost for now. `open`: it was open (not only on its way). */
  | { do: "down"; open: boolean }
  /** Connect again after the owner's wait for try number `tries` (from 0). */
  | { do: "retry"; tries: number }
  /** It ended for good, and why: a final close code's reason, or "refused". */
  | { do: "end"; why: string; open: boolean }
  /** Close the socket, if there is one. */
  | { do: "shut" };

export interface PhaseRules {
  /** The close codes that end the connection, each with its reason. */
  readonly final?: Readonly<Record<number, string>>;
  /** A socket that was never in ends as "refused" on the failure after this many. */
  readonly refuseAfter?: number;
}

export type SocketStep = (p: SocketPhase, e: PhaseEvent) => { phase: SocketPhase; effects: PhaseEffect[] };

export const socketStep =
  (rules: PhaseRules = {}): SocketStep =>
  (p, e) => {
    const same = { phase: p, effects: [] };
    const live = p.at == "connecting" || p.at == "open";
    const open = p.at == "open";
    switch (e.type) {
      case "start":
        return p.at == "stopped" ? { phase: { at: "connecting", tries: 0 }, effects: [{ do: "connect" }] } : same;
      case "opened":
        return p.at == "connecting" ? { phase: { at: "open", ready: false }, effects: [{ do: "up" }] } : same;
      case "ready":
        return open ? { phase: { at: "open", ready: true }, effects: [] } : same;
      case "timer":
        return p.at == "backoff" ? { phase: { at: "connecting", tries: p.tries }, effects: [{ do: "connect" }] } : same;
      case "stop":
        return p.at == "stopped" ? same : { phase: { at: "stopped" }, effects: [{ do: "shut" }] };
      case "closed": {
        if (!live) return same;
        const why = e.code == null ? undefined : rules.final?.[e.code];
        if (why) return { phase: { at: "ended", why }, effects: [{ do: "end", why, open }] };
        const tries = p.at == "connecting" ? p.tries : 0;
        if (rules.refuseAfter != null && !open && !e.known && tries >= rules.refuseAfter)
          return { phase: { at: "ended", why: "refused" }, effects: [{ do: "end", why: "refused", open }] };
        return {
          phase: { at: "backoff", tries: tries + 1 },
          effects: [
            { do: "down", open },
            { do: "retry", tries },
          ],
        };
      }
    }
  };
