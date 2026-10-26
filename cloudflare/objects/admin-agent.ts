// The admins' agents, as a Durable Object (one, named "admin"): the Cloudflare
// side of agents/admin/sessions.ts. It gives the agents their SQLite and the
// Platform, forwards the calls the Worker makes (RPC), and wakes a run a
// restart cut off (its alarm).

import { DurableObject } from "cloudflare:workers";
import { AdminAgents, type AdminAgentObject } from "../../agents/admin/sessions.ts";
import type { Env } from "../env";
import { platform } from "../platform";
import { STALE_MS } from "../../agents/chat-store";

export class AdminAgentHost extends DurableObject<Env> implements AdminAgentObject {
  private agents = new AdminAgents({
    sql: {
      exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[],
      transaction: (f) => this.ctx.storage.transactionSync(f),
    },
    platform: platform(this.env),
    // While a run goes, the alarm looks again a little after its checkpoints should have come.
    watch: () => { void this.ctx.storage.getAlarm().then((at) => (at == null ? this.ctx.storage.setAlarm(Date.now() + STALE_MS + 5_000) : undefined)); },
  });

  /** A run with no checkpoint for a while: it goes on from its last checkpoint, if it isn't running. */
  async alarm(): Promise<void> {
    if (await this.agents.wake()) await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
  }

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
}
