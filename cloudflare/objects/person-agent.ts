// Each person's agent, as a Durable Object (one per person, named by their login): the Cloudflare side of
// agents/person/sessions.ts. It gives the agent its SQLite and the Platform, forwards the calls the Worker makes
// (RPC), and wakes a run a restart cut off (its alarm). Its conversation, scope "you:<login>", is kept step by step
// (agents/checkpoint.ts, in agents/chat-store.ts's tables).
//
// (Before the one agent, it kept each person's conversations with a document's own agent, scope "doc:<id>": rows that
// stay, and that nothing wakes.)

import { DurableObject } from "cloudflare:workers";
import { STALE_MS } from "../../agents/chat-store";
import { PersonAgents, type PersonAgentObject } from "../../agents/person/sessions.ts";
import { platform } from "../platform";
import { blobsOf } from "../blobs";
import type { Env } from "../env";

export class PersonAgent extends DurableObject<Env> implements PersonAgentObject {
  private sql = {
    exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[],
    transaction: <R>(f: () => R) => this.ctx.storage.transactionSync(f),
  };
  private agents = new PersonAgents({
    sql: this.sql,
    platform: platform(this.env),
    blobs: blobsOf(this.env),
    watch: () => void this.watch(),
  });

  agentState(login: string, origin: string, name?: string, fresh?: boolean) {
    return this.agents.agentState(login, origin, name, fresh);
  }
  agentPrompt(
    login: string,
    origin: string,
    text: string,
    context: string | null,
    attached?: unknown,
    doc?: string | null,
    name?: string,
    id?: string
  ) {
    return this.agents.agentPrompt(login, origin, text, context, attached, doc, name, id);
  }
  agentControl(login: string, op: "abort" | "reset" | "model", model?: string) {
    return this.agents.agentControl(login, op, model);
  }
  conversation(login: string) {
    return this.agents.conversation(login);
  }
  clearConversation(login: string) {
    return this.agents.clearConversation(login);
  }
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

  /** While a run goes: the alarm looks again a little after its checkpoints should have come. */
  private async watch(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + STALE_MS + 5_000);
  }

  /** A run with no checkpoint for a while: it goes on from its last checkpoint, if it isn't running. */
  async alarm(): Promise<void> {
    if (await this.agents.wake()) await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
  }
}
