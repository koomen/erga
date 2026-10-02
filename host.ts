// The host for one document, wherever it runs: the local Bun server
// (open.ts) or a Durable Object on Cloudflare (worker/doc-host.ts). Given
// the open room, its files and the agent's settings, it keeps each person's
// agent session, their open tabs and their share tokens, and serves the
// document's API (api.ts), what storage holds (/api/stored) and the
// document's files (/doc/).
//
// What differs by platform stays with the caller: where files live, who a
// request is from (?user= locally, the session cookie hosted), and the
// WebSockets, which each platform accepts its own way and hands to
// `room.connect` and `addTab`.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { MODELS, externalGuide, isModelChoice, startSession, type AgentConfig, type AgentSession } from "./agent";
import { AgentOff, Api, BadRequest, ExplainBadRequests, ModelFixed, NoSuchModel, NoSuchTool, Person, PersonFromQuery, SessionFailed, ShareToken, ToolFailed, Unauthorized, type AgentState, type ModelState } from "./api";
import { digest, type FileStore, type Room } from "./room";
import type { ViewRequest, ViewResult } from "./src/page/agent-log";

export interface HostOptions {
  readonly room: Room;
  readonly files: FileStore["Service"];
  readonly doc: {
    readonly name: string;
    /** The document's path inside its folder. */
    readonly path: string;
    readonly kind: "html" | "md";
    /** Where the folder is, as the caller describes it (a directory, a URL). */
    readonly dir: string;
  };
  readonly agent: AgentConfig | { readonly missing: string };
  /** Who a request is from. */
  readonly personOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string };
  /** The document's public address for a request, for the external agent's guide. */
  readonly baseUrl: (request: HttpServerRequest.HttpServerRequest) => string;
  /** Hosted: people are who they signed in as, so a tab can't pick its own name (?user=). */
  readonly signedIn?: boolean;
  /** A person's picture, if the platform knows one (hosted: their GitHub avatar). */
  readonly avatarOf?: (person: { id: string; name: string }) => string | undefined;
  /** Whether a person may edit (locally everyone may; hosted, the project role would decide). */
  readonly canEdit?: (person: { id: string; name: string }) => boolean;
}

/** One of a person's open tabs: their agent's events and its view_page requests go only to them. */
interface Tab { user: string; send: (msg: unknown) => void }

/** Paths the host never serves or stores: dotfiles and node_modules. */
export const ignored = (rel: string) => rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || seg == "node_modules");

/** A request's path inside the folder, or null if it would leave it (or is ignored). */
export function cleanRel(raw: string | undefined): string | null {
  const parts: string[] = [];
  let decoded: string;
  try { decoded = decodeURIComponent(raw ?? ""); } catch { return null; }
  for (const seg of decoded.split(/[\\/]/)) {
    if (!seg || seg == ".") continue;
    if (seg == "..") return null;
    parts.push(seg);
  }
  const rel = parts.join("/");
  return rel && !ignored(rel) ? rel : null;
}

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};
export const mimeOf = (path: string) => MIME[/\.[^./]+$/.exec(path.toLowerCase())?.[0] ?? ""];

/** HttpApi's platform needs, none of which a document served from storage uses. */
const fromStorage = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  Etag.layerWeak,
  FileSystem.layerNoop({}),
  Path.layer,
);

