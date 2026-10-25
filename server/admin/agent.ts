// The admin's agent, one per admin, kept in one object: each session, its
// conversation and panel layout, and the event stream its panel listens on.
// The panel is client/admin-agent.ts, on every admin page. This is the logic
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
// calls the same APIs the agent's tools do, and reads this first:
//
//   GET    /api/admin/guide                 the admin APIs, how to call them, and the token's limits

import { adminGuide, adminTools, dashboardTools, sourceTools, startAdminAgent, type AdminAgent, type DashboardOps } from "../../agents/admin.ts";
import { panelPrefs, type PanelPrefs } from "../../agents/admin-chats.ts";
import { ChatTables, tableStore, wakeRuns, type ChatSql } from "../../agents/chat-store.ts";
import { restoredLog } from "../../agents/checkpoint.ts";
import type { ToolWho } from "../../agents/tools.ts";
import { isModelChoice, MODELS } from "../../editor-agent/session.ts";
import { emptyLog, type Log, type Offer } from "../../shared/agent-log.ts";
import type { CredentialStatus } from "../../deploy/credential.ts";
import { checkAttachments } from "../../shared/attach.ts";
import { byLine, VIA } from "../../shared/attribution.ts";
import { forgetHome } from "../home/index.ts";
import { authOps, SHARE_ADMIN_HOURS } from "../identity/index.ts";
import { LOCKED } from "../directory/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import type { GithubStatus, SourceAnswer, SourceRead } from "../source/index.ts";

const enc = new TextEncoder();

/** This server's branch deploys, as the dashboard tools ask them (the pipeline's object answers, by RPC). */
export interface DashboardDeploys {
  status(history?: number): Promise<object>;
  logOf(target: string, deploy?: string): Promise<object | null>;
  redeploy(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** Back to the Worker version before the target's live deploy (its restore point). */
  rollback(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** The release store (deploy/releases.ts): both channels (null: no store). */
  releases(): Promise<object | null>;
  /** Each environment's domains, and one added or removed (deploy/branches.ts). */
  domains(): Promise<object>;
  addDomain(target: string, hostname: string, by: string): Promise<object>;
  removeDomain(target: string, hostname: string, by: string): Promise<object>;
  /** The control Worker's Cloudflare credential (deploy/credential.ts): its status, and revoked (the Ops page's card). */
  credentialStatus(): Promise<CredentialStatus>;
  disconnectCredential(): Promise<void>;
}

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
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Each admin's conversation, kept step by step (agents/checkpoint.ts), scope "admin:<login>". */
  private chats: ChatTables;

  constructor(private deps: AdminAgentsDeps) {
    deps.sql.exec(`CREATE TABLE IF NOT EXISTS agent_prefs (login TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated INTEGER NOT NULL)`);
    this.chats = new ChatTables(deps.sql);
  }

  private get platform() { return this.deps.platform; }

  /** Erga's repository, where this server has one. */
  private source() {
    const source = this.platform.source;
    if (!source) throw new Error("Erga's repository isn't set up on this server: it needs the Artifacts binding: bun deploy/setup.ts binds it, and server/source/import.ts fills it.");
    return source.object;
  }

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
    // The admin tools act as the admin, with admin power, via their agent: the change log names them, and how.
    const as = (): ToolWho => ({ dir: this.platform.directory, who: { login, admin: true, via: VIA.admin }, origin: state.origin, auth: authOps(this.platform, state.origin) });
    // The source tools read the server's copy of Erga's repository, read-only.
    const readSource = async (q: SourceRead): Promise<SourceAnswer> => {
      const r = await this.source().read(state.origin, q);
      if ("error" in r) throw new Error(r.error);
      return r;
    };
    const scope = `admin:${login}`;
    const store = tableStore(this.chats, scope, (running) => { if (running) this.deps.watch?.(); });
    const agent = startAdminAgent({ cfg, owner: login, tools: [...adminTools(as, guard), ...sourceTools(readSource, guard), ...dashboardTools(this.dashboard(login, state), guard)], store, stored: this.chats.load(scope), meta: { origin } });
    agent.subscribe((ev) => this.event({ type: "agent", ev }, login));
    s = Object.assign(state, { agent });
    this.agents.set(login, s);
    // A run a restart cut off goes on, from its last checkpoint.
    agent.resume().catch((e: unknown) => console.log(`couldn't resume ${login}'s admin agent: ${e}`));
    return s;
  }

