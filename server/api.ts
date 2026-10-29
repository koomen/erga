// The server's API for agents: everything a person can do in the app, for an
// agent holding one of their agent tokens. It's the same token,
// and the same mechanism, as a document's own external agent API (document/host.ts,
// /d/<id>/api/ext): this one covers the whole server, and offers each
// document's tools for any document the person may edit.
//
//   GET  /llms.txt                 the guide, for anyone (how to get a token, call the API, publish a site)
//   GET  /api, /api/ext            the same guide (personal, with a token)
//   GET  /api/tools                the operations and tools the caller may use, as JSON (name, description, JSON Schema):
//                                  for the person's own pages (their session) and for an agent token alike
//   POST /api/tools/<name>         runs one, the body its arguments: {"ok": true, "result": ...} or {"ok": false, "error"}.
//                                  The front end's one API: every page calls its operations here (from this site's own
//                                  pages only), and every agent has the same ones as tools
//   GET  /api/ext/tools            the tools, as JSON (name, description, JSON Schema), for an agent token
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
// The app (server/app.ts) sends those paths here: each answer is an Effect
// (server/http.ts), with the platform that knows agent tokens. The share button's token
// (<document>/api/share) is server/documents/make.ts's.
//
// The tools are agents/tools.ts's: the server's operations (server/operations/: documents, sharing, tokens, and the
// server's settings and users for a caller with admin power), and every document tool (read, edit, write, ...)
// with a `document` argument, run in that document's host as the person's agent. The front end, REST, MCP and the
// guide all reach the same ones.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";
import { ID, roleMay } from "./directory/index.ts";
import { fromElsewhere } from "./pages/index.ts";
import { forwarded } from "./documents/index.ts";
import { type Platform, type Session, whoOf } from "./platform";
import { call, fromWeb, json, platform as currentPlatform, text, webRequest, type Route } from "./http.ts";
import { accessOf } from "../document/access";
import { byLine } from "../shared/attribution";
import { allTools, jsonSchemaOf, runTool, toolsFor, type Tool } from "../agents/tools";
import { addFile, type Caller, cleanFilePath, OperationError } from "./operations/index.ts";
import type { ToolContent, ToolSpec } from "../document/agent";
import { authOps, expiryOf, REQUEST_MINUTES, SCOPES, ScopeError, type AgentToken, type Scope } from "./identity/index.ts";
import { Base64 } from "effect/encoding";
import { serverGuide } from "../agents/guides";

/** Who calls a tool here: the person signed in (their session, or an agent's token), the platform, and the server's origin. */
type ToolContext = Caller & { readonly session: Session; readonly platform: Platform; readonly origin: string };

/** A session as a caller of the operations. */
const callerOf = (platform: Platform, session: Session, origin: string): ToolContext => ({
  dir: platform.directory,
  who: whoOf(session),
  name: session.name,
  origin,
  auth: authOps(platform, origin),
  platform,
  session,
  ...(session.agent ? { token: session.agent as AgentToken } : {}),
});

/** The tools a caller may use; without one, all of them (the admin ones say so). */
const listed = (ctx: ToolContext | null) => call(() => (ctx ? toolsFor(ctx) : Promise.resolve(allTools())));
const specOf = (t: Tool): ToolSpec => ({ name: t.name, description: t.description, parameters: jsonSchemaOf(t) });

const refuse = (message: string, status = 400) => Effect.fail(new OperationError({ message, status }));

