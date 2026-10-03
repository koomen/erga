// One document on erga.dev, as a Durable Object: the hosted counterpart of
// a local document (docs.ts). It keeps the document's files and the room's Yjs state in its own
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
// It also keeps its row in the directory (directory.ts, D1) up to date: when
// it was last edited, and the title that follows its first heading (at most
// every DIRECTORY_EVERY_MS); a document made before the directory adds its
// row the first time it opens. It deletes itself, row included, if nobody
// edits it within UNEDITED_HOURS of being made.

import { DurableObject } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { agentConfigFrom } from "../agent";
import { DIRECTORY_EVERY_MS, nameOf, namingFor, throttle, UNTITLED, type DocName, type DocRow } from "../directory";
import { afterUnedited, titleOf, UNEDITED_HOURS } from "../front";
import { makeHost } from "../host";
import { FileStore, Room, StateStore, StoreError } from "../room";
import { directoryOf } from "./d1";
import type { Env } from "./env";

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, and when a file last changed (never, if unset).
 * Documents made before ids were kept here have none (their object's name has it).
 */
interface Meta { id?: string; owner: string; index: string; created: number; modified?: number; test?: boolean }

interface Person { id: string; name: string }

const FILE = "file:", META = "meta", STATE = "state";
const AVATARS = "https://avatars.githubusercontent.com";

export class DocHost extends DurableObject<Env> {
  private open: Promise<Opened | null> | null = null;
  /** Every WebSocket open on this document: someone has it open while there are any. */
  private sockets = new Set<WebSocket>();

  private sync: (() => void) | null = null;

  /**
   * Creates the document, whose row the front door has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (UNEDITED_HOURS after it's
   * made, or sooner when local development asks, to test it).
   */
  async create(owner: string, id: string, files: Record<string, string>, index: string, opts: { test?: boolean; expires: number | null }): Promise<boolean> {
    if (await this.ctx.storage.get<Meta>(META)) return false;
    const encoder = new TextEncoder();
    for (const [path, text] of Object.entries(files)) await this.ctx.storage.put(FILE + path, encoder.encode(text));
    const meta: Meta = { id, owner: owner.toLowerCase(), index, created: Date.now(), ...(opts.test ? { test: true } : {}) };
    await this.ctx.storage.put(META, meta);
    if (!meta.test && opts.expires != null) await this.ctx.storage.setAlarm(opts.expires);
    return true;
  }

  /** Deletes the document (the front door has asked the directory who may): everyone on it is disconnected. */
  async delete(): Promise<boolean> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return false;
    await this.destroy(meta);
    return true;
  }

  /**
   * Puts the document in the directory if it isn't there yet (one made
   * before the directory), as it is now, keeping this object's name: its row.
   * Null if there's no such document.
   */
  async register(): Promise<DocRow | null> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return null;
    const id = this.idOf(meta);
    const bytes = await this.ctx.storage.get<Uint8Array>(FILE + meta.index);
    const { doc } = await directoryOf(this.env).add({
      id, owner: meta.owner,
      title: (bytes && titleOf(new TextDecoder().decode(bytes), meta.index)) || UNTITLED,
      // A test document's address stays its id (the suite addresses it so).
      ...(meta.test ? { slug: id, slugSet: true } : {}),
      doName: this.ctx.id.name ?? id,
      created: meta.created, modified: meta.modified ?? null,
      expires: meta.modified || meta.test ? null : (await this.ctx.storage.getAlarm()),
      test: meta.test,
    });
    return doc;
  }

  /**
   * UNEDITED_HOURS after it was made: a document nobody has edited goes.
   * One open somewhere waits an hour more, so it isn't pulled from under
   * someone about to type.
   */
  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    const next = afterUnedited(meta, this.sockets.size > 0, Date.now());
    if (next == "keep") return;
    if (next != "delete") {
      await this.ctx.storage.setAlarm(next);
      await directoryOf(this.env).setExpires(this.idOf(meta), next).catch((e) => console.log(`couldn't update ${this.idOf(meta)}'s row: ${e}`));
      return;
    }
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
    await directoryOf(this.env).remove(this.idOf(meta));
  }

  /** Its id: in its meta, or (made before ids were kept there) in its name, "<owner>/<id>". */
  private idOf(meta: Meta): string {
    const name = this.ctx.id.name;
    return meta.id ?? (name?.includes("/") ? name.split("/")[1] : name) ?? this.ctx.id.toString();
  }

  /**
   * Brings its row up to date after edits: when it was last edited, and the
   * title, which follows its first heading until someone sets it (and the
   * slug the title). Every open tab hears of a new title or address.
   */
  private async syncDirectory(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    const bytes = await this.ctx.storage.get<Uint8Array>(FILE + meta.index);
    const r = await directoryOf(this.env).edited(this.idOf(meta), {
      modified: meta.modified ?? null,
      pageTitle: bytes ? titleOf(new TextDecoder().decode(bytes), meta.index) : null,
    });
    if (r?.renamed) (await this.open)?.renamed(nameOf(r.doc));
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
    // At most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    this.sync ??= throttle(() => this.syncDirectory().catch((e) => console.log(`couldn't update ${this.idOf(meta)}'s row: ${e}`)), DIRECTORY_EVERY_MS);
    this.sync();
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
    // Documents made before the directory join it when they open.
    await this.register().catch((e) => console.log(`couldn't put ${this.idOf(meta)} in the directory: ${e}`));
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
      // Its title and address, renamed as whoever asks (test people are "test-...": they may rename only test documents).
      naming: (person) => naming({ login: person.id, test: person.id.startsWith("test-") }),
    });
    const naming = namingFor(directoryOf(this.env), this.idOf(meta), () => titleOf(room.text(meta.index) ?? "", meta.index));

    return {
      handler: host.handler,
      renamed: host.renamed,
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
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)).then(host.dispose),
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
  /** Tells every open tab the document's new title and address. */
  renamed: (name: DocName) => void;
  close: () => Promise<void>;
}

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
