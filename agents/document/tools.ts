// The document tools every agent has in a document (run in its host: agents/document/session.ts): the files' text
// (read, edit, grep), a page's edits (document_api, call_edit: its own API, run in a sandbox, document/page-api.ts, and
// erga/text's, libs/text/api/edits.ts), the page (page-tools.ts), and open_page.
// What a person does with the document as a whole (its name, pages, folders, files' list and versions) is an
// operation (server/operations/editor.ts), which the agent has as a tool too. Two tools here are the operations' own
// (HOST_ONLY): write's one file and versions' diff run here, where the session's replica and its last turn are.

import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AgentTool } from "../run";
import type { ViewRequest, ViewResult } from "../../shared/agent-log";
import type { LiveAnswer, LiveRequest } from "../../shared/live-page";
import { readableSize } from "../../shared/bytes";
import { globToRegExp } from "../../shared/glob";
import { unifiedDiff } from "../../document/versions";
import { EDITS, WorkspaceError, modelPath, type Workspace } from "./workspace";
import { isPdf, pageCount, pageRange, PAGES_PER_READ, PDF_READ_MAX, pdfPages } from "../../document/pdf";
import type { FilesAccess, OpenResult, VersionsAccess } from "../../document/agent";
import { pageTools } from "./page-tools";
import { readLines, type TextEdit } from "../../shared/text-edits";
import { findInSource } from "../../shared/source-select";
import { textApi, type DocumentApi } from "../../libs/text/api/edits";
import { slidesApi } from "../../libs/slides/api/slides";
import { bringsEditor, importedLibrary } from "../../shared/page-html";
import { inputProblem } from "./edit-input";
import { applyPageEdit, describePageApi, type PageEdits, type Sandbox } from "../../document/page-api";
import { apiPathOf } from "../../shared/page-ops";

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The biggest image read gives the model (its limit is 5 MB of base64). */
const IMAGE_READ_MAX = 3_750_000;
/** The most bytes a write of bytes takes in one call (base64 in the tool's arguments). */
const WRITE_BYTES_MAX = 25_000_000;

/** The tools that change the document: someone who may only view it (and their agent, and their token) has none of them. */
export const CHANGES = new Set(["edit", "write", "call_edit"]);
/**
 * The tools that only the operations call, in the host (server/operations/: runInDocument): write's one file (the
 * operation write), and diff_versions (the operation versions, with from or to). No agent has them by these names.
 */
export const HOST_ONLY = new Set(["write", "diff_versions"]);


