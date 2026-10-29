// A Git smart HTTP client, for the few things Erga asks of a remote
// (Artifacts, and GitHub for the mirror): list its branches, fetch a pack of
// what it has that we don't, and push ref updates with a pack. Protocol v2
// for fetching (ls-refs and fetch), v0 for pushing (receive-pack has no v2).

import * as Schema from "effect/Schema";
import { concat, DELIM, FLUSH, pkt, pktText, readPkts, sideBand, text, ZERO, type Pkt } from "./git.ts";

export interface Remote {
  /** The repository's URL, ".../name.git". */
  url: string;
  /** Headers every request carries (its credentials). */
  headers: Record<string, string>;
  /** How to reach it (globalThis.fetch by default). */
  fetch?: typeof fetch;
}

export class RemoteError extends Schema.TaggedError<RemoteError>()("RemoteError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {}

async function call(remote: Remote, path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Uint8Array> {
  const f = remote.fetch ?? globalThis.fetch.bind(globalThis);
  let r: Response;
  try {
    r = await f(remote.url.replace(/\/+$/, "") + path, { ...init, headers: { "User-Agent": "git/2.47.0 (erga)", ...remote.headers, ...init.headers } });
  } catch (e) {
    throw new RemoteError({ message: `couldn't reach ${hostOf(remote.url)}: ${(e as Error).message}` });
  }
  const body = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) {
    const why =
      r.status == 401 || r.status == 403 ? "its credentials were refused" : r.status == 404 ? "no such repository" : `HTTP ${r.status}`;
    throw new RemoteError({
      message: `${hostOf(remote.url)} said no (${why})${body.length && body.length < 300 ? `: ${text(body).trim()}` : ""}`,
      status: r.status,
    });
  }
  return body;
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** The remote's branches, and where HEAD points, with protocol v2's ls-refs. */
export async function lsRefs(remote: Remote, prefix = "refs/heads/"): Promise<{ refs: Map<string, string>; head: string | null }> {
  const body = concat([pkt("command=ls-refs\n"), pkt("agent=erga\n"), DELIM, pkt("symrefs\n"), pkt(`ref-prefix ${prefix}\n`), pkt("ref-prefix HEAD\n"), FLUSH]);
  const answer = await call(remote, "/git-upload-pack", { method: "POST", body: body as BodyInit, headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" } });
  const refs = new Map<string, string>();
  let head: string | null = null;
  for (const p of readPkts(answer).pkts) {
    const line = pktText(p);
    if (!line) continue;
    const [sha, name, ...attrs] = line.split(" ");
    if (name == "HEAD") { head = attrs.find((a) => a.startsWith("symref-target:"))?.slice(14) ?? null; continue; }
    if (/^[0-9a-f]{40}$/.test(sha) && name?.startsWith(prefix)) refs.set(name, sha);
  }
  return { refs, head };
}

/** The receive-pack advertisement (v0): the remote's refs and what its receive-pack can do. */
export async function receiveAdvert(remote: Remote): Promise<{ refs: Map<string, string>; caps: Set<string> }> {
  const body = await call(remote, "/info/refs?service=git-receive-pack", { method: "GET", headers: { Accept: "*/*" } });
  return parseAdvert(body);
}

/** A v0 advertisement ("# service=..." first, when it came over HTTP). */
export function parseAdvert(body: Uint8Array): { refs: Map<string, string>; caps: Set<string> } {
  const refs = new Map<string, string>();
  let caps = new Set<string>();
  const pkts = readPkts(body).pkts;
  let first = true;
  for (const p of pkts) {
    if (p.kind != "data") continue;
    let line = text(p.data).replace(/\n$/, "");
    if (line.startsWith("# service=")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) { if (first) caps = new Set(line.slice(nul + 1).split(" ").filter(Boolean)); line = line.slice(0, nul); }
    first = false;
    const [sha, name] = line.split(" ");
    if (sha != ZERO && name && name != "capabilities^{}") refs.set(name, sha);
  }
  return { refs, caps };
}

/**
 * A pack of what `wants` need that `haves` don't (protocol v2's fetch):
 * self-contained (no thin pack), so every delta's base is in it. With
 * `deepen`, only that many commits deep from each want.
 */
export async function fetchPack(remote: Remote, opts: { wants: string[]; haves?: string[]; deepen?: number; filter?: string }): Promise<Uint8Array> {
  if (!opts.wants.length) return new Uint8Array();
  // A filter (partial clone: "blob:none", no files) where the remote takes one; a remote that doesn't is asked again without.
  if (opts.filter) return fetchPackWith(remote, opts, opts.filter).catch(() => fetchPackWith(remote, opts));
  return fetchPackWith(remote, opts);
}

async function fetchPackWith(remote: Remote, opts: { wants: string[]; haves?: string[]; deepen?: number }, filter?: string): Promise<Uint8Array> {
  const args = [
    pkt("no-progress\n"), pkt("ofs-delta\n"),
    ...opts.wants.map((w) => pkt(`want ${w}\n`)),
    ...(opts.haves ?? []).map((h) => pkt(`have ${h}\n`)),
    ...(opts.deepen ? [pkt(`deepen ${opts.deepen}\n`)] : []),
    ...(filter ? [pkt(`filter ${filter}\n`)] : []),
    pkt("done\n"),
  ];
  const body = concat([pkt("command=fetch\n"), pkt("agent=erga\n"), DELIM, ...args, FLUSH]);
  const answer = await call(remote, "/git-upload-pack", { method: "POST", body: body as BodyInit, headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" } });
  // Sections (shallow-info, acknowledgments...), then "packfile" and the pack in side-band packets.
  const { pkts } = readPkts(answer);
  const at = pkts.findIndex((p) => pktText(p) == "packfile");
  if (at < 0) {
    const err = pkts.map(pktText).find((l) => l?.startsWith("ERR "));
    throw new RemoteError({ message: err ? err.slice(4) : "the remote sent no pack" });
  }
  return sideBand(pkts.slice(at + 1).filter((p): p is Extract<Pkt, { kind: "data" }> => p.kind == "data")).data;
}

export interface RefUpdate { ref: string; old: string; new: string }
export interface PushResult { unpack: string; refs: Map<string, string> }

/**
 * Pushes ref updates with `pack` (receive-pack, v0, report-status): what
 * the remote said of the pack ("ok", or why not) and of each ref ("ok", or
 * why not). A remote that checks `old` moves a ref only if it's still there.
 */
export async function receivePack(remote: Remote, updates: RefUpdate[], pack: Uint8Array | null, caps: string[] = []): Promise<PushResult> {
  const lines = updates.map((u, i) => pkt(`${u.old} ${u.new} ${u.ref}${i == 0 ? `\0${["report-status", ...caps, "agent=erga"].join(" ")}` : ""}\n`));
  // A pack follows unless every update is a delete.
  const body = concat([...lines, FLUSH, ...(updates.some((u) => u.new != ZERO) && pack ? [pack] : [])]);
  const answer = await call(remote, "/git-receive-pack", { method: "POST", body: body as BodyInit, headers: { "Content-Type": "application/x-git-receive-pack-request", Accept: "application/x-git-receive-pack-result" } });
  let pkts = readPkts(answer).pkts;
  // Some send report-status in side-band whether asked or not.
  if (pkts[0]?.kind == "data" && pkts[0].data[0] == 1) pkts = readPkts(sideBand(pkts).data).pkts;
  const result: PushResult = { unpack: "", refs: new Map() };
  for (const p of pkts) {
    const line = pktText(p);
    if (!line) continue;
    if (line.startsWith("unpack ")) result.unpack = line.slice(7);
    else if (line.startsWith("ok ")) result.refs.set(line.slice(3), "ok");
    else if (line.startsWith("ng ")) {
      const [ref, ...why] = line.slice(3).split(" ");
      result.refs.set(ref, why.join(" ") || "refused");
    }
  }
  if (!result.unpack)
    throw new RemoteError({
      message: `${hostOf(remote.url)} sent no report${answer.length && answer.length < 300 ? `: ${text(answer).trim()}` : ""}`,
    });
  return result;
}

