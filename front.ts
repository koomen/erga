// The front door: the app around the documents (worker/index.ts serves it,
// on erga.dev and in local development alike). It's written against web
// Requests and Responses, and the Worker supplies the rest (`Platform`):
// who's signed in, the templates, the directory of documents (directory.ts,
// in D1) and the documents themselves (Durable Objects).
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents, latest edit first; POST /docs/delete deletes one, /docs/rename renames one,
//                              /docs/share shares one (or stops sharing it)
//   /<owner>/<slug>            the editor on that document (for those it's shared with): its canonical address
//   /<owner>/<id>, /<owner>/<old slug>, /d/<id>
//                              redirect there
//   /d/<id>/<rest>             the document's own host (host.ts): /api/..., /doc/..., the sockets; the
//                              editor uses this address, which never changes. Under any of the
//                              addresses above it works too (older tabs and share links use them).
//
// Who may open, edit, rename, delete or share a document is the directory's
// to say (`Directory.may`, from the document's permissions); the front door
// asks it for every request, and tells the document's host whether the
// person may edit or only view (x-erga-access).
//
// Signing in, the editor's own files and the WebSockets stay with the
// Worker. The rule for when an unedited document goes (`afterUnedited`) is
// here; the document's alarm applies it.

import { type Directory, type DocRow, type Grant, type Route, type Who, NotAllowed, UNTITLED } from "./directory.ts";

/** Who's signed in. */
export interface Session {
  login: string;
  name: string;
  /** A test person, signed in with a test token minted by `by` (hosted only). */
  test?: { by: string };
  /** In local development, the name a tab gave in ?user=, carried along in the links it follows. */
  as?: string;
}

/** A document as its owner's list shows it. */
export interface Listed {
  id: string;
  owner: string;
  slug: string;
  title: string;
  titleSet: boolean;
  slugSet: boolean;
  created: number;
  /** When a file last changed (when it was made, if never). */
  modified: number;
  /** When it goes away if nobody edits it (only while it's never been edited). */
  expires?: number;
  /** In local development, a document that's a file or folder on disk: where it is. Deleting it leaves the files be. */
  path?: string;
}

/** What the front door needs from the platform it runs on. */
export interface Platform {
  /** Who's asking, if anyone is signed in (in local development, someone always is). */
  sessionOf(request: Request): Promise<Session | null>;
  /** The templates' text files, by template then path ("demo" → { "index.html": "..." }). */
  templates: Record<string, Record<string, string>>;
  /** The editor's page, served at each document's address. */
  editor(request: Request): Promise<Response>;
  /**
   * Local development: /new may name the document (?id=) and shorten its
   * unedited time (?unedited=<ms>), and /docs opens files from disk (the
   * dev server's /__erga/open, dev/plugin.ts).
   */
  dev(url: URL): boolean;
  /**
   * Where documents' pages run (see pagesOrigin): "erga-pages.dev", or
   * "localhost" for a request that came to this machine.
   */
  pagesDomain(url: URL): string;
  /** Signs the tokens that open a document's files on its pages origin. */
  secret: string;
  /** Every document's address, title and permissions; the server's users and settings. */
  directory: Directory;
  docs: {
    /**
     * Makes the host of a document already in the directory, from a
     * template's files; false if it already has one. Unless someone edits
     * it, it goes at `expires`.
     */
    create(doc: Route, files: Record<string, string>, index: string, opts: { test?: boolean; expires: number | null }): Promise<boolean>;
    exists(doc: Route): Promise<boolean>;
    /** Deletes a document (its host takes it out of the directory too); false if it had no host. */
    delete(doc: Route): Promise<boolean>;
    /** `owner`'s documents, most recently changed first. */
    list(owner: string): Promise<Listed[]>;
    /** Hands a request to the document's host, its path already the one inside the document. */
    fetch(doc: Route, request: Request): Promise<Response>;
  };
}

export const HOUR = 60 * 60 * 1000;

/**
 * When a document's unedited time is up: one that's been edited (or is a
 * test document) stays, one open somewhere waits an hour more, so it isn't
 * pulled from under someone about to type, and any other goes.
 */
export function afterUnedited(doc: { modified?: number; test?: boolean }, open: boolean, now: number): "keep" | "delete" | number {
  if (doc.modified || doc.test) return "keep";
  return open ? now + HOUR : "delete";
}

