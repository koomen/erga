// The agent's turn (agents/run.ts runs it): one state, and what each event does to it. No IO here: `next` answers
// the new state and the effects, and the loop does them.
//
//   idle      no run. A message starts one.
//   running   a run goes: the model's turns and their tool calls. A message steers it (the model has it next turn).
//   stopping  Stop (or a new conversation) was asked: the run ends after the tool call that runs now, never in the
//             middle of one. A message waits for the end, then starts a new run.
//   asking    the run ended at a tool call that needs the person's Approve (an operation's `asks`: a delete, a share
//             with anyone, an admin change). Approve runs the call and the run goes on; Deny, a new message or Stop
//             closes it unrun (the model hears so). A restart closes it too: it is never approved by default.
//   resuming  a run that a restart cut off goes on from its last checkpoint (agents/checkpoint.ts). A message steers
//             the run that follows; Stop or a new conversation waits for the resume to end.
//
// The rule for the queue on Stop: a message sent before Stop is never answered. It goes into the conversation, as
// the transcript shows it, and the store no longer keeps it as waiting, so a restart doesn't answer it either. A
// message sent after Stop starts a new run once the old one ended. A new conversation drops both.

export type Turn =
  | { readonly at: "idle" }
  | { readonly at: "running" }
  | { readonly at: "stopping"; readonly reset: boolean }
  /** `id`: the tool call that waits for the person's answer. */
  | { readonly at: "asking"; readonly id: string }
  | { readonly at: "resuming"; readonly stop: "no" | "stop" | "reset" };

export type TurnEvent =
  /** The person sent a message. */
  | { readonly e: "prompt" }
  | { readonly e: "stop" }
  /** A new conversation. */
  | { readonly e: "reset" }
  /** A restart cut a run off: go on with it. */
  | { readonly e: "resume" }
  /** The resume's work is done: whether the run goes on; whether messages steer it, or wait after a Stop. */
  | { readonly e: "resumed"; readonly going: boolean; readonly steered: boolean; readonly held: boolean }
  /** The person's answer to the call `id` that waits for it: run it, or not. */
  | { readonly e: "approve"; readonly id: string }
  | { readonly e: "deny"; readonly id: string }
  /**
   * The run ended (done, failed or stopped); whether messages steer it, or wait after a Stop. `asking`: it ended at
   * this tool call, which needs the person's Approve.
   */
  | { readonly e: "ended"; readonly steered: boolean; readonly held: boolean; readonly asking?: string };

export type TurnEffect =
  /** The message steers the run: the model has it at its next turn. */
  | "steer"
  /** The message waits for the stop to end. */
  | "hold"
  | "start"
  /** The messages that steer the run are no longer kept as waiting (the store's queue). */
  | "unqueue"
  /** The run ends after the tool call that runs now. */
  | "interrupt"
  /** The messages that steered go into the conversation, unanswered. */
  | "settle"
  /** The messages that waited for the stop steer the next run. */
  | "release"
  /** The conversation is forgotten, with every message that waits. */
  | "clear"
  /** The call that waited for the person's answer may run: the next run runs it. */
  | "approve"
  /** The call that waited, and the turn's calls after it, get a result that says they did not run. */
  | "deny";

export const IDLE: Turn = { at: "idle" };
const RUNNING: Turn = { at: "running" };

/** What a stop leaves once the run (or the resume) ended. */
const afterStop = (reset: boolean, held: boolean): [Turn, TurnEffect[]] =>
  reset ? [IDLE, ["clear"]] : held ? [RUNNING, ["settle", "release", "start"]] : [IDLE, ["settle"]];

export function next(t: Turn, ev: TurnEvent): [Turn, TurnEffect[]] {
  switch (t.at) {
    case "idle":
      if (ev.e == "prompt") return [RUNNING, ["steer", "start"]];
      if (ev.e == "reset") return [t, ["clear"]];
      if (ev.e == "resume") return [{ at: "resuming", stop: "no" }, []];
      return [t, []];
    case "running":
      if (ev.e == "prompt") return [t, ["steer"]];
      if (ev.e == "stop" || ev.e == "reset") return [{ at: "stopping", reset: ev.e == "reset" }, ["unqueue", "interrupt"]];
      // A message that came as the run ended: a new run answers it.
      // A message that came before the question counts as the answer: no.
      if (ev.e == "ended" && ev.asking != null) return ev.steered ? [t, ["deny", "start"]] : [{ at: "asking", id: ev.asking }, []];
      if (ev.e == "ended") return ev.steered ? [t, ["start"]] : [IDLE, []];
      return [t, []];
    case "stopping":
      if (ev.e == "prompt") return [t, ["hold"]];
      if (ev.e == "reset") return [{ at: "stopping", reset: true }, []];
      if (ev.e == "ended") {
        const [after, effects] = afterStop(t.reset, ev.held);
        return [after, ev.asking != null ? ["deny", ...effects] : effects];
      }
      return [t, []];
    case "asking":
      if (ev.e == "approve" && ev.id == t.id) return [RUNNING, ["approve", "start"]];
      if (ev.e == "deny" && ev.id == t.id) return [RUNNING, ["deny", "start"]];
      if (ev.e == "prompt") return [RUNNING, ["deny", "steer", "start"]];
      if (ev.e == "stop") return [IDLE, ["deny"]];
      if (ev.e == "reset") return [IDLE, ["clear"]];
      return [t, []];
    case "resuming":
      if (ev.e == "prompt") return [t, [t.stop == "no" ? "steer" : "hold"]];
      if (ev.e == "stop" || ev.e == "reset") {
        const stop = ev.e == "reset" || t.stop == "reset" ? "reset" : "stop";
        return [{ at: "resuming", stop }, t.stop == "no" ? ["unqueue"] : []];
      }
      if (ev.e == "resumed") {
        if (t.stop != "no") return afterStop(t.stop == "reset", ev.held);
        return ev.going || ev.steered ? [RUNNING, ["start"]] : [IDLE, []];
      }
      return [t, []];
  }
}
