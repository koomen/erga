// A document's files on disk, in local development: the folder (or single
// file) the dev server linked it to, reached over the document's /api/mirror
// WebSocket (mirror.ts says what goes over it). As a Storage (document/storage.ts)
// it is the document's storage with its files and folders on the folder and
// everything else (its record, the room's state, its versions) in the storage
// it wraps: the document reads and writes its files as it does anywhere, and
// merges each change made on disk (the dev server says which) against the
// version it last wrote or read there. Deleting the document leaves the files.
//
// Until the dev server connects, a call waits for it (a while); while it's
// away, calls fail and the room tries them again.

import type { FromDisk, ToDisk } from "./mirror.ts";
import { KEYS, type Storage } from "../document/storage.ts";
import { base64, fromBase64 } from "../shared/bytes.ts";

type Ask = { t: "list" } | { t: "read"; path: string } | { t: "write"; path: string; text?: string; b64?: string }
  | { t: "remove"; path: string } | { t: "folders" } | { t: "mkdir"; path: string } | { t: "rmdir"; path: string };
type Reply = Extract<FromDisk, { t: "reply" }>;

/** The dev server's socket to a document's files, and what it says. */
export class DiskLink {
  private socket: WebSocket | null = null;
  private waiting: ((socket: WebSocket) => void)[] = [];
  private calls = new Map<number, { resolve: (reply: Reply) => void; reject: (e: Error) => void }>();
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
      let m: FromDisk;
      try { m = JSON.parse(String(e.data)) as FromDisk; } catch { return; }
      if (m.t == "reply") { this.calls.get(m.id)?.resolve(m); this.calls.delete(m.id); }
      else if (m.t == "changed" && typeof m.path == "string") this.on.changed(m.path);
      else if (m.t == "flush") this.on.flush().finally(() => this.send({ t: "flushed" }));
    });
    const gone = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const call of this.calls.values()) call.reject(new Error("the dev server went away"));
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
  async ask(ask: Ask): Promise<Reply> {
    const socket = this.socket ?? await this.connection();
    const id = ++this.ids;
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      try { socket.send(JSON.stringify({ ...ask, id } as ToDisk)); } catch (e) { this.calls.delete(id); reject(e as Error); }
    });
    if (reply.error) throw new Error(reply.error);
    return reply;
  }

  /** The socket, once the dev server connects (it does so as it starts); an error if it doesn't soon. */
  private connection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== resume);
        reject(new Error("the files on disk aren't connected: is the dev server running?"));
      }, 15_000);
      const resume = (socket: WebSocket) => { clearTimeout(timer); resolve(socket); };
      this.waiting.push(resume);
    });
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

  private async paths(): Promise<string[]> {
    return ((await this.link.ask({ t: "list" })).paths ?? []).filter((p) => this.only == null || p == this.only);
  }
  private async folders(): Promise<string[]> {
    return this.only != null ? [] : (await this.link.ask({ t: "folders" })).dirs ?? [];
  }
  private async read<T>(key: string): Promise<T | undefined> {
    if (key.startsWith(DIR)) return ((await this.folders()).includes(key.slice(DIR.length)) ? true : undefined) as T | undefined;
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return undefined;
    const { b64 } = await this.link.ask({ t: "read", path });
    return b64 == null ? undefined : (fromBase64(b64) as T);
  }
  private async write(key: string, value: unknown): Promise<void> {
    if (key.startsWith(DIR)) { await this.link.ask({ t: "mkdir", path: key.slice(DIR.length) }); return; }
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return;
    const bytes = value instanceof Uint8Array ? value : typeof value == "string" ? new TextEncoder().encode(value) : null;
    if (!bytes) throw new Error(`${path}: a file on disk holds bytes, not ${typeof value}`);
    await this.link.ask({ t: "write", path, b64: base64(bytes) });
  }
  private async remove(key: string): Promise<boolean> {
    if (key.startsWith(DIR)) { await this.link.ask({ t: "rmdir", path: key.slice(DIR.length) }); return true; }
    const path = key.slice(FILE.length);
    if (this.only != null && path != this.only) return false;
    const was = (await this.link.ask({ t: "read", path })).b64 != null;
    if (was) await this.link.ask({ t: "remove", path });
    return was;
  }
}
