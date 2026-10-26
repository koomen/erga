// One document, as a Durable Object (on erga.dev, and in local development
// alike): the Cloudflare side of document/document.ts. It gives the
// Document its storage, the server around it (the directory in D1, the
// other objects, the agent's settings), takes its WebSockets, wakes it for
// its alarm, and forwards the calls the rest of the Worker makes (RPC).
//
// Tabs' sockets use the hibernation API (ctx.acceptWebSocket): the object
// sleeps while they're idle and wakes for their next message, and each
// socket keeps what it is in its attachment. document/tabs.ts joins them to
// the document whenever it opens; the document closes itself when nothing
// has happened for a while (ERGA_ROOM_IDLE_MS, a minute), so nothing keeps
// the object awake while tabs only sit open.
//
// The dev server's link to a document on disk (/api/mirror) is here too:
// the files then stay on disk, reached over that WebSocket (document/disk.ts).
// It's an ordinary socket: a document on disk never sleeps.

import { DurableObject } from "cloudflare:workers";
import { Document, personOf, type DocumentDeps, type FileData, type OnDisk } from "../../document/document";
import type { ViewAnswer } from "../../document/view";
import type { DocKind } from "../../document/pages";
import { Tabs, type Tab } from "../../document/tabs";
import { PING, PONG } from "../../shared/room-socket";
import type { Who } from "../../server/directory/index.ts";
import type { Role } from "../../document/access";
import type { NamedRow } from "../../document/names";
import { documentAgents } from "../../agents/document/session";
import { agentToolsFor } from "../../agents/tools";
import { VIA } from "../../shared/attribution";
import type { RestoreResult, VersionsState } from "../../document/versions";
import type { DocSnapshot, Page } from "../../document/snapshot";
import { directoryOf } from "../d1";
import { forgetDecisions } from "../../server/documents/index.ts";
import { platform } from "../platform";
import { CALLS, DeployGate, DEPLOYED_HEADER, deployedOf, STALE, staleResponse, type Call } from "./document-stub";
import { DiskLink } from "../../document/disk";
import type { Env } from "../env";
import { blobsOf } from "../blobs";
import { safeAvatar } from "../../shared/avatars";
import { sleep } from "../../shared/time";

