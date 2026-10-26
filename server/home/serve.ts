// Serving the homepage at / from its deployed snapshot (deploys.ts): remembered
// in this isolate and in the edge's cache, and checked against the home object
// for a newer one at most every few seconds, after answering
// (stale-while-revalidate), so / never waits on anything but the snapshot, and
// usually not even on that. The files are at /_home/<gen>/<path>, cached for
// good. Where there's no edge cache (workers.dev has none) the isolate's
// memory serves alone.

import { roleMay } from "../directory/index.ts";
import { accountOf, link, OWN_ACCOUNT, withEdit } from "../pages/index.ts";
import { mayDeploy } from "../../control/deploys/access.ts";
import { whoOf, type Platform } from "../platform.ts";
import type { LivePage } from "./deploys.ts";
import { HOME_FILES, homeHeader } from "./render.ts";
import { actingAdmin } from "../identity/index.ts";

/** The snapshot as this isolate last had it, and when it last asked whether it's still current. */
let memo: { page: LivePage; checked: number } | null = null;
let refreshing: Promise<LivePage | null> | null = null;

const cacheKey = (url: URL) => `${url.origin}${HOME_FILES}page`;

/** Forgets the snapshot this isolate and its edge remember (after the homepage changed, through this isolate). */
export async function forgetHome(platform: Platform, url: URL): Promise<void> {
  memo = null;
  await platform.edge.cache?.delete(cacheKey(url)).catch(() => false);
}

/** Asks the home object for the snapshot (only what's changed), and remembers it here and in the edge's cache. */
function refresh(platform: Platform, url: URL): Promise<LivePage | null> {
  return refreshing ??= (async () => {
    const answer = await platform.home.page(memo?.page.gen ?? null);
    const cache = platform.edge.cache;
    if (!answer) {
      memo = null;
      await cache?.delete(cacheKey(url)).catch(() => false);
      return null;
    }
    const page = answer.same ? memo!.page : answer.page;
    const checked = Date.now();
    memo = { page, checked };
    await cache?.put(cacheKey(url), new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", "x-checked": String(checked) } })).catch(() => {});
    return page;
  })().finally(() => { refreshing = null; });
}

/** The snapshot to serve, and where it came from: this isolate, the edge's cache or the home object. */
async function livePage(platform: Platform, url: URL): Promise<{ page: LivePage; from: string } | null> {
  const recheckMs = platform.edge.homeRecheckMs;
  // 0 (local development, tests): nothing remembered, every / asks the home object.
  if (recheckMs == 0) { const page = await refresh(platform, url); return page && { page, from: "home" }; }
  const stale = (checked: number) => Date.now() - checked >= recheckMs;
  const later = (p: Promise<unknown>) => platform.edge.background(p.catch((e) => console.log(`couldn't check the homepage: ${e}`)));
  if (memo) {
    if (stale(memo.checked)) later(refresh(platform, url));
    return { page: memo.page, from: "memory" };
  }
  const cached = await platform.edge.cache?.match(cacheKey(url)).catch(() => undefined);
  if (cached) {
    try {
      const page = await cached.json() as LivePage;
      const checked = Number(cached.headers.get("x-checked")) || 0;
      if (!memo) memo = { page, checked };
      if (stale(checked)) later(refresh(platform, url));
      return { page, from: "cache" };
    } catch { /* unreadable: ask */ }
  }
  const page = await refresh(platform, url);
  return page && { page, from: "home" };
}

/**
 * / on the app's own site: the homepage's snapshot, with its controls for
 * whoever's asking. The page goes out at once; the controls follow as soon as
 * it's known who's asking (signed out, that's at once too). Null when there's
 * no snapshot yet: the caller shows the viewer, and a deploy starts.
 */
export async function serveHome(request: Request, platform: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  const live = await livePage(platform, url);
  if (!live) {
    platform.edge.background(platform.home.ensure().catch((e) => console.log(`couldn't start the homepage's deploy: ${e}`)));
    return null;
  }
  const { page, from } = live;
  const controls = (async () => {
    const session = await platform.sessionOf(request);
    const who = session && whoOf(session);
    const dir = platform.directory;
    // Only admins may edit the homepage: their role is asked of the database only if they are one
    // (whether someone is, the isolate remembers for a few seconds), so for anyone else, signed out above all, nothing is.
    const admin = !!session && !session.agent && (await actingAdmin(dir.users, session));
    const doc = { id: page.docId, owner: page.address.split("/")[1], test: false };
    const role = admin ? await dir.access(who, doc) : null;
    return homeHeader({
      clone: link("/new?from=landing", session),
      edit: session && !session.agent && roleMay(role, "edit") ? withEdit(link(page.address, session)) : null,
      files: session && !session.agent && roleMay(role, "edit") ? link(`${page.address}?files`, session) : null,
      account: accountOf(session, admin, await mayDeploy(dir, session)),
      here: url.pathname + url.search,
      doc: page.docId,
    });
  })();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    // Different for each person (the controls): never kept for someone else; checked each time.
    "Cache-Control": "private, no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Server-Timing": `home;desc="${from}"`,
    [OWN_ACCOUNT]: "1",
  };
  if (request.method == "HEAD") { controls.catch(() => {}); return new Response(null, { headers }); }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(encoder.encode(page.before));
      let header = "";
      try { header = await controls; } catch (e) { console.log(`the homepage's controls failed: ${e}`); }
      c.enqueue(encoder.encode(header + page.after));
      c.close();
    },
  });
  return new Response(body, { headers });
}

/** One of a deploy's files, /_home/<gen>/<path>: the same forever, so kept for good, in the browser and the edge's cache. */
export async function serveHomeFile(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const [, gen, rest] = /^\/_home\/([a-z0-9]+)\/(.+)$/.exec(url.pathname) ?? [];
  let path: string | null = null;
  try { path = rest ? decodeURIComponent(rest) : null; } catch { path = null; }
  if ((request.method != "GET" && request.method != "HEAD") || !gen || !path) return new Response("Not found", { status: 404 });
  const cache = platform.edge.cache;
  const key = url.origin + url.pathname;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return request.method == "HEAD" ? new Response(null, hit) : hit;
  const file = await platform.home.file(gen, path);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const response = new Response(file.bytes as BodyInit, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", ...AUTHORS_POLICY } });
  if (cache) platform.edge.background(cache.put(key, response.clone()).catch(() => {}));
  return request.method == "HEAD" ? new Response(null, response) : response;
}

/** The homepage's files are its authors' code: no policy of the site's pages (server/security.ts), only the frame rule. */
const AUTHORS_POLICY = { "Content-Security-Policy": "frame-ancestors 'self'" };

/**
 * A path at the root that may be one of the homepage's own files (a link to
 * its other pages, a file its script fetches by a relative URL): the current
 * deploy's, if it has it. Null otherwise (the path is the app's).
 */
export async function serveHomeRoot(request: Request, platform: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  let rel: string;
  try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  const live = await livePage(platform, url);
  if (!live || !live.page.files.includes(rel)) return null;
  const file = await platform.home.file(live.page.gen, rel);
  if (!file) return null;
  return new Response(request.method == "HEAD" ? null : (file.bytes as BodyInit), { headers: { "Content-Type": file.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...AUTHORS_POLICY } });
}
