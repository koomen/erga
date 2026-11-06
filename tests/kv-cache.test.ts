// The edge's cache on a KV namespace (cloudflare/kv-cache.ts), where the host's Cache API keeps nothing (celld): what
// it keeps, for how long, and what it never keeps.

import { expect, test } from "bun:test";
import { keepFor, type Kv, kvCache } from "../cloudflare/kv-cache";

/** A KV namespace in memory: what kvCache calls, and the TTL of each write. */
function memoryKv() {
  const data = new Map<string, { value: ArrayBuffer; metadata: unknown; ttl?: number }>();
  const kv = {
    getWithMetadata: async (key: string) => {
      const e = data.get(key);
      return { value: e?.value ?? null, metadata: e?.metadata ?? null };
    },
    put: async (key: string, value: ArrayBuffer, opts: { expirationTtl?: number; metadata?: unknown }) => {
      data.set(key, { value, metadata: opts.metadata, ttl: opts.expirationTtl });
    },
    delete: async (key: string) => void data.delete(key),
  };
  return { kv: kv as unknown as Kv, data };
}

test("a cacheable response comes back whole from any isolate; private, ranges and deletes miss", async () => {
  const { kv, data } = memoryKv();
  const key = "https://erga.example/_home-files/abc/style.css";
  await kvCache(kv).put(
    key,
    new Response("body { color: red }", { headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=31536000, immutable" } })
  );
  // Another isolate: a new adapter on the same namespace.
  const hit = await kvCache(kv).match(key);
  expect(hit?.status).toBe(200);
  expect(hit?.headers.get("content-type")).toBe("text/css");
  expect(await hit?.text()).toBe("body { color: red }");
  expect([...data.values()][0].ttl).toBe(7 * 86_400);

  expect(await kvCache(kv).match(new Request(key, { headers: { Range: "bytes=0-3" } }))).toBeUndefined();
  await kvCache(kv).put("https://erga.example/me", new Response("mine", { headers: { "Cache-Control": "private, max-age=60" } }));
  expect(await kvCache(kv).match("https://erga.example/me")).toBeUndefined();
  await kvCache(kv).delete(key);
  expect(await kvCache(kv).match(key)).toBeUndefined();
});

test("a copy lives for its max-age, at least KV's 60 s and at most a week", () => {
  const cc = (v: string, status = 200) => new Response(null, { status, headers: { "Cache-Control": v } });
  expect(keepFor(cc("max-age=86400"))).toBe(86_400);
  expect(keepFor(cc("max-age=5"))).toBe(60);
  expect(keepFor(cc("public, s-maxage=120, max-age=10"))).toBe(120);
  expect(keepFor(cc("no-store"))).toBeNull();
  expect(keepFor(cc("max-age=60", 404))).toBeNull();
  expect(keepFor(new Response(null))).toBeNull();
});
