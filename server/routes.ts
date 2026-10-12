// The front door: the app around the documents (cloudflare/index.ts serves it,
// on erga.dev and in local development alike). It's written against web
// Requests and Responses, and the Worker supplies the rest (`Platform`):
// who's signed in, the templates, the directory of documents (server/directory.ts,
// in D1) and the documents themselves (Durable Objects).
//
//   /                          the front page: the viewer on the landing document (a setting), for anyone
//   /new                       a blank document for you, in the editor (signs you in first); /new?template=<id> one from
//                              a template; /new?from=landing a copy
//                              of the front page's, /new?from=<id> of another you may open (the viewer's Clone)
//   /docs                      your documents, latest edit first; POST /docs/delete deletes one,
//                              /docs/share shares one (or stops sharing it), GET /docs/share?id= says with whom
//   /admin                     the server's settings and users, for admins; POST /admin/settings, /admin/users
//   /<owner>/<slug>            the viewer on that document (for those it's shared with): its canonical address;
//                              Clone, and Edit for those who may edit it
//   /<owner>/<slug>#edit       the editor on it, under Documents (its breadcrumbs): the same page, which
//                              goes into the editor for #edit (the server never sees it)
//   /<owner>/<slug>/<page>     another of its pages (document/pages.ts: blog is blog.html, else blog/index.html), #edit
//                              for its editor; never with a slash added at the end
//   /<owner>/<id>, /<owner>/<old slug>, /d/<id> (and pages under them)
//                              redirect there
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets; the
//                              editor uses this address, which never changes. Under any of the
//                              addresses above it works too (older tabs and share links use them).
//
// Who may open, edit, rename, delete or share a document is the directory's
// to say (`Directory.may`, from the document's permissions); the front door
// asks it for every request, and tells the document's host whether the
// person may edit or only view (x-erga-access).
//
// The server's API for agents (/llms.txt, /api/..., /mcp) and /tokens are
// server/api.ts's.
//
// Anywhere, "Authorization: Bearer erga_..." (an agent token, server/identity)
// signs in as the person it stands for, as their agent (Session.agent), with
// that person's permissions.
//
// Signing in, the editor's own files and the WebSockets stay with the
// Worker.

import type { SiteOps } from "./site-publish.ts";
import { avatarsOf, OWN_ACCOUNT } from "./account-menu.ts";
import { adminDoor } from "./admin/pages.ts";
import { VIA } from "../shared/attribution.ts";
import { type Directory, type DocRow, type Grant, type Permission, type Role, type Route, type Who, ID, newDocId, NotAllowed, OWNER, roleMay, TEST_ID, UNTITLED } from "./directory.ts";
import { accessOf, whoOf, type Listed, type Platform, type Session } from "./platform.ts";

import type { PublishRequest, PublishResult, RestoreResult, Version, VersionsState } from "../document/versions.ts";
import { pageAddress, resolvePage, titleOf } from "../document/pages.ts";
import { FAVICON_LINK, WORDMARK } from "../assets/logo/logo.ts";
import { NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu, templateById, TEMPLATES, type Template } from "./templates.ts";