/** Runs a tool by name, as the caller; its answer as it is. A failure the caller can act on is an OperationError; any other a 500's. */
const runNamed = Effect.fnUntraced(function* (name: string, args: unknown, ctx: ToolContext) {
  const tool = allTools().find((t) => t.name == name);
  if (!tool)
    return yield* refuse(`There's no tool named "${name}". The tools are: ${(yield* listed(ctx)).map((t) => t.name).join(", ")}.`, 404);
  if (args == null) args = {};
  if (typeof args != "object" || Array.isArray(args)) return yield* refuse("The arguments must be a JSON object.");
  for (const key of jsonSchemaOf(tool).required ?? [])
    if ((args as Record<string, unknown>)[key] === undefined) return yield* refuse(`${name} needs "${key}".`);
  const a = tool.loose
    ? (args as Record<string, unknown>)
    : yield* Schema.decodeUnknownEffect(tool.parameters as Schema.Codec<Record<string, unknown>>)(args, { errors: "all" }).pipe(
        Effect.mapError((e) => new OperationError({ message: `Validation failed for tool "${name}":\n${e.message}`, status: 400 }))
      );
  return yield* Effect.tryPromise({
    try: () => runTool(tool, a, ctx),
    catch: (e) =>
      e instanceof OperationError ? e : new OperationError({ message: `The tool failed: ${(e as Error)?.message ?? e}`, status: 500 }),
  });
});

/** The same, its answer as content items (an outside agent's REST and MCP). */
const callTool = (name: string, args: unknown, ctx: ToolContext) =>
  Effect.map(runNamed(name, args, ctx), (out): ToolContent[] => {
    if (Array.isArray(out) && out.every((c) => c && typeof c == "object" && "type" in c)) return out as ToolContent[];
    return [{ type: "text", text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }];
  });

// ---------------------------------------------------------------- HTTP

const failure = (error: string, status: number) =>
  json({ ok: false, error }, status, status == 401 ? { "WWW-Authenticate": 'Bearer realm="erga"' } : {});
const NO_TOKEN = (origin: string) => `This needs an agent token, sent as "Authorization: Bearer <token>". Your person can make one at ${origin}/tokens, or you can ask for one: POST ${origin}/api/auth/request (see ${origin}/llms.txt). If yours stopped working it was revoked.`;

/** The body as JSON, as `schema` has it; or None, when it isn't JSON or isn't that. */
const body = <S extends Schema.Top>(schema: S) =>
  webRequest.pipe(
    Effect.flatMap((r) => call(() => r.text())),
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema as unknown as Schema.Codec<S["Type"]>))(t)),
    Effect.option
  );

