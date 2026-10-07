// The server's API for agents: everything a person can do in the app, for an
// agent holding one of their agent tokens (tokens.ts). It's the same token,
// and the same mechanism, as a document's own external agent API (host.ts,
// /d/<id>/api/ext): this one covers the whole server, and offers each
// document's tools for any document the person may edit.
//
//   GET  /llms.txt                 the guide, for anyone (how to get a token, call the API, publish a site)
//   GET  /api, /api/ext            the same guide (personal, with a token)
//   GET  /api/ext/tools            the tools, as JSON (name, description, JSON Schema)
//   POST /api/ext/tools/<name>     runs one, the body its arguments: {"ok": true, "content": [...]}
//   POST /api/publish              a folder of files as a document (multipart or JSON), or into one
//   GET  /api/docs/<id>/versions   a document's versions and what's published; POST .../publish sets it,
//                                  POST .../versions/<versionId>/restore brings one back, or one file of it with {"path": ...} (versions.ts)
//   POST /api/auth/request         an agent asks for a token: a link for its person to approve
//   POST /api/auth/poll            ... and collects the token once they have
//   POST /mcp                      the same tools as a stateless MCP server (Streamable HTTP, JSON answers)
//   GET  /api/docs/<id>/tree       a document's file tree; POST does a tree operation (tree.ts). For people
//                                  signed in (the tree's UI) as well as tokens
//   /tokens, /tokens/...           a person's tokens: make one (a scope, an expiry), revoke one, approve or deny an agent's request
//   /settings                      their settings: the test token, and a link to /tokens
//
// The Worker (worker/index.ts) sends those paths here, with the platform
// that knows agent tokens (front.ts, withTokens). The share button's token
// (<document>/api/share) is front.ts's.
//
// Tools are a registry (`TOOLS`): a name, a description, arguments as JSON
// Schema and a `run`, given who's asking and the platform. Adding one is
// adding an entry; REST, MCP and the guide all list it. The document tools
// (read, edit, write, ... from agent.ts) are added with a `document`
// argument and run in that document's host, as the person's agent. The
// tools the editor's own agent has too (server-tools.ts: sharing, and the
// server's settings and users for an admin) are added as they are; the admin
// ones are listed only for an admin's token.

import { validateToolArguments } from "@mariozechner/pi-ai";
import { documentToolSpecs, type ToolContent, type ToolSpec } from "./agent";
import { type Action, type DocRow, type Route, nameOf, roleMay } from "./directory";
import type { PublishRequest } from "./versions";
import { accessOf, appPage, brand, esc, forwarded, fromElsewhere, ICON, ID, makeDoc, newDocId, page, safeNext, startingFiles, TIMES_SCRIPT, type Platform, type Session, whoOf } from "./front";
import { byLine, VIA } from "./attribution";
import { findDocument, runServerTool, SERVER_TOOLS, ToolError, type ToolWho } from "./server-tools";
import { cleanRel } from "./host";
import { LABEL_MAX, normalCode, REQUEST_MINUTES, SCOPES, ScopeError, type AgentToken, type Scope } from "./tokens";
import { LOCKED } from "./users";
import { TEMPLATES, templateById } from "./templates";

// ---------------------------------------------------------------- the registry

/** What a tool runs with: who's asking (always an agent token's person), the platform, and the server's origin. */
export interface ToolContext {
  readonly session: Session & { agent: AgentToken };
  readonly platform: Platform;
  readonly origin: string;
  readonly url: URL;
}

/** JSON Schema for a tool's arguments: an object. */
export interface ArgsSchema { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }

