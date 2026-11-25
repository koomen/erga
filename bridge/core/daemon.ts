// Shared background daemon (100% agent-agnostic; takes an AgentDriver).
// Runs locally over a Unix domain socket (~/.erga/daemon.<agent>.sock) and
// coordinates all three capabilities:
//   (1) Local Yjs rooms mirrored to disk (YjsDiskSync)
//   (2) Shared OAuth authentication for Erga API / MCP
//   (3) Outbound WebSocket to /api/agent/bridge + AgentDriver sessions (e.g. `agy acp`)
//       so the user can interact with the local agent directly from Erga's browser pane.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { AntigravityTranscriptMirror, findAntigravitySession } from "../drivers/antigravity.ts";

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
  label?: string;
  /** When true (MCP calls), returns a device-code URL immediately instead of blocking on login. */
  nonBlockingAuth?: boolean;
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
  private defaultCwd: string;
  private bridgeId: string;

  constructor(
    private readonly driver: AgentDriver,
    private readonly opts: {
      defaultOrigin?: string;
      defaultCwd?: string;
      mcpSpec?: (origin: string) => McpServerSpec;
      log?: (line: string) => void;
    } = {}
  ) {
    this.defaultCwd = opts.defaultCwd ?? process.cwd();
    const host = (process.env.HOSTNAME || "local").replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 24) || "local";
    this.bridgeId = `${driver.id}-${host}`;
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

  /** Starts the local Unix-socket RPC server. */
  startSocket(socketPath = daemonSocketPath(this.driver.id)): void {
    mkdirSync(ergaHome(), { recursive: true });
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    this.server = Bun.serve({
      unix: socketPath,
      fetch: (req) => this.handleRpc(req),
    });
    writeFileSync(join(ergaHome(), `daemon.${this.driver.id}.pid`), `${process.pid}\n`);
    this.log(`listening on ${socketPath}`);
  }

  /** Connects the global bridge to `origin` so every Erga doc sees this local agent. */
  async connectOrigin(rawOrigin: string, opts: { interactive?: boolean; label?: string } = {}): Promise<ErgaBridgeClient> {
    const origin = normalizeOrigin(rawOrigin);
    let client = this.bridges.get(origin);
    if (client) {
      if (!client.connected) await client.start();
      return client;
    }
    // Ensure we have an OAuth token before opening the bridge socket.
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

    // Authenticate (non-blocking device-code prompt for MCP, interactive login for CLI).
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

    // Discover the calling interactive Antigravity session if not explicitly supplied.
    const discovered =
      this.driver.id == "antigravity" ? findAntigravitySession({ conversationId: req.conversationId, cwd: req.cwd }) : null;
    const conversationId = req.conversationId ?? discovered?.conversationId ?? null;
    const transcriptPath = req.transcriptPath ?? discovered?.transcriptPath ?? null;
    const sessionCwd = req.cwd ?? discovered?.cwd ?? this.defaultCwd;

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

      let mirror: AntigravityTranscriptMirror | null = null;
      if (transcriptPath && this.driver.id == "antigravity") {
        mirror = new AntigravityTranscriptMirror(transcriptPath, (evs) => {
          const b = this.bridges.get(origin);
          if (!b) return;
          for (const ev of evs) this.forwardDriverEvent(b, docId, ev);
        });
        mirror.start(false);
      }

      mounted = {
        origin,
        docId,
        owner,
        slug,
        title,
        url: docUrl,
        dir,
        cwd: sessionCwd,
        conversationId,
        transcriptPath,
        status: "synced",
        sync,
        mirror,
      };
      this.mounts.set(key, mounted);
    } else {
      // Update session attachment if a newer conversation opened the same doc.
      if (conversationId) mounted.conversationId = conversationId;
      if (sessionCwd) mounted.cwd = sessionCwd;
      if (transcriptPath && transcriptPath != mounted.transcriptPath && this.driver.id == "antigravity") {
        mounted.mirror?.stop();
        mounted.transcriptPath = transcriptPath;
        mounted.mirror = new AntigravityTranscriptMirror(transcriptPath, (evs) => {
          const b = this.bridges.get(origin);
          if (!b) return;
          for (const ev of evs) this.forwardDriverEvent(b, docId, ev);
        });
        mounted.mirror.start(false);
      }
    }

    if (req.fromDir) {
      const src = resolve(sessionCwd, req.fromDir);
      await copyIntoManaged(src, mounted.dir);
      await mounted.sync.flush();
      copiedFrom = src;
    }

    // Connect outbound bridge and bind this document so the browser panel defaults to this local agent.
    const bridge = await this.connectOrigin(origin, { interactive: true });
    const folderLabel = basename(sessionCwd);
    const label = req.label || (folderLabel && sessionCwd != mounted.dir ? `${this.driver.label} (${folderLabel})` : this.driver.label);
    bridge.bind(docId, { label, sessionId: mounted.conversationId, cwd: mounted.cwd });

    const note = copiedFrom
      ? `Copied files from ${copiedFrom} into the managed Erga directory ${mounted.dir}. Tell the user that live edits happen in ${mounted.dir} and their original folder is untouched.`
      : `Live Yjs sync active in managed Erga directory ${mounted.dir}. Tell the user where the synced copy lives if they ask.`;

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
        status: m.status,
        files: m.sync.paths(),
      })),
    };
  }

  async stop(): Promise<void> {
    for (const p of this.pendingLogins.values()) p.abort.abort();
    this.pendingLogins.clear();
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
    // Direct /d/<id> or bare id, or /<owner>/<slug>
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
    // Fallback: ask list_documents via Erga's tool API.
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

  // ---------------------------------------------------------------- browser <-> local agent routing

  private async handleBridgeMessage(origin: string, msg: ToBridge): Promise<void> {
    const bridge = this.bridges.get(origin);
    if (!bridge) return;
    const tKey = this.threadKey(origin, msg.doc);

    if (msg.type == "abort") {
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
      const mounted = msg.doc ? this.mounts.get(this.mountKey(origin, msg.doc)) : undefined;
      if (mounted) mounted.conversationId = null;
      return;
    }

    if (msg.type == "answer") {
      const existing = this.threads.get(tKey);
      if (existing) await existing.handle.answer(msg.id, msg.approve);
      return;
    }

    if (msg.type == "model") {
      await this.threads.get(tKey)?.handle.setModel?.(msg.model);
      return;
    }

    if (msg.type == "prompt") {
      try {
        // Auto-mount the document locally if it isn't mounted yet!
        let mounted = msg.doc ? this.mounts.get(this.mountKey(origin, msg.doc)) : undefined;
        if (msg.doc && !mounted) {
          await this.openDocument({ origin, document: `/d/${msg.doc}` });
          mounted = this.mounts.get(this.mountKey(origin, msg.doc));
        }

        const thread = await this.ensureThread(origin, msg.doc, mounted ?? null);
        // Materialize browser attachments into a local ignored folder so the agent can also inspect them by path.
        const attachments: LocalAttachment[] = [];
        if (msg.files?.length) {
          const baseDir = mounted?.dir ?? this.defaultCwd;
          const attDir = join(baseDir, ".erga-attachments");
          await mkdir(attDir, { recursive: true });
          for (const f of msg.files) {
            const safeName = `${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
            const abs = join(attDir, safeName);
            if (f.kind == "image") {
              await writeFile(abs, Buffer.from(f.data, "base64"));
            } else {
              await writeFile(abs, f.data, "utf8");
            }
            attachments.push({ kind: f.kind, name: f.name, type: f.mimeType, data: f.data, path: abs });
          }
        }

        const promptText = this.formatPrompt(msg.text, msg.context, mounted ?? null);
        mounted?.sync.setPresence({ busy: true, activity: "working" });
        mounted?.mirror?.setSuppressed(true);
        try {
          await thread.handle.prompt({ text: promptText, attachments });
        } finally {
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
      resumeId: mounted?.conversationId ?? null,
      systemPromptAppend,
    });
    if (mounted && !mounted.conversationId) mounted.conversationId = handle.sessionId;

    const unsub = handle.onEvent((ev) => {
      const bridge = this.bridges.get(origin);
      if (!bridge) return;
      if (ev.t == "tool" && mounted) {
        mounted.sync.setPresence({ busy: true, activity: ev.status == "running" ? ev.name : "working" });
      }
      this.forwardDriverEvent(bridge, doc, ev);
    });

    const thread: ActiveThread = { origin, doc, handle, unsub, sessionId: handle.sessionId };
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
        const body = (await req.json()) as { conversationId?: string };
        for (const m of this.mounts.values()) {
          if (!body.conversationId || m.conversationId == body.conversationId) m.mirror?.poke();
        }
        return json({ ok: true });
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
export async function daemonRpc<T = Record<string, unknown>>(agentId: string, path: string, body?: unknown): Promise<T | null> {
  const sock = daemonSocketPath(agentId);
  if (!existsSync(sock)) return null;
  try {
    const res = await fetch(`http://localhost${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      unix: sock,
      signal: AbortSignal.timeout(180_000),
    } as RequestInit & { unix: string });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
