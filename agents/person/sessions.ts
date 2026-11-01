// Each person's agent, kept in their own object (PersonAgent, named by their login): the session, its conversation and
// panel layout, and the event stream their pages listen on. The panel is client/agent/person-agent.ts, on every page.
// This is the logic (PersonAgents) and the routes; the Durable Object (cloudflare/objects/person-agent.ts) gives it its
// SQLite and forwards the calls.
//
//   GET    /api/agent                 { enabled, reason?, model, models, choice, log }
//   POST   /api/agent                 { text, context, files? }: a message (it steers a turn that is running); context
//                                     is the page note: the page open, what is selected there
//   POST   /api/agent/abort|reset     stops the turn; starts a new conversation
//   POST   /api/agent/model           { model }: sonnet or opus-fast, from the next message
//   GET    /api/agent/events          a WebSocket (Upgrade: websocket, as the panel asks) or server-sent events, to that
//                                     person's pages only: { type: "agent", ev }
//   GET    /api/agent/conversation    { log: { items, busy, undoable } }: the conversation
//   DELETE /api/agent/conversation    a new conversation (the "New conversation" button)
//   GET    /api/agent/prefs           { open?, side?, width? }: their panel, as they left it
//   PUT    /api/agent/prefs           { open?, side?, width? }: changes what's given
//
// The panel is the person's, in a browser: no token reaches it. An outside agent with a token
// ("Authorization: Bearer erga_...", server/identity) calls the same tools itself (MCP, POST /api/tools/<name>,
// server/api.ts), and reads the guide first (/llms.txt).

import { startAgent, type AgentSession } from "./agent.ts";
import { panelPrefs, type PanelPrefs } from "./panel.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, toolsFor } from "../tools.ts";
import type { Caller } from "../../server/operations/index.ts";
import { isModelChoice, MODELS } from "../models.ts";
import { emptyLog, type Log } from "../../shared/agent-log.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { VIA } from "../../shared/attribution.ts";
import { authOps } from "../../server/identity/index.ts";
import type { Platform } from "../../server/platform.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { call, ctx, fromWeb, json, type Route } from "../../server/http.ts";

const enc = new TextEncoder();

/**
 * What the agents need from where they run: their SQLite, the Platform (the
 * directory, tokens, the repository, the deploys, the homepage), and an
 * alarm, set while a run goes (`wake` when it rings).
 */
export interface PersonAgentsDeps {
  sql: ChatSql;
  platform: Platform;
  watch?: () => void;
}

export class PersonAgents {
  /** The event streams open, each with the person it's for. */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, string>();
  private sockets = new Map<(text: string) => void, string>();
  /** Each person's agent (one, in their object), with where the server is, as their page said last. */
  private agents = new Map<string, { agent: AgentSession; origin: string }>();
  private beat: Fiber.Fiber<void> | null = null;
  /** Each person's conversation, kept step by step (agents/checkpoint.ts), scope "you:<login>". */
  private chats: ChatTables;

