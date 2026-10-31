// The operations inside one document, as a person does them in the editor: its name and address (the title card),
// its pages and folders (the page tree), its kind (the settings' Document/Project switch) and
// its versions (the settings' Versions). Each takes `document`; the editor's agent may leave it out for the one it's
// in (Caller.here). They reach the document's host through its Durable Object's calls (platform.docs), as the person,
// after the directory says they may.
//
// The text itself is edited over the room's socket (and by the document tools read, edit, write, grep...:
// agents/document/tools.ts), not here.

import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import type { DocRow } from "../directory/index.ts";
import type { ToolContent } from "../../document/agent.ts";
import type { DocName } from "../../document/api.ts";
import { nameOf } from "../../document/names.ts";
import { pageAddress, type TreeOp } from "../../document/pages.ts";
import { cleanFilePath } from "./documents.ts";
import { byLine } from "../../shared/attribution.ts";
import { readLines } from "../../shared/text-edits.ts";
import { type Caller, described, DOCUMENT, findDocument, iso, type Operation, OperationError, platformOf, str } from "./operation.ts";

const MAX_LINES = 2000,
  MAX_BYTES = 50 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The person as the document's host knows them (their carets, edits and renames). */
const personOf = (caller: Caller) => ({ id: caller.who.login.toLowerCase(), name: caller.name ?? caller.who.login });

/** A document's name, as get_title and rename_document answer it. */
function named(n: DocName, caller: Caller) {
  return {
    id: n.id,
    owner: n.owner,
    title: n.title,
    titleFollows: n.titleSet ? "set by someone" : "the page's first heading",
    slug: n.slug,
    slugFollows: n.slugSet ? "set by someone" : "the title",
    address: n.address,
    ...(caller.origin ? { url: caller.origin + n.address } : {}),
    titleSet: n.titleSet,
    slugSet: n.slugSet,
    always: `/d/${n.id}`,
  };
}

/** Whether the caller may change the document's files (and the document can change at all: not a single file from disk). */
const mayEdit = (caller: Caller, doc: DocRow) => caller.dir.may(caller.who, "edit", doc);

/** A tree operation, as an editor: the tree after it, or what's wrong. */
async function treeOp(caller: Caller, ref: unknown, op: TreeOp) {
  const doc = await findDocument(caller, ref, "edit");
  const r = await platformOf(caller).docs.treeOp(doc, op);
  if (!r.ok) throw new OperationError({ message: r.error, status: r.status });
  return { document: described(doc, caller), entries: r.entries, kind: r.kind };
}

const PATH = (what: string) => str(what);

const TO_DOCUMENT = Schema.optionalKey(
  str("Another document to put it in: its address (/<owner>/<slug>), its URL, its id, or the slug of one of yours (default: the same one).")
);

/**
 * cp, and mv into another document: `from` (a file; a folder with everything in it; "." for the whole document) to
 * `to` in `to_document` (else the same one), as a publish writes files: text as an edit, a blob by its ref, so no
 * bytes go through the agent. A file at the destination is replaced (the old one stays in the versions). `to` that
 * ends with "/", or names a folder there, takes it inside. A move then deletes what it copied.
 */
