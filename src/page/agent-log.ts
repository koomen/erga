// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The host folds pi's agent events into these small events,
// sends each one to its user's tabs over their event WebSocket, and both
// apply them with `reduce`. Tool calls an external agent makes through the
// API (`via: "external"`) land in the same transcript. A transcript is private to one person and one document: their
// tabs all show it, collaborators never see it.

export type LogItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string; via?: "external" }
  | { kind: "error"; text: string };

export type LogEvent =
  | { t: "user"; text: string }
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | { t: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string; via?: "external" }
  | { t: "error"; text: string }
  | { t: "busy"; busy: boolean }
  /** How many of the agent's changes "Undo the agent's change" can take back. */
  | { t: "undoable"; count: number }
  | { t: "reset" };

export interface Log { items: LogItem[]; busy: boolean; undoable: number }

export const emptyLog = (): Log => ({ items: [], busy: false, undoable: 0 });

/** Applies one event in place; returns the index of the item it touched, or -1. */
export function reduce(log: Log, ev: LogEvent): number {
  const items = log.items;
  const last = items[items.length - 1];
  switch (ev.t) {
    case "user": items.push({ kind: "user", text: ev.text }); return items.length - 1;
    case "text":
      if (last?.kind == "assistant") { last.text += ev.delta; return items.length - 1; }
      items.push({ kind: "assistant", text: ev.delta });
      return items.length - 1;
    case "thinking":
      if (last?.kind == "thinking") { last.text += ev.delta; return items.length - 1; }
      items.push({ kind: "thinking", text: ev.delta });
      return items.length - 1;
    case "tool": {
      const i = items.findIndex((x) => x.kind == "tool" && x.id == ev.id);
      const item: LogItem = { kind: "tool", id: ev.id, name: ev.name, path: ev.path, status: ev.status, detail: ev.detail, image: ev.image, via: ev.via };
      if (i >= 0) { items[i] = item; return i; }
      items.push(item);
      return items.length - 1;
    }
    case "error": items.push({ kind: "error", text: ev.text }); return items.length - 1;
    case "busy": log.busy = ev.busy; return -1;
    case "undoable": log.undoable = ev.count; return -1;
    case "reset": items.length = 0; log.busy = false; return -1;
  }
}

// ------------------------------------------------------------------ view_page

/** The agent asks to see the page; an open editor tab renders and captures it. */
export interface ViewRequest {
  /** CSS selector of one element to capture. */
  selector?: string;
  /** The whole page rather than one screenful. */
  fullPage?: boolean;
  /** Width to render at, in CSS pixels (default: as wide as the user's page). */
  width?: number;
  /** Height of one screenful, in CSS pixels (default: as tall as the user's page). */
  height?: number;
  /** Light or dark mode, for the page's prefers-color-scheme (default: the user's). */
  colorScheme?: ColorScheme;
  /**
   * The agent's Yjs state vector when it asked (src/room/doc.ts): the tab
   * renders once it has seen every edit the agent had made by then.
   */
  after?: string;
  /**
   * evaluate_page: a JavaScript expression to run in the same render,
   * instead of taking a picture. Its result comes back as JSON (`value`).
   */
  evaluate?: string;
  /** How long evaluate waits for its result, in ms (EVAL_TIMEOUT). */
  timeout?: number;
}

export type ColorScheme = "light" | "dark";

/** A font the page's text rendered in, and where. */
export interface RenderedFont {
  /** The family the browser drew with, e.g. "Literata", or "Georgia" when a web font didn't load. */
  family: string;
  /** The family the page asked for first, when the browser drew with another. */
  wanted?: string;
  /** How many elements' text it drew, and a few of their tags. */
  elements: number;
  tags: string[];
}

/** What the tab sends back: a PNG (base64), evaluate's result, or why it couldn't. */
export interface ViewResult {
  png?: string;
  width: number;
  height: number;
  /** The screenful the page rendered at, in CSS pixels. */
  viewport?: { width: number; height: number };
  colorScheme?: ColorScheme;
  /** The fonts the page's text rendered in, most used first. */
  fonts?: RenderedFont[];
  /** Fonts and images still loading when the capture stopped waiting for them. */
  pending?: string[];
  /** Errors the page's scripts threw while it rendered. */
  errors: string[];
  note?: string;
  error?: string;
  /** evaluate's result as JSON text, cut to EVAL_MAX_JSON characters ("undefined" when there is none). */
  value?: string;
}

/** evaluate_page's limits: how long it waits, by default and at most (ms), and how much JSON it sends back. */
export const EVAL_TIMEOUT = { default: 5_000, max: 15_000 };
export const EVAL_MAX_JSON = 20_000;
export const evalTimeout = (req: ViewRequest) => Math.max(100, Math.min(EVAL_TIMEOUT.max, Number(req.timeout) || EVAL_TIMEOUT.default));
/** How long a tab may take to answer a view request: the render, plus evaluate's own wait. */
export const viewWait = (req: ViewRequest) => 20_000 + (req.evaluate != null ? evalTimeout(req) : 0);
