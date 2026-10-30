// The page tools: view_page and evaluate_page, which render the page afresh in the person's tab (a hidden frame of
// the page editor: client/page-editor/frame.ts, captureView), and the live page's (page_console ... page_key), which
// read and act on the page as it runs there (shared/live-page.ts).

import * as Schema from "effect/Schema";
import type { AgentTool } from "../run";
import { EVAL_MAX_JSON, EVAL_TIMEOUT, type ColorScheme, type ViewRequest, type ViewResult } from "../../shared/agent-log";
import {
  CONSOLE_LEVELS,
  describeAct,
  describeConsole,
  describeEvents,
  describeNetwork,
  describeTab,
  parseSince,
  type ConsoleLevel,
  type LiveRequest,
  type LiveResult,
} from "../../shared/live-page";

/** view_page, evaluate_page and the live page's tools, over the person's tabs (`view`). */
export function pageTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return [
    {
      name: "view_page",
      label: "Look at the page",
      description: "See the page the user has open, as they see it: a picture of the latest version rendered in the user's browser, plus any JavaScript errors it threw, the fonts its text rendered in, and the size and light or dark mode it rendered at. By default one screenful from the top, at the user's own window size and mode; full_page for the whole page (up to 4000px tall); selector for one element; width, height and color_scheme to see it as someone else would.",
      parameters: Schema.Struct({
        selector: Schema.optionalKey(
          Schema.String.annotate({ description: 'CSS selector of an element to capture, e.g. "#chart" or "figure:nth-of-type(2)".' })
        ),
        full_page: Schema.optionalKey(Schema.Boolean.annotate({ description: "Capture the whole page rather than the first screenful." })),
        width: Schema.optionalKey(
          Schema.Finite.annotate({ description: "Width to render at, in CSS pixels (default: as wide as the user's page)." })
        ),
        height: Schema.optionalKey(
          Schema.Finite.annotate({ description: "Height of the screenful, in CSS pixels (default: as tall as the user's page)." })
        ),
        color_scheme: Schema.optionalKey(
          Schema.Literals(["light", "dark"]).annotate({
            description: "Light or dark mode, for the page's prefers-color-scheme (default: the user's).",
          })
        ),
      }),
      execute: async (_id, p: { selector?: string; full_page?: boolean; width?: number; height?: number; color_scheme?: ColorScheme }) => {
        const v = await view({ selector: p.selector, fullPage: p.full_page, width: p.width, height: p.height, colorScheme: p.color_scheme });
        if (v.error || !v.png) throw new Error(v.error ?? "The page couldn't be captured.");
        return { content: [{ type: "image" as const, data: v.png, mimeType: "image/png" }, { type: "text" as const, text: describeView(v, p.selector, p.full_page) }], details: {} };
      },
    },
    {
      name: "evaluate_page",
      label: "Inspect the page",
      description: `Run a JavaScript expression in the page the user has open, rendered as view_page renders it (the latest version, in the user's browser), and get its result as JSON. For what a picture can't measure: computed styles, the fonts in use, element sizes and positions. E.g. getComputedStyle(document.querySelector("h1")).fontFamily, [...document.fonts].filter((f) => f.status == "loaded").map((f) => f.family), or document.querySelector("#chart").getBoundingClientRect(). It may be async (await works); statements need their own return. Read-only: it runs in a throwaway copy, so nothing it changes reaches the document (edit the files for that), and it can reach nothing the page's own scripts can't. Waits ${EVAL_TIMEOUT.default / 1000}s for the result by default (timeout, at most ${EVAL_TIMEOUT.max / 1000}s); the JSON is cut to ${EVAL_MAX_JSON / 1000}K characters, so return only what you need.`,
      parameters: Schema.Struct({
        expression: Schema.String.annotate({ description: "JavaScript to run in the page, e.g. getComputedStyle(document.body).fontSize" }),
        width: Schema.optionalKey(
          Schema.Finite.annotate({ description: "Width to render at, in CSS pixels (default: as wide as the user's page)." })
        ),
        height: Schema.optionalKey(
          Schema.Finite.annotate({ description: "Height of the screenful, in CSS pixels (default: as tall as the user's page)." })
        ),
        color_scheme: Schema.optionalKey(
          Schema.Literals(["light", "dark"]).annotate({
            description: "Light or dark mode, for the page's prefers-color-scheme (default: the user's).",
          })
        ),
        timeout: Schema.optionalKey(
          Schema.Finite.annotate({
            description: `How long to wait for the result, in ms (default ${EVAL_TIMEOUT.default}, at most ${EVAL_TIMEOUT.max}).`,
          })
        ),
      }),
      execute: async (_id, p: { expression: string; width?: number; height?: number; color_scheme?: ColorScheme; timeout?: number }) => {
        if (!p.expression?.trim()) throw new Error("Give an expression to run.");
        const v = await view({ evaluate: p.expression, width: p.width, height: p.height, colorScheme: p.color_scheme, timeout: p.timeout });
        const errors = v.errors.length ? `\nThe page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "";
        if (v.error || v.value == null) throw new Error((v.error ?? "The page couldn't be inspected.") + errors);
        return text(`${v.value}${v.note ? `\n\n[${v.note}]` : ""}${errors}`);
      },
    },
    ...liveTools(view),
  ] as AgentTool[];
}

/**
 * page_console, page_network, page_events, page_inspect, page_click and page_key: the live page in the person's
 * open editor tab (shared/live-page.ts), not view_page's throwaway render. Asked over view_page's path.
 */
function liveTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  const ask = async (req: LiveRequest): Promise<LiveResult> => {
    const v = await view({ live: req });
    if (v.error || v.value == null) throw new Error(v.error ?? "The tab didn't answer.");
    let r: LiveResult;
    try { r = JSON.parse(v.value) as LiveResult; } catch { throw new Error("The tab's answer didn't parse."); }
    if (r.error) throw new Error(`${r.error} ${describeTab(r.tab)}`.trim());
    return r;
  };
  const since = (raw: string | undefined) => parseSince(raw) ?? undefined;
  const LIVE =
    "the live page: the page as it runs now in the user's open editor tab (their focused tab, else a visible one), not view_page's fresh render";
  const SINCE = Schema.optionalKey(
    Schema.String.annotate({ description: 'Only what happened since then: an ISO time, or how long ago ("30s", "5m", "2h").' })
  );
  const FRAME = Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Which frame: "page" (the default), a CSS selector of an iframe inside the page, or a frame\'s name as page_inspect lists them.',
    })
  );
  return [
    {
      name: "page_console",
      label: "Read the page's console",
      description: `Read the console of ${LIVE}: errors, warnings and logs from the editor's own windows and from the page's frames (the frames inside it too, on its origin), uncaught errors, unhandled rejections, and audio, video, image or script files that failed to load. Identical messages collapse into one line with a count and the first and last time, so a warning repeated 50,000 times is one line. Filter by level, pattern and since.`,
      parameters: Schema.Struct({
        level: Schema.optionalKey(
          Schema.Array(Schema.Union(CONSOLE_LEVELS.map((l) => Schema.Literal(l)))).annotate({
            description: 'Only these levels, e.g. ["error", "warn"] (default: all).',
          })
        ),
        pattern: Schema.optionalKey(
          Schema.String.annotate({ description: "Only messages matching this regular expression (case-insensitive) or text." })
        ),
        since: SINCE,
        limit: Schema.optionalKey(
          Schema.Finite.annotate({ description: "How many distinct messages, the most recent (default 50, at most 200)." })
        ),
      }),
      execute: async (_id, p: { level?: ConsoleLevel[]; pattern?: string; since?: string; limit?: number }) => {
        const r = await ask({ kind: "console", levels: p.level, pattern: p.pattern, since: since(p.since), limit: p.limit });
        return text(`${describeConsole(r.console!)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_network",
      label: "Read the page's requests",
      description: `List the requests of ${LIVE}: each file and fetch its frames asked for, with method, status, content type, size, byte range (the request's Range and the response's Content-Range, where known), timing, who asked (audio, img, script, fetch...), and how it was served: by Erga's server (the document's own files, with what the server says it sent), a service worker, the cache, or the network. Filter by pattern (URL, type or error), since, or failed only.`,
      parameters: Schema.Struct({
        pattern: Schema.optionalKey(
          Schema.String.annotate({
            description:
              'Only requests whose URL, content type or error matches this regular expression or text, e.g. "\\.m4a" or "audio/".',
          })
        ),
        since: SINCE,
        failed: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Only requests that failed (an error, or status 400 or more)." })
        ),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many, the most recent (default 50, at most 300)." })),
      }),
      execute: async (_id, p: { pattern?: string; since?: string; failed?: boolean; limit?: number }) => {
        const r = await ask({ kind: "network", pattern: p.pattern, since: since(p.since), failed: p.failed, limit: p.limit });
        return text(`${describeNetwork(r.network!)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_events",
      label: "Read the page's events",
      description: `Read the log of pointer and key events on ${LIVE}, and who consumed each one: whether the editor or the page's own script called preventDefault or stopPropagation, on which element's listener, and in which phase. Use it when a click or a key on the page seems to do nothing: e.g. "click on <button#play>: the editor called preventDefault".`,
      parameters: Schema.Struct({
        since: SINCE,
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many, the most recent (default 40, at most 200)." })),
      }),
      execute: async (_id, p: { since?: string; limit?: number }) => {
        const r = await ask({ kind: "events", since: since(p.since), limit: p.limit });
        return text(`${describeEvents(r.events!)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_inspect",
      label: "Inspect the live page",
      description: `Inspect ${LIVE}. Without an expression: the fixed facts of each frame (the editor's, the page's, and those inside it): its sandbox and allow attributes, its user activation (isActive, hasBeenActive), the autoplay policy (permissions policy, getAutoplayPolicy), and each audio and video element's readyState, networkState, paused, currentTime, duration, error, src and type. With an expression: runs that JavaScript in the page's frame (never in the editor's own origin) and gives its result as JSON; it may be async; statements need their own return. Read-only: it must not change the page (it is the person's live page, not a copy). Use it only when the user asks you to look into their page in this conversation; the tab shows them a line each time.`,
      parameters: Schema.Struct({
        expression: Schema.optionalKey(
          Schema.String.annotate({
            description: 'JavaScript to run in the live page, e.g. document.querySelector("audio").buffered.length',
          })
        ),
        frame: FRAME,
        timeout: Schema.optionalKey(
          Schema.Finite.annotate({
            description: `How long to wait for the result, in ms (default ${EVAL_TIMEOUT.default}, at most ${EVAL_TIMEOUT.max}).`,
          })
        ),
      }),
      execute: async (_id, p: { expression?: string; frame?: string; timeout?: number }) => {
        const r = await ask({ kind: "inspect", expression: p.expression, frame: p.frame, timeout: p.timeout });
        const i = r.inspect!;
        if (i.error) throw new Error(`${i.error} ${describeTab(r.tab)}`.trim());
        const body = i.facts !== undefined ? JSON.stringify(i.facts, null, 1) : `${i.value}${i.note ? `\n\n[${i.note}]` : ""}`;
        return text(`${body}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_click",
      label: "Click on the live page",
      description: `Click on ${LIVE}, through the editor's own handlers and then the page's: pointerdown, mousedown, pointerup, mouseup and click, at an element (selector: its center) or a point (x, y in the page's window). The browser marks a script's events untrusted, so the click gives no user activation of its own; the page's media may still play, on the activation from the user's last click in the tab (the editor delegates autoplay to the page; Chrome). The answer says whether the event was trusted, the activation before and after, who consumed it, the media's state and the console right after. Click only when the user asks you to act on their page in this conversation; the tab shows them a line each time.`,
      parameters: Schema.Struct({
        selector: Schema.optionalKey(Schema.String.annotate({ description: 'CSS selector of the element to click, e.g. "#play".' })),
        x: Schema.optionalKey(Schema.Finite.annotate({ description: "Or the point to click: x in the page's window, in CSS pixels." })),
        y: Schema.optionalKey(Schema.Finite.annotate({ description: "And y." })),
        frame: FRAME,
      }),
      execute: async (_id, p: { selector?: string; x?: number; y?: number; frame?: string }) => {
        const r = await ask({ kind: "click", selector: p.selector, x: p.x, y: p.y, frame: p.frame });
        return text(`${describeAct("click", r.act!)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_key",
      label: "Press a key on the live page",
      description: `Press a key on ${LIVE} (keydown, then keyup), through the editor's own handlers and then the page's: on the element a selector names, else on whatever has the focus. The key as KeyboardEvent.key names it: "Enter", " ", "ArrowLeft", "k". The answer says whether the event was trusted, the activation before and after, and who consumed it. Press keys only when the user asks you to act on their page in this conversation; the tab shows them a line each time.`,
      parameters: Schema.Struct({
        key: Schema.String.annotate({ description: 'The key, e.g. "Enter", " ", "ArrowRight", "k".' }),
        selector: Schema.optionalKey(
          Schema.String.annotate({ description: "CSS selector of the element to send it to (default: the focused element)." })
        ),
        shift: Schema.optionalKey(Schema.Boolean),
        alt: Schema.optionalKey(Schema.Boolean),
        ctrl: Schema.optionalKey(Schema.Boolean),
        meta: Schema.optionalKey(Schema.Boolean),
        frame: FRAME,
      }),
      execute: async (_id, p: { key: string; selector?: string; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; frame?: string }) => {
        if (!p.key) throw new Error("Give the key to press.");
        const r = await ask({ kind: "key", key: p.key, selector: p.selector, shift: p.shift, alt: p.alt, ctrl: p.ctrl, meta: p.meta, frame: p.frame });
        return text(`${describeAct("key", r.act!)}\n${describeTab(r.tab)}`);
      },
    },
  ] as AgentTool[];
}

/** view_page's words beside its picture: what it shows, how it rendered (size, mode, fonts), and the page's errors. */
export function describeView(v: ViewResult, selector?: string, fullPage?: boolean): string {
  const lines = [`Screenshot: ${v.width}×${v.height}px${selector ? ` of ${selector}` : fullPage ? ", whole page" : ", top of the page"}.`];
  if (v.viewport || v.colorScheme) lines.push(`Rendered${v.viewport ? ` in a ${v.viewport.width}×${v.viewport.height}px window` : ""}${v.colorScheme ? `${v.viewport ? "," : ""} in ${v.colorScheme} mode` : ""}.`);
  if (v.fonts?.length) {
    lines.push("Fonts the text rendered in:");
    for (const f of v.fonts) lines.push(`- ${f.family}${f.wanted ? ` (the page asked for ${f.wanted}, which didn't load or isn't installed)` : ""}: ${f.elements} element${f.elements == 1 ? "" : "s"} (${f.tags.join(", ")})`);
  }
  if (v.pending?.length) lines.push(`Still loading when the picture was taken: ${v.pending.join(", ")}.`);
  if (v.note) lines.push(v.note);
  lines.push(v.errors.length ? `The page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "No script errors.");
  return lines.join("\n");
}
