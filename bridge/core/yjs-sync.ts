// Local Yjs replica of an Erga document room (/d/<id>/api/room) synced
// bidirectionally to a local folder on disk. Reuses Erga's wire protocol
// (shared/yjs-protocol.ts), Y.Doc schema (document/model/content.ts), and
// 3-way word-level rebase (document/model/merge.ts) so edits made by any local
// coding agent merge cleanly with live human typing in the browser.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import * as Y from "yjs";
import { applyChanges, assets, files, folders, isTextPath, roomInfo } from "../../document/model/content.ts";
import { rebase, rebaseOnce } from "../../document/model/merge.ts";
import { cleanRel, ignored } from "../../document/model/pages.ts";
import { decodeStart, PING, PONG } from "../../shared/room-socket.ts";
import {
  Awareness,
  Decoder,
  Encoder,
  MSG_STORED,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  readSyncMessage,
  removeAwarenessStates,
  writeSyncStep1,
  writeUpdate,
} from "../../shared/yjs-protocol.ts";

const MSG_SYNC = 0,
  MSG_AWARENESS = 1,
  MSG_QUERY_AWARENESS = 3;

const TEXT_MAX = 512 * 1024;
const PING_EVERY_MS = 15_000;
const POLL_EVERY_MS = 1_000;
const DEBOUNCE_MS = 80;

