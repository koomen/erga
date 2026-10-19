// The builder's release cache: each release the
// builder builds, kept by its commit and the builder's toolchain, so a commit
// built once is never built again. Staging builds a commit when it reaches
// the staging branch; when main fast-forwards to it, production's deploy of
// the same commit takes that release at once, with no container and no build.
//
// Why reusing a release across targets is safe:
//
//   - A build's inputs are the commit and the builder's image, nothing of the
//     target. The pipeline asks for {source, commit, branch}: the branch only
//     says where to fetch from, and Git checks every object it fetches against
//     its id, so a commit's id names its tree exactly, whatever remote it came
//     from. The container's environment is the image's (no target's vars or
//     secrets: build.ts runs client/build.ts and `cf build` with the same fixed env
//     for every commit; ERGA_SERVER_CONFIG empty, the Artifacts namespace from
//     the commit's own deploy/targets.json). `cf build` writes production's
//     names (cloudflare.config.ts) whichever server asked.
//   - Everything that makes a release a target's own is applied after, by the
//     pipeline, at the upload: the
//     Worker's name, its database id, its text settings (DEPLOY_TARGET,
//     ERGA_VERSION, the target's vars), its secrets (kept on the Worker), its
//     services, its pages' domain and its factory image. None of it is in the
//     bundle, so staging's build of a commit is, byte for byte, what
//     production's own build of it would be (but the time in release.json).
//   - The key holds the toolchain: the builder Worker's version id, which
//     changes on every `wrangler deploy` of the builder (so with every new
//     image: Bun, Node, Git, the dependency cache, build.ts), Bun's version
//     and this cache's format. A builder without a version id caches nothing.
//   - Only the builder writes it, and only a release its own container just
//     built and streamed back, under the commit it asked that container for.
//     Erga's servers reach the builder only over its service binding, by
//     fetch, and its routes are /build and /cancel: no route writes the cache,
//     and the cache's Durable Object has a name no build id can take. So a
//     server (staging's, which anyone who can push to staging controls) can't
//     put a release in for a commit it didn't build. A build of a commit runs
//     that commit's own code: what staging builds for a commit is what
//     production would have built for it.
//   - Only a full 40-hex commit id is a key (a short one could name another
//     commit later), and only a build that ended with a release is kept.

/** The cache's format: change it to drop every release kept before. */
export const CACHE_FORMAT = 1;
/** How many releases are kept (the oldest go first): ~15 MB each. */
export const CACHE_KEEP = 16;
/** Each release is kept in parts of this many characters (a Durable Object's stored value has a size limit). */
export const CHUNK = 512 * 1024;

/** Where releases are kept: the builder's Durable Object storage, or a Map in the tests. */
export interface ReleaseStore {
  get(key: string): Promise<{ line: string; at: number; branch?: string } | null>;
  put(key: string, line: string, meta: { at: number; branch?: string }): Promise<void>;
}

