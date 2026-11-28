// Each person's agent, kept in their own object (PersonAgent, named by their login): its threads, and the event
// streams their pages listen on. A thread is a session with a conversation of its own: one for each document (the
// pages of that document show it), and one for the rest of Erga (the list, the settings, the admin pages). Threads
// run apart: a turn goes on in its thread when the person opens another page, and its answer lands there. The panel
// is client/agent/person-agent.ts, on every page.
//
// When a local ACP bridge connects over /api/agent/bridge, it renders natively inside Erga's embedded chat pane with
// its own isolated per-session SQLite thread scope (local:<bridgeId>:<threadId>:...) and auto-update notifications.

import { startAgent, type AgentSession } from "./agent.ts";
import {
  activeBridge,
  bridgeLabelFor,
  bridgeStep,
  bridgeThreadId,
  disconnectedBridge,
  EMPTY_BRIDGES,
  isLocalSelected,
  localScopeOf,
  panelOptions,
  selectedThreadKey,
  type BridgeState,
  type ConnectedBridge,
  type DisconnectedBridge,
} from "./bridge.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, opsOf, toolsFor } from "../tools.ts";
import { callDocument, type Caller } from "../../server/operations/index.ts";
import { roleMay, type Directory, type Route as DocRoute } from "../../server/directory/index.ts";
import { assetManifest } from "../../server/pages/index.ts";
import { isModelChoice, type AgentSettings } from "../models.ts";
import { emptyLog, reduce, type Log, type LogEvent } from "../../shared/agent-log.ts";
import { checkAttachments, fileRefs } from "../../shared/attach.ts";
import { VIA } from "../../shared/attribution.ts";
import {
  bridgeIdOf,
  EMBEDDED_THREAD,
  isLocalChoice,
  localChoice,
  localThreadKey,
  type PanelOption,
  type ToBridge,
} from "../../shared/bridge-protocol.ts";
import { parseFromBridge } from "../../shared/bridge-schema.ts";
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

/** A panel event socket's metadata (kept as a hibernated WebSocket attachment). */
export interface PanelSocketAttachment {
  readonly kind: "panel";
  readonly login: string;
  readonly doc: string | null;
  readonly scope: string;
  readonly origin: string;
}

/** A local bridge socket's metadata (kept as a hibernated WebSocket attachment; bounded size). */
export interface BridgeSocketAttachment {
  readonly kind: "bridge";
  readonly sockId: string;
  readonly info: BridgeInfo;
}

export type AgentSocketAttachment = PanelSocketAttachment | BridgeSocketAttachment;

export interface PanelSocketEntry extends PanelSocketAttachment {
  send(text: string): void;
}

export interface BridgeSocketEntry {
  readonly sockId: string;
  readonly info: BridgeInfo;
  send(text: string): void;
  close(): void;
}

/** Hibernatable WebSockets owned by the host (Cloudflare DO `ctx.getWebSockets()` + attachments). */
export interface AgentSockets {
  panels(): Iterable<PanelSocketEntry>;
  bridges(): Iterable<BridgeSocketEntry>;
}

export interface PersonAgentsDeps {
  sql: ChatSql;
  platform: Platform;
  watch?: () => void;
  blobs?: BlobStore;
  sockets?: AgentSockets;
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
  origin?: string;
}

