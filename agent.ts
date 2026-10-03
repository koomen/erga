// The agent editor: one session per person per document, running in the
// host. A session holds that person's transcript and runs, and joins the
// document room as an ordinary Yjs peer with its own replica of the shared
// doc. The room never holds a conversation, a long run doesn't load the
// room, and closing the tab doesn't stop the agent.
//
// It runs on pi's agent core (https://github.com/badlogic/pi-mono:
// @mariozechner/pi-agent-core + pi-ai) with our own tools, written against
// the small Workspace interface in workspace.ts, so the same agent could
// run elsewhere (a browser) if it ever needs to. Others see only its edits,
// attributed ("Pete's agent"), and its presence while it works: a labelled
// cursor where it last edited, and whether it's busy, on awareness.
//
// This module is the Promise edge: pi's SDK is async, and open.ts wraps
// what it exposes in Effect.
//
// Configuration comes from .env (see .env.example; ERGA_AGENT_ENV_FILE
// points elsewhere), falling back to the environment. The key lives only here,
// in the host:
//   ANTHROPIC_API_KEY          required
//   ERGA_AGENT_MODEL    the model a session starts on: sonnet (default,
//                              Claude Sonnet 5.5) or opus-fast (Claude Opus 5.5
//                              in fast mode); each person can switch in the panel
//   ERGA_AGENT_EFFORT   low | medium (default) | high | xhigh | max
//
// ERGA_AGENT_MODEL=script swaps the model for a scripted one (see
// `scriptModel`), for the test suite in tests/suite/: deterministic, free,
// and it needs no key. Never set it on a deployment real people use.

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, validateToolArguments, type Context, type Model } from "@mariozechner/pi-ai";
import { Agent as PiAgent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { emptyLog, reduce, type Log, type LogEvent } from "./src/page/agent-log";
import type { ViewRequest, ViewResult } from "./src/page/agent-log";
import { agentName, colorFor, files, introduce, stamp, stateVector, type Author } from "./src/room/doc";
import { joinLocal, type Room } from "./room";
import type { Naming } from "./directory";
import { YjsWorkspace, WorkspaceError, cleanPath, globToRegExp, type Workspace } from "./workspace";
import documentPrompt from "./DOCUMENT_PROMPT.md" with { type: "text" };

/** The models a person can switch between, by key; prices per million tokens. */
export const MODELS = {
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", fast: false, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  "opus-fast": { id: "claude-opus-5-5", label: "Opus 5.5 fast", fast: true, cost: { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 } },
} as const;
export type ModelChoice = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelChoice = "sonnet";
export const isModelChoice = (s: string): s is ModelChoice => Object.hasOwn(MODELS, s);

export interface AgentConfig {
  apiKey: Redacted.Redacted<string>;
  /** The model sessions start on, or the scripted test model. */
  model: ModelChoice | "script";
  effort: string;
}

const isScript = (cfg: AgentConfig) => cfg.model == "script";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The agent's settings; the key stays redacted, so it can't end up in a log. */
const settings = Config.all({
  apiKey: Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
  model: Config.withDefault(Config.Literals([...Object.keys(MODELS) as ModelChoice[], "script"], "ERGA_AGENT_MODEL"), DEFAULT_MODEL),
  effort: Config.withDefault(Config.Literals(EFFORTS, "ERGA_AGENT_EFFORT"), "medium"),
});

/** Reads the agent's settings from the given env file, falling back to the process env. */
export const loadConfig = (envPath: string): Effect.Effect<AgentConfig | { missing: string }, never, FileSystem.FileSystem> => Effect.gen(function* () {
  const env = ConfigProvider.fromEnv();
  const provider = yield* ConfigProvider.fromDotEnv({ path: envPath }).pipe(
    Effect.map((file) => ConfigProvider.orElse(file, env)),
    Effect.orElseSucceed(() => env),
  );
  return yield* agentConfigFrom(provider);
});

/** Reads the agent's settings from a provider (hosted: the Worker's bindings). */
export const agentConfigFrom = (provider: ConfigProvider.ConfigProvider): Effect.Effect<AgentConfig | { missing: string }> => Effect.gen(function* () {
  const read = yield* Effect.result(settings.parse(provider));
  if (read._tag == "Failure") {
    // "ERGA_AGENT_MODEL should be "sonnet" or "opus-fast"", not the schema's own wording.
    const m = /Expected (.+)\n\s*at \["(\w+)"\]/.exec(read.failure.message);
    return { missing: m ? `${m[2]} should be ${m[1].replaceAll(" | ", " or ")}` : read.failure.message };
  }
  const { apiKey, model, effort } = read.success;
  if (model == "script") return { apiKey: Redacted.make(""), model, effort: "medium" } satisfies AgentConfig;
  if (Option.isNone(apiKey) || !Redacted.value(apiKey.value)) return { missing: `ANTHROPIC_API_KEY is not set (copy .env.example to .env)` };
  return { apiKey: apiKey.value, model, effort } satisfies AgentConfig;
});

/**
 * pi's built-in catalogue predates the 5.5 models, so they're described here.
 * Fast mode (Opus only) is the `fast-mode-2026-02-01` beta plus `speed: "fast"`
 * in the request body (added in `patchPayload`).
 */
function describeModel(choice: ModelChoice): Model<"anthropic-messages"> {
  const m = MODELS[choice];
  return {
    id: m.id,
    name: m.label,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...m.cost },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    headers: m.fast ? { "anthropic-beta": "fast-mode-2026-02-01" } : undefined,
  };
}