export interface ServerTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ArgsSchema;
  /** Only for server admins: listed only for an admin's token. */
  readonly admin?: boolean;
  /** Reaches beyond one document (lists or makes documents, manages tokens): never for a document token (tokens.ts). */
  readonly wide?: boolean;
  /** Its answer: text, JSON (shown as text), or content items (text, images). Throws a ToolError the agent can act on. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | object | ToolContent[]>;
}

export { ToolError };

const str = (description: string) => ({ type: "string", description });
const DOCUMENT_ARG = str("The document: its address (/<owner>/<slug>), its URL, its id, or the slug of one of yours.");
const FILES_ARG = {
  type: "object",
  description: "Files by path relative to the document's folder (\"index.html\", \"css/app.css\"): each a string of text, or {\"base64\": \"...\"} for any other file (images, fonts).",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "object", properties: { base64: { type: "string" } }, required: ["base64"] }] },
};

/** The server's own tools. Add one here and it's in the REST API, MCP and the guide. */
export const TOOLS: ServerTool[] = [
  {
    name: "whoami",
    description: "Who your token stands for, what it's called, its scope (document, documents or admin), its document (for the document scope) and when it expires.",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, origin }) => ({
      login: session.login, name: session.name, server: origin,
      token: { id: session.agent.id, label: session.agent.label, scope: session.agent.scope, ...(session.agent.docId ? { document: session.agent.docId } : {}), expires: session.agent.expires ? new Date(session.agent.expires).toISOString() : null },
    }),
  },
  {
    name: "list_documents",
    wide: true,
    description: "The person's documents, most recently edited first: id, title, address, URL, when it was last edited, and when it goes if nobody edits it (only for never-edited ones).",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, platform, origin }) => (await platform.docs.list(session.login)).map((d) => ({
      id: d.id, title: d.title, address: `/${d.owner}/${d.slug}`, url: `${origin}/${d.owner}/${d.slug}`,
      modified: new Date(d.modified).toISOString(), ...(d.expires != null ? { expires: new Date(d.expires).toISOString() } : {}), ...(d.path != null ? { onDisk: d.path } : {}),
    })),
  },
  {
    name: "create_document",
    wide: true,
    description: `Makes a new document and answers its URL. With files, it's those files (publishing a site or a page: a folder with index.html or index.md, plus its styles, scripts and images), and it stays. Without files it's a blank page, a template (template: ${TEMPLATES.map((t) => t.id).join(", ")}, or "landing" for a copy of the server's front page) or a copy of another document you may open (from), which goes if nobody edits it in time (the server's delete_docs_after_hours setting, unless that's never; it says when). The title follows the page's first heading unless you give one; the address (/<owner>/<slug>) follows the title unless you give a slug.`,
    parameters: {
      type: "object",
      properties: {
        files: FILES_ARG,
        index: str("The page, if it isn't index.html or index.md: an .html or .md file among the files."),
        title: str("Its title (else the page's first heading)."),
        slug: str("Its address after /<owner>/ (letters, digits and dashes; else made from the title). Taken already, it gets -2, -3..."),
        template: { type: "string", enum: ["blank", ...TEMPLATES.map((t) => t.id), "landing"], description: "Without files: a blank page (blank or page, the default), another template, or a copy of the server's front page (landing)." },
        from: str("Without files: a document to copy instead (its address, URL or id). Someone who may not edit it copies its published version."),
      },
    },
    run: async (args, ctx) => {
      const { session, platform } = ctx;
      // Anyone who may sign in may make documents (withTokens checked they still may); test people only test documents.
      if (session.test) throw new ToolError("You can't make documents on this server.", 403);
      let files = decodeFiles(args.files);
      const published = Object.keys(files).length > 0;
      let index: string;
      if (published) index = pageOf(files, args.index);
      else {
        const named = typeof args.template == "string" && args.template != "blank" ? args.template : null;
        const template = named && named != "landing" ? templateById(named) : undefined;
        if (named && named != "landing" && !template) throw new ToolError(`There's no template "${named}".`);
        const from = args.from ? (await resolve(ctx, args.from, "open")).id : named == "landing" ? "landing" : null;
        const start = await startingFiles(platform, from, whoOf(session), template);
        if (!start) throw new ToolError(from == "landing" ? "This server has no front page (landing document) to copy." : "There's nothing there you can copy.", 404);
        ({ files, index } = start);
      }
      for (let tries = 0; tries < 5; tries++) {
        const doc = await makeDoc(platform, session.login.toLowerCase(), newDocId(), files, {
          index, published, title: optString(args.title, "title"), slug: optString(args.slug, "slug"),
        });
        if (doc) return { ...described(doc, ctx), page: index, files: Object.keys(files).sort(), ...(published || doc.expires == null ? {} : { expires: `${new Date(doc.expires).toISOString()}, unless someone edits it` }) };
      }
      throw new ToolError("Couldn't pick an address for it: try again.", 500);
    },
  },
  {
    name: "update_files",
    description: "Publishes files into an existing document: each replaces the file as it is now, as an edit (open editors show it at once, and anyone's undo history stays). replace: true also deletes every file not given (the page itself stays), for publishing a site again. delete removes the files named.",
    parameters: {
      type: "object",
      properties: {
        document: DOCUMENT_ARG,
        files: FILES_ARG,
        delete: { type: "array", items: { type: "string" }, description: "Paths of files to delete." },
        replace: { type: "boolean", description: "Delete every file that isn't in files (except the page)." },
      },
      required: ["document"],
    },
    run: async (args, ctx) => {
      const doc = await resolve(ctx, args.document, "edit");
      const files = decodeFiles(args.files);
      const remove = new Set(stringList(args.delete, "delete").map((p) => cleanPath(p)));
      if (args.replace === true) for (const p of await ctx.platform.docs.paths(doc)) if (!(p in files)) remove.add(p);
      if (!Object.keys(files).length && !remove.size) throw new ToolError("Nothing to do: give files, delete, or replace.");
      const r = await ctx.platform.docs.publish(doc, files, [...remove], byLine(ctx.session.login.toLowerCase(), whoOf(ctx.session).via));
      return { ...described((await ctx.platform.directory.get(doc.id)) ?? doc, ctx), ...r };
    },
  },
  {
    name: "rename_document",
    description: "Sets a document's title and/or address (slug). An empty one goes back to following: the title the page's first heading, the slug the title. Old addresses keep redirecting.",
    parameters: { type: "object", properties: { document: DOCUMENT_ARG, title: str("The new title (\"\" to follow the page's first heading)."), slug: str("The new address after /<owner>/ (\"\" to follow the title).") }, required: ["document"] },
    run: async (args, ctx) => {
      const doc = await resolve(ctx, args.document, "rename");
      const patch = { ...(args.title !== undefined ? { title: optString(args.title, "title") ?? "" } : {}), ...(args.slug !== undefined ? { slug: optString(args.slug, "slug") ?? "" } : {}) };
      // Through the document's host, as a rename in the editor is, so its open tabs follow.
      const r = await callDoc(ctx, doc, "/api/name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new ToolError(body.error ?? `The document answered ${r.status}.`, r.status == 409 ? 409 : 400);
      return described((await ctx.platform.directory.get(doc.id)) ?? doc, ctx);
    },
  },
  {
    name: "delete_document",
    description: "Deletes one of the person's documents, for good (only its owner may). A document that's a folder on disk (local development) only comes off the list.",
    parameters: { type: "object", properties: { document: DOCUMENT_ARG }, required: ["document"] },
    run: async (args, ctx) => {
      const doc = await resolve(ctx, args.document, "delete");
      if (!(await ctx.platform.docs.delete(doc))) await ctx.platform.directory.remove(doc.id);
      return { deleted: true, id: doc.id, title: doc.title };
    },
  },
  {
    name: "list_tokens",
    wide: true,
    description: "The person's agent tokens (never the tokens themselves): id, label, when made and last used.",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, platform }) => (await platform.tokens.list(session.login)).map((t) => ({
      id: t.id, label: t.label, kind: t.kind, scope: t.scope, ...(t.docId ? { document: t.docId } : {}), expires: t.expires ? new Date(t.expires).toISOString() : null, created: new Date(t.created).toISOString(), lastUsed: t.lastUsed ? new Date(t.lastUsed).toISOString() : null, ...(t.id == session.agent.id ? { yours: true } : {}),
    })),
  },
  {
    name: "revoke_token",
    wide: true,
    description: "Turns one of the person's agent tokens off, by id (list_tokens). Revoking your own ends your access.",
    parameters: { type: "object", properties: { id: str("The token's id.") }, required: ["id"] },
    run: async (args, { session, platform }) => {
      if (!(await platform.tokens.revoke(session.login, String(args.id ?? ""), whoOf(session).via))) throw new ToolError(`You have no token "${args.id}".`, 404);
      return { revoked: args.id };
    },
  },
];