/** The front door's answer to a request, for any path (a page saying so when there's nothing there). */
export async function frontDoor(request: Request, base: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const pages = pagesHost(url, base);
  if (pages) return pagesDoor(request, url, pages, base);
  const platform = base;
  if (path == "/") return viewLanding(platform, request, await platform.sessionOf(request));
  if (path == "/new") return newDoc(platform, request);
  if (path == "/docs") return listDocs(platform, request);
  if (path == "/docs/delete" && request.method == "POST") return deleteDoc(platform, request);
  if (path == "/docs/share") return shareDoc(platform, request);
  if (path == "/admin" || path == "/admin/changes" || path == "/admin/settings" || path == "/admin/users" || path == "/admin/api-keys" || path == "/admin/credentials" || path == "/admin/share" || path == "/admin/auth" || path == "/admin/auth/status") return adminDoor(platform, request);

  const [, first, second, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
  const nothing = () => page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);
  if (!first || (first != "d" && !OWNER.test(first))) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const session = await platform.sessionOf(request);

  // A document's address is the document: /<owner>/<slug>, and /<page> after it for its other pages. Its editor
  // is the same page with #edit, which never reaches the server. Sign in first, then the page, at its canonical address.
  // /api/... and /doc/... under it are the document's host (so no page or folder at its top may be called api or doc).
  if (!/^\/(api|doc)(\/|$)/.test(rest ?? "")) {
    if (!session) return signInFirst(path + url.search);
    // The document and what they may do with it, in one round trip to the database, and none to the document itself: its frame
    // asks for its page, which is all the document needs to say, so the page answers as soon as it can.
    const found = first == "d" && !ID.test(second) ? null : await platform.directory.openAs(whoOf(session), first, second);
    if (!found) return nothing();
    const { doc, role } = found;
    if (!role) return refused(session);
    // Another of its pages: which file (the document itself is asked, only then).
    const wanted = (rest ?? "").replace(/^\/+|\/+$/g, "");
    let file: string | null = null, at = "";
    if (wanted) {
      const [paths, index] = await Promise.all([platform.docs.paths(doc), platform.docs.index(doc)]);
      if (index == null) return nothing();
      const files = new Set(paths);
      const page = resolvePage((p) => files.has(p), wanted, index);
      if (!page) return noPage(`/${doc.owner}/${doc.slug}`);
      file = page.file;
      at = page.canonical ? `/${page.canonical.split("/").map(encodeURIComponent).join("/")}` : "";
    }
    const canonical = `/${doc.owner}/${doc.slug}${at}`;
    if (!samePath(path, canonical) && !samePath(path, `${canonical}/`)) return new Response(null, { status: 302, headers: { Location: canonical + url.search } });
    return viewDocument(platform, request, { doc, index: file, role }, session, false);
  }
  const route = await documentRoute(platform, first, second);
  if (!route) return new Response("No such document", { status: 404 });
  // An external agent brings its token (Session.agent); everyone else signs in.
  if (!session) {
    return rest.startsWith("/api/ext")
      ? Response.json({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". If it stopped working it was revoked: ask for a new one." }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="erga"' } })
      : new Response("Sign in first", { status: 401 });
  }
  const access = await platform.directory.access(whoOf(session), route);
  if (!access) return new Response("Not allowed", { status: 403 });
  // The share button's token is the front door's, not the document's.
  if (rest == "/api/share" && request.method == "POST") return shareToken(platform, request, session);
  // The document's sockets (its room, its events) are opened by this site's own pages: a page of another origin, even
  // of this site (another subdomain, which the session cookie reaches), may not open one as whoever's signed in.
  const origin = request.headers.get("origin");
  if (request.headers.get("upgrade")?.toLowerCase() == "websocket" && origin && origin != url.origin) return new Response("Not from this site", { status: 403 });
  const answer = await platform.docs.fetch(route, forwarded(request, url, rest, `${url.origin}/d/${route.id}`, session, accessOf(access)));
  // A document's own files are its own: nothing of the site's goes into them.
  if (!/^text\/html\b/i.test(answer.headers.get("content-type") ?? "") || answer.status == 101) return answer;
  const headers = new Headers(answer.headers);
  headers.set(OWN_ACCOUNT, "1");
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

/** Whether two paths are the same address, however each is percent-encoded. */
const samePath = (a: string, b: string) => {
  try { return decodeURIComponent(a) == decodeURIComponent(b); } catch { return a == b; }
};

/** A document that's there, at a page that isn't. */
const noPage = (address: string) => page("Not found", `This document has no page here. <a href="${esc(address)}">Go to its first page</a>.`, 404);

/**
 * Who may use /deploy: the deploy_page setting (off, admins and those with
 * the deploy role, or users), and never a test person or an agent's token. It's a permission of its own: it
 * gives nothing of an admin's (settings, users, the factory).
 */
export async function mayDeploy(directory: Directory, session: Session | null): Promise<boolean> {
  if (!session || session.test || session.agent) return false;
  const mode = await directory.config.get("deploy_page");
  if (mode == "users") return true;
  return mode == "admins" && (await directory.users.hasDeploy(whoOf(session)));
}

/** What the editor's menu on your avatar needs to know that the document doesn't: the links it offers. */
async function accountMeta(platform: Platform, session: Session): Promise<string> {
  const admin = !session.test && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  const deploy = await mayDeploy(platform.directory, session);
  const links = { docs: link("/docs", session), settings: link("/settings", session), ...(deploy ? { deploy: link("/deploy", session) } : {}), ...(admin ? { admin: link("/admin", session) } : {}), signOut: "/auth/logout" };
  return `<meta name="erga-account" content="${esc(JSON.stringify(links))}">`;
}

const refused = (session: Session) => session.test
  ? page("Test documents only", "Test people can open only test documents.", 403)
  : page("Not shared with you", `This document hasn't been shared with <b>${esc(session.login)}</b>. Ask its owner to share it with you.`, 403);

/**
 * How to reach the document at /<first>/<second>, for the requests under
 * it. By id it's remembered (an id is never another of the owner's slugs,
 * server/directory.ts), so a document's many subrequests rarely ask the database.
 */
export async function documentRoute(platform: Pick<Platform, "directory">, first: string, second: string): Promise<Route | null> {
  if (first == "d") return ID.test(second) ? platform.directory.route(second) : null;
  if (!OWNER.test(first)) return null;
  const owner = first.toLowerCase();
  if (ID.test(second)) {
    const byId = await platform.directory.route(second);
    if (byId?.owner == owner) return byId;
  }
  const found = await platform.directory.locate(owner, second);
  return found && { id: found.doc.id, owner: found.doc.owner, test: found.doc.test };
}

// ---------------------------------------------------------------- pages

// A document's page runs on an origin of its own, <id>-<owner>.erga-pages.dev
// (or <id>-<owner>.localhost:<port> on this machine), never this site's: its
// scripts, whoever wrote them, can't act as the person viewing it (see
// client/bridge.ts). That origin has no cookies. It serves the page
// editor's frame and the document's files under a token, signed here, that
// opens this one document for a week; the editor's address on this site hands
// it out to whoever may open the document.

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
 * same all day: the browser's cache can answer for them (they're checked by ETag, server/routes.ts's pagesDoor and document/host.ts's docFile).
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
async function pagesDoor(request: Request, url: URL, doc: { owner: string; id: string }, platform: Platform): Promise<Response> {
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

const HOST_STYLE = "html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;background:transparent}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent;visibility:hidden}iframe.on{visibility:visible}html.wait iframe,html.placing iframe{visibility:hidden}";

/** The frame's host page's version: a digest of its code (FNV-1a), which changes whenever that does. */
const versionOf = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

/** What a document's page may do in its frame, in the viewer and the editor alike (frame.ts makes the editor's the same). */
const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

/** Where the frame's host page shows the page as it renders from: what viewers see, which the document serves at pub/. */
const VIEW_FILES = "pub";
/**
 * The frame's host page, on the document's own origin: it shows the page as
 * it renders (#view) until the document's page asks for the editor
 * ("erga-edit"). Then it loads the editor's half, which renders
 * the editable page in a frame of its own (#page) and calls ergaHost.ready;
 * the editable page takes the plain one's place, scrolled to the same spot.
 * Back to viewing ("erga-view"), the plain page loads afresh behind it and
 * takes its place again the same way, the editor carrying on unseen.
 */
const HOST_SCRIPT = `(function () {
  var SHELL = document.querySelector('meta[name="erga-shell"]').content, want = "view", loading = false;
  var view = document.getElementById("view"), src = view ? view.getAttribute("src") : "";
  var page = function () { return document.getElementById("page"); };
  // The page stops dead at its top and bottom, without the bounce that would show what's behind it (and pass on to the controls).
  function still(f) {
    try { var d = f.contentDocument, s = d.createElement("style"); s.textContent = "html { overscroll-behavior: none; }"; (d.head || d.documentElement).append(s); } catch (e) {}
  }
  // The page went to another of the document's pages (a link followed): the shell's address follows, and so
  // does the page shown again on the way back from editing.
  var DOC = location.pathname.replace(/\\/?$/, "/") + "${VIEW_FILES}/";
  function moved(f) {
    try {
      var p = f.contentWindow.location.pathname;
      if (p.indexOf(DOC) != 0) return;
      // pub/ itself is the document's own page ("").
      var path = decodeURIComponent(p.slice(DOC.length));
      if (path && !/\\.(html|md)$/i.test(path)) return;
      src = p;
      parent.postMessage({ type: "erga-nav", path: path }, SHELL);
    } catch (e) {}
  }
  // The shell's controls fade once the page is scrolled (FADE): it hears where the page shown is scrolled to, and where the
  // pointer is over it (in this page's coordinates; the shell places them), at most once a frame.
  // (Exactly too, sx and sy, for the canvas the shell paints around the frame: see canvasOf.)
  var scrolled = null, pointer = null;
  // The scale the editor draws the page at (client/zoom.ts: the page zoomed, not the controls): its points, in this page's terms.
  function scale(f) { var w = f.offsetWidth; return w ? f.getBoundingClientRect().width / w || 1 : 1; }
  function report(f) {
    try {
      if (!f.classList.contains("on")) return;
      var w = f.contentWindow, y = Math.max(0, Math.round(w.scrollY)), at = w.scrollX + "," + w.scrollY;
      if (at !== scrolled) { scrolled = at; parent.postMessage({ type: "erga-scroll", y: y, sx: w.scrollX, sy: w.scrollY }, SHELL); }
    } catch (e) {}
  }
  function follow(f) {
    try {
      var d = f.contentDocument, w = f.contentWindow;
      if (!d || d.ergaFollowed) return;
      d.ergaFollowed = true;
      w.addEventListener("scroll", function () { report(f); }, { passive: true });
      d.addEventListener("pointermove", function (e) {
        if (e.pointerType != "mouse" || !f.classList.contains("on")) return;
        if (!pointer) requestAnimationFrame(function () { parent.postMessage({ type: "erga-pointer", x: pointer.x, y: pointer.y }, SHELL); pointer = null; });
        var k = scale(f);
        pointer = { x: e.clientX * k, y: e.clientY * k };
      }, { capture: true, passive: true });
      d.addEventListener("pointerdown", function (e) {
        if (e.pointerType != "mouse" && f.classList.contains("on")) parent.postMessage({ type: "erga-pointer", x: e.clientX * scale(f), y: e.clientY * scale(f), tap: true }, SHELL);
      }, { capture: true, passive: true });
      report(f);
    } catch (e) {}
  }
  if (view) view.addEventListener("load", function () { view.ergaLoaded = true; still(view); moved(view); follow(view); });
  // Reloaded in the editor (&y=, FRAME_SRC): the page shown opens where it was scrolled to, out of sight until it's there
  // (its content may still be coming), or as far as it goes once it has loaded (a shorter page now), or after a moment.
  var startY = Number((/[?&]y=(\\d+)/.exec(location.search) || [])[1]) || 0;
  function placed() { startY = 0; document.documentElement.classList.remove("placing"); }
  function place(f) {
    try {
      var w = f.contentWindow, d = f.contentDocument;
      if (!d || !d.documentElement || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return;
      w.scrollTo(0, startY);
      if (Math.abs(w.scrollY - startY) < 2 || (f.ergaLoaded && w.scrollY + w.innerHeight >= d.documentElement.scrollHeight - 2)) placed();
    } catch (e) { placed(); }
  }
  if (startY) { document.documentElement.classList.add("placing"); setTimeout(placed, 1500); }
  // The band above the page (the document's page, viewDocument) takes the page's background: this tells the shell what it is,
  // on every frame it changes (a page of a multi-page document, a theme switch), as a solid colour (a gradient's first one).
  // The first time this page sees the document (nothing remembered here), the page waits out of sight until the shell has
  // painted that colour, so a dark page never shows under a white band; later, the shell remembers it too, so it shows at once.
  var band = null, known = null;
  try { known = localStorage.getItem("erga:band"); } catch (e) {}
  function reveal() { document.documentElement.classList.remove("wait"); }
  if (known == null) { document.documentElement.classList.add("wait"); setTimeout(reveal, 500); }
  // (Its own colour; else, for one that's only a gradient, the gradient's colour at the top.)
  function solid(cs) {
    var c = cs.backgroundColor;
    if (!clear(c)) return c;
    var img = cs.backgroundImage, stops = img && img != "none" && /gradient/.test(img) ? img.match(/rgba?\\([^)]*\\)/g) : null;
    if (stops) return /^linear-gradient\\((to top|0deg|360deg)[,)]/.test(img) ? stops[stops.length - 1] : stops[0];
    return "";
  }
  function colourOf(f) {
    var d = f.contentDocument, w = f.contentWindow;
    if (!d || !w || !d.documentElement || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return null;
    var c = solid(w.getComputedStyle(d.documentElement));
    if (!c && d.body) c = solid(w.getComputedStyle(d.body));
    return c;
  }
  // The page's canvas, so the shell paints the room around the frame (the band above it, the room beside it that the agent
  // opens) as the page would if it reached there (BAND_BOOT, paintCanvas): the background the browser gives the canvas (the
  // root's, or the body's when the root has none), its layers sized and placed against the root's box as the browser does,
  // in the page's own coordinates (the shell follows its scroll: erga-scroll). Gradients and images only: an image goes as
  // its file, once fetched here (the shell mustn't fetch the page's addresses as you); one that can't be is left out.
  // "tile": a layer repeats in tiles smaller than the page (a pattern), which carry on around it; else the page's edges do.
  var canvasSaid = "", pictures = {};
  function clear(c) { return /^(transparent|rgba\\([^)]*,\\s*0\\))$/.test(c); }
  function layers(v) {
    var out = [], depth = 0, quote = "", from = 0;
    for (var i = 0; i < v.length; i++) {
      var ch = v[i];
      if (quote) { if (ch == "\\\\") i++; else if (ch == quote) quote = ""; }
      else if (ch == '"' || ch == "'") quote = ch;
      else if (ch == "(") depth++;
      else if (ch == ")") depth--;
      else if (ch == "," && !depth) { out.push(v.slice(from, i).trim()); from = i + 1; }
    }
    out.push(v.slice(from).trim());
    return out;
  }
  /** An image's file: undefined while it's being fetched, null if it can't be. */
  function picture(u) {
    if (u in pictures) return pictures[u];
    pictures[u] = undefined;
    fetch(u).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      pictures[u] = b && /^image\\//.test(b.type) && b.size < 4e6 ? b : null;
    }, function () { pictures[u] = null; });
    return undefined;
  }
  function canvasOf(f) {
    var d = f.contentDocument, w = f.contentWindow, root = d && d.documentElement;
    if (!root || !w || d.URL == "about:blank" || (!d.body && d.readyState == "loading")) return null;
    var cs = w.getComputedStyle(root);
    if (cs.backgroundImage == "none" && clear(cs.backgroundColor) && d.body) cs = w.getComputedStyle(d.body);
    var c = { color: clear(cs.backgroundColor) ? "" : cs.backgroundColor, image: "", files: [], urls: [] };
    if (cs.backgroundImage == "none") return c;
    var images = layers(cs.backgroundImage), sizes = layers(cs.backgroundSize), repeats = layers(cs.backgroundRepeat), tile = false;
    for (var i = 0; i < images.length; i++) {
      var m = /^url\\("((?:[^"\\\\]|\\\\.)*)"\\)$/.exec(images[i]);
      if (m) {
        var file = picture(m[1]);
        if (file === undefined) return null;
        if (!file) { images[i] = "none"; continue; }
        images[i] = 'url("erga-file:' + c.files.length + '")';
        c.files.push(file); c.urls.push(m[1]);
      } else if (!/^(repeating-)?(linear|radial|conic)-gradient\\(/.test(images[i])) { images[i] = "none"; continue; }
      var size = sizes[i % sizes.length], whole = /^(cover|contain|100%( 100%| auto)?|auto( 100%| auto)?)$/.test(size) && !(m && /^auto( auto)?$/.test(size));
      if ((!whole || /^repeating-/.test(images[i])) && repeats[i % repeats.length] != "no-repeat") tile = true;
    }
    if (images.every(function (v) { return v == "none"; })) return c;
    // (In the page's own terms, the frame's box too; the shell draws them at the page's scale, c.zoom.)
    var b = f.getBoundingClientRect(), k = scale(f), fr = { left: b.left / k, top: b.top / k, width: b.width / k, height: b.height / k };
    var r = root.getBoundingClientRect(), fixed = /fixed/.test(cs.backgroundAttachment);
    c.image = images.join(", "); c.size = cs.backgroundSize; c.position = cs.backgroundPosition; c.repeat = cs.backgroundRepeat;
    c.tile = tile; c.fixed = fixed; c.zoom = k;
    c.x = fixed ? fr.left : fr.left + r.left + w.scrollX; c.y = fixed ? fr.top : fr.top + r.top + w.scrollY;
    c.w = fixed ? fr.width : r.width; c.h = fixed ? fr.height : r.height;
    return c;
  }
  // A new page in a colour of its own (a link to another of the document's pages) waits out of sight in the same way, so
  // it never shows under the last page's band; a page that changes its own colour (a theme switch) stays in sight.
  var shown = null;
  (function watch() {
    try {
      var f = document.querySelector("iframe.on"), c = f ? colourOf(f) : null;
      if (f && startY) place(f);
      // The fade's too (above), from as soon as the page shown has a document (well before its load event, on a page with
      // large images), and again after it goes to another of the document's pages.
      if (f) follow(f);
      // (The canvas first: the shell has painted both once it answers the colour, erga-band-ok.)
      var cv = f && c != null ? canvasOf(f) : null;
      if (cv) {
        var key = JSON.stringify(cv);
        delete cv.urls;
        if (key != canvasSaid) { canvasSaid = key; parent.postMessage({ type: "erga-canvas", canvas: cv }, SHELL); }
      }
      if (c != null && c !== band) {
        if (band != null && shown && f.contentDocument != shown) { document.documentElement.classList.add("wait"); setTimeout(reveal, 300); }
        band = c;
        try { localStorage.setItem("erga:band", c); } catch (e) {}
        parent.postMessage({ type: "erga-band", color: c }, SHELL);
      }
      if (c != null) shown = f.contentDocument;
      // The steps, a few times a second besides when the page says (ergastep), for a page that forgets to.
      var now = Date.now();
      if (stepping && now - stepping.polled > 300) { stepping.polled = now; tellSteps(); }
    } catch (e) {}
    requestAnimationFrame(watch);
  })();
  function show(to) {
    var from = document.querySelector("iframe.on");
    if (from == to) return;
    try { if (from) to.contentWindow.scrollTo(from.contentWindow.scrollX, from.contentWindow.scrollY); } catch (e) {}
    to.classList.add("on");
    report(to);
    tellSteps();
    if (!from) return;
    from.classList.remove("on");
    if (from.id == "view") from.remove();
  }
  window.ergaHost = { ready: function () { if (want == "edit") show(page()); } };
  // A presentation (editor-agent/PROMPT.md, "Presentations"): the page shown says it has steps (window.ergaSteps). This tells
  // the shell how many, their labels and the current one (STEPS_BOOT shows them) whenever that changes, goes to a step or
  // draws one when the shell asks, and steps with the arrow keys pressed in the page. "rev" changes whenever a step's
  // picture may have changed: another page shown, the document edited (ergaHost.changed, frame.ts), different steps.
  var STEP_MAX = 1000, stepping = { doc: null, said: "null", shape: "", rev: 0, polled: 0 };
  function presentation() {
    var f = document.querySelector("iframe.on");
    try {
      var w = f && f.contentWindow, p = w && w.ergaSteps;
      return p && typeof p.count == "function" && typeof p.go == "function" && typeof p.current == "function" ? { w: w, d: w.document, p: p } : null;
    } catch (e) { return null; }
  }
  function whole(n, max) { n = Math.floor(Number(n)); return isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; }
  function stepsKey(e) {
    var t = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key != "ArrowLeft" && e.key != "ArrowRight")) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    // Once the page's own handlers have had it: a page that takes the key itself (preventDefault) keeps it.
    setTimeout(function () { if (!e.defaultPrevented) step({ by: e.key == "ArrowLeft" ? -1 : 1 }); });
  }
  function tellSteps() {
    var s = presentation(), m = null;
    // A page loaded afresh (another page, or the editor's render) is another window behind the same frame: listened to anew.
    if (s && s.d !== stepping.doc) {
      stepping.doc = s.d; stepping.rev++;
      s.w.addEventListener("ergastep", function () { tellSteps(); });
      s.w.addEventListener("keydown", stepsKey);
    }
    if (s) try {
      var count = whole(s.p.count(), STEP_MAX), labels = [];
      for (var i = 0; i < count; i++) {
        var l = typeof s.p.label == "function" ? s.p.label(i) : "";
        labels.push(typeof l == "string" ? l.replace(/\\s+/g, " ").trim().slice(0, 200) : "");
      }
      m = { count: count, current: whole(s.p.current(), Math.max(0, count - 1)), labels: labels, images: typeof s.p.image == "function" };
    } catch (e) { m = null; }
    var shape = m ? m.count + "\\n" + m.labels.join("\\n") : "";
    if (shape != stepping.shape) { stepping.shape = shape; stepping.rev++; }
    if (m) m.rev = stepping.rev;
    var said = JSON.stringify(m);
    if (said != stepping.said) { stepping.said = said; parent.postMessage({ type: "erga-steps", steps: m }, SHELL); }
  }
  function step(to) {
    var s = presentation();
    if (!s) return;
    try {
      var count = whole(s.p.count(), STEP_MAX), at = whole(s.p.current(), STEP_MAX);
      var n = to.by ? at + (to.by > 0 ? 1 : -1) : whole(to.to, STEP_MAX);
      if (n >= 0 && n < count && n != at) {
        if (to.by > 0 && typeof s.p.next == "function") s.p.next();
        else if (to.by < 0 && typeof s.p.back == "function") s.p.back();
        else s.p.go(n);
      }
    } catch (e) {}
    tellSteps();
  }
  // A step's picture, as a Blob (the shell makes its own address for it): the page answers a canvas, a Blob or an image's address.
  function stepImage(m) {
    var s = presentation(), rev = stepping.rev, n = whole(m.step, STEP_MAX);
    if (!s || typeof s.p.image != "function" || m.rev !== rev) return;
    var answer = function (blob) {
      var ok = blob && typeof blob.type == "string" && /^image\\//.test(blob.type) && blob.size < 4e6;
      parent.postMessage({ type: "erga-step-image", step: n, rev: rev, blob: ok ? blob : null }, SHELL);
    };
    var size = { width: whole(m.width, 1600) || 320, height: whole(m.height, 1600) || 180 };
    Promise.resolve().then(function () { return s.p.image(n, size); }).then(function (r) {
      if (!r) return null;
      if (typeof r == "string") return fetch(r).then(function (res) { return res.blob(); });
      if (typeof r.toBlob == "function") return new Promise(function (done) { r.toBlob(done, "image/png"); });
      if (typeof r.arrayBuffer == "function") return r;
      return null;
    }).then(answer, function () { answer(null); });
  }
  window.ergaHost.changed = function () { stepping.rev++; stepping.said = ""; tellSteps(); };
  addEventListener("message", function (e) {
    if (e.source != parent || e.origin != SHELL || !e.data) return;
    var type = e.data.type;
    if (type == "erga-band-ok") reveal();
    else if (type == "erga-edit") {
      want = "edit";
      if (!loading) { loading = true; var s = document.createElement("script"); s.src = "/frame.js"; document.body.append(s); }
      else if (page() && page().dataset.ready) show(page());
    } else if (type == "erga-view" && src) {
      want = "view";
      if (!page()) return;
      var old = document.getElementById("view");
      if (old) old.remove();
      var v = document.createElement("iframe");
      v.id = "view"; v.title = "Document"; v.setAttribute("sandbox", "${PAGE_SANDBOX}");
      v.onload = function () { still(v); moved(v); follow(v); if (want == "view") show(v); };
      v.src = src;
      document.body.prepend(v);
    } else if (type == "erga-step") step(e.data);
    else if (type == "erga-step-image") stepImage(e.data);
    else if (type == "erga-prefetch") {
      var l = document.createElement("link"); l.rel = "prefetch"; l.href = "/frame.js"; document.head.append(l);
    }
  });
  // Opened in the editor (?edit=1): its half starts loading now, without waiting to be asked.
  if (/[?&]edit=1(&|$)/.test(location.search)) { want = "edit"; loading = true; var s = document.createElement("script"); s.src = "/frame.js"; document.body.append(s); }
  parent.postMessage({ type: "erga-host" }, SHELL);
})();`;
const HOST_VERSION = versionOf(HOST_STYLE + PAGE_SANDBOX + HOST_SCRIPT + VIEW_FILES);

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
export const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** The front page: the viewer on the landing document (the landing_document setting), for anyone, signed in or not. Made from the repo's assets/landing/ if there's none (seedLanding). */
async function viewLanding(platform: Platform, request: Request, session: Session | null): Promise<Response> {
  const roleOf = (doc: DocRow) => (session ? platform.directory.access(whoOf(session), doc) : Promise.resolve(null));
  // The usual case, the setting's document there: whether it is (its host's page) and what they may do with it, at once.
  const named = await platform.directory.landing();
  if (named) {
    const [index, role] = await Promise.all([platform.docs.index(named), roleOf(named)]);
    if (index != null) return viewDocument(platform, request, { doc: named, index, role }, session, true);
  }
  const landing = await landingPage(platform);
  if (!landing) return startPage(platform, session);
  return viewDocument(platform, request, { ...landing, role: await roleOf(landing.doc) }, session, true);
}

/**
 * The front page's document: the one landing_document names, else (unset,
 * or naming a document that's gone) a new one made from the repo's assets/landing/
 * (seedLanding). Null only when the deploy locks the setting to a document
 * that isn't there, or there's nobody to own one.
 */
export async function landingDocument(platform: Platform): Promise<DocRow | null> {
  return (await landingPage(platform))?.doc ?? null;
}

/** The front page's document (landingDocument) and its page: the one round trip to its host tells both that it's there and which file to show. */
async function landingPage(platform: Platform): Promise<{ doc: DocRow; index: string } | null> {
  const doc = await platform.directory.landing();
  const index = doc && (await platform.docs.index(doc));
  if (doc && index != null) return { doc, index };
  const made = await seedLanding(platform);
  const madeIndex = made && (await platform.docs.index(made));
  return made && madeIndex != null ? { doc: made, index: madeIndex } : null;
}

/** Seeds under way, by directory (one per database), so a burst of first requests in one isolate makes one document. */
const seeding = new WeakMap<object, Promise<DocRow | null>>();

/**
 * Makes the front page from the repo's assets/landing/ (built into the Worker) the
 * first time anyone asks for it, and again when the one it named was deleted
 * or an admin reset the setting: a document of the landing owner's at
 * /<owner>/landing, which the other bootstrap admins may edit too, and sets
 * landing_document to it. No deploy step does this; the server does.
 * Requests at once in one isolate share one seed; across isolates the setting
 * is claimed compare-and-set (ServerConfig.claim), and a seed that loses
 * deletes its document and takes the winner's. Each seed makes its document
 * at its id (/<owner>/<id>), and only the winner moves to /<owner>/landing,
 * once it has won: so a loser never holds "landing" while the winner looks
 * for a free slug, which gave the winner "landing-2". A setting an admin
 * chose (a document that's there) is never touched, nor one the deploy locks.
 */
export function seedLanding(platform: Platform): Promise<DocRow | null> {
  const key = platform.directory;
  const running = seeding.get(key);
  if (running) return running;
  const run = (async () => {
    const config = platform.directory.config;
    const project = platform.landing;
    if (config.isLocked("landing_document") || !project?.owner) return null;
    const index = project.files["index.html"] != null ? "index.html" : project.files["index.md"] != null ? "index.md" : null;
    if (!index) return null;
    // Read afresh (settings are remembered a few seconds): another isolate may have seeded it just now.
    const live = async (stored: string | null) => {
      let ref: unknown = null;
      try { ref = stored == null ? null : JSON.parse(stored); } catch { /* not JSON: dangling */ }
      const doc = typeof ref == "string" && ref ? await platform.directory.find(ref) : null;
      return doc && !doc.test && (await platform.docs.exists(doc)) ? doc : null;
    };
    // The winner's document, still at its id, takes its address: landing-2 only if another of the owner's really is at landing.
    // A loser does it too, so the document it answers with has its address already.
    const settle = async (doc: DocRow | null) => (doc && doc.slug == doc.id ? ((await platform.directory.reslug(doc.id, "landing")) ?? doc) : doc);
    const stored = await config.stored("landing_document");
    const there = await live(stored);
    if (there) return there;
    const owner = project.owner.toLowerCase();
    let made: DocRow | null = null;
    for (let tries = 0; !made && tries < 5; tries++) { const id = newDocId(); made = await makeDoc(platform, owner, id, { ...project.files }, { index, slug: id, published: true }); }
    if (!made) return null;
    if (!(await config.claim("landing_document", stored, made.id, owner))) {
      // Another seed won: theirs is the front page, and this one goes.
      if (!(await platform.docs.delete(made))) await platform.directory.remove(made.id);
      return settle(await live(await config.stored("landing_document")));
    }
    made = (await settle(made)) ?? made;
    // The deploy's own doing (its ADMINS), not a person's: the server shares as the owner, with admin power
    // (editing the front page needs that: server/directory.ts, homeLimit).
    const server = { login: owner, test: false, admin: true };
    for (const login of project.editors) {
      if (login.toLowerCase() == owner) continue;
      await platform.directory.share(server, made.id, login, "editor").catch(() => {});
    }
    return made;
  })().finally(() => seeding.delete(key));
  seeding.set(key, run);
  return run;
}

/**
 * A document's page, the viewer (/<owner>/<slug>, or one of its other pages)
 * and the editor (the same address with #edit) alike: the document as it renders, on its own pages origin (whoever edits
 * it can't act as the people who view it), in a frame filling the window,
 * with the controls floating over its top corners. The page is the same in
 * both, and small: the document shows at once, and editing is loaded on top
 * of it (EDIT_BOOT) only when someone goes into it, by the pencil or at #edit,
 * without reloading or moving the document. Over the viewer, Clone (a copy of
 * your own) for anyone who may see it, and Edit for those who may edit it.
 * The front page is this, on the landing document.
 */
async function viewDocument(platform: Platform, request: Request, opened: { doc: DocRow; index: string | null; role: Role | null }, session: Session | null, landing: boolean): Promise<Response> {
  const url = new URL(request.url);
  const { doc, index, role } = opened;
  const origin = pagesOrigin(doc.owner, doc.id, url, platform);
  // The frame's host page (pagesDoor), with the token that opens the document's files, showing its page straight away.
  // What they may do, from the role the caller looked up (as Directory.may decides).
  const canEdit = !!session && !session.agent && roleMay(role, "edit");
  // What the editor needs to know, for whoever may go into it: where its document's host and frame are, and the links on its avatar.
  const editable = canEdit;
  const [token, account] = await Promise.all([
    // Someone who may not edit it sees only its published version, in every file the frame asks for.
    // On a server for admins alone (staging), the token names its admin, whom the pages origin checks again.
    pagesToken(platform.secret, doc.owner, doc.id, url.origin, undefined, { published: !canEdit, ...(platform.adminsOnly && session ? { by: session.login } : {}) }),
    editable && session ? accountMeta(platform, session) : "",
  ]);
  const host = `${origin}/t/${token}/`;
  const address = `/${doc.owner}/${doc.slug}`;
  const clone = cloneButton(link(`/new?from=${landing ? "landing" : doc.id}`, session));
  // This page's address (one of the document's other pages, or the document's own).
  const here = index && pageAddress(index) ? `${address}/${pageAddress(index).split("/").map(encodeURIComponent).join("/")}` : address;
  const edit = canEdit ? editButton(`${link(here, session)}#edit`, false) : "";
  // Its owner shares it with people from the editor too (/docs/share).
  const canShare = editable && !!session && !session.agent && !session.test && roleMay(role, "share");
  // The document's address and which of its pages this is, for everyone: the address bar follows the page shown (NAV_SCRIPT).
  const meta = `<meta name="erga-address" content="${esc(address)}">${index ? `<meta name="erga-page" content="${esc(index)}">` : ""}` + (editable && session
    ? `<meta name="erga-pages" content="${esc(host)}"><meta name="erga-base" content="/d/${doc.id}">${canShare ? `<meta name="erga-share" content="${esc(link("/docs/share", session))}">` : ""}${account}`
    : "");
  // Its page by name when it's known (the front page's, or another of its pages), else the folder, which its host answers with its page.
  const src = `${host}?view=${index ? encodeURIComponent(index) : ""}&v=${HOST_VERSION}`;
  // Opened with #edit (which only the browser sees), for whoever may edit: the page is the editor's from its first moment
  // (EDITING_HEAD, EDITING_BODY), the frame starts on its half of the editor at once (&edit=1), and the editor's files are
  // fetched as the page parses, rather than one after another once its script runs (EDIT_BOOT).
  const opening = editable ? `<script>${EDITING_HEAD}</script>` : "";
  const frame = `<iframe id="frame" class="erga-view" ${editable ? "data-src" : "src"}="${esc(src)}" title="${esc(doc.title)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe>`;
  // The band above the document (and, editing, the room the agent opens) takes the page's background: remembered from this
  // document's last visit, before anything has loaded, then as the frame tells it (BAND_BOOT).
  const backdrop = `<script>${BAND_HEAD}ergaBand(${JSON.stringify(doc.id)});</script>`;
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${esc(doc.title)}</title>
${FAVICON_LINK}
<meta name="erga-doc" content="${esc(doc.id)}">
<link rel="preconnect" href="${esc(origin)}">
${meta}${backdrop}${crumbsFont(session)}<style>${BAND_STYLE}</style>${opening}
<body>${editable ? `<script>${EDITING_BODY}</script>` : ""}
<div class="erga-canvas" aria-hidden="true"><div></div></div>${frame}${editable ? `<script>${FRAME_SRC}</script>` : ""}
${viewCrumbs(session, landing ? null : doc.title)}<div class="erga-view-buttons">${newDocButton("erga-view-button")}${clone}${edit}</div>${newDocMenu((path) => link(path, session), !!session && !session.test && !session.agent)}${VIEW_STYLE}${NEW_DOC_STYLE}<script>${NEW_DOC_SCRIPT}ergaNewDoc(document);</script><script>${NAV_SCRIPT}</script><script>${BAND_BOOT}</script><script>${FADE_BOOT}</script>${STEPS_STYLE}<script>${STEPS_BOOT}</script>${editable ? `<script>${EDIT_BOOT}</script>` : ""}
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Link: `<${origin}>; rel=preconnect` } });
}

