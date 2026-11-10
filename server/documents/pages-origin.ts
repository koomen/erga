// A document's pages origin (<id>-<owner>.erga-pages.dev, or one shared host): where the
// document's page runs, for readers and editors alike, apart from the app's origin. The
// viewer (view.ts) holds it in its one frame; the page editor runs inside it there (the
// page needs an origin of its own for that, holding nothing but this one document). A
// signed token in the address opens the document's files (pagesToken): /t/<token>/<path>
// is the file at <path>, and a page (an HTML file the frame goes to) comes with what the
// viewer and the editor need in it (pages/reader.ts, readerPage).
//
// Trap: a pass carries the document's share counter (document/access.ts, `shares`), and the document refuses a pass
// from before a share ended. A test that asks the document for a file with a checked key sends `x-erga-shares` too.
// An open page keeps its old pass: after a share ends, its next file gets a 403 until the person loads the page again.

import * as Effect from "effect/Effect";
import { call, ctx, fromWeb } from "../http.ts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";
import { ID, OWNER } from "../directory/index.ts";
import type { Platform } from "../platform.ts";
import { forwarded } from "./routes.ts";
import { sourceDigest } from "../../shared/page-html.ts";
import { readerPage, readerVersion } from "../pages/index.ts";
import { PAGE_HEADER } from "../../shared/offline.ts";

const PAGES_LABEL = /^([a-z0-9]{8})-([a-z0-9-]{1,39})$/;

const DAY = 24 * 60 * 60, WEEK = 7 * DAY;

/** Whether a request came to a document's pages origin (any of them), rather than the app's own. */
export const isPagesSite = (url: URL, platform: Platform) => url.hostname.endsWith(`.${platform.pagesDomain(url)}`) || (!!platform.pagesShared?.(url) && url.hostname == platform.pagesShared(url));

/**
 * Whether this origin has Erga's service worker (server/pages/worker.ts): the app's own, and a document's own pages
 * origin. Never a shared pages host (the setting pagesHost: one host for every document), where the copy and the
 * replica the editor keeps would not be one document's.
 */
export const workerHere = (url: URL, platform: Pick<Platform, "pagesDomain" | "pagesShared">) =>
  !(isPagesSite(url, platform as Platform) && platform.pagesShared?.(url) == url.hostname);

/** The origin a document's page runs on. */
export function pagesOrigin(owner: string, id: string, url: URL, platform: Platform): string {
  const shared = platform.pagesShared?.(url);
  if (shared) return `https://${shared}`;
  const domain = platform.pagesDomain(url);
  return domain == "localhost" ? `${url.protocol}//${id}-${owner.toLowerCase()}.localhost${url.port ? `:${url.port}` : ""}` : `https://${id}-${owner.toLowerCase()}.${domain}`;
}

/** The document a pages origin is for, if the request came to one. */
export function pagesHost(url: URL, platform: Platform): { owner: string; id: string } | null {
  // On a shared host the document is the one its token names (pagesRoutes checks the token itself).
  const shared = platform.pagesShared?.(url);
  if (shared && url.hostname == shared) {
    const claims = /^\/t\/([^/.]+)\./.exec(url.pathname)?.[1];
    try {
      // (Only to find the document: pagesRoutes opens the token, with its signature.)
      const d = claims && (JSON.parse(Result.getOrThrow(Base64Url.decodeString(claims))) as { v?: { d?: unknown } }).v?.d;
      const [owner, id] = typeof d == "string" ? d.split("/") : [];
      return owner && id && OWNER.test(owner) && ID.test(id) ? { owner, id } : null;
    } catch { return null; }
  }
  const domain = platform.pagesDomain(url);
  if (!url.hostname.endsWith(`.${domain}`)) return null;
  const m = PAGES_LABEL.exec(url.hostname.slice(0, -domain.length - 1));
  return m && OWNER.test(m[2]) && ID.test(m[1]) ? { owner: m[2], id: m[1] } : null;
}

/**
 * A pages token's value (server/signed.ts): the document (d), the viewer's origin (s), whom it was made for (a) and
 * whether for an editor (w), and the document's share counter when it was made (n).
 */
