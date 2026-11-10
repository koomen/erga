// Each person's agent, kept in their own object (PersonAgent, named by their login): the session, its conversation
// and the event stream their pages listen on. The panel is client/agent/person-agent.ts, on every page.
// This is the logic (PersonAgents) and the routes; the Durable Object (cloudflare/objects/person-agent.ts) gives it its
// SQLite and forwards the calls.
//
// The routes are ROUTES, below (/api/agent...).
//
// The panel is the person's, in a browser: no token reaches it. An outside agent with a token
// ("Authorization: Bearer erga_...", server/identity) calls the same tools itself (MCP, POST /api/tools/<name>,
// server/api.ts).

import { startAgent, type AgentSession } from "./agent.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, toolsFor } from "../tools.ts";
import { callDocument, type Caller, runComment } from "../../server/operations/index.ts";
import type { Directory, Route as DocRoute } from "../../server/directory/index.ts";
import { isModelChoice, type AgentSettings } from "../models.ts";
import { emptyLog, type Log } from "../../shared/agent-log.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { type CommentAsk, VIA } from "../../shared/attribution.ts";
import { authOps } from "../../server/identity/index.ts";
import type { Platform } from "../../server/platform.ts";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import { storeBlob, type BlobStore } from "../../document/blobs.ts";
import * as Cache from "effect/Cache";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { call, ctx, fromWeb, json, type Route } from "../../server/http.ts";
import { PANEL, routeFor, SECRET, STREAM, type RouteRow } from "../../shared/routes.ts";

const enc = new TextEncoder();

/** The model menu's state: the model it's on, and the models the person can use now (with whose key runs each). */
const modelState = (agent: AgentSession) => ({
  model: agent.model,
  choice: agent.modelChoice,
  models: agent.models.map((u) => ({ id: u.choice, label: u.label, key: u.key })),
});

/**
 * What the agents need from where they run: their SQLite, the Platform (the
 * directory, tokens, the repository, the deploys, the homepage), and an
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
 * setting agent_daily_tokens. Null when it can. Their own key has no limit (agents/run.ts never asks then).
 */
export async function dailyLimit(dir: Directory, login: string, now = Date.now()): Promise<string | null> {
  const [most, used] = await Promise.all([dir.config.get("agent_daily_tokens"), dir.activity.serverTokens(login, now)]);
  const n = (v: number) => v.toLocaleString("en-US");
  return used < most
    ? null
    : `Your agent used ${n(used)} tokens on the server's keys today, and the limit for one day is ${n(most)}. It works again after midnight UTC, or now with your own API key (Settings, Agent).`;
}

/** How long the panel's state may use the agent settings read before: a few polls of the panel. */
const SETTINGS_KEPT = "5 seconds";

