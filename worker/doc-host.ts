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
//
// It also keeps its entry in the owner's list (doc-list.ts) up to date, and
// deletes itself if nobody edits it within UNEDITED_HOURS of being made.

import { DurableObject } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { HttpRouter } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { agentConfigFrom } from "../agent";
import { makeHost } from "../host";
import { FileStore, Room, StateStore, StoreError } from "../room";
import type { Listed } from "./doc-list";
import type { Env } from "./env";

/** How long a new document lasts if nobody ever edits it. */
export const UNEDITED_HOURS = 24;
const HOUR = 60 * 60 * 1000;

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, and when a file last changed (never, if unset).
 * Documents made before ids were kept here have none (their object's name has it).
 */
interface Meta { id?: string; owner: string; index: string; created: number; modified?: number; test?: boolean }

interface Person { id: string; name: string }

const FILE = "file:", META = "meta", STATE = "state";
const AVATARS = "https://avatars.githubusercontent.com";

/** HttpApi's platform needs, none of which a document served from storage uses. */
const platform = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  Etag.layerWeak,
  FileSystem.layerNoop({}),
  Path.layer,
);

export class DocHost extends DurableObject<Env> {
  private open: Promise<Opened | null> | null = null;
  /** Every WebSocket open on this document: someone has it open while there are any. */
  private sockets = new Set<WebSocket>();

  /**
   * Creates the document from a template's files; false if it already
   * exists. Unless someone edits it, it's deleted UNEDITED_HOURS later
   * (or `unedited` ms, which only local development asks for, to test it).
   */
  async create(owner: string, id: string, files: Record<string, string>, index: string, opts: { test?: boolean; unedited?: number } = {}): Promise<boolean> {
    if (await this.ctx.storage.get<Meta>(META)) return false;
    const encoder = new TextEncoder();
    for (const [path, text] of Object.entries(files)) await this.ctx.storage.put(FILE + path, encoder.encode(text));
    const meta: Meta = { id, owner, index, created: Date.now(), ...(opts.test ? { test: true } : {}) };
    await this.ctx.storage.put(META, meta);
    if (!meta.test) await this.ctx.storage.setAlarm(meta.created + (opts.unedited ?? UNEDITED_HOURS * HOUR));
    await this.list(meta);
    return true;
  }

