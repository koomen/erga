// Shared background daemon (100% agent-agnostic; takes an AgentDriver).
// Runs locally over a Unix domain socket (~/.erga/daemon.<agent>.sock) and
// coordinates all three capabilities:
//   (1) Local Yjs rooms mirrored to disk (YjsDiskSync)
//   (2) Shared OAuth authentication for Erga API / MCP
//   (3) Outbound WebSocket to /api/agent/bridge: routes prompts directly into an
//       attached live terminal session (when present, no second process spawned)
//       or falls back to an AgentDriver subprocess (e.g. `agy acp`) for headless runs.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LogEvent } from "../../shared/agent-log.ts";
import type { ToBridge } from "../../shared/bridge-protocol.ts";
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
import { copyIntoManaged, daemonSocketPath, parseDocumentRef, resolveDocument } from "./daemon-io.ts";
import {
  extractToolPath,
  type AgentDriver,
  type AgentHandle,
  type DriverEvent,
  type LiveMessenger,
  type LiveSession,
  type LocalAttachment,
  type McpServerSpec,
  type PromptWait,
} from "./driver.ts";
import { managedDocDir, YjsDiskSync, type SyncStatus } from "./yjs-sync.ts";
import { findSession, hookEvents, recordSession, type HookPayload } from "./sessions.ts";
import { AntigravityTranscriptMirror, defaultTranscriptPath, type LiveAntigravitySession } from "../drivers/antigravity.ts";

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
  /** The agent's process that opened it, where the agent names its session by the process. */
  pid?: number;
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
  unsubClose: () => void;
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

/** A permission that a live session asks in its terminal: the panel's card answers it too. */
interface LiveAsk {
  card: { id: string; name: string; path: string | null };
  answer: Promise<boolean>;
  give: (ok: boolean) => void;
  /** The panel answered it. */
  done: boolean;
}

/** How long the daemon holds a request that waits for the user: its server ends a quiet request after ten seconds. */
const HOLD_MS = 5_000;
const hold = () => new Promise<null>((r) => setTimeout(() => r(null), HOLD_MS).unref?.());

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
  /** The agent's process that asks, where that names its session (sessions.ts: findSession). */
  pid?: number;
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

export class ErgaDaemon {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private mounts = new Map<string, MountedDoc>();
  private openingMounts = new Map<string, Promise<MountedDoc>>();
  private bridges = new Map<string, ErgaBridgeClient>();
  private connectingOrigins = new Map<string, Promise<ErgaBridgeClient>>();
  private threads = new Map<string, ActiveThread>();
  private openingThreads = new Map<string, Promise<ActiveThread>>();
  private promptQueues = new Map<string, Promise<void>>();
  private pendingLogins = new Map<string, { pending: PendingDeviceAuth; abort: AbortController }>();
  /** In-memory live session handles keyed by conversationId (never written to disk or returned in /status). */
  private liveSessions = new Map<string, LiveSession>();
  /** The permission that each live session asks now. */
  private liveAsks = new Map<string, LiveAsk>();
  /** The tool call that each live session started last: a permission request names its tool, not its call. */
  private lastTools = new Map<string, { id: string; name: string }>();
  /** Conversations with an in-flight browser-injected turn waiting for Stop or idle poll. */
  private activeLiveTurns = new Map<string, ActiveLiveTurn>();
  /** Conversations where the user clicked Stop in the browser pane (consumed on next hook). */
  private abortingConversations = new Set<string>();
  private defaultCwd: string;
  private bridgeId: string;
  private live: LiveMessenger | undefined;

  constructor(
    private readonly driver: AgentDriver,
    private readonly opts: {
      defaultOrigin?: string;
      defaultCwd?: string;
      autoApprove?: boolean;
      mode?: string | null;
      mcpSpec?: (origin: string) => McpServerSpec;
      liveMessenger?: LiveMessenger;
      log?: (line: string) => void;
    } = {}
  ) {
    this.defaultCwd = opts.defaultCwd ?? process.cwd();
    const host = (process.env.HOSTNAME || "local").replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 24) || "local";
    this.bridgeId = `${driver.id}-${host}`;
    this.live = opts.liveMessenger ?? driver.live;
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

