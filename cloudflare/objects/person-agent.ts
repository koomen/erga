// Each person's agent, as a Durable Object (one per person, named by their login): the Cloudflare side of
// agents/person/sessions.ts. It gives the agent its SQLite and the Platform, forwards the calls the Worker makes
// (RPC), accepts panel and bridge WebSockets via the hibernation API so idle sockets do not hold the object awake,
// and wakes a run a restart cut off (its alarm). Each thread's conversation (one for each document, scope
// "thread:<doc>:<login>", and one for the rest of Erga, scope "you:<login>") is kept step by step
// (agents/checkpoint.ts, in agents/chat-store.ts's tables).
//
// (Before the one agent, it kept each person's conversations with a document's own agent, scope "doc:<id>": rows that
// stay, and that nothing wakes.)

import { DurableObject } from "cloudflare:workers";
import { STALE_MS } from "../../agents/chat-store";
import {
  PersonAgents,
  type AgentSocketAttachment,
  type BridgeInfo,
  type BridgeSocketEntry,
  type PanelSocketEntry,
  type PersonAgentObject,
} from "../../agents/person/sessions.ts";
import { PING, PONG } from "../../shared/room-socket.ts";
import { blobsOf } from "../blobs";
import type { Env } from "../env";
import { platform } from "../platform";

const dec = new TextDecoder();

export class PersonAgent extends DurableObject<Env> implements PersonAgentObject {
  private sql = {
    exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[],
    transaction: <R>(f: () => R) => this.ctx.storage.transactionSync(f),
  };
  private agents: PersonAgents;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Panel and bridge pings are answered at the edge without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.agents = new PersonAgents({
      sql: this.sql,
      platform: platform(this.env),
      blobs: blobsOf(this.env),
      watch: () => void this.watch(),
      sockets: {
        panels: () =>
          this.ctx.getWebSockets().flatMap((ws): PanelSocketEntry[] => {
            const att = ws.deserializeAttachment() as AgentSocketAttachment | null;
            return att?.kind == "panel" ? [{ ...att, send: (text) => ws.send(text) }] : [];
          }),
        bridges: () =>
          this.ctx.getWebSockets().flatMap((ws): BridgeSocketEntry[] => {
            const att = ws.deserializeAttachment() as AgentSocketAttachment | null;
            return att?.kind == "bridge" ? [this.bridgeEntry(ws, att.sockId, att.info)] : [];
          }),
      },
    });
  }

  private closeSocket(ws: WebSocket, code = 1000, reason = "closed"): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed, or a code that can't be sent back */
    }
  }

  private bridgeEntry(ws: WebSocket, sockId: string, info: BridgeInfo): BridgeSocketEntry {
    return {
      sockId,
      info,
      send: (text) => ws.send(text),
      close: () => this.closeSocket(ws),
    };
  }

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
  agentControl(login: string, doc: string | null, op: "abort" | "reset" | "model" | "approve" | "deny", model?: string, choice?: string) {
    return this.agents.agentControl(login, doc, op, model, choice);
  }
  conversation(login: string, doc: string | null) {
    return this.agents.conversation(login, doc);
  }
  clearConversation(login: string, doc: string | null) {
    return this.agents.clearConversation(login, doc);
  }
  /** The panel's events: a hibernatable WebSocket (Upgrade: websocket), else server-sent events; or a local agent bridge socket. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname == "/api/agent/bridge") {
      if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") return new Response("Upgrade required", { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      const info: BridgeInfo = {
        login: request.headers.get("x-erga-login") ?? "",
        grantId: request.headers.get("x-erga-grant-id") ?? "",
        label: request.headers.get("x-erga-grant-label") || "Agent",
        onlyDoc: request.headers.get("x-erga-only-doc") || null,
        origin: request.headers.get("x-erga-origin") || url.origin,
      };
      server.serializeAttachment({ kind: "bridge", sockId: crypto.randomUUID(), info } satisfies AgentSocketAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") return this.agents.fetch(request);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(this.agents.panelAttachment(request) satisfies AgentSocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message == "string" ? message : dec.decode(message);
    if (raw == PING) {
      try {
        ws.send(PONG);
      } catch {
        /* closing */
      }
      return;
    }
    const att = ws.deserializeAttachment() as AgentSocketAttachment | null;
    if (att?.kind == "bridge") await this.agents.bridgeMessage(this.bridgeEntry(ws, att.sockId, att.info), raw);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as AgentSocketAttachment | null;
    if (att?.kind == "bridge") await this.agents.bridgeClosed(att.sockId);
    this.closeSocket(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as AgentSocketAttachment | null;
    if (att?.kind == "bridge") await this.agents.bridgeClosed(att.sockId);
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
