// New documents, the documents list and the share token: what /new, /docs and <document>/api/share do. The list's
// page is pages/docs.ts. Deleting and sharing are operations (server/operations/documents.ts).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { FileData } from "../../document/document.ts";
import { kindOf, titleOf, type DocKind } from "../../document/pages.ts";
import { type DocRow, type Grant, ID, newDocId, NO_WRITE, NotAllowed, type Permission, type Who } from "../directory/index.ts";
import { addressOf, UNTITLED } from "../../document/names.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { landingDocument } from "./landing.ts";
import {
  confirmAction,
  docsPage,
  fromElsewhere,
  link,
  page,
  signInFirst,
  type Template,
  templateById,
  TEMPLATES,
  withEdit,
} from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { call, ctx, Field, form, html, json, NO_STORE, plainJson, redirect, text, webRequest } from "../http.ts";

/** A template's starting files (server/pages/templates.ts: a folder under assets/templates/), its page and its kind; null if this server hasn't them. */
export function templateFiles(
  platform: Platform,
  template: Template
): { files: Record<string, string | Uint8Array>; index: string; kind?: DocKind } | null {
  const files = platform.templates[template.files.slice("assets/templates/".length)];
  if (!files) return null;
  const index = files["index.html"] != null ? "index.html" : null;
  return index ? { files: { ...files }, index, ...(template.kind ? { kind: template.kind } : {}) } : null;
}

/**
 * What a new document starts from: a copy of the homepage's document
 * (`landing`), of another document by id (one `who` may open), or a
 * template's files (server/pages/templates.ts; the first, a blank page, by default).
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

/** A new document for the signed-in person, at /<login>/<id>: blank, from a template (?template=<id>, server/pages/templates.ts), or a copy of the homepage's (?from=landing). */
export const newDoc = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
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
  if (!(yield* call(() => platform.directory.mayWrite(session.login))))
    return page("You can't make documents here", `${esc(NO_WRITE)} <a href="/docs">Your documents</a>`, 403);
  const wanted = params.get("id");
  const from = params.get("from");
  const start = yield* call(() => startingFiles(platform, from, whoOf(session), template));
  if (!start)
    return page(
      "Nothing to copy",
      from == "landing"
        ? 'This server has no homepage to copy. <a href="/new">Make a blank document</a>.'
        : 'There\'s no document here you can copy. <a href="/new">Make a blank document</a>.',
      404
    );
  const files = start.files,
    index = start.index;
  // ?kind=project: a project from the start (create_document's kind), else the kind it copies, else from its files.
  const kind = params.get("kind") == "project" ? "project" as const : start.kind;
  // Local development may name the document (the test suite wants "test" in its address),
  // and say how soon it goes if nobody edits it (?unedited=<ms>, for e2e/full/front/lifetime.e2e.ts).
  const dev = platform.dev(url);
  const unedited = (dev && Number(params.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const id = wanted && dev && ID.test(wanted) ? wanted : newDocId();
    const made = yield* call(() => makeDoc(platform, session.login.toLowerCase(), id, files, { unedited, index, kind }));
    if (made) return redirect(withEdit(link(addressOf(made), session)));
  }
  return page("Couldn't make a document", "Something went wrong picking an address. <a href=\"/new\">Try again</a>.", 500);
});

/**
 * /scratch: a new blank scratch document for the signed-in person, opened in the editor at its random address. It isn't
 * on their list, and it goes delete_docs_after_hours after it's made (never, if that's never) unless they save it (save_document).
 */
