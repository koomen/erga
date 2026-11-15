// Serving a domain from its published snapshot (publishing.ts): remembered in this isolate and in the edge's cache,
// and checked against the domain's site object for a newer one at most every few seconds, after answering
// (stale-while-revalidate), so a page never waits on anything but the snapshot, and usually not even on that. Where
// there's no edge cache (workers.dev has none) the isolate's memory serves alone.
//
// The Erga domain (the server's own): / is the published page, with Erga's controls if the document's publishing
// setting has them; its files are at /_home-files/<gen>/<path>, cached for good; the site's other addresses answer
// after Erga's own (server/app.ts). A custom domain (the deploy's `--domain`, Platform's deploy.domains) gets only the
// site's files (serveDomain): on it, Erga has only `/_erga/` (server/app.ts): the pages' model and its sign-in, a round
// trip through the Erga domain (server/identity/domain-pass.ts) that needs the facts' `app`. The Erga domain's session
// never counts there. A domain with nothing published answers with nothing (`nothing`).
//
// A test gives its server `ERGA_DEPLOY={"domains":["site.localhost"]}` (e2e/publishing/publishing.e2e.ts). The browser
// reaches site.localhost; Node's and Bun's fetch can't, so send the Host header with `node:http`.

import * as Effect from "effect/Effect";
import { call, ctx, fromWeb } from "../http.ts";
import { roleMay } from "../directory/index.ts";
import { accountOf, link, OWN_ACCOUNT, withEdit } from "../pages/index.ts";
import { whoOf, type Platform } from "../platform.ts";
import { type Copy, decide, isServed, type LivePage, type Served, settle, tagOf } from "./snapshot.ts";
import { LIVE_FILES, pageInter, siteHeader, withBand, withControls, withLlm, withToken } from "./render.ts";
import { pageToken } from "./llm-token.ts";
import { actingAdmin } from "../identity/index.ts";
import { fileOf, NOT_FOUND, redirectOf } from "./addresses.ts";
import { localLibraries } from "../../shared/page-html.ts";
import { pageAddress } from "../../document/pages.ts";
import { domainOf, ERGA } from "./domains.ts";

/** What this isolate last had of each domain, and when it last asked whether it's still current. */
const memo = new Map<string, Copy>();
const refreshing = new Map<string, Promise<Served | null>>();

/** Where the edge keeps a domain's copy: an address of the domain's own (the edge's cache holds only its own zone's). */
function cacheKey(url: URL, domain: string): string {
  const at = new URL(`${LIVE_FILES}served`, url);
  if (domain != ERGA) at.hostname = domain;
  return at.toString();
}

/** Forgets what this isolate and its edge remember of a domain (after its state changed, through this isolate). */
export async function forgetSite(platform: Platform, url: URL, domain: string): Promise<void> {
  memo.delete(domain);
  await platform.edge.cache?.delete(cacheKey(url, domain)).catch(() => false);
}

/** Asks the site object what the domain serves (only what's changed), and remembers it here and in the edge's cache. */
function refresh(platform: Platform, url: URL, domain: string): Promise<Served | null> {
  const running = refreshing.get(domain);
  if (running) return running;
  const run = (async () => {
    const known = memo.get(domain)?.served ?? null;
    const copy = settle(known, await platform.site(domain).served(known && tagOf(known)), Date.now());
    const cache = platform.edge.cache;
    if (copy == "keep") return memo.get(domain)?.served ?? null;
    if (copy) memo.set(domain, copy);
    else memo.delete(domain);
    if (!copy) await cache?.delete(cacheKey(url, domain)).catch(() => false);
    else
      await cache
        ?.put(
          cacheKey(url, domain),
          new Response(JSON.stringify(copy.served), {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", "x-checked": String(copy.checked) },
          })
        )
        .catch(() => {});
    return copy?.served ?? null;
  })().finally(() => refreshing.delete(domain));
  refreshing.set(domain, run);
  return run;
}

/** The edge's copy, if it has one of this release's shape. */
async function cached(platform: Platform, url: URL, domain: string): Promise<Copy | null> {
  try {
    const hit = await platform.edge.cache?.match(cacheKey(url, domain));
    if (!hit) return null;
    const served: unknown = await hit.json();
    return isServed(served) ? { served, checked: Number(hit.headers.get("x-checked")) || 0 } : null;
  } catch {
    return null;
  }
}