/** The viewer's Clone button (a copy of your own, at `href`): also the homepage's. */
export const cloneButton = (href: string) => `<a href="${esc(href)}" class="erga-view-button erga-clone-button" aria-label="Clone: make your own copy" data-tip="Clone"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0345) translate(-12 -13.25)" stroke-width="1.5467"><g transform="translate(0 1.25)"><rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2"/><path d="M15.25 8.75V6.5a1.75 1.75 0 0 0-1.75-1.75H6.5A1.75 1.75 0 0 0 4.75 6.5v7c0 .97.78 1.75 1.75 1.75h2.25"/></g></g></svg></a>`;
/** The viewer's pencil (Edit, the editor at `href`), blue while editing: also the homepage's. */
export const editButton = (href: string, editing: boolean) => `<a href="${esc(href)}" class="erga-view-button erga-edit-button" aria-label="Edit" aria-pressed="${editing}" data-tip="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0512) translate(-11.885 -13.365)" stroke-width="1.5221"><g transform="translate(0 1.25)"><path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/></g></g></svg></a>`;

/**
 * For whoever may edit, at the top of a document's page: opened with #edit, it
 * fetches the editor's files at once. (The page's background, remembered
 * from last time, is BAND_HEAD's.)
 *
 * Reloaded in the editor (by hand, or for a new release), the page opens as
 * the editor was, from its first frame, rather than as the viewer until the
 * editor's code has come: its layout (the agent's pane open or not, the
 * document beside it: what the editor kept, main.ts's "shell", restore.ts)
 * and its controls, from the copy of the editor's page this tab keeps
 * (EDIT_BOOT, erga:editor-html), its stylesheets holding the first frame
 * until they're in. The controls wait, inert, for the editor's code
 * (erga-restored; if that never comes, the viewer's controls come back),
 * and the document opens where it was scrolled to (FRAME_SRC). Only for
 * the window's same size, and at the same address.
 */
/** Where a tab keeps its copy of the editor's page (EDIT_BOOT), for a reload in the editor to open with (EDITING_HEAD). */
export const EDITOR_COPY = "erga:editor-html";
/** What a page kept for its reload (client/restore.ts, RESTORE_KEY: the same, which tests/restore-key.test.ts checks). */
export const RESTORE_KEY = "erga:live:restore";
const EDITING_HEAD = `if (location.hash == "#edit") {
  for (const [href, as] of [["/editor.html", "fetch"], ["/page.js", "script"], ["/style.css", "style"], ["/fonts/inter.css", "style"]]) {
    const l = Object.assign(document.createElement("link"), { rel: "preload", href, as });
    if (as == "fetch") l.crossOrigin = "anonymous";
    document.head.append(l);
  }
  try {
    const s = JSON.parse(sessionStorage.getItem("${RESTORE_KEY}") || "null"), me = performance.timeOrigin;
    const shell = s?.keep?.shell, html = sessionStorage.getItem("${EDITOR_COPY}"), root = document.documentElement;
    if (shell && html && s.url == location.pathname + location.search && (s.used == null || s.used == me) && s.at <= me + 1000 && me - s.at < 60000
      && (!s.hand || performance.getEntriesByType("navigation")[0]?.type == "reload") && shell.width == innerWidth && shell.height == innerHeight) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      window.ergaRestored = { html, doc, body: shell.body, parts: shell.parts, editor: s.keep.editor };
      root.dataset.theme = "light";
      root.style.cssText += ";" + shell.style;
      root.classList.add(...shell.html);
      // Written into the page as it parses, in their order, so the first frame waits for them as for its own.
      document.write([...doc.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => { el.dataset.ergaRestored = ""; return el.outerHTML; }).join(""));
    }
  } catch (e) {}
}`;
/** ... and as its body starts: editing, from the first frame; reloaded in the editor, with its controls (EDITING_HEAD). */
const EDITING_BODY = `if (location.hash == "#edit") {
  document.body.classList.add("erga-editing");
  const r = window.ergaRestored;
  if (r) {
    document.body.classList.add(...r.body, "erga-restored", "erga-editor-ready", "no-motion");
    const wrap = Object.assign(document.createElement("div"), { id: "erga-editor", inert: true });
    for (const el of r.doc.body.children) if (el.id != "frame" && el.tagName != "SCRIPT") wrap.append(document.importNode(el, true));
    for (const [id, html] of Object.entries(r.parts || {})) {
      const t = document.createElement("template");
      t.innerHTML = html;
      const was = wrap.querySelector("#" + CSS.escape(id)), now = t.content.firstElementChild;
      if (was && now?.id == id) was.replaceWith(now);
    }
    document.body.append(wrap);
  }
}`;
/**
 * The frame, for whoever may edit: opened with #edit, its host page starts on its half of the editor at once (pagesDoor);
 * reloaded in the editor, scrolled where it was (&y=, HOST_SCRIPT).
 */
const FRAME_SRC = `{
  const f = document.getElementById("frame"), kept = window.ergaRestored?.editor, y = kept?.mode == "text" ? Math.round(kept.scroll) : 0;
  f.src = f.dataset.src + (location.hash == "#edit" ? "&edit=1" + (y > 0 ? "&y=" + y : "") : "");
}`;

/**
 * Which of the document's pages is shown, for everyone on a document's page
 * (viewDocument): the frame says when the page in it goes to another of the
 * document's pages (a link followed: HOST_SCRIPT), and the address bar
 * follows, without a reload: /<owner>/<slug>/<page>, #edit kept
 * while editing. `ergaPageAddress()` is the page's address now.
 */
const NAV_SCRIPT = `(() => {
  const frame = document.getElementById("frame");
  const pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const meta = (name) => document.querySelector('meta[name="' + name + '"]');
  const suffix = (file) => {
    let s = file.replace(/\\.(html|md)$/i, "");
    s = s == "index" ? "" : s.replace(/\\/index$/, "");
    return s ? "/" + s.split("/").map(encodeURIComponent).join("/") : "";
  };
  window.ergaPageAddress = () => meta("erga-address").content + (meta("erga-page") ? suffix(meta("erga-page").content) : "");
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages || e.data?.type != "erga-nav") return;
    // A page's path in the document; "" for the document's own.
    const path = e.data.path;
    if (typeof path != "string" || (path && !/\\.(html|md)$/i.test(path)) || path.length > 1000 || (path && path.split("/").some((p) => !p || p == ".." || p.startsWith(".")))) return;
    let m = meta("erga-page");
    if (!m) { m = document.head.appendChild(document.createElement("meta")); m.name = "erga-page"; m.content = ""; }
    if (m.content == path || (!path && !suffix(m.content))) return;
    m.content = path;
    // Viewing at the front page's address (/), its first page stays there.
    if (location.pathname == "/" && !suffix(path)) return;
    const here = ergaPageAddress();
    if (location.pathname != here) history.replaceState(history.state, "", here + location.search + location.hash);
    document.querySelector(".erga-view-buttons a[aria-pressed]")?.setAttribute("href", here + location.search + "#edit");
  });
})();`;