export const scratchDoc = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return signInFirst("/scratch");
  if (session.onlyDoc != null) return page("One document only", "This token is for one document: it can't make others.", 403);
  if (request.method == "POST" ? request.headers.get("origin") != url.origin : fromElsewhere(request))
    return confirmAction("Scratch document", "Make a scratch document", `/scratch${url.search}`);
  if (!(yield* call(() => platform.directory.mayWrite(session.login))))
    return page("You can't make documents here", `${esc(NO_WRITE)} <a href="/docs">Your documents</a>`, 403);
  const start = yield* call(() => startingFiles(platform, null));
  if (!start) return page("Couldn't make a document", "This server has no blank page to start from.", 500);
  // Local development may say how soon it goes (?unedited=<ms>), to test it.
  const unedited = (platform.dev(url) && Number(url.searchParams.get("unedited"))) || undefined;
  for (let tries = 0; tries < 5; tries++) {
    const made = yield* call(() =>
      makeDoc(platform, session.login.toLowerCase(), newDocId(), start.files, {
        index: start.index,
        kind: start.kind,
        scratch: true,
        unedited,
      })
    );
    if (made) return redirect(withEdit(link(addressOf(made), session)));
  }
  return page("Couldn't make a document", 'Something went wrong picking an address. <a href="/scratch">Try again</a>.', 500);
});

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
  // A scratch one goes then too, edited or not, published or not.
  const kept = opts.published && !opts.scratch;
  const hours = kept || opts.unedited ? null : await platform.directory.config.get("delete_docs_after_hours");
  const expires = kept ? null : opts.unedited ? created + opts.unedited : hours == null ? null : created + hours * HOUR;
  const index = opts.index ?? "index.html";
  const page = files[index];
  const pageText = typeof page == "string" ? page : page instanceof Uint8Array ? new TextDecoder().decode(page) : "";
  // A project if asked, or if its files have more than one page (a published folder); else a document.
  const kind = opts.kind ?? kindOf(Object.keys(files));
  const { doc, added } = await platform.directory.add({
    id, owner, kind,
    ...(opts.title?.trim() ? { title: opts.title, titleSet: true } : { title: titleOf(pageText) ?? UNTITLED }),
    // A scratch one's address is its random id until it's saved (save_document).
    ...(opts.scratch ? { slug: id, slugSet: true, scratch: true } : opts.slug?.trim() ? { slug: opts.slug, slugSet: true } : {}),
    created,
    expires,
    ...(opts.published ? { modified: created } : {}),
  });
  if (!added) return null;
  if (
    await platform.docs.create(doc, files, index, {
      expires,
      kind,
      ...(opts.published ? { modified: created } : {}),
      ...(opts.scratch ? { scratch: true } : {}),
    })
  )
    return doc;
  // A host by that name was there already (one whose row went): leave it, and try another id.
  await platform.directory.remove(id);
  return null;
}

export interface MakeOptions {
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
  /** A scratch document: off the list, its address its id, and gone delete_docs_after_hours after it's made, edited or not. */
  scratch?: boolean;
}

/** A new document's id: 8 letters and digits, none easily mistaken for another. */

/** /docs: the signed-in person's documents, most recently edited first; /docs/archived: those they archived. */
export const listDocs = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const archived = url.pathname == "/docs/archived";
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) return signInFirst(url.pathname);
  if (session.onlyDoc != null) return page("One document only", "This token is for one document: it can't list others.", 403);
  const [docs, hours, asks] = yield* call(() =>
    Promise.all([
      platform.docs.list(session.login, { archived }),
      platform.directory.config.get("delete_docs_after_hours"),
      archived ? [] : platform.directory.requests.waiting(session.login),
    ])
  );
  return html(docsPage(session, docs, Date.now(), hours, archived, asks), 200, NO_STORE);
});

/**
 * POST <document>/api/share {rotate}: the share button's token, the
 * person's one 'share' token, the same each time until rotated.
 */
export const shareToken = Effect.fnUntraced(function* (session: Session) {
  const { request, url, platform } = yield* ctx;
  const refuse = (error: string) => plainJson({ ok: false, error }, 403);
  // The server's browser (Session.view) runs an agent's code in the viewer's window: an agent too.
  if (session.agent || session.view) return refuse("An agent can't make tokens.");
  const origin = request.headers.get("origin");
  if (origin && origin != url.origin) return refuse("Forbidden");
  // Any body that isn't { rotate: true } keeps the token as it is.
  const { rotate } = yield* call(() => request.json().catch(() => ({}))).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RotateBody)),
    Effect.orElseSucceed(() => ({ rotate: false }))
  );
  const via = whoOf(session).via;
  const { token } = yield* call(() =>
    platform.tokens.share({ login: session.login, name: session.name, ...(via ? { via } : {}) }, rotate === true)
  );
  return json({ token });
});

const RotateBody = Schema.Struct({ rotate: Schema.optional(Schema.Unknown) });