/** What the domain serves, and where it came from: this isolate, the edge's cache or the site object (snapshot.ts, decide). */
async function live(platform: Platform, url: URL, domain: string): Promise<(Served & { from: string }) | null> {
  const recheckMs = platform.edge.siteRecheckMs;
  const mine = memo.get(domain) ?? null;
  let cache: Copy | null | undefined;
  let d = decide(mine, cache, Date.now(), recheckMs);
  if (d.do == "cache") d = decide(mine, (cache = await cached(platform, url, domain)), Date.now(), recheckMs);
  if (d.do == "serve") {
    const { copy } = d;
    if (d.refresh)
      platform.edge.background(
        refresh(platform, url, domain).catch((e) => console.log(`couldn't check ${domain || "the Erga domain"}: ${e}`))
      );
    if (copy == mine) return { ...copy.served, from: "memory" };
    memo.set(domain, copy);
    return { ...copy.served, from: "cache" };
  }
  const served = await refresh(platform, url, domain);
  return served && { ...served, from: "site" };
}

/** The document whose version the request's domain serves now (its id), or null: its pages alone may call its model as a guest. */
export const liveDoc = async (platform: Platform, url: URL) => (await live(platform, url, domainOf(platform, url)))?.page.docId ?? null;

/** A domain with nothing published answers with nothing: no page, no Erga text, no sign that a site was there. */
export const nothing = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * / on the Erga domain: the published page, with Erga's controls for whoever's asking, if the site has them. The page
 * goes out at once; the controls follow as soon as it's known who's asking (signed out, that's at once too). Null when
 * nothing is published there.
 */
export const serveRoot = Effect.flatMap(ctx, ({ request, platform }) =>
  Effect.map(
    call(() => rootPage(request, platform)),
    (r) => r && fromWeb(r)
  )
);

/**
 * Erga's controls over one of the site's pages (siteHeader), for whoever asks. `html`: the page, whose own Inter the
 * bars may use; `file`: the page's file (null: the document's own page).
 */
async function controlsOf(
  request: Request,
  platform: Platform,
  page: LivePage,
  url: URL,
  html: string,
  file: string | null
): Promise<string> {
  const session = await platform.sessionOf(request);
  const dir = platform.directory;
  const inPerson = !!session && !session.agent;
  // Someone signed out asks the database nothing.
  const [admin, doc] = inPerson ? await Promise.all([actingAdmin(dir.users, session), dir.route(page.docId)]) : [false, null];
  const role = inPerson && doc ? await dir.access(whoOf(session), doc) : null;
  const rest = file ? pageAddress(file) : "";
  const here = rest ? `${page.address}/${rest.split("/").map(encodeURIComponent).join("/")}` : page.address;
  return siteHeader({
    clone: link(`/new?from=${page.docId}`, session),
    edit: roleMay(role, "edit") ? withEdit(link(here, session)) : null,
    account: accountOf(session, admin),
    here: url.pathname + url.search,
    doc: page.docId,
    font: !pageInter(html),
  });
}

/** serveRoot's answer, as a web Response (its header streams in after the page's start), or null. */
async function rootPage(request: Request, platform: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  const served = await live(platform, url, ERGA);
  if (!served) return null;
  const { page, bars, from } = served;
  const controls = bars ? controlsOf(request, platform, page, url, page.before, null) : Promise.resolve("");
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    // Different for each person (the controls): never kept for someone else; checked each time.
    "Cache-Control": "private, no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Server-Timing": `site;desc="${from}"`,
    [OWN_ACCOUNT]: "1",
  };
  if (request.method == "HEAD") { controls.catch(() => {}); return new Response(null, { headers }); }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const before = withToken(page.before, await pageToken(platform.secret, page.docId, Date.now()));
      c.enqueue(encoder.encode(bars ? withBand(before) : before));
      let header = "";
      try {
        header = await controls;
      } catch (e) {
        console.log(`the published page's controls failed: ${e}`);
      }
      c.enqueue(encoder.encode(header + page.after));
      c.close();
    },
  });
  return new Response(body, { headers });
}

/** One of a snapshot's files, /_home-files/<gen>/<path>: the same forever, so kept for good, in the browser and the edge's cache. */
export const serveLiveFile = Effect.flatMap(ctx, ({ request, platform }) =>
  Effect.map(
    call(() => liveFile(request, platform)),
    fromWeb
  )
);

