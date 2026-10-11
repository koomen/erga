// One document, as a Durable Object (on erga.dev, and in local development
// alike): the Cloudflare side of document/document.ts. It gives the
// Document its storage, the server around it (the directory in D1, the
// other objects, the agent's settings), takes its WebSockets (a Durable
// Object accepts them its own way), wakes it for its alarm, and forwards
// the calls the rest of the Worker makes (RPC).
//
// The dev server's link to a document on disk (/api/mirror) is here too:
// the files then stay on disk, reached over that WebSocket (disk.ts).

import { DurableObject } from "cloudflare:workers";
import { Document, personOf, type DocumentDeps, type OnDisk } from "../document/document";
import type { DocRow } from "../server/directory";
import { agentToolsFor } from "../agents/tools";
import { VIA } from "../shared/attribution";
import type { PublishRequest, PublishResult, RestoreResult, VersionsState } from "../document/versions";
import type { DocSnapshot, Page } from "../deploy/snapshot";
import type { ImportedDocument } from "../server/admin/cutover";
import { directoryOf } from "./d1";
import { agentSettings } from "./agent-settings";
import { platform } from "./platform";
import { DiskLink } from "./disk";
import { publishedChanged } from "./published";
import { siteChanged, siteOps } from "./site-host";
import type { Env } from "./env";

