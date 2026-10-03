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
//   POST /api/auth/request         an agent asks for a token: a link for its person to approve
//   POST /api/auth/poll            ... and collects the token once they have
//   POST /mcp                      the same tools as a stateless MCP server (Streamable HTTP, JSON answers)
//   /tokens                        a person's tokens: make, revoke, approve an agent's request
//
// The Worker (worker/index.ts) sends those paths here, with the platform
// that knows agent tokens (front.ts, withTokens). The share button's token
// (<document>/api/share) is front.ts's.
//
// Tools are a registry (`TOOLS`): a name, a description, arguments as JSON
// Schema and a `run`, given who's asking and the platform. Adding one is
// adding an entry; REST, MCP and the guide all list it. The document tools
// (read, edit, write, ... from agent.ts) are added with a `document`
// argument and run in that document's host, as the person's agent.

import { documentToolSpecs, type ToolContent, type ToolSpec } from "./agent";
import { type Action, type DocRow, type Route, nameOf } from "./directory";
import { accessOf, documentRoute, esc, forwarded, ID, makeDoc, newDocId, page, safeNext, type Platform, type Session, whoOf } from "./front";
import { cleanRel } from "./host";
import { LABEL_MAX, normalCode, REQUEST_MINUTES, type AgentToken } from "./tokens";

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
  /** Its answer: text, JSON (shown as text), or content items (text, images). Throws a ToolError the agent can act on. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | object | ToolContent[]>;
}

/** A tool's failure, worded for the agent to act on; `status` is the HTTP status the REST API answers. */
export class ToolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

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
    description: "Who your token stands for, and what it's called.",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, origin }) => ({ login: session.login, name: session.name, token: { id: session.agent.id, label: session.agent.label }, server: origin }),
  },
  {
    name: "list_documents",
    description: "The person's documents, most recently edited first: id, title, address, URL, when it was last edited, and when it goes if nobody edits it (only for never-edited ones).",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, platform, origin }) => (await platform.docs.list(session.login)).map((d) => ({
      id: d.id, title: d.title, address: `/${d.owner}/${d.slug}`, url: `${origin}/${d.owner}/${d.slug}`,
      modified: new Date(d.modified).toISOString(), ...(d.expires != null ? { expires: new Date(d.expires).toISOString() } : {}), ...(d.path != null ? { onDisk: d.path } : {}),
    })),
  },
  {
    name: "create_document",
    description: `Makes a new document and answers its URL. With files, it's those files (publishing a site or a page: a folder with index.html or index.md, plus its styles, scripts and images), and it stays. Without files it's a blank page (or a copy of the demo, template: "demo"), which goes if nobody edits it in time (the server's unedited_hours setting; it says when). The title follows the page's first heading unless you give one; the address (/<owner>/<slug>) follows the title unless you give a slug.`,
    parameters: {
      type: "object",
      properties: {
        files: FILES_ARG,
        index: str("The page, if it isn't index.html or index.md: an .html or .md file among the files."),
        title: str("Its title (else the page's first heading)."),
        slug: str("Its address after /<owner>/ (letters, digits and dashes; else made from the title). Taken already, it gets -2, -3..."),
        template: { type: "string", enum: ["blank", "demo"], description: "Without files: a blank page (the default) or a copy of the demo." },
      },
    },
    run: async (args, ctx) => {
      const { session, platform } = ctx;
      // Anyone who may sign in may make documents (withTokens checked they still may); test people only test documents.
      if (session.test) throw new ToolError("You can't make documents on this server.", 403);
      let files = decodeFiles(args.files);
      const published = Object.keys(files).length > 0;
      if (!published) files = { ...platform.templates[args.template == "demo" ? "demo" : "doc"] };
      const index = pageOf(files, args.index);
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
      const r = await ctx.platform.docs.publish(doc, files, [...remove]);
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
    description: "The person's agent tokens (never the tokens themselves): id, label, when made and last used.",
    parameters: { type: "object", properties: {} },
    run: async (_args, { session, platform }) => (await platform.tokens.list(session.login)).map((t) => ({
      id: t.id, label: t.label, kind: t.kind, created: new Date(t.created).toISOString(), lastUsed: t.lastUsed ? new Date(t.lastUsed).toISOString() : null, ...(t.id == session.agent.id ? { yours: true } : {}),
    })),
  },
  {
    name: "revoke_token",
    description: "Turns one of the person's agent tokens off, by id (list_tokens). Revoking your own ends your access.",
    parameters: { type: "object", properties: { id: str("The token's id.") }, required: ["id"] },
    run: async (args, { session, platform }) => {
      if (!(await platform.tokens.revoke(session.login, String(args.id ?? "")))) throw new ToolError(`You have no token "${args.id}".`, 404);
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

/** Every tool: the server's, then the documents'. */
export const allTools = (): ServerTool[] => [...TOOLS, ...documentTools()];
const specOf = (t: ServerTool): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters });

/** Runs a tool by name; its answer as content items. */
async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolContent[]> {
  const tool = allTools().find((t) => t.name == name);
  if (!tool) throw new ToolError(`There's no tool named "${name}". The tools are: ${allTools().map((t) => t.name).join(", ")}.`, 404);
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
async function resolve(ctx: ToolContext, ref: unknown, action: Action): Promise<DocRow> {
  if (typeof ref != "string" || !ref.trim()) throw new ToolError("Name the document: its address (/<owner>/<slug>), URL or id.");
  let path = ref.trim();
  try { path = new URL(path).pathname; } catch { /* not a URL */ }
  const parts = path.split("/").filter(Boolean);
  const { platform, session } = ctx;
  let route: Route | null = null;
  if (parts.length >= 2) route = await documentRoute(platform, parts[0], parts[1]);
  else if (parts.length == 1) {
    route = ID.test(parts[0]) ? await platform.directory.route(parts[0]) : null;
    route ??= await documentRoute(platform, session.login, parts[0]);
  }
  const doc = route && await platform.directory.get(route.id);
  if (!doc) throw new ToolError(`There's no document "${ref}". list_documents lists yours.`, 404);
  if (!(await platform.directory.may(whoOf(session), action, doc))) {
    throw new ToolError(action == "delete" ? "Only its owner can delete a document." : `You can't ${action} that document.`, 403);
  }
  return doc;
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

  if (path == "/llms.txt" && (method == "GET" || method == "HEAD")) return new Response(guide(origin, null), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
  if ((path == "/api" || path == "/api/ext") && (method == "GET" || method == "HEAD")) {
    if (request.headers.get("authorization") && !agent) return failure(NO_TOKEN(origin), 401);
    return new Response(guide(origin, agent), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (path == "/mcp") return mcp(request, ctx, origin);
  if (path == "/api/ext/tools" && method == "GET") return json({ ok: true, tools: allTools().map(specOf) });
  if (path == "/api/auth/request" && method == "POST") return askForToken(request, platform, origin);
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
        instructions: `Erga (${ctx.origin}) as ${ctx.session.name} (${ctx.session.login}): list, make (publish files as a site), rename and delete their documents, and read and edit any document they may edit (name it with "document"). The full guide: ${ctx.origin}/api/ext.`,
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: allTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
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

/** POST /api/auth/request {label}: a link for the person to approve, and a code to poll with. */
async function askForToken(request: Request, platform: Platform, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: unknown };
  const r = await platform.tokens.request(typeof body?.label == "string" ? body.label : null);
  const approve = `${origin}/tokens/approve?code=${r.userCode}`;
  return json({
    ok: true, code: r.code, user_code: r.userCode, label: r.label, approve_url: approve,
    poll_url: `${origin}/api/auth/poll`, interval: 2, expires_in: Math.round((r.expires - Date.now()) / 1000),
    next: `Ask your person to open ${approve} (signed in to Erga) and approve "${r.label}". Meanwhile POST {"code": "${r.code}"} to ${origin}/api/auth/poll every couple of seconds: it answers 202 while waiting and 200 with the token once they've approved.`,
  });
}

/** POST /api/auth/poll {code}: 202 waiting, 200 with the token (once), 410 if it expired or was collected. */
async function pollForToken(request: Request, platform: Platform): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body?.code != "string") return failure("Send {\"code\": \"...\"}, the code /api/auth/request gave you.", 400);
  const r = await platform.tokens.collect(body.code);
  if (r.status == "pending") return json({ ok: false, status: "pending", error: "Not approved yet: ask again in a couple of seconds." }, 202);
  if (r.status == "gone") return json({ ok: false, status: "gone", error: `That request expired (they last ${REQUEST_MINUTES} minutes) or its token was already collected: ask again.` }, 410);
  return json({ ok: true, status: "approved", token: r.token, login: r.login });
}

// ---------------------------------------------------------------- /tokens

/**
 * /tokens: the signed-in person's agent tokens (make one, revoke one),
 * approving an agent's request (/tokens/approve?code=), and, where the
 * platform makes them, a test token for running the test suite.
 */
export async function tokensDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
  const session = await platform.sessionOf(request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(safeNext(path + url.search))}` } });
  if (session.agent) return page("Not for agents", "Tokens are made and approved by people, signed in.", 403);
  if (session.test) return page("Not for test people", "Sign in as yourself to make a token.", 403);
  const post = request.method == "POST";
  // Only this site's own pages may make, revoke or approve.
  if (post && request.headers.get("origin") != url.origin) return new Response("Forbidden", { status: 403 });
  const form = post ? await request.formData() : null;
  const field = (k: string) => String(form?.get(k) ?? "");
  const who = { login: session.login, name: session.name };

  if (path == "/tokens/approve") {
    const code = normalCode(post ? field("code") : url.searchParams.get("code") ?? "");
    const waiting = await platform.tokens.pending(code);
    if (!waiting) return tokensPage(platform, session, url, { notice: `<p class="notice error">That request (${esc(code)}) has expired or was already approved. Ask the agent to start again.</p>` });
    if (!post) {
      return tokensPage(platform, session, url, {
        notice: `<section class="approve"><h2>An agent asks to act as you</h2>
<p><b>${esc(waiting.label)}</b> wants a token that lets it do everything you can do on Erga: list, make, edit, rename and delete your documents. Approve only if you started this, and the code matches what it showed you:</p>
<p class="code">${esc(code)}</p>
<form method="post" action="/tokens/approve"><input type="hidden" name="code" value="${esc(code)}"><button class="primary">Approve</button> <a href="/tokens">Not now</a></form></section>`,
      });
    }
    const info = await platform.tokens.approve(code, who);
    return tokensPage(platform, session, url, { notice: info ? `<p class="notice">Approved: <b>${esc(info.label)}</b> has its token now. Go back to it. You can revoke it below at any time.</p>` : `<p class="notice error">That request has expired.</p>` });
  }
  if (path == "/tokens/new" && post) {
    const { token, info } = await platform.tokens.mint(who, field("label") || "Agent");
    return tokensPage(platform, session, url, { made: { token, label: info.label } });
  }
  if (path == "/tokens/revoke" && post) {
    await platform.tokens.revoke(session.login, field("id"));
    return new Response(null, { status: 303, headers: { Location: "/tokens" } });
  }
  if (path != "/tokens") return page("Not found", "There's nothing here. <a href=\"/tokens\">Your tokens</a>.", 404);
  return tokensPage(platform, session, url, {});
}

async function tokensPage(platform: Platform, session: Session, url: URL, o: { notice?: string; made?: { token: string; label: string } }): Promise<Response> {
  const origin = url.origin;
  const list = await platform.tokens.list(session.login);
  const when = (t: number | null) => (t ? `<time datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>` : "never");
  const rows = list.map((t) => `<li><span class="label">${esc(t.label)}</span><span class="meta">${t.kind == "share" ? "share button · " : ""}made ${when(t.created)} · used ${when(t.lastUsed)}</span>
<form method="post" action="/tokens/revoke" data-label="${esc(t.label)}"><input type="hidden" name="id" value="${esc(t.id)}"><button class="revoke">Revoke</button></form></li>`).join("\n");
  const made = o.made ? `<section class="made"><h2>Your new token: ${esc(o.made.label)}</h2>
<p>Copy it now: it isn't shown again.</p>
<pre class="secret">${esc(o.made.token)}</pre>
<p>Tell your agent (Claude Code, Codex...):</p>
<pre>Erga's API is at ${esc(origin)}: read ${esc(origin)}/llms.txt first. My token is ${esc(o.made.token)}
(send it as "Authorization: Bearer &lt;token&gt;").</pre>
<p>Or add Erga to Claude Code as an MCP server:</p>
<pre>claude mcp add --transport http erga ${esc(origin)}/mcp --header "Authorization: Bearer ${esc(o.made.token)}"</pre></section>` : "";
  const test = platform.testToken ? await platform.testToken(session.login) : null;
  const testBlock = test ? `<section class="test"><h2>Test token</h2>
<p>This one is different: it signs in test people (Ada, Bo, ...) who can open only test documents under <b>/${esc(session.login)}/test…</b>, where a scripted agent stands in for the model, so the test suite runs here for free. It lasts until ${test.expires.toUTCString()}. Each visit makes a new one.</p>
<pre class="secret">${esc(test.token)}</pre>
<p>Run the suite against ${esc(origin)}:</p>
<pre>ERGA_TEST_TOKEN=${esc(test.token)} bun run test:prod</pre></section>` : "";
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tokens · Erga</title>
<link rel="stylesheet" href="/fonts/inter.css">
<link rel="stylesheet" href="/style.css">
<style>
  body { font-size: 15px; line-height: 1.55; }
  main { max-width: var(--column); margin: 0 auto; padding: 12vh 20px 48px; }
  h1 { margin: 0 0 6px; font-size: 24px; font-weight: 650; letter-spacing: -0.015em; color: var(--fg-strong); }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 620; color: var(--fg-strong); }
  p { margin: 0 0 12px; }
  .lede { color: var(--soft); margin-bottom: 26px; }
  a { color: inherit; text-decoration-color: var(--mark); text-underline-offset: 0.2em; }
  section { margin: 0 0 28px; padding: 18px; border: 1px solid var(--rule); border-radius: 14px; }
  .made, .approve { border-color: var(--caret); }
  pre { margin: 0 0 12px; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--chrome) 9%, transparent); font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; color: var(--fg-strong); }
  .secret { user-select: all; }
  .code { font: 600 26px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; color: var(--fg-strong); }
  .notice { padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--caret) 10%, transparent); }
  .notice.error { background: color-mix(in srgb, #c2410c 12%, transparent); }
  ol { list-style: none; margin: 0 0 16px; padding: 0; }
  li { display: flex; align-items: baseline; gap: 12px; padding: 11px 2px; border-bottom: 1px solid var(--rule); }
  li:first-child { border-top: 1px solid var(--rule); }
  .label { font-weight: 550; color: var(--fg-strong); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: 1; font-size: 13px; color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  form { margin: 0; }
  .new { display: flex; gap: 8px; }
  .new input { flex: 1; min-width: 0; padding: 7px 12px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--fg-strong); font: inherit; font-size: 14px; }
  button { font: 600 13px var(--font-text); padding: 7px 14px; border-radius: 999px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary, .new button { border-color: var(--fg-strong); background: var(--fg-strong); color: var(--bg); }
  .revoke { padding: 4px 11px; font-size: 12.5px; }
  .empty { color: var(--soft); padding: 12px 2px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
  footer { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--chrome); }
  footer a { text-decoration: none; }
  @media (max-width: 520px) { li { flex-wrap: wrap; } .meta { flex-basis: 100%; order: 3; } main { padding-top: 6vh; } }
</style>
<main>
  <h1>Tokens</h1>
  <p class="lede">An agent token lets an agent (Claude Code, Codex, a script) do everything you can do on Erga, as you: list, make, edit, rename and delete your documents, and publish a folder of files as a site. Point the agent at <a href="/llms.txt">${esc(origin)}/llms.txt</a>; it explains the rest, including how to ask you for a token itself.</p>
  ${o.notice ?? ""}
  ${made}
  <h2>Your tokens</h2>
  ${list.length ? `<ol>\n${rows}\n</ol>` : `<p class="empty">None yet. The share button in the editor makes one too.</p>`}
  <form class="new" method="post" action="/tokens/new"><input name="label" maxlength="${LABEL_MAX}" placeholder="What it's for: Claude Code on my laptop" aria-label="What the token is for" autocomplete="off"><button>New token</button></form>
  <div style="height:28px"></div>
  ${testBlock}
  <footer><span>Signed in as ${esc(session.login)}</span><a href="/docs">Documents</a><a href="/llms.txt">The API</a><a href="/auth/logout">Sign out</a></footer>
</main>
<script>
  for (const f of document.querySelectorAll("form[data-label]")) f.addEventListener("submit", (e) => { if (!confirm("Revoke \\u201c" + f.dataset.label + "\\u201d? Agents using it lose access at once.")) e.preventDefault(); });
  for (const t of document.querySelectorAll("time")) { const d = new Date(t.dateTime); t.title = d.toLocaleString(); t.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
</script>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------- the guide

/** The guide (/llms.txt for anyone; /api/ext, personal, with a token): enough for an agent to start from nothing. */
export function guide(origin: string, session: ToolContext["session"] | null): string {
  const toolDocs = (tools: ServerTool[]) => tools.map((t) => `### ${t.name}\n\n${t.description}\n\n\`\`\`json\n${JSON.stringify(t.parameters)}\n\`\`\``).join("\n\n");
  const you = session
    ? `You're signed in as **${session.name}** (${session.login}), with the token "${session.agent.label}". Everything below acts as them.`
    : `Nothing here works without a token: get one first (below).`;
  return `# Erga

> Erga (${origin}) is a multiplayer page editor: people and their agents edit
> HTML and Markdown documents together, in place, on the rendered page. Each
> document is a folder of files (a page, its styles, scripts, images), at
> ${origin}/<owner>/<slug>. This API lets an agent do everything a person can
> do in the app, as that person: list, make, rename and delete their documents,
> publish a folder of files (a static site, a page) as a document, and read and
> edit any document they may edit.

${you}

## Getting a token

Every call carries an agent token that stands for one person:

    Authorization: Bearer erga_...

Your person may give you one (they make it at ${origin}/tokens, or with the
share button in the editor). If you don't have one, ask for it: no sign-in
needed on your side.

    curl -s -X POST ${origin}/api/auth/request -H "Content-Type: application/json" -d '{"label": "Claude Code"}'

The answer has an \`approve_url\` and a \`code\`. Show your person the
\`approve_url\` (and the \`user_code\`) and ask them to open it and approve.
Meanwhile poll, every couple of seconds:

    curl -s -X POST ${origin}/api/auth/poll -H "Content-Type: application/json" -d '{"code": "<code>"}'

It answers 202 while they haven't approved yet, then 200 with \`{"token": "erga_..."}\`
(once). The request lasts ${REQUEST_MINUTES} minutes. Keep the token somewhere
safe for later (an environment variable, ERGA_TOKEN): it works until your person
revokes it at ${origin}/tokens.

## Calling the API

Two ways to the same tools.

**HTTP.** \`GET ${origin}/api/ext/tools\` lists them as JSON; run one by POSTing its
arguments as JSON:

    curl -s -X POST ${origin}/api/ext/tools/list_documents -H "Authorization: Bearer $ERGA_TOKEN" -H "Content-Type: application/json" -d '{}'

The answer is \`{"ok": true, "content": [{"type": "text", "text": "..."}]}\` (the
text is JSON for the server's own tools; a document tool may answer an image,
\`{"type": "image", "mimeType": "image/png", "data": "<base64>"}\`). A failure is
\`{"ok": false, "error": "..."}\` with 400 (fix the call as the error says), 401
(no token, or a revoked one), 403 (not allowed), 404 (no such tool or document)
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

Every document has the tools its embedded agent uses (read, edit, write, ls,
find, grep, view_page, get_title, set_title). Here they take a \`document\`
argument too. Each document also has its own guide, with the rules for
writing pages people can keep editing by hand (read it before changing a page
much): \`GET ${origin}/d/<id>/api/ext\` with the same token. Your edits show up
live in everyone's editor, attributed to your person's agent, and your person
can undo them one call at a time. edit matches text exactly as it is right
now: read a file right before editing it, and read again if an edit fails
because someone changed the text meanwhile.

## The server's tools

${toolDocs(TOOLS)}

## Document tools

${toolDocs(documentTools())}
`;
}