async function copyFiles(caller: Caller, args: Record<string, unknown>, move: boolean) {
  const platform = platformOf(caller);
  const other = args.to_document != null && String(args.to_document).trim() != "";
  const src = await findDocument(caller, args.document, move || !other ? "edit" : "open");
  const dst = other ? await findDocument({ ...caller, here: undefined }, args.to_document, "edit") : src;
  const raw = String(args.from ?? "").trim();
  const from = raw == "." || raw == "./" ? "" : cleanFilePath(raw);
  const snap = await platform.docs.snapshot(src);
  if (!snap) throw new OperationError({ message: "There's no such document.", status: 404 });
  const under = Object.keys(snap.files).filter((p) => !from || p == from || p.startsWith(`${from}/`));
  if (!under.length)
    throw new OperationError({ message: `There's no file or folder ${raw} in ${described(src, caller).address}.`, status: 404 });
  if (move && dst.id != src.id && under.includes(snap.index))
    throw new OperationError({
      message: `${snap.index} is ${described(src, caller).address}'s own page, which can't leave it: cp it instead (then delete_document, if the whole document should go).`,
      status: 400,
    });
  const there = dst.id == src.id ? Object.keys(snap.files) : await platform.docs.paths(dst);
  const rawTo = String(args.to ?? "").trim();
  const toDir = rawTo == "." || rawTo == "./" ? "" : rawTo.endsWith("/") ? cleanFilePath(rawTo) : null;
  const named = toDir == null ? cleanFilePath(rawTo) : null;
  const into = toDir ?? (named != null && there.some((p) => p.startsWith(`${named}/`)) ? named : null);
  const name = from.split("/").pop() ?? "";
  const target = into == null ? named! : [into, name].filter(Boolean).join("/");
  if (dst.id == src.id && (target == from || (from && target.startsWith(`${from}/`)) || !from))
    throw new OperationError({ message: `${raw} can't be copied onto itself, or into itself.`, status: 400 });
  const files = Object.fromEntries(
    under.map((p) => [[target, p.slice(from.length).replace(/^\//, "")].filter(Boolean).join("/"), snap.files[p]])
  );
  const by = byLine(caller.who.login.toLowerCase(), caller.who.via);
  const r = await platform.docs.publish(dst, files, [], by);
  const removed = move && !r.refused.length ? (await platform.docs.publish(src, {}, under, by)).removed : [];
  // A folder that moved goes whole, empty folders in it too.
  if (move && removed.length && !(from in snap.files)) await platform.docs.treeOp(src, { op: "delete", path: from });
  return {
    from: described(src, caller),
    to: described(dst, caller),
    written: r.written,
    replaced: r.written.filter((p) => there.includes(p)),
    ...(r.refused.length ? { refused: r.refused } : {}),
    ...(move ? { removed } : {}),
  };
}

export const EDITOR_OPERATIONS: Operation[] = [
  {
    name: "get_title",
    label: "Read the title",
    activity: "reading the title",
    ui: "The editor: the title, and the address under it",
    description:
      "A document's title (shown in the documents list and the browser tab) and its address, /<owner>/<slug>. Until someone sets them, the title follows the page's first heading and the slug follows the title. It is always reachable at /d/<id> too.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: async (args, caller) => named(nameOf(await findDocument(caller, args.document, "open")), caller),
  },
  {
    name: "rename_document",
    label: "Rename the document",
    activity: "renaming the document",
    ui: "The editor: the title, and the address under it (its pencil)",
    description:
      "Sets a document's title, its address slug (the last part of /<owner>/<slug>), or both. The slug is made from what you give (\"Q3 plan\" becomes \"q3-plan\"); one already used by another of the owner's documents is refused. An empty string goes back to following: the title the page's first heading, the slug the title. Old addresses keep redirecting, and everyone's open editor moves to the new one. Only rename when asked to; this doesn't change the page's text (edit its heading for that).",
    parameters: Schema.Struct({
      document: DOCUMENT,
      title: Schema.optionalKey(str('The new title ("" to follow the page\'s first heading).')),
      slug: Schema.optionalKey(str('The new address after /<owner>/ ("" to follow the title).')),
    }),
    run: async (args, caller) => {
      if (args.title === undefined && args.slug === undefined)
        throw new OperationError({ message: "Give a title, a slug, or both.", status: 400 });
      const doc = await findDocument(caller, args.document, "rename");
      const patch = {
        ...(typeof args.title == "string" ? { title: args.title } : {}),
        ...(typeof args.slug == "string" ? { slug: args.slug } : {}),
      };
      // Through the document's host, so its open tabs follow.
      const r = await platformOf(caller).docs.rename(doc, personOf(caller), patch);
      if (!r.ok) throw new OperationError({ message: r.error, status: 409 });
      return named(r.name, caller);
    },
  },
  {
    name: "list_pages",
    label: "List pages",
    activity: "looking at the pages",
    ui: "The editor's page tree, and each document's on the documents list (/docs)",
    description:
      "A document's pages, folders and other files, as its page tree shows them: each entry's path and type (page, folder or file), a page's title and address. Pages are the .html files; index.html is the home page. Also its kind (document: one page; project: pages), whether you may change it (canEdit), and the latest moves.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      const t = await platformOf(caller).docs.tree(doc);
      if (!t) throw new OperationError({ message: "There's no such document.", status: 404 });
      const home = nameOf(doc).address;
      return {
        document: described(doc, caller),
        kind: t.kind,
        canEdit: !t.single && (await mayEdit(caller, doc)),
        entries: t.entries.map((e) => {
          if (e.type != "page") return e;
          const rest = pageAddress(e.path);
          return { ...e, address: home + (rest ? `/${rest}` : "") };
        }),
        moved: t.moved,
      };
    },
  },
  {
    name: "ls",
    label: "List files",
    activity: "looking around",
    ui: "The page tree: every file",
    description:
      "Every file of a document under a folder (default: all of them): each one's path, kind (text, or a file kept whole), type, size in bytes and time; and the folders. Also the document's page (index), its kind, and whether you may change its files (canEdit).",
    parameters: Schema.Struct({ document: DOCUMENT, path: Schema.optionalKey(PATH("Only the files in this folder")) }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      const list = await platformOf(caller).docs.files(doc);
      if (!list) throw new OperationError({ message: "There's no such document.", status: 404 });
      const raw = typeof args.path == "string" ? args.path.replace(/^[./]+$/, "").replace(/^\.?\/+|\/+$/g, "") : "";
      const dir = raw ? `${cleanFilePath(raw)}/` : "";
      const inside = (p: string) => !dir || p.startsWith(dir);
      const files = list.files.filter((f) => inside(f.path));
      const folders = list.folders.filter(inside);
      if (dir && !files.length && !folders.length && !list.folders.includes(dir.slice(0, -1)))
        throw new OperationError({ message: `There's no folder ${dir.slice(0, -1)}.`, status: 404 });
      return {
        document: described(doc, caller),
        index: list.index,
        kind: list.kind,
        canEdit: !list.single && (await mayEdit(caller, doc)),
        files: files.map((f) => ({ ...f, at: iso(f.at) })),
        folders,
      };
    },
  },
  {
    name: "new_page",
    label: "New page",
    activity: "making a page",
    ui: "The page tree: New page",
    description:
      "Makes a new page from the new-page template, at a path like \"blog/post.html\" (folders it's in are made too; without an extension it's .html). Each page has its own address: blog/post.html is /<owner>/<slug>/blog/post, blog/index.html is /<owner>/<slug>/blog. Only a project has more than one page. Answers the tree after it.",
    parameters: Schema.Struct({ document: DOCUMENT, path: PATH('Path of the new page, e.g. "about.html" or "blog/index.html"') }),
    run: (args, caller) => treeOp(caller, args.document, { op: "new_page", path: String(args.path ?? "") }),
  },
  {
    name: "mkdir",
    label: "New folder",
    activity: "making a folder",
    ui: "The page tree: New folder",
    description: "Makes a folder (and any it's in). Empty folders stay until deleted. Answers the tree after it.",
    parameters: Schema.Struct({ document: DOCUMENT, path: PATH('Path of the folder, e.g. "blog/drafts"') }),
    run: (args, caller) => treeOp(caller, args.document, { op: "new_folder", path: String(args.path ?? "") }),
  },
  {
    name: "mv",
    label: "Move",
    activity: "moving",
    ui: "The page tree: Rename, and a drag to another folder",
    description:
      "Moves or renames a file or a folder (with everything in it). In one document, nothing may be at the destination already, and the document's own page (index.html at its root) can't be moved; answers the tree after it. With to_document, it goes into that document (images too, without their bytes through you), replacing what's there, and is deleted here; answers what was written. Moving a page changes its address: fix links to it in other pages.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      from: PATH("Path of the file or folder now"),
      to: PATH('Its new path, or a folder to put it in ("images/", or "." for the top)'),
      to_document: TO_DOCUMENT,
    }),
    run: (args, caller) =>
      args.to_document != null && String(args.to_document).trim() != ""
        ? copyFiles(caller, args, true)
        : treeOp(caller, args.document, { op: "move", from: String(args.from ?? ""), to: String(args.to ?? "") }),
  },
  {
    name: "cp",
    label: "Copy",
    activity: "copying",
    ui: "None yet",
    description:
      'Copies a file, a folder with everything in it, or a whole document ("."), within a document or into another (to_document), in one call: text and images alike, without their content through you. A file at the destination is replaced (the old one stays in the versions). E.g. a presentation into a project as its page: cp {"document": "/ada/deck", "from": "index.html", "to": "index.html", "to_document": "/ada/project"}, and its images with from "images", to "images". Answers what was written and replaced.',
    parameters: Schema.Struct({
      document: DOCUMENT,
      from: PATH('Path of the file or folder to copy, or "." for every file'),
      to: PATH('Its new path, or a folder to put it in ("images/", or "." for the top)'),
      to_document: TO_DOCUMENT,
    }),
    run: (args, caller) => copyFiles(caller, args, false),
  },
  {
    name: "rm",
    label: "Delete",
    activity: "deleting",
    ui: "The page tree: Delete",
    description:
      "Deletes a file, or a folder with everything in it. The document's own page (index.html at its root) can't be deleted. Only delete what you were asked to. Answers the tree after it.",
    parameters: Schema.Struct({ document: DOCUMENT, path: PATH("Path of the file or folder") }),
    run: (args, caller) => treeOp(caller, args.document, { op: "delete", path: String(args.path ?? "") }),
  },
  {
    name: "make_project",
    label: "Make a project",
    activity: "making it a project",
    ui: "The editor's settings: Document/Project",
    description:
      "Makes a document a project: a folder of pages, each with its own address, instead of one page with files beside it. Only a project can have more than one page. make_document turns it back while it has one page. Only when the person asks for it, or agrees to it.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: (args, caller) => treeOp(caller, args.document, { op: "make_project" }),
  },
  {
    name: "make_document",
    label: "Make a document",
    activity: "making it a document",
    ui: "The editor's settings: Document/Project",
    description:
      "Makes a project a document again: one page (index.html) and any other files beside it. Only a project with one page, its index.html, can: delete its other pages first (rm), and only when the person asks. Other files (images, styles) stay.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: (args, caller) => treeOp(caller, args.document, { op: "make_document" }),
  },
  {
    name: "list_versions",
    label: "List versions",
    activity: "looking at versions",
    ui: "The editor's settings: Versions, and Show older versions",
    description:
      "A document's versions, newest first: each one's id (v1, v2...), number, when it was cut, who edited, and a short description; the current one; the total; whether there are edits since the current one (pending); and whether you may restore one (canEdit). A version is a snapshot of every file, cut after a burst of edits. Viewers always see the document as it is now.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      before: Schema.optionalKey(str('Only versions older than this one (its id, e.g. "v12"), to page back')),
      limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many (default 10, at most 100)" })),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      const state = await platformOf(caller).docs.versions(doc, {
        before: typeof args.before == "string" ? args.before : null,
        limit: typeof args.limit == "number" ? args.limit : undefined,
      });
      if (!state) throw new OperationError({ message: "There's no such document.", status: 404 });
      return { ...state, canEdit: await mayEdit(caller, doc) };
    },
  },
  {
    name: "read_version",
    label: "Read a version",
    activity: "reading an old version",
    ui: "The editor's settings: Versions (each version's files)",
    description: `Reads an old version of a document. Without path: its details and files. With path: that file's text as it was in that version (cut to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit), or the picture for an image. To bring an old version, or one file of it, back, use restore_version.`,
    parameters: Schema.Struct({
      document: DOCUMENT,
      version: str('The version\'s id ("v3") or number'),
      path: Schema.optionalKey(str("A file in it, relative to the document's folder")),
      offset: Schema.optionalKey(Schema.Finite.annotate({ description: "Line number to start reading from (1-indexed)" })),
      limit: Schema.optionalKey(Schema.Finite.annotate({ description: "Maximum number of lines to read" })),
    }),
    run: async (args, caller): Promise<object | ToolContent[]> => {
      const doc = await findDocument(caller, args.document, "open");
      const docs = platformOf(caller).docs;
      const ref = String(args.version ?? "");
      const v = await docs.version(doc, ref);
      if (!v) throw new OperationError({ message: `There's no version "${ref}": list_versions shows them.`, status: 404 });
      if (typeof args.path != "string" || !args.path) return v;
      const path = args.path.replace(/^\.?\//, "");
      const bytes = await docs.versionFile(doc, v.id, path);
      if (!bytes)
        throw new OperationError({ message: `${v.id} has no file ${path}. Its files: ${v.files.slice(0, 50).join(", ")}`, status: 404 });
      if (IMAGE.test(path)) return [{ type: "image", data: Base64.encode(bytes), mimeType: MIME[path.split(".").pop()!.toLowerCase()] }];
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        return [{ type: "text", text: `${path} in ${v.id} is a binary file of ${bytes.length} bytes.` }];
      }
      const out = readLines(
        body,
        typeof args.offset == "number" ? args.offset : 1,
        typeof args.limit == "number" ? args.limit : MAX_LINES,
        MAX_BYTES
      );
      return [{ type: "text", text: out }];
    },
  },
  {
    name: "restore_version",
    label: "Restore a version",
    activity: "restoring a version",
    ui: "The editor's settings: Versions, a version's Edit",
    description:
      "Brings an old version back: its files are written over the document as it is now (files it didn't have are deleted), which everyone editing sees at once, and that becomes a new version, the current one. With path, only that file comes back, and the other files stay as they are: prefer this when only one file needs it. Nothing is lost: edits not yet in a version become one first, and every version stays. Answers the new current version and the files restored: read them again before you edit them. Only someone who may edit the document may; only when asked.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      version: str('The version\'s id ("v3") or number'),
      path: Schema.optionalKey(str("Only this file, relative to the document's folder (it must be in that version)")),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "edit");
      const path = typeof args.path == "string" && args.path ? args.path : null;
      // A person's restore is theirs; an agent's is its person's, via it ("ada, via their agent").
      const r = await platformOf(caller).docs.restore(
        doc,
        String(args.version ?? ""),
        byLine(caller.who.login.toLowerCase(), caller.who.via),
        path
      );
      if (!r.ok) throw new OperationError({ message: r.error, status: r.status });
      return { current: r.current, from: r.from, files: r.files };
    },
  },
];
