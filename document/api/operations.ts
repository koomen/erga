// The document's own operations on its files and pages, for any caller that the app vouches for (a user's page, a
// user's own agent, an outside agent): the files' text (read, edit, write, grep), a page's edits (document_api,
// call_edit: its own API, run in a sandbox, page-api.ts, and erga/text's, libs/text/api/edits.ts), the page as it
// runs (page-operations.ts), open_page, and a diff of two versions. Each runs as a participant (participants.ts), on
// the room's own text (workspace.ts). The host serves them (host.ts, POST /api/operations/<name>).
//
// What a user does with the document as a whole (its name, pages, folders, files' list and versions) is an operation
// of the server (server/operations/editor.ts). The agents' tools are a thin layer over both (agents/tools.ts).
//
// The descriptions and the errors are written for whoever calls: mostly a model, which reads them as its manual.

import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ViewRequest, ViewResult } from "../../shared/view-page";
import type { LiveAnswer, LiveRequest } from "../../shared/live-page";
import { readableSize } from "../../shared/bytes";
import { globToRegExp } from "../../shared/glob";
import { escapeRe } from "../../shared/html";
import { IMAGE_TYPES } from "../../shared/attach";
import { pictureSize, tooLarge } from "../../shared/picture";
import { unifiedDiff, type Version, type VersionsState } from "../history/versions";
import { EDITORS_READ_VERSIONS } from "../model/content";
import { EDITS, WorkspaceError, modelPath, type Workspace } from "../room/workspace";
import { PAGE_OPERATIONS } from "./page-operations";
import { readLines, type TextEdit } from "../../shared/text-edits";
import { findInSource } from "../../shared/source-select";
import { textApi, type DocumentApi } from "../../libs/text/api/edits";
import { bringsEditor } from "../../shared/page-html";
import { inputProblem } from "./edit-input";
import { applyPageEdit, describePageApi, type PageEdits, type Sandbox } from "./page-api";
import { apiPathOf } from "../../shared/page-ops";
import { checkNewName, cleanPath, cleanTreePath, isPage, parentsOf, TreeError, type TreeOp } from "../model/pages";
import type { Participant, Room } from "../room/room";
import type { StoreError } from "../store/storage";

const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** The biggest image read gives the model: 5 MB of base64 (the model takes 10 MB: shared/picture.ts). */
const IMAGE_READ_MAX = 3_750_000;
/** The most bytes a write of bytes takes in one call (base64 in the tool's arguments). */
const WRITE_BYTES_MAX = 25_000_000;

/** What an operation answers: text, and for read on an image or view_page, a picture. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** What the file operations reach beyond the shared text: every file's size, time and kind, and a write of bytes. */
export interface FilesAccess {
  /** Each file's size (bytes), time (ms, when known) and kind: text, or a file kept whole (a blob), with its type. */
  stats(): Promise<Map<string, { size: number | null; at: number | null; kind: "text" | "file"; type: string }>>;
  /** Writes a file's bytes as the participant: text if it is text, else a file kept whole. Refused past the limits. */
  writeBytes(path: string, bytes: Uint8Array): Promise<{ kind: "text" | "file"; replaced: boolean }>;
}

/** The document's versions, as the operations reach them. */
export interface VersionsAccess {
  state(opts: { before?: string | number | null; limit?: number }): Promise<VersionsState>;
  version(ref: string | number): Promise<(Version & { files: string[]; index: string }) | null>;
  /** Every file of a version (null if there's no such version). */
  files(ref: string | number): Promise<Map<string, Uint8Array> | null>;
  /** Every file as it is now, up to the keystroke. */
  current(): Promise<Map<string, Uint8Array>>;
}

/** What open_page did: the page it opened, and in how many of the user's tabs (none: nothing opened). */
export interface OpenResult {
  path: string;
  tabs: number;
  message: string;
}

