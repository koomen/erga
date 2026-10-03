// One document, as a Durable Object (on erga.dev, and in local development
// alike). It keeps the document's files and the room's Yjs state in its own
// storage, opens the room (room.ts) when the first request arrives, and
// serves the per-document host (host.ts): the API,
// /api/stored and /doc/. It takes the two WebSockets itself, since a Durable
// Object accepts them its own way.
//
// The front door (worker/index.ts) has already checked who's asking: it
// forwards each request with the path inside the document (/api/doc, not
// /koomen/abc123/api/doc), the document's public address in x-erga-base,
// the signed-in person in x-erga-person, and what they may do in
// x-erga-access ("edit", or "view": their room connection is then read-only,
// and so are their agent and publishes). A request that came with an agent
// token (tokens.ts) also has x-erga-agent: only those may call the external
// agent's tools (/api/ext), as the person the token stands for, who may do
// what they last could.
//
// It also keeps its row in the directory (directory.ts, D1) up to date: when
// it was last edited, and the title that follows its first heading (at most
// every DIRECTORY_EVERY_MS). It deletes itself, row included, if nobody
// edits it within its unedited time (the unedited_hours setting) of being made.
//
// In local development a document can be a file or folder on disk (`link`).
// Its files then stay there: the room's storage is the folder itself, reached
// through the dev server over a WebSocket (/api/mirror, disk.ts), and only
// the room's Yjs state is kept here. Its address is the folder's (or the
// file's) name. A single file on its own (`only`) is the only file such a
// document holds: nobody can make another.

import { DurableObject } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { agentConfigFrom } from "../agent";
import { DIRECTORY_EVERY_MS, nameOf, namingFor, throttle, UNTITLED, type DocName, type DocRow } from "../directory";
import { afterUnedited, titleOf } from "../front";
import { makeHost } from "../host";
import { FileStore, Room, StateStore, StoreError } from "../room";
import { assets, isTextPath, files as texts } from "../src/room/doc";
import { directoryOf } from "./d1";
import { DiskLink } from "./disk";
import type { Env } from "./env";

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, and when a file last changed (never, if unset).
 */
interface Meta { id: string; owner: string; index: string; created: number; modified?: number; test?: boolean; disk?: OnDisk }

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
interface OnDisk { path: string; slug: string; only?: boolean }

interface Person { id: string; name: string }

const FILE = "file:", META = "meta", STATE = "state";
const AVATARS = "https://avatars.githubusercontent.com";

export class DocHost extends DurableObject<Env> {
  private open: Promise<Opened | null> | null = null;
  /** The document once it's open (`open` resolved). */
  private opened: Opened | null = null;
  /** Every WebSocket open on this document: someone has it open while there are any. */
  private sockets = new Set<WebSocket>();
  /** A document on disk: its files, through the dev server. */
  private disk = new DiskLink({
    changed: (path) => { this.open?.then((o) => o && Effect.runPromise(o.room.fileChanged(path))).catch((e) => console.log(`couldn't take ${path} from disk: ${e}`)); },
    connected: () => { this.open?.then((o) => o?.catchUp()).catch(() => {}); },
    // Edits already on their way (another socket, a busy machine) land first: a tenth of a second is nothing to wait when stopping.
    flush: async () => { const o = await this.open; await new Promise((r) => setTimeout(r, 100)); if (o) await Effect.runPromise(o.room.flush); },
  });

  private sync: (() => void) | null = null;
  /**
   * Who may edit, by person id, as the front door last said (x-erga-access):
   * their agent, and an external agent acting for them, may do what they could
   * at their latest request.
   */
  private editors = new Map<string, boolean>();