/** The agent's tools, over a workspace. */
export function makeTools(
  ws: Workspace,
  opts: {
    view: (req: ViewRequest) => Promise<ViewResult>;
    live: (req: LiveRequest) => Promise<LiveAnswer>;
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
   * imports (erga/slides; erga/canvas uses erga/text's), else erga/text, unless it has an editor of its own. Throws when it has neither.
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
    // erga/canvas edits its frames' text with erga/text, so its edits are erga/text's.
    const imported = importedLibrary(html);
    const library = imported == "slides" ? slidesApi : imported == "canvas" ? textApi : bringsEditor(html) ? null : textApi;
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
  const readFile = async (path: string, bytes: Uint8Array, pages?: string) => {
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
  /** read with `version`: the file's bytes in that version. */
  const oldFile = async (version: string, path: string) => {
    const files = await opts.versions?.files(version);
    if (!files) throw new Error(`There's no version "${version}": versions lists them.`);
    const bytes = files.get(path);
    if (!bytes) throw new Error(`${version} has no file ${path}. Its files: ${[...files.keys()].slice(0, 50).join(", ")}`);
    return bytes;
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
      description: "Reads a file (text, an image, a PDF), one element or CSS rule of it, or an old version.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({
          description: `The file. Text comes cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; an image as a picture; a PDF as pages you see`,
        }),
        offset: Schema.optionalKey(Schema.Finite.annotate({ description: "The line to start at (1 is the first)" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "At most this many lines" })),
        pages: Schema.optionalKey(
          Schema.String.annotate({ description: `A PDF's pages: "3" or "21-40", at most ${PAGES_PER_READ} (default: the first ones)` })
        ),
        selector: Schema.optionalKey(
          Schema.String.annotate({
            description: 'Only the one element it matches, as the source has it (e.g. "svg g#logo"): edit takes it too',
          })
        ),
        css_rule: Schema.optionalKey(
          Schema.String.annotate({ description: 'Only the one CSS rule with this selector (e.g. ".legible h2"): edit takes it as cssRule' })
        ),
        version: Schema.optionalKey(
          Schema.String.annotate({ description: 'The file as it was in this version ("v3"; versions lists them)' })
        ),
      }),
      execute: async (
        _id,
        p: { path: string; offset?: number; limit?: number; pages?: string; selector?: string; css_rule?: string; version?: string }
      ) => {
        const path = run(modelPath(p.path));
        let all: string;
        if (p.version != null) {
          const bytes = await oldFile(String(p.version), path);
          if (IMAGE.test(path) || isPdf(path)) return readFile(path, bytes, p.pages);
          try {
            all = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
          } catch {
            return text(`${path} in ${p.version} is a file of ${readableSize(bytes.length)} that isn't text.`);
          }
        } else if (!ws.isText(path) && ws.paths().includes(path)) {
          const bytes = await opts.readAsset(path);
          if (!bytes) throw new Error(`${path} doesn't exist`);
          return readFile(path, bytes, p.pages);
        } else all = run(ws.read(path));
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
      description: "Replaces exact text, one element or one CSS rule in a file's source; one undo step.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: "The file" }),
        edits: EDITS.annotate({
          description:
            "Replacements against the file as it is now, each unique and apart (merge two in one block). oldText not found: the file changed, read it again. A page's text: call_edit first",
        }),
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
      description: "Lists a page's edits (its own API's and its library's), with their inputs: use them first for its text.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({
          description:
            'The page, e.g. "index.html": its own API (<meta name="erga-api">), and erga/slides\' or erga/text\'s. They keep the HTML as a person\'s editing would; edit the source only for layout, styles and scripts',
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
      description: "Runs one of a page's edits (document_api lists them); if it refuses, edit the source.",
      parameters: Schema.Struct({
        path: Schema.String.annotate({ description: 'The page, e.g. "index.html"' }),
        edit: Schema.String.annotate({ description: 'The edit\'s name, e.g. "replace_text": it lands at once, one undo step' }),
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
      // The operation write's one file (HOST_ONLY): its arguments are described there (server/operations/documents.ts).
      description: "Writes one file: text (only the differences apply), or bytes.",
      parameters: Schema.Struct({
        path: Schema.String,
        content: Schema.optionalKey(Schema.String),
        content_base64: Schema.optionalKey(Schema.String),
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
      name: "grep",
      label: "Search",
      description: "Searches the document's text files, and its PDFs' text, for a regular expression.",
      parameters: Schema.Struct({
        pattern: Schema.String.annotate({
          description: "A regular expression, or literal text with literal: true. The answer: path:line: text (a PDF's page for its line)",
        }),
        glob: Schema.optionalKey(Schema.String.annotate({ description: 'Only the files that match, e.g. "**/*.css"' })),
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
    ...pageTools(opts.view, opts.live),
    ...(opts.open ? [openPage(opts.open)] : []),
    ...(opts.versions ? [diffVersions(opts.versions, opts.lastTurn ?? (async () => null))] : []),
  ] as AgentTool[];
}


/**
 * diff_versions: what changed between two versions, or since the agent's last turn (which only it knows): the
 * operation versions' diff (HOST_ONLY), whose arguments are described there (server/operations/editor.ts). Each file's
 * unified diff (binary files only say they changed), cut at about 50KB.
 */
function diffVersions(versions: VersionsAccess, lastTurn: () => Promise<string | null>): AgentTool {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
  return {
      name: "diff_versions",
      label: "Diff versions",
      description: "Shows what changed between two versions, as a unified diff of each file.",
      parameters: Schema.Struct({
        from: Schema.optionalKey(Schema.String),
        to: Schema.optionalKey(Schema.String),
        path: Schema.optionalKey(Schema.String),
        context: Schema.optionalKey(Schema.Finite),
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
          if (!files) throw new Error(`There's no version "${ref}": versions lists them.`);
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

/** open_page: moves the person's open editor to another page of the document (the pages themselves: ls, an operation). */
function openPage(open: (path: string) => Promise<OpenResult>): AgentTool {
  return {
    name: "open_page",
    label: "Open a page",
    description: "Switches your person's open editor tabs on this document to another of its pages.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description:
          'The page\'s file ("blog/post.html") or its address under the document ("blog/post", "" for the home page). With no tab open, the answer gives its address',
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
 * document's host. Not the HOST_ONLY ones: the operations offer those.
 */
export function documentToolSpecs(): { name: string; description: string; parameters: Schema.Struct<Schema.Struct.Fields> }[] {
  const none = () => { throw new Error("no document"); };
  const versions = { state: none, version: none, files: none, current: none } as unknown as VersionsAccess;
  return makeTools(null as unknown as Workspace, {
    view: none,
    live: none,
    readAsset: none,
    edited: none,
    versions,
    open: none,
    sandbox: none,
  })
    .filter((t) => !HOST_ONLY.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Schema.Struct<Schema.Struct.Fields> }));
}


export function toolPath(args: unknown): string | null {
  const a = args as { path?: unknown; from?: unknown } | null;
  return typeof a?.path == "string" ? a.path : typeof a?.from == "string" ? a.from : null;
}