/** The new-document template's page, which a new page starts from. */
const TEMPLATE =
  Object.values(
    import.meta.glob("../../assets/templates/doc/index.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>
  )[0] ?? "";

export class DocumentObject extends DurableObject<Env> {
  /** The dev server's sockets (ordinary ones): a document on disk. */
  private mirrors = new Set<WebSocket>();
  /** A document on disk: its files, through the dev server. */
  private disk = new DiskLink({
    changed: (path) => { this.document.diskChanged(path).catch((e) => console.log(`couldn't take ${path} from disk: ${e}`)); },
    connected: () => { this.document.diskConnected().catch(() => {}); },
    // Edits already on their way (another socket, a busy machine) land first: a tenth of a second is nothing to wait when stopping.
    flush: async () => {
      await sleep(100);
      await this.document.flush();
    },
  });
  private document = new Document(this.deps());
  /** The tabs' sockets, joined to the document whenever it's open. */
  private tabs = new Tabs<WebSocket>({
    document: () => this.document,
    sockets: () => this.ctx.getWebSockets(),
    tabOf: (ws) => (ws.deserializeAttachment() as Tab | null) ?? null,
    keep: (ws, tab) => ws.serializeAttachment(tab),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A tab's "are you there?" is answered without waking the object (client/shell/collab.ts sends it while idle).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private deps(): DocumentDeps {
    const env = this.env;
    return {
      storage: this.ctx.storage,
      directory: directoryOf(env),
      tabs: {
        count: () => this.ctx.getWebSockets().length + this.mirrors.size,
        closeAll: (code, reason) => {
          for (const socket of [...this.ctx.getWebSockets(), ...this.mirrors]) { try { socket.close(code, reason); } catch { /* already closed */ } }
          this.mirrors.clear();
          this.tabs.detachAll();
        },
        attach: (opened) => this.tabs.attachAll(opened),
        detach: () => this.tabs.detachAll(),
      },
      agents: documentAgents({
        settings: () => platform(env).agentSettings(),
        // Sharing this document (or another), the documents list (list, make, delete), and for an admin the server's settings and users, as the person.
        serverTools: (person, here) => agentToolsFor({ dir: directoryOf(env), who: { login: person.id, test: person.id.startsWith("test-"), via: VIA.agent }, here, platform: platform(env) }),
        // Each person's conversation here, kept in their own object (cloudflare/objects/person-agent.ts).
        chats: (person, docId) => {
          const agents = env.AGENTS.getByName(person.id), scope = `doc:${docId}`;
          return { load: () => agents.load(scope), save: (change) => agents.save(scope, change), clear: () => agents.clear(scope) };
        },
      }),
      home: {
        forget: (docId) => env.HOME.getByName("home").forget(docId),
        // A new version: if it is the homepage, its next deploy is scheduled.
        changed: async (docId) => {
          await env.HOME.getByName("home").changed(docId);
        },
      },
      disk: { storage: (only) => this.disk.storage(this.ctx.storage, only) },
      timing: {
        idleMs: Number(env.ERGA_VERSION_IDLE_MS) || 30_000,
        maxMs: Number(env.ERGA_VERSION_MAX_MS) || 5 * 60_000,
        writeDelay: Number(env.ERGA_WRITE_DELAY_MS) || undefined,
        closeIdleMs: Number(env.ERGA_ROOM_IDLE_MS) || 60_000,
      },
      background: (work) => this.ctx.waitUntil(work),
      // Its files that aren't text, in R2.
      blobs: blobsOf(env),
      // (This isolate's answers only: elsewhere a viewer's kept answer lasts its few seconds: server/documents/view.ts.)
      viewChanged: (docId) => forgetDecisions(docId),
      log: (line) => console.log(line),
      pageTemplate: TEMPLATE || undefined,
      // Each person's picture, as the app sent it (their users row: shared/avatars.ts); none: their initial shows.
      avatarOf: (person) => safeAvatar(person.avatar) ?? undefined,
    };
  }

  // ------------------------------------------------------------ what the Worker calls (RPC)

  /** A caller from a newer deploy: the object writes what it holds, then stops; the next call starts it on the new code (document-host.ts). */
  private gate = new DeployGate(deployedOf(this.env), async () => {
    console.log("a caller from a newer deploy: this object writes its edits and restarts");
    await this.document.flush().catch((e) => console.log(`couldn't write before the restart: ${e}`));
    // After this answer goes.
    setTimeout(() => this.ctx.abort("a newer deploy"), 0);
  });

  /**
   * Every call from the Worker (documentOf, document-host.ts): `method` with
   * `args`, from a caller of deploy `deployed`. An object older than its
   * caller runs nothing, answers STALE and stops. Each version of the object
   * keeps this signature.
   */
  async call(deployed: number, method: string, args: unknown[]): Promise<unknown> {
    if (await this.gate.stale(deployed)) return STALE;
    if (!(CALLS as readonly string[]).includes(method)) throw new Error(`No such call: ${method}`);
    return (this[method as Call] as (...a: unknown[]) => unknown)(...args);
  }

  create(
    owner: string,
    id: string,
    files: Record<string, FileData>,
    index: string,
    opts: { test?: boolean; expires: number | null; modified?: number; kind?: DocKind }
  ): Promise<boolean> {
    return this.document.create(owner, id, files, index, opts);
  }
  link(owner: string, id: string, index: string, disk: OnDisk): Promise<NamedRow> {
    return this.document.link(owner, id, index, disk);
  }
  // (Each call that opens the document holds it open until it's done: it doesn't close for being idle meanwhile.)
  publish(files: Record<string, FileData>, remove: string[], by?: string) { return this.document.publish(files, remove, by); }
  paths(): Promise<string[]> { return this.document.hold(() => this.document.paths()); }
  index(): Promise<string | null> { return this.document.index(); }
  snapshot() { return this.document.hold(() => this.document.snapshot()); }
  delete(): Promise<boolean> { return this.document.delete(); }
  /** A message for everyone who has the document open (the homepage's deploy status, home.ts). Opens nothing. */
  async notify(msg: unknown): Promise<void> { this.tabs.notify(msg); }
  diskPath(): Promise<string | null> { return this.document.diskPath(); }
  exists(): Promise<boolean> { return this.document.exists(); }
  exportStorage(id: string, page: Page): Promise<DocSnapshot | null> { return this.document.exportStorage(id, page); }
  importStorage(snap: DocSnapshot): Promise<void> { return this.document.importStorage(snap); }
  wipeStorage(): Promise<void> { return this.document.wipeStorage(); }
  versionsState(opts: { before?: string | number | null; limit?: number } = {}): Promise<VersionsState | null> { return this.document.hold(() => this.document.versionsState(opts)); }
  restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult> { return this.document.hold(() => this.document.restore(ref, by, path)); }
  currentFiles() { return this.document.hold(() => this.document.currentFiles()); }
  /** The directory's permissions for this document now (Directory.share pushes each change): the document's copy. */
  setPermissions(list: { login: string; role: Role }[]): Promise<void> { return this.document.setPermissions(list); }
  /** A viewer's page in one call (Document.view): what they may do, which file, the version, its text. */
  view(who: Who | null, opts: { page: string; anyone?: boolean }): Promise<ViewAnswer | null> { return this.document.view(who, opts); }
  /** A person's agent run that a restart cut off goes on (their object's alarm asks). */
  resumeAgent(person: { id: string; name: string }): Promise<void> { return this.document.hold(() => this.document.resumeAgent(person)); }

  /** Its unedited time is up (document.wake says what then). */
  async alarm(): Promise<void> {
    await this.document.wake();
  }

  async fetch(request: Request): Promise<Response> {
    if (await this.gate.stale(Number(request.headers.get(DEPLOYED_HEADER)) || 0)) return staleResponse();
    const url = new URL(request.url);
    // The dev server, bringing the files of a document on disk: before the room opens, which waits for them.
    if (url.pathname == "/api/mirror") return this.mirror(request);
    if (request.headers.get("upgrade")?.toLowerCase() != "websocket") return this.document.handle(request);
    // A tab's one socket: the room, and with ?events=1 its person's events (document/tabs.ts).
    if (!url.pathname.startsWith("/api/room")) return new Response("Not found", { status: 404 });
    // Who may: decided here, on the document's copy of its permissions (the app asked no database).
    const allowed = await this.document.authorize(request);
    if (allowed instanceof Response) return allowed;
    request = allowed;
    const opened = await this.document.admit(request);
    if (!opened) return new Response("No such document", { status: 404 });
    const tab: Tab = {
      id: crypto.randomUUID(), readOnly: request.headers.get("x-erga-access") != "edit", epoch: url.searchParams.get("epoch") || null,
      person: personOf(request.headers), events: url.searchParams.get("events") == "1" || url.searchParams.get("watch") == "files",
      // A files view (client/pages/files.ts): it hears the tree change, and never joins the room.
      ...(url.searchParams.get("watch") == "files" ? { watch: true } : {}),
    };
    const [client, server] = Object.values(new WebSocketPair());
    // A tab holding another epoch's history is refused, never merged (on a socket of its own, closed at once).
    if (!tab.watch && tab.epoch && tab.epoch != opened.room.epoch) {
      server.accept();
      server.close(4409, "stale epoch");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(tab);
    if (!this.tabs.join(server, opened, tab)) server.close(4409, "stale epoch");
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A tab's message (it may wake the object: the document then opens again from storage). */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.tabs.message(ws, typeof message == "string" ? message : bytesOf(message));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.tabs.closed(ws);
    try { ws.close(code, reason); } catch { /* already closed, or a code that can't be sent back */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.tabs.closed(ws);
  }

  /** The dev server's socket to the files of a document on disk (the app checked its secret; so does this). */
  private async mirror(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!(await this.document.onDisk()) || !this.env.ERGA_LINK_SECRET || url.searchParams.get("link") != this.env.ERGA_LINK_SECRET || request.headers.get("upgrade")?.toLowerCase() != "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.mirrors.add(server);
    const gone = () => this.mirrors.delete(server);
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    this.disk.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** A frame's bytes, whether it came as text, an ArrayBuffer or a view on one. */
function bytesOf(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data == "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
