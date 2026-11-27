// Local Erga bridge daemon (~/.erga/bridge.sock): a thin, stateless client
// sitting between a local TerminalBackend (herdr-core or rex) and Erga servers.
//
// Responsibilities:
// 1. Mount Erga documents locally via YjsDiskSync (~/.erga/docs/...).
// 2. Bind each mounted document to either a Single Terminal or a Whole Space.
// 3. Relay live PTY streams (DATA / RESIZE / CLOSE) and OSC 7501 status + turn
//    updates between the local backend and Erga's PersonAgent Durable Object.
// 4. Persist active document bindings inside the backend (doc "erga-bridge")
//    so <200 ms self-updates restart seamlessly without interrupting any agent.

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import type { AttachScope, TerminalSummary, ToBridge } from "../../shared/bridge-protocol.ts";
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
import type { BackendEvent, PtyAttachment, TerminalBackend } from "./backend.ts";
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
const BINDINGS_KEY = "erga-bridge";

interface MountedDoc {
  origin: string;
  docId: string;
  owner: string;
  slug: string;
  title: string;
  dir: string;
  sync: YjsDiskSync;
  scope: AttachScope;
  spaceId: string | null;
  spaceName: string | null;
  terminals: TerminalSummary[];
  activeTerminal: string | null;
}

interface PersistedBinding {
  origin: string;
  docId: string;
  scope: AttachScope;
  spaceId: string | null;
  terminalId: string | null;
}

export interface OpenDocumentRequest {
  origin?: string;
  document?: string;
  create?: boolean;
  title?: string;
  slug?: string;
  template?: string;
  fromDir?: string;
  space?: boolean | string;
  terminal?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nonBlockingAuth?: boolean;
}

export type OpenDocumentResult =
  | {
      ok: true;
      origin: string;
      docId: string;
      url: string;
      dir: string;
      title: string;
      files: string[];
      scope: AttachScope;
      spaceName: string | null;
      terminals: TerminalSummary[];
      activeTerminal: string | null;
      copiedFrom?: string;
    }
  | {
      ok: false;
      needsAuth: true;
      origin: string;
      verificationUri: string;
      verificationUriComplete: string;
      userCode: string;
      message: string;
    };

export interface DaemonOptions {
  version?: string;
  defaultOrigin?: string;
  log?: (line: string) => void;
  onRestart?: (nextVersion: string) => void;
}

const mountKey = (origin: string, docId: string) => `${origin}\n${docId}`;
const ptyKey = (origin: string, doc: string | null, terminalId: string) => `${origin}\n${doc ?? ""}\n${terminalId}`;

export class ErgaDaemon {
  readonly id: string;
  private readonly version: string;
  private readonly log: (line: string) => void;
  private mounts = new Map<string, MountedDoc>();
  private openingMounts = new Map<string, Promise<MountedDoc>>();
  private bridges = new Map<string, ErgaBridgeClient>();
  private connectingOrigins = new Map<string, Promise<ErgaBridgeClient>>();
  private ptys = new Map<string, PtyAttachment>();
  private pendingAuth = new Map<string, PendingDeviceAuth>();
  private updateState: UpdateState;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private unsubBackend: (() => void) | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private backendVersion = "0.0.0";

  constructor(
    readonly backend: TerminalBackend,
    private readonly opts: DaemonOptions = {}
  ) {
    this.version = opts.version ?? BRIDGE_VERSION;
    this.log = opts.log ?? ((line) => console.error(`[erga-bridge] ${line}`));
    this.id = `${backend.id}-${
      hostname()
        .replace(/[^a-zA-Z0-9-]+/g, "")
        .slice(0, 20) || "local"
    }`;
    this.updateState = { at: "idle", version: this.version };
  }

  /** Connects to the local PTY backend, subscribes to live OSC 7501 + space events, and restores saved bindings. */
  async start(): Promise<void> {
    const info = await this.backend.connect();
    this.backendVersion = info.version;
    this.unsubBackend = this.backend.subscribe((ev) => this.handleBackendEvent(ev));
    this.healthyTimer = setTimeout(() => markCurrentHealthy(), 5_000);
    await this.restoreBindings();
  }