/** The toolchain's part of the key: a hash of the cache's format, Bun's version and the builder's version; null if there's no version. */
export async function toolchainKey(o: { bun: string; builderVersion: string | null | undefined }): Promise<string | null> {
  if (!o.builderVersion) return null;
  const bytes = new TextEncoder().encode(`format ${CACHE_FORMAT}\nbun ${o.bun}\nbuilder ${o.builderVersion}\n`);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

/** A release's key: the full commit id and the toolchain, or null (not cached). */
export function releaseKey(commit: unknown, toolchain: string | null): string | null {
  return typeof commit == "string" && /^[0-9a-f]{40}$/.test(commit) && toolchain ? `${commit}:${toolchain}` : null;
}

const enc = new TextEncoder();
const ndjson = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`);

/**
 * POST /build, with the cache in front: a release kept for this commit and
 * toolchain is answered at once (a log line, then the release, as a build's
 * stream ends); else `build` builds it (the container), and the release its
 * stream ends with is kept. `keep` hears the store's write (ctx.waitUntil).
 */
export async function cachedBuild(body: string, o: { store: ReleaseStore; toolchain: string | null; build: (body: string) => Promise<Response>; keep?: (p: Promise<unknown>) => void; now?: () => number }): Promise<Response> {
  let req: { commit?: unknown; branch?: unknown } = {};
  try { req = JSON.parse(body); } catch { /* the container says what's wrong */ }
  const key = releaseKey(req.commit, o.toolchain);
  const hit = key ? await o.store.get(key).catch(() => null) : null;
  if (hit) {
    const commit = String(req.commit).slice(0, 12);
    const when = new Date(hit.at).toISOString().replace("T", " ").slice(0, 19);
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(ndjson({ log: `release cache: ${commit} was built at ${when} UTC${hit.branch ? ` (for ${hit.branch})` : ""} by this builder: that release is reused, with no new build` }));
        c.enqueue(ndjson({ cached: { at: hit.at, ...(hit.branch ? { branch: hit.branch } : {}) } }));
        c.enqueue(enc.encode(`${hit.line}\n`));
        c.close();
      },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
  }
  const r = await o.build(body);
  if (!key || !r.ok || !r.body) return r;
  // The build's stream, passed on as it comes; its release line (`{"bundle": ...}`), kept when the stream ends.
  const reader = r.body.getReader();
  let parts: Uint8Array[] = [], bundle: string | null = null;
  /** Each whole line, decoded once when its newline comes (the release is one line of ~15 MB). */
  const line = () => {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    parts = [];
    const text = new TextDecoder().decode(all);
    if (text.startsWith('{"bundle":')) bundle = text;
  };
  const take = (chunk: Uint8Array) => {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) { parts.push(chunk.slice(start, nl)); start = nl + 1; line(); }
    if (start < chunk.length) parts.push(chunk.slice(start));
  };
  const now = o.now ?? Date.now;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        if (parts.length) line();
        c.close();
        if (bundle) {
          const line = bundle;
          bundle = null;
          o.keep?.(o.store.put(key, line, { at: now(), ...(typeof req.branch == "string" ? { branch: req.branch } : {}) }).catch(() => {}));
        }
        return;
      }
      take(value);
      c.enqueue(value);
    },
    // The pipeline went away (its deploy was cancelled): nothing is kept.
    cancel(reason) { bundle = null; return reader.cancel(reason); },
  }), { status: r.status, headers: r.headers });
}

/** A ReleaseStore in a Durable Object's storage: each release in CHUNK-sized parts, the newest CACHE_KEEP kept. */
export function storageStore(storage: { get(keys: string[]): Promise<Map<string, unknown>>; get<T>(key: string): Promise<T | undefined>; put(entries: Record<string, unknown>): Promise<void>; delete(keys: string[]): Promise<number> }): ReleaseStore {
  interface Meta { parts: number; at: number; branch?: string }
  const metaKey = (k: string) => `release:${k}`, partKey = (k: string, i: number) => `release:${k}:${i}`;
  const keys = (k: string, n: number) => Array.from({ length: n }, (_, i) => partKey(k, i));
  return {
    async get(k) {
      const meta = await storage.get<Meta>(metaKey(k));
      if (!meta) return null;
      const out: string[] = [];
      const all = keys(k, meta.parts);
      for (let i = 0; i < all.length; i += 100) {
        const got = await storage.get(all.slice(i, i + 100));
        for (const pk of all.slice(i, i + 100)) { const v = got.get(pk); if (typeof v != "string") return null; out.push(v); }
      }
      return { line: out.join(""), at: meta.at, ...(meta.branch ? { branch: meta.branch } : {}) };
    },
    async put(k, line, m) {
      const n = Math.ceil(line.length / CHUNK);
      const all = keys(k, n);
      for (let i = 0; i < n; i += 100) {
        const batch: Record<string, unknown> = {};
        for (let j = i; j < Math.min(n, i + 100); j++) batch[all[j]] = line.slice(j * CHUNK, (j + 1) * CHUNK);
        await storage.put(batch);
      }
      // The release counts only once its parts are all there.
      await storage.put({ [metaKey(k)]: { parts: n, at: m.at, ...(m.branch ? { branch: m.branch } : {}) } });
      const index = ((await storage.get<{ key: string; parts: number }[]>("releases")) ?? []).filter((e) => e.key != k);
      index.unshift({ key: k, parts: n });
      const gone = index.splice(CACHE_KEEP);
      await storage.put({ releases: index });
      for (const g of gone) await storage.delete([metaKey(g.key), ...keys(g.key, g.parts)]);
    },
  };
}
