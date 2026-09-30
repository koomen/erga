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

const EDITOR_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

interface Doc {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly kind: "html" | "md";
}

const SaveBody = Schema.Struct({ text: Schema.String });

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
  const changes = yield* PubSub.unbounded<string>();
  const encoder = new TextEncoder();

  const readDoc = Effect.gen(function* () {
    const text = yield* fs.readFileString(doc.path);
    return { name: doc.name, kind: doc.kind, text, dir: doc.dir };
  });

  const writeDoc = (text: string) =>
    Effect.gen(function* () {
      yield* Ref.set(known, text);
      const tmp = path.join(doc.dir, `.${doc.name}.sw-${process.pid}.tmp`);
      yield* fs.writeFileString(tmp, text);
      yield* fs.rename(tmp, doc.path);
    });

  // Watch the document's folder; a change to the file that isn't ours is pushed to the editor.
  const watcher = fs.watch(doc.dir).pipe(
    Stream.filter((ev) => path.basename(ev.path) === doc.name),
    Stream.debounce("60 millis"),
    Stream.mapEffect(() => fs.readFileString(doc.path).pipe(Effect.option)),
    Stream.filterMap((o) => o),
    Stream.mapEffect((text) =>
      Ref.get(known).pipe(
        Effect.flatMap((k) => (k === text ? Effect.void : Ref.set(known, text).pipe(
          Effect.zipRight(PubSub.publish(changes, "data: " + JSON.stringify({ text }) + "\n\n")),
          Effect.zipRight(Console.log(`  changed on disk: ${doc.name}`)),
        ))),
      ),
    ),
    Stream.runDrain,
    Effect.catchAllCause(() => Effect.void),
  );

  const router = HttpRouter.empty.pipe(
    HttpRouter.get("/", serveFile(EDITOR_DIR, "page.html")),
    HttpRouter.get("/api/doc", readDoc.pipe(Effect.flatMap((d) => HttpServerResponse.json(d)))),
    HttpRouter.put("/api/doc", Effect.gen(function* () {
      const body = yield* HttpServerRequest.schemaBodyJson(SaveBody);
      yield* writeDoc(body.text);
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.post("/api/doc", Effect.gen(function* () {
      // sendBeacon on page hide: same as PUT.
      const body = yield* HttpServerRequest.schemaBodyJson(SaveBody);
      yield* writeDoc(body.text);
      return yield* HttpServerResponse.json({ ok: true });
    })),
    HttpRouter.get("/api/events", Effect.gen(function* () {
      const stream = Stream.make(encoder.encode(": connected\n\n")).pipe(
        Stream.concat(Stream.fromPubSub(changes).pipe(Stream.map((s) => encoder.encode(s)))),
      );
      return HttpServerResponse.stream(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
    })),
    HttpRouter.get("/doc/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(doc.dir, p["*"] ?? "")))),
    HttpRouter.get("/*", HttpRouter.params.pipe(Effect.flatMap((p) => serveFile(EDITOR_DIR, p["*"] ?? "", "no-cache")))),
    HttpRouter.catchAll((e) => Effect.succeed(HttpServerResponse.text(String((e as { message?: string }).message ?? e), { status: 500 }))),
  );

  const url = `http://127.0.0.1:${port}/`;
  const server = Layer.unwrapEffect(
    Effect.gen(function* () {
      const rel = path.relative(process.cwd(), doc.path);
      yield* Console.log(`\n  editing ${doc.kind === "md" ? "Markdown" : "HTML"}: ${rel.startsWith("..") ? doc.path : rel || doc.name}\n  ${url}\n`);
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