/** The server's API (see the top of this file). */
export const serverApi: Route = Effect.gen(function* () {
  const request = yield* webRequest,
    platform = yield* currentPlatform;
  const url = new URL(request.url),
    path = url.pathname.replace(/\/+$/, "") || "/",
    origin = url.origin;
  const session = yield* call(() => platform.sessionOf(request));
  const agent = session?.agent ? (session as Session & { agent: AgentToken }) : null;
  // An agent token's caller: the outside agents' API is for tokens.
  const ctx: ToolContext | null = agent && callerOf(platform, agent, origin);
  const method = request.method;

  if (path == "/llms.txt" && (method == "GET" || method == "HEAD"))
    return text(serverGuide(origin, null, true), 200, { "Cache-Control": "no-cache" });
  if ((path == "/api" || path == "/api/ext") && (method == "GET" || method == "HEAD")) {
    if (request.headers.get("authorization") && !agent) return failure(NO_TOKEN(origin), 401);
    const guide = serverGuide(origin, agent, agent ? yield* adminStatus(platform, agent) : true);
    return HttpServerResponse.text(guide, { contentType: "text/markdown; charset=utf-8", headers: { "Cache-Control": "no-store" } });
  }
  if (path == "/mcp") return yield* mcp(ctx, origin);
  if (path == "/api/ext/tools" && method == "GET") {
    // With a token, the tools its person may use; without, all of them (the admin ones say so).
    if (request.headers.get("authorization") && !ctx) return failure(NO_TOKEN(origin), 401);
    return json({ ok: true, tools: (yield* listed(ctx)).map(specOf) });
  }
  if (path == "/api/auth/request" && method == "POST") return yield* askForToken(platform, origin);
  // The front end's API, and any agent's: the person's session, or a token.
  if (path == "/api/tools" || path.startsWith("/api/tools/")) {
    if (!session) return failure(request.headers.get("authorization") ? NO_TOKEN(origin) : "Sign in first.", 401);
    const caller = callerOf(platform, session, origin);
    if (path == "/api/tools" && (method == "GET" || method == "HEAD"))
      return json({ ok: true, tools: (yield* listed(caller)).map(specOf) });
    const [, named] = /^\/api\/tools\/([^/]+)$/.exec(path) ?? [];
    if (!named || method != "POST")
      return failure(`GET ${origin}/api/tools lists the tools; POST ${origin}/api/tools/<name> runs one.`, 404);
    // A person's session acts only from this site's own pages.
    // (A form another site posts as text/plain carries an Origin too: only this site's own is let through.)
    if (!session.agent && request.headers.get("origin") != origin) return failure("Only this site's own pages may do this.", 403);
    const args = yield* body(Schema.Unknown);
    if (args._tag == "None" && request.headers.get("content-length") != "0")
      return failure("The body must be the tool's arguments, as JSON.", 400);
    return yield* runNamed(decodeURIComponent(named), args._tag == "Some" ? args.value : undefined, caller).pipe(
      Effect.map((result) => json({ ok: true, result })),
      Effect.catchTag("OperationError", (e) => Effect.succeed(failure(e.message, e.status)))
    );
  }
  // A document's versions: for the person signed in (the settings UI) or an agent token alike.
  const [, docId, , restoreId] = /^\/api\/docs\/([^/]+)\/(versions|versions\/([^/]+)\/restore)$/.exec(path) ?? [];
  if (docId)
    return yield* versionsApi(
      platform,
      session,
      decodeURIComponent(docId),
      restoreId ? "restore" : "versions",
      restoreId && decodeURIComponent(restoreId)
    );
  const [, treeOf] = /^\/api\/docs\/([^/]+)\/tree$/.exec(path) ?? [];
  if (treeOf && (method == "GET" || method == "POST")) return yield* docTree(platform, session, decodeURIComponent(treeOf));
  if (path == "/api/auth/poll" && method == "POST") return yield* pollForToken(platform);

  const [, name] = /^\/api\/ext\/tools\/([^/]+)$/.exec(path) ?? [];
  if (name && method == "POST") {
    if (!ctx) return failure(NO_TOKEN(origin), 401);
    const args = yield* body(Schema.Unknown);
    if (args._tag == "None" && request.headers.get("content-length") != "0")
      return failure("The body must be the tool's arguments, as JSON.", 400);
    return yield* callTool(decodeURIComponent(name), args._tag == "Some" ? args.value : undefined, ctx).pipe(
      Effect.map((content) => json({ ok: true, content })),
      Effect.catchTag("OperationError", (e) => Effect.succeed(failure(e.message, e.status)))
    );
  }
  if (path == "/api/publish" && method == "POST") {
    if (!ctx) return failure(NO_TOKEN(origin), 401);
    return yield* publish(ctx).pipe(
      Effect.map((r) => json({ ok: true, ...r })),
      Effect.catchTag("OperationError", (e) =>
        Effect.succeed(failure(e.status == 500 ? e.message.replace(/^The tool failed/, "Publishing failed") : e.message, e.status))
      )
    );
  }
  return failure(`There's nothing at ${method} ${path}. The guide: GET ${origin}/api/ext`, 404);
});

/** A restore's body: optionally one file only, {"path": "blog/post.html"}. */
const RestoreBody = Schema.Struct({ path: Schema.optionalKey(Schema.Unknown) });

/**
 * GET /api/docs/<id>/versions[?before=<versionId>&limit=<n>]: its versions,
 * newest first, the current one, and whether the person may restore one
 * (canEdit). POST /api/docs/<id>/versions/<versionId>/restore: editors only.
 * For anyone who may open the document, signed in or with an agent token; a
 * POST from a browser only from this site's own pages.
 */