const listener = (request: Request): PanelSocketAttachment => {
  const url = new URL(request.url);
  const login = request.headers.get("x-erga-login") ?? "";
  const doc = docOf(url);
  return { kind: "panel", login, doc, scope: scopeOf(login, doc), origin: url.origin };
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
  sockId: string;
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
  private sockToBridge = new Map<string, { login: string; id: string }>();
  private bridgesHydrated = false;
  private localLogs = new Map<string, Log>();
  private panelSeqs = new Map<string, number>();
  private origins = new Map<string, string>();
  private beat: Fiber.Fiber<void> | null = null;
  private chats: ChatTables;
  private settings: Cache.Cache<string, AgentSettings, unknown>;

  constructor(private deps: PersonAgentsDeps) {
    this.chats = new ChatTables(deps.sql);
    deps.sql.exec(
      "CREATE TABLE IF NOT EXISTS bridge_sessions (sock_id TEXT PRIMARY KEY, login TEXT NOT NULL, bridge_id TEXT NOT NULL, origin TEXT NOT NULL, bridge TEXT NOT NULL)"
    );
    deps.sql.exec("CREATE TABLE IF NOT EXISTS bridge_state (login TEXT PRIMARY KEY, picks TEXT NOT NULL, disconnected TEXT NOT NULL)");
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
        if (!isLocalSelected(this.bridgesOf(login), doc)) {
          const models = panelOptions(this.bridgesOf(login), doc, modelState(agent).models);
          this.event({ type: "model", enabled: true, thread: EMBEDDED_THREAD, ...modelState(agent), models }, login, scope);
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
      if (!isLocalSelected(this.bridgesOf(login), doc)) this.event({ type: "agent", thread: EMBEDDED_THREAD, ev }, login, scope);
    });
    s = Object.assign(state, { agent });
    this.agents.set(scope, s);
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s agent: ${e}`));
    return s;
  }

  private ensureBridges(): void {
    if (this.bridgesHydrated) return;
    this.bridgesHydrated = true;
    if (!this.deps.sockets) return;
    const live = new Map<string, BridgeSocketEntry>();
    for (const s of this.deps.sockets.bridges()) live.set(s.sockId, s);
    const rows = this.deps.sql.exec<{ sock_id: string; login: string; bridge_id: string; origin: string; bridge: string }>(
      "SELECT sock_id, login, bridge_id, origin, bridge FROM bridge_sessions"
    );
    const byLogin = new Map<string, ConnectedBridge[]>();
    const droppedByLogin = new Map<string, ConnectedBridge[]>();
    const stale: string[] = [];
    for (const r of rows) {
      let parsed: ConnectedBridge;
      try {
        parsed = JSON.parse(r.bridge) as ConnectedBridge;
      } catch {
        stale.push(r.sock_id);
        continue;
      }
      const entry = live.get(r.sock_id);
      if (!entry) {
        stale.push(r.sock_id);
        const dropped = droppedByLogin.get(r.login);
        if (dropped) dropped.push(parsed);
        else droppedByLogin.set(r.login, [parsed]);
        continue;
      }
      this.bridgeSockets.set(bridgeKey(r.login, r.bridge_id), {
        id: r.bridge_id,
        sockId: r.sock_id,
        send: entry.send,
        close: entry.close,
        info: entry.info,
      });
      this.sockToBridge.set(r.sock_id, { login: r.login, id: r.bridge_id });
      if (r.origin) this.origins.set(r.login, r.origin);
      else if (entry.info.origin) this.origins.set(r.login, entry.info.origin);
      const list = byLogin.get(r.login);
      if (list) list.push(parsed);
      else byLogin.set(r.login, [parsed]);
    }
    const stateRows = this.deps.sql.exec<{ login: string; picks: string; disconnected: string }>(
      "SELECT login, picks, disconnected FROM bridge_state"
    );
    const savedByLogin = new Map<string, { picks: Record<string, string>; disconnected: Record<string, DisconnectedBridge> }>();
    for (const r of stateRows) {
      try {
        savedByLogin.set(r.login, {
          picks: JSON.parse(r.picks) as Record<string, string>,
          disconnected: JSON.parse(r.disconnected) as Record<string, DisconnectedBridge>,
        });
      } catch {
        /* ignore corrupt row */
      }
    }
    const logins = new Set([...byLogin.keys(), ...droppedByLogin.keys(), ...savedByLogin.keys()]);
    const dirtyState: Array<[string, BridgeState]> = [];
    const now = Date.now();
    for (const login of logins) {
      const liveBridges = byLogin.get(login) ?? [];
      const liveIds = new Set(liveBridges.map((b) => b.id));
      const dropped = (droppedByLogin.get(login) ?? []).filter((b) => !liveIds.has(b.id));
      const saved = savedByLogin.get(login);
      let state: BridgeState = {
        bridges: [...liveBridges, ...dropped],
        picks: saved?.picks ?? {},
        disconnected: saved?.disconnected ?? {},
      };
      let changed = false;
      for (const b of dropped) {
        state = bridgeStep(state, { on: "disconnect", id: b.id, now }).state;
        changed = true;
      }
      const picks: Record<string, string> = {};
      for (const [k, v] of Object.entries(state.picks)) {
        const bid = isLocalChoice(v) ? bridgeIdOf(v) : null;
        if (bid && !liveIds.has(bid) && state.disconnected[k]?.id != bid) changed = true;
        else picks[k] = v;
      }
      if (changed) {
        state = { ...state, picks };
        dirtyState.push([login, state]);
      }
      this.bridgeStates.set(login, state);
    }
    if (stale.length || dirtyState.length) {
      this.deps.sql.transaction(() => {
        for (const id of stale) this.deps.sql.exec("DELETE FROM bridge_sessions WHERE sock_id = ?", id);
        for (const [login, state] of dirtyState) this.writeBridgeMeta(login, state);
      });
    }
  }

  private writeBridgeMeta(login: string, state: BridgeState): void {
    if (Object.keys(state.picks).length || Object.keys(state.disconnected).length) {
      this.deps.sql.exec(
        "INSERT OR REPLACE INTO bridge_state (login, picks, disconnected) VALUES (?, ?, ?)",
        login,
        JSON.stringify(state.picks),
        JSON.stringify(state.disconnected)
      );
    } else {
      this.deps.sql.exec("DELETE FROM bridge_state WHERE login = ?", login);
    }
  }

  private saveBridges(login: string, state: BridgeState): void {
    this.deps.sql.transaction(() => {
      this.deps.sql.exec("DELETE FROM bridge_sessions WHERE login = ?", login);
      for (const b of state.bridges) {
        const sock = this.bridgeSockets.get(bridgeKey(login, b.id));
        if (!sock) continue;
        this.deps.sql.exec(
          "INSERT INTO bridge_sessions (sock_id, login, bridge_id, origin, bridge) VALUES (?, ?, ?, ?, ?)",
          sock.sockId,
          login,
          b.id,
          sock.info.origin || this.origins.get(login) || "",
          JSON.stringify(b)
        );
      }
      this.writeBridgeMeta(login, state);
    });
  }

  private setBridgeState(login: string, state: BridgeState): void {
    this.bridgeStates.set(login, state);
    this.saveBridges(login, state);
  }

  private originOf(login: string): string {
    const known = this.origins.get(login);
    if (known) return known;
    if (this.deps.sockets) {
      for (const p of this.deps.sockets.panels()) {
        if (p.login == login && p.origin) {
          this.origins.set(login, p.origin);
          return p.origin;
        }
      }
      for (const b of this.deps.sockets.bridges()) {
        if (b.info.login == login && b.info.origin) {
          this.origins.set(login, b.info.origin);
          return b.info.origin;
        }
      }
    }
    return "http://localhost";
  }

  private bridgesOf(login: string): BridgeState {
    this.ensureBridges();
    return this.bridgeStates.get(login) ?? EMPTY_BRIDGES;
  }

  private localLogOf(login: string, doc: string | null, bridgeId: string, threadId: string): Log {
    const scope = localScopeOf(login, doc, bridgeId, threadId);
    let log = this.localLogs.get(scope);
    if (!log) {
      const stored = this.chats.load(scope);
      log = stored ? restoredLog(stored) : emptyLog();
      this.localLogs.set(scope, log);
    }
    return log;
  }

  private saveLocalLog(login: string, doc: string | null, bridgeId: string, threadId: string, log: Log): void {
    const scope = localScopeOf(login, doc, bridgeId, threadId);
    this.localLogs.set(scope, log);
    this.chats.save(scope, {
      messages: { from: 0, items: [] },
      log: { from: 0, items: log.items },
      state: {
        running: false,
        queued: [],
        calls: {},
        model: localChoice(bridgeId),
        bound: null,
        stable: log.items.length,
        meta: { login, bridge: bridgeId, thread: threadId, ...(doc ? { doc } : {}) },
        at: Date.now(),
      },
    });
  }

  private clearLocalBusy(login: string, doc: string | null, bridgeId: string, threadId: string): void {
    const log = this.localLogOf(login, doc, bridgeId, threadId);
    if (!log.busy) return;
    reduce(log, { t: "busy", busy: false });
    this.saveLocalLog(login, doc, bridgeId, threadId, log);
  }

  private disconnectBridge(login: string, bridgeId: string, sockId?: string): Promise<void> {
    this.ensureBridges();
    const key = bridgeKey(login, bridgeId);
    const current = this.bridgeSockets.get(key);
    if (sockId && current?.sockId != sockId) return Promise.resolve();
    this.bridgeSockets.delete(key);
    if (current) this.sockToBridge.delete(current.sockId);
    try {
      current?.close();
    } catch {
      /* already closed */
    }
    const prev = this.bridgesOf(login);
    const had = prev.bridges.find((b) => b.id == bridgeId);
    const res = bridgeStep(prev, { on: "disconnect", id: bridgeId, now: Date.now() });
    this.setBridgeState(login, res.state);
    if (had) {
      for (const d of had.docs) this.clearLocalBusy(login, d, bridgeId, bridgeThreadId(had, d));
      if (!had.docs.length) this.clearLocalBusy(login, null, bridgeId, had.threadId);
    }
    for (const [k, d] of Object.entries(res.state.disconnected)) {
      if (d.id == bridgeId && k != "*") this.clearLocalBusy(login, k || null, bridgeId, d.threadId);
    }
    return res.notify ? this.notifyPanels(login, res.notify) : Promise.resolve();
  }

  private sendBridge(login: string, bridgeId: string, msg: ToBridge): boolean {
    this.ensureBridges();
    const sock = this.bridgeSockets.get(bridgeKey(login, bridgeId));
    if (!sock) return false;
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      void this.disconnectBridge(login, bridgeId, sock.sockId);
      return false;
    }
  }

  /** Combined panel state for `doc`, merging connected local agents (above) with embedded models (below). */
  private async panelState(login: string, doc: string | null, origin: string, name?: string, fresh = false) {
    this.origins.set(login, origin);
    const s = await this.session(login, doc, origin, name, !fresh);
    const embedded = typeof s == "string" ? null : s;
    const embeddedModels = embedded ? modelState(embedded.agent).models : [];
    const bState = this.bridgesOf(login);
    const models: PanelOption[] = panelOptions(bState, doc, embeddedModels);
    const active = activeBridge(bState, doc);
    if (active) {
      const tid = bridgeThreadId(active, doc);
      const log = this.localLogOf(login, doc, active.id, tid);
      return {
        enabled: true as const,
        model: bridgeLabelFor(active, doc),
        choice: localChoice(active.id),
        thread: localThreadKey(active.id, tid),
        models,
        log,
      };
    }
    const disc = disconnectedBridge(bState, doc);
    if (disc) {
      const log = this.localLogOf(login, doc, disc.id, disc.threadId);
      return {
        enabled: true as const,
        model: disc.label,
        choice: localChoice(disc.id),
        thread: localThreadKey(disc.id, disc.threadId),
        disconnected: true as const,
        models,
        log,
      };
    }
    if (embedded) {
      return { enabled: true as const, ...modelState(embedded.agent), thread: EMBEDDED_THREAD, models, log: embedded.agent.log() };
    }
    return { enabled: false as const, reason: typeof s == "string" ? s : "the agent is off" };
  }

  /** Pushes updated model/agent options and active thread log to open browser tabs for `targets` ("*" = all). */
  private notifyPanels(login: string, targets: readonly (string | "*")[]): Promise<void> {
    const all = targets.includes("*");
    const wanted = new Set<string | null>();
    const collect = (who: Listener) => {
      if (who.login != login) return;
      if (all || targets.includes(who.doc ?? "")) wanted.add(who.doc);
    };
    for (const who of this.clients.values()) collect(who);
    for (const who of this.sockets.values()) collect(who);
    if (this.deps.sockets) for (const who of this.deps.sockets.panels()) collect(who);
    const origin = this.originOf(login);
    const sends: Promise<void>[] = [];
    for (const doc of wanted) {
      const seqKey = `${login}\n${doc ?? ""}`;
      const seq = (this.panelSeqs.get(seqKey) ?? 0) + 1;
      this.panelSeqs.set(seqKey, seq);
      sends.push(
        this.panelState(login, doc, origin).then((state) => {
          if (this.panelSeqs.get(seqKey) !== seq) return;
          this.event({ type: "model", ...state }, login, scopeOf(login, doc));
        })
      );
    }
    return Promise.all(sends).then(() => {});
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
    const active = activeBridge(this.bridgesOf(login), targetDoc);
    if (active) {
      const tid = bridgeThreadId(active, targetDoc);
      const thread = localThreadKey(active.id, tid);
      const log = this.localLogOf(login, targetDoc, active.id, tid);
      if (id && log.items.some((i) => i.kind == "user" && i.id == id)) return { ok: true };
      const files = checkAttachments(attached);
      if (typeof files == "string") return { ok: false, reason: files };
      if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
      const trimmed = text.slice(0, 20000);
      const ctx = context ? context.slice(0, 4000) : null;
      const refs = fileRefs(files);
      const userEv: LogEvent = { t: "user", text: trimmed, ...(refs?.length ? { files: refs } : {}), ...(id ? { id } : {}) };
      const busyEv: LogEvent = { t: "busy", busy: true };
      reduce(log, userEv);
      reduce(log, busyEv);
      this.saveLocalLog(login, targetDoc, active.id, tid, log);
      const scope = scopeOf(login, targetDoc);
      this.event({ type: "agent", thread, ev: userEv }, login, scope);
      this.event({ type: "agent", thread, ev: busyEv }, login, scope);
      const route = targetDoc ? await this.platform.directory.route(targetDoc).catch(() => null) : null;
      const sent = this.sendBridge(login, active.id, {
        type: "prompt",
        doc: targetDoc,
        docAddress: route ? `/d/${route.id}` : null,
        text: trimmed,
        context: ctx,
        ...(files.length ? { files } : {}),
        ...(id ? { id } : {}),
      });
      if (!sent) {
        const errEv: LogEvent = { t: "error", text: `${bridgeLabelFor(active, targetDoc)} disconnected.` };
        const idleEv: LogEvent = { t: "busy", busy: false };
        reduce(log, errEv);
        reduce(log, idleEv);
        this.saveLocalLog(login, targetDoc, active.id, tid, log);
        this.event({ type: "agent", thread, ev: errEv }, login, scope);
        this.event({ type: "agent", thread, ev: idleEv }, login, scope);
        return { ok: false, reason: `${bridgeLabelFor(active, targetDoc)} disconnected` };
      }
      return { ok: true };
    }
    const disc = disconnectedBridge(this.bridgesOf(login), targetDoc);
    if (disc) return { ok: false, reason: `${disc.label} is disconnected` };
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
    const bState = this.bridgesOf(login);
    const active = activeBridge(bState, doc);
    if (active) return this.localLogOf(login, doc, active.id, bridgeThreadId(active, doc));
    const disc = disconnectedBridge(bState, doc);
    if (disc) return this.localLogOf(login, doc, disc.id, disc.threadId);
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
    const bState = this.bridgesOf(login);
    const active = activeBridge(bState, doc);
    if (active) {
      const tid = bridgeThreadId(active, doc);
      const lScope = localScopeOf(login, doc, active.id, tid);
      this.localLogs.set(lScope, emptyLog());
      this.chats.clear(lScope);
      const res = bridgeStep(bState, { on: "reset", id: active.id, doc, nextThreadId: crypto.randomUUID() });
      this.setBridgeState(login, res.state);
      this.sendBridge(login, active.id, { type: "reset", doc });
      this.event({ type: "agent", thread: localThreadKey(active.id, tid), ev: { t: "reset" } }, login, scopeOf(login, doc));
      if (res.notify) void this.notifyPanels(login, res.notify);
      return emptyLog();
    }
    const disc = disconnectedBridge(bState, doc);
    if (disc) return this.localLogOf(login, doc, disc.id, disc.threadId);
    const scope = scopeOf(login, doc);
    const s = this.agents.get(scope);
    if (s) await s.agent.reset();
    else {
      this.chats.clear(scope);
      this.event({ type: "agent", thread: EMBEDDED_THREAD, ev: { t: "reset" } }, login, scope);
    }
    return emptyLog();
  }

  async agentControl(
    login: string,
    doc: string | null,
    op: "abort" | "reset" | "model" | "approve" | "deny",
    model?: string,
    choice?: string
  ) {
    const scope = scopeOf(login, doc);
    if (op == "model") {
      const origin = this.originOf(login);
      const wasThread = selectedThreadKey(this.bridgesOf(login), doc);
      if (isLocalChoice(model)) {
        const res = bridgeStep(this.bridgesOf(login), { on: "select", doc, choice: model });
        if (!res.ok) return { ok: false, reason: "that connected agent isn't available" };
        this.setBridgeState(login, res.state);
        const state = await this.panelState(login, doc, origin);
        const nowThread = selectedThreadKey(res.state, doc);
        const payload = wasThread == nowThread ? { ...state, log: undefined } : state;
        this.event({ type: "model", ...payload }, login, scope);
        return { ok: true, ...payload };
      }
      let s = this.agents.get(scope);
      if (!s) {
        const opened = await this.session(login, doc, origin);
        if (typeof opened != "string") s = opened;
      }
      if (!s) return { ok: false, reason: "the embedded agent isn't configured" };
      if (!model || !isModelChoice(model) || !s.agent.setModel(model)) return { ok: false, reason: "that model isn't one you can use now" };
      const res = bridgeStep(this.bridgesOf(login), { on: "select", doc, choice: model });
      this.setBridgeState(login, res.state);
      const state = await this.panelState(login, doc, origin);
      const nowThread = selectedThreadKey(res.state, doc);
      const payload = wasThread == nowThread ? { ...state, log: undefined } : state;
      this.event({ type: "model", ...payload }, login, scope);
      return { ok: true, ...payload };
    }
    const bState = this.bridgesOf(login);
    const active = activeBridge(bState, doc);
    if (active) {
      if (op == "abort") {
        const tid = bridgeThreadId(active, doc);
        this.sendBridge(login, active.id, { type: "abort", doc });
        const log = this.localLogOf(login, doc, active.id, tid);
        if (log.busy) {
          const ev: LogEvent = { t: "busy", busy: false };
          reduce(log, ev);
          this.saveLocalLog(login, doc, active.id, tid, log);
          this.event({ type: "agent", thread: localThreadKey(active.id, tid), ev }, login, scope);
        }
        return { ok: true };
      }
      if (op == "reset") {
        await this.clearConversation(login, doc);
        return { ok: true };
      }
      if (op == "approve" || op == "deny") {
        if (!model) return { ok: false, reason: "missing call id" };
        const sent = this.sendBridge(login, active.id, {
          type: "answer",
          doc,
          id: model,
          approve: op == "approve",
          ...(choice ? { choice } : {}),
        });
        return sent ? { ok: true } : { ok: false, reason: "the connected agent disconnected" };
      }
    }
    const disc = disconnectedBridge(bState, doc);
    if (disc) return { ok: false, reason: `${disc.label} is disconnected` };
    const s = this.agents.get(scope);
    if (!s) {
      if (op == "reset") await this.clearConversation(login, doc);
      if (op == "abort" && this.chats.running().some((r) => r.scope == scope)) {
        this.chats.stop(scope);
        this.event({ type: "agent", thread: EMBEDDED_THREAD, ev: { t: "busy", busy: false } }, login, scope);
      }
      return { ok: op == "abort" || op == "reset", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "approve" || op == "deny") {
      if (!s.agent.answer(model ?? "", op == "approve")) return { ok: false, reason: "that call no longer waits for your answer" };
    } else if (op == "reset") await this.clearConversation(login, doc);
    return { ok: true, ...modelState(s.agent) };
  }

  // -- local agent bridge sockets (/api/agent/bridge)

  /** Attachment metadata for a hibernatable panel WebSocket (/api/agent/events). */
  panelAttachment(request: Request): PanelSocketAttachment {
    return listener(request);
  }

  /** Handles one frame from a local bridge WebSocket (works identically before and after DO hibernation). */
  bridgeMessage(entry: BridgeSocketEntry, raw: string): Promise<void> {
    this.ensureBridges();
    const { info, sockId, send, close } = entry;
    if (info.origin) this.origins.set(info.login, info.origin);
    const current = this.sockToBridge.get(sockId);
    let bridgeId = current?.id ?? null;

    if (raw == PING) {
      try {
        send(PONG);
      } catch {
        if (bridgeId) return this.disconnectBridge(info.login, bridgeId, sockId);
      }
      return Promise.resolve();
    }
    if (raw == PONG) return Promise.resolve();
    const msg = parseFromBridge(raw);
    if (!msg) return Promise.resolve();

    const applyAndNotify = (res: ReturnType<typeof bridgeStep>): Promise<void> => {
      this.setBridgeState(info.login, res.state);
      return res.notify ? this.notifyPanels(info.login, res.notify) : Promise.resolve();
    };

    if (msg.type == "hello") {
      const doc = msg.doc ?? null;
      if (info.onlyDoc && doc && doc != info.onlyDoc) return Promise.resolve();
      const tasks: Promise<void>[] = [];
      if (bridgeId && bridgeId != msg.id) tasks.push(this.disconnectBridge(info.login, bridgeId, sockId));
      bridgeId = msg.id;
      const sock: BridgeSocket = { id: bridgeId, sockId, send, close, info };
      const prev = this.bridgeSockets.get(bridgeKey(info.login, bridgeId));
      if (prev && prev.sockId != sockId) {
        this.sockToBridge.delete(prev.sockId);
        try {
          prev.close();
        } catch {
          /* already closed */
        }
      }
      this.bridgeSockets.set(bridgeKey(info.login, bridgeId), sock);
      this.sockToBridge.set(sockId, { login: info.login, id: bridgeId });
      tasks.push(
        applyAndNotify(
          bridgeStep(this.bridgesOf(info.login), {
            on: "connect",
            fallbackThreadId: crypto.randomUUID(),
            ...(msg.reconnect ? { reconnect: true } : {}),
            bridge: {
              id: msg.id,
              agent: msg.agent,
              label: msg.label,
              version: msg.version ?? "dev",
              grantId: info.grantId,
              onlyDoc: info.onlyDoc,
              doc: doc ?? info.onlyDoc,
              sessionId: msg.sessionId ?? null,
              threadId: msg.threadId ?? null,
              cwd: msg.cwd ?? null,
              connectedAt: Date.now(),
            },
          })
        )
      );
      const latest = assetManifest()?.bridge;
      if (latest && msg.version && msg.version != "dev" && msg.version != latest.version) {
        this.sendBridge(info.login, bridgeId, {
          type: "update",
          version: latest.version,
          sha256: latest.sha256,
          url: "/plugin/bridge.js",
        });
      }
      return Promise.all(tasks).then(() => {});
    }

    if (!bridgeId) return Promise.resolve();

    if (msg.type == "bind") {
      if (info.onlyDoc && msg.doc != info.onlyDoc) return Promise.resolve();
      return applyAndNotify(
        bridgeStep(this.bridgesOf(info.login), {
          on: "bind",
          id: bridgeId,
          doc: msg.doc,
          label: msg.label,
          sessionId: msg.sessionId,
          threadId: msg.threadId,
          fallbackThreadId: crypto.randomUUID(),
          cwd: msg.cwd,
          ...(msg.reconnect ? { reconnect: true } : {}),
        })
      );
    }

    if (msg.type == "unbind") {
      const prev = this.bridgesOf(info.login);
      const had = prev.bridges.find((b) => b.id == bridgeId);
      if (had && had.docs.includes(msg.doc)) this.clearLocalBusy(info.login, msg.doc, bridgeId, bridgeThreadId(had, msg.doc));
      return applyAndNotify(bridgeStep(prev, { on: "unbind", id: bridgeId, doc: msg.doc, now: Date.now() }));
    }

    if (msg.type == "event") {
      if (info.onlyDoc && msg.doc != info.onlyDoc) return Promise.resolve();
      const bState = this.bridgesOf(info.login);
      const b = bState.bridges.find((x) => x.id == bridgeId);
      if (!b) return Promise.resolve();
      const tid = bridgeThreadId(b, msg.doc);
      const log = this.localLogOf(info.login, msg.doc, bridgeId, tid);
      reduce(log, msg.ev);
      this.saveLocalLog(info.login, msg.doc, bridgeId, tid, log);
      if (activeBridge(bState, msg.doc)?.id == bridgeId) {
        this.event({ type: "agent", thread: localThreadKey(bridgeId, tid), ev: msg.ev }, info.login, scopeOf(info.login, msg.doc));
      }
      return Promise.resolve();
    }

    if (msg.type == "log") {
      if (info.onlyDoc && msg.doc != info.onlyDoc) return Promise.resolve();
      const bState = this.bridgesOf(info.login);
      const b = bState.bridges.find((x) => x.id == bridgeId);
      if (!b) return Promise.resolve();
      const tid = bridgeThreadId(b, msg.doc);
      this.saveLocalLog(info.login, msg.doc, bridgeId, tid, msg.log);
      if (activeBridge(bState, msg.doc)?.id == bridgeId) {
        this.event({ type: "log", thread: localThreadKey(bridgeId, tid), log: msg.log }, info.login, scopeOf(info.login, msg.doc));
      }
      return Promise.resolve();
    }

    if (msg.type == "turn_done" && msg.doc) {
      if (info.onlyDoc && msg.doc != info.onlyDoc) return Promise.resolve();
      const who = { login: info.login, ...(info.onlyDoc ? { onlyDoc: info.onlyDoc } : {}), via: VIA.token(info.label) };
      return this.platform.directory
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
          return callDocument(caller, route, "/api/turn-done", { method: "POST" }).then(
            (r) => void r.body?.cancel(),
            () => {}
          );
        })
        .catch(() => {});
    }

    return Promise.resolve();
  }

  /** Handles close/error on a hibernatable bridge WebSocket. */
  bridgeClosed(sockId: string): Promise<void> {
    this.ensureBridges();
    const found = this.sockToBridge.get(sockId);
    if (!found) return Promise.resolve();
    return this.disconnectBridge(found.login, found.id, sockId);
  }

  /** In-memory bridge join helper (unit tests). */
  joinBridge(info: BridgeInfo, send: (text: string) => void, close: () => void): { message(text: string): void; close(): void } {
    const entry: BridgeSocketEntry = { sockId: crypto.randomUUID(), info, send, close };
    return {
      message: (raw: string) => void this.bridgeMessage(entry, raw),
      close: () => void this.bridgeClosed(entry.sockId),
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

  /** Heartbeat for non-hibernatable SSE streams only; WebSockets use client PING/PONG auto-response so the DO can sleep. */
  private keepBeating() {
    this.beat ??= Effect.runFork(
      Effect.sync(() => {
        for (const c of this.clients.keys()) this.send(c, ": beat\n\n");
        return this.clients.size > 0;
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
    if (this.deps.sockets) {
      for (const p of this.deps.sockets.panels()) {
        if (!hears(p)) continue;
        try {
          p.send(text);
        } catch {
          /* gone: its close comes */
        }
      }
    }
  }

  /** A WebSocket's side of the panel event stream for one person's thread (?doc=). Returns its leave callback. */
  join(request: Request, send: (text: string) => void): () => void {
    const who = listener(request);
    this.sockets.set(send, who);
    return () => {
      this.sockets.delete(send);
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
    /** A person's agent: their own object, named by their login. */
    personAgent(login: string): PersonAgentObject;
  }
}