export const OWNER = /^[A-Za-z0-9-]{1,39}$/, ID = /^[a-z0-9]{8}$/;
/** Test documents: what test people may open, and where the scripted agent stands in for the model. */
export const TEST_ID = /^test[a-z0-9]{4}$/;
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** The front door's answer to a request, for any path (a page saying so when there's nothing there). */
export async function frontDoor(request: Request, platform: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const pages = pagesHost(url, platform);
  if (pages) return pagesDoor(request, url, pages, platform);
  if (path == "/") return viewDemo(platform, await platform.sessionOf(request));
  if (path == "/new") return newDoc(platform, request);
  if (path == "/docs") return listDocs(platform, request);
  if (path == "/docs/delete" && request.method == "POST") return deleteDoc(platform, request);
  if (path == "/docs/rename" && request.method == "POST") return renameDoc(platform, request);
  if (path == "/docs/share" && request.method == "POST") return shareDoc(platform, request);

  const [, first, second, rest] = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path) ?? [];
  const nothing = () => page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);
  if (!first || (first != "d" && !OWNER.test(first))) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const session = await platform.sessionOf(request);

  // The editor itself: sign in first, then the page that joins the document, at its canonical address.
  if (!rest || rest == "/") {
    if (!session) return signInFirst(path + url.search);
    const doc = await documentAt(platform, first, second);
    if (!doc) return nothing();
    if (!(await platform.directory.may(whoOf(session), "open", doc))) return refused(session);
    const canonical = `/${doc.owner}/${doc.slug}`;
    if (path != canonical && path != `${canonical}/`) return new Response(null, { status: 302, headers: { Location: canonical + url.search } });
    if (!(await platform.docs.exists(doc))) return nothing();
    // The page editor runs on the document's own origin, at an address that carries the token for its files.
    // The editor reaches its document's host at /d/<id>, which a rename never changes.
    const pagesUrl = `${pagesOrigin(doc.owner, doc.id, url, platform)}/t/${await pagesToken(platform.secret, doc.owner, doc.id, url.origin)}/`;
    const editor = (await (await platform.editor(request)).text())
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(doc.title)}</title>`)
      .replace("</head>", `<meta name="erga-pages" content="${esc(pagesUrl)}"><meta name="erga-base" content="/d/${doc.id}"></head>`);
    return new Response(editor, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const route = await documentRoute(platform, first, second);
  if (!route) return new Response("No such document", { status: 404 });
  // An external agent brings its share token, which the document checks; everyone else needs a session.
  if (!session && !rest.startsWith("/api/ext")) return new Response("Sign in first", { status: 401 });
  const access = session ? await platform.directory.access(whoOf(session), route) : null;
  if (session && !access) return new Response("Not allowed", { status: 403 });
  return platform.docs.fetch(route, forwarded(request, url, rest, `${url.origin}/d/${route.id}`, session, access == "owner" || access == "editor" ? "edit" : "view"));
}

/** Who a session is, to the directory's `may`. */
export const whoOf = (session: Session): Who => ({ login: session.login.toLowerCase(), test: !!session.test, ...(session.test ? { by: session.test.by.toLowerCase() } : {}) });

const refused = (session: Session) => session.test
  ? page("Test documents only", "Test people can open only test documents.", 403)
  : page("Not shared with you", `This document hasn't been shared with <b>${esc(session.login)}</b>. Ask its owner to share it with you.`, 403);

/**
 * The document at /<first>/<second> (/d/<id>, /<owner>/<slug>,
 * /<owner>/<id>, /<owner>/<an old slug>), with all it is.
 */
async function documentAt(platform: Platform, first: string, second: string): Promise<DocRow | null> {
  if (first == "d") return ID.test(second) ? platform.directory.get(second) : null;
  return (await platform.directory.locate(first, second))?.doc ?? null;
}

