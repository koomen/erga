// The comments' one state on the page (comments.ts draws it and does its IO): the page's open threads, whether they're
// shown, the thread in use, the new comment being written, and the thread just resolved, which Undo reopens for a few
// seconds. Each call's answer and the undo's timer come back as events.
//
//   listed: the server's open threads (after each change the document tells of: frame.ts)
//   compose --send--> (add) --answered--> the new thread, in use
//   send: the text shows in its card at once, pending, and its box empties and waits; on an error, the text goes back
//   into the box, with the reason beside it (a card's key: its thread's id, "" for the new comment's)
//   edit (✎, one's own comment) --> its text in a box, in its place --send--> (edit) pending --answered--> as edited
//                                                           --cancel--> as it was
//   resolve --> gone, with "Resolved · Undo" --undo--> (reopen) --answered--> back
//                                            --expired--> the pill goes

import type { AnchorJSON } from "../api/anchors";

/** A comment, as the server sends it (document/comments.ts). */
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
  /** The comment open for editing, in its thread, and the text its box opens with. */
  editing: { thread: string; comment: string; text: string } | null;
  /** The text each card sent, until the server answers: it shows in the card, pending. (An edit's key: "e:" and its comment.) */
  sending: Record<string, string>;
  /** Each card's text the server refused, with its reason: the text is back in its box. */
  errors: Record<string, string>;
  /** The thread just resolved, while Undo can reopen it; `n` counts resolves, for the timer's end. */
  resolved: { thread: Thread; n: number } | null;
}

export type Action = "add" | "reply" | "edit" | "resolve" | "reopen";

export type CommentEvent =
  | { type: "listed"; threads: Thread[] }
  | { type: "show"; on: boolean }
  /** The Comment button, or ⌘⌥M, on a selection. */
  | { type: "compose"; anchor: AnchorJSON }
  /** Esc: the new comment closes, or the thread in use. */
  | { type: "cancel" }
  /** Enter: the new comment, a reply to the thread in use, or the comment being edited (`comment`). */
  | { type: "send"; text: string; thread?: string; comment?: string }
  /** ✎ on one's own comment. */
  | { type: "edit"; thread: string; comment: string }
  | { type: "activate"; id: string | null }
  | { type: "resolve"; id: string }
  | { type: "undo" }
  | { type: "expired"; n: number }
  /** A call's answer; `card`: an edit's key. */
  | { type: "answered"; action: Action; thread: Thread | null; card?: string }
  /** A call that failed: `card`, the card whose text it sent (add, reply); `thread`, the thread it changed (resolve, reopen). */
  | { type: "failed"; action: Action; message: string; card?: string; thread?: Thread };

export type Effect =
  | { do: "call"; action: "add"; anchor: AnchorJSON; text: string }
  | { do: "call"; action: "reply"; thread: string; text: string }
  | { do: "call"; action: "edit"; comment: string; text: string }
  | { do: "call"; action: "resolve" | "reopen"; thread: Thread }
  /** The undo's few seconds; their end is `expired` with this n. */
  | { do: "timer"; n: number }
  | { do: "explain"; message: string }
  /** The focus back to the page's text. */
  | { do: "focus" }
  /** The box of this card empties: its text is on its way. */
  | { do: "cleared"; card: string }
  /** The text goes back into this card's box: the server refused it. */
  | { do: "restore"; card: string; text: string };

export const initial = (shown = true): State => ({
  threads: [],
  shown,
  active: null,
  draft: null,
  editing: null,
  sending: {},
  errors: {},
  resolved: null,
});

/** The key of an edit's text in `sending` and `errors`. */
export const editKey = (comment: string) => `e:${comment}`;

/** `r` without `key`. */
const without = (r: Record<string, string>, key: string) => {
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
      return done({
        ...s,
        threads,
        active: has(s.active ?? undefined) ? s.active : null,
        editing: has(s.editing?.thread) ? s.editing : null,
      });
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
    case "send": {
      const text = e.text.trim();
      if (e.comment) {
        const key = editKey(e.comment),
          was = s.threads.flatMap((t) => t.comments).find((c) => c.id == e.comment);
        if (!text || key in s.sending || s.editing?.comment != e.comment) return done(s);
        // Unchanged: it closes, as it was.
        if (text == was?.text) return done({ ...s, editing: null, errors: without(s.errors, key) });
        return done({ ...s, editing: { ...s.editing, text }, sending: { ...s.sending, [key]: text }, errors: without(s.errors, key) }, [
          { do: "call", action: "edit", comment: e.comment, text },
        ]);
      }
      const card = e.thread ?? "";
      if (!text || card in s.sending || (!e.thread && !s.draft)) return done(s);
      const next = { ...s, sending: { ...s.sending, [card]: text }, errors: without(s.errors, card) };
      const call: Effect = e.thread
        ? { do: "call", action: "reply", thread: e.thread, text }
        : { do: "call", action: "add", anchor: s.draft!.anchor, text };
      return done(next, [{ do: "cleared", card }, call]);
    }
    case "edit": {
      const c = s.threads.find((t) => t.id == e.thread)?.comments.find((x) => x.id == e.comment);
      if (!c || (s.editing && editKey(s.editing.comment) in s.sending)) return done(s);
      return done({ ...s, active: e.thread, draft: null, editing: { thread: e.thread, comment: c.id, text: c.text } });
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
      if (e.action == "add")
        return done({ ...s, threads, draft: null, sending: without(s.sending, ""), active: e.thread.id }, [{ do: "focus" }]);
      if (e.action == "reply") return done({ ...s, threads, sending: without(s.sending, e.thread.id) });
      if (e.action == "edit" && e.card) return done({ ...s, threads, editing: null, sending: without(s.sending, e.card) });
      return done({ ...s, threads });
    }
    case "failed": {
      const explain: Effect = { do: "explain", message: e.message };
      // An edit: its box opens again with the text it sent (`editing.text`), and the reason.
      if (e.action == "edit" && e.card != null)
        return done({ ...s, sending: without(s.sending, e.card), errors: { ...s.errors, [e.card]: e.message } });
      // A comment or a reply: its text goes back into its box, and the reason shows there.
      if ((e.action == "add" || e.action == "reply") && e.card != null) {
        const text = s.sending[e.card] ?? "";
        return done({ ...s, sending: without(s.sending, e.card), errors: { ...s.errors, [e.card]: e.message } }, [
          { do: "restore", card: e.card, text },
        ]);
      }
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