const versionsApi = Effect.fnUntraced(function* (
  platform: Platform,
  session: Session | null,
  ref: string,
  what: "versions" | "restore",
  versionRef?: string
) {
  const request = yield* webRequest;
  const url = new URL(request.url);
  const fail = (error: string, status: number) => json({ error }, status);
  if (!session) return fail("Sign in first, or send an agent token as \"Authorization: Bearer <token>\".", 401);
  const doc = /^[a-z0-9]{8}$/.test(ref) ? yield* call(() => platform.directory.get(ref)) : null;
  const role = doc ? yield* call(() => platform.directory.access(whoOf(session), doc)) : null;
  if (!doc || !role) return fail("There's no such document, or it isn't shared with you.", 404);
  const canEdit = roleMay(role, "edit");
  if (what == "versions") {
    if (request.method != "GET" && request.method != "HEAD") return fail("GET this.", 405);
    const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
    const state = yield* call(() => platform.docs.versions(doc, { before: url.searchParams.get("before"), limit }));
    return state ? json({ ...state, canEdit }) : fail("There's no such document.", 404);
  }
  if (request.method != "POST") return fail("POST this.", 405);
  if (!session.agent && request.headers.get("origin") != url.origin) return fail(`Only this site's own pages may ${what}.`, 403);
  if (!canEdit) return fail(`You may only view this document, so you can't ${what} it.`, 403);
  // A person's restore is theirs; an agent token's is its person's, via it ("ada, via a shared agent (CI)").
  const by = byLine(session.login.toLowerCase(), whoOf(session).via);
  const asked = yield* body(RestoreBody);
  const one = asked._tag == "Some" ? asked.value.path : undefined;
  const path = typeof one == "string" && one ? one : null;
  const r = yield* call(() => platform.docs.restore(doc, versionRef ?? "", by, path));
  return r.ok ? json({ current: r.current, from: r.from, files: r.files }) : fail(r.error, r.status);
});

/**
 * A document's file tree (document/host.ts, /api/tree): GET reads it, for whoever may
 * open the document; POST does one operation, for its editors. Signed in
 * with the app's session (the tree's UI, from this site's pages only) or an
 * agent token. Answers JSON: the tree, or {error}.
 */
const docTree = Effect.fnUntraced(function* (platform: Platform, session: Session | null, id: string) {
  const request = yield* webRequest;
  const err = (error: string, status: number) => json({ error }, status);
  if (!session) return err("Sign in first, or send an agent token as \"Authorization: Bearer <token>\".", 401);
  const post = request.method == "POST";
  if (post && !session.agent && fromElsewhere(request)) return err("Not from this site.", 403);
  const route = ID.test(id) ? yield* call(() => platform.directory.route(id)) : null;
  const access = route && (yield* call(() => platform.directory.access(whoOf(session), route)));
  if (!route || !access) return err("There's no such document, or it isn't shared with you.", 404);
  if (post && accessOf(access) != "edit") return err("You can only view this document.", 403);
  const url = new URL(request.url);
  const inner = new Request(new URL("/api/tree", url.origin), {
    method: request.method,
    headers: request.headers,
    body: post ? yield* call(() => request.text()) : undefined,
  });
  return fromWeb(
    yield* call(() =>
      platform.docs.fetch(route, forwarded(inner, new URL("/api/tree", url.origin), "/api/tree", `${url.origin}/d/${route.id}`, session))
    )
  );
});

/** The publish's fields that aren't files, in a multipart body. */
const FIELDS = ["title", "slug", "index", "document", "template"];

/**
 * POST /api/publish: a folder of files as a new document, or into an
 * existing one (`document`), from the command line. Multipart (each file a
 * part, named by its path; or named "file" with its path as the filename)
 * or JSON (create_document's or update_files' arguments).
 */
