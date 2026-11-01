// The operations on documents as wholes: who you are, the documents list (/docs: list, make, delete), sharing (the
// Share dialogs of the list and the editor), publishing files into one, and an admin's search of everyone's. What a
// person does inside one document (its name, pages, files and versions) is editor.ts's; its text is edited over the
// room's socket, and by the document tools (agents/document/tools.ts), which agents/tools.ts offers for any document.

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { ANYONE, type DocRow, type Grant, newDocId, NO_WRITE } from "../directory/index.ts";
import { makeDoc, startingFiles } from "../documents/index.ts";
import { TEMPLATES, templateById } from "../pages/index.ts";
import type { FileData } from "../../document/document.ts";
import { cleanRel, isDocKind, type DocKind } from "../../document/pages.ts";
import { byLine } from "../../shared/attribution.ts";
import {
  type Caller,
  described,
  DOCUMENT,
  findDocument,
  iso,
  type Operation,
  OperationError,
  platformOf,
  str,
} from "./operation.ts";
import { addressOf } from "../../document/names.ts";

/** Files as a caller gives them: by path, each text or base64. */
const FILES = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String })])).annotate({
  description:
    'Files by path relative to the document\'s folder ("index.html", "css/app.css"): each a string of text, or {"base64": "..."} for any other file (images, fonts).',
});
const ANY_DOCUMENT = str("The document: its address (/<owner>/<slug>), its URL, its id, or the slug of one of yours.");