/**
 * The band at the top of a document's page (viewDocument), where the
 * controls are: the document's frame starts below it, so they never cover
 * the document, and it takes the document's own background, so it reads as
 * part of the page: its colour, and over that its gradient or image
 * (.erga-canvas, which has the frame's box; BAND_BOOT paints it). --band-h is the controls' row
 * (34px, at max(12px, the notch)) and a 10px gap; the editor's client/editor.html
 * keeps the frame there too. Until the frame says (BAND_BOOT), the colour
 * is the one this document had last time on this browser, and the
 * controls' tone (light or dark text) with it.
 */
const BAND_STYLE = `:root { --band-h: calc(max(12px, env(safe-area-inset-top)) + 44px); }
html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; }
html { background: var(--page-bg, var(--band, #fff)); }
#frame { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); border: 0; display: block; background: transparent; }
.erga-canvas { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); pointer-events: none; }
.erga-canvas > div { position: absolute; left: 0; top: 0; }
.erga-canvas :is(i, b) { position: absolute; display: block; }
.erga-canvas b { overflow: hidden; }
.erga-canvas i { box-sizing: content-box; background-origin: content-box; }`;

/** Sets the band's colour (ergaBand(id, colour)), or the one remembered for document `id` (ergaBand(id)); and the controls' tone to suit. Answers the tone. */
const BAND_HEAD = `window.ergaBand = function (id, color) {
  var key = "erga:band:v1:" + id, root = document.documentElement, tone = "";
  try {
    if (color === undefined) { var b = JSON.parse(localStorage.getItem(key) || "null"); color = b && typeof b.bg == "string" ? b.bg : ""; }
  } catch (e) { color = ""; }
  if (color && !(window.CSS && CSS.supports("color", color))) color = "";
  var rgb = color.match(/[\\d.]+/g);
  if (color && /^rgba?\\(/.test(color) && rgb && rgb.length >= 3) tone = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45 ? "page-dark" : "page-light";
  if (color) root.style.setProperty("--band", color); else root.style.removeProperty("--band");
  root.classList.toggle("page-dark", tone == "page-dark");
  root.classList.toggle("page-light", tone == "page-light");
  if (arguments.length > 1) try { localStorage.setItem(key, JSON.stringify({ bg: color, tone: tone })); } catch (e) {}
  return tone;
};`;

/** The band's colour, as the frame's host page tells it (pagesDoor, HOST_SCRIPT); answered once painted, so a first visit's page shows only under its own colour. */
const BAND_BOOT = `(() => {
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const id = document.querySelector('meta[name="erga-doc"]').content;
  // The page's canvas (HOST_SCRIPT, canvasOf), behind the frame, reaching out from it over the band and the room beside
  // the page, and scrolled with the page. Its layers are placed against the page's root box (the <i>'s content box), as
  // the browser places the canvas's. A pattern ("tile") carries on in its tiles all round; anything else (a gradient
  // across the page) carries on as the page's edges: the edge's row or column of pixels (a <b> that shows only that line),
  // stretched out (scaled) over the band and the room beside. Below, it repeats, as the page itself does there. Until the
  // frame says, the canvas this document had last time on this browser, if it was gradients only.
  const room = document.querySelector(".erga-canvas"), sheet = room.firstElementChild, KEY = "erga:canvas:v1:" + id, FAR = 4000;
  let canvas = null, urls = [], sx = 0, sy = 0;
  const px = (n) => (Number.isFinite(n) ? n : 0) + "px";
  // (At the page's scale, when the editor zooms it: client/zoom.ts.)
  function scrolled() {
    const k = canvas ? canvas.zoom : 1, at = canvas && !canvas.fixed ? \`translate(\${px(-sx * k)}, \${px(-sy * k)})\` : "";
    sheet.style.transformOrigin = "0 0";
    sheet.style.transform = k == 1 ? at : \`\${at} scale(\${k})\`;
  }
  function paintCanvas(c, files) {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    sheet.replaceChildren();
    canvas = null;
    if (!c || typeof c.image != "string" || !c.image) return scrolled();
    let image = c.image;
    // Its images: the files sent (erga-file:n), each at an address of this page's own; nothing else.
    if (/url\\(/i.test(image.replace(/url\\("erga-file:\\d+"\\)/g, "")) || /image-set|image\\(|element\\(|cross-fade/i.test(image)) return scrolled();
    image = image.replace(/url\\("erga-file:(\\d+)"\\)/g, (_, n) => {
      const f = files?.[n];
      if (!(f instanceof Blob) || !/^image\\//.test(f.type)) return "none";
      const u = URL.createObjectURL(f);
      urls.push(u);
      return \`url("\${u}")\`;
    });
    const look = { backgroundColor: c.color, backgroundImage: image, backgroundSize: c.size, backgroundPosition: c.position, backgroundRepeat: c.repeat };
    const ok = { backgroundColor: "color", backgroundImage: "background-image", backgroundSize: "background-size", backgroundPosition: "background-position", backgroundRepeat: "background-repeat" };
    for (const k in look) if (typeof look[k] != "string" || (look[k] && !CSS.supports(ok[k], look[k]))) look[k] = "";
    if (!look.backgroundImage) return scrolled();
    const x = Number(c.x), y = Number(c.y), w = Math.max(1, Number(c.w) || 0), h = Math.max(1, Number(c.h) || 0);
    const sheetOf = (at, l, t, extra) => {
      const i = document.createElement("i");
      Object.assign(i.style, look, { left: px(l), top: px(t), width: px(w), height: px(h) }, extra);
      at.append(i);
      return i;
    };
    if (c.tile) sheetOf(sheet, x, y, { padding: px(FAR), margin: px(-FAR) });
    else {
      sheetOf(sheet, x, y, { paddingBottom: px(FAR) });
      // Each edge: [left, top, width, height] of the line it shows, where the page is drawn in it, and which way it stretches.
      for (const [l, t, bw, bh, dx, origin, scale] of [
        [x, y - 1, w, 1, 0, "50% 100%", \`scaleY(\${FAR})\`],
        [x - 1, y, 1, h, 0, "100% 50%", \`scaleX(\${FAR})\`],
        [x + w, y, 1, h, 1 - w, "0 50%", \`scaleX(\${FAR})\`],
        [x - 1, y - 1, 1, 1, 0, "100% 100%", \`scale(\${FAR})\`],
        [x + w, y - 1, 1, 1, 1 - w, "0 100%", \`scale(\${FAR})\`],
      ]) {
        const b = document.createElement("b");
        Object.assign(b.style, { left: px(l), top: px(t), width: px(bw), height: px(bh), transformOrigin: origin, transform: scale });
        sheetOf(b, dx, 0);
        sheet.append(b);
      }
    }
    const zoom = Number(c.zoom);
    canvas = { fixed: !!c.fixed, zoom: zoom >= 0.25 && zoom <= 5 ? zoom : 1 };
    scrolled();
  }
  try { const kept = JSON.parse(localStorage.getItem(KEY) || "null"); if (kept) paintCanvas(kept, []); } catch (e) {}
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages) return;
    if (e.data?.type == "erga-scroll") { sx = Number(e.data.sx) || 0; sy = Number(e.data.sy) || 0; return scrolled(); }
    if (e.data?.type == "erga-canvas") {
      const c = e.data.canvas;
      paintCanvas(c, c?.files);
      try { if (c && !c.files?.length) localStorage.setItem(KEY, JSON.stringify({ ...c, files: [] })); else localStorage.removeItem(KEY); } catch (e) {}
      return;
    }
    if (e.data?.type != "erga-band") return;
    const c = e.data.color;
    if (typeof c != "string" || c.length > 200 || /url\\(/i.test(c)) return;
    window.ergaBand(id, c);
    requestAnimationFrame(() => frame.contentWindow.postMessage({ type: "erga-band-ok" }, pages));
  });
})();`;

/**
 * Going into the editor and back, on a document's page (viewDocument), for
 * those who may: the pencil, the editor's eye, the browser's back and
 * forward, or a page opened with #edit. Only the address's #edit changes, never the page.
 * The first time, the editor's controls and styles (client/editor.html, served as
 * /editor.html) are added to the page, then its code, which joins
 * the room; the frame loads its half and swaps the plain page for
 * the editable one, at the same place (pagesDoor). The editor's controls fade
 * in over the viewer's once it's ready (main.ts calls ergaShell.ready), and
 * out again on the way back; the editor keeps running meanwhile, so going back
 * in is immediate. Viewing, it fetches the editor's files while the browser is
 * idle, so that first time is quick too.
 */
const EDIT_BOOT = `(() => {
  const frame = document.getElementById("frame"), body = document.body;
  const pages = new URL(document.querySelector('meta[name="erga-pages"]').content, location.href).origin;
  let hostUp = false, wanted = null, editor = null, ready = false;
  // Reloaded in the editor, its controls are up already (EDITING_BODY), shown as if it were ready (but inert) until it is:
  // last on the page, as they'd be added below.
  const restored = window.ergaRestored;
  if (restored) {
    body.append(document.getElementById("erga-editor"));
    // (The editor's code not there in a while: the viewer's controls, with the pencil waiting, as on any way in.)
    setTimeout(() => { if (!ready) { body.classList.remove("erga-restored", "no-motion"); sync(); } }, 8000);
  }
  const toFrame = (type) => frame.contentWindow.postMessage({ type }, pages);
  // The frame's host page is up (or up again): what it was asked before then goes now.
  addEventListener("message", (e) => {
    if (e.source != frame.contentWindow || e.origin != pages || e.data?.type != "erga-host") return;
    hostUp = true;
    if (wanted) toFrame(wanted);
  });
  const ask = (type) => { wanted = type; if (hostUp) toFrame(type); };
  const sync = () => {
    const wrap = document.getElementById("erga-editor");
    body.classList.toggle("erga-editor-ready", ready || (!!restored && body.classList.contains("erga-restored") && body.classList.contains("erga-editing")));
    if (wrap) wrap.inert = !(ready && body.classList.contains("erga-editing"));
  };
  // The document's details, asked for as soon as editing starts, alongside the editor's files: that wakes its room too.
  const base = document.querySelector('meta[name="erga-base"]').content;
  const user = new URLSearchParams(location.search).get("user")?.trim();
  const info = () => { const url = base + "/api/doc" + (user ? "?user=" + encodeURIComponent(user) : ""); return { url, response: fetch(url) }; };
  const load = () => editor ??= (async () => {
    window.ergaDocInfo = info();
    document.head.append(Object.assign(document.createElement("link"), { rel: "preload", as: "script", href: "/page.js" }));
    const html = await (await fetch("/editor.html")).text();
    // This tab's copy, for a reload to open with (EDITING_HEAD).
    try { sessionStorage.setItem("${EDITOR_COPY}", html); } catch (e) {}
    // Reloaded with this very page's copy: its controls are the ones up already. Otherwise (a new release, say) they're the
    // new page's, which take the copy's place once their stylesheets are in.
    if (!restored || restored.html != html) {
      const d = new DOMParser().parseFromString(html, "text/html");
      document.documentElement.dataset.theme = "light";
      await Promise.all([...d.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => {
        el = document.importNode(el, true);
        const loaded = el.tagName == "LINK" && new Promise((done) => { el.onload = el.onerror = done; });
        document.head.append(el);
        return loaded;
      }));
      for (const el of document.querySelectorAll("[data-erga-restored], #erga-editor")) el.remove();
      const wrap = document.createElement("div");
      wrap.id = "erga-editor";
      for (const el of d.body.children) if (el.id != "frame" && el.tagName != "SCRIPT") wrap.append(document.importNode(el, true));
      body.append(wrap);
    }
    sync();
    body.append(Object.assign(document.createElement("script"), { src: "/page.js" }));
  })();
  // Editing, unless on the way out (erga-closing: the editor's own actions closing back into the pencil, client/editor.html).
  const editing = () => body.classList.contains("erga-editing") && !body.classList.contains("erga-closing");
  let closing = 0;
  function go(edit, push) {
    // The editor already running on another page (the viewer went to it since): that page's editor, loaded afresh.
    if (edit && window.ergaPage?.pagePath != null && window.ergaPage.pagePath != (document.querySelector('meta[name="erga-page"]')?.content || window.ergaPage.pagePath)) {
      history.replaceState(null, "", ergaPageAddress() + location.search + "#edit");
      location.reload();
      return;
    }
    if (push) history.pushState(null, "", (location.pathname == "/" ? "/" : ergaPageAddress()) + location.search + (edit ? "#edit" : ""));
    if (edit == editing() && push !== null) return;
    clearTimeout(closing);
    body.classList.remove("erga-closing");
    if (!edit && ready && body.classList.contains("erga-editing") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Out of the editor: its own actions close back into the pencil first (client/editor.html, .edit-group, 420ms), with the editor's
      // row still up; then the viewer's, the same buttons in the same places, takes over.
      body.classList.add("erga-closing");
      closing = setTimeout(() => { body.classList.remove("erga-closing", "erga-editing"); sync(); }, 420);
    } else body.classList.toggle("erga-editing", edit);
    document.querySelector(".erga-edit-button")?.setAttribute("aria-pressed", String(edit));
    ask(edit ? "erga-edit" : "erga-view");
    window.ergaPage?.setEditing(edit);
    sync();
    if (edit) load();
  }
  // Whether the page was opened in the editor (with #edit), rather than switched into it: main.ts restores
  // the agent as it was left only then, and otherwise opens it the way it does on any later switch.
  window.ergaShell = {
    ready() {
      ready = true;
      sync();
      // Its controls run now; what moves moves again from the next frame.
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("erga-restored", "no-motion")));
    },
    loadedEditing: editing(),
  };
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.(".erga-edit-button, #btn-edit");
    if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.id != "btn-edit", true);
  });
  // Back and forward, or #edit typed or taken off the address: editing follows it.
  const follow = () => go(location.hash == "#edit", false);
  addEventListener("popstate", follow);
  addEventListener("hashchange", follow);
  // Viewing, the editor's files are fetched ahead, at low priority, and its room woken (its details asked for): sooner when the
  // pointer or focus comes to the pencil, else once the document has loaded (its frame and everything in it) and the browser is
  // idle, so it never competes with the document itself.
  let fetched = false;
  const prefetch = () => {
    if (fetched || editor) return;
    fetched = true;
    for (const href of ["/editor.html", "/page.js", "/style.css", "/fonts/inter.css"]) document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href }));
    if (hostUp) toFrame("erga-prefetch"); else wanted ??= "erga-prefetch";
    info().response.catch(() => {});
  };
  for (const type of ["pointerover", "focusin"]) document.addEventListener(type, (e) => { if (e.target.closest?.(".erga-edit-button")) prefetch(); });
  if (editing()) go(true, null);
  else {
    const idle = () => (window.requestIdleCallback ?? setTimeout)(prefetch);
    if (document.readyState == "complete") idle(); else addEventListener("load", idle, { once: true });
  }
})();`;

/**
 * A presentation's steps, on a document's page (viewDocument), viewing and
 * editing alike: the frame's host page says when the page shown has steps
 * (HOST_SCRIPT: erga-steps; editor-agent/PROMPT.md, "Presentations"), and this
 * shows back and forward under the page, the step it's at, and a list of the
 * steps that opens over its right side. The arrow keys step too, pressed here
 * or in the page (the host page's), except in text. The list shows each step's
 * picture where the page draws them (erga-step-image), kept until the page
 * changes (another rev: an edit, another page), else its number and label.
 */
