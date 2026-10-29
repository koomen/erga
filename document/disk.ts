// A document's files on disk, in local development: the folder (or single
// file) the dev server linked it to, reached over the document's /api/mirror
// WebSocket (dev/vite-plugin.ts is the other end). As a Storage (document/storage.ts)
// it is the document's storage with its files and folders on the folder and
// everything else (its record, the room's state, its versions) in the storage
// it wraps: the document reads and writes its files as it does anywhere, and
// merges each change made on disk (the dev server says which) against the
// version it last wrote or read there. Deleting the document leaves the files.
//
// Until the dev server connects, a call waits for it (a while); while it's
// away, calls fail and the room tries them again.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { KEYS, type Storage } from "./storage.ts";

// What goes over the WebSocket, between the document and the dev server, which has
// the files. The document asks for them as its room would ask a folder:
// list, read and write (and the tree's: remove, folders, mkdir, rmdir), each answered by a reply with the same id. The dev
// server says when a file changed on disk, so the room merges it in; and
// asks the room to write what it holds when it's about to stop.

export type ToDisk =
  | { t: "list"; id: number }
  | { t: "read"; id: number; path: string }
  /** `text`, or `b64` for a file that isn't text (one moved elsewhere). */
  | { t: "write"; id: number; path: string; text?: string; b64?: string }
  | { t: "remove"; id: number; path: string }
  /** Every folder (`dirs` in the reply), empty ones included. */
  | { t: "folders"; id: number }
  | { t: "mkdir"; id: number; path: string }
  /** A folder and whatever is still in it. */
  | { t: "rmdir"; id: number; path: string }
  | { t: "flushed" };

export type FromDisk =
  /** `paths` for a list; `b64` for a read (null: there's no such file); `error` if it failed. */
  | { t: "reply"; id: number; paths?: string[]; dirs?: string[]; b64?: string | null; error?: string }
  | { t: "changed"; path: string }
  | { t: "flush" };

/** What the dev server says, as the link reads it: anything else on the socket is left alone. */
const Reply = Schema.Struct({
  t: Schema.Literal("reply"),
  id: Schema.Number,
  paths: Schema.optional(Schema.Array(Schema.String)),
  dirs: Schema.optional(Schema.Array(Schema.String)),
  b64: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.String),
});
const Changed = Schema.Struct({ t: Schema.Literal("changed"), path: Schema.String });
const Flush = Schema.Struct({ t: Schema.Literal("flush") });
const FromDiskJson = Schema.fromJsonString(Schema.Union([Reply, Changed, Flush]));
const readFromDisk = Schema.decodeUnknownOption(FromDiskJson);

/** The files on disk can't be reached (the dev server isn't connected, or went away), or the dev server failed the ask. */
export class DiskError extends Schema.TaggedError<DiskError>()("DiskError", { message: Schema.String }) {}

type Ask = { t: "list" } | { t: "read"; path: string } | { t: "write"; path: string; text?: string; b64?: string }
  | { t: "remove"; path: string } | { t: "folders" } | { t: "mkdir"; path: string } | { t: "rmdir"; path: string };
type Reply = Extract<FromDisk, { t: "reply" }>;

/** The dev server's socket to a document's files, and what it says. */
export class DiskLink {
  private socket: WebSocket | null = null;
  private waiting: ((socket: WebSocket) => void)[] = [];
  private calls = new Map<number, Deferred.Deferred<Reply, DiskError>>();
  private ids = 0;

  constructor(private on: {
    /** A file changed on disk. */
    changed(path: string): void;
    /** The dev server connected (again): anything may have changed meanwhile. */
    connected(): void;
    /** The dev server is about to stop: write everything now. */
    flush(): Promise<void>;
  }) {}

  /** The dev server's socket (a new one replaces an old one). */
  accept(socket: WebSocket): void {
    if (this.socket) { try { this.socket.close(4000, "replaced"); } catch { /* already closed */ } }
    this.socket = socket;
    socket.addEventListener("message", (e) => {
      const m = Option.getOrNull(readFromDisk(String(e.data))) as FromDisk | null;
      if (m?.t == "reply") {
        const call = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (call) Deferred.doneUnsafe(call, Effect.succeed(m));
      } else if (m?.t == "changed") this.on.changed(m.path);
      else if (m?.t == "flush") this.on.flush().finally(() => this.send({ t: "flushed" }));
    });
    const gone = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const call of this.calls.values())
        Deferred.doneUnsafe(call, Effect.fail(new DiskError({ message: "the dev server went away" })));
      this.calls.clear();
    };
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
    for (const resume of this.waiting.splice(0)) resume(socket);
    this.on.connected();
  }

  /** The document's storage with its files on disk: only `only` of them, for a single file linked on its own. */
  storage(inner: Storage, only: string | null): Storage {
    return new DiskStorage(inner, this, only);
  }

  /** @internal An ask to the dev server, and its reply. */
  ask(ask: Ask): Effect.Effect<Reply, DiskError> {
    const self = this;
    return Effect.gen(function* () {
      const socket = self.socket ?? (yield* self.connection);
      const id = ++self.ids;
      const reply = yield* Deferred.make<Reply, DiskError>();
      self.calls.set(id, reply);
      const sent = Result.try(() => socket.send(JSON.stringify({ ...ask, id } as ToDisk)));
      if (Result.isFailure(sent)) {
        self.calls.delete(id);
        return yield* new DiskError({ message: sent.failure instanceof Error ? sent.failure.message : String(sent.failure) });
      }
      const got = yield* Deferred.await(reply);
      if (got.error) return yield* new DiskError({ message: got.error });
      return got;
    });
  }

  /** The socket, once the dev server connects (it does so as it starts); an error if it doesn't soon. */
  private get connection(): Effect.Effect<WebSocket, DiskError> {
    let resume: ((socket: WebSocket) => void) | null = null;
    return Effect.callback<WebSocket>((done) => {
      resume = (socket) => done(Effect.succeed(socket));
      this.waiting.push(resume);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => {
          this.waiting = this.waiting.filter((w) => w !== resume);
          return Effect.fail(new DiskError({ message: "the files on disk aren't connected: is the dev server running?" }));
        },
      })
    );
  }

  private send(m: ToDisk): void {
    try { this.socket?.send(JSON.stringify(m)); } catch { /* gone */ }
  }
}

