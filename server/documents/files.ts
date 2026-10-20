// A document's files for the viewer: /_f/<key>/<path>, on this site's own origin (the connection the viewer's
// page came on, so a first visit opens no other). The key names the document and the version viewers see
// (Document.view's `ver`, a digest of its files), with a MAC of the server's secret: only a viewer page this
// server rendered for someone who may view the document hands one out, and nobody can make one for another
// version or document. On a server for admins alone (staging) it names the admin too, who must still be one.
//
// The files of one version never change, so each is kept for a year, by the browser and by the edge's cache
// (`public, immutable`): a second view asks nothing for them. A key for a version that's no longer the one viewers
// see (the document changed since the page was rendered) still answers, with the files as they are now, checked
// each time (`no-cache`).
//
// The viewer's frame has an opaque origin, so these are cross-origin requests: every answer allows any origin
// (CORS), and none carries a cookie (the session cookie is SameSite=Lax, which the opaque origin's requests never
// send). Every answer also has its own sandbox (Content-Security-Policy: sandbox), so a file opened by itself at
// this address runs in an opaque origin too, never as this site; a page may be framed only by this site.
// A page (HTML) has the reader's script (pages/reader.ts) put first, as the srcdoc page has.

import { type Platform } from "../platform.ts";
import { ID } from "../directory/index.ts";
import { readerPage } from "../pages/index.ts";
import { forwarded } from "./front-door.ts";

export const FILES_PREFIX = "/_f/";

/** Whether a path is a document's files' (filesDoor). */
export const isFilesPath = (path: string) => path.startsWith(FILES_PREFIX);

const YEAR = 365 * 24 * 60 * 60;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const keys = new Map<string, Promise<CryptoKey>>();
async function mac(secret: string, value: string): Promise<string> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-files:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (keys.size > 4) keys.clear();
    keys.set(secret, key);
  }
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(value)))).slice(0, 22);
}

/** The path every file of this version of the document is under: /_f/<id>.<ver>[.<admin>].<mac>/ (`by`: staging's admin). */
export async function filesPrefix(secret: string, id: string, ver: string, by?: string | null): Promise<string> {
  const named = `${id}.${ver}${by ? `.${by.toLowerCase()}` : ""}`;
  return `${FILES_PREFIX}${named}.${await mac(secret, named)}/`;
}

/** What a files address's key says, if its MAC is good: the document, the version, and the admin it names (staging). */
export async function readFilesKey(secret: string, key: string): Promise<{ id: string; ver: string; by: string | null } | null> {
  const parts = key.split(".");
  if (parts.length != 3 && parts.length != 4) return null;
  const [id, ver] = parts, by = parts.length == 4 ? parts[2] : null, given = parts[parts.length - 1];
  if (!ID.test(id) || !/^[a-z0-9]{1,40}$/.test(ver) || (by != null && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(by))) return null;
  const want = await mac(secret, parts.slice(0, -1).join("."));
  if (want.length != given.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return d == 0 ? { id, ver, by } : null;
}

/** The sandbox every file answers with: a page may run scripts (as it does in the viewer's frame), in an opaque origin, framed only by this site. */
const sandboxOf = (html: boolean, origin: string) => (html ? `sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors ${origin}` : "sandbox");

/** GET /_f/<key>/<path>: one of a document's files, as viewers see it (see the top of this file). */
export async function filesDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const notFound = (status = 404) => new Response(status == 404 ? "Not found" : "Not allowed", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  if (request.method != "GET" && request.method != "HEAD") return notFound();
  const [, key, rest] = /^\/_f\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
  const claims = key ? await readFilesKey(platform.secret, key) : null;
  if (!claims) return notFound();
  // On staging: an admin's key, while they're still one.
  if (platform.adminsOnly && !(claims.by && (await platform.directory.users.isAdmin({ login: claims.by })))) return notFound(403);
  const cache = platform.edge.cache;
  const cacheKey = `${url.origin}${url.pathname}${url.search}`;
  const ranged = request.headers.has("range");
  if (cache && !ranged) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return fresh(hit, request);
  }
  const inner = forwarded(request, url, `/doc${rest}`, `${url.origin}/d/${claims.id}`, null, "files");
  inner.headers.set("x-erga-view", claims.ver);
  const answer = await platform.docs.fetch({ id: claims.id, owner: "", test: false }, inner);
  const same = answer.headers.get("x-erga-view-same") == "1";
  const headers = new Headers(answer.headers);
  headers.delete("x-erga-view-same");
  headers.delete("set-cookie");
  const html = /^text\/html\b/i.test(headers.get("content-type") ?? "");
  headers.set("Content-Security-Policy", sandboxOf(html, url.origin));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", same && (answer.status == 200 || answer.status == 302) ? `public, max-age=${YEAR}, immutable` : "no-cache");
  let body: BodyInit | null = answer.body;
  if (html && answer.status == 200 && request.method == "GET") {
    body = readerPage(await answer.text(), { page: null, prefix: `${FILES_PREFIX}${key}/` });
    headers.delete("content-length");
    headers.delete("etag");
  }
  const response = new Response(body, { status: answer.status, statusText: answer.statusText, headers });
  if (cache && same && !ranged && request.method == "GET" && (answer.status == 200 || answer.status == 302)) {
    platform.edge.background(cache.put(cacheKey, response.clone()).catch(() => {}));
  }
  return response;
}

/** A kept answer, or 304 when the browser has it already. */
function fresh(hit: Response, request: Request): Response {
  const etag = hit.headers.get("etag");
  if (etag && request.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") == etag.replace(/^W\//, ""))) {
    return new Response(null, { status: 304, headers: hit.headers });
  }
  return request.method == "HEAD" ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
}
