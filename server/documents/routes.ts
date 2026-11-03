// The app for documents (server/app.ts hands it every document address,
// on erga.dev and in local development alike). It's written against web
// Requests and Responses, and the Worker supplies the rest (`Platform`):
// who's signed in, the templates, the directory of documents (server/directory/,
// in D1) and the documents themselves (Durable Objects).
//
//   /                          the homepage: the viewer on the landing document (a setting), for anyone
//   /new                       a blank document for you, in the editor (signs you in first); /new?template=<id> one from
//                              a template; /new?from=landing a copy
//                              of the homepage's, /new?from=<id> of another you may open (the viewer's Clone)
//   /docs                      your documents, latest edit first (delete and share are operations: POST /api/tools/<name>)
//   /admin                     the server's settings and users, for admins (each change an operation: POST /api/tools/<name>)
//   /<owner>/<slug>            the viewer on that document (for those it's shared with; for people not signed in, a
//                              document shared with anyone with the link while the server lets people share publicly): its canonical address;
//                              Clone, and Edit for those who may edit it
//   /<owner>/<slug>?edit       the editor on it, under Documents (its breadcrumbs): the same page, which
//                              goes into the editor (the pencil goes there and back without a reload)
//   /_home[/<page>]            the homepage project (nobody's: document/names.ts), as /<owner>/<slug>[/<page>] above
//   /<owner>/<slug>/<page>     another of its pages (document/pages.ts: blog is blog.html, else blog/index.html), ?edit
//                              for its editor; never with a slash added at the end
//   /<owner>/<id>, /<owner>/<old slug>, /d/<id> (and pages under them)
//                              redirect there
//   POST /d/<id>/api/key       an edit key for the document's page (edit-key.ts): with it, the page opens the document's
//                              socket and puts dropped files into its files, from the pages origin, as the person it names
//   /d/<id>/<rest>             the document's own host: /api/..., /doc/..., the sockets; the
//                              editor uses this address, which never changes. Under any of the
//                              addresses above it works too (older tabs and share links use them).
//
// Who may open, edit, rename, delete or share a document is the directory's
// rule (`Directory.decide`, from the document's permissions). For a request to
// a document, its host applies it, on the copy of its permissions it keeps
// (document/document.ts, authorize): the app says only who's asking
// (x-erga-who), and asks the database nothing. The viewer's page asks the host
// once for everything (view.ts).
//
// The server's API for agents (/api/..., /mcp, /llms.txt) and /tokens are
// server/api.ts's.
//
// Anywhere, "Authorization: Bearer erga_..." (an agent token, server/identity)
// signs in as the person it stands for, as their agent (Session.agent), with
// that person's permissions.
//
// Signing in, the editor's own files and the WebSockets stay with the
// Worker.

import * as Effect from "effect/Effect";
import { adminRoutes, isAdminPath } from "../admin/index.ts";
import { ID, OWNER, type Route, type Who } from "../directory/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { HOME_OWNER, HOME_SLUG } from "../../document/names.ts";
import { listDocs, newDoc, shareToken } from "./make.ts";
import { adoptLanding, landingDocument } from "./landing.ts";
import { pagesOrigin, pagesRoutes, pagesHost } from "./pages-origin.ts";
import { editKey, type KeyPerson, keyWho, readEditKey } from "./edit-key.ts";
import { viewAddress, viewLanding, viewPublic } from "./view.ts";
import { OWN_ACCOUNT, page, signInFirst } from "../pages/index.ts";
import { call, ctx, fromWeb, plainJson, text, type Route as HttpRoute } from "../http.ts";

