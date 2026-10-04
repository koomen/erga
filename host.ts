// The host for one document, run by its Durable Object (worker/doc-host.ts).
// Given the open room, its files and the agent's settings, it keeps each
// person's agent session and their open tabs, and serves
// the document's API (api.ts), what storage holds (/api/stored) and the
// document's files (/doc/).
//
// What's the Durable Object's stays with it: where files live, who a request
// is from (the person the front door vouched for), and the WebSockets, which
// it accepts its own way and hands to `room.connect` and `addTab`.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { MODELS, externalGuide, isModelChoice, startSession, type AgentConfig, type AgentSession } from "./agent";
import { AgentOff, Api, BadRequest, ExplainBadRequests, ModelFixed, NameRefused, NoSuchModel, NoSuchTool, Person, PersonFromRequest, SessionFailed, ExternalAgent, ToolFailed, Unauthorized, type AgentState, type ModelState } from "./api";
import type { DocName, Naming } from "./directory";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { digest, StoreError, type FileStore, type Room } from "./room";
import { titleOf } from "./front";
import { checkNewName, cleanTreePath, isPage, parentsOf, resolvePage, TreeError, treeEntries, type TreeOp } from "./tree";
import { ignored, isTextPath as isTextFile } from "./src/room/doc";
import type { ViewRequest, ViewResult } from "./src/page/agent-log";
import type { VersionsAccess } from "./agent";

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
  /**
   * Whom an external agent's request acts for: the person its token stands
   * for, as the front door vouched (null if it came without one).
   */
  readonly agentOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string } | null;
  /** The document's public address for a request, for the external agent's guide. */
  readonly baseUrl: (request: HttpServerRequest.HttpServerRequest) => string;
  /** A person's picture, if the platform knows one (hosted: their GitHub avatar). */
  readonly avatarOf?: (person: { id: string; name: string }) => string | undefined;
  /** Whether a person may edit, so their agent may (everyone, if not given; the directory's roles decide, worker/doc-host.ts). */
  readonly canEdit?: (person: { id: string; name: string }) => boolean;
  /** Whether a request may publish a file (PUT /api/stored): everyone, if not given. */
  readonly mayPublish?: (request: HttpServerRequest.HttpServerRequest) => boolean;
  /** A single file opened from disk: the document holds only it, and no other file can be made. */
  readonly only?: string;
  /** The document's title and address in the directory (directory.ts), read and changed as a person. */
  readonly naming?: (person: { id: string; name: string }) => Naming;
  /** The tools beyond the document a person's agent may use now (server-tools.ts: sharing; settings and users for an admin). */
  readonly serverTools?: (person: { id: string; name: string }) => Promise<AgentTool[]>;
  /** An agent's turn ended (the embedded agent's, or an external agent's run of calls): a version is cut. */
  readonly turnEnded?: () => void;
  /** The document's versions and publishing (versions.ts), for the agents' tools. */
  readonly versions?: VersionsAccess;
  /** A new page's text (templates/doc), by its path; a plain one if not given. */
  readonly newPage?: (path: string) => string;
}

/** One of a person's open tabs: their agent's events and its view_page requests go only to them. */
interface Tab { user: string; send: (msg: unknown) => void }

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

/**
 * A document's file as served under /doc/: always checked with the server
 * before it's used (no-cache), so a page always loads the latest version, but
 * by its digest (ETag), so a file that hasn't changed since the browser last
 * had it comes back as a 304 with no body. Shared by the host's route and the
 * Durable Object's own (worker/doc-host.ts, which serves stored files before
 * the room is open).
 */
