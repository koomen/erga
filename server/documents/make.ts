// New documents, the documents list, deleting and sharing: what /new, /docs, /docs/delete,
// /docs/share and the share token do. The list's page is pages/docs.ts.

import type { FileData } from "../../document/document.ts";
import { kindOf, titleOf, type DocKind } from "../../document/pages.ts";
import { type DocRow, type Grant, ID, newDocId, NO_WRITE, NotAllowed, type Permission, TEST_ID, UNTITLED, type Who } from "../directory/index.ts";
import { type Listed, type Platform, type Session, whoOf } from "../platform.ts";
import { landingDocument } from "./landing.ts";
import { esc, avatarsOf, confirmAction, docsPage, fromElsewhere, link, page, signInFirst, type Template, templateById, TEMPLATES, withEdit } from "../pages/index.ts";

/** A template's starting files (server/templates.ts: a folder under assets/templates/), and its page; null if this server hasn't them. */
export function templateFiles(platform: Platform, template: Template): { files: Record<string, string | Uint8Array>; index: string } | null {
  const files = platform.templates[template.files.slice("assets/templates/".length)];
  if (!files) return null;
  const index = files["index.html"] != null ? "index.html" : null;
  return index ? { files: { ...files }, index } : null;
}

/**
 * What a new document starts from: a copy of the front page's document
 * (`landing`), of another document by id (one `who` may open), or a
 * template's files (server/templates.ts; the first, a blank page, by default).
 * Null if there's nothing there to copy.
 */
export async function startingFiles(platform: Platform, from: string | null, who?: Who, template?: Template): Promise<{ files: Record<string, FileData>; index: string; kind?: DocKind } | null> {
  if (!from) return templateFiles(platform, template ?? TEMPLATES[0]);
  const doc = from == "landing" ? await landingDocument(platform) : ID.test(from) && who ? await platform.directory.get(from) : null;
  if (!doc || (from != "landing" && !(await platform.directory.may(who!, "open", doc)))) return null;
  // A copy is the kind its original is (a project with one page stays a project).
  const snap = await platform.docs.snapshot(doc);
  return snap && (doc.kind ? { ...snap, kind: doc.kind } : snap);
}

/** A new document for the signed-in person, at /<login>/<id>: blank, from a template (?template=<id>, server/templates.ts), or a copy of the front page's (?from=landing). */
export async function newDoc(platform: Platform, request: Request): Promise<Response> {
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
  if (!session.test && !(await platform.directory.mayWrite(session.login))) return page("You can't make documents here", `${esc(NO_WRITE)} <a href="/docs">Your documents</a>`, 403);
  const wanted = params.get("id");
  const from = params.get("from");
  const start = await startingFiles(platform, from, whoOf(session), template);
  if (!start) return page("Nothing to copy", from == "landing" ? "This server has no front page to copy. <a href=\"/new\">Make a blank document</a>." : "There's no document here you can copy. <a href=\"/new\">Make a blank document</a>.", 404);
  const files = start.files, index = start.index;
  // ?kind=project: a project from the start (create_document's kind), else the kind it copies, else from its files.
  const kind = params.get("kind") == "project" ? "project" as const : start.kind;
  // A test person makes (or reuses) a test document under the address of whoever minted their token.
  // Its address is its id, which never follows the title (the suite addresses it by id).
  if (session.test) {
    if (!wanted || !TEST_ID.test(wanted)) return page("Test documents only", "Name the test document: /new?id=test1234.", 400);
    const owner = session.test.by.toLowerCase();
    const known = await platform.directory.route(wanted);
    if (known && (known.owner != owner || !known.test)) return page("Taken", "That test document's id is someone else's: pick another.", 409);
    if (!known) await makeDoc(platform, owner, wanted, files, { test: true, index, kind });
    return new Response(null, { status: 302, headers: { Location: `/${owner}/${wanted}?edit` } });
  }
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for e2e/front/lifetime.e2e.ts).
  const dev = platform.dev(url);
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newDocId();
    const made = await makeDoc(platform, session.login.toLowerCase(), id, files, { unedited, index, kind });
    if (made) return new Response(null, { status: 302, headers: { Location: withEdit(link(`/${made.owner}/${made.slug}`, session)) } });
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
}

/**
 * Makes a document from a template's files: its row in the directory (titled
 * by the template's heading, its slug following that), then its host. Null
 * if the id is taken.
 */
const HOUR = 60 * 60 * 1000;

