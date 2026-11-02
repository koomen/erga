// The page tools: view_page and eval_in_page, which render the page afresh in the person's tab (a hidden frame of
// Erga's page tools: client/page-tools/capture.ts), and the live page's (page_console ... page_key, and eval_in_page
// with live), which read and act on the page as it runs there (shared/live-page.ts).

import * as Schema from "effect/Schema";
import type { AgentTool } from "../run";
import type { TextEdit } from "../../shared/text-edits";
import { EDITS } from "./workspace";
import { stepSpec } from "../../shared/steps";
import {
  EVAL_MAX_JSON,
  EVAL_TIMEOUT,
  FRAMES,
  type ColorScheme,
  type StepShown,
  type ViewRequest,
  type ViewResult,
} from "../../shared/agent-log";
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

/** view_page, eval_in_page and the live page's tools, over the person's tabs (`view`). */
export function pageTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return [
    {
      name: "view_page",
      label: "Look at the page",
      description: `See the page the user has open, as they see it: a picture of the latest version rendered in the user's browser, plus any JavaScript errors it threw, the fonts its text rendered in, and the size and light or dark mode it rendered at. By default one screenful from the top, at the user's own window size and mode; full_page for the whole page (up to 4000px tall); selector for one element; width, height and color_scheme to see it as someone else would. ${AT_STEP} ${PREVIEW_WORDS} It renders in a hidden copy: the user's own view doesn't move. A page that scrolls has 56px more padding at the top of its <html> in every view, where Erga's bars float over it; it isn't in the page's files.`,
      parameters: Schema.Struct({
        selector: Schema.optionalKey(
          Schema.String.annotate({ description: 'CSS selector of an element to capture, e.g. "#chart" or "figure:nth-of-type(2)".' })
        ),
        full_page: Schema.optionalKey(Schema.Boolean.annotate({ description: "Capture the whole page rather than the first screenful." })),
        ...RENDER,
        ...STEP_FIELDS("picture is taken"),
        ...PREVIEW,
      }),
      execute: async (_id, p: { selector?: string; full_page?: boolean } & RenderArgs & StepArgs & PreviewArgs) => {
        const v = await view({ selector: p.selector, fullPage: p.full_page, ...renderReq(p), ...stepReq(p), ...previewReq(p) });
        if (v.error || !v.png) throw new Error(v.error ?? "The page couldn't be captured.");
        const words = { type: "text" as const, text: describeView(v, p.selector, p.full_page) };
        if (!v.shots?.length) return { content: [{ type: "image" as const, data: v.png, mimeType: "image/png" }, words], details: {} };
        return {
          content: [
            ...v.shots.flatMap((s) => [
              { type: "text" as const, text: `At ${s.at} ms:` },
              { type: "image" as const, data: s.png, mimeType: "image/png" },
            ]),
            words,
          ],
          details: {},
        };
      },
    },
    {
      name: "eval_in_page",
      label: "Run JavaScript in the page",
      description: `Run JavaScript in the page the user has open, and get its result as JSON. By default it runs in a fresh hidden copy, rendered as view_page renders it (the latest version, in the user's browser): for what a picture can't measure, such as computed styles, the fonts in use, element sizes and positions. E.g. getComputedStyle(document.querySelector("h1")).fontFamily, [...document.fonts].filter((f) => f.status == "loaded").map((f) => f.family), or document.querySelector("#chart").getBoundingClientRect(). The copy is thrown away: nothing it changes reaches the document (edit the files for that), and it can reach nothing the page's own scripts can't. It runs once the page loaded (its scripts ran) and its fonts and images loaded, or says what still loaded. ${AT_STEP} ${PREVIEW_WORDS} With frames, the result is a list: [{"at_ms": 300, "value": ...}, ...]. With live, it runs in ${LIVE} instead (frame picks a frame inside it): read-only, as it is the person's live page, not a copy; use live only when the user asks you to look into their page in this conversation, and the tab shows them a line each time. The code may be async (await works); statements need their own return. Waits ${EVAL_TIMEOUT.default / 1000}s for the result by default (timeout, at most ${EVAL_TIMEOUT.max / 1000}s); the JSON is cut to ${EVAL_MAX_JSON / 1000}K characters, so return only what you need.`,
      parameters: Schema.Struct({
        expression: Schema.String.annotate({ description: "JavaScript to run in the page, e.g. getComputedStyle(document.body).fontSize" }),
        live: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Run it in the live page as it runs now, not in a fresh copy (default false)." })
        ),
        frame: FRAME,
        ...RENDER,
        timeout: Schema.optionalKey(
          Schema.Finite.annotate({
            description: `How long to wait for the result, in ms (default ${EVAL_TIMEOUT.default}, at most ${EVAL_TIMEOUT.max}).`,
          })
        ),
        ...STEP_FIELDS("expression runs"),
        ...PREVIEW,
      }),
      execute: async (
        _id,
        p: { expression: string; live?: boolean; frame?: string; timeout?: number } & RenderArgs & StepArgs & PreviewArgs
      ) => {
        if (!p.expression?.trim()) throw new Error("Give an expression to run.");
        if (p.live) {
          const fresh = ["width", "height", "color_scheme", "step", "at_ms", "frames", "edits", "path"].filter(
            (k) => (p as Record<string, unknown>)[k] != null
          );
          if (fresh.length) throw new Error(`${fresh.join(", ")} apply to a fresh copy only, not with live.`);
          const r = await askLive(view, { kind: "inspect", expression: p.expression, frame: p.frame, timeout: p.timeout });
          const i = r.inspect!;
          if (i.error) throw new Error(`${i.error} ${describeTab(r.tab)}`.trim());
          return text(`${i.value}${i.note ? `\n\n[${i.note}]` : ""}\n${describeTab(r.tab)}`);
        }
        if (p.frame != null) throw new Error("frame applies to the live page only: give live: true with it.");
        const v = await view({ evaluate: p.expression, timeout: p.timeout, ...renderReq(p), ...stepReq(p), ...previewReq(p) });
        const errors = v.errors.length ? `\nThe page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "";
        if (v.error || v.value == null) throw new Error((v.error ?? "The page couldn't be inspected.") + errors);
        const where = [v.page ? `Rendered ${v.page}` : "", v.step ? `at ${describeStep(v.step)}` : ""].filter(Boolean).join(" ");
        return text(
          `${v.value}${v.note ? `\n\n[${v.note}]` : ""}${where ? `\n\n[${where}.]` : ""}${v.preview ? `\n\n[${describePreview(v.preview)}]` : ""}${errors}`
        );
      },
    },
    ...liveTools(view),
  ] as AgentTool[];
}

const LIVE =
  "the live page: the page as it runs now in the user's open editor tab (their focused tab, else a visible one), not view_page's fresh render";
const FRAME = Schema.optionalKey(
  Schema.String.annotate({
    description:
      'Which frame of the live page: "page" (the default), a CSS selector of an iframe inside the page, or a frame\'s name as page_inspect lists them.',
  })
);

/** A request to the live page, over view_page's path: its answer, or an error that says why there's none. */
async function askLive(view: (req: ViewRequest) => Promise<ViewResult>, req: LiveRequest): Promise<LiveResult> {
  const v = await view({ live: req });
  if (v.error || v.value == null) throw new Error(v.error ?? "The tab didn't answer.");
  let r: LiveResult;
  try {
    r = JSON.parse(v.value) as LiveResult;
  } catch {
    throw new Error("The tab's answer didn't parse.");
  }
  if (r.error) throw new Error(`${r.error} ${describeTab(r.tab)}`.trim());
  return r;
}

/**
 * page_console, page_network, page_events, page_inspect, page_click and page_key: the live page in the person's
 * open editor tab (shared/live-page.ts), not view_page's throwaway render. Asked over view_page's path.
 */
function liveTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  const ask = (req: LiveRequest) => askLive(view, req);
  const since = (raw: string | undefined) => parseSince(raw) ?? undefined;
  const SINCE = Schema.optionalKey(
    Schema.String.annotate({ description: 'Only what happened since then: an ISO time, or how long ago ("30s", "5m", "2h").' })
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
      description: `The fixed facts of each frame of ${LIVE} (the editor's, the page's, and those inside it): its sandbox and allow attributes, its user activation (isActive, hasBeenActive), the autoplay policy (permissions policy, getAutoplayPolicy), and each audio and video element's readyState, networkState, paused, currentTime, duration, error, src and type. To run JavaScript in the live page, use eval_in_page with live.`,
      parameters: Schema.Struct({ frame: FRAME }),
      execute: async (_id, p: { frame?: string }) => {
        const r = await ask({ kind: "inspect", frame: p.frame });
        const i = r.inspect!;
        if (i.error) throw new Error(`${i.error} ${describeTab(r.tab)}`.trim());
        return text(`${JSON.stringify(i.facts, null, 1)}\n${describeTab(r.tab)}`);
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
      execute: async (
        _id,
        p: { key: string; selector?: string; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; frame?: string }
      ) => {
        if (!p.key) throw new Error("Give the key to press.");
        const r = await ask({
          kind: "key",
          key: p.key,
          selector: p.selector,
          shift: p.shift,
          alt: p.alt,
          ctrl: p.ctrl,
          meta: p.meta,
          frame: p.frame,
        });
        return text(`${describeAct("key", r.act!)}\n${describeTab(r.tab)}`);
      },
    },
  ] as AgentTool[];
}

