// Alerts: what the person must know while they edit, in one card. An error (a problem of the page, text that can't be
// edited, a file that wasn't added, an agent that stopped) or progress (an upload, edits on their way to the server). One
// state, and `step`, the one function that says what the card shows. No IO here: client/shell/alerts.ts draws it, keeps the
// timers and tells each alert's source of its buttons.
//
// The rules:
//   - A new error opens the card. An error with a key that's there adds 1 to its count.
//   - Progress never opens the card. It shows as one line, after QUIET_MS: what ends sooner shows nothing.
//   - The card stays until the person closes it (×, Escape) or its last alert ends. Close dismisses every error, and
//     stops nothing that runs: progress stays, as the line. A click on the line opens the card.
//   - A button acts on its own alert. "Fix with agent" (FIX) asks the agent and takes the alert off.
//   - A confirmation ("Saved") is not an alert: the toast's (client/shell/toast.ts), in a place of its own.
//
// The page's editor raises its alerts by postMessage (AlertMessage up, AlertAct down: libs/text/ui/alerts.ts). The page's
// own script can forge one, so `readMessage` takes only what it knows, cut to size, and the card shows it as text.

export type Kind = "error" | "progress";
export type Source = "page" | "editor" | "upload" | "agent" | "connection";
export interface Action {
  id: string;
  label: string;
  primary?: boolean;
}
/** Who caused it: a person or an agent. */
export interface By {
  name: string;
  agent: boolean;
}
export type RowState = "waiting" | "running" | "done" | "error";
/** One part of a batch (a file of an upload). `p`: how far it is, 0 to 1. `detail`: its numbers, or why it failed. */
export interface Row {
  id: string;
  title: string;
  detail?: string;
  state: RowState;
  p?: number;
  by?: By;
  actions?: Action[];
}

/** What a source raises. The same key is the same alert. */
export interface Raise {
  key: string;
  kind: Kind;
  source: Source;
  title: string;
  detail?: string;
  by?: By;
  actions?: Action[];
  rows?: Row[];
  /** Progress with no rows: how far it is, 0 to 1 (none: it can't tell). */
  p?: number;
  /** A request the agent can do for it ("Fix with agent"). `draft`: the start of one, for the person to complete. */
  fix?: string;
  draft?: boolean;
  /** Shown one time in a view of the page (a page's problem), until the agent is asked to fix it. */
  once?: boolean;
  /**
   * Of the page in the frame: it goes when the page loads again, or another comes. "page": a problem of the page, which
   * the page that loads says again if it's still there. "load": the page's editor raised it, and hears its buttons.
   */
  life?: "page" | "load";
}

export interface Alert extends Raise {
  count: number;
  actions: Action[];
  rows: Row[];
  /** Progress in its first QUIET_MS: not shown yet. */
  quiet: boolean;
  /** Progress that ended: it says so for DONE_MS. */
  done: boolean;
}

export interface State {
  /** The newest first. */
  alerts: Alert[];
  /** The person opened the card from the line. */
  open: boolean;
  /** The keys of the `once` alerts this view of the page has shown. */
  seen: string[];
}

export type Event =
  | { t: "raise"; alert: Raise }
  /** One row of a batch, new or changed. */
  | { t: "row"; key: string; row: Row }
  /** Its source says that it is over. `title`: what the line says for DONE_MS ("3 files uploaded"). */
  | { t: "end"; key: string; title?: string }
  /** A button of an alert, or of one of its rows. */
  | { t: "act"; key: string; row?: string; action: string }
  /** "Fix all with agent". */
  | { t: "fix-all" }
  /** A click on the line. */
  | { t: "open" }
  /** × or Escape. */
  | { t: "close" }
  | { t: "timeout"; key: string; what: "quiet" | "done" }
  /** The page in the frame loaded again: its editor is new. */
  | { t: "load" }
  /** Another page in the frame. */
  | { t: "page" };

export type Effect =
  /** The card or the line, again. */
  | { t: "draw" }
  /** Only one row's bar and numbers. */
  | { t: "paint"; key: string; row: string }
  /** To the alert's source: a button, or "dismiss" (DISMISS) as the person closes it. */
  | { t: "tell"; key: string; row?: string; action: string }
  /** Ask the agent to fix these. */
  | { t: "fix"; alerts: Alert[] }
  | { t: "timer"; key: string; what: "quiet" | "done"; ms: number };

export const QUIET_MS = 1000,
  DONE_MS = 2000;
/** The action "Fix with agent", and what a source hears when the person closes its alert. */
export const FIX = "fix",
  DISMISS = "dismiss";

export const initial: State = { alerts: [], open: false, seen: [] };

