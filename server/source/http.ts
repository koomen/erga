// Erga's Git endpoint, /git/erga.git (Git smart HTTP), once the caller is
// known to be allowed (cloudflare/source.ts checks the agent token):
//
//   GET  /git/erga.git/info/refs?service=git-upload-pack     clone, fetch, pull: passed through to Artifacts
//   POST /git/erga.git/git-upload-pack                       as they are (protocol v0, v1 and v2), streamed; for a
//                                                            factory VM (`reads`): protocol v2, and only the refs it
//                                                            may read, listed (ls-refs) or fetched by name (want-ref)
//   GET  /git/erga.git/info/refs?service=git-receive-pack    push: Erga's own advertisement (staging and main),
//   POST /git/erga.git/git-receive-pack                      and the push checked and landed by SourceRepo
//
// Platform-neutral: the Worker and the tests both serve it.

import type { Remote } from "./remote.ts";
import { concat, pkt, readPkts, text, utf8 } from "./git.ts";

export interface GitDoor {
  /** The Artifacts repo, with a token that may read. */
  upstream(): Promise<Remote>;
  /** The receive-pack advertisement (SourceRepo.advertise). */
  advertise(): Promise<Uint8Array>;
  /** A push's request body in, its report out (SourceRepo.receive). */
  receive(body: Uint8Array): Promise<Uint8Array>;
  /** The refs this caller may list and fetch by name, if not all (a factory VM's: factory/git-grant.ts, readAllowed). */
  reads?: (ref: string) => boolean;
}

const SPECIAL = { flush: "0000", delim: "0001", end: "0002" } as const;

/** Ref lines ("<oid> <ref>…": v0's advertisement, v2's ls-refs) for the refs `reads` refuses, left out; v0's capabilities move to the first line kept. */
export function filterRefLines(body: Uint8Array, reads: (ref: string) => boolean): Uint8Array {
  const out: Uint8Array[] = [];
  let caps: string | null = null;
  for (const p of readPkts(body).pkts) {
    if (p.kind != "data") { out.push(utf8(SPECIAL[p.kind])); continue; }
    const line = text(p.data).replace(/\n$/, "");
    const nul = line.indexOf("\0");
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const ref = /^[0-9a-f]{40} (\S+)/.exec(head)?.[1];
    if (!ref || ref == "capabilities^{}") { out.push(pkt(p.data)); continue; }
    if (nul >= 0) caps = line.slice(nul + 1);
    if (!reads(ref.replace(/\^\{\}$/, ""))) continue;
    out.push(pkt(`${head}${caps != null ? `\0${caps}` : ""}\n`));
    caps = null;
  }
  return concat(out);
}

/** The body of a request, unzipped if it came gzipped. */
async function bodyOf(request: Request): Promise<Uint8Array> {
  let stream = request.body;
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (stream && (encoding == "gzip" || encoding == "x-gzip")) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
    const body = await bodyOf(request);
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
  const out = (answer: Response, body: BodyInit | null) =>
    new Response(body, { status: answer.status, headers: new Headers({ ...nocache, "Content-Type": answer.headers.get("content-type") ?? "application/octet-stream" }) });
  const { reads } = door;
  if (!reads) {
    const answer = await f(target, { method: request.method, headers, body: request.method == "POST" ? request.body : undefined, ...(request.method == "POST" ? { duplex: "half" } : {}) } as RequestInit);
    if (!answer.ok) return new Response(`Artifacts said no (HTTP ${answer.status}).\n`, { status: 502 });
    return out(answer, answer.body);
  }
  // A caller that may read some refs only (a factory VM): protocol v2, where refs are listed only by ls-refs, whose
  // answer is filtered, and a fetch names refs only by want-ref, which is checked. (Another task's commits can still
  // be fetched by id, but its VM has no way to learn them.)
  headers["git-protocol"] = "version=2";
  let body: Uint8Array | undefined, command = "";
  if (request.method == "POST") {
    body = await bodyOf(request);
    delete headers["content-encoding"];
    const lines = readPkts(body).pkts.map((p) => (p.kind == "data" ? text(p.data).replace(/\n$/, "") : ""));
    command = lines.find((l) => l.startsWith("command="))?.slice(8) ?? "";
    if (command != "ls-refs" && command != "fetch" && command != "object-info") return new Response("Erga's Git endpoint speaks Git's protocol v2 to factory VMs only: git -c protocol.version=2 …\n", { status: 400 });
    const refused = lines.map((l) => /^want-ref (\S+)/.exec(l)?.[1]).find((r) => r && !reads(r));
    if (refused) return new Response(`This token may not read ${refused}.\n`, { status: 403 });
  }
  const answer = await f(target, { method: request.method, headers, body } as RequestInit);
  if (!answer.ok) return new Response(`Artifacts said no (HTTP ${answer.status}).\n`, { status: 502 });
  // The capability advertisement (v2 lists no refs there; if it were v0's, its refs are filtered too), and ls-refs.
  if (request.method == "GET" || command == "ls-refs") return out(answer, filterRefLines(new Uint8Array(await answer.arrayBuffer()), reads) as BodyInit);
  return out(answer, answer.body);
}
