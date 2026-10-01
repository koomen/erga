#!/usr/bin/env bun
// Opens a page from disk in the page editor, as a document room that people
// and their agents edit together.
//
//   bun open.ts <file-or-directory> [--port 4400] [--no-open]
//
// A directory must hold index.html or index.md. The host turns the folder
// into one document room (room.ts): a shared Yjs doc of its text files that
// editor tabs join over a WebSocket at /api/room, with files written back to
// disk on a debounce and edits made on disk (an editor, git) merged in. It
// serves the editor shell at / and the document's folder at /doc/, text
// files from the room (so a page always loads the latest shared version)
// and everything else from disk.
//
// Each person gets their own agent session (agent.ts) when .env
// holds an API key: a private transcript, shared by that person's tabs, and
// a replica of the shared doc it edits as another participant. A tab names
// its person in ?user=; the agent's progress comes back on that person's
// event channel (a WebSocket at /api/events), and view_page asks that person's tabs.
// The share button gives a person a token for an external agent, which
// calls the same tools in the same session over /api/ext.

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Console from "effect/Console";
import * as Schedule from "effect/Schedule";
import { MODELS, externalGuide, isModelChoice, loadConfig, startSession, type AgentSession } from "./agent";
import { Room, digest, type FileStore, type StateStore } from "./room";
import type { ViewRequest, ViewResult } from "./src/page/agent-log";

const EDITOR_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** Hands each message a socket receives to f, until the socket closes (which fails the pull). */
const each = <A, E>(pull: Effect.Effect<ReadonlyArray<A>, Socket.SocketError>, f: (data: A) => Effect.Effect<void, E>) =>
  Effect.forever(Effect.flatMap(pull, (batch) => Effect.forEach(batch, f, { discard: true })));

interface Doc {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly kind: "html" | "md";
}