  /**
   * The dashboard tools' work, as the admin: the same calls the Ops page's API
   * makes, and /settings' tokens, so the change log and a deploy's trigger name the admin, as when they click.
   */
  private dashboard(login: string, state: { origin: string }): DashboardOps {
    const source = () => this.source();
    const pipeline = () => this.platform.deploys;
    const withOffer = <T extends { credential?: CredentialStatus }>(o: T): T | (T & { offer: Offer; connect: string }) => !o.credential || o.credential.connected ? o : {
      ...o,
      offer: { kind: "connect-cloudflare", label: o.credential.by ? "Connect Cloudflare again" : "Connect Cloudflare", url: `${this.platform.control?.url ?? state.origin}/install/start?popup=1` },
      connect: "Nothing deploys until the admin connects Cloudflare. A Connect Cloudflare button shows under this call in their panel: it opens Cloudflare's consent in a popup, on this page. Tell them so, with Cloudflare's own words (credential.error, else credential.problem). You can't consent for them.",
    };
    const actor = async () => ({ login, name: (await this.platform.directory.users.get(login))?.name || login, via: VIA.admin });
    // Not connected (or the sync is refused): the answer carries Connect GitHub, a button under the call in the admin's panel
    // (the App's install page, in a popup, on the control Worker's origin). The consent is the admin's own.
    const withGithubOffer = <T extends { github: GithubStatus }>(o: T): T | (T & { offer: Offer; connect: string }) => o.github.connected && !o.github.error ? o : {
      ...o,
      offer: { kind: "connect-github", label: o.github.link ? "Connect GitHub again" : "Connect GitHub", url: `${this.platform.control?.url ?? state.origin}/github/connect?popup=1` },
      connect: o.github.connected ? "The sync with GitHub stopped (github.error says why). If GitHub refused the App's access, a Connect GitHub button shows under this call in the admin's panel: tell them to click it. You can't consent for them." : "Nothing syncs with GitHub until the admin connects a repository. A Connect GitHub button shows under this call in their panel: it opens the App's install page on GitHub in a popup, where they pick the account and the repository. Tell them so. You can't consent for them, and there's no token to ask for.",
    };
    return {
      branches: async () => source().branches(state.origin),
      release: async (commit) => {
        const r = await source().merge(state.origin, await actor(), commit);
        if ("error" in r) throw new Error(r.error);
        return { ...r, done: r.upToDate ? "main was at staging already: nothing to deploy" : `main moved to ${r.commit.slice(0, 10)}: production deploys it now (list_deploys follows it)` };
      },
      // GitHub: the status (with Connect GitHub, a button in the panel, when nothing is connected), a sync now, Disconnect.
      githubStatus: async () => withGithubOffer({ github: await source().githubStatus(state.origin), conflict: (await source().branches(state.origin)).conflict ?? null }),
      syncGithub: async () => {
        const github = await source().syncGithub(state.origin, byLine(login, VIA.admin));
        return withGithubOffer({ github, done: github.error ? `the sync stopped: ${github.error}` : "in sync: what GitHub had came in, what it lacked went out" });
      },
      disconnectGithub: async () => {
        const r = await source().disconnectGithub(state.origin);
        if ("error" in r) throw new Error(r.error);
        return withGithubOffer({ github: await source().githubStatus(state.origin), done: "GitHub is disconnected: the repository there stays, the App is uninstalled from the account, and nothing syncs until the admin connects GitHub again" });
      },
      // Not connected: the answer carries Connect Cloudflare, a button under the call in the admin's panel (a consent in a
      // popup, on the control Worker's origin). The consent is the admin's own: the agent only offers it.
      deploys: async (history) => withOffer(await pipeline().status(history) as { credential?: CredentialStatus }),
      // (From the deploys' status: a control Worker a release behind has no credentialStatus over its binding yet.)
      credential: async () => withOffer({ credential: ((await pipeline().status(0)) as { credential?: CredentialStatus }).credential }),
      disconnectCredential: async () => {
        await pipeline().disconnectCredential();
        return { done: "The control Worker's Cloudflare grant is revoked: nothing deploys until the admin connects Cloudflare again (a consent of their own)", credential: await pipeline().credentialStatus() };
      },
      deployLog: (target, deploy) => pipeline().logOf(target, deploy),
      redeploy: async (target, fresh) => {
        const r = fresh ? await pipeline().redeployWith(target, `redeploy by ${byLine(login, VIA.admin)}`, { fresh: true }) : await pipeline().redeploy(target, `redeploy by ${byLine(login, VIA.admin)}`);
        if (!r.ok) throw new Error(r.error ?? "refused");
        return { done: `${target} redeploys now${fresh ? ", with a fresh copy of production's data" : ""}`, target: r.status };
      },
      rollback: async (target) => {
        const r = await pipeline().rollback(target, `rollback by ${byLine(login, VIA.admin)}`);
        if (!r.ok) throw new Error(r.error ?? "refused");
        return { done: `${target} is rolled back`, target: r.status };
      },
      releases: async () => (await pipeline().releases()) ?? { error: "This server has no release store." },
      cutRelease: async (version, notes) => {
        const r = await source().release(state.origin, await actor(), { ...(version ? { version } : {}), ...(notes ? { notes } : {}) });
        if ("error" in r) throw new Error(r.error);
        return { ...r, done: `release ${r.tag} cut at ${r.commit.slice(0, 10)}: it goes on stable once its build is in the store, and installs that follow stable upgrade to it` };
      },
      domains: async () => {
        const r = await pipeline().domains() as { error?: string };
        if (r.error) throw new Error(r.error);
        return r;
      },
      addDomain: async (target, hostname) => {
        const r = await pipeline().addDomain(target, hostname, byLine(login, VIA.admin)) as { error?: string };
        if (r.error) throw new Error(r.error);
        return { ...r, done: `${hostname} added to ${target}: Cloudflare makes its DNS record and certificate in a minute or two` };
      },
      removeDomain: async (target, hostname) => {
        const r = await pipeline().removeDomain(target, hostname, byLine(login, VIA.admin)) as { error?: string };
        if (r.error) throw new Error(r.error);
        return { ...r, done: `${hostname} removed from ${target}` };
      },
      updateFromUpstream: async () => {
        const r = await source().update(state.origin, await actor());
        if ("error" in r) throw new Error(r.error);
        const done = r.result == "up-to-date" ? "staging has everything upstream's channel has: nothing to update"
          : r.result == "conflicts" ? `the merge of ${r.conflict.version} waits on the branch ${r.conflict.branch}: ${r.conflict.files.length} file${r.conflict.files.length == 1 ? "" : "s"} conflict (${r.conflict.files.map((f) => f.path).join(", ")}). Read each at that branch, resolve it with resolve_conflict_file, then finish_waiting_merge`
          : `staging is at ${r.commit.slice(0, 10)} (${r.result}, ${r.version}, ${r.brought} commit${r.brought == 1 ? "" : "s"} brought in): staging deploys it; production follows through deploy_production`;
        return { ...r, done };
      },
      resolveConflictFile: async (path, content) => {
        const r = await source().resolveUpdate(state.origin, await actor(), path, content);
        if ("error" in r) throw new Error(r.error);
        return { ...r, done: r.remaining.length ? `${r.path} written; still carrying markers: ${r.remaining.join(", ")}` : `${r.path} written; no file carries markers: finish_waiting_merge finishes the merge` };
      },
      finishWaitingMerge: async () => {
        const r = await source().finishUpdate(state.origin, await actor());
        if ("error" in r) throw new Error(r.error);
        return { ...r, done: `merged ${r.version}: staging is at ${r.commit.slice(0, 10)} and deploys it; production follows through deploy_production` };
      },
      dropWaitingMerge: async () => {
        const r = await source().abandonUpdate(state.origin);
        if ("error" in r) throw new Error(r.error);
        return { done: "the waiting merge and its branch are gone; staging is as it was" };
      },
      deployHome: async () => {
        if (!(await this.platform.directory.homeId())) throw new Error("No document is the homepage (the landing_document setting): there's nothing to deploy.");
        const status = await this.platform.home.deploy(byLine(login, VIA.admin));
        await forgetHome(this.platform, new URL(state.origin)).catch(() => {});
        return { done: "The homepage deploys now", status };
      },
      agentTokens: async () => (await this.platform.tokens.list(login)).map((t) => ({ id: t.id, label: t.label, kind: t.kind, scope: t.scope, docId: t.docId, created: t.created, expires: t.expires, lastUsed: t.lastUsed })),
      revokeAgentToken: (id) => this.platform.tokens.revoke(login, id, VIA.admin),
    };
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
    this.beat ??= setInterval(() => {
      for (const c of this.clients.keys()) this.send(c, ": beat\n\n");
      for (const to of this.sockets.keys()) this.sendTo(to, '{"type":"beat"}');
      if (!this.clients.size && !this.sockets.size && this.beat) { clearInterval(this.beat); this.beat = null; }
    }, 20_000);
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

// ---------------------------------------------------------------- the routes

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** An admin, signed in (the person, in a browser: for their own agent panel, which no token reaches). */
async function adminOf(platform: Platform, request: Request): Promise<{ login: string; name: string } | null> {
  const session = await platform.sessionOf(request);
  if (!session || session.test || session.agent) return null;
  if (!(await platform.directory.users.actsAsAdmin(whoOf(session)))) return null;
  return { login: session.login.toLowerCase(), name: session.name };
}

/** An admin, or an outside agent acting as one: with `token`, it came with an admin token. */
type GuideReader = { login: string; name: string; token?: { id: string; label: string; expires: number | null } };

/** Who asks for the admin guide: an admin signed in in a browser, or an outside agent with an admin token. */
async function guideReaderOf(platform: Platform, request: Request, url: URL): Promise<GuideReader | Response> {
  const raw = /^Bearer\s+(erga_\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (raw) {
    const again = `Ask an admin for a new one (Share with agent, on any page under ${url.origin}/admin), or make an admin token at ${url.origin}/tokens.`;
    const t = await platform.tokens.verify(raw).catch(() => null);
    if (!t) return json({ error: `That token doesn't work: it expired, or was revoked. ${again}` }, 401);
    if (t.testBy || !(await platform.directory.users.isAdmin(t.login))) return json({ error: `Only admins can do that, and ${t.login} isn't one.` }, 403);
    if (t.scope != "admin") return json({ error: LOCKED, locked: true }, 403);
    return { login: t.login, name: t.name, token: { id: t.id, label: t.label, expires: t.expires } };
  }
  const admin = await adminOf(platform, request);
  if (admin) return admin;
  return json({ error: `Only admins can do that: sign in, or send an admin token as "Authorization: Bearer <token>".` }, (await platform.sessionOf(request)) ? 403 : 401);
}

/** GET /api/admin/guide: the admin guide, for an admin or their agent with an admin token. */
export async function adminGuideApi(request: Request, platform: Platform, url: URL): Promise<Response> {
  const reader = await guideReaderOf(platform, request, url);
  if (reader instanceof Response) return reader;
  if (request.method != "GET") return json({ error: "Not found" }, 404);
  const body = adminGuide({ origin: url.origin, owner: reader.login, label: reader.token?.label ?? "(your token's label)", expires: reader.token ? reader.token.expires : Date.now() + SHARE_ADMIN_HOURS * 3600_000 });
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
}

export const isAdminAgentPath = (path: string) => path == "/api/admin/agent" || path.startsWith("/api/admin/agent/");

/** /api/admin/agent...: the admin's own agent panel. */
export async function adminAgentApi(request: Request, platform: Platform, url: URL): Promise<Response> {
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? "")) return json({ error: `The admin's agent panel is theirs, in a browser: an outside agent calls the same APIs itself (GET ${url.origin}/api/admin/guide).` }, 403);
  const admin = await adminOf(platform, request);
  if (!admin) return json({ error: "Only admins have an admin agent." }, (await platform.sessionOf(request)) ? 403 : 401);
  if (request.method != "GET" && request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
  const h = platform.adminAgent, path = url.pathname.replace(/\/$/, ""), m = request.method;
  if (path == "/api/admin/agent") {
    if (m == "GET") return json(await h.agentState(admin.login, url.origin));
    if (m == "POST") {
      const body = await request.json().catch(() => ({})) as { text?: unknown; context?: unknown; files?: unknown };
      const r = await h.agentPrompt(admin.login, url.origin, String(body.text ?? ""), typeof body.context == "string" ? body.context : null, body.files);
      return json(r, r.ok ? 200 : 409);
    }
  }
  const control = /^\/api\/admin\/agent\/(abort|reset|model)$/.exec(path)?.[1] as "abort" | "reset" | "model" | undefined;
  if (control && m == "POST") {
    const body = control == "model" ? await request.json().catch(() => ({})) as { model?: string } : {};
    const r = await h.agentControl(admin.login, control, body.model);
    return json(r, r.ok ? 200 : 409);
  }
  if (path == "/api/admin/agent/events" && m == "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-erga-login", admin.login);
    return h.fetch(new Request(request.url, { headers }));
  }
  if (path == "/api/admin/agent/conversation") {
    if (m == "GET") return json({ log: await h.conversation(admin.login) });
    if (m == "DELETE") return json({ ok: true, log: await h.clearConversation(admin.login) });
  }
  if (path == "/api/admin/agent/prefs") {
    if (m == "GET") return json(await h.agentPrefs(admin.login));
    if (m == "PUT") return json(await h.setAgentPrefs(admin.login, await request.json().catch(() => ({}))));
  }
  return json({ error: "Not found" }, 404);
}