/** The new-document template's page, which a new page starts from. */
const TEMPLATE = Object.values(import.meta.glob("../assets/templates/doc/index.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0] ?? "";
const AVATARS = "https://avatars.githubusercontent.com";

export class DocumentObject extends DurableObject<Env> {
  /** Every WebSocket open on this document: someone has it open while there are any. */
  private sockets = new Set<WebSocket>();
  /** A document on disk: its files, through the dev server. */
  private disk = new DiskLink({
    changed: (path) => { this.document.diskChanged(path).catch((e) => console.log(`couldn't take ${path} from disk: ${e}`)); },
    connected: () => { this.document.diskConnected().catch(() => {}); },
    // Edits already on their way (another socket, a busy machine) land first: a tenth of a second is nothing to wait when stopping.
    flush: async () => { await new Promise((r) => setTimeout(r, 100)); await this.document.flush(); },
  });
  private document = new Document(this.deps());

  private deps(): DocumentDeps {
    const env = this.env;
    return {
      storage: this.ctx.storage,
      directory: directoryOf(env),
      tabs: {
        count: () => this.sockets.size,
        closeAll: (code, reason) => { for (const socket of this.sockets) { try { socket.close(code, reason); } catch { /* already closed */ } } this.sockets.clear(); },
      },
      agentSettings: () => agentSettings(env),
      // Sharing this document (or another), the documents list (list, make, delete), and for an admin the server's settings and users, as the person.
      serverTools: (person, here) => agentToolsFor({ dir: directoryOf(env), who: { login: person.id, test: person.id.startsWith("test-"), via: VIA.agent }, here, platform: platform(env), sites: siteOps(env, "") }),
      takeDownSite: (site) => env.SITES.getByName(site.docId).remove(site.docId, site),
      home: {
        forget: (docId) => env.HOME?.getByName("home").forget(docId) ?? Promise.resolve(),
        publishedChanged: (docId) => publishedChanged(env, docId),
      },
      siteChanged: (docId) => siteChanged(env, docId),
      disk: { store: (only) => this.disk.store(only) },
      timing: { idleMs: Number(env.ERGA_VERSION_IDLE_MS) || 30_000, maxMs: Number(env.ERGA_VERSION_MAX_MS) || 5 * 60_000, writeDelay: Number(env.ERGA_WRITE_DELAY_MS) || undefined },
      background: (work) => this.ctx.waitUntil(work),
      log: (line) => console.log(line),
      pageTemplate: TEMPLATE || undefined,
      // People's ids are their GitHub logins, so GitHub serves their pictures.
      avatarOf: (person) => (person.id.startsWith("test-") ? undefined : `${AVATARS}/${encodeURIComponent(person.id)}?s=64`),
    };
  }

  // ------------------------------------------------------------ what the Worker calls (RPC)

  create(owner: string, id: string, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean> { return this.document.create(owner, id, files, index, opts); }
  link(owner: string, id: string, index: string, disk: OnDisk): Promise<DocRow> { return this.document.link(owner, id, index, disk); }
  publish(files: Record<string, string | Uint8Array>, remove: string[], by?: string) { return this.document.publish(files, remove, by); }
  paths(): Promise<string[]> { return this.document.paths(); }
  index(): Promise<string | null> { return this.document.index(); }
  snapshot(opts: { published?: boolean } = {}) { return this.document.snapshot(opts); }
  delete(): Promise<boolean> { return this.document.delete(); }
  /** A message for everyone who has the document open (the homepage's deploy status, home.ts). Opens nothing. */
  async notify(msg: unknown): Promise<void> { this.document.notify(msg); }
  diskPath(): Promise<string | null> { return this.document.diskPath(); }
  exists(): Promise<boolean> { return this.document.exists(); }
  exportStorage(id: string, page: Page): Promise<DocSnapshot | null> { return this.document.exportStorage(id, page); }
  importStorage(snap: DocSnapshot): Promise<void> { return this.document.importStorage(snap); }
  wipeStorage(): Promise<void> { return this.document.wipeStorage(); }
  versionsState(opts: { before?: string | number | null; limit?: number } = {}): Promise<VersionsState | null> { return this.document.versionsState(opts); }
  version(ref: string | number) { return this.document.version(ref); }
  versionFile(ref: string | number, path: string): Promise<Uint8Array | null> { return this.document.versionFile(ref, path); }
  setPublished(req: PublishRequest): Promise<PublishResult> { return this.document.setPublished(req); }
  restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult> { return this.document.restore(ref, by, path); }
  publishedFiles() { return this.document.publishedFiles(); }
  /** The storage cutover: becomes an exported document (server/admin/cutover.ts). */
  importExported(doc: ImportedDocument) { return this.document.importExported(doc); }

  /** Its unedited time is up (document.wake says what then). */
  async alarm(): Promise<void> {
    await this.document.wake();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The dev server, bringing the files of a document on disk: before the room opens, which waits for them.
    if (url.pathname == "/api/mirror") return this.mirror(request);
    if (request.headers.get("upgrade")?.toLowerCase() != "websocket") return this.document.handle(request);
    const opened = await this.document.admit(request);
    if (!opened) return new Response("No such document", { status: 404 });
    const editing = request.headers.get("x-erga-access") == "edit";
    const [client, server] = Object.values(new WebSocketPair());
    if (url.pathname.startsWith("/api/room")) {
      server.accept();
      this.track(server);
      // Binary frames as ArrayBuffers: with this compatibility date they'd otherwise arrive as Blobs.
      server.binaryType = "arraybuffer";
      const joined = this.document.joinRoom(opened, { epoch: url.searchParams.get("epoch"), readOnly: !editing, send: (m) => { try { server.send(m); } catch { /* already closed */ } } });
      // A tab holding another epoch's history is refused, never merged.
      if (!joined) server.close(4409, "stale epoch");
      else {
        server.addEventListener("message", (e) => { if (!joined.receive(bytesOf(e.data))) server.close(4400, "malformed message"); });
        server.addEventListener("close", joined.left);
        server.addEventListener("error", joined.left);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname == "/api/events") {
      server.accept();
      this.track(server);
      const leave = this.document.joinEvents(opened, personOf(request.headers), (msg) => { try { server.send(JSON.stringify(msg)); } catch { /* already closed */ } });
      server.addEventListener("close", leave);
      server.addEventListener("error", leave);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  /** The dev server's socket to the files of a document on disk (the front door checked its secret; so does this). */
  private async mirror(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!(await this.document.onDisk()) || !this.env.ERGA_LINK_SECRET || url.searchParams.get("link") != this.env.ERGA_LINK_SECRET || request.headers.get("upgrade")?.toLowerCase() != "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.track(server);
    this.disk.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private track(socket: WebSocket): void {
    this.sockets.add(socket);
    const gone = () => this.sockets.delete(socket);
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }
}

/** A frame's bytes, whether it came as text, an ArrayBuffer or a view on one. */
function bytesOf(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data == "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