  /** Starts the local Unix socket RPC server (~/.erga/bridge.sock, mode 0600). */
  startSocket(): void {
    const sock = daemonSocketPath();
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
          if (url.pathname == "/spaces") {
            const [spaces, terminals] = await Promise.all([this.backend.listSpaces(), this.backend.listTerminals()]);
            return Response.json({ ok: true, backend: this.backend.id, version: this.backendVersion, spaces, terminals });
          }
          if (url.pathname == "/open" && req.method == "POST") {
            const body = (await req.json()) as OpenDocumentRequest;
            return Response.json(await this.openDocument(body));
          }
          if (url.pathname == "/unmount" && req.method == "POST") {
            const body = (await req.json()) as { origin?: string; docId: string };
            return Response.json({ ok: await this.unmountDocument(body.docId, body.origin) });
          }
          if (url.pathname == "/connect" && req.method == "POST") {
            const body = (await req.json()) as { origin?: string };
            const origin = normalizeOrigin(body.origin || this.opts.defaultOrigin || defaultOrigin());
            await this.connectOrigin(origin, { interactive: false });
            return Response.json({ ok: true, origin });
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
      backend: this.backend.id,
      backendVersion: this.backendVersion,
      updateState: this.updateState,
      bridges: [...this.bridges.entries()].map(([origin, b]) => ({ origin, connected: b.connected })),
      mounts: [...this.mounts.values()].map((m) => ({
        origin: m.origin,
        docId: m.docId,
        url: `${m.origin}/${m.owner}/${m.slug}`,
        dir: m.dir,
        scope: m.scope,
        spaceName: m.spaceName,
        terminals: m.terminals.map((t) => ({ id: t.id, label: t.label, status: t.status?.state ?? "idle" })),
        activeTerminal: m.activeTerminal,
      })),
    };
  }

  /** Connects (or returns existing) outbound WebSocket bridge for `origin`. */
  async connectOrigin(rawOrigin: string, opts: { interactive?: boolean } = {}): Promise<ErgaBridgeClient> {
    const origin = normalizeOrigin(rawOrigin);
    const existing = this.bridges.get(origin);
    if (existing) return existing;
    const inflight = this.connectingOrigins.get(origin);
    if (inflight) return inflight;

    const promise = (async () => {
      const token = await getAccessToken(origin, CLIENT_NAME, { interactive: opts.interactive, log: this.log });
      if (!token) throw new Error(`Not signed in to ${origin}. Run erga-agent login.`);
      const client = new ErgaBridgeClient({
        origin,
        id: this.id,
        backend: this.backend.id,
        label: this.backend.label,
        version: this.version,
        token: async () => {
          const t = await getAccessToken(origin, CLIENT_NAME, { interactive: false, log: this.log });
          if (!t) throw new Error(`No token for ${origin}`);
          return t;
        },
        onMessage: (msg) => void this.handleBridgeMessage(origin, msg),
        log: this.log,
      });
      this.bridges.set(origin, client);
      try {
        await client.start();
      } catch (e) {
        this.bridges.delete(origin);
        client.stop();
        throw e;
      }
      return client;
    })().finally(() => this.connectingOrigins.delete(origin));

    this.connectingOrigins.set(origin, promise);
    return promise;
  }

  /** Opens/creates an Erga document, mounts YjsDiskSync, and binds a single terminal or whole space. */
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

    const meta = await resolveDocument(origin, CLIENT_NAME, docRef);
    const key = mountKey(origin, meta.id);
    const target = await this.backend.resolveTarget({
      space: req.space,
      terminal: req.terminal,
      env: req.env ?? process.env,
      cwd: req.cwd,
    });