/** What an operation reaches of the document, for the participant that it runs as (host.ts gives it for each call). */
export interface Reach {
  /** The participant's user, by name. */
  user: { id: string; name: string };
  /** The participant's view of the text: the texts that it last read, and its edits (workspace.ts). */
  ws: Workspace;
  /** Whether the participant's user may edit, now. */
  canEdit(): boolean;
  /** Renders a page in the server's browser (view_page, eval_in_page). */
  view(req: ViewRequest): Promise<ViewResult>;
  /** Asks the user's open tabs about the live page (page_log, page_input, eval_in_page with live): the best answer. */
  live(req: LiveRequest): Promise<LiveAnswer>;
  /** Switches the user's open editor tabs to a page (open_page). */
  open(path: string): Promise<OpenResult>;
  /** The bytes of a file that isn't text. */
  readAsset(path: string): Promise<Uint8Array | null>;
  /** The participant changed a file, up to `at`: its undo step, its turn's files, its caret (participants.ts). */
  edited(path: string, at: number): void;
  versions: VersionsAccess;
  /** The version the document was at when the participant's last run of calls ended (diff_versions' "last_turn"); null before its first. */
  lastTurn(): Promise<string | null>;
  files: FilesAccess;
  /** Runs a page's own API (page-api.ts). */
  sandbox: Sandbox;
  /** Runs the call as one of the participant's work (participants.ts, during): its presence and turn. */
  during<A>(call: { activity: string; changes: boolean }, run: () => Promise<A>): Promise<A>;
}

/** One operation of the document. */
export interface DocumentOperation {
  readonly name: string;
  readonly description: string;
  /** What the participant does while it runs ("editing"): its presence shows it. */
  readonly activity: string;
  /** It changes the document: someone who may only view it (and their agent, and their token) has none of these. */
  readonly changes?: true;
  /** Its arguments. */
  readonly parameters: Schema.Top;
  /** Runs with its arguments decoded; throws (an Error whose message the caller reads) when it fails. */
  // biome-ignore lint/suspicious/noExplicitAny: each operation names its own arguments, which `parameters` decoded
  run(c: Reach, p: any): Promise<ToolContent[]>;
}

const text = (s: string): ToolContent[] => [{ type: "text", text: s }];
/** Runs a workspace operation; its failure becomes the operation's error, which the caller reads. */
const run = <T>(op: Effect.Effect<T, WorkspaceError>): T => Effect.runSync(Effect.mapError(op, (e) => new Error(e.message)));

/**
 * A page's APIs: its own (its module, <meta name="erga-api">, described in the sandbox) and erga/text's, unless it has an
 * editor of its own. Throws when it has neither.
 */
