// The front door: the app around the documents (worker/index.ts serves it,
// on erga.dev and in local development alike). It's written against web
// Requests and Responses, and the Worker supplies the rest (`Platform`):
// who's signed in, the templates, the directory of documents (directory.ts,
// in D1) and the documents themselves (Durable Objects).
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents, latest edit first; POST /docs/delete deletes one, /docs/rename renames one,
//                              /docs/share shares one (or stops sharing it), GET /docs/share?id= says with whom
//   /admin                     the server's settings and users, for admins (admin.ts); POST /admin/settings, /admin/users
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
// The server's API for agents (/llms.txt, /api/..., /mcp) and /tokens are
// server-api.ts's, which the Worker calls with `withTokens(platform)`.
//
// Anywhere, "Authorization: Bearer erga_..." (an agent token, tokens.ts)
// signs in as the person it stands for, as their agent (Session.agent), with
// that person's permissions.
//
// Signing in, the editor's own files and the WebSockets stay with the
// Worker. The rule for when an unedited document goes (`afterUnedited`) is
// here; the document's alarm applies it.

import { adminDoor } from "./admin.ts";
import { type Directory, type DocRow, type Grant, type Permission, type Role, type Route, type Who, NotAllowed, UNTITLED } from "./directory.ts";
import type { AgentToken, Tokens } from "./tokens.ts";