/**
 * How to reach the document at /<first>/<second>, for the requests under
 * it. By id it's remembered (an id is never another of the owner's slugs,
 * directory.ts), so a document's many subrequests rarely ask the database.
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
// src/page/bridge.ts). That origin has no cookies. It serves the page
// editor's frame and the document's files under a token, signed here, that
// opens this one document for a week; the editor's address on this site hands
// it out to whoever may open the document.

const PAGES_LABEL = /^([a-z0-9]{8})-([a-z0-9-]{1,39})$/;
const WEEK = 7 * 24 * 60 * 60;

/** The origin a document's page runs on. */
export function pagesOrigin(owner: string, id: string, url: URL, platform: Platform): string {
  const domain = platform.pagesDomain(url);
  return domain == "localhost" ? `${url.protocol}//${id}-${owner.toLowerCase()}.localhost${url.port ? `:${url.port}` : ""}` : `https://${id}-${owner.toLowerCase()}.${domain}`;
}

/** The document a pages origin is for, if the request came to one. */
function pagesHost(url: URL, platform: Platform): { owner: string; id: string } | null {
  const domain = platform.pagesDomain(url);
  if (!url.hostname.endsWith(`.${domain}`)) return null;
  const m = PAGES_LABEL.exec(url.hostname.slice(0, -domain.length - 1));
  return m && OWNER.test(m[2]) && ID.test(m[1]) ? { owner: m[2], id: m[1] } : null;
}

const hmac = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-pages:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
};
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A token that opens one document's files on its pages origin, for a week, for the editor at `shell` (whose origin it names). */
export async function pagesToken(secret: string, owner: string, id: string, shell: string, now = Date.now()): Promise<string> {
  const claims = b64url(new TextEncoder().encode(JSON.stringify({ d: `${owner.toLowerCase()}/${id}`, e: Math.floor(now / 1000) + WEEK, s: shell })));
  return `${claims}.${await hmac(secret, claims)}`;
}

/** The editor's origin, if `token` is good for this document and current. */
export async function readPagesToken(secret: string, token: string, owner: string, id: string, now = Date.now()): Promise<string | null> {
  const [claims, mac, extra] = token.split(".");
  if (!claims || !mac || extra != null || mac != (await hmac(secret, claims))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(claims.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)))) as { d?: string; e?: number; s?: string };
    if (c.d != `${owner.toLowerCase()}/${id}` || !(Number(c.e) > now / 1000) || typeof c.s != "string") return null;
    return new URL(c.s).origin == c.s ? c.s : null;
  } catch { return null; }
}

/**
 * A request to a document's pages origin: /t/<token>/ is the page editor's
 * frame, which only the editor on this site may embed, and /t/<token>/doc/...
 * are the document's files.
 */