/**
 * pi only knows adaptive thinking for the 4.6/4.7 models and would send a
 * budget (or `disabled`), both of which the 5.5 models reject. Rewrite the
 * request: adaptive thinking with summaries (so the panel can show them),
 * explicit effort, and fast mode when the current model has it.
 */
function patchPayload(cfg: AgentConfig, current: () => ModelChoice) {
  return (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    return {
      ...p,
      max_tokens: 64_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { ...(p.output_config as object | undefined), effort: cfg.effort },
      ...(MODELS[current()].fast ? { speed: "fast" } : {}),
    };
  };
}

/**
 * The scripted model, for tests. A message containing `@script` followed by
 * a JSON array of steps plays them in order, one per model call:
 *
 *   { "tool": "edit", "args": { ... } }   call a tool
 *   { "text": "Done." }                   reply and end the turn
 *   { "error": "overloaded" }             fail the request
 *
 * Any step may add "delay": ms, to wait before answering (so a test can act
 * between two tool calls). Once the steps run out it says "(script done)".
 */
let script: ReturnType<typeof registerFauxProvider> | null = null;
function scriptModel(): Model<string> {
  script ??= registerFauxProvider({ provider: "script", models: [{ id: "script", name: "script (test model)", input: ["text", "image"] }] });
  if (script.getPendingResponseCount() < 100) script.appendResponses(Array.from({ length: 1000 }, () => scriptStep));
  return script.getModel();
}

async function scriptStep(context: Context) {
  const msgs = context.messages;
  let at = -1, steps: { tool?: string; args?: Record<string, unknown>; text?: string; error?: string; delay?: number }[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role != "user") continue;
    const text = typeof m.content == "string" ? m.content : m.content.map((c) => (c.type == "text" ? c.text : "")).join("");
    const k = text.indexOf("@script");
    if (k < 0) continue;
    try { steps = JSON.parse(text.slice(k + 7).trim()); } catch (e) { return fauxAssistantMessage(`bad script: ${(e as Error).message}`); }
    at = i;
    break;
  }
  if (at < 0) return fauxAssistantMessage("(no script)");
  const step = steps[msgs.slice(at + 1).filter((m) => m.role == "assistant").length];
  if (step?.delay) await new Promise((r) => setTimeout(r, step.delay));
  if (!step) return fauxAssistantMessage("(script done)");
  if (step.error) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if (step.tool) return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
  return fauxAssistantMessage([fauxText(step.text ?? "")]);
}