export function docFile(rel: string, bytes: Uint8Array, ifNoneMatch?: string | null): { status: number; type: string; headers: Record<string, string>; body: Uint8Array | null } {
  const etag = `"${digest(bytes)}"`;
  const type = mimeOf(rel) ?? (isTextFile(rel) ? "text/plain; charset=utf-8" : "application/octet-stream");
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  const fresh = !!ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") == etag);
  return fresh ? { status: 304, type, headers, body: null } : { status: 200, type, headers, body: bytes };
}

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
  /** Every open tab, whoever's. */
  const sendAll = (msg: unknown) => { for (const t of tabs) t.send(msg); };
  // The tree changed, by anyone (a person, an agent, a publish, disk): every open tab refetches it.
  room.onTree(() => sendAll({ type: "tree" }));
  /** The latest moves, for a tab that missed one while it was loading (GET /api/tree). */
  const moves: { from: string; to: string }[] = [];
  /** Does a tree operation, as a person or their agent; open tabs hear what moved or went, to follow a page that did. */
  const tree = async (op: unknown) => {
    const done = await runTreeOp(room, op, { index: doc.path, only: opts.only, newPage: opts.newPage });
    if (done.op == "move") {
      moves.push({ from: done.from, to: done.to });
      if (moves.length > 50) moves.shift();
      sendAll({ type: "tree", moved: { from: done.from, to: done.to } });
    }
    else if (done.op == "delete") sendAll({ type: "tree", deleted: done.path });
    return done;
  };
  /** Every open tab, whoever's: the document's new title and address, so they show it and move to it. */
  const renamed = (name: DocName) => { for (const t of tabs) t.send({ type: "name", name }); };
  /** The document's naming as a person; a rename (by them or their agent) reaches every tab. */
  const namingAs = (user: { id: string; name: string }): Naming | undefined => {
    const n = opts.naming?.(user);
    return n && { get: n.get, set: async (patch) => { const name = await n.set(patch); renamed(name); return name; } };
  };
  const nameError = (e: unknown) => new NameRefused({ ok: false, error: e instanceof Error ? e.message : String(e) });

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
        cfg: "missing" in agent ? null : agent, room, owner: user, docName: doc.name, kind: doc.kind, only: opts.only,
        canEdit: () => opts.canEdit?.(user) ?? true,
        view: view(user.id),
        naming: namingAs(user),
        serverTools: opts.serverTools && (() => opts.serverTools!(user)),
        readAsset: (rel) => Effect.runPromise(Effect.orElseSucceed(files.read(rel), () => null)),
        turnEnded: opts.turnEnded,
        versions: opts.versions,
        tree: async (op) => { await tree(op); },
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

  // An external agent (Claude Code, Codex...) holds one of the person's
  // agent tokens (tokens.ts; the share button makes one), which the front
  // door checks; over /api/ext it calls that person's agent tools, as their agent.

  const modelState = (s: AgentSession): ModelState => ({
    model: s.model,
    choice: s.modelChoice,
    models: s.modelChoice == null ? [] : Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
  });

  // ---------------------------------------------------------- the API (api.ts)

  const personFromRequest = Layer.succeed(PersonFromRequest, (handler) =>
    HttpServerRequest.HttpServerRequest.use((req) => Effect.provideService(handler, Person, opts.personOf(req))));
  const externalAgent = Layer.succeed(ExternalAgent, (handler) => Effect.gen(function* () {
    const user = opts.agentOf(yield* HttpServerRequest.HttpServerRequest);
    if (!user) return yield* new Unauthorized({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". If it stopped working it was revoked: ask for a new one." });
    return yield* Effect.provideService(handler, Person, user);
  }));
  const explainBadRequests = HttpApiMiddleware.layerSchemaErrorTransform(ExplainBadRequests, (e) =>
    e.kind == "Params" || e.kind == "Headers" || e.kind == "Query" || e.kind == "Payload"
      ? Effect.fail(new BadRequest({ ok: false, error: e.cause.message }))
      : Effect.die(e));

  const docApi = HttpApiBuilder.group(Api, "doc", (h) => h
    .handle("info", () => Person.use((user) => Effect.gen(function* () {
      const docName = yield* Effect.promise(() => namingAs(user)?.get().catch(() => undefined) ?? Promise.resolve(undefined));
      return { name: doc.name, path: doc.path, kind: doc.kind, dir: doc.dir, user: user.name, userId: user.id, avatar: opts.avatarOf?.(user), writeDelay: room.writeDelay, canEdit: opts.canEdit?.(user) ?? true, docName };
    })))
    .handle("name", () => Person.use((user) => {
      const n = namingAs(user);
      return n ? Effect.tryPromise({ try: () => n.get(), catch: nameError }) : Effect.fail(nameError("This document has no name to read."));
    }))
    .handle("rename", ({ payload }) => Person.use((user) => {
      const n = namingAs(user);
      return n ? Effect.tryPromise({ try: () => n.set(payload), catch: nameError }) : Effect.fail(nameError("This document can't be renamed."));
    })));

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
      Effect.map((s) => ({ ok: s.undo() })), Effect.orElseSucceed(() => ({ ok: false }))))));

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
    docApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    agentApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    extApi.pipe(Layer.provide([externalAgent, explainBadRequests])),
  ]));

  // ---------------------------------------------------------- storage and files

  const badPath = HttpServerResponse.text("Bad path", { status: 400 });
  /** The tree, each page with its title (its first heading, else its <title>) when it has one. */
  const entries = () => treeEntries(room.paths(), room.folderPaths()).map((e) => {
    const text = e.type == "page" ? room.text(e.path) : null;
    const title = text != null ? titleOf(text, e.path) : null;
    return title ? { ...e, title } : e;
  });
  const routes: Array<HttpRouter.Route<unknown>> = [
    // The document's file tree (tree.ts): its pages, other files and folders.
    HttpRouter.route("GET", "/api/tree", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const canEdit = (opts.mayPublish?.(req) ?? true) && opts.only == null;
      return yield* HttpServerResponse.json({ entries: entries(), canEdit, moved: moves }, { headers: { "Cache-Control": "no-store" } });
    })),
    // A tree operation: a new page or folder, a move (or rename), a delete. Editors only.
    HttpRouter.route("POST", "/api/tree", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (opts.mayPublish && !opts.mayPublish(req)) return yield* HttpServerResponse.json({ error: "You can only view this document." }, { status: 403 });
      const body = yield* Effect.orElseSucceed(req.json, () => null);
      const r = yield* Effect.promise(() => tree(body).then(() => null, (e: unknown) => e));
      if (r) {
        const status = r instanceof TreeError ? r.status : 500;
        return yield* HttpServerResponse.json({ error: r instanceof Error ? r.message : String(r) }, { status });
      }
      return yield* HttpServerResponse.json({ entries: entries() }, { headers: { "Cache-Control": "no-store" } });
    })),
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
      if (opts.only != null && rel != opts.only) return HttpServerResponse.text(`This document is the single file ${opts.only}`, { status: 403 });
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (opts.mayPublish && !opts.mayPublish(req)) return HttpServerResponse.text("You can only view this document.", { status: 403 });
      const text = yield* req.text;
      const ifMatch = req.headers["if-match"]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const r = yield* room.push(rel, text, ifMatch);
      return yield* HttpServerResponse.json(r, { status: r.ok ? 200 : r.reason == "stale" ? 412 : 415, headers: r.etag ? { ETag: `"${r.etag}"` } : {} });
    })),
    // The document's folder: text files from the room, so a page always
    // loads the latest shared version, and everything else from storage.
    HttpRouter.route("GET", "/doc/*", Effect.gen(function* () {
      // The path as asked for, a slash at the end included (the router's parameter drops it).
      const req = yield* HttpServerRequest.HttpServerRequest;
      const asked = new URL(req.url, "http://doc").pathname;
      const raw = asked.startsWith("/doc/") ? asked.slice("/doc/".length) : (yield* HttpRouter.params)["*"] ?? "";
      // A page by its address (blog for blog.html or blog/index.html): sent to its file, relatively, so the
      // frame's address is the file's and the page's own relative links resolve. doc/ itself is the document's
      // page, served as it is (the frame asks for it so, front.ts; its links resolve from the root either way).
      const page = () => {
        const found = resolvePage((p) => room.exists(p) == "file", raw, doc.path);
        if (!found || found.file == cleanRel(raw)) return null;
        let from = raw;
        try { from = decodeURIComponent(raw); } catch { /* resolvePage refused it already */ }
        return HttpServerResponse.empty({ status: 302, headers: { Location: relativeUrl(from, found.file), "Cache-Control": "no-store" } });
      };
      const rel = raw ? cleanRel(raw) : doc.path;
      if (!rel) return page() ?? HttpServerResponse.text("Not found", { status: 404 });
      if (raw && room.exists(rel) != "file") { const to = page(); if (to) return to; }
      const text = room.text(rel);
      const bytes = text != null ? new TextEncoder().encode(text) : yield* files.read(rel);
      if (!bytes) return HttpServerResponse.text("Not found", { status: 404 });
      const r = docFile(rel, bytes, req.headers["if-none-match"]);
      return HttpServerResponse.uint8Array(r.body ?? new Uint8Array(), { status: r.status, contentType: r.type, headers: r.headers });
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
    /** Tells every open tab, whoever's (a new version, a publish: { type: "versions" }). */
    broadcast: (msg: unknown) => { for (const t of tabs) t.send(msg); },
    /** The document was renamed some other way (its title following an edit): every tab hears of it. */
    renamed,
    /** A message for every open tab, whoever's (the homepage's deploy status, { type: "home" }: worker/home.ts). */
    notify: (msg: unknown) => { for (const t of tabs) t.send(msg); },
    agentOff,
  };
}

/** A plain route's failure: a request that doesn't parse is the client's mistake (400); anything else is ours. */
export function failed(e: unknown) {
  const err = e as { _tag?: string; reason?: { _tag?: string }; message?: string };
  const bad = err._tag == "SchemaError" || err.reason?._tag == "RequestParseError";
  return HttpServerResponse.text(String(err.message ?? e), { status: bad ? 400 : 500 });
}

/**
 * The relative URL from a request's path to a file, both inside the
 * document's folder ("blog" to "blog/index.html" is "blog/index.html"; from
 * "blog/" it's "index.html"): a redirect that keeps whatever comes before
 * (the pages origin's /t/<token>/doc/).
 */
export function relativeUrl(from: string, to: string): string {
  const dir = from.split("/").filter(Boolean);
  if (!from.endsWith("/")) dir.pop();
  const target = to.split("/");
  let k = 0;
  while (k < dir.length && k < target.length - 1 && dir[k] == target[k]) k++;
  return "../".repeat(dir.length - k) + target.slice(k).map(encodeURIComponent).join("/");
}

/** What a tree operation did, its paths cleaned (a new page's with its extension). */
export type TreeDone = TreeOp;

/**
 * Checks a tree operation (tree.ts: TreeOp) against the document as it is,
 * then does it in the room: a new page from the template, a new folder, a
 * move (or rename) of a file or folder, or a delete (a folder with all it
 * holds). The document's own page can't be moved or deleted. Throws a
 * TreeError saying what's wrong.
 */
export async function runTreeOp(room: Room, raw: unknown, o: { index: string; only?: string; newPage?: (path: string) => string }): Promise<TreeDone> {
  if (!raw || typeof raw != "object" || Array.isArray(raw)) throw new TreeError('Send the operation as JSON: {"op": "new_page" | "new_folder" | "move" | "delete", ...}.');
  const op = raw as Record<string, unknown>;
  if (o.only != null) throw new TreeError(`This document is the single file ${o.only}, opened from disk on its own: it can't hold other files or folders.`, 403);
  const exists = (p: string) => room.exists(p);
  const free = (p: string) => {
    if (exists(p)) throw new TreeError(`There's already ${exists(p) == "folder" ? "a folder" : "a file"} at ${p}.`, 409);
    const file = parentsOf(p).find((d) => exists(d) == "file");
    if (file) throw new TreeError(`${file} is a file, so nothing can go inside it.`, 409);
  };
  const run = (e: Effect.Effect<void, StoreError>) => Effect.runPromise(Effect.mapError(e, (err) => new TreeError(`Couldn't do it: ${err.message}`, 500)));
  switch (op.op) {
    case "new_page": {
      let path = cleanTreePath(op.path);
      if (!isPage(path)) {
        if (/\.[^./]+$/.test(path)) throw new TreeError(`A page is an .html or .md file, not ${path}.`);
        path += o.index.endsWith(".md") ? ".md" : ".html";
      }
      checkNewName(path, "page");
      free(path);
      await run(room.create(path, (o.newPage ?? plainPage)(path)));
      return { op: "new_page", path };
    }
    case "new_folder": {
      const path = cleanTreePath(op.path);
      checkNewName(path, "folder");
      free(path);
      await run(room.mkdir(path));
      return { op: "new_folder", path };
    }
    case "move": {
      const from = cleanTreePath(op.from, "from");
      let to = cleanTreePath(op.to, "to");
      const kind = exists(from);
      if (!kind) throw new TreeError(`There's nothing at ${from}.`, 404);
      if (from == o.index) throw new TreeError(`${from} is the document's own page: it can't be moved or renamed.`);
      // A page renamed without an extension keeps its own.
      if (kind == "file" && isPage(from) && !/\.[^./]+$/.test(to)) to += from.slice(from.lastIndexOf("."));
      if (to == from) return { op: "move", from, to };
      if (kind == "folder" && to.startsWith(`${from}/`)) throw new TreeError(`A folder can't go inside itself.`);
      checkNewName(to, kind == "folder" ? "folder" : isPage(to) ? "page" : "file");
      free(to);
      await run(room.move(from, to));
      return { op: "move", from, to };
    }
    case "delete": {
      const path = cleanTreePath(op.path);
      if (path == o.index) throw new TreeError(`${path} is the document's own page: it can't be deleted.`);
      if (!exists(path)) throw new TreeError(`There's nothing at ${path}.`, 404);
      await run(room.remove(path));
      return { op: "delete", path };
    }
    default:
      throw new TreeError(`There's no operation "${String(op.op)}": it's one of new_page, new_folder, move and delete.`);
  }
}

/** A new page when there's no template: a heading to start from. */
const plainPage = (path: string) => path.endsWith(".md") ? "# Untitled\n\nStart writing here.\n" : "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Untitled</title>\n</head>\n<body>\n<h1>Untitled</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n";
