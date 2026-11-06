// A request for a token (tokens.ts), as a state machine. Its row in token_requests has a status:
//
//   waiting   --approve-->  approved   (effect: mint the token)
//   waiting   --deny------>  gone
//   approved  --collect--->  gone       (effect: hand the token over: the agent's poll, or the OAuth code's trade)
//   waiting   --lapse----->  gone       (past `expires`)
//   approved  --lapse----->  gone       (effect: revoke the token: nobody collected it)
//
// "gone" is no row: a collected or denied request is deleted. Approval starts a new `expires`: the time to collect.
// The IO code (tokens.ts) writes each change with `WHERE status = <from>` and checks that it changed the row, so of
// two changes at once only one happens.

export type Status = "waiting" | "approved";
export type Event = "approve" | "deny" | "collect" | "lapse";
export type Effect = "mint" | "hand_over" | "revoke";

/** A request as its row is now: `expired` if it's past `expires`. */
export interface State {
  status: Status;
  expired: boolean;
}

/** What an event does: the status after (gone: the row goes), and what the IO does then. */
export interface Step {
  to: Status | "gone";
  effect: Effect | null;
}

/** The step for `event` from `state`; null if it does nothing (the request isn't in a state for it). */
export function step(state: State, event: Event): Step | null {
  if (state.expired)
    return event == "lapse" || event == "collect" ? { to: "gone", effect: state.status == "approved" ? "revoke" : null } : null;
  if (state.status == "waiting") {
    if (event == "approve") return { to: "approved", effect: "mint" };
    if (event == "deny") return { to: "gone", effect: null };
    return null;
  }
  return event == "collect" ? { to: "gone", effect: "hand_over" } : null;
}