  constructor(private deps: PersonAgentsDeps) {
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS agent_prefs (login TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated INTEGER NOT NULL)`);
    this.chats = new ChatTables(deps.sql);
  }

  private get platform() { return this.deps.platform; }

  /**
   * The person's session, made the first time; the origin is the latest the page sent. An admin's has the admin's
   * tools and prompt (as they are when it starts; each tool call checks again: Users.mustAdmin).
   * The settings are read each time (each turn, each time the panel opens), so a key an admin stores, replaces or clears reaches it.
   */
  private async session(login: string, origin: string): Promise<{ agent: AgentSession; origin: string } | string> {
    const cfg = await this.platform.agentSettings().catch((e: unknown) => ({ missing: `the agent's settings couldn't be read (${e instanceof Error ? e.message : String(e)}); try again in a moment` }));
    if ("missing" in cfg) return cfg.missing;
    let s = this.agents.get(login);
    if (s) { s.origin = origin; s.agent.configure(cfg); return s; }
    const state = { origin };
    const admin = await this.platform.directory.users.isAdmin(login);
    // Every tool acts as the person, via their agent: the change log and a document's history name them, and how.
    const as = (): Caller => ({
      dir: this.platform.directory,
      who: { login, ...(admin ? { admin: true } : {}), via: VIA.agent },
      name: login,
      origin: state.origin,
      platform: this.platform,
      auth: authOps(this.platform, state.origin),
    });
    const scope = `you:${login}`;
    const store = tableStore(this.chats, scope, (running) => {
      if (running) this.deps.watch?.();
    });
    const agent = startAgent({
      cfg,
      owner: login,
      admin,
      tools: agentTools(await toolsFor(as()), as),
      store,
      stored: this.chats.load(scope),
      meta: { origin },
    });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login));
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    // A run a restart cut off goes on, from its last checkpoint.
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s agent: ${e}`));
    return s;
  }

  async agentState(login: string, origin: string) {
    const s = await this.session(login, origin);
    if (typeof s == "string") return { enabled: false as const, reason: s };
    const models = s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [];
    return { enabled: true as const, model: s.agent.model, choice: s.agent.modelChoice, models, log: s.agent.log() };
  }

  async agentPrompt(login: string, origin: string, text: string, context: string | null, attached?: unknown): Promise<{ ok: boolean; reason?: string }> {
    const s = await this.session(login, origin);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    const files = checkAttachments(attached);
    if (typeof files == "string") return { ok: false, reason: files };
    if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null, files);
    return { ok: true };
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
      if (login && state.meta.origin) await this.session(login, state.meta.origin);
    });
  }

  /** A new conversation: the turn stopped, the transcript and the model's messages gone, every tab told. */
  async clearConversation(login: string): Promise<Log> {
    const s = this.agents.get(login);
    if (s) await s.agent.reset();
    else this.event({ type: "agent", ev: { t: "reset" } }, login);
    this.chats.clear(`you:${login}`);
    return emptyLog();
  }

  async agentPrefs(login: string): Promise<PanelPrefs> {
    const r = this.deps.sql.exec<{ prefs: string }>("SELECT prefs FROM agent_prefs WHERE login = ?", login)[0];
    try { return panelPrefs(JSON.parse(r?.prefs ?? "{}")); } catch { return {}; }
  }

  /** Changes what's given (open, side, width), keeps the rest. */
  async setAgentPrefs(login: string, body: unknown): Promise<PanelPrefs> {
    const prefs = { ...(await this.agentPrefs(login)), ...panelPrefs(body) };
    this.deps.sql.exec("INSERT OR REPLACE INTO agent_prefs (login, prefs, updated) VALUES (?, ?, ?)", login, JSON.stringify(prefs), Date.now());
    return prefs;
  }

  async agentControl(login: string, op: "abort" | "reset" | "model", model?: string) {
    const s = this.agents.get(login);
    if (!s) {
      if (op == "reset") await this.clearConversation(login);
      return { ok: op != "model", reason: "the agent hasn't started" };
    }
    if (op == "abort") s.agent.abort();
    else if (op == "reset") await this.clearConversation(login);
    else if (!model || !isModelChoice(model) || !s.agent.setModel(model)) return { ok: false, reason: "that model isn't one of the choices" };
    return { ok: true, model: s.agent.model, choice: s.agent.modelChoice, models: s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [] };
  }

  // -- live updates: the event stream of one person's pages

  async fetch(request: Request): Promise<Response> {
    this.keepBeating();
    const login = request.headers.get("x-erga-login") ?? "";
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.clients.set(w, login);
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
    this.sockets.set(send, request.headers.get("x-erga-login") ?? "");
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
  "agentState" | "agentPrompt" | "agentControl" | "conversation" | "clearConversation" | "agentPrefs" | "setAgentPrefs" | "fetch"
>;

declare module "../../server/platform.ts" {
  interface Platform {
    /** A person's agent: their own object, named by their login. */
    personAgent(login: string): PersonAgentObject;
  }
}

// ---------------------------------------------------------------- the routes

/** Someone signed in, in person (in a browser: for their own agent panel, which no token reaches). Test people have none. */
const personOf = (platform: Platform, request: Request) =>
  call(async (): Promise<{ login: string } | null> => {
    const session = await platform.sessionOf(request);
    if (!session || session.test || session.agent) return null;
    return { login: session.login.toLowerCase() };
  });

export const isAgentPath = (path: string) => path == "/api/agent" || path.startsWith("/api/agent/");

/** The bodies the panel sends: a message, a model, its preferences (panel.ts checks those). */
const Prompt = Schema.Struct({
  text: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  files: Schema.optionalKey(Schema.Unknown),
});
const ModelBody = Schema.Struct({ model: Schema.optionalKey(Schema.String) });

/** The body as JSON, as `schema` has it; else `fallback` (a body that isn't JSON counts as none, as before). */
const body = <S extends Schema.Top>(request: Request, schema: S, fallback: S["Type"]) =>
  call(() => request.text()).pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema as unknown as Schema.Codec<S["Type"]>))(t)),
    Effect.orElseSucceed(() => fallback)
  );

/** /api/agent...: the person's own agent panel. */
export const agentApi: Route = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? ""))
    return json(
      { error: `The agent panel is a person's, in a browser: an outside agent calls the same tools itself (GET ${url.origin}/llms.txt).` },
      403
    );
  const me = yield* personOf(platform, request);
  if (!me)
    return json({ error: "Sign in as yourself to talk to your agent." }, (yield* call(() => platform.sessionOf(request))) ? 403 : 401);
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const h = platform.personAgent(me.login),
    path = url.pathname.replace(/\/$/, ""),
    m = request.method;
  if (path == "/api/agent") {
    if (m == "GET") return json(yield* call(() => h.agentState(me.login, url.origin)));
    if (m == "POST") {
      const b = yield* body(request, Prompt, {});
      const r = yield* call(() =>
        h.agentPrompt(me.login, url.origin, String(b.text ?? ""), typeof b.context == "string" ? b.context : null, b.files)
      );
      return json(r, r.ok ? 200 : 409);
    }
  }
  const control = /^\/api\/agent\/(abort|reset|model)$/.exec(path)?.[1] as "abort" | "reset" | "model" | undefined;
  if (control && m == "POST") {
    const b = control == "model" ? yield* body(request, ModelBody, {}) : {};
    const r = yield* call(() => h.agentControl(me.login, control, b.model));
    return json(r, r.ok ? 200 : 409);
  }
  if (path == "/api/agent/events" && m == "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-erga-login", me.login);
    return fromWeb(yield* call(() => h.fetch(new Request(request.url, { headers }))));
  }
  if (path == "/api/agent/conversation") {
    if (m == "GET") return json({ log: yield* call(() => h.conversation(me.login)) });
    if (m == "DELETE") return json({ ok: true, log: yield* call(() => h.clearConversation(me.login)) });
  }
  if (path == "/api/agent/prefs") {
    if (m == "GET") return json(yield* call(() => h.agentPrefs(me.login)));
    if (m == "PUT") {
      const prefs = yield* body(request, Schema.Unknown, {});
      return json(yield* call(() => h.setAgentPrefs(me.login, prefs)));
    }
  }
  return json({ error: "Not found" }, 404);
});
