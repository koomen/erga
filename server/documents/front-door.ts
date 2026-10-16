// The front door for documents (server/app.ts hands it every document address,
// on erga.dev and in local development alike). It's written against web
// Requests and Responses, and the Worker supplies the rest (`Platform`):
// who's signed in, the templates, the directory of documents (server/directory/,
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

import { resolvePage } from "../../document/pages.ts";
import { VIA } from "../../shared/attribution.ts";
import { adminDoor } from "../admin/index.ts";
import { ID, OWNER, type Route } from "../directory/index.ts";
import { accessOf, type Platform, type Session, whoOf } from "../platform.ts";
import { viewLanding } from "./landing.ts";
import { deleteDoc, listDocs, newDoc, shareDoc, shareToken } from "./make.ts";
import { pagesDoor, pagesHost } from "./pages-origin.ts";
import { viewDocument } from "./view.ts";
import { esc, OWN_ACCOUNT, page, signInFirst } from "../pages/index.ts";

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
  if (answer.status == 101) return answer;
  // A document's files (an HTML page, an SVG) are its authors' code. Here, on this site's own origin, they run in a
  // sandbox of their own (an opaque origin, no scripts): opened at this address, a page's script would otherwise act as
  // whoever opened it, with their session. Pages run on their pages origin (pagesDoor), never here.
  const headers = new Headers(answer.headers);
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  // A document's own files are its own: nothing of the site's goes into them.
  if (/^text\/html\b/i.test(answer.headers.get("content-type") ?? "")) headers.set(OWN_ACCOUNT, "1");
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

/** Whether two paths are the same address, however each is percent-encoded. */
const samePath = (a: string, b: string) => {
  try { return decodeURIComponent(a) == decodeURIComponent(b); } catch { return a == b; }
};

/** A document that's there, at a page that isn't. */
const noPage = (address: string) => page("Not found", `This document has no page here. <a href="${esc(address)}">Go to its first page</a>.`, 404);

const refused = (session: Session) => session.test
  ? page("Test documents only", "Test people can open only test documents.", 403)
  : page("Not shared with you", `This document hasn't been shared with <b>${esc(session.login)}</b>. Ask its owner to share it with you.`, 403);

/**
 * How to reach the document at /<first>/<second>, for the requests under
 * it. By id it's remembered (an id is never another of the owner's slugs,
 * server/directory/), so a document's many subrequests rarely ask the database.
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