/** The app's answer to a request, for any path (a page saying so when there's nothing there). */
export const documentRoutes: HttpRoute = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const path = url.pathname;
  const pages = pagesHost(url, platform);
  if (pages) return yield* pagesRoutes(pages);
  if (path == "/") return yield* viewLanding;
  if (path == "/new") return yield* newDoc;
  if (path == "/docs") return yield* listDocs;
  if (isAdminPath(path)) return yield* adminRoutes;

  // The homepage project's address, /_home[/<page>], is its row's /<HOME_OWNER>/<HOME_SLUG> (document/names.ts).
  const home = /^\/_home(\/.*)?$/.exec(path);
  // There's one from the first time anyone asks (made, or the homepage from before made the project: landing.ts).
  if (home)
    yield* call(async () => {
      await adoptLanding(platform);
      if (!(await platform.directory.locate(HOME_OWNER, HOME_SLUG))) await landingDocument(platform);
    });
  const routed = home ? `/${HOME_OWNER}/${HOME_SLUG}${home[1] ?? ""}` : path;
  const [, first, second, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(routed) ?? [];
  const nothing = () => page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);
  if (!first || (first != "d" && !OWNER.test(first))) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const session = yield* call(() => platform.sessionOf(request));

  // A document's address is the document: /<owner>/<slug>, and /<page> after it for its other pages. Its editor
  // is the same page with ?edit. Sign in first, then the page, at its canonical address.
  // /api/... and /doc/... under it are the document's host (so no page or folder at its top may be called api or doc).
  if (!/^\/(api|doc)(\/|$)/.test(rest ?? "")) {
    // Not signed in: a document shared publicly opens for them, to view (Directory.isPublic); any other, sign in first.
    if (!session) return (yield* viewPublic(first, second, (rest ?? "").replace(/^\/+|\/+$/g, ""))) ?? signInFirst(path + url.search);
    if (first == "d" && !ID.test(second)) return nothing();
    return yield* viewAddress(session, first, second, (rest ?? "").replace(/^\/+|\/+$/g, ""));
  }
  // By id (the editor's address), the document's host is asked straight away: it says whether there's such a document.
  const route =
    first == "d"
      ? ID.test(second)
        ? { id: second, owner: "", test: false }
        : null
      : yield* call(() => documentRoute(platform, first, second));
  if (!route) return text("No such document", 404);
  // A document's tools are the server's one API's (POST /api/tools/<name>, with "document"): the host's own route for
  // them is the server's to call (forwardedAs), never reached from outside; so is a person's agent's "turn done".
  if (/^\/api\/tools(\/|$)|^\/api\/agent\/done$/.test(rest))
    return plainJson(
      {
        ok: false,
        error: `A document's tools are at POST ${url.origin}/api/tools/<name>, with the document as "document". Or use the MCP server: ${url.origin}/mcp`,
      },
      404
    );
  // From the document's own page, on its pages origin (which has no cookies), with an edit key (edit-key.ts): its socket,
  // the files dropped on it (PUT /api/files/<path>), and the browser's preflight. As the person the key
  // names, never as a cookie that came with it; the document decides what they may do.
  const key = url.searchParams.get("key");
  if (key != null && keyed(request, rest)) {
    const doc = yield* call(() => platform.directory.route(route.id));
    const origin = doc ? pagesOrigin(doc.owner, doc.id, url, platform) : "";
    if (!doc || request.headers.get("origin") != origin) return text("Not from this document's page", 403);
    const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    if (request.method == "OPTIONS")
      return plainJson(null, 204, {
        ...cors,
        "Access-Control-Allow-Methods": "PUT, POST",
        "Access-Control-Allow-Headers": "content-type, x-erga-sha256",
        "Access-Control-Max-Age": "600",
      });
    const person = yield* call(() => readEditKey(platform.secret, key, doc.owner, doc.id));
    if (!person) return text("This key has expired: reload the page.", 403, cors);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    const inner = new URL(url);
    inner.searchParams.delete("key");
    const answer = yield* call(() =>
      platform.docs.fetch(
        route,
        forwardedAs(
          new Request(inner, { method: request.method, headers, body: request.body }),
          inner,
          rest,
          person,
          keyWho(person, doc.id)
        )
      )
    );
    if (answer.status == 101) return fromWeb(answer);
    const out = new Headers(answer.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return fromWeb(new Response(answer.body, { status: answer.status, headers: out }));
  }
  if (!session) return text("Sign in first", 401);
  // The edit key for the document's page (edit-key.ts): for whoever may open the document, asked by this site's own page.
  if (rest == "/api/key" && request.method == "POST") {
    const origin = request.headers.get("origin");
    if (session.agent || (origin && origin != url.origin)) return text("Not allowed", 403);
    const doc = yield* call(() => platform.directory.route(route.id));
    if (!doc || !(yield* call(() => platform.directory.access(whoOf(session), doc)))) return text("Not allowed", 403);
    const person = {
      login: session.login,
      name: session.name,
      ...(session.avatar && !session.test ? { avatar: session.avatar } : {}),
      ...(session.test ? { testBy: session.test.by } : {}),
      ...(whoOf(session).admin ? { admin: true } : {}),
    };
    return plainJson(yield* call(() => editKey(platform.secret, doc.owner, doc.id, person)), 200, { "Cache-Control": "no-store" });
  }
  // The share button's token is the app's, not the document's: for whoever may open the document.
  if (rest == "/api/share" && request.method == "POST") {
    const doc = yield* call(() => platform.directory.route(route.id));
    if (!doc || !(yield* call(() => platform.directory.access(whoOf(session), doc)))) return text("Not allowed", 403);
    return yield* shareToken(session);
  }
  // The document's sockets (its room, its events) are opened by this site's own pages: a page of another origin, even
  // of this site (another subdomain, which the session cookie reaches), may not open one as whoever's signed in.
  const origin = request.headers.get("origin");
  if (request.headers.get("upgrade")?.toLowerCase() == "websocket" && origin && origin != url.origin)
    return text("Not from this site", 403);
  // Who's asking: the document decides what they may do (document/document.ts, authorize), and refuses the rest.
  const answer = yield* call(() => platform.docs.fetch(route, forwarded(request, url, rest, session)));
  if (answer.status == 101) return fromWeb(answer);
  // A document's files (an HTML page, an SVG) are its authors' code. Here, on this site's own origin, they run in a
  // sandbox of their own (an opaque origin, no scripts): opened at this address, a page's script would otherwise act as
  // whoever opened it, with their session. Pages run on their pages origin (pagesRoutes), never here.
  const headers = new Headers(answer.headers);
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  // A document's own files are its own: nothing of the site's goes into them.
  if (/^text\/html\b/i.test(answer.headers.get("content-type") ?? "")) headers.set(OWN_ACCOUNT, "1");
  return fromWeb(new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers }));
});



