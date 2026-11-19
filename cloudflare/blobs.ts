// Documents' blobs on Cloudflare (document/store/blobs.ts): the FILES bucket in
// R2, each blob at blobs/<sha-256>, written with that sha-256, which R2
// checks. A blob never changes, so the edge's cache keeps a whole one by its
// hash with no time limit: most loads of a page's images never reach R2.

import type { BlobBody, BlobStore } from "../document/store/blobs";
import type { EdgeCache } from "./kv-cache";
import type { Env } from "./env";

/** The edge keeps a whole blob up to this size (the Cache API takes up to 512 MB). */
const CACHE_MAX = 512 * 1024 * 1024;
/** The cache's key for a blob: a URL of its own, never a page's. */
const cacheKey = (hash: string) => `https://blobs.invalid/${hash}`;

const key = (hash: string) => `blobs/${hash}`;

/**
 * The blob store on `env.FILES`, or undefined where it isn't bound.
 * `edge`: the edge's cache (platform.ts) and work after the answer (the
 * cache's copy of a blob); without it nothing is cached.
 */
export function blobsOf(
  env: Pick<Env, "FILES">,
  edge?: { cache: EdgeCache | null; background: (work: Promise<unknown>) => void }
): BlobStore | undefined {
  const bucket = env.FILES;
  if (!bucket) return undefined;
  const cache = edge?.cache ?? null;
  const background = edge?.background;
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
      return o ? { size: o.size } : null;
    },
    async get(hash, range): Promise<BlobBody | null> {
      if (cache) {
        const hit = await cache.match(new Request(cacheKey(hash), range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}));
        // A range the cache answered as a range; or the whole blob.
        if (hit?.body && (range ? hit.status == 206 : hit.status == 200)) {
          const total = range ? Number(/\/(\d+)$/.exec(hit.headers.get("content-range") ?? "")?.[1]) : Number(hit.headers.get("content-length"));
          if (Number.isFinite(total) && total > 0) return { body: hit.body, size: total, ...(range ? { range } : {}), cached: true };
        }
        await hit?.body?.cancel();
      }
      const o = await bucket.get(key(hash), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
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
      const o = await bucket.get(key(hash));
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    put,
  };
  return store;
}
