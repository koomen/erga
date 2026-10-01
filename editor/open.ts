#!/usr/bin/env bun
// Opens a page from disk in the page editor.
//
//   bun wip/editor/open.ts <file-or-directory> [--port 4400] [--no-open]
//
// A directory must hold index.html or index.md. The host serves the editor
// shell at /, the document's folder at /doc/ (so its scripts, styles and
// images load as they would when published), and a small API the shell uses
// to read the document, write edits back to disk, and hear about edits made
// on disk by anything else (an agent, another editor). The file on disk is
// the source of truth; the editor never holds a copy it doesn't write back.
//
// It also runs the embedded agent (agent.ts) when wip/editor/.env holds an
// API key: the shell sends messages to /api/agent, the agent's progress comes
// back over the same event stream, and its edits reach the page through the
// watcher like any other change on disk.

import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServer from "@effect/platform/HttpServer";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Console from "effect/Console";
import * as Chunk from "effect/Chunk";
import * as Schedule from "effect/Schedule";
import { loadConfig, startAgent, type Agent } from "./agent";
import type { ViewRequest, ViewResult } from "./src/page/agent-log";

const EDITOR_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

interface Doc {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly kind: "html" | "md";
}

const SaveBody = Schema.Struct({ text: Schema.String, version: Schema.Number });
const ViewBody = Schema.Struct({
  id: Schema.String,
  png: Schema.optional(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  errors: Schema.Array(Schema.String),
  note: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const PromptBody = Schema.Struct({ text: Schema.String, context: Schema.optional(Schema.NullOr(Schema.String)) });

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
  if (!target || !Number.isFinite(port)) return yield* new UsageError({ message: "usage: bun wip/editor/open.ts <file-or-directory> [--port N] [--no-open]" });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const doc = yield* resolveDoc(target);
  // What the editor last wrote (or we last read), so disk changes it caused are not echoed back.
  const known = yield* Ref.make(yield* fs.readFileString(doc.path));
  // Bumped on every change to the document, ours or not. A save names the
  // version it was based on, so it can never overwrite a change it hasn't seen.
  const version = yield* Ref.make(1);
  const changes = yield* PubSub.unbounded<string>();
  const encoder = new TextEncoder();
  const send = (msg: unknown) => PubSub.publish(changes, "data: " + JSON.stringify(msg) + "\n\n");

  // The agent, if configured. Its events go to every open shell. To look at
  // the page it asks the open shells: each renders the latest version and
  // the first to answer wins (src/page/main.ts). With no shell open, there's
  // nothing to look with, and the tool says so.
  const shells = yield* Ref.make(0);
  const views = new Map<string, (r: ViewResult) => void>();
  const view = (req: ViewRequest): Promise<ViewResult> => {
    if (Effect.runSync(Ref.get(shells)) == 0) return Promise.resolve({ width: 0, height: 0, errors: [], error: "Nobody has the editor open, so there's no browser to look at the page with." });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { views.delete(id); resolve({ width: 0, height: 0, errors: [], error: "The editor didn't send a picture back in time." }); }, 20_000);
      views.set(id, (r) => { clearTimeout(timer); views.delete(id); resolve(r); });
      Effect.runSync(send({ type: "view", id, req }));
    });
  };
  const cfg = yield* Effect.promise(() => loadConfig(process.env.SCRATCHWORK_AGENT_ENV_FILE || path.join(EDITOR_DIR, ".env")));
  let agent: Agent | null = null;
  let agentOff = "missing" in cfg ? cfg.missing : "";
  if (!("missing" in cfg)) {
    const started = yield* Effect.tryPromise(() => startAgent({ cfg, cwd: doc.dir, docName: doc.name, kind: doc.kind, view })).pipe(Effect.either);
    if (started._tag == "Right") {
      agent = started.right;
      agent.subscribe((ev) => Effect.runSync(send({ type: "agent", ev })));
    } else agentOff = `the agent did not start: ${String(started.left.error)}`;
  }

  const readDoc = Effect.gen(function* () {
    const text = yield* fs.readFileString(doc.path);
    yield* noteDisk(text);
    return { name: doc.name, kind: doc.kind, text, dir: doc.dir, version: yield* Ref.get(version) };
  });

  /** Records the document's text on disk; true if it had changed behind our back. */
  const noteDisk = (text: string) =>
    Ref.get(known).pipe(Effect.flatMap((k) => k === text ? Effect.succeed(false) : Ref.set(known, text).pipe(
      Effect.zipRight(Ref.update(version, (v) => v + 1)),
      Effect.zipRight(Console.log(`  changed on disk: ${doc.name}`)),
      Effect.as(true),
    )));

  /** Writes the editor's text, unless the file changed since the version it was based on. */
  const writeDoc = (text: string, base: number) =>
    Effect.gen(function* () {
      const onDisk = yield* fs.readFileString(doc.path);
      const moved = yield* noteDisk(onDisk);
      const v = yield* Ref.get(version);
      if (moved || base !== v) {
        if (moved) yield* send({ type: "doc", text: onDisk, version: v });
        return { ok: false as const, text: onDisk, version: v };
      }
      yield* Ref.set(known, text);
      const next = yield* Ref.updateAndGet(version, (n) => n + 1);
      const tmp = path.join(doc.dir, `.${doc.name}.sw-${process.pid}.tmp`);
      yield* fs.writeFileString(tmp, text);
      yield* fs.rename(tmp, doc.path);
      return { ok: true as const, version: next };
    });

  // Watch the document's folder, subfolders included. A change to the document
  // that isn't ours is sent to the editor as its new text; a change to any other
  // file (a stylesheet, a script, an image) as its path, so the page reloads.
  const docChanged = fs.readFileString(doc.path).pipe(
    Effect.option,
    Effect.flatMap((o) => o._tag == "None" ? Effect.void : noteDisk(o.value).pipe(
      Effect.flatMap((moved) => moved ? Ref.get(version).pipe(Effect.flatMap((v) => send({ type: "doc", text: o.value, version: v }))) : Effect.void),
    )),
  );
  const ignored = (rel: string) => rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || seg == "node_modules");
  const watcher = fs.watch(doc.dir, { recursive: true }).pipe(
    Stream.map((ev) => path.relative(doc.dir, path.resolve(doc.dir, ev.path))),
    Stream.filter((rel) => !ignored(rel)),
    Stream.groupedWithin(1000, "60 millis"),
    Stream.mapEffect((chunk) => {
      const rels = [...new Set(Chunk.toReadonlyArray(chunk))];
      const others = rels.filter((r) => r != doc.name);
      return Effect.all([
        rels.includes(doc.name) ? docChanged : Effect.void,
        others.length ? send({ type: "files", paths: others }) : Effect.void,
      ]);
    }),
    Stream.retry(Schedule.spaced("250 millis")),
    Stream.runDrain,
    Effect.catchAllCause(() => Effect.void),
  );

  const router = HttpRouter.empty.pipe(
    HttpRouter.get("/", serveFile(EDITOR_DIR, "page.html")),
    HttpRouter.get("/api/doc", readDoc.pipe(Effect.flatMap((d) => HttpServerResponse.json(d)))),
    HttpRouter.put("/api/doc", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(SaveBody);
      const result = yield* writeDoc(body.text, body.version);
      return yield* HttpServerResponse.json(result, { status: result.ok ? 200 : 409 });
    })),
    HttpRouter.post("/api/doc", Effect.gen(function* () {
      // sendBeacon on page hide: same as PUT.
      const body = yield* HttpServerRequest.schemaBodyJson(SaveBody);
      const result = yield* writeDoc(body.text, body.version);
      return yield* HttpServerResponse.json(result, { status: result.ok ? 200 : 409 });
    })),
    HttpRouter.get("/api/events", Effect.gen(function* () {
      // Counted, so view_page knows whether there's a shell to ask.
      const stream = Stream.make(encoder.encode(": connected\n\n")).pipe(
        Stream.concat(Stream.fromPubSub(changes).pipe(Stream.map((s) => encoder.encode(s)))),
        Stream.onStart(Ref.update(shells, (n) => n + 1)),
        Stream.ensuring(Ref.update(shells, (n) => n - 1)),
      );
      return HttpServerResponse.stream(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
    })),
    HttpRouter.get("/api/agent", HttpServerResponse.json(
      agent ? { enabled: true, model: agent.model, log: agent.log() } : { enabled: false, reason: agentOff },
    )),
    HttpRouter.post("/api/agent", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(PromptBody);
      if (!agent) return yield* HttpServerResponse.json({ ok: false, reason: agentOff }, { status: 503 });
      agent.prompt(body.text, body.context ?? null);
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.post("/api/agent/view", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(ViewBody);
      const { id, ...result } = body;
      views.get(id)?.({ ...result, errors: [...result.errors] });
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.post("/api/agent/abort", Effect.gen(function* () {
      if (agent) yield* Effect.promise(() => agent!.abort());
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.post("/api/agent/reset", Effect.gen(function* () {
      if (agent) yield* Effect.promise(() => agent!.reset());
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.get("/doc/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(doc.dir, p["*"] ?? "")))),
    HttpRouter.get("/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(EDITOR_DIR, p["*"] ?? "", "no-cache")))),
    HttpRouter.catchAll((e) => Effect.succeed(HttpServerResponse.text(String((e as { message?: string }).message ?? e), { status: 500 }))),
  );

  const url = `http://127.0.0.1:${port}/`;
  const server = Layer.unwrapEffect(
    Effect.gen(function* () {
      const rel = path.relative(process.cwd(), doc.path);
      yield* Console.log(`\n  editing ${doc.kind === "md" ? "Markdown" : "HTML"}: ${rel.startsWith("..") ? doc.path : rel || doc.name}\n  ${url}\n  agent: ${agent ? agent.model : `off (${agentOff})`}\n`);
      if (!noOpen) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      return HttpServer.serve(router).pipe(Layer.provide(BunHttpServer.layer({ port, idleTimeout: 0 })));
    }),
  );
  yield* Effect.forkScoped(watcher);
  yield* Layer.launch(server);
});

program.pipe(
  Effect.scoped,
  Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.zipRight(Effect.sync(() => process.exit(2))))),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
);
