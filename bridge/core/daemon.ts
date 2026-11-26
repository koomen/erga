// Shared background daemon (100% agent-agnostic; takes an AgentDriver).
// Runs locally over a Unix domain socket (~/.erga/daemon.<agent>.sock) and
// coordinates all three capabilities:
//   (1) Local Yjs rooms mirrored to disk (YjsDiskSync)
//   (2) Shared OAuth authentication for Erga API / MCP
//   (3) Outbound WebSocket to /api/agent/bridge: routes prompts directly into an
//       attached live terminal session (when present, no second process spawned)
//       or falls back to an AgentDriver subprocess (e.g. `agy acp`) for headless runs.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ignored } from "../../document/model/pages.ts";
import type { LogEvent } from "../../shared/agent-log.ts";
import type { ToBridge } from "../../shared/bridge-protocol.ts";
import {
  DEFAULT_ORIGIN,
  ergaFetch,
  ergaHome,
  getAccessToken,
  normalizeOrigin,
  startDeviceLogin,
  waitForDeviceLogin,
  type PendingDeviceAuth,
} from "./auth.ts";
import { ErgaBridgeClient } from "./bridge-client.ts";
import type { AgentDriver, AgentHandle, DriverEvent, LocalAttachment, McpServerSpec } from "./driver.ts";
import { managedDocDir, YjsDiskSync, type SyncStatus } from "./yjs-sync.ts";
import { findSession, hookEvents, recordSession, type HookPayload } from "./sessions.ts";
import {
  AntigravityTranscriptMirror,
  defaultLiveAntigravityMessenger,
  defaultTranscriptPath,
  type LiveAntigravityMessenger,
  type LiveAntigravitySession,
} from "../drivers/antigravity.ts";

export interface MountedDoc {
  origin: string;
  docId: string;
  owner: string;
  slug: string;
  title: string;
  url: string;
  dir: string;
  cwd: string;
  conversationId: string | null;
  transcriptPath: string | null;
  status: SyncStatus;
  sync: YjsDiskSync;
  mirror: AntigravityTranscriptMirror | null;
}

interface ActiveThread {
  origin: string;
  doc: string | null;
  handle: AgentHandle;
  unsub: () => void;
  sessionId: string;
  /** A prompt from the browser runs in this thread now. */
  busy: boolean;
}

interface ActiveLiveTurn {
  origin: string;
  doc: string;
  poll: ReturnType<typeof setInterval> | null;
  sawRunning: boolean;
  idlePolls: number;
}

export interface OpenDocRequest {
  origin?: string;
  document?: string;
  create?: boolean;
  title?: string;
  slug?: string;
  template?: string;
  /** Optional local folder whose files are copied into the new document's managed directory. */
  fromDir?: string;
  cwd?: string;
  conversationId?: string;
  transcriptPath?: string;
  /** Documented Antigravity live language server address (kept in daemon RAM only). */
  lsAddress?: string;
  /** Documented Antigravity CSRF token for `lsAddress` (kept in daemon RAM only). */
  csrfToken?: string;
  appDataDir?: string;
  label?: string;
  /** When true (MCP / agent calls), returns a device-code URL immediately instead of blocking on login. */
  nonBlockingAuth?: boolean;
}

export interface AttachLiveRequest {
  conversationId: string;
  lsAddress: string;
  csrfToken: string;
  cwd?: string;
  transcriptPath?: string;
  appDataDir?: string;
  docId?: string;
}

export interface NeedsAuthResult {
  ok: false;
  needsAuth: true;
  origin: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  message: string;
}

export interface OpenDocSuccess {
  ok: true;
  origin: string;
  docId: string;
  owner: string;
  slug: string;
  title: string;
  url: string;
  dir: string;
  copiedFrom?: string;
  liveAttached: boolean;
  attachCommand?: string;
  note: string;
  files: string[];
  connected: boolean;
}

export function daemonSocketPath(agentId: string): string {
  return join(ergaHome(), `daemon.${agentId}.sock`);
}

/** Parses an Erga document URL, `/<owner>/<slug>`, `/d/<id>`, or bare id. */
export function parseDocumentRef(ref: string, fallbackOrigin = DEFAULT_ORIGIN): { origin: string; ref: string } {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const cleanPath = u.pathname.replace(/\/+$/, "") || "/";
    return { origin: u.origin, ref: cleanPath };
  }
  return { origin: normalizeOrigin(fallbackOrigin), ref: trimmed };
}

export class ErgaDaemon {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private mounts = new Map<string, MountedDoc>();
  private bridges = new Map<string, ErgaBridgeClient>();
  private threads = new Map<string, ActiveThread>();
  private pendingLogins = new Map<string, { pending: PendingDeviceAuth; abort: AbortController }>();
  /** In-memory live session handles keyed by conversationId (never written to disk or returned in /status). */
  private liveSessions = new Map<string, LiveAntigravitySession>();
  /** Conversations with an in-flight browser-injected turn waiting for Stop or idle poll. */
  private activeLiveTurns = new Map<string, ActiveLiveTurn>();
  /** Conversations where the user clicked Stop in the browser pane (consumed on next hook). */
  private abortingConversations = new Set<string>();
  private defaultCwd: string;
  private bridgeId: string;
  private live: LiveAntigravityMessenger;

