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
// edits it within its unedited time (the delete_docs_after_hours setting) of
// being made; if an admin has since set that to never, it stays.
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
import { agentConfigFrom, type AgentConfig } from "../agent";
import { DIRECTORY_EVERY_MS, nameOf, namingFor, throttle, UNTITLED, type DocName, type DocRow } from "../directory";
import { afterUnedited, titleOf } from "../front";
import { cleanRel, docFile, makeHost, relativeUrl } from "../host";
import { resolvePage } from "../tree";
import { agentToolsFor } from "../server-tools";
import { FileStore, Room, StateStore, StoreError } from "../room";
import { agentName, assets, authorOf, files as texts, folders, isTextPath, type Author } from "../src/room/doc";
import { describeChange, fallbackDescription, firePublished, publicVersion, versionNumber, Versions, type KV, type Published, type PublishRequest, type PublishResult, type RestoreResult, type StoredVersion, type Version, type VersionsState } from "../versions";
import * as Y from "yjs";
import { decodeValue, encodeValue, type DocSnapshot } from "../deploy/snapshot";
import { directoryOf, withKeys } from "./d1";
import { DiskLink } from "./disk";
import { publishedChanged } from "./published";
import type { Env } from "./env";

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, and when a file last changed (never, if unset).
 */
interface Meta { id: string; owner: string; index: string; created: number; modified?: number; test?: boolean; disk?: OnDisk; published?: { n: number } }

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
interface OnDisk { path: string; slug: string; only?: boolean }

interface Person { id: string; name: string }

/** Storage keys: a file's bytes, a folder made as one (empty ones too), what the document is, the room's Yjs state. */
const FILE = "file:", DIR = "dir:", META = "meta", STATE = "state";