export function makeHost(opts: HostOptions) {
  const { room, files, doc, agent } = opts;
  const tabs = new Set<Tab>();
  const sendTo = (user: string, msg: unknown) => { for (const t of tabs) if (t.user == user) t.send(msg); };

  // view_page: ask the owner's tabs; the first to answer wins. With none of
  // their tabs open there's nothing to look with (no server-side browser
  // yet; Cloudflare Browser Rendering could stand in), and the tool says so.
  const views = new Map<string, (r: ViewResult) => void>();
  const view = (user: string) => (req: ViewRequest): Promise<ViewResult> => {
    if (![...tabs].some((t) => t.user == user)) return Promise.resolve({ width: 0, height: 0, errors: [], error: "Your user has no editor tab open, so there's no browser to look at the page with." });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { views.delete(id); resolve({ width: 0, height: 0, errors: [], error: "The editor didn't send a picture back in time." }); }, 20_000);
      views.set(id, (r) => { clearTimeout(timer); views.delete(id); resolve(r); });
      sendTo(user, { type: "view", id, req });
    });
  };

  const agentOff = "missing" in agent ? agent.missing : "";
  const sessions = new Map<string, Promise<AgentSession>>();
  /**
   * A person's agent session, started the first time they open the panel. With
   * the embedded agent off it still exists, for an external agent's tool calls.
   */
  const sessionFor = (user: { id: string; name: string }) => {
    let s = sessions.get(user.id);
    if (!s) {
      s = startSession({
        cfg: "missing" in agent ? null : agent, room, owner: user, docName: doc.name, kind: doc.kind,
        canEdit: () => opts.canEdit?.(user) ?? true,
        view: view(user.id),
        readAsset: (rel) => Effect.runPromise(Effect.orElseSucceed(files.read(rel), () => null)),
      });
      s.then((session) => session.subscribe((ev) => sendTo(user.id, { type: "agent", ev })), () => sessions.delete(user.id));
      sessions.set(user.id, s);
    }
    return s;
  };
  /** The person's agent session, or why it didn't start. */
  const session = (user: { id: string; name: string }) => Effect.tryPromise(() => sessionFor(user));
  /** For the panel's endpoints: their session, unless the embedded agent is off. */
  const agentSession = Person.use((user) => agentOff
    ? Effect.fail(new AgentOff({ ok: false, reason: agentOff }))
    : Effect.mapError(session(user), () => new AgentOff({ ok: false, reason: "the agent did not start" })));
  /** For an external agent: the session's tools work even with the embedded agent off. */
  const extSession = Person.use((user) => Effect.mapError(session(user), () => new SessionFailed({ ok: false, error: "The agent's session didn't start." })));

  // Sharing with an external agent: the share button mints a token that
  // stands for one person, and an agent holding it calls that person's
  // agent tools over /api/ext, as their agent. Tokens live as long as the
  // host; rotating one revokes the old.
  const shareTokens = new Map<string, { id: string; name: string }>();
  const tokenOf = new Map<string, string>();
  const mintToken = (user: { id: string; name: string }, rotate: boolean) => {
    const old = tokenOf.get(user.id);
    if (old && !rotate) return old;
    if (old) shareTokens.delete(old);
    const token = "erga_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    shareTokens.set(token, user);
    tokenOf.set(user.id, token);
    return token;
  };

  const modelState = (s: AgentSession): ModelState => ({
    model: s.model,
    choice: s.modelChoice,
    models: s.modelChoice == null ? [] : Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
  });

  // ---------------------------------------------------------- the API (api.ts)

  const personFromQuery = Layer.succeed(PersonFromQuery, (handler) =>
    HttpServerRequest.HttpServerRequest.use((req) => Effect.provideService(handler, Person, opts.personOf(req))));
  const shareToken = Layer.succeed(ShareToken, {
    bearer: (handler, { credential }) => {
      const user = shareTokens.get(Redacted.value(credential));
      return user
        ? Effect.provideService(handler, Person, user)
        : Effect.fail(new Unauthorized({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". Ask for a new prompt if it stopped working (the editor may have restarted)." }));
    },
  });
  const explainBadRequests = HttpApiMiddleware.layerSchemaErrorTransform(ExplainBadRequests, (e) =>
    e.kind == "Params" || e.kind == "Headers" || e.kind == "Query" || e.kind == "Payload"
      ? Effect.fail(new BadRequest({ ok: false, error: e.cause.message }))
      : Effect.die(e));

  const docApi = HttpApiBuilder.group(Api, "doc", (h) => h
    .handle("info", () => Person.useSync((user) => ({ name: doc.name, path: doc.path, kind: doc.kind, dir: doc.dir, user: user.name, userId: user.id, signedIn: opts.signedIn ?? false, avatar: opts.avatarOf?.(user), writeDelay: room.writeDelay }))));

  const agentApi = HttpApiBuilder.group(Api, "agent", (h) => h
    .handle("state", () => Person.use((user) => session(user).pipe(
      Effect.map((s): AgentState => agentOff ? { enabled: false, reason: agentOff, log: s.log() } : { enabled: true, ...modelState(s), log: s.log() }),
      Effect.catch((e) => Effect.succeed<AgentState>({ enabled: false, reason: `the agent did not start: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}` })),
    )))
    .handle("prompt", ({ payload }) => Effect.gen(function* () {
      const s = yield* agentSession;
      // The sender's last keystrokes travel over its WebSocket; let them land first.
      if (payload.after) yield* room.waitFor(payload.after);
      s.prompt(payload.text, payload.context ?? null);
      return { ok: true as const };
    }))
    .handle("model", ({ payload }) => Effect.gen(function* () {
      const s = yield* agentSession;
      if (!isModelChoice(payload.model)) return yield* new NoSuchModel({ ok: false, reason: `there's no model "${payload.model}"` });
      if (!s.setModel(payload.model)) return yield* new ModelFixed({ ok: false, reason: "this agent's model can't be changed" });
      const state = modelState(s);
      sendTo((yield* Person).id, { type: "model", ...state });
      return { ok: true as const, ...state };
    }))
    .handle("view", ({ payload: { id, ...result } }) => Effect.sync(() => {
      views.get(id)?.({ ...result, errors: [...result.errors] });
      return { ok: true as const };
    }))
    .handle("abort", () => Person.use((user) => session(user).pipe(
      Effect.map((s) => s.abort()), Effect.ignore, Effect.as({ ok: true as const }))))
    .handle("reset", () => Person.use((user) => session(user).pipe(
      Effect.flatMap((s) => Effect.promise(() => s.reset())), Effect.ignore, Effect.as({ ok: true as const }))))
    .handle("undo", () => Person.use((user) => session(user).pipe(
      Effect.map((s) => ({ ok: s.undo() })), Effect.orElseSucceed(() => ({ ok: false })))))
    .handle("share", ({ payload }) => Person.useSync((user) => ({ token: mintToken(user, payload.rotate ?? false) }))));

  const extApi = HttpApiBuilder.group(Api, "ext", (h) => h
    .handle("guide", () => Effect.gen(function* () {
      const user = yield* Person;
      const s = yield* extSession;
      const base = opts.baseUrl(yield* HttpServerRequest.HttpServerRequest);
      return externalGuide({ docName: doc.path, kind: doc.kind, owner: user.name, base, tools: s.tools() });
    }))
    .handle("tools", () => Effect.map(extSession, (s) => ({ ok: true as const, tools: s.tools() })))
    .handle("run", ({ params: { name }, payload }) => Effect.gen(function* () {
      const s = yield* extSession;
      if (!s.tools().some((t) => t.name == name)) return yield* new NoSuchTool({ ok: false, error: `There's no tool named "${name}". The tools are: ${s.tools().map((t) => t.name).join(", ")}.` });
      const content = yield* Effect.tryPromise({ try: () => s.runTool(name, payload), catch: (e) => new ToolFailed({ ok: false, error: (e as Error).message }) });
      return { ok: true as const, content };
    })));

  const api = HttpApiBuilder.layer(Api).pipe(Layer.provide([
    docApi.pipe(Layer.provide([personFromQuery, explainBadRequests])),
    agentApi.pipe(Layer.provide([personFromQuery, explainBadRequests])),
    extApi.pipe(Layer.provide([shareToken, explainBadRequests])),
  ]));

  // ---------------------------------------------------------- storage and files

  const badPath = HttpServerResponse.text("Bad path", { status: 400 });
  const routes: Array<HttpRouter.Route<unknown>> = [
    // What storage holds (not the room): lets a test see the room's writes
    // land, and send an edit that arrives as a file (a publish, a git pull)
    // without depending on a filesystem watcher.
    HttpRouter.route("GET", "/api/stored/*", Effect.gen(function* () {
      const rel = cleanRel((yield* HttpRouter.params)["*"]);
      if (!rel) return badPath;
      const bytes = yield* files.read(rel);
      return bytes ? HttpServerResponse.uint8Array(bytes, { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store", ETag: `"${digest(bytes)}"` } }) : HttpServerResponse.text("Not found", { status: 404 });
    })),
    // With If-Match, refused (412) if storage has changed since that version.
    HttpRouter.route("PUT", "/api/stored/*", Effect.gen(function* () {
      const rel = cleanRel((yield* HttpRouter.params)["*"]);
      if (!rel) return badPath;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* req.text;
      const ifMatch = req.headers["if-match"]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const r = yield* room.push(rel, text, ifMatch);
      return yield* HttpServerResponse.json(r, { status: r.ok ? 200 : r.reason == "stale" ? 412 : 415, headers: r.etag ? { ETag: `"${r.etag}"` } : {} });
    })),
    // The document's folder: text files from the room, so a page always
    // loads the latest shared version, and everything else from storage.
    HttpRouter.route("GET", "/doc/*", Effect.gen(function* () {
      const rel = cleanRel((yield* HttpRouter.params)["*"]);
      if (!rel) return HttpServerResponse.text("Not found", { status: 404 });
      const text = room.text(rel);
      if (text != null) return HttpServerResponse.text(text, { contentType: mimeOf(rel) ?? "text/plain; charset=utf-8", headers: { "Cache-Control": "no-store" } });
      const bytes = yield* files.read(rel);
      return bytes ? HttpServerResponse.uint8Array(bytes, { contentType: mimeOf(rel) ?? "application/octet-stream", headers: { "Cache-Control": "no-store" } }) : HttpServerResponse.text("Not found", { status: 404 });
    })),
  ];

  const app = Layer.mergeAll(api, HttpRouter.addAll(routes.map((r) => HttpRouter.route(r.method, r.path, Effect.catch(r.handler, (e) => Effect.succeed(failed(e))))))) as Layer.Layer<
    never, never, HttpRouter.HttpRouter | HttpPlatform.HttpPlatform | Etag.Generator | FileSystem.FileSystem | Path.Path
  >;
  const web = HttpRouter.toWebHandler(app.pipe(Layer.provide(fromStorage)), { disableLogger: true });

  return {
    /**
     * The document's HTTP app, as a web handler: the API, /api/stored and
     * /doc/, for requests whose path is the one inside the document. The
     * caller adds the WebSockets and the editor's files.
     */
    handler: (request: Request) => web.handler(request),
    /** Releases the handler (when the document closes). */
    dispose: web.dispose,
    /** A tab joins its person's event channel; returns the leave function. */
    addTab: (user: string, send: (msg: unknown) => void) => {
      const tab: Tab = { user, send };
      tabs.add(tab);
      return () => { tabs.delete(tab); };
    },
    agentOff,
  };
}

/** A plain route's failure: a request that doesn't parse is the client's mistake (400); anything else is ours. */
export function failed(e: unknown) {
  const err = e as { _tag?: string; reason?: { _tag?: string }; message?: string };
  const bad = err._tag == "SchemaError" || err.reason?._tag == "RequestParseError";
  return HttpServerResponse.text(String(err.message ?? e), { status: bad ? 400 : 500 });
}