const failed = (a: Alert) => a.rows.filter((r) => r.state == "error").length;
/** Whether an alert shows: an error, or progress past its quiet time, or with a row that failed. */
export const shows = (a: Alert) => a.kind == "error" || !a.quiet || a.done || failed(a) > 0;
/** How many problems show: the errors, and the rows that failed. */
export const problems = (s: State) => s.alerts.reduce((n, a) => n + (a.kind == "error" ? Math.max(1, failed(a)) : failed(a)), 0);
/** The alerts with a request the agent can do as it is. */
export const fixable = (s: State) => s.alerts.filter((a) => a.fix && !a.draft);
/** What shows: nothing, the one line (progress alone), or the card. */
export function view(s: State): "none" | "line" | "card" {
  if (!s.alerts.some(shows)) return "none";
  return s.open || problems(s) > 0 ? "card" : "line";
}
/** How far a progress alert is, 0 to 1: its own word, or its rows' (a row that ended counts whole); null: it can't tell. */
export function progress(a: Alert): number | null {
  if (a.p != null) return a.p;
  if (!a.rows.length) return null;
  return a.rows.reduce((n, r) => n + (r.state == "done" || r.state == "error" ? 1 : (r.p ?? 0)), 0) / a.rows.length;
}
/** The progress in a few words: the newest's title, and how many more. */
export function running(s: State): string {
  const all = s.alerts.filter((a) => a.kind == "progress" && shows(a));
  return all.length ? all[0].title + (all.length > 1 ? ` · ${all.length - 1} more` : "") : "";
}
/** The card's head: "3 problems", "Uploading 3 files · 2 problems", or with no problem "In progress". */
export function headline(s: State): string {
  const n = problems(s);
  return n ? [running(s), `${n} problem${n == 1 ? "" : "s"}`].filter(Boolean).join(" · ") : "In progress";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) == JSON.stringify(b);

export function step(s: State, e: Event): [State, Effect[]] {
  const at = "key" in e ? s.alerts.findIndex((a) => a.key == e.key) : -1;
  const old = at < 0 ? null : s.alerts[at];
  const put = (a: Alert): State => ({ ...s, alerts: s.alerts.map((x) => (x == old ? a : x)) });
  const drop = (keys: string[]): State => ({ ...s, alerts: s.alerts.filter((a) => !keys.includes(a.key)) });
  /** The card closes itself with its last alert: the next line starts closed. */
  const settle = (next: State, effects: Effect[]): [State, Effect[]] => [
    next.open && !next.alerts.some(shows) ? { ...next, open: false } : next,
    effects,
  ];
  const draw: Effect = { t: "draw" };
  switch (e.t) {
    case "raise": {
      const r = e.alert,
        was = s.alerts.find((a) => a.key == r.key);
      if (r.once && s.seen.includes(r.key)) return [s, []];
      const seen = r.once ? [...s.seen, r.key] : s.seen;
      const made: Alert = {
        ...r,
        actions: r.actions ?? [],
        rows: r.rows ?? [],
        count: was && r.kind == "error" && was.kind == "error" ? was.count + 1 : 1,
        quiet: r.kind == "progress" && (was ? was.quiet : true),
        done: false,
      };
      // (An error in the card that runs again, after "Try again": the card stays up for it.)
      if (was)
        return [
          { ...s, seen, open: s.open || (view(s) == "card" && shows(was)), alerts: s.alerts.map((a) => (a == was ? made : a)) },
          [draw],
        ];
      const next = { ...s, seen, alerts: [made, ...s.alerts] };
      return [
        next,
        made.kind == "progress" ? [{ t: "timer", key: r.key, what: "quiet", ms: QUIET_MS }, ...(shows(made) ? [draw] : [])] : [draw],
      ];
    }
    case "row": {
      if (!old || old.done) return [s, []];
      const i = old.rows.findIndex((r) => r.id == e.row.id),
        was = old.rows[i];
      const next = put({ ...old, rows: was ? old.rows.map((r) => (r == was ? e.row : r)) : [...old.rows, e.row] });
      const shown = shows(next.alerts[at]);
      // Only its numbers changed: the row alone is painted, so they can change many times a second.
      const numbers = !!was && same({ ...was, p: 0, detail: "" }, { ...e.row, p: 0, detail: "" });
      return [next, !shown ? [] : numbers ? [{ t: "paint", key: e.key, row: e.row.id }] : [draw]];
    }
    case "end": {
      if (!old) return [s, []];
      // The rows that failed stay, as a problem to close or to try again.
      if (failed(old))
        return [
          put({ ...old, kind: "error", quiet: false, title: e.title ?? old.title, rows: old.rows.filter((r) => r.state == "error") }),
          [draw],
        ];
      if (old.kind == "progress" && shows(old) && e.title)
        return [
          put({ ...old, done: true, title: e.title, detail: undefined, actions: [], rows: [], p: 1 }),
          [{ t: "timer", key: e.key, what: "done", ms: DONE_MS }, draw],
        ];
      return settle(drop([e.key]), shows(old) ? [draw] : []);
    }
    case "act": {
      if (!old) return [s, []];
      if (e.action != FIX) return [s, [{ t: "tell", key: e.key, row: e.row, action: e.action }]];
      if (!old.fix) return [s, []];
      // (If it's still wrong after the agent's turn, it says so again.)
      return settle({ ...drop([e.key]), seen: s.seen.filter((k) => k != e.key) }, [{ t: "fix", alerts: [old] }, draw]);
    }
    case "fix-all": {
      const all = fixable(s),
        keys = all.map((a) => a.key);
      if (!all.length) return [s, []];
      return settle({ ...drop(keys), seen: s.seen.filter((k) => !keys.includes(k)) }, [{ t: "fix", alerts: all }, draw]);
    }
    case "open":
      return view(s) == "line" ? [{ ...s, open: true }, [draw]] : [s, []];
    case "close": {
      if (view(s) != "card") return [s, []];
      const gone = s.alerts.filter((a) => a.kind == "error" || failed(a));
      const alerts = s.alerts
        .filter((a) => a.kind != "error")
        .map((a) => (failed(a) ? { ...a, rows: a.rows.filter((r) => r.state != "error") } : a));
      return [{ ...s, alerts, open: false }, [...gone.map((a): Effect => ({ t: "tell", key: a.key, action: DISMISS })), draw]];
    }
    case "timeout": {
      if (!old) return [s, []];
      if (e.what == "quiet") return old.quiet ? [put({ ...old, quiet: false }), shows(old) ? [] : [draw]] : [s, []];
      return old.done ? settle(drop([e.key]), [draw]) : [s, []];
    }
    case "load":
    case "page": {
      // The page's own problems go too: the page that comes says them again if they're still there (what the person
      // dismissed stays seen, in the same page).
      const gone = s.alerts.filter((a) => a.life).map((a) => a.key);
      const next = { ...drop(gone), seen: e.t == "page" ? [] : s.seen.filter((k) => !gone.includes(k)) };
      return settle(next, gone.length ? [draw] : []);
    }
  }
}

