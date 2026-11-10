// The operations on documents as wholes: who you are (your tokens, keys and Erga's pages too), the documents list
// (/docs: list, make, delete; an admin's search of everyone's), sharing (the Share dialogs of the list and the editor,
// and the readers' options), writing files into one, and revoking a token or a key. What a person does inside one
// document (its name, pages, files and versions) is editor.ts's; its text is edited over the room's socket, and by the
// document tools (agents/document/tools.ts), which agents/tools.ts offers for any document.

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { readersStep, type Readers } from "./readers.ts";
import { ANYONE, type DocRow, type Grant, newDocId, NO_WRITE, PAGE_LLM_WHO, type PageLlmWho } from "../directory/index.ts";
import { forgetDecisions, makeDoc, startingFiles } from "../documents/index.ts";
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
  said,
  type Operation,
  OperationError,
  platformOf,
  namedDocument,
  runInDocument,
  str,
} from "./operation.ts";
import { sitePages } from "./pages.ts";
import { addressOf } from "../../document/names.ts";
import {
  DEFAULT_PAGE_LLM_MODEL,
  isPageLlmModel,
  MODELS,
  PAGE_LLM_MODELS,
  pageLlmChoices,
  PROVIDERS,
  type ModelChoice,
} from "../../shared/models.ts";

/** Files as a caller gives them: by path, each text or base64. */
const FILES = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String })])).annotate({
  description: 'Each path\'s text, or {"base64": "..."} for bytes.',
});
/** Files to write: as FILES, or a file Erga keeps already, by its sha-256 (an image sent to your agent). */
const WRITE_FILES = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String }), Schema.Struct({ blob: Schema.String })])
).annotate({
  description:
    'Each path\'s text, {"base64": "..."} for bytes, or {"blob": "<sha-256>"} for a file Erga keeps (an image sent to your agent).',
});

/**
 * How to write a page people can keep editing by hand (agents/document/PROMPT.md, short): in MCP's instructions
 * (server/api.ts), once, not in each tool that writes a page.
 */
export const PAGE_RULES =
  "People keep editing pages by hand, and the editor locks text that doesn't match its source: write well-formed HTML (close every element, </p> and </li> too); keep text in plain leaf elements (p, h1-h6, li, td), never loose beside blocks; never let a script change text in the source (give it an empty element, or mark the text data-erga-noedit); link the document's files relatively (\"style.css\"), other documents by /<owner>/<slug>; keep the page's place (slide, view) in location.hash; set a background on body; leave data-erga attributes alone. For slides or a canvas, start from the slides or canvas template: a presentation defines window.ergaSteps and imports erga/steps, which gives the steps.";

/** How many tokens whoami lists, if not told. */
const TOKENS_SHOWN = 20;

const bool = (description: string) => Schema.optionalKey(Schema.Boolean.annotate({ description }));

