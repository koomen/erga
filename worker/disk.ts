// A document's files on disk, in local development: the folder (or single
// file) the dev server linked it to (dev/plugin.ts), reached over the
// document's /api/mirror WebSocket. As a FileStore it's the room's storage,
// just as a folder was for the old local host: the room lists, reads and
// writes the files themselves, and merges each change made on disk (the
// dev server says which) against the version it last wrote or read there.
// Nothing of the files is kept in the Durable Object's own storage.
//
// Until the dev server connects, the room waits for it (a while); while it's
// away, writes fail and the room tries them again.

import * as Effect from "effect/Effect";
import type { FromDisk, ToDisk } from "../dev/mirror";
import { FileStore, StoreError } from "../room";

type Ask = { t: "list" } | { t: "read"; path: string } | { t: "write"; path: string; text: string };

export class DiskLink {
  private socket: WebSocket | null = null;
  private waiting: ((socket: WebSocket) => void)[] = [];
  private calls = new Map<number, { resolve: (reply: Extract<FromDisk, { t: "reply" }>) => void; reject: (e: Error) => void }>();
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

  /** The files as a FileStore: only `only` of them, for a single file linked on its own. */
  store(only: string | null): FileStore["Service"] {
    const fail = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });
    return FileStore.of({
      list: Effect.tryPromise({ try: async () => ((await this.ask({ t: "list" })).paths ?? []).filter((p) => only == null || p == only), catch: fail }),
      read: (path) => only != null && path != only ? Effect.succeed(null) : Effect.tryPromise({
        try: async () => { const { b64 } = await this.ask({ t: "read", path }); return b64 == null ? null : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); },
        catch: fail,
      }),
      // A file anyone else adds beside a single file stays in the room, never on disk.
      write: (path, text) => only != null && path != only ? Effect.void : Effect.tryPromise({ try: () => this.ask({ t: "write", path, text }).then(() => {}), catch: fail }),
    });
  }

  private async ask(ask: Ask): Promise<Extract<FromDisk, { t: "reply" }>> {
    const socket = this.socket ?? await this.connection();
    const id = ++this.ids;
    const reply = await new Promise<Extract<FromDisk, { t: "reply" }>>((resolve, reject) => {
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