    let mount = this.mounts.get(key);
    if (!mount) {
      let pending = this.openingMounts.get(key);
      if (!pending) {
        pending = (async () => {
          const dir = managedDocDir(ergaHome(), origin, meta.owner, meta.slug);
          const sync = new YjsDiskSync({
            origin,
            docId: meta.id,
            dir,
            token: async () => {
              const t = await getAccessToken(origin, CLIENT_NAME, { interactive: false, log: this.log });
              if (!t) throw new Error(`No token for ${origin}`);
              return t;
            },
            log: this.log,
          });
          await sync.start();
          const m: MountedDoc = {
            origin,
            docId: meta.id,
            owner: meta.owner,
            slug: meta.slug,
            title: meta.title,
            dir,
            sync,
            scope: target.scope,
            spaceId: target.spaceId,
            spaceName: target.spaceName,
            terminals: [...target.terminals],
            activeTerminal: target.activeTerminal,
          };
          this.mounts.set(key, m);
          return m;
        })().finally(() => this.openingMounts.delete(key));
        this.openingMounts.set(key, pending);
      }
      mount = await pending;
    } else {
      mount.scope = target.scope;
      mount.spaceId = target.spaceId;
      mount.spaceName = target.spaceName;
      mount.terminals = [...target.terminals];
      mount.activeTerminal = target.activeTerminal;
    }

    if (req.fromDir) {
      await copyIntoManaged(req.fromDir, mount.dir);
      await mount.sync.flush();
    }

    const bridge = await this.connectOrigin(origin, { interactive: !req.nonBlockingAuth });
    const label =
      mount.scope == "space"
        ? mount.spaceName || `${this.backend.label} space`
        : mount.terminals[0]?.label || (req.cwd ? `${this.backend.label} (${basename(req.cwd)})` : this.backend.label);
    bridge.bind(meta.id, {
      label,
      scope: mount.scope,
      spaceId: mount.spaceId,
      spaceName: mount.spaceName,
      terminals: mount.terminals,
      activeTerminal: mount.activeTerminal,
    });
    await this.persistBindings();

