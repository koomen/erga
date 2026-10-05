// The builder Worker (erga-builder): Cloudflare Containers running the build
// of a commit (build.ts, in the image Dockerfile makes, served by server.ts).
// Erga's servers reach it over a service binding (BUILDER; the pipeline adds
// it to the Workers it deploys), and it has no public address
// (workers_dev off, no routes), so only they can ask it to build.
//
// Each build has a container of its own: the pipeline names the build (?id=,
// deploy/builder/client.ts) and the Durable Object of that name starts a
// container for it, forwards the request and streams the answer back. When
// the build ends, or is cancelled, the container is destroyed at once, so it
// frees its place (max_instances in wrangler.jsonc) for the next build. Two
// deploys at once (staging and production) build side by side; past
// max_instances, a container doesn't start (503) and the pipeline waits.
//
// Deployed once, by deploy/setup.ts (`bunx wrangler deploy` here: it builds
// the image with Docker and pushes it to Cloudflare's registry).

import { DurableObject } from "cloudflare:workers";

interface Env { BUILDS: DurableObjectNamespace<Builder> }

export class Builder extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const container = (this.ctx as unknown as { container: ContainerApi }).container;
    // A cancel with no container up: there's no build to stop (and none is started for it).
    const path = new URL(request.url).pathname;
    if (path == "/cancel") {
      if (!container.running) return Response.json({ stopped: false });
      // Stop the build, then the container: its place is free for the next build now, not in minutes.
      const r = await container.getTcpPort(8080).fetch(new Request("http://container/cancel", request)).then((r) => r.json()).catch(() => ({ stopped: false }));
      await container.destroy().catch(() => {});
      return Response.json(r);
    }
    if (!container.running) container.start({ enableInternet: true, env: { PORT: "8080" } });
    const port = container.getTcpPort(8080);
    // Up when its server answers (it's a few seconds from a cold start).
    for (let i = 0; ; i++) {
      try { const r = await port.fetch("http://container/health"); if (r.ok) break; } catch { /* not yet */ }
      if (i > 120) return Response.json({ error: "The build container didn't start." }, { status: 503 });
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await port.fetch(new Request(`http://container${path}`, request));
    if (!r.body) { this.ctx.waitUntil(container.destroy().catch(() => {})); return r; }
    // The build's stream, passed on; when it ends (or the pipeline drops it), the container goes.
    const reader = r.body.getReader();
    const done = () => { this.ctx.waitUntil(container.destroy().catch(() => {})); };
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try { const { done: end, value } = await reader.read(); if (end) { c.close(); done(); } else c.enqueue(value); }
        catch (e) { c.error(e); done(); }
      },
      cancel(reason) { reader.cancel(reason).catch(() => {}); done(); },
    });
    return new Response(body, { status: r.status, headers: r.headers });
  }
}

interface ContainerApi {
  running: boolean;
  start(o?: { enableInternet?: boolean; env?: Record<string, string> }): void;
  destroy(error?: unknown): Promise<void>;
  getTcpPort(port: number): { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if ((path != "/build" && path != "/cancel") || request.method != "POST") return new Response("Not found", { status: 404 });
    // A container for each build (its id; an older pipeline sends none and shares one: 409 while busy, and it tries again).
    const id = (url.searchParams.get("id") ?? "").replace(/[^\w-]/g, "").slice(0, 64) || "builder";
    return env.BUILDS.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
