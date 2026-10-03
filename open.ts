#!/usr/bin/env bun
// The local host: erga.dev's app on your machine, for you and your agents.
//
//   bun open.ts [file-or-directory] [--port 4400] [--no-open] [--data ~/.erga]   (--help for more)
//
// It serves the same front door as the hosted Worker (front.ts): the demo
// at /, /new, your documents at /docs, and each document at /<you>/<id>,
// with the per-document host (host.ts) under it. What the platform does on
// Cloudflare is done here with local stand-ins:
//
//   - who you are: the name in your git config, no sign-in. A tab can be
//     someone else with ?user=Ada; /auth/github?as=Ada signs this browser in
//     as Ada (a cookie) and /auth/logout back out
//   - documents: folders in the data directory (docs.ts), real files you
//     can look at, kept across restarts; one nobody edits goes after 24
//     hours, as hosted
//   - the editor's own files: from this folder
//
// Naming a file or folder opens it as one of your documents, edited in
// place: the room (room.ts) writes edits back to it 400ms after the last
// one and merges edits made to it on disk (an editor, git). It gets an
// address of its own, the same every time, joins /docs, and the browser
// opens on it. A directory must hold index.html or index.md. With nothing
// named, the browser opens on the demo.
//
// Each person gets their own agent session (agent.ts) when .env
// holds an API key: a private transcript, shared by that person's tabs, and
// a replica of the shared doc it edits as another participant. A tab names
// its person in ?user=; the agent's progress comes back on that person's
// event channel (a WebSocket at /api/events), and view_page asks that person's tabs.
// The share button gives a person a token for an external agent, which
// calls the same tools in the same session over /api/ext.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { MODELS, loadConfig } from "./agent";
import { openDirectory } from "./directory-sqlite";
import { LocalDocs } from "./docs";
import { documentRoute, frontDoor, safeNext, type Platform, type Session } from "./front";
import { failed, mimeOf } from "./host";
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
  /** Where documents are kept, if not ~/.erga (--data says it too). */
  dataDir: Config.option(Config.String("ERGA_DATA_DIR")),
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
    // Its real path: the document's address comes from it, so it's the same however it's named.
    const abs = yield* fs.realPath(path.resolve(arg)).pipe(Effect.mapError(() => new UsageError({ message: `${arg}: not found` })));
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

/** The templates' text files, by template then path, as the Worker bundles them. */
const readTemplates = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(EDITOR_DIR, "templates");
  const out: Record<string, Record<string, string>> = {};
  for (const name of yield* fs.readDirectory(root)) {
    for (const rel of yield* fs.readDirectory(path.join(root, name), { recursive: true })) {
      const full = path.join(root, name, rel);
      if ((yield* fs.stat(full)).type == "File") (out[name] ??= {})[rel.split(path.sep).join("/")] = yield* fs.readFileString(full);
    }
  }
  return out;
});

/** The local stand-in for the session cookie: just the name this browser signed in as. */
const COOKIE = "erga_session";
const cookieOf = (header: string | null | undefined) => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k == COOKIE) try { return decodeURIComponent(v.join("=")); } catch { return ""; }
  }
  return "";
};