  /** Deletes the document, if `owner` made it: everyone on it is disconnected. */
  async delete(owner: string): Promise<boolean> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta || meta.owner.toLowerCase() != owner.toLowerCase()) return false;
    await this.destroy(meta);
    return true;
  }

  /**
   * UNEDITED_HOURS after it was made: a document nobody has edited goes.
   * One open somewhere waits an hour more, so it isn't pulled from under
   * someone about to type.
   */
  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta || meta.modified || meta.test) return;
    if (this.sockets.size) return this.ctx.storage.setAlarm(Date.now() + HOUR);
    console.log(`deleting ${meta.owner}/${this.idOf(meta)}: not edited in ${UNEDITED_HOURS} hours`);
    await this.destroy(meta);
  }

  private async destroy(meta: Meta): Promise<void> {
    for (const socket of this.sockets) { try { socket.close(4404, "document deleted"); } catch { /* already closed */ } }
    this.sockets.clear();
    // The room writes what it holds as it closes, so it closes before storage is cleared.
    const opened = await this.open;
    this.open = null;
    await opened?.close();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (!meta.test) await this.env.LISTS.getByName(meta.owner.toLowerCase()).remove(this.idOf(meta));
  }

  private idOf(meta: Meta): string {
    return meta.id ?? this.ctx.id.name?.split("/")[1] ?? this.ctx.id.toString();
  }

  /** Puts the document's entry, as it is now, in its owner's list (test documents aren't listed). */
  private async list(meta: Meta): Promise<void> {
    if (meta.test) return;
    const bytes = await this.ctx.storage.get<Uint8Array>(FILE + meta.index);
    const id = this.idOf(meta);
    const entry: Listed = {
      id,
      title: (bytes && titleOf(new TextDecoder().decode(bytes), meta.index)) || id,
      created: meta.created,
      modified: meta.modified ?? meta.created,
      ...(meta.modified ? {} : { expires: (await this.ctx.storage.getAlarm()) ?? undefined }),
    };
    await this.env.LISTS.getByName(meta.owner.toLowerCase()).put(entry);
  }

  /**
   * The room writes a file only when its text changed (its own seeding and
   * people merely looking never do), so a write that changes what storage
   * holds is an edit: by a person, an agent or a publish.
   */
  private async edited(path: string, text: string): Promise<void> {
    const before = await this.ctx.storage.get<Uint8Array>(FILE + path);
    const bytes = new TextEncoder().encode(text);
    await this.ctx.storage.put(FILE + path, bytes);
    if (before && sameBytes(before, bytes)) return;
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    meta.modified = Date.now();
    await this.ctx.storage.put(META, meta);
    if (!meta.test) await this.ctx.storage.deleteAlarm();
    this.list(meta).catch((e) => console.log(`couldn't update ${meta.owner}'s list: ${e}`));
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
    // Documents made before there was a list join it when they open.
    this.list(meta).catch((e) => console.log(`couldn't update ${meta.owner}'s list: ${e}`));
    const storage = this.ctx.storage;
    const storeError = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });
    const files = FileStore.of({
      list: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: FILE })).keys()].map((k) => k.slice(FILE.length)), catch: storeError }),
      read: (path) => Effect.tryPromise({ try: async () => (await storage.get<Uint8Array>(FILE + path)) ?? null, catch: storeError }),
      write: (path, text) => Effect.tryPromise({ try: () => this.edited(path, text), catch: storeError }),
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
    // A test document's agent is the scripted one (agent.ts): free, and the same every run.
    const agent = meta.test
      ? { apiKey: Redacted.make(""), model: "script" as const, effort: "medium" }
      : await Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(this.env)));
    const host = makeHost({
      room, files, agent,
      doc: { name: meta.index, path: meta.index, kind: meta.index.endsWith(".md") ? "md" : "html", dir: meta.owner },
      personOf: (req) => personOf(new Headers(req.headers as Record<string, string>)),
      baseUrl: (req) => req.headers["x-erga-base"] ?? "",
      signedIn: true,
      // People's ids are their GitHub logins, so GitHub serves their pictures.
      avatarOf: (person) => (person.id.startsWith("test-") ? undefined : `${AVATARS}/${encodeURIComponent(person.id)}?s=64`),
    });
    const { handler } = HttpRouter.toWebHandler(host.app.pipe(Layer.provide(platform)), { disableLogger: true });

    return {
      handler: (request) => handler(request),
      roomSocket: (url) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        this.track(server);
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
        this.track(server);
        const leave = host.addTab(person.id, (msg) => { try { server.send(JSON.stringify(msg)); } catch { /* already closed */ } });
        server.addEventListener("close", leave);
        server.addEventListener("error", leave);
        return new Response(null, { status: 101, webSocket: client });
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  }

  private track(socket: WebSocket): void {
    this.sockets.add(socket);
    const gone = () => this.sockets.delete(socket);
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }
}

interface Opened {
  handler: (request: Request) => Promise<Response>;
  roomSocket: (url: URL) => Response;
  eventSocket: (person: Person) => Response;
  close: () => Promise<void>;
}

/**
 * A page's title, as the list shows it: its first top-level heading (what
 * people edit on the page), else an HTML page's <title>. Null if it has neither.
 */
export function titleOf(text: string, path: string): string | null {
  const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 120) || null;
  if (path.endsWith(".md")) {
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    return heading ? clean(heading[1].replace(/[*_`]/g, "")) : null;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text), title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return (h1 && clean(h1[1])) || (title && clean(title[1])) || null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] == "#" ? String.fromCodePoint(parseInt(e[1] == "x" || e[1] == "X" ? e.slice(2) : e.slice(1), e[1] == "x" || e[1] == "X" ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
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
