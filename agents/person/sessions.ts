// Each person's agent, kept in their own object (PersonAgent, named by their login): its threads, and the event
// streams their pages listen on. A thread is a session with a conversation of its own: one for each document (the
// pages of that document show it), and one for the rest of Erga (the list, the settings, the admin pages). Threads
// run apart: a turn goes on in its thread when the person opens another page, and its answer lands there. The panel
// is client/agent/person-agent.ts, on every page.
//
// When a local bridge (herdr-core or rex) connects over /api/agent/bridge, it takes over the bound document's panel
// in terminal-first mode (PTY bytes + OSC 7501 status), with zero local chat storage in SQLite. Switching the panel
// dropdown back to a built-in server model returns seamlessly to the embedded chat agent.

import { startAgent, type AgentSession } from "./agent.ts";
import { activeBridge, bridgeLabelFor, bridgeStep, EMPTY_BRIDGES, localBridgeView, panelOptions, type BridgeState } from "./bridge.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, opsOf, toolsFor } from "../tools.ts";
import { callDocument, type Caller } from "../../server/operations/index.ts";
import { roleMay, type Directory, type Route as DocRoute } from "../../server/directory/index.ts";
import { assetManifest } from "../../server/pages/index.ts";
import { isModelChoice, type AgentSettings } from "../models.ts";
import { emptyLog, type Log } from "../../shared/agent-log.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { VIA } from "../../shared/attribution.ts";
import { isLocalChoice, localChoice, type LocalBridgeView, type PanelOption, type ToBridge } from "../../shared/bridge-protocol.ts";
import { parseBrowserToAgent, parseFromBridge } from "../../shared/bridge-schema.ts";
import { PING, PONG } from "../../shared/room-socket.ts";
import { authOps } from "../../server/identity/index.ts";
import type { Platform } from "../../server/platform.ts";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import { storeBlob, type BlobStore } from "../../document/store/blobs.ts";
import * as Cache from "effect/Cache";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

const enc = new TextEncoder();

/** The model menu's state: the model it's on, and the models the person can use now (with whose key runs each). */
const modelState = (agent: AgentSession) => ({
  model: agent.model,
  choice: agent.modelChoice,
  models: agent.models.map((u) => ({ id: u.choice, label: u.label, key: u.key })),
});

export interface PersonAgentsDeps {
  sql: ChatSql;
  platform: Platform;
  watch?: () => void;
  blobs?: BlobStore;
}

export async function dailyLimit(dir: Directory, login: string, now = Date.now()): Promise<string | null> {
  const most = await dir.config.get("agent_daily_tokens");
  if (most === null) return null;
  const used = await dir.activity.serverTokens(login, now);
  const n = (v: number) => v.toLocaleString("en-US");
  return used < most
    ? null
    : `Your agent used ${n(used)} tokens on the server's keys today, and the limit for one day is ${n(most)}. It works again after midnight UTC, or now with your own API key (Settings, Agent).`;
}

const SETTINGS_KEPT = "5 seconds";

export const docOf = (url: URL): string | null => {
  const doc = url.searchParams.get("doc");
  return doc && /^[a-z0-9-]{1,64}$/.test(doc) ? doc : null;
};

const scopeOf = (login: string, doc: string | null) => (doc ? `thread:${doc}:${login}` : `you:${login}`);

interface Listener {
  login: string;
  doc: string | null;
  scope: string;
  watching: { bridgeId: string; terminal: string } | null;
}

const listener = (request: Request): Listener => {
  const login = request.headers.get("x-erga-login") ?? "";
  const doc = docOf(new URL(request.url));
  return { login, doc, scope: scopeOf(login, doc), watching: null };
};

export interface BridgeInfo {
  login: string;
  grantId: string;
  label: string;
  onlyDoc: string | null;
  origin: string;
}

interface BridgeSocket {
  id: string;
  send(text: string): void;
  close(): void;
  info: BridgeInfo;
}

