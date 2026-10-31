// Live pages' hub, as a Durable Object (one, named "news"): the Cloudflare side of server/news/hub.ts. It gives the hub
// its SQLite and the open pages' sockets, and decides nothing. The sockets use the hibernation API: the object sleeps
// while no news comes, and each socket keeps whose it is in its attachment. A page's ping is answered without waking it.

import { DurableObject } from "cloudflare:workers";
import type { News } from "../../server/directory/index.ts";
import { Hub, type Listener } from "../../server/news/index.ts";
import { PING, PONG } from "../../shared/room-socket.ts";
import type { Env } from "../env";

type Who = Pick<Listener, "login" | "admin">;

export class NewsHub extends DurableObject<Env> {
  private hub: Hub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.hub = new Hub(
      { exec: <T>(query: string, ...params: (string | number | null)[]) => ctx.storage.sql.exec(query, ...params).toArray() as T[] },
      () =>
        this.ctx.getWebSockets().flatMap((ws) => {
          const who = ws.deserializeAttachment() as Who | null;
          return who ? [{ ...who, send: (text: string) => ws.send(text) }] : [];
        })
    );
  }

  /** These rows changed: their pages hear it. */
  publish(news: News[]): number {
    return this.hub.publish(news);
  }

  /** An open page's socket; the Worker says whose it is (server/news/routes.ts). */
  async fetch(request: Request): Promise<Response> {
    const login = request.headers.get("x-erga-login");
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket" || !login) return new Response("A WebSocket only.", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ login, admin: request.headers.get("x-erga-admin") == "1" } satisfies Who);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The page says the last version it saw (`{"since": v}`): it hears what changed since. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = ws.deserializeAttachment() as Who | null;
    if (!who || typeof message != "string") return;
    let since: unknown;
    try {
      since = (JSON.parse(message) as { since?: unknown }).since;
    } catch {
      return;
    }
    if (typeof since == "number") ws.send(JSON.stringify(this.hub.since(who, since)));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed, or a code that can't be sent back */
    }
  }
}
