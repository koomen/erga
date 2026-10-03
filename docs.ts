// The documents on this machine: the local host's counterpart of erga.dev's
// Durable Objects (worker/doc-host.ts, worker/doc-list.ts), behind the same
// front door (front.ts). Each document is a folder in the data directory
// (~/.erga unless --data or ERGA_DATA_DIR says otherwise):
//
//   docs/<owner>/<id>/meta.json   what it is: its page, who made it, when it was made, last edited, and goes if nobody edits it
//   docs/<owner>/<id>/files/      its files, as ordinary files (change them with anything: the room merges it)
//   docs/<owner>/<id>/state.yjs   the room's Yjs state, so a restarted host keeps the history
//
// A document opened from disk (`bun start ./notes`) has no files/ of its
// own: its meta.json names the folder, which the room edits in place. Its
// id comes from its path, so the same folder opens at the same address
// every time. It never goes for being unedited, and deleting it from /docs
// only forgets it: the folder stays as it is.
//
// As a Durable Object does, a document opens on its first request (its
// room, room.ts; its host, host.ts; and a watcher that merges edits made to
// its files by anything else) and stays open while the host runs.
//
// The directory (directory.ts: addresses, titles, members, what /docs
// lists) is a SQLite file beside them, erga.db (directory-sqlite.ts). Each
// document keeps its row up to date as erga.dev's do; a folder without a
// row (one from before the directory) gets one when the host starts. A
// document opened from disk is its owner's, never expires, and its slug is
// its folder's name (or its file's, for a single file), not its title.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { HttpServerRequest } from "effect/http";
import type { AgentConfig } from "./agent";
import { DIRECTORY_EVERY_MS, nameOf, namingFor, throttle, UNTITLED, type Directory, type DocRow, type Route } from "./directory";
import { afterUnedited, ALPHABET, titleOf, UNEDITED_HOURS, type Listed } from "./front";
import { ignored, makeHost } from "./host";
import { FileStore, Room, StateStore, StoreError } from "./room";

/** What a document is (meta.json). `path`: opened from disk, the folder it lives in. */
interface Meta { id: string; owner: string; index: string; created: number; modified?: number; expires?: number; path?: string }

/** An open document: its room and host, and the sockets on it. */
export interface Opened {
  readonly room: Room;
  readonly host: ReturnType<typeof makeHost>;
  /** A socket joins (`close` hangs it up if the document is deleted); returns the leave function. */
  track(close: () => void): () => void;
}

export interface LocalDocsOptions {
  readonly directory: Directory;
  readonly agent: AgentConfig | { readonly missing: string };
  /** Who a request is from (host.ts). */
  readonly personOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string };
  readonly writeDelay?: number;
  readonly log: (line: string) => void;
}

export class LocalDocs {
  private opened = new Map<string, Promise<(Opened & { close(): Promise<void> }) | null>>();
  /** Each open document's sockets, by how to hang each up: someone has it open while there are any. */
  private sockets = new Map<string, Set<() => void>>();
  private alarms = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each document's throttled update of its row in the directory. */
  private syncs = new Map<string, () => void>();

  constructor(readonly root: string, private opts: LocalDocsOptions) {}
  private get directory() { return this.opts.directory; }

  private dir(owner: string, id: string) { return join(this.root, "docs", owner.toLowerCase(), id); }
  private key(owner: string, id: string) { return `${owner.toLowerCase()}/${id}`; }
  /** Where a document's files are. */
  private folder(meta: Meta) { return meta.path ?? join(this.dir(meta.owner, meta.id), "files"); }