export class PersonAgents {
  /** The event streams open, each with the person it's for. */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, string>();
  private sockets = new Map<(text: string) => void, string>();
  /** Each person's last comment that asks (askComment) while no panel of theirs listened. In memory: a restart loses it. */
  private asks = new Map<string, CommentAsk>();
  /** Each person's agent (one, in their object), with where the server is and the document open, as their page said last. */
  private agents = new Map<string, { agent: AgentSession; origin: string; here: string | null }>();
  private beat: Fiber.Fiber<void> | null = null;
  /** Each person's conversation, kept step by step (agents/checkpoint.ts), scope "you:<login>". */
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
   * The person's session, made the first time; the origin is the latest the page sent. An admin's has the admin's
   * tools and prompt (as they are when it starts; each tool call checks again: Users.mustAdmin).
   * The settings are read again at each turn, so a key an admin stores, replaces or clears reaches its next turn. The
   * panel's state (`kept`) may use the settings read up to SETTINGS_KEPT before.
   */
  private async session(
    login: string,
    origin: string,
    name?: string,
    kept = false
  ): Promise<{ agent: AgentSession; origin: string; here: string | null } | string> {
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
    let s = this.agents.get(login);
    if (s) { s.origin = origin; s.agent.configure(cfg); return s; }
    const state: { origin: string; here: string | null; name: string } = { origin, here: null, name: name ?? login };
    /** The documents its tools ran in this turn (callDocument): each hears when the turn is done (a version is cut there). */
    const touched = new Map<string, DocRoute>();
    const admin = await this.platform.directory.users.isAdmin(login);
    // Every tool acts as the person, via their agent: the change log and a document's history name them, and how.
    const as = (): Caller => ({
      dir: this.platform.directory,
      who: { login, ...(admin ? { admin: true } : {}), via: VIA.agent },
      name: state.name,
      origin: state.origin,
      // The document open on their page, as their last message said: the default for a tool's `document`.
      ...(state.here ? { here: state.here } : {}),
      platform: this.platform,
      auth: authOps(this.platform, state.origin),
      ranIn: (doc) => touched.set(doc.id, doc),
    });
    const scope = `you:${login}`;
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
      modelChanged: () => this.event({ type: "model", ...modelState(agent) }, login),
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
        callDocument(as(), doc, "/api/agent/done", { method: "POST" }).then(
          (r) => r.body?.cancel(),
          () => {}
        );
      touched.clear();
    });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login));
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    // A run a restart cut off goes on, from its last checkpoint.
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s agent: ${e}`));
    return s;
  }

  /** The panel's state: with the settings read up to SETTINGS_KEPT before, unless `fresh` (a key just changed). */
  async agentState(login: string, origin: string, name?: string, fresh = false) {
    const s = await this.session(login, origin, name, !fresh);
    if (typeof s == "string") return { enabled: false as const, reason: s };
    return { enabled: true as const, ...modelState(s.agent), log: s.agent.log() };
  }

  /** A message, from a page (`doc`: the id of the document it has open, if any: the document tools' own, unnamed). */
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
    const s = await this.session(login, origin, name);
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
    s.here = typeof doc == "string" && /^[a-z0-9-]{1,64}$/.test(doc) ? doc : null;
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null, files, id);
    return { ok: true };
  }

  /**
   * A comment with @erga that came with a page's edit key (server/operations/comments.ts): no agent starts. The
   * person's panels ask them whether to run it.
   */
  async askComment(login: string, ask: CommentAsk): Promise<void> {
    this.event({ type: "comment-ask", ask }, login);
    // No panel of theirs listens (a socket that went away is out by now): the question waits for their next one.
    if (![...this.sockets.values(), ...this.clients.values()].includes(login)) this.asks.set(login, ask);
  }

  /** A panel of the person's listens from now: it hears the question that waited for one. */
  private listening(login: string) {
    const ask = this.asks.get(login);
    if (ask && this.asks.delete(login)) this.event({ type: "comment-ask", ask }, login);
  }

  // -- each person's conversation, kept

  /** The person's conversation: the live one, or the one stored (the agent need not be on to read it). */
  async conversation(login: string): Promise<Log> {
    const live = this.agents.get(login)?.agent.log();
    if (live) return live;
    const stored = this.chats.load(`you:${login}`);
    return stored ? restoredLog(stored) : emptyLog();
  }

  /** The object's alarm: each run a restart cut off goes on (its session starts, and resumes). Answers whether some still run. */
  async wake(): Promise<boolean> {
    return wakeRuns(this.chats, async (scope, state) => {
      const login = /^you:(.+)$/.exec(scope)?.[1];
      if (login && state.meta.origin) await this.session(login, state.meta.origin, state.meta.name);
    });
  }

  /** A new conversation: the turn stopped, the transcript and the model's messages gone, every tab told. */
  async clearConversation(login: string): Promise<Log> {
    const s = this.agents.get(login);
    if (s) await s.agent.reset();
    else {
      this.chats.clear(`you:${login}`);
      this.event({ type: "agent", ev: { t: "reset" } }, login);
    }
    return emptyLog();
  }

  async agentControl(login: string, op: "abort" | "reset" | "model" | "approve" | "deny", model?: string) {
    const s = this.agents.get(login);
    if (!s) {
      if (op == "reset") await this.clearConversation(login);
      // A run kept from before a restart, that no agent goes on with yet: Stop ends it, and the alarm wakes nothing.
      if (op == "abort" && this.chats.running().some((r) => r.scope == `you:${login}`)) {
        this.chats.stop(`you:${login}`);
        this.event({ type: "agent", ev: { t: "busy", busy: false } }, login);
      }
      return { ok: op == "abort" || op == "reset", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "approve" || op == "deny") {
      // `model` carries the call's id: the answer is for the question the person saw, never for a later one.
      if (!s.agent.answer(model ?? "", op == "approve")) return { ok: false, reason: "that call no longer waits for your answer" };
    } else if (op == "reset") await this.clearConversation(login);
    else if (!model || !isModelChoice(model) || !s.agent.setModel(model))
      return { ok: false, reason: "that model isn't one you can use now" };
    const state = modelState(s.agent);
    // The person's other tabs follow.
    if (op == "model") this.event({ type: "model", ...state }, login);
    return { ok: true, ...state };
  }

  // -- live updates: the event stream of one person's pages

  async fetch(request: Request): Promise<Response> {
    this.keepBeating();
    const login = request.headers.get("x-erga-login") ?? "";
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.clients.set(w, login);
    this.send(w, ": connected\nretry: 2000\n\n");
    this.listening(login);
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

  /** An event for that person's pages only. */
  private event(data: Record<string, unknown>, login: string) {
    const text = JSON.stringify(data), line = enc.encode(`data: ${text}\n\n`);
    for (const [c, who] of this.clients) if (who == login) this.send(c, line);
    for (const [to, who] of this.sockets) if (who == login) this.sendTo(to, text);
  }

  /**
   * A WebSocket's side of the stream (the panel's: the Durable Object accepts it): that person's events, as JSON, to
   * `send`. It holds none of the browser's six connections to the host, as an event stream does. Returns its leave.
   */
  join(request: Request, send: (text: string) => void): () => void {
    const login = request.headers.get("x-erga-login") ?? "";
    this.sockets.set(send, login);
    this.keepBeating();
    this.listening(login);
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
  "agentState" | "agentPrompt" | "askComment" | "agentControl" | "conversation" | "clearConversation" | "fetch"
>;

declare module "../../server/platform.ts" {
  interface Platform {
    /** A person's agent: their own object, named by their login. */
    personAgent(login: string): PersonAgentObject;
  }
}

// ---------------------------------------------------------------- the routes

/** Someone signed in, in person (in a browser: for their own agent panel, which no token reaches). */
const personOf = (platform: Platform, request: Request) =>
  call(async (): Promise<{ login: string; name: string } | null> => {
    const session = await platform.sessionOf(request);
    if (!session || session.agent) return null;
    return { login: session.login.toLowerCase(), name: session.name };
  });

export const isAgentPath = (path: string) => path == "/api/agent" || path.startsWith("/api/agent/");

/** The bodies the panel sends: a message, a model. */
const Prompt = Schema.Struct({
  text: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  files: Schema.optionalKey(Schema.Unknown),
  doc: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.Unknown),
});
const ModelBody = Schema.Struct({ model: Schema.optionalKey(Schema.String) });
const AnswerBody = Schema.Struct({ id: Schema.optionalKey(Schema.String) });
const CommentBody = Schema.Struct({
  doc: Schema.optionalKey(Schema.Unknown),
  thread: Schema.optionalKey(Schema.Unknown),
  comment: Schema.optionalKey(Schema.Unknown),
  text: Schema.optionalKey(Schema.Unknown),
});
const KeyBody = Schema.Struct({ name: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.String) });

/** The body as JSON, as `schema` has it; else `fallback` (a body that isn't JSON counts as none, as before). */
const body = <S extends Schema.Top>(request: Request, schema: S, fallback: S["Type"]) =>
  call(() => request.text()).pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema as unknown as Schema.Codec<S["Type"]>))(t)),
    Effect.orElseSucceed(() => fallback)
  );

/** /api/agent...: the person's own agent panel, on this site's pages. Only this site's own origin may talk to it, or listen. */
export const agentApi: Route = Effect.gen(function* () {
  const { request, url } = yield* ctx;
  const from = request.headers.get("origin");
  if (from && from != url.origin) return json({ error: "Forbidden" }, 403);
  return yield* agentRoutes(url.origin);
});

/** The panel's routes, for a page at `origin` (this site's). */
const agentRoutes = (origin: string): Route =>
  Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? ""))
    return json(
      {
        error: `The agent panel is a person's, in a browser: an outside agent calls the same tools itself, over MCP (${url.origin}/mcp).`,
      },
      403
    );
  const me = yield* personOf(platform, request);
  if (!me)
    return json({ error: "Sign in as yourself to talk to your agent." }, (yield* call(() => platform.sessionOf(request))) ? 403 : 401);
  if (request.method != "GET" && request.headers.get("origin") != origin) return json({ error: "Forbidden" }, 403);
  const found = routeFor(ROUTES, request.method, url.pathname.replace(/\/$/, ""));
  if (!found) return json({ error: "Not found" }, 404);
  return yield* found.route.run({ request, url, platform, me, h: platform.personAgent(me.login) });
});