const publish = Effect.fnUntraced(function* (ctx: ToolContext) {
  const request = yield* webRequest;
  const type = request.headers.get("content-type") ?? "";
  let args: Record<string, unknown>;
  if (type.startsWith("multipart/form-data")) {
    const form = yield* Effect.tryPromise({
      try: () => request.formData(),
      catch: () => new OperationError({ message: "That multipart body didn't parse.", status: 400 }),
    });
    const files: Record<string, string | Uint8Array> = {};
    let total = 0;
    args = {};
    for (const [key, value] of form.entries()) {
      if (typeof value == "string") {
        if (FIELDS.includes(key)) args[key] = value;
        else if (key == "replace") args.replace = value == "true" || value == "1";
        else if (key == "delete") args.delete = [...((args.delete as string[] | undefined) ?? []), value];
        else
          return yield* refuse(
            `What's "${key}"? Send files as file parts (-F "path/in/site=@local/file"), and title, slug, index, document, replace or delete as fields.`
          );
        continue;
      }
      const file = value as File;
      const p = key == "file" || key == "files" || key == "files[]" ? file.name : key;
      const bytes = new Uint8Array(yield* call(() => file.arrayBuffer()));
      total = yield* Effect.try({ try: () => addFile(files, cleanFilePath(p), bytes, total), catch: (e) => e as OperationError });
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
    args.files = Object.fromEntries(Object.entries(files).map(([p, d]) => [p, typeof d == "string" ? d : { base64: Base64.encode(d) }]));
  } else {
    const parsed = yield* body(Schema.Record(Schema.String, Schema.Unknown));
    if (parsed._tag == "None")
      return yield* refuse('Send the files as multipart/form-data, or JSON: {"files": {"index.html": "..."}, "title": "..."}.');
    args = { ...parsed.value };
  }
  if (args.document) {
    const content = yield* callTool("update_files", { replace: true, ...args }, ctx);
    return { updated: true, ...JSON.parse((content[0] as { text: string }).text) } as object;
  }
  if (!args.files || !Object.keys(args.files as object).length) return yield* refuse("No files: send at least the page (index.html).");
  const content = yield* callTool("create_document", args, ctx);
  return { created: true, ...JSON.parse((content[0] as { text: string }).text) } as object;
});

// ---------------------------------------------------------------- MCP

const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * A JSON-RPC message, as far as the server reads it. (Effect's McpServer builds its tool list and its instructions
 * once; here both are each token's own, so the server answers MCP itself.)
 */
const RpcMessage = Schema.Struct({
  jsonrpc: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
type RpcMessage = typeof RpcMessage.Type;
const decodeRpc = Schema.decodeUnknownOption(RpcMessage);

/**
 * POST /mcp: the tools as a stateless MCP server (Streamable HTTP): every
 * request stands alone, needs the token, and is answered as JSON; there's no
 * session and no stream (GET is refused, as the spec allows).
 */
const mcp = Effect.fnUntraced(function* (ctx: ToolContext | null, origin: string) {
  const request = yield* webRequest;
  if (request.method != "POST") return text("This MCP server answers POSTs only (stateless, no event stream).", 405, { Allow: "POST" });
  if (!ctx) return failure(NO_TOKEN(origin), 401);
  const parsed = yield* body(Schema.Unknown);
  if (parsed._tag == "None") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const batch = Array.isArray(parsed.value);
  const answers = (yield* Effect.forEach(batch ? (parsed.value as unknown[]) : [parsed.value], (m) => rpc(m, ctx), {
    concurrency: "unbounded",
  })).filter((a) => a != null);
  if (!answers.length) return HttpServerResponse.empty({ status: 202 });
  return json(batch ? answers : answers[0]);
});

const rpc = Effect.fnUntraced(function* (raw: unknown, ctx: ToolContext) {
  const decoded = decodeRpc(raw);
  const id = (raw as RpcMessage | null)?.id;
  if (decoded._tag == "None" || decoded.value.method === undefined)
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid request" } } as object;
  const m = decoded.value;
  // Notifications (initialized, cancelled...) need no answer.
  if (m.id === undefined || m.id === null) return null;
  const ok = (result: unknown): object => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      const admin = yield* call(() => ctx.platform.directory.users.actsAsAdmin(ctx.who));
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "erga", title: "Erga", version: "1.0.0" },
        instructions: `Erga (${ctx.origin}) as ${ctx.session.name} (${ctx.session.login}): list, make (publish files as a site), rename, share and delete their documents, read and edit any document they may edit (name it with "document")${admin ? ", and, as they're an admin with an admin token, read and change the server's settings and users" : ""}.${ctx.session.onlyDoc != null ? ` This token reaches one document only (id ${ctx.session.onlyDoc}).` : ""} The full guide: ${ctx.origin}/api/ext.`,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: (yield* listed(ctx)).map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t) })) });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!allTools().some((t) => t.name == name))
        return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } } as object;
      return yield* callTool(name, m.params?.arguments ?? {}, ctx).pipe(
        // A PDF (read's) as MCP carries a file: an embedded resource.
        Effect.map((content) =>
          ok({
            content: content.map((c) =>
              c.type == "document"
                ? { type: "resource", resource: { uri: `erga:${name}/document.pdf`, mimeType: c.mimeType, blob: c.data } }
                : c
            ),
          })
        ),
        Effect.catchTag("OperationError", (e) => Effect.succeed(ok({ content: [{ type: "text", text: e.message }], isError: true })))
      );
    }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } } as object;
  }
});