/**
 * How to write documents the page editor can keep editing by hand
 * (DOCUMENT_PROMPT.md, the one copy of these rules), appended to the system prompt.
 */
const DOCUMENT_RULES = documentPrompt.trim();

const systemPrompt = (docName: string, kind: "html" | "md", owner: string) => `
You are ${agentName(owner)}, embedded in Erga's page editor. ${owner} is looking at
${docName} (${kind == "md" ? "Markdown" : "HTML"}) rendered as a live page, and editing its text in
place. Other people may have the same document open and be editing it too, each with
their own agent; you work for ${owner} only. The document is a folder of files (the page,
its styles, scripts, images, other pages); your tools see that folder, and you may read
and change any text file in it. Paths are relative to the folder.

- Your edits go straight into the shared document and show up in everyone's page as
  you make them, attributed to you. Prefer small, targeted edits (the edit tool) over
  rewriting whole files.
- People may be typing while you work. edit matches oldText against the text as it is
  at that moment; if it fails because the text changed, read the file again and retry.
  Read a file right before editing it (with read, not grep: search output cuts long
  lines, so text copied from it won't match), and keep edits scoped to what was asked.
- Messages may begin with an <editor> block saying where ${owner}'s caret or selection
  is. "This", "here" and "the selection" refer to it.
- Edits to the text show up in the page as you make them. Changes to anything else
  (the page's structure, scripts, styles, other files) show up when you finish your
  turn.
- view_page shows you the page as ${owner} sees it (a screenshot, plus any script
  errors). Use it to check visual work, like a diagram, layout or styling, before you
  say it's done. It renders your latest changes, including ones the page won't show
  until your turn ends. Pass a CSS selector to look closely at one element.
- get_title and set_title read and change the document's title (shown in the list and
  the browser tab) and its address, /<owner>/<slug>. Until someone sets them, the title
  follows the page's first heading and the slug follows the title, so a new heading
  usually renames the document by itself. Use set_title when asked to rename it or
  change its address.
- Keep replies short: say what you changed, not how. ${owner} can see the result.
- Follow the rules below whenever you create or change a page, so people can keep
  editing it by hand. When you fix a page that breaks them, keep its text as it is.

${DOCUMENT_RULES}
`.trim();

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The agent's tools, over a workspace. */
function makeTools(ws: Workspace, opts: {
  view: (req: ViewRequest) => Promise<ViewResult>;
  readAsset: (path: string) => Promise<Uint8Array | null>;
  edited: (path: string, at: number) => void;
  naming?: Naming;
}): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  /** Runs a workspace operation; its failure becomes the tool's error, which the model reads. */
  const run = <T>(op: Effect.Effect<T, WorkspaceError>): T => Effect.runSync(Effect.mapError(op, (e) => new Error(e.message)));
  return [
    {
      name: "read",
      label: "Read",
      description: `Read a file's current text (or see an image: png, jpg, gif, webp). Output is cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for more.`,
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file, relative to the document's folder" }),
        offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      }),
      execute: async (_id, p: { path: string; offset?: number; limit?: number }) => {
        const path = run(cleanPath(p.path));
        if (!ws.isText(path) && IMAGE.test(path)) {
          const bytes = await opts.readAsset(path);
          if (!bytes) throw new Error(`${path} doesn't exist`);
          return { content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: MIME[path.split(".").pop()!.toLowerCase()] }], details: {} };
        }
        const lines = run(ws.read(path)).split("\n");
        const start = Math.max(0, (p.offset ?? 1) - 1);
        if (start >= lines.length && lines.length > 1) throw new Error(`Offset ${p.offset} is beyond the end of the file (${lines.length} lines)`);
        let end = Math.min(lines.length, start + (p.limit ?? MAX_LINES));
        let out = lines.slice(start, end).join("\n");
        while (out.length > MAX_BYTES && end > start + 1) { end = start + Math.max(1, Math.floor((end - start) / 2)); out = lines.slice(start, end).join("\n"); }
        if (end < lines.length) out += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
        return text(out);
      },
    },
    {
      name: "edit",
      label: "Edit",
      description: "Edit a file by exact text replacement, against its text as it is right now. Every edits[].oldText must match a unique, non-overlapping region. If two changes touch the same block, merge them into one edit. If oldText isn't found, the file changed since you read it: read it again.",
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file to edit" }),
        edits: Type.Array(Type.Object({
          oldText: Type.String({ description: "Exact text to replace; must be unique in the file" }),
          newText: Type.String({ description: "Replacement text" }),
        }), { description: "One or more targeted replacements, each matched against the current file" }),
      }),
      execute: async (_id, p: { path: string; edits: { oldText: string; newText: string }[] }) => {
        const r = run(ws.edit(p.path, p.edits));
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "write",
      label: "Write",
      description: "Write a file's whole content, creating it if needed. For an existing file only the differences are applied, but prefer edit for targeted changes.",
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file to write" }),
        content: Type.String({ description: "The file's new content" }),
      }),
      execute: async (_id, p: { path: string; content: string }) => {
        const r = run(ws.write(p.path, p.content));
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "ls",
      label: "List",
      description: "List the files and folders directly inside a folder of the document (default: its root).",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Folder to list" })) }),
      execute: async (_id, p: { path?: string }) => {
        const dir = p.path && p.path.replace(/^[./]+$/, "") ? run(cleanPath(p.path!)) + "/" : "";
        const entries = new Set<string>();
        for (const f of ws.paths()) if (f.startsWith(dir)) { const rest = f.slice(dir.length); entries.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : rest); }
        if (!entries.size) throw new Error(`${p.path} is empty or doesn't exist`);
        return text([...entries].sort().join("\n"));
      },
    },
    {
      name: "find",
      label: "Find files",
      description: "Find files by glob pattern, e.g. \"*.css\" or \"posts/**/*.md\".",
      parameters: Type.Object({ pattern: Type.String({ description: "Glob pattern" }) }),
      execute: async (_id, p: { pattern: string }) => {
        const re = globToRegExp(p.pattern);
        const found = ws.paths().filter((f) => re.test(f));
        return text(found.length ? found.slice(0, 500).join("\n") : "No files match.");
      },
    },
    {
      name: "grep",
      label: "Search",
      description: "Search the text files for a regular expression (or literal text). Returns path:line: text, long lines cut.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Regular expression, or literal text with literal: true" }),
        glob: Type.Optional(Type.String({ description: "Only files matching this glob" })),
        ignoreCase: Type.Optional(Type.Boolean()),
        literal: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean }) => {
        let re: RegExp;
        try { re = new RegExp(p.literal ? p.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p.pattern, p.ignoreCase ? "i" : ""); } catch (e) { throw new Error(`bad pattern: ${(e as Error).message}`); }
        const only = p.glob ? globToRegExp(p.glob) : null;
        const out: string[] = [];
        for (const f of ws.paths()) {
          if (!ws.isText(f) || (only && !only.test(f))) continue;
          run(ws.read(f)).split("\n").forEach((line, i) => { if (out.length < 100 && re.test(line)) out.push(`${f}:${i + 1}: ${line.length > 300 ? line.slice(0, 300) + "…" : line}`); });
        }
        return text(out.length ? out.join("\n") + (out.length == 100 ? "\n[First 100 matches.]" : "") : "No matches.");
      },
    },
    {
      name: "view_page",
      label: "Look at the page",
      description: "See the page as the user sees it: a picture of the latest version rendered in the user's browser, plus any JavaScript errors it threw. By default one screenful from the top; full_page for the whole page (up to 4000px tall); selector for one element.",
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ description: "CSS selector of an element to capture, e.g. \"#chart\" or \"figure:nth-of-type(2)\"." })),
        full_page: Type.Optional(Type.Boolean({ description: "Capture the whole page rather than the first screenful." })),
        width: Type.Optional(Type.Number({ description: "Width to render at, in CSS pixels (default: as wide as the user's page)." })),
      }),
      execute: async (_id, p: { selector?: string; full_page?: boolean; width?: number }) => {
        const v = await opts.view({ selector: p.selector, fullPage: p.full_page, width: p.width });
        if (v.error || !v.png) throw new Error(v.error ?? "The page couldn't be captured.");
        const lines = [`Screenshot: ${v.width}×${v.height}px${p.selector ? ` of ${p.selector}` : p.full_page ? ", whole page" : ", top of the page"}.`];
        if (v.note) lines.push(v.note);
        lines.push(v.errors.length ? `The page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "No script errors.");
        return { content: [{ type: "image" as const, data: v.png, mimeType: "image/png" }, { type: "text" as const, text: lines.join("\n") }], details: {} };
      },
    },
    ...(opts.naming ? namingTools(opts.naming) : []),
  ] as AgentTool[];
}

/** get_title and set_title: the document's title and its address, kept in the directory (directory.ts), not in a file. */
function namingTools(naming: Naming): AgentTool[] {
  const describe = (n: Awaited<ReturnType<Naming["get"]>>) => [
    `Title: ${n.title}${n.titleSet ? " (set by someone)" : " (follows the page's first heading)"}`,
    `Address: ${n.address} (slug "${n.slug}"${n.slugSet ? ", set by someone" : ", follows the title"})`,
    `Always reachable at /d/${n.id}.`,
  ].join("\n");
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return [
    {
      name: "get_title",
      label: "Read the title",
      description: "Read the document's title (shown in the document list and the browser tab) and its address, /<owner>/<slug>. Until someone sets them, the title follows the page's first heading and the slug follows the title.",
      parameters: Type.Object({}),
      execute: async () => text(describe(await naming.get())),
    },
    {
      name: "set_title",
      label: "Rename the document",
      description: "Set the document's title, its address slug (the last part of /<owner>/<slug>), or both. The slug is made from what you give (\"Q3 plan\" becomes \"q3-plan\"); one already used by another of the owner's documents is refused. An empty string goes back to following: the title the page's first heading, the slug the title. Old addresses keep redirecting to the new one, and everyone's open editor moves to it. Only rename when asked to; this doesn't change the page's text (edit its heading for that).",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "The new title, or \"\" to follow the page's first heading again" })),
        slug: Type.Optional(Type.String({ description: "The new slug (lowercase letters, digits, dashes), or \"\" to follow the title again" })),
      }),
      execute: async (_id, p: { title?: string; slug?: string }) => {
        if (p.title === undefined && p.slug === undefined) throw new Error("Give a title, a slug, or both.");
        return text(`Renamed.\n${describe(await naming.set(p))}`);
      },
    },
  ] as AgentTool[];
}

/** What a tool returns: text, and for read on an image or view_page, a picture. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** A tool as an external agent sees it: its arguments as JSON Schema. */
export interface ToolSpec { name: string; description: string; parameters: unknown }

export interface AgentSession {
  /** The model's name, or null when the embedded agent is off (its tools still work). */
  readonly model: string | null;
  /** The model it's on, of MODELS; null when off or scripted (nothing to switch). */
  readonly modelChoice: ModelChoice | null;
  /** Switches model from the next turn on (a running turn finishes on the old one). */
  setModel(choice: ModelChoice): boolean;
  /** The transcript so far (for a tab that just loaded). */
  log(): Log;
  /** Sends a message; while a turn is running it steers the current one. */
  prompt(text: string, context: string | null): void;
  abort(): void;
  reset(): Promise<void>;
  /** Takes back the agent's most recent change (one tool call), if any. */
  undo(): boolean;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** The tools, for an external agent. */
  tools(): ToolSpec[];
  /**
   * Runs one tool for an external agent, exactly as the embedded agent would:
   * same replica of the doc, same attribution, presence and undo history. The
   * call shows in the transcript, marked as external. Throws with a message
   * the caller can act on (unknown tool, bad arguments, the tool's own error).
   */
  runTool(name: string, args: unknown): Promise<ToolContent[]>;
}

export interface SessionOptions {
  /** Null when the embedded agent is off: no model, but the tools still work for an external agent. */
  cfg: AgentConfig | null;
  room: Room;
  /** The person this session works for. */
  owner: { id: string; name: string };
  docName: string;
  kind: "html" | "md";
  /** Whether the owner may edit (an agent acts with its user's permissions). */
  canEdit: () => boolean;
  /** Asks one of the owner's open tabs to render and capture the page. */
  view: (req: ViewRequest) => Promise<ViewResult>;
  readAsset: (path: string) => Promise<Uint8Array | null>;
  /** The document's title and address, as the owner (get_title, set_title); without it those tools are left out. */
  naming?: Naming;
}

const TOOL_ACTIVITY: Record<string, string> = { read: "reading", edit: "editing", write: "writing", ls: "looking around", find: "looking for files", grep: "searching", view_page: "looking at the page", get_title: "reading the title", set_title: "renaming the document" };

export async function startSession(opts: SessionOptions): Promise<AgentSession> {
  const { cfg, owner } = opts;
  const me: Author = { user: owner.id, name: agentName(owner.name), color: colorFor(owner.id, true), kind: "agent" };

  // The session's own replica of the shared doc, joined to the room as a peer.
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: me, busy: false, activity: null, cursor: null });
  joinLocal(opts.room, doc, awareness);
  await new Promise((r) => setTimeout(r, 0)); // the in-process sync is microtasks: done by now
  introduce(doc, me);

  const origin = { agent: owner.id }, undoOrigin = { agentUndo: owner.id };
  const undo = new Y.UndoManager(files(doc), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const ws = new YjsWorkspace(doc, me, opts.canEdit, origin);
  let choice: ModelChoice | null = cfg == null || cfg.model == "script" ? null : cfg.model;
  const model = cfg == null ? null : choice == null ? scriptModel() : describeModel(choice);

  const log = emptyLog();
  const listeners = new Set<(ev: LogEvent) => void>();
  // tool_execution_end carries no args; keep each call's path from its start event.
  const paths = new Map<string, string | null>();
  const emit = (ev: LogEvent) => {
    if (ev.t == "tool") {
      if (ev.status == "running") paths.set(ev.id, ev.path);
      else ev = { ...ev, path: paths.get(ev.id) ?? null };
    }
    reduce(log, ev);
    for (const l of listeners) l(ev);
  };
  const presence = (patch: Record<string, unknown>) => awareness.setLocalState({ ...awareness.getLocalState(), ...patch });
  // Busy while the embedded agent runs, or while an external agent is
  // calling tools: during a call, and for a while after the last one, since
  // it's thinking between calls and nothing says when it's done.
  const busy = { agent: false, ext: 0, extTimer: null as ReturnType<typeof setTimeout> | null };
  const syncBusy = (activity?: string | null) => {
    const on = busy.agent || busy.ext > 0 || busy.extTimer != null;
    presence({ busy: on, activity: on ? activity ?? (awareness.getLocalState()?.activity as string | null) ?? "working" : null });
  };
  const undoable = () => emit({ t: "undoable", count: undo.undoStack.length });

  const tools = makeTools(ws, {
    view: (req) => opts.view({ ...req, after: stateVector(doc) }),
    readAsset: opts.readAsset,
    naming: opts.naming,
    edited: (path, at) => {
      // One undo step per tool call, and the agent's cursor where it last wrote.
      undo.stopCapturing();
      undoable();
      const t = files(doc).get(path);
      if (t) presence({ cursor: { path, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)), head: null } });
    },
  });

  const agent = cfg && model ? new PiAgent({
    initialState: { systemPrompt: systemPrompt(opts.docName, opts.kind, owner.name), model, thinkingLevel: "medium", tools },
    getApiKey: () => Redacted.value(cfg.apiKey) || "none",
    onPayload: isScript(cfg) ? undefined : patchPayload(cfg, () => choice ?? DEFAULT_MODEL),
  }) : null;

  agent?.subscribe((e: AgentEvent) => {
    switch (e.type) {
      case "message_update": {
        const m = e.assistantMessageEvent;
        if (m.type == "text_delta") emit({ t: "text", delta: m.delta });
        else if (m.type == "thinking_delta") emit({ t: "thinking", delta: m.delta });
        break;
      }
      case "message_end": {
        const msg = e.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (msg.role == "assistant" && msg.stopReason == "error") emit({ t: "error", text: msg.errorMessage || "The request failed." });
        break;
      }
      case "tool_execution_start": {
        const path = toolPath(e.args);
        presence({ activity: `${TOOL_ACTIVITY[e.toolName] ?? e.toolName}${path ? ` ${path}` : ""}` });
        emit({ t: "tool", id: e.toolCallId, name: e.toolName, path, status: "running" });
        break;
      }
      case "tool_execution_end":
        presence({ activity: "thinking" });
        emit({
          t: "tool", id: e.toolCallId, name: e.toolName, path: null,
          status: e.isError ? "error" : "done",
          detail: e.isError ? resultText(e.result).slice(0, 400) : undefined,
          image: e.isError ? undefined : resultImage(e.result),
        });
        break;
      case "agent_start": busy.agent = true; syncBusy("thinking"); emit({ t: "busy", busy: true }); break;
      case "agent_end": busy.agent = false; syncBusy(); emit({ t: "busy", busy: false }); break;
    }
  });

  return {
    get model() { return agent?.state.model.name ?? null; },
    get modelChoice() { return choice; },
    setModel(next) {
      if (!agent || choice == null) return false;
      choice = next;
      agent.state.model = describeModel(next);
      return true;
    },
    log: () => log,
    prompt(text, context) {
      emit({ t: "user", text });
      if (!agent || !cfg) { emit({ t: "error", text: "The agent is off." }); return; }
      const content = context ? `<editor>\n${context}\n</editor>\n\n${text}` : text;
      if (isScript(cfg)) scriptModel();
      if (agent.state.isStreaming) { agent.steer({ role: "user", content, timestamp: Date.now() }); return; }
      agent.prompt(content).catch((err: unknown) => {
        emit({ t: "error", text: err instanceof Error ? err.message : String(err) });
        busy.agent = false;
        syncBusy();
        emit({ t: "busy", busy: false });
      });
    },
    abort: () => agent?.abort(),
    async reset() {
      if (agent) {
        agent.abort();
        await agent.waitForIdle();
        agent.reset();
      }
      paths.clear();
      undo.clear();
      busy.agent = false;
      syncBusy();
      presence({ cursor: null });
      emit({ t: "reset" });
      undoable();
    },
    undo() {
      if (!undo.undoStack.length) return false;
      // Stamped, so the undo is attributed to the agent even when it only deletes (src/room/doc.ts).
      doc.transact(() => { undo.undo(); stamp(doc, me); }, undoOrigin);
      undoable();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tools: () => tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) })),
    async runTool(name, args) {
      const tool = tools.find((t) => t.name == name);
      if (!tool) throw new Error(`There's no tool named "${name}". The tools are: ${tools.map((t) => t.name).join(", ")}.`);
      const id = `ext-${crypto.randomUUID()}`;
      const params = validateToolArguments(tool, { type: "toolCall", id, name, arguments: (args ?? {}) as Record<string, unknown> });
      const path = toolPath(params);
      busy.ext++;
      if (busy.extTimer) { clearTimeout(busy.extTimer); busy.extTimer = null; }
      syncBusy(`${TOOL_ACTIVITY[name] ?? name}${path ? ` ${path}` : ""}`);
      emit({ t: "tool", id, name, path, status: "running", via: "external" });
      try {
        const result = await tool.execute(id, params);
        emit({ t: "tool", id, name, path, status: "done", image: resultImage(result), via: "external" });
        return result.content as ToolContent[];
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ t: "tool", id, name, path, status: "error", detail: message.slice(0, 400), via: "external" });
        throw new Error(message);
      } finally {
        busy.ext--;
        if (busy.extTimer) clearTimeout(busy.extTimer);
        busy.extTimer = setTimeout(() => { busy.extTimer = null; syncBusy(); }, EXTERNAL_IDLE_MS);
        syncBusy("working");
      }
    },
  };
}