/** The document tools (agent.ts), for any document: a `document` argument, and they run in its host. */
let docTools: ServerTool[] | null = null;
function documentTools(): ServerTool[] {
  return docTools ??= documentToolSpecs().map((spec: ToolSpec): ServerTool => {
    const p = spec.parameters as ArgsSchema;
    return {
      name: spec.name,
      description: `${spec.description} (In any document you may edit: name it with "document"; paths are relative to its folder.)`,
      parameters: { ...p, type: "object", properties: { document: DOCUMENT_ARG, ...p.properties }, required: ["document", ...(p.required ?? [])] },
      run: async (args, ctx) => {
        const doc = await resolve(ctx, args.document, "edit");
        const { document: _, ...rest } = args;
        const r = await callDoc(ctx, doc, `/api/ext/tools/${encodeURIComponent(spec.name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rest) });
        const body = (await r.json().catch(() => ({ ok: false, error: `The document answered ${r.status}.` }))) as { ok: boolean; content?: ToolContent[]; error?: string };
        if (!body.ok) throw new ToolError(body.error ?? "The tool failed.", r.status >= 400 && r.status < 500 ? r.status : 500);
        return body.content ?? [];
      },
    };
  });
}

/** What a tool in server-tools.ts runs with, for an agent token's person. */
const toolWho = (ctx: ToolContext): ToolWho => ({ dir: ctx.platform.directory, who: whoOf(ctx.session), origin: ctx.origin });

/** The tools the editor's agent has too (server-tools.ts): sharing, and the admin ones. The documents list's are in TOOLS above, with files. */
const sharedTools: ServerTool[] = SERVER_TOOLS.filter((t) => !t.docs).map((t) => ({
  name: t.name,
  description: t.description,
  admin: t.admin,
  parameters: JSON.parse(JSON.stringify(t.parameters)) as ArgsSchema,
  run: async (args, ctx) => {
    let checked: Record<string, unknown>;
    try { checked = validateToolArguments(t as never, { type: "toolCall", id: "api", name: t.name, arguments: args }) as Record<string, unknown>; } catch (e) { throw new ToolError((e as Error).message); }
    return runServerTool(t, checked, toolWho(ctx));
  },
}));

/** Every tool: the server's, then those the editor's agent has too, then the documents'. */
export const allTools = (): ServerTool[] => [...TOOLS, ...sharedTools, ...documentTools()];

/** The tools someone may use (all of them, admin ones marked so, for no one in particular): no admin ones without admin power, no wide ones for a document token. */
export async function toolsFor(ctx: ToolContext | null): Promise<ServerTool[]> {
  const admin = ctx ? await ctx.platform.directory.users.actsAsAdmin(whoOf(ctx.session)) : true;
  const one = ctx?.session.onlyDoc != null;
  return allTools().filter((t) => (admin || !t.admin) && !(one && t.wide));
}
const specOf = (t: ServerTool): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters });

/** Runs a tool by name; its answer as content items. */
async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolContent[]> {
  const tool = allTools().find((t) => t.name == name);
  if (!tool) throw new ToolError(`There's no tool named "${name}". The tools are: ${(await toolsFor(ctx)).map((t) => t.name).join(", ")}.`, 404);
  if (tool.admin && !(await ctx.platform.directory.users.actsAsAdmin(whoOf(ctx.session)))) {
    throw new ToolError((await ctx.platform.directory.users.isAdmin(whoOf(ctx.session))) ? `${name} needs an admin token: ${LOCKED}` : `${name} is for the server's admins only, and ${ctx.session.login} isn't one.`, 403);
  }
  if (tool.wide && ctx.session.onlyDoc != null) throw new ToolError(`${name} isn't for a document token: this token reaches one document only. Make a token with the documents scope at ${ctx.origin}/tokens.`, 403);
  if (args == null) args = {};
  if (typeof args != "object" || Array.isArray(args)) throw new ToolError("The arguments must be a JSON object.");
  const a = args as Record<string, unknown>;
  for (const key of tool.parameters.required ?? []) if (a[key] === undefined) throw new ToolError(`${name} needs "${key}".`);
  const out = await tool.run(a, ctx);
  if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c)) return out as ToolContent[];
  return [{ type: "text", text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }];
}

// ---------------------------------------------------------------- helpers for tools

/** A document's row, its URL and its API, as tools answer them. */
function described(doc: DocRow, { origin }: ToolContext) {
  const name = nameOf(doc);
  return { id: doc.id, title: name.title, address: name.address, url: origin + name.address, api: `${origin}/d/${doc.id}/api/ext` };
}

/**
 * The document an agent names (an address, a URL, an id, or one of the
 * person's slugs), if the person may do `action` with it.
 */
function resolve(ctx: ToolContext, ref: unknown, action: Action): Promise<DocRow> {
  return findDocument(toolWho(ctx), ref, action);
}

/** A request to a document's own host, as the agent's person, with what they may do there (front.ts, forwarded). */
async function callDoc(ctx: ToolContext, doc: Route, path: string, init: RequestInit): Promise<Response> {
  const inner = new Request(new URL(path, ctx.origin), init);
  const access = accessOf(await ctx.platform.directory.access(whoOf(ctx.session), doc));
  return ctx.platform.docs.fetch(doc, forwarded(inner, new URL(path, ctx.origin), path, `${ctx.origin}/d/${doc.id}`, ctx.session, access));
}

const MAX_FILE = 2_000_000, MAX_TOTAL = 50_000_000, MAX_FILES = 2000;

function cleanPath(p: string): string {
  const rel = cleanRel(p.replace(/^\.?\//, ""));
  if (!rel) throw new ToolError(`"${p}" isn't a path inside the document (no "..", no hidden files or node_modules).`);
  return rel;
}

/** Files as tools take them: text, or {base64} for anything else. */
function decodeFiles(raw: unknown): Record<string, string | Uint8Array> {
  if (raw == null) return {};
  if (typeof raw != "object" || Array.isArray(raw)) throw new ToolError("files must be an object of paths to contents.");
  const out: Record<string, string | Uint8Array> = {};
  let total = 0;
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    const rel = cleanPath(path);
    let data: string | Uint8Array;
    if (typeof v == "string") data = v;
    else if (v && typeof v == "object" && typeof (v as { base64?: unknown }).base64 == "string") {
      try { data = Uint8Array.from(atob((v as { base64: string }).base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch { throw new ToolError(`${path}: that isn't base64.`); }
    } else if (v && typeof v == "object" && typeof (v as { text?: unknown }).text == "string") data = (v as { text: string }).text;
    else throw new ToolError(`${path}: give its text as a string, or {"base64": "..."}.`);
    addFile(out, rel, data, () => total, (n) => { total = n; });
  }
  return out;
}

function addFile(out: Record<string, string | Uint8Array>, rel: string, data: string | Uint8Array, total: () => number, setTotal: (n: number) => void) {
  const size = typeof data == "string" ? new TextEncoder().encode(data).length : data.length;
  if (size > MAX_FILE) throw new ToolError(`${rel} is ${(size / 1e6).toFixed(1)}MB: files can be at most ${MAX_FILE / 1e6}MB.`, 413);
  setTotal(total() + size);
  if (total() > MAX_TOTAL) throw new ToolError(`That's more than ${MAX_TOTAL / 1e6}MB of files.`, 413);
  out[rel] = data;
  if (Object.keys(out).length > MAX_FILES) throw new ToolError(`That's more than ${MAX_FILES} files.`, 413);
}

/** The document's page among the files: the one named, else index.html, else index.md. */
function pageOf(files: Record<string, unknown>, named: unknown): string {
  if (named != null && typeof named != "string") throw new ToolError("index must be a path.");
  const index = named ? cleanPath(named) : "index.html" in files ? "index.html" : "index.md" in files ? "index.md" : null;
  if (!index) throw new ToolError(`There's no page: include index.html or index.md, or name the page with "index". The files: ${Object.keys(files).slice(0, 20).join(", ")}.`);
  if (!/\.(html?|md)$/i.test(index)) throw new ToolError(`The page must be an .html or .md file, not ${index}.`);
  if (!(index in files)) throw new ToolError(`${index} isn't among the files.`);
  return index;
}

const optString = (v: unknown, what: string): string | undefined => {
  if (v == null) return undefined;
  if (typeof v != "string") throw new ToolError(`${what} must be a string.`);
  return v;
};
const stringList = (v: unknown, what: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x != "string")) throw new ToolError(`${what} must be a list of paths.`);
  return v as string[];
};

// ---------------------------------------------------------------- HTTP

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const failure = (error: string, status: number) =>
  json({ ok: false, error }, status, status == 401 ? { "WWW-Authenticate": 'Bearer realm="erga"' } : {});
const NO_TOKEN = (origin: string) => `This needs an agent token, sent as "Authorization: Bearer <token>". Your person can make one at ${origin}/tokens, or you can ask for one: POST ${origin}/api/auth/request (see ${origin}/llms.txt). If yours stopped working it was revoked.`;

/** The server's API (see the top of this file). */
export async function serverApi(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", origin = url.origin;
  const session = await platform.sessionOf(request);
  const agent = session?.agent ? session as ToolContext["session"] : null;
  const ctx = agent && { session: agent, platform, origin, url };
  const method = request.method;

  if (path == "/llms.txt" && (method == "GET" || method == "HEAD")) return new Response(guide(origin, null, true), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
  if ((path == "/api" || path == "/api/ext") && (method == "GET" || method == "HEAD")) {
    if (request.headers.get("authorization") && !agent) return failure(NO_TOKEN(origin), 401);
    return new Response(guide(origin, agent, agent ? await adminStatus(platform, agent) : true), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (path == "/mcp") return mcp(request, ctx, origin);
  if (path == "/api/ext/tools" && method == "GET") {
    // With a token, the tools its person may use; without, all of them (the admin ones say so).
    if (request.headers.get("authorization") && !ctx) return failure(NO_TOKEN(origin), 401);
    return json({ ok: true, tools: (await toolsFor(ctx)).map(specOf) });
  }
  if (path == "/api/auth/request" && method == "POST") return askForToken(request, platform, origin);
  // A document's versions and publishing: for the person signed in (the settings UI) or an agent token alike.
  const [, docId, what, restoreId] = /^\/api\/docs\/([^/]+)\/(versions|publish|versions\/([^/]+)\/restore)$/.exec(path) ?? [];
  if (docId) return versionsApi(request, platform, session, decodeURIComponent(docId), restoreId ? "restore" : what as "versions" | "publish", restoreId && decodeURIComponent(restoreId));
  const [, treeOf] = /^\/api\/docs\/([^/]+)\/tree$/.exec(path) ?? [];
  if (treeOf && (method == "GET" || method == "POST")) return docTree(request, platform, session, decodeURIComponent(treeOf));
  if (path == "/api/auth/poll" && method == "POST") return pollForToken(request, platform);

  const [, name] = /^\/api\/ext\/tools\/([^/]+)$/.exec(path) ?? [];
  if (name && method == "POST") {
    if (!ctx) return failure(NO_TOKEN(origin), 401);
    const args = await request.json().catch(() => undefined);
    if (args === undefined && request.headers.get("content-length") != "0") return failure("The body must be the tool's arguments, as JSON.", 400);
    try {
      return json({ ok: true, content: await runTool(decodeURIComponent(name), args, ctx) });
    } catch (e) {
      return e instanceof ToolError ? failure(e.message, e.status) : failure(`The tool failed: ${(e as Error)?.message ?? e}`, 500);
    }
  }
  if (path == "/api/publish" && method == "POST") {
    if (!ctx) return failure(NO_TOKEN(origin), 401);
    try {
      return json({ ok: true, ...(await publish(request, ctx)) });
    } catch (e) {
      return e instanceof ToolError ? failure(e.message, e.status) : failure(`Publishing failed: ${(e as Error)?.message ?? e}`, 500);
    }
  }
  return failure(`There's nothing at ${method} ${path}. The guide: GET ${origin}/api/ext`, 404);
}

/**
 * GET /api/docs/<id>/versions[?before=<versionId>&limit=<n>]: its versions,
 * newest first, the current one and the published one, and whether the
 * person may publish (canEdit). POST /api/docs/<id>/publish {mode: "latest"}
 * or {mode: "manual", versionId}: editors only. For anyone who may open the
 * document, signed in or with an agent token; a POST from a browser only from
 * this site's own pages.
 */
async function versionsApi(request: Request, platform: Platform, session: Session | null, ref: string, what: "versions" | "publish" | "restore", versionRef?: string): Promise<Response> {
  const url = new URL(request.url);
  const fail = (error: string, status: number) => json({ error }, status);
  if (!session) return fail("Sign in first, or send an agent token as \"Authorization: Bearer <token>\".", 401);
  const doc = /^[a-z0-9]{8}$/.test(ref) ? await platform.directory.get(ref) : null;
  const role = doc ? await platform.directory.access(whoOf(session), doc) : null;
  if (!doc || !role) return fail("There's no such document, or it isn't shared with you.", 404);
  const canEdit = roleMay(role, "edit");
  if (what == "versions") {
    if (request.method != "GET" && request.method != "HEAD") return fail("GET this.", 405);
    const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
    const state = await platform.docs.versions(doc, { before: url.searchParams.get("before"), limit });
    return state ? json({ ...state, canEdit }) : fail("There's no such document.", 404);
  }
  if (request.method != "POST") return fail(what == "restore" ? "POST this." : "POST {\"mode\": \"latest\"} or {\"mode\": \"manual\", \"versionId\": \"v3\"}.", 405);
  if (!session.agent && request.headers.get("origin") != url.origin) return fail(`Only this site's own pages may ${what}.`, 403);
  if (!canEdit) return fail(`You may only view this document, so you can't ${what} it.`, 403);
  if (what == "restore") {
    // A person's restore is theirs; an agent token's is its person's, via it ("ada, via a shared agent (CI)").
    const by = byLine(session.login.toLowerCase(), whoOf(session).via);
    // Optionally one file only: {"path": "blog/post.html"}.
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
    const path = typeof body?.path == "string" && body.path ? body.path : null;
    const r = await platform.docs.restore(doc, versionRef ?? "", by, path);
    return r.ok ? json({ current: r.current, from: r.from, files: r.files }) : fail(r.error, r.status);
  }
  const body = (await request.json().catch(() => null)) as PublishRequest | null;
  if (!body || typeof body != "object") return fail("Send JSON: {\"mode\": \"latest\"} or {\"mode\": \"manual\", \"versionId\": \"v3\"}.", 400);
  const r = await platform.docs.setPublished(doc, body);
  return r.ok ? json({ published: r.published }) : fail(r.error, r.status);
}

/**
 * A document's file tree (host.ts, /api/tree): GET reads it, for whoever may
 * open the document; POST does one operation, for its editors. Signed in
 * with the app's session (the tree's UI, from this site's pages only) or an
 * agent token. Answers JSON: the tree, or {error}.
 */
async function docTree(request: Request, platform: Platform, session: Session | null, id: string): Promise<Response> {
  const err = (error: string, status: number) => json({ error }, status);
  if (!session) return err("Sign in first, or send an agent token as \"Authorization: Bearer <token>\".", 401);
  const post = request.method == "POST";
  if (post && !session.agent && fromElsewhere(request)) return err("Not from this site.", 403);
  const route = ID.test(id) ? await platform.directory.route(id) : null;
  const access = route && (await platform.directory.access(whoOf(session), route));
  if (!route || !access) return err("There's no such document, or it isn't shared with you.", 404);
  if (post && accessOf(access) != "edit") return err("You can only view this document.", 403);
  const url = new URL(request.url);
  const inner = new Request(new URL("/api/tree", url.origin), { method: request.method, headers: request.headers, body: post ? await request.text() : undefined });
  return platform.docs.fetch(route, forwarded(inner, new URL("/api/tree", url.origin), "/api/tree", `${url.origin}/d/${route.id}`, session, accessOf(access)));
}

/**
 * POST /api/publish: a folder of files as a new document, or into an
 * existing one (`document`), from the command line. Multipart (each file a
 * part, named by its path; or named "file" with its path as the filename)
 * or JSON (create_document's or update_files' arguments).
 */
async function publish(request: Request, ctx: ToolContext): Promise<object> {
  const type = request.headers.get("content-type") ?? "";
  let args: Record<string, unknown>;
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => { throw new ToolError("That multipart body didn't parse."); });
    const files: Record<string, string | Uint8Array> = {};
    let total = 0;
    args = {};
    for (const [key, value] of form.entries()) {
      if (typeof value == "string") {
        if (["title", "slug", "index", "document", "template"].includes(key)) args[key] = value;
        else if (key == "replace") args.replace = value == "true" || value == "1";
        else if (key == "delete") args.delete = [...((args.delete as string[] | undefined) ?? []), value];
        else throw new ToolError(`What's "${key}"? Send files as file parts (-F "path/in/site=@local/file"), and title, slug, index, document, replace or delete as fields.`);
        continue;
      }
      const file = value as File;
      const p = key == "file" || key == "files" || key == "files[]" ? file.name : key;
      addFile(files, cleanPath(p), new Uint8Array(await file.arrayBuffer()), () => total, (n) => { total = n; });
    }
    // Text files as text, so they're edited as text.
    for (const [p, data] of Object.entries(files)) if (typeof data != "string" && /\.(html?|md|markdown|css|m?js|json|svg|txt|xml|csv)$/i.test(p)) {
      try { files[p] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data); } catch { /* left as bytes */ }
    }
    args.files = Object.fromEntries(Object.entries(files).map(([p, d]) => [p, typeof d == "string" ? d : { base64: toBase64(d) }]));
  } else {
    const body = await request.json().catch(() => null);
    if (!body || typeof body != "object" || Array.isArray(body)) throw new ToolError("Send the files as multipart/form-data, or JSON: {\"files\": {\"index.html\": \"...\"}, \"title\": \"...\"}.");
    args = body as Record<string, unknown>;
  }
  if (args.document) {
    const content = await runTool("update_files", { replace: true, ...args }, ctx);
    return { updated: true, ...JSON.parse((content[0] as { text: string }).text) };
  }
  if (!args.files || !Object.keys(args.files as object).length) throw new ToolError("No files: send at least the page (index.html or index.md).");
  const content = await runTool("create_document", args, ctx);
  return { created: true, ...JSON.parse((content[0] as { text: string }).text) };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- MCP

const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/**
 * POST /mcp: the tools as a stateless MCP server (Streamable HTTP): every
 * request stands alone, needs the token, and is answered as JSON; there's no
 * session and no stream (GET is refused, as the spec allows).
 */
async function mcp(request: Request, ctx: ToolContext | null, origin: string): Promise<Response> {
  if (request.method != "POST") return new Response("This MCP server answers POSTs only (stateless, no event stream).", { status: 405, headers: { Allow: "POST" } });
  if (!ctx) return failure(NO_TOKEN(origin), 401);
  const body = await request.json().catch(() => undefined) as RpcMessage | RpcMessage[] | undefined;
  if (body === undefined) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => rpc(m, ctx)))).filter((a) => a != null);
  if (!answers.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? answers : answers[0]);
}

async function rpc(m: RpcMessage, ctx: ToolContext): Promise<object | null> {
  const id = m?.id;
  if (!m || typeof m.method != "string") return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid request" } };
  // Notifications (initialized, cancelled...) need no answer.
  if (id === undefined || id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "erga", title: "Erga", version: "1.0.0" },
        instructions: `Erga (${ctx.origin}) as ${ctx.session.name} (${ctx.session.login}): list, make (publish files as a site), rename, share and delete their documents, read and edit any document they may edit (name it with "document")${(await ctx.platform.directory.users.actsAsAdmin(whoOf(ctx.session))) ? ", and, as they're an admin with an admin token, read and change the server's settings and users" : ""}.${ctx.session.onlyDoc != null ? ` This token reaches one document only (id ${ctx.session.onlyDoc}).` : ""} The full guide: ${ctx.origin}/api/ext.`,
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: (await toolsFor(ctx)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!allTools().some((t) => t.name == name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      try {
        return ok({ content: await runTool(name, m.params?.arguments ?? {}, ctx) });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof ToolError ? e.message : `The tool failed: ${(e as Error)?.message ?? e}` }], isError: true });
      }
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

// ---------------------------------------------------------------- asking for a token

/** A token's expiry as given: an ISO 8601 time, a date (the end of that day, UTC), milliseconds since the epoch, or nothing (never). */
function expiryOf(v: unknown): number | null | "bad" {
  if (v == null || v === "") return null;
  if (typeof v == "number") return Number.isFinite(v) ? v : "bad";
  if (typeof v != "string") return "bad";
  const s = v.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59Z`) : /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? t : "bad";
}

/** POST /api/auth/request {label, scope, doc?, expires?}: a link for the person to approve, and a code to poll with. */
async function askForToken(request: Request, platform: Platform, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: unknown; scope?: unknown; doc?: unknown; expires?: unknown };
  const scope = body?.scope ?? "documents";
  if (!SCOPES.includes(scope as Scope)) return failure(`scope must be "document" (one document: give doc), "documents" or "admin".`, 400);
  const expires = expiryOf(body?.expires);
  if (expires == "bad") return failure("expires must be a time (ISO 8601, e.g. 2026-12-31T00:00:00Z), a date, or left out for a token that lasts until it's revoked.", 400);
  let r;
  try {
    r = await platform.tokens.request(typeof body?.label == "string" ? body.label : null, { scope: scope as Scope, docId: typeof body?.doc == "string" ? body.doc : null, expires });
  } catch (e) {
    if (e instanceof ScopeError) return failure(e.message, 400);
    throw e;
  }
  const approve = `${origin}/tokens/approve?code=${r.userCode}`;
  return json({
    ok: true, code: r.code, user_code: r.userCode, label: r.label, scope, approve_url: approve,
    poll_url: `${origin}/api/auth/poll`, interval: 2, expires_in: Math.round((r.expires - Date.now()) / 1000),
    next: `Ask your person to open ${approve} (signed in to Erga) and approve "${r.label}" (scope: ${scope}). Meanwhile POST {"code": "${r.code}"} to ${origin}/api/auth/poll every couple of seconds: it answers 202 while waiting and 200 with the token once they've approved.`,
  });
}