const PagesToken = signed(
  "pages",
  Schema.Struct({
    d: Schema.String,
    s: Schema.String,
    a: Schema.optionalKey(Schema.String),
    w: Schema.optionalKey(Schema.Literal(1)),
    n: Schema.optionalKey(Schema.Number),
  }),
  WEEK
);

/**
 * A token that opens one document's files on its pages origin, for a week, for the viewer at `shell` (whose origin it names);
 * `edit`: for someone who may edit it, or comment on it (the comments are the editor's), whose pages come with what
 * the editor needs in them (readerPage).
 * Its expiry is rounded up to the next whole day, so the token, and with it the address of every file of the page, stays the
 * same all day: the browser's cache can answer for them (they're checked by ETag, pagesRoutes and document/host.ts's docFile).
 * `ttl`: good for that many seconds only, not rounded (the server's own browser: cloudflare/render.ts).
 * `shares`: the document's share counter now (document/access.ts): the token opens its files only until a share of it ends.
 */
export async function pagesToken(
  secret: string,
  owner: string,
  id: string,
  shell: string,
  now = Date.now(),
  opts: { by?: string; edit?: boolean; ttl?: number; shares?: number } = {}
): Promise<string> {
  // by: whom it was made for, only on a server for admins alone (staging, Platform.adminsOnly): its pages origin lets the
  // token in only while they're still an admin. Elsewhere a token names nobody (a page's own
  // scripts can read its address).
  return PagesToken.seal(
    secret,
    {
      d: `${owner.toLowerCase()}/${id}`,
      s: shell,
      ...(opts.by ? { a: opts.by.toLowerCase() } : {}),
      ...(opts.edit ? { w: 1 as const } : {}),
      ...(opts.shares ? { n: opts.shares } : {}),
    },
    { until: opts.ttl ? Math.ceil(now / 1000 + opts.ttl) : Math.ceil((now / 1000 + WEEK) / DAY) * DAY }
  );
}

