// The phase of the room's socket (collab.ts): one value, and what each event does to it. Pure: collab.ts does the
// effects it returns. The timer is the backoff's: collab.ts clears it each time the phase leaves backoff, and a timer
// that fires in any other phase does nothing.
//
//   connecting --opened--> open --synced--> synced
//   connecting | open | synced --closed--> backoff --timer--> connecting
//                              --closed 4404--> gone (the document was deleted)
//                              --closed 4403--> stopped, and the page loads again (no longer theirs to open)
//                              --closed 4409, or stale--> stopped (a stale history: the page loads again)
//   connecting --closed, a third time, never in--> stopped (refused: no such document, or not theirs)
//   any --close--> stopped

export type RoomPhase =
  | { at: "connecting"; tries: number }
  | { at: "open" }
  | { at: "synced" }
  | { at: "backoff"; tries: number }
  | { at: "gone" }
  | { at: "stopped" };

export type RoomEvent =
  | { type: "opened" }
  /** The room answered this tab's first sync step 1 on this socket. */
  | { type: "synced" }
  /** The socket closed. `known`: this tab had the room's state or its hello once (else a refusal looks the same). */
  | { type: "closed"; code: number; known: boolean }
  | { type: "timer" }
  /** The socket's hello is of another history than this tab's. */
  | { type: "stale" }
  /** The tab leaves the room for good. */
  | { type: "close" };

/** What the page shows of the socket. */
export type RoomStatus = "up" | "down" | "gone";

export type RoomEffect =
  | { do: "connect" }
  /** The socket opened: ask for what changed, send presence, start the pings. */
  | { do: "up" }
  | { do: "status"; status: RoomStatus }
  | { do: "retry"; after: number }
  /** Close the socket, if there is one. */
  | { do: "shut" }
  | { do: "stale" }
  | { do: "reload" }
  | { do: "refused" };

const MAX_WAIT = 2500;

/** What the page shows for a phase. */
export const statusOf = (p: RoomPhase): RoomStatus => (p.at == "open" || p.at == "synced" ? "up" : p.at == "gone" ? "gone" : "down");

export function roomStep(p: RoomPhase, e: RoomEvent): { phase: RoomPhase; effects: RoomEffect[] } {
  const same = { phase: p, effects: [] };
  const live = p.at == "connecting" || p.at == "open" || p.at == "synced";
  switch (e.type) {
    case "opened":
      return p.at == "connecting" ? { phase: { at: "open" }, effects: [{ do: "up" }, { do: "status", status: "up" }] } : same;
    case "synced":
      return p.at == "open" ? { phase: { at: "synced" }, effects: [] } : same;
    case "timer":
      return p.at == "backoff" ? { phase: { at: "connecting", tries: p.tries }, effects: [{ do: "connect" }] } : same;
    case "close":
      return p.at == "stopped" ? same : { phase: { at: "stopped" }, effects: [{ do: "shut" }] };
    case "stale":
      return live ? { phase: { at: "stopped" }, effects: [{ do: "shut" }, { do: "stale" }] } : same;
    case "closed": {
      if (!live) return same;
      const down: RoomEffect[] = p.at == "connecting" ? [] : [{ do: "status", status: "down" }];
      if (e.code == 4404) return { phase: { at: "gone" }, effects: [{ do: "status", status: "gone" }] };
      if (e.code == 4409) return { phase: { at: "stopped" }, effects: [...down, { do: "stale" }] };
      if (e.code == 4403) return { phase: { at: "stopped" }, effects: [...down, { do: "reload" }] };
      // (4408, a role changed: it joins again, as they may now.)
      const tries = p.at == "connecting" ? p.tries : 0;
      if (p.at == "connecting" && !e.known && tries >= 2) return { phase: { at: "stopped" }, effects: [{ do: "refused" }] };
      return {
        phase: { at: "backoff", tries: tries + 1 },
        effects: [...down, { do: "retry", after: Math.min(MAX_WAIT, 100 * 2 ** tries) }],
      };
    }
  }
}
