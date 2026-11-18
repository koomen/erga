// Each person's agent, kept in their own object (PersonAgent, named by their login): its threads, and the event
// streams their pages listen on. A thread is a session with a conversation of its own: one for each document (the
// pages of that document show it), and one for the rest of Erga (the list, the settings, the admin pages). Threads
// run apart: a turn goes on in its thread when the person opens another page, and its answer lands there. The panel
// is client/agent/person-agent.ts, on every page.
// This is the logic (PersonAgents); the Durable Object (cloudflare/objects/person-agent.ts) gives it its
// SQLite and forwards the calls. The routes that reach it (/api/agent...) are routes.ts's.

import { startAgent, type AgentSession } from "./agent.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, toolsFor } from "../tools.ts";
import { callDocument, type Caller } from "../../server/operations/index.ts";
import type { Directory, Route as DocRoute } from "../../server/directory/index.ts";
import { isModelChoice, type AgentSettings } from "../models.ts";
import { emptyLog, type Log } from "../../shared/agent-log.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { VIA } from "../../shared/attribution.ts";
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

/**
 * What the agents need from where they run: their SQLite, the Platform (the
 * directory, tokens, the repository, the deploys, publishing), and an
 * alarm, set while a run goes (`wake` when it rings).
 */
export interface PersonAgentsDeps {
  sql: ChatSql;
  platform: Platform;
  watch?: () => void;
  /** Where an image sent to the agent is kept, so the agent can add it to a document (write's {"blob": ...}). */
  blobs?: BlobStore;
}

/**
 * Why `login`'s agent can't take another turn on the server's keys now: their tokens there today (UTC) reached the
 * setting agent_daily_tokens. Null when it can, and always when the setting is null (no limit). Their own key has no
 * limit (agents/run.ts never asks then).
 */
export async function dailyLimit(dir: Directory, login: string, now = Date.now()): Promise<string | null> {
  const most = await dir.config.get("agent_daily_tokens");
  if (most === null) return null;
  const used = await dir.activity.serverTokens(login, now);
  const n = (v: number) => v.toLocaleString("en-US");
  return used < most
    ? null
    : `Your agent used ${n(used)} tokens on the server's keys today, and the limit for one day is ${n(most)}. It works again after midnight UTC, or now with your own API key (Settings, Agent).`;
}

/** How long the panel's state may use the agent settings read before: a few polls of the panel. */
const SETTINGS_KEPT = "5 seconds";

/** The document whose thread a page of the panel's asks for (?doc=, its id): null on a page outside a document. */
export const docOf = (url: URL): string | null => {
  const doc = url.searchParams.get("doc");
  return doc && /^[a-z0-9-]{1,64}$/.test(doc) ? doc : null;
};

/** A thread's name: where its conversation is kept (agents/chat-store.ts), and what its pages listen for. */
const scopeOf = (login: string, doc: string | null) => (doc ? `thread:${doc}:${login}` : `you:${login}`);

/** Who listens on a stream: the person, and the thread their page shows. */
interface Listener {
  login: string;
  scope: string;
}
const listener = (request: Request): Listener => {
  const login = request.headers.get("x-erga-login") ?? "";
  return { login, scope: scopeOf(login, docOf(new URL(request.url))) };
};

/** A thread's session, with where the server is, as the person's page said last. */
interface Thread {
  agent: AgentSession;
  origin: string;
}

export class PersonAgents {
  /** The event streams open, each with who listens. */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, Listener>();
  private sockets = new Map<(text: string) => void, Listener>();
  /** Each thread's session, by its scope. */
  private agents = new Map<string, Thread>();
  private beat: Fiber.Fiber<void> | null = null;
  /** Each thread's conversation, kept step by step (agents/checkpoint.ts), by its scope (scopeOf). */
  private chats: ChatTables;
  /**
   * Each person's agent settings, as last read. The panel asks for the agent's state every few seconds, and each
   * read is several rows of the database: a state asked within SETTINGS_KEPT of the last read uses it. A turn reads
   * them again. A failed read isn't kept.
   */
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

  private get platform() { return this.deps.platform; }