/** POST /api/auth/poll {code}: 202 waiting, 200 with the token (once), 410 if it expired, was denied or was collected. */
async function pollForToken(request: Request, platform: Platform): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body?.code != "string") return failure("Send {\"code\": \"...\"}, the code /api/auth/request gave you.", 400);
  const r = await platform.tokens.collect(body.code);
  if (r.status == "pending") return json({ ok: false, status: "pending", error: "Not approved yet: ask again in a couple of seconds." }, 202);
  if (r.status == "gone") return json({ ok: false, status: "gone", error: `That request expired (they last ${REQUEST_MINUTES} minutes), was denied, or its token was already collected: ask again.` }, 410);
  return json({ ok: true, status: "approved", token: r.token, login: r.login });
}

// ---------------------------------------------------------------- /tokens

/**
 * /tokens: the signed-in person's tokens (make one with a scope and an
 * optional expiry, revoke one), approving or denying an agent's request
 * (/tokens/approve?code=), and, where the platform makes them, a test token
 * for running the test suite. /settings is the same page.
 */
export async function tokensDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(safeNext(path + url.search))}` } });
  if (session.agent) return page("Not for agents", "Tokens are made and approved by people, signed in.", 403);
  if (session.test) return page("Not for test people", "Sign in as yourself to make a token.", 403);
  const post = request.method == "POST";
  // Only this site's own pages may make, revoke, approve or deny.
  if (post && request.headers.get("origin") != url.origin) return new Response("Forbidden", { status: 403 });
  const form = post ? await request.formData() : null;
  const field = (k: string) => String(form?.get(k) ?? "");
  const who = { login: session.login, name: session.name };
  const error = (message: string) => `<p class="notice error">${esc(message)}</p>`;

  if (path == "/tokens/approve") {
    const code = normalCode(post ? field("code") : url.searchParams.get("code") ?? "");
    const waiting = await platform.tokens.pending(code);
    if (!waiting) return tokensPage(platform, session, url, { notice: error(`That request (${code}) has expired, or was already approved or denied. Ask the agent to start again.`) });
    if (post && field("answer") == "deny") {
      await platform.tokens.deny(code);
      return tokensPage(platform, session, url, { notice: `<p class="notice">Denied: <b>${esc(waiting.label)}</b> gets no token.</p>` });
    }
    if (!post) return tokensPage(platform, session, url, { notice: await approvalCard(platform, session, code, waiting) });
    try {
      const info = await platform.tokens.approve(code, who);
      return tokensPage(platform, session, url, { notice: info ? `<p class="notice">Approved: <b>${esc(info.label)}</b> has its token now. Go back to it. You can revoke it below at any time.</p>` : error("That request has expired.") });
    } catch (e) {
      if (e instanceof ScopeError) return tokensPage(platform, session, url, { notice: error(`${e.message} The request is still waiting: deny it, or ask the agent for another scope.`) });
      throw e;
    }
  }
  if (path == "/tokens/new" && post) {
    const scope = (field("scope") || "documents") as Scope;
    const expires = expiryOf(field("expires"));
    if (expires == "bad") return tokensPage(platform, session, url, { notice: error("That expiry isn't a date.") });
    try {
      const { token, info } = await platform.tokens.mint(who, field("label") || "Agent", { scope, docId: field("doc") || null, expires });
      return tokensPage(platform, session, url, { made: { token, info } });
    } catch (e) {
      if (e instanceof ScopeError) return tokensPage(platform, session, url, { notice: error(e.message) });
      throw e;
    }
  }
  if (path == "/tokens/revoke" && post) {
    await platform.tokens.revoke(session.login, field("id"));
    return new Response(null, { status: 303, headers: { Location: "/tokens" } });
  }
  if (path != "/tokens" && path != "/settings") return page("Not found", "There's nothing here. <a href=\"/tokens\">Your tokens</a>.", 404);
  return tokensPage(platform, session, url, {});
}

const SCOPE_NAMES: Record<Scope, string> = { document: "One document", documents: "All my documents", admin: "Admin" };

/** A document token's document, as a line shows it: its title and address, or "a document that's gone". */
async function docLabel(platform: Platform, ref: string | null): Promise<string> {
  const doc = ref ? await platform.directory.find(ref) : null;
  return doc ? `${esc(nameOf(doc).title)} <span class="addr">${esc(nameOf(doc).address)}</span>` : `<span class="never">a document that's gone</span>`;
}

