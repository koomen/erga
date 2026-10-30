// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The agent loop (agents/run.ts) folds its run into these small events,
// sends each one to its user's tabs over their event WebSocket, and both
// apply them with `reduce`. Tool calls an external agent makes through the
// API (`via: "external"`) land in the same transcript. A transcript is private to one person and one document: their
// tabs all show it, collaborators never see it.

import type { FileRef } from "./attach";
import type { LiveRequest } from "./live-page";
import type { TextEdit } from "./text-edits";

export type LogItem =
  /** `files`: what was attached, as the log shows it. */
  | { kind: "user"; text: string; files?: FileRef[] }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string; via?: "external"; offer?: Offer }
  | { kind: "error"; text: string };

/**
 * A button a tool's result puts under its call in the panel: what only the person may do, on this same page, offered
 * by the agent (a Cloudflare consent, which opens in a popup). The tool's own code makes it (its result's
 * `details.offer`), never the model's text.
 */
/** A consent the agent can't give but can offer: a button under the tool's result in the panel, which opens the consent in a popup. */
export interface Offer { kind: "connect-cloudflare" | "connect-github"; label: string; url: string }

/** The offer in a tool's result, if it has one. */
export function offerOf(result: unknown): Offer | undefined {
  const o = (result as { details?: { offer?: Offer } } | null)?.details?.offer;
  return o && (o.kind == "connect-cloudflare" || o.kind == "connect-github") && typeof o.url == "string" && typeof o.label == "string" ? { kind: o.kind, label: o.label, url: o.url } : undefined;
}

export type LogEvent =
  | { t: "user"; text: string; files?: FileRef[] }
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | { t: "tool"; id: string; name: string; path: string | null; status: "running" | "done" | "error"; detail?: string; image?: string; via?: "external"; offer?: Offer }
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
    case "user": items.push(ev.files?.length ? { kind: "user", text: ev.text, files: ev.files } : { kind: "user", text: ev.text }); return items.length - 1;
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
      const item: LogItem = { kind: "tool", id: ev.id, name: ev.name, path: ev.path, status: ev.status, detail: ev.detail, image: ev.image, via: ev.via, ...(ev.offer ? { offer: ev.offer } : {}) };
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
   * The agent's Yjs state vector when it asked: the tab
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
  /**
   * A presentation's step to show first (shared/steps.ts): its index, its number ("3.2"), or a hash ("#3.2") the
   * render opens at.
   */
  step?: number | string;
  /** How long after the step (or the load) the picture is taken, or the expression runs, in ms (FRAMES). */
  atMs?: number;
  /** Several pictures (or runs of the expression), at these times after the step, in ms, in one render (FRAMES). */
  frames?: number[];
  /**
   * A preview: these edits (as the edit tool takes them) applied to a copy of the open page's text, for this render
   * only, never to the document. `path`, if given, must be the open page.
   */
  preview?: { path?: string; edits: TextEdit[] };
  /**
   * The live page instead (shared/live-page.ts): every one of the person's tabs answers, its result as JSON in
   * `value`, and the host takes the focused tab's (else a visible one's) answer.
   */
  live?: LiveRequest;
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
  /** The page the tab rendered (its file). */
  page?: string;
  /** The step shown (`step`): its index, its number as the steps' list shows it, how many there are, and its label. */
  step?: StepShown;
  /** `preview`: the page the edits went to, in the copy, and how many there were. */
  preview?: { path: string; edits: number };
  /** `frames`: a picture at each time (ms after the step); `png` is the first. */
  shots?: { at: number; png: string }[];
  /** A live request: this tab couldn't (no editor yet), so another tab's answer comes first. */
  declined?: boolean;
  /** A live request: 2 from the focused tab, 1 a visible one, 0 one in the background. */
  rank?: number;
}

export interface StepShown { index: number; number: string; count: number; label?: string }

/** The times view_page and evaluate_page wait: after a step by default, at most for one time, and how many frames. */
export const FRAMES = { afterStep: 1_000, afterLoad: 600, max: 10_000, count: 6 };
/** The longest a request waits in the render: the latest of its times. */
export const renderWait = (req: ViewRequest) => Math.min(FRAMES.max, Math.max(0, req.atMs ?? 0, ...(req.frames ?? [])));

/** evaluate_page's limits: how long it waits, by default and at most (ms), and how much JSON it sends back. */
export const EVAL_TIMEOUT = { default: 5_000, max: 15_000 };
export const EVAL_MAX_JSON = 20_000;
export const evalTimeout = (req: { timeout?: number }) => Math.max(100, Math.min(EVAL_TIMEOUT.max, Number(req.timeout) || EVAL_TIMEOUT.default));
/** How long a tab may take to answer a view request: the render, plus evaluate's own wait. */
export const viewWait = (req: ViewRequest) =>
  req.live ? 10_000 + (req.live.kind == "inspect" ? evalTimeout(req.live) : 0)
  : 20_000 + (req.step != null ? 5_000 : 0) + renderWait(req) + (req.evaluate != null ? evalTimeout(req) : 0) * Math.max(1, req.frames?.length ?? 0) + 3_000 * Math.max(0, (req.frames?.length ?? 0) - 1);