export async function makeDoc(platform: Platform, owner: string, id: string, files: Record<string, FileData>, opts: MakeOptions): Promise<DocRow | null> {
  const created = Date.now();
  // A published one has been edited already (its files are someone's work): it never expires.
  // Nor does any when the server's delete_docs_after_hours is never (null).
  const hours = opts.test || opts.published || opts.unedited ? null : await platform.directory.config.get("delete_docs_after_hours");
  const expires = opts.test || opts.published ? null : opts.unedited ? created + opts.unedited : hours == null ? null : created + hours * HOUR;
  const index = opts.index ?? "index.html";
  const page = files[index];
  const pageText = typeof page == "string" ? page : page instanceof Uint8Array ? new TextDecoder().decode(page) : "";
  // A project if asked, or if its files have more than one page (a published folder); else a document.
  const kind = opts.kind ?? kindOf(Object.keys(files));
  const { doc, added } = await platform.directory.add({
    id, owner, kind,
    ...(opts.title?.trim() ? { title: opts.title, titleSet: true } : { title: titleOf(pageText) ?? UNTITLED }),
    ...(opts.test ? { slug: id, slugSet: true } : opts.slug?.trim() ? { slug: opts.slug, slugSet: true } : {}),
    created, expires, test: opts.test,
    ...(opts.published ? { modified: created } : {}),
  });
  if (!added) return null;
  if (await platform.docs.create(doc, files, index, { test: opts.test, expires, kind, ...(opts.published ? { modified: created } : {}) })) return doc;
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
  /** A document (one page) or a project (pages): from its files if not given (a project if they have more than one page). */
  kind?: DocKind;
  /** A title (set: it won't follow the page's heading) and slug (set: it won't follow the title). */
  title?: string;
  slug?: string;
  /** Made from someone's files (the server's API): counts as edited, so it never expires. */
  published?: boolean;
}

/** A new document's id: 8 letters and digits, none easily mistaken for another. */

/** How long the list waits for documents from before kinds to say theirs (they say it once, for good). */
const KINDS_WAIT_MS = 1500;

/**
 * Documents from before kinds, in a list: each opens (in the background, if it takes longer than the list may wait),
 * which decides its kind from its pages and writes it to the directory. The list shows the ones known in time.
 */
async function decideKinds(platform: Platform, docs: Listed[]): Promise<void> {
  const unknown = docs.filter((d) => !d.kind && d.path == null);
  if (!unknown.length) return;
  const work = Promise.all(unknown.map(async (d) => {
    const paths = await platform.docs.paths({ id: d.id, owner: d.owner, test: false }).catch(() => null);
    if (paths?.length) d.kind = kindOf(paths);
  }));
  platform.edge.background(work);
  await Promise.race([work, new Promise((r) => setTimeout(r, KINDS_WAIT_MS))]);
}

/** /docs: the signed-in person's documents, most recently edited first. */
export async function listDocs(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session) return signInFirst("/docs");
  if (session.test) return page("Not for test people", "Test people have no documents of their own.", 403);
  if (session.onlyDoc != null) return page("One document only", "This token is for one document: it can't list others.", 403);
  const [docs, hours] = await Promise.all([platform.docs.list(session.login), platform.directory.config.get("delete_docs_after_hours")]);
  await decideKinds(platform, docs);
  return new Response(docsPage(session, docs, Date.now(), hours), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** POST /docs/delete (id=...): deletes one of the signed-in person's documents. */
export async function deleteDoc(platform: Platform, request: Request): Promise<Response> {
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
 * documents ("editor" or "viewer"; login "*" is anyone with the link: refused
 * unless the server lets users share content publicly), or takes it away (role
 * "none" or empty). Only its owner may. Answers JSON: everyone's permissions now,
 * whether the server lets people share publicly (`publicSharing`), which of them can't sign in yet
 * (`notUsers`: not users of this server), each one's picture (`avatars`, by
 * login: their GitHub picture), or the error. GET /docs/share?id=
 * answers the same without changing anything (the list's share dialog).
 */
export async function shareDoc(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (!session || session.test) return Response.json({ error: "Sign in first" }, { status: 401 });
  const url = new URL(request.url);
  const answer = async (permissions: Permission[]) => {
    const notUsers = (await Promise.all(permissions.map(async (p) => (p.login == "*" || (await platform.directory.users.allowed(p.login)) ? null : p.login)))).filter((l) => l != null);
    // Whether the server lets users share content publicly: the menus offer anyone with the link only then.
    const publicSharing = await platform.directory.config.get("public_sharing");
    return Response.json({ permissions, notUsers, avatars: avatarsOf(permissions.map((p) => p.login)), publicSharing });
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

/**
 * POST <document>/api/share {rotate}: the share button's token, the
 * person's one 'share' token, the same each time until rotated.
 */
export async function shareToken(platform: Platform, request: Request, session: Session): Promise<Response> {
  const refuse = (error: string) => Response.json({ ok: false, error }, { status: 403 });
  if (session.agent) return refuse("An agent can't make tokens.");
  const origin = request.headers.get("origin");
  if (origin && origin != new URL(request.url).origin) return refuse("Forbidden");
  const body = (await request.json().catch(() => ({}))) as { rotate?: unknown };
  const { token } = await platform.tokens.share({ login: session.login, name: session.name, testBy: session.test?.by }, body?.rotate === true);
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