/** The render's size and mode, as view_page and eval_in_page take them. */
const RENDER = {
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
};
type RenderArgs = { width?: number; height?: number; color_scheme?: ColorScheme };
const renderReq = (p: RenderArgs) => ({ width: p.width, height: p.height, colorScheme: p.color_scheme });

const AT_STEP = `For a presentation (window.ergaSteps), step shows one step first: its number as the steps' list shows it, as a string ("3.2": slide 3, its second part; "4": slide 4), or a hash ("#3.2") to open the page at. at_ms waits that long after the step before the picture or the run (default ${FRAMES.afterStep} ms after a step, ${FRAMES.afterLoad} ms after the load); frames takes several at once, at these times after the step (e.g. [300, 900, 2500]), to check a transition in one call.`;
const PREVIEW_WORDS =
  'path renders another page of the document (e.g. "notes.html") in place of the open one. To see edits before you make them, give edits (as the edit tool takes them): they go to a copy of the page, for this render only.';
/** step, at_ms and frames: a presentation's step, and when. */
const STEP_FIELDS = (what: string) => ({
  step: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Finite]).annotate({
      description:
        'The step to show first, as a string: its number as the steps\' list shows it ("3": slide 3; "3.2": slide 3, its second part), or a hash ("#3.2").',
    })
  ),
  at_ms: Schema.optionalKey(
    Schema.Finite.annotate({ description: `How long after the step (or the load) the ${what}, in ms (at most ${FRAMES.max}).` })
  ),
  frames: Schema.optionalKey(
    Schema.Array(Schema.Finite).annotate({
      description: `Several times after the step, in ms (at most ${FRAMES.count}, each up to ${FRAMES.max}): the ${what} at each. The step's CSS transitions and animations show as they are at each time; animation by script runs on its own.`,
    })
  ),
});
type StepArgs = { step?: string | number; at_ms?: number; frames?: readonly number[] };
function stepReq(p: StepArgs): { step?: string; atMs?: number; frames?: number[] } {
  if (p.at_ms != null && p.frames?.length) throw new Error("Give at_ms or frames, not both.");
  return { step: p.step == null ? undefined : stepSpec(p.step), atMs: p.at_ms, ...(p.frames?.length ? { frames: [...p.frames] } : {}) };
}
const PREVIEW = {
  edits: Schema.optionalKey(
    EDITS.annotate({
      description:
        "A preview: edits as the edit tool takes them, applied to a copy of the open page's text for this render only, never to the document. If one doesn't apply, nothing renders and the answer says why.",
    })
  ),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The page to render, by its path in the document, e.g. "notes.html" (default: the page the user has open). edits go to it.',
    })
  ),
};
type PreviewArgs = { edits?: readonly TextEdit[]; path?: string };
function previewReq(p: PreviewArgs): { path?: string; preview?: { edits: TextEdit[] } } {
  return {
    ...(p.path != null ? { path: p.path } : {}),
    ...(p.edits ? { preview: { edits: p.edits.map((e) => ({ ...e })) } } : {}),
  };
}
const describePreview = (p: { path: string; edits: number }) =>
  `A preview: ${p.edits} edit${p.edits == 1 ? "" : "s"} applied to a copy of ${p.path}, for this render only. The document is unchanged: apply them with edit.`;
