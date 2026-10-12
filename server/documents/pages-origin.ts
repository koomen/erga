// A document's pages origin (<id>-<owner>.erga-pages.dev, or one shared host): where its
// files run, apart from the app's origin. The frame's host page there (pages/frame-host.ts)
// opens the document's files with a signed token the viewer gives it (pagesToken), which
// says what it may read: the latest state, or the published version only.

import { ID, OWNER } from "../directory.ts";
import type { Platform } from "../platform.ts";
import { forwarded } from "./front-door.ts";
import { esc, HOST_SCRIPT, HOST_STYLE, HOST_VERSION, PAGE_SANDBOX, VIEW_FILES } from "../pages/index.ts";

const PAGES_LABEL = /^([a-z0-9]{8})-([a-z0-9-]{1,39})$/;

const DAY = 24 * 60 * 60, WEEK = 7 * DAY;

/** The origin a document's page runs on. */
export function pagesOrigin(owner: string, id: string, url: URL, platform: Platform): string {
  const shared = platform.pagesShared?.(url);
  if (shared) return `https://${shared}`;
  const domain = platform.pagesDomain(url);
  return domain == "localhost" ? `${url.protocol}//${id}-${owner.toLowerCase()}.localhost${url.port ? `:${url.port}` : ""}` : `https://${id}-${owner.toLowerCase()}.${domain}`;
}

/** The document a pages origin is for, if the request came to one. */
export function pagesHost(url: URL, platform: Platform): { owner: string; id: string } | null {
  // On a shared host the document is the one its token names (pagesDoor checks the token itself).
  const shared = platform.pagesShared?.(url);
  if (shared && url.hostname == shared) {
    const claims = /^\/t\/([^/.]+)\./.exec(url.pathname)?.[1];
    try {
      const d = claims && (JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(claims.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)))) as { d?: unknown }).d;
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
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(value))));
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A token that opens one document's files on its pages origin, for a week, for the editor at `shell` (whose origin it names).
 * Its expiry is rounded up to the next whole day, so the token, and with it the address of every file of the page, stays the
 * same all day: the browser's cache can answer for them (they're checked by ETag, pagesDoor and document/host.ts's docFile).
 */
export async function pagesToken(secret: string, owner: string, id: string, shell: string, now = Date.now(), opts: { published?: boolean; by?: string } = {}): Promise<string> {
  // published: for someone who may only view it, whose every file is the published version's, doc/ as pub/.
  // by: whom it was made for, only on a server for admins alone (staging, Platform.adminsOnly): its pages origin lets the
  // token in only while they're still an admin. Elsewhere a token names nobody (a page's own
  // scripts can read its address).
  const claims = b64url(new TextEncoder().encode(JSON.stringify({ d: `${owner.toLowerCase()}/${id}`, e: Math.ceil((now / 1000 + WEEK) / DAY) * DAY, s: shell, ...(opts.published ? { p: 1 } : {}), ...(opts.by ? { a: opts.by.toLowerCase() } : {}) })));
  return `${claims}.${await hmac(secret, claims)}`;
}

/** The editor's origin, if `token` is good for this document and current. */
export async function readPagesToken(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<string | null> {
  return (await readPagesClaims(secret, token, owner, id, now))?.shell ?? null;
}

/** What a good, current token for this document says: the editor's origin, whether it opens only the published version, and whom it was made for (if it says). */
export async function readPagesClaims(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<{ shell: string; published: boolean; by?: string } | null> {
  const [claims, mac, extra] = token.split(".");
  if (!claims || !mac || extra != null || !sameText(mac, await hmac(secret, claims))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(claims.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)))) as { d?: string; e?: number; s?: string; p?: number; a?: unknown };
    if (c.d != `${owner.toLowerCase()}/${id}` || !(Number(c.e) > now / 1000) || typeof c.s != "string") return null;
    return new URL(c.s).origin == c.s ? { shell: c.s, published: c.p == 1, ...(typeof c.a == "string" ? { by: c.a } : {}) } : null;
  } catch { return null; }
}

/**
 * A request to a document's pages origin: /t/<token>/ is the page editor's
 * frame, which only the editor on this site may embed, and /t/<token>/doc/...
 * are the document's files.
 */
export async function pagesDoor(request: Request, url: URL, doc: { owner: string; id: string }, platform: Platform): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  let [, token, rest] = /^\/t\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
  if (!token || (request.method != "GET" && request.method != "HEAD")) return notFound();
  const claims = await readPagesClaims(platform.secret, token, doc.owner, doc.id);
  const shell = claims?.shell;
  if (!claims || !shell) return new Response("This link has expired: reload the editor.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (rest == "/") {
    // ?view=<file>: the page to show straight away, as it renders (the viewer's, and the editor's until it has its own).
    // ?view= (empty): the document's page, whatever its name (its host answers doc/ with it).
    const view = url.searchParams.get("view");
    const files = `/t/${token}/doc/`;
    // The page as it renders is what viewers see (pub/: the published version, or the files as they are now; document/versions.ts).
    const shown = `/t/${token}/${VIEW_FILES}/`;
    const src = view == "" ? shown : view && !/^\/|(^|\/)\.\.(\/|$)/.test(view) ? `${shown}${view.split("/").map(encodeURIComponent).join("/")}` : "";
    // Its base is the document's folder: the editable page (frame.js renders it as srcdoc, which takes this page's base) then
    // resolves the document's files there from the start, even in Chrome's preload scanner, which otherwise asks for them here too.
    const html = `<!doctype html><html><head><meta charset="utf-8"><base href="${esc(files)}"><meta name="erga-shell" content="${esc(shell)}"><title>Erga page</title>
<style>${HOST_STYLE}</style>
</head><body>${src ? `<iframe id="view" class="on" src="${esc(src)}" title="Document" sandbox="${PAGE_SANDBOX}"></iframe>` : ""}<script>${HOST_SCRIPT}</script></body></html>`;
    // Everything in it comes from its address (the token names the shell) and this code: with this code's version in the
    // address (?v=, as the document's page links it), the browser may keep it for the day the token stays the same; without,
    // it's checked with the server each time (answered 304 when unchanged).
    const etag = `"${b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))).slice(0, 22)}"`;
    const cache = url.searchParams.get("v") == HOST_VERSION ? `private, max-age=${DAY}` : "no-cache";
    const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache, ETag: etag, "Content-Security-Policy": `frame-ancestors ${shell}`, "Referrer-Policy": "no-referrer" };
    if (request.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") == etag)) return new Response(null, { status: 304, headers });
    return new Response(html, { headers });
  }
  if (!rest.startsWith("/doc/") && !rest.startsWith("/pub/")) return notFound();
  // Someone who may only view the document gets the published version's files, whichever they ask for.
  if (claims.published && rest.startsWith("/doc/")) rest = "/pub/" + rest.slice("/doc/".length);
  // The token names the document; the directory confirms it's still its owner's (remembered, so usually without asking the
  // database). Both at once: a file is only read, so asking the document before the answer comes costs nothing if it's no.
  const asked = { id: doc.id, owner: doc.owner.toLowerCase(), test: false };
  const [route, answer] = await Promise.all([
    platform.directory.route(doc.id),
    platform.docs.fetch(asked, forwarded(request, url, rest, `${shell}/d/${doc.id}`, null, null)),
  ]);
  if (!route || route.owner != asked.owner) { await answer.body?.cancel(); return notFound(); }
  return answer;
}
