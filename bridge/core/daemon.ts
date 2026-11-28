// Local Erga bridge daemon (~/.erga/bridge.sock): a single lightweight process
// managing shared YjsDiskSync document mirrors (~/.erga/docs/...) and standalone
// ACP agent sessions connected to Erga's native embedded chat pane.
//
// Responsibilities:
// 1. Mount Erga documents locally via YjsDiskSync (shared across all agents).
// 2. Spawn and bridge any standalone ACP agent (Antigravity, Claude Code, Codex,
//    Pi, Gemini CLI, OpenCode, or custom `--acp "<cmd>"`) over /api/agent/bridge.
// 3. Inject `erga-agent mcp` into every ACP session via standard `mcpServers`.
// 4. Persist active mounts & ACP sessions in ~/.erga/bindings.json (mode 0600)
//    so turn-safe <200 ms self-updates restart at idle and resume sessions via
//    `session/load` / `session/resume` with `reconnect: true`.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Attachment } from "../../shared/attach.ts";
import type { ToBridge } from "../../shared/bridge-protocol.ts";
import { createAcpDriver } from "../drivers/acp.ts";
import { detectAgents, resolveAgentPreset } from "../drivers/presets.ts";
import type { AgentDriver, AgentHandle, DriverEvent, LocalAttachment, McpServerSpec } from "../drivers/stdio.ts";
import {
  defaultOrigin,
  ergaFetch,
  ergaHome,
  getAccessToken,
  normalizeOrigin,
  startDeviceLogin,
  waitForDeviceLogin,
  type PendingDeviceAuth,
} from "./auth.ts";
import { ErgaBridgeClient } from "./bridge-client.ts";
import { copyIntoManaged, daemonSocketPath, resolveDocument } from "./daemon-io.ts";
import {
  BRIDGE_VERSION,
  downloadAndSwap,
  fetchUpdateManifest,
  markCurrentHealthy,
  readPinnedOrigin,
  updateStep,
  type UpdateManifest,
  type UpdateState,
} from "./updater.ts";
import { managedDocDir, YjsDiskSync } from "./yjs-sync.ts";

const CLIENT_NAME = "Erga Bridge";

interface MountedDoc {
  origin: string;
  docId: string;
  owner: string;
  slug: string;
  title: string;
  dir: string;
  sync: YjsDiskSync;
}

interface AgentConnection {
  id: string;
  origin: string;
  agent: string;
  acp?: string;
  label: string;
  docId: string | null;
  cwd: string;
  addDirs: string[];
  autoApprove: boolean;
  model?: string;
  threadId: string;
  driver: AgentDriver;
  handle: AgentHandle;
  unsubEvent: () => void;
  unsubClose: () => void;
  client: ErgaBridgeClient;
  busy: boolean;
}

interface PersistedMount {
  origin: string;
  docId: string;
}

interface PersistedConnection {
  id: string;
  origin: string;
  agent: string;
  acp?: string;
  label: string;
  docId: string | null;
  cwd: string;
  addDirs?: string[];
  autoApprove?: boolean;
  model?: string;
  sessionId: string;
  threadId: string;
}

interface PersistedState {
  mounts: PersistedMount[];
  connections: PersistedConnection[];
}

export interface OpenDocumentRequest {
  origin?: string;
  document?: string;
  create?: boolean;
  title?: string;
  slug?: string;
  template?: string;
  fromDir?: string;
  connect?: boolean;
  agent?: string;
  acp?: string;
  label?: string;
  cwd?: string;
  model?: string;
  autoApprove?: boolean;
  nonBlockingAuth?: boolean;
}

export interface ConnectAgentRequest {
  id?: string;
  origin?: string;
  document?: string;
  agent?: string;
  acp?: string;
  label?: string;
  cwd?: string;
  resumeId?: string;
  threadId?: string;
  model?: string;
  autoApprove?: boolean;
  reconnect?: boolean;
  nonBlockingAuth?: boolean;
}

export type NeedsAuthResult = {
  ok: false;
  needsAuth: true;
  origin: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  message: string;
};

export type OpenDocumentResult =
  | {
      ok: true;
      origin: string;
      docId: string;
      url: string;
      dir: string;
      title: string;
      files: string[];
      copiedFrom?: string;
      connection?: { id: string; agent: string; label: string; sessionId: string; threadId: string };
    }
  | NeedsAuthResult;

