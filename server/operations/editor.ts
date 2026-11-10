// The operations inside one document, as a person does them in the editor: what it is (ls: its name and address,
// kind, homepage, access, files and pages), its name (the title card), its pages and folders (the page tree), its kind
// (the settings' Document/Project switch), a page's head (the settings' Page) and its versions (the settings' Versions). Each takes `document`; the
// person's own agent may leave it out for the one open on their page (Caller.here). They reach the document's host
// through its Durable Object's calls (platform.docs), as the person, after the directory says they may.
//
// The text itself is edited over the room's socket (and by the document tools read, edit, grep...:
// agents/document/tools.ts), not here. Two calls run there, as the person's agent, since only the host knows what
// they need: write's one file (its differences, one undo step: documents.ts) and versions' diff (from "last_turn").

import * as Schema from "effect/Schema";
import type { DocRow } from "../directory/index.ts";
import type { DocName } from "../../document/api.ts";
import { EDITORS_READ_VERSIONS } from "../../document/content.ts";
import { nameOf } from "../../document/names.ts";
import { pageAddress, type TreeOp } from "../../document/pages.ts";
import { globToRegExp } from "../../shared/glob.ts";
import { accessOf, cleanFilePath, readersOf } from "./documents.ts";
import { homepageOf } from "./home.ts";
import { byLine } from "../../shared/attribution.ts";
import { HEAD_FIELDS, headOf, withHead, type PageHead } from "../../shared/page-head.ts";
import {
  type Caller,
  described,
  DOCUMENT,
  findDocument,
  iso,
  type Operation,
  OperationError,
  platformOf,
  runInDocument,
  str,
} from "./operation.ts";

/** The person as the document's host knows them (their carets, edits and renames). */
const personOf = (caller: Caller) => ({ id: caller.who.login.toLowerCase(), name: caller.name ?? caller.who.login });