/** serveLiveFile's answer, as a web Response (the edge's cache keeps it so). */
async function liveFile(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const [, gen, rest] = /^\/_home-files\/([a-z0-9]+)\/(.+)$/.exec(url.pathname) ?? [];
  let path: string | null = null;
  try { path = rest ? decodeURIComponent(rest) : null; } catch { path = null; }
  if ((request.method != "GET" && request.method != "HEAD") || !gen || !path) return new Response("Not found", { status: 404 });
  const cache = platform.edge.cache;
  const key = url.origin + url.pathname;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return request.method == "HEAD" ? new Response(null, hit) : hit;
  const file = await platform.site(ERGA).file(gen, path);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const response = new Response(file.bytes as BodyInit, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", ...AUTHORS_POLICY } });
  if (cache) platform.edge.background(cache.put(key, response.clone()).catch(() => {}));
  return request.method == "HEAD" ? new Response(null, response) : response;
}

/** A site's files are its authors' code: no policy of the site's pages (server/security.ts), only the frame rule. */
const AUTHORS_POLICY = { "Content-Security-Policy": "frame-ancestors 'self'" };

/**
 * Any other address of the Erga domain's site (addresses.ts): a rule of its _redirects, one of its files at its clean
 * address, or, with `notFound`, its 404.html. Null when the site has nothing there, or when `taken` says the address is
 * Erga's (Erga's paths win): the app answers it. Its HTML pages get window.ergaLLM, and the controls, as / does.
 */
export const serveSitePath = (o: { notFound: boolean; taken: () => Promise<boolean> }) =>
  Effect.flatMap(ctx, ({ request, platform }) =>
    Effect.map(
      call(() => siteAnswer(request, platform, ERGA, o)),
      (r) => r && fromWeb(r)
    )
  );

/** How the site answers: on the Erga domain (`taken`: whether an address is Erga's), or on a custom one (no `taken`). */
type Where = { notFound: boolean; taken?: () => Promise<boolean> };

async function siteAnswer(request: Request, platform: Platform, domain: string, o: Where): Promise<Response | null> {
  const url = new URL(request.url);
  // On the Erga domain, / is serveRoot's alone.
  if (url.pathname == "/" && domain == ERGA) return null;
  const served = await live(platform, url, domain);
  if (!served) return null;
  const page = served.page;
  const files = new Set(page.files);
  const has = (p: string) => files.has(p);
  const redirect = redirectOf(page.site, url.pathname, url.search);
  const found = redirect ? null : fileOf(has, url.pathname);
  if ((redirect || found) && o.taken && (await o.taken())) return null;
  if (redirect) return new Response(null, { status: redirect.status, headers: { Location: redirect.to, "Cache-Control": "no-cache" } });
  if (found && "slash" in found)
    return new Response(null, { status: 301, headers: { Location: found.slash + url.search, "Cache-Control": "no-cache" } });
  if (found) return siteFile(request, platform, domain, served, found.file, 200);
  if (o.notFound && has(NOT_FOUND)) return siteFile(request, platform, domain, served, NOT_FOUND, 404);
  return null;
}

/** One of the snapshot's files, as it is (an HTML page with window.ergaLLM, and Erga's controls where the site has them); null if the publish lost it. */
async function siteFile(
  request: Request,
  platform: Platform,
  domain: string,
  { page, bars }: Served,
  rel: string,
  status: number
): Promise<Response | null> {
  const file = await platform.site(domain).file(page.gen, rel);
  if (!file) return null;
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...AUTHORS_POLICY,
  };
  if (!/^text\/html/i.test(file.type)) return new Response(request.method == "HEAD" ? null : (file.bytes as BodyInit), { status, headers });
  const html = new TextDecoder().decode(file.bytes);
  const token = await pageToken(platform.secret, page.docId, Date.now());
  // On a custom domain, the page's model is at that domain's /_erga/ (agents/page-llm.ts, domainLlmApi), and a page's
  // libraries of Erga's (/erga/<name>/editor.js) are at the Erga domain (the facts' `app`).
  if (domain != ERGA) {
    const app = new URL(request.url);
    if (platform.deploy.app) app.hostname = platform.deploy.app;
    const body = withLlm(localLibraries(html, platform.deploy.app ? app.origin : ""), page.docId, token, page.address, "/_erga");
    return new Response(request.method == "HEAD" ? null : body, { status, headers });
  }
  // On the Erga domain, the page is its own: never the app's bare corner (withAccount). With Erga's bars, it has the
  // controls / has, and starts below their band.
  headers[OWN_ACCOUNT] = "1";
  headers["Cache-Control"] = "private, no-cache";
  let body = withLlm(localLibraries(html, ""), page.docId, token, page.address);
  if (bars) body = withControls(body, await controlsOf(request, platform, page, new URL(request.url), html, rel));
  return new Response(request.method == "HEAD" ? null : body, { status, headers });
}

/**
 * Every request on a custom domain: the published snapshot's files as they are, at their clean addresses, with its
 * redirects and its 404 page. No bars, no pencil, no viewer, no frame: people edit the document on the Erga domain, and
 * a publish there changes what this domain serves. Of Erga's, only window.ergaLLM in its HTML pages, and its paths
 * under /_erga/ (server/app.ts). Null: nothing is published there.
 */
export const serveDomain = (domain: string) =>
  Effect.flatMap(ctx, ({ request, platform }) =>
    Effect.map(
      call(async () => {
        if (request.method != "GET" && request.method != "HEAD") return nothing();
        return (await siteAnswer(request, platform, domain, { notFound: true })) ?? nothing();
      }),
      fromWeb
    )
  );
