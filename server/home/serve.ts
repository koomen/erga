// Serving the homepage at / from its deployed snapshot (deploys.ts): remembered
// in this isolate and in the edge's cache, and checked against the home object
// for a newer one at most every few seconds, after answering
// (stale-while-revalidate), so / never waits on anything but the snapshot, and
// usually not even on that. The files are at /_home-files/<gen>/<path>, cached for
// good. Where there's no edge cache (workers.dev has none) the isolate's
// memory serves alone.
//
// The homepage can have a domain of its own (the deploy facts' `home`, from `bun erga deploy <host> --home <domain>`).
// Then that host gets only the site's files (serveHomeDomain), and the Erga domain's `/` is the small Sign in page. On
// that domain, Erga has only `/_erga/` (server/app.ts): the pages' model and its sign-in, a round trip through the
// Erga domain (server/identity/home-pass.ts) that needs the facts' `app`. The Erga domain's session never counts
// there. A test gives its server `ERGA_DEPLOY={"home":"home.localhost"}` (e2e/homepage/homepage.e2e.ts). The browser
// reaches home.localhost; Node's and Bun's fetch can't, so send the Host header with `node:http`.

import * as Effect from "effect/Effect";
import { call, ctx, fromWeb } from "../http.ts";
import { roleMay } from "../directory/index.ts";
import { accountOf, link, OWN_ACCOUNT, withEdit } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { type Copy, decide, isLivePage, type LivePage, settle } from "./snapshot.ts";
import { HOME_FILES, homeHeader, pageInter, withHomeLlm, withToken } from "./render.ts";
import { pageToken } from "./llm-token.ts";
import { actingAdmin } from "../identity/index.ts";
import { fileOf, NOT_FOUND, redirectOf } from "./site.ts";
import { localLibraries } from "../../shared/page-html.ts";

/** The snapshot as this isolate last had it, and when it last asked whether it's still current. */
let memo: Copy | null = null;
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
    const known = memo?.page ?? null;
    const copy = settle(known, await platform.home.page(known?.gen ?? null), Date.now());
    const cache = platform.edge.cache;
    if (copy == "keep") return memo?.page ?? null;
    memo = copy;
    if (!copy) await cache?.delete(cacheKey(url)).catch(() => false);
    else
      await cache
        ?.put(
          cacheKey(url),
          new Response(JSON.stringify(copy.page), {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", "x-checked": String(copy.checked) },
          })
        )
        .catch(() => {});
    return copy?.page ?? null;
  })().finally(() => { refreshing = null; });
}

/** The edge's copy, if it has one of this release's shape. */
async function cached(platform: Platform, url: URL): Promise<Copy | null> {
  try {
    const hit = await platform.edge.cache?.match(cacheKey(url));
    if (!hit) return null;
    const page: unknown = await hit.json();
    return isLivePage(page) ? { page, checked: Number(hit.headers.get("x-checked")) || 0 } : null;
  } catch {
    return null;
  }
}

