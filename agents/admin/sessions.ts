// The admin's agent, one per admin, kept in one object: each session, its
// conversation and panel layout, and the event stream its panel listens on.
// The panel is client/admin/admin-agent.ts, on every admin page. This is the logic
// (AdminAgents) and the routes; the Durable Object
// (cloudflare/objects/admin-agent.ts) gives it its SQLite and forwards the calls.
//
//   GET    /api/admin/agent                 { enabled, reason?, model, models, choice, log }
//   POST   /api/admin/agent                 { text, context, files? }: a message (it steers a turn that is running)
//   POST   /api/admin/agent/abort|reset     stops the turn; starts a new conversation
//   POST   /api/admin/agent/model           { model }: sonnet or opus-fast, from the next message
//   GET    /api/admin/agent/events          a WebSocket (Upgrade: websocket, as the panel asks) or server-sent events, to that
//                                           admin's pages only: { type: "agent", ev }
//   GET    /api/admin/agent/conversation    { log: { items, busy, undoable } }: the admin's conversation
//   DELETE /api/admin/agent/conversation    a new conversation (the "New conversation" button)
//   GET    /api/admin/agent/prefs           { open?, side?, width? }: their panel, as they left it
//   PUT    /api/admin/agent/prefs           { open?, side?, width? }: changes what's given
//
// The panel is the admin's, in a browser: no token reaches it. An outside agent with an admin token
// ("Authorization: Bearer erga_...", server/identity, scope admin; Share with agent on the admin pages makes one)
// calls the same tools itself (POST /api/tools/<name>, server/api.ts), and reads the guide first (/llms.txt).

import { startAdminAgent, type AdminAgent } from "./agent.ts";
import { panelPrefs, type PanelPrefs } from "./panel.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../chat-store.ts";
import { restoredLog } from "../checkpoint.ts";
import { agentTools, allTools } from "../tools.ts";
import type { Caller } from "../../server/operations/index.ts";
import { isModelChoice, MODELS } from "../models.ts";
import { emptyLog, type Log } from "../../shared/agent-log.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { VIA } from "../../shared/attribution.ts";
import { authOps } from "../../server/identity/index.ts";
import { whoOf, type Platform } from "../../server/platform.ts";
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
export interface AdminAgentsDeps {
  sql: ChatSql;
  platform: Platform;
  watch?: () => void;
}

export class AdminAgents {
  /** The event streams open, each with the admin it's for. */
  private clients = new Map<WritableStreamDefaultWriter<Uint8Array>, string>();
  private sockets = new Map<(text: string) => void, string>();
  /** Each admin's agent, with where the server is, as their page said last. */
  private agents = new Map<string, { agent: AdminAgent; origin: string }>();
  private beat: Fiber.Fiber<void> | null = null;
  /** Each admin's conversation, kept step by step (agents/checkpoint.ts), scope "admin:<login>". */
  private chats: ChatTables;

