// The phase of the viewer's socket (client/inline/viewer-live.ts): one value, and what each event does to it. Pure:
// viewer-live.ts does the effects it returns, and clears the backoff's timer each time the phase leaves backoff.
//
//   connecting --opened--> open --closed--> backoff --timer--> connecting
//   connecting | open --closed 4404 / 4403--> gone (deleted, or no longer theirs to open: it never comes back)

import type { ConnectionState } from "../live/client";

export type ViewPhase =
  | { at: "connecting"; tries: number }
  | { at: "open" }
  | { at: "backoff"; tries: number }
  | { at: "gone"; why: "deleted" | "unshared" };

export type ViewEvent = { type: "opened" } | { type: "closed"; code: number } | { type: "timer" };

export type ViewEffect =
  | { do: "connect" }
  | { do: "status"; state: ConnectionState; why?: "deleted" | "unshared" }
  /** Connect again after `backoff(tries)` (client/live/client.ts). */
  | { do: "retry"; tries: number };

export function viewStep(p: ViewPhase, e: ViewEvent): { phase: ViewPhase; effects: ViewEffect[] } {
  const same = { phase: p, effects: [] };
  switch (e.type) {
    case "opened":
      return p.at == "connecting" ? { phase: { at: "open" }, effects: [{ do: "status", state: "up" }] } : same;
    case "timer":
      return p.at == "backoff" ? { phase: { at: "connecting", tries: p.tries }, effects: [{ do: "connect" }] } : same;
    case "closed": {
      if (p.at != "connecting" && p.at != "open") return same;
      if (e.code == 4404 || e.code == 4403) {
        const why = e.code == 4404 ? "deleted" : "unshared";
        return { phase: { at: "gone", why }, effects: [{ do: "status", state: "gone", why }] };
      }
      const tries = p.at == "connecting" ? p.tries : 0;
      return {
        phase: { at: "backoff", tries: tries + 1 },
        effects: [
          { do: "status", state: "down" },
          { do: "retry", tries },
        ],
      };
    }
  }
}