const day = (t: number) => `<time class="day" datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>`;

/** The card on /tokens/approve: what the agent asks for, and Approve (if the person may give it) or Deny. */
async function approvalCard(platform: Platform, session: Session, code: string, waiting: { label: string; grant: { scope: Scope; docId: string | null; expires: number | null } }): Promise<string> {
  const g = waiting.grant;
  const may = await platform.tokens.check({ login: session.login, name: session.name }, g).then(() => null, (e) => (e instanceof ScopeError ? e.message : "This request can't be approved."));
  const what = g.scope == "document" ? `one document: ${await docLabel(platform, g.docId)}. It can do there what you can do, and nothing anywhere else.`
    : g.scope == "documents" ? "all your documents: everything you can do with documents, but no admin power."
    : "everything you can do in Erga, admin power included (the server's settings, its users, pushes to its source).";
  return `<section class="card approve"><h2>An agent asks to act as you</h2>
<p><b>${esc(waiting.label)}</b> wants a token for ${what}</p>
<dl class="grant"><dt>Scope</dt><dd class="scope-${g.scope}">${SCOPE_NAMES[g.scope]}</dd><dt>Expires</dt><dd>${g.expires ? day(g.expires) : "Never (until you revoke it)"}</dd></dl>
<p>Approve only if you started this and the code matches:</p>
<p class="code">${esc(code)}</p>
${may ? `<p class="notice error">${esc(may)}</p>` : ""}
<form class="buttons" method="post" action="/tokens/approve"><input type="hidden" name="code" value="${esc(code)}">${may ? "" : `<button class="new" name="answer" value="approve">Approve</button>`}<button class="deny" name="answer" value="deny">Deny</button></form></section>`;
}

