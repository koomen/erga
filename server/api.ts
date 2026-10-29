// The server's API for agents: everything a person can do in the app, for an
// agent holding one of their agent tokens. It's the same token,
// and the same mechanism, as a document's own external agent API (document/host.ts,
// /d/<id>/api/ext): this one covers the whole server, and offers each
// document's tools for any document the person may edit.
//
//   GET  /llms.txt                 the guide, for anyone (how to get a token, call the API, publish a site)
//   GET  /api, /api/ext            the same guide (personal, with a token)
//   GET  /api/ext/tools            the tools, as JSON (name, description, JSON Schema)
//   POST /api/ext/tools/<name>     runs one, the body its arguments: {"ok": true, "content": [...]}
//   POST /api/publish              a folder of files as a document (multipart or JSON), or into one
//   GET  /api/docs/<id>/versions   a document's versions;
//                                  POST .../versions/<versionId>/restore brings one back, or one file of it with {"path": ...}
//   POST /api/auth/request         an agent asks for a token: a link for its person to approve
//   POST /api/auth/poll            ... and collects the token once they have
//   POST /mcp                      the same tools as a stateless MCP server (Streamable HTTP, JSON answers)
//   GET  /api/docs/<id>/tree       a document's file tree; POST does a tree operation. For people
//                                  signed in (the tree's UI) as well as tokens
//   /tokens, /tokens/...           a person's tokens: make one (a scope, an expiry), revoke one, approve or deny an agent's request
//   /settings                      their settings: their tokens and the test token
//
// The Worker sends those paths here, with the platform
// that knows agent tokens. The share button's token
// (<document>/api/share) is server/documents/make.ts's.
//
// The tools are agents/tools.ts's registry: the outside agents' own (their
// documents, published files, tokens), those the embedded agents have too
// (sharing, and the server's settings and users for an admin: listed only for
// an admin's token), and every document tool (read, edit, write, ...) with a
// `document` argument, run in that document's host as the person's agent.
// REST, MCP and the guide all list them.

import * as Schema from "effect/Schema";
import { ID, LOCKED, roleMay } from "./directory/index.ts";
import { fromElsewhere } from "./pages/index.ts";
import { forwarded } from "./documents/index.ts";
import { type Platform, type Session, whoOf } from "./platform";
import { accessOf } from "../document/access";
import { byLine } from "../shared/attribution";
import { addFile, jsonSchemaOf, cleanFilePath, runTool, ToolError, toolsFor, toolsOf, type Tool, type ToolWho } from "../agents/tools";
import type { ToolContent, ToolSpec } from "../document/agent";
import { authOps, expiryOf, REQUEST_MINUTES, SCOPES, ScopeError, type AgentToken, type Scope } from "./identity/index.ts";
import { base64 } from "../shared/bytes";
import { json } from "../shared/http";
import { serverGuide } from "../agents/guides";

/** What a tool runs with, for an outside agent: who its token stands for, the platform, and the server's origin. */
type ToolContext = ToolWho & { readonly session: Session & { agent: AgentToken }; readonly platform: Platform; readonly origin: string };

/** The tools a token's person may use; without a token, all of them (the admin ones say so). */
const listed = (ctx: ToolContext | null) => (ctx ? toolsFor(ctx, "api") : Promise.resolve(toolsOf("api")));
const specOf = (t: Tool): ToolSpec => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t) });

/** Runs a tool by name, for an outside agent; its answer as content items. */
async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolContent[]> {
  const tool = toolsOf("api").find((t) => t.name == name);
  if (!tool)
    throw new ToolError({
      message: `There's no tool named "${name}". The tools are: ${(await listed(ctx)).map((t) => t.name).join(", ")}.`,
      status: 404,
    });
  if (tool.admin && !(await ctx.dir.users.actsAsAdmin(ctx.who))) {
    throw new ToolError({
      message: (await ctx.dir.users.isAdmin(ctx.who))
        ? `${name} needs an admin token: ${LOCKED}`
        : `${name} is for the server's admins only, and ${ctx.session.login} isn't one.`,
      status: 403,
    });
  }
  if (tool.wide && ctx.session.onlyDoc != null)
    throw new ToolError({
      message: `${name} isn't for a document token: this token reaches one document only. Make a token with the documents scope at ${ctx.origin}/tokens.`,
      status: 403,
    });
  if (args == null) args = {};
  if (typeof args != "object" || Array.isArray(args)) throw new ToolError({ message: "The arguments must be a JSON object.", status: 400 });
  let a = args as Record<string, unknown>;
  for (const key of jsonSchemaOf(tool).required ?? [])
    if (a[key] === undefined) throw new ToolError({ message: `${name} needs "${key}".`, status: 400 });
  if (!tool.loose) {
    try {
      a = Schema.decodeUnknownSync(tool.parameters as Schema.Codec<Record<string, unknown>>)(a, { errors: "all" });
    } catch (e) {
      throw new ToolError({ message: `Validation failed for tool "${name}":\n${(e as Error).message}`, status: 400 });
    }
  }
  const out = await runTool(tool, a, ctx);
  if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c)) return out as ToolContent[];
  return [{ type: "text", text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }];
}

