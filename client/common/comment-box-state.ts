// The comment box's one state, in the window around the document's page (comment-box.ts draws it and does its IO).
// The page's open card asks for the box (libs/text/ui/comments-state.ts, boxOf): a new comment's, a reply's or an
// edit's, never with text. The person types in it here, where the page's scripts can't reach, and Enter sends it with
// the person's session. The page hears what was sent and the answer, and shows them in its card.
//
//   asked (another card) --> open, empty; an edit's: its text read from the server first (loading --loaded--> filled)
//   send --> (call) the page told "sent"; a comment's or a reply's box empties, and the card waits for the answer
//        --answered--> the page told; --failed--> the page told the reason, and the text goes back into its box
//   an edit sent unchanged: it closes, as it was (the page told "cancel"); refused, its box opens again with its text
//   cancel (Esc) --> closed, the page told, the focus back to the page
//   ended (the person's agent's turn) --> the page told; while a comment is on its way, after its answer

import type { AgentNote } from "../../shared/attribution";

/** The page's word for a box (the page's own, checked: comment-box.ts). */
export type Ask =
  | { card: ""; act: "add"; anchor: { start: string; end: string; quote: string } }
  | { card: string; act: "edit"; comment: string }
  | { card: string; act: "reply"; thread: string };

export type Action = Ask["act"];

export interface State {
  /** The box open now, for this card. */
  ask: Ask | null;
  /** An edit's box: its comment's text, while it is read (null) and after (the text it opened with). */
  was: string | null;
  /** The cards whose text is on its way to the server. */
  busy: string[];
  /**
   * The last edit sent: its text, and the text its box opened with. Its card shows the text without a box until the
   * answer; refused, the box opens again with it.
   */
  held: { card: string; text: string; was: string } | null;
  /** The end of the agent's turn, heard while a comment was on its way: the page hears it after the answer. */
  ended: string | null;
}

export type BoxEvent =
  | { type: "asked"; ask: Ask | null; focus: boolean }
  | { type: "loaded"; card: string; text: string }
  | { type: "send"; text: string }
  | { type: "cancel" }
  /** `busy`: the person's agent is at work again, at the answer (a turn's end before it was another turn's). */
  | { type: "answered"; card: string; action: Action; thread: unknown; agent?: AgentNote; busy?: boolean }
  /** The person's agent ended a turn; `why`: what a thread that has no reply from it says. */
  | { type: "ended"; why: string }
  | { type: "failed"; card: string; action: Action; message: string; text: string };

/** What the page hears (frame.ts gives it to comments.ts). */
export type ToPage =
  | { type: "erga-comment-sent"; card: string; text: string }
  | { type: "erga-comment-answered"; card: string; action: Action; thread: unknown; agent?: AgentNote }
  | { type: "erga-comment-failed"; card: string; action: Action; message: string }
  | { type: "erga-comment-cancel"; card: string }
  | { type: "erga-comment-turn"; why: string };

export type Effect =
  /** The box's text now. */
  | { do: "fill"; text: string }
  | { do: "focus" }
  /** The focus, if the box has it, back to the page. */
  | { do: "page" }
  /** Reads an edit's comment, for its text. */
  | { do: "read"; card: string; comment: string }
  | { do: "call"; ask: Ask; text: string }
  | { do: "tell"; message: ToPage };

export const initial: State = { ask: null, was: null, busy: [], held: null, ended: null };

export function step(s: State, e: BoxEvent): { state: State; effects: Effect[] } {
  const done = (state: State, effects: Effect[] = []) => ({ state, effects });
  switch (e.type) {
    case "asked": {
      const same = !!e.ask && JSON.stringify(e.ask) == JSON.stringify(s.ask);
      if (same) return done(s, e.focus ? [{ do: "focus" }] : []);
      if (!e.ask) return done({ ...s, ask: null, was: null }, [{ do: "page" }]);
      const held = s.held?.card == e.ask.card && !s.busy.includes(e.ask.card) ? s.held : null;
      if (held)
        return done({ ...s, ask: e.ask, was: held.was, held: null }, [{ do: "fill", text: held.text }, { do: e.focus ? "focus" : "page" }]);
      const read: Effect[] = e.ask.act == "edit" ? [{ do: "read", card: e.ask.card, comment: e.ask.comment }] : [];
      return done({ ...s, ask: e.ask, was: null }, [{ do: "fill", text: "" }, ...read, { do: e.focus ? "focus" : "page" }]);
    }
    case "loaded":
      if (s.ask?.card != e.card || s.ask.act != "edit" || s.was != null) return done(s);
      return done({ ...s, was: e.text }, [{ do: "fill", text: e.text }]);
    case "send": {
      const text = e.text.trim(),
        ask = s.ask;
      if (!ask || !text || s.busy.includes(ask.card) || (ask.act == "edit" && s.was == null)) return done(s);
      if (ask.act == "edit" && text == s.was)
        return done({ ...s, ask: null, was: null }, [
          { do: "tell", message: { type: "erga-comment-cancel", card: ask.card } },
          { do: "page" },
        ]);
      return done({ ...s, busy: [...s.busy, ask.card], held: ask.act == "edit" ? { card: ask.card, text, was: s.was! } : s.held }, [
        { do: "tell", message: { type: "erga-comment-sent", card: ask.card, text } },
        ...(ask.act == "edit" ? [] : [{ do: "fill", text: "" } as const]),
        { do: "call", ask, text },
      ]);
    }
    case "cancel":
      if (!s.ask || (s.ask.act == "edit" && s.busy.includes(s.ask.card))) return done(s);
      return done({ ...s, ask: null, was: null }, [
        { do: "tell", message: { type: "erga-comment-cancel", card: s.ask.card } },
        { do: "page" },
      ]);
    case "answered": {
      const { type: _, busy: atWork, ...rest } = e;
      const busy = s.busy.filter((c) => c != e.card);
      // A turn that ended while this was on its way: it may have been this comment's, and quick. After the answer.
      const ended = busy.length ? s.ended : null;
      const turn: Effect[] =
        s.ended != null && !busy.length && !atWork ? [{ do: "tell", message: { type: "erga-comment-turn", why: s.ended } }] : [];
      return done({ ...s, busy, ended, held: s.held?.card == e.card ? null : s.held }, [
        { do: "tell", message: { type: "erga-comment-answered", ...rest } },
        ...turn,
      ]);
    }
    case "ended":
      if (s.busy.length) return done({ ...s, ended: e.why });
      return done(s, [{ do: "tell", message: { type: "erga-comment-turn", why: e.why } }]);
    case "failed": {
      const back: Effect[] = s.ask?.card == e.card && e.action != "edit" ? [{ do: "fill", text: e.text }] : [];
      return done({ ...s, busy: s.busy.filter((c) => c != e.card), ended: s.busy.length > 1 ? s.ended : null }, [
        { do: "tell", message: { type: "erga-comment-failed", card: e.card, action: e.action, message: e.message } },
        ...back,
      ]);
    }
  }
}
