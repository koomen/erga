// The comments' one state on the page (comments.ts draws it and does its IO): the page's open threads, whether they're
// shown, the thread in use, the new comment being written, and the thread just resolved, which Undo reopens for a few
// seconds. Each call's answer and the undo's timer come back as events.
//
// The box a person types in is not the page's: the window around it draws it (client/common/comment-box.ts), where
// the open card has its place (boxOf), sends the comment with the person's session, and tells this page what it sent
// and the answer. So `sent`, `answered` and `failed` of add, reply and edit come from there.
//
//   listed: the server's open threads (after each change the document tells of: frame.ts)
//   compose --sent--> pending --answered--> the new thread, in use
//   sent: the text shows in its card at once, pending; on an error, the reason shows over its box (a card's key: its
//   thread's id, "" for the new comment's, editKey for an edit's)
//   edit (✎, one's own comment) --> its box in its place --sent--> pending --answered--> as edited
//                                                   --cancel--> as it was
//   answered with @erga: the thread shows the person's agent at work, or why it didn't start, until its reply comes;
//   ended (the agent's turn) --> (the threads read again) --listed--> no reply in the thread: why, in its place
//   resolve --> gone, with "Resolved · Undo" --undo--> (reopen) --answered--> back
//                                            --expired--> the pill goes

import type { AgentNote } from "../../../shared/attribution";
import type { AnchorJSON } from "../api/anchors";

/** A comment, as the server sends it (document/api/comments.ts). */
export interface Comment {
  id: string;
  by: string;
  via?: string;
  text: string;
  at: string;
  /** When it was last edited. */
  edited_at?: string;
}

/** An open thread, as the server sends it. */
export interface Thread {
  id: string;
  quote: string;
  anchor: AnchorJSON | null;
  created_by: string;
  comments: Comment[];
}

export interface State {
  threads: Thread[];
  /** The shell's word (erga-comments): highlights and cards shown. */
  shown: boolean;
  /** The thread in use: its highlight stronger, its card with Reply. */
  active: string | null;
  /** The new comment being written, on this text. */
  draft: { anchor: AnchorJSON } | null;
  /** The comment open for editing, in its thread. */
  editing: { thread: string; comment: string } | null;
  /** The text each card sent, until the server answers: it shows in the card, pending. (An edit's key: "e:" and its comment.) */
  sending: Record<string, string>;
  /** Each card's text the server refused, with its reason: the text is back in its box. */
  errors: Record<string, string>;
  /** The thread just resolved, while Undo can reopen it; `n` counts resolves, for the timer's end. */
  resolved: { thread: Thread; n: number } | null;
  /**
   * Each thread whose agent this tab's person asked (@erga): their comment; why there is no reply (it didn't start, or
   * its turn ended); and, while the threads are read again after the turn's end, why that would be.
   */
  asked: Record<string, { after: string; reason?: string; ending?: string }>;
}

/** The box the open card asks the window around the page for: a new comment's, an edit's, or a reply's. */
export type Box =
  | { card: ""; act: "add"; anchor: AnchorJSON }
  | { card: string; act: "edit"; comment: string }
  | { card: string; act: "reply"; thread: string };

export type Action = "add" | "reply" | "edit" | "resolve" | "reopen";

export type CommentEvent =
  | { type: "listed"; threads: Thread[] }
  | { type: "show"; on: boolean }
  /** The Comment button, or ⌘⌥M, on a selection. */
  | { type: "compose"; anchor: AnchorJSON }
  /** Esc: the new comment closes, or the thread in use. */
  | { type: "cancel" }
  /** The box sent this card's text (the window around the page sends it, with the person's session). */
  | { type: "sent"; card: string; text: string }
  /** ✎ on one's own comment. */
  | { type: "edit"; thread: string; comment: string }
  | { type: "activate"; id: string | null }
  | { type: "resolve"; id: string }
  | { type: "undo" }
  | { type: "expired"; n: number }
  /** A call's answer; `card`: the card whose text it sent; `agent`: what an @erga in it did. */
  | { type: "answered"; action: Action; thread: Thread | null; card?: string; agent?: AgentNote }
  /** The person's agent ended its turn (`why`: a sentence for a thread that has no reply from it). */
  | { type: "ended"; why: string }
  /** A call that failed: `card`, the card whose text it sent (add, reply); `thread`, the thread it changed (resolve, reopen). */
  | { type: "failed"; action: Action; message: string; card?: string; thread?: Thread };