const STEPS_BOOT = `(() => {
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const svg = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  const bar = document.createElement("div"), panel = document.createElement("div");
  bar.className = "erga-steps"; bar.hidden = true;
  bar.innerHTML = '<button type="button" class="erga-steps-toggle" aria-label="Steps" aria-expanded="false">' + svg("M5 6.5h14M5 12h14M5 17.5h14") + '</button>'
    + '<button type="button" class="erga-steps-back" aria-label="Back">' + svg("M14.5 6.5L9 12l5.5 5.5") + '</button>'
    + '<span class="erga-steps-at" aria-live="polite"></span>'
    + '<button type="button" class="erga-steps-next" aria-label="Forward">' + svg("M9.5 6.5L15 12l-5.5 5.5") + '</button>';
  // The list under a head: the editor docks it beside the page, and the head is where it's dragged from.
  panel.className = "erga-steps-panel"; panel.hidden = true; panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Steps");
  panel.innerHTML = '<div class="erga-steps-head">Steps</div><ol class="erga-steps-list"></ol>';
  const list = panel.querySelector("ol");
  document.body.append(panel, bar);
  const [toggle, back, next] = bar.querySelectorAll("button"), at = bar.querySelector(".erga-steps-at");
  // What the page says (null: no steps), the list's shape it was built for, and the steps' pictures: step -> { url, rev }.
  let steps = null, shape = "", pics = new Map(), asked = new Set(), timer = 0;
  const send = (m) => frame.contentWindow?.postMessage(m, pages);
  const open = () => !panel.hidden;
  const items = () => panel.querySelectorAll(".erga-step");
  const drop = () => { for (const p of pics.values()) URL.revokeObjectURL(p.url); pics.clear(); asked.clear(); };
  function picture(i) {
    const box = items()[i]?.querySelector(".erga-step-pic"), p = pics.get(i);
    if (!box) return;
    if (p) { let img = box.querySelector("img"); if (!img) { box.textContent = ""; img = box.appendChild(document.createElement("img")); img.alt = ""; } if (img.src != p.url) img.src = p.url; }
    else if (box.querySelector("img") || !box.textContent) box.textContent = String(i + 1);
  }
  // The pictures of the steps in sight in the list, of this rev, that it hasn't yet: asked for once the page has stopped changing.
  function ask() {
    clearTimeout(timer);
    if (!steps?.images || !open()) return;
    timer = setTimeout(() => {
      const r = frame.getBoundingClientRect(), w = 384, h = Math.round(w * (r.height / r.width || 9 / 16)), view = list.getBoundingClientRect();
      items().forEach((el, i) => {
        const b = el.getBoundingClientRect(), key = steps.rev + ":" + i;
        if (b.bottom < view.top - 200 || b.top > view.bottom + 200 || pics.get(i)?.rev == steps.rev || asked.has(key)) return;
        asked.add(key);
        send({ type: "erga-step-image", step: i, rev: steps.rev, width: w, height: h });
      });
    }, pics.size ? 400 : 0);
  }
  function build() {
    list.textContent = "";
    panel.classList.toggle("erga-steps-plain", !steps.images);
    steps.labels.forEach((label, i) => {
      const li = list.appendChild(document.createElement("li")), b = li.appendChild(document.createElement("button"));
      b.type = "button"; b.className = "erga-step"; b.dataset.step = i;
      b.setAttribute("aria-label", (label ? label + ", " : "") + "step " + (i + 1) + " of " + steps.count);
      b.appendChild(document.createElement("span")).className = "erga-step-pic";
      const name = b.appendChild(document.createElement("span")), n = name.appendChild(document.createElement("b"));
      name.className = "erga-step-name"; n.textContent = i + 1;
      name.appendChild(document.createElement("span")).textContent = label || "Step " + (i + 1);
      picture(i);
    });
  }
  function current() {
    items().forEach((el, i) => { if (i == steps.current) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
    if (open()) items()[steps.current]?.scrollIntoView({ block: "nearest" });
  }
  function update(s) {
    const was = steps;
    steps = s && s.count > 0 ? s : null;
    bar.hidden = !steps;
    if (!steps) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); shape = ""; drop(); return; }
    // Other steps: the old pictures may be of other steps. Otherwise they stay up until the new ones come.
    const now = steps.count + "\\n" + steps.labels.join("\\n") + "\\n" + steps.images;
    if (now != shape) { shape = now; drop(); build(); }
    at.textContent = (steps.current + 1) + " / " + steps.count;
    bar.title = steps.labels[steps.current] || "";
    back.disabled = steps.current <= 0;
    next.disabled = steps.current >= steps.count - 1;
    current();
    if (!was || was.rev != steps.rev) ask();
    place();
  }
  // Under the page and over its right side (its left, if the editor's layout has the list left of the page), wherever the editor puts
  // the frame (the agent beside it), out of sight with it. Docked beside the page in the editor, the editor places the list.
  function place() {
    if (!steps) return;
    const r = frame.getBoundingClientRect(), hidden = getComputedStyle(frame).visibility == "hidden" || !r.width;
    bar.style.visibility = panel.style.visibility = hidden ? "hidden" : "";
    bar.style.left = r.left + r.width / 2 + "px";
    bar.style.bottom = Math.max(12, innerHeight - r.bottom + 14) + "px";
    const docked = panel.classList.contains("erga-docked") && document.body.classList.contains("erga-editing");
    let left = false;
    try { const o = JSON.parse(localStorage.getItem("erga:layout:v1") || "null")?.order; left = Array.isArray(o) && o.indexOf("picker") < o.indexOf("doc"); } catch {}
    panel.style.left = docked || !left ? "" : Math.max(8, r.left + 12) + "px";
    panel.style.right = docked ? "" : left ? "auto" : Math.max(8, innerWidth - r.right + 12) + "px";
    panel.style.top = docked ? "" : r.top + 12 + "px";
    // The pictures' shape is the frame's, as it is now (it changes with the window).
    panel.style.setProperty("--ar", r.width && r.height ? r.width + " / " + r.height : "16 / 9");
    panel.style.maxHeight = docked ? "" : Math.max(80, innerHeight - Math.max(12, innerHeight - r.bottom + 14) - 50 - r.top - 12) + "px";
  }
  function show(on) {
    panel.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) { place(); current(); ask(); }
  }
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source != frame.contentWindow || e.origin != pages || !m) return;
    if (m.type == "erga-steps") {
      const s = m.steps, ok = s && Number.isInteger(s.count) && s.count >= 0 && s.count <= 1000 && Number.isInteger(s.current) && Number.isInteger(s.rev)
        && Array.isArray(s.labels) && s.labels.length == s.count && s.labels.every((l) => typeof l == "string" && l.length <= 200);
      update(ok ? { count: s.count, current: Math.min(s.current, s.count - 1), labels: s.labels, images: s.images === true, rev: s.rev } : null);
    } else if (m.type == "erga-step-image" && steps && m.rev == steps.rev && Number.isInteger(m.step) && m.step < steps.count) {
      const old = pics.get(m.step);
      if (old) URL.revokeObjectURL(old.url);
      if (m.blob instanceof Blob && /^image\\//.test(m.blob.type)) pics.set(m.step, { url: URL.createObjectURL(m.blob), rev: m.rev });
      else pics.delete(m.step);
      picture(m.step);
    }
  });
  const go = (m) => { if (steps) send({ type: "erga-step", ...m }); };
  back.addEventListener("click", () => go({ by: -1 }));
  next.addEventListener("click", () => go({ by: 1 }));
  toggle.addEventListener("click", () => show(!open()));
  panel.addEventListener("click", (e) => { const b = e.target.closest?.(".erga-step"); if (b) go({ to: Number(b.dataset.step) }); });
  list.addEventListener("scroll", ask, { passive: true });
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!steps || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key == "Escape" && open()) { show(false); return; }
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.closest?.(".cm-editor"))) return;
    e.preventDefault();
    go({ by: e.key == "ArrowLeft" ? -1 : 1 });
  });
  new ResizeObserver(place).observe(frame);
  addEventListener("resize", place);
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  frame.addEventListener("transitionend", place);
})();`;

const STEPS_STYLE = `
<style>
  .erga-steps, .erga-steps-panel { --st-bg: rgba(255, 255, 255, .95); --st-fg: #3f3f46; --st-soft: #8a8a94; --st-hover: rgba(161, 161, 169, .18);
    position: fixed; z-index: 25; box-sizing: border-box; background: var(--st-bg); color: var(--st-fg);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .06), 0 4px 18px rgba(0, 0, 0, .14); font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  html.page-dark :is(.erga-steps, .erga-steps-panel) { --st-bg: rgba(31, 31, 35, .95); --st-fg: #e4e4e9; --st-soft: #8f8f99; --st-hover: rgba(161, 161, 169, .2);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 4px 18px rgba(0, 0, 0, .4); }
  .erga-steps[hidden], .erga-steps-panel[hidden] { display: none; }
  .erga-steps { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; transform: translateX(-50%); }
  .erga-steps button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  .erga-steps button:hover:not(:disabled) { background: var(--st-hover); }
  .erga-steps button:disabled { opacity: .3; cursor: default; }
  :is(.erga-steps button, .erga-step):focus-visible { outline: 2px solid #3b7cf0; outline-offset: -2px; }
  .erga-steps button[aria-expanded="true"] { color: #3b7cf0; }
  .erga-steps svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .erga-steps-at { min-width: 54px; padding: 0 2px; text-align: center; font-variant-numeric: tabular-nums; }
  .erga-steps-panel { display: flex; flex-direction: column; width: min(208px, 55vw); overflow: hidden; border-radius: 12px; }
  .erga-steps-head { flex: none; padding: 10px 12px 2px; color: var(--st-soft); font-size: 12px; font-weight: 600; }
  .erga-steps-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 6px; list-style: none; overflow-y: auto; overscroll-behavior: contain; }
  .erga-step { display: block; width: 100%; padding: 5px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .erga-step:hover { background: var(--st-hover); }
  .erga-step-pic { display: grid; place-items: center; width: 100%; aspect-ratio: var(--ar, 16 / 9); overflow: hidden; border-radius: 5px;
    background: var(--st-hover); color: var(--st-soft); font-size: 22px; font-weight: 600; }
  .erga-step-pic img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .erga-step[aria-current="step"] .erga-step-pic { outline: 2px solid #3b7cf0; outline-offset: 1px; }
  .erga-step-name { display: flex; gap: 6px; margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.3; }
  .erga-step-name b { color: var(--st-soft); font-weight: 500; font-variant-numeric: tabular-nums; }
  .erga-step-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .erga-steps-plain .erga-step-pic { display: none; }
  .erga-steps-plain .erga-step-name { margin: 0; }
  .erga-steps-plain .erga-step[aria-current="step"] { color: #3b7cf0; }
  .erga-steps-plain .erga-step[aria-current="step"] b { color: inherit; }
  /* On a phone the agent covers the page: the steps go with it. */
  @media (max-width: 640px) { body.agent-open :is(.erga-steps, .erga-steps-panel) { display: none; } }
</style>`;