async function tokensPage(platform: Platform, session: Session, url: URL, o: { notice?: string; made?: { token: string; info: AgentToken } }): Promise<Response> {
  const origin = url.origin;
  const [list, docs, admin] = await Promise.all([
    platform.tokens.list(session.login), platform.docs.list(session.login), platform.directory.users.isAdmin(whoOf(session)),
  ]);
  const when = (t: number | null) => (t ? `<time datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>` : `<span class="never">Never</span>`);
  const scopeCell = async (t: AgentToken) => t.scope == "document" ? `<span class="scope">One document</span> ${await docLabel(platform, t.docId)}` : `<span class="scope">${SCOPE_NAMES[t.scope]}</span>`;
  // Rows as the documents list's: its name (and whether it's the share button's), its scope, when it expires, when it was last used, revoke on hover.
  const rows = (await Promise.all(list.map(async (t) => `  <li${t.expires != null && t.expires <= Date.now() ? ` class="expired"` : ""}>
    <div class="name"><span class="title">${esc(t.label)}</span>${t.kind == "share" ? `<span class="note">${t.scope == "admin" ? "Admin pages" : "Share button"}</span>` : ""}</div>
    <div class="what">${await scopeCell(t)}</div>
    ${t.expires ? (t.expires <= Date.now() ? `<span class="never">Expired</span>` : day(t.expires)) : `<span class="never">Never</span>`}
    ${when(t.lastUsed)}
    <div class="acts"><form method="post" action="/tokens/revoke" data-label="${esc(t.label)}"><input type="hidden" name="id" value="${esc(t.id)}"><button class="act" aria-label="Revoke ${esc(t.label)}" data-tip="Revoke">${ICON.delete}</button></form></div>
  </li>`))).join("\n");
  const m = o.made;
  const made = m ? `<section class="card made"><h2>${esc(m.info.label)}</h2>
<p>${SCOPE_NAMES[m.info.scope]}${m.info.scope == "document" ? `: ${await docLabel(platform, m.info.docId)}` : ""}. ${m.info.expires ? `Expires ${day(m.info.expires)}.` : "It lasts until you revoke it."} Copy it now: it isn't shown again.</p>
<pre class="secret">${esc(m.token)}</pre>
<p>Tell your agent:</p>
<pre>Erga's API is at ${esc(origin)}: read ${esc(origin)}/llms.txt first. My token is ${esc(m.token)}
(send it as "Authorization: Bearer &lt;token&gt;").</pre>
<p>Or add Erga to Claude Code:</p>
<pre>claude mcp add --transport http erga ${esc(origin)}/mcp --header "Authorization: Bearer ${esc(m.token)}"</pre>${m.info.scope == "admin" ? `
<p>To push to Erga's source with it (README, Tokens), once:</p>
<pre>git remote set-url origin ${esc(origin)}/git/erga.git
printf 'protocol=${esc(url.protocol.replace(":", ""))}\\nhost=${esc(url.host)}\\nusername=token\\npassword=${esc(m.token)}\\n\\n' | git credential approve</pre>` : ""}</section>` : "";
  const test = platform.testToken ? await platform.testToken(session.login) : null;
  const testBlock = test ? `<section class="part">
  <h2>Test token</h2>
  <p class="sub">Runs the test suite here, as test people, on test documents only. Until ${day(test.expires.getTime())}.</p>
  <pre>ERGA_TEST_TOKEN=<span class="secret">${esc(test.token)}</span> bun run test:prod</pre>
</section>` : "";
  const docOptions = docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (/${esc(d.owner)}/${esc(d.slug)})</option>`).join("");
  const style = `
  .part { margin-bottom: 56px; }
  .part h2 { margin: 0; font-size: 17px; font-weight: 620; letter-spacing: -0.01em; color: var(--fg-strong); }
  .part > header { margin-bottom: 20px; align-items: flex-end; }
  .part > .sub { margin-bottom: 16px; }
  .part .sub a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 0.2em; }
  .labels, ol.rows > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) 7rem 7rem 40px; align-items: center; column-gap: 16px; }
  .labels { padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 12px; font-weight: 500; color: var(--chrome); }
  ol.rows > li, ol.rows > li:first-child { border: 0; }
  ol.rows > li.expired { opacity: 0.55; }
  ol.rows { padding-top: 6px; margin-bottom: 20px; }
  .name { min-width: 0; display: flex; align-items: center; gap: 12px; padding: 11px 0; }
  .what { min-width: 0; font-size: 13px; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope { font-weight: 550; color: var(--fg-strong); }
  .addr { color: var(--chrome); }
  .note { padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--soft); background: color-mix(in srgb, var(--chrome) 13%, transparent); }
  time, .never { margin: 0; text-align: left; font-size: 13px; color: var(--soft); }
  .acts { display: flex; justify-content: flex-end; }
  .acts .act { position: relative; }
  .acts .act[data-tip]::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); z-index: 40;
    white-space: pre; font: 400 12px/1.3 var(--font-text); letter-spacing: 0.01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .acts .act[data-tip]:hover::after { opacity: 1; } }
  .empty { margin-bottom: 20px; padding: 32px 24px; }
  form.add { display: grid; gap: 14px; max-width: 560px; padding: 18px 20px; border: 1px solid var(--rule); border-radius: 12px; }
  form.add h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  form.add label.field { display: grid; gap: 6px; font-size: 13px; font-weight: 500; color: var(--soft); }
  form.add fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 8px; }
  form.add legend { margin-bottom: 6px; font-size: 13px; font-weight: 500; color: var(--soft); }
  form.add .choice { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--fg-strong); }
  form.add .choice small { color: var(--soft); font-size: 12.5px; }
  form.add select, form.add input[type=date] { font: inherit; font-size: 14px; padding: 6px 8px; border: 1px solid var(--rule); border-radius: 8px; background: transparent; color: var(--fg-strong); max-width: 100%; }
  form.add .doc-pick { margin-left: 26px; }
  form.add .buttons { display: flex; }
  .card { margin: 0 0 24px; padding: 18px 20px; border: 1px solid var(--rule); border-radius: 12px; font-size: 14px; }
  .card h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  .card p { margin: 0 0 10px; }
  .made, .approve { border-color: var(--caret); }
  .card .buttons { display: flex; align-items: center; gap: 12px; }
  .card button.new, .card button.deny { font: inherit; font-size: 13.5px; font-weight: 550; }
  .card button.deny { padding: 6px 12px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--soft); cursor: pointer; }
  dl.grant { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 0 0 12px; font-size: 14px; }
  dl.grant dt { color: var(--soft); }
  dl.grant dd { margin: 0; font-weight: 550; color: var(--fg-strong); }
  dl.grant dd.scope-admin { color: #c2410c; }
  pre { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--chrome) 9%, transparent); font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; color: var(--fg-strong); }
  .secret { user-select: all; }
  .code { font: 600 26px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; color: var(--fg-strong); }
  .notice { margin: 0 0 24px; padding: 12px 14px; border-radius: 10px; font-size: 14px; background: color-mix(in srgb, var(--caret) 10%, transparent); }
  .notice.error { background: color-mix(in srgb, #c2410c 12%, transparent); }
  @media (max-width: 620px) { .labels { display: none; } .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) auto 40px; } ol.rows .what, ol.rows > li > time:nth-of-type(2), ol.rows > li > .never:nth-of-type(2) { display: none; } }