// ---------------------------------------------------------------- asking for a token

/** An agent's request for a token; each field checked below, with words that say how to fix it. */
const TokenAsk = Schema.Struct({
  label: Schema.optionalKey(Schema.Unknown),
  scope: Schema.optionalKey(Schema.Unknown),
  doc: Schema.optionalKey(Schema.Unknown),
  expires: Schema.optionalKey(Schema.Unknown),
});

/** POST /api/auth/request {label, scope, doc?, expires?}: a link for the person to approve, and a code to poll with. */
const askForToken = Effect.fnUntraced(function* (platform: Platform, origin: string) {
  const asked = yield* body(TokenAsk);
  const b = asked._tag == "Some" ? asked.value : {};
  const scope = b.scope ?? "documents";
  if (!SCOPES.includes(scope as Scope)) return failure(`scope must be "document" (one document: give doc), "documents" or "admin".`, 400);
  const expires = expiryOf(b.expires);
  if (expires == "bad") return failure("expires must be a time (ISO 8601, e.g. 2026-12-31T00:00:00Z), a date, or left out for a token that lasts until it's revoked.", 400);
  const made = yield* Effect.tryPromise({
    try: () =>
      platform.tokens.request(typeof b.label == "string" ? b.label : null, {
        scope: scope as Scope,
        docId: typeof b.doc == "string" ? b.doc : null,
        expires,
      }),
    catch: (e) => e,
  }).pipe(Effect.result);
  if (made._tag == "Failure") {
    if (made.failure instanceof ScopeError) return failure(made.failure.message, 400);
    return yield* Effect.die(made.failure);
  }
  const r = made.success;
  const approve = `${origin}/tokens/approve?code=${r.userCode}`;
  return json({
    ok: true, code: r.code, user_code: r.userCode, label: r.label, scope, approve_url: approve,
    poll_url: `${origin}/api/auth/poll`, interval: 2, expires_in: Math.round((r.expires - Date.now()) / 1000),
    next: `Ask your person to open ${approve} (signed in to Erga) and approve "${r.label}" (scope: ${scope}). Meanwhile POST {"code": "${r.code}"} to ${origin}/api/auth/poll every couple of seconds: it answers 202 while waiting and 200 with the token once they've approved.`,
  });
});

/** POST /api/auth/poll {code}: 202 waiting, 200 with the token (once), 410 if it expired, was denied or was collected. */
const pollForToken = Effect.fnUntraced(function* (platform: Platform) {
  const asked = yield* body(Schema.Struct({ code: Schema.String }));
  if (asked._tag == "None") return failure('Send {"code": "..."}, the code /api/auth/request gave you.', 400);
  const r = yield* call(() => platform.tokens.collect(asked.value.code));
  if (r.status == "pending") return json({ ok: false, status: "pending", error: "Not approved yet: ask again in a couple of seconds." }, 202);
  if (r.status == "gone") return json({ ok: false, status: "gone", error: `That request expired (they last ${REQUEST_MINUTES} minutes), was denied, or its token was already collected: ask again.` }, 410);
  return json({ ok: true, status: "approved", token: r.token, login: r.login });
});

// ---------------------------------------------------------------- the guide

/** Whether a token's person may use the admin tools now (an admin-scope token), is an admin without one ("locked"), or neither. */
const adminStatus = (platform: Platform, session: Session) =>
  call(async (): Promise<boolean | "locked"> => {
    const users = platform.directory.users, who = whoOf(session);
    return (await users.actsAsAdmin(who)) ? true : (await users.isAdmin(who)) ? "locked" : false;
  });