async function pagesDoor(request: Request, url: URL, doc: { owner: string; id: string }, platform: Platform): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const [, token, rest] = /^\/t\/([^/]+)(\/.*)$/.exec(url.pathname) ?? [];
  if (!token || (request.method != "GET" && request.method != "HEAD")) return notFound();
  const shell = await readPagesToken(platform.secret, token, doc.owner, doc.id);
  if (!shell) return new Response("This link has expired: reload the editor.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (rest == "/") {
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="erga-shell" content="${esc(shell)}"><title>Erga page</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#page{position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent}</style>
</head><body><script src="/frame.js"></script></body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": `frame-ancestors ${shell}`, "Referrer-Policy": "no-referrer" },
    });
  }
  if (!rest.startsWith("/doc/")) return notFound();
  const route = await platform.directory.route(doc.id);
  if (!route || route.owner != doc.owner.toLowerCase()) return notFound();
  return platform.docs.fetch(route, forwarded(request, url, rest, `${shell}/d/${doc.id}`, null, null));
}

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** The demo as anyone sees it: just the page, and an Edit button (which makes you a copy of it). */
function viewDemo(platform: Platform, session: Session | null): Response {
  const docs = session && !session.test ? `<nav class="erga-docs-nav" aria-label="Documents"><a href="${esc(link("/docs", session))}" class="erga-edit-button erga-docs-button">‹ Documents</a></nav>` : "";
  const edit = `<a href="${esc(link("/new?from=demo", session))}" class="erga-edit-button">Edit</a>`;
  const html = platform.templates.demo["index.html"].replace("</body>", `${docs}${edit}${EDIT_BUTTON_STYLE}</body>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

const EDIT_BUTTON_STYLE = `
<style>
  .erga-edit-button { position: fixed; top: 16px; right: 16px; z-index: 1000; padding: 7px 16px; border-radius: 999px;
    font: 600 14px/1.2 system-ui, -apple-system, sans-serif; text-decoration: none; color: #fff; background: #1b2330;
    box-shadow: 0 2px 10px rgba(20, 28, 40, .2); }
  .erga-edit-button:hover { background: #2f3b4d; }
  .erga-docs-button { right: auto; left: 16px; color: #1b2330; background: #fff; }
  .erga-docs-button:hover { background: #eef1f5; }
  /* On a phone they'd sit over the text the whole way down: they stay at the top instead, and are bigger to tap. */
  @media (max-width: 640px), (max-height: 480px) { .erga-edit-button { position: absolute; padding: 10px 18px; } }
  @media (prefers-color-scheme: dark) {
    .erga-edit-button { color: #12161d; background: #e4e8ee; } .erga-edit-button:hover { background: #fff; }
    .erga-docs-button { color: #e4e8ee; background: #1a2029; } .erga-docs-button:hover { background: #232a35; }
  }
</style>`;

/** The templates /new?from= may copy; anything else makes a blank document. */
const FROM = new Set(["demo"]);

/** A new document for the signed-in person, at /<login>/<id>: blank (templates/doc), or a copy of the demo. */
async function newDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  if (!session) return signInFirst(`/new${params.size ? `?${params}` : ""}`);
  // Another site may not make documents for you (nor an unconfirmed sign-in on the way back from GitHub).
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request)) {
    return confirmAction("New document", params.get("from") == "demo" ? "Make your copy of the demo" : "Make a new document", `/new${url.search}`);
  }
  const wanted = params.get("id");
  const from = params.get("from");
  const template = platform.templates[from && FROM.has(from) ? from : "doc"];
  // A test person makes (or reuses) a test document under the address of whoever minted their token.
  // Its address is its id, which never follows the title (the suite addresses it by id).
  if (session.test) {
    if (!wanted || !TEST_ID.test(wanted)) return page("Test documents only", "Name the test document: /new?id=test1234.", 400);
    const owner = session.test.by.toLowerCase();
    const known = await platform.directory.route(wanted);
    if (known && (known.owner != owner || !known.test)) return page("Taken", "That test document's id is someone else's: pick another.", 409);
    if (!known) await makeDoc(platform, owner, wanted, template, { test: true });
    return new Response(null, { status: 302, headers: { Location: `/${owner}/${wanted}` } });
  }
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for tests/worker.ts).
  const dev = platform.dev(url);
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newId();
    const made = await makeDoc(platform, session.login.toLowerCase(), id, template, { unedited });
    if (made) return new Response(null, { status: 302, headers: { Location: link(`/${made.owner}/${made.slug}`, session) } });
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

/**
 * Makes a document from a template's files: its row in the directory (titled
 * by the template's heading, its slug following that), then its host. Null
 * if the id is taken.
 */
async function makeDoc(platform: Platform, owner: string, id: string, files: Record<string, string>, opts: { test?: boolean; unedited?: number }): Promise<DocRow | null> {
  const created = Date.now();
  const expires = opts.test ? null : created + (opts.unedited ?? (await platform.directory.config.get("unedited_hours")) * HOUR);
  const { doc, added } = await platform.directory.add({
    id, owner, title: titleOf(files["index.html"] ?? "", "index.html") ?? UNTITLED,
    ...(opts.test ? { slug: id, slugSet: true } : {}),
    created, expires, test: opts.test,
  });
  if (!added) return null;
  if (await platform.docs.create(doc, files, "index.html", { test: opts.test, expires })) return doc;
  // A host by that name was there already (one whose row went): leave it, and try another id.
  await platform.directory.remove(id);
  return null;
}

/** /docs: the signed-in person's documents, most recently edited first. */
async function listDocs(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  const docs = await platform.docs.list(session.login);
  const hours = await platform.directory.config.get("unedited_hours");
  return new Response(docsPage(session, docs, Date.now(), platform.dev(new URL(request.url)), hours), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
 * POST /docs/rename (id, title, slug): renames a document from the list. It
 * goes through the document's host, as a rename in the editor does, so its
 * open tabs follow. Answers JSON to the list's script, else goes back to the list.
 */
async function renameDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return new Response("Sign in first", { status: 401 });
  const url = new URL(request.url);
  if (request.headers.get("origin") != url.origin) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const route = ID.test(id) ? await platform.directory.route(id) : null;
  if (!route) return new Response("No such document", { status: 404 });
  // Only what's given changes; an empty one goes back to following (directory.ts, rename).
  const patch = { title: form.has("title") ? String(form.get("title")) : undefined, slug: form.has("slug") ? String(form.get("slug")) : undefined };
  // As the person asking: their cookie (and locally ?user=) come along, as forwarded() passes them.
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  const inner = new Request(new URL("/api/name", url), { method: "POST", headers, body: JSON.stringify(patch) });
  const answer = await platform.docs.fetch(route, forwarded(inner, url, "/api/name", `${url.origin}/d/${id}`, session, null));
  if (request.headers.get("accept")?.includes("application/json")) return new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
  if (!answer.ok) return page("Couldn't rename", `${esc(((await answer.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong.")} <a href="${esc(link("/docs", session))}">Back to your documents</a>.`, answer.status);
  return new Response(null, { status: 303, headers: { Location: link("/docs", session) } });
}

/**
 * POST /docs/share (id, login, role): gives someone a role on one of your
 * documents ("editor" or "viewer"; login "*" is anyone signed in who has the
 * link), or takes it away (role "none" or empty). Only its owner may. Answers
 * JSON: everyone's permissions now, or the error.
 */
async function shareDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (request.headers.get("origin") != new URL(request.url).origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const id = String(form.get("id") ?? ""), login = String(form.get("login") ?? ""), role = String(form.get("role") ?? "");
  if (!ID.test(id) || !(await platform.directory.get(id))) return Response.json({ error: "No such document" }, { status: 404 });
  try {
    const permissions = await platform.directory.share(whoOf(session), id, login, role == "" || role == "none" ? null : role as Grant);
    return Response.json({ permissions });
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

/** The documents view, in the editor's own type and colours (style.css), light or dark with the system. */
function docsPage(session: Session, docs: Listed[], now: number, dev: boolean, hours: number): string {
  const rows = docs.map((d) => {
    const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
    const note = d.path != null ? `<span class="note" title="${esc(d.path)}">On disk</span>`
      : left != null ? `<span class="note" title="A document nobody edits is deleted ${hours} hours after it's made">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    // One opened from disk only comes off the list: its files stay where they are.
    const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
    return `  <li>
    <a class="doc" href="${esc(link(`/${d.owner}/${d.slug}`, session))}"><span class="title">${esc(d.title)}</span>${note}<time datetime="${when}">${ago(d.modified, now)}</time></a>
    <button type="button" class="act rename" aria-label="Rename ${esc(d.title)}" title="Rename" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-slug="${esc(d.slug)}"${d.titleSet ? " data-title-set" : ""}${d.slugSet ? " data-slug-set" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h3.5L18.25 9.25a2.47 2.47 0 0 0-3.5-3.5L5 15.5V19Z"/><path d="m13.5 7 3.5 3.5"/></svg></button>
    <form method="post" action="${esc(link("/docs/delete", session))}" data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" title="${remove}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></form>
  </li>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documents · Erga</title>
<link rel="stylesheet" href="/fonts/inter.css">
<link rel="stylesheet" href="/style.css">
<style>
  body { font-size: 15px; line-height: 1.5; }
  main { max-width: var(--column); margin: 0 auto; padding: 14vh 20px 40px; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.015em; color: var(--fg-strong); }
  .new { flex: none; padding: 7px 14px; border-radius: 999px; background: var(--fg-strong); color: var(--bg); font-size: 13px; font-weight: 600; text-decoration: none; transition: opacity 150ms ease; }
  .new:hover { opacity: 0.85; }
  :is(.new, .doc, .act, footer a, dialog button):focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; border-radius: 6px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--rule); }
  li:first-child { border-top: 1px solid var(--rule); }
  .doc { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; padding: 13px 2px; color: inherit; text-decoration: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg-strong); }
  .doc:hover .title { text-decoration: underline; text-decoration-color: var(--mark); text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
  .note { flex: none; font-size: 12.5px; color: var(--chrome); }
  time { flex: none; margin-left: auto; font-size: 13px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; }
  form { margin: 0; }
  .act { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--chrome); cursor: pointer; opacity: 0; transition: opacity 150ms ease, color 150ms ease, background-color 150ms ease; }
  .act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .act, .act:focus-visible { opacity: 1; }
  .act:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  @media (hover: none) { .act { opacity: 1; } }
  /* Renaming: a small card over the list. */
  dialog { width: min(400px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px; border: 1px solid var(--panel-border); border-radius: 14px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font-size: 14px; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.18); }
  dialog h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  dialog label { display: block; margin: 0 0 4px; font-size: 12.5px; color: var(--soft); }
  dialog .field { display: flex; align-items: center; margin-bottom: 12px; border: 1px solid var(--rule); border-radius: 9px; background: color-mix(in srgb, var(--chrome) 6%, transparent); padding: 0 10px; }
  dialog .field:focus-within { border-color: var(--caret); }
  dialog .field span { color: var(--soft); white-space: nowrap; }
  dialog input { flex: 1; min-width: 0; padding: 8px 0; border: 0; outline: 0; background: transparent; color: var(--fg-strong); font: inherit; }
  dialog .hint { margin: -6px 0 12px; font-size: 12px; color: var(--soft); min-height: 1em; }
  dialog .hint:empty { display: none; }
  dialog .hint.error { color: #c2410c; }
  dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  dialog button { font: 600 13px var(--font-text); padding: 7px 14px; border-radius: 999px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
  dialog button.primary { border-color: var(--fg-strong); background: var(--fg-strong); color: var(--bg); }
  @media (pointer: coarse) { dialog input { font-size: 16px; } }
  .empty { margin: 0; padding: 28px 2px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); color: var(--soft); }
  .open { display: flex; gap: 8px; margin: 28px 0 0; }
  .open input { flex: 1; min-width: 0; padding: 7px 12px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--fg-strong); font: inherit; font-size: 13.5px; }
  .open input::placeholder { color: var(--soft); }
  .open input:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .open button { flex: none; padding: 7px 14px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--fg-strong); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .open button:hover { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  footer { padding-top: 40px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--chrome); }
  footer a { color: inherit; text-decoration: none; }
  footer a:hover { color: var(--chrome-hover); }
  @media (max-width: 520px) { .note { display: none; } main { padding-top: 8vh; } }
  /* Touch: room for a finger. */
  @media (pointer: coarse) { .new { padding: 10px 16px; } .act { width: 40px; height: 40px; } .delete { margin-right: -6px; } footer a { padding: 8px 0; margin: -8px 0; } }
</style>
<main>
  <header>
    <h1>Documents</h1>
    <a class="new" href="${esc(link("/new", session))}">New document</a>
  </header>
  ${docs.length ? `<ol>\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank, and goes away after ${hours} hours if you never edit it.</p>`}
  ${dev ? `<form class="open" method="post" action="${esc(link("/__erga/open", session))}" aria-label="Open from disk">
    <input name="path" required placeholder="A file or folder on this machine: ~/notes, ./site/index.md" aria-label="Path to a file or folder" autocomplete="off" spellcheck="false">
    <button>Open</button>
  </form>` : ""}
  <footer><span>Signed in as ${esc(session.login)}</span><a href="${esc(link("/", session))}">The demo</a><a href="/auth/logout">Sign out</a></footer>
</main>
<dialog id="rename" aria-labelledby="rename-title">
  <form method="post" action="${esc(link("/docs/rename", session))}">
    <h2 id="rename-title">Rename</h2>
    <input type="hidden" name="id">
    <label for="rename-name">Title</label>
    <div class="field"><input id="rename-name" name="title" autocomplete="off" spellcheck="false"></div>
    <label for="rename-slug">Address</label>
    <div class="field"><span>/${esc(session.login.toLowerCase())}/</span><input id="rename-slug" name="slug" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <p class="hint" id="rename-hint" role="status"></p>
    <div class="buttons"><button type="button" value="cancel" formnovalidate>Cancel</button><button class="primary">Save</button></div>
  </form>
</dialog>
<script>
  // Times in the reader's own language and zone, and a question before deleting.
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const t of document.querySelectorAll("time")) {
    const d = new Date(t.dateTime), s = (d - Date.now()) / 1000;
    t.title = d.toLocaleString();
    if (s > -60) t.textContent = "just now";
    else if (s > -3600) t.textContent = rtf.format(Math.round(s / 60), "minute");
    else if (s > -86400) t.textContent = rtf.format(Math.round(s / 3600), "hour");
    else if (s > -30 * 86400) t.textContent = rtf.format(Math.round(s / 86400), "day");
    else t.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  for (const f of document.querySelectorAll("form[data-title]")) {
    const q = "disk" in f.dataset ? "Take \\u201c" + f.dataset.title + "\\u201d off your list? Its files stay where they are." : "Delete \\u201c" + f.dataset.title + "\\u201d? This can't be undone.";
    f.addEventListener("submit", (e) => { if (!confirm(q)) e.preventDefault(); });
  }
  // Renaming: the title, and the address, which follows the title until it's set.
  // An empty field goes back to following (the title the page's first heading).
  const dialog = document.getElementById("rename"), form = dialog.querySelector("form");
  const nameIn = form.elements.title, slugIn = form.elements.slug, hint = document.getElementById("rename-hint");
  const slugify = (s) => s.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/['\\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  let was = null, slugTouched = false;
  const say = (text, error) => { hint.textContent = text; hint.classList.toggle("error", !!error); };
  const preview = () => say(!nameIn.value.trim() ? "Empty: the title follows the page's first heading."
    : !slugIn.value.trim() ? "Empty: the address follows the title." : "");
  for (const b of document.querySelectorAll("button.rename")) b.addEventListener("click", () => {
    was = { id: b.dataset.id, title: b.dataset.title, slug: b.dataset.slug, slugSet: "slugSet" in b.dataset };
    slugTouched = false;
    form.elements.id.value = was.id;
    nameIn.value = was.title;
    slugIn.value = was.slug;
    say("");
    dialog.showModal();
    nameIn.select();
  });
  // An address that follows the title follows it here too, until it's typed in.
  nameIn.addEventListener("input", () => { if (!was.slugSet && !slugTouched) slugIn.value = slugify(nameIn.value) || was.slug; preview(); });
  slugIn.addEventListener("input", () => { slugTouched = true; preview(); });
  form.querySelector('[value="cancel"]').addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Only what was changed: a title left as it was keeps following the heading, if it did.
    const body = new URLSearchParams({ id: was.id });
    if (nameIn.value.trim() != was.title) body.set("title", nameIn.value.trim());
    if (slugTouched && slugIn.value.trim() != was.slug) body.set("slug", slugIn.value.trim());
    if ([...body.keys()].length == 1) return dialog.close();
    say("Saving\\u2026");
    const r = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } }).catch(() => null);
    if (r && r.ok) return location.reload();
    say((r && (await r.json().catch(() => ({}))).error) || "Couldn't rename it: try again.", true);
  });
</script>
</html>`;
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
 * A request for the document's host: the path inside the document, its
 * public address, who's asking and whether they may edit or only view
 * (never what the browser claimed: those headers are replaced).
 */
function forwarded(request: Request, url: URL, rest: string, base: string, session: Session | null, access: "edit" | "view" | null): Request {
  const inner = new URL(rest + url.search, url.origin);
  const headers = new Headers(request.headers);
  headers.delete("x-erga-person");
  headers.delete("x-erga-access");
  headers.set("x-erga-base", base);
  if (session) headers.set("x-erga-person", JSON.stringify({ id: session.login.toLowerCase(), name: session.name }));
  if (session && access) headers.set("x-erga-access", access);
  return new Request(inner, { method: request.method, headers, body: request.body, redirect: "manual" });
}

/**
 * A page's title, as the list shows it: its first top-level heading (what
 * people edit on the page), else an HTML page's <title>. Null if it has neither.
 */
export function titleOf(text: string, path: string): string | null {
  const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 120) || null;
  if (path.endsWith(".md")) {
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    return heading ? clean(heading[1].replace(/[*_`]/g, "")) : null;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text), title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return (h1 && clean(h1[1])) || (title && clean(title[1])) || null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] == "#" ? String.fromCodePoint(parseInt(e[1] == "x" || e[1] == "X" ? e.slice(2) : e.slice(1), e[1] == "x" || e[1] == "X" ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

/** A small page for when there's nothing to show, or something about signing in goes wrong. */
export function page(title: string, html: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Erga</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;color:#1b2330;background:#f7f8fa}h1{font-size:1.4rem}a{color:#1f5f8b}
@media(prefers-color-scheme:dark){body{color:#e4e8ee;background:#12161d}a{color:#7fb6e0}}</style><h1>${title}</h1><p>${html}</p>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
