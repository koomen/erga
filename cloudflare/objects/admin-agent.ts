// The admins' agents, as a Durable Object (one, named "admin"): the Cloudflare
// side of server/admin/agent.ts. It gives the agents their SQLite and the
// Platform, and forwards the calls the Worker makes (RPC).

import { DurableObject } from "cloudflare:workers";
import { AdminAgents, type AdminAgentObject } from "../../server/admin/index.ts";
import type { Env } from "../env";
import { platform } from "../platform";

export class AdminAgentHost extends DurableObject<Env> implements AdminAgentObject {
  private agents = new AdminAgents({
    sql: { exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[] },
    platform: platform(this.env),
  });

  agentState(login: string, origin: string) { return this.agents.agentState(login, origin); }
  agentPrompt(login: string, origin: string, text: string, context: string | null, attached?: unknown) { return this.agents.agentPrompt(login, origin, text, context, attached); }
  agentControl(login: string, op: "abort" | "reset" | "model", model?: string) { return this.agents.agentControl(login, op, model); }
  conversation(login: string) { return this.agents.conversation(login); }
  clearConversation(login: string) { return this.agents.clearConversation(login); }
  agentPrefs(login: string) { return this.agents.agentPrefs(login); }
  setAgentPrefs(login: string, body: unknown) { return this.agents.setAgentPrefs(login, body); }
  fetch(request: Request) { return this.agents.fetch(request); }
}