  private async meta(owner: string, id: string): Promise<Meta | null> {
    try { return JSON.parse(await readFile(join(this.dir(owner, id), "meta.json"), "utf8")) as Meta; } catch { return null; }
  }
  private saveMeta(meta: Meta) {
    return writeAtomic(join(this.dir(meta.owner, meta.id), "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  }

  /**
   * Creates the document, whose row is already in the directory, from a
   * template's files; false if it already exists. Unless someone edits it,
   * it's deleted at `expires`.
   */
  async create(owner: string, id: string, files: Record<string, string>, index: string, opts: { expires: number | null }): Promise<boolean> {
    if (await this.meta(owner, id)) return false;
    for (const [path, text] of Object.entries(files)) await writeAtomic(join(this.dir(owner, id), "files", path), text);
    const meta: Meta = { id, owner: owner.toLowerCase(), index, created: Date.now(), ...(opts.expires != null ? { expires: opts.expires } : {}) };
    await this.saveMeta(meta);
    this.schedule(meta);
    return true;
  }

  /**
   * A folder on disk as one of `owner`'s documents, its page at `index`
   * inside it: its row in the directory (made the first time; a rename since
   * is kept).
   */
  async link(owner: string, folder: string, index: string): Promise<DocRow> {
    const hash = createHash("sha1").update(join(folder, index)).digest();
    const id = Array.from(hash.subarray(0, 8), (b) => ALPHABET[b % ALPHABET.length]).join("");
    let meta = await this.meta(owner, id);
    if (!meta || meta.path != folder || meta.index != index) await this.saveMeta(meta = { id, owner: owner.toLowerCase(), index, created: Date.now(), path: folder });
    return this.register(meta);
  }

  /**
   * Puts a document in the directory if it isn't there yet, as it is now:
   * its row. One opened from disk is named after its folder (or its file, if
   * it's a single file) rather than following its title.
   */
  private async register(meta: Meta): Promise<DocRow> {
    const text = await readFile(join(this.folder(meta), meta.index), "utf8").catch(() => null);
    const disk = meta.path ? (/^index\.(html?|md)$/i.test(basename(meta.index)) ? basename(meta.path) : basename(meta.index).replace(/\.[^.]+$/, "")) : null;
    const { doc } = await this.directory.add({
      id: meta.id, owner: meta.owner, title: (text && titleOf(text, meta.index)) || UNTITLED,
      ...(disk != null ? { slug: disk, slugSet: true } : {}),
      // Its folder, docs/<owner>/<id>, is how this host finds it; the name is the Durable Object's on erga.dev.
      doName: `${meta.owner.toLowerCase()}/${meta.id}`,
      created: meta.created, modified: meta.modified ?? null,
      expires: meta.path || meta.modified ? null : meta.expires ?? null,
    });
    return doc;
  }

  /** A document from before the directory, at /<owner>/<id>, put in it now; null if there's none. */
  async adopt(owner: string, id: string): Promise<DocRow | null> {
    const meta = await this.meta(owner, id);
    return meta ? this.register(meta) : null;
  }

  async exists(owner: string, id: string): Promise<boolean> {
    const meta = await this.meta(owner, id);
    return !!meta && (await stat(this.folder(meta)).then((s) => s.isDirectory(), () => false));
  }

  /** Deletes the document (one opened from disk is only forgotten): everyone on it is disconnected. */
  async delete(owner: string, id: string): Promise<boolean> {
    const meta = await this.meta(owner, id);
    if (!meta) return false;
    await this.destroy(meta);
    return true;
  }

  private async destroy(meta: Meta): Promise<void> {
    const key = this.key(meta.owner, meta.id);
    for (const close of this.sockets.get(key) ?? []) close();
    this.sockets.delete(key);
    // The room writes what it holds as it closes, so it closes before the folder goes.
    const opened = await this.opened.get(key);
    this.opened.delete(key);
    await opened?.close();
    clearTimeout(this.alarms.get(key));
    this.alarms.delete(key);
    await rm(this.dir(meta.owner, meta.id), { recursive: true, force: true });
    await this.directory.remove(meta.id);
  }

  /** `owner`'s documents, most recently edited first (from the directory; where each one opened from disk lives, from its meta). */
  async list(owner: string): Promise<Listed[]> {
    const docs: Listed[] = [];
    for (const d of await this.directory.list(owner)) {
      const meta = await this.meta(d.owner, d.id);
      docs.push({
        id: d.id, owner: d.owner, slug: d.slug, title: d.title, titleSet: d.titleSet, slugSet: d.slugSet,
        created: d.created, modified: d.modified ?? d.created,
        ...(meta?.path ? { path: meta.path.replace(homedir(), "~") } : d.modified == null && d.expires != null ? { expires: d.expires } : {}),
      });
    }
    return docs;
  }

  /** Hands a request (its path the one inside the document) to the document's host. */
  async fetch(owner: string, id: string, request: Request): Promise<Response> {
    const opened = await this.open(owner, id);
    return opened ? opened.host.handler(request) : new Response("No such document", { status: 404 });
  }

  /** The document, opened if it isn't yet; null if there's no such document. */
  open(owner: string, id: string): Promise<Opened | null> {
    const key = this.key(owner, id);
    let opened = this.opened.get(key);
    if (!opened) {
      opened = this.load(owner, id).catch((e) => { this.opts.log(`  couldn't open ${key}: ${(e as Error).message}`); return null; });
      this.opened.set(key, opened);
      opened.then((o) => { if (!o && this.opened.get(key) == opened) this.opened.delete(key); });
    }
    return opened;
  }

  /** Opens the room on the document's files, for as long as the host runs (or until it's deleted). */
  private async load(owner: string, id: string): Promise<(Opened & { close(): Promise<void> }) | null> {
    const meta = await this.meta(owner, id);
    if (!meta) return null;
    const folder = this.folder(meta);
    if (!(await stat(folder).then((s) => s.isDirectory(), () => false))) return null;
    const key = this.key(owner, id);
    const storeError = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });
    const read = (file: string) => readFile(file).then((b) => new Uint8Array(b), () => null);
    // The folder as a FileStore (room.ts): what the room loads, writes back
    // and re-reads when the watcher sees a change.
    const files = FileStore.of({
      list: Effect.tryPromise({ try: () => listFiles(folder), catch: storeError }),
      read: (path) => Effect.promise(() => read(join(folder, path))),
      write: (path, text) => Effect.tryPromise({ try: () => this.edited(meta, folder, path, text), catch: storeError }),
    });
    const stateFile = join(this.dir(owner, id), "state.yjs");
    const state = StateStore.of({
      load: Effect.promise(() => read(stateFile)),
      save: (bytes) => Effect.tryPromise({ try: () => writeAtomic(stateFile, bytes), catch: storeError }),
    });
    const scope = Effect.runSync(Scope.make());
    const room = await Effect.runPromise(Room.make({ log: this.opts.log, writeDelay: this.opts.writeDelay }).pipe(
      Effect.provideService(FileStore, files),
      Effect.provideService(StateStore, state),
      Scope.provide(scope),
    ));
    const host = makeHost({
      room, files, agent: this.opts.agent,
      doc: { name: basename(meta.index), path: meta.index, kind: meta.index.endsWith(".md") ? "md" : "html", dir: folder },
      personOf: this.opts.personOf,
      baseUrl: (req) => req.headers["x-erga-base"] ?? `http://${req.headers["host"]}/d/${id}`,
      naming: (person) => naming({ login: person.id }),
    });
    const naming = namingFor(this.directory, id, () => titleOf(room.text(meta.index) ?? "", meta.index));
    const watcher = this.watch(folder, room);
    return {
      room, host,
      track: (close) => {
        const mine = this.sockets.get(key) ?? new Set();
        this.sockets.set(key, mine);
        mine.add(close);
        return () => { mine.delete(close); };
      },
      close: async () => {
        watcher.close();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await host.dispose();
      },
    };
  }

  /**
   * As on erga.dev: the room writes a file only when its text changed (its
   * own seeding and people merely looking never do), so a write that changes
   * what's on disk is an edit, by a person, an agent or a publish.
   */
  private async edited(meta: Meta, folder: string, path: string, text: string): Promise<void> {
    const file = join(folder, path);
    const before = await readFile(file, "utf8").catch(() => null);
    await writeAtomic(file, text);
    if (before == text) return;
    const now = await this.meta(meta.owner, meta.id);
    if (!now) return;
    now.modified = Date.now();
    delete now.expires;
    await this.saveMeta(now);
    const key = this.key(now.owner, now.id);
    clearTimeout(this.alarms.get(key));
    // Its row: at most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    let sync = this.syncs.get(key);
    if (!sync) this.syncs.set(key, sync = throttle(() => this.syncDirectory(now.owner, now.id).catch((e) => this.opts.log(`  couldn't update ${key}'s row: ${(e as Error).message}`)), DIRECTORY_EVERY_MS));
    sync();
  }

  /**
   * Brings a document's row up to date after edits: when it was last edited,
   * and the title, which follows its first heading until someone sets it
   * (and the slug the title). Every open tab hears of a new title or address.
   */
  private async syncDirectory(owner: string, id: string): Promise<void> {
    const meta = await this.meta(owner, id);
    if (!meta) return;
    const text = await readFile(join(this.folder(meta), meta.index), "utf8").catch(() => null);
    const r = await this.directory.edited(id, { modified: meta.modified ?? null, pageTitle: text == null ? null : titleOf(text, meta.index) });
    if (r?.renamed) (await this.opened.get(this.key(owner, id)))?.host.renamed(nameOf(r.doc));
  }

  /** Every change in the folder, subfolders included, goes to the room: it merges text edits it didn't make and notes changed assets. */
  private watch(folder: string, room: Room): FSWatcher {
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const take = () => {
      timer = undefined;
      for (const rel of changed) {
        Effect.runPromise(room.fileChanged(rel)).catch((e) => this.opts.log(`  could not read ${rel}: ${(e as Error).message}`));
      }
      changed.clear();
    };
    const watcher = watch(folder, { recursive: true }, (_, name) => {
      const rel = name?.toString().split(sep).join("/");
      if (!rel || ignored(rel)) return;
      changed.add(rel);
      timer ??= setTimeout(take, 60);
    });
    watcher.on("error", (e) => this.opts.log(`  stopped watching ${folder}: ${e.message}`));
    return watcher;
  }

  /**
   * Puts every document in the directory that isn't there yet (folders from
   * before it), and starts the clock on every one nobody has edited yet (one
   * whose time is up goes now).
   */
  async start(): Promise<void> {
    const root = join(this.root, "docs");
    for (const owner of await readdir(root).catch(() => [] as string[])) {
      for (const id of await readdir(join(root, owner)).catch(() => [] as string[])) {
        const meta = await this.meta(owner, id);
        if (!meta) continue;
        await this.register(meta).catch((e) => this.opts.log(`  couldn't put ${owner}/${id} in the directory: ${(e as Error).message}`));
        this.schedule(meta);
      }
    }
  }

  /** The alarm for when a document goes if nobody edits it (none opened from disk). */
  private schedule(meta: Meta): void {
    const key = this.key(meta.owner, meta.id);
    clearTimeout(this.alarms.get(key));
    if (meta.path || meta.modified || meta.expires == null) return;
    // setTimeout's longest wait is about 24 days; an alarm that's early sets itself again.
    this.alarms.set(key, setTimeout(() => this.alarm(meta.owner, meta.id), Math.min(Math.max(0, meta.expires - Date.now()), 2 ** 31 - 1)));
  }

  private async alarm(owner: string, id: string): Promise<void> {
    this.alarms.delete(this.key(owner, id));
    const meta = await this.meta(owner, id);
    if (!meta || meta.path || meta.expires == null) return;
    if (meta.expires > Date.now()) return this.schedule(meta);
    const next = afterUnedited(meta, (this.sockets.get(this.key(owner, id))?.size ?? 0) > 0, Date.now());
    if (next == "keep") return;
    if (next != "delete") {
      meta.expires = next;
      await this.saveMeta(meta);
      await this.directory.setExpires(id, next);
      return this.schedule(meta);
    }
    this.opts.log(`  deleting ${owner}/${id}: not edited in ${UNEDITED_HOURS} hours`);
    await this.destroy(meta);
  }

  /** Closes every open document (each room writes what it hasn't yet). */
  async close(): Promise<void> {
    for (const alarm of this.alarms.values()) clearTimeout(alarm);
    await Promise.all([...this.opened.values()].map(async (opened) => (await opened)?.close()));
  }
}

/** Every file in a folder, relative and "/"-separated, skipping what the host never serves (dotfiles, node_modules). */
async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (ignored(path)) continue;
    if (e.isDirectory()) out.push(...(await listFiles(root, path)));
    else if (e.isFile() || (e.isSymbolicLink() && (await stat(join(root, path)).then((s) => s.isFile(), () => false)))) out.push(path);
  }
  return out;
}

let writes = 0;
/** Writes a file whole or not at all (a temporary dotfile renamed over it), making its folder if need be. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.erga-${process.pid}-${++writes}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, file);
}