async function apisOf(
  c: Reach,
  path: string
): Promise<{ html: string; own: PageEdits | null; code: string | null; library: DocumentApi | null }> {
  if (!/\.html?$/i.test(path)) throw new Error(`${path} isn't a page: its edits are the source's (edit, write).`);
  const html = run(c.ws.read(path));
  const module = apiPathOf(path, html);
  const code = module && c.ws.paths().includes(module) ? run(c.ws.read(module)) : null;
  if (module && code == null)
    throw new Error(`${path} names ${module} as its API (<meta name="erga-api">), but the document has no such file.`);
  const own = code == null ? null : await describePageApi(c.sandbox, code);
  const library = bringsEditor(html) ? null : textApi;
  if (!own && !library)
    throw new Error(`${path} has its own editor and names no API of its own (<meta name="erga-api">): edit its source (edit, write).`);
  return { html, own, code, library };
}
/** An edit based on text the file no longer has: which restores changed it since the agent saw it, and the current version. */
async function changedSince(c: Reach, message: string, path: string): Promise<string> {
  const s = await c.versions.state({ limit: 20 }).catch(() => null);
  if (!s) return message;
  const since = c.ws.seenAt(path) ?? 0;
  const restores = s.versions.filter((v) => Date.parse(v.at) >= since && (/^Restored version \d+$/.test(v.description ?? "") || v.description?.startsWith(`Restored ${path} from version `))).reverse();
  const what = restores.length ? ` It was restored since: ${restores.map((v) => `${v.id}, "${v.description}", by ${v.authors.join(", ") || "(unknown)"}`).join("; ")}.` : "";
  return message.replace(/ Read \S+ again and retry\.$/, "") + `${what} The current version is ${s.current.id}${s.pending ? " (with edits since, not yet a version)" : ""}. Read ${path} again and retry.`;
}
/** read, for a file kept whole: an image as a picture, anything else described. */
async function readFile(c: Reach, path: string, bytes: Uint8Array): Promise<ToolContent[]> {
  if (IMAGE.test(path)) {
    if (bytes.length > IMAGE_READ_MAX)
      throw new Error(
        `${path} is ${readableSize(bytes.length)}: too big to see (an image can have up to ${readableSize(IMAGE_READ_MAX)}).`
      );
    const large = tooLarge(pictureSize(bytes), 0);
    if (large)
      throw new Error(
        `${path} is ${large}. To see it scaled down, take view_page with a preview (edits) that puts it in the page as an <img>, and with that <img>'s selector.`
      );
    return [{ type: "image", data: Base64.encode(bytes), mimeType: IMAGE_TYPES[path.split(".").pop()!.toLowerCase()] }];
  }
  const kind = (await c.files.stats().catch(() => null))?.get(path)?.type ?? "a file that isn't text";
  return text(
    `${path} is a file kept whole (${kind}, ${readableSize(bytes.length)}): it isn't text or an image, so it can't be shown here. It can be moved, renamed, deleted, or replaced with write's content_base64.`
  );
}
/** read with `version`: the file's bytes in that version. */
async function oldFile(c: Reach, version: string, path: string): Promise<Uint8Array> {
  if (!c.canEdit()) throw new Error(EDITORS_READ_VERSIONS);
  const files = await c.versions.files(version);
  if (!files) throw new Error(`There's no version "${version}": versions lists them.`);
  const bytes = files.get(path);
  if (!bytes) throw new Error(`${version} has no file ${path}. Its files: ${[...files.keys()].slice(0, 50).join(", ")}`);
  return bytes;
}
/** write's bytes: a file kept whole (or text, if they are text), as the participant. */
async function writeBytes(c: Reach, raw: string, b64: string): Promise<string> {
  const path = run(modelPath(raw));
  if (!c.canEdit()) throw new Error("Your user can only view this document, so you can't change it.");
  const clean = b64.replace(/\s+/g, "");
  if ((clean.length * 3) / 4 > WRITE_BYTES_MAX) throw new Error(`That's more than ${WRITE_BYTES_MAX / 1e6} MB: too much for one call.`);
  const decoded = Base64.decode(clean);
  if (Result.isFailure(decoded)) throw new Error("content_base64 isn't base64.");
  const bytes = decoded.success;
  const r = await c.files.writeBytes(path, bytes);
  return `${r.replaced ? "Replaced" : "Wrote"} ${path} (${readableSize(bytes.length)}, ${r.kind == "text" ? "as text" : "a file kept whole"}).`;
}
/** read with a glob: each text file it matches, whole, after a line with its path, as far as MAX_BYTES goes. */
function readMany(c: Reach, glob: string): string {
  const only = globToRegExp(glob.replace(/^\.?\//, ""));
  const paths = c.ws.paths().filter((f) => only.test(f) && c.ws.isText(f));
  if (!paths.length) throw new Error(`No text file matches ${glob}.`);
  let out = "",
    i = 0;
  for (; i < paths.length; i++) {
    const part = `==> ${paths[i]} <==\n${run(c.ws.read(paths[i]))}\n`;
    if (out.length + part.length > MAX_BYTES) break;
    out += part;
  }
  return i < paths.length
    ? `${out}\n[${paths.length - i} more: ${paths.slice(i).join(", ")}. Read them by name, or with a narrower glob.]`
    : out;
}
/** edit with a glob: each oldText replaced everywhere, in each text file the glob matches that has it (as sed would). */
async function editMany(c: Reach, glob: string, edits: readonly TextEdit[]): Promise<string> {
  if (edits.some((e) => !e.oldText)) throw new Error("With a glob path, each edit gives oldText (no selector or cssRule).");
  const only = globToRegExp(glob.replace(/^\.?\//, ""));
  const done: string[] = [];
  for (const f of c.ws.paths()) {
    if (!only.test(f) || !c.ws.isText(f)) continue;
    const here = run(c.ws.read(f));
    const mine = edits.filter((e) => here.includes(e.oldText!)).map((e) => ({ ...e, replaceAll: true }));
    if (!mine.length) continue;
    const r = await Effect.runPromise(Effect.mapError(c.ws.edit(f, mine), (e) => new Error(e.message)));
    c.edited(r.path, r.at);
    done.push(r.summary);
  }
  if (!done.length) throw new Error(`No file that ${glob} matches has any of the oldTexts: nothing was changed.`);
  return done.join("\n");
}
/** The operations on the files' text. */
const FILE_OPERATIONS: DocumentOperation[] = [
  {
    name: "read",
    activity: "reading",
    description: "Reads a file: text or an image.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description: `The file (text: ${MAX_LINES} lines at most); or a glob ("*.html"): each text file it matches, one after another.`,
      }),
      offset: Schema.optionalKey(Schema.Finite),
      limit: Schema.optionalKey(Schema.Finite),
      selector: Schema.optionalKey(
        Schema.String.annotate({
          description: 'Only this element, e.g. "svg g#logo".',
        })
      ),
      css_rule: Schema.optionalKey(Schema.String.annotate({ description: 'Only this CSS rule, e.g. ".legible h2".' })),
      version: Schema.optionalKey(Schema.String.annotate({ description: "As in this version." })),
    }),
    run: async (c, p: { path: string; offset?: number; limit?: number; selector?: string; css_rule?: string; version?: string }) => {
      if (/[*?{]/.test(p.path) && p.version == null) return text(readMany(c, p.path));
      const path = run(modelPath(p.path));
      let all: string;
      if (p.version != null) {
        const bytes = await oldFile(c, String(p.version), path);
        if (IMAGE.test(path)) return readFile(c, path, bytes);
        try {
          all = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch {
          return text(`${path} in ${p.version} is a file of ${readableSize(bytes.length)} that isn't text.`);
        }
      } else if (!c.ws.isText(path) && c.ws.paths().includes(path)) {
        const bytes = await c.readAsset(path);
        if (!bytes) throw new Error(`${path} doesn't exist`);
        return readFile(c, path, bytes);
      } else all = run(c.ws.read(path));
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
    activity: "editing",
    changes: true,
    description: "Replaces text, an element or a CSS rule in a file.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description: 'The file; or a glob ("**/*.html"): each oldText, everywhere in each file it matches',
      }),
      edits: EDITS.annotate({
        description: "Replacements, all at once, each unique unless replaceAll",
      }),
    }),
    run: async (c, p: { path: string; edits: readonly TextEdit[] }) => {
      if (/[*?{]/.test(p.path)) return text(await editMany(c, p.path, p.edits));
      const r = await Effect.runPromise(Effect.match(c.ws.edit(p.path, p.edits), { onFailure: (e) => e, onSuccess: (r) => r }));
      if (r instanceof WorkspaceError)
        throw new Error(r.reason == "changed" ? await changedSince(c, r.message, run(modelPath(p.path))) : r.message);
      c.edited(r.path, r.at);
      return text(r.summary);
    },
  },
  {
    name: "document_api",
    activity: "reading the page's edits",
    description: "Lists a page's own edits: use them first for its text.",
    parameters: Schema.Struct({
      path: Schema.optionalKey(
        Schema.String.annotate({
          description: 'The page (default "index.html")',
        })
      ),
    }),
    run: async (c, p: { path?: string }) => {
      const { own, library } = await apisOf(c, run(modelPath(p.path ?? "index.html")));
      const apis = [
        own && { api: own.name, description: own.description, edits: own.edits },
        library && { api: library.name, description: library.description, edits: library.edits },
      ];
      return text(JSON.stringify({ apis: apis.filter(Boolean) }));
    },
  },
  {
    name: "call_edit",
    activity: "editing",
    changes: true,
    description: "Runs one of a page's edits (document_api).",
    parameters: Schema.Struct({
      path: Schema.optionalKey(Schema.String.annotate({ description: 'The page (default "index.html")' })),
      edit: Schema.String.annotate({ description: 'The edit\'s name, e.g. "replace_text".' }),
      input: Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Its input, as its schema says.",
      }),
    }),
    run: async (c, p: { path?: string; edit: string; input: Record<string, unknown> }) => {
      const path = run(modelPath(p.path ?? "index.html"));
      const { html, own, code, library } = await apisOf(c, path);
      const schema = (own?.edits.find((e) => e.name == p.edit) ?? library?.edits.find((e) => e.name == p.edit))?.input;
      const problem = schema && inputProblem(p.edit, schema, p.input);
      if (problem) throw new Error(problem);
      if (own?.edits.some((e) => e.name == p.edit)) {
        const r = await applyPageEdit(c.sandbox, code!, html, p.edit, p.input);
        if ("refused" in r) throw new Error(r.refused);
        const done = run(c.ws.change(path, html, r.changes));
        c.edited(done.path, done.at);
        return text(`Made ${own.name}'s ${p.edit}. ${done.summary}`);
      }
      if (!library)
        throw new Error(`${path}'s API${own ? `, ${own.name},` : ""} has no edit named "${p.edit}": document_api lists its edits.`);
      const r = library.apply(html, path, p.edit, p.input);
      if ("refused" in r) throw new Error(r.refused);
      if (!r.changes.length) return text(r.done);
      const done = run(c.ws.change(path, html, r.changes));
      c.edited(done.path, done.at);
      return text(`${r.done} ${done.summary}`);
    },
  },
  {
    name: "write",
    activity: "writing",
    changes: true,
    // The operation write's one file (HOST_ONLY): its arguments are described there (server/operations/documents.ts).
    description: "Writes one file: text (only the differences apply), or bytes.",
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.optionalKey(Schema.String),
      content_base64: Schema.optionalKey(Schema.String),
    }),
    run: async (c, p: { path: string; content?: string; content_base64?: string }) => {
      if ((p.content == null) == (p.content_base64 == null)) throw new Error("Give the file's content as text (content) or as bytes (content_base64): one of them.");
      if (p.content_base64 != null) return text(await writeBytes(c, p.path, p.content_base64));
      const r = await Effect.runPromise(Effect.mapError(c.ws.write(p.path, p.content!), (e) => new Error(e.message)));
      c.edited(r.path, r.at);
      return text(r.summary);
    },
  },
  {
    name: "grep",
    activity: "searching",
    description: "Searches the text files for a regex.",
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({
        description: "A regex, or text with literal.",
      }),
      glob: Schema.optionalKey(Schema.String.annotate({ description: 'Only matching paths, e.g. "**/*.css".' })),
      ignoreCase: Schema.optionalKey(Schema.Boolean),
      literal: Schema.optionalKey(Schema.Boolean),
    }),
    run: async (c, p: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean }) => {
      let re: RegExp;
      try {
        re = new RegExp(p.literal ? escapeRe(p.pattern) : p.pattern, p.ignoreCase ? "i" : "");
      } catch (e) {
        throw new Error(`bad pattern: ${(e as Error).message}`);
      }
      const only = p.glob ? globToRegExp(p.glob) : null;
      const out: string[] = [];
      const cut = (line: string) => (line.length > 300 ? line.slice(0, 300) + "…" : line);
      for (const f of c.ws.paths()) {
        if (out.length >= 100) break;
        if ((only && !only.test(f)) || !c.ws.isText(f)) continue;
        run(c.ws.read(f))
          .split("\n")
          .forEach((line, i) => {
            if (out.length < 100 && re.test(line)) out.push(`${f}:${i + 1}:${cut(line)}`);
          });
      }
      return text(out.length ? out.join("\n") + (out.length == 100 ? "\n[First 100 matches.]" : "") : "No matches.");
    },
  },
];

