// One document on erga.dev, as a Durable Object: the hosted counterpart of
// open.ts. It keeps the document's files and the room's Yjs state in its own
// storage, opens the room (room.ts) when the first request arrives, and
// serves the same per-document host as the local server (host.ts): the API,
// /api/stored and /doc/. It takes the two WebSockets itself, since a Durable
// Object accepts them its own way.
//
// The front door (worker/index.ts) has already checked who's asking: it
// forwards each request with the path inside the document (/api/doc, not
// /koomen/abc123/api/doc), the document's public address in x-erga-base,
// and the signed-in person in x-erga-person. An external agent's requests
// to /api/ext carry its share token instead, which this host checks.

import { DurableObject } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { HttpRouter } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { agentConfigFrom } from "../agent";
import { makeHost } from "../host";
import { FileStore, Room, StateStore, StoreError } from "../room";
import type { Env } from "./env";

/** What a document is: who made it and which file is its page. */
interface Meta { owner: string; index: string; created: number }

interface Person { id: string; name: string }

const FILE = "file:", META = "meta", STATE = "state";

/** HttpApi's platform needs, none of which a document served from storage uses. */
const platform = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  Etag.layerWeak,
  FileSystem.layerNoop({}),
  Path.layer,
);

export class DocHost extends DurableObject<Env> {
  private open: Promise<Opened | null> | null = null;

  /** Creates the document from a template's files; false if it already exists. */
  async create(owner: string, files: Record<string, string>, index: string): Promise<boolean> {
    if (await this.ctx.storage.get<Meta>(META)) return false;
    const encoder = new TextEncoder();
    for (const [path, text] of Object.entries(files)) await this.ctx.storage.put(FILE + path, encoder.encode(text));
    await this.ctx.storage.put(META, { owner, index, created: Date.now() } satisfies Meta);
    return true;
  }

  /** Whether the document exists. */
  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<Meta>(META)) != null;
  }

  async fetch(request: Request): Promise<Response> {
    const opened = await (this.open ??= this.load());
    if (!opened) return new Response("No such document", { status: 404 });
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() == "websocket") {
      if (url.pathname.startsWith("/api/room")) return opened.roomSocket(url);
      if (url.pathname == "/api/events") return opened.eventSocket(personOf(request.headers));
      return new Response("Not found", { status: 404 });
    }
    return opened.handler(request);
  }

  /** Opens the room on this document's storage, for as long as the object lives. */
  private async load(): Promise<Opened | null> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return null;
    const storage = this.ctx.storage;
    const storeError = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });
    const files = FileStore.of({
      list: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: FILE })).keys()].map((k) => k.slice(FILE.length)), catch: storeError }),
      read: (path) => Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(FILE + path)) ?? null, catch: storeError }),
      write: (path, text) => Effect.tryPromise({ try: () => storage.put(FILE + path, new TextEncoder().encode(text)), catch: storeError }),
    });
    const state = StateStore.of({
      load: Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(STATE)) ?? null, catch: storeError }),
      save: (bytes) => Effect.tryPromise({ try: () => storage.put(STATE, bytes), catch: storeError }),
    });

    // The room's scope lasts as long as this object: it's evicted only when
    // idle, by which time the room's writes (400ms behind the last edit) are in.
    const scope = Effect.runSync(Scope.make());
    const room = await Effect.runPromise(Room.make({ log: (line) => console.log(line) }).pipe(
      Effect.provideService(FileStore, files),
      Effect.provideService(StateStore, state),
      Scope.provide(scope),
    ));
    const agent = await Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(this.env)));
    const host = makeHost({
      room, files, agent,
      doc: { name: meta.index, path: meta.index, kind: meta.index.endsWith(".md") ? "md" : "html", dir: meta.owner },
      personOf: (req) => personOf(new Headers(req.headers as Record<string, string>)),
      baseUrl: (req) => req.headers["x-erga-base"] ?? "",
      signedIn: true,
    });
    const { handler } = HttpRouter.toWebHandler(host.app.pipe(Layer.provide(platform)), { disableLogger: true });

    return {
      handler: (request) => handler(request),
      roomSocket: (url) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        // Binary frames as ArrayBuffers: with this compatibility date they'd otherwise arrive as Blobs.
        server.binaryType = "arraybuffer";
        const send = (m: Uint8Array) => { try { server.send(m); } catch { /* already closed */ } };
        const conn = room.connect(send, { epoch: url.searchParams.get("epoch") });
        // A tab holding another epoch's history is refused, never merged (room.ts).
        if (!conn) server.close(4409, "stale epoch");
        else {
          server.addEventListener("message", (e) => {
            if (!conn.receive(bytesOf(e.data))) server.close(4400, "malformed message");
          });
          const leave = () => conn.close();
          server.addEventListener("close", leave);
          server.addEventListener("error", leave);
        }
        return new Response(null, { status: 101, webSocket: client });
      },
      eventSocket: (person) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        const leave = host.addTab(person.id, (msg) => { try { server.send(JSON.stringify(msg)); } catch { /* already closed */ } });
        server.addEventListener("close", leave);
        server.addEventListener("error", leave);
        return new Response(null, { status: 101, webSocket: client });
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  }
}

interface Opened {
  handler: (request: Request) => Promise<Response>;
  roomSocket: (url: URL) => Response;
  eventSocket: (person: Person) => Response;
  close: () => Promise<void>;
}

/** A frame's bytes, whether it came as text, an ArrayBuffer or a view on one. */
function bytesOf(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data == "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/** The person the front door vouched for (anonymous if it didn't, which only /api/ext should see). */
function personOf(headers: Headers): Person {
  try {
    const p = JSON.parse(headers.get("x-erga-person") ?? "") as Person;
    if (typeof p.id == "string" && typeof p.name == "string") return p;
  } catch { /* none */ }
  return { id: "anon", name: "Someone" };
}