const { file: FILE, dir: DIR } = KEYS;
const onDisk = (key: string) => key.startsWith(FILE) || key.startsWith(DIR);

/**
 * The Storage: `files/<path>` and `folders/<path>` on the folder, through the
 * link; every other key in `inner`. A single file (`only`) is the one file
 * there: another path written beside it stays in the room, never on disk.
 */
class DiskStorage implements Storage {
  constructor(private inner: Storage, private link: DiskLink, private only: string | null) {}

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      const own = key.filter((k) => !onDisk(k));
      if (own.length) for (const [k, v] of await this.inner.get<T>(own)) out.set(k, v);
      for (const k of key) if (onDisk(k)) { const v = await this.read<T>(k); if (v !== undefined) out.set(k, v); }
      return out;
    }
    return onDisk(key) ? this.read<T>(key) : this.inner.get<T>(key);
  }
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key == "string") return onDisk(key) ? this.write(key, value) : this.inner.put(key, value);
    const own = Object.fromEntries(Object.entries(key).filter(([k]) => !onDisk(k)));
    if (Object.keys(own).length) await this.inner.put(own);
    for (const [k, v] of Object.entries(key)) if (onDisk(k)) await this.write(k, v);
  }
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let n = 0;
      const own = key.filter((k) => !onDisk(k));
      if (own.length) n += await this.inner.delete(own);
      for (const k of key) if (onDisk(k) && await this.remove(k)) n++;
      return n;
    }
    return onDisk(key) ? this.remove(key) : this.inner.delete(key);
  }
  async list<T = unknown>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    const entries: [string, T][] = [];
    if (!onDisk(prefix)) entries.push(...(await this.inner.list<T>({ prefix })).entries());
    if (FILE.startsWith(prefix) || prefix.startsWith(FILE)) {
      const paths = (await this.paths()).filter((p) => (FILE + p).startsWith(prefix)).sort();
      entries.push(...(await Promise.all(paths.map(async (p) => [FILE + p, (await this.read<T>(FILE + p))!] as [string, T]))).filter(([, v]) => v !== undefined));
    }
    if (DIR.startsWith(prefix) || prefix.startsWith(DIR)) {
      for (const d of (await this.folders()).filter((d) => (DIR + d).startsWith(prefix)).sort()) entries.push([DIR + d, true as T]);
    }
    const out = new Map<string, T>();
    for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (options.startAfter != null && k <= options.startAfter) continue;
      if (options.limit != null && out.size >= options.limit) break;
      out.set(k, v);
    }
    return out;
  }
  /** The document's own entries go; its files on disk stay. */
  deleteAll(): Promise<void> { return this.inner.deleteAll(); }
  getAlarm(): Promise<number | null> { return this.inner.getAlarm(); }
  setAlarm(at: number): Promise<void> { return this.inner.setAlarm(at); }
  deleteAlarm(): Promise<void> { return this.inner.deleteAlarm(); }

  // ------------------------------------------------------------ the folder, through the link

  private ask(ask: Ask): Promise<Reply> {
    return Effect.runPromise(this.link.ask(ask));
  }
  private async paths(): Promise<string[]> {
    return ((await this.ask({ t: "list" })).paths ?? []).filter((p) => this.only == null || p == this.only);
  }
  private async folders(): Promise<string[]> {
    return this.only != null ? [] : [...((await this.ask({ t: "folders" })).dirs ?? [])];
  }
  private async read<T>(key: string): Promise<T | undefined> {
    if (key.startsWith(DIR)) return ((await this.folders()).includes(key.slice(DIR.length)) ? true : undefined) as T | undefined;
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return undefined;
    const { b64 } = await this.ask({ t: "read", path });
    return b64 == null ? undefined : (Result.getOrThrow(Base64.decode(b64)) as T);
  }
  private async write(key: string, value: unknown): Promise<void> {
    if (key.startsWith(DIR)) {
      await this.ask({ t: "mkdir", path: key.slice(DIR.length) });
      return;
    }
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return;
    const bytes = value instanceof Uint8Array ? value : typeof value == "string" ? new TextEncoder().encode(value) : null;
    if (!bytes) throw new DiskError({ message: `${path}: a file on disk holds bytes, not ${typeof value}` });
    await this.ask({ t: "write", path, b64: Base64.encode(bytes) });
  }
  private async remove(key: string): Promise<boolean> {
    if (key.startsWith(DIR)) {
      await this.ask({ t: "rmdir", path: key.slice(DIR.length) });
      return true;
    }
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return false;
    const was = (await this.ask({ t: "read", path })).b64 != null;
    if (was) await this.ask({ t: "remove", path });
    return was;
  }
}
