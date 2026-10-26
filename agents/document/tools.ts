// The document agent's tools: the files (read, edit, write and the rest), the live page, versions, the viewers'
// agent, the document's tree, its pages and its name.

import * as Effect from "effect/Effect";
import { type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
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
import { pageAddress, type TreeEntry, type TreeOp } from "../../document/pages";
import type { Naming } from "../../server/directory/index.ts";
import { unifiedDiff, type RestoreResult, type Version, type VersionsState } from "../../document/versions";
import { WorkspaceError, cleanPath, globToRegExp, type Workspace } from "./workspace";
import { isPdf, pageCount, pageRange, PAGES_PER_READ, PDF_READ_MAX, pdfPages } from "../../document/pdf";
import { fromBase64 } from "../../shared/bytes";

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The biggest image read gives the model (its limit is 5 MB of base64). */
const IMAGE_READ_MAX = 3_750_000;
/** The most bytes a write of bytes takes in one call (base64 in the tool's arguments). */
const WRITE_BYTES_MAX = 25_000_000;

/** The tools that change the document: someone who may only view it (and their agent, and their token) has none of them. */
export const CHANGES = new Set([
  "edit",
  "write",
  "mv",
  "rm",
  "mkdir",
  "new_page",
  "make_project",
  "make_document",
  "set_title",
  "restore_version",
]);

/** What the file tools reach beyond the shared text: every file's size, time and kind, a file's bytes, a PDF's text, and a write of bytes. */
export interface FilesAccess {
  /** Each file's size (bytes), time (ms, when known) and kind: text, or a file kept whole (a blob), with its type. */
  stats(): Promise<Map<string, { size: number | null; at: number | null; kind: "text" | "file"; type: string }>>;
  /** A PDF's text, page by page, extracted once and kept by the PDF's hash; null if it can't be had. */
  pdfText(path: string): Promise<string[] | null>;
  /** Writes a file's bytes as `by` (the agent's person, via it): text if it is text, else a file kept whole. Refused past the limits. */
  writeBytes(path: string, bytes: Uint8Array, by: string): Promise<{ kind: "text" | "file"; replaced: boolean }>;
}

const readableSize = (n: number | null) => n == null ? "?" : n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(1)} GB`;
const stamp16 = (at: number | null) => at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : "";

/** The agent's tools, over a workspace. */
export function makeTools(
  ws: Workspace,
  opts: {
    view: (req: ViewRequest) => Promise<ViewResult>;
    readAsset: (path: string) => Promise<Uint8Array | null>;
    edited: (path: string, at: number) => void;
    naming?: Naming;
    versions?: VersionsAccess;
    /** The version the document was at when this agent's last turn ended (diff_versions' "last_turn"); null before its first turn ends. */
    lastTurn?: () => Promise<string | null>;
    canEdit?: () => boolean;
    /** Who the agent's restores are by, now (its person, via it: shared/attribution.ts). */
    by?: () => string;
    /** Resolves once the agent's replica has everything the room has (after a restore, say). */
    caughtUp?: () => Promise<void>;
    /** The document's file tree: new pages and folders, moves, deletes; resolves once the agent's replica has the result. */
    tree?: (op: TreeOp) => Promise<void>;
    /** The document's pages, with titles, and its address (list_pages). */
    pages?: () => Promise<PageTree>;
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
      if (bytes.length > IMAGE_READ_MAX) throw new Error(`${path} is ${readableSize(bytes.length)}: too big to see (an image can have up to ${readableSize(IMAGE_READ_MAX)}).`);
      return { content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: MIME[path.split(".").pop()!.toLowerCase()] }], details: {} };
    }
    if (isPdf(path)) {
      let total: number;
      try { total = await pageCount(bytes); } catch (e) { throw new Error(`${path} isn't a PDF that can be read (${(e as Error).message}). Its size: ${readableSize(bytes.length)}.`); }
      const range = pageRange(pages, total);
      if (typeof range == "string") throw new Error(range);
      const part = await pdfPages(bytes, range.from, range.to);
      if (part.bytes.length > PDF_READ_MAX) throw new Error(`Pages ${range.from}-${range.to} of ${path} are ${readableSize(part.bytes.length)}: too big to see at once. Read fewer pages (pages: "${range.from}-${Math.max(range.from, range.from + Math.floor((range.to - range.from) / 2))}").`);
      const shown = range.from == 1 && range.to == total ? `${path}: ${total} page${total == 1 ? "" : "s"} (PDF, ${readableSize(bytes.length)}), all of them below.` : `${path}: pages ${range.from}-${range.to} of ${total} (PDF, ${readableSize(bytes.length)}) below.${range.to < total ? ` Read pages "${range.to + 1}-${Math.min(total, range.to + PAGES_PER_READ)}" for more.` : ""}`;
      // As an image's block with the PDF's type: the model's request makes it a document (agents/models.ts, patchPayload).
      return { content: [{ type: "text" as const, text: shown }, { type: "image" as const, data: Buffer.from(part.bytes).toString("base64"), mimeType: "application/pdf" }], details: {} };
    }
    const kind = (await opts.files?.stats().catch(() => null))?.get(path)?.type ?? "a file that isn't text";
    return text(`${path} is a file kept whole (${kind}, ${readableSize(bytes.length)}): it isn't text, a PDF or an image, so it can't be shown here. It can be moved, renamed, deleted, or replaced with write's content_base64.`);
  };
  /** write's bytes: a file kept whole (or text, if they are text), as the agent's person. */
  const writeBytes = async (raw: string, b64: string) => {
    const path = run(cleanPath(raw));
    if (!(opts.canEdit?.() ?? true)) throw new Error("Your user can only view this document, so you can't change it.");
    if (!opts.files) throw new Error("This document takes only text: write the file's text in content.");
    const clean = b64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 == 1) throw new Error("content_base64 isn't base64.");
    if ((clean.length * 3) / 4 > WRITE_BYTES_MAX) throw new Error(`That's more than ${WRITE_BYTES_MAX / 1e6} MB: too much for one call.`);
    const bytes = fromBase64(clean);
    const r = await opts.files.writeBytes(path, bytes, opts.by?.() ?? "agent");
    await opts.caughtUp?.();
    return `${r.replaced ? "Replaced" : "Wrote"} ${path} (${readableSize(bytes.length)}, ${r.kind == "text" ? "as text" : "a file kept whole"}).`;
  };
  return [
    {
      name: "read",
      label: "Read",
      description: `Read a file: a text file's current text, an image (png, jpg, gif, webp) as a picture, or a PDF as a document you see (its text, tables, layout and scans), ${PAGES_PER_READ} pages at a time (pages: "21-40" for more). For another kind of file, its size and type. Text is cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for more.`,
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file, relative to the document's folder" }),
        offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
        pages: Type.Optional(Type.String({ description: `A PDF's pages to read: one ("3") or a range ("21-40"), at most ${PAGES_PER_READ}. Default: the first ${PAGES_PER_READ}.` })),
      }),
      execute: async (_id, p: { path: string; offset?: number; limit?: number; pages?: string }) => {
        const path = run(cleanPath(p.path));
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
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file to edit" }),
        edits: Type.Array(Type.Object({
          oldText: Type.String({ description: "Exact text to replace; must be unique in the file" }),
          newText: Type.String({ description: "Replacement text" }),
        }), { description: "One or more targeted replacements, each matched against the current file" }),
      }),
      execute: async (_id, p: { path: string; edits: { oldText: string; newText: string }[] }) => {
        const r = await Effect.runPromise(Effect.match(ws.edit(p.path, p.edits), { onFailure: (e) => e, onSuccess: (r) => r }));
        if (r instanceof WorkspaceError) throw new Error(r.reason == "changed" ? await changedSince(r.message, run(cleanPath(p.path))) : r.message);
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "write",
      label: "Write",
      description: `Write a file's whole content, creating it if needed: text in content, or any file's bytes (a PDF, an image) in content_base64. For an existing text file only the differences are applied, but prefer edit for targeted changes. Bytes replace the file whole; the old one stays in the versions. At most ${WRITE_BYTES_MAX / 1e6} MB of bytes in one call.`,
      parameters: Type.Object({
        path: Type.String({ description: "Path of the file to write" }),
        content: Type.Optional(Type.String({ description: "The file's new content, as text" })),
        content_base64: Type.Optional(Type.String({ description: "Or the file's bytes, base64: for a file that isn't text" })),
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
      name: "ls",
      label: "List",
      description: "List the files and folders directly inside a folder of the document (default: its root, which holds every page's files and the shared assets): each file's kind (text, or a file kept whole, with its type), size and time (UTC). Folders end in /.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Folder to list" })) }),
      execute: async (_id, p: { path?: string }) => {
        const dir = p.path && p.path.replace(/^[./]+$/, "") ? run(cleanPath(p.path!)) + "/" : "";
        const entries = new Set<string>();
        for (const f of [...ws.paths(), ...ws.folders().map((d) => d + "/")]) if (f.startsWith(dir) && f != dir) { const rest = f.slice(dir.length); entries.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : rest); }
        if (!entries.size) {
          if (dir && ws.folders().includes(dir.slice(0, -1))) return text(`${dir} is an empty folder.`);
          throw new Error(`${p.path} is empty or doesn't exist`);
        }
        const names = [...entries].sort();
        const stats = await opts.files?.stats().catch(() => null);
        if (!stats) return text(names.join("\n"));
        const rows = names.map((name) => {
          if (name.endsWith("/")) return ["dir", "", "", name];
          const s = stats.get(dir + name);
          return [s?.kind == "file" ? "file" : "text", readableSize(s?.size ?? null), stamp16(s?.at ?? null), s?.kind == "file" ? `${name}  (${s.type})` : name];
        });
        const width = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
        const files = names.filter((n) => !n.endsWith("/")).length;
        return text(rows.map((r) => r.map((c, i) => (i < 3 ? c.padEnd(width[i]) : c)).join("  ")).join("\n") + (rows.length > 20 ? `\n${files} file${files == 1 ? "" : "s"}, ${rows.length - files} folder${rows.length - files == 1 ? "" : "s"}` : ""));
      },
    },
    {
      name: "find",
      label: "Find files",
      description: "Find files anywhere in the document by glob pattern, e.g. \"**/*.css\", \"*.html\" (top level) or \"posts/**/*.html\".",
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
      description: "Search every text file in the document (all pages and assets) for a regular expression (or literal text), and every PDF through its text. Returns path:line: text for a text file and path:page: text for a PDF, long lines cut.",
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
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ description: "CSS selector of an element to capture, e.g. \"#chart\" or \"figure:nth-of-type(2)\"." })),
        full_page: Type.Optional(Type.Boolean({ description: "Capture the whole page rather than the first screenful." })),
        width: Type.Optional(Type.Number({ description: "Width to render at, in CSS pixels (default: as wide as the user's page)." })),
        height: Type.Optional(Type.Number({ description: "Height of the screenful, in CSS pixels (default: as tall as the user's page)." })),
        color_scheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Light or dark mode, for the page's prefers-color-scheme (default: the user's)." })),
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
      parameters: Type.Object({
        expression: Type.String({ description: "JavaScript to run in the page, e.g. getComputedStyle(document.body).fontSize" }),
        width: Type.Optional(Type.Number({ description: "Width to render at, in CSS pixels (default: as wide as the user's page)." })),
        height: Type.Optional(Type.Number({ description: "Height of the screenful, in CSS pixels (default: as tall as the user's page)." })),
        color_scheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Light or dark mode, for the page's prefers-color-scheme (default: the user's)." })),
        timeout: Type.Optional(Type.Number({ description: `How long to wait for the result, in ms (default ${EVAL_TIMEOUT.default}, at most ${EVAL_TIMEOUT.max}).` })),
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
    ...(opts.pages ? pageTools(opts.pages, opts.open) : []),
    ...(opts.tree ? treeTools(opts.tree, opts.open) : []),
    ...(opts.naming ? namingTools(opts.naming) : []),
    ...(opts.versions ? versionTools(opts.versions, opts.canEdit ?? (() => true), opts.by ?? (() => "agent"), opts.lastTurn ?? (async () => null), ws, opts.caughtUp ?? (async () => {})) : []),
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
  const LIVE = "the live page: the page as it runs now in the user's open editor tab (their focused tab, else a visible one), not view_page's fresh render";
  const SINCE = Type.Optional(Type.String({ description: "Only what happened since then: an ISO time, or how long ago (\"30s\", \"5m\", \"2h\")." }));
  const FRAME = Type.Optional(Type.String({ description: "Which frame: \"page\" (the default), a CSS selector of an iframe inside the page, or a frame's name as page_inspect lists them." }));
  return [
    {
      name: "page_console",
      label: "Read the page's console",
      description: `Read the console of ${LIVE}: errors, warnings and logs from the editor's own windows and from the page's frames (the frames inside it too, on its origin), uncaught errors, unhandled rejections, and audio, video, image or script files that failed to load. Identical messages collapse into one line with a count and the first and last time, so a warning repeated 50,000 times is one line. Filter by level, pattern and since.`,
      parameters: Type.Object({
        level: Type.Optional(Type.Array(Type.Union(CONSOLE_LEVELS.map((l) => Type.Literal(l))), { description: "Only these levels, e.g. [\"error\", \"warn\"] (default: all)." })),
        pattern: Type.Optional(Type.String({ description: "Only messages matching this regular expression (case-insensitive) or text." })),
        since: SINCE,
        limit: Type.Optional(Type.Number({ description: "How many distinct messages, the most recent (default 50, at most 200)." })),
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
      parameters: Type.Object({
        pattern: Type.Optional(Type.String({ description: "Only requests whose URL, content type or error matches this regular expression or text, e.g. \"\\.m4a\" or \"audio/\"." })),
        since: SINCE,
        failed: Type.Optional(Type.Boolean({ description: "Only requests that failed (an error, or status 400 or more)." })),
        limit: Type.Optional(Type.Number({ description: "How many, the most recent (default 50, at most 300)." })),
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
      parameters: Type.Object({ since: SINCE, limit: Type.Optional(Type.Number({ description: "How many, the most recent (default 40, at most 200)." })) }),
      execute: async (_id, p: { since?: string; limit?: number }) => {
        const r = await ask({ kind: "events", since: since(p.since), limit: p.limit });
        return text(`${describeEvents(r.events!)}\n${describeTab(r.tab)}`);
      },
    },
    {
      name: "page_inspect",
      label: "Inspect the live page",
      description: `Inspect ${LIVE}. Without an expression: the fixed facts of each frame (the editor's, the page's, and those inside it): its sandbox and allow attributes, its user activation (isActive, hasBeenActive), the autoplay policy (permissions policy, getAutoplayPolicy), and each audio and video element's readyState, networkState, paused, currentTime, duration, error, src and type. With an expression: runs that JavaScript in the page's frame (never in the editor's own origin) and gives its result as JSON; it may be async; statements need their own return. Read-only: it must not change the page (it is the person's live page, not a copy). Use it only when the user asks you to look into their page in this conversation; the tab shows them a line each time.`,
      parameters: Type.Object({
        expression: Type.Optional(Type.String({ description: "JavaScript to run in the live page, e.g. document.querySelector(\"audio\").buffered.length" })),
        frame: FRAME,
        timeout: Type.Optional(Type.Number({ description: `How long to wait for the result, in ms (default ${EVAL_TIMEOUT.default}, at most ${EVAL_TIMEOUT.max}).` })),
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
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ description: "CSS selector of the element to click, e.g. \"#play\"." })),
        x: Type.Optional(Type.Number({ description: "Or the point to click: x in the page's window, in CSS pixels." })),
        y: Type.Optional(Type.Number({ description: "And y." })),
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
      parameters: Type.Object({
        key: Type.String({ description: "The key, e.g. \"Enter\", \" \", \"ArrowRight\", \"k\"." }),
        selector: Type.Optional(Type.String({ description: "CSS selector of the element to send it to (default: the focused element)." })),
        shift: Type.Optional(Type.Boolean()), alt: Type.Optional(Type.Boolean()), ctrl: Type.Optional(Type.Boolean()), meta: Type.Optional(Type.Boolean()),
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

/** The document's versions, as the agents' tools reach them. */
export interface VersionsAccess {
  state(opts: { before?: string | number | null; limit?: number }): Promise<VersionsState>;
  version(ref: string | number): Promise<(Version & { files: string[]; index: string }) | null>;
  file(ref: string | number, path: string): Promise<Uint8Array | null>;
  /** Every file of a version (null if there's no such version). */
  files(ref: string | number): Promise<Map<string, Uint8Array> | null>;
  /** Every file as it is now, up to the keystroke. */
  current(): Promise<Map<string, Uint8Array>>;
  /** Brings a version back (or, with `path`, one file of it) as a new current version, by `by` (a login). */
  restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult>;
}

/** list_versions, read_version, diff_versions and restore_version: what the person can do with versions, their agent can (and diff them). */
function versionTools(versions: VersionsAccess, canEdit: () => boolean, by: () => string, lastTurn: () => Promise<string | null>, ws: Workspace, caughtUp: () => Promise<void>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  const line = (v: Version) => `${v.id}  ${v.at}  ${v.authors.join(", ") || "(unknown)"}  ${v.description ?? "(description coming)"}`;
  return [
    {
      name: "list_versions",
      label: "List versions",
      description: "List the document's versions, newest first: each one's id (v1, v2...), when it was cut, who edited, and a short description. A version is a snapshot of every file, cut after a burst of edits (when edits pause, when an agent's turn ends, when the last editor leaves). Viewers always see the document as it is now.",
      parameters: Type.Object({
        before: Type.Optional(Type.String({ description: "Only versions older than this one (its id, e.g. \"v12\"), to page back" })),
        limit: Type.Optional(Type.Number({ description: "How many (default 10, at most 100)" })),
      }),
      execute: async (_id, p: { before?: string; limit?: number }) => {
        const s = await versions.state({ before: p.before ?? null, limit: p.limit });
        const more = s.versions.length && s.versions[s.versions.length - 1].n > 1 ? `\n[Older versions: before=${s.versions[s.versions.length - 1].id}]` : "";
        return text(`Current: ${s.current.id}${s.pending ? " (with edits since, not yet a version)" : ""}; ${s.total} version(s).\n\n${s.versions.map(line).join("\n")}${more}`);
      },
    },
    {
      name: "read_version",
      label: "Read a version",
      description: `Read an old version of the document. Without path: its files and details. With path: that file's text as it was in that version (cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit), or the picture for an image. To bring an old version, or one file of it, back, use restore_version.`,
      parameters: Type.Object({
        version: Type.String({ description: "The version's id (\"v3\") or number" }),
        path: Type.Optional(Type.String({ description: "A file in it, relative to the document's folder" })),
        offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      }),
      execute: async (_id, p: { version: string; path?: string; offset?: number; limit?: number }) => {
        const v = await versions.version(p.version);
        if (!v) throw new Error(`There's no version "${p.version}": list_versions shows them.`);
        if (!p.path) return text(`${line(v)}\nPage: ${v.index}\nFiles:\n${v.files.join("\n")}`);
        const path = p.path.replace(/^\.?\//, "");
        const bytes = await versions.file(v.id, path);
        if (!bytes) throw new Error(`${v.id} has no file ${path}. Its files: ${v.files.slice(0, 50).join(", ")}`);
        if (IMAGE.test(path)) return { content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: MIME[path.split(".").pop()!.toLowerCase()] }], details: {} };
        let body: string;
        try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return text(`${path} in ${v.id} is a binary file of ${bytes.length} bytes.`); }
        const lines = body.split("\n");
        const start = Math.max(0, (p.offset ?? 1) - 1);
        let end = Math.min(lines.length, start + (p.limit ?? MAX_LINES));
        let out = lines.slice(start, end).join("\n");
        while (out.length > MAX_BYTES && end > start + 1) { end = start + Math.max(1, Math.floor((end - start) / 2)); out = lines.slice(start, end).join("\n"); }
        if (end < lines.length) out += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
        return text(out);
      },
    },
    {
      name: "diff_versions",
      label: "Diff versions",
      description: `See what changed in the document between two versions, as a unified diff for each file (files added, deleted and changed; binary files only say they changed). from: a version's id ("v3"), or "last_turn", the document as it was when your last turn ended (the default), to see what others changed since (and what you changed in this turn). to: a version's id, or "current", the document as it is now, up to the keystroke (the default). path: only that file, or the files in that folder. Cut at about ${MAX_BYTES / 1024}KB: pass path for more. Use it instead of reading whole files to compare them.`,
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: "A version's id (\"v3\") or number, \"last_turn\" (the default) or \"current\"" })),
        to: Type.Optional(Type.String({ description: "A version's id (\"v3\") or number, \"last_turn\" or \"current\" (the default)" })),
        path: Type.Optional(Type.String({ description: "Only this file, or the files in this folder, relative to the document's folder" })),
        context: Type.Optional(Type.Number({ description: "Lines of context around each change (default 3)" })),
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
    },
    {
      name: "restore_version",
      label: "Restore a version",
      description: `Bring an old version back: its files are written over the document as it is now (files it didn't have are deleted), which everyone editing sees at once, and that becomes a new version, the current one. With path, only that file comes back, and the other files stay as they are: prefer this when only one file needs it, as others may be editing other pages. Nothing is lost: edits not yet in a version become one first, and every version stays. What's published in "manual" mode stays as it is. Answers the new current version's id and the restored text (up to ${MAX_BYTES / 1024}KB in all), so you can edit against it at once. Only someone who may edit the document may; only do it when asked.`,
      parameters: Type.Object({
        version: Type.String({ description: "The version's id (\"v3\") or number" }),
        path: Type.Optional(Type.String({ description: "Only this file, relative to the document's folder (it must be in that version)" })),
      }),
      execute: async (_id, p: { version: string; path?: string }) => {
        if (!canEdit()) throw new Error("You may only view this document, so you can't restore a version.");
        const r = await versions.restore(p.version, by(), p.path ? Effect.runSync(Effect.mapError(cleanPath(p.path), (e) => new Error(e.message))) : null);
        if (!r.ok) throw new Error(r.error);
        // The agent edits its own replica: it has the restored text once it has caught up with the room.
        await caughtUp();
        const head = `Restored ${p.path ? `${r.files[0]} from ${r.from}` : `${r.from} (${r.files.length} file${r.files.length == 1 ? "" : "s"})`}. The current version is now ${r.current.id} ("${r.current.description}").`;
        // Each restored text file as it is now, until the budget runs out; the agent's edits are based on what it's shown.
        let budget = MAX_BYTES;
        const shown: string[] = [], rest: string[] = [];
        for (const path of r.files) {
          if (!ws.isText(path)) { rest.push(`${path} (not text)`); continue; }
          if (budget <= 0) { rest.push(path); continue; }
          let body = Effect.runSync(Effect.orElseSucceed(ws.read(path), () => ""));
          if (body.length > budget) {
            const lines = body.split("\n");
            let end = lines.length;
            while (end > 1 && lines.slice(0, end).join("\n").length > budget) end = Math.max(1, Math.floor(end / 2));
            body = `${lines.slice(0, end).join("\n")}\n[Showing lines 1-${end} of ${lines.length}: read ${path} for the rest.]`;
          }
          budget -= body.length;
          shown.push(`=== ${path} ===\n${body}`);
        }
        const tail = rest.length ? `\n\n[Not shown: ${rest.join(", ")}. Read them before you edit them.]` : "";
        return text(`${head}${shown.length ? ` Its text now, to edit against:\n\n${shown.join("\n\n")}` : ""}${tail}`);
      },
    },
  ] as AgentTool[];
}

/**
 * new_page, mkdir, mv and rm: the document's file tree, with the same powers
 * a person has in the editor's file tree (document/host.ts, runTreeOp, checks each).
 */
function treeTools(tree: (op: TreeOp) => Promise<void>, open?: (path: string) => Promise<OpenResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return [
    {
      name: "new_page",
      label: "New page",
      description: `Make a new page from the new-page template, at a path like "blog/post.html" (folders it's in are made too; without an extension it's .html). Each page has its own address: blog/post.html is /<owner>/<slug>/blog/post, blog/index.html is /<owner>/<slug>/blog. Then edit it like any file. (write also makes a page, from your own text.)${open ? " open: true also switches the user's editor to it (as open_page)." : ""}`,
      parameters: Type.Object({
        path: Type.String({ description: "Path of the new page, e.g. \"about.html\" or \"blog/index.html\"" }),
        ...(open ? { open: Type.Optional(Type.Boolean({ description: "Also open it in the user's editor" })) } : {}),
      }),
      execute: async (_id, p: { path: string; open?: boolean }) => {
        await tree({ op: "new_page", path: p.path });
        const file = /\.html$/i.test(p.path) ? p.path : `${p.path}.html`;
        const made = `Made ${file} from the template.`;
        if (!p.open || !open) return text(made);
        return text(`${made} ${(await open(file)).message}`);
      },
    },
    {
      name: "mkdir",
      label: "New folder",
      description: "Make a folder (and any it's in). Empty folders stay until deleted.",
      parameters: Type.Object({ path: Type.String({ description: "Path of the folder, e.g. \"blog/drafts\"" }) }),
      execute: async (_id, p: { path: string }) => { await tree({ op: "new_folder", path: p.path }); return text(`Made the folder ${p.path}.`); },
    },
    {
      name: "mv",
      label: "Move",
      description: "Move or rename a file or a folder (with everything in it). Nothing may be at the destination already. The document's own page (index.html at its root) can't be moved. Moving a page changes its address: fix links to it in other pages.",
      parameters: Type.Object({
        from: Type.String({ description: "Path of the file or folder now" }),
        to: Type.String({ description: "Its new path" }),
      }),
      execute: async (_id, p: { from: string; to: string }) => { await tree({ op: "move", from: p.from, to: p.to }); return text(`Moved ${p.from} to ${p.to}.`); },
    },
    {
      name: "rm",
      label: "Delete",
      description: "Delete a file, or a folder with everything in it. The document's own page (index.html at its root) can't be deleted. Only delete what you were asked to.",
      parameters: Type.Object({ path: Type.String({ description: "Path of the file or folder" }) }),
      execute: async (_id, p: { path: string }) => { await tree({ op: "delete", path: p.path }); return text(`Deleted ${p.path}.`); },
    },
    {
      name: "make_project",
      label: "Make a project",
      description: "Make this document a project: a folder of pages, each with its own address, instead of one page with files beside it. Only a project can have more than one page (new_page, or a new .html file). make_document turns it back while it has one page. Do it only when the user asks for it, or agrees to it (the Document/Project switch in the document's settings does the same).",
      parameters: Type.Object({}),
      execute: async () => { await tree({ op: "make_project" }); return text("It's a project now: new_page makes more pages, each with its own address."); },
    },
    {
      name: "make_document",
      label: "Make a document",
      description: "Make this project a document again: one page (index.html) and any other files beside it. Only a project with one page, its index.html, can: delete its other pages first (rm), and only when the user asks. Other files (images, styles) stay. Do it only when the user asks for it, or agrees to it (the Document/Project switch in the document's settings does the same).",
      parameters: Type.Object({}),
      execute: async () => { await tree({ op: "make_document" }); return text("It's a document now: one page, index.html, and the files beside it."); },
    },
  ] as AgentTool[];
}

/** The document's pages as list_pages answers them: every entry (titles on pages), and the document's address. */
export interface PageTree { address: string; entries: TreeEntry[] }
/** What open_page did: the page it opened, and in how many of the person's tabs (none: nothing opened). */
export interface OpenResult { path: string; tabs: number; message: string }

/** list_pages and open_page: the document as its users see it (pages), and moving the person's editor between them. */
function pageTools(pages: () => Promise<PageTree>, open?: (path: string) => Promise<OpenResult>): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return [
    {
      name: "list_pages",
      label: "List pages",
      description: "List the document's pages: each page's file, title and address, by folder (folders end in /). Pages are the .html files; index.html is the home page. The other files (CSS, JS, images, PDFs...) are counted here: ls and find list them.",
      parameters: Type.Object({}),
      execute: async () => {
        const t = await pages();
        const lines = t.entries.filter((e) => e.type != "file").map((e) => {
          const depth = e.path.split("/").length - 1, pad = "  ".repeat(depth);
          if (e.type == "folder") return `${pad}${e.path}/`;
          const rest = pageAddress(e.path);
          return `${pad}${e.path}  "${e.title ?? "(untitled)"}"  ${t.address}${rest ? `/${rest}` : ""}${e.path == "index.html" ? "  (home page)" : ""}`;
        });
        const n = t.entries.filter((e) => e.type == "page").length, assets = t.entries.filter((e) => e.type == "file").length;
        return text(`${n} page(s) and ${assets} other file(s) (shared assets).\n\n${lines.join("\n")}`);
      },
    },
    ...(open ? [{
      name: "open_page",
      label: "Open a page",
      description: "Switch the user's open editor to another page of this document, by its file (\"blog/post.html\") or its address under the document (\"blog/post\", \"\" for the home page). Every editor tab the user has open on this document goes there. With none open, nothing happens, and the answer says so and gives the page's address. Use it when the user asks to go to a page, or to show them a page you made.",
      parameters: Type.Object({ path: Type.String({ description: "The page's file, e.g. \"about.html\", or its address under the document, e.g. \"blog\"" }) }),
      execute: async (_id: string, p: { path: string }) => text((await open(p.path)).message),
    }] : []),
  ] as AgentTool[];
}

/** get_title and set_title: the document's title and its address, kept in the directory, not in a file. */
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

/**
 * The document tools' names, descriptions and arguments (JSON Schema), with
 * no document behind them: for the server's API, which offers
 * them for any document by adding a `document` argument and runs them in that
 * document's host.
 */
export function documentToolSpecs(): ToolSpec[] {
  const none = () => { throw new Error("no document"); };
  const naming = { get: none, set: none } as unknown as Naming;
  const versions = { state: none, version: none, file: none, files: none, current: none, restore: none } as unknown as VersionsAccess;
  return makeTools(null as unknown as Workspace, {
    view: none,
    readAsset: none,
    edited: none,
    naming,
    tree: none,
    versions,
    pages: none,
    open: none,
  }).map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) }));
}

/** What a tool returns: text, and for read on an image or view_page, a picture; for read on a PDF, the PDF (a range of its pages). */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "document"; data: string; mimeType: "application/pdf" };
/** A tool as an external agent sees it: its arguments as JSON Schema. */
export interface ToolSpec { name: string; description: string; parameters: unknown }

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