/** Who's signed in. */
export interface Session {
  login: string;
  name: string;
  /** A test person, signed in with a test token minted by `by` (hosted only). */
  test?: { by: string };
  /** In local development, the name a tab gave in ?user=, carried along in the links it follows. */
  as?: string;
  /** Signed in with an agent token (tokens.ts): an agent acting as this person. */
  agent?: AgentToken;
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
  /** What the person whose list it is may do with it: their own document, or one shared with them. */
  role: Role;
  /** How many it's shared with besides its owner (anyone with the link counts as one). */
  shared?: number;
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
  /** Agent tokens (tokens.ts). */
  tokens: Tokens;
  /** A test token for the test suite, minted by `login` (shown on /tokens), where the platform makes them. */
  testToken?(login: string): Promise<{ token: string; expires: Date }>;
  docs: {
    /**
     * Makes the host of a document already in the directory, from a
     * template's files; false if it already has one. Unless someone edits
     * it, it goes at `expires`.
     */
    create(doc: Route, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean>;
    /**
     * Files arriving whole into an existing document (a publish): written,
     * and merged into its room as edits; `remove` deletes files.
     */
    publish(doc: Route, files: Record<string, string | Uint8Array>, remove: string[]): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }>;
    /** Every file a document holds. */
    paths(doc: Route): Promise<string[]>;
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
export async function frontDoor(request: Request, base: Platform): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const pages = pagesHost(url, base);
  if (pages) return pagesDoor(request, url, pages, base);
  const platform = withTokens(base, url);
  if (path == "/") return viewDemo(platform, await platform.sessionOf(request));
  if (path == "/new") return newDoc(platform, request);
  if (path == "/docs") return listDocs(platform, request);
  if (path == "/docs/delete" && request.method == "POST") return deleteDoc(platform, request);
  if (path == "/docs/rename" && request.method == "POST") return renameDoc(platform, request);
  if (path == "/docs/share") return shareDoc(platform, request);
  if (path == "/admin" || path == "/admin/settings" || path == "/admin/users") return adminDoor(platform, request);

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
  // An external agent brings its token (Session.agent); everyone else signs in.
  if (!session) {
    return rest.startsWith("/api/ext")
      ? Response.json({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". If it stopped working it was revoked: ask for a new one." }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="erga"' } })
      : new Response("Sign in first", { status: 401 });
  }
  const access = await platform.directory.access(whoOf(session), route);
  if (!access) return new Response("Not allowed", { status: 403 });
  // The share button's token is the front door's (tokens.ts), not the document's.
  if (rest == "/api/share" && request.method == "POST") return shareToken(platform, request, session);
  return platform.docs.fetch(route, forwarded(request, url, rest, `${url.origin}/d/${route.id}`, session, accessOf(access)));
}

/**
 * The platform with agent tokens: a request carrying one ("Authorization:
 * Bearer erga_...") is signed in as the person it stands for, as long as
 * they may still sign in, whatever cookie it has. A bearer token that isn't
 * a good one signs in nobody.
 */
export function withTokens(platform: Platform, url: URL): Platform {
  return {
    ...platform,
    async sessionOf(request) {
      const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) return platform.sessionOf(request);
      const token = await platform.tokens.verify(bearer).catch(() => null);
      if (!token) return null;
      // A test person's token opens only test documents, while whoever minted their test token may sign in.
      const session: Session = { login: token.login, name: token.name, agent: token, ...(token.testBy ? { test: { by: token.testBy } } : {}) };
      const users = platform.directory.users;
      if (token.testBy) return (await users.allowed(token.testBy)) ? session : null;
      return platform.dev(url) || (await users.allowed(token.login)) ? session : null;
    },
  };
}

/** What a role lets someone do inside a document, as its host is told (x-erga-access). */
export const accessOf = (role: Role | null): "edit" | "view" | null =>
  role == "owner" || role == "editor" ? "edit" : role == "viewer" ? "view" : null;

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
export const link = (path: string, session: Session | null) =>
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
export const newDocId = newId;

/** /docs: the signed-in person's documents, most recently edited first. */
async function listDocs(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  const [docs, hours, admin] = await Promise.all([platform.docs.list(session.login), platform.directory.config.get("delete_docs_after_hours"), platform.directory.users.isAdmin(whoOf(session))]);
  return new Response(docsPage(session, docs, Date.now(), platform.dev(new URL(request.url)), hours, admin), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
 * JSON: everyone's permissions now, and which of them can't sign in yet
 * (`notUsers`: not users of this server), or the error. GET /docs/share?id=
 * answers the same without changing anything (the list's share dialog).
 */
async function shareDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return Response.json({ error: "Sign in first" }, { status: 401 });
  const url = new URL(request.url);
  const answer = async (permissions: Permission[]) => {
    const notUsers = (await Promise.all(permissions.map(async (p) => (p.login == "*" || (await platform.directory.users.allowed(p.login)) ? null : p.login)))).filter((l) => l != null);
    return Response.json({ permissions, notUsers });
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
 * colours (style.css), light or dark with the system, a column of rows, small
 * icon buttons that show on hover, and dialogs as small cards.
 */
export const APP_STYLE = `
  body { font-size: 15px; line-height: 1.5; }
  main { max-width: var(--column); margin: 0 auto; padding: 14vh 20px 40px; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.015em; color: var(--fg-strong); }
  .new { flex: none; padding: 7px 14px; border: 0; border-radius: 999px; background: var(--fg-strong); color: var(--bg); font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; transition: opacity 150ms ease; }
  .new:hover { opacity: 0.85; }
  :is(.new, .doc, .act, footer a, dialog button, .pill, select):focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; border-radius: 6px; }
  ol.rows { list-style: none; margin: 0; padding: 0; }
  ol.rows > li { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--rule); }
  ol.rows > li:first-child { border-top: 1px solid var(--rule); }
  .doc { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; padding: 13px 2px; color: inherit; text-decoration: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg-strong); }
  a.doc:hover .title { text-decoration: underline; text-decoration-color: var(--mark); text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
  .note { flex: none; font-size: 12.5px; color: var(--chrome); }
  time { flex: none; margin-left: auto; font-size: 13px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; }
  form { margin: 0; }
  .act { flex: none; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--chrome); cursor: pointer; opacity: 0; transition: opacity 150ms ease, color 150ms ease, background-color 150ms ease; }
  .act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .act, .act:focus-visible, .act.on { opacity: 1; }
  .act:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .act:disabled { cursor: default; opacity: 0 !important; }
  @media (hover: none) { .act { opacity: 1; } }
  .pill { flex: none; padding: 7px 14px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--fg-strong); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .pill:hover:not(:disabled) { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .pill:disabled { color: var(--chrome); cursor: default; }
  .input { min-width: 0; padding: 7px 12px; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--fg-strong); font: inherit; font-size: 13.5px; }
  .input::placeholder { color: var(--soft); }
  .input:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .input:disabled { color: var(--soft); background: color-mix(in srgb, var(--chrome) 6%, transparent); }
  select { padding: 5px 26px 5px 10px; border: 1px solid var(--rule); border-radius: 999px; color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; appearance: none;
    background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E") no-repeat right 7px center / 14px; }
  select:disabled { color: var(--soft); cursor: default; background-image: none; padding-right: 10px; }
  select option { color: initial; }
  .badge { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .badge.strong { color: var(--bg); background: var(--fg-strong); }
  dialog { width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px; border: 1px solid var(--panel-border); border-radius: 14px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font-size: 14px; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.18); }
  dialog h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: var(--fg-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog label { display: block; margin: 0 0 4px; font-size: 12.5px; color: var(--soft); }
  dialog .field { display: flex; align-items: center; margin-bottom: 12px; border: 1px solid var(--rule); border-radius: 9px; background: color-mix(in srgb, var(--chrome) 6%, transparent); padding: 0 10px; }
  dialog .field:focus-within { border-color: var(--caret); }
  dialog .field span { color: var(--soft); white-space: nowrap; }
  dialog input { flex: 1; min-width: 0; padding: 8px 0; border: 0; outline: 0; background: transparent; color: var(--fg-strong); font: inherit; }
  .hint { margin: -6px 0 12px; font-size: 12px; color: var(--soft); min-height: 1em; }
  .hint:empty { display: none; }
  .hint.error { color: #c2410c; }
  dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  dialog button { font: 600 13px var(--font-text); padding: 7px 14px; border-radius: 999px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
  dialog button.primary { border-color: var(--fg-strong); background: var(--fg-strong); color: var(--bg); }
  dialog button.act { padding: 0; border: 0; }
  @media (pointer: coarse) { dialog input, .input { font-size: 16px; } }
  .empty { margin: 0; padding: 28px 2px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); color: var(--soft); }
  footer { padding-top: 40px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--chrome); }
  footer a { color: inherit; text-decoration: none; }
  footer a:hover { color: var(--chrome-hover); }
  @media (max-width: 520px) { .note { display: none; } main { padding-top: 8vh; } }
  /* Touch: room for a finger. */
  @media (pointer: coarse) { .new, .pill { padding: 10px 16px; } .act { width: 40px; height: 40px; } footer a { padding: 8px 0; margin: -8px 0; } }
`;

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
  rename: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h3.5L18.25 9.25a2.47 2.47 0 0 0-3.5-3.5L5 15.5V19Z"/><path d="m13.5 7 3.5 3.5"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M18.5 8v6M15.5 11h6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
};

/** The page around a view (/docs, /admin): its title, the shared look and the view's own style. */
export const appPage = (title: string, style: string, body: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Erga</title>
<link rel="stylesheet" href="/fonts/inter.css">
<link rel="stylesheet" href="/style.css">
<style>${APP_STYLE}${style}</style>
${body}
</html>`;

/** Who a document is shared with, as its row in the list says it (the owner's own view). */
function sharedNote(d: Listed): string {
  if (!d.shared) return "";
  return `<span class="note shared" title="Shared with ${d.shared} besides you">Shared</span>`;
}

/** The documents view: yours and those shared with you, with new, open, share, rename and delete. */
function docsPage(session: Session, docs: Listed[], now: number, dev: boolean, hours: number | null, admin: boolean): string {
  const rows = docs.map((d) => {
    const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
    const mine = d.role == "owner";
    const note = !mine ? `<span class="note" title="Shared with you by ${esc(d.owner)}">${esc(d.owner)} · ${d.role == "editor" ? "can edit" : "view only"}</span>`
      : d.path != null ? `<span class="note" title="${esc(d.path)}">On disk</span>`
      : left != null ? `<span class="note" title="${hours == null ? "Made when unedited documents were deleted: it still goes unless someone edits it" : `A document nobody edits is deleted ${hours} hours after it's made`}">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    // One opened from disk only comes off the list: its files stay where they are.
    const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
    return `  <li>
    <a class="doc" href="${esc(link(`/${d.owner}/${d.slug}`, session))}"><span class="title">${esc(d.title)}</span>${note}${mine ? sharedNote(d) : ""}<time datetime="${when}">${ago(d.modified, now)}</time></a>
    <div class="acts">${mine ? `<button type="button" class="act share" aria-label="Share ${esc(d.title)}" title="Share" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-address="/${esc(d.owner)}/${esc(d.slug)}">${ICON.share}</button>
    <button type="button" class="act rename" aria-label="Rename ${esc(d.title)}" title="Rename" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-slug="${esc(d.slug)}"${d.titleSet ? " data-title-set" : ""}${d.slugSet ? " data-slug-set" : ""}>${ICON.rename}</button>
    <form method="post" action="${esc(link("/docs/delete", session))}" data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" title="${remove}">${ICON.delete}</button></form>` : ""}</div>
  </li>`;
  }).join("\n");
  const style = `
  .shared { color: var(--soft); }
  /* The buttons (only on your own documents) take the same room on every row, so the times line up. */
  .acts { flex: none; display: flex; justify-content: flex-end; gap: 2px; width: 94px; }
  @media (pointer: coarse) { .acts { width: 124px; } }
  .open { display: flex; gap: 8px; margin: 28px 0 0; }
  .open .input { flex: 1; }
  @media (pointer: coarse) { .delete { margin-right: -6px; } }
  /* Sharing: who has it, anyone with the link, and adding someone. */
  #share { width: min(460px, calc(100vw - 32px)); }
  #share .add { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  #share .add .field { flex: 1; margin: 0; }
  .people { list-style: none; margin: 0 0 14px; padding: 0; max-height: 40vh; overflow: auto; }
  .people li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--rule); }
  .people li:last-child { border-bottom: 1px solid var(--rule); }
  .people .face { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; font-size: 12px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 16%, transparent); text-transform: uppercase; }
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
  return appPage("Documents", style, `<main>
  <header>
    <h1>Documents</h1>
    <a class="new" href="${esc(link("/new", session))}">New document</a>
  </header>
  ${docs.length ? `<ol class="rows">\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank${hours == null ? "." : `, and goes away after ${hours} hour${hours == 1 ? "" : "s"} if you never edit it.`}</p>`}
  ${dev ? `<form class="open" method="post" action="${esc(link("/__erga/open", session))}" aria-label="Open from disk">
    <input class="input" name="path" required placeholder="A file or folder on this machine: ~/notes, ./site/index.md" aria-label="Path to a file or folder" autocomplete="off" spellcheck="false">
    <button class="pill">Open</button>
  </form>` : ""}
  <footer><span>Signed in as ${esc(session.login)}</span><a href="${esc(link("/", session))}">The demo</a><a href="${esc(link("/tokens", session))}">Agent tokens</a>${admin ? `<a href="${esc(link("/admin", session))}">Admin</a>` : ""}<a href="/auth/logout">Sign out</a></footer>
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
    say("Saving…");
    const r = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } }).catch(() => null);
    if (r && r.ok) return location.reload();
    say((r && (await r.json().catch(() => ({}))).error) || "Couldn't rename it: try again.", true);
  });

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
  function render({ permissions, notUsers }) {
    people.replaceChildren();
    const pending = new Set(notUsers || []);
    let all = "none";
    for (const p of permissions) {
      if (p.login == "*") { all = p.role; continue; }
      const who = el("span", { className: "who", textContent: p.login });
      if (p.login == me) who.append(el("small", { textContent: "you" }));
      if (pending.has(p.login)) who.append(el("small", { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" }));
      const li = el("li", {}, el("span", { className: "face", ariaHidden: "true", textContent: p.login[0] }), who);
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
 * person's one 'share' token (tokens.ts), the same each time until rotated.
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
  headers.delete("authorization");
  headers.set("x-erga-base", base);
  if (session) headers.set("x-erga-person", JSON.stringify({ id: session.login.toLowerCase(), name: session.name }));
  if (session && access) headers.set("x-erga-access", access);
  // Only an agent token's request may call a document's external agent tools (host.ts).
  if (session?.agent) headers.set("x-erga-agent", session.agent.id);
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
