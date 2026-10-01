#!/usr/bin/env bun
// Opens a page from disk in the page editor, as a document room that people
// and their agents edit together.
//
//   bun open.ts [file-or-directory] [--port 4400] [--no-open]   (--help for more)
//
// With no document named, it opens a scratch copy of the demo (templates/demo).
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
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { MODELS, loadConfig } from "./agent";
import { FileStore, Room, StateStore, StoreError } from "./room";
import { failed, ignored, makeHost, mimeOf } from "./host";
import { version } from "./package.json";

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


/** The host's settings from the environment: tests set these; people rarely need to. */
const settings = Config.all({
  /** Where the room's Yjs state is kept (the suite uses a scratch folder). */
  stateDir: Config.option(Config.String("ERGA_ROOM_STATE_DIR")),
  cacheHome: Config.option(Config.String("XDG_CACHE_HOME")),
  home: Config.withDefault(Config.String("HOME"), "/tmp"),
  user: Config.withDefault(Config.String("USER"), ""),
  /** Shortens the room's write delay (tests do). */
  writeDelay: Config.option(Config.Int("ERGA_WRITE_DELAY_MS")),
  /** The agent's settings file, if not .env next to this one. */
  agentEnvFile: Config.option(Config.String("ERGA_AGENT_ENV_FILE")),
});

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
    const type = mimeOf(full) ?? "application/octet-stream";
    return HttpServerResponse.uint8Array(bytes, { contentType: type, headers: { "Cache-Control": cacheControl } });
  });

/** A scratch copy of templates/demo, removed when the host stops. */
const demoCopy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "erga-demo-" }), "demo");
  yield* fs.copy(path.join(EDITOR_DIR, "templates", "demo"), dir);
  return dir;
}).pipe(Effect.mapError((e) => new UsageError({ message: `couldn't copy the demo: ${e.message}` })));