  constructor(
    private readonly driver: AgentDriver,
    private readonly opts: {
      defaultOrigin?: string;
      defaultCwd?: string;
      autoApprove?: boolean;
      mode?: string | null;
      mcpSpec?: (origin: string) => McpServerSpec;
      liveMessenger?: LiveAntigravityMessenger;
      log?: (line: string) => void;
    } = {}
  ) {
    this.defaultCwd = opts.defaultCwd ?? process.cwd();
    const host = (process.env.HOSTNAME || "local").replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 24) || "local";
    this.bridgeId = `${driver.id}-${host}`;
    this.live = opts.liveMessenger ?? defaultLiveAntigravityMessenger;
  }

  private log(msg: string): void {
    this.opts.log?.(`[daemon:${this.driver.id}] ${msg}`);
  }

  private mountKey(origin: string, docId: string): string {
    return `${normalizeOrigin(origin)}\n${docId}`;
  }

  private threadKey(origin: string, doc: string | null): string {
    return `${normalizeOrigin(origin)}\n${doc ?? ""}`;
  }

  /** Starts the local Unix-socket RPC server (owner-only 0600 permissions). */
  startSocket(socketPath = daemonSocketPath(this.driver.id)): void {
    mkdirSync(ergaHome(), { recursive: true });
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    this.server = Bun.serve({
      unix: socketPath,
      fetch: (req) => this.handleRpc(req),
    });
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      /* ignore on platforms without chmod on sockets */
    }
    writeFileSync(join(ergaHome(), `daemon.${this.driver.id}.pid`), `${process.pid}\n`);
    this.log(`listening on ${socketPath}`);
  }

  /** Registers an already-running Antigravity CLI session in daemon RAM and attaches matching mounted docs. */
  attachLiveSession(req: AttachLiveRequest): { ok: true; conversationId: string; liveAttached: true; attachedDocs: string[] } {
    const cwd = req.cwd || this.defaultCwd;
    const discovered = findSession(this.driver.id, { conversationId: req.conversationId, cwd });
    const transcriptPath = req.transcriptPath ?? discovered?.transcriptPath ?? defaultTranscriptPath(req.conversationId, req.appDataDir);
    const live: LiveAntigravitySession = {
      conversationId: req.conversationId,
      lsAddress: req.lsAddress,
      csrfToken: req.csrfToken,
      cwd,
      transcriptPath,
    };
    this.liveSessions.set(req.conversationId, live);
    recordSession(this.driver.id, { conversationId: req.conversationId, cwd, ...(transcriptPath ? { transcriptPath } : {}) });

    const attachedDocs: string[] = [];
    for (const m of this.mounts.values()) {
      const matches = req.docId ? m.docId == req.docId : m.conversationId == req.conversationId || m.cwd == cwd || !m.conversationId;
      if (!matches) continue;
      m.conversationId = req.conversationId;
      m.cwd = cwd;
      this.ensureMirror(m, transcriptPath);
      const b = this.bridges.get(m.origin);
      if (b) {
        const folderLabel = basename(cwd);
        const label = folderLabel && cwd != m.dir ? `${this.driver.label} (${folderLabel})` : this.driver.label;
        b.bind(m.docId, { label, sessionId: m.conversationId, cwd: m.cwd });
      }
      attachedDocs.push(m.docId);
    }
    this.log(`attached live session ${req.conversationId} (${attachedDocs.length} doc(s))`);
    return { ok: true, conversationId: req.conversationId, liveAttached: true, attachedDocs };
  }

  private ensureMirror(mounted: MountedDoc, transcriptPath: string | null): void {
    if (this.driver.id != "antigravity" || !transcriptPath) return;
    if (mounted.transcriptPath == transcriptPath && mounted.mirror) return;
    mounted.mirror?.stop();
    mounted.transcriptPath = transcriptPath;
    mounted.mirror = new AntigravityTranscriptMirror(transcriptPath, (evs) => {
      const b = this.bridges.get(mounted.origin);
      if (!b) return;
      for (const ev of evs) this.forwardDriverEvent(b, mounted.docId, ev);
    });
    mounted.mirror.start(false);
  }

  /** Connects the global bridge to `origin` so every Erga doc sees this local agent. */
  async connectOrigin(rawOrigin: string, opts: { interactive?: boolean; label?: string } = {}): Promise<ErgaBridgeClient> {
    const origin = normalizeOrigin(rawOrigin);
    let client = this.bridges.get(origin);
    if (client) {
      if (!client.connected) await client.start();
      return client;
    }
    const tok = await getAccessToken(origin, this.driver.label, { interactive: opts.interactive !== false, log: (s) => this.log(s) });
    if (!tok) throw new Error(`Not signed in to ${origin}.`);
    client = new ErgaBridgeClient({
      origin,
      id: this.bridgeId,
      agent: this.driver.id,
      label: opts.label || this.driver.label,
      token: async () => {
        const t = await getAccessToken(origin, this.driver.label, { interactive: false });
        if (!t) throw new Error(`Token expired for ${origin}`);
        return t;
      },
      onMessage: (msg) => void this.handleBridgeMessage(origin, msg),
      onStatus: (up) => this.log(`bridge ${origin}: ${up ? "connected" : "disconnected"}`),
      log: (s) => this.log(s),
    });
    this.bridges.set(origin, client);
    await client.start();
    return client;
  }

  /** Starts (or reuses) a background device-code login for `rawOrigin` and returns the verification prompt. */
  async startAuth(rawOrigin: string): Promise<NeedsAuthResult> {
    const origin = normalizeOrigin(rawOrigin);
    let active = this.pendingLogins.get(origin);
    if (active && active.pending.expiresAt <= Date.now() + 15_000) {
      active.abort.abort();
      this.pendingLogins.delete(origin);
      active = undefined;
    }
    if (!active) {
      const pending = await startDeviceLogin(origin, this.driver.label);
      const abort = new AbortController();
      this.pendingLogins.set(origin, { pending, abort });
      void waitForDeviceLogin(pending, { signal: abort.signal })
        .then(
          () => this.log(`device sign-in approved for ${origin}`),
          (e) => this.log(`device sign-in ended for ${origin}: ${e instanceof Error ? e.message : e}`)
        )
        .finally(() => {
          if (this.pendingLogins.get(origin)?.abort === abort) this.pendingLogins.delete(origin);
        });
      active = { pending, abort };
    }
    const { pending } = active;
    const expiresIn = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
    return {
      ok: false,
      needsAuth: true,
      origin,
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresIn,
      message: `Sign in to ${origin}: open ${pending.verificationUriComplete} in any browser (local or remote) and approve code ${pending.userCode}. Then retry your request.`,
    };
  }

  /** Opens (or creates) an Erga document, mounts its local Yjs room, and binds the browser agent pane. */
  async openDocument(req: OpenDocRequest): Promise<OpenDocSuccess | NeedsAuthResult> {
    const parsed = req.document
      ? parseDocumentRef(req.document, req.origin ?? this.opts.defaultOrigin ?? DEFAULT_ORIGIN)
      : { origin: normalizeOrigin(req.origin ?? this.opts.defaultOrigin ?? DEFAULT_ORIGIN), ref: "" };
    const origin = parsed.origin;

    // Register live session handle immediately (even if auth is pending) so it stays ready after approval.
    if (this.driver.id == "antigravity" && req.conversationId && req.lsAddress && req.csrfToken) {
      const cwd = req.cwd ?? this.defaultCwd;
      const tp = req.transcriptPath ?? defaultTranscriptPath(req.conversationId, req.appDataDir);
      this.liveSessions.set(req.conversationId, {
        conversationId: req.conversationId,
        lsAddress: req.lsAddress,
        csrfToken: req.csrfToken,
        cwd,
        transcriptPath: tp,
      });
    }

    const existingTok = await getAccessToken(origin, this.driver.label, { interactive: false });
    if (!existingTok) {
      if (req.nonBlockingAuth) return this.startAuth(origin);
      await getAccessToken(origin, this.driver.label, { interactive: true, log: (s) => this.log(s) });
    }

    let docId = "";
    let owner = "";
    let slug = "";
    let title = "";
    let docUrl = "";

    if (req.create) {
      const createRes = await ergaFetch(
        origin,
        this.driver.label,
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
        { interactive: true }
      );
      const data = (await createRes.json()) as {
        ok?: boolean;
        error?: string;
        result?: { id?: string; address?: string; url?: string; title?: string };
      };
      if (!createRes.ok || !data.ok || !data.result?.id) {
        throw new Error(data.error || `create_document failed (${createRes.status})`);
      }
      docId = data.result.id;
      const addr = (data.result.address || "").replace(/^\/+/, "");
      const parts = addr.split("/");
      owner = parts[0] || "doc";
      slug = parts[1] || docId;
      title = data.result.title || slug;
      docUrl = data.result.url || `${origin}/${owner}/${slug}`;
    } else {
      if (!parsed.ref) throw new Error("Provide either `document` (URL, /owner/slug, or id) or `create: true`.");
      const meta = await this.resolveDocument(origin, parsed.ref);
      docId = meta.id;
      owner = meta.owner;
      slug = meta.slug;
      title = meta.title;
      docUrl = `${origin}/${owner}/${slug}`;
    }

    const discovered = findSession(this.driver.id, { conversationId: req.conversationId, cwd: req.cwd });
    const conversationId = req.conversationId ?? discovered?.conversationId ?? null;
    const liveFromMap = conversationId
      ? this.liveSessions.get(conversationId)
      : [...this.liveSessions.values()].find((s) => req.cwd && s.cwd == req.cwd);
    const effectiveConversationId = conversationId ?? liveFromMap?.conversationId ?? null;
    const transcriptPath =
      req.transcriptPath ??
      liveFromMap?.transcriptPath ??
      discovered?.transcriptPath ??
      (effectiveConversationId ? defaultTranscriptPath(effectiveConversationId, req.appDataDir) : null);
    const sessionCwd = req.cwd ?? liveFromMap?.cwd ?? discovered?.cwd ?? this.defaultCwd;

    const key = this.mountKey(origin, docId);
    let mounted = this.mounts.get(key);
    let copiedFrom: string | null = null;
    if (!mounted) {
      const dir = managedDocDir(ergaHome(), origin, owner, slug);
      const sync = new YjsDiskSync({
        origin,
        docId,
        dir,
        token: async () => {
          const t = await getAccessToken(origin, this.driver.label, { interactive: false });
          if (!t) throw new Error(`Not signed in to ${origin}`);
          return t;
        },
        onStatus: (s) => {
          if (mounted) mounted.status = s;
        },
        log: (s) => this.log(s),
      });
      await sync.start();

      mounted = {
        origin,
        docId,
        owner,
        slug,
        title,
        url: docUrl,
        dir,
        cwd: sessionCwd,
        conversationId: effectiveConversationId,
        transcriptPath: null,
        status: "synced",
        sync,
        mirror: null,
      };
      this.ensureMirror(mounted, transcriptPath);
      this.mounts.set(key, mounted);
    } else {
      if (effectiveConversationId) mounted.conversationId = effectiveConversationId;
      if (sessionCwd) mounted.cwd = sessionCwd;
      this.ensureMirror(mounted, transcriptPath);
    }

    if (req.fromDir) {
      const src = resolve(sessionCwd, req.fromDir);
      await copyIntoManaged(src, mounted.dir);
      await mounted.sync.flush();
      copiedFrom = src;
    }

    const bridge = await this.connectOrigin(origin, { interactive: true });
    const folderLabel = basename(sessionCwd);
    const label = req.label || (folderLabel && sessionCwd != mounted.dir ? `${this.driver.label} (${folderLabel})` : this.driver.label);
    bridge.bind(docId, { label, sessionId: mounted.conversationId, cwd: mounted.cwd });

    const liveAttached = !!(mounted.conversationId && this.liveSessions.has(mounted.conversationId));
    const attachNote =
      !liveAttached && this.driver.id == "antigravity"
        ? " Run `erga-agent attach` via run_command so Erga's browser panel routes prompts directly into THIS running Antigravity session."
        : "";
    const note =
      (copiedFrom
        ? `Copied files from ${copiedFrom} into the managed Erga directory ${mounted.dir}. Tell the user that live edits happen in ${mounted.dir} and their original folder is untouched.`
        : `Live Yjs sync active in managed Erga directory ${mounted.dir}. Tell the user where the synced copy lives if they ask.`) +
      attachNote;

    return {
      ok: true,
      origin,
      docId,
      owner,
      slug,
      title,
      url: docUrl,
      dir: mounted.dir,
      ...(copiedFrom ? { copiedFrom } : {}),
      liveAttached,
      ...(!liveAttached && this.driver.id == "antigravity" ? { attachCommand: "erga-agent attach" } : {}),
      note,
      files: mounted.sync.paths(),
      connected: bridge.connected,
    };
  }

  async unmountDocument(rawOrigin: string, docId: string): Promise<boolean> {
    const origin = normalizeOrigin(rawOrigin);
    const key = this.mountKey(origin, docId);
    const mounted = this.mounts.get(key);
    if (!mounted) return false;
    if (mounted.conversationId) this.clearLiveTurn(mounted.conversationId);
    await mounted.sync.flush().catch(() => {});
    await mounted.sync.stop();
    mounted.mirror?.stop();
    this.mounts.delete(key);
    this.bridges.get(origin)?.unbind(docId);
    const tKey = this.threadKey(origin, docId);
    const thread = this.threads.get(tKey);
    if (thread) {
      thread.unsub();
      await thread.handle.close();
      this.threads.delete(tKey);
    }
    return true;
  }

  status() {
    return {
      pid: process.pid,
      agent: this.driver.id,
      label: this.driver.label,
      bridgeId: this.bridgeId,
      bridges: [...this.bridges.entries()].map(([origin, b]) => ({ origin, connected: b.connected })),
      mounts: [...this.mounts.values()].map((m) => ({
        origin: m.origin,
        docId: m.docId,
        url: m.url,
        dir: m.dir,
        cwd: m.cwd,
        conversationId: m.conversationId,
        liveAttached: !!(m.conversationId && this.liveSessions.has(m.conversationId)),
        status: m.status,
        files: m.sync.paths(),
      })),
    };
  }

  async stop(): Promise<void> {
    for (const p of this.pendingLogins.values()) p.abort.abort();
    this.pendingLogins.clear();
    for (const cid of [...this.activeLiveTurns.keys()]) this.clearLiveTurn(cid);
    this.liveSessions.clear();
    this.abortingConversations.clear();
    for (const m of [...this.mounts.values()]) {
      await m.sync.flush().catch(() => {});
      await m.sync.stop();
      m.mirror?.stop();
    }
    this.mounts.clear();
    for (const t of this.threads.values()) {
      t.unsub();
      await t.handle.close().catch(() => {});
    }
    this.threads.clear();
    for (const b of this.bridges.values()) b.stop();
    this.bridges.clear();
    this.server?.stop(true);
    this.server = null;
    try {
      rmSync(daemonSocketPath(this.driver.id), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- document lookup

  private async resolveDocument(origin: string, ref: string): Promise<{ id: string; owner: string; slug: string; title: string }> {
    const clean = ref.replace(/^\/+|\/+$/g, "");
    const parts = clean.split("/");
    const docPath =
      parts[0] == "d" && parts[1]
        ? `/d/${parts[1]}/api/doc`
        : parts.length >= 2
          ? `/${parts[0]}/${parts[1]}/api/doc`
          : `/d/${parts[0]}/api/doc`;
    const res = await ergaFetch(origin, this.driver.label, docPath, {}, { interactive: true });
    if (res.ok) {
      const info = (await res.json()) as {
        docName?: { id?: string; owner?: string; slug?: string; title?: string; address?: string };
        name?: string;
        dir?: string;
      };
      const id = info.docName?.id || (parts[0] == "d" ? parts[1] : parts.length == 1 ? parts[0] : "");
      if (id) {
        const owner = info.docName?.owner || info.dir || parts[0] || "doc";
        const slug = info.docName?.slug || parts[1] || id;
        const title = info.docName?.title || slug;
        return { id, owner, slug, title };
      }
    }
    const listRes = await ergaFetch(
      origin,
      this.driver.label,
      "/api/tools/list_documents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      },
      { interactive: true }
    );
    if (listRes.ok) {
      const payload = (await listRes.json()) as {
        ok?: boolean;
        result?: { documents?: { id: string; address: string; title: string }[] };
      };
      const docs = payload.result?.documents ?? [];
      const needle = `/${clean}`.toLowerCase();
      const hit = docs.find((d) => d.id == clean || d.address.toLowerCase() == needle || needle.startsWith(`${d.address.toLowerCase()}/`));
      if (hit) {
        const [, o = "doc", s = hit.id] = hit.address.split("/");
        return { id: hit.id, owner: o, slug: s, title: hit.title || s };
      }
    }
    throw new Error(`Could not find Erga document "${ref}" on ${origin} (status ${res.status}).`);
  }

  // ---------------------------------------------------------------- live turn lifecycle & hooks

  private clearLiveTurn(conversationId: string): void {
    const active = this.activeLiveTurns.get(conversationId);
    if (!active) return;
    if (active.poll) clearInterval(active.poll);
    this.activeLiveTurns.delete(conversationId);
  }

  private async finishLiveTurn(conversationId: string, mounted: MountedDoc): Promise<void> {
    this.clearLiveTurn(conversationId);
    mounted.mirror?.poke();
    await mounted.sync.flush().catch(() => {});
    mounted.sync.setPresence({ busy: false, activity: null });
    const bridge = this.bridges.get(mounted.origin);
    if (bridge) {
      bridge.send({ type: "event", doc: mounted.docId, ev: { t: "busy", busy: false } });
      bridge.send({ type: "turn_done", doc: mounted.docId });
    }
  }

  /** Handles one plugin hook callback of the agent's own session (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`). */
  async handleHook(payload: HookPayload): Promise<Record<string, unknown>> {
    const evName = payload.hookEventName;
    const defaultReply = evName == "PreToolUse" ? { decision: "allow" } : {};
    recordSession(this.driver.id, payload);
    const cid = payload.conversationId;
    if (!cid) return defaultReply;

    // Honor browser Stop requests cleanly on the very next hook point.
    if (this.abortingConversations.has(cid)) {
      if (evName == "Stop") {
        this.abortingConversations.delete(cid);
      } else if (evName == "PreToolUse") {
        return { decision: "deny", reason: "Stopped from Erga browser panel." };
      } else if (evName == "PreInvocation" || evName == "PostInvocation") {
        return { terminationBehavior: "terminate" };
      }
    }

    const matching = [...this.mounts.values()].filter((m) => m.conversationId == cid);
    if (!matching.length) return defaultReply;

    const translated = hookEvents(payload);
    for (const m of matching) {
      if (payload.transcriptPath) this.ensureMirror(m, payload.transcriptPath);
      // Do not mix events into a turn that the agent's own subprocess streams for this doc now.
      if (this.threads.get(this.threadKey(m.origin, m.docId))?.busy) continue;
      const bridge = this.bridges.get(m.origin);
      if (!bridge) continue;

      if (evName == "PreInvocation") {
        m.mirror?.poke();
        if (payload.invocationNum === 0) {
          m.sync.setPresence({ busy: true, activity: "thinking" });
          if (!this.activeLiveTurns.has(cid)) {
            // A turn that started in the terminal: the panel shows what the user typed there.
            for (const ev of translated) this.forwardDriverEvent(bridge, m.docId, ev);
            bridge.send({ type: "event", doc: m.docId, ev: { t: "busy", busy: true } });
          }
        }
      } else if (evName == "PreToolUse" || evName == "PostToolUse") {
        m.mirror?.setSkipToolCalls(true);
        for (const ev of translated) {
          if (ev.t == "tool") {
            m.sync.setPresence({ busy: true, activity: ev.status == "running" ? ev.name : "working" });
          }
          this.forwardDriverEvent(bridge, m.docId, ev);
        }
        if (evName == "PostToolUse") m.mirror?.poke();
      } else if (evName == "PostInvocation") {
        m.mirror?.poke();
      } else if (evName == "Stop") {
        m.mirror?.poke();
        if (payload.fullyIdle !== false && !payload.continuationActive) {
          this.clearLiveTurn(cid);
          await m.sync.flush().catch(() => {});
          m.sync.setPresence({ busy: false, activity: null });
          for (const ev of translated) this.forwardDriverEvent(bridge, m.docId, ev);
        }
      }
    }
    return defaultReply;
  }

  // ---------------------------------------------------------------- browser <-> local agent routing

  private async handleBridgeMessage(origin: string, msg: ToBridge): Promise<void> {
    const bridge = this.bridges.get(origin);
    if (!bridge) return;
    const tKey = this.threadKey(origin, msg.doc);
    const mountedForDoc = msg.doc ? this.mounts.get(this.mountKey(origin, msg.doc)) : undefined;

    if (msg.type == "abort") {
      if (mountedForDoc?.conversationId && this.liveSessions.has(mountedForDoc.conversationId)) {
        this.abortingConversations.add(mountedForDoc.conversationId);
        this.clearLiveTurn(mountedForDoc.conversationId);
        mountedForDoc.sync.setPresence({ busy: false, activity: null });
        bridge.send({ type: "event", doc: msg.doc, ev: { t: "busy", busy: false } });
      }
      await this.threads.get(tKey)?.handle.abort();
      return;
    }

    if (msg.type == "reset") {
      const existing = this.threads.get(tKey);
      if (existing) {
        existing.unsub();
        await existing.handle.close();
        this.threads.delete(tKey);
      }
      if (mountedForDoc) {
        if (mountedForDoc.conversationId) {
          this.clearLiveTurn(mountedForDoc.conversationId);
          this.abortingConversations.delete(mountedForDoc.conversationId);
        }
        mountedForDoc.conversationId = null;
        mountedForDoc.mirror?.stop();
        mountedForDoc.mirror = null;
        mountedForDoc.transcriptPath = null;
      }
      return;
    }

    if (msg.type == "answer") {
      const existing = this.threads.get(tKey);
      if (existing) await existing.handle.answer(msg.id, msg.approve, msg.choice);
      return;
    }

    if (msg.type == "model") {
      await this.threads.get(tKey)?.handle.setModel?.(msg.model);
      return;
    }

    if (msg.type == "prompt") {
      try {
        let mounted = mountedForDoc;
        if (msg.doc && !mounted) {
          await this.openDocument({ origin, document: `/d/${msg.doc}` });
          mounted = this.mounts.get(this.mountKey(origin, msg.doc));
        }

        // Materialize browser attachments into a local ignored folder so any agent can inspect them by path.
        const attachments: LocalAttachment[] = [];
        if (msg.files?.length) {
          const baseDir = mounted?.dir ?? this.defaultCwd;
          const attDir = join(baseDir, ".erga-attachments");
          await mkdir(attDir, { recursive: true });
          for (const f of msg.files) {
            const safeName = `${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
            const abs = join(attDir, safeName);
            if (f.kind == "image") await writeFile(abs, Buffer.from(f.data, "base64"));
            else await writeFile(abs, f.data, "utf8");
            attachments.push({ kind: f.kind, name: f.name, type: f.mimeType, data: f.data, path: abs });
          }
        }

        const live = mounted?.conversationId ? this.liveSessions.get(mounted.conversationId) : undefined;
        if (live && mounted) {
          await this.promptLiveSession(origin, bridge, mounted, live, msg.text, msg.context, attachments);
          return;
        }

        // Never spawn a competing ACP process against an already-running interactive Antigravity conversation.
        if (this.driver.id == "antigravity" && mounted?.conversationId) {
          bridge.send({
            type: "event",
            doc: msg.doc,
            ev: {
              t: "error",
              text: "This document is linked to your Antigravity terminal session, but live prompt routing is not attached yet. Run `erga-agent attach` in that terminal (or click + New conversation to start a separate background session).",
            },
          });
          bridge.send({ type: "event", doc: msg.doc, ev: { t: "busy", busy: false } });
          return;
        }

        if (!this.threads.has(tKey)) {
          bridge.send({ type: "event", doc: msg.doc, ev: { t: "thinking", delta: `Starting ${this.driver.label} session…` } });
        }
        const thread = await this.ensureThread(origin, msg.doc, mounted ?? null);
        const promptText = this.formatPrompt(msg.text, msg.context, mounted ?? null);
        mounted?.sync.setPresence({ busy: true, activity: "working" });
        mounted?.mirror?.setSuppressed(true);
        thread.busy = true;
        try {
          await thread.handle.prompt({ text: promptText, attachments });
        } finally {
          thread.busy = false;
          await mounted?.sync.flush().catch(() => {});
          mounted?.sync.setPresence({ busy: false, activity: null });
          mounted?.mirror?.setSuppressed(false);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.log(`prompt failed on ${msg.doc ?? "general"}: ${message}`);
        bridge.send({ type: "event", doc: msg.doc, ev: { t: "error", text: message } });
        bridge.send({ type: "event", doc: msg.doc, ev: { t: "busy", busy: false } });
      }
    }
  }

  private async promptLiveSession(
    origin: string,
    bridge: ErgaBridgeClient,
    mounted: MountedDoc,
    live: LiveAntigravitySession,
    text: string,
    context: string | null,
    attachments: readonly LocalAttachment[]
  ): Promise<void> {
    this.abortingConversations.delete(live.conversationId);
    const attLines = attachments.filter((a) => a.path).map((a) => `Attached ${a.kind} "${a.name}" saved at: ${a.path}`);
    const fullText = attLines.length ? `${text}\n\n${attLines.join("\n")}` : text;
    const promptText = this.formatPrompt(fullText, context, mounted);

    mounted.sync.setPresence({ busy: true, activity: "working" });
    mounted.mirror?.setSuppressed(false);

    try {
      await this.live.send(live, promptText, { title: "Erga browser panel" });
    } catch (e) {
      this.liveSessions.delete(live.conversationId);
      mounted.sync.setPresence({ busy: false, activity: null });
      const detail = e instanceof Error ? e.message : String(e);
      bridge.send({
        type: "event",
        doc: mounted.docId,
        ev: {
          t: "error",
          text: `Could not reach your live Antigravity terminal session (${detail}). Run \`erga-agent attach\` in a running session, or click + New conversation for a background session.`,
        },
      });
      bridge.send({ type: "event", doc: mounted.docId, ev: { t: "busy", busy: false } });
      return;
    }

    // Track the live turn and add a safety poll in case the Stop hook does not fire.
    this.clearLiveTurn(live.conversationId);
    const turn: ActiveLiveTurn = { origin, doc: mounted.docId, poll: null, sawRunning: false, idlePolls: 0 };
    turn.poll = setInterval(() => {
      void this.live.check(live).then((st) => {
        if (!this.activeLiveTurns.has(live.conversationId)) return;
        mounted.mirror?.poke();
        if (st == "running") {
          turn.sawRunning = true;
          turn.idlePolls = 0;
        } else if (st == "gone") {
          this.liveSessions.delete(live.conversationId);
          void this.finishLiveTurn(live.conversationId, mounted);
        } else {
          turn.idlePolls++;
          if (turn.sawRunning || turn.idlePolls >= 3) {
            void this.finishLiveTurn(live.conversationId, mounted);
          }
        }
      });
    }, 2_000);
    this.activeLiveTurns.set(live.conversationId, turn);
  }

  private async ensureThread(origin: string, doc: string | null, mounted: MountedDoc | null): Promise<ActiveThread> {
    const tKey = this.threadKey(origin, doc);
    const existing = this.threads.get(tKey);
    if (existing) return existing;

    const cwd = mounted?.cwd ?? mounted?.dir ?? this.defaultCwd;
    const addDirs = mounted && mounted.dir != cwd ? [mounted.dir] : [];
    const mcpServers = this.opts.mcpSpec ? [this.opts.mcpSpec(origin)] : [];
    const systemPromptAppend = mounted
      ? `You are connected to Erga document ${mounted.url} (id: ${mounted.docId}). Its files are live-synced via Yjs in local directory: ${mounted.dir}. Read and edit the document's files directly in that local directory with your native file tools; changes sync live to the user's browser. Use the Erga MCP tools (page, documents, read, edit, comments, versions) for page previews, live console logs, comments, publishing, or other Erga documents.`
      : `You are connected to Erga (${origin}). Use the Erga MCP tools (erga_open, documents, read, edit, page) to open, create, or edit documents.`;

    const handle = await this.driver.open({
      cwd,
      addDirs,
      mcpServers,
      resumeId: null,
      systemPromptAppend,
      autoApprove: this.opts.autoApprove,
      mode: this.opts.mode,
    });

    const unsub = handle.onEvent((ev) => {
      const bridge = this.bridges.get(origin);
      if (!bridge) return;
      if (ev.t == "tool" && mounted) {
        mounted.sync.setPresence({ busy: true, activity: ev.status == "running" ? ev.name : "working" });
      }
      this.forwardDriverEvent(bridge, doc, ev);
    });

    const thread: ActiveThread = { origin, doc, handle, unsub, sessionId: handle.sessionId, busy: false };
    this.threads.set(tKey, thread);
    return thread;
  }

  private forwardDriverEvent(bridge: ErgaBridgeClient, doc: string | null, ev: DriverEvent): void {
    if (ev.t == "turn_done") {
      bridge.send({ type: "turn_done", doc });
      return;
    }
    if (ev.t == "models") return;
    bridge.send({ type: "event", doc, ev: ev as LogEvent });
  }

  private formatPrompt(text: string, context: string | null, mounted: MountedDoc | null): string {
    const notes: string[] = [];
    if (mounted) notes.push(`Active Erga document: ${mounted.url} (live local folder: ${mounted.dir})`);
    if (context) notes.push(context);
    return notes.length ? `<erga-context>\n${notes.join("\n")}\n</erga-context>\n\n${text}` : text;
  }

  // ---------------------------------------------------------------- local Unix-socket RPC

  private async handleRpc(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    try {
      if (req.method == "GET" && url.pathname == "/status") return json({ ok: true, ...this.status() });
      if (req.method == "POST" && url.pathname == "/open") {
        const body = (await req.json()) as OpenDocRequest;
        return json(await this.openDocument(body));
      }
      if (req.method == "POST" && url.pathname == "/attach") {
        const body = (await req.json()) as AttachLiveRequest;
        if (!body.conversationId || !body.lsAddress || !body.csrfToken) {
          return json({ ok: false, error: "Missing conversationId, lsAddress, or csrfToken." }, 400);
        }
        return json(this.attachLiveSession(body));
      }
      if (req.method == "POST" && url.pathname == "/auth/start") {
        const body = (await req.json()) as { origin?: string };
        const origin = normalizeOrigin(body.origin ?? this.opts.defaultOrigin ?? DEFAULT_ORIGIN);
        const tok = await getAccessToken(origin, this.driver.label, { interactive: false });
        if (tok) return json({ ok: true, signedIn: true, origin });
        return json(await this.startAuth(origin));
      }
      if (req.method == "POST" && url.pathname == "/unmount") {
        const body = (await req.json()) as { origin?: string; docId: string };
        const ok = await this.unmountDocument(body.origin ?? this.opts.defaultOrigin ?? DEFAULT_ORIGIN, body.docId);
        return json({ ok });
      }
      if (req.method == "POST" && url.pathname == "/connect") {
        const body = (await req.json()) as { origin?: string; label?: string };
        const origin = normalizeOrigin(body.origin ?? this.opts.defaultOrigin ?? DEFAULT_ORIGIN);
        await this.connectOrigin(origin, { interactive: true, label: body.label });
        return json({ ok: true, origin });
      }
      if (req.method == "POST" && url.pathname == "/hook") {
        const body = (await req.json()) as HookPayload;
        const hookResponse = await this.handleHook(body);
        return json({ ok: true, hookResponse });
      }
      if (req.method == "POST" && url.pathname == "/permission") {
        // A session that this daemon's driver started asks the user about one tool call (mcp-server.ts).
        if (!this.driver.permission) return json({ ok: false, error: `${this.driver.label} asks no permission here.` }, 404);
        const body = (await req.json()) as { session: string; args: Record<string, unknown> };
        // The user may take long to answer, and this server ends a quiet request: the tool asks again while it is pending.
        const wait = new Promise<null>((r) => setTimeout(() => r(null), 5_000));
        const answer = await Promise.race([this.driver.permission(body), wait]);
        return json(answer ? { ok: true, answer } : { ok: true, pending: true });
      }
      if (req.method == "POST" && url.pathname == "/stop") {
        setTimeout(() => void this.stop().then(() => process.exit(0)), 20);
        return json({ ok: true });
      }
      return json({ ok: false, error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
}

/** Copies non-ignored files from a local project folder into a document's managed directory. */
export async function copyIntoManaged(srcDir: string, dstDir: string, sub = ""): Promise<void> {
  if (!sub && resolve(srcDir) == resolve(dstDir)) return;
  const entries = await readdir(join(srcDir, sub), { withFileTypes: true });
  for (const ent of entries) {
    const rel = sub ? `${sub}/${ent.name}` : ent.name;
    if (ent.name == ".git" || ent.name == "node_modules" || ent.name == ".DS_Store" || ent.name == ".erga" || ignored(rel)) continue;
    const from = join(srcDir, rel);
    const to = join(dstDir, rel);
    if (ent.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyIntoManaged(srcDir, dstDir, rel);
    } else if (ent.isFile()) {
      await mkdir(join(dstDir, sub), { recursive: true });
      await copyFile(from, to);
    }
  }
}

/** Sends one RPC request to a running local daemon over its Unix socket; null if not running. */
export async function daemonRpc<T = Record<string, unknown>>(
  agentId: string,
  path: string,
  body?: unknown,
  timeoutMs = 180_000
): Promise<T | null> {
  const sock = daemonSocketPath(agentId);
  if (!existsSync(sock)) return null;
  try {
    const res = await fetch(`http://localhost${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      unix: sock,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { unix: string });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