const ViewBody = Schema.Struct({
  id: Schema.String,
  png: Schema.optional(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  errors: Schema.Array(Schema.String),
  note: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const ModelBody = Schema.Struct({ model: Schema.String });
const ShareBody = Schema.Struct({ rotate: Schema.optional(Schema.Boolean) });
const PromptBody = Schema.Struct({ text: Schema.String, context: Schema.optional(Schema.NullOr(Schema.String)), after: Schema.optional(Schema.String) });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

/** Resolves the argument to the document: a file, or a folder's index.html / index.md. */
const resolveDoc = (arg: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const abs = path.resolve(arg);
    const info = yield* fs.stat(abs).pipe(Effect.mapError(() => new UsageError({ message: `${arg}: not found` })));
    let file = abs;
    if (info.type === "Directory") {
      const candidates = ["index.html", "index.htm", "index.md"].map((n) => path.join(abs, n));
      const found = yield* Effect.findFirst(candidates, (c) => fs.exists(c).pipe(Effect.orElseSucceed(() => false)));
      if (found._tag === "None") return yield* new UsageError({ message: `${arg}: no index.html or index.md here` });
      file = found.value;
    }
    const ext = path.extname(file).toLowerCase();
    const kind = ext === ".md" ? "md" : ext === ".html" || ext === ".htm" ? "html" : null;
    if (!kind) return yield* new UsageError({ message: `${arg}: open an .html or .md file, or a folder with an index` });
    return { path: file, dir: path.dirname(file), name: path.basename(file), kind } satisfies Doc;
  });

/** Serves one file from a root, refusing paths that escape it. */
const serveFile = (root: string, rel: string, cacheControl = "no-store") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clean = decodeURIComponent(rel).replace(/^\/+/, "");
    root = path.resolve(root);
    const full = path.resolve(root, clean);
    if (full !== root && !full.startsWith(root + path.sep)) return HttpServerResponse.text("Not found", { status: 404 });
    const info = yield* fs.stat(full).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") return HttpServerResponse.text("Not found", { status: 404 });
    const bytes = yield* fs.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    return HttpServerResponse.uint8Array(bytes, { contentType: type, headers: { "Cache-Control": cacheControl } });
  });

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1)[0] : null; };
  const noOpen = flag("--no-open") != null;
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args.splice(portIdx, 2)[1]) : 4400;
  const target = args[0];
  if (!target || !Number.isFinite(port)) return yield* new UsageError({ message: "usage: bun open.ts <file-or-directory> [--port N] [--no-open]" });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const doc = yield* resolveDoc(target);
  const gitName = yield* Effect.promise(() => new Response(Bun.spawn(["git", "config", "user.name"], { stdout: "pipe", stderr: "ignore" }).stdout).text()).pipe(Effect.orElseSucceed(() => ""));
  const defaultName = gitName.trim().split(/\s+/)[0] || process.env.USER || "Me";
  const docPath = path.relative(doc.dir, doc.path).split(path.sep).join("/");

  // The folder as a FileStore (room.ts): what the room loads, writes back
  // and re-reads when the watcher sees a change. Writes are atomic renames.
  const ignored = (rel: string) => rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || seg == "node_modules");
  const run = <A, E>(e: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => Effect.runPromise(e.pipe(Effect.provide(BunServices.layer)));
  const store: FileStore = {
    list: () => run(fs.readDirectory(doc.dir, { recursive: true }).pipe(
      Effect.map((all) => all.map((r) => r.split(path.sep).join("/")).filter((r) => !ignored(r))),
      Effect.flatMap((all) => Effect.filter(all, (r) => fs.stat(path.join(doc.dir, r)).pipe(Effect.map((s) => s.type == "File"), Effect.orElseSucceed(() => false)))),
    )),
    read: (rel) => run(fs.readFile(path.join(doc.dir, rel)).pipe(Effect.orElseSucceed(() => null))),
    write: (rel, text) => run(Effect.gen(function* () {
      const full = path.join(doc.dir, rel);
      yield* fs.makeDirectory(path.dirname(full), { recursive: true });
      const tmp = path.join(path.dirname(full), `.${path.basename(full)}.erga-${process.pid}.tmp`);
      yield* fs.writeFileString(tmp, text);
      yield* fs.rename(tmp, full);
    })),
  };
  // The room's Yjs state lives in a cache file named for the folder, so a
  // restarted host picks up the same history (room.ts).
  // (ERGA_ROOM_STATE_DIR puts it elsewhere; the test suite uses a scratch folder.)
  const stateDir = process.env.ERGA_ROOM_STATE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || "/tmp", ".cache"), "erga", "rooms");
  const stateFile = path.join(stateDir, new Bun.CryptoHasher("sha1").update(doc.dir).digest("hex").slice(0, 20) + ".yjs");
  const state: StateStore = {
    load: () => run(fs.readFile(stateFile).pipe(Effect.orElseSucceed(() => null))),
    save: (bytes) => run(Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true });
      yield* fs.writeFile(stateFile + ".tmp", bytes);
      yield* fs.rename(stateFile + ".tmp", stateFile);
    })),
  };
  // ERGA_WRITE_DELAY_MS shortens the room's write delay (tests do; people don't need to).
  const room = yield* Effect.promise(() => Room.open(store, { state, log: (line) => console.log(line), writeDelay: Number(process.env.ERGA_WRITE_DELAY_MS) || undefined }));
  /** A request's path inside the folder, refusing ones that leave it. */
  const cleanRel = (raw: string | undefined) => {
    const rel = path.normalize(decodeURIComponent(raw ?? "")).replace(/^\/+/, "");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || ignored(rel)) throw new UsageError({ message: `bad path: ${raw}` });
    return rel.split(path.sep).join("/");
  };
  if (room.text(docPath) == null) return yield* new UsageError({ message: `${doc.name}: not a UTF-8 text file` });

  // Each person's open tabs, as event streams: their agent's events and its
  // requests to look at the page go only to them.
  interface Tab { user: string; send: (msg: unknown) => void }
  const tabs = new Set<Tab>();
  const sendTo = (user: string, msg: unknown) => { for (const t of tabs) if (t.user == user) t.send(msg); };

  // view_page: ask the owner's tabs; the first to answer wins. With none of
  // their tabs open there's nothing to look with (no server-side browser
  // here; hosted, Cloudflare Browser Rendering would stand in), and the tool
  // says so.
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

  const cfg = yield* Effect.promise(() => loadConfig(process.env.ERGA_AGENT_ENV_FILE || path.join(EDITOR_DIR, ".env")));
  const agentOff = "missing" in cfg ? cfg.missing : "";
  const sessions = new Map<string, Promise<AgentSession>>();
  /**
   * A person's agent session, started the first time they open the panel. With
   * the embedded agent off it still exists, for an external agent's tool calls.
   */
  const sessionFor = (user: { id: string; name: string }) => {
    let s = sessions.get(user.id);
    if (!s) {
      s = startSession({
        cfg: "missing" in cfg ? null : cfg, room, owner: user, docName: doc.name, kind: doc.kind,
        canEdit: () => true, // locally everyone may edit; hosted, the project role decides
        view: view(user.id),
        readAsset: store.read,
      });
      s.then((session) => session.subscribe((ev) => sendTo(user.id, { type: "agent", ev })), () => sessions.delete(user.id));
      sessions.set(user.id, s);
    }
    return s;
  };
  const session = (user: { id: string; name: string }) => Effect.tryPromise(() => sessionFor(user)).pipe(Effect.result);

  // Sharing with an external agent: the share button mints a token that
  // stands for one person, and an agent holding it calls that person's
  // agent tools over /api/ext, as their agent. Tokens live as long as the
  // host; rotating one revokes the old. Hosted, they'd be stored and scoped
  // to the project like any other credential.
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
  /** The person an external agent's request acts for, from its bearer token. */
  const bearer = HttpServerRequest.HttpServerRequest.useSync((r) => {
    const m = /^Bearer\s+(\S+)$/i.exec(r.headers["authorization"] ?? "");
    return m ? shareTokens.get(m[1]) ?? null : null;
  });
  const unauthorized = HttpServerResponse.jsonUnsafe({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". Ask for a new prompt if it stopped working (the editor may have restarted)." }, { status: 401 });
  const baseUrl = HttpServerRequest.HttpServerRequest.useSync((r) => `http://${r.headers["host"] ?? `127.0.0.1:${port}`}`);

  // Watch the folder, subfolders included, and hand every change to the
  // room: it merges text edits it didn't make and notes changed assets.
  const watcher = fs.watch(doc.dir, { recursive: true }).pipe(
    Stream.map((ev) => path.relative(doc.dir, path.resolve(doc.dir, ev.path)).split(path.sep).join("/")),
    Stream.filter((rel) => !ignored(rel)),
    Stream.groupedWithin(1000, "60 millis"),
    Stream.mapEffect((chunk) => Effect.forEach(new Set(chunk), (rel) => Effect.promise(() => room.fileChanged(rel)), { discard: true })),
    Stream.retry(Schedule.spaced("250 millis")),
    Stream.runDrain,
    Effect.catchCause(() => Effect.void),
  );

  // Who a request is from. Locally that's just a name per tab (?user=Ada),
  // defaulting to the person running the host; hosted, the session cookie.
  const userOf = (url: URL) => {
    const name = (url.searchParams.get("user") || "").trim().slice(0, 40) || defaultName;
    return { id: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "anon", name };
  };
  const requestUrl = HttpServerRequest.HttpServerRequest.useSync((r) => new URL(r.url, "http://localhost"));
  /** The session's model, and what it can switch to (nothing when scripted). */
  const modelState = (s: AgentSession) => ({
    model: s.model,
    choice: s.modelChoice,
    models: s.modelChoice == null ? [] : Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
  });
  const agentState = (s: AgentSession | null, err?: unknown) => s
    ? (agentOff ? { enabled: false, reason: agentOff, log: s.log() } : { enabled: true, ...modelState(s), log: s.log() })
    : { enabled: false, reason: `the agent did not start: ${String((err as Error).message ?? err)}` };

  const routes: Array<HttpRouter.Route<unknown, FileSystem.FileSystem | Path.Path>> = [
    HttpRouter.route("GET", "/", serveFile(EDITOR_DIR, "page.html")),
    HttpRouter.route("GET", "/api/doc", Effect.sync(() => HttpServerResponse.jsonUnsafe({ name: doc.name, path: docPath, kind: doc.kind, dir: doc.dir, user: defaultName, writeDelay: room.writeDelay }))),
    // The room: Yjs sync and awareness over a WebSocket (y-websocket's protocol).
    HttpRouter.route("GET", "/api/room/*", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const epoch = new URL(req.url, "http://localhost").searchParams.get("epoch");
      const socket = yield* req.upgrade;
      const pull = yield* Socket.readerBytes(socket);
      const { write } = yield* socket.writer;
      const conn = room.connect((m) => { Effect.runFork(write(m)); }, { epoch });
      // A tab holding another epoch's history is refused, never merged (room.ts).
      if (!conn) return yield* write(new Socket.CloseEvent(4409, "stale epoch")).pipe(Effect.as(HttpServerResponse.empty()), Effect.orElseSucceed(() => HttpServerResponse.empty()));
      yield* each(pull, (data) => conn.receive(data) ? Effect.void : write(new Socket.CloseEvent(4400, "malformed message"))).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => conn.close())),
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped)),
    // Each tab's own channel: a WebSocket, not server-sent events, because a
    // browser allows only six HTTP/1.1 connections per host and every open
    // tab's event stream would hold one, leaving later requests (sending the
    // agent a message) queued forever. WebSockets don't count against that.
    HttpRouter.route("GET", "/api/events", Effect.gen(function* () {
      const user = userOf(yield* requestUrl);
      const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade;
      const { pull } = yield* socket.reader;
      const { write } = yield* socket.writer;
      const tab: Tab = { user: user.id, send: (msg) => { Effect.runFork(write(JSON.stringify(msg)).pipe(Effect.ignore)); } };
      tabs.add(tab);
      yield* each(pull, () => Effect.void).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => tabs.delete(tab))),
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped)),
    HttpRouter.route("GET", "/api/agent", Effect.gen(function* () {
      const s = yield* session(userOf(yield* requestUrl));
      return yield* HttpServerResponse.json(s._tag == "Success" ? agentState(s.success) : agentState(null, s.failure));
    })),
    HttpRouter.route("POST", "/api/agent", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(PromptBody);
      const s = yield* session(userOf(yield* requestUrl));
      if (agentOff || s._tag != "Success") return yield* HttpServerResponse.json({ ok: false, reason: agentOff || "the agent did not start" }, { status: 503 });
      // The sender's last keystrokes travel over its WebSocket; let them land first.
      if (body.after) yield* Effect.promise(() => room.waitFor(body.after!));
      s.success.prompt(body.text, body.context ?? null);
      return yield* HttpServerResponse.json({ ok: true });
    })),
    // The share button: a token for this person's external agent (rotate: true revokes the old one).
    HttpRouter.route("POST", "/api/share", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(ShareBody);
      const user = userOf(yield* requestUrl);
      return yield* HttpServerResponse.json({ token: mintToken(user, body.rotate ?? false) });
    })),
    // An external agent: its guide, the tools as JSON, and a tool call.
    HttpRouter.route("GET", "/api/ext", Effect.gen(function* () {
      const user = yield* bearer;
      if (!user) return unauthorized;
      const s = yield* session(user);
      if (s._tag != "Success") return HttpServerResponse.jsonUnsafe({ ok: false, error: "The agent's session didn't start." }, { status: 503 });
      const guide = externalGuide({ docName: docPath, kind: doc.kind, owner: user.name, base: yield* baseUrl, tools: s.success.tools() });
      return HttpServerResponse.text(guide, { contentType: "text/markdown; charset=utf-8" });
    })),
    HttpRouter.route("GET", "/api/ext/tools", Effect.gen(function* () {
      const user = yield* bearer;
      if (!user) return unauthorized;
      const s = yield* session(user);
      if (s._tag != "Success") return HttpServerResponse.jsonUnsafe({ ok: false, error: "The agent's session didn't start." }, { status: 503 });
      return yield* HttpServerResponse.json({ ok: true, tools: s.success.tools() });
    })),
    HttpRouter.route("POST", "/api/ext/tools/:name", Effect.gen(function* () {
      const user = yield* bearer;
      if (!user) return unauthorized;
      const { name } = yield* HttpRouter.params;
      const args = yield* HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap((r) => r.json), Effect.orElseSucceed(() => undefined));
      if (args === undefined || typeof args != "object" || args === null || Array.isArray(args)) return HttpServerResponse.jsonUnsafe({ ok: false, error: "The body must be a JSON object of the tool's arguments." }, { status: 400 });
      const s = yield* session(user);
      if (s._tag != "Success") return HttpServerResponse.jsonUnsafe({ ok: false, error: "The agent's session didn't start." }, { status: 503 });
      if (!s.success.tools().some((t) => t.name == name)) return HttpServerResponse.jsonUnsafe({ ok: false, error: `There's no tool named "${name}". The tools are: ${s.success.tools().map((t) => t.name).join(", ")}.` }, { status: 404 });
      const run = yield* Effect.tryPromise({ try: () => s.success.runTool(name!, args), catch: (e) => (e as Error).message }).pipe(Effect.result);
      return run._tag == "Success"
        ? HttpServerResponse.jsonUnsafe({ ok: true, content: run.success })
        : HttpServerResponse.jsonUnsafe({ ok: false, error: run.failure }, { status: 400 });
    })),
    // Switch the person's agent to another model, from its next turn; their other tabs follow.
    HttpRouter.route("POST", "/api/agent/model", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(ModelBody);
      const user = userOf(yield* requestUrl);
      const s = yield* session(user);
      if (agentOff || s._tag != "Success") return HttpServerResponse.jsonUnsafe({ ok: false, reason: agentOff || "the agent did not start" }, { status: 503 });
      if (!isModelChoice(body.model)) return HttpServerResponse.jsonUnsafe({ ok: false, reason: `there's no model "${body.model}"` }, { status: 400 });
      if (!s.success.setModel(body.model)) return HttpServerResponse.jsonUnsafe({ ok: false, reason: "this agent's model can't be changed" }, { status: 409 });
      const state = modelState(s.success);
      sendTo(user.id, { type: "model", ...state });
      return HttpServerResponse.jsonUnsafe({ ok: true, ...state });
    })),
    HttpRouter.route("POST", "/api/agent/view", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(ViewBody);
      const { id, ...result } = body;
      views.get(id)?.({ ...result, errors: [...result.errors] });
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.route("POST", "/api/agent/abort", Effect.gen(function* () {
      const s = yield* session(userOf(yield* requestUrl));
      if (s._tag == "Success") s.success.abort();
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.route("POST", "/api/agent/reset", Effect.gen(function* () {
      const s = yield* session(userOf(yield* requestUrl));
      if (s._tag == "Success") yield* Effect.promise(() => s.success.reset());
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.route("POST", "/api/agent/undo", Effect.gen(function* () {
      const s = yield* session(userOf(yield* requestUrl));
      return yield* HttpServerResponse.json({ ok: s._tag == "Success" && s.success.undo() });
    })),
    // What storage holds (not the room): lets a test see the room's writes
    // land, and send an edit that arrives as a file (a publish, a git pull)
    // without depending on a filesystem watcher. Hosted, this is the
    // publish path, behind the project's write role.
    HttpRouter.route("GET", "/api/stored/*", Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const rel = yield* Effect.try(() => cleanRel(params["*"]));
      const bytes = yield* Effect.promise(() => store.read(rel));
      return bytes ? HttpServerResponse.uint8Array(bytes, { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store", ETag: `"${digest(bytes)}"` } }) : HttpServerResponse.text("Not found", { status: 404 });
    }).pipe(Effect.catchTag("UnknownError", () => Effect.succeed(HttpServerResponse.text("Bad path", { status: 400 }))))),
    // With If-Match, refused (412) if storage has changed since that version.
    HttpRouter.route("PUT", "/api/stored/*", Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const rel = yield* Effect.try(() => cleanRel(params["*"]));
      const req = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* req.text;
      const ifMatch = req.headers["if-match"]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const r = yield* Effect.promise(() => room.push(rel, text, ifMatch));
      return yield* HttpServerResponse.json(r, { status: r.ok ? 200 : r.reason == "stale" ? 412 : 415, headers: r.etag ? { ETag: `"${r.etag}"` } : {} });
    }).pipe(Effect.catchTag("UnknownError", () => Effect.succeed(HttpServerResponse.text("Bad path", { status: 400 }))))),
    HttpRouter.route("GET", "/doc/*", HttpRouter.params.pipe(Effect.flatMap((p) => {
      const rel = decodeURIComponent(p["*"] ?? "").replace(/^\/+/, "");
      const text = room.text(rel);
      return text != null
        ? Effect.succeed(HttpServerResponse.text(text, { contentType: MIME[path.extname(rel).toLowerCase()] ?? "text/plain; charset=utf-8", headers: { "Cache-Control": "no-store" } }))
        : serveFile(doc.dir, rel);
    }))),
    HttpRouter.route("GET", "/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(EDITOR_DIR, p["*"] ?? "", "no-cache")))),
  ];
  // A request that doesn't parse is the client's mistake (400); anything else is ours.
  const badRequest = (e: { _tag?: string; reason?: { _tag?: string } }) => e._tag == "SchemaError" || e.reason?._tag == "RequestParseError";
  const failed = (e: unknown) => HttpServerResponse.text(String((e as { message?: string }).message ?? e), { status: badRequest(e as object) ? 400 : 500 });
  const app = HttpRouter.addAll(routes.map((r) => HttpRouter.route(r.method, r.path, Effect.catch(r.handler, (e) => Effect.succeed(failed(e))))));

  const url = `http://127.0.0.1:${port}/`;
  const server = Layer.unwrap(
    Effect.gen(function* () {
      const rel = path.relative(process.cwd(), doc.path);
      yield* Console.log(`\n  editing ${doc.kind === "md" ? "Markdown" : "HTML"}: ${rel.startsWith("..") ? doc.path : rel || doc.name}\n  ${url}   (another person: ${url}?user=Ada)\n  agent: ${"missing" in cfg ? `off (${agentOff})` : `${cfg.model == "script" ? "script" : MODELS[cfg.model].label} to start (each person can switch)`}\n`);
      if (!noOpen) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      // Tabs hold their sockets open for good, so waiting for connections to
      // finish (Bun's graceful shutdown) would only stall every exit by 20s.
      return HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(BunHttpServer.layer({ port, idleTimeout: 0, gracefulShutdownTimeout: 0 })));
    }),
  );
  yield* Effect.forkScoped(watcher);
  // Whatever the room hasn't written yet goes to disk on the way out.
  yield* Effect.addFinalizer(() => Effect.promise(() => room.close()));
  yield* Layer.launch(server);
});

program.pipe(
  Effect.scoped,
  Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => process.exit(2))))),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