export const DOCUMENT_OPERATIONS: Operation[] = [
  {
    name: "whoami",
    label: "Who you are",
    ui: "The account menu: who is signed in",
    description:
      "Who you act for: their login and name, the server, how you act (in person, or through which agent), whether you have admin power here, and for an agent token its label, scope, document (for the document scope) and expiry.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const { who, token } = caller;
      return {
        login: who.login,
        ...(caller.name ? { name: caller.name } : {}),
        ...(caller.origin ? { server: caller.origin } : {}),
        ...(who.via ? { via: who.via } : {}),
        adminPower: await caller.dir.users.actsAsAdmin(who),
        ...(token
          ? {
              token: {
                id: token.id,
                label: token.label,
                scope: token.scope,
                ...(token.docId ? { document: token.docId } : {}),
                expires: iso(token.expires),
              },
            }
          : {}),
      };
    },
  },
  {
    name: "list_documents",
    label: "List documents",
    activity: "listing the documents",
    wide: true,
    ui: "Documents (/docs): the list",
    description:
      "The person's documents, as the documents list (/docs) shows them, most recently edited first: their own and the ones shared with them. Each one's id, title, address, URL, whose it is, their role in it, when it was last edited, and when it goes if nobody edits it (only for never-edited ones).",
    parameters: Schema.Struct({}),
    run: async (_args, caller) =>
      (await platformOf(caller).docs.list(caller.who.login.toLowerCase())).map((d) => ({
        id: d.id,
        title: d.title,
        address: addressOf(d),
        ...(caller.origin ? { url: `${caller.origin}/${d.owner}/${d.slug}` } : {}),
        owner: d.owner,
        role: d.role,
        modified: iso(d.modified),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.expires != null ? { expires: iso(d.expires) } : {}),
        ...(d.path != null ? { onDisk: d.path } : {}),
        ...(d.id == caller.here ? { here: true } : {}),
      })),
  },
  {
    name: "create_document",
    label: "Make a document",
    activity: "making a document",
    wide: true,
    loose: true,
    ui: "Documents (/docs): New, from a template or a copy; the viewer's Clone; publishing a folder of files",
    description: `Makes a new document for the person and answers its address and URL. With files, it's those files (publishing a site or a page: a folder with index.html, plus its styles, scripts and images), and it stays. Without files it's a blank page (the default), a template (${TEMPLATES.map((t) => `"${t.id}": ${t.description}`).join(" ")} "landing": a copy of the server's homepage), or a copy of a document they may open (from), which goes if nobody edits it in time (the server's delete_docs_after_hours setting; the answer says when). The title follows the page's first heading unless you give one; the address (/<owner>/<slug>) follows the title unless you give a slug.`,
    parameters: Schema.Struct({
      files: Schema.optionalKey(FILES),
      index: Schema.optionalKey(str("The page, if it isn't index.html: an .html file among the files.")),
      title: Schema.optionalKey(str("Its title (else the page's first heading).")),
      slug: Schema.optionalKey(
        str("Its address after /<owner>/ (letters, digits and dashes; else made from the title). Taken already, it gets -2, -3...")
      ),
      template: Schema.optionalKey(
        Schema.String.annotate({
          enum: ["blank", ...TEMPLATES.map((t) => t.id), "landing"],
          description:
            "Without files: a blank page (blank or page, the default), another template, or a copy of the server's homepage (landing).",
        })
      ),
      from: Schema.optionalKey(
        str("Without files: a document to copy instead (its address, URL or id). It copies the document as it is now.")
      ),
      kind: Schema.optionalKey(
        Schema.String.annotate({
          enum: ["document", "project"],
          description:
            "document: one page and any files beside it; project: a folder of pages, each with its own address. Else the kind of the document copied, or from the files: a project if they have more than one page.",
        })
      ),
    }),
    run: async (args, caller) => {
      const { who } = caller,
        platform = platformOf(caller);
      // Anyone who may sign in may make documents; test people only test documents.
      if (who.test) throw new OperationError({ message: "You can't make documents on this server.", status: 403 });
      let files: Record<string, FileData> = decodeFiles(args.files);
      const published = Object.keys(files).length > 0;
      let index: string;
      let startKind: DocKind | undefined;
      let from: string | null = null;
      if (published) index = pageOf(files, args.index);
      else {
        const named = typeof args.template == "string" && args.template.trim() && args.template != "blank" ? args.template.trim() : null;
        if (named && args.from)
          throw new OperationError({ message: "Give a template or a document to copy (from), not both.", status: 400 });
        const template = named && named != "landing" ? templateById(named) : undefined;
        if (named && named != "landing" && !template)
          throw new OperationError({
            message: `There's no template "${named}": ${TEMPLATES.map((t) => t.id).join(", ")}, or landing.`,
            status: 400,
          });
        from = args.from
          ? (await findDocument({ ...caller, here: undefined }, args.from, "open")).id
          : named == "landing"
            ? "landing"
            : null;
        const start = await startingFiles(platform, from, who, template);
        if (!start)
          throw new OperationError({
            message: from == "landing" ? "This server has no homepage (landing document) to copy." : "There's nothing there you can copy.",
            status: 404,
          });
        ({ files, index } = start);
        startKind = start.kind;
      }
      if (!(await caller.dir.mayWrite(who.login))) throw new OperationError({ message: NO_WRITE, status: 403 });
      for (let tries = 0; tries < 5; tries++) {
        const doc = await makeDoc(platform, who.login.toLowerCase(), newDocId(), files, {
          index,
          published,
          title: optString(args.title, "title"),
          slug: optString(args.slug, "slug"),
          kind: isDocKind(args.kind) ? args.kind : startKind,
        });
        if (doc)
          return {
            ...described(doc, caller),
            page: index,
            files: Object.keys(files).sort(),
            ...(from ? { from } : {}),
            ...(published || doc.expires == null ? {} : { expires: `${iso(doc.expires)}, unless someone edits it` }),
          };
      }
      throw new OperationError({ message: "Couldn't pick an address for it: try again.", status: 500 });
    },
  },
  {
    name: "delete_document",
    label: "Delete a document",
    activity: "deleting a document",
    ui: "Documents (/docs): Delete",
    description:
      "Deletes one of the person's documents for good, as Delete on the documents list does (only its owner may). A document that's a folder on disk (local development) only comes off the list. The editor's agent can't delete the document it's in: the person deletes that one on the documents list (/docs). Only delete when the person asks, naming the document.",
    parameters: Schema.Struct({ document: ANY_DOCUMENT }),
    run: async (args, caller) => {
      const doc = await findDocument({ ...caller, here: undefined }, args.document, "delete");
      if (doc.id == caller.here)
        throw new OperationError({
          message: "That's the document you're in: the person deletes it on the documents list (/docs).",
          status: 409,
        });
      const platform = platformOf(caller);
      if (!(await platform.docs.delete(doc))) await platform.directory.remove(doc.id);
      return { deleted: described(doc, caller) };
    },
  },
  {
    name: "document_access",
    label: "Who has access",
    activity: "checking who has access",
    ui: "Share (the documents list and the editor): who it's shared with",
    description:
      "Who a document is shared with: its owner, and everyone given a role (editor or viewer; \"*\" is anyone with the link), each one's picture, who of them can't sign in on this server yet (notUsers), and whether the server lets users share content publicly. Only its owner may see this.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: async (args, caller) => shareAnswer(caller, await findDocument(caller, args.document, "share")),
  },
  {
    name: "share_document",
    label: "Share the document",
    activity: "sharing the document",
    ui: "Share (the documents list and the editor): give someone a role, change it, or stop sharing",
    description:
      'Shares a document (only its owner may): gives someone the role of editor (may edit and rename it) or viewer (may only look), or takes theirs away with role "none". login "*" means anyone with the link: anyone signed in, and people who aren\'t signed in too (as viewers); the server refuses it, saying why, unless it lets users share content publicly (the Access page). Answers who has access now.',
    parameters: Schema.Struct({
      document: DOCUMENT,
      login: str(
        'Whose role to set: a GitHub login, or "*" for anyone with the link (only while the server lets users share content publicly)'
      ),
      role: Schema.Literals(["editor", "viewer", "none"]).annotate({ description: "editor, viewer, or none to stop sharing it with them" }),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "share");
      await caller.dir.share(
        caller.who,
        doc.id,
        String(args.login ?? "")
          .trim()
          .replace(/^@/, ""),
        args.role == "none" || !args.role ? null : (args.role as Grant)
      );
      return shareAnswer(caller, doc);
    },
  },
  {
    name: "update_files",
    loose: true,
    ui: "An HTTP client's publish (POST /api/publish)",
    description:
      "Publishes files into an existing document: each replaces the file as it is now, as an edit (open editors show it at once, and anyone's undo history stays). replace: true also deletes every file not given (the page itself stays), for publishing a site again. delete removes the files named.",
    parameters: Schema.Struct({
      document: ANY_DOCUMENT,
      files: Schema.optionalKey(FILES),
      delete: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Paths of files to delete." })),
      replace: Schema.optionalKey(Schema.Boolean.annotate({ description: "Delete every file that isn't in files (except the page)." })),
    }),
    run: async (args, caller) => {
      const platform = platformOf(caller);
      const doc = await findDocument(caller, args.document, "edit");
      const files = decodeFiles(args.files);
      const remove = new Set(stringList(args.delete, "delete").map((p) => cleanFilePath(p)));
      if (args.replace === true) for (const p of await platform.docs.paths(doc)) if (!(p in files)) remove.add(p);
      if (!Object.keys(files).length && !remove.size)
        throw new OperationError({ message: "Nothing to do: give files, delete, or replace.", status: 400 });
      const r = await platform.docs.publish(doc, files, [...remove], byLine(caller.who.login.toLowerCase(), caller.who.via));
      return { ...described((await platform.directory.get(doc.id)) ?? doc, caller), ...r };
    },
  },
  {
    name: "search_documents",
    label: "Find a document or project on the server",
    activity: "finding a document or project",
    admin: true,
    ui: "Settings (/admin): the Homepage Project picker",
    description:
      "Admins only. Finds any of the server's documents and projects, everyone's, by a part of its title, its owner, its address (/<owner>/<slug>) or its id, as the Homepage Project setting's picker on /admin does; most recently edited first. Each: its id, title, owner, address and kind (document or project). To make one the homepage, give its address or id to set_setting with the key landing_document.",
    parameters: Schema.Struct({
      query: str("A part of the title, owner or address; empty: the most recently edited"),
      limit: Schema.optionalKey(Schema.Int.annotate({ description: "At most this many (default 20, at most 100)" })),
    }),
    run: async (args, { dir, who }) => ({ found: await dir.search(who, String(args.query ?? ""), Number(args.limit) || 20) }),
  },
];