/** The front page when there's no landing document and none can be made (seedLanding): what Erga is, and the way in. */
async function startPage(platform: Platform, session: Session | null): Promise<Response> {
  const admin = !!session && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  const signedIn = session && !session.test;
  const actions = signedIn
    ? `<a class="new" href="${esc(link("/docs", session))}">Your documents</a><a class="pill" href="${esc(link("/new", session))}">New document</a>`
    : `<a class="new" href="/auth/github?next=%2Fdocs">Sign in</a>`;
  const style = `
  .start { padding-top: 22vh; }
  .start p { margin: 0 0 22px; color: var(--soft); }
  .start .actions { display: flex; gap: 8px; }
  .start .pill { text-decoration: none; }
  .start .hint { margin-top: 28px; font-size: 13px; }
  .start code { font-family: var(--font-mono); font-size: 12.5px; }
  .start .hint a { color: inherit; }`;
  return new Response(appPage("Erga", style, `${signedIn ? crumbs(session, []) : ""}<main class="start">
  <header><h1>Erga</h1></header>
  <p>Pages you edit where they're rendered, together with your agents.</p>
  <div class="actions">${actions}</div>
  ${admin ? `<p class="hint">There's no front page: the deploy locks <code>landing_document</code> to a document that isn't there, or has no admins (<code>ADMINS</code>) to make the repo's demo page for. Choose one of your documents as <code>landing_document</code> on <a href="${esc(link("/admin", session))}">the admin page</a>.</p>` : ""}
</main>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * The viewer's controls (Clone, Edit, who you are) fade once the page is
 * scrolled, on a document's page (viewDocument, FADE_BOOT) and on the
 * homepage alike: whole at the top of the page, faded (VIEW_STYLE,
 * FADED) anywhere below it, and whole again while the pointer is within
 * FADE_NEAR px of them, one of them has keyboard focus or your menu is open.
 * On a touch screen, with no pointer to come near, a tap near them brings
 * them back until the page scrolls again. It's a function of those alone:
 * the same scroll and pointer give the same look, and no timer changes it.
 *
 * `ergaFade(target, root)` (a page script) puts the class erga-faded on
 * `target` while they're faded; `root` is the document or shadow root they're
 * in. Its caller tells it where the page is scrolled to (scroll(y)) and where
 * the pointer is, in the window's coordinates (pointer(x, y, tap)), or that it
 * left the window (leave()).
 */
export const FADE_NEAR = 100;
/** How see-through the faded controls are: faint, but still there to find. */
export const FADED = 0.2;
export const FADE = `function ergaFade(target, root) {
  var NEAR = ${FADE_NEAR}, y = 0, mouse = null, tap = false, CONTROLS = ".erga-view-buttons, .erga-account, .erga-crumbs";
  // How far (x, y) is from the nearest control (the account's button, not its menu).
  function distance(x, y) {
    var best = Infinity;
    root.querySelectorAll(".erga-view-buttons > *, .erga-account-btn").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      best = Math.min(best, Math.hypot(dx, dy));
    });
    return best;
  }
  function focused() {
    var a = root.activeElement;
    try { return !!(a && a.closest && a.closest(CONTROLS) && a.matches(":focus-visible")); } catch (e) { return false; }
  }
  function update() {
    var whole = y <= 0 || tap || (mouse && distance(mouse.x, mouse.y) <= NEAR) || focused() || !!root.querySelector('.erga-account-btn[aria-expanded="true"]');
    target.classList.toggle("erga-faded", !whole);
  }
  root.addEventListener("focusin", update);
  root.addEventListener("focusout", function () { setTimeout(update); });
  // The account's menu opening or closing.
  new MutationObserver(update).observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
  addEventListener("resize", update);
  update();
  return {
    scroll: function (to) { to = Math.max(0, Number(to) || 0); if (to != y) tap = false; y = to; update(); },
    pointer: function (x, py, isTap) {
      if (!isFinite(x) || !isFinite(py)) return;
      if (isTap) tap = distance(x, py) <= NEAR; else mouse = { x: x, y: py };
      update();
    },
    leave: function () { mouse = null; update(); },
    update: update,
  };
}`;

/**
 * The fade (FADE) on a document's page: the page scrolls in the frame, on its
 * own origin, so the frame's host page says where it's scrolled to and where
 * the pointer is over it (HOST_SCRIPT: erga-scroll, erga-pointer). The pointer
 * over the band and the controls is this page's own.
 */
const FADE_BOOT = `(() => {
  ${FADE}
  const frame = document.getElementById("frame"), pages = new URL(frame.src || frame.dataset.src, location.href).origin;
  const fade = ergaFade(document.documentElement, document);
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source != frame.contentWindow || e.origin != pages || !m) return;
    if (m.type == "erga-scroll") fade.scroll(m.y);
    else if (m.type == "erga-pointer") { const r = frame.getBoundingClientRect(); fade.pointer(Number(m.x) + r.left, Number(m.y) + r.top, m.tap === true); }
  });
  document.addEventListener("pointermove", (e) => { if (e.pointerType == "mouse") fade.pointer(e.clientX, e.clientY, false); }, { passive: true });
  document.addEventListener("pointerdown", (e) => { if (e.pointerType != "mouse") fade.pointer(e.clientX, e.clientY, true); }, { passive: true });
  // Out of the window (not into the frame, which then says where the pointer is).
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    const r = frame.getBoundingClientRect();
    if (e.clientX > r.left + 1 && e.clientX < r.right - 1 && e.clientY > r.top + 1 && e.clientY < r.bottom - 1) return;
    fade.leave();
  });
})();`;

export const VIEW_STYLE = `
<style>
  /* The editor's look (client/style.css, .icon-btn): small icons. Right of them is who you are. Upper left, for
     someone signed in, the breadcrumbs (viewCrumbs), where the editor's are (client/editor.html, .chrome-nav) and as they look. */
  :is(.erga-view-buttons, .erga-crumbs) { --chrome: #a1a1a9; --chrome-hover: #3f3f46; --fg: #1c1c1f; --fg-strong: #0d0d0f; --soft: #6b6b73;
    position: fixed; top: max(12px, env(safe-area-inset-top)); z-index: 1000; display: flex; align-items: center;
    font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .erga-view-buttons { right: max(56px, calc(env(safe-area-inset-right) + 40px)); gap: 2px; }
  .erga-crumbs { left: max(14px, env(safe-area-inset-left)); height: 34px; min-width: 0; max-width: calc(100vw - 200px); margin: 0; font-size: 13.5px; }
  /* Each step's box and arrow as the editor's, so going into the editor and out moves nothing. */
  .erga-crumbs, .erga-crumbs > * { align-items: baseline; line-height: 34px; }
  .erga-crumbs > * { display: flex; height: 34px; text-decoration: none; }
  .erga-crumbs > :not(:last-child)::after { content: "›"; color: var(--chrome); opacity: 0.55; font-size: 13.5px; font-weight: 400; letter-spacing: normal; }
  .erga-brand { flex: none; padding: 0 6px; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); }
  .erga-brand::after { margin: 0 -6px 0 10px; }
  .erga-crumbs a.erga-crumb { flex: none; padding: 0 10px; color: var(--soft); }
  .erga-crumb::after { margin: 0 -6px 0 12px; }
  .erga-crumbs .erga-here { padding: 0 8px; }
  .erga-crumbs a:hover { opacity: 0.7; }
  .erga-crumbs a:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 1px; border-radius: 8px; }
  .erga-crumbs .erga-here { min-width: 0; color: var(--fg); }
  .erga-crumbs .erga-here span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 520px) { .erga-crumbs a.erga-crumb { display: none; } .erga-crumbs .erga-here { padding: 0 6px; } }
  /* On the band (BAND_STYLE), in the document's own colour: light or dark text to suit it, whatever the system's mode. */
  html.page-dark :is(.erga-view-buttons, .erga-crumbs) { --chrome: #8a8a94; --chrome-hover: #e4e4e9; --fg: #ececf1; --fg-strong: #ececf1; --soft: #a1a1aa; }
  html.page-light .erga-account { --acc-bg: #fff; --acc-fg: #1c1c1f; --acc-soft: #6b6b73; --acc-chrome: #a1a1a9; --acc-ring: #e6e6ea; --acc-hover: rgba(161, 161, 169, .14); }
  html.page-dark .erga-account { --acc-bg: #1f1f23; --acc-fg: #ececf1; --acc-soft: #8f8f99; --acc-chrome: #8a8a94; --acc-ring: #2f2f35; --acc-hover: rgba(161, 161, 169, .16); }
  html:is(.page-dark, .page-light) .erga-account-btn:not(.erga-account-out) { box-shadow: 0 0 0 2px var(--band, var(--acc-bg)); }
  .erga-view-button { position: relative; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--chrome);
    transition: color 150ms ease, background-color 150ms ease; }
  .erga-view-button:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  /* Editing (or on the way into it), the pencil is blue, as the editor's own is. */
  .erga-view-button[aria-pressed="true"] { color: #3b7cf0; }
  /* On the way into the editor the first time, while its code arrives, the pencil breathes (only if that takes a moment). */
  body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: erga-edit-wait 700ms ease-in-out 250ms infinite alternate; }
  @keyframes erga-edit-wait { to { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: none; opacity: 0.6; } }
  .erga-view-button svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .erga-view-button::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); white-space: pre; font-size: 12px;
    font-weight: 400; line-height: 1.3; letter-spacing: .01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .erga-view-button:hover::after { opacity: 1; } }
  /* Into the editor and out (EDIT_BOOT): the controls you're going to are there at once, whole, and the ones you're leaving fade
     out; so those in both (the pencil, your avatar, the breadcrumbs) never go see-through. */
  #erga-editor { opacity: 0; transition: opacity 200ms ease; }
  body.erga-editing.erga-editor-ready #erga-editor { opacity: 1; transition: none; }
  body:not(.erga-editing) #nav-docs { visibility: hidden; }
  .erga-view-buttons, .erga-account, .erga-crumbs { transition: none; }
  /* Editing, the editor's own breadcrumbs, just under the viewer's while those fade, take the clicks. */
  body.erga-editing .erga-crumbs { pointer-events: none; }
  body.erga-editing.erga-editor-ready :is(.erga-view-buttons, .erga-account, .erga-crumbs) { opacity: 0; visibility: hidden; transition: opacity 200ms ease, visibility 0s 200ms; }
  /* Faded once the page is scrolled (FADE): the controls themselves, not the band behind them nor your open menu. Quick and
     smooth, and with no motion at all for those who ask for less: just the change. */
  .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: opacity 180ms ease, color 150ms ease, background-color 150ms ease; }
  html.erga-faded :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  :host(.erga-faded) :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  @media (prefers-reduced-motion: reduce) { .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: color 150ms ease, background-color 150ms ease; } }
  /* On a phone they'd sit over the text the whole way down: they stay at the top instead. */
  @media (max-width: 640px), (max-height: 480px) {
    .erga-view-buttons, .erga-crumbs { position: absolute; }
  }
</style>`;

/** A template's starting files (server/templates.ts: a folder under assets/templates/), and its page; null if this server hasn't them. */
export function templateFiles(platform: Platform, template: Template): { files: Record<string, string | Uint8Array>; index: string } | null {
  const files = platform.templates[template.files.slice("assets/templates/".length)];
  if (!files) return null;
  const index = files["index.html"] != null ? "index.html" : files["index.md"] != null ? "index.md" : null;
  return index ? { files: { ...files }, index } : null;
}

/**
 * What a new document starts from: a copy of the front page's document
 * (`landing`), of another document by id (one `who` may open), or a
 * template's files (server/templates.ts; the first, a blank page, by default).
 * Null if there's nothing there to copy.
 */
export async function startingFiles(platform: Platform, from: string | null, who?: Who, template?: Template): Promise<{ files: Record<string, string | Uint8Array>; index: string } | null> {
  if (!from) return templateFiles(platform, template ?? TEMPLATES[0]);
  const doc = from == "landing" ? await landingDocument(platform) : ID.test(from) && who ? await platform.directory.get(from) : null;
  if (!doc || (from != "landing" && !(await platform.directory.may(who!, "open", doc)))) return null;
  // A copy of what they may see: someone who may not edit it copies its published version (the same in "latest" mode).
  const editor = !!who && (await platform.directory.may(who, "edit", doc));
  return platform.docs.snapshot(doc, { published: !editor });
}

/** A new document for the signed-in person, at /<login>/<id>: blank, from a template (?template=<id>, server/templates.ts), or a copy of the front page's (?from=landing). */
async function newDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  if (!session) return signInFirst(`/new${params.size ? `?${params}` : ""}`);
  if (session.onlyDoc != null) return page("One document only", "This token is for one document: it can't make others.", 403);
  const named = params.get("template");
  const template = named ? templateById(named) : undefined;
  if (named && !template) return page("No such template", "There's no template by that name. <a href=\"/new\">Make a blank document</a>.", 404);
  // Another site may not make documents for you (nor an unconfirmed sign-in on the way back from GitHub).
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) {
    return confirmAction("New document", params.get("from") ? "Make your copy of this page" : template ? `Make a new document: ${template.name}` : "Make a new document", `/new${url.search}`);
  }
  const wanted = params.get("id");
  const from = params.get("from");
  const start = await startingFiles(platform, from, whoOf(session), template);
  if (!start) return page("Nothing to copy", from == "landing" ? "This server has no front page to copy. <a href=\"/new\">Make a blank document</a>." : "There's no document here you can copy. <a href=\"/new\">Make a blank document</a>.", 404);
  const files = start.files, index = start.index;
  // A test person makes (or reuses) a test document under the address of whoever minted their token.
  // Its address is its id, which never follows the title (the suite addresses it by id).
  if (session.test) {
    if (!wanted || !TEST_ID.test(wanted)) return page("Test documents only", "Name the test document: /new?id=test1234.", 400);
    const owner = session.test.by.toLowerCase();
    const known = await platform.directory.route(wanted);
    if (known && (known.owner != owner || !known.test)) return page("Taken", "That test document's id is someone else's: pick another.", 409);
    if (!known) await makeDoc(platform, owner, wanted, files, { test: true, index });
    return new Response(null, { status: 302, headers: { Location: `/${owner}/${wanted}#edit` } });
  }
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for e2e/front/lifetime.e2e.ts).
  const dev = platform.dev(url);
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newDocId();
    const made = await makeDoc(platform, session.login.toLowerCase(), id, files, { unedited, index });
    if (made) return new Response(null, { status: 302, headers: { Location: `${link(`/${made.owner}/${made.slug}`, session)}#edit` } });
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

/**
 * Makes a document from a template's files: its row in the directory (titled
 * by the template's heading, its slug following that), then its host. Null
 * if the id is taken.
 */
const HOUR = 60 * 60 * 1000;

export async function makeDoc(platform: Platform, owner: string, id: string, files: Record<string, string | Uint8Array>, opts: MakeOptions): Promise<DocRow | null> {
  const created = Date.now();
  // A published one has been edited already (its files are someone's work): it never expires.
  // Nor does any when the server's delete_docs_after_hours is never (null).
  const hours = opts.test || opts.published || opts.unedited ? null : await platform.directory.config.get("delete_docs_after_hours");
  const expires = opts.test || opts.published ? null : opts.unedited ? created + opts.unedited : hours == null ? null : created + hours * HOUR;
  const index = opts.index ?? "index.html";
  const page = files[index];
  const pageText = typeof page == "string" ? page : page ? new TextDecoder().decode(page) : "";
  const { doc, added } = await platform.directory.add({
    id, owner,
    ...(opts.title?.trim() ? { title: opts.title, titleSet: true } : { title: titleOf(pageText, index) ?? UNTITLED }),
    ...(opts.test ? { slug: id, slugSet: true } : opts.slug?.trim() ? { slug: opts.slug, slugSet: true } : {}),
    created, expires, test: opts.test,
    ...(opts.published ? { modified: created } : {}),
  });
  if (!added) return null;
  if (await platform.docs.create(doc, files, index, { test: opts.test, expires, ...(opts.published ? { modified: created } : {}) })) return doc;
  // A host by that name was there already (one whose row went): leave it, and try another id.
  await platform.directory.remove(id);
  return null;
}

export interface MakeOptions {
  test?: boolean;
  /** How soon it goes if nobody edits it, in ms (local development's tests). */
  unedited?: number;
  /** Its page (index.html if not given). */
  index?: string;
  /** A title (set: it won't follow the page's heading) and slug (set: it won't follow the title). */
  title?: string;
  slug?: string;
  /** Made from someone's files (the server's API): counts as edited, so it never expires. */
  published?: boolean;
}

/** A new document's id: 8 letters and digits, none easily mistaken for another. */

/** /docs: the signed-in person's documents, most recently edited first. */
async function listDocs(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  if (session.onlyDoc != null) return page("One document only", "This token is for one document: it can't list others.", 403);
  const [docs, hours] = await Promise.all([platform.docs.list(session.login), platform.directory.config.get("delete_docs_after_hours")]);
  return new Response(docsPage(session, docs, Date.now(), hours), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** POST /docs/delete (id=...): deletes one of the signed-in person's documents. */
async function deleteDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return new Response("Sign in first", { status: 401 });
  // Only from this site's own pages (the session cookie is SameSite=Lax already).
  if (request.headers.get("origin") != new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  const id = String((await request.formData()).get("id") ?? "");
  const route = ID.test(id) ? await platform.directory.route(id) : null;
  if (!route) return new Response("No such document", { status: 404 });
  if (!(await platform.directory.may(whoOf(session), "delete", route))) return new Response("Only its owner can delete a document", { status: 403 });
  // Gone already (or never made): drop a stale entry all the same.
  if (!(await platform.docs.delete(route))) await platform.directory.remove(id);
  return new Response(null, { status: 303, headers: { Location: link("/docs", session) } });
}

/**
 * POST /docs/share (id, login, role): gives someone a role on one of your
 * documents ("editor" or "viewer"; login "*" is anyone signed in who has the
 * link), or takes it away (role "none" or empty). Only its owner may. Answers
 * JSON: everyone's permissions now, and which of them can't sign in yet
 * (`notUsers`: not users of this server), each one's picture (`avatars`, by
 * login: their GitHub picture), or the error. GET /docs/share?id=
 * answers the same without changing anything (the list's share dialog).
 */
async function shareDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return Response.json({ error: "Sign in first" }, { status: 401 });
  const url = new URL(request.url);
  const answer = async (permissions: Permission[]) => {
    const notUsers = (await Promise.all(permissions.map(async (p) => (p.login == "*" || (await platform.directory.users.allowed(p.login)) ? null : p.login)))).filter((l) => l != null);
    return Response.json({ permissions, notUsers, avatars: avatarsOf(permissions.map((p) => p.login)) });
  };
  if (request.method == "GET") {
    const id = url.searchParams.get("id") ?? "";
    const doc = ID.test(id) ? await platform.directory.get(id) : null;
    if (!doc) return Response.json({ error: "No such document" }, { status: 404 });
    if (!(await platform.directory.may(whoOf(session), "share", doc))) return Response.json({ error: "Only its owner can share a document." }, { status: 403 });
    return answer(await platform.directory.permissions(id));
  }
  if (request.method != "POST") return Response.json({ error: "GET or POST" }, { status: 405 });
  if (request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const id = String(form.get("id") ?? ""), login = String(form.get("login") ?? ""), role = String(form.get("role") ?? "");
  if (!ID.test(id) || !(await platform.directory.get(id))) return Response.json({ error: "No such document" }, { status: 404 });
  try {
    return answer(await platform.directory.share(whoOf(session), id, login, role == "" || role == "none" ? null : role as Grant));
  } catch (e) {
    if (e instanceof NotAllowed) return Response.json({ error: e.message }, { status: 403 });
    throw e;
  }
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "12 days ago", or the date (the page's script redoes it in the reader's zone). */
function ago(t: number, now: number): string {
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min == 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours == 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days == 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The look the app's own pages share (/docs, /admin): the editor's type and
 * colours, light or dark with the system, a column of rows, small
 * icon buttons that show on hover, and dialogs as small cards.
 */
export const APP_STYLE = `
  body { font-size: 15px; line-height: 1.5; background: var(--bg); -webkit-font-smoothing: antialiased; }
  /* The page fills the window, so the footer (siteFooter) sits at its foot. */
  body { min-height: 100vh; margin: 0; display: flex; flex-direction: column; }
  .site-foot { padding: 24px 16px 32px; text-align: center; font-size: 12.5px; color: var(--chrome); }
  main { flex: 1; width: 100%; min-height: 0; box-sizing: border-box; max-width: 1080px; margin: 0 auto; padding: 120px 24px 96px; display: flex; flex-direction: column; }
  /* The breadcrumbs (crumbs): the wordmark, then where you are, upper left, on the line of the account corner upper right
     (server/account-menu.ts). The viewer's (VIEW_STYLE) and the editor's (client/editor.html) look the same, in the same place. */
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; margin: 0; min-width: 0; max-width: calc(100vw - 140px); }
  .brand { flex: none; display: flex; align-items: center; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); text-decoration: none; }
  .brand:hover { opacity: 0.7; }
  .crumbs > :not(.brand)::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  .crumbs a.crumb { flex: none; display: flex; align-items: center; color: var(--soft); text-decoration: none; font-size: 13.5px; font-weight: 500; }
  .crumbs a.crumb:hover { color: var(--fg-strong); }
  .crumbs .here { display: flex; align-items: center; min-width: 0; margin: 0; font-size: 13.5px; line-height: inherit; font-weight: 500; letter-spacing: normal; color: var(--fg); }
  .crumbs .here span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 36px; }
  h1 { margin: 0; font-size: 30px; line-height: 1.15; font-weight: 650; letter-spacing: -0.025em; color: var(--fg-strong); }
  .sub { margin: 6px 0 0; font-size: 14px; color: var(--soft); }
  .new, .pill { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 8px;
    font: inherit; font-size: 13.5px; font-weight: 550; line-height: 1; text-decoration: none; white-space: nowrap; cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease; }
  .new { border: 1px solid var(--fg-strong); background: var(--fg-strong); color: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
  .new:hover { opacity: 0.86; }
  .new svg, .pill svg { width: 15px; height: 15px; margin-left: -3px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .pill { border: 1px solid var(--rule); background: var(--bg); color: var(--fg-strong); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
  .pill:hover:not(:disabled) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
  .pill:disabled { color: var(--chrome); cursor: default; box-shadow: none; }
  :is(.new, .doc, .act, .brand, .crumb, dialog button, .pill, select):focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; border-radius: 8px; }
  ol.rows { list-style: none; margin: 0; padding: 0; }
  ol.rows > li { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--rule); }
  ol.rows > li:first-child { border-top: 1px solid var(--rule); }
  .doc { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 13px 4px; color: inherit; text-decoration: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg-strong); }
  .note { flex: none; font-size: 12.5px; color: var(--chrome); }
  time { flex: none; margin-left: auto; font-size: 13px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; }
  form { margin: 0; }
  .act { flex: none; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--chrome); cursor: pointer; opacity: 0; transition: opacity 150ms ease, color 150ms ease, background-color 150ms ease; }
  .act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .act, .act:focus-visible, .act.on { opacity: 1; }
  .act:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
  .act:disabled { cursor: default; opacity: 0 !important; }
  @media (hover: none) { .act { opacity: 1; } }
  .input { box-sizing: border-box; min-width: 0; height: 34px; padding: 0 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--fg-strong); font: inherit; font-size: 14px; transition: border-color 150ms ease; }
  .input::placeholder { color: var(--chrome); }
  .input:hover:not(:disabled) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
  .input:focus-visible { outline: 2px solid color-mix(in srgb, var(--caret) 35%, transparent); outline-offset: 0; border-color: var(--caret); }
  .input:disabled { color: var(--soft); background: color-mix(in srgb, var(--chrome) 6%, transparent); }
  select { padding: 5px 26px 5px 10px; border: 1px solid var(--rule); border-radius: 7px; color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; appearance: none;
    background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E") no-repeat right 7px center / 14px; }
  select:disabled { color: var(--soft); cursor: default; background-image: none; padding-right: 10px; }
  select option { color: initial; }
  .badge { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .badge.strong { color: var(--bg); background: var(--fg-strong); }
  dialog { width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px; border: 1px solid var(--panel-border); border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font-size: 14px; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.18); }
  dialog h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: var(--fg-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog label { display: block; margin: 0 0 4px; font-size: 12.5px; color: var(--soft); }
  dialog .field { display: flex; align-items: center; margin-bottom: 12px; border: 1px solid var(--rule); border-radius: 8px; background: color-mix(in srgb, var(--chrome) 6%, transparent); padding: 0 10px; }
  dialog .field:focus-within { border-color: var(--caret); }
  dialog .field span { color: var(--soft); white-space: nowrap; }
  dialog input { flex: 1; min-width: 0; padding: 8px 0; border: 0; outline: 0; background: transparent; color: var(--fg-strong); font: inherit; }
  .hint { margin: -6px 0 12px; font-size: 12px; color: var(--soft); min-height: 1em; }
  .hint:empty { display: none; }
  .hint.error { color: #c2410c; }
  dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  dialog button { font: 550 13px var(--font-text); height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
  dialog button.primary { border-color: var(--fg-strong); background: var(--fg-strong); color: var(--bg); }
  dialog button.act { height: 30px; padding: 0; border: 0; }
  @media (pointer: coarse) { dialog input, .input { font-size: 16px; } }
  .empty { margin: 0; padding: 48px 24px; border: 1px dashed var(--rule); border-radius: 12px; text-align: center; color: var(--soft); }
  @media (max-width: 520px) { .note { display: none; } main { padding: 88px 16px 64px; } h1 { font-size: 26px; } }
  /* Touch: room for a finger. */
  @media (pointer: coarse) { .new, .pill, .input { height: 40px; } .act { width: 40px; height: 40px; } }
`;

/** The footer at the foot of Erga's own pages (not the editor's, nor a document's): the copyright, this year. */
export const siteFooter = () => `<footer class="site-foot">© ${new Date().getUTCFullYear()} Erga</footer>`;

/** One step of the breadcrumbs: a page above this one (with its address), or this page (without). */
export interface Crumb { label: string; href?: string }

/**
 * The breadcrumbs in the upper left of every page for someone signed in: the wordmark (back to the front page), then
 * the pages above this one, then this one. `here` is the tag of this page's own crumb (the admin pages' is their <h1>).
 */
export function crumbs(session: Session | null, trail: Crumb[], here = "span"): string {
  const steps = trail.map((c) => c.href
    ? `<a class="crumb" href="${esc(link(c.href, session))}">${esc(c.label)}</a>`
    : `<${here} class="here" aria-current="page"><span>${esc(c.label)}</span></${here}>`).join("");
  return `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="${esc(link("/", session))}" draggable="false"><span>${WORDMARK}</span></a>${steps}</nav>`;
}

/**
 * The viewer's breadcrumbs (VIEW_STYLE), for someone signed in: Erga › Documents › the document, as the editor's
 *. The front page's are the wordmark alone; a test person's skip Documents, as they have none. An agent sees none.
 */
/** The breadcrumbs' type (Inter, as the editor's), for a page that shows them (viewCrumbs) but has none of the app's style. */
export const crumbsFont = (session: Session | null) => session && !session.agent ? `<link rel="stylesheet" href="/fonts/inter.css">` : "";

export function viewCrumbs(session: Session | null, title: string | null): string {
  if (!session || session.agent) return "";
  const docs = session.test ? "" : `<a class="erga-crumb" href="${esc(link("/docs", session))}">Documents</a>`;
  const here = title == null ? "" : `${docs}<span class="erga-here" aria-current="page"><span>${esc(title)}</span></span>`;
  return `<nav class="erga-crumbs" aria-label="Breadcrumbs"><a class="erga-brand" href="${esc(link("/", session))}"><span>${WORDMARK}</span></a>${here}</nav>`;
}

/** Every <time datetime> in the reader's own language and zone: "5 minutes ago", "yesterday", the date. */
export const TIMES_SCRIPT = `
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.dateTime), s = (d - Date.now()) / 1000;
    t.title = d.toLocaleString();
    if (s > -60) t.textContent = "just now";
    else if (s > -3600) t.textContent = rtf.format(Math.round(s / 60), "minute");
    else if (s > -86400) t.textContent = rtf.format(Math.round(s / 3600), "hour");
    else if (s > -30 * 86400) t.textContent = rtf.format(Math.round(s / 86400), "day");
    else t.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
`;

export const ICON = {
  delete: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M18.5 8v6M15.5 11h6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.75 7.5 4.5 4.5-4.5 4.5"/></svg>`,
  /** Share with an agent: the editor's (client/editor.html, #btn-share). */
  agent: `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(0.8824) translate(-12 -12)" stroke-width="1.8133"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M8 11.5H6.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H16"/></g></svg>`,
};

/** The page around a view (/docs, /admin): its title, the shared look and the view's own style. */
export const appPage = (title: string, style: string, body: string, footer = true) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Erga</title>
${FAVICON_LINK}
<link rel="stylesheet" href="/fonts/inter.css">
<link rel="stylesheet" href="/style.css">
<style>${APP_STYLE}${style}</style>
${body}
${footer ? siteFooter() : ""}
</html>`;

/** Who a document is shared with, as its row in the list says it (the owner's own view). */
function sharedNote(d: Listed): string {
  if (!d.shared) return "";
  return `<span class="note shared" title="Shared with ${d.shared} besides you">Shared</span>`;
}

/** The documents view: yours and those shared with you, with new, open, share and delete. */
function docsPage(session: Session, docs: Listed[], now: number, hours: number | null): string {
  const rows = docs.map((d) => {
    const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
    const mine = d.role == "owner";
    const note = !mine ? `<span class="note" title="Shared with you by ${esc(d.owner)}">${esc(d.owner)} · ${d.role == "editor" ? "can edit" : "view only"}</span>`
      : d.path != null ? `<span class="note" title="${esc(d.path)}">On disk</span>`
      : left != null ? `<span class="note" title="${hours == null ? "Made when unedited documents were deleted: it still goes unless someone edits it" : `A document nobody edits is deleted ${hours} hours after it's made`}">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    // One opened from disk only comes off the list: its files stay where they are.
    const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
    // The whole row opens the document (the link stretches over it); its buttons sit on top.
    return `  <li>
    <div class="name"><button type="button" class="twist" aria-expanded="false" aria-controls="pages-${esc(d.id)}" aria-label="Pages of ${esc(d.title)}" data-tip="Pages" data-id="${esc(d.id)}" data-base="/${esc(d.owner)}/${esc(d.slug)}" data-title="${esc(d.title)}"${d.role == "viewer" ? "" : " data-edit"}>${ICON.chevron}</button><a class="doc" href="${esc(link(`/${d.owner}/${d.slug}`, session))}#edit"><span class="title">${esc(d.title)}</span></a>${note}${mine ? sharedNote(d) : ""}</div>
    <time datetime="${when}">${ago(d.modified, now)}</time>
    <div class="acts">${mine ? `<button type="button" class="act share" aria-label="Share ${esc(d.title)}" data-tip="Share" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-address="/${esc(d.owner)}/${esc(d.slug)}">${ICON.share}</button>
    <form method="post" action="${esc(link("/docs/delete", session))}" data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" data-tip="${remove}">${ICON.delete}</button></form>` : ""}</div>
  </li>`;
  }).join("\n");
  const style = `
  /* Rows, and the labels over them, in three columns: the name (its title and what's special about it), when it was edited, its buttons. */
  .labels, ol.rows > li { display: grid; grid-template-columns: minmax(0, 1fr) 10rem 64px; align-items: center; column-gap: 16px; }
  .labels { padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 12px; font-weight: 500; color: var(--chrome); }
  ol.rows > li { position: relative; }
  /* No rules between documents: only the one under the labels. */
  ol.rows > li, ol.rows > li:first-child { border: 0; }
  ol.rows { padding-top: 6px; }
  .name { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 11px 0; }
  .doc { flex: 0 1 auto; padding: 0; }
  .doc::after { content: ""; position: absolute; inset: 0; }
  .acts { position: relative; z-index: 1; }
  .name { gap: 12px; }
  /* A document's pages (pages-tree.js, loaded once the list is up): the chevron left of its title opens them beneath its row. */
  .twist { position: relative; z-index: 1; flex: none; display: grid; place-items: center; width: 22px; height: 22px; margin: 0 -8px 0 -4px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--chrome); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
  .twist svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 150ms ease; }
  .twist:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .twist[aria-expanded="true"] svg { transform: rotate(90deg); }
  .twist:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .labels span:first-child { padding-left: 22px; }
  ol.rows > li.sub { display: block; padding: 0 0 10px 18px; }
  ol.rows > li.sub[hidden] { display: none; }
  .sub-tree { max-width: 560px; }
  .sub-tree.error { margin: 0; font-size: 13px; color: #c2410c; }
  /* Before the tree's script runs: a quiet line where its rows go, faded in only if it lasts. */
  .sub-wait { margin: 0; padding: 6px 4px 6px 26px; font-size: 12.5px; color: var(--soft); animation: sub-wait 150ms 120ms both; }
  @keyframes sub-wait { from { opacity: 0; } }
  @media (pointer: coarse) { .twist { width: 34px; height: 34px; margin: 0 -10px 0 -10px; } }
  .title { transition: color 120ms ease; }
  li:hover .title { color: var(--link); }
  .note, .shared { padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--soft); background: color-mix(in srgb, var(--chrome) 13%, transparent); }
  time { margin: 0; text-align: left; }
  /* The buttons (only on your own documents) take the same room on every row, so the times line up. */
  .acts { display: flex; justify-content: flex-end; gap: 2px; }
  /* Help text on the buttons, as the editor's: plain, under the pointer, following it (server/account-menu.ts moves it). */
  .acts .act { position: relative; }
  .acts .act[data-tip]::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); z-index: 40;
    white-space: pre; font: 400 12px/1.3 var(--font-text); letter-spacing: 0.01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .acts .act[data-tip]:hover::after { opacity: 1; } }
  @media (pointer: coarse) { .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) 8rem 84px; } }
  @media (max-width: 520px) { .labels { display: none; } .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) auto 64px; } }
  @media (pointer: coarse) { .delete { margin-right: -6px; } }
  /* Sharing: who has it, anyone with the link, and adding someone. */
  #share { width: min(460px, calc(100vw - 32px)); }
  #share .add { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  #share .add .field { flex: 1; margin: 0; }
  .people { list-style: none; margin: 0 0 14px; padding: 0; max-height: 40vh; overflow: auto; }
  .people li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--rule); }
  .people li:last-child { border-bottom: 1px solid var(--rule); }
  .people .face { position: relative; flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; overflow: hidden; font-size: 12px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 16%, transparent); text-transform: uppercase; }
  .people .face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .people .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); }
  .people .who small { margin-left: 6px; font-size: 12px; color: var(--soft); }
  .people .pending { color: #c2410c; }
  .people .fixed { font-size: 13px; color: var(--soft); padding-right: 4px; }
  .people .act { opacity: 1; width: 26px; height: 26px; }
  .anyone { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
  .anyone .face svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; }
  .anyone .who { flex: 1; color: var(--fg-strong); }
  .anyone .who small { display: block; font-size: 12px; color: var(--soft); }
  #share .buttons { justify-content: space-between; }
`;
  const count = `${docs.length} document${docs.length == 1 ? "" : "s"}`;
  return appPage("Documents", style, `${crumbs(session, [{ label: "Documents" }])}<main>
  <header>
    <div><h1>Documents</h1>${docs.length ? `<p class="sub">${count}</p>` : ""}</div>
    <a class="pill" href="${esc(link("/new", session))}" title="New document" aria-label="New document">${ICON.plus}New</a>
  </header>
  ${docs.length ? `<div class="labels" aria-hidden="true"><span>Name</span><span>Edited</span><span></span></div>
  <ol class="rows">\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank${hours == null ? "." : `, and goes away after ${hours} hour${hours == 1 ? "" : "s"} if you never edit it.`}</p>`}
</main>
<dialog id="share" aria-labelledby="share-title" data-action="${esc(link("/docs/share", session))}" data-me="${esc(session.login.toLowerCase())}">
  <h2 id="share-title">Share</h2>
  <form class="add">
    <div class="field"><input name="login" placeholder="A GitHub login" aria-label="GitHub login to share with" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
    <select name="role" aria-label="Their role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
    <button class="primary">Add</button>
  </form>
  <ul class="people" aria-label="People with access"></ul>
  <div class="anyone">
    <span class="face" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5Z"/></svg></span>
    <label class="who" for="share-anyone">Anyone signed in with the link<small>Anyone who can sign in to this server</small></label>
    <select id="share-anyone"><option value="none">No access</option><option value="viewer">Can view</option><option value="editor">Can edit</option></select>
  </div>
  <p class="hint" id="share-hint" role="status"></p>
  <div class="buttons"><button type="button" class="copy">Copy link</button><button type="button" class="primary done">Done</button></div>
</dialog>
<script>
  // Times in the reader's own language and zone, and a question before deleting.
  ${TIMES_SCRIPT}
  for (const f of document.querySelectorAll("form[data-title]")) {
    const q = "disk" in f.dataset ? "Take “" + f.dataset.title + "” off your list? Its files stay where they are." : "Delete “" + f.dataset.title + "”? This can't be undone.";
    f.addEventListener("submit", (e) => { if (!confirm(q)) e.preventDefault(); });
  }
  // Sharing: each change is saved as it's made (POST /docs/share), and the list follows when the dialog closes.
  const share = document.getElementById("share"), action = share.dataset.action, me = share.dataset.me;
  const people = share.querySelector(".people"), adder = share.querySelector("form.add"), anyone = document.getElementById("share-anyone");
  const shareHint = document.getElementById("share-hint");
  const tell = (text, error) => { shareHint.textContent = text; shareHint.classList.toggle("error", !!error); };
  let doc = null, changed = false;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const ROLES = [["editor", "Can edit"], ["viewer", "Can view"]];
  const roleSelect = (role, label) => {
    const s = el("select", { ariaLabel: label });
    for (const [v, t] of ROLES) s.append(el("option", { value: v, textContent: t, selected: v == role }));
    return s;
  };
  function render({ permissions, notUsers, avatars }) {
    people.replaceChildren();
    const pending = new Set(notUsers || []);
    let all = "none";
    for (const p of permissions) {
      if (p.login == "*") { all = p.role; continue; }
      const who = el("span", { className: "who", textContent: p.login });
      if (p.login == me) who.append(el("small", { textContent: "you" }));
      if (pending.has(p.login)) who.append(el("small", { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" }));
      const face = el("span", { className: "face", ariaHidden: "true", textContent: p.login[0] });
      const pic = avatars?.[p.login];
      if (pic) { const img = el("img", { src: pic, alt: "", draggable: false }); img.addEventListener("error", () => img.remove()); face.append(img); }
      const li = el("li", {}, face, who);
      if (p.role == "owner") li.append(el("span", { className: "fixed", textContent: "Owner" }));
      else {
        const s = roleSelect(p.role, "Role for " + p.login);
        s.addEventListener("change", () => change(p.login, s.value));
        const x = el("button", { type: "button", className: "act", title: "Stop sharing with " + p.login, ariaLabel: "Stop sharing with " + p.login, innerHTML: ${JSON.stringify(ICON.close)} });
        x.addEventListener("click", () => change(p.login, "none"));
        li.append(s, x);
      }
      people.append(li);
    }
    anyone.value = all;
  }
  async function call(init) {
    const r = await fetch(init ? action : action + (action.includes("?") ? "&" : "?") + "id=" + doc.id, init ? { method: "POST", body: new URLSearchParams(init), headers: { Accept: "application/json" } } : {}).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  async function change(login, role) {
    tell("Saving…");
    try { render(await call({ id: doc.id, login, role })); changed = true; tell(""); return true; }
    catch (e) { tell(e.message, true); return false; }
  }
  for (const b of document.querySelectorAll("button.share")) b.addEventListener("click", async () => {
    doc = { id: b.dataset.id, title: b.dataset.title, address: b.dataset.address };
    share.querySelector("h2").textContent = "Share “" + doc.title + "”";
    people.replaceChildren();
    adder.reset();
    tell("Loading…");
    share.showModal();
    adder.elements.login.focus();
    try { render(await call()); tell(""); } catch (e) { tell(e.message, true); }
  });
  adder.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = adder.elements.login.value.trim().replace(/^@/, "");
    if (login && (await change(login, adder.elements.role.value))) adder.elements.login.value = "";
  });
  anyone.addEventListener("change", () => change("*", anyone.value));
  share.querySelector(".copy").addEventListener("click", async () => {
    const url = location.origin + doc.address;
    try { await navigator.clipboard.writeText(url); tell("Link copied: " + url); } catch { tell(url); }
  });
  share.querySelector(".done").addEventListener("click", () => share.close());
  share.addEventListener("close", () => { if (changed) location.reload(); });
  // A document's pages, beneath its row: the tree. The script loads once the list is up and the tab is idle, and a
  // document's pages are read as the pointer heads for its row, together, so a click shows them at once. Each document's last
  // answer is kept for the tab: opened again, or on the next visit, its pages show straight away, and are read again behind.
  // Pages open in the editor for those who may edit, in the viewer otherwise. Which are open is remembered for the tab.
  let treeJs = null;
  const loadTree = () => window.ergaTree ? Promise.resolve(window.ergaTree) : (treeJs ??= new Promise((ok, no) => {
    const s = Object.assign(document.createElement("script"), { src: "/pages-tree.js" });
    s.onload = () => window.ergaTree ? ok(window.ergaTree) : no(new Error("Couldn't load the pages."));
    s.onerror = () => { treeJs = null; s.remove(); no(new Error("Couldn't load the pages: check your connection and try again.")); };
    document.head.append(s);
  }));
  (window.requestIdleCallback ?? setTimeout)(() => loadTree().catch(() => {}));
  const treeQuery = ${JSON.stringify(session.as ? `?user=${encodeURIComponent(session.as)}` : "")};
  // A tree read ahead of the click, handed to the tree for its first read (once), if it's still fresh.
  const ahead = new Map();
  const readAhead = (id) => {
    const a = ahead.get(id);
    if (a && Date.now() - a.at < 10000) return;
    const answer = fetch("/api/docs/" + encodeURIComponent(id) + "/tree" + treeQuery, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    answer.catch(() => {});
    ahead.set(id, { at: Date.now(), answer });
  };
  const fetchFor = (id) => (url, init) => {
    const a = ahead.get(id);
    if (a && (!init || !init.method || init.method == "GET")) { ahead.delete(id); if (Date.now() - a.at < 10000) return a.answer.then((r) => r.clone(), () => fetch(url, init)); }
    return fetch(url, init);
  };
  const keptKey = (id) => "erga:docs-tree:" + id;
  const kept = (id) => { try { return JSON.parse(sessionStorage.getItem(keptKey(id)) || "null"); } catch { return null; } };
  const keep = (id, answer) => { try { sessionStorage.setItem(keptKey(id), JSON.stringify({ entries: answer.entries, canEdit: answer.canEdit })); } catch {} };
  const openKey = "erga:docs-open";
  const opened = new Set((() => { try { return JSON.parse(sessionStorage.getItem(openKey) || "[]"); } catch { return []; } })());
  const saveOpened = () => { try { sessionStorage.setItem(openKey, JSON.stringify([...opened])); } catch {} };
  const trees = new Map(), readAt = new Map();
  async function showPages(b, open) {
    const id = b.dataset.id;
    b.setAttribute("aria-expanded", String(open));
    if (open) opened.add(id); else opened.delete(id);
    saveOpened();
    let sub = document.getElementById("pages-" + id);
    // Opened again: its pages are there already; read again only if they're more than a few seconds old.
    if (sub) { sub.hidden = !open; if (open && Date.now() - (readAt.get(id) ?? 0) > 4000) trees.get(id)?.refresh({ quiet: true }); return; }
    if (!open) return;
    readAhead(id);
    sub = Object.assign(document.createElement("li"), { id: "pages-" + id, className: "sub" });
    const box = Object.assign(document.createElement("div"), { className: "sub-tree" });
    // Until the tree's script runs: the pages kept from before, or a quiet line saying they're on their way.
    box.append(Object.assign(document.createElement("p"), { className: "sub-wait", textContent: "Loading pages…" }));
    sub.append(box);
    b.closest("li").after(sub);
    try {
      const t = await loadTree();
      box.replaceChildren();
      trees.set(id, t.mountTree(box, { id, base: b.dataset.base, editing: "edit" in b.dataset, query: treeQuery, rootTitle: b.dataset.title, label: "Pages of " + b.dataset.title,
        initial: kept(id), fetch: fetchFor(id), onChange: (a) => { readAt.set(id, Date.now()); keep(id, a); } }));
    } catch (e) { box.className = "sub-tree error"; box.textContent = e.message; }
  }
  for (const b of document.querySelectorAll("button.twist")) {
    // The pointer resting on a row (or the chevron focused, or touched): its pages are read, and the script fetched.
    let rest = 0;
    const li = b.closest("li");
    const ready = () => { if (!trees.has(b.dataset.id)) readAhead(b.dataset.id); loadTree().catch(() => {}); };
    li.addEventListener("pointerenter", () => { clearTimeout(rest); rest = setTimeout(ready, 60); });
    li.addEventListener("pointerleave", () => clearTimeout(rest));
    b.addEventListener("focus", ready);
    b.addEventListener("pointerdown", ready);
    b.addEventListener("click", () => showPages(b, b.getAttribute("aria-expanded") != "true"));
    if (opened.has(b.dataset.id)) showPages(b, true);
  }
  // Changes made elsewhere (another tab, an agent) show here too: the open trees are read again when the tab comes back,
  // and every few seconds while it's in view. Quietly: never while someone is naming, moving or deleting something in one.
  const refreshOpen = () => { for (const [id, t] of trees) if (!document.getElementById("pages-" + id)?.hidden) t.refresh({ quiet: true }); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState == "visible") refreshOpen(); });
  setInterval(() => { if (document.visibilityState == "visible") refreshOpen(); }, 4000);
</script>`);
}

/**
 * Only paths on this site: "/koomen/abc", never "//elsewhere" or a full URL.
 * No backslashes or control characters either: browsers read "/\elsewhere"
 * as "//elsewhere", and drop tabs and newlines ("/\t/elsewhere").
 */
export const safeNext = (next: string | null) => (next && next.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(next) && !next.startsWith("//") ? next : "/");

/**
 * A request that another site started (its link, form or image), as the
 * browser reports it. Clients that don't say (scripts, tests) aren't
 * browsers carrying someone's cookie, so they count as this site.
 */
export const fromElsewhere = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  return site != null && site != "same-origin" && site != "none";
};

/**
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button style="font:inherit;font-weight:600;padding:8px 16px;border:0;border-radius:10px;background:#1b2330;color:#fff;cursor:pointer">${esc(button)}</button></form>`, 200);

const signInFirst = (next: string) => new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(safeNext(next))}` } });

/**
 * POST <document>/api/share {rotate}: the share button's token, the
 * person's one 'share' token, the same each time until rotated.
 */
async function shareToken(platform: Platform, request: Request, session: Session): Promise<Response> {
  const refuse = (error: string) => Response.json({ ok: false, error }, { status: 403 });
  if (session.agent) return refuse("An agent can't make tokens.");
  const origin = request.headers.get("origin");
  if (origin && origin != new URL(request.url).origin) return refuse("Forbidden");
  const body = (await request.json().catch(() => ({}))) as { rotate?: unknown };
  const { token } = await platform.tokens.share({ login: session.login, name: session.name, testBy: session.test?.by }, body?.rotate === true);
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * A request for the document's host: the path inside the document, its
 * public address, who's asking and whether they may edit or only view
 * (never what the browser claimed: those headers are replaced), and whether
 * it's an agent with a token.
 */
export function forwarded(request: Request, url: URL, rest: string, base: string, session: Session | null, access: "edit" | "view" | null): Request {
  const inner = new URL(rest + url.search, url.origin);
  const headers = new Headers(request.headers);
  headers.delete("x-erga-person");
  headers.delete("x-erga-access");
  headers.delete("x-erga-agent");
  headers.delete("x-erga-via");
  headers.delete("authorization");
  headers.set("x-erga-base", base);
  if (session) headers.set("x-erga-person", JSON.stringify({ id: session.login.toLowerCase(), name: session.name }));
  if (session && access) headers.set("x-erga-access", access);
  // Only an agent token's request may call a document's external agent tools.
  if (session?.agent) headers.set("x-erga-agent", session.agent.id);
  // How the person acts there: through this token's agent, by its label (JSON: a header is ASCII).
  if (session?.agent) headers.set("x-erga-via", JSON.stringify(VIA.token(session.agent.label)).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  return new Request(inner, { method: request.method, headers, body: request.body, redirect: "manual" });
}

/** A small page for when there's nothing to show, or something about signing in goes wrong. */
export function page(title: string, html: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Erga</title>${FAVICON_LINK}
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;color:#1b2330;background:#f7f8fa}h1{font-size:1.4rem}a{color:#1f5f8b}
.site-foot{position:fixed;left:0;right:0;bottom:24px;text-align:center;font-size:13px;color:#8a93a1}
@media(prefers-color-scheme:dark){body{color:#e4e8ee;background:#12161d}a{color:#7fb6e0}}</style><h1>${title}</h1><p>${html}</p>${siteFooter()}`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
