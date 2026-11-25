// Each person's agent, as a Durable Object (one per person, named by their login): the Cloudflare side of
// agents/person/sessions.ts. It gives the agent its SQLite and the Platform, forwards the calls the Worker makes
// (RPC), and wakes a run a restart cut off (its alarm). Each thread's conversation (one for each document, scope
// "thread:<doc>:<login>", and one for the rest of Erga, scope "you:<login>") is kept step by step
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

  agentState(login: string, doc: string | null, origin: string, name?: string, fresh?: boolean) {
    return this.agents.agentState(login, doc, origin, name, fresh);
  }
  agentPrompt(
    login: string,
    origin: string,
    text: string,
    context: string | null,
    attached?: unknown,
    doc?: string | null,
    name?: string,
    id?: string,
    page?: unknown
  ) {
    return this.agents.agentPrompt(login, origin, text, context, attached, doc, name, id, page);
  }
  agentControl(login: string, doc: string | null, op: "abort" | "reset" | "model" | "approve" | "deny", model?: string) {
    return this.agents.agentControl(login, doc, op, model);
  }
  conversation(login: string, doc: string | null) {
    return this.agents.conversation(login, doc);
  }
  clearConversation(login: string, doc: string | null) {
    return this.agents.clearConversation(login, doc);
  }
  /** The panel's events: a WebSocket (Upgrade: websocket), else server-sent events; or a local agent bridge socket. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname == "/api/agent/bridge") {
      if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") return new Response("Upgrade required", { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      const login = request.headers.get("x-erga-login") ?? "";
      const grantId = request.headers.get("x-erga-grant-id") ?? "";
      const label = request.headers.get("x-erga-grant-label") || "Agent";
      const onlyDoc = request.headers.get("x-erga-only-doc") || null;
      const origin = request.headers.get("x-erga-origin") || url.origin;
      const handle = this.agents.joinBridge(
        { login, grantId, label, onlyDoc, origin },
        (text) => server.send(text),
        () => {
          try {
            server.close(1000, "closed");
          } catch {
            /* already closed */
          }
        }
      );
      server.addEventListener("message", (ev) => handle.message(String(ev.data)));
      server.addEventListener("close", () => handle.close());
      server.addEventListener("error", () => handle.close());
      return new Response(null, { status: 101, webSocket: client });
    }
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
