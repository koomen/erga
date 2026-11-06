// The phase of the page's news socket (live-rows.ts): one value, and what each event does to it. Pure: live-rows.ts
// does the effects it returns, and clears the backoff's timer each time the phase leaves backoff, so a list that
// stops (its page left) never gets a socket that nothing owns.
//
//   stopped --start--> connecting --opened--> open --closed--> backoff --timer--> connecting
//   any --stop--> stopped

export type NewsPhase = { at: "connecting"; tries: number } | { at: "open" } | { at: "backoff"; tries: number } | { at: "stopped" };

export type NewsEvent = { type: "start" } | { type: "opened" } | { type: "closed" } | { type: "timer" } | { type: "stop" };

export type NewsEffect =
  | { do: "connect" }
  /** The socket opened: say the last version heard. */
  | { do: "up" }
  | { do: "down" }
  /** Connect again after `backoff(tries)` (client/live/client.ts). */
  | { do: "retry"; tries: number }
  /** Close the socket, if there is one. */
  | { do: "shut" };

export function newsStep(p: NewsPhase, e: NewsEvent): { phase: NewsPhase; effects: NewsEffect[] } {
  const same = { phase: p, effects: [] };
  switch (e.type) {
    case "start":
      return p.at == "stopped" ? { phase: { at: "connecting", tries: 0 }, effects: [{ do: "connect" }] } : same;
    case "opened":
      return p.at == "connecting" ? { phase: { at: "open" }, effects: [{ do: "up" }] } : same;
    case "timer":
      return p.at == "backoff" ? { phase: { at: "connecting", tries: p.tries }, effects: [{ do: "connect" }] } : same;
    case "closed": {
      if (p.at != "connecting" && p.at != "open") return same;
      const tries = p.at == "connecting" ? p.tries : 0;
      return { phase: { at: "backoff", tries: tries + 1 }, effects: [{ do: "down" }, { do: "retry", tries }] };
    }
    case "stop":
      return p.at == "stopped" ? same : { phase: { at: "stopped" }, effects: [{ do: "shut" }] };
  }
}