/** Local-only tool artifacts that must never be synced into an Erga document. */
function localIgnored(rel: string): boolean {
  if (!rel || ignored(rel)) return true;
  const parts = rel.split("/");
  for (const p of parts) {
    if (p == ".git" || p == "node_modules" || p == ".erga" || p == ".erga-attachments" || p == ".DS_Store") return true;
    if (p.endsWith(".swp") || p.endsWith(".swo") || p.endsWith(".tmp") || p.endsWith("~") || /^\.#/.test(p)) return true;
  }
  return false;
}

export type SyncStatus = "connecting" | "synced" | "reconnecting" | "gone" | "closed";

export interface YjsSyncOptions {
  /** Erga server origin, e.g. "https://erga.dev" or "http://localhost:4400". */
  origin: string;
  /** Erga document id. */
  docId: string;
  /** Managed local directory to mirror the document's files into (~/.erga/docs/...). */
  dir: string;
  /** Returns the current valid Bearer token for `origin`. */
  token: () => Promise<string>;
  /** Optional status listener. */
  onStatus?: (status: SyncStatus) => void;
  /** Optional log callback. */
  log?: (line: string) => void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

/**
 * Bidirectional Yjs <-> filesystem mirror for one Erga document.
 * Local edits go through `rebase(base, current, incoming)` so concurrent
 * browser edits are preserved character-for-character.
 */
export class YjsDiskSync {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  private readonly LOCAL = { localDisk: true };
  private readonly REMOTE = { remoteRoom: true };
  private ws: WebSocket | null = null;
  private watcher: FSWatcher | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private status: SyncStatus = "connecting";
  private closed = false;
  private epoch: string | null = null;
  /** Last text we wrote to or read from disk for each text file (echo guard & rebase base). */
  private diskBase = new Map<string, string>();
  /** Last sha-256 hash we synced for each binary asset. */
  private assetHashes = new Map<string, string>();
  /** Relative paths queued by fs.watch or poll. */
  private dirty = new Set<string>();
  private rescan = false;
  /** File stamps (mtimeMs:size) for fallback polling. */
  private stamps = new Map<string, string>();
  /** Serializes disk <-> Yjs sync passes so writes and reads never interleave. */
  private queue: Promise<void> = Promise.resolve();
  private presenceState: Record<string, unknown> = {};

  constructor(private readonly opts: YjsSyncOptions) {
    this.awareness.setLocalState(null);
  }

  private log(msg: string): void {
    this.opts.log?.(`[yjs ${this.opts.docId}] ${msg}`);
  }

  private setStatus(s: SyncStatus): void {
    if (this.status == s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /** Connects to Erga, writes initial files to `opts.dir`, and starts live bidirectional sync. */
  async start(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true });
    this.bindDoc(this.doc);
    try {
      await this.fetchStart();
      await this.syncRemoteToDisk();
      await this.snapshotStamps();
      this.startWatching();
      await this.connectSocket();
      this.setStatus("synced");
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  /** Lists all files currently in the synced Yjs document. */
  paths(): string[] {
    return [...new Set([...files(this.doc).keys(), ...assets(this.doc).keys()])].sort();
  }

  /** Updates the local agent's presence in the Erga editor (e.g. `{ busy: true, activity: "editing" }`). */
  setPresence(patch: { busy?: boolean; activity?: string | null }): void {
    this.presenceState = { ...this.presenceState, ...patch, active: Date.now() };
    this.awareness.setLocalState(this.presenceState);
  }

  /** Forces any pending local disk edits to flush into Yjs right now (useful in tests & before close). */
  async flush(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.rescan = true;
    await this.enqueue(() => this.applyDiskChanges());
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setStatus("closed");
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poller) clearInterval(this.poller);
    if (this.pinger) clearInterval(this.pinger);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watcher?.close();
    this.watcher = null;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.awareness.destroy();
    try {
      this.ws?.close(1000, "closed");
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.doc.destroy();
  }

  // ---------------------------------------------------------------- doc bindings

  private bindDoc(doc: Y.Doc): void {
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.REMOTE) return;
      const e = new Encoder();
      e.writeUint(MSG_SYNC);
      writeUpdate(e, update);
      this.sendBytes(e.toBytes());
    });
    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === this.REMOTE) return;
      const clients = [...added, ...updated, ...removed];
      if (!clients.length) return;
      const e = new Encoder();
      e.writeUint(MSG_AWARENESS);
      e.writeBytes(encodeAwarenessUpdate(this.awareness, clients));
      this.sendBytes(e.toBytes());
    });
    files(doc).observeDeep((events) => {
      const touched = new Set<string>();
      for (const ev of events) {
        if (ev.transaction.origin === this.LOCAL) continue;
        if (ev.target === files(doc)) {
          for (const k of (ev as Y.YMapEvent<Y.Text>).keysChanged) touched.add(k);
        } else if (ev.path.length && typeof ev.path[0] == "string") {
          touched.add(ev.path[0]);
        }
      }
      if (touched.size) void this.enqueue(() => this.writeRemoteTexts(touched));
    });
    assets(doc).observe((ev) => {
      if (ev.transaction.origin === this.LOCAL) return;
      const touched = new Set(ev.keysChanged);
      if (touched.size) void this.enqueue(() => this.syncRemoteAssets(touched));
    });
    folders(doc).observe((ev) => {
      if (ev.transaction.origin === this.LOCAL) return;
      void this.enqueue(async () => {
        for (const dir of folders(doc).keys()) {
          const clean = cleanRel(dir);
          if (clean && !localIgnored(clean)) await mkdir(join(this.opts.dir, clean), { recursive: true }).catch(() => {});
        }
      });
    });
  }

  // ---------------------------------------------------------------- network

  private async fetchStart(): Promise<void> {
    const token = await this.opts.token();
    const res = await fetch(`${this.opts.origin}/d/${this.opts.docId}/api/start`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /d/${this.opts.docId}/api/start failed (${res.status}): ${await res.text()}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { hello, state } = decodeStart<{ epoch?: string }>(bytes);
    Y.applyUpdate(this.doc, state, this.REMOTE);
    this.epoch = hello.epoch ?? roomInfo(this.doc).get("epoch") ?? null;
  }

  private async connectSocket(): Promise<void> {
    if (this.closed) return;
    const token = await this.opts.token();
    const wsUrl = new URL(`${this.opts.origin.replace(/^http/, "ws")}/d/${this.opts.docId}/api/room`);
    if (this.epoch) wsUrl.searchParams.set("epoch", this.epoch);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      // Bun's WebSocket constructor accepts custom headers in the second argument.
      const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(wsUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.tries = 0;
        const e = new Encoder();
        e.writeUint(MSG_SYNC);
        writeSyncStep1(e, this.doc);
        this.sendBytes(e.toBytes());
        if (this.awareness.getLocalState()) {
          const aw = new Encoder();
          aw.writeUint(MSG_AWARENESS);
          aw.writeBytes(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
          this.sendBytes(aw.toBytes());
        }
        if (this.pinger) clearInterval(this.pinger);
        this.pinger = setInterval(() => {
          try {
            if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(PING);
          } catch {
            /* closing */
          }
        }, PING_EVERY_MS);
        this.setStatus("synced");
        done(resolve);
      });

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data == "string") {
          if (ev.data == PONG) return;
          return;
        }
        const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as Uint8Array);
        this.handleBinary(bytes);
      });

      ws.addEventListener("close", (ev) => {
        if (this.ws === ws) this.ws = null;
        if (this.pinger) {
          clearInterval(this.pinger);
          this.pinger = null;
        }
        if (this.closed) return done(resolve);
        if (ev.code == 4404) {
          this.setStatus("gone");
          done(() => reject(new Error("Document was deleted.")));
          return;
        }
        if (ev.code == 4409) {
          this.log("stale epoch, adopting local edits onto fresh room state");
          void this.reAdoptEpoch();
          done(resolve);
          return;
        }
        this.setStatus("reconnecting");
        this.scheduleReconnect();
        done(resolve);
      });

      ws.addEventListener("error", () => {
        if (!settled) done(() => reject(new Error("Could not open room WebSocket.")));
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const wait = Math.min(5_000, 250 * 2 ** Math.min(this.tries++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocket().catch(() => this.scheduleReconnect());
    }, wait);
  }

  /** Re-syncs after a room epoch reset without losing local disk edits (document/model/merge.ts, rebaseOnce). */
  private async reAdoptEpoch(): Promise<void> {
    await this.enqueue(async () => {
      const oldTexts = new Map<string, string>();
      for (const [p, t] of files(this.doc)) oldTexts.set(p, t.toString());
      const bases = new Map(this.diskBase);

      this.awareness.destroy();
      this.doc.destroy();
      this.doc = new Y.Doc();
      this.awareness = new Awareness(this.doc);
      this.awareness.setLocalState(Object.keys(this.presenceState).length ? this.presenceState : null);
      this.bindDoc(this.doc);

      await this.fetchStart();
      this.doc.transact(() => {
        for (const [path, ours] of oldTexts) {
          const base = bases.get(path);
          const current = files(this.doc).get(path);
          if (base == null || ours == base || !current) continue;
          applyChanges(current, rebaseOnce(base, current.toString(), ours));
        }
      }, this.LOCAL);
      await this.syncRemoteToDisk();
      await this.connectSocket();
    });
  }

  private handleBinary(bytes: Uint8Array): void {
    try {
      const d = new Decoder(bytes);
      const type = d.readUint();
      if (type == MSG_SYNC) {
        const reply = new Encoder();
        reply.writeUint(MSG_SYNC);
        readSyncMessage(d, reply, this.doc, this.REMOTE);
        if (reply.length > 1) this.sendBytes(reply.toBytes());
        const e = roomInfo(this.doc).get("epoch");
        if (e) this.epoch = e;
      } else if (type == MSG_AWARENESS) {
        applyAwarenessUpdate(this.awareness, d.readBytes(), this.REMOTE);
      } else if (type == MSG_QUERY_AWARENESS) {
        if (this.awareness.getLocalState()) {
          const aw = new Encoder();
          aw.writeUint(MSG_AWARENESS);
          aw.writeBytes(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
          this.sendBytes(aw.toBytes());
        }
      } else if (type == MSG_STORED) {
        // Stored state vector acknowledgement; nothing required for disk mirror.
      }
    } catch (e) {
      this.log(`ignored malformed frame: ${e instanceof Error ? e.message : e}`);
    }
  }

  private sendBytes(bytes: Uint8Array): void {
    try {
      if (this.ws?.readyState == WebSocket.OPEN) this.ws.send(bytes.slice());
    } catch {
      /* reconnect will resync */
    }
  }

  // ---------------------------------------------------------------- remote -> disk

  private async syncRemoteToDisk(): Promise<void> {
    for (const dir of folders(this.doc).keys()) {
      const clean = cleanRel(dir);
      if (clean && !localIgnored(clean)) await mkdir(join(this.opts.dir, clean), { recursive: true });
    }
    const textKeys = new Set(files(this.doc).keys());
    await this.writeRemoteTexts(textKeys);
    const assetKeys = new Set(assets(this.doc).keys());
    await this.syncRemoteAssets(assetKeys);

    const expected = new Set([...textKeys, ...assetKeys]);
    for (const rel of await this.walkDisk()) {
      if (!expected.has(rel)) await rm(join(this.opts.dir, rel), { force: true }).catch(() => {});
    }
  }

  private async writeRemoteTexts(paths: Set<string>): Promise<void> {
    for (const raw of paths) {
      const rel = cleanRel(raw);
      if (!rel || localIgnored(rel)) continue;
      const yText = files(this.doc).get(rel);
      const abs = join(this.opts.dir, rel);
      if (!yText) {
        this.diskBase.delete(rel);
        await rm(abs, { force: true }).catch(() => {});
        continue;
      }
      const content = yText.toString();
      if (this.diskBase.get(rel) === content && existsSync(abs)) continue;
      this.diskBase.set(rel, content);
      await writeAtomic(abs, content);
      await this.stampFile(rel);
    }
  }

  private async syncRemoteAssets(paths: Set<string>): Promise<void> {
    const token = await this.opts.token().catch(() => null);
    for (const raw of paths) {
      const rel = cleanRel(raw);
      if (!rel || localIgnored(rel)) continue;
      const hash = assets(this.doc).get(rel);
      const abs = join(this.opts.dir, rel);
      if (!hash) {
        this.assetHashes.delete(rel);
        if (!files(this.doc).has(rel)) await rm(abs, { force: true }).catch(() => {});
        continue;
      }
      if (this.assetHashes.get(rel) == hash && existsSync(abs)) continue;
      if (!token) continue;
      const encoded = rel.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`${this.opts.origin}/d/${this.opts.docId}/doc/${encoded}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (!res?.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.assetHashes.set(rel, hash);
      await writeAtomic(abs, bytes);
      await this.stampFile(rel);
    }
  }

  // ---------------------------------------------------------------- disk -> remote

  private startWatching(): void {
    try {
      this.watcher = watch(this.opts.dir, { recursive: true }, (_event, name) => {
        if (typeof name != "string") {
          this.rescan = true;
        } else {
          const rel = cleanRel(name.split(sep).join("/"));
          if (rel && !localIgnored(rel)) this.dirty.add(rel);
        }
        this.scheduleDiskPass();
      });
    } catch {
      /* fallback poller still runs */
    }
    this.poller = setInterval(() => {
      void this.pollDisk();
    }, POLL_EVERY_MS);
  }

  private scheduleDiskPass(): void {
    if (this.closed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.enqueue(() => this.applyDiskChanges());
    }, DEBOUNCE_MS);
  }

  private async walkDisk(sub = ""): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(join(this.opts.dir, sub), { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const rel = sub ? `${sub}/${ent.name}` : ent.name;
      if (localIgnored(rel)) continue;
      if (ent.isDirectory()) out.push(...(await this.walkDisk(rel)));
      else if (ent.isFile()) out.push(rel);
    }
    return out;
  }

  private async stampFile(rel: string): Promise<void> {
    const s = await stat(join(this.opts.dir, rel)).catch(() => null);
    if (s?.isFile()) this.stamps.set(rel, `${s.mtimeMs}:${s.size}`);
    else this.stamps.delete(rel);
  }

  private async snapshotStamps(): Promise<void> {
    this.stamps.clear();
    for (const rel of await this.walkDisk()) await this.stampFile(rel);
  }

  private async pollDisk(): Promise<void> {
    if (this.closed) return;
    const seen = new Set<string>();
    let changed = false;
    for (const rel of await this.walkDisk()) {
      seen.add(rel);
      const s = await stat(join(this.opts.dir, rel)).catch(() => null);
      if (!s?.isFile()) continue;
      const stamp = `${s.mtimeMs}:${s.size}`;
      if (this.stamps.get(rel) != stamp) {
        this.stamps.set(rel, stamp);
        this.dirty.add(rel);
        changed = true;
      }
    }
    for (const old of [...this.stamps.keys()]) {
      if (!seen.has(old)) {
        this.stamps.delete(old);
        this.dirty.add(old);
        changed = true;
      }
    }
    if (changed) this.scheduleDiskPass();
  }

  private async applyDiskChanges(): Promise<void> {
    if (this.closed) return;
    const targets = new Set(this.dirty);
    this.dirty.clear();
    if (this.rescan) {
      this.rescan = false;
      for (const rel of await this.walkDisk()) targets.add(rel);
      for (const rel of this.diskBase.keys()) targets.add(rel);
      for (const rel of this.assetHashes.keys()) targets.add(rel);
    }
    for (const rel of targets) {
      if (localIgnored(rel)) continue;
      const abs = join(this.opts.dir, rel);
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isFile()) {
        // File removed from disk: delete from Yjs if we were tracking it.
        if (this.diskBase.has(rel)) {
          this.diskBase.delete(rel);
          this.doc.transact(() => files(this.doc).delete(rel), this.LOCAL);
        } else if (this.assetHashes.has(rel)) {
          this.assetHashes.delete(rel);
          this.doc.transact(() => assets(this.doc).delete(rel), this.LOCAL);
        }
        continue;
      }
      this.stamps.set(rel, `${s.mtimeMs}:${s.size}`);
      const bytes = new Uint8Array(await readFile(abs));
      const text = isTextPath(rel) && bytes.length <= TEXT_MAX ? decodeUtf8(bytes) : null;
      if (text != null) {
        const prev = this.diskBase.get(rel);
        if (prev === text) continue;
        this.diskBase.set(rel, text);
        this.doc.transact(() => {
          const existing = files(this.doc).get(rel);
          if (!existing) {
            const nt = new Y.Text();
            nt.insert(0, text);
            files(this.doc).set(rel, nt);
          } else {
            const base = prev ?? existing.toString();
            const changes = rebase(base, existing.toString(), text);
            if (!changes.empty) applyChanges(existing, changes);
          }
        }, this.LOCAL);
      } else {
        // Binary file (image, PDF, font): upload via PUT /d/<id>/api/files/<path>.
        const hash = sha256(bytes);
        if (this.assetHashes.get(rel) == hash) continue;
        const token = await this.opts.token().catch(() => null);
        if (!token) continue;
        const encoded = rel.split("/").map(encodeURIComponent).join("/");
        const res = await fetch(`${this.opts.origin}/d/${this.opts.docId}/api/files/${encoded}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => null);
        if (res?.ok) this.assetHashes.set(rel, hash);
        else this.log(`upload failed for ${rel}: ${res?.status ?? "network error"}`);
      }
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch((e) => this.log(`sync error: ${e instanceof Error ? e.message : e}`));
    return this.queue;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Computes the managed local directory path for an Erga document. */
export function managedDocDir(home: string, origin: string, owner: string, slug: string): string {
  const host = new URL(origin).host.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeOwner = owner.replace(/[^a-zA-Z0-9._-]+/g, "_") || "doc";
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]+/g, "_") || "untitled";
  return join(home, "docs", host, safeOwner, safeSlug);
}

/** Ensures `abs` is inside `root` and returns the clean relative path, or null. */
export function relInside(root: string, abs: string): string | null {
  const r = relative(root, abs).split(sep).join("/");
  return r && !r.startsWith("..") ? cleanRel(r) : null;
}