/** The person who asks, checked, and their agent's object. */
interface Asked {
  readonly request: Request;
  readonly url: URL;
  readonly platform: Platform;
  readonly me: { login: string; name: string };
  readonly h: ReturnType<Platform["personAgent"]>;
}

/**
 * Stops the turn, starts a new conversation, switches the model ({ model }: one the person can use, from the next
 * turn), or gives the person's answer ({ id }) to the tool call `id` that waits for it (a delete, a share with anyone,
 * a token's revoke, an admin change: an operation's `asks`): run it, or not.
 */
const control = (what: "abort" | "reset" | "model" | "approve" | "deny") => (a: Asked) =>
  Effect.gen(function* () {
    const b = what == "model" ? yield* body(a.request, ModelBody, {}) : {};
    const answered = what == "approve" || what == "deny" ? yield* body(a.request, AnswerBody, {}) : {};
    const r = yield* call(() => a.h.agentControl(a.me.login, what, b.model ?? answered.id));
    return json(r, r.ok ? 200 : 409);
  });

const PANEL_ROW = { domain: "none", exempt: PANEL } as const;

/** The agent panel's routes. */
export const ROUTES: readonly RouteRow<(a: Asked) => Route>[] = [
  {
    method: "GET",
    path: "/api/agent",
    // { enabled, reason?, model, models, choice, log }
    run: (a) =>
      call(() => a.h.agentState(a.me.login, a.url.origin, a.me.name, a.url.searchParams.has("fresh"))).pipe(
        Effect.map((state) => json(state))
      ),
    action: "Your agent's panel",
    ...PANEL_ROW,
  },
  {
    method: "POST",
    path: "/api/agent",
    // { text, context, files?, doc?, id? }: a message (it steers a turn that is running). context is the page note (the
    // page open, what is selected there), doc the id of the document open, for the document tools that name none, id
    // the tab's own id for the message: its copy in the transcript carries it, and a second message with the same id
    // (Try again, after the first got there) is not sent again.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, Prompt, {});
        const r = yield* call(() =>
          a.h.agentPrompt(
            a.me.login,
            a.url.origin,
            String(b.text ?? ""),
            typeof b.context == "string" ? b.context : null,
            b.files,
            typeof b.doc == "string" ? b.doc : null,
            a.me.name,
            typeof b.id == "string" && /^[\w-]{1,64}$/.test(b.id) ? b.id : undefined
          )
        );
        return json(r, r.ok ? 200 : 409);
      }),
    action: "A message to your agent",
    ...PANEL_ROW,
  },
  { method: "POST", path: "/api/agent/abort", run: control("abort"), action: "Stop your agent", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/reset", run: control("reset"), action: "Start a new conversation with your agent", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/model", run: control("model"), action: "Switch your agent's model", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/approve", run: control("approve"), action: "Approve a call your agent asks for", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/deny", run: control("deny"), action: "Deny a call your agent asks for", ...PANEL_ROW },
  {
    method: "GET",
    path: "/api/agent/events",
    // A WebSocket (Upgrade: websocket, as the panel asks) or server-sent events, to that person's pages only: { type: "agent", ev }
    run: (a) => {
      const headers = new Headers(a.request.headers);
      headers.set("x-erga-login", a.me.login);
      return Effect.map(
        call(() => a.h.fetch(new Request(a.request.url, { headers }))),
        fromWeb
      );
    },
    action: "Your agent's live updates",
    domain: "none",
    exempt: STREAM,
  },
  {
    method: "GET",
    path: "/api/agent/conversation",
    // { log: { items, busy, undoable } }
    run: (a) => call(() => a.h.conversation(a.me.login)).pipe(Effect.map((log) => json({ log }))),
    action: "Your agent's conversation, kept",
    ...PANEL_ROW,
  },
  {
    method: "DELETE",
    path: "/api/agent/conversation",
    run: (a) => call(() => a.h.clearConversation(a.me.login)).pipe(Effect.map((log) => json({ ok: true, log }))),
    action: "A new conversation with your agent",
    ...PANEL_ROW,
  },
  {
    method: "POST",
    path: "/api/agent/comment",
    // { doc, thread, comment, text }: the person's click on "Run this comment as a request?", which the panel shows
    // for a comment with @erga sent with the page's edit key (the event { type: "comment-ask", ask }): their agent
    // takes the thread.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, CommentBody, {});
        const admin = yield* call(() => a.platform.directory.users.isAdmin(a.me.login));
        const caller: Caller = {
          dir: a.platform.directory,
          who: { login: a.me.login, ...(admin ? { admin: true } : {}) },
          name: a.me.name,
          origin: a.url.origin,
          platform: a.platform,
        };
        const r = yield* call(() => runComment(caller, b));
        return json(r, r.ok ? 200 : 409);
      }),
    action: "Run your comment with @erga as a request (the panel's question)",
    ...PANEL_ROW,
  },
  {
    method: "POST",
    path: "/api/agent/keys",
    // { name, value }: the person's own API key for a provider (Settings, Agent), in place of the one there was; a
    // secret, so set only here (whoami, revoke list and remove them). The answer has its last four characters, never the key.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, KeyBody, {});
        // A key that isn't one (the wrong provider's, a plan token) is refused, saying why.
        return yield* Effect.tryPromise({
          try: () => a.platform.directory.personKeys.set({ login: a.me.login }, b.name ?? "", b.value ?? ""),
          catch: (e) => (e instanceof Error ? e.message : String(e)),
        }).pipe(
          Effect.map((key) => json({ ok: true, key })),
          Effect.catch((error) => Effect.succeed(json({ ok: false, error }, 400)))
        );
      }),
    action: "Add or replace your own API key (Settings, Agent)",
    domain: "none",
    exempt: SECRET,
  },
];

