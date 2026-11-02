// The document tools every agent has in a document (run in its host: agents/document/session.ts): the files' text (read, edit, write, find, grep), a page's edits (document_api, call_edit: its own API, run in a sandbox, document/page-api.ts, and erga/text's, libs/text/api/edits.ts), the page (page-tools.ts), and diff_versions.
// What a person does with the document as a whole (its name, pages, folders, files' list and versions) is an
// operation (server/operations/editor.ts), which the agent has as a tool too.

import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AgentTool } from "../run";
import type { ViewRequest, ViewResult } from "../../shared/agent-log";
import { readableSize } from "../../shared/bytes";
import { unifiedDiff } from "../../document/versions";
import { EDITS, WorkspaceError, globToRegExp, modelPath, type Workspace } from "./workspace";
import { isPdf, pageCount, pageRange, PAGES_PER_READ, PDF_READ_MAX, pdfPages } from "../../document/pdf";
import type { FilesAccess, OpenResult, VersionsAccess } from "../../document/agent";
import { pageTools } from "./page-tools";
import { readLines, type TextEdit } from "../../shared/text-edits";
import { findInSource } from "../../shared/source-select";
import { textApi, type DocumentApi } from "../../libs/text/api/edits";
import { slidesApi } from "../../libs/slides/api/slides";
import { bringsEditor, importedLibrary } from "../../shared/page-html";
import { inputProblem } from "./edit-input";
import { apiPathOf, applyPageEdit, describePageApi, type PageEdits, type Sandbox } from "../../document/page-api";

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The biggest image read gives the model (its limit is 5 MB of base64). */
const IMAGE_READ_MAX = 3_750_000;
/** The most bytes a write of bytes takes in one call (base64 in the tool's arguments). */
const WRITE_BYTES_MAX = 25_000_000;