/** The person's tokens, as /settings shows them. */
export const TOKEN_OPERATIONS: Operation[] = [
  {
    name: "list_tokens",
    label: "List agent tokens",
    activity: "listing the agent tokens",
    wide: true,
    ui: "Settings (/settings): your agent tokens, Share with agent's too",
    description:
      "The person's agent tokens (never the tokens themselves): id, label, kind, scope, when made, when they expire and when last used.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) =>
      (await platformOf(caller).tokens.list(caller.who.login)).map((t) => ({
        id: t.id,
        label: t.label,
        kind: t.kind,
        scope: t.scope,
        ...(t.docId ? { document: t.docId } : {}),
        expires: iso(t.expires),
        created: iso(t.created),
        lastUsed: iso(t.lastUsed),
        ...(t.id == caller.token?.id ? { yours: true } : {}),
      })),
  },
  {
    name: "revoke_token",
    label: "Revoke an agent token",
    activity: "revoking an agent token",
    wide: true,
    ui: "Settings (/settings): Revoke",
    description:
      "Turns one of the person's agent tokens off, by id (list_tokens), as Revoke on /settings does: agents using it lose access at once. Revoking your own ends your access. Only when the person asks, naming the token.",
    parameters: Schema.Struct({ id: str("The token's id.") }),
    run: async (args, caller) => {
      if (!(await platformOf(caller).tokens.revoke(caller.who.login, String(args.id ?? ""), caller.who.via)))
        throw new OperationError({ message: `You have no token "${args.id}".`, status: 404 });
      return { revoked: args.id };
    },
  },
];