export type ConnectAgentResult =
  | {
      ok: true;
      id: string;
      origin: string;
      agent: string;
      label: string;
      sessionId: string;
      threadId: string;
      cwd: string;
      docId: string | null;
      url?: string;
      dir?: string;
    }
  | NeedsAuthResult;

export interface DaemonOptions {
  version?: string;
  home?: string;
  defaultOrigin?: string;
  selfCmd?: { command: string; prefix: readonly string[] };
  driverFactory?: (req: ConnectAgentRequest) => AgentDriver;
  log?: (line: string) => void;
  onRestart?: (nextVersion: string) => void;
}

const mountKey = (origin: string, docId: string) => `${origin}\n${docId}`;
const hostSlug = () =>
  hostname()
    .replace(/[^a-zA-Z0-9-]+/g, "")
    .slice(0, 16) || "local";

function saveAttachmentsToDisk(cwd: string, files: readonly Attachment[] | undefined): LocalAttachment[] {
  if (!files?.length) return [];
  const dir = join(cwd, ".erga-attachments");
  let created = false;
  return files.map((f, i) => {
    const safeName = (f.name || `file-${i}`).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    if (f.kind == "text") {
      if (!created) {
        mkdirSync(dir, { recursive: true });
        created = true;
      }
      const p = join(dir, `${Date.now()}-${i}-${safeName}`);
      writeFileSync(p, f.data, "utf8");
      return { name: f.name, type: f.mimeType, kind: "text", data: f.data, path: p };
    }
    return { name: f.name, type: f.mimeType, kind: "image", data: f.data };
  });
}

function buildSystemPrompt(origin: string, mount?: MountedDoc): string {
  if (!mount) {
    return `You are connected to Erga (${origin}) via ACP + MCP. Use the erga MCP tools for reading, editing, and inspecting live Erga documents.`;
  }
  return `You are connected to Erga document "${mount.title}" (${origin}/${mount.owner}/${mount.slug}, id ${mount.docId}).
The document's live Yjs-synced folder on disk is: ${mount.dir}
Edit files directly in that folder—every edit syncs live to Erga via Yjs CRDT with 3-way rebase. Use the erga MCP \`page\` tool (view_page, page_log, page_input) to inspect the rendered page.`;
}

function buildPromptText(msg: Extract<ToBridge, { type: "prompt" }>, mount?: MountedDoc, cwd?: string): string {
  const notes: string[] = [];
  if (mount && cwd && resolve(cwd) != resolve(mount.dir)) {
    notes.push(`Erga document "${mount.title}" is synced locally at: ${mount.dir}`);
  }
  if (msg.context) notes.push(msg.context);
  return notes.length ? `${notes.join("\n")}\n\n${msg.text}` : msg.text;
}