/** The tools that change the document: someone who may only view it (and their agent, and their token) has none of them. */
export const CHANGES = new Set(["edit", "write", "call_edit"]);


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
    /** Runs a page's own API (document/page-api.ts). */
    sandbox: Sandbox;
  }
): AgentTool[] {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  /** Runs a workspace operation; its failure becomes the tool's error, which the model reads. */
  const run = <T>(op: Effect.Effect<T, WorkspaceError>): T => Effect.runSync(Effect.mapError(op, (e) => new Error(e.message)));
  /**
   * A page's APIs: its own (its module, <meta name="erga-api">, described in the sandbox) and its library's: the one it
   * imports (erga/slides), else erga/text, unless it has an editor of its own. Throws when it has neither.
   */
  const apisOf = async (
    path: string
  ): Promise<{ html: string; own: PageEdits | null; code: string | null; library: DocumentApi | null }> => {
    if (!/\.html?$/i.test(path)) throw new Error(`${path} isn't a page: its edits are the source's (edit, write).`);
    const html = run(ws.read(path));
    const module = apiPathOf(path, html);
    const code = module && ws.paths().includes(module) ? run(ws.read(module)) : null;
    if (module && code == null)
      throw new Error(`${path} names ${module} as its API (<meta name="erga-api">), but the document has no such file.`);
    const own = code == null ? null : await describePageApi(opts.sandbox, code);
    const library = importedLibrary(html) == "slides" ? slidesApi : bringsEditor(html) ? null : textApi;
    if (!own && !library)
      throw new Error(`${path} has its own editor and names no API of its own (<meta name="erga-api">): edit its source (edit, write).`);
    return { html, own, code, library };
  };
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
      description: `Read a file: a text file's current text, an image (png, jpg, gif, webp) as a picture, or a PDF as a document you see (its text, tables, layout and scans), ${PAGES_PER_READ} pages at a time (pages: "21-40" for more). For another kind of file, its size and type. Text is cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for more. For one part of a big page, give selector (one element's source, found in the source as written, e.g. "section.legible") or css_rule (one CSS rule, e.g. ".legible h2"): the answer is that part and its lines, and edit takes the same selector or cssRule to replace it.`,
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Path of the file, relative to the document's folder" }),
        offset: Schema.optionalKey(Schema.Finite.annotate({ description: "Line number to start reading from (1-indexed)" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "Maximum number of lines to read" })),
        pages: Schema.optionalKey(
          Schema.String.annotate({
            description: `A PDF's pages to read: one ("3") or a range ("21-40"), at most ${PAGES_PER_READ}. Default: the first ${PAGES_PER_READ}.`,
          })
        ),
        selector: Schema.optionalKey(
          Schema.String.annotate({ description: 'Only the one element this CSS selector matches, e.g. "section.legible" or "svg g#logo".' })
        ),
        css_rule: Schema.optionalKey(
          Schema.String.annotate({
            description: 'Only the one CSS rule with this selector (in a stylesheet, or the page\'s <style>), e.g. ".legible h2".',
          })
        ),
      }),
      execute: async (_id, p: { path: string; offset?: number; limit?: number; pages?: string; selector?: string; css_rule?: string }) => {
        const path = run(modelPath(p.path));
        if (!ws.isText(path) && ws.paths().includes(path)) return readFile(path, p.pages);
        const all = run(ws.read(path));
        if (p.selector != null || p.css_rule != null) {
          const found = findInSource(all, path, { selector: p.selector, cssRule: p.css_rule });
          if (typeof found == "string") throw new Error(found);
          const [a, b] = found.lines;
          return text(
            `[${path}, ${a == b ? `line ${a}` : `lines ${a}-${b}`}: the ${p.selector != null ? `element "${p.selector}"` : `CSS rule "${p.css_rule}"`}]\n${all.slice(found.from, found.to)}`
          );
        }
        const lines = all.split("\n").length;
        if ((p.offset ?? 1) > lines && lines > 1) throw new Error(`Offset ${p.offset} is beyond the end of the file (${lines} lines)`);
        const out = readLines(all, p.offset ?? 1, p.limit ?? MAX_LINES, MAX_BYTES);
        return text(out);
      },
    },
    {
      name: "edit",
      label: "Edit",
      description:
        'Edit a file by exact text replacement, against its text as it is right now. Every edits[].oldText must match a unique, non-overlapping region. If two changes touch the same block, merge them into one edit. If oldText isn\'t found, the file changed since you read it: read it again. To replace a whole element, give its CSS selector instead of oldText ({"selector": "svg g#logo", "newText": "<g id=\\"logo\\">...</g>"}); to replace a whole CSS rule (in a stylesheet or a <style>), its selector as cssRule ({"cssRule": ".legible h2", "newText": ".legible h2 { color: navy; }"}). Either must name exactly one, in the source as written; read with selector or css_rule shows it first. Each call is one step to undo. For a change to a page\'s text (words, blocks, styles, links, lists), use the page\'s own edits first (document_api, call_edit).',
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "Path of the file to edit" }),
        edits: EDITS.annotate({ description: "One or more targeted replacements, each matched against the current file" }),
      }),
      execute: async (_id, p: { path: string; edits: readonly TextEdit[] }) => {
        const r = await Effect.runPromise(Effect.match(ws.edit(p.path, p.edits), { onFailure: (e) => e, onSuccess: (r) => r }));
        if (r instanceof WorkspaceError)
          throw new Error(r.reason == "changed" ? await changedSince(r.message, run(modelPath(p.path))) : r.message);
        opts.edited(r.path, r.at);
        return text(r.summary);
      },
    },
    {
      name: "document_api",
      label: "Read the page's edits",
      description: "List a page's edits (its own API's and its library's), with their inputs: use them first for a change to its text.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({
          description:
            "Path of the page, e.g. \"index.html\". Its APIs: its own, if it names one (<meta name=\"erga-api\">), and its library's (the one it imports, erga/slides; else erga/text, unless it has an editor of its own). Each edit: its name, what it does, its input's JSON Schema. They keep the HTML as a person's editing would; edit the source (edit, write) only for what they can't do (layout, styles, scripts).",
        }),
      }),
      execute: async (_id, p: { path: string }) => {
        const { own, library } = await apisOf(run(modelPath(p.path)));
        const apis = [
          own && { api: own.name, description: own.description, edits: own.edits },
          library && { api: library.name, description: library.description, edits: library.edits },
        ];
        return text(JSON.stringify({ apis: apis.filter(Boolean) }, null, 1));
      },
    },
    {
      name: "call_edit",
      label: "Edit the page",
      description: "Run one of a page's edits (document_api lists them, with their input's schema); if it refuses, edit the source.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: 'Path of the page, e.g. "index.html"' }),
        edit: Schema.String.annotate({
          description:
            'The edit\'s name, e.g. "replace_text". It lands in the page at once, and everyone sees it typed. Each call is one step to undo.',
        }),
        input: Schema.Record(Schema.String, Schema.Unknown).annotate({
          description: 'The edit\'s input, as its schema says, e.g. {"selector": "h1", "find": "Draft", "text": "Final"}',
        }),
      }),
      execute: async (_id, p: { path: string; edit: string; input: Record<string, unknown> }) => {
        const path = run(modelPath(p.path));
        const { html, own, code, library } = await apisOf(path);
        const schema = (own?.edits.find((e) => e.name == p.edit) ?? library?.edits.find((e) => e.name == p.edit))?.input;
        const problem = schema && inputProblem(p.edit, schema, p.input);
        if (problem) throw new Error(problem);
        if (own?.edits.some((e) => e.name == p.edit)) {
          const r = await applyPageEdit(opts.sandbox, code!, html, p.edit, p.input);
          if ("refused" in r) throw new Error(r.refused);
          const done = run(ws.change(path, html, r.changes));
          opts.edited(done.path, done.at);
          return text(`Made ${own.name}'s ${p.edit}. ${done.summary}`);
        }
        if (!library)
          throw new Error(`${path}'s API${own ? `, ${own.name},` : ""} has no edit named "${p.edit}": document_api lists its edits.`);
        const r = library.apply(html, path, p.edit, p.input);
        if ("refused" in r) throw new Error(r.refused);
        if (!r.changes.length) return text(r.done);
        const done = run(ws.change(path, html, r.changes));
        opts.edited(done.path, done.at);
        return text(`${r.done} ${done.summary}`);
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
    ...pageTools(opts.view),
    ...(opts.open ? [openPage(opts.open)] : []),
    ...(opts.versions ? [diffVersions(opts.versions, opts.lastTurn ?? (async () => null))] : []),
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
    sandbox: none,
  }).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Schema.Struct<Schema.Struct.Fields> }));
}


export function toolPath(args: unknown): string | null {
  const a = args as { path?: unknown; from?: unknown } | null;
  return typeof a?.path == "string" ? a.path : typeof a?.from == "string" ? a.from : null;
}

