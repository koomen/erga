// The operations on documents as wholes: who you are (your tokens, keys and Erga's pages too), the documents list
// (/docs: list, make, delete; an admin's search of everyone's), sharing (the Share dialogs of the list and the editor,
// and the readers' options), writing files into one, and revoking a token or a key. What a person does inside one
// document (its name, pages, files and versions) is editor.ts's; its text is edited over the room's socket, and by the
// document tools (agents/document/tools.ts), which agents/tools.ts offers for any document.

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
  ANY_DOCUMENT,
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
import { sitePages } from "./pages.ts";
import { addressOf } from "../../document/names.ts";
import { DEFAULT_PAGE_LLM_MODEL, isPageLlmModel, PAGE_LLM_MODELS } from "../../shared/models.ts";

/** Files as a caller gives them: by path, each text or base64. */
const FILES = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String })])).annotate({
  description: 'Each path\'s text, or {"base64": "..."} for bytes.',
});

/**
 * How to write a page people can keep editing by hand (agents/document/PROMPT.md, short): in MCP's instructions
 * (server/api.ts), once, not in each tool that writes a page.
 */
export const PAGE_RULES =
  "People keep editing pages by hand, and the editor locks text that doesn't match its source: write well-formed HTML (close every element, </p> and </li> too); keep text in plain leaf elements (p, h1-h6, li, td), never loose beside blocks; never let a script change text in the source (give it an empty element, or mark the text data-erga-noedit); link the document's files relatively (\"style.css\"), other documents by /<owner>/<slug>; keep the page's place (slide, view) in location.hash; set a background on body; leave data-erga attributes alone. For slides or a canvas, start from the slides or canvas template: its library gives the steps and zoom.";

const bool = (description: string) => Schema.optionalKey(Schema.Boolean.annotate({ description }));

