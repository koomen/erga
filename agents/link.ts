// An attached session: an agent that runs somewhere else (Claude Code in a terminal) and keeps its own session, with
// a helper beside it that opened a link to its person's agent object (GET /api/agent/link, a WebSocket). Up the link
// come AG-UI 1.0 events, one for each frame (shared/agui-schema.ts): the first is CUSTOM "hello", which names the
// session. Down the link go a RunAgentInput (a message from the panel, or the answers to a run that stopped to ask)
// and {"cancel": runId} (Stop: AG-UI has no cancel message).
//
// This file is the link's state machine, with no IO: the person's agent object keeps each link, hears its socket and
// does what `linkStep` answers (agents/person/sessions.ts). The session owns its conversation: the link keeps only
// what the panel shows of it since the attach (`log`), for a page that opens later.

import { emptyLog, type Log, type LogEvent, reduce } from "../shared/agent-log.ts";
import { answer, send, start, step, type Fold } from "../shared/agui.ts";
import { decodeEvent, type RunAgentInput } from "../shared/agui-schema.ts";

/** The session as its helper names it: all of it is the helper's text. */
export interface Hello {
  /** The session's own id: the helper's link after a break is the same session. */
  id: string;
  /** The agent ("Claude Code"), where it runs ("ada-laptop, ~/trip"), and its model. */
  agent: string;
  where: string;
  model: string;
}

export interface Link {
  /** Null until the hello. */
  readonly hello: Hello | null;
  readonly fold: Fold;
  readonly log: Log;
}

export type LinkEvent =
  /** A frame from the helper: its text. */
  | { e: "frame"; text: string }
  /** From the panel: a message (`id`: the tab's id for it; `run`: a new id for the run), an answer to a card, Stop. */
  | { e: "prompt"; text: string; context: string | null; id?: string; run: string }
  | { e: "answer"; item: string; approve: boolean; run: string }
  | { e: "stop" };

export type LinkEffect =
  /** A frame for the helper. */
  | { t: "down"; frame: RunAgentInput | { cancel: string } }
  /** One event for the panel's log (the link's own copy has it already). */
  | { t: "log"; ev: LogEvent }
  /** The session said who it is: the panels' menus list it. */
  | { t: "hello" }
  /** The helper broke the protocol: the link closes, with why. */
  | { t: "close"; why: string };

/** The log keeps this many items: the session has the rest. */
const KEPT = 400;
const ALSO = "Also asked in the terminal. The first answer counts.";
const CONTEXT = "What the person has open in Erga";

export const linkStart = (): Link => ({ hello: null, fold: start("", ""), log: emptyLog() });

/** A text of the helper's, as one line of at most `max` characters. */
const line = (v: unknown, max: number, or: string) => (typeof v == "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : or);

/** The hello's value, checked: null when it names no session. */
function helloOf(value: unknown): Hello | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.session != "string" || !/^[\w-]{1,64}$/.test(v.session)) return null;
  return { id: v.session, agent: line(v.agent, 40, "Agent"), where: line(v.where, 80, ""), model: line(v.model, 40, "") };
}

export function linkStep(link: Link, ev: LinkEvent): { link: Link; effects: LinkEffect[] } {
  /** The link after the fold's step, with its log's events: the link's own log has them, and the panels get them. */
  const logged = (fold: Fold, out: LogEvent[], more: LinkEffect[] = []) => {
    // (The session keeps the thread's messages: the link keeps none.)
    const log: Log = { ...link.log, items: [...link.log.items] };
    const shown = out.map((o): LogEvent => (o.t == "tool" && o.status == "asking" ? { ...o, note: ALSO } : o));
    for (const o of shown) reduce(log, o);
    if (log.items.length > KEPT) log.items.splice(0, log.items.length - KEPT);
    return {
      link: { ...link, fold: { ...fold, messages: [] }, log },
      effects: [...shown.map((ev): LinkEffect => ({ t: "log", ev })), ...more],
    };
  };
  switch (ev.e) {
    case "frame": {
      let value: unknown = null;
      try {
        value = JSON.parse(ev.text);
      } catch {
        return { link, effects: [{ t: "close", why: "a frame that is not JSON" }] };
      }
      const checked = decodeEvent(value);
      if ("unknown" in checked) return { link, effects: [] };
      if ("malformed" in checked)
        return { link, effects: [{ t: "close", why: `an event that AG-UI 1.0 does not permit (${checked.malformed})` }] };
      const event = checked.event;
      if (!link.hello) {
        const hello = event.type == "CUSTOM" && event.name == "hello" ? helloOf(event.value) : null;
        if (!hello)
          return { link, effects: [{ t: "close", why: "the first frame must be the CUSTOM event hello, with the session's id" }] };
        return { link: { ...link, hello, fold: start(hello.agent, hello.id) }, effects: [{ t: "hello" }] };
      }
      const r = step(link.fold, event);
      return logged(r.fold, r.out);
    }
    case "prompt": {
      if (!link.hello) return { link, effects: [] };
      const r = send(link.fold, ev.run, ev.text, ev.context ? { context: [{ description: CONTEXT, value: ev.context }] } : {});
      return logged(r.fold, [{ t: "user", text: ev.text, ...(ev.id ? { id: ev.id } : {}) }], [{ t: "down", frame: r.input }]);
    }
    case "answer": {
      const r = answer(link.fold, ev.item, ev.approve);
      if (!r) return { link, effects: [] };
      if (!r.ready) return logged(r.fold, r.out);
      const next = send(r.fold, ev.run, null);
      return logged(next.fold, r.out, [{ t: "down", frame: next.input }]);
    }
    case "stop":
      return { link, effects: link.fold.run ? [{ t: "down", frame: { cancel: link.fold.run } }] : [] };
  }
}