  /**
   * Creates the document, whose row the front door has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (the unedited_hours setting
   * after it's made, or sooner when local development asks, to test it).
   */
  async create(owner: string, id: string, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean> {
    if (await this.ctx.storage.get<Meta>(META)) return false;
    const encoder = new TextEncoder();
    for (const [path, data] of Object.entries(files)) await this.ctx.storage.put(FILE + path, typeof data == "string" ? encoder.encode(data) : data);
    const meta: Meta = { id, owner: owner.toLowerCase(), index, created: Date.now(), ...(opts.modified ? { modified: opts.modified } : {}), ...(opts.test ? { test: true } : {}) };
    await this.ctx.storage.put(META, meta);
    if (!meta.test && opts.expires != null) await this.ctx.storage.setAlarm(opts.expires);
    return true;
  }

  /**
   * Local development: the document for a file or folder on disk, made if
   * it doesn't exist yet, and its row in the directory (its address the
   * folder's or file's name, `disk.slug`). Its files stay on disk (the dev
   * server connects to /api/mirror to reach them); it never expires, and
   * deleting it leaves them as they are.
   */
  async link(owner: string, id: string, index: string, disk: OnDisk): Promise<DocRow> {
    const meta = await this.ctx.storage.get<Meta>(META);
    await this.ctx.storage.put(META, meta ? { ...meta, index, disk } : { id, owner: owner.toLowerCase(), index, created: Date.now(), disk });
    await this.ctx.storage.deleteAlarm();
    return (await this.addRow())!;
  }

  /**
   * Files arriving whole (a publish, from the server's API): each written and
   * taken into the room as an edit "on disk", so open tabs see it at once.
   * What the room holds is written first, so a file replaces the text as it
   * is now (only edits made while it arrives merge with it). Text files go through the room's
   * push; others (images) are stored and the room told. `remove` deletes
   * files. Says what it did with each.
   */
  async publish(files: Record<string, string | Uint8Array>, remove: string[]): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; throw new Error("There's no such document."); }
    const meta = (await this.ctx.storage.get<Meta>(META))!;
    const out = { written: [] as string[], removed: [] as string[], refused: [] as { path: string; why: string }[] };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    // Edits not yet written land first, so a published file replaces what's there now rather than merging with it.
    await Effect.runPromise(opened.room.flush);
    for (const [path, data] of Object.entries(files)) {
      if (meta.disk?.only && path != meta.index) { out.refused.push({ path, why: `this document is the single file ${meta.index}` }); continue; }
      let text: string | null = null;
      if (typeof data == "string") text = data;
      else if (isTextPath(path)) { try { text = decoder.decode(data); } catch { out.refused.push({ path, why: "not UTF-8 text" }); continue; } }
      if (text != null && isTextPath(path)) {
        const r = await Effect.runPromise(opened.room.push(path, text));
        if (r.ok) out.written.push(path); else out.refused.push({ path, why: r.reason ?? "refused" });
        continue;
      }
      if (meta.disk) { out.refused.push({ path, why: "a document on disk takes only text files this way" }); continue; }
      await this.ctx.storage.put(FILE + path, typeof data == "string" ? new TextEncoder().encode(data) : data);
      await Effect.runPromise(opened.room.fileChanged(path));
      out.written.push(path);
    }
    for (const path of remove) {
      if (path == meta.index) { out.refused.push({ path, why: "it's the document's page" }); continue; }
      if (meta.disk) { out.refused.push({ path, why: "files on disk aren't deleted this way" }); continue; }
      if (!(await this.ctx.storage.get(FILE + path))) continue;
      await this.ctx.storage.delete(FILE + path);
      await Effect.runPromise(opened.room.fileChanged(path));
      out.removed.push(path);
    }
    if (out.written.length || out.removed.length) await this.touch();
    return out;
  }

  /** Every file the document holds (the room's view: text files and others). */
  async paths(): Promise<string[]> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; return []; }
    return [...new Set([...texts(opened.room.doc).keys(), ...assets(opened.room.doc).keys()])].sort();
  }

  /** Deletes the document (the front door has asked the directory who may): everyone on it is disconnected. */
  async delete(): Promise<boolean> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return false;
    await this.destroy(meta);
    return true;
  }

  /**
   * Puts a document on disk in the directory if it isn't there yet, as it is
   * now: its row. Anyone signed in may edit it (on this machine, that's
   * whoever local development lets in). Null if there's no such document.
   */
  private async addRow(): Promise<DocRow | null> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return null;
    const id = this.idOf(meta);
    const text = await this.pageText(meta);
    const { doc } = await directoryOf(this.env).add({
      id, owner: meta.owner,
      title: (text && titleOf(text, meta.index)) || UNTITLED,
      // A test document's address stays its id (the suite addresses it so); one on disk is its folder's or file's name.
      ...(meta.test ? { slug: id, slugSet: true } : meta.disk ? { slug: meta.disk.slug, slugSet: true } : {}),
      created: meta.created, modified: meta.modified ?? null,
      expires: meta.modified || meta.test || meta.disk ? null : (await this.ctx.storage.getAlarm()),
      test: meta.test,
      ...(meta.disk ? { everyone: "editor" as const } : {}),
    });
    return doc;
  }

  /**
   * Its unedited time is up: a document nobody has edited goes.
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
    console.log(`deleting ${meta.owner}/${this.idOf(meta)}: never edited`);
    await this.destroy(meta);
  }

  private async destroy(meta: Meta): Promise<void> {
    // One on disk writes what it holds there first, while the dev server is still connected.
    if (meta.disk && this.opened) await Effect.runPromise(this.opened.room.flush);
    for (const socket of this.sockets) { try { socket.close(4404, "document deleted"); } catch { /* already closed */ } }
    this.sockets.clear();
    // The room writes what it holds as it closes, so it closes before storage is cleared.
    const opened = await this.open;
    this.open = null;
    this.opened = null;
    await opened?.close();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await directoryOf(this.env).remove(this.idOf(meta));
  }

  /** Its id (also its object's name). */
  private idOf(meta: Meta): string {
    return meta.id;
  }

  /**
   * Brings its row up to date after edits: when it was last edited, and the
   * title, which follows its first heading until someone sets it (and the
   * slug the title). Every open tab hears of a new title or address.
   */
  private async syncDirectory(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    const text = await this.pageText(meta);
    const r = await directoryOf(this.env).edited(this.idOf(meta), {
      modified: meta.modified ?? null,
      pageTitle: text != null ? titleOf(text, meta.index) : null,
    });
    if (r?.renamed) (await this.open)?.renamed(nameOf(r.doc));
  }

  /**
   * The page's text: from storage, or for a document on disk from its room
   * (once it's open; never waited for, since opening waits for the dev
   * server, which may be linking it just then).
   */
  private async pageText(meta: Meta): Promise<string | null> {
    if (meta.disk) return this.opened?.room.text(meta.index) ?? null;
    const bytes = await this.ctx.storage.get<Uint8Array>(FILE + meta.index);
    return bytes ? new TextDecoder().decode(bytes) : null;
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
    await this.touch();
  }

  /** A file changed: the document has been edited, so it stays (and its row says when). */
  private async touch(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    meta.modified = Date.now();
    await this.ctx.storage.put(META, meta);
    if (!meta.test) await this.ctx.storage.deleteAlarm();
    // At most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    this.sync ??= throttle(() => this.syncDirectory().catch((e) => console.log(`couldn't update ${this.idOf(meta)}'s row: ${e}`)), DIRECTORY_EVERY_MS);
    this.sync();
  }

  /** Where its files are, for a document on disk (local development); null for any other. */
  async diskPath(): Promise<string | null> {
    return (await this.ctx.storage.get<Meta>(META))?.disk?.path ?? null;
  }

  /** Whether the document exists. */
  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<Meta>(META)) != null;
  }

  async fetch(request: Request): Promise<Response> {
    // The dev server, bringing the files of a document on disk: before the room opens, which waits for them.
    if (new URL(request.url).pathname == "/api/mirror") return this.mirror(request);
    const opened = await (this.open ??= this.load());
    // Not made yet: asked again next time, since it may be by then (made, or linked from disk).
    if (!opened) { this.open = null; return new Response("No such document", { status: 404 }); }
    const url = new URL(request.url);
    const editing = request.headers.get("x-erga-access") == "edit";
    if (request.headers.has("x-erga-person")) this.editors.set(personOf(request.headers).id, editing);
    if (request.headers.get("upgrade")?.toLowerCase() == "websocket") {
      // Someone who may only view the document joins the room read-only: they see every edit, and theirs go nowhere.
      if (url.pathname.startsWith("/api/room")) return opened.roomSocket(url, !editing);
      if (url.pathname == "/api/events") return opened.eventSocket(personOf(request.headers));
      return new Response("Not found", { status: 404 });
    }
    return opened.handler(request);
  }

  /** The dev server's socket to the files of a document on disk (the front door checked its secret; so does this). */
  private async mirror(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta?.disk || !this.env.ERGA_LINK_SECRET || url.searchParams.get("link") != this.env.ERGA_LINK_SECRET || request.headers.get("upgrade")?.toLowerCase() != "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.track(server);
    this.disk.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Opens the room on this document's storage, for as long as the object lives. */
  private async load(): Promise<Opened | null> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return null;
    const storage = this.ctx.storage;
    const storeError = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });
    const onDisk = meta.disk && this.disk.store(meta.disk.only ? meta.index : null);
    const files = onDisk ? FileStore.of({
      ...onDisk,
      // A write to disk is an edit too (the room writes only files whose text changed).
      write: (path, text) => onDisk.write(path, text).pipe(Effect.andThen(Effect.promise(() => this.touch()))),
    }) : FileStore.of({
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
    const room = await Effect.runPromise(Room.make({ log: (line) => console.log(line), writeDelay: Number(this.env.ERGA_WRITE_DELAY_MS) || undefined }).pipe(
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
      doc: { name: meta.index, path: meta.index, kind: meta.index.endsWith(".md") ? "md" : "html", dir: meta.disk?.path ?? meta.owner },
      only: meta.disk?.only ? meta.index : undefined,
      personOf: (req) => personOf(new Headers(req.headers as Record<string, string>)),
      // The front door sets x-erga-agent only on a request whose agent token it checked.
      agentOf: (req) => (req.headers["x-erga-agent"] ? personOf(new Headers(req.headers as Record<string, string>)) : null),
      // Their agent edits only if they may (and only while they may).
      canEdit: (person) => this.editors.get(person.id) ?? false,
      mayPublish: (req) => req.headers["x-erga-access"] == "edit",
      baseUrl: (req) => req.headers["x-erga-base"] ?? "",
      // People's ids are their GitHub logins, so GitHub serves their pictures.
      avatarOf: (person) => (person.id.startsWith("test-") ? undefined : `${AVATARS}/${encodeURIComponent(person.id)}?s=64`),
      // Its title and address, renamed as whoever asks (test people are "test-...": they may rename only test documents).
      naming: (person) => naming({ login: person.id, test: person.id.startsWith("test-") }),
    });
    const naming = namingFor(directoryOf(this.env), this.idOf(meta), () => titleOf(room.text(meta.index) ?? "", meta.index));

    const opened: Opened = {
      handler: host.handler,
      renamed: host.renamed,
      roomSocket: (url, readOnly) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        this.track(server);
        // Binary frames as ArrayBuffers: with this compatibility date they'd otherwise arrive as Blobs.
        server.binaryType = "arraybuffer";
        const send = (m: Uint8Array) => { try { server.send(m); } catch { /* already closed */ } };
        const conn = room.connect(send, { epoch: url.searchParams.get("epoch"), readOnly });
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
      room,
      // Back in touch with disk: every file there, and every one the room holds, is looked at again.
      catchUp: async () => {
        const paths = new Set([...await Effect.runPromise(files.list), ...texts(room.doc).keys(), ...assets(room.doc).keys()]);
        for (const path of paths) await Effect.runPromise(room.fileChanged(path)).catch(() => {});
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)).then(host.dispose),
    };
    this.opened = opened;
    // Now with its title, for one on disk.
    if (meta.disk) this.syncDirectory().catch((e) => console.log(`couldn't update ${this.idOf(meta)}'s row: ${e}`));
    return opened;
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
  roomSocket: (url: URL, readOnly: boolean) => Response;
  eventSocket: (person: Person) => Response;
  room: Room;
  catchUp: () => Promise<void>;
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

/** The person the front door vouched for (anonymous if it didn't: the pages origin's requests for files). */
function personOf(headers: Headers): Person {
  try {
    const p = JSON.parse(headers.get("x-erga-person") ?? "") as Person;
    if (typeof p.id == "string" && typeof p.name == "string") return p;
  } catch { /* none */ }
  return { id: "anon", name: "Someone" };
}
