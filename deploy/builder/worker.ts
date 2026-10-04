// The builder Worker (erga-builder): Cloudflare Containers running the build
// of a commit (build.ts, in the image Dockerfile makes, served by server.ts).
// Erga's servers reach it over a service binding (BUILDER; the pipeline adds
// it to the Workers it deploys), and it has no public address
// (workers_dev off, no routes), so only they can ask it to build.
//
// One container does one build at a time; the Durable Object in front of it
// starts it when a build comes, forwards the request and streams the answer
// back; the container stops itself after a few idle minutes (sleepAfter).
//
// Deployed once, by deploy/setup.ts (`bunx wrangler deploy` here: it builds
// the image with Docker and pushes it to Cloudflare's registry).

import { DurableObject } from "cloudflare:workers";

interface Env { BUILDS: DurableObjectNamespace<Builder> }

export class Builder extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const container = (this.ctx as unknown as { container: ContainerApi }).container;
    if (!container.running) container.start({ enableInternet: true, env: { PORT: "8080" } });
    const port = container.getTcpPort(8080);
    // Up when its server answers (it's a few seconds from a cold start).
    for (let i = 0; ; i++) {
      try { const r = await port.fetch("http://container/health"); if (r.ok) break; } catch { /* not yet */ }
      if (i > 120) return Response.json({ error: "The build container didn't start." }, { status: 503 });
      await new Promise((r) => setTimeout(r, 500));
    }
    return port.fetch(new Request("http://container/build", request));
  }
}

interface ContainerApi {
  running: boolean;
  start(o?: { enableInternet?: boolean; env?: Record<string, string> }): void;
  getTcpPort(port: number): { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname != "/build" || request.method != "POST") return new Response("Not found", { status: 404 });
    // One builder: builds wait their turn (the container answers 409 while busy, and the pipeline tries again).
    return env.BUILDS.getByName("builder").fetch(request);
  },
} satisfies ExportedHandler<Env>;
