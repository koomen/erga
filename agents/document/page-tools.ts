// The page tools: view_page and eval_in_page, which render the page afresh in the server's browser
// (cloudflare/render.ts), and the live page's (page_log, page_input, and eval_in_page with live), which read and act
// on the page as it runs in the person's open tab (shared/live-page.ts).

import * as Schema from "effect/Schema";
import type { AgentTool } from "../run";
import type { TextEdit } from "../../shared/text-edits";
import { EDITS } from "./workspace";
import { stepSpec } from "../../libs/steps/api/steps";
import {
  EVAL_TIMEOUT,
  FRAMES,
  VIEW_DEFAULT,
  type ColorScheme,
  type Shot,
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
  type LiveAnswer,
  type LiveRequest,
  type LiveResult,
} from "../../shared/live-page";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** view_page and eval_in_page, over the server's browser (`view`), and the live page's tools, over the person's tabs (`live`). */
export function pageTools(view: (req: ViewRequest) => Promise<ViewResult>, live: (req: LiveRequest) => Promise<LiveAnswer>): AgentTool[] {
  return [
    {
      name: "view_page",
      label: "Look at the page",
      description: "Pictures of the page, with its script errors.",
      parameters: Schema.Struct({
        selector: Schema.optionalKey(
          Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
            description: "Elements to picture: one picture each.",
          })
        ),
        full_page: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Not only the top screenful.",
          })
        ),
        ...RENDER,
        step: Schema.optionalKey(
          Schema.Union([Schema.String, Schema.Finite, Schema.Array(Schema.Union([Schema.String, Schema.Finite]))]).annotate({
            description: `${STEP_WORDS} A list: one picture each.`,
          })
        ),
        ...TIME_FIELDS,
        ...PREVIEW,
      }),
      execute: async (
        _id,
        p: { selector?: string | readonly string[]; full_page?: boolean; step?: StepArg | readonly StepArg[] } & RenderArgs &
          TimeArgs &
          PreviewArgs
      ) => {
        const selectors = p.selector == null ? [] : typeof p.selector == "string" ? [p.selector] : [...p.selector];
        const steps = p.step == null ? [] : Array.isArray(p.step) ? p.step.map(stepSpec) : [stepSpec(p.step as StepArg)];
        if (selectors.length > 1 && steps.length > 1) throw new Error("Give a list of selectors or a list of steps, not both.");
        const times = timeReq(p);
        const pictures = Math.max(1, selectors.length, steps.length) * Math.max(1, times.frames?.length ?? 1);
        if (pictures > FRAMES.count)
          throw new Error(`That is ${pictures} pictures: one call takes at most ${FRAMES.count} (places × frames).`);
        const v = await view({
          ...(selectors.length ? { selectors } : {}),
          ...(steps.length ? { steps } : {}),
          fullPage: p.full_page,
          ...renderReq(p),
          ...times,
          ...previewReq(p),
        });
        if (v.error || !v.shots?.length) throw new Error(v.error ?? "The page couldn't be captured.");
        const many = v.shots.length > 1,
          names = shotNames(v.shots);
        return {
          content: [
            ...v.shots.flatMap((s, i) => [
              ...(many ? [{ type: "text" as const, text: `${names[i]}:` }] : []),
              { type: "image" as const, data: s.png, mimeType: "image/png" },
            ]),
            { type: "text" as const, text: describeView(v, p.full_page) },
          ],
          details: {},
        };
      },
    },
    {
      name: "eval_in_page",
      label: "Run JavaScript in the page",
      description: "Runs JavaScript in a copy of the page.",
      parameters: Schema.Struct({
        expression: Schema.String.annotate({
          description: "JavaScript; await works, statements need a return.",
        }),
        live: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "In the person's open page instead, only when they ask.",
          })
        ),
        frame: FRAME,
        ...RENDER,
        timeout: Schema.optionalKey(Schema.Finite),
        step: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite]).annotate({ description: STEP_WORDS })),
        ...TIME_FIELDS,
        ...PREVIEW,
      }),
      execute: async (
        _id,
        p: { expression: string; live?: boolean; frame?: string; timeout?: number; step?: StepArg } & RenderArgs & TimeArgs & PreviewArgs
      ) => {
        if (!p.expression?.trim()) throw new Error("Give an expression to run.");
        if (p.live) {
          const fresh = ["width", "height", "color_scheme", "step", "at_ms", "frames", "edits", "path"].filter(
            (k) => (p as Record<string, unknown>)[k] != null
          );
          if (fresh.length) throw new Error(`${fresh.join(", ")} apply to a fresh copy only, not with live.`);
          const r = await askLive(live, { kind: "inspect", expression: p.expression, frame: p.frame, timeout: p.timeout });
          const i = r.inspect!;
          if (i.error) throw new Error(`${i.error} ${describeTab(r.tab)}`.trim());
          return text(`${i.value}${i.note ? `\n\n[${i.note}]` : ""}\n${describeTab(r.tab)}`);
        }
        if (p.frame != null) throw new Error("frame applies to the live page only: give live: true with it.");
        const v = await view({
          evaluate: p.expression,
          timeout: p.timeout,
          ...renderReq(p),
          ...(p.step != null ? { steps: [stepSpec(p.step)] } : {}),
          ...timeReq(p),
          ...previewReq(p),
        });
        const errors = v.errors.length ? `\nThe page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "";
        if (v.error || v.value == null) throw new Error((v.error ?? "The page couldn't be inspected.") + errors);
        const where = [v.page ? `Rendered ${v.page}` : "", v.step ? `at ${describeStep(v.step)}` : ""].filter(Boolean).join(" ");
        return text(
          `${v.value}${v.note ? `\n\n[${v.note}]` : ""}${where ? `\n\n[${where}.]` : ""}${v.preview ? `\n\n[${describePreview(v.preview)}]` : ""}${errors}`
        );
      },
    },
    ...liveTools(live),
  ] as AgentTool[];
}

const FRAME = Schema.optionalKey(
  Schema.String.annotate({
    description: "Live page: an iframe's selector or name.",
  })
);

/** A request to the live page, in the person's tabs: its answer, or an error that says why there's none. */
async function askLive(live: (req: LiveRequest) => Promise<LiveAnswer>, req: LiveRequest): Promise<LiveResult> {
  const v = await live(req);
  if (v.value == null) throw new Error("The tab didn't answer.");
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
function liveTools(live: (req: LiveRequest) => Promise<LiveAnswer>): AgentTool[] {
  const ask = (req: LiveRequest) => askLive(live, req);
  return [
    {
      name: "page_log",
      label: "Read the live page",
      description: "The person's open page: its console, requests, events, frames.",
      parameters: Schema.Struct({
        kind: Schema.Literals(["console", "network", "events", "frames"]).annotate({
          description: "events: pointer and key events; frames: each frame's sandbox.",
        }),
        level: Schema.optionalKey(Schema.Array(Schema.Literals(CONSOLE_LEVELS))),
        pattern: Schema.optionalKey(
          Schema.String.annotate({
            description: "Only what matches.",
          })
        ),
        failed: Schema.optionalKey(Schema.Boolean),
        since: Schema.optionalKey(Schema.String.annotate({ description: 'Since then: a time, or "5m" ago.' })),
        limit: Schema.optionalKey(Schema.Finite),
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
      description: "Clicks or presses a key in the person's open page, when they ask.",
      parameters: Schema.Struct({
        selector: Schema.optionalKey(
          Schema.String.annotate({
            description: "CSS selector: the element to click at its center, or to send the key to (default: the focus).",
          })
        ),
        x: Schema.optionalKey(Schema.Finite.annotate({ description: "Or click at x, y (CSS px)." })),
        y: Schema.optionalKey(Schema.Finite),
        key: Schema.optionalKey(Schema.String.annotate({ description: 'A key instead, e.g. "Enter".' })),
        modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(MODIFIERS))),
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
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  color_scheme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
};
type RenderArgs = { width?: number; height?: number; color_scheme?: ColorScheme };
const renderReq = (p: RenderArgs) => ({ width: p.width, height: p.height, colorScheme: p.color_scheme });

type StepArg = string | number;
const STEP_WORDS = 'A presentation step to show first, e.g. "3.2".';
/** at_ms and frames: when, after the step or the load. */
const TIME_FIELDS = {
  at_ms: Schema.optionalKey(
    Schema.Finite.annotate({
      description: `ms after the step or load.`,
    })
  ),
  frames: Schema.optionalKey(
    Schema.Array(Schema.Finite).annotate({
      description: `Several at_ms times, for a transition.`,
    })
  ),
};
type TimeArgs = { at_ms?: number; frames?: readonly number[] };
function timeReq(p: TimeArgs): { atMs?: number; frames?: number[] } {
  if (p.at_ms != null && p.frames?.length) throw new Error("Give at_ms or frames, not both.");
  return { atMs: p.at_ms, ...(p.frames?.length ? { frames: [...p.frames] } : {}) };
}
const PREVIEW = {
  edits: Schema.optionalKey(
    EDITS.annotate({ description: "A preview: edits as the edit tool takes them, on a copy, for this render only." })
  ),
  path: Schema.optionalKey(Schema.String.annotate({ description: 'Another page, e.g. "notes.html".' })),
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

/** Each picture's name, as the words before it say it: what differs between the pictures (the element, the step) and when. */
function shotNames(shots: readonly Shot[]): string[] {
  const vary = (f: (s: Shot) => unknown) => new Set(shots.map(f)).size > 1;
  const bySelector = vary((s) => s.selector),
    byStep = vary((s) => s.step?.index);
  return shots.map((s) =>
    [bySelector ? s.selector : "", byStep && s.step ? describeStep(s.step) : "", `at ${s.at} ms`]
      .filter(Boolean)
      .join(", ")
      .replace(/^at/, "At")
  );
}

/** view_page's words beside its pictures: what they show, how the page rendered (size, mode, fonts), and its errors. */
export function describeView(v: ViewResult, fullPage?: boolean): string {
  const shots = v.shots ?? [];
  const one = shots.length == 1 ? shots[0] : null;
  const lines = [
    one
      ? `Screenshot: ${one.width}×${one.height}px${one.selector ? ` of ${one.selector}` : fullPage ? ", whole page" : ", top of the page"}${v.page ? `, of ${v.page}` : ""}${one.step ? `, at ${describeStep(one.step)}` : ""}.`
      : `Screenshots (${shots.length})${v.page ? ` of ${v.page}` : ""}${shots[0]?.selector && !shots.some((s) => s.selector != shots[0].selector) ? `, of ${shots[0].selector}` : ""}${shots[0]?.step && !shots.some((s) => s.step?.index != shots[0].step?.index) ? `, at ${describeStep(shots[0].step)}` : ""}: ${shotNames(
          shots
        )
          .map((n, i) => `${n.replace(/^At/, "at")}, ${shots[i].width}×${shots[i].height}px`)
          .join("; ")}.`,
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
  for (const s of shots) if (s.note) lines.push(s.note);
  if (v.note) lines.push(v.note);
  if (v.preview) lines.push(describePreview(v.preview));
  lines.push(v.errors.length ? `The page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "No script errors.");
  return lines.join("\n");
}
