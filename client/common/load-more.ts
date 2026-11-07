// A list's Load more (the Analytics page, client/inline/admin-analytics.ts) as a state machine: one state, the events,
// and `step`, which gives the next state and what to do. The page keeps the state, fetches, and adds the rows.

export type LoadMore =
  /** It shows `next` people; more wait. */
  | { is: "idle"; next: number }
  | { is: "loading"; next: number }
  /** The last fetch failed: Load more tries again. */
  | { is: "failed"; next: number; error: string }
  /** Every person is shown: the button goes. */
  | { is: "done" };

export type LoadEvent = { e: "click" } | { e: "loaded"; count: number; more: boolean } | { e: "failed"; error: string };

/** Fetch the people from `offset`. */
export type LoadEffect = { fx: "fetch"; offset: number };

export function step(s: LoadMore, ev: LoadEvent): [LoadMore, LoadEffect[]] {
  switch (ev.e) {
    case "click":
      return s.is == "idle" || s.is == "failed" ? [{ is: "loading", next: s.next }, [{ fx: "fetch", offset: s.next }]] : [s, []];
    case "loaded":
      if (s.is != "loading") return [s, []];
      return [ev.more ? { is: "idle", next: s.next + ev.count } : { is: "done" }, []];
    case "failed":
      return s.is == "loading" ? [{ is: "failed", next: s.next, error: ev.error }, []] : [s, []];
  }
}