  constructor(private deps: AdminAgentsDeps) {
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS agent_prefs (login TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated INTEGER NOT NULL)`);
    this.chats = new ChatTables(deps.sql);
  }

  private get platform() { return this.deps.platform; }

  /** Why the admin may not act now, or null: they must still be an admin. Every tool call asks. */
  private async refusal(login: string): Promise<string | null> {
    if (!(await this.platform.directory.users.isAdmin(login))) return "Only admins have an admin agent.";
    return null;
  }

  /**
   * The admin's session, made the first time; the origin is the latest the page sent.
   * The settings are read each time (each turn, each time the panel opens), so a key an admin stores, replaces or clears reaches it.
   */
  private async session(login: string, origin: string): Promise<{ agent: AdminAgent; origin: string } | string> {
    const cfg = await this.platform.agentSettings().catch((e: unknown) => ({ missing: `the agent's settings couldn't be read (${e instanceof Error ? e.message : String(e)}); try again in a moment` }));
    if ("missing" in cfg) return cfg.missing;
    let s = this.agents.get(login);
    if (s) { s.origin = origin; s.agent.configure(cfg); return s; }
    const state = { origin };
    const guard = async () => {
      const why = await this.refusal(login);
      if (why) throw new Error(why);
    };
    // Every tool acts as the admin, with admin power, via their agent: the change log names them, and how. Their
    // documents too: the agent can do all they can.
    const as = (): Caller => ({
      dir: this.platform.directory,
      who: { login, admin: true, via: VIA.admin },
      name: login,
      origin: state.origin,
      platform: this.platform,
      auth: authOps(this.platform, state.origin),
    });
    const scope = `admin:${login}`;
    const store = tableStore(this.chats, scope, (running) => {
      if (running) this.deps.watch?.();
    });
    const agent = startAdminAgent({
      cfg,
      owner: login,
      tools: agentTools(allTools(), as, guard),
      store,
      stored: this.chats.load(scope),
      meta: { origin },
    });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login));
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    // A run a restart cut off goes on, from its last checkpoint.
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s admin agent: ${e}`));
    return s;
  }

  async agentState(login: string, origin: string) {
    const s = await this.session(login, origin);
    if (typeof s == "string") return { enabled: false as const, reason: s };
    const models = s.agent.modelChoice ? Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })) : [];
    return { enabled: true as const, model: s.agent.model, choice: s.agent.modelChoice, models, log: s.agent.log() };
  }

  async agentPrompt(login: string, origin: string, text: string, context: string | null, attached?: unknown): Promise<{ ok: boolean; reason?: string }> {
    const why = await this.refusal(login);
    if (why) return { ok: false, reason: why };
    const s = await this.session(login, origin);
    if (typeof s == "string") return { ok: false, reason: `the agent is off: ${s}` };
    const files = checkAttachments(attached);
    if (typeof files == "string") return { ok: false, reason: files };
    if (!text.trim() && !files.length) return { ok: false, reason: "say something" };
    s.agent.prompt(text.slice(0, 20000), context ? context.slice(0, 4000) : null, files);
    return { ok: true };
  }

  // -- each admin's conversation, kept

  /** The admin's conversation: the live one, or the one stored (the agent need not be on to read it). */
  async conversation(login: string): Promise<Log> {
    const live = this.agents.get(login)?.agent.log();
    if (live) return live;
    const stored = this.chats.load(`admin:${login}`);
    return stored ? restoredLog(stored) : emptyLog();
  }

  /** The object's alarm: each run a restart cut off goes on (its session starts, and resumes). Answers whether some still run. */
  async wake(): Promise<boolean> {
    return wakeRuns(this.chats, async (scope, state) => {
      const login = /^admin:(.+)$/.exec(scope)?.[1];
      if (login && state.meta.origin) await this.session(login, state.meta.origin);
    });
  }

  /** A new conversation: the turn stopped, the transcript and the model's messages gone, every tab told. */
  async clearConversation(login: string): Promise<Log> {
    const s = this.agents.get(login);
    if (s) await s.agent.reset();
    else this.event({ type: "agent", ev: { t: "reset" } }, login);
    this.chats.clear(`admin:${login}`);
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

  // -- live updates: the event stream of one admin's pages

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

  /** An event for that admin's pages only. */
  private event(data: Record<string, unknown>, login: string) {
    const text = JSON.stringify(data), line = enc.encode(`data: ${text}\n\n`);
    for (const [c, who] of this.clients) if (who == login) this.send(c, line);
    for (const [to, who] of this.sockets) if (who == login) this.sendTo(to, text);
  }

  /**
   * A WebSocket's side of the stream (the panel's: the Durable Object accepts it): that admin's events, as JSON, to
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

/** What the routes ask of the admins' agents (the Durable Object answers, by RPC, forwarding to an AdminAgents). */
export type AdminAgentObject = Pick<AdminAgents, "agentState" | "agentPrompt" | "agentControl" | "conversation" | "clearConversation" | "agentPrefs" | "setAgentPrefs" | "fetch">;

declare module "../../server/platform.ts" {
  interface Platform {
    /** The admins' agents, one object per server. */
    adminAgent: AdminAgentObject;
  }
}

// ---------------------------------------------------------------- the routes


/** An admin, signed in (the person, in a browser: for their own agent panel, which no token reaches). */
const adminOf = (platform: Platform, request: Request) =>
  call(async (): Promise<{ login: string; name: string } | null> => {
    const session = await platform.sessionOf(request);
    if (!session || session.test || session.agent) return null;
    if (!(await platform.directory.users.actsAsAdmin(whoOf(session)))) return null;
    return { login: session.login.toLowerCase(), name: session.name };
  });

export const isAdminAgentPath = (path: string) => path == "/api/admin/agent" || path.startsWith("/api/admin/agent/");

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

/** /api/admin/agent...: the admin's own agent panel. */
export const adminAgentApi: Route = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? ""))
    return json(
      {
        error: `The admin's agent panel is theirs, in a browser: an outside agent calls the same tools itself, with an admin token (GET ${url.origin}/llms.txt).`,
      },
      403
    );
  const admin = yield* adminOf(platform, request);
  if (!admin) return json({ error: "Only admins have an admin agent." }, (yield* call(() => platform.sessionOf(request))) ? 403 : 401);
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const h = platform.adminAgent, path = url.pathname.replace(/\/$/, ""), m = request.method;
  if (path == "/api/admin/agent") {
    if (m == "GET") return json(yield* call(() => h.agentState(admin.login, url.origin)));
    if (m == "POST") {
      const b = yield* body(request, Prompt, {});
      const r = yield* call(() =>
        h.agentPrompt(admin.login, url.origin, String(b.text ?? ""), typeof b.context == "string" ? b.context : null, b.files)
      );
      return json(r, r.ok ? 200 : 409);
    }
  }
  const control = /^\/api\/admin\/agent\/(abort|reset|model)$/.exec(path)?.[1] as "abort" | "reset" | "model" | undefined;
  if (control && m == "POST") {
    const b = control == "model" ? yield* body(request, ModelBody, {}) : {};
    const r = yield* call(() => h.agentControl(admin.login, control, b.model));
    return json(r, r.ok ? 200 : 409);
  }
  if (path == "/api/admin/agent/events" && m == "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-erga-login", admin.login);
    return fromWeb(yield* call(() => h.fetch(new Request(request.url, { headers }))));
  }
  if (path == "/api/admin/agent/conversation") {
    if (m == "GET") return json({ log: yield* call(() => h.conversation(admin.login)) });
    if (m == "DELETE") return json({ ok: true, log: yield* call(() => h.clearConversation(admin.login)) });
  }
  if (path == "/api/admin/agent/prefs") {
    if (m == "GET") return json(yield* call(() => h.agentPrefs(admin.login)));
    if (m == "PUT") {
      const prefs = yield* body(request, Schema.Unknown, {});
      return json(yield* call(() => h.setAgentPrefs(admin.login, prefs)));
    }
  }
  return json({ error: "Not found" }, 404);
});