const describeStep = (s: StepShown) => `step ${s.number} (index ${s.index} of ${s.count}${s.label ? `: ${s.label}` : ""})`;

/** view_page's words beside its picture: what it shows, how it rendered (size, mode, fonts), and the page's errors. */
export function describeView(v: ViewResult, selector?: string, fullPage?: boolean): string {
  const lines = [
    `Screenshot${v.shots ? `s (${v.shots.length})` : ""}: ${v.width}×${v.height}px${selector ? ` of ${selector}` : fullPage ? ", whole page" : ", top of the page"}${v.page ? `, of ${v.page}` : ""}${v.step ? `, at ${describeStep(v.step)}` : ""}.`,
  ];
  if (v.viewport || v.colorScheme)
    lines.push(
      `Rendered${v.viewport ? ` in a ${v.viewport.width}×${v.viewport.height}px window` : ""}${v.colorScheme ? `${v.viewport ? "," : ""} in ${v.colorScheme} mode` : ""}.`
    );
  if (v.fonts?.length) {
    lines.push("Fonts the text rendered in:");
    for (const f of v.fonts)
      lines.push(
        `- ${f.family}${f.wanted ? ` (the page asked for ${f.wanted}, which didn't load or isn't installed)` : ""}: ${f.elements} element${f.elements == 1 ? "" : "s"} (${f.tags.join(", ")})`
      );
  }
  if (v.pending?.length) lines.push(`Still loading when the picture was taken: ${v.pending.join(", ")}.`);
  if (v.note) lines.push(v.note);
  if (v.preview) lines.push(describePreview(v.preview));
  lines.push(v.errors.length ? `The page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "No script errors.");
  return lines.join("\n");
}