/** The editor's origin, if `token` is good for this document and current. */
export async function readPagesToken(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<string | null> {
  return (await readPagesClaims(secret, token, owner, id, now))?.shell ?? null;
}

/** What a good, current token for this document says: the viewer's origin, whom it was made for (if it says), whether for an editor, and its share counter. */
export async function readPagesClaims(
  secret: string,
  token: string,
  owner: string,
  id: string,
  now = Date.now()
): Promise<{ shell: string; by?: string; edit?: boolean; shares: number } | null> {
  const c = await PagesToken.open(secret, token, now);
  if (!c || c.d != `${owner.toLowerCase()}/${id}`) return null;
  try {
    return new URL(c.s).origin == c.s
      ? { shell: c.s, ...(c.a != null ? { by: c.a } : {}), ...(c.w === 1 ? { edit: true } : {}), shares: c.n ?? 0 }
      : null;
  } catch { return null; }
}

/**
 * A request to a document's pages origin: /t/<token>/<path> is the document's file at <path> (/t/<token>/ its own
 * page), which only the viewer on the token's site may frame. A reader's address has the document's version after the
 * token (/t/<token>/@<ver>/<path>, server/documents/view.ts): its files are kept by the browser until the version changes. A page the frame goes to (an HTML file, as a frame's
 * document) comes with the viewer's script first in it (readerPage); anything else as the file is.
 */
export const pagesRoutes = (doc: { owner: string; id: string }) =>
  Effect.flatMap(ctx, ({ request, url, platform }) =>
    Effect.map(
      call(() => pageFile(request, url, doc, platform)),
      fromWeb
    )
  );

/** The answer of pagesRoutes, as a web Response: mostly the document's own, passed on. */
async function pageFile(request: Request, url: URL, doc: { owner: string; id: string }, platform: Platform): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  // (/t/<token>/@<ver>/<path>: a reader's address, with the version of the document that the viewer showed.)
  const [, token, ver, rest] = /^\/t\/([^/]+)(?:\/@([^/]+))?(\/.*)$/.exec(url.pathname) ?? [];
  if (!token || (request.method != "GET" && request.method != "HEAD")) return notFound();
  const claims = await readPagesClaims(platform.secret, token, doc.owner, doc.id);
  const shell = claims?.shell;
  if (!claims || !shell) return new Response("This link has expired: reload the page.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  // A frame's document (Sec-Fetch-Dest says so: a page's own fetch of an HTML file gets the file as it is), or the page's
  // editor asking for its page as the frame got it (libs/text/ui/offline-page.ts: for the browser's copy).
  const page =
    request.method == "GET" &&
    (/^(iframe|frame|document)$/.test(request.headers.get("sec-fetch-dest") ?? "") || request.headers.get(PAGE_HEADER) == "1");
  // Its ETag is the file's with what goes in it (this code's version and the token's kind), so the browser's copy is
  // checked against the file's: the file's own (stripped of ours) goes to the document.
  const ours = `.${readerVersion()}${claims.edit ? "w" : ""}`;
  const asked = new Headers(request.headers);
  // This origin has no cookies of its own. Until erga-pages.dev is on the Public Suffix List (a request to publicsuffix.org),
  // one document's page can set a cookie for all of them: it goes no further than here.
  asked.delete("cookie");
  // A reader's address with a version: the document says its version now with the file. An address then always means the
  // same files, and the browser keeps them. Not an editor's: its page changes under it, and is checked each time.
  const versioned = !!ver && !claims.edit;
  if (versioned) asked.set("x-erga-ver", ver);
  else asked.delete("x-erga-ver");
  const inm = asked.get("if-none-match");
  if (page && inm) {
    const theirs = inm.split(",").map((t) => t.trim().replace(/^W\//, "")).filter((t) => t.endsWith(`${ours}"`)).map((t) => t.slice(0, -ours.length - 1) + '"');
    if (theirs.length) asked.set("if-none-match", theirs.join(", ")); else asked.delete("if-none-match");
  }
  // The token names the document; the directory confirms it's still its owner's (remembered, so usually without asking the
  // database). Both at once: a file is only read, so asking the document before the answer comes costs nothing if it's no.
  // The document hears the token's share counter, and refuses one from before a share ended (document/access.ts).
  const at = { id: doc.id, owner: doc.owner.toLowerCase(), test: false };
  const inner = forwarded(new Request(request.url, { method: request.method, headers: asked }), url, `/doc${rest}`, null, "files");
  inner.headers.set("x-erga-shares", String(claims.shares));
  const [route, answer] = await Promise.all([platform.directory.route(doc.id), platform.docs.fetch(at, inner)]);
  if (!route || route.owner != at.owner) { await answer.body?.cancel(); return notFound(); }
  const type = answer.headers.get("content-type") ?? "";
  const now = versioned ? answer.headers.get("x-erga-ver") : null;
  const found = answer.status == 200 || answer.status == 304;
  // A page at a version that is not the document's now (a link in an old page, a tab that was away): the same page at
  // the version now, so its files are that version's too.
  if (page && found && now && now != ver) {
    await answer.body?.cancel();
    return new Response(null, {
      status: 302,
      headers: { Location: `/t/${token}/@${now}${rest}${url.search}`, "Cache-Control": "no-store" },
    });
  }
  if (!page || !/^text\/html\b/i.test(type) || !found) {
    // A file as it is, at the version now: this address never has other bytes.
    if (answer.status != 200 || !now || now != ver) return answer;
    const kept = new Headers(answer.headers);
    kept.set("Cache-Control", "private, max-age=31536000, immutable");
    return new Response(answer.body, { status: 200, headers: kept });
  }
  const etag = answer.headers.get("etag");
  const headers = new Headers(answer.headers);
  for (const h of ["content-length", "content-range", "accept-ranges"]) headers.delete(h);
  if (etag) headers.set("ETag", etag.replace(/"$/, `${ours}"`));
  // Only the viewer that the token names may frame it.
  headers.set("Content-Security-Policy", `frame-ancestors ${shell}`);
  headers.set("Referrer-Policy", "no-referrer");
  if (answer.status == 304) return new Response(null, { status: 304, headers });
  const text = await answer.text();
  return new Response(
    readerPage(text, { shell, prefix: `/t/${token}/${ver ? `@${ver}/` : ""}`, src: sourceDigest(text), editor: !!claims.edit }),
    {
    status: 200,
    headers,
  });
}