export const DOCUMENT_OPERATIONS: Operation[] = [
  {
    name: "whoami",
    label: "Who you are",
    ui: "The account menu: who is signed in; Settings (/settings): your agent tokens and your API keys; the quick search (⌘K): its pages",
    description: "Who you act for: your tokens, API keys and Erga's pages.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const { who, token, dir } = caller;
      // A document token reaches one document: not its person's tokens, keys or pages.
      const wide = who.onlyDoc == null;
      return {
        login: who.login,
        ...(caller.name ? { name: caller.name } : {}),
        ...(caller.origin ? { server: caller.origin } : {}),
        ...(who.via ? { via: who.via } : {}),
        adminPower: await dir.users.actsAsAdmin(who),
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
        ...(wide
          ? {
              tokens: (await platformOf(caller).tokens.list(who.login)).map((t) => ({
                id: t.id,
                label: t.label,
                kind: t.kind,
                scope: t.scope,
                ...(t.docId ? { document: t.docId } : {}),
                expires: iso(t.expires),
                created: iso(t.created),
                lastUsed: iso(t.lastUsed),
                ...(t.id == token?.id ? { yours: true } : {}),
              })),
              // The person's own keys for their agent's models: never a key, only whether it's set. Pasted only in Settings, Agent.
              apiKeys: (await dir.personKeys.list(who)).map((k) => ({
                name: k.name,
                label: k.label,
                set: k.set,
                last4: k.last4,
                updated: iso(k.updated),
                ...(k.unreadable ? { unreadable: "stored, but this server can't open it: paste it again in Settings, Agent" } : {}),
              })),
              pages: await sitePages(caller),
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
    ui: "Documents (/docs): the list; Settings (/admin): the Homepage Project picker (an admin's search of everyone's)",
    description: "Your documents and those shared with you, newest first.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(Schema.String),
      all: bool("Everyone's (admins)."),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: async (args, caller) => {
      const { dir, who } = caller;
      const query = typeof args.query == "string" ? args.query : "";
      if (args.all === true) {
        if (!(await dir.users.actsAsAdmin(who)))
          throw new OperationError({ message: "Only an admin with admin power can list everyone's documents (all).", status: 403 });
        return await dir.search(who, query, Number(args.limit) || 20);
      }
      const q = query.trim().toLowerCase();
      return (await platformOf(caller).docs.list(who.login.toLowerCase()))
        .map((d) => ({
          id: d.id,
          title: d.title,
          address: addressOf(d),
          ...(caller.origin ? { url: caller.origin + addressOf(d) } : {}),
          owner: d.owner,
          role: d.role,
          modified: iso(d.modified),
          ...(d.kind ? { kind: d.kind } : {}),
          ...(d.expires != null ? { expires: iso(d.expires) } : {}),
          ...(d.path != null ? { onDisk: d.path } : {}),
          ...(d.id == caller.here ? { here: true } : {}),
        }))
        .filter((d) => !q || `${d.title} ${d.address} ${d.id}`.toLowerCase().includes(q));
    },
  },
  {
    name: "create_document",
    label: "Make a document",
    activity: "making a document",
    wide: true,
    loose: true,
    ui: "Documents (/docs): New, from a template or a copy; the viewer's Clone; publishing a folder of files",
    description: "Makes a document from files, a template or a copy.",
    parameters: Schema.Struct({
      files: Schema.optionalKey(FILES),
      index: Schema.optionalKey(str("The page, if not index.html.")),
      title: Schema.optionalKey(str("Default: the first heading.")),
      slug: Schema.optionalKey(str("Default: from the title.")),
      template: Schema.optionalKey(
        Schema.String.annotate({
          enum: ["blank", ...TEMPLATES.map((t) => t.id), "landing"],
          description: `Without files: ${["blank", ...TEMPLATES.map((t) => t.id), "landing"].join(", ")}.`,
        })
      ),
      from: Schema.optionalKey(str("Without files: a document to copy.")),
      kind: Schema.optionalKey(
        Schema.String.annotate({
          enum: ["document", "project"],
          description: "document (one page) or project (pages).",
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
    description: "Deletes a document for good (owner only).",
    parameters: Schema.Struct({ document: ANY_DOCUMENT }),
    run: async (args, caller) => {
      const doc = await findDocument({ ...caller, here: undefined }, args.document, "delete");
      if (doc.id == caller.here)
        throw new OperationError({
          message: "That's the document open on the person's page: they delete it on the documents list (/docs).",
          status: 409,
        });
      const platform = platformOf(caller);
      // A folder on disk (local development) only comes off the list.
      if (!(await platform.docs.delete(doc))) await platform.directory.remove(doc.id);
      return { deleted: described(doc, caller) };
    },
  },
  {
    name: "share_document",
    label: "Share the document",
    activity: "sharing the document",
    ui: "Share (the documents list and the editor): give someone a role, change it, or stop sharing; Document settings (the editor): Readers",
    description: "Shares a document (owner), or sets its readers' options (editors).",
    parameters: Schema.Struct({
      document: DOCUMENT,
      login: Schema.optionalKey(str('A GitHub login, or "*" for anyone with the link.')),
      role: Schema.optionalKey(Schema.Literals(["editor", "viewer", "none"]).annotate({ description: "none stops sharing." })),
      reader_agent: bool("Readers may ask their agent."),
      reader_bars: bool("Readers see Erga's bars over it."),
      page_llm: bool("Its script may call a model (window.ergaLLM)."),
      page_llm_model: Schema.optionalKey(Schema.Literals(PAGE_LLM_MODELS)),
    }),
    run: async (args, caller) => {
      const { dir } = caller;
      const login = String(args.login ?? "")
        .trim()
        .replace(/^@/, "");
      // Roles are the owner's; the readers' options, anyone's who may edit it.
      const doc = await findDocument(caller, args.document, login ? "share" : "edit");
      if (!login && args.reader_agent == null && args.reader_bars == null && args.page_llm == null && args.page_llm_model == null)
        throw new OperationError({
          message: "Give a login and a role, reader_agent, reader_bars, page_llm or page_llm_model.",
          status: 400,
        });
      if (!login != !args.role)
        throw new OperationError({ message: "Give a login and its role (editor, viewer or none) together.", status: 400 });
      if (login) {
        await dir.share(caller.who, doc.id, login, args.role == "none" ? null : (args.role as Grant));
      }
      if (args.reader_agent === true && (await dir.permissions(doc.id)).some((p) => p.login == ANYONE))
        throw new OperationError({
          message:
            "Anyone with the link can open this document, so readers can't use their agent on it. Stop sharing it with anyone first.",
          status: 409,
        });
      if (args.reader_agent != null) await dir.setReaderOption(doc.id, "agent", args.reader_agent === true);
      if (args.reader_bars != null) await dir.setReaderOption(doc.id, "bars", args.reader_bars === true);
      if (args.page_llm != null || args.page_llm_model != null) {
        const had = await dir.pageLlm.setting(doc.id);
        const model = args.page_llm_model ?? (had.model && isPageLlmModel(had.model) ? had.model : DEFAULT_PAGE_LLM_MODEL);
        await dir.pageLlm.set(doc.id, args.page_llm == null ? had.on : args.page_llm === true, String(model));
      }
      const owner = !!login || (await dir.may(caller.who, "share", doc));
      return { document: described(doc, caller), ...(owner ? await accessOf(caller, doc) : await readersOf(caller, doc)) };
    },
  },
  {
    name: "write",
    label: "Write",
    activity: "writing",
    loose: true,
    ui: "An HTTP client's publish (POST /api/publish); the page tree's upload (PUT /api/files/<path>)",
    description: "Writes one file (path), or many (files).",
    parameters: Schema.Struct({
      document: DOCUMENT,
      path: Schema.optionalKey(str("The file.")),
      content: Schema.optionalKey(str("Its text (prefer edit for a change).")),
      content_base64: Schema.optionalKey(Schema.String),
      files: Schema.optionalKey(FILES),
      replace: bool("With files: delete the other files."),
    }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "edit");
      const one = args.path != null;
      if (one == (args.files != null))
        throw new OperationError({ message: "Give one file (path, with content or content_base64), or files.", status: 400 });
      // One file: in the document's host, as the person's agent (only the differences of a text file, one undo step).
      if (one) {
        const { path, content, content_base64 } = args;
        return runInDocument(caller, doc, "write", { path, content, content_base64 });
      }
      // Many: as a publish, each file an edit (open editors show it at once, and anyone's undo history stays).
      const platform = platformOf(caller);
      const files = decodeFiles(args.files);
      const remove = new Set<string>();
      if (args.replace === true) for (const p of await platform.docs.paths(doc)) if (!(p in files)) remove.add(p);
      if (!Object.keys(files).length && !remove.size) throw new OperationError({ message: "Nothing to do: files is empty.", status: 400 });
      const r = await platform.docs.publish(doc, files, [...remove], byLine(caller.who.login.toLowerCase(), caller.who.via));
      return { ...described((await platform.directory.get(doc.id)) ?? doc, caller), ...r };
    },
  },
  {
    name: "revoke",
    label: "Revoke a token or a key",
    activity: "revoking",
    wide: true,
    ui: "Settings (/settings): Revoke a token; Settings, Agent: Remove a key",
    description: "Turns off a token, or removes an API key.",
    parameters: Schema.Struct({
      token: Schema.optionalKey(Schema.String),
      api_key: Schema.optionalKey(str("anthropic, openai, google or openrouter.")),
    }),
    run: async (args, caller) => {
      const { dir, who } = caller;
      if ((args.token == null) == (args.api_key == null))
        throw new OperationError({ message: "Give a token's id (token) or a provider (api_key): one of them.", status: 400 });
      if (args.api_key != null) {
        const k = await dir.personKeys.clear(who, String(args.api_key));
        return { removed: k.name, label: k.label };
      }
      if (!(await platformOf(caller).tokens.revoke(who.login, String(args.token), who.via)))
        throw new OperationError({ message: `You have no token "${args.token}".`, status: 404 });
      return { revoked: args.token };
    },
  },
];

/** The readers' options, which anyone who may edit the document may see and change, and whether anyone with the link may open it. */
export async function readersOf(caller: Caller, doc: DocRow) {
  const { dir } = caller;
  const [permissions, readers, llm] = await Promise.all([dir.permissions(doc.id), dir.readerOptions(doc.id), dir.pageLlm.setting(doc.id)]);
  return {
    readerAgent: readers.agent,
    readerBars: readers.bars,
    pageLlm: { on: llm.on, model: llm.model ?? DEFAULT_PAGE_LLM_MODEL },
    anyoneWithLink: permissions.some((p) => p.login == ANYONE),
  };
}

/** Who a document is shared with, as the Share dialogs show it (its owner only), and the readers' options: ls's `access`. */
export async function accessOf(caller: Caller, doc: DocRow) {
  const { dir } = caller;
  const [permissions, readers] = await Promise.all([dir.permissions(doc.id), readersOf(caller, doc)]);
  const notUsers = (
    await Promise.all(permissions.map(async (p) => (p.login == ANYONE || (await dir.users.allowed(p.login)) ? null : p.login)))
  ).filter((l) => l != null);
  return {
    permissions: permissions.map((p) => ({
      login: p.login,
      role: p.role,
      granted: iso(p.granted),
      ...(p.grantedBy ? { grantedBy: p.grantedBy } : {}),
      ...(p.grantedVia ? { grantedVia: p.grantedVia } : {}),
    })),
    notUsers,
    avatars: await dir.users.avatars(permissions.map((p) => p.login)),
    publicSharing: await dir.config.get("public_sharing"),
    ...readers,
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
