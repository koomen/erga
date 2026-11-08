// The comments' one state on the page (comments.ts draws it and does its IO): the page's open threads, whether they're
// shown, the thread in use, the new comment being written, and the thread just resolved, which Undo reopens for a few
// seconds. Each call's answer and the undo's timer come back as events.
//
//   listed: the server's open threads (after each change the document tells of: frame.ts)
//   compose --send--> (add) --answered--> the new thread, in use
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
  /** The new comment being written, on this text; `sending` once Enter sent it. */
  draft: { anchor: AnchorJSON; sending: boolean } | null;
  /** The thread just resolved, while Undo can reopen it; `n` counts resolves, for the timer's end. */
  resolved: { thread: Thread; n: number } | null;
}

export type Action = "add" | "reply" | "resolve" | "reopen";

export type CommentEvent =
  | { type: "listed"; threads: Thread[] }
  | { type: "show"; on: boolean }
  /** The Comment button, or ⌘⌥M, on a selection. */
  | { type: "compose"; anchor: AnchorJSON }
  /** Esc: the new comment closes, or the thread in use. */
  | { type: "cancel" }
  /** Enter: the new comment, or a reply to the thread in use. */
  | { type: "send"; text: string; thread?: string }
  | { type: "activate"; id: string | null }
  | { type: "resolve"; id: string }
  | { type: "undo" }
  | { type: "expired"; n: number }
  | { type: "answered"; action: Action; thread: Thread | null }
  | { type: "failed"; action: Action; message: string; thread?: Thread };

export type Effect =
  | { do: "call"; action: "add"; anchor: AnchorJSON; text: string }
  | { do: "call"; action: "reply"; thread: string; text: string }
  | { do: "call"; action: "resolve" | "reopen"; thread: Thread }
  /** The undo's few seconds; their end is `expired` with this n. */
  | { do: "timer"; n: number }
  | { do: "explain"; message: string }
  /** The focus back to the page's text. */
  | { do: "focus" }
  /** The reply box of this thread empties: its reply is in. */
  | { do: "cleared"; thread: string };

export const initial = (shown = true): State => ({ threads: [], shown, active: null, draft: null, resolved: null });

/** Puts a thread in the list, in place of the one with its id. */
const upsert = (threads: Thread[], t: Thread) =>
  threads.some((x) => x.id == t.id) ? threads.map((x) => (x.id == t.id ? t : x)) : [...threads, t];

export function step(s: State, e: CommentEvent): { state: State; effects: Effect[] } {
  const done = (state: State, effects: Effect[] = []) => ({ state, effects });
  switch (e.type) {
    case "listed": {
      // (The thread just resolved stays out, though the server's list came before its resolve.)
      const threads = e.threads.filter((t) => t.id != s.resolved?.thread.id);
      return done({ ...s, threads, active: threads.some((t) => t.id == s.active) ? s.active : null });
    }
    case "show":
      return done({ ...s, shown: e.on, active: e.on ? s.active : null });
    case "compose":
      return done({ ...s, draft: { anchor: e.anchor, sending: false }, active: null });
    case "cancel":
      if (s.draft) return done({ ...s, draft: null }, [{ do: "focus" }]);
      if (s.active) return done({ ...s, active: null }, [{ do: "focus" }]);
      return done(s);
    case "send": {
      const text = e.text.trim();
      if (!text) return done(s);
      if (e.thread) return done(s, [{ do: "call", action: "reply", thread: e.thread, text }]);
      if (!s.draft || s.draft.sending) return done(s);
      return done({ ...s, draft: { ...s.draft, sending: true } }, [{ do: "call", action: "add", anchor: s.draft.anchor, text }]);
    }
    case "activate":
      return done({ ...s, active: e.id, draft: e.id ? null : s.draft });
    case "resolve": {
      const thread = s.threads.find((t) => t.id == e.id);
      if (!thread) return done(s);
      const n = (s.resolved?.n ?? 0) + 1;
      return done(
        { ...s, threads: s.threads.filter((t) => t.id != e.id), active: s.active == e.id ? null : s.active, resolved: { thread, n } },
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
      if (e.action == "add") return done({ ...s, threads, draft: null, active: e.thread.id }, [{ do: "focus" }]);
      if (e.action == "reply") return done({ ...s, threads }, [{ do: "cleared", thread: e.thread.id }]);
      return done({ ...s, threads });
    }
    case "failed": {
      const explain: Effect = { do: "explain", message: e.message };
      if (e.action == "add") return done({ ...s, draft: s.draft && { ...s.draft, sending: false } }, [explain]);
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
