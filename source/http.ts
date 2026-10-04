// Erga's Git endpoint, /git/erga.git (Git smart HTTP), once the caller is
// known to be allowed (worker/source.ts checks the agent token):
//
//   GET  /git/erga.git/info/refs?service=git-upload-pack     clone, fetch, pull: passed through to Artifacts
//   POST /git/erga.git/git-upload-pack                       as they are (protocol v0, v1 and v2), streamed
//   GET  /git/erga.git/info/refs?service=git-receive-pack    push: Erga's own advertisement (staging and main),
//   POST /git/erga.git/git-receive-pack                      and the push checked and landed by SourceRepo
//
// Platform-neutral: the Worker and the tests both serve it.

import type { Remote } from "./remote.ts";

export interface GitDoor {
  /** The Artifacts repo, with a token that may read. */
  upstream(): Promise<Remote>;
  /** The receive-pack advertisement (SourceRepo.advertise). */
  advertise(): Promise<Uint8Array>;
  /** A push's request body in, its report out (SourceRepo.receive). */
  receive(body: Uint8Array): Promise<Uint8Array>;
}

const MAX_PUSH = 100 * 1024 * 1024;

export async function gitHttp(request: Request, rest: string, door: GitDoor): Promise<Response> {
  const url = new URL(request.url);
  const service = url.searchParams.get("service");
  const nocache = { "Cache-Control": "no-cache, max-age=0, must-revalidate", Expires: "Fri, 01 Jan 1980 00:00:00 GMT", Pragma: "no-cache" };
  if (rest == "/info/refs" && request.method == "GET" && service == "git-receive-pack") {
    return new Response(await door.advertise() as BodyInit, { headers: { "Content-Type": "application/x-git-receive-pack-advertisement", ...nocache } });
  }
  if (rest == "/git-receive-pack" && request.method == "POST") {
    let stream = request.body;
    const encoding = request.headers.get("content-encoding")?.toLowerCase();
    if (stream && (encoding == "gzip" || encoding == "x-gzip")) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    const body = new Uint8Array(await new Response(stream).arrayBuffer());
    if (body.length > MAX_PUSH) return new Response("That push is too big for Erga (100MB at most): push in smaller steps.\n", { status: 413 });
    return new Response(await door.receive(body) as BodyInit, { headers: { "Content-Type": "application/x-git-receive-pack-result", ...nocache } });
  }
  const read = (rest == "/info/refs" && request.method == "GET" && service == "git-upload-pack") || (rest == "/git-upload-pack" && request.method == "POST");
  if (!read) return new Response("Not found: Erga's Git endpoint does clone, fetch, pull and push (smart HTTP).\n", { status: 404 });
  // Clone, fetch and pull: Artifacts answers, Erga only carries it.
  const upstream = await door.upstream();
  const headers: Record<string, string> = { ...upstream.headers };
  for (const h of ["content-type", "content-encoding", "git-protocol", "accept", "user-agent"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const target = upstream.url.replace(/\/+$/, "") + rest + url.search;
  const f = upstream.fetch ?? globalThis.fetch.bind(globalThis);
  const answer = await f(target, { method: request.method, headers, body: request.method == "POST" ? request.body : undefined, ...(request.method == "POST" ? { duplex: "half" } : {}) } as RequestInit);
  if (!answer.ok) return new Response(`Artifacts said no (HTTP ${answer.status}).\n`, { status: 502 });
  const out = new Headers({ ...nocache, "Content-Type": answer.headers.get("content-type") ?? "application/octet-stream" });
  return new Response(answer.body, { status: answer.status, headers: out });
}
