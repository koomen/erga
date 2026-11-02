// The page tools: view_page and eval_in_page, which render the page afresh in the person's tab (a hidden frame of
// Erga's page tools: client/page-tools/capture.ts), and the live page's (page_log, page_input, and eval_in_page
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

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** view_page, eval_in_page and the live page's tools, over the person's tabs (`view`). */
export function pageTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  return [
    {
      name: "view_page",
      label: "Look at the page",
      description: "A picture of the page as the person sees it, with its script errors and fonts.",
      parameters: Schema.Struct({
        selector: Schema.optionalKey(Schema.String.annotate({ description: "CSS selector of one element to capture." })),
        full_page: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "The whole page, up to 4000px tall (default: the top screenful). Erga adds 56px of top padding to a page that scrolls.",
          })
        ),
        ...RENDER,
        ...STEP_FIELDS,
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
      description: "Runs JavaScript in a hidden copy of the page and returns the result as JSON.",
      parameters: Schema.Struct({
        expression: Schema.String.annotate({
          description: `JavaScript; await works, statements need a return. It runs after load; its changes are thrown away. The JSON is cut at ${EVAL_MAX_JSON / 1000}K characters.`,
        }),
        live: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Run it in the person's open page instead, read-only, only when they ask (the tab shows them a line).",
          })
        ),
        frame: FRAME,
        ...RENDER,
        timeout: Schema.optionalKey(
          Schema.Finite.annotate({ description: `ms to wait (default ${EVAL_TIMEOUT.default}, max ${EVAL_TIMEOUT.max}).` })
        ),
        ...STEP_FIELDS,
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