const bridgeKey = (login: string, id: string) => `${login}\n${id}`;

interface Thread {
  agent: AgentSession;
  origin: string;
  page: unknown;
}

export class PersonAgents {
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, Listener>();
  private sockets = new Map<(text: string) => void, Listener>();
  private agents = new Map<string, Thread>();
  private bridgeStates = new Map<string, BridgeState>();
  private bridgeSockets = new Map<string, BridgeSocket>();
  private origins = new Map<string, string>();
  private beat: Fiber.Fiber<void> | null = null;
  private chats: ChatTables;
  private settings: Cache.Cache<string, AgentSettings, unknown>;

  constructor(private deps: PersonAgentsDeps) {
    this.chats = new ChatTables(deps.sql);
    this.settings = Effect.runSync(
      Cache.makeWith((login: string) => Effect.tryPromise({ try: () => deps.platform.agentSettings(login), catch: (e) => e }), {
        capacity: 64,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? SETTINGS_KEPT : 0),
      })
    );
  }

  private get platform() {
    return this.deps.platform;
  }

  private async session(login: string, doc: string | null, origin: string, name?: string, kept = false): Promise<Thread | string> {
    const cfg = await Effect.runPromise(
      (kept ? Cache.get : Cache.refresh)(this.settings, login).pipe(
        Effect.catch((e) =>
          Effect.succeed({
            missing: `the agent's settings couldn't be read (${e instanceof Error ? e.message : String(e)}); try again in a moment`,
          })
        )
      )
    );
    if ("missing" in cfg) return cfg.missing;
    const scope = scopeOf(login, doc);
    let s = this.agents.get(scope);
    if (s) {
      s.origin = origin;
      s.agent.configure(cfg);
      return s;
    }
    const state: { origin: string; name: string; turn: string | null; page: unknown } = {
      origin,
      name: name ?? login,
      turn: null,
      page: null,
    };
    const touched = new Map<string, DocRoute>();
    const admin = await this.platform.directory.users.isAdmin(login);
    const as = (): Caller => ({
      dir: this.platform.directory,
      who: { login, ...(admin ? { admin: true } : {}), via: VIA.agent },
      name: state.name,
      origin: state.origin,
      ...(doc ? { here: doc } : {}),
      page: state.page,
      platform: this.platform,
      auth: authOps(this.platform, state.origin),
      ranIn: (d) => touched.set(d.id, d),
      turn: (state.turn ??= crypto.randomUUID()),
    });
    const store = tableStore(this.chats, scope, (running) => {
      if (running) this.deps.watch?.();
    });
    const tools = await toolsFor(as(), true);
    const agent = startAgent({
      cfg,
      owner: login,
      admin,
      feedback: tools.some((t) => opsOf(t).includes("send_feedback")),
      tools: agentTools(tools, as),
      store,
      stored: this.chats.load(scope),
      meta: { origin, name: state.name },
      modelChanged: () => {
        if (!activeBridge(this.bridgesOf(login), doc)) {
          const models = panelOptions(this.bridgesOf(login), doc, modelState(agent).models);
          this.event({ type: "model", enabled: true, ...modelState(agent), models, local: null }, login, scope);
        }
      },
      limit: () => dailyLimit(this.platform.directory, login),
      used: (t) =>
        void this.platform.directory.activity
          .add(login, t.own ? { "in:own": t.input, "out:own": t.output } : { "in:server": t.input, "out:server": t.output })
          .catch((e: unknown) => console.log(`couldn't count ${login}'s tokens: ${e}`)),
    });
    agent.subscribe((ev) => {
      if (ev.t != "busy" || ev.busy) return;
      for (const d of touched.values())
        callDocument(as(), d, "/api/turn-done", { method: "POST" }).then(
          (r) => r.body?.cancel(),
          () => {}
        );
      touched.clear();
      state.turn = null;
    });
    agent.subscribe((ev) => {
      if (!activeBridge(this.bridgesOf(login), doc)) this.event({ type: "agent", ev }, login, scope);
    });
    s = Object.assign(state, { agent });
    this.agents.set(scope, s);
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s agent: ${e}`));
    return s;
  }

  private bridgesOf(login: string): BridgeState {
    return this.bridgeStates.get(login) ?? EMPTY_BRIDGES;
  }

  private disconnectBridge(login: string, bridgeId: string, sock?: BridgeSocket): void {
    const key = bridgeKey(login, bridgeId);
    const current = this.bridgeSockets.get(key);
    if (sock && current !== sock) return;
    this.bridgeSockets.delete(key);
    try {
      current?.close();
    } catch {
      /* already closed */
    }
    for (const who of this.sockets.values()) {
      if (who.login == login && who.watching?.bridgeId == bridgeId) who.watching = null;
    }
    const res = bridgeStep(this.bridgesOf(login), { on: "disconnect", id: bridgeId });
    this.bridgeStates.set(login, res.state);
    if (res.notify) this.notifyPanels(login, res.notify);
  }

  private sendBridge(login: string, bridgeId: string, msg: ToBridge): boolean {
    const sock = this.bridgeSockets.get(bridgeKey(login, bridgeId));
    if (!sock) return false;
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      this.disconnectBridge(login, bridgeId, sock);
      return false;
    }
  }

  private maybeDetach(login: string, doc: string | null, watch: { bridgeId: string; terminal: string } | null): void {
    if (!watch) return;
    for (const other of this.sockets.values()) {
      if (
        other.login == login &&
        other.doc == doc &&
        other.watching?.bridgeId == watch.bridgeId &&
        other.watching?.terminal == watch.terminal
      ) {
        return;
      }
    }
    this.sendBridge(login, watch.bridgeId, { type: "pty_detach", doc, terminal: watch.terminal });
  }

  /** Combined panel state for `doc`, merging connected local bridges (above) with embedded models (below). */
  private async panelState(login: string, doc: string | null, origin: string, name?: string, fresh = false) {
    this.origins.set(login, origin);
    const s = await this.session(login, doc, origin, name, !fresh);
    const embedded = typeof s == "string" ? null : s;
    const embeddedModels = embedded ? modelState(embedded.agent).models : [];
    const bState = this.bridgesOf(login);
    const models: PanelOption[] = panelOptions(bState, doc, embeddedModels);
    const local: LocalBridgeView | null = localBridgeView(bState, doc);
    if (local) {
      return {
        enabled: true as const,
        model: local.label,
        choice: localChoice(local.bridgeId),
        models,
        local,
        log: emptyLog(),
      };
    }
    if (embedded) {
      return { enabled: true as const, ...modelState(embedded.agent), models, log: embedded.agent.log() };
    }
    return { enabled: false as const, reason: typeof s == "string" ? s : "the agent is off" };
  }

  private notifyPanels(login: string, targets: readonly (string | "*")[]): void {
    const all = targets.includes("*");
    const wanted = new Set<string | null>();
    const collect = (who: Listener) => {
      if (who.login != login) return;
      if (all || targets.includes(who.doc ?? "")) wanted.add(who.doc);
    };
    for (const who of this.clients.values()) collect(who);
    for (const who of this.sockets.values()) collect(who);
    const origin = this.origins.get(login) ?? "http://localhost";
    for (const doc of wanted) {
      void this.panelState(login, doc, origin).then((state) => {
        this.event({ type: "model", ...state }, login, scopeOf(login, doc));
      });
    }
  }

  private pushBridgeState(login: string, targets: readonly (string | "*")[]): void {
    const all = targets.includes("*");
    const bState = this.bridgesOf(login);
    const docs = new Set<string | null>();
    const collect = (who: Listener) => {
      if (who.login != login) return;
      if (all || targets.includes(who.doc ?? "")) docs.add(who.doc);
    };
    for (const who of this.clients.values()) collect(who);
    for (const who of this.sockets.values()) collect(who);
    for (const doc of docs) {
      const local = localBridgeView(bState, doc);
      this.event({ type: "bridge_state", local }, login, scopeOf(login, doc));
    }
  }

  async agentState(login: string, doc: string | null, origin: string, name?: string, fresh = false) {
    return this.panelState(login, doc, origin, name, fresh);
  }

  async agentPrompt(
    login: string,
    origin: string,
    text: string,
    context: string | null,
    attached?: unknown,
    doc?: string | null,
    name?: string,
    id?: string,
    page?: unknown
  ): Promise<{ ok: boolean; reason?: string }> {
    const targetDoc = doc ?? null;
    this.origins.set(login, origin);
    const local = localBridgeView(this.bridgesOf(login), targetDoc);
    if (local) {
      const trimmed = text.trim().slice(0, 20000);
      if (!trimmed) return { ok: false, reason: "say something" };
      const sent = this.sendBridge(login, local.bridgeId, {
        type: "send",
        doc: targetDoc,
        terminal: local.activeTerminal,
        text: trimmed,
      });
      return sent ? { ok: true } : { ok: false, reason: `${local.label} disconnected` };
    }
    const s = await this.session(login, targetDoc, origin, name);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    s.page = page ?? null;
    if (id && s.agent.log().items.some((i) => i.kind == "user" && i.id == id)) return { ok: true };
    const files = checkAttachments(attached);
    if (typeof files == "string") return { ok: false, reason: files };
    if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
    const blobs = this.deps.blobs;
    if (blobs)
      for (const f of files)
        if (f.kind == "image") {
          const bytes = Base64.decode(f.data);
          if (Result.isSuccess(bytes)) f.blob = (await Effect.runPromise(storeBlob(blobs, bytes.success))).hash;
        }
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null, files, id);
    return { ok: true };
  }

  async conversation(login: string, doc: string | null): Promise<Log> {
    if (activeBridge(this.bridgesOf(login), doc)) return emptyLog();
    const scope = scopeOf(login, doc);
    const live = this.agents.get(scope)?.agent.log();
    if (live) return live;
    const stored = this.chats.load(scope);
    return stored ? restoredLog(stored) : emptyLog();
  }

  async wake(): Promise<boolean> {
    return wakeRuns(this.chats, async (scope, state) => {
      const [, doc, login] = /^(?:you|thread:([a-z0-9-]+)):(.+)$/.exec(scope) ?? [];
      if (login && state.meta.origin) await this.session(login, doc ?? null, state.meta.origin, state.meta.name);
    });
  }

  async clearConversation(login: string, doc: string | null): Promise<Log> {
    if (activeBridge(this.bridgesOf(login), doc)) return emptyLog();
    const scope = scopeOf(login, doc);
    const s = this.agents.get(scope);
    if (s) await s.agent.reset();
    else {
      this.chats.clear(scope);
      this.event({ type: "agent", ev: { t: "reset" } }, login, scope);
    }
    return emptyLog();
  }

  async agentControl(
    login: string,
    doc: string | null,
    op: "abort" | "reset" | "model" | "approve" | "deny",
    model?: string,
    _choice?: string
  ) {
    const scope = scopeOf(login, doc);
    if (op == "model") {
      const wasBridge = activeBridge(this.bridgesOf(login), doc);
      if (isLocalChoice(model)) {
        const res = bridgeStep(this.bridgesOf(login), { on: "select", doc, choice: model });
        if (!res.ok) return { ok: false, reason: "that connected bridge isn't available" };
        this.bridgeStates.set(login, res.state);
        const state = await this.panelState(login, doc, this.origins.get(login) ?? "http://localhost");
        this.event({ type: "model", ...state }, login, scope);
        return { ok: true, ...state };
      }
      const s = this.agents.get(scope);
      if (!s) return { ok: false, reason: "the embedded agent isn't configured" };
      if (!model || !isModelChoice(model) || !s.agent.setModel(model)) return { ok: false, reason: "that model isn't one you can use now" };
      const res = bridgeStep(this.bridgesOf(login), { on: "select", doc, choice: model });
      this.bridgeStates.set(login, res.state);
      const state = await this.panelState(login, doc, this.origins.get(login) ?? "http://localhost");
      const payload = wasBridge ? state : { ...state, log: undefined };
      this.event({ type: "model", ...payload }, login, scope);
      return { ok: true, ...payload };
    }

    const local = localBridgeView(this.bridgesOf(login), doc);
    if (local) {
      if (op == "abort") {
        const sent = this.sendBridge(login, local.bridgeId, { type: "interrupt", doc, terminal: local.activeTerminal });
        return sent ? { ok: true } : { ok: false, reason: `${local.label} disconnected` };
      }
      return { ok: op == "reset" };
    }

    const s = this.agents.get(scope);
    if (!s) {
      if (op == "reset") await this.clearConversation(login, doc);
      if (op == "abort" && this.chats.running().some((r) => r.scope == scope)) {
        this.chats.stop(scope);
        this.event({ type: "agent", ev: { t: "busy", busy: false } }, login, scope);
      }
      return { ok: op == "abort" || op == "reset", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "approve" || op == "deny") {
      if (!s.agent.answer(model ?? "", op == "approve")) return { ok: false, reason: "that call no longer waits for your answer" };
    } else if (op == "reset") await this.clearConversation(login, doc);
    return { ok: true, ...modelState(s.agent) };
  }

  // -- local bridge sockets (/api/agent/bridge)

  joinBridge(info: BridgeInfo, send: (text: string) => void, close: () => void): { message(text: string): void; close(): void } {
    let bridgeId: string | null = null;
    const sock: BridgeSocket = { id: "", send, close, info };
    if (info.origin) this.origins.set(info.login, info.origin);
    this.keepBeating();

    const applyAndNotify = (res: ReturnType<typeof bridgeStep>) => {
      this.bridgeStates.set(info.login, res.state);
      if (res.notify) this.notifyPanels(info.login, res.notify);
    };

    return {
      message: (raw: string) => {
        if (raw == PING) {
          try {
            send(PONG);
          } catch {
            if (bridgeId) this.disconnectBridge(info.login, bridgeId, sock);
          }
          return;
        }
        if (raw == PONG) return;
        const msg = parseFromBridge(raw);
        if (!msg) return;

        if (msg.type == "hello") {
          const doc = msg.doc ?? null;
          if (info.onlyDoc && doc && doc != info.onlyDoc) return;
          if (bridgeId && bridgeId != msg.id) this.disconnectBridge(info.login, bridgeId, sock);
          bridgeId = msg.id;
          sock.id = msg.id;
          const prev = this.bridgeSockets.get(bridgeKey(info.login, bridgeId));
          if (prev && prev !== sock) prev.close();
          this.bridgeSockets.set(bridgeKey(info.login, bridgeId), sock);
          applyAndNotify(
            bridgeStep(this.bridgesOf(info.login), {
              on: "connect",
              ...(msg.reconnect ? { reconnect: true } : {}),
              bridge: {
                id: msg.id,
                backend: msg.backend,
                label: msg.label,
                version: msg.version,
                grantId: info.grantId,
                onlyDoc: info.onlyDoc,
                doc: doc ?? info.onlyDoc,
                connectedAt: Date.now(),
              },
            })
          );
          // Notify bridge immediately when a newer bundled release is deployed on this server.
          const latest = assetManifest()?.bridge;
          if (latest && msg.version && msg.version != "dev" && msg.version != latest.version) {
            this.sendBridge(info.login, bridgeId, {
              type: "update",
              version: latest.version,
              sha256: latest.sha256,
              url: "/plugin/bridge.js",
              minHcVersion: latest.minHcVersion,
            });
          }
          return;
        }

        if (!bridgeId) return;

        if (msg.type == "bind") {
          if (info.onlyDoc && msg.doc != info.onlyDoc) return;
          applyAndNotify(
            bridgeStep(this.bridgesOf(info.login), {
              on: "bind",
              id: bridgeId,
              doc: msg.doc,
              label: msg.label,
              scope: msg.scope,
              spaceId: msg.spaceId,
              spaceName: msg.spaceName,
              terminals: msg.terminals,
              activeTerminal: msg.activeTerminal,
              ...(msg.reconnect ? { reconnect: true } : {}),
            })
          );
          return;
        }

        if (msg.type == "unbind") {
          applyAndNotify(bridgeStep(this.bridgesOf(info.login), { on: "unbind", id: bridgeId, doc: msg.doc }));
          return;
        }

        if (msg.type == "terminals") {
          if (info.onlyDoc && msg.doc != info.onlyDoc) return;
          const res = bridgeStep(this.bridgesOf(info.login), {
            on: "terminals",
            id: bridgeId,
            doc: msg.doc,
            terminals: msg.terminals,
            spaceName: msg.spaceName,
          });
          this.bridgeStates.set(info.login, res.state);
          if (res.notify) this.pushBridgeState(info.login, res.notify);
          return;
        }

        if (msg.type == "pty_data" || msg.type == "pty_closed") {
          if (info.onlyDoc && msg.doc != info.onlyDoc) return;
          const bState = this.bridgesOf(info.login);
          const payload = JSON.stringify(
            msg.type == "pty_data"
              ? { type: "pty_data", terminal: msg.terminal, data: msg.data }
              : { type: "pty_closed", terminal: msg.terminal, ...(msg.reason ? { reason: msg.reason } : {}) }
          );
          for (const [to, who] of this.sockets) {
            if (who.login != info.login) continue;
            if (msg.doc != null && who.doc != msg.doc) continue;
            if (activeBridge(bState, who.doc)?.id != bridgeId) continue;
            this.sendTo(to, payload);
          }
          return;
        }

        if (msg.type == "turn_done" && msg.doc) {
          if (info.onlyDoc && msg.doc != info.onlyDoc) return;
          const who = { login: info.login, ...(info.onlyDoc ? { onlyDoc: info.onlyDoc } : {}), via: VIA.token(info.label) };
          void this.platform.directory
            .openAs(who, "d", msg.doc)
            .then((found) => {
              if (!found || !roleMay(found.role, "edit")) return;
              const caller: Caller = {
                dir: this.platform.directory,
                who,
                name: info.login,
                origin: info.origin,
                platform: this.platform,
                auth: authOps(this.platform, info.origin),
              };
              const route: DocRoute = { id: found.doc.id, owner: found.doc.owner, test: found.doc.test };
              void callDocument(caller, route, "/api/turn-done", { method: "POST" }).then(
                (r) => r.body?.cancel(),
                () => {}
              );
            })
            .catch(() => {});
        }
      },
      close: () => {
        if (!bridgeId) return;
        this.disconnectBridge(info.login, bridgeId, sock);
      },
    };
  }

  // -- live updates: the event stream of one person's pages

  async fetch(request: Request): Promise<Response> {
    this.keepBeating();
    const who = listener(request);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.clients.set(w, who);
    this.send(w, ": connected\nretry: 2000\n\n");
    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  private keepBeating() {
    this.beat ??= Effect.runFork(
      Effect.sync(() => {
        for (const c of this.clients.keys()) this.send(c, ": beat\n\n");
        for (const to of this.sockets.keys()) this.sendTo(to, '{"type":"beat"}');
        for (const b of [...this.bridgeSockets.values()]) {
          try {
            b.send(PING);
          } catch {
            this.disconnectBridge(b.info.login, b.id, b);
          }
        }
        return this.clients.size > 0 || this.sockets.size > 0 || this.bridgeSockets.size > 0;
      }).pipe(
        Effect.delay("20 seconds"),
        Effect.repeat({ while: (open) => open }),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            this.beat = null;
          })
        )
      )
    );
  }

  private event(data: Record<string, unknown>, login: string, scope?: string) {
    const text = JSON.stringify(data),
      line = enc.encode(`data: ${text}\n\n`);
    const hears = (who: Listener) => who.login == login && (!scope || who.scope == scope);
    for (const [c, who] of this.clients) if (hears(who)) this.send(c, line);
    for (const [to, who] of this.sockets) if (hears(who)) this.sendTo(to, text);
  }

  /**
   * Registers a browser tab's /api/agent/events WebSocket.
   * Accepts bidirectional PTY control/input messages (`pty_attach`, `pty_detach`,
   * `pty_input`, `pty_resize`, `pty_select`) and cleans up PTY attachments on close.
   */
  join(request: Request, send: (text: string) => void): { message(raw: string): void; close(): void } {
    const who = listener(request);
    this.sockets.set(send, who);
    this.keepBeating();

    return {
      message: (raw: string) => {
        if (raw == PING) {
          this.sendTo(send, PONG);
          return;
        }
        if (raw == PONG) return;
        const msg = parseBrowserToAgent(raw);
        if (!msg) return;
        const active = activeBridge(this.bridgesOf(who.login), who.doc);
        if (!active) return;

        if (msg.type == "pty_select") {
          const res = bridgeStep(this.bridgesOf(who.login), {
            on: "select_terminal",
            id: active.id,
            doc: who.doc,
            terminal: msg.terminal,
          });
          if (!res.ok) return;
          this.bridgeStates.set(who.login, res.state);
          this.pushBridgeState(who.login, [who.doc ?? ""]);
          return;
        }

        if (msg.type == "pty_attach") {
          const prev = who.watching;
          who.watching = { bridgeId: active.id, terminal: msg.terminal };
          if (prev && (prev.bridgeId != active.id || prev.terminal != msg.terminal)) {
            this.maybeDetach(who.login, who.doc, prev);
          }
          const sel = bridgeStep(this.bridgesOf(who.login), {
            on: "select_terminal",
            id: active.id,
            doc: who.doc,
            terminal: msg.terminal,
          });
          if (sel.ok) {
            this.bridgeStates.set(who.login, sel.state);
            this.pushBridgeState(who.login, [who.doc ?? ""]);
          }
          this.sendBridge(who.login, active.id, {
            type: "pty_attach",
            doc: who.doc,
            terminal: msg.terminal,
            cols: msg.cols,
            rows: msg.rows,
          });
          return;
        }

        if (msg.type == "pty_detach") {
          const prev = who.watching;
          who.watching = null;
          this.maybeDetach(who.login, who.doc, prev);
          return;
        }

        if (msg.type == "pty_input") {
          this.sendBridge(who.login, active.id, {
            type: "pty_input",
            doc: who.doc,
            terminal: msg.terminal,
            data: msg.data,
          });
          return;
        }

        if (msg.type == "pty_resize") {
          this.sendBridge(who.login, active.id, {
            type: "pty_resize",
            doc: who.doc,
            terminal: msg.terminal,
            cols: msg.cols,
            rows: msg.rows,
          });
        }
      },
      close: () => {
        const prev = who.watching;
        who.watching = null;
        this.sockets.delete(send);
        this.maybeDetach(who.login, who.doc, prev);
      },
    };
  }

  private sendTo(send: (text: string) => void, text: string) {
    try {
      send(text);
    } catch {
      this.sockets.delete(send);
    }
  }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, s: string | Uint8Array) {
    w.write(typeof s == "string" ? enc.encode(s) : s).catch(() => {
      this.clients.delete(w);
      w.abort().catch(() => {});
    });
  }
}

export type PersonAgentObject = Pick<
  PersonAgents,
  "agentState" | "agentPrompt" | "agentControl" | "conversation" | "clearConversation" | "fetch"
>;

declare module "../../server/platform.ts" {
  interface Platform {
    personAgent(login: string): PersonAgentObject;
  }
}