/** How long an external agent counts as working after its last tool call. */
const EXTERNAL_IDLE_MS = 8_000;

/**
 * The guide an external agent reads first (GET /api/ext): how to call the
 * tools, what they are, and the same working rules the embedded agent follows.
 */
export function externalGuide(o: { docName: string; kind: "html" | "md"; owner: string; base: string; tools: ToolSpec[] }): string {
  const tools = o.tools.map((t) => `### ${t.name}\n\n${t.description}\n\nArguments (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(t.parameters, null, 2)}\n\`\`\``).join("\n\n");
  return `# Editing "${o.docName}" in Erga

${o.owner} has ${o.docName} (${o.kind == "md" ? "Markdown" : "HTML"}) open in Erga's page editor and
has given you access to edit it as their agent, ${agentName(o.owner)}. The document
is a folder of files (the page, its styles, scripts, images, other pages); the
tools below see that folder, and you may read and change any text file in it.
Paths are relative to the folder.

## Calling the tools

Every request carries the token you were given:

    Authorization: Bearer <token>

Run a tool by POSTing its arguments as JSON:

    curl -s -X POST ${o.base}/api/ext/tools/read \\
      -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\
      -d '{"path": "${o.docName}"}'

The answer is JSON: \`{"ok": true, "content": [...]}\`, where each content item is
\`{"type": "text", "text": "..."}\` or \`{"type": "image", "mimeType": "image/png", "data": "<base64>"}\`.
A failure is \`{"ok": false, "error": "..."}\` with HTTP status 400 (bad call; the
error says what to fix), 401 (bad token) or 404 (no such tool).
\`GET ${o.base}/api/ext/tools\` lists the tools as JSON.

## How to work

- Your edits go straight into the shared document and show up in everyone's page
  as you make them, attributed to ${agentName(o.owner)}. ${o.owner} can undo them one tool
  call at a time. Prefer small, targeted edits (edit) over rewriting whole files.
- People may be typing while you work. edit matches oldText against the text as it
  is at that moment; if it fails because the text changed, read the file again and
  retry. Read a file right before editing it (with read, not grep: search output
  cuts long lines, so text copied from it won't match), and keep edits scoped to
  what was asked.
- view_page shows you the page as ${o.owner} sees it, rendered in their browser (so it
  needs their editor open): a screenshot plus any script errors. Use it to check
  visual work before you say it's done.
- get_title and set_title read and change the document's title (shown in the
  document list and the browser tab) and its address, /<owner>/<slug>. Until
  someone sets them, the title follows the page's first heading and the slug
  follows the title. Use set_title when asked to rename the document or change
  its address; old addresses keep redirecting, and the API address above never
  changes.
- Follow the rules below whenever you create or change a page, so people can keep
  editing it by hand.

## Tools

${tools}

${DOCUMENT_RULES.replace(/^(#+) /gm, "#$1 ")}
`;
}

function toolPath(args: unknown): string | null {
  const a = args as { path?: unknown } | null;
  return typeof a?.path == "string" ? a.path : null;
}

/** A tool result's image (view_page's screenshot), as a data URL for the panel. */
function resultImage(result: unknown): string | undefined {
  const r = result as { content?: { type: string; data?: string; mimeType?: string }[] } | null;
  const img = r?.content?.find((c) => c.type == "image" && c.data);
  return img ? `data:${img.mimeType ?? "image/png"};base64,${img.data}` : undefined;
}

function resultText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] } | null;
  return (r?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
}
