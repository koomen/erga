// The document agent's tools: the files' text (read, edit, write, find, grep), the live page, and diff_versions.
// What a person does with the document as a whole (its name, pages, folders, files' list and versions) is an
// operation (server/operations/editor.ts), which the agent has as a tool too.

import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
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
import { readableSize } from "../../shared/bytes";
import { unifiedDiff } from "../../document/versions";
import { WorkspaceError, globToRegExp, modelPath, type Workspace } from "./workspace";
import { isPdf, pageCount, pageRange, PAGES_PER_READ, PDF_READ_MAX, pdfPages } from "../../document/pdf";
import type { FilesAccess, OpenResult, VersionsAccess } from "../../document/agent";

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The biggest image read gives the model (its limit is 5 MB of base64). */
const IMAGE_READ_MAX = 3_750_000;
/** The most bytes a write of bytes takes in one call (base64 in the tool's arguments). */
const WRITE_BYTES_MAX = 25_000_000;

/** The tools that change the document: someone who may only view it (and their agent, and their token) has none of them. */
export const CHANGES = new Set(["edit", "write"]);


/** The agent's tools, over a workspace. */
export function makeTools(
  ws: Workspace,
  opts: {
    view: (req: ViewRequest) => Promise<ViewResult>;
    readAsset: (path: string) => Promise<Uint8Array | null>;
    edited: (path: string, at: number) => void;
    versions?: VersionsAccess;
    /** The version the document was at when this agent's last turn ended (diff_versions' "last_turn"); null before its first turn ends. */
    lastTurn?: () => Promise<string | null>;
    canEdit?: () => boolean;
    /** Who the agent's restores are by, now (its person, via it: shared/attribution.ts). */
    by?: () => string;
    /** Resolves once the agent's replica has everything the room has (after a restore, say). */
    caughtUp?: () => Promise<void>;
    /** Switches the person's open editor tabs to a page (open_page). */
    open?: (path: string) => Promise<OpenResult>;
    /** Every file's size, time and kind, PDFs' text, writes of bytes; without it, ls lists names, grep text files, and write takes text only. */
    files?: FilesAccess;
  }
): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  /** Runs a workspace operation; its failure becomes the tool's error, which the model reads. */
  const run = <T>(op: Effect.Effect<T, WorkspaceError>): T => Effect.runSync(Effect.mapError(op, (e) => new Error(e.message)));
  /** An edit based on text the file no longer has: which restores changed it since the agent saw it, and the current version. */
  const changedSince = async (message: string, path: string): Promise<string> => {
    const s = opts.versions && await opts.versions.state({ limit: 20 }).catch(() => null);
    if (!s) return message;
    const since = ws.seenAt(path) ?? 0;
    const restores = s.versions.filter((v) => Date.parse(v.at) >= since && (/^Restored version \d+$/.test(v.description ?? "") || v.description?.startsWith(`Restored ${path} from version `))).reverse();
    const what = restores.length ? ` It was restored since: ${restores.map((v) => `${v.id}, "${v.description}", by ${v.authors.join(", ") || "(unknown)"}`).join("; ")}.` : "";
    return message.replace(/ Read \S+ again and retry\.$/, "") + `${what} The current version is ${s.current.id}${s.pending ? " (with edits since, not yet a version)" : ""}. Read ${path} again and retry.`;
  };
  /** read, for a file kept whole: an image as a picture, a PDF (a range of its pages) as a document, anything else described. */
  const readFile = async (path: string, pages?: string) => {
    const bytes = await opts.readAsset(path);
    if (!bytes) throw new Error(`${path} doesn't exist`);
    if (IMAGE.test(path)) {
      if (bytes.length > IMAGE_READ_MAX)
        throw new Error(
          `${path} is ${readableSize(bytes.length)}: too big to see (an image can have up to ${readableSize(IMAGE_READ_MAX)}).`
        );
      return {
        content: [{ type: "image" as const, data: Base64.encode(bytes), mimeType: MIME[path.split(".").pop()!.toLowerCase()] }],
        details: {},
      };
    }
    if (isPdf(path)) {
      const counted = await Effect.runPromise(Effect.result(pageCount(bytes)));
      if (Result.isFailure(counted))
        throw new Error(`${path} isn't a PDF that can be read (${counted.failure.message}). Its size: ${readableSize(bytes.length)}.`);
      const total = counted.success;
      const range = pageRange(pages, total);
      if (typeof range == "string") throw new Error(range);
      const part = await Effect.runPromise(pdfPages(bytes, range.from, range.to));
      if (part.bytes.length > PDF_READ_MAX) throw new Error(`Pages ${range.from}-${range.to} of ${path} are ${readableSize(part.bytes.length)}: too big to see at once. Read fewer pages (pages: "${range.from}-${Math.max(range.from, range.from + Math.floor((range.to - range.from) / 2))}").`);
      const shown = range.from == 1 && range.to == total ? `${path}: ${total} page${total == 1 ? "" : "s"} (PDF, ${readableSize(bytes.length)}), all of them below.` : `${path}: pages ${range.from}-${range.to} of ${total} (PDF, ${readableSize(bytes.length)}) below.${range.to < total ? ` Read pages "${range.to + 1}-${Math.min(total, range.to + PAGES_PER_READ)}" for more.` : ""}`;
      // As an image's block with the PDF's type: the model's request makes it a document (agents/models.ts, patchPayload).
      return {
        content: [
          { type: "text" as const, text: shown },
          { type: "image" as const, data: Base64.encode(part.bytes), mimeType: "application/pdf" },
        ],
        details: {},
      };
    }
    const kind = (await opts.files?.stats().catch(() => null))?.get(path)?.type ?? "a file that isn't text";
    return text(`${path} is a file kept whole (${kind}, ${readableSize(bytes.length)}): it isn't text, a PDF or an image, so it can't be shown here. It can be moved, renamed, deleted, or replaced with write's content_base64.`);
  };
  /** write's bytes: a file kept whole (or text, if they are text), as the agent's person. */
  const writeBytes = async (raw: string, b64: string) => {
    const path = run(modelPath(raw));
    if (!(opts.canEdit?.() ?? true)) throw new Error("Your user can only view this document, so you can't change it.");
    if (!opts.files) throw new Error("This document takes only text: write the file's text in content.");
    const clean = b64.replace(/\s+/g, "");
    if ((clean.length * 3) / 4 > WRITE_BYTES_MAX) throw new Error(`That's more than ${WRITE_BYTES_MAX / 1e6} MB: too much for one call.`);
    const decoded = Base64.decode(clean);
    if (Result.isFailure(decoded)) throw new Error("content_base64 isn't base64.");
    const bytes = decoded.success;
    const r = await opts.files.writeBytes(path, bytes, opts.by?.() ?? "agent");
    await opts.caughtUp?.();
    return `${r.replaced ? "Replaced" : "Wrote"} ${path} (${readableSize(bytes.length)}, ${r.kind == "text" ? "as text" : "a file kept whole"}).`;
  };
  return [
    {
      name: "read",
      label: "Read",
      description: `Read a file: a text file's current text, an image (png, jpg, gif, webp) as a picture, or a PDF as a document you see (its text, tables, layout and scans), ${PAGES_PER_READ} pages at a time (pages: "21-40" for more). For another kind of file, its size and type. Text is cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for more.`,
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Path of the file, relative to the document's folder" }),
        offset: Schema.optionalKey(Schema.Finite.annotate({ description: "Line number to start reading from (1-indexed)" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "Maximum number of lines to read" })),
        pages: Schema.optionalKey(
          Schema.String.annotate({
            description: `A PDF's pages to read: one ("3") or a range ("21-40"), at most ${PAGES_PER_READ}. Default: the first ${PAGES_PER_READ}.`,
          })
        ),
      }),
      execute: async (_id, p: { path: string; offset?: number; limit?: number; pages?: string }) => {
        const path = run(modelPath(p.path));
        if (!ws.isText(path) && ws.paths().includes(path)) return readFile(path, p.pages);
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
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Path of the file to edit" }),
        edits: Schema.Array(
          Schema.Struct({
            oldText: Schema.String.annotate({ description: "Exact text to replace; must be unique in the file" }),
            newText: Schema.String.annotate({ description: "Replacement text" }),
          })
        ).annotate({ description: "One or more targeted replacements, each matched against the current file" }),
      }),
      execute: async (_id, p: { path: string; edits: { oldText: string; newText: string }[] }) => {
        const r = await Effect.runPromise(Effect.match(ws.edit(p.path, p.edits), { onFailure: (e) => e, onSuccess: (r) => r }));
        if (r instanceof WorkspaceError)
          throw new Error(r.reason == "changed" ? await changedSince(r.message, run(modelPath(p.path))) : r.message);
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "write",
      label: "Write",
      description: `Write a file's whole content, creating it if needed: text in content, or any file's bytes (a PDF, an image) in content_base64. For an existing text file only the differences are applied, but prefer edit for targeted changes. Bytes replace the file whole; the old one stays in the versions. At most ${WRITE_BYTES_MAX / 1e6} MB of bytes in one call.`,
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Path of the file to write" }),
        content: Schema.optionalKey(Schema.String.annotate({ description: "The file's new content, as text" })),
        content_base64: Schema.optionalKey(
          Schema.String.annotate({ description: "Or the file's bytes, base64: for a file that isn't text" })
        ),
      }),
      execute: async (_id, p: { path: string; content?: string; content_base64?: string }) => {
        if ((p.content == null) == (p.content_base64 == null)) throw new Error("Give the file's content as text (content) or as bytes (content_base64): one of them.");
        if (p.content_base64 != null) return text(await writeBytes(p.path, p.content_base64));
        const r = await Effect.runPromise(Effect.mapError(ws.write(p.path, p.content!), (e) => new Error(e.message)));
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "find",
      label: "Find files",
      description: "Find files anywhere in the document by glob pattern, e.g. \"**/*.css\", \"*.html\" (top level) or \"posts/**/*.html\".",
      parameters: Schema.Struct({ pattern: Schema.String.annotate({ description: "Glob pattern" }) }),
      execute: async (_id, p: { pattern: string }) => {
        const re = globToRegExp(p.pattern);
        const found = ws.paths().filter((f) => re.test(f));
        return text(found.length ? found.slice(0, 500).join("\n") : "No files match.");
      },
    },
    {
      name: "grep",
      label: "Search",
      description: "Search every text file in the document (all pages and assets) for a regular expression (or literal text), and every PDF through its text. Returns path:line: text for a text file and path:page: text for a PDF, long lines cut.",
      parameters: Schema.Struct({
        pattern: Schema.String.annotate({ description: "Regular expression, or literal text with literal: true" }),
        glob: Schema.optionalKey(Schema.String.annotate({ description: "Only files matching this glob" })),
        ignoreCase: Schema.optionalKey(Schema.Boolean),
        literal: Schema.optionalKey(Schema.Boolean),
      }),
      execute: async (_id, p: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean }) => {
        let re: RegExp;
        try { re = new RegExp(p.literal ? p.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p.pattern, p.ignoreCase ? "i" : ""); } catch (e) { throw new Error(`bad pattern: ${(e as Error).message}`); }
        const only = p.glob ? globToRegExp(p.glob) : null;
        const out: string[] = [];
        const cut = (line: string) => (line.length > 300 ? line.slice(0, 300) + "…" : line);
        let unread = 0;
        for (const f of ws.paths()) {
          if (out.length >= 100) break;
          if (only && !only.test(f)) continue;
          if (ws.isText(f)) { run(ws.read(f)).split("\n").forEach((line, i) => { if (out.length < 100 && re.test(line)) out.push(`${f}:${i + 1}: ${cut(line)}`); }); continue; }
          // A PDF through its text (extracted once, kept by the PDF's hash): page by page.
          if (!isPdf(f) || !opts.files) continue;
          const pages = await opts.files.pdfText(f).catch(() => null);
          if (!pages) { unread++; continue; }
          pages.forEach((page, i) => { for (const line of page.split("\n")) if (out.length < 100 && re.test(line)) out.push(`${f}:${i + 1}: ${cut(line.trim())}`); });
        }
        if (unread) out.push(`[${unread} PDF${unread == 1 ? "" : "s"} couldn't be searched: no text could be read from ${unread == 1 ? "it" : "them"} here (read shows a PDF as it is).]`);
        return text(out.length ? out.join("\n") + (out.length == 100 ? "\n[First 100 matches.]" : "") : "No matches.");
      },
    },
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
        const v = await opts.view({ selector: p.selector, fullPage: p.full_page, width: p.width, height: p.height, colorScheme: p.color_scheme });
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
        const v = await opts.view({ evaluate: p.expression, width: p.width, height: p.height, colorScheme: p.color_scheme, timeout: p.timeout });
        const errors = v.errors.length ? `\nThe page threw ${v.errors.length} error(s):\n${v.errors.slice(0, 10).join("\n")}` : "";
        if (v.error || v.value == null) throw new Error((v.error ?? "The page couldn't be inspected.") + errors);
        return text(`${v.value}${v.note ? `\n\n[${v.note}]` : ""}${errors}`);
      },
    },
    ...liveTools(opts.view),
    ...(opts.open ? [openPage(opts.open)] : []),
    ...(opts.versions ? [diffVersions(opts.versions, opts.lastTurn ?? (async () => null))] : []),
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