export type Effect =
  | { do: "call"; action: "resolve" | "reopen"; thread: Thread }
  /** The undo's few seconds; their end is `expired` with this n. */
  | { do: "timer"; n: number }
  | { do: "explain"; message: string }
  /** The focus back to the page's text. */
  | { do: "focus" }
  /** The server's threads again (a reply may have come just before the turn's end). */
  | { do: "refresh" };

export const initial = (shown = true): State => ({
  threads: [],
  shown,
  active: null,
  draft: null,
  editing: null,
  sending: {},
  errors: {},
  resolved: null,
  asked: {},
});

/** The key of an edit's text in `sending` and `errors`. */
export const editKey = (comment: string) => `e:${comment}`;

/** The box the open card has: the comment being edited, else the new comment, else a reply to the thread in use. */
export function boxOf(s: State): Box | null {
  if (s.editing) return { card: editKey(s.editing.comment), act: "edit", comment: s.editing.comment };
  if (s.draft) return { card: "", act: "add", anchor: s.draft.anchor };
  if (s.active) return { card: s.active, act: "reply", thread: s.active };
  return null;
}

/** What a thread shows of the agent its person asked: at work, or why it didn't start; null once it replied, or unasked. */
export function agentOf(s: State, t: Thread): { reason?: string } | null {
  const a = s.asked[t.id];
  const at = a ? t.comments.findIndex((c) => c.id == a.after) : -1;
  if (!a || (at >= 0 && t.comments.slice(at + 1).some((c) => c.via))) return null;
  return a.reason == null ? {} : { reason: a.reason };
}

/** `r` without `key`. */
const without = <T>(r: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = r;
  return rest;
};

/** Puts a thread in the list, in place of the one with its id. */
const upsert = (threads: Thread[], t: Thread) =>
  threads.some((x) => x.id == t.id) ? threads.map((x) => (x.id == t.id ? t : x)) : [...threads, t];