`;
  const html = appPage("Tokens", style, `${brand(session)}<main>
  <header><div><h1>Tokens</h1></div></header>
  ${o.notice ?? ""}
  ${made}
  <section class="part">
  <h2>Your tokens</h2>
  <p class="sub">A token lets an agent or a script (Claude Code, Codex, git) act as you, within its scope. <a href="/llms.txt">Point agents here</a>.</p>
  ${list.length ? `<div class="labels" aria-hidden="true"><span>Name</span><span>Scope</span><span>Expires</span><span>Last used</span><span></span></div>
  <ol class="rows">\n${rows}\n  </ol>` : `<p class="empty">No tokens yet.</p>`}
  <form class="add" method="post" action="/tokens/new">
    <h3>New token</h3>
    <label class="field">Name<input class="input" name="label" maxlength="${LABEL_MAX}" placeholder="What it's for: Claude Code on my laptop" autocomplete="off"></label>
    <fieldset><legend>Scope</legend>
      <label class="choice"><input type="radio" name="scope" value="document"${docs.length ? "" : " disabled"}> One document <small>only that document, with your rights there</small></label>
      <select class="doc-pick" name="doc" aria-label="The document"${docs.length ? "" : " disabled"}>${docOptions || `<option value="">You have no documents</option>`}</select>
      <label class="choice"><input type="radio" name="scope" value="documents" checked> All my documents <small>everything you can do with documents, no admin power</small></label>
      ${admin ? `<label class="choice"><input type="radio" name="scope" value="admin"> Admin <small>everything you can do, admin power and git push included</small></label>` : ""}
    </fieldset>
    <label class="field">Expires (optional)<input type="date" name="expires" min="${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}" aria-label="Expiry date"></label>
    <div class="buttons"><button class="pill">${ICON.plus}Make token</button></div>
  </form>
  </section>
  ${testBlock}
</main>
<script>
  ${TIMES_SCRIPT}
  for (const t of document.querySelectorAll("time.day")) t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  for (const f of document.querySelectorAll("form[data-label]")) f.addEventListener("submit", (e) => { if (!confirm("Revoke \\u201c" + f.dataset.label + "\\u201d? Agents using it lose access at once.")) e.preventDefault(); });
  // Picking a document picks the one-document scope.
  const pick = document.querySelector(".doc-pick"), one = document.querySelector("input[name=scope][value=document]");
  pick?.addEventListener("change", () => { if (one && !one.disabled) one.checked = true; });
</script>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------- the guide

/** Whether a token's person may use the admin tools now (an admin-scope token), is an admin without one ("locked"), or neither. */
async function adminStatus(platform: Platform, session: Session): Promise<boolean | "locked"> {
  const users = platform.directory.users, who = whoOf(session);
  return (await users.actsAsAdmin(who)) ? true : (await users.isAdmin(who)) ? "locked" : false;
}

/**
 * The guide (/llms.txt for anyone; /api/ext, personal, with a token): enough for an agent to start from nothing.
 * `admin`: the admin tools work for this token (an admin-scope token), or "locked": its person is an admin, but this isn't an admin token.
 */
