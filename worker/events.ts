// The app's live events for admins' pages, /api/events (server-sent
// events): one Durable Object, "app", holds every open page's stream and
// sends each event to all of them. Anything in the Worker publishes with
// `publishEvent(env, { type: ... })`:
//
//   { type: "source" }    a branch of Erga's repository moved, or the mirror's status changed (source/)
//   { type: "deploys" }   a deploy target changed (the deploy pipeline)
//   { type: "deploy-log", target, deployId, lines }   new lines of a deploy's log
//
// Each event is a JSON object on a `data:` line. A page refetches what the
// event names; EventSource reconnects by itself, after which the page
// refetches everything.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const enc = new TextEncoder();

export class EventHub extends DurableObject<Env> {
  private clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;

  async fetch(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.clients.add(writer);
    this.send(writer, ": connected\nretry: 2000\n\n");
    // A comment now and then keeps proxies from closing a quiet stream, and finds the ones that went away.
    this.beat ??= setInterval(() => {
      for (const w of this.clients) this.send(w, ": beat\n\n");
      if (!this.clients.size && this.beat) { clearInterval(this.beat); this.beat = null; }
    }, 20_000);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  async publish(event: { type: string } & Record<string, unknown>): Promise<number> {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const w of this.clients) this.send(w, line);
    return this.clients.size;
  }

  /** A little JSON kept for a stand-in (worker/deploys-stub.ts). */
  async stored(key: string): Promise<unknown> { return (await this.ctx.storage.get(key)) ?? null; }
  async store(key: string, value: unknown): Promise<void> { await this.ctx.storage.put(key, value); }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, s: string) {
    w.write(enc.encode(s)).catch(() => { this.clients.delete(w); w.abort().catch(() => {}); });
  }
}

/** Sends an event to every admin page that's listening. */
export async function publishEvent(env: Env, event: { type: string } & Record<string, unknown>): Promise<void> {
  if (!env.EVENTS) return;
  await env.EVENTS.getByName("app").publish(event).catch((e: unknown) => console.error("publishing an event:", e));
}

/** The stream for one page. */
export const eventStream = (env: Env, request: Request) => env.EVENTS.getByName("app").fetch(request);