/**
 * diff_versions: what changed between two versions, or since the agent's last turn (which only it knows). Listing,
 * reading and restoring versions are operations (server/operations/editor.ts), as a person does them.
 */
function diffVersions(versions: VersionsAccess, lastTurn: () => Promise<string | null>): AgentTool {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return {
      name: "diff_versions",
      label: "Diff versions",
      description: `See what changed in the document between two versions, as a unified diff for each file (files added, deleted and changed; binary files only say they changed). from: a version's id ("v3"), or "last_turn", the document as it was when your last turn ended (the default), to see what others changed since (and what you changed in this turn). to: a version's id, or "current", the document as it is now, up to the keystroke (the default). path: only that file, or the files in that folder. Cut at about ${MAX_BYTES / 1024}KB: pass path for more. Use it instead of reading whole files to compare them.`,
      parameters: Schema.Struct({
        from: Schema.optionalKey(
          Schema.String.annotate({ description: 'A version\'s id ("v3") or number, "last_turn" (the default) or "current"' })
        ),
        to: Schema.optionalKey(
          Schema.String.annotate({ description: 'A version\'s id ("v3") or number, "last_turn" or "current" (the default)' })
        ),
        path: Schema.optionalKey(
          Schema.String.annotate({ description: "Only this file, or the files in this folder, relative to the document's folder" })
        ),
        context: Schema.optionalKey(Schema.Finite.annotate({ description: "Lines of context around each change (default 3)" })),
      }),
      execute: async (_id, p: { from?: string; to?: string; path?: string; context?: number }) => {
        /** A side of the diff: its name, as the answer says it, and its files. */
        const side = async (ref: string) => {
          const r = ref.trim().toLowerCase().replace(/[\s-]+/g, "_");
          if (r == "current" || r == "now") return { name: "current (the document as it is now)", files: await versions.current() };
          let id: string = ref;
          if (r == "last_turn") {
            const last = await lastTurn();
            if (!last) throw new Error(`You have no last turn in this document yet (or it's been reopened since), so there's nothing to diff from: pass from with a version's id. ${(await versions.state({ limit: 1 })).current.id} is the latest version.`);
            id = last;
          }
          const files = await versions.files(id);
          if (!files) throw new Error(`There's no version "${ref}": list_versions shows them.`);
          const v = (await versions.version(id))!;
          return { name: r == "last_turn" ? `${v.id} (where your last turn ended)` : v.id, files };
        };
        const from = await side(p.from ?? "last_turn"), to = await side(p.to ?? "current");
        const d = unifiedDiff(from.files, to.files, { path: p.path, context: p.context == null ? undefined : Math.max(0, Math.min(50, Math.floor(p.context))) });
        const what = p.path ? ` in ${p.path.replace(/^\.?\//, "")}` : "";
        if (!d.files.length) return text(`No changes${what} from ${from.name} to ${to.name}.`);
        return text(`From ${from.name} to ${to.name}${what}: ${d.files.length} file(s) differ.\n\n${d.diff}`);
      },
  } as AgentTool;
}