const program = (args: { target: Option.Option<string>; port: number; open: boolean }) => Effect.gen(function* () {
  const { port } = args;
  const env = yield* settings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // No document named: the demo, from a fresh copy so the template stays as it is.
  const target = Option.isSome(args.target) ? args.target.value : yield* demoCopy;
  const doc = yield* resolveDoc(target);
  const gitName = yield* spawner.string(ChildProcess.make("git", ["config", "user.name"])).pipe(Effect.orElseSucceed(() => ""));
  const defaultName = gitName.trim().split(/\s+/)[0] || env.user || "Me";
  const docPath = path.relative(doc.dir, doc.path).split(path.sep).join("/");

  // The folder as a FileStore (room.ts): what the room loads, writes back
  // and re-reads when the watcher sees a change. Writes are atomic renames.
  const storeError = (e: { message: string }) => new StoreError({ message: e.message });
  const store = FileStore.of({
    list: fs.readDirectory(doc.dir, { recursive: true }).pipe(
      Effect.map((all) => all.map((r) => r.split(path.sep).join("/")).filter((r) => !ignored(r))),
      Effect.flatMap((all) => Effect.filter(all, (r) => fs.stat(path.join(doc.dir, r)).pipe(Effect.map((s) => s.type == "File"), Effect.orElseSucceed(() => false)))),
      Effect.mapError(storeError),
    ),
    read: (rel) => fs.readFile(path.join(doc.dir, rel)).pipe(Effect.orElseSucceed(() => null)),
    write: (rel, text) => Effect.gen(function* () {
      const full = path.join(doc.dir, rel);
      yield* fs.makeDirectory(path.dirname(full), { recursive: true });
      const tmp = path.join(path.dirname(full), `.${path.basename(full)}.erga-${process.pid}.tmp`);
      yield* fs.writeFileString(tmp, text);
      yield* fs.rename(tmp, full);
    }).pipe(Effect.mapError(storeError)),
  });
  // The room's Yjs state lives in a cache file named for the folder, so a
  // restarted host picks up the same history (room.ts).
  const stateDir = Option.getOrElse(env.stateDir, () => path.join(Option.getOrElse(env.cacheHome, () => path.join(env.home, ".cache")), "erga", "rooms"));
  const stateFile = path.join(stateDir, new Bun.CryptoHasher("sha1").update(doc.dir).digest("hex").slice(0, 20) + ".yjs");
  const state = StateStore.of({
    load: fs.readFile(stateFile).pipe(Effect.orElseSucceed(() => null)),
    save: (bytes) => Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true });
      yield* fs.writeFile(stateFile + ".tmp", bytes);
      yield* fs.rename(stateFile + ".tmp", stateFile);
    }).pipe(Effect.mapError(storeError)),
  });
  // Open for as long as the host runs; on the way out it writes what's unsaved.
  const room = yield* Room.make({ log: (line) => console.log(line), writeDelay: Option.getOrUndefined(env.writeDelay) }).pipe(
    Effect.provideService(FileStore, store),
    Effect.provideService(StateStore, state),
  );
  if (room.text(docPath) == null) return yield* new UsageError({ message: `${doc.name}: not a UTF-8 text file` });

  // Who a request is from. Locally that's just a name per tab (?user=Ada),
  // defaulting to the person running the host.
  const userOf = (url: URL) => {
    const name = (url.searchParams.get("user") || "").trim().slice(0, 40) || defaultName;
    return { id: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "anon", name };
  };
  const urlOf = (req: HttpServerRequest.HttpServerRequest) => new URL(req.url, "http://localhost");
  const cfg = yield* loadConfig(Option.getOrElse(env.agentEnvFile, () => path.join(EDITOR_DIR, ".env")));
  const host = makeHost({
    room, files: store, agent: cfg,
    doc: { name: doc.name, path: docPath, kind: doc.kind, dir: doc.dir },
    personOf: (req) => userOf(urlOf(req)),
    baseUrl: (req) => `http://${req.headers["host"] ?? `127.0.0.1:${port}`}`,
  });

  // Watch the folder, subfolders included, and hand every change to the
  // room: it merges text edits it didn't make and notes changed assets.
  const watcher = fs.watch(doc.dir, { recursive: true }).pipe(
    Stream.map((ev) => path.relative(doc.dir, path.resolve(doc.dir, ev.path)).split(path.sep).join("/")),
    Stream.filter((rel) => !ignored(rel)),
    Stream.groupedWithin(1000, "60 millis"),
    Stream.mapEffect((chunk) => Effect.forEach(new Set(chunk), (rel) => room.fileChanged(rel).pipe(
      Effect.catch((e) => Effect.sync(() => console.log(`  could not read ${rel}: ${e.message}`))),
    ), { discard: true })),
    Stream.retry(Schedule.spaced("250 millis")),
    Stream.runDrain,
    Effect.catchCause(() => Effect.void),
  );

  // The editor's own files, and the WebSockets (host.ts leaves those to each platform).
  const routes: Array<HttpRouter.Route<unknown, FileSystem.FileSystem | Path.Path>> = [
    HttpRouter.route("GET", "/", serveFile(EDITOR_DIR, "page.html")),
    // The room: Yjs sync and awareness over a WebSocket (y-websocket's protocol).
    HttpRouter.route("GET", "/api/room/*", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const epoch = urlOf(req).searchParams.get("epoch");
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
      const req = yield* HttpServerRequest.HttpServerRequest;
      const user = userOf(urlOf(req));
      const socket = yield* req.upgrade;
      const { pull } = yield* socket.reader;
      const { write } = yield* socket.writer;
      const leave = host.addTab(user.id, (msg) => { Effect.runFork(write(JSON.stringify(msg)).pipe(Effect.ignore)); });
      yield* each(pull, () => Effect.void).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(leave)),
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped)),
    HttpRouter.route("GET", "/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(EDITOR_DIR, p["*"] ?? "", "no-cache")))),
  ];
  const app = Layer.mergeAll(host.app, HttpRouter.addAll(routes.map((r) => HttpRouter.route(r.method, r.path, Effect.catch(r.handler, (e) => Effect.succeed(failed(e)))))));

  const url = `http://127.0.0.1:${port}/`;
  const server = Layer.unwrap(
    Effect.gen(function* () {
      const rel = path.relative(process.cwd(), doc.path);
      const what = Option.isNone(args.target) ? "the demo (a copy of templates/demo; edits last until the host stops)" : rel.startsWith("..") ? doc.path : rel || doc.name;
      yield* Console.log(`\n  editing ${doc.kind === "md" ? "Markdown" : "HTML"}: ${what}\n  ${url}   (another person: ${url}?user=Ada)\n  agent: ${"missing" in cfg ? `off (${host.agentOff})` : `${cfg.model == "script" ? "script" : MODELS[cfg.model].label} to start (each person can switch)`}\n`);
      if (args.open) yield* Effect.forkDetach(Effect.ignore(spawner.exitCode(ChildProcess.make("open", [url]))));
      // Tabs hold their sockets open for good, so waiting for connections to
      // finish (Bun's graceful shutdown) would only stall every exit by 20s.
      return HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(BunHttpServer.layer({ port, idleTimeout: 0, gracefulShutdownTimeout: 0 })));
    }),
  );
  yield* Effect.forkScoped(watcher);
  yield* Layer.launch(server);
});

const open = Command.make("open", {
  target: Argument.String("file-or-directory").pipe(
    Argument.withDescription("An .html or .md file, or a folder holding index.html or index.md (the demo if left out)"),
    Argument.optional,
  ),
  port: Flag.Int("port").pipe(Flag.withDefault(4400), Flag.withDescription("The port to serve the editor on")),
  open: Flag.Boolean("open").pipe(Flag.withDefault(true), Flag.withDescription("Open the editor in a browser (--no-open doesn't)")),
}, (args) => program(args).pipe(
  Effect.scoped,
  Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => process.exit(2))))),
)).pipe(Command.withDescription("Opens a page from disk in the editor, for people and their agents to edit together."));

Command.run(open, { version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
