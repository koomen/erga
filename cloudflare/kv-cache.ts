// The edge's cache (Platform["edge"]["cache"]) on a KV namespace, for a host whose Cache API keeps nothing: celld's
// caches.default always misses (deploy/aws/README.md). The deploy binds EDGE_CACHE there; Cloudflare has no such
// binding, and its own cache serves. One namespace serves every isolate and node, and keeps its copies over restarts.
//
// A copy is the response's bytes, with its status and headers as the value's metadata, for its max-age (KV's
// shortest is 60 s; at most a week, so the namespace stays small). It keeps no copy KV can't hold whole (1 MiB: above
// that celld puts the value in the bucket, no faster than the origin), and answers no range: the caller reads those.

import { sha256Hex } from "../shared/bytes";

/** The cache's interface (server/platform.ts, edge.cache). */
export interface EdgeCache {
  match(key: string | Request): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const MAX_BYTES = 1024 * 1024;
const MIN_TTL = 60;
const MAX_TTL = 7 * 86_400;

interface Meta {
  status: number;
  headers: [string, string][];
}

/** The key KV holds a copy at: the SHA-256 of the URL (a URL can pass KV's 512 bytes). */
const kvKey = (key: string | Request) => sha256Hex(typeof key == "string" ? key : key.url);

/** How long a response may be kept, in seconds, as its Cache-Control says; null: not at all. */
export function keepFor(response: Response): number | null {
  const cc = response.headers.get("cache-control") ?? "";
  if (response.status != 200 || /\b(no-store|private)\b/.test(cc)) return null;
  const age = Number(/\bs-maxage=(\d+)/.exec(cc)?.[1] ?? /\bmax-age=(\d+)/.exec(cc)?.[1]);
  return Number.isFinite(age) && age > 0 ? Math.min(Math.max(age, MIN_TTL), MAX_TTL) : null;
}

/** What it needs of a KV namespace (KVNamespace, in the Workers types). */
export interface Kv {
  getWithMetadata<M>(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  put(key: string, value: ArrayBuffer, options: { expirationTtl: number; metadata: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvCache(kv: Kv): EdgeCache {
  return {
    async match(key) {
      if (typeof key != "string" && key.headers.has("range")) return undefined;
      const { value, metadata } = await kv.getWithMetadata<Meta>(await kvKey(key), "arrayBuffer");
      if (!value || !metadata) return undefined;
      return new Response(value, { status: metadata.status, headers: metadata.headers });
    },
    async put(key, response) {
      const ttl = keepFor(response);
      const length = Number(response.headers.get("content-length"));
      if (ttl == null || length > MAX_BYTES) return void (await response.body?.cancel());
      const body = await response.arrayBuffer();
      const metadata: Meta = { status: response.status, headers: [...response.headers] };
      // (KV's metadata holds 1024 bytes: a response with longer headers isn't kept.)
      if (body.byteLength > MAX_BYTES || JSON.stringify(metadata).length > 1024) return;
      await kv.put(await kvKey(key), body, { expirationTtl: ttl, metadata });
    },
    async delete(key) {
      await kv.delete(await kvKey(key));
      return true;
    },
  };
}
