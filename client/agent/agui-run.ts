// A hosted agent in the panel, as a state machine with no IO (agui-http.ts does what it answers): the person sends a
// message, the page posts a run to the agent's AG-UI endpoint, and the agent's events become the panel's log
// (shared/agui.ts). AG-UI over HTTP has no cancel and no steering: Stop closes the stream, and a message sent while a
// run goes closes that run and starts the next one with it. An agent that answers 401 or 403 wants the person's
// sign-in there: the run waits (`held`) until they come back.

import type { LogEvent } from "../../shared/agent-log";
import { answer, eventOf, send, start, step, type Fold } from "../../shared/agui";
import type { RunAgentInput } from "../../shared/agui-schema";

export interface Hosted {
  readonly fold: Fold;
  readonly at: "idle" | "running" | "sign-in";
  /** The run that was posted last: only its stream is heard. */
  readonly run: string | null;
  /** The run's input, to post again after the person signs in at the agent. */
  readonly held: RunAgentInput | null;
  /** The run said how it ended (RUN_FINISHED, RUN_ERROR): a stream that closes before that was cut. */
  readonly ended: boolean;
}

export type HostedEvent =
  /** `id`: the tab's id for the message (client/agent/sends.ts); `run`: a new id for the run. */
  | { e: "send"; text: string; context: string | null; id: string; run: string }
  | { e: "answer"; item: string; approve: boolean; run: string }
  /** One frame of the stream of `run`: its JSON value (null: not JSON). */
  | { e: "frame"; run: string; value: unknown }
  | { e: "closed"; run: string }
  /** The agent's answer was no stream: its status. */
  | { e: "refused"; run: string; status: number }
  /** No answer at all: the network, or the agent does not permit this site's pages. */
  | { e: "lost"; run: string }
  | { e: "stop" }
  | { e: "signed-in" }
  | { e: "not-now" }
  | { e: "reset"; thread: string };

export type HostedEffect =
  | { t: "post"; input: RunAgentInput }
  | { t: "abort" }
  | { t: "log"; ev: LogEvent }
  /** The card that asks the person to sign in at the agent: shown, or gone. */
  | { t: "sign-in"; show: boolean }
  | { t: "save" };

export const hostedStart = (agent: string, thread: string): Hosted => ({
  fold: start(agent, thread),
  at: "idle",
  run: null,
  held: null,
  ended: true,
});

const log = (ev: LogEvent): HostedEffect => ({ t: "log", ev });
const BUSY = log({ t: "busy", busy: true }),
  IDLE = log({ t: "busy", busy: false });
/** The fold with no run open: its stream is gone. */
const cut = (fold: Fold): Fold => ({ ...fold, run: null, said: null });
/** What the agent gets of the page with a message. */
const CONTEXT = "What the person has open in Erga";

export function hostedStep(s: Hosted, ev: HostedEvent): { state: Hosted; effects: HostedEffect[] } {
  const same = { state: s, effects: [] };
  const idle = (fold: Fold, effects: HostedEffect[]) => ({
    state: { ...s, fold, at: "idle" as const, held: null },
    effects: [...effects, IDLE, { t: "save" as const }],
  });
  const post = (fold: Fold, input: RunAgentInput, before: HostedEffect[]) => ({
    state: { fold, at: "running" as const, run: input.runId, held: input, ended: false },
    effects: [...before, { t: "sign-in" as const, show: false }, BUSY, { t: "post" as const, input }],
  });
  const heard = "run" in ev && ev.e != "send" && ev.e != "answer" ? s.at == "running" && ev.run == s.run : true;
  if (!heard) return same;
  const name = s.fold.agent;
  switch (ev.e) {
    case "send": {
      const going: HostedEffect[] = s.at == "running" ? [{ t: "abort" }] : [];
      const r = send(
        s.at == "running" ? cut(s.fold) : s.fold,
        ev.run,
        ev.text,
        ev.context ? { context: [{ description: CONTEXT, value: ev.context }] } : {}
      );
      return post(r.fold, r.input, [...going, log({ t: "user", text: ev.text, id: ev.id })]);
    }
    case "answer": {
      const r = s.at == "running" ? null : answer(s.fold, ev.item, ev.approve);
      if (!r) return same;
      const out = r.out.map(log);
      if (!r.ready) return { state: { ...s, fold: r.fold }, effects: out };
      const next = send(r.fold, ev.run, null);
      return post(next.fold, next.input, out);
    }
    case "frame": {
      const checked = eventOf(ev.value);
      if ("unknown" in checked) return same;
      // The specification's rule: a known event with a wrong value fails the run.
      if ("malformed" in checked)
        return idle(cut(s.fold), [
          { t: "abort" },
          log({ t: "error", text: `${name} sent an event that AG-UI 1.0 does not permit (${checked.malformed}).` }),
        ]);
      const r = step(s.fold, checked.event);
      const ended = s.ended || checked.event.type == "RUN_FINISHED" || checked.event.type == "RUN_ERROR";
      return { state: { ...s, fold: r.fold, ended }, effects: r.out.map(log) };
    }
    case "closed":
      return idle(cut(s.fold), s.ended ? [] : [log({ t: "error", text: `${name}'s answer stopped before its end.` })]);
    case "refused":
      if (ev.status == 401 || ev.status == 403) return { state: { ...s, at: "sign-in" }, effects: [IDLE, { t: "sign-in", show: true }] };
      return idle(s.fold, [log({ t: "error", text: `${name} answered ${ev.status}.` })]);
    case "lost":
      return idle(s.fold, [log({ t: "error", text: `${name} did not answer. It may not permit this site to call it.` })]);
    case "stop":
      return s.at == "running" ? idle(cut(s.fold), [{ t: "abort" }]) : same;
    case "signed-in":
      return s.at == "sign-in" && s.held ? post(s.fold, s.held, []) : same;
    case "not-now":
      return s.at == "sign-in" ? { state: { ...s, at: "idle", held: null }, effects: [{ t: "sign-in", show: false }] } : same;
    case "reset":
      return {
        state: hostedStart(name, ev.thread),
        effects: [
          ...(s.at == "running" ? [{ t: "abort" as const }] : []),
          { t: "sign-in", show: false },
          log({ t: "reset" }),
          { t: "save" },
        ],
      };
  }
}

/**
 * A reader of server-sent events: give it the stream's text as it comes, and it gives `data` each event's data (the
 * lines of its `data:` fields). Comments and the other fields are skipped.
 */
export function sse(data: (text: string) => void): (chunk: string) => void {
  let rest = "",
    lines: string[] = [];
  return (chunk) => {
    // (A carriage return at the chunk's end may be half of a line's end: it waits for the next chunk.)
    const text = rest + chunk,
      half = text.endsWith("\r") ? "\r" : "";
    const all = text.slice(0, text.length - half.length).split(/\r\n|\n|\r/);
    rest = (all.pop() ?? "") + half;
    for (const line of all) {
      if (line == "") {
        if (lines.length) data(lines.join("\n"));
        lines = [];
      } else if (line.startsWith("data:")) lines.push(line.slice(line[5] == " " ? 6 : 5));
    }
  };
}