export function step(s: State, e: CommentEvent): { state: State; effects: Effect[] } {
  const done = (state: State, effects: Effect[] = []) => ({ state, effects });
  switch (e.type) {
    case "listed": {
      // (The thread just resolved stays out, though the server's list came before its resolve.)
      const threads = e.threads.filter((t) => t.id != s.resolved?.thread.id);
      const has = (id: string | undefined) => threads.some((t) => t.id == id);
      const next = {
        ...s,
        threads,
        active: has(s.active ?? undefined) ? s.active : null,
        editing: has(s.editing?.thread) ? s.editing : null,
      };
      // (An agent that replied, or a thread that went: no more to show of it. A turn that ended with none: why.)
      const asked = Object.fromEntries(
        Object.entries(s.asked)
          .filter(([id]) => threads.some((t) => t.id == id && agentOf(next, t)))
          .map(([id, { ending, ...a }]) => [id, ending && a.reason == null ? { ...a, reason: ending } : a])
      );
      return done({ ...next, asked });
    }
    case "show":
      return done({ ...s, shown: e.on, active: e.on ? s.active : null });
    case "compose":
      return done({ ...s, draft: { anchor: e.anchor }, sending: without(s.sending, ""), errors: without(s.errors, ""), active: null });
    case "cancel":
      if (s.editing) {
        const key = editKey(s.editing.comment);
        if (key in s.sending) return done(s);
        return done({ ...s, editing: null, errors: without(s.errors, key) });
      }
      if (s.draft) return done({ ...s, draft: null, sending: without(s.sending, ""), errors: without(s.errors, "") }, [{ do: "focus" }]);
      if (s.active) return done({ ...s, active: null }, [{ do: "focus" }]);
      return done(s);
    case "sent": {
      const text = e.text.trim();
      if (!text || e.card in s.sending) return done(s);
      const errors = without(s.errors, e.card);
      if (e.card.startsWith("e:")) {
        if (!s.editing || editKey(s.editing.comment) != e.card) return done(s);
        return done({ ...s, sending: { ...s.sending, [e.card]: text }, errors });
      }
      if (!e.card && !s.draft) return done(s);
      return done({ ...s, sending: { ...s.sending, [e.card]: text }, errors });
    }
    case "edit": {
      const c = s.threads.find((t) => t.id == e.thread)?.comments.find((x) => x.id == e.comment);
      if (!c || (s.editing && editKey(s.editing.comment) in s.sending)) return done(s);
      return done({ ...s, active: e.thread, draft: null, editing: { thread: e.thread, comment: c.id } });
    }
    case "activate":
      return done({ ...s, active: e.id, draft: e.id ? null : s.draft, editing: s.editing?.thread == e.id ? s.editing : null });
    case "resolve": {
      const thread = s.threads.find((t) => t.id == e.id);
      if (!thread) return done(s);
      const n = (s.resolved?.n ?? 0) + 1;
      return done(
        {
          ...s,
          threads: s.threads.filter((t) => t.id != e.id),
          active: s.active == e.id ? null : s.active,
          editing: s.editing?.thread == e.id ? null : s.editing,
          resolved: { thread, n },
        },
        [{ do: "call", action: "resolve", thread }, { do: "timer", n }, { do: "focus" }]
      );
    }
    case "undo": {
      if (!s.resolved) return done(s);
      const { thread } = s.resolved;
      return done({ ...s, threads: upsert(s.threads, thread), resolved: null }, [{ do: "call", action: "reopen", thread }]);
    }
    case "expired":
      return done(s.resolved?.n == e.n ? { ...s, resolved: null } : s);
    case "answered": {
      if (e.action == "resolve" || !e.thread) return done(s);
      const threads = upsert(s.threads, e.thread);
      // Its @erga: the comment just written, last in the thread, is what the agent answers.
      const mine = e.agent && e.thread.comments.at(-1);
      const asked = mine
        ? {
            ...s.asked,
            [e.thread.id]: { after: mine.id, ...("reason" in e.agent! ? { reason: `It didn't start: ${e.agent.reason}.` } : {}) },
          }
        : s.asked;
      if (e.action == "add")
        return done({ ...s, threads, asked, draft: null, sending: without(s.sending, ""), active: e.thread.id }, [{ do: "focus" }]);
      if (e.action == "reply") return done({ ...s, threads, asked, sending: without(s.sending, e.card ?? e.thread.id) });
      if (e.action == "edit" && e.card) return done({ ...s, threads, editing: null, sending: without(s.sending, e.card) });
      return done({ ...s, threads });
    }
    case "ended": {
      const waiting = Object.entries(s.asked).filter(([, a]) => a.reason == null);
      if (!waiting.length) return done(s);
      const asked = { ...s.asked, ...Object.fromEntries(waiting.map(([id, a]) => [id, { ...a, ending: e.why }])) };
      return done({ ...s, asked }, [{ do: "refresh" }]);
    }
    case "failed": {
      const explain: Effect = { do: "explain", message: e.message };
      // A comment, a reply or an edit: the reason shows over its box, which has its text again.
      if ((e.action == "add" || e.action == "reply" || e.action == "edit") && e.card != null)
        return done({ ...s, sending: without(s.sending, e.card), errors: { ...s.errors, [e.card]: e.message } });
      // A resolve that didn't happen: the thread comes back. A reopen that didn't: it goes again.
      if (e.action == "resolve" && e.thread)
        return done({ ...s, threads: upsert(s.threads, e.thread), resolved: s.resolved?.thread.id == e.thread.id ? null : s.resolved }, [
          explain,
        ]);
      if (e.action == "reopen" && e.thread) return done({ ...s, threads: s.threads.filter((t) => t.id != e.thread!.id) }, [explain]);
      return done(s, [explain]);
    }
  }
}