// ---------------------------------------------------------------- HTTP

const failure = (error: string, status: number) =>
  json({ ok: false, error }, status, status == 401 ? { "WWW-Authenticate": 'Bearer realm="erga"' } : {});
const NO_TOKEN = (origin: string) => `This needs an agent token, sent as "Authorization: Bearer <token>". Your person can make one at ${origin}/tokens, or you can ask for one: POST ${origin}/api/auth/request (see ${origin}/llms.txt). If yours stopped working it was revoked.`;

/** The server's API (see the top of this file). */
export async function serverApi(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", origin = url.origin;
  const session = await platform.sessionOf(request);
  const agent = session?.agent ? (session as ToolContext["session"]) : null;
  const ctx: ToolContext | null = agent && {
    dir: platform.directory,
    who: whoOf(agent),
    origin,
    auth: authOps(platform, origin),
    platform,
    session: agent,
  };
  const method = request.method;

  if (path == "/llms.txt" && (method == "GET" || method == "HEAD"))
    return new Response(serverGuide(origin, null, true), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    });
  if ((path == "/api" || path == "/api/ext") && (method == "GET" || method == "HEAD")) {
    if (request.headers.get("authorization") && !agent) return failure(NO_TOKEN(origin), 401);
    return new Response(serverGuide(origin, agent, agent ? await adminStatus(platform, agent) : true), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (path == "/mcp") return mcp(request, ctx, origin);
  if (path == "/api/ext/tools" && method == "GET") {
    // With a token, the tools its person may use; without, all of them (the admin ones say so).
    if (request.headers.get("authorization") && !ctx) return failure(NO_TOKEN(origin), 401);
    return json({ ok: true, tools: (await listed(ctx)).map(specOf) });
  }
  if (path == "/api/auth/request" && method == "POST") return askForToken(request, platform, origin);
  // A document's versions: for the person signed in (the settings UI) or an agent token alike.
  const [, docId, , restoreId] = /^\/api\/docs\/([^/]+)\/(versions|versions\/([^/]+)\/restore)$/.exec(path) ?? [];
  if (docId) return versionsApi(request, platform, session, decodeURIComponent(docId), restoreId ? "restore" : "versions", restoreId && decodeURIComponent(restoreId));
  const [, treeOf] = /^\/api\/docs\/([^/]+)\/tree$/.exec(path) ?? [];
  if (treeOf && (method == "GET" || method == "POST")) return docTree(request, platform, session, decodeURIComponent(treeOf));
  if (path == "/api/auth/poll" && method == "POST") return pollForToken(request, platform);

  const [, name] = /^\/api\/ext\/tools\/([^/]+)$/.exec(path) ?? [];
  if (name && method == "POST") {
    if (!ctx) return failure(NO_TOKEN(origin), 401);
    const args = await request.json().catch(() => undefined);
    if (args === undefined && request.headers.get("content-length") != "0") return failure("The body must be the tool's arguments, as JSON.", 400);
    try {
      return json({ ok: true, content: await callTool(decodeURIComponent(name), args, ctx) });
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
 * newest first, the current one, and whether the person may restore one
 * (canEdit). POST /api/docs/<id>/versions/<versionId>/restore: editors only.
 * For anyone who may open the document, signed in or with an agent token; a
 * POST from a browser only from this site's own pages.
 */
async function versionsApi(request: Request, platform: Platform, session: Session | null, ref: string, what: "versions" | "restore", versionRef?: string): Promise<Response> {
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
  if (request.method != "POST") return fail("POST this.", 405);
  if (!session.agent && request.headers.get("origin") != url.origin) return fail(`Only this site's own pages may ${what}.`, 403);
  if (!canEdit) return fail(`You may only view this document, so you can't ${what} it.`, 403);
  // A person's restore is theirs; an agent token's is its person's, via it ("ada, via a shared agent (CI)").
  const by = byLine(session.login.toLowerCase(), whoOf(session).via);
  // Optionally one file only: {"path": "blog/post.html"}.
  const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
  const path = typeof body?.path == "string" && body.path ? body.path : null;
  const r = await platform.docs.restore(doc, versionRef ?? "", by, path);
  return r.ok ? json({ current: r.current, from: r.from, files: r.files }) : fail(r.error, r.status);
}

/**
 * A document's file tree (document/host.ts, /api/tree): GET reads it, for whoever may
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
  return platform.docs.fetch(route, forwarded(inner, new URL("/api/tree", url.origin), "/api/tree", `${url.origin}/d/${route.id}`, session));
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
    const form = await request.formData().catch(() => {
      throw new ToolError({ message: "That multipart body didn't parse.", status: 400 });
    });
    const files: Record<string, string | Uint8Array> = {};
    let total = 0;
    args = {};
    for (const [key, value] of form.entries()) {
      if (typeof value == "string") {
        if (["title", "slug", "index", "document", "template"].includes(key)) args[key] = value;
        else if (key == "replace") args.replace = value == "true" || value == "1";
        else if (key == "delete") args.delete = [...((args.delete as string[] | undefined) ?? []), value];
        else
          throw new ToolError({
            message: `What's "${key}"? Send files as file parts (-F "path/in/site=@local/file"), and title, slug, index, document, replace or delete as fields.`,
            status: 400,
          });
        continue;
      }
      const file = value as File;
      const p = key == "file" || key == "files" || key == "files[]" ? file.name : key;
      total = addFile(files, cleanFilePath(p), new Uint8Array(await file.arrayBuffer()), total);
    }
    // Text files as text, so they're edited as text.
    for (const [p, data] of Object.entries(files))
      if (typeof data != "string" && /\.(html?|md|markdown|css|m?js|json|svg|txt|xml|csv)$/i.test(p)) {
        try {
          files[p] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
        } catch {
          /* left as bytes */
        }
      }
    args.files = Object.fromEntries(Object.entries(files).map(([p, d]) => [p, typeof d == "string" ? d : { base64: base64(d) }]));
  } else {
    const body = await request.json().catch(() => null);
    if (!body || typeof body != "object" || Array.isArray(body))
      throw new ToolError({
        message: 'Send the files as multipart/form-data, or JSON: {"files": {"index.html": "..."}, "title": "..."}.',
        status: 400,
      });
    args = body as Record<string, unknown>;
  }
  if (args.document) {
    const content = await callTool("update_files", { replace: true, ...args }, ctx);
    return { updated: true, ...JSON.parse((content[0] as { text: string }).text) };
  }
  if (!args.files || !Object.keys(args.files as object).length)
    throw new ToolError({ message: "No files: send at least the page (index.html).", status: 400 });
  const content = await callTool("create_document", args, ctx);
  return { created: true, ...JSON.parse((content[0] as { text: string }).text) };
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
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: (await listed(ctx)).map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t) })) });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!toolsOf("api").some((t) => t.name == name))
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      try {
        // A PDF (read's) as MCP carries a file: an embedded resource.
        const content = (await callTool(name, m.params?.arguments ?? {}, ctx)).map((c) =>
          c.type == "document"
            ? { type: "resource", resource: { uri: `erga:${name}/document.pdf`, mimeType: c.mimeType, blob: c.data } }
            : c
        );
        return ok({ content });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof ToolError ? e.message : `The tool failed: ${(e as Error)?.message ?? e}` }], isError: true });
      }
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

// ---------------------------------------------------------------- asking for a token

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

// ---------------------------------------------------------------- the guide

/** Whether a token's person may use the admin tools now (an admin-scope token), is an admin without one ("locked"), or neither. */
async function adminStatus(platform: Platform, session: Session): Promise<boolean | "locked"> {
  const users = platform.directory.users, who = whoOf(session);
  return (await users.actsAsAdmin(who)) ? true : (await users.isAdmin(who)) ? "locked" : false;
}