/** A document's name, as ls and rename_document answer it. */
function named(n: DocName, caller: Caller) {
  return {
    id: n.id,
    owner: n.owner,
    title: n.title,
    slug: n.slug,
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
const TO = PATH("Its new path or folder.");
const TO_DOCUMENT = Schema.optionalKey(str("Another document."));
const VERSION = str('A version, e.g. "v3".');

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
    name: "ls",
    label: "Look at the document",
    activity: "looking around",
    ui: "The editor: the title and address; a project's tree (the documents list, the crumbs); the editor's settings: Document/Project, Homepage, Readers; Share: who has access",
    description: "A document's name, kind, access, files and pages.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      path: Schema.optionalKey(PATH("Only what is in this folder")),
      glob: Schema.optionalKey(str('Only matching paths, e.g. "**/*.css".')),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      const docs = platformOf(caller).docs;
      const [tree, list, homepage, owner] = await Promise.all([
        docs.tree(doc),
        docs.files(doc),
        homepageOf(caller, doc),
        caller.dir.may(caller.who, "share", doc),
      ]);
      const canEdit = !tree?.single && (await mayEdit(caller, doc));
      if (!tree || !list) throw new OperationError({ message: "There's no such document.", status: 404 });
      const raw = typeof args.path == "string" ? args.path.replace(/^[./]+$/, "").replace(/^\.?\/+|\/+$/g, "") : "";
      const dir = raw ? `${cleanFilePath(raw)}/` : "";
      if (dir && !tree.entries.some((e) => e.path.startsWith(dir) || e.path == dir.slice(0, -1)))
        throw new OperationError({ message: `There's no folder ${dir.slice(0, -1)}.`, status: 404 });
      const only = typeof args.glob == "string" && args.glob ? globToRegExp(args.glob) : null;
      const stats = new Map(list.files.map((f) => [f.path, f]));
      const home = nameOf(doc).address;
      const entries = tree.entries
        .filter((e) => (!dir || e.path.startsWith(dir)) && (!only || only.test(e.path)))
        .map((e) => {
          const f = stats.get(e.path);
          const rest = e.type == "page" ? pageAddress(e.path) : null;
          return {
            ...e,
            ...(rest != null ? { address: home + (rest ? `/${rest}` : "") } : {}),
            ...(f ? { kind: f.kind, mime: f.type, size: f.size, at: iso(f.at) } : {}),
          };
        });
      return {
        ...named(nameOf(doc), caller),
        kind: tree.kind,
        index: list.index,
        canEdit,
        ...(homepage ? { homepage } : {}),
        ...(owner ? { access: await accessOf(caller, doc) } : canEdit ? { access: await readersOf(caller, doc) } : {}),
        entries,
        moved: tree.moved,
      };
    },
  },
  {
    name: "rename_document",
    label: "Rename the document",
    activity: "renaming the document",
    ui: "The editor: the title, and the address under it (its pencil)",
    description: "Sets a document's title, slug or both.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      title: Schema.optionalKey(str('"": the first heading.')),
      slug: Schema.optionalKey(str('"": from the title.')),
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
    name: "new",
    label: "New page or folder",
    activity: "making a page",
    ui: "The page tree: New page, New folder",
    description: "Makes a page, or a folder (a path ending in /).",
    parameters: Schema.Struct({
      document: DOCUMENT,
      path: PATH('e.g. "about.html" or "blog/".'),
    }),
    run: (args, caller) => {
      const path = String(args.path ?? "").trim();
      return treeOp(
        caller,
        args.document,
        path.endsWith("/") ? { op: "new_folder", path: path.replace(/\/+$/, "") } : { op: "new_page", path }
      );
    },
  },
  {
    name: "mv",
    label: "Move",
    activity: "moving",
    ui: "The page tree: Rename, and a drag to another folder",
    description: "Moves or renames a file or folder.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      from: PATH("The file or folder."),
      to: PATH("Its new path or folder."),
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
    description: "Copies a file or folder.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      from: PATH('The file or folder ("." for all).'),
      to: TO,
      to_document: TO_DOCUMENT,
    }),
    run: (args, caller) => copyFiles(caller, args, false),
  },
  {
    name: "rm",
    label: "Delete",
    activity: "deleting",
    ui: "The page tree: Delete",
    description: "Deletes a file or folder.",
    parameters: Schema.Struct({ document: DOCUMENT, path: PATH("The file or folder") }),
    run: (args, caller) => treeOp(caller, args.document, { op: "delete", path: String(args.path ?? "") }),
  },
  {
    name: "set_kind",
    label: "Change the kind",
    activity: "changing the kind",
    ui: "The editor's settings: Document/Project",
    description: "Makes a document a project, or back.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      kind: Schema.Literals(["project", "document"]).annotate({
        description: "project: pages; document: one page.",
      }),
    }),
    run: (args, caller) => {
      if (args.kind != "project" && args.kind != "document")
        throw new OperationError({ message: "kind is project or document.", status: 400 });
      return treeOp(caller, args.document, { op: args.kind == "project" ? "make_project" : "make_document" });
    },
  },
  {
    name: "set_head",
    label: "Set the page's details",
    activity: "setting the page's details",
    ui: "The editor's settings: Page, Details (the page's title, description, icon and link picture)",
    description: "Sets a page's title, description, icon or link picture.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      path: Schema.optionalKey(PATH("The page (default: the document's own).")),
      title: Schema.optionalKey(str("The browser tab's title, and a link's; \"\" removes it.")),
      description: Schema.optionalKey(str("A sentence or two for search results and link previews.")),
      icon: Schema.optionalKey(str("The tab's icon: a file of the document (relative to the page) or a URL.")),
      image: Schema.optionalKey(str("The picture a link to the page shows (og:image): a file or a URL.")),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "edit");
      const changes: PageHead = {};
      for (const f of HEAD_FIELDS) if (typeof args[f] == "string") changes[f] = args[f];
      if (!Object.keys(changes).length)
        throw new OperationError({ message: "Give at least one of title, description, icon and image.", status: 400 });
      const platform = platformOf(caller);
      const snap = await platform.docs.snapshot(doc);
      if (!snap) throw new OperationError({ message: "There's no such document.", status: 404 });
      const path = typeof args.path == "string" && args.path.trim() ? cleanFilePath(args.path) : snap.index;
      const text = snap.files[path];
      if (!/\.html?$/i.test(path) || typeof text != "string")
        throw new OperationError({
          message: `${path} isn't a page of ${described(doc, caller).address}: only a page has these.`,
          status: 404,
        });
      // The page's <head> as it should be: only its differences reach the room, as an edit (open editors show it).
      const now = withHead(text, changes);
      if (now != text) {
        const r = await platform.docs.publish(doc, { [path]: now }, [], byLine(caller.who.login.toLowerCase(), caller.who.via));
        if (r.refused.length) throw new OperationError({ message: r.refused[0].why, status: 409 });
      }
      return { document: described(doc, caller), path, head: headOf(now) };
    },
  },
  {
    name: "versions",
    label: "Versions",
    activity: "looking at versions",
    ui: "The editor's settings: Versions, and Show older versions",
    description: "Lists versions; with from or to, a diff.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      before: Schema.optionalKey(str("Only older ones.")),
      limit: Schema.optionalKey(Schema.Finite.annotate({ description: "How many (default 10)." })),
      from: Schema.optionalKey(str('A version, or "last_turn" (the default).')),
      to: Schema.optionalKey(str('A version, or "current" (the default).')),
      path: Schema.optionalKey(str("Only this file or folder.")),
      context: Schema.optionalKey(Schema.Finite),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      // A version may hold text that its authors removed before they shared the document: for those who may edit only.
      if (!(await mayEdit(caller, doc))) throw new OperationError({ message: EDITORS_READ_VERSIONS, status: 403 });
      // A diff in the document's host: only it knows where this agent's last turn ended.
      if (args.from != null || args.to != null) {
        const { from, to, path, context } = args;
        return runInDocument(caller, doc, "diff_versions", { from, to, path, context });
      }
      const state = await platformOf(caller).docs.versions(doc, {
        before: typeof args.before == "string" ? args.before : null,
        limit: typeof args.limit == "number" ? args.limit : undefined,
      });
      if (!state) throw new OperationError({ message: "There's no such document.", status: 404 });
      return { ...state, canEdit: true };
    },
  },
  {
    name: "restore_version",
    label: "Restore a version",
    activity: "restoring a version",
    ui: "The editor's settings: Versions, a version's Restore",
    description: "Brings back a version, or one file of it.",
    parameters: Schema.Struct({
      document: DOCUMENT,
      version: VERSION,
      path: Schema.optionalKey(str("Only this file.")),
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
