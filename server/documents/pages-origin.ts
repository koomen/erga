// A document's pages origin (<id>-<owner>.erga-pages.dev, or one shared host): where the
// document's page runs, for readers and editors alike, apart from the app's origin. The
// viewer (view.ts) holds it in its one frame; the page editor runs inside it there (the
// page needs an origin of its own for that, holding nothing but this one document). A
// signed token in the address opens the document's files (pagesToken): /t/<token>/<path>
// is the file at <path>, and a page (an HTML file the frame goes to) comes with what the
// viewer and the editor need in it (pages/reader.ts, readerPage).

import * as Effect from "effect/Effect";
import { call, ctx, fromWeb } from "../http.ts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { ID, OWNER } from "../directory/index.ts";
import type { Platform } from "../platform.ts";
import { forwarded } from "./routes.ts";
import { markPage, sourceDigest } from "../../shared/page-html.ts";
import { readerPage, readerVersion } from "../pages/index.ts";

const PAGES_LABEL = /^([a-z0-9]{8})-([a-z0-9-]{1,39})$/;

const DAY = 24 * 60 * 60, WEEK = 7 * DAY;

/** Whether a request came to a document's pages origin (any of them), rather than the app's own. */
export const isPagesSite = (url: URL, platform: Platform) => url.hostname.endsWith(`.${platform.pagesDomain(url)}`) || (!!platform.pagesShared?.(url) && url.hostname == platform.pagesShared(url));

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
      const d = claims && (JSON.parse(Result.getOrThrow(Base64Url.decodeString(claims))) as { d?: unknown }).d;
      const [owner, id] = typeof d == "string" ? d.split("/") : [];
      return owner && id && OWNER.test(owner) && ID.test(id) ? { owner, id } : null;
    } catch { return null; }
  }
  const domain = platform.pagesDomain(url);
  if (!url.hostname.endsWith(`.${domain}`)) return null;
  const m = PAGES_LABEL.exec(url.hostname.slice(0, -domain.length - 1));
  return m && OWNER.test(m[2]) && ID.test(m[1]) ? { owner: m[2], id: m[1] } : null;
}

/** The signing key, imported once per secret (per isolate): every file of a document's page checks its token. */
/** Whether two strings (MACs) are the same, in a time that doesn't say where they differ. */
const sameText = (a: string, b: string) => {
  if (a.length != b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d == 0;
};

const hmacKeys = new Map<string, Promise<CryptoKey>>();

const hmac = async (secret: string, value: string) => {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-pages:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (hmacKeys.size > 4) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return Base64Url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(value))));
};

/**
 * A token that opens one document's files on its pages origin, for a week, for the viewer at `shell` (whose origin it names);
 * `edit`: for someone who may edit it, whose pages come with what the editor needs in them (readerPage).
 * Its expiry is rounded up to the next whole day, so the token, and with it the address of every file of the page, stays the
 * same all day: the browser's cache can answer for them (they're checked by ETag, pagesRoutes and document/host.ts's docFile).
 */
export async function pagesToken(secret: string, owner: string, id: string, shell: string, now = Date.now(), opts: { by?: string; edit?: boolean } = {}): Promise<string> {
  // by: whom it was made for, only on a server for admins alone (staging, Platform.adminsOnly): its pages origin lets the
  // token in only while they're still an admin. Elsewhere a token names nobody (a page's own
  // scripts can read its address).
  const claims = Base64Url.encode(
    new TextEncoder().encode(
      JSON.stringify({
        d: `${owner.toLowerCase()}/${id}`,
        e: Math.ceil((now / 1000 + WEEK) / DAY) * DAY,
        s: shell,
        ...(opts.by ? { a: opts.by.toLowerCase() } : {}),
        ...(opts.edit ? { w: 1 } : {}),
      })
    )
  );
  return `${claims}.${await hmac(secret, claims)}`;
}