  /** Starts the local Unix-socket RPC server (owner-only 0700 home dir and 0600 socket permissions). */
  startSocket(socketPath = daemonSocketPath(this.driver.id)): void {
    const home = ergaHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(home, 0o700);
    } catch {
      /* ignore on platforms without chmod */
    }
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
    const existing = this.bridges.get(origin);
    if (existing) {
      if (!existing.connected) await existing.start();
      return existing;
    }
    const inflight = this.connectingOrigins.get(origin);
    if (inflight) return inflight;
    const opening = (async () => {
      const tok = await getAccessToken(origin, this.driver.label, { interactive: opts.interactive !== false, log: (s) => this.log(s) });
      if (!tok) throw new Error(`Not signed in to ${origin}.`);
      const client = new ErgaBridgeClient({
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
      await client.start();
      this.bridges.set(origin, client);
      return client;
    })().finally(() => this.connectingOrigins.delete(origin));
    this.connectingOrigins.set(origin, opening);
    return opening;
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
    const fallbackOrigin = req.origin ?? this.opts.defaultOrigin ?? defaultOrigin();
    const parsed = req.document ? parseDocumentRef(req.document, fallbackOrigin) : { origin: normalizeOrigin(fallbackOrigin), ref: "" };
    const origin = parsed.origin;

    // Register live session handle immediately (even if auth is pending) so it stays ready after approval.
    if (this.driver.id == "antigravity" && req.conversationId && req.lsAddress && req.csrfToken) {
      const cwd = req.cwd ?? this.defaultCwd;
      const tp = req.transcriptPath ?? defaultTranscriptPath(req.conversationId, req.appDataDir);
      const live: LiveAntigravitySession = {
        conversationId: req.conversationId,
        lsAddress: req.lsAddress,
        csrfToken: req.csrfToken,
        cwd,
        transcriptPath: tp,
      };
      this.liveSessions.set(req.conversationId, live);
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
      const meta = await resolveDocument(origin, this.driver.label, parsed.ref);
      docId = meta.id;
      owner = meta.owner;
      slug = meta.slug;
      title = meta.title;
      docUrl = `${origin}/${owner}/${slug}`;
    }

    const discovered = findSession(this.driver.id, { conversationId: req.conversationId, cwd: req.cwd, pid: req.pid });
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
      let opening = this.openingMounts.get(key);
      if (!opening) {
        opening = (async () => {
          const dir = managedDocDir(ergaHome(), origin, owner, slug);
          let created: MountedDoc | null = null;
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
              if (created) created.status = s;
            },
            log: (s) => this.log(s),
          });
          await sync.start();

          created = {
            origin,
            docId,
            owner,
            slug,
            title,
            url: docUrl,
            dir,
            cwd: sessionCwd,
            conversationId: effectiveConversationId,
            pid: req.pid,
            transcriptPath: null,
            status: "synced",
            sync,
            mirror: null,
          };
          this.ensureMirror(created, transcriptPath);
          this.mounts.set(key, created);
          return created;
        })().finally(() => this.openingMounts.delete(key));
        this.openingMounts.set(key, opening);
      }
      mounted = await opening;
    }
    if (effectiveConversationId) mounted.conversationId = effectiveConversationId;
    if (req.pid) mounted.pid = req.pid;
    if (sessionCwd) mounted.cwd = sessionCwd;
    this.ensureMirror(mounted, transcriptPath);

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

  async unmountDocument(rawOrigin: string | undefined, docId: string): Promise<boolean> {
    const origin = rawOrigin ? normalizeOrigin(rawOrigin) : undefined;
    const hit = origin
      ? (() => {
          const key = this.mountKey(origin, docId);
          const mounted = this.mounts.get(key);
          return mounted ? ([key, mounted] as const) : null;
        })()
      : ([...this.mounts.entries()].find(([, m]) => m.docId == docId || m.url == docId) ?? null);
    if (!hit) return false;
    const [key, mounted] = hit;
    if (mounted.conversationId) this.clearLiveTurn(mounted.conversationId);
    await mounted.sync.flush().catch(() => {});
    await mounted.sync.stop();
    mounted.mirror?.stop();
    this.mounts.delete(key);
    this.bridges.get(mounted.origin)?.unbind(mounted.docId);
    const tKey = this.threadKey(mounted.origin, mounted.docId);
    const thread = this.threads.get(tKey);
    if (thread) {
      thread.unsub();
      thread.unsubClose();
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
    this.liveAsks.clear();
    this.abortingConversations.clear();
    for (const m of [...this.mounts.values()]) {
      await m.sync.flush().catch(() => {});
      await m.sync.stop();
      m.mirror?.stop();
    }
    this.mounts.clear();
    for (const t of this.threads.values()) {
      t.unsub();
      t.unsubClose();
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

    this.adopt(cid, payload.pid);
    // A turn that the user starts in the terminal is not the turn that the panel stopped.
    if (evName == "PreInvocation" && payload.prompt) this.abortingConversations.delete(cid);
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

    if (evName == "PermissionRequest") return this.askLive(cid, payload, matching);
    const ask = this.liveAsks.get(cid);
    if (ask) {
      // The terminal answered (or the turn ended). The call's own end closes its card; any other event closes it here.
      this.liveAsks.delete(cid);
      if (!ask.done && !(evName == "PostToolUse" && payload.toolCall?.id == ask.card.id)) {
        this.toPanels(matching, { t: "tool", ...ask.card, status: "done", detail: "Answered in the terminal" });
      }
    }
    if (evName == "PreToolUse" && payload.toolCall?.id) {
      this.lastTools.set(cid, { id: payload.toolCall.id, name: payload.toolCall.name || "tool" });
    }

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

  /** Sends an event of a live session to the panel of each of its documents, but not into a turn that a session of the bridge's own streams there. */
  private toPanels(mounts: readonly MountedDoc[], ev: DriverEvent): void {
    for (const m of mounts) {
      if (this.threads.get(this.threadKey(m.origin, m.docId))?.busy) continue;
      const bridge = this.bridges.get(m.origin);
      if (bridge) this.forwardDriverEvent(bridge, m.docId, ev);
    }
  }

  /** A live session asks a permission in its terminal. The panel shows a card, and the hook asks again while no answer came. */
  private async askLive(cid: string, payload: HookPayload, mounts: readonly MountedDoc[]): Promise<Record<string, unknown>> {
    const ask = this.liveAsks.get(cid);
    if (!ask) {
      // The hook asks again for a request that is gone: the terminal answered it.
      if (payload.again) return {};
      const name = payload.toolCall?.name || "tool";
      const args = payload.toolCall?.args ?? {};
      const last = this.lastTools.get(cid);
      const card = { id: last?.name == name ? last.id : `ask-${name}`, name, path: extractToolPath(name, args) };
      let give!: (ok: boolean) => void;
      const answer = new Promise<boolean>((r) => (give = r));
      this.liveAsks.set(cid, { card, answer, give, done: false });
      const detail = `${name}${card.path ? ` ${card.path}` : ""}`;
      this.toPanels(mounts, { t: "tool", ...card, status: "asking", detail, call: { tool: name, args } });
      return { pending: true };
    }
    const ok = await Promise.race([ask.answer, hold()]);
    if (ok == null) return { pending: true };
    this.liveAsks.delete(cid);
    return { behavior: ok ? "allow" : "deny" };
  }

  /** The agent's process goes on in a new session (Claude Code: /clear). The documents that the process opened go with it. */
  private adopt(cid: string, pid: number | undefined): void {
    for (const m of this.mounts.values()) {
      if (!pid || m.pid != pid || m.conversationId == cid) continue;
      if (m.conversationId) this.liveSessions.delete(m.conversationId);
      m.conversationId = cid;
    }
  }

  /** The user's answer in the panel to a permission that the live session asks: the session's hook takes it. */
  private answerLive(mounted: MountedDoc, ask: LiveAsk, ok: boolean): void {
    if (ask.done) return;
    ask.done = true;
    ask.give(ok);
    this.toPanels([mounted], { t: "tool", ...ask.card, status: ok ? "running" : "error", ...(ok ? {} : { detail: "Denied" }) });
  }

  /** A hook of the agent's own session waits for the next prompt that the panel of one of its documents sends (cli.ts: wait). */
  async waitForPrompt(session: LiveSession, waiter: number): Promise<PromptWait> {
    // A hook of a session that the agent's process left ends.
    if (session.pid && findSession(this.driver.id, { pid: session.pid })?.conversationId != session.conversationId) return {};
    this.adopt(session.conversationId, session.pid);
    const open = [...this.mounts.values()].some((m) => m.conversationId == session.conversationId);
    if (!this.driver.waitForPrompt || !open) return {};
    this.liveSessions.set(session.conversationId, session);
    return this.driver.waitForPrompt(session, waiter);
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
        const ask = this.liveAsks.get(mountedForDoc.conversationId);
        if (ask) this.answerLive(mountedForDoc, ask, false);
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
        existing.unsubClose();
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
      if (await this.threads.get(tKey)?.handle.answer(msg.id, msg.approve, msg.choice)) return;
      // A permission that the live session asks in its terminal: its hook takes the user's answer there.
      const ask = mountedForDoc?.conversationId ? this.liveAsks.get(mountedForDoc.conversationId) : undefined;
      if (mountedForDoc && ask && ask.card.id == msg.id) this.answerLive(mountedForDoc, ask, msg.approve && msg.choice != "deny");
      return;
    }

    if (msg.type == "model") {
      await this.threads.get(tKey)?.handle.setModel?.(msg.model);
      return;
    }

    if (msg.type == "prompt") {
      const prev = this.promptQueues.get(tKey) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => this.runBridgePrompt(origin, bridge, tKey, msg));
      const tracked = next.finally(() => {
        if (this.promptQueues.get(tKey) === tracked) this.promptQueues.delete(tKey);
      });
      this.promptQueues.set(tKey, tracked);
      await tracked;
    }
  }

  private async runBridgePrompt(
    origin: string,
    bridge: ErgaBridgeClient,
    tKey: string,
    msg: Extract<ToBridge, { type: "prompt" }>
  ): Promise<void> {
    try {
      let mounted = msg.doc ? this.mounts.get(this.mountKey(origin, msg.doc)) : undefined;
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
      if (live && mounted && (await this.promptLiveSession(origin, bridge, mounted, live, msg.text, msg.context, attachments))) return;

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

      const existing = this.threads.get(tKey);
      if (!existing || existing.handle.closed) {
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

  private async promptLiveSession(
    origin: string,
    bridge: ErgaBridgeClient,
    mounted: MountedDoc,
    live: LiveSession,
    text: string,
    context: string | null,
    attachments: readonly LocalAttachment[]
  ): Promise<boolean> {
    const messenger = this.live;
    if (!messenger) return false;
    this.abortingConversations.delete(live.conversationId);
    const attLines = attachments.filter((a) => a.path).map((a) => `Attached ${a.kind} "${a.name}" saved at: ${a.path}`);
    const fullText = attLines.length ? `${text}\n\n${attLines.join("\n")}` : text;
    const promptText = this.formatPrompt(fullText, context, mounted);

    mounted.sync.setPresence({ busy: true, activity: "working" });
    mounted.mirror?.setSuppressed(false);

    try {
      await messenger.send(live, promptText, { title: "Erga browser panel" });
    } catch (e) {
      this.liveSessions.delete(live.conversationId);
      mounted.sync.setPresence({ busy: false, activity: null });
      // Antigravity's own background session would compete with its terminal session. Any other agent's takes the prompt.
      if (this.driver.id != "antigravity") return false;
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
      return true;
    }

    // Track the live turn and add a safety poll in case the Stop hook does not fire.
    this.clearLiveTurn(live.conversationId);
    const turn: ActiveLiveTurn = { origin, doc: mounted.docId, poll: null, sawRunning: false, idlePolls: 0 };
    turn.poll = setInterval(() => {
      void messenger.check(live).then((st) => {
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
    return true;
  }

  private async ensureThread(origin: string, doc: string | null, mounted: MountedDoc | null): Promise<ActiveThread> {
    const tKey = this.threadKey(origin, doc);
    const existing = this.threads.get(tKey);
    if (existing) {
      if (!existing.handle.closed) return existing;
      existing.unsub();
      existing.unsubClose();
      this.threads.delete(tKey);
    }
    const inflight = this.openingThreads.get(tKey);
    if (inflight) return inflight;

    const opening = (async () => {
      const cwd = mounted?.cwd ?? mounted?.dir ?? this.defaultCwd;
      const addDirs = mounted && mounted.dir != cwd ? [mounted.dir] : [];
      const mcpServers = this.opts.mcpSpec ? [this.opts.mcpSpec(origin)] : [];
      const systemPromptAppend = mounted
        ? `You are connected to Erga document ${mounted.url} (id: ${mounted.docId}). Its files are live-synced via Yjs in local directory: ${mounted.dir}. Read and edit the document's files directly in that local directory with your native file tools; changes sync live to the user's browser. Use the Erga MCP tools (page, documents, read, edit, comments, versions) for page previews, live console logs, comments, publishing, or other Erga documents.`
        : `You are connected to Erga (${origin}). Use the Erga MCP tools (documents, read, edit, page) to read or edit documents, or run erga-agent open <url> to mount one locally.`;

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

      const unsubClose =
        handle.onClose?.(() => {
          const cur = this.threads.get(tKey);
          if (cur?.handle === handle) {
            cur.unsub();
            cur.unsubClose();
            this.threads.delete(tKey);
          }
        }) ?? (() => {});

      const thread: ActiveThread = { origin, doc, handle, unsub, unsubClose, sessionId: handle.sessionId, busy: false };
      if (handle.closed) {
        unsub();
        unsubClose();
      } else {
        this.threads.set(tKey, thread);
      }
      return thread;
    })().finally(() => this.openingThreads.delete(tKey));

    this.openingThreads.set(tKey, opening);
    return opening;
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
        const origin = normalizeOrigin(body.origin ?? this.opts.defaultOrigin ?? defaultOrigin());
        const tok = await getAccessToken(origin, this.driver.label, { interactive: false });
        if (tok) return json({ ok: true, signedIn: true, origin });
        return json(await this.startAuth(origin));
      }
      if (req.method == "POST" && url.pathname == "/unmount") {
        const body = (await req.json()) as { origin?: string; docId: string };
        const ok = await this.unmountDocument(body.origin, body.docId);
        return json({ ok });
      }
      if (req.method == "POST" && url.pathname == "/connect") {
        const body = (await req.json()) as { origin?: string; label?: string };
        const origin = normalizeOrigin(body.origin ?? this.opts.defaultOrigin ?? defaultOrigin());
        const tok = await getAccessToken(origin, this.driver.label, { interactive: false });
        if (!tok) return json(await this.startAuth(origin));
        await this.connectOrigin(origin, { interactive: false, label: body.label });
        return json({ ok: true, origin });
      }
      if (req.method == "POST" && url.pathname == "/hook") {
        const body = (await req.json()) as HookPayload;
        const hookResponse = await this.handleHook(body);
        return json({ ok: true, hookResponse });
      }
      if (req.method == "POST" && url.pathname == "/wait") {
        const { waiter, ...session } = (await req.json()) as LiveSession & { waiter: number };
        return json({ ok: true, ...(await this.waitForPrompt(session, waiter)) });
      }
      if (req.method == "POST" && url.pathname == "/permission") {
        // A session that this daemon's driver started asks the user about one tool call (mcp-server.ts).
        if (!this.driver.permission) return json({ ok: false, error: `${this.driver.label} asks no permission here.` }, 404);
        const body = (await req.json()) as { session: string; args: Record<string, unknown> };
        // The user may take long to answer: the tool asks again while it is pending.
        const answer = await Promise.race([this.driver.permission(body), hold()]);
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