const program = (args: { target: Option.Option<string>; port: number; open: boolean; data: Option.Option<string> }) => Effect.gen(function* () {
  const { port } = args;
  const env = yield* settings;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gitName = yield* spawner.string(ChildProcess.make("git", ["config", "user.name"])).pipe(Effect.orElseSucceed(() => ""));
  const defaultName = gitName.trim().split(/\s+/)[0] || env.user || "Me";

  // Who a request is from. Locally that's a name: the tab's own (?user=Ada),
  // else the one this browser signed in as, else the person running the host.
  // Their login, the owner part of their documents' addresses, is the name
  // in letters and digits.
  const nameOf = (url: URL, cookie: string | null | undefined) =>
    (url.searchParams.get("user") || cookieOf(cookie)).trim().slice(0, 40) || defaultName;
  const personOf = (url: URL, cookie: string | null | undefined) => {
    const name = nameOf(url, cookie);
    return { id: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "anon", name };
  };
  const loginOf = (name: string) =>
    name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "me";
  const sessionOf = (request: Request): Session => {
    const url = new URL(request.url);
    const name = nameOf(url, request.headers.get("cookie"));
    return { login: loginOf(name), name, ...(url.searchParams.get("user") ? { as: name } : {}) };
  };
  const urlOf = (req: HttpServerRequest.HttpServerRequest) => new URL(req.url, "http://localhost");

  const dataDir = path.resolve(Option.getOrElse(Option.orElse(args.data, () => env.dataDir), () => path.join(env.home, ".erga")));
  const cfg = yield* loadConfig(Option.getOrElse(env.agentEnvFile, () => path.join(EDITOR_DIR, ".env")));
  mkdirSync(dataDir, { recursive: true });
  // The directory: every document's address, title and members (directory.ts), in the data directory.
  const { directory } = yield* Effect.acquireRelease(Effect.sync(() => openDirectory(path.join(dataDir, "erga.db"))), (d) => Effect.sync(() => d.close()));
  const docs = new LocalDocs(dataDir, {
    directory,
    agent: cfg,
    personOf: (req) => personOf(urlOf(req), req.headers["cookie"]),
    writeDelay: Option.getOrUndefined(env.writeDelay),
    log: (line) => console.log(line),
  });
  // Open for as long as the host runs; on the way out each room writes what's unsaved.
  yield* Effect.acquireRelease(Effect.promise(() => docs.start()), () => Effect.promise(() => docs.close()));

  // A file or folder named: one of your documents, edited where it is.
  const me = loginOf(defaultName);
  let start = "/";
  let opened: Doc | null = null;
  if (Option.isSome(args.target)) {
    const doc = opened = yield* resolveDoc(args.target.value);
    const index = path.relative(doc.dir, doc.path).split(path.sep).join("/");
    const row = yield* Effect.promise(() => docs.link(me, doc.dir, index));
    const room = (yield* Effect.promise(() => docs.open(me, row.id)))?.room;
    if (room?.text(index) == null) {
      yield* Effect.promise(() => docs.delete(me, row.id));
      return yield* new UsageError({ message: `${doc.name}: not a UTF-8 text file` });
    }
    start = `/${row.owner}/${row.slug}`;
  }

  const templates = yield* readTemplates;
  const editorFile = path.join(EDITOR_DIR, "page.html");
  // Signs the tokens that open a document's files on its pages origin; kept, so open tabs ride out a restart.
  const secretFile = path.join(dataDir, ".pages-secret");
  const secret = existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : (() => {
    const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    writeFileSync(secretFile, fresh, { mode: 0o600 });
    return fresh;
  })();
  const platform: Platform = {
    sessionOf: async (request) => sessionOf(request),
    templates,
    editor: async () => new Response(Bun.file(editorFile)),
    mayCreate: () => true,
    dev: () => true,
    // Each document's page on its own origin here too: <id>-<owner>.localhost, which browsers send to this machine.
    pagesDomain: () => "localhost",
    secret,
    directory,
    // A document's folder is docs/<owner>/<id> in the data directory, whatever its row's do_name.
    docs: {
      create: (doc, files, index, opts) => docs.create(doc.owner, doc.id, files, index, opts),
      exists: (doc) => docs.exists(doc.owner, doc.id),
      delete: (doc) => docs.delete(doc.owner, doc.id),
      list: (owner) => docs.list(owner),
      fetch: (doc, request) => docs.fetch(doc.owner, doc.id, request),
      adopt: async (owner, id) => {
        const doc = await docs.adopt(owner, id);
        return doc && { id: doc.id, owner: doc.owner, doName: doc.doName, test: doc.test };
      },
    },
  };

  /** The document a socket is for (at any of its addresses, as front.ts finds it), opened if need be. */
  const docOf = Effect.gen(function* () {
    const { first, second } = yield* HttpRouter.params;
    const route = first && second ? yield* Effect.promise(() => documentRoute(platform, first, second)) : null;
    return route ? yield* Effect.promise(() => docs.open(route.owner, route.id)) : null;
  });
  const notFound = HttpServerResponse.text("No such document", { status: 404 });

  // The WebSockets (host.ts leaves those to each platform), the editor's own
  // files, signing in, and everything else to the front door.
  const routes: Array<HttpRouter.Route<unknown, FileSystem.FileSystem | Path.Path>> = [
    // The room: Yjs sync and awareness over a WebSocket (y-websocket's protocol).
    HttpRouter.route("GET", "/:first/:second/api/room/*", Effect.gen(function* () {
      const doc = yield* docOf;
      if (!doc) return notFound;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const epoch = urlOf(req).searchParams.get("epoch");
      const socket = yield* req.upgrade;
      const pull = yield* Socket.readerBytes(socket);
      const { write } = yield* socket.writer;
      const conn = doc.room.connect((m) => { Effect.runFork(write(m)); }, { epoch });
      // A tab holding another epoch's history is refused, never merged (room.ts).
      if (!conn) return yield* write(new Socket.CloseEvent(4409, "stale epoch")).pipe(Effect.as(HttpServerResponse.empty()), Effect.orElseSucceed(() => HttpServerResponse.empty()));
      const leave = doc.track(() => { Effect.runFork(Effect.ignore(write(new Socket.CloseEvent(4404, "document deleted")))); });
      yield* each(pull, (data) => conn.receive(data) ? Effect.void : write(new Socket.CloseEvent(4400, "malformed message"))).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => { leave(); conn.close(); })),
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped)),
    // Each tab's own channel: a WebSocket, not server-sent events, because a
    // browser allows only six HTTP/1.1 connections per host and every open
    // tab's event stream would hold one, leaving later requests (sending the
    // agent a message) queued forever. WebSockets don't count against that.
    HttpRouter.route("GET", "/:first/:second/api/events", Effect.gen(function* () {
      const doc = yield* docOf;
      if (!doc) return notFound;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const user = personOf(urlOf(req), req.headers["cookie"]);
      const socket = yield* req.upgrade;
      const { pull } = yield* socket.reader;
      const { write } = yield* socket.writer;
      const leaveTab = doc.host.addTab(user.id, (msg) => { Effect.runFork(write(JSON.stringify(msg)).pipe(Effect.ignore)); });
      const leave = doc.track(() => { Effect.runFork(Effect.ignore(write(new Socket.CloseEvent(4404, "document deleted")))); });
      yield* each(pull, () => Effect.void).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(Effect.sync(() => { leave(); leaveTab(); })),
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped)),
    HttpRouter.route("GET", "/page.js", serveFile(EDITOR_DIR, "page.js", "no-cache")),
    HttpRouter.route("GET", "/frame.js", serveFile(EDITOR_DIR, "frame.js", "no-cache")),
    HttpRouter.route("GET", "/style.css", serveFile(EDITOR_DIR, "style.css", "no-cache")),
    HttpRouter.route("GET", "/fonts/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(path.join(EDITOR_DIR, "fonts"), p["*"] ?? "", "no-cache")))),
    // Signing in: nothing to check locally. ?as= names who this browser is
    // (as DEV_LOGIN does for the Worker in development), and signing out
    // goes back to the person running the host.
    HttpRouter.route("GET", "/auth/github", Effect.gen(function* () {
      const url = urlOf(yield* HttpServerRequest.HttpServerRequest);
      const as = url.searchParams.get("as")?.trim().slice(0, 40);
      const headers: Record<string, string> = { Location: safeNext(url.searchParams.get("next")) };
      if (as) headers["Set-Cookie"] = `${COOKIE}=${encodeURIComponent(as)}; Path=/; HttpOnly; SameSite=Lax`;
      return HttpServerResponse.empty({ status: 302, headers });
    })),
    HttpRouter.route("GET", "/auth/logout", HttpServerResponse.empty({ status: 302, headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` } })),
    HttpRouter.route("*", "*", Effect.gen(function* () {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      return HttpServerResponse.fromWeb(yield* Effect.promise(() => frontDoor(request, platform)));
    })),
  ];
  const app = HttpRouter.addAll(routes.map((r) => HttpRouter.route(r.method, r.path, Effect.catch(r.handler, (e) => Effect.succeed(failed(e))))));

  const base = `http://127.0.0.1:${port}`;
  const server = Layer.unwrap(
    Effect.gen(function* () {
      const where = dataDir.replace(env.home, "~");
      if (opened) {
        const rel = path.relative(process.cwd(), opened.path);
        yield* Console.log(`\n  editing ${opened.kind === "md" ? "Markdown" : "HTML"}: ${rel.startsWith("..") ? opened.path : rel || opened.name}\n  ${base}${start}   (another person: ${base}${start}?user=Ada)`);
      } else {
        yield* Console.log(`\n  ${base}/   (the demo; Edit makes you a copy)`);
      }
      yield* Console.log(`  your documents: ${base}/docs   (kept in ${where}, as ${me})\n  agent: ${"missing" in cfg ? `off (${cfg.missing})` : `${cfg.model == "script" ? "script" : MODELS[cfg.model].label} to start (each person can switch)`}\n`);
      if (args.open) yield* Effect.forkDetach(Effect.ignore(spawner.exitCode(ChildProcess.make("open", [base + start]))));
      // Tabs hold their sockets open for good, so waiting for connections to
      // finish (Bun's graceful shutdown) would only stall every exit by 20s.
      return HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(Layer.provide(BunHttpServer.layer({ port, idleTimeout: 0, gracefulShutdownTimeout: 0 })));
    }),
  );
  yield* Layer.launch(server);
});

const open = Command.make("open", {
  target: Argument.String("file-or-directory").pipe(
    Argument.withDescription("An .html or .md file, or a folder holding index.html or index.md, to edit where it is (left out, the browser opens on the demo)"),
    Argument.optional,
  ),
  port: Flag.Int("port").pipe(Flag.withDefault(4400), Flag.withDescription("The port to serve the app on")),
  open: Flag.Boolean("open").pipe(Flag.withDefault(true), Flag.withDescription("Open the browser (--no-open doesn't)")),
  data: Flag.String("data").pipe(Flag.withDescription("Where documents are kept (default: $ERGA_DATA_DIR, else ~/.erga)"), Flag.optional),
}, (args) => program(args).pipe(
  Effect.scoped,
  Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => process.exit(2))))),
)).pipe(Command.withDescription("Serves erga.dev's app locally: the demo, your documents (/docs, /new), and any page from disk to edit in place, for people and their agents."));

Command.run(open, { version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