/** The new-document template's page (templates/doc), which a new page starts from. */
const TEMPLATE = Object.values(import.meta.glob("../templates/doc/index.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0] ?? "";
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

  /** Its versions (versions.ts), in its own storage. */
  private versions = new Versions(kvOf(this.ctx.storage));
  /**
   * Edits not yet in a version: since when, by whom, and the timers that cut
   * one (see `noteEdit` for the rule).
   */
  private pending = { dirty: false, since: 0, authors: new Set<string>(), idle: null as ReturnType<typeof setTimeout> | null, max: null as ReturnType<typeof setTimeout> | null };
  /** Cuts, one at a time. */
  private cutting: Promise<unknown> = Promise.resolve();
  /** Room connections that may edit: when the last one goes, a version is cut. */
  private editing = 0;
  /** The published version's number in "manual" mode, null in "latest" (undefined: not read yet). */
  private pub: number | null | undefined = undefined;
  private get idleMs() { return Number(this.env.ERGA_VERSION_IDLE_MS) || 30_000; }
  private get maxMs() { return Number(this.env.ERGA_VERSION_MAX_MS) || 5 * 60_000; }
  /**
   * Who may edit, by person id, as the front door last said (x-erga-access):
   * their agent, and an external agent acting for them, may do what they could
   * at their latest request.
   */
  private editors = new Map<string, boolean>();

  /**
   * Creates the document, whose row the front door has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (the delete_docs_after_hours setting
   * after it's made, or sooner when local development asks, to test it).
   */
  async create(owner: string, id: string, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean> {
    if (await this.ctx.storage.get<Meta>(META)) return false;
    const encoder = new TextEncoder();
    for (const [path, data] of Object.entries(files)) await this.ctx.storage.put(FILE + path, typeof data == "string" ? encoder.encode(data) : data);
    const meta: Meta = { id, owner: owner.toLowerCase(), index, created: Date.now(), ...(opts.modified ? { modified: opts.modified } : {}), ...(opts.test ? { test: true } : {}) };
    await this.ctx.storage.put(META, meta);
    if (!meta.test && opts.expires != null) await this.ctx.storage.setAlarm(opts.expires);
    // Its first version: the files it starts from.
    const first = new Map(Object.entries(files).map(([path, data]) => [path, typeof data == "string" ? encoder.encode(data) : data]));
    await this.versions.cut(first, index, [meta.owner], "First version");
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

  /** The document's page (index.html, index.md...), or null if there's no such document. */
  async index(): Promise<string | null> {
    return (await this.ctx.storage.get<Meta>(META))?.index ?? null;
  }

  /**
   * Every file the document holds as it is now (text from the room, so the
   * latest edits are in it), and its page: what a copy of it starts from.
   * Null if there's no such document.
   */
  async snapshot(opts: { published?: boolean } = {}): Promise<{ index: string; files: Record<string, string | Uint8Array> } | null> {
    const meta = await this.ctx.storage.get<Meta>(META);
    // Someone who may only view it, in "manual" mode, copies what they see: the published version.
    const v = opts.published && meta?.published ? await this.versions.get(meta.published.n) : null;
    if (v) return { index: v.index, files: Object.fromEntries(await this.versions.files(v)) };
    const opened = meta && await (this.open ??= this.load());
    if (!meta || !opened) { if (!opened) this.open = null; return null; }
    const files: Record<string, string | Uint8Array> = {};
    for (const path of await this.paths()) {
      const text = opened.room.text(path);
      const data = text ?? (await this.ctx.storage.get<Uint8Array>(FILE + path));
      if (data != null) files[path] = data;
    }
    return { index: meta.index, files };
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
   * someone about to type. If delete_docs_after_hours is now never, it stays.
   */
  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta) return;
    const next = afterUnedited(meta, this.sockets.size > 0, Date.now());
    if (next == "keep") return;
    if ((await directoryOf(this.env).config.get("delete_docs_after_hours")) == null) {
      await directoryOf(this.env).setExpires(this.idOf(meta), null).catch((e) => console.log(`couldn't update ${this.idOf(meta)}'s row: ${e}`));
      return;
    }
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
    this.clearPending();
    // The room writes what it holds as it closes, so it closes before storage is cleared.
    const opened = await this.open;
    this.open = null;
    this.opened = null;
    await opened?.close();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.versions = new Versions(kvOf(this.ctx.storage));
    this.pub = undefined;
    await directoryOf(this.env).remove(this.idOf(meta));
    // If it was the homepage, its snapshot goes too (the next / makes another).
    await this.env.HOME?.getByName("home").forget(this.idOf(meta)).catch((e) => console.log(`couldn't tell the homepage: ${e}`));
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

  /** A message for everyone who has the document open (the homepage's deploy status: worker/home.ts). Opens nothing. */
  async notify(msg: unknown): Promise<void> {
    this.opened?.notify(msg);
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

  /**
   * Everything in its storage, and its alarm: the snapshot staging copies
   * (deploy/snapshot.ts). Only reads: the room isn't opened, nothing is
   * written, the directory isn't touched. Null if there's no document.
   */
  async exportStorage(id: string): Promise<DocSnapshot | null> {
    const all = await this.ctx.storage.list();
    if (!all.has(META)) return null;
    return { id, entries: [...all].map(([k, v]) => [k, encodeValue(v)]), alarm: await this.ctx.storage.getAlarm() };
  }

  /**
   * Becomes `snap` (staging only: the front door allows it only with
   * SNAPSHOT_IMPORT, never on production): whoever has it open is
   * disconnected and the room closed first (it writes what it holds as it
   * closes), then its storage is emptied and the snapshot written in.
   */
  async importStorage(snap: DocSnapshot): Promise<void> {
    await this.closeForSnapshot();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const entries = Object.fromEntries(snap.entries.map(([k, e]) => [k, decodeValue(e)]));
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
    if (snap.alarm != null) await this.ctx.storage.setAlarm(snap.alarm);
  }

  /** Empties it (staging only: a document production no longer has). The directory row is already gone with the old database. */
  async wipeStorage(): Promise<void> {
    await this.closeForSnapshot();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private async closeForSnapshot(): Promise<void> {
    for (const socket of this.sockets) { try { socket.close(1012, "document replaced by a snapshot"); } catch { /* already closed */ } }
    this.sockets.clear();
    const opened = await this.open?.catch(() => null);
    this.open = null;
    this.opened = null;
    await opened?.close().catch(() => {});
  }

  async fetch(request: Request): Promise<Response> {
    // The dev server, bringing the files of a document on disk: before the room opens, which waits for them.
    if (new URL(request.url).pathname == "/api/mirror") return this.mirror(request);
    // What viewers see (pub/): in "manual" mode the published version's files; in "latest" the files as they are now, as doc/.
    const asked = new URL(request.url);
    if (asked.pathname.startsWith("/pub/")) {
      const served = await this.publishedFile(request, asked);
      if (served) return served;
      asked.pathname = "/doc/" + asked.pathname.slice("/pub/".length);
      request = new Request(asked, request);
    }
    // Someone viewing it: its files straight from storage while the room isn't open, without opening it.
    const stored = this.opened || this.open ? null : await this.storedFile(request);
    if (stored) return stored;
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

  /**
   * A GET of one of its files (/doc/...) while the room isn't open: from
   * storage, which holds the latest text then (the room writes every edit
   * there before it closes), so viewing a document never waits for its room
   * to open. Null for anything else (and for a document on disk, whose files
   * are the dev server's), which opens the room as before.
   */
  private async storedFile(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if ((request.method != "GET" && request.method != "HEAD") || !url.pathname.startsWith("/doc/") || request.headers.get("upgrade")) return null;
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!meta || meta.disk) return null;
    // doc/ itself is its page (front.ts's frame asks for it so, not knowing its name).
    const rel = url.pathname == "/doc/" ? meta.index : cleanRel(url.pathname.slice("/doc/".length));
    if (!rel) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const bytes = await this.ctx.storage.get<Uint8Array>(FILE + rel);
    if (!bytes) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const r = docFile(rel, bytes, request.headers.get("if-none-match"));
    return new Response(request.method == "HEAD" ? null : r.body, { status: r.status, headers: { "Content-Type": r.type, ...r.headers, "Server-Timing": 'doc;desc="stored"' } });
  }

  /**
   * A GET of one of the published version's files (pub/...), in "manual"
   * mode; null in "latest" mode (the caller serves the files as they are now),
   * which costs no more than reading the document's meta, kept in memory.
   */
  private async publishedFile(request: Request, url: URL): Promise<Response | null> {
    if (request.method != "GET" && request.method != "HEAD") return null;
    const n = await this.publishedNumber();
    const v = n != null ? await this.versions.get(n) : null;
    if (!v) return null;
    const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const raw = url.pathname.slice("/pub/".length);
    const rel = raw ? cleanRel(raw) : v.index;
    // A page by its address (blog for blog.html or blog/index.html), as doc/ does (host.ts): sent to its file, relatively.
    if (!rel || !(rel in v.files)) {
      const found = resolvePage((p) => p in v.files, raw, v.index);
      if (!found || found.file == rel) return notFound();
      let from = raw;
      try { from = decodeURIComponent(raw); } catch { /* resolvePage refused it already */ }
      return new Response(null, { status: 302, headers: { Location: relativeUrl(from, found.file), "Cache-Control": "no-store" } });
    }
    const bytes = await this.versions.file(v, rel);
    if (!bytes) return notFound();
    const r = docFile(rel, bytes, request.headers.get("if-none-match"));
    return new Response(request.method == "HEAD" ? null : r.body, { status: r.status, headers: { "Content-Type": r.type, ...r.headers, "Server-Timing": `doc;desc="version ${n}"` } });
  }

  /** The published version's number in "manual" mode; null in "latest". */
  private async publishedNumber(): Promise<number | null> {
    if (this.pub === undefined) this.pub = (await this.ctx.storage.get<Meta>(META))?.published?.n ?? null;
    return this.pub;
  }

  // ---------------------------------------------------------------- versions

  /**
   * An edit reached the room (a file's text, or another file, changed), by
   * `author`. When to cut a version, so that a burst of edits is one version:
   *
   * - edits pause for `idleMs` (30 seconds);
   * - a burst has gone on for `maxMs` (5 minutes) since its first edit;
   * - an agent's turn ends (the embedded agent's, or an external agent's
   *   calls, 8 seconds after its last), so an agent's turn is one version:
   *   while any agent works, the two rules above wait for it;
   * - the last person who may edit leaves (their room connection closes);
   * - before a publish, so what's published can be the latest edit;
   * - when the room opens, if what it holds isn't the latest version (edits
   *   made while timers couldn't run: the object was evicted).
   *
   * A cut that finds nothing changed since the latest version makes none.
   */
  private noteEdit(author: string | null): void {
    const p = this.pending;
    p.dirty = true;
    if (author) p.authors.add(author);
    if (!p.since) {
      p.since = Date.now();
      const burst = () => { p.max = this.agentWorking() ? setTimeout(burst, this.idleMs) : null; if (!p.max) void this.cutSoon("burst"); };
      p.max = setTimeout(burst, this.maxMs);
    }
    if (p.idle) clearTimeout(p.idle);
    const idle = () => { p.idle = this.agentWorking() ? setTimeout(idle, this.idleMs) : null; if (!p.idle) void this.cutSoon("idle"); };
    p.idle = setTimeout(idle, this.idleMs);
  }

  /** Whether any agent in the room is in the middle of a turn (its busy flag, on awareness). */
  private agentWorking(): boolean {
    const room = this.opened?.room;
    if (!room) return false;
    for (const state of room.awareness.getStates().values()) {
      const s = state as { busy?: boolean; user?: Author } | null;
      if (s?.busy && s.user?.kind == "agent") return true;
    }
    return false;
  }

  private clearPending(): { authors: string[]; dirty: boolean } {
    const p = this.pending;
    if (p.idle) clearTimeout(p.idle);
    if (p.max) clearTimeout(p.max);
    const out = { authors: [...p.authors], dirty: p.dirty };
    this.pending = { dirty: false, since: 0, authors: new Set(), idle: null, max: null };
    return out;
  }

  /** Cuts a version of what the document holds now (after any cut under way); the new version, or null if nothing changed. */
  private cutSoon(reason: string, as?: { authors: string[]; description: string }): Promise<StoredVersion | null> {
    const run = this.cutting.then(() => this.cutNow(reason, as));
    this.cutting = run.catch((e) => console.log(`couldn't cut a version (${reason}): ${e instanceof Error ? e.stack : e}`));
    return run;
  }

  private async cutNow(_reason: string, as?: { authors: string[]; description: string }): Promise<StoredVersion | null> {
    // Edits from in-process peers (agents) sync on microtasks: they've reached the room by the next macrotask.
    await new Promise((r) => setTimeout(r, 0));
    const opened = this.opened;
    const meta = await this.ctx.storage.get<Meta>(META);
    if (!opened || !meta) return null;
    const { authors } = this.clearPending();
    const r = await this.versions.cut(await opened.current(), meta.index, as?.authors ?? authors, as?.description ?? ((await this.versions.head()) == 0 ? "First version" : null), opened.room.folderPaths());
    if (!r) return null;
    opened.broadcast({ type: "versions" });
    if (!meta.published) this.firePublished(meta);
    if (r.previous && !as) this.ctx.waitUntil(this.describe(r.version, r.previous, meta).catch((e) => console.log(`couldn't describe version ${r.version.n}: ${e}`)));
    return r.version;
  }

  /** Writes a version's description in the background: the model's five words, or the fallback. Never in the way of editing. */
  private async describe(version: StoredVersion, previous: StoredVersion, meta: Meta): Promise<void> {
    const changes = await this.versions.changes(previous, version);
    const cfg = this.opened?.agent;
    const key = !meta.test && cfg && !("missing" in cfg) && cfg.model != "script" ? Redacted.value(cfg.apiKey) : "";
    const text = (key ? await describeChange(key, changes) : null) ?? fallbackDescription(changes);
    await this.versions.describe(version.n, text);
    this.opened?.broadcast({ type: "versions" });
  }

  private async publishedNow(meta: Meta): Promise<Published> {
    const latest = (await this.versions.latest())!;
    const v = meta.published ? await this.versions.get(meta.published.n) : null;
    return v ? { mode: "manual", version: publicVersion(v) } : { mode: "latest", version: publicVersion(latest) };
  }

  private firePublished(meta: Meta): void {
    const docId = this.idOf(meta);
    this.publishedNow(meta).then((published) => firePublished({ docId, published, files: async () => (await this.publishedFiles())?.files ?? new Map() }))
      .catch((e) => console.log(`couldn't tell of ${docId}'s published version: ${e}`));
    // If it's the homepage, its next deploy is scheduled (published.ts).
    this.ctx.waitUntil(directoryOf(this.env).homeId().then((home) => home == docId ? publishedChanged(this.env, docId) : undefined)
      .catch((e) => console.log(`couldn't schedule the homepage's deploy: ${e}`)));
  }

  /** Opens the document and waits for any cut under way (the first, when it opens, makes sure there is a version). */
  private async ready(): Promise<{ opened: Opened; meta: Meta } | null> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; return null; }
    await this.cutting;
    if ((await this.versions.head()) == 0) await this.cutSoon("first");
    const meta = await this.ctx.storage.get<Meta>(META);
    return meta ? { opened, meta } : null;
  }

  /** Its versions, newest first (`limit`, before version `before`), the current one and the published one. Null if there's no such document. */
  async versionsState(opts: { before?: string | number | null; limit?: number } = {}): Promise<VersionsState | null> {
    const r = await this.ready();
    if (!r) return null;
    const before = opts.before != null ? versionNumber(opts.before) : null;
    const { versions, total } = await this.versions.list({ before, limit: opts.limit });
    const latest = (await this.versions.latest())!;
    return { current: publicVersion(latest), published: await this.publishedNow(r.meta), versions: versions.map(publicVersion), total, pending: this.pending.dirty };
  }

  /** One version (by id or number), with its files' paths; null if there's none. */
  async version(ref: string | number): Promise<(Version & { files: string[]; index: string }) | null> {
    const n = versionNumber(ref);
    if (!(await this.ready()) || n == null) return null;
    const v = await this.versions.get(n);
    return v && { ...publicVersion(v), index: v.index, files: Object.keys(v.files) };
  }

  /** One file of a version; null if there's no such version or file. */
  async versionFile(ref: string | number, path: string): Promise<Uint8Array | null> {
    const n = versionNumber(ref);
    if (!(await this.ready()) || n == null) return null;
    const v = await this.versions.get(n);
    return v ? this.versions.file(v, path) : null;
  }

  /**
   * Sets what viewers see (the front door has checked the person may edit):
   * "latest", the document as it is, up to the keystroke, or "manual", one
   * version (by default the current one). Edits not yet in a version become
   * one first. Every open tab hears of it ({ type: "versions" }).
   */
  async setPublished(req: PublishRequest): Promise<PublishResult> {
    const r = await this.ready();
    if (!r) return { ok: false, status: 404, error: "There's no such document." };
    if (req?.mode != "latest" && req?.mode != "manual") return { ok: false, status: 400, error: 'Send {"mode": "latest"} or {"mode": "manual", "versionId": "v3"}.' };
    // Edits not yet in a version become one: publishing the current version means up to the keystroke.
    const before = await this.versions.head();
    await this.cutSoon("publish");
    const meta = (await this.ctx.storage.get<Meta>(META))!;
    if (req.mode == "latest") delete meta.published;
    else {
      const head = await this.versions.head();
      const asked = req.versionId == null ? head : versionNumber(req.versionId);
      // The version that was current when the person asked is the current state, now cut.
      const n = asked == before ? head : asked;
      if (n == null || n > head || !(await this.versions.get(n))) return { ok: false, status: 404, error: `There's no version ${req.versionId} of this document: its versions are v1 to v${head}.` };
      meta.published = { n };
    }
    await this.ctx.storage.put(META, meta);
    this.pub = meta.published?.n ?? null;
    r.opened.broadcast({ type: "versions" });
    this.firePublished(meta);
    return { ok: true, published: await this.publishedNow(meta) };
  }

  /**
   * Brings a version back: its files are written over the document as it
   * is now (every file: those it didn't have are deleted), as an edit open
   * editors see live, and that becomes a new version, the current one, by
   * `by`, "Restored version <n>". With `path`, only that file comes back
   * ("Restored <path> from version <n>"); the other files stay as they are.
   * Edits not yet in a version become one first, so nothing is lost. In
   * "latest" mode viewers then see it; in "manual" mode what's published stays.
   */
  async restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult> {
    const r = await this.ready();
    if (!r) return { ok: false, status: 404, error: "There's no such document." };
    const n = versionNumber(ref);
    const v = n != null ? await this.versions.get(n) : null;
    if (!v) return { ok: false, status: 404, error: `There's no version ${ref} of this document: its versions are v1 to v${await this.versions.head()}.` };
    if (path != null) {
      path = path.replace(/^\.?\/+/, "");
      if (!(path in v.files)) return { ok: false, status: 404, error: `Version ${v.n} has no file ${path}: its files are ${Object.keys(v.files).sort().join(", ")}.` };
    }
    await this.cutSoon("restore");
    const files = await this.versions.files(v);
    if (path != null) {
      const out = await this.publish({ [path]: files.get(path)! }, []);
      if (out.refused.length) return { ok: false, status: 409, error: `Couldn't restore ${path}: ${out.refused[0].why}.` };
      const made = await this.cutSoon("restored", { authors: [by], description: `Restored ${path} from version ${v.n}` });
      return { ok: true, current: publicVersion(made ?? (await this.versions.latest())!), from: v.id, files: [path] };
    }
    const room = r.opened.room;
    // Folders it didn't have go (unless something of it is inside); then its files over the current ones; then its folders.
    const keep = [...files.keys(), ...(v.folders ?? [])];
    for (const d of room.folderPaths()) if (!keep.some((p) => p == d || p.startsWith(`${d}/`)) && room.exists(d) == "folder") await Effect.runPromise(room.remove(d)).catch(() => {});
    const now = new Set((await r.opened.current()).keys());
    const out = await this.publish(Object.fromEntries(files), [...now].filter((p) => !files.has(p)));
    for (const d of v.folders ?? []) if (room.exists(d) != "folder") await Effect.runPromise(room.mkdir(d)).catch(() => {});
    if (out.refused.length) console.log(`restoring ${v.id}: ${out.refused.map((x) => `${x.path} (${x.why})`).join(", ")}`);
    const made = await this.cutSoon("restored", { authors: [by], description: `Restored version ${v.n}` });
    return { ok: true, current: publicVersion(made ?? (await this.versions.latest())!), from: v.id, files: [...files.keys()].sort() };
  }

  /**
   * The files viewers see, and which version that is: the published
   * version's in "manual" mode; in "latest" mode the document as it is now
   * (up to the keystroke), with the current version. For the homepage's
   * deploy (versions.ts, publishedFiles).
   */
  async publishedFiles(): Promise<{ published: Published; index: string; files: Map<string, Uint8Array> } | null> {
    const r = await this.ready();
    if (!r) return null;
    const published = await this.publishedNow(r.meta);
    const v = r.meta.published ? await this.versions.get(r.meta.published.n) : null;
    return v ? { published, index: v.index, files: await this.versions.files(v) } : { published, index: r.meta.index, files: await r.opened.current() };
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
      // Moving, deleting and folders are edits too: the document stays, and its row says when.
      writeBytes: (path, bytes) => Effect.tryPromise({ try: async () => { await storage.put(FILE + path, bytes); await this.touch(); }, catch: storeError }),
      remove: (path) => Effect.tryPromise({ try: async () => { if (await storage.delete(FILE + path)) await this.touch(); }, catch: storeError }),
      folders: Effect.tryPromise({ try: async () => [...(await storage.list({ prefix: DIR })).keys()].map((k) => k.slice(DIR.length)), catch: storeError }),
      mkdir: (path) => Effect.tryPromise({
        try: async () => {
          const all = path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
          for (const d of all) await storage.put(DIR + d, true);
          await this.touch();
        },
        catch: storeError,
      }),
      rmdir: (path) => Effect.tryPromise({
        try: async () => {
          const keys = [...(await storage.list({ prefix: FILE + path + "/" })).keys(), ...(await storage.list({ prefix: DIR + path + "/" })).keys(), DIR + path];
          await storage.delete(keys.slice(0, 128));
          for (let i = 128; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
          await this.touch();
        },
        catch: storeError,
      }),
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
      : await Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(await withKeys(this.env))));
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
      // Sharing this document (or another), and for an admin the server's settings and users, as the person.
      serverTools: (person) => agentToolsFor({ dir: directoryOf(this.env), who: { login: person.id, test: person.id.startsWith("test-") }, here: this.idOf(meta) }),
      // An agent's turn is one version, and where its next diff_versions starts from ("last_turn").
      turnEnded: () => this.cutSoon("agent turn").then(async (v) => (v ?? (await this.versions.latest()))?.id ?? null),
      versions: {
        state: (opts) => this.versionsState(opts).then((s) => s!),
        version: (ref) => this.version(ref),
        file: (ref, path) => this.versionFile(ref, path),
        files: async (ref) => {
          const n = versionNumber(ref);
          const v = n != null && (await this.ready()) ? await this.versions.get(n) : null;
          return v ? this.versions.files(v) : null;
        },
        current: async () => (await this.ready())?.opened.current() ?? new Map(),
        publish: (req) => this.setPublished(req),
        restore: (ref, by, path) => this.restore(ref, by, path),
      },
      // A new page in its file tree starts as a new document does.
      newPage: TEMPLATE ? (path) => (path.endsWith(".md") ? plainMarkdown : TEMPLATE) : undefined,
    });
    // Every edit to the files, and who made it: a version is cut once a burst of them ends (noteEdit).
    room.doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (!touchesFiles(room.doc, tr)) return;
      const a = authorOf(room.doc, tr);
      this.noteEdit(a ? (a.kind == "agent" ? agentName(a.user) : a.kind == "disk" ? (meta.disk ? "on disk" : "files published") : a.user) : null);
    });
    const naming = namingFor(directoryOf(this.env), this.idOf(meta), () => titleOf(room.text(meta.index) ?? "", meta.index));

    const opened: Opened = {
      agent,
      broadcast: host.broadcast,
      // Every file as it is now: text from the room (the latest keystroke), the rest from storage.
      current: async () => {
        const out = new Map<string, Uint8Array>();
        const encoder = new TextEncoder();
        for (const path of new Set([...texts(room.doc).keys(), ...assets(room.doc).keys()])) {
          const text = room.text(path);
          const bytes = text != null ? encoder.encode(text) : await Effect.runPromise(Effect.orElseSucceed(files.read(path), () => null));
          if (bytes) out.set(path, bytes);
        }
        return out;
      },
      handler: host.handler,
      renamed: host.renamed,
      notify: host.notify,
      roomSocket: (url, readOnly) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        this.track(server);
        // Binary frames as ArrayBuffers: with this compatibility date they'd otherwise arrive as Blobs.
        server.binaryType = "arraybuffer";
        const send = (m: Uint8Array) => { try { server.send(m); } catch { /* already closed */ } };
        const conn = room.connect(send, { epoch: url.searchParams.get("epoch"), readOnly });
        // When the last person who may edit leaves, what they did is a version.
        if (conn && !readOnly) {
          this.editing++;
          let gone = false;
          const left = () => { if (gone) return; gone = true; if (--this.editing == 0) void this.cutSoon("left"); };
          server.addEventListener("close", left);
          server.addEventListener("error", left);
        }
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
        await Effect.runPromise(room.syncFolders).catch(() => {});
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)).then(host.dispose),
    };
    this.opened = opened;
    // A version of what it holds, if that isn't the latest one (or there's none yet).
    void this.cutSoon("open");
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
  /** The agent's settings: its key also writes versions' descriptions. */
  agent: AgentConfig | { missing: string };
  /** Tells every open tab, whoever's. */
  broadcast: (msg: unknown) => void;
  /** Every file the document holds as it is now. */
  current: () => Promise<Map<string, Uint8Array>>;
  handler: (request: Request) => Promise<Response>;
  roomSocket: (url: URL, readOnly: boolean) => Response;
  eventSocket: (person: Person) => Response;
  room: Room;
  catchUp: () => Promise<void>;
  /** Tells every open tab the document's new title and address. */
  renamed: (name: DocName) => void;
  /** A message for every open tab. */
  notify: (msg: unknown) => void;
  close: () => Promise<void>;
}

/** Durable Object storage as versions.ts's KV. */
function kvOf(storage: DurableObjectStorage): KV {
  return {
    get: ((k: string | string[]) => storage.get(k as string)) as KV["get"],
    put: (entries) => storage.put(entries),
  };
}

/** Whether a transaction changed a file: a text's content, or the list of files or other files (images). */
function touchesFiles(doc: Y.Doc, tr: Y.Transaction): boolean {
  const fileMap = texts(doc) as Y.AbstractType<any>, assetMap = assets(doc) as Y.AbstractType<any>, folderMap = folders(doc) as Y.AbstractType<any>;
  for (const type of tr.changed.keys()) {
    if (type === fileMap || type === assetMap || type === folderMap) return true;
    if (type._item?.parent === fileMap) return true;
  }
  return false;
}

/** A new Markdown page (a document whose page is index.md). */
const plainMarkdown = "# Untitled\n\nStart writing here.\n";

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