/** Who a document is shared with, as the Share dialogs show it. */
async function shareAnswer(caller: Caller, doc: DocRow) {
  const { dir } = caller;
  const permissions = await dir.permissions(doc.id);
  const notUsers = (
    await Promise.all(permissions.map(async (p) => (p.login == ANYONE || (await dir.users.allowed(p.login)) ? null : p.login)))
  ).filter((l) => l != null);
  return {
    document: described(doc, caller),
    permissions: permissions.map((p) => ({
      login: p.login,
      role: p.role,
      ...(p.login == ANYONE
        ? {
            means:
              "anyone with the link: anyone signed in, and, while the server lets users share content publicly, people who aren't signed in too (as viewers)",
          }
        : {}),
      granted: iso(p.granted),
      ...(p.grantedBy ? { grantedBy: p.grantedBy } : {}),
      ...(p.grantedVia ? { grantedVia: p.grantedVia } : {}),
    })),
    notUsers,
    avatars: await dir.users.avatars(permissions.map((p) => p.login)),
    publicSharing: await dir.config.get("public_sharing"),
  };
}

const MAX_FILE = 2_000_000,
  MAX_TOTAL = 50_000_000,
  MAX_FILES = 2000;

/** A file's path as a caller gives it, inside the document. */
export function cleanFilePath(p: string): string {
  const rel = cleanRel(p);
  if (!rel)
    throw new OperationError({
      message: `"${p}" isn't a path inside the document (no "..", no hidden files or node_modules).`,
      status: 400,
    });
  return rel;
}

/** Files as operations take them: text, or {base64} for anything else. */
function decodeFiles(raw: unknown): Record<string, string | Uint8Array> {
  if (raw == null) return {};
  if (typeof raw != "object" || Array.isArray(raw))
    throw new OperationError({ message: "files must be an object of paths to contents.", status: 400 });
  const out: Record<string, string | Uint8Array> = {};
  let total = 0;
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    const rel = cleanFilePath(path);
    let data: string | Uint8Array;
    if (typeof v == "string") data = v;
    else if (v && typeof v == "object" && typeof (v as { base64?: unknown }).base64 == "string") {
      const bytes = Base64.decode((v as { base64: string }).base64.replace(/\s+/g, ""));
      if (Result.isFailure(bytes)) throw new OperationError({ message: `${path}: that isn't base64.`, status: 400 });
      data = bytes.success;
    } else if (v && typeof v == "object" && typeof (v as { text?: unknown }).text == "string") data = (v as { text: string }).text;
    else throw new OperationError({ message: `${path}: give its text as a string, or {"base64": "..."}.`, status: 400 });
    total = addFile(out, rel, data, total);
  }
  return out;
}

/** Adds a file to `out`, within the limits; answers the total size so far. */
export function addFile(out: Record<string, string | Uint8Array>, rel: string, data: string | Uint8Array, total: number): number {
  const size = typeof data == "string" ? new TextEncoder().encode(data).length : data.length;
  if (size > MAX_FILE)
    throw new OperationError({ message: `${rel} is ${(size / 1e6).toFixed(1)}MB: files can be at most ${MAX_FILE / 1e6}MB.`, status: 413 });
  total += size;
  if (total > MAX_TOTAL) throw new OperationError({ message: `That's more than ${MAX_TOTAL / 1e6}MB of files.`, status: 413 });
  out[rel] = data;
  if (Object.keys(out).length > MAX_FILES) throw new OperationError({ message: `That's more than ${MAX_FILES} files.`, status: 413 });
  return total;
}

/** The document's page among the files: the one named, else index.html. */
function pageOf(files: Record<string, unknown>, named: unknown): string {
  if (named != null && typeof named != "string") throw new OperationError({ message: "index must be a path.", status: 400 });
  const index = named ? cleanFilePath(named) : "index.html" in files ? "index.html" : null;
  if (!index)
    throw new OperationError({
      message: `There's no page: include index.html, or name the page with "index". The files: ${Object.keys(files).slice(0, 20).join(", ")}.`,
      status: 400,
    });
  if (!/\.html?$/i.test(index)) throw new OperationError({ message: `The page must be an .html file, not ${index}.`, status: 400 });
  if (!(index in files)) throw new OperationError({ message: `${index} isn't among the files.`, status: 400 });
  return index;
}

const optString = (v: unknown, what: string): string | undefined => {
  if (v == null) return undefined;
  if (typeof v != "string") throw new OperationError({ message: `${what} must be a string.`, status: 400 });
  return v;
};
const stringList = (v: unknown, what: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x != "string"))
    throw new OperationError({ message: `${what} must be a list of paths.`, status: 400 });
  return v as string[];
};