/**
 * diff_versions: what changed between two versions, or since the participant's last run of calls (which only the
 * document knows): the server's operation versions calls it, with from or to (server/operations/editor.ts). Each
 * file's unified diff (binary files only say they changed), cut at about 50KB.
 */
const DIFF_VERSIONS: DocumentOperation = {
  name: "diff_versions",
  activity: "comparing versions",
  description: "Shows what changed between two versions, as a unified diff of each file.",
  parameters: Schema.Struct({
    from: Schema.optionalKey(Schema.String),
    to: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
    context: Schema.optionalKey(Schema.Finite),
  }),
  run: async (c, p: { from?: string; to?: string; path?: string; context?: number }) => {
    if (!c.canEdit()) throw new Error(EDITORS_READ_VERSIONS);
    const { versions } = c;
    /** A side of the diff: its name, as the answer says it, and its files. */
    const side = async (ref: string) => {
      const r = ref.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (r == "current" || r == "now") return { name: "current (the document as it is now)", files: await versions.current() };
      let id: string = ref;
      if (r == "last_turn") {
        const last = await c.lastTurn();
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
};

/** open_page: moves the user's open editor to another page of the document (the pages themselves: ls, an operation of the server). */
const OPEN_PAGE: DocumentOperation = {
  name: "open_page",
  activity: "opening a page",
  description: "Opens another page in your user's editor tabs.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description:
        'The page\'s file ("blog/post.html") or its address under the document ("blog/post", "" for the home page). With no tab open, the answer gives its address',
    }),
  }),
  run: async (c, p: { path: string }) => text((await c.open(p.path)).message),
};