    return {
      ok: true,
      origin,
      docId: meta.id,
      url: `${origin}/${meta.owner}/${meta.slug}`,
      dir: mount.dir,
      title: meta.title,
      files: mount.sync.paths(),
      scope: mount.scope,
      spaceName: mount.spaceName,
      terminals: mount.terminals,
      activeTerminal: mount.activeTerminal,
      ...(req.fromDir ? { copiedFrom: req.fromDir } : {}),
    };
  }

  async unmountDocument(docId: string, rawOrigin?: string): Promise<boolean> {
    const mount = rawOrigin
      ? this.mounts.get(mountKey(normalizeOrigin(rawOrigin), docId))
      : [...this.mounts.values()].find((m) => m.docId == docId);
    if (!mount) return false;
    this.mounts.delete(mountKey(mount.origin, mount.docId));
    await mount.sync.flush().catch(() => {});
    await mount.sync.stop();
    for (const [k, att] of [...this.ptys.entries()]) {
      if (k.startsWith(`${mount.origin}\n${mount.docId}\n`)) {
        att.close();
        this.ptys.delete(k);
      }
    }
    this.bridges.get(mount.origin)?.unbind(mount.docId);
    await this.persistBindings();
    return true;
  }

  async stop(): Promise<void> {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.unsubBackend?.();
    for (const att of this.ptys.values()) att.close();
    this.ptys.clear();
    for (const m of this.mounts.values()) {
      await m.sync.flush().catch(() => {});
      await m.sync.stop().catch(() => {});
    }
    this.mounts.clear();
    for (const b of this.bridges.values()) b.stop();
    this.bridges.clear();
    await this.backend.close().catch(() => {});
    this.server?.stop(true);
    this.server = null;
    const sock = daemonSocketPath();
    if (existsSync(sock)) rmSync(sock, { force: true });
  }

  // ---------------------------------------------------------------- Erga -> local PTY relay

  private async handleBridgeMessage(origin: string, msg: ToBridge): Promise<void> {
    const bridge = this.bridges.get(origin);
    if (!bridge) return;

    if (msg.type == "update") {
      await this.applyUpdateOffer({ version: msg.version, sha256: msg.sha256, url: msg.url, minHcVersion: msg.minHcVersion });
      return;
    }

    if (msg.type == "pty_attach") {
      const k = ptyKey(origin, msg.doc, msg.terminal);
      this.ptys.get(k)?.close();
      this.ptys.delete(k);
      try {
        const att = await this.backend.attach(
          msg.terminal,
          { cols: msg.cols, rows: msg.rows },
          (bytes) => {
            bridge.send({ type: "pty_data", doc: msg.doc, terminal: msg.terminal, data: Buffer.from(bytes).toString("base64") });
          },
          (reason) => {
            if (this.ptys.get(k) === att) this.ptys.delete(k);
            bridge.send({ type: "pty_closed", doc: msg.doc, terminal: msg.terminal, ...(reason ? { reason } : {}) });
          }
        );
        this.ptys.set(k, att);
      } catch (e) {
        bridge.send({
          type: "pty_closed",
          doc: msg.doc,
          terminal: msg.terminal,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (msg.type == "pty_detach") {
      const k = ptyKey(origin, msg.doc, msg.terminal);
      this.ptys.get(k)?.close();
      this.ptys.delete(k);
      return;
    }

    if (msg.type == "pty_input") {
      const att = this.ptys.get(ptyKey(origin, msg.doc, msg.terminal));
      if (!att) return;
      att.write(new Uint8Array(Buffer.from(msg.data, "base64")));
      return;
    }

    if (msg.type == "pty_resize") {
      const att = this.ptys.get(ptyKey(origin, msg.doc, msg.terminal));
      att?.resize(msg.cols, msg.rows);
      return;
    }

    if (msg.type == "send") {
      const targetId = msg.terminal ?? (msg.doc ? this.mounts.get(mountKey(origin, msg.doc))?.activeTerminal : null);
      if (targetId) await this.backend.send(targetId, msg.text).catch((e) => this.log(`send failed: ${e}`));
      return;
    }

    if (msg.type == "interrupt") {
      const targetId = msg.terminal ?? (msg.doc ? this.mounts.get(mountKey(origin, msg.doc))?.activeTerminal : null);
      if (targetId) await this.backend.interrupt(targetId).catch((e) => this.log(`interrupt failed: ${e}`));
    }
  }

  // ---------------------------------------------------------------- backend -> Erga events

  private handleBackendEvent(ev: BackendEvent): void {
    if (ev.type == "spaces_changed" || ev.type == "resync") {
      void this.refreshAllMounts();
      return;
    }
    if (ev.type == "turn_done") {
      for (const m of this.mounts.values()) {
        if (!m.terminals.some((t) => t.id == ev.terminalId)) continue;
        void m.sync.flush().finally(() => {
          this.bridges.get(m.origin)?.send({ type: "turn_done", doc: m.docId, terminal: ev.terminalId });
        });
      }
      return;
    }
    if (ev.type == "terminal_removed") {
      for (const m of this.mounts.values()) {
        if (!m.terminals.some((t) => t.id == ev.terminalId)) continue;
        m.terminals = m.terminals.filter((t) => t.id != ev.terminalId);
        this.bridges.get(m.origin)?.updateTerminals(m.docId, m.terminals, m.spaceName);
      }
      return;
    }
    if (ev.type == "terminal_changed") {
      const t = ev.terminal;
      let spaceRefreshNeeded = false;
      for (const m of this.mounts.values()) {
        const idx = m.terminals.findIndex((x) => x.id == t.id);
        if (idx >= 0) {
          m.terminals = m.terminals.map((x, i) => (i == idx ? t : x));
          const anyWorking = m.terminals.some((x) => x.status?.state == "working");
          m.sync.setPresence({ busy: anyWorking, activity: anyWorking ? "working" : null });
          this.bridges.get(m.origin)?.updateTerminals(m.docId, m.terminals, m.spaceName);
        } else if (m.scope == "space" && t.parent && m.terminals.some((x) => x.id == t.parent)) {
          // A spawned child worker belongs to this bound space!
          spaceRefreshNeeded = true;
        }
      }
      if (spaceRefreshNeeded) void this.refreshAllMounts();
    }
  }

  private async refreshAllMounts(): Promise<void> {
    if (!this.mounts.size) return;
    const [spaces, live] = await Promise.all([this.backend.listSpaces(), this.backend.listTerminals()]).catch(() => [[], []] as const);
    const byId = new Map(live.map((t) => [t.id, t]));
    for (const m of this.mounts.values()) {
      if (m.scope == "space") {
        const sp = m.spaceId && m.spaceId != "all" ? spaces.find((s) => s.id == m.spaceId) : null;
        m.terminals = sp ? [...sp.terminals] : [...live];
        if (sp) m.spaceName = sp.name;
      } else {
        const singleId = m.activeTerminal ?? m.terminals[0]?.id;
        const found = singleId ? byId.get(singleId) : undefined;
        if (found) m.terminals = [found];
      }
      this.bridges.get(m.origin)?.updateTerminals(m.docId, m.terminals, m.spaceName);
    }
  }

  // ---------------------------------------------------------------- persistence & auto-update

  private async persistBindings(): Promise<void> {
    if (!this.backend.setState) return;
    const items: PersistedBinding[] = [...this.mounts.values()].map((m) => ({
      origin: m.origin,
      docId: m.docId,
      scope: m.scope,
      spaceId: m.spaceId,
      terminalId: m.scope == "single" ? (m.activeTerminal ?? m.terminals[0]?.id ?? null) : null,
    }));
    await this.backend.setState(BINDINGS_KEY, { bindings: items }).catch(() => {});
  }

  private async restoreBindings(): Promise<void> {
    if (!this.backend.getState) return;
    const saved = await this.backend.getState<{ bindings?: PersistedBinding[] }>(BINDINGS_KEY).catch(() => null);
    for (const b of saved?.bindings ?? []) {
      await this.openDocument({
        origin: b.origin,
        document: `/d/${b.docId}`,
        space: b.scope == "space" ? b.spaceId || true : false,
        terminal: b.terminalId ?? undefined,
        nonBlockingAuth: true,
      }).catch((e) => this.log(`restore ${b.docId} skipped: ${e instanceof Error ? e.message : e}`));
    }
  }

  async checkForUpdate(checkOnly = false): Promise<{ ok: boolean; updated?: boolean; version?: string; latest?: string; error?: string }> {
    const pinned = readPinnedOrigin();
    if (!pinned) return { ok: true, updated: false, version: this.version };
    try {
      const manifest = await fetchUpdateManifest(pinned);
      if (manifest.version == this.version) return { ok: true, updated: false, version: this.version, latest: manifest.version };
      if (checkOnly) return { ok: true, updated: false, version: this.version, latest: manifest.version };
      const swapped = await this.applyUpdateOffer(manifest);
      return { ok: true, updated: swapped, version: this.version, latest: manifest.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async applyUpdateOffer(manifest: UpdateManifest): Promise<boolean> {
    if (process.env.ERGA_BRIDGE_DEV == "1" || this.version == "dev") return false;
    const pinned = readPinnedOrigin();
    if (!pinned) return false;
    const step1 = updateStep(this.updateState, { on: "manifest", manifest });
    this.updateState = step1.state;
    if (!step1.effects.some((e) => e.do == "download_and_swap")) return false;

    try {
      const res = await downloadAndSwap(pinned, manifest);
      const step2 = updateStep(this.updateState, { on: "swapped", nextVersion: res.version, bundlePath: res.bundlePath });
      this.updateState = step2.state;
      for (const m of this.mounts.values()) await m.sync.flush().catch(() => {});
      await this.persistBindings();
      this.log(`updated bridge ${this.version} -> ${res.version}`);
      if (this.opts.onRestart) this.opts.onRestart(res.version);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.updateState = updateStep(this.updateState, { on: "fail", message: msg }).state;
      this.log(`update failed: ${msg}`);
      return false;
    }
  }

  private async beginNonBlockingAuth(origin: string): Promise<Extract<OpenDocumentResult, { needsAuth: true }>> {
    let pending = this.pendingAuth.get(origin);
    if (!pending || Date.now() >= pending.expiresAt - 15_000) {
      pending = await startDeviceLogin(origin, CLIENT_NAME);
      this.pendingAuth.set(origin, pending);
      const active = pending;
      void waitForDeviceLogin(active)
        .then(() => {
          if (this.pendingAuth.get(origin) === active) this.pendingAuth.delete(origin);
          void this.connectOrigin(origin, { interactive: false }).catch(() => {});
        })
        .catch(() => {
          if (this.pendingAuth.get(origin) === active) this.pendingAuth.delete(origin);
        });
    }
    return {
      ok: false,
      needsAuth: true,
      origin,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      userCode: pending.userCode,
      message: `Sign in to ${origin} in any browser: ${pending.verificationUriComplete} (code: ${pending.userCode}).`,
    };
  }
}
