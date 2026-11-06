// A message the panel sent, from the moment it shows (dimmed) until the agent's transcript has it. Each message has
// the tab's own id (POST /api/agent's `id`), and the transcript's copy carries it: the panel matches the two by id,
// never by text (the server cuts a long message; two tabs may send the same words). agent-chat.ts keeps one state for
// each message and does what `sendStep` returns.

/**
 * - pending: on its way, dimmed;
 * - failed: "Not sent", with Try again;
 * - echoed: the transcript has it (its copy takes the dimmed one's place);
 * - dropped: a new conversation took a failed one away.
 */
export type SendState = "pending" | "failed" | "echoed" | "dropped";

export type SendEvent =
  /** The transcript has a message with this id: an event from the agent, or a conversation loaded. */
  | { t: "echo" }
  /** The server refused it, or didn't answer in time. */
  | { t: "fail"; reason: string }
  /** Try again: the same message, with the same id. */
  | { t: "retry" }
  /** A new conversation. */
  | { t: "reset" };

/** What the panel does: take the dimmed message away, say "Not sent", or send it again. */
export type SendEffect = { t: "remove" } | { t: "show-failed"; reason: string } | { t: "resend" } | null;

export function sendStep(s: SendState, ev: SendEvent): { state: SendState; effect: SendEffect } {
  const stay = { state: s, effect: null };
  switch (s) {
    case "pending":
      if (ev.t == "echo") return { state: "echoed", effect: { t: "remove" } };
      if (ev.t == "fail") return { state: "failed", effect: { t: "show-failed", reason: ev.reason } };
      // (A message on its way goes into the new conversation.)
      return stay;
    case "failed":
      // An answer after the time ran out: it got there after all, and Try again goes.
      if (ev.t == "echo") return { state: "echoed", effect: { t: "remove" } };
      if (ev.t == "retry") return { state: "pending", effect: { t: "resend" } };
      if (ev.t == "reset") return { state: "dropped", effect: { t: "remove" } };
      return stay;
    case "echoed":
    case "dropped":
      return stay;
  }
}