/** Every operation of the document, by name. */
export const OPERATIONS: readonly DocumentOperation[] = [...FILE_OPERATIONS, ...PAGE_OPERATIONS, OPEN_PAGE, DIFF_VERSIONS];

/** No operation has that name. */
export class NoSuchOperation extends Error {}

/** A call's file, for its presence and the lock: its `path`. */
const pathOf = (args: unknown): string | null => {
  const a = args as { path?: unknown } | null;
  return typeof a?.path == "string" ? a.path : null;
};

/**
 * Runs one operation by name, as the participant that `c` reaches for, with its arguments checked. Throws with a
 * message the caller can act on (no such operation, bad arguments, the operation's own error).
 */
export async function runOperation(c: Reach, name: string, args: unknown): Promise<ToolContent[]> {
  /** The operations as the user may use them now: someone who may only view the document has none that change it. */
  const mine = () =>
    OPERATIONS.filter((o) => c.canEdit() || !o.changes)
      .map((o) => o.name)
      .join(", ");
  const op = OPERATIONS.find((o) => o.name == name);
  if (!op) throw new NoSuchOperation(`There's no tool named "${name}". The tools are: ${mine()}.`);
  if (op.changes && !c.canEdit())
    throw new Error(`${c.user.name} can only view this document, so ${name} isn't one of the tools: they are ${mine()}.`);
  let params: Record<string, unknown>;
  try {
    params = Schema.decodeUnknownSync(op.parameters as Schema.Codec<Record<string, unknown>>)(args ?? {}, { errors: "all" });
  } catch (e) {
    throw new Error(`Validation failed for tool "${name}":\n${(e as Error).message}`);
  }
  const path = pathOf(params);
  return c.during({ activity: `${op.activity}${path ? ` ${path}` : ""}`, changes: !!op.changes }, () => op.run(c, params));
}