  /**
   * The session of the person's thread for `doc` (null: the rest of Erga), made the first time; the origin is the
   * latest the page sent. An admin's has the admin's
   * tools and prompt (as they are when it starts; each tool call checks again: Users.mustAdmin).
   * The settings are read again at each turn, so a key an admin stores, replaces or clears reaches its next turn. The
   * panel's state (`kept`) may use the settings read up to SETTINGS_KEPT before.
   */
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
    const state: { origin: string; name: string; turn: string | null } = { origin, name: name ?? login, turn: null };
    /** The documents its tools ran in this turn (callDocument): each hears when the turn is done (a version is cut there). */
    const touched = new Map<string, DocRoute>();
    const admin = await this.platform.directory.users.isAdmin(login);
    // Every tool acts as the person, via their agent: the change log and a document's history name them, and how.
    const as = (): Caller => ({
      dir: this.platform.directory,
      who: { login, ...(admin ? { admin: true } : {}), via: VIA.agent },
      name: state.name,
      origin: state.origin,
      // The thread's document: the default for a tool's `document`.
      ...(doc ? { here: doc } : {}),
      platform: this.platform,
      auth: authOps(this.platform, state.origin),
      ranIn: (doc) => touched.set(doc.id, doc),
      // The turn that its calls are part of, from its first call to the end of its run: a document marks where the
      // turn began there (its "See changes" and "Undo the turn").
      turn: (state.turn ??= crypto.randomUUID()),
    });
    const store = tableStore(this.chats, scope, (running) => {
      if (running) this.deps.watch?.();
    });
    const agent = startAgent({
      cfg,
      owner: login,
      admin,
      tools: agentTools(await toolsFor(as(), true), as),
      store,
      stored: this.chats.load(scope),
      meta: { origin, name: state.name },
      modelChanged: () => this.event({ type: "model", ...modelState(agent) }, login, scope),
      limit: () => dailyLimit(this.platform.directory, login),
      // Its tokens, in the day's counts (the Analytics page), by whose key.
      used: (t) =>
        void this.platform.directory.activity
          .add(login, t.own ? { "in:own": t.input, "out:own": t.output } : { "in:server": t.input, "out:server": t.output })
          .catch((e: unknown) => console.log(`couldn't count ${login}'s tokens: ${e}`)),
    });
    // Its turn done: each document it worked in hears so at once (its presence ends, and the turn is one version there).
    agent.subscribe((ev) => {
      if (ev.t != "busy" || ev.busy) return;
      for (const doc of touched.values())
        callDocument(as(), doc, "/api/turn-done", { method: "POST" }).then(
          (r) => r.body?.cancel(),
          () => {}
        );
      touched.clear();
      state.turn = null;
    });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login, scope));
    s = Object.assign(state, { agent });
    this.agents.set(scope, s);
    // A run a restart cut off goes on, from its last checkpoint.
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s agent: ${e}`));
    return s;
  }

  /** The panel's state: with the settings read up to SETTINGS_KEPT before, unless `fresh` (a key just changed). */
  async agentState(login: string, doc: string | null, origin: string, name?: string, fresh = false) {
    const s = await this.session(login, doc, origin, name, !fresh);
    if (typeof s == "string") return { enabled: false as const, reason: s };
    return { enabled: true as const, ...modelState(s.agent), log: s.agent.log() };
  }

  /** A message, from a page (`doc`: the id of the document it has open, if any: the message goes to that document's thread). */
  async agentPrompt(
    login: string,
    origin: string,
    text: string,
    context: string | null,
    attached?: unknown,
    doc?: string | null,
    name?: string,
    id?: string
  ): Promise<{ ok: boolean; reason?: string }> {
    const s = await this.session(login, doc ?? null, origin, name);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    // Sent again (Try again, after an answer that came too late): the transcript has it already.
    if (id && s.agent.log().items.some((i) => i.kind == "user" && i.id == id)) return { ok: true };
    const files = checkAttachments(attached);
    if (typeof files == "string") return { ok: false, reason: files };
    if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
    // Each image is kept as a blob: the agent adds it to a document by its hash, without its bytes.
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

  // -- each thread's conversation, kept

  /** A thread's conversation: the live one, or the one stored (the agent need not be on to read it). */
  async conversation(login: string, doc: string | null): Promise<Log> {
    const scope = scopeOf(login, doc);
    const live = this.agents.get(scope)?.agent.log();
    if (live) return live;
    const stored = this.chats.load(scope);
    return stored ? restoredLog(stored) : emptyLog();
  }

  /** The object's alarm: each run a restart cut off goes on (its session starts, and resumes). Answers whether some still run. */
  async wake(): Promise<boolean> {
    return wakeRuns(this.chats, async (scope, state) => {
      const [, doc, login] = /^(?:you|thread:([a-z0-9-]+)):(.+)$/.exec(scope) ?? [];
      if (login && state.meta.origin) await this.session(login, doc ?? null, state.meta.origin, state.meta.name);
    });
  }

  /** A new conversation in a thread: the turn stopped, the transcript and the model's messages gone, every tab told. */
  async clearConversation(login: string, doc: string | null): Promise<Log> {
    const scope = scopeOf(login, doc);
    const s = this.agents.get(scope);
    if (s) await s.agent.reset();
    else {
      this.chats.clear(scope);
      this.event({ type: "agent", ev: { t: "reset" } }, login, scope);
    }
    return emptyLog();
  }

  async agentControl(login: string, doc: string | null, op: "abort" | "reset" | "model" | "approve" | "deny", model?: string) {
    const scope = scopeOf(login, doc);
    const s = this.agents.get(scope);
    if (!s) {
      if (op == "reset") await this.clearConversation(login, doc);
      // A run kept from before a restart, that no agent goes on with yet: Stop ends it, and the alarm wakes nothing.
      if (op == "abort" && this.chats.running().some((r) => r.scope == scope)) {
        this.chats.stop(scope);
        this.event({ type: "agent", ev: { t: "busy", busy: false } }, login, scope);
      }
      return { ok: op == "abort" || op == "reset", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "approve" || op == "deny") {
      // `model` carries the call's id: the answer is for the question the person saw, never for a later one.
      if (!s.agent.answer(model ?? "", op == "approve")) return { ok: false, reason: "that call no longer waits for your answer" };
    } else if (op == "reset") await this.clearConversation(login, doc);
    else if (!model || !isModelChoice(model) || !s.agent.setModel(model))
      return { ok: false, reason: "that model isn't one you can use now" };
    const state = modelState(s.agent);
    // The person's other tabs on this thread follow.
    if (op == "model") this.event({ type: "model", ...state }, login, scope);
    return { ok: true, ...state };
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

  /** A beat now and then keeps proxies from closing a quiet stream, and finds the ones that went away. */
  private keepBeating() {
    // Every 20 s while a stream or a socket is open; then it ends.
    this.beat ??= Effect.runFork(
      Effect.sync(() => {
        for (const c of this.clients.keys()) this.send(c, ": beat\n\n");
        for (const to of this.sockets.keys()) this.sendTo(to, '{"type":"beat"}');
        return this.clients.size > 0 || this.sockets.size > 0;
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

  /** An event for that person's pages only: those that show the thread `scope`, or all of them without one. */
  private event(data: Record<string, unknown>, login: string, scope?: string) {
    const text = JSON.stringify(data), line = enc.encode(`data: ${text}\n\n`);
    const hears = (who: Listener) => who.login == login && (!scope || who.scope == scope);
    for (const [c, who] of this.clients) if (hears(who)) this.send(c, line);
    for (const [to, who] of this.sockets) if (hears(who)) this.sendTo(to, text);
  }

  /**
   * A WebSocket's side of the stream (the panel's: the Durable Object accepts it): the events of that person's thread
   * (the request's ?doc=), as JSON, to `send`. It holds none of the browser's six connections to the host, as an event stream does. Returns its leave.
   */
  join(request: Request, send: (text: string) => void): () => void {
    const who = listener(request);
    this.sockets.set(send, who);
    this.keepBeating();
    return () => { this.sockets.delete(send); };
  }

  private sendTo(send: (text: string) => void, text: string) {
    try { send(text); } catch { this.sockets.delete(send); }
  }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, s: string | Uint8Array) {
    w.write(typeof s == "string" ? enc.encode(s) : s).catch(() => { this.clients.delete(w); w.abort().catch(() => {}); });
  }
}

/** What the routes ask of a person's agent (their Durable Object answers, by RPC, forwarding to a PersonAgents). */
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