// ---------------------------------------------------------------- the page's editor's alerts, by postMessage

/** The page's editor to the viewer ("erga-alert"). Its alerts live as long as it does (life "load"). */
export type AlertMessage = { type: "erga-alert" } & (
  | { op: "raise"; alert: Omit<Raise, "life" | "once" | "source"> & { source: "editor" | "upload" | "connection" } }
  | { op: "row"; key: string; row: Row }
  | { op: "end"; key: string; title?: string }
);
/** The viewer to the page's editor ("erga-alert-act"): a button of its alert, or DISMISS. */
export interface AlertAct {
  type: "erga-alert-act";
  key: string;
  row?: string;
  action: string;
}

/**
 * A message of the page as an event, or null if it isn't one: only the fields above, each cut to size. Its key gets
 * `prefix`, so the page can't name an alert of the viewer's own.
 */
export function readMessage(m: unknown, prefix: string): Extract<Event, { t: "raise" | "row" | "end" }> | null {
  const o = (v: unknown) => (v && typeof v == "object" ? (v as Record<string, unknown>) : null);
  const s = (v: unknown, max: number) => (typeof v == "string" && v ? v.slice(0, max) : undefined);
  const p = (v: unknown) => (typeof v == "number" && v >= 0 && v <= 1 ? v : undefined);
  const by = (v: unknown): By | undefined => {
    const name = s(o(v)?.name, 80);
    return name ? { name, agent: o(v)!.agent === true } : undefined;
  };
  const actions = (v: unknown): Action[] =>
    (Array.isArray(v) ? v : []).slice(0, 4).flatMap((a) => {
      const id = s(o(a)?.id, 40),
        label = s(o(a)?.label, 40);
      return id && label && id != FIX ? [{ id, label, ...(o(a)!.primary === true ? { primary: true } : {}) }] : [];
    });
  const row = (v: unknown): Row | null => {
    const r = o(v),
      id = s(r?.id, 100),
      title = s(r?.title, 200),
      state = (["waiting", "running", "done", "error"] as const).find((x) => x == r?.state);
    return r && id && title && state
      ? { id, title, state, detail: s(r.detail, 300), p: p(r.p), by: by(r.by), actions: actions(r.actions) }
      : null;
  };
  const d = o(m),
    a = o(d?.alert),
    key = s(d?.op == "raise" ? a?.key : d?.key, 100);
  if (!d || !key) return null;
  if (d.op == "end") return { t: "end", key: prefix + key, title: s(d.title, 200) };
  if (d.op == "row") {
    const r = row(d.row);
    return r && { t: "row", key: prefix + key, row: r };
  }
  const kind = (["error", "progress"] as const).find((x) => x == a?.kind),
    source = (["editor", "upload", "connection"] as const).find((x) => x == a?.source),
    title = s(a?.title, 200);
  if (d.op != "raise" || !a || !kind || !source || !title) return null;
  const fix = s(a.fix, 2000);
  return {
    t: "raise",
    alert: {
      key: prefix + key,
      kind,
      source,
      title,
      detail: s(a.detail, 500),
      by: by(a.by),
      actions: actions(a.actions),
      rows: (Array.isArray(a.rows) ? a.rows : []).slice(0, 50).flatMap((r) => row(r) ?? []),
      p: p(a.p),
      ...(fix ? { fix, ...(a.draft === true ? { draft: true } : {}) } : {}),
      life: "load",
    },
  };
}