/** The editor's origin, if `token` is good for this document and current. */
export async function readPagesToken(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<string | null> {
  return (await readPagesClaims(secret, token, owner, id, now))?.shell ?? null;
}

/** What a good, current token for this document says: the viewer's origin, whom it was made for (if it says), and whether for an editor. */
export async function readPagesClaims(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<{ shell: string; by?: string; edit?: boolean } | null> {
  const [claims, mac, extra] = token.split(".");
  if (!claims || !mac || extra != null || !sameText(mac, await hmac(secret, claims))) return null;
  try {
    const c = JSON.parse(Result.getOrThrow(Base64Url.decodeString(claims))) as {
      d?: string;
      e?: number;
      s?: string;
      a?: unknown;
      w?: unknown;
    };
    if (c.d != `${owner.toLowerCase()}/${id}` || !(Number(c.e) > now / 1000) || typeof c.s != "string") return null;
    return new URL(c.s).origin == c.s ? { shell: c.s, ...(typeof c.a == "string" ? { by: c.a } : {}), ...(c.w === 1 ? { edit: true } : {}) } : null;
  } catch { return null; }
}

/** A page made from a text (by its file's ETag): its marked HTML and its text's digest, a few megabytes at most. */
const marked = new Map<string, { html: string; src: string }>();
let markedSize = 0;
const MARKED_MAX = 8_000_000;

function markedPage(etag: string | null, text: string): { html: string; src: string } {
  const kept = etag ? marked.get(etag) : undefined;
  if (kept) return kept;
  const made = { html: markPage(text), src: sourceDigest(text) };
  if (etag && text.length < MARKED_MAX / 8) {
    if (markedSize + made.html.length > MARKED_MAX) { marked.clear(); markedSize = 0; }
    marked.set(etag, made);
    markedSize += made.html.length;
  }
  return made;
}

/**
 * A request to a document's pages origin: /t/<token>/<path> is the document's file at <path> (/t/<token>/ its own
 * page), which only the viewer on the token's site may frame. A page the frame goes to (an HTML file, as a frame's
 * document) comes marked, with the viewer's script first in it (readerPage); anything else as the file is.
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
  const [, token, rest] = /^\/t\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
  if (!token || (request.method != "GET" && request.method != "HEAD")) return notFound();
  const claims = await readPagesClaims(platform.secret, token, doc.owner, doc.id);
  const shell = claims?.shell;
  if (!claims || !shell) return new Response("This link has expired: reload the page.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  // A frame's document (Sec-Fetch-Dest says so: a page's own fetch of an HTML file gets the file as it is).
  const page = request.method == "GET" && /^(iframe|frame|document)$/.test(request.headers.get("sec-fetch-dest") ?? "");
  // Its ETag is the file's with what goes in it (this code's version and the token's kind), so the browser's copy is
  // checked against the file's: the file's own (stripped of ours) goes to the document.
  const ours = `.${readerVersion()}${claims.edit ? "w" : ""}`;
  const asked = new Headers(request.headers);
  // This origin has no cookies of its own. Until erga-pages.dev is on the Public Suffix List (docs/psl-submission.md),
  // one document's page can set a cookie for all of them: it goes no further than here.
  asked.delete("cookie");
  const inm = asked.get("if-none-match");
  if (page && inm) {
    const theirs = inm.split(",").map((t) => t.trim().replace(/^W\//, "")).filter((t) => t.endsWith(`${ours}"`)).map((t) => t.slice(0, -ours.length - 1) + '"');
    if (theirs.length) asked.set("if-none-match", theirs.join(", ")); else asked.delete("if-none-match");
  }
  // The token names the document; the directory confirms it's still its owner's (remembered, so usually without asking the
  // database). Both at once: a file is only read, so asking the document before the answer comes costs nothing if it's no.
  const at = { id: doc.id, owner: doc.owner.toLowerCase(), test: false };
  const inner = new Request(request.url, { method: request.method, headers: asked });
  const [route, answer] = await Promise.all([
    platform.directory.route(doc.id),
    platform.docs.fetch(at, forwarded(inner, url, `/doc${rest}`, null, "files")),
  ]);
  if (!route || route.owner != at.owner) { await answer.body?.cancel(); return notFound(); }
  const type = answer.headers.get("content-type") ?? "";
  if (!page || !/^text\/html\b/i.test(type) || (answer.status != 200 && answer.status != 304)) return answer;
  const etag = answer.headers.get("etag");
  const headers = new Headers(answer.headers);
  for (const h of ["content-length", "content-range", "accept-ranges"]) headers.delete(h);
  if (etag) headers.set("ETag", etag.replace(/"$/, `${ours}"`));
  // Only the viewer that the token names may frame it.
  headers.set("Content-Security-Policy", `frame-ancestors ${shell}`);
  headers.set("Referrer-Policy", "no-referrer");
  if (answer.status == 304) return new Response(null, { status: 304, headers });
  const made = markedPage(etag, await answer.text());
  return new Response(readerPage(made.html, { shell, prefix: `/t/${token}/`, src: made.src, editor: !!claims.edit }), { status: 200, headers });
}