/** The snapshot to serve, and where it came from: this isolate, the edge's cache or the home object (snapshot.ts, decide). */
async function livePage(platform: Platform, url: URL): Promise<{ page: LivePage; from: string } | null> {
  const recheckMs = platform.edge.homeRecheckMs;
  let cache: Copy | null | undefined;
  let d = decide(memo, cache, Date.now(), recheckMs);
  if (d.do == "cache") d = decide(memo, (cache = await cached(platform, url)), Date.now(), recheckMs);
  if (d.do == "serve") {
    const { copy } = d;
    if (d.refresh) platform.edge.background(refresh(platform, url).catch((e) => console.log(`couldn't check the homepage: ${e}`)));
    if (copy == memo) return { page: copy.page, from: "memory" };
    memo = copy;
    return { page: copy.page, from: "cache" };
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
export const serveHome = Effect.flatMap(ctx, ({ request, platform }) =>
  Effect.map(
    call(() => homePage(request, platform)),
    (r) => r && fromWeb(r)
  )
);

/** serveHome's answer, as a web Response (its header streams in after the page's start), or null. */
async function homePage(request: Request, platform: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  const live = await livePage(platform, url);
  if (!live) {
    platform.edge.background(platform.home.ensure().catch((e) => console.log(`couldn't start the homepage's deploy: ${e}`)));
    return null;
  }
  const { page, from } = live;
  // site.json may turn the bars off: then nobody gets them (someone signed in never sees /).
  const controls = !page.site.bars
    ? Promise.resolve("")
    : (async () => {
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
      account: accountOf(session, admin),
      here: url.pathname + url.search,
      doc: page.docId,
      font: !pageInter(page.before),
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
      c.enqueue(encoder.encode(withToken(page.before, await pageToken(platform.secret, page.docId, Date.now()))));
      let header = "";
      try { header = await controls; } catch (e) { console.log(`the homepage's controls failed: ${e}`); }
      c.enqueue(encoder.encode(header + page.after));
      c.close();
    },
  });
  return new Response(body, { headers });
}

/** One of a deploy's files, /_home-files/<gen>/<path>: the same forever, so kept for good, in the browser and the edge's cache. */
export const serveHomeFile = Effect.flatMap(ctx, ({ request, platform }) =>
  Effect.map(
    call(() => homeFile(request, platform)),
    fromWeb
  )
);

/** serveHomeFile's answer, as a web Response (the edge's cache keeps it so). */
async function homeFile(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const [, gen, rest] = /^\/_home-files\/([a-z0-9]+)\/(.+)$/.exec(url.pathname) ?? [];
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
 * Any other address of the homepage's site (site.ts): a rule of its _redirects, one of its files at its clean address,
 * or, with `notFound`, its 404.html. Null when the site has nothing there, or when `taken` says the address is Erga's
 * (Erga's paths win): the app answers it. Its HTML pages get window.ergaLLM, as / does.
 */
export const serveHomeSite = (o: { notFound: boolean; taken: () => Promise<boolean> }) =>
  Effect.flatMap(ctx, ({ request, platform }) =>
    Effect.map(
      call(() => siteAnswer(request, platform, o)),
      (r) => r && fromWeb(r)
    )
  );

/** How the site answers: on the Erga domain (`taken`: whether an address is Erga's), or on its own (`direct`). */
type Where = { notFound: boolean; taken?: () => Promise<boolean>; direct?: boolean };

async function siteAnswer(request: Request, platform: Platform, o: Where): Promise<Response | null> {
  const url = new URL(request.url);
  // On the Erga domain, / is serveHome's alone. It had no snapshot a moment ago: a first deploy that ends since must
  // not make / the site's bare index.html.
  if (url.pathname == "/" && !o.direct) return null;
  const live = await livePage(platform, url);
  if (!live) return null;
  const page = live.page;
  const files = new Set(page.files);
  const has = (p: string) => files.has(p);
  const redirect = redirectOf(page.site, url.pathname, url.search);
  const found = redirect ? null : fileOf(has, url.pathname);
  if ((redirect || found) && o.taken && (await o.taken())) return null;
  if (redirect) return new Response(null, { status: redirect.status, headers: { Location: redirect.to, "Cache-Control": "no-cache" } });
  if (found && "slash" in found)
    return new Response(null, { status: 301, headers: { Location: found.slash + url.search, "Cache-Control": "no-cache" } });
  if (found) return siteFile(request, platform, page, found.file, 200, !!o.direct);
  if (o.notFound && has(NOT_FOUND)) return siteFile(request, platform, page, NOT_FOUND, 404, !!o.direct);
  return null;
}

/** One of the snapshot's files, as it is (an HTML page with window.ergaLLM); null if the deploy lost it. */
async function siteFile(
  request: Request,
  platform: Platform,
  page: LivePage,
  rel: string,
  status: number,
  direct: boolean
): Promise<Response | null> {
  const file = await platform.home.file(page.gen, rel);
  if (!file) return null;
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...AUTHORS_POLICY,
  };
  // An HTML page gets the homepage's model (window.ergaLLM), as the homepage's own page does; on its own domain, at
  // that domain's /_erga/ (agents/page-llm.ts, homeDomainLlmApi).
  // On its own domain, a page's libraries of Erga's (/erga/<name>/editor.js) are at the Erga domain (the facts' `app`).
  const app = new URL(request.url);
  if (direct && platform.deploy.app) app.hostname = platform.deploy.app;
  const body = /^text\/html/i.test(file.type)
    ? withHomeLlm(
        localLibraries(new TextDecoder().decode(file.bytes), direct && platform.deploy.app ? app.origin : ""),
        page.docId,
        await pageToken(platform.secret, page.docId, Date.now()),
        direct ? "/_erga" : ""
      )
    : (file.bytes as BodyInit);
  return new Response(request.method == "HEAD" ? null : body, { status, headers });
}

/**
 * Every request on the homepage's own domain (Platform's deploy.home): the deployed snapshot's files as they are, at
 * their clean addresses, with its redirects and its 404 page. No bars, no pencil, no viewer, no frame: people edit the
 * site on the Erga domain, and a deploy there changes what this domain serves. Of Erga's, only window.ergaLLM in its
 * HTML pages, and its paths under /_erga/ (server/app.ts).
 */
export const serveHomeDomain = Effect.flatMap(ctx, ({ request, platform }) =>
  Effect.map(
    call(() => homeDomain(request, platform)),
    fromWeb
  )
);

async function homeDomain(request: Request, platform: Platform): Promise<Response> {
  const plain = (text: string, status: number) =>
    new Response(request.method == "HEAD" ? null : text, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", ...AUTHORS_POLICY },
    });
  if (request.method != "GET" && request.method != "HEAD") return plain("Not allowed", 405);
  const answer = await siteAnswer(request, platform, { notFound: true, direct: true });
  if (answer) return answer;
  if (!(await livePage(platform, new URL(request.url)))) {
    platform.edge.background(platform.home.ensure().catch((e) => console.log(`couldn't start the homepage's deploy: ${e}`)));
    return plain("This site isn't deployed yet.", 503);
  }
  return plain("Not found", 404);
}