export class ErgaDaemon {
  private readonly version: string;
  private readonly home: string;
  private readonly log: (line: string) => void;
  private mounts = new Map<string, MountedDoc>();
  private openingMounts = new Map<string, Promise<MountedDoc>>();
  private connections = new Map<string, AgentConnection>();
  private pendingAuth = new Map<string, PendingDeviceAuth>();
  private updateState: UpdateState;
  private activeTurns = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: DaemonOptions = {}) {
    this.version = opts.version ?? BRIDGE_VERSION;
    this.home = opts.home ?? ergaHome();
    this.log = opts.log ?? ((line) => console.error(`[erga-bridge] ${line}`));
    this.updateState = { at: "idle", version: this.version };
  }

  private bindingsPath(): string {
    return join(this.home, "bindings.json");
  }

  /** Marks startup healthy after 5 s and restores saved mounts & ACP connections. */
  async start(): Promise<void> {
    this.healthyTimer = setTimeout(() => markCurrentHealthy(this.home), 5_000);
    await this.restoreBindings();
  }

  /** Starts the local Unix socket RPC server (~/.erga/bridge.sock, mode 0600). */
  startSocket(): void {
    const sock = daemonSocketPath(this.home);
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(sock), 0o700);
    } catch {
      /* best effort */
    }
    if (existsSync(sock)) rmSync(sock, { force: true });

    this.server = Bun.serve({
      unix: sock,
      fetch: async (req) => {
        const url = new URL(req.url);
        try {
          if (url.pathname == "/status") return Response.json(this.status());
          if (url.pathname == "/agents") return Response.json({ ok: true, agents: detectAgents() });
          if (url.pathname == "/open" && req.method == "POST") {
            return Response.json(await this.openDocument((await req.json()) as OpenDocumentRequest));
          }
          if (url.pathname == "/connect" && req.method == "POST") {
            return Response.json(await this.connectAgent((await req.json()) as ConnectAgentRequest));
          }
          if (url.pathname == "/disconnect" && req.method == "POST") {
            const body = (await req.json()) as { id: string };
            return Response.json({ ok: await this.disconnectAgent(body.id) });
          }
          if (url.pathname == "/unmount" && req.method == "POST") {
            const body = (await req.json()) as { origin?: string; docId: string };
            return Response.json({ ok: await this.unmountDocument(body.docId, body.origin) });
          }
          if (url.pathname == "/auth/start" && req.method == "POST") {
            const body = (await req.json()) as { origin?: string };
            const origin = normalizeOrigin(body.origin || this.opts.defaultOrigin || defaultOrigin());
            return Response.json(await this.beginNonBlockingAuth(origin));
          }
          if (url.pathname == "/update" && req.method == "POST") {
            const body = (await req.json().catch(() => ({}))) as { checkOnly?: boolean };
            return Response.json(await this.checkForUpdate(Boolean(body.checkOnly)));
          }
          if (url.pathname == "/stop" && req.method == "POST") {
            setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Not found" }, { status: 404 });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    });
    try {
      chmodSync(sock, 0o600);
    } catch {
      /* best effort */
    }
  }

  status() {
    return {
      ok: true,
      pid: process.pid,
      version: this.version,
      activeTurns: this.activeTurns,
      updateState: this.updateState,
      connections: [...this.connections.values()].map((c) => ({
        id: c.id,
        origin: c.origin,
        agent: c.agent,
        label: c.label,
        docId: c.docId,
        cwd: c.cwd,
        sessionId: c.handle.sessionId,
        threadId: c.threadId,
        connected: c.client.connected,
        busy: c.busy,
      })),
      mounts: [...this.mounts.values()].map((m) => ({
        origin: m.origin,
        docId: m.docId,
        url: `${m.origin}/${m.owner}/${m.slug}`,
        dir: m.dir,
        title: m.title,
      })),
    };
  }

  private async ensureMount(origin: string, docRef: string, opts: { interactive?: boolean } = {}): Promise<MountedDoc> {
    const meta = await resolveDocument(origin, CLIENT_NAME, docRef, { interactive: opts.interactive ?? false });
    const key = mountKey(origin, meta.id);
    const existing = this.mounts.get(key);
    if (existing) return existing;
    let pending = this.openingMounts.get(key);
    if (!pending) {
      pending = (async () => {
        const dir = managedDocDir(this.home, origin, meta.owner, meta.slug);
        const sync = new YjsDiskSync({
          origin,
          docId: meta.id,
          dir,
          token: async () => {
            const t = await getAccessToken(origin, CLIENT_NAME, { interactive: opts.interactive ?? false, log: this.log });
            if (!t) throw new Error(`No token for ${origin}`);
            return t;
          },
          log: this.log,
        });
        await sync.start();
        const m: MountedDoc = { origin, docId: meta.id, owner: meta.owner, slug: meta.slug, title: meta.title, dir, sync };
        this.mounts.set(key, m);
        return m;
      })().finally(() => this.openingMounts.delete(key));
      this.openingMounts.set(key, pending);
    }
    return pending;
  }

  /** Opens/creates an Erga document and mounts its local Yjs room clone (optionally binding a standalone agent). */
  async openDocument(req: OpenDocumentRequest): Promise<OpenDocumentResult> {
    const origin = normalizeOrigin(req.origin || this.opts.defaultOrigin || defaultOrigin());
    if (!(await getAccessToken(origin, CLIENT_NAME, { interactive: false }))) {
      if (req.nonBlockingAuth) return await this.beginNonBlockingAuth(origin);
    }

    let docRef = req.document;
    if (req.create || !docRef) {
      const res = await ergaFetch(
        origin,
        CLIENT_NAME,
        "/api/tools/create_document",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(req.title ? { title: req.title } : {}),
            ...(req.slug ? { slug: req.slug } : {}),
            ...(req.template ? { template: req.template } : {}),
          }),
        },
        { interactive: !req.nonBlockingAuth, log: this.log }
      );
      if (!res.ok) throw new Error(`Could not create Erga document (${res.status}): ${await res.text()}`);
      const created = (await res.json()) as { result?: { id?: string; address?: string } };
      docRef = created.result?.address || created.result?.id;
      if (!docRef) throw new Error("Server returned no document id.");
    }

    const mount = await this.ensureMount(origin, docRef, { interactive: !req.nonBlockingAuth });
    if (req.fromDir) {
      await copyIntoManaged(req.fromDir, mount.dir);
      await mount.sync.flush();
    }
    this.persistBindings();

    let connection: { id: string; agent: string; label: string; sessionId: string; threadId: string } | undefined;
    if (req.connect) {
      const bound = await this.connectAgent({
        origin,
        document: `/d/${mount.docId}`,
        agent: req.agent,
        acp: req.acp,
        label: req.label,
        cwd: req.cwd,
        model: req.model,
        autoApprove: req.autoApprove,
        nonBlockingAuth: req.nonBlockingAuth,
      });
      if (!bound.ok) return bound;
      connection = { id: bound.id, agent: bound.agent, label: bound.label, sessionId: bound.sessionId, threadId: bound.threadId };
    }

    return {
      ok: true,
      origin,
      docId: mount.docId,
      url: `${origin}/${mount.owner}/${mount.slug}`,
      dir: mount.dir,
      title: mount.title,
      files: mount.sync.paths(),
      ...(req.fromDir ? { copiedFrom: req.fromDir } : {}),
      ...(connection ? { connection } : {}),
    };
  }

  /** Mounts optional document, spawns a standalone ACP agent session, and bridges it to Erga's native chat pane. */
  async connectAgent(req: ConnectAgentRequest): Promise<ConnectAgentResult> {
    const origin = normalizeOrigin(req.origin || this.opts.defaultOrigin || defaultOrigin());
    const tok = await getAccessToken(origin, CLIENT_NAME, { interactive: !req.nonBlockingAuth, log: this.log });
    if (!tok) {
      if (req.nonBlockingAuth) return await this.beginNonBlockingAuth(origin);
      throw new Error(`Not signed in to ${origin}. Run erga-agent login.`);
    }

    const mount = req.document ? await this.ensureMount(origin, req.document, { interactive: !req.nonBlockingAuth }) : undefined;
    const cwd = req.cwd ? resolve(req.cwd) : (mount?.dir ?? process.cwd());
    const addDirs = mount && resolve(cwd) != resolve(mount.dir) ? [mount.dir] : [];

    const driver =
      this.opts.driverFactory?.(req) ?? createAcpDriver(resolveAgentPreset({ agent: req.agent, acp: req.acp, label: req.label }), this.log);

    const mcpServers: McpServerSpec[] = this.opts.selfCmd
      ? [{ name: "erga", command: this.opts.selfCmd.command, args: [...this.opts.selfCmd.prefix, "mcp", "--server", origin] }]
      : [];

    const handle = await driver.open({
      cwd,
      addDirs,
      resumeId: req.resumeId,
      model: req.model,
      autoApprove: req.autoApprove,
      systemPrompt: buildSystemPrompt(origin, mount),
      mcpServers,
    });

    const id = req.id || `${driver.id}-${hostSlug()}-${crypto.randomUUID().slice(0, 6)}`;
    const label = req.label || (mount && req.cwd ? `${driver.label} (${basename(cwd)})` : driver.label);
    const threadId = req.threadId || handle.sessionId || crypto.randomUUID();
    const docId = mount?.docId ?? null;

    const client = new ErgaBridgeClient({
      origin,
      id,
      agent: driver.id,
      label,
      version: this.version,
      doc: docId,
      sessionId: handle.sessionId,
      threadId,
      cwd,
      model: handle.model,
      models: handle.models,
      initialReconnect: req.reconnect,
      token: async () => {
        const t = await getAccessToken(origin, CLIENT_NAME, { interactive: false, log: this.log });
        if (!t) throw new Error(`No token for ${origin}`);
        return t;
      },
      onMessage: (msg) => void this.handleBridgeMessage(id, msg),
      log: this.log,
    });

    const conn: AgentConnection = {
      id,
      origin,
      agent: req.agent || driver.id,
      acp: req.acp,
      label,
      docId,
      cwd,
      addDirs,
      autoApprove: Boolean(req.autoApprove),
      model: req.model,
      threadId,
      driver,
      handle,
      unsubEvent: () => {},
      unsubClose: () => {},
      client,
      busy: false,
    };

    this.wireHandle(conn);
    this.connections.set(id, conn);

    try {
      await client.start();
      if (docId) {
        client.bind(docId, { label, sessionId: handle.sessionId, threadId, cwd });
      }
    } catch (e) {
      this.connections.delete(id);
      conn.unsubEvent();
      conn.unsubClose();
      client.stop();
      await handle.close().catch(() => {});
      throw e;
    }

    this.persistBindings();
    return {
      ok: true,
      id,
      origin,
      agent: driver.id,
      label,
      sessionId: handle.sessionId,
      threadId,
      cwd,
      docId,
      ...(mount ? { url: `${origin}/${mount.owner}/${mount.slug}`, dir: mount.dir } : {}),
    };
  }

  private wireHandle(conn: AgentConnection): void {
    conn.unsubEvent();
    conn.unsubClose();
    conn.unsubEvent = conn.handle.onEvent((ev: DriverEvent) => {
      if (ev.t == "busy") {
        this.setConnBusy(conn, ev.busy);
        conn.client.sendEvent(conn.docId, ev);
        return;
      }
      if (ev.t == "turn_done") {
        this.setConnBusy(conn, false);
        const mount = conn.docId ? this.mounts.get(mountKey(conn.origin, conn.docId)) : undefined;
        const finish = () => {
          conn.client.turnDone(conn.docId);
          this.maybeCompletePendingRestart();
        };
        if (mount) void mount.sync.flush().finally(finish);
        else finish();
        return;
      }
      conn.client.sendEvent(conn.docId, ev);
    });
    conn.unsubClose = conn.handle.onClose(() => {
      if (this.connections.get(conn.id)?.handle !== conn.handle) return;
      this.setConnBusy(conn, false);
      this.connections.delete(conn.id);
      conn.client.stop();
      this.persistBindings();
      this.maybeCompletePendingRestart();
    });
  }

  private setConnBusy(conn: AgentConnection, next: boolean): void {
    if (conn.busy == next) return;
    conn.busy = next;
    this.activeTurns = Math.max(0, this.activeTurns + (next ? 1 : -1));
    const mount = conn.docId ? this.mounts.get(mountKey(conn.origin, conn.docId)) : undefined;
    if (mount) {
      const anyBusy = [...this.connections.values()].some((c) => c.origin == conn.origin && c.docId == conn.docId && c.busy);
      mount.sync.setPresence({ busy: anyBusy, activity: anyBusy ? "working" : null });
    }
  }

  private async handleBridgeMessage(connId: string, msg: ToBridge): Promise<void> {
    const conn = this.connections.get(connId);
    if (!conn) return;

    if (msg.type == "update") {
      await this.applyUpdateOffer({ version: msg.version, sha256: msg.sha256, url: msg.url });
      return;
    }

    if (msg.type == "prompt") {
      const mount = msg.doc ? this.mounts.get(mountKey(conn.origin, msg.doc)) : undefined;
      const attachments = saveAttachmentsToDisk(conn.cwd, msg.files);
      const text = buildPromptText(msg, mount, conn.cwd);
      await conn.handle.prompt({ text, attachments });
      return;
    }

    if (msg.type == "abort") {
      await conn.handle.abort();
      return;
    }

    if (msg.type == "answer") {
      await conn.handle.answer(msg.id, msg.approve, msg.choice);
      return;
    }

    if (msg.type == "model") {
      await conn.handle.setModel?.(msg.model);
      return;
    }

    if (msg.type == "reset") {
      const prev = conn.handle;
      conn.unsubEvent();
      conn.unsubClose();
      this.setConnBusy(conn, false);
      await prev.close().catch(() => {});
      const mount = conn.docId ? this.mounts.get(mountKey(conn.origin, conn.docId)) : undefined;
      const mcpServers: McpServerSpec[] = this.opts.selfCmd
        ? [{ name: "erga", command: this.opts.selfCmd.command, args: [...this.opts.selfCmd.prefix, "mcp", "--server", conn.origin] }]
        : [];
      const fresh = await conn.driver.open({
        cwd: conn.cwd,
        addDirs: conn.addDirs,
        model: conn.model,
        autoApprove: conn.autoApprove,
        systemPrompt: buildSystemPrompt(conn.origin, mount),
        mcpServers,
      });
      conn.handle = fresh;
      conn.threadId = fresh.sessionId || crypto.randomUUID();
      this.wireHandle(conn);
      this.persistBindings();
    }
  }

  async disconnectAgent(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn) return false;
    this.connections.delete(id);
    this.setConnBusy(conn, false);
    conn.unsubEvent();
    conn.unsubClose();
    if (conn.docId) conn.client.unbind(conn.docId);
    conn.client.stop();
    await conn.handle.close().catch(() => {});
    this.persistBindings();
    this.maybeCompletePendingRestart();
    return true;
  }

  async unmountDocument(docId: string, rawOrigin?: string): Promise<boolean> {
    const mount = rawOrigin
      ? this.mounts.get(mountKey(normalizeOrigin(rawOrigin), docId))
      : [...this.mounts.values()].find((m) => m.docId == docId);
    if (!mount) return false;
    this.mounts.delete(mountKey(mount.origin, mount.docId));
    for (const c of [...this.connections.values()]) {
      if (c.origin == mount.origin && c.docId == mount.docId) {
        await this.disconnectAgent(c.id);
      }
    }
    await mount.sync.flush().catch(() => {});
    await mount.sync.stop().catch(() => {});
    this.persistBindings();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    for (const c of [...this.connections.values()]) {
      this.setConnBusy(c, false);
      c.unsubEvent();
      c.unsubClose();
      c.client.stop();
      await c.handle.close().catch(() => {});
    }
    this.connections.clear();
    for (const m of this.mounts.values()) {
      await m.sync.flush().catch(() => {});
      await m.sync.stop().catch(() => {});
    }
    this.mounts.clear();
    this.server?.stop(true);
    this.server = null;
    const sock = daemonSocketPath(this.home);
    if (existsSync(sock)) rmSync(sock, { force: true });
  }

  // ---------------------------------------------------------------- persistence & turn-safe auto-update

  private persistBindings(): void {
    const p = this.bindingsPath();
    try {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      const data: PersistedState = {
        mounts: [...this.mounts.values()].map((m) => ({ origin: m.origin, docId: m.docId })),
        connections: [...this.connections.values()].map((c) => ({
          id: c.id,
          origin: c.origin,
          agent: c.agent,
          ...(c.acp ? { acp: c.acp } : {}),
          label: c.label,
          docId: c.docId,
          cwd: c.cwd,
          ...(c.addDirs.length ? { addDirs: c.addDirs } : {}),
          ...(c.autoApprove ? { autoApprove: true } : {}),
          ...(c.model ? { model: c.model } : {}),
          sessionId: c.handle.sessionId,
          threadId: c.threadId,
        })),
      };
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, p);
    } catch {
      /* best effort */
    }
  }

  private async restoreBindings(): Promise<void> {
    const p = this.bindingsPath();
    if (!existsSync(p)) return;
    let saved: Partial<PersistedState> | null = null;
    try {
      saved = JSON.parse(readFileSync(p, "utf8")) as Partial<PersistedState>;
    } catch {
      return;
    }
    for (const m of saved?.mounts ?? []) {
      if (this.stopped) return;
      await this.ensureMount(m.origin, `/d/${m.docId}`, { interactive: false }).catch((e) =>
        this.log(`restore mount ${m.docId} skipped: ${e instanceof Error ? e.message : e}`)
      );
    }
    for (const c of saved?.connections ?? []) {
      if (this.stopped) return;
      await this.connectAgent({
        id: c.id,
        origin: c.origin,
        ...(c.docId ? { document: `/d/${c.docId}` } : {}),
        agent: c.agent,
        acp: c.acp,
        label: c.label,
        cwd: c.cwd,
        resumeId: c.sessionId,
        threadId: c.threadId,
        model: c.model,
        autoApprove: c.autoApprove,
        reconnect: true,
        nonBlockingAuth: true,
      }).catch((e) => this.log(`restore agent ${c.id} skipped: ${e instanceof Error ? e.message : e}`));
    }
  }

  async checkForUpdate(
    checkOnly = false
  ): Promise<{ ok: boolean; updated?: boolean; pendingRestart?: boolean; version?: string; latest?: string; error?: string }> {
    const pinned = readPinnedOrigin(this.home);
    if (!pinned) return { ok: true, updated: false, version: this.version };
    const step1 = updateStep(this.updateState, { on: "check" });
    this.updateState = step1.state;
    if (!step1.effects.length) {
      return {
        ok: true,
        updated: false,
        pendingRestart: this.updateState.at == "pending_restart",
        version: this.version,
      };
    }
    try {
      const manifest = await fetchUpdateManifest(pinned);
      if (checkOnly || manifest.version == this.version) {
        this.updateState = updateStep(this.updateState, { on: "up_to_date" }).state;
        return { ok: true, updated: false, version: this.version, latest: manifest.version };
      }
      return await this.applyUpdateOffer(manifest);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.updateState = updateStep(this.updateState, { on: "fail", message: msg }).state;
      return { ok: false, version: this.version, error: msg };
    }
  }

  async applyUpdateOffer(
    manifest: UpdateManifest
  ): Promise<{ ok: boolean; updated?: boolean; pendingRestart?: boolean; version?: string; latest?: string; error?: string }> {
    const pinned = readPinnedOrigin(this.home);
    if (!pinned) return { ok: true, updated: false, version: this.version };
    const step = updateStep(this.updateState, { on: "manifest", manifest });
    this.updateState = step.state;
    if (!step.effects.length) {
      return {
        ok: true,
        updated: false,
        pendingRestart: this.updateState.at == "pending_restart",
        version: this.version,
        latest: manifest.version,
      };
    }
    try {
      const swapped = await downloadAndSwap(pinned, manifest, this.home);
      const done = updateStep(this.updateState, {
        on: "swapped",
        nextVersion: swapped.version,
        bundlePath: swapped.bundlePath,
        busy: this.activeTurns > 0,
      });
      this.updateState = done.state;
      this.persistBindings();
      if (done.state.at == "pending_restart") {
        this.log(`bridge update ${swapped.version} verified — waiting for active turn to finish before restarting`);
        return { ok: true, updated: true, pendingRestart: true, version: this.version, latest: swapped.version };
      }
      if (done.effects.some((ef) => ef.do == "restart")) {
        this.opts.onRestart?.(swapped.version);
      }
      return { ok: true, updated: true, version: this.version, latest: swapped.version };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.updateState = updateStep(this.updateState, { on: "fail", message: msg }).state;
      return { ok: false, version: this.version, error: msg };
    }
  }

  private maybeCompletePendingRestart(): void {
    if (this.activeTurns > 0 || this.updateState.at != "pending_restart") return;
    const step = updateStep(this.updateState, { on: "turn_idle" });
    this.updateState = step.state;
    const restart = step.effects.find((ef) => ef.do == "restart");
    if (restart) {
      this.persistBindings();
      this.opts.onRestart?.(restart.nextVersion);
    }
  }

  private async beginNonBlockingAuth(origin: string): Promise<NeedsAuthResult> {
    let pending = this.pendingAuth.get(origin);
    if (!pending || pending.expiresAt <= Date.now() + 15_000) {
      pending = await startDeviceLogin(origin, CLIENT_NAME);
      this.pendingAuth.set(origin, pending);
      void waitForDeviceLogin(pending)
        .catch((e) => this.log(`device auth failed: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          if (this.pendingAuth.get(origin) === pending) this.pendingAuth.delete(origin);
        });
    }
    return {
      ok: false,
      needsAuth: true,
      origin,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      userCode: pending.userCode,
      message: `Open ${pending.verificationUriComplete} (code ${pending.userCode}) in your browser, approve sign-in, then retry.`,
    };
  }
}