export const DOCUMENT_OPERATIONS: Operation[] = [
  {
    name: "whoami",
    label: "Who you are",
    ui: "The account menu: who is signed in; Settings (/settings): your agent tokens and your API keys; the quick search (⌘K): its pages",
    description: "Who you act for: your tokens, API keys and Erga's pages.",
    parameters: Schema.Struct({
      limit: Schema.optionalKey(Schema.Int),
      offset: Schema.optionalKey(Schema.Int.annotate({ description: "whoami: tokens to skip, to list the next ones." })),
    }),
    run: async (args, caller) => {
      const { who, token, dir } = caller;
      // A document token reaches one document: not its person's tokens, keys or pages.
      const wide = who.onlyDoc == null;
      const limit = Math.min(Math.max(Number(args.limit) || TOKENS_SHOWN, 1), 100),
        offset = Math.max(Number(args.offset) || 0, 0);
      const mine = wide ? await platformOf(caller).tokens.list(who.login, limit, offset) : null;
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
        ...(mine
          ? {
              // Newest first, `limit` of them (expired ones never); `moreTokens`: how many come after these.
              tokens: mine.tokens.map((t) => ({
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
              moreTokens: Math.max(mine.total - offset - mine.tokens.length, 0),
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
    ui: "Documents (/docs): the list; Settings (/admin/settings): the Homepage picker (an admin's search of everyone's)",
    description: "Your documents and those shared with you, newest first.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(Schema.String),
      all: bool("Everyone's (admins)."),
      archived: bool("Only those you archived (archive_document); else none of them."),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: async (args, caller) => {
      const { dir, who } = caller;
      const query = typeof args.query == "string" ? args.query : "";
      if (args.all === true) {
        if (!(await dir.users.actsAsAdmin(who)))
          throw new OperationError({ message: "Only an admin with admin power can list everyone's documents (all).", status: 403 });
        return await dir.lists.search(who, query, Number(args.limit) || 20);
      }
      const q = query.trim().toLowerCase();
      return (await platformOf(caller).docs.list(who.login.toLowerCase(), { archived: args.archived === true }))
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
    ui: "Documents (/docs): New, from a template or a copy, and + Scratch (/scratch); the viewer's Clone; publishing a folder of files",
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
      scratch: bool("Not on the list; deleted delete_docs_after_hours after it's made (a setting), unless saved (save_document)."),
    }),
    run: async (args, caller) => {
      const { who } = caller,
        platform = platformOf(caller);
      const scratch = args.scratch === true;
      if (scratch && args.slug)
        throw new OperationError({ message: "A scratch document's address is random until it's saved: no slug.", status: 400 });
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
          scratch,
        });
        if (doc)
          return {
            ...described(doc, caller),
            page: index,
            files: Object.keys(files).sort(),
            ...(from ? { from } : {}),
            ...(doc.expires == null || (published && !scratch)
              ? {}
              : { expires: `${iso(doc.expires)}, ${scratch ? "unless someone saves it (save_document)" : "unless someone edits it"}` }),
          };
      }
      throw new OperationError({ message: "Couldn't pick an address for it: try again.", status: 500 });
    },
  },
  {
    name: "save_document",
    label: "Save a scratch document",
    activity: "saving a scratch document",
    ui: "A scratch document's page: Save",
    description: "Saves a scratch document: on the list, never deleted.",
    parameters: Schema.Struct({ document: DOCUMENT, title: Schema.optionalKey(str("Default: the first heading.")) }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "edit");
      if (!(await caller.dir.may(caller.who, "delete", doc)))
        throw new OperationError({ message: "Only its owner can save a scratch document.", status: 403 });
      if (!doc.scratch) throw new OperationError({ message: "That document is saved already: it isn't a scratch document.", status: 409 });
      const platform = platformOf(caller);
      // The document writes its own row as it keeps itself.
      await platform.docs.keep(doc);
      forgetDecisions(doc.id);
      // Its address was its id: now it follows the title (the one given, one set before, or the first heading's now).
      const given = optString(args.title, "title")?.trim();
      const title = given || (doc.titleSet ? undefined : null);
      const r = await platform.docs.rename(
        doc,
        { id: caller.who.login.toLowerCase(), name: caller.name ?? caller.who.login },
        { slug: null, ...(title !== undefined ? { title } : {}) }
      );
      if (!r.ok) throw new OperationError({ message: r.error, status: 400 });
      return { saved: described((await platform.directory.get(doc.id)) ?? doc, caller) };
    },
  },
  {
    name: "delete_document",
    label: "Delete a document",
    activity: "deleting a document",
    ui: "Documents (/docs): Delete",
    description: "Deletes a document for good (owner only).",
    parameters: Schema.Struct({ document: ANY_DOCUMENT }),
    asks: (args) => `Delete the document ${named(args.document)} for good`,
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
  ...([true, false] as const).map(
    (archived): Operation => ({
      name: archived ? "archive_document" : "unarchive_document",
      label: archived ? "Archive a document" : "Unarchive a document",
      activity: archived ? "archiving a document" : "unarchiving a document",
      ui: archived ? "Documents (/docs): Archive" : "Archived documents (/docs/archived): Unarchive",
      description: archived
        ? "Moves a document off your list into your archive (/docs/archived), for you only."
        : "Moves a document from your archive (/docs/archived) back onto your list.",
      parameters: Schema.Struct({ document: DOCUMENT }),
      run: async (args, caller) => {
        const doc = await findDocument(caller, args.document, "open");
        await caller.dir.lists.archive(doc.id, caller.who.login, archived);
        return { [archived ? "archived" : "unarchived"]: described(doc, caller) };
      },
    })
  ),
  {
    name: "request_access",
    label: "Ask for access",
    activity: "asking for access",
    wide: true,
    ui: 'A document that isn\'t shared with you (its "no access" page): Ask its owner for access',
    description: "Asks a document's owner for access to it: one request for each document.",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: async (args, caller) => {
      const doc = await namedDocument(caller, args.document);
      if (await caller.dir.may(caller.who, "open", doc))
        throw new OperationError({ message: "You already have access to that document.", status: 409 });
      await caller.dir.requests.ask(doc.id, caller.who.login);
      return { asked: doc.owner, note: `${doc.owner} sees the request on their documents list.` };
    },
  },
  {
    name: "share_document",
    label: "Share the document",
    activity: "sharing the document",
    ui: "Share (the documents list and the editor): give someone a role, change it, or stop sharing; Document settings (the editor): Readers",
    description: "Shares a document or answers a request for access (owner); sets its readers' options (editors).",
    // Only a share with anyone: a person is named, and sees it in their list.
    asks: (args) =>
      args.login == "*" && args.role != "none"
        ? `Share ${named(args.document)} with anyone who has the link${typeof args.role == "string" ? ` (${args.role})` : ""}`
        : null,
    parameters: Schema.Struct({
      document: DOCUMENT,
      login: Schema.optionalKey(str('A GitHub login, or "*" for anyone with the link.')),
      role: Schema.optionalKey(Schema.Literals(["editor", "commenter", "viewer", "none"]).annotate({ description: "none stops sharing." })),
      reader_agent: bool("Readers may ask their agent."),
      reader_bars: bool("Readers see Erga's bars over it."),
      page_llm: bool("Its script may call a model (window.ergaLLM)."),
      page_llm_model: Schema.optionalKey(
        Schema.Literals(PAGE_LLM_MODELS).annotate({
          description: "OpenAI's only where the server has an OpenAI key (ls: access.pageLlm.models).",
        })
      ),
      page_llm_who: Schema.optionalKey(
        Schema.Literals(PAGE_LLM_WHO).annotate({
          description: "Who may call it: signed_in viewers, or all (signed out too, with a smaller limit).",
        })
      ),
    }),
    run: async (args, caller) => {
      const { dir } = caller;
      const login = String(args.login ?? "")
        .trim()
        .replace(/^@/, "");
      // Roles are the owner's; the readers' options, anyone's who may edit it.
      const doc = await findDocument(caller, args.document, login ? "share" : "edit");
      const llm = args.page_llm != null || args.page_llm_model != null || args.page_llm_who != null;
      if (!login && args.reader_agent == null && args.reader_bars == null && !llm)
        throw new OperationError({
          message: "Give a login and a role, reader_agent, reader_bars, page_llm, page_llm_model or page_llm_who.",
          status: 400,
        });
      if (!login != !args.role)
        throw new OperationError({ message: "Give a login and its role (editor, viewer or none) together.", status: 400 });
      const asked = args.page_llm_model as ModelChoice | undefined;
      if (asked != null && !(await pageLlmModels(caller)).includes(asked))
        throw new OperationError({
          message: `The server has no API key that runs ${MODELS[asked].label} for pages.`,
          status: 409,
        });
      // Who reads it, and their agent: decided in full before any write (readers.ts).
      const [permissions, options] = await Promise.all([dir.permissions(doc.id), dir.readerOptions(doc.id)]);
      const readers: Readers = permissions.some((p) => p.login == ANYONE)
        ? { state: "public" }
        : { state: "private", agent: options.agent };
      const step = readersStep(readers, {
        anyone: login == ANYONE ? args.role != "none" : undefined,
        agent: args.reader_agent == null ? undefined : args.reader_agent === true,
      });
      if ("refused" in step) throw new OperationError({ message: step.refused, status: 409 });
      // The agent goes off before the document goes public, and comes on only after the rest.
      if (step.agent === false) await dir.setReaderOption(doc.id, "agent", false);
      if (login) await dir.share(caller.who, doc.id, login, args.role == "none" ? null : (args.role as Grant));
      if (step.agent === true) await dir.setReaderOption(doc.id, "agent", true);
      if (args.reader_bars != null) await dir.setReaderOption(doc.id, "bars", args.reader_bars === true);
      if (llm) {
        const had = await dir.pageLlm.setting(doc.id);
        const model = args.page_llm_model ?? (had.model && isPageLlmModel(had.model) ? had.model : DEFAULT_PAGE_LLM_MODEL);
        const on = args.page_llm == null ? had.on : args.page_llm === true;
        await dir.pageLlm.set(doc.id, { on, model: String(model), who: (args.page_llm_who as PageLlmWho | undefined) ?? had.who });
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
      files: Schema.optionalKey(WRITE_FILES),
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
      const files = decodeFiles(args.files, true);
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
    asks: (args) => (args.api_key != null ? `Remove your ${said(args.api_key)} API key` : `Revoke the token ${said(args.token)}`),
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

const named = (document: unknown) => (typeof document == "string" && document.trim() ? said(document) : "the document open on the page");

/** The page models the owner may choose now: Claude's, and the others the server's keys run (pageLlmChoices). */
async function pageLlmModels(caller: Caller): Promise<ModelChoice[]> {
  const cfg = await caller.platform?.agentSettings();
  const server = cfg && !("missing" in cfg) ? PROVIDERS.filter((p) => cfg.server[p]) : [];
  return pageLlmChoices({
    own: [],
    server,
    mode: cfg && !("missing" in cfg) ? cfg.mode : "server",
    off: cfg && !("missing" in cfg) ? cfg.off : [],
  });
}

/** The readers' options, which anyone who may edit the document may see and change, and whether anyone with the link may open it. */
export async function readersOf(caller: Caller, doc: DocRow) {
  const { dir } = caller;
  const [permissions, readers, llm, models] = await Promise.all([
    dir.permissions(doc.id),
    dir.readerOptions(doc.id),
    dir.pageLlm.setting(doc.id),
    pageLlmModels(caller),
  ]);
  return {
    readerAgent: readers.agent,
    readerBars: readers.bars,
    pageLlm: { on: llm.on, model: llm.model ?? DEFAULT_PAGE_LLM_MODEL, models, who: llm.who },
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
    // Who asked for access and waits for the owner's answer (request_access): share_document answers, "none" declines.
    requests: (await dir.requests.waiting(doc.owner, doc.id)).map((r) => ({ login: r.login, asked: iso(r.asked) })),
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

/** Files as operations take them: text, or {base64} for anything else; with `blobs` (write), {blob} for a kept file. */
function decodeFiles(raw: unknown, blobs = false): Record<string, FileData> {
  if (raw == null) return {};
  if (typeof raw != "object" || Array.isArray(raw))
    throw new OperationError({ message: "files must be an object of paths to contents.", status: 400 });
  const out: Record<string, FileData> = {};
  let total = 0;
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    const rel = cleanFilePath(path);
    let data: string | Uint8Array;
    if (typeof v == "string") data = v;
    else if (v && typeof v == "object" && typeof (v as { base64?: unknown }).base64 == "string") {
      const bytes = Base64.decode((v as { base64: string }).base64.replace(/\s+/g, ""));
      if (Result.isFailure(bytes)) throw new OperationError({ message: `${path}: that isn't base64.`, status: 400 });
      data = bytes.success;
    } else if (blobs && v && typeof v == "object" && typeof (v as { blob?: unknown }).blob == "string") {
      const hash = (v as { blob: string }).blob.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OperationError({ message: `${path}: a blob is a sha-256, 64 hex digits.`, status: 400 });
      // (Its size comes from the blob store, which the document asks: uploads.ts.)
      out[rel] = { hash, size: 0, at: Date.now() };
      continue;
    } else if (v && typeof v == "object" && typeof (v as { text?: unknown }).text == "string") data = (v as { text: string }).text;
    else throw new OperationError({ message: `${path}: give its text as a string, or {"base64": "..."}.`, status: 400 });
    total = addFile(out, rel, data, total);
  }
  return out;
}

/** Adds a file to `out`, within the limits; answers the total size so far. */
export function addFile(out: Record<string, FileData>, rel: string, data: string | Uint8Array, total: number): number {
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
