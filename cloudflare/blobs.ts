// Documents' blobs on Cloudflare (document/blobs.ts): the FILES bucket in
// R2, each blob at blobs/<sha-256>, written with that sha-256, which R2
// checks. A blob never changes, so the edge's cache keeps a whole one by its
// hash with no time limit: most loads of a page's images never reach R2.
//
// Staging runs on a copy of production's documents, but not of its bucket:
// a blob staging doesn't have is read from production's (its read-only
// snapshot endpoint, GET /api/snapshot/blob/<sha-256>, behind SNAPSHOT_TOKEN),
// and kept in staging's own bucket from then on.

import { PRODUCTION } from "../deploy/targets";
import type { BlobBody, BlobStore } from "../document/blobs";
import type { Env } from "./env";

/** The edge keeps a whole blob up to this size (the Cache API takes up to 512 MB). */
const CACHE_MAX = 512 * 1024 * 1024;
/** The cache's key for a blob: a URL of its own, never a page's. */
const cacheKey = (hash: string) => `https://blobs.erga.dev/${hash}`;

const key = (hash: string) => `blobs/${hash}`;

/**
 * The blob store on `env.FILES`, or undefined where it isn't bound (a
 * server deployed before blobs). `background`: work after the answer (the
 * cache's copy of a blob); without it nothing is cached.
 */
export function blobsOf(env: Pick<Env, "FILES" | "SNAPSHOT_IMPORT" | "SNAPSHOT_TOKEN" | "DEPLOY_TARGET">, background?: (work: Promise<unknown>) => void): BlobStore | undefined {
  const bucket = env.FILES;
  if (!bucket) return undefined;
  const cache = background && typeof caches != "undefined" ? (caches as unknown as { default: Cache }).default : null;
  // Staging: what its copy of production's documents needs from production's bucket.
  const fromProduction = env.SNAPSHOT_IMPORT == "1" && env.DEPLOY_TARGET != "production" && (env.SNAPSHOT_TOKEN?.trim().length ?? 0) >= 32
    ? async (hash: string): Promise<boolean> => {
      const r = await fetch(`https://${PRODUCTION.host}/api/snapshot/blob/${hash}`, { headers: { Authorization: `Bearer ${env.SNAPSHOT_TOKEN!.trim()}` } }).catch(() => null);
      const size = Number(r?.headers.get("content-length"));
      if (!r?.ok || !r.body || !Number.isInteger(size)) { await r?.body?.cancel(); return false; }
      await put(hash, r.body, size);
      return true;
    }
    : null;
  const put = async (hash: string, data: Uint8Array | ReadableStream<Uint8Array>, size: number) => {
    let body: Uint8Array | ReadableStream<Uint8Array> = data;
    if (!(data instanceof Uint8Array)) {
      // R2 takes a stream of a known length.
      const fixed = new FixedLengthStream(size);
      void data.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    await bucket.put(key(hash), body, { sha256: hash });
  };
  const store: BlobStore = {
    async head(hash) {
      const o = await bucket.head(key(hash));
      if (o) return { size: o.size };
      return fromProduction && (await fromProduction(hash)) ? store.head(hash) : null;
    },
    async get(hash, range): Promise<BlobBody | null> {
      if (cache) {
        const hit = await cache.match(new Request(cacheKey(hash), range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}));
        // A range the cache answered as a range; or the whole blob.
        if (hit?.body && (range ? hit.status == 206 : hit.status == 200)) {
          const total = range ? Number(/\/(\d+)$/.exec(hit.headers.get("content-range") ?? "")?.[1]) : Number(hit.headers.get("content-length"));
          if (Number.isFinite(total) && total > 0) return { body: hit.body, size: total, ...(range ? { range } : {}) };
        }
        await hit?.body?.cancel();
      }
      let o = await bucket.get(key(hash), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
      if (!o && fromProduction && (await fromProduction(hash))) o = await bucket.get(key(hash), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
      if (!o) return null;
      if (!range && cache && background && o.size <= CACHE_MAX) {
        const [mine, kept] = o.body.tee();
        background(cache.put(cacheKey(hash), new Response(kept, {
          headers: { "Content-Length": String(o.size), "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
        })).catch(() => {}));
        return { body: mine, size: o.size };
      }
      return { body: o.body, size: o.size, ...(range ? { range } : {}) };
    },
    async bytes(hash) {
      let o = await bucket.get(key(hash));
      if (!o && fromProduction && (await fromProduction(hash))) o = await bucket.get(key(hash));
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    put,
  };
  return store;
}

/**
 * GET /api/snapshot/blob/<sha-256>: one blob, for a server that copies
 * this one's documents (staging, production's), behind SNAPSHOT_TOKEN. Only
 * reads. Null for any other path.
 */
export async function snapshotBlob(request: Request, env: Pick<Env, "FILES" | "SNAPSHOT_TOKEN">): Promise<Response | null> {
  const m = /^\/api\/snapshot\/blob\/([0-9a-f]{64})$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  const token = env.SNAPSHOT_TOKEN?.trim();
  if (!token || token.length < 32 || !env.FILES) return Response.json({ error: "Not found" }, { status: 404 });
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!same(bearer, token)) return Response.json({ error: "Not allowed" }, { status: 403 });
  if (request.method != "GET") return Response.json({ error: "GET only" }, { status: 405 });
  const o = await env.FILES.get(key(m[1]));
  if (!o) return Response.json({ error: "No such blob" }, { status: 404 });
  return new Response(o.body, { headers: { "Content-Length": String(o.size), "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
}

/** Two strings compared in constant time (for their length). */
function same(a: string, b: string): boolean {
  if (a.length != b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d == 0;
}