const FRAME = Schema.optionalKey(
  Schema.String.annotate({
    description: 'Live page only: "page" (default), an iframe\'s CSS selector, or a frame name from page_log frames.',
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

const MODIFIERS = ["shift", "alt", "ctrl", "meta"] as const;
type Modifier = (typeof MODIFIERS)[number];
type LogArgs = {
  kind: "console" | "network" | "events" | "frames";
  level?: ConsoleLevel[];
  pattern?: string;
  failed?: boolean;
  since?: string;
  limit?: number;
  frame?: string;
};

/**
 * page_log and page_input: the live page in the person's open editor tab (shared/live-page.ts), not view_page's
 * throwaway render. Asked over view_page's path.
 */
function liveTools(view: (req: ViewRequest) => Promise<ViewResult>): AgentTool[] {
  const ask = (req: LiveRequest) => askLive(view, req);
  return [
    {
      name: "page_log",
      label: "Read the live page",
      description: "The person's open page: its console, requests, events or frames (kind).",
      parameters: Schema.Struct({
        kind: Schema.Literals(["console", "network", "events", "frames"]).annotate({
          description:
            "console: logs and errors, repeats as one line; network: requests and how each was served; events: pointer and key events and who consumed them; frames: each frame's sandbox, activation, autoplay and media.",
        }),
        level: Schema.optionalKey(
          Schema.Array(Schema.Literals(CONSOLE_LEVELS)).annotate({ description: 'console: only these levels, e.g. ["error", "warn"].' })
        ),
        pattern: Schema.optionalKey(
          Schema.String.annotate({
            description: "console, network: only entries that match this regex or text (the URL, type or error for network).",
          })
        ),
        failed: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "network: only failed requests (an error, or status 400 or more)." })
        ),
        since: Schema.optionalKey(Schema.String.annotate({ description: 'Only since then: an ISO time, or "30s", "5m", "2h" ago.' })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many, the most recent (default 50; events 40)." })),
        frame: FRAME,
      }),
      execute: async (_id, p: LogArgs) => {
        const since = parseSince(p.since) ?? undefined;
        if (p.kind == "console") {
          const r = await ask({ kind: "console", levels: p.level, pattern: p.pattern, since, limit: p.limit });
          return text(`${describeConsole(r.console!)}\n${describeTab(r.tab)}`);
        }
        if (p.kind == "network") {
          const r = await ask({ kind: "network", pattern: p.pattern, since, failed: p.failed, limit: p.limit });
          return text(`${describeNetwork(r.network!)}\n${describeTab(r.tab)}`);
        }
        if (p.kind == "events") {
          const r = await ask({ kind: "events", since, limit: p.limit });
          return text(`${describeEvents(r.events!)}\n${describeTab(r.tab)}`);
        }
        if (p.kind != "frames") throw new Error('kind is "console", "network", "events" or "frames".');
        const r = await ask({ kind: "inspect", frame: p.frame });
        const i = r.inspect!;
        if (i.error) throw new Error(`${i.error} ${describeTab(r.tab)}`.trim());
        return text(`${JSON.stringify(i.facts, null, 1)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_input",
      label: "Act on the live page",
      description: "Clicks, or presses a key, in the person's open page, only when they ask.",
      parameters: Schema.Struct({
        selector: Schema.optionalKey(
          Schema.String.annotate({
            description: "CSS selector: the element to click at its center, or to send the key to (default: the focus).",
          })
        ),
        x: Schema.optionalKey(Schema.Finite.annotate({ description: "Or click at this point: CSS px in the page's window." })),
        y: Schema.optionalKey(Schema.Finite),
        key: Schema.optionalKey(
          Schema.String.annotate({ description: 'Press this key instead of a click, as KeyboardEvent.key: "Enter", " ", "k".' })
        ),
        modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(MODIFIERS)).annotate({ description: "Keys held with key." })),
        frame: FRAME,
      }),
      execute: async (
        _id,
        p: { selector?: string; x?: number; y?: number; key?: string; modifiers?: readonly Modifier[]; frame?: string }
      ) => {
        if (p.key == null) {
          if (p.modifiers?.length) throw new Error("modifiers apply to a key: give key with them.");
          const r = await ask({ kind: "click", selector: p.selector, x: p.x, y: p.y, frame: p.frame });
          return text(`${describeAct("click", r.act!)}\n${describeTab(r.tab)}`);
        }
        if (!p.key) throw new Error("Give the key to press.");
        if (p.x != null || p.y != null) throw new Error("x and y apply to a click: a key goes to selector or the focus.");
        const held = new Set(p.modifiers ?? []);
        const r = await ask({
          kind: "key",
          key: p.key,
          selector: p.selector,
          shift: held.has("shift"),
          alt: held.has("alt"),
          ctrl: held.has("ctrl"),
          meta: held.has("meta"),
          frame: p.frame,
        });
        return text(`${describeAct("key", r.act!)}\n${describeTab(r.tab)}`);
      },
    },
  ] as AgentTool[];
}

/** The render's size and mode, as view_page and eval_in_page take them. */
const RENDER = {
  width: Schema.optionalKey(Schema.Finite.annotate({ description: "Width in CSS px (default: the person's)." })),
  height: Schema.optionalKey(Schema.Finite.annotate({ description: "Screen height in CSS px (default: the person's)." })),
  color_scheme: Schema.optionalKey(Schema.Literals(["light", "dark"]).annotate({ description: "Default: the person's." })),
};
type RenderArgs = { width?: number; height?: number; color_scheme?: ColorScheme };
const renderReq = (p: RenderArgs) => ({ width: p.width, height: p.height, colorScheme: p.color_scheme });

/** step, at_ms and frames: a presentation's step, and when. */
const STEP_FIELDS = {
  step: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Finite]).annotate({
      description: 'A step of a presentation (window.ergaSteps) to show first: "3", "3.2" (slide 3, part 2) or "#3.2".',
    })
  ),
  at_ms: Schema.optionalKey(
    Schema.Finite.annotate({
      description: `ms after the step or load (default ${FRAMES.afterStep} after a step, ${FRAMES.afterLoad} after load; max ${FRAMES.max}).`,
    })
  ),
  frames: Schema.optionalKey(
    Schema.Array(Schema.Finite).annotate({
      description: `Several at_ms times in one call (at most ${FRAMES.count}), e.g. for a transition.`,
    })
  ),
};
type StepArgs = { step?: string | number; at_ms?: number; frames?: readonly number[] };
function stepReq(p: StepArgs): { step?: string; atMs?: number; frames?: number[] } {
  if (p.at_ms != null && p.frames?.length) throw new Error("Give at_ms or frames, not both.");
  return { step: p.step == null ? undefined : stepSpec(p.step), atMs: p.at_ms, ...(p.frames?.length ? { frames: [...p.frames] } : {}) };
}
const PREVIEW = {
  edits: Schema.optionalKey(
    EDITS.annotate({ description: "A preview: edits as the edit tool takes them, on a copy, for this render only." })
  ),
  path: Schema.optionalKey(
    Schema.String.annotate({ description: 'Another page of the document to render, e.g. "notes.html" (default: the open one).' })
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
