// The agent conversation as the editor shows it, shared by the host (which
// keeps the transcript, so a reload picks it back up) and the shell (which
// renders it). The agent loop (agents/run.ts) folds its run into these small events,
// sends each one to its user's tabs over their event WebSocket, and both
// apply them with `reduce`. Tool calls an external agent makes through the
// API (`via: "external"`) land in the same transcript. A transcript is private to one person and one document: their
// tabs all show it, collaborators never see it.

import type { FileRef } from "./attach";
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
  | { t: "undoable"; count: number; redo: number }
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

/**
 * The agent asks to see the page: the server's browser opens it (cloudflare/render.ts) and answers a picture of each
 * place asked for, or an expression's result.
 */
export interface ViewRequest {
  /** CSS selectors of elements to capture: one picture each, from one render. */
  selectors?: string[];
  /** The whole page rather than one screenful. */
  fullPage?: boolean;
  /** Width to render at, in CSS pixels (VIEW_DEFAULT). */
  width?: number;
  /** Height of one screenful, in CSS pixels (VIEW_DEFAULT). */
  height?: number;
  /** Light or dark mode, for the page's prefers-color-scheme (default: light). */
  colorScheme?: ColorScheme;
  /**
   * eval_in_page: a JavaScript expression to run in the same render,
   * instead of taking a picture. Its result comes back as JSON (`value`).
   */
  evaluate?: string;
  /** How long evaluate waits for its result, in ms (EVAL_TIMEOUT). */
  timeout?: number;
  /**
   * A presentation's steps to show (shared/steps.ts, stepSpec): each its number ("3.2"), or a hash ("#3.2") the
   * render opens at. One picture each, in order, from one render; eval_in_page takes one.
   */
  steps?: string[];
  /** How long after the step (or the load) the picture is taken, or the expression runs, in ms (FRAMES). */
  atMs?: number;
  /** Several pictures (or runs of the expression), at these times after the step, in ms, in one render (FRAMES). */
  frames?: number[];
  /** The page to render, by its path in the document: the document's own page by default. */
  path?: string;
  /**
   * A preview: these edits (as the edit tool takes them) applied to a copy of the page's text (`path`'s), for this
   * render only, never to the document.
   */
  preview?: { edits: TextEdit[] };
}

export type ColorScheme = "light" | "dark";

/** The window a render has when the agent names none. */
export const VIEW_DEFAULT = { width: 1280, height: 800 };

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

/** One picture: a PNG (base64), its size, and where and when it was taken. */
export interface Shot {
  png: string;
  width: number;
  height: number;
  /** ms after the step (or the load). */
  at: number;
  /** The element it shows, if one. */
  selector?: string;
  /** The step it shows, if one. */
  step?: StepShown;
  note?: string;
}

/** What the render answers: pictures, evaluate's result, or why it couldn't. */
export interface ViewResult {
  /** The pictures, in the order asked for: each place, at each time. */
  shots?: Shot[];
  /** The screenful the page rendered at, in CSS pixels. */
  viewport?: { width: number; height: number };
  colorScheme?: ColorScheme;
  /** The fonts the page's text rendered in (in the last place), most used first. */
  fonts?: RenderedFont[];
  /** Fonts and images still loading when the capture stopped waiting for them. */
  pending?: string[];
  /** Errors the page's scripts threw while it rendered. */
  errors: string[];
  note?: string;
  error?: string;
  /** evaluate's result as JSON text, cut to EVAL_MAX_JSON characters ("undefined" when there is none). */
  value?: string;
  /** The page rendered (its file). */
  page?: string;
  /** eval_in_page's step: its index, its number as the steps' list shows it, how many there are, and its label. */
  step?: StepShown;
  /** `preview`: the page the edits went to, in the copy, and how many there were. */
  preview?: { path: string; edits: number };
}

export interface StepShown {
  index: number;
  number: string;
  count: number;
  label?: string;
}

/** A part of the page in the page's CSS pixels, from its top left corner (not the window's). */
export type Clip = { x: number; y: number; width: number; height: number };

/**
 * The render's tools in the page (window.__ergaRender: client/page-tools/capture.ts), which the server's browser calls
 * one at a time, between its own pictures (cloudflare/render.ts).
 */
export interface PageRender {
  /** Waits for the fonts and images (a few seconds at most), and answers what still hadn't loaded. */
  settle(): Promise<string[]>;
  /** Shows a step (a number, or a hash), and starts the clock again from it. */
  step(spec: string): Promise<StepShown | { note: string } | string>;
  /** Waits until `t` ms on the clock, holds the animations at `t`, and answers the part to take: the screenful (no clip), the page, or an element. */
  hold(t: number, selector: string | null, fullPage: boolean): Promise<{ at: number; clip?: Clip; note?: string; error?: string }>;
  /** Lets the animations run again after a picture; the time it took is left out of the clock. */
  release(): void;
  /** Runs the expression at `t` ms on the clock. */
  evaluate(expr: string, timeoutMs: number, t: number): Promise<{ at: number; value?: string; note?: string; error?: string }>;
  /** The fonts the text under the element (or the whole page) rendered in. */
  fonts(selector: string | null): RenderedFont[];
}

/** The times view_page and eval_in_page wait: after a step by default, at most for one time, and how many pictures in one call. */
export const FRAMES = { afterStep: 1_000, afterLoad: 600, max: 10_000, count: 6 };

/** eval_in_page's limits: how long it waits, by default and at most (ms), and how much JSON it sends back. */
export const EVAL_TIMEOUT = { default: 5_000, max: 15_000 };
export const EVAL_MAX_JSON = 20_000;
export const evalTimeout = (req: { timeout?: number }) => Math.max(100, Math.min(EVAL_TIMEOUT.max, Number(req.timeout) || EVAL_TIMEOUT.default));
