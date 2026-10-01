// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The host folds pi's session events into these small events,
// sends each one to the shell over SSE, and both apply them with `reduce`.

export type LogItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string }
  | { kind: "error"; text: string };

export type LogEvent =
  | { t: "user"; text: string }
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | { t: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string }
  | { t: "error"; text: string }
  | { t: "busy"; busy: boolean }
  | { t: "reset" };

export interface Log { items: LogItem[]; busy: boolean }

export const emptyLog = (): Log => ({ items: [], busy: false });

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
      const item: LogItem = { kind: "tool", id: ev.id, name: ev.name, path: ev.path, status: ev.status, detail: ev.detail, image: ev.image };
      if (i >= 0) { items[i] = item; return i; }
      items.push(item);
      return items.length - 1;
    }
    case "error": items.push({ kind: "error", text: ev.text }); return items.length - 1;
    case "busy": log.busy = ev.busy; return -1;
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
}

/** What the tab sends back: a PNG (base64), or why it couldn't. */
export interface ViewResult {
  png?: string;
  width: number;
  height: number;
  /** Errors the page's scripts threw while it rendered. */
  errors: string[];
  note?: string;
  error?: string;
}
