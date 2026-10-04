// The builder's container: a small HTTP server that builds one commit at a
// time (build.ts) and streams how it's going. The builder Worker
// (deploy/builder/worker.ts) starts the container and forwards the
// pipeline's request to it (deploy/builder/client.ts sends it).
//
//   POST /build {source: {cloneUrl, token}, commit, branch}
//     → NDJSON: {"log": "..."} per line of output, then {"bundle": "<release bundle JSON>"} or {"error": "..."}
//   POST /cancel {commit?} → stops the running build (of that commit, if named): its commands are killed
//   GET /health → ok
//
//   bun deploy/builder/server.ts        (PORT, default 8080; WORK, default /tmp/erga-build)

import { buildCommit, type Source } from "./build";

const PORT = Number(process.env.PORT ?? 8080);
const WORK = process.env.WORK ?? "/tmp/erga-build";
let busy = false;
/** The running build: its commit, and what stops it. */
let running: { commit: string; abort: AbortController } | null = null;

export async function handle(request: Request, build: typeof buildCommit = buildCommit): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname == "/health") return new Response("ok");
  if (url.pathname == "/cancel" && request.method == "POST") {
    const { commit } = (await request.json().catch(() => ({}))) as { commit?: string };
    if (!running || (commit && running.commit != commit)) return Response.json({ stopped: false });
    running.abort.abort(new Error("The build was cancelled."));
    return Response.json({ stopped: true, commit: running.commit });
  }
  if (url.pathname != "/build" || request.method != "POST") return new Response("Not found", { status: 404 });
  if (busy) return Response.json({ error: "A build is already running." }, { status: 409 });
  busy = true;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => { if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`)); };
      try {
        const body = (await request.json()) as { source: Source; commit: string; branch?: string };
        running = { commit: body.commit, abort };
        const bundle = await build({ source: body.source, commit: body.commit, branch: body.branch, dir: WORK, log: (line) => send({ log: line }), signal: abort.signal });
        send({ bundle: new TextDecoder().decode(bundle) });
      } catch (e) {
        send({ error: abort.signal.aborted ? "The build was cancelled." : (e as Error)?.message ?? String(e) });
      } finally {
        busy = false;
        running = null;
        if (!closed) { closed = true; controller.close(); }
      }
    },
    // The pipeline went away (its deploy was cancelled): stop the build too.
    cancel() { closed = true; abort.abort(new Error("The build was cancelled.")); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

if (import.meta.main) {
  Bun.serve({ port: PORT, idleTimeout: 0, fetch: (r) => handle(r) });
  console.log(`erga builder on :${PORT}`);
}