/** What an edit key opens, from the document's page: its socket, and a file put into its files (and its preflight). */
const keyed = (request: Request, rest: string) =>
  (rest == "/api/room" && request.headers.get("upgrade")?.toLowerCase() == "websocket") ||
  (rest.startsWith("/api/files/") && (request.method == "PUT" || request.method == "OPTIONS"));

/** The person a request's edit key names (/<owner or d>/<doc>/api/... ?key=, what it opens), if it's good: for the staging guard. */
export async function keyedPerson(platform: Platform, request: Request, url: URL): Promise<KeyPerson | null> {
  const [, first, second, rest] = /^\/([^/]+)\/([^/]+)(\/api\/.*)$/.exec(url.pathname) ?? [];
  const key = url.searchParams.get("key");
  if (!first || !second || key == null || !keyed(request, rest)) return null;
  const route = await documentRoute(platform, first, second);
  const doc = route && (await platform.directory.route(route.id));
  return doc ? readEditKey(platform.secret, key, doc.owner, doc.id) : null;
}

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

// A document's page never runs as this site: its scripts, whoever wrote
// them, can't act as the person viewing it. It runs on an origin of its own,
// <id>-<owner>.erga-pages.dev (or <id>-<owner>.localhost:<port> on this
// machine), for readers and editors alike, in the viewer's one frame
// (view.ts), and the page editor reaches into it there (see libs/text/ui/bridge.ts).
// That origin has no cookies. It serves the document's files under a token,
// signed here, that opens this one document for a week; the viewer's page
// hands it out to whoever may open the document.

/**
 * A request for the document's host: the path inside the document, who's asking (x-erga-who: the document decides what they
 * may do), and whether it's an agent with a token; never what the browser
 * claimed: those headers are replaced. `checked`: a file read with a key the
 * app checked itself (the document's pages origin),
 * for nobody in particular.
 */
export function forwarded(request: Request, url: URL, rest: string, session: Session | null, checked?: "files"): Request {
  const person = session && {
    login: session.login,
    name: session.name,
    ...(session.avatar && !session.test ? { avatar: session.avatar } : {}),
  };
  return forwardedAs(request, url, rest, person, session && whoOf(session), checked);
}

/**
 * The same, for a caller the server itself vouches for: a person (and their picture), and who they are
 * (Who: how they act, `via`, when through one of their agents: an agent token's, or the editor's or admin's agent
 * reaching another document). Only such a request, from the server itself, may run a document tool in the document's
 * host (/api/tools/<name> there: agents/tools.ts, runInDocument), as the person's agent.
 */
export function forwardedAs(
  request: Request,
  url: URL,
  rest: string,
  person: { login: string; name: string; avatar?: string } | null,
  who: Who | null,
  checked?: "files"
): Request {
  const inner = new URL(rest + url.search, url.origin);
  const headers = new Headers(request.headers);
  for (const h of [
    "x-erga-person",
    "x-erga-access",
    "x-erga-who",
    "x-erga-checked",
    "x-erga-view",
    "x-erga-agent",
    "x-erga-via",
    "authorization",
  ])
    headers.delete(h);
  if (person)
    headers.set(
      "x-erga-person",
      ascii(JSON.stringify({ id: person.login.toLowerCase(), name: person.name, ...(person.avatar ? { avatar: person.avatar } : {}) }))
    );
  if (who) headers.set("x-erga-who", ascii(JSON.stringify(who)));
  if (checked) headers.set("x-erga-checked", checked);
  // Only an agent's request may call a document's agent tools; with how the person acts through it (JSON: a header is ASCII).
  if (who?.via) {
    headers.set("x-erga-agent", "1");
    headers.set("x-erga-via", ascii(JSON.stringify(who.via)));
  }
  return new Request(inner, { method: request.method, headers, body: request.body, redirect: "manual" });
}

/** JSON as a header holds it: ASCII, the rest escaped. */
const ascii = (json: string) => json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
