// Each person's agent, as a Durable Object (one per person, named by their login): the Cloudflare side of
// agents/person/sessions.ts. It gives the agent its SQLite and the Platform, forwards the calls the Worker makes
// (RPC), and wakes a run a restart cut off (its alarm). Its conversation, scope "you:<login>", is kept step by step
// (agents/checkpoint.ts, in agents/chat-store.ts's tables).
//
// It also keeps the person's conversations with the document agent, one for each document ("doc:<id>"): that agent
// runs in the document's object, where its tools are, and saves each checkpoint here.

import { DurableObject } from "cloudflare:workers";
import { ChatTables, STALE_MS, wakeRuns } from "../../agents/chat-store";
import { PersonAgents, type PersonAgentObject } from "../../agents/person/sessions.ts";
import { platform } from "../platform";
import type { ChatSave, StoredChat } from "../../agents/checkpoint";
import type { Env } from "../env";
import { documentOf } from "./document-stub";

export class PersonAgent extends DurableObject<Env> implements PersonAgentObject {
  private sql = {
    exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[],
    transaction: <R>(f: () => R) => this.ctx.storage.transactionSync(f),
  };
  private chats = new ChatTables(this.sql);
  private agents = new PersonAgents({ sql: this.sql, platform: platform(this.env), watch: () => void this.watch() });

  agentState(login: string, origin: string) { return this.agents.agentState(login, origin); }
  agentPrompt(login: string, origin: string, text: string, context: string | null, attached?: unknown) { return this.agents.agentPrompt(login, origin, text, context, attached); }
  agentControl(login: string, op: "abort" | "reset" | "model", model?: string) { return this.agents.agentControl(login, op, model); }
  conversation(login: string) { return this.agents.conversation(login); }
  clearConversation(login: string) { return this.agents.clearConversation(login); }
  agentPrefs(login: string) { return this.agents.agentPrefs(login); }
  setAgentPrefs(login: string, body: unknown) { return this.agents.setAgentPrefs(login, body); }
  /** The panel's events: a WebSocket (Upgrade: websocket), else server-sent events. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") return this.agents.fetch(request);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const leave = this.agents.join(request, (text) => server.send(text));
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);
    return new Response(null, { status: 101, webSocket: client });
  }

  async load(scope: string): Promise<StoredChat | null> { return this.chats.load(scope); }

  async save(scope: string, change: ChatSave): Promise<void> {
    this.chats.save(scope, change);
    if (change.state.running || change.state.queued.length) await this.watch();
  }

  async clear(scope: string): Promise<void> { this.chats.clear(scope); }

  /** While a run goes: the alarm looks again a little after its checkpoints should have come. */
  private async watch(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + STALE_MS + 5_000);
  }

  /** A run with no checkpoint for a while: it goes on from its last checkpoint, if it isn't running (the person's
   *  agent here; a document agent's, in its document). */
  async alarm(): Promise<void> {
    const mine = await this.agents.wake();
    const more = await wakeRuns(this.chats, async (scope, state) => {
      const doc = /^doc:(.+)$/.exec(scope)?.[1];
      if (!doc || !state.meta.person) return;
      await documentOf(this.env, doc).resumeAgent({ id: state.meta.person, name: state.meta.name ?? state.meta.person });
    });
    if (more || mine) await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
  }
}
