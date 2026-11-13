// view_page and eval_in_page: what an agent asks of a render of the page (ViewRequest), what the render answers
// (ViewResult), the render's tools inside the page (PageRender) and the limits of both. Shared by the agent's tools
// (agents/document/page-tools.ts), the server's browser (cloudflare/render.ts) and the page (client/page-tools/).

import type { TextEdit } from "./text-edits";

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
  /** evaluate runs in the viewer's own window (the shell around the page's frame), not in the page. */
  shell?: boolean;
  /** The page opened in the editor (?edit), not in the viewer. */
  editor?: boolean;
  /**
   * A presentation's steps to show (libs/steps/api/steps.ts, stepSpec): each its number ("3.2"), or a hash ("#3.2") the
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
  /** Where it was shown: in the viewer or in the editor; and whether the viewer had its bars. */
  shown?: "viewer" | "editor";
  bars?: boolean;
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
  /**
   * The window's height a picture of the whole page, or of an element not all in view, needs: the page's height (at
   * most MAX_SHOT); 0 when the window as it is shows it.
   */
  need(selector: string | null, fullPage: boolean): number;
  /** Waits until `t` ms on the clock, holds the animations at `t`, and answers the part to take: the window (no clip) or an element, in the window's coordinates. */
  hold(t: number, selector: string | null, fullPage: boolean): Promise<{ at: number; clip?: Clip; note?: string; error?: string }>;
  /** Lets the animations run again after a picture; the time it took is left out of the clock. */
  release(): void;
  /** Runs the expression at `t` ms on the clock. */
  evaluate(expr: string, timeoutMs: number, t: number): Promise<{ at: number; value?: string; note?: string; error?: string }>;
  /** The fonts the text under the element (or the whole page) rendered in. */
  fonts(selector: string | null): RenderedFont[];
}

/**
 * The times view_page and eval_in_page wait: after a step by default, after the load for a picture (the page's scripts
 * and animations draw), at most for one time, and how many pictures in one call.
 */
export const FRAMES = { afterStep: 1_000, afterLoad: 600, max: 10_000, count: 6 };

/** When a render takes its pictures or runs its code, in ms after the step or the load: code runs at once after the load. */
export const renderTimes = (req: Pick<ViewRequest, "frames" | "atMs" | "steps" | "evaluate">): number[] =>
  req.frames?.length ? req.frames : [req.atMs ?? (req.steps?.length ? FRAMES.afterStep : req.evaluate != null ? 0 : FRAMES.afterLoad)];

/** eval_in_page's limits: how long it waits, by default and at most (ms), and how much JSON it sends back. */
export const EVAL_TIMEOUT = { default: 5_000, max: 15_000 };
export const EVAL_MAX_JSON = 20_000;
export const evalTimeout = (req: { timeout?: number }) =>
  Math.max(100, Math.min(EVAL_TIMEOUT.max, Number(req.timeout) || EVAL_TIMEOUT.default));