export function guide(origin: string, session: ToolContext["session"] | null, adminOrLocked: boolean | "locked"): string {
  const admin = adminOrLocked === true, locked = adminOrLocked == "locked";
  const toolDocs = (tools: ServerTool[]) => tools.map((t) => `### ${t.name}\n\n${t.description}\n\n\`\`\`json\n${JSON.stringify(t.parameters)}\n\`\`\``).join("\n\n");
  const you = session
    ? `You're signed in as **${session.name}** (${session.login}), with the token "${session.agent.label}" (scope: ${session.agent.scope}${session.agent.expires ? `, until ${new Date(session.agent.expires).toISOString()}` : ""}). Everything below acts as them.${session.onlyDoc != null ? ` This token reaches one document only (id ${session.onlyDoc}): list_documents, create_document and the token tools are refused, and so is every other document.` : ""}${admin ? " They're an admin of this server, and this is an admin token, so the admin tools are yours too." : locked ? " They're an admin of this server, but the admin tools need an admin token (below)." : ""}`
    : `Nothing here works without a token: get one first (below).`;
  return `# Erga

> Erga (${origin}) is a multiplayer page editor: people and their agents edit
> HTML and Markdown documents together, in place, on the rendered page. Each
> document is a folder of files (its pages, styles, scripts, images), at
> ${origin}/<owner>/<slug>: index.html is that address, and every other page
> is at its path without .html (blog/post.html at /<owner>/<slug>/blog/post,
> blog/index.html at /<owner>/<slug>/blog). Any of these with #edit opens it in
> the editor. This API lets an agent do everything a person can
> do in the app, as that person: list, make, rename, share and delete their
> documents, publish a folder of files (a static site, a page) as a document,
> read and edit any document they may edit, and, for a server admin, configure
> the server (its settings and who may sign in). The editor's own agent has
> the same tools, for the same person.

${you}

## Getting a token

Every call carries a token that stands for one person:

    Authorization: Bearer erga_...

Each token has a scope: \`document\` (one document, with the person's rights
there, and nothing else), \`documents\` (everything they can do with documents,
but no admin power) or \`admin\` (everything they can do, admin power included,
while they're an admin; only admins can have one). It may also have an expiry,
after which it stops working. Ask for the smallest scope that does the job.

Your person may give you one (they make it at ${origin}/tokens, or with the
share button in the editor, which gives a documents token). If you don't have
one, ask for it: no sign-in needed on your side.

    curl -s -X POST ${origin}/api/auth/request -H "Content-Type: application/json" -d '{"label": "Claude Code", "scope": "documents"}'

For one document, \`"scope": "document", "doc": "<its address, URL or id>"\`; for
an expiry, \`"expires": "2026-12-31T00:00:00Z"\` (or a date). Your person sees
the scope, the document and the expiry, and approves or denies.

The answer has an \`approve_url\` and a \`code\`. Show your person the
\`approve_url\` (and the \`user_code\`) and ask them to open it and approve.
Meanwhile poll, every couple of seconds:

    curl -s -X POST ${origin}/api/auth/poll -H "Content-Type: application/json" -d '{"code": "<code>"}'

It answers 202 while they haven't approved yet, then 200 with \`{"token": "erga_..."}\`
(once), or 410 if they denied it. The request lasts ${REQUEST_MINUTES} minutes. Keep the token somewhere
safe for later (an environment variable, ERGA_TOKEN): it works until it expires
or your person revokes it at ${origin}/tokens.

## Calling the API

Two ways to the same tools.

**HTTP.** \`GET ${origin}/api/ext/tools\` lists them as JSON; run one by POSTing its
arguments as JSON:

    curl -s -X POST ${origin}/api/ext/tools/list_documents -H "Authorization: Bearer $ERGA_TOKEN" -H "Content-Type: application/json" -d '{}'

The answer is \`{"ok": true, "content": [{"type": "text", "text": "..."}]}\` (the
text is JSON for the server's own tools; a document tool may answer an image,
\`{"type": "image", "mimeType": "image/png", "data": "<base64>"}\`). A failure is
\`{"ok": false, "error": "..."}\` with 400 (fix the call as the error says), 401
(no token, or a revoked or expired one), 403 (not allowed, or outside the token's scope), 404 (no such tool or document)
or 413 (too big).

**MCP.** \`${origin}/mcp\` is a stateless MCP server (Streamable HTTP, JSON
answers) with the same tools. In Claude Code:

    claude mcp add --transport http erga ${origin}/mcp --header "Authorization: Bearer $ERGA_TOKEN"

## Publishing a folder (a static site) as a document

To put a local static web app or page on Erga, send its folder: it needs an
index.html (or index.md) at the top. From the folder (the build output, if it
has one):

    args=(); while IFS= read -r f; do args+=(-F "\${f#./}=@\$f"); done < <(find . -type f ! -path '*/.*' ! -path '*/node_modules/*')
    curl -s -X POST ${origin}/api/publish -H "Authorization: Bearer $ERGA_TOKEN" -F "title=My app" "\${args[@]}"

Each file part is named by its path in the site. The answer's \`url\` is the
document, which opens in the editor (give it to your person); \`id\` and \`api\`
are for working on it. To publish the folder again into the same document, add
\`-F document=<id>\`: the files are replaced (merged as edits, so open editors
follow) and files that are gone are deleted. JSON works too: \`{"title": "...",
"files": {"index.html": "<!doctype html>...", "logo.png": {"base64": "..."}}}\`,
which is what the create_document and update_files tools take. Files can be at
most 2MB each, 50MB in all. The page runs as it would anywhere (its scripts
too), on an origin of its own; relative links between its files work.

## Working in a document

A document is a folder of files. Pages are its .html (or .md) files
(index.html is the home page); everything else (CSS, JS, images, fonts) is
shared assets. Users see pages; you see files: the document tools see the
whole document as one file system, rooted at its folder.

Every document has the tools its embedded agent uses (read, edit, write, ls,
find, grep, list_pages, open_page, new_page, mkdir, mv, rm, view_page,
evaluate_page, get_title, set_title). Here they take a \`document\` argument too.
open_page switches your person's open editor on that document to another
page (if they have none open, it says so and gives the address). Each document also has its own guide, with the rules for
writing pages people can keep editing by hand (read it before changing a page
much): \`GET ${origin}/d/<id>/api/ext\` with the same token. Your edits show up
live in everyone's editor, attributed to your person's agent, and your person
can undo them one call at a time. edit matches text exactly as it is right
now: read a file right before editing it, and read again if an edit fails
because someone changed the text meanwhile.

## Versions and publishing

Each document keeps versions: snapshots of all its files, cut after each burst
of edits and each agent turn, with a five-word description. What its viewers
see is either "latest" (the document as it is) or one version ("manual"). The
document tools list_versions, read_version, diff_versions, restore_version and publish_version handle them; so
does plain HTTP:

    curl -s ${origin}/api/docs/<id>/versions -H "Authorization: Bearer $ERGA_TOKEN"
    curl -s -X POST ${origin}/api/docs/<id>/publish -H "Authorization: Bearer $ERGA_TOKEN" -H "Content-Type: application/json" -d '{"mode": "manual", "versionId": "v3"}'
    curl -s -X POST ${origin}/api/docs/<id>/versions/v3/restore -H "Authorization: Bearer $ERGA_TOKEN"
    curl -s -X POST ${origin}/api/docs/<id>/versions/v3/restore -H "Authorization: Bearer $ERGA_TOKEN" -H "Content-Type: application/json" -d '{"path": "blog/post.html"}'

Only someone who may edit a document may publish it or restore a version (a
restore writes the old version's files over the document, as a new version;
with a path, only that file).
Do either only when your person asks.

## The server's tools

${toolDocs([...TOOLS, ...sharedTools.filter((t) => !t.admin)])}

## Admin tools

For the server's admins only, with an admin token (a token with the admin scope): ${session ? (admin ? "yours is one, so these are listed for you and work while your person is an admin." : locked ? `${session.login} is an admin, but this token's scope is ${session.agent.scope}, so these aren't listed for it and are refused.` : `${session.login} isn't one, so these aren't listed for your token and are refused.`) : "they work only with an admin token."}
Your person makes one at ${origin}/tokens (scope: Admin), or approves your
request for one (\`"scope": "admin"\`). It works only while they're an admin.
The settings are the server's own (list_settings says what each does); one the
deploy locks shows as \`"locked": true\` and can't be changed here. Users are
everyone who may sign in; an admin by the deploy (\`"bootstrap": true\`) can't
be demoted or removed here.

${admin || !session ? toolDocs(sharedTools.filter((t) => t.admin)) : "(none for you)"}

## Document tools

${toolDocs(documentTools())}
`;
}