/** open_page: moves the person's open editor to another page of the document (the pages themselves: list_pages, an operation). */
function openPage(open: (path: string) => Promise<OpenResult>): AgentTool {
  return {
    name: "open_page",
    label: "Open a page",
    description:
      'Switch the user\'s open editor to another page of this document, by its file ("blog/post.html") or its address under the document ("blog/post", "" for the home page). Every editor tab the user has open on this document goes there. With none open, nothing happens, and the answer says so and gives the page\'s address. Use it when the user asks to go to a page, or to show them a page you made (new_page, then open_page).',
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description: 'The page\'s file, e.g. "about.html", or its address under the document, e.g. "blog"',
      }),
    }),
    execute: async (_id: string, p: { path: string }) => ({
      content: [{ type: "text" as const, text: (await open(p.path)).message }],
      details: {},
    }),
  } as AgentTool;
}

/**
 * The document tools' names, descriptions and arguments (JSON Schema), with
 * no document behind them: for the server's API, which offers
 * them for any document by adding a `document` argument and runs them in that
 * document's host.
 */
export function documentToolSpecs(): { name: string; description: string; parameters: Schema.Struct<Schema.Struct.Fields> }[] {
  const none = () => { throw new Error("no document"); };
  const versions = { state: none, version: none, files: none, current: none } as unknown as VersionsAccess;
  return makeTools(null as unknown as Workspace, {
    view: none,
    readAsset: none,
    edited: none,
    versions,
    open: none,
  }).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Schema.Struct<Schema.Struct.Fields> }));
}


export function toolPath(args: unknown): string | null {
  const a = args as { path?: unknown; from?: unknown } | null;
  return typeof a?.path == "string" ? a.path : typeof a?.from == "string" ? a.from : null;
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