// ---------------------------------------------------------------- the tree: pages, folders and files, made, moved and deleted

/** What a tree operation did, its paths cleaned (a new page's with its extension). */
export type TreeDone = TreeOp;

/**
 * Checks a tree operation against the document as it is,
 * then does it in the room: a new page from the template, a new folder, a
 * move (or rename) of a file or folder, or a delete (a folder with all it
 * holds). The document's own page can't be moved or deleted. Throws a
 * TreeError saying what's wrong.
 */
export function runTreeOp(
  room: Room,
  raw: unknown,
  o: {
    /** Whose change it is. */
    by: Participant;
    index: string;
    only?: string;
    newPage?: string;
    unwait?: (path: string) => Promise<boolean>;
  }
): Effect.Effect<TreeDone, TreeError> {
  const fail = (message: string, status?: number) => Effect.fail(new TreeError(message, status));
  /** One of pages.ts's checks, which throw a TreeError. */
  const check = <A>(f: () => A) => Effect.try({ try: f, catch: (e) => (e instanceof TreeError ? e : new TreeError(String(e), 500)) });
  const done = (e: Effect.Effect<void, StoreError>) => Effect.mapError(e, (err) => new TreeError(`Couldn't do it: ${err.message}`, 500));
  return Effect.gen(function* () {
    if (!raw || typeof raw != "object" || Array.isArray(raw))
      return yield* fail('Send the operation as JSON: {"op": "new_page" | "new_folder" | "move" | "delete", ...}.');
    const op = raw as Record<string, unknown>;
    if (o.only != null)
      return yield* fail(
        `This document is the single file ${o.only}, opened from disk on its own: it can't hold other files or folders.`,
        403
      );
    const exists = (p: string) => room.exists(p);
    const free = (p: string) => {
      if (exists(p)) return fail(`There's already ${exists(p) == "folder" ? "a folder" : "a file"} at ${p}.`, 409);
      const file = parentsOf(p).find((d) => exists(d) == "file");
      return file ? fail(`${file} is a file, so nothing can go inside it.`, 409) : Effect.void;
    };
    switch (op.op) {
      case "new_page": {
        let path = yield* check(() => cleanTreePath(op.path));
        if (!isPage(path)) {
          if (/\.[^./]+$/.test(path)) return yield* fail(`A page is an .html file, not ${path}.`);
          path += ".html";
        }
        yield* check(() => checkNewName(path, "page"));
        yield* free(path);
        yield* done(room.create(path, o.newPage ?? PLAIN_PAGE, o.by));
        return { op: "new_page", path } as const;
      }
      case "new_folder": {
        const path = yield* check(() => cleanTreePath(op.path));
        yield* check(() => checkNewName(path, "folder"));
        yield* free(path);
        yield* done(room.mkdir(path, o.by));
        return { op: "new_folder", path } as const;
      }
      case "move": {
        const from = yield* check(() => cleanTreePath(op.from, "from"));
        let to = yield* check(() => cleanTreePath(op.to, "to"));
        const type = exists(from);
        if (!type) return yield* fail(`There's nothing at ${from}.`, 404);
        if (from == o.index) return yield* fail(`${from} is the document's own page: it can't be moved or renamed.`);
        // A page renamed without an extension keeps its own.
        if (type == "file" && isPage(from) && !/\.[^./]+$/.test(to)) to += from.slice(from.lastIndexOf("."));
        if (to == from) return { op: "move", from, to } as const;
        if (type == "folder" && to.startsWith(`${from}/`)) return yield* fail(`A folder can't go inside itself.`);
        const target = to;
        yield* check(() => checkNewName(target, type == "folder" ? "folder" : isPage(target) ? "page" : "file"));
        yield* free(to);
        yield* done(room.move(from, to, o.by));
        return { op: "move", from, to } as const;
      }
      case "delete": {
        const path = yield* check(() => cleanTreePath(op.path));
        if (path == o.index) return yield* fail(`${path} is the document's own page: it can't be deleted.`);
        // (A file on its way there, whose bytes haven't come: it's taken back.)
        if (!exists(path) && (yield* Effect.promise(async () => (await o.unwait?.(path)) ?? false))) return { op: "delete", path } as const;
        if (!exists(path)) return yield* fail(`There's nothing at ${path}.`, 404);
        yield* done(room.remove(path, o.by));
        return { op: "delete", path } as const;
      }
      default:
        return yield* fail(`There's no operation "${String(op.op)}": it's one of new_page, new_folder, move and delete.`);
    }
  });
}

/** A new page when there's no template: a heading to start from. */
const PLAIN_PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Untitled</title>\n</head>\n<body>\n<h1>Untitled</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n";
