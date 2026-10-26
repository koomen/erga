// The viewer on a document: the page at /<owner>/<slug> (and the front page, /), which is
// the editor too for whoever may edit (?edit). It holds the document's page in one frame,
// on the document's own pages origin (pages-origin.ts: the page with what the viewer and
// the editor need in it, pages/reader.ts), for readers and editors alike: the page loads
// once, and going into the editor loads the editor into it.
//
// One call to the document's host says what this page needs (Platform.docs.view): what the
// person may do (the host decides, on its copy of the document's permissions), and which
// file the address is. The answer is kept: what someone may see at an address (the
// document, their role, the file), by the address and who they are, for DECISION_MS (in
// this isolate's memory and the edge's cache), when the document is quiet (no file changed
// in the last minute: one being edited is asked each time). It's theirs alone: the key
// names them. A change of permissions, or of a quiet document, reaches it within that time
// (this isolate forgets a change of permissions at once).
//
// So a second view in a short while asks neither the database nor the document. The page
// has an ETag (everything it says); the browser checks it each time (`private, no-cache`),
// and an unchanged page is a 304.
//
// The page is rendered whole here, with the account corner and live.js (what server/app.ts
// adds to the site's other pages, reading them back).

import { pageAddress } from "../../document/pages.ts";
import type { ViewAnswer } from "../../document/view.ts";
import { mayDeploy } from "../identity/index.ts";
import { ID, OWNER, roleMay } from "../directory/index.ts";
import type { Role } from "../../document/access.ts";
import { BUILD_HEADER, CHECK_HEADER, pageBuild } from "../live.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { frontDocument, landingPage } from "./landing.ts";
import { pagesOrigin, pagesToken } from "./pages-origin.ts";
import {
  accountHtml,
  accountOf,
  cloneButton,
  editButton,
  filesButton,
  filesPage,
  link,
  OWN_ACCOUNT,
  page,
  scriptTag,
  startPage,
  viewerPage,
  withEdit,
} from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { base64url, sha256 } from "../../shared/bytes.ts";

/** How long a decision (who may see what at an address) is kept: as long as the directory keeps who's an admin (users.ts). */
export const DECISION_MS = 10_000;

/** What someone may see at an address: the document, its name, their role, the version viewers see and the file it is. */
interface Decision {
  id: string;
  owner: string;
  slug: string;
  title: string;
  role: Role | null;
  ver: string;
  file: string;
  /** The page's own address under the document's ("" for its own page). */
  canonical: string;
}

/** Decisions in this isolate: key -> when, and what. */
const decisions = new Map<string, { at: number; d: Decision }>();
/** Documents whose permissions changed, and when: a decision made before (here or kept at the edge) no longer holds. */
const changed = new Map<string, number>();

// (Keys on this site's own origin, at a path nothing serves: the edge's cache holds only its own zone's addresses.)
const decisionKey = (url: URL, who: string) => `${url.origin}/_erga-cache/view${url.pathname}?who=${encodeURIComponent(who)}`;

/** Who's asking, as a decision's key names them: everything Directory.decide looks at. */
const whoKey = (session: Session | null) => (session ? JSON.stringify(whoOf(session)) : "");

async function keptDecision(platform: Platform, key: string): Promise<Decision | null> {
  const mine = decisions.get(key);
  if (mine && Date.now() - mine.at < DECISION_MS) return mine.d;
  const hit = await platform.edge.cache?.match(key).catch(() => undefined);
  if (!hit) return null;
  const kept = (await hit.json().catch(() => null)) as { at: number; d: Decision } | null;
  if (!kept || Date.now() - kept.at >= DECISION_MS || kept.at <= (changed.get(kept.d.id) ?? 0)) return null;
  decisions.set(key, kept);
  return kept.d;
}

function keepDecision(platform: Platform, key: string, d: Decision): void {
  const kept = { at: Date.now(), d };
  if (decisions.size > 5000) decisions.clear();
  decisions.set(key, kept);
  const cache = platform.edge.cache;
  if (cache) platform.edge.background(cache.put(key, Response.json(kept, { headers: { "Cache-Control": `max-age=${Math.ceil(DECISION_MS / 1000)}` } })).catch(() => {}));
}

/** This isolate forgets what it decided for a document (its permissions changed). */
export function forgetDecisions(id: string): void {
  if (changed.size > 5000) changed.clear();
  changed.set(id, Date.now());
  for (const [key, { d }] of decisions) if (d.id == id) decisions.delete(key);
}

/** Whether two paths are the same address, however each is percent-encoded. */
const samePath = (a: string, b: string) => {
  try { return decodeURIComponent(a) == decodeURIComponent(b); } catch { return a == b; }
};

const nothing = () => page("Not found", "There's no document here. <a href=\"/\">Back to the start</a>.", 404);

/** A document that's there, at a page that isn't. */
const noPage = (address: string) => page("Not found", `This document has no page here. <a href="${esc(address)}">Go to its first page</a>.`, 404);

const refused = (session: Session) => session.test
  ? page("Test documents only", "Test people can open only test documents.", 403)
  : page("Not shared with you", `This document hasn't been shared with <b>${esc(session.login)}</b>. Ask its owner to share it with you.`, 403);

/** A page's address under its document's, as the address bar has it. */
const suffix = (canonical: string) => (canonical ? `/${canonical.split("/").map(encodeURIComponent).join("/")}` : "");

/**
 * The viewer at /<first>/<second>[/<page>] (`first` an owner, or "d" with an id): the document's page for whoever
 * it's shared with, at its canonical address (other addresses redirect there).
 */
export async function viewAddress(platform: Platform, request: Request, session: Session, first: string, second: string, wanted: string): Promise<Response> {
  const url = new URL(request.url);
  const key = decisionKey(url, whoKey(session));
  let d = await keptDecision(platform, key);
  let answer: ViewAnswer | null = null;
  if (!d) {
    // The document at the address: by id straight from its host; by slug, the directory finds it.
    let row: { id: string; owner: string; slug: string; title: string } | null = null;
    if (first == "d") { if (!ID.test(second)) return nothing(); }
    else {
      if (!OWNER.test(first)) return nothing();
      row = (await platform.directory.locate(first, second))?.doc ?? null;
      if (!row) return nothing();
    }
    const id = row?.id ?? second;
    answer = await platform.docs.view(id, whoOf(session), { page: wanted });
    if (!answer) return nothing();
    if (!answer.role) return refused(session);
    const name = row ?? answer.name ?? (await platform.directory.get(id));
    if (!name) return nothing();
    if (answer.file == null || answer.ver == null) return noPage(`/${name.owner}/${name.slug}`);
    d = { id, owner: name.owner, slug: name.slug, title: name.title, role: answer.role, ver: answer.ver, file: answer.file, canonical: answer.canonical ?? "" };
    if (answer.quiet) keepDecision(platform, key, d);
  }
  const canonical = `/${d.owner}/${d.slug}${suffix(d.canonical)}`;
  if (!samePath(url.pathname, canonical) && !samePath(url.pathname, `${canonical}/`)) return new Response(null, { status: 302, headers: { Location: canonical + url.search, "Cache-Control": "no-store" } });
  if (url.searchParams.has("files")) return renderFiles(platform, request, session, d);
  return render(platform, request, session, d, false);
}

/**
 * The viewer for someone who isn't signed in, at /<owner>/<slug>[/<page>]: a document shared with anyone with the link,
 * while the server lets users share content publicly (Directory.isPublic). They view it only. Null for any other: they
 * sign in first, as before.
 */
export async function viewPublic(platform: Platform, request: Request, first: string, second: string, wanted: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (first == "d" || !OWNER.test(first)) return null;
  const row = (await platform.directory.locate(first, second))?.doc ?? null;
  if (!row || !(await platform.directory.isPublic(row.id))) return null;
  const answer = await platform.docs.view(row.id, null, { page: wanted, anyone: true });
  if (!answer || answer.file == null || answer.ver == null) return null;
  const d: Decision = { id: row.id, owner: row.owner, slug: row.slug, title: row.title, role: "viewer", ver: answer.ver, file: answer.file, canonical: answer.canonical ?? "" };
  const canonical = `/${d.owner}/${d.slug}${suffix(d.canonical)}`;
  if (!samePath(url.pathname, canonical) && !samePath(url.pathname, `${canonical}/`)) return new Response(null, { status: 302, headers: { Location: canonical + url.search, "Cache-Control": "no-store" } });
  return render(platform, request, null, d, false);
}

/**
 * The files view (?files: server/pages/files.ts): every file of the document, for whoever may view it; whoever may
 * edit adds, moves, renames and deletes them there. Its files come from the pages origin, under a token as the viewer's.
 */
async function renderFiles(platform: Platform, request: Request, session: Session, d: Decision): Promise<Response> {
  const url = new URL(request.url);
  const canEdit = !session.agent && roleMay(d.role, "edit");
  const by = platform.adminsOnly ? session.login : null;
  const token = await pagesToken(platform.secret, d.owner, d.id, url.origin, undefined, by ? { by } : {});
  const pages = `${pagesOrigin(d.owner, d.id, url, platform)}/t/${token}/`;
  const html = filesPage({ session, title: d.title, address: `/${d.owner}/${d.slug}`, docId: d.id, pages, canEdit });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/**
 * The front page: the viewer on the landing document (the landing_document setting), for anyone, signed in or not.
 * Made from the repo's assets/landing/ if there's none (landing.ts).
 */
export async function viewLanding(platform: Platform, request: Request, session: Session | null): Promise<Response> {
  const url = new URL(request.url);
  // (Which document the setting names is part of the key: another one is another decision.)
  // None set yet: nothing kept (the seed below sets one).
  const home = await platform.directory.homeId();
  const key = home ? `${decisionKey(url, whoKey(session))}&home=${home}` : null;
  let d = key ? await keptDecision(platform, key) : null;
  if (!d) {
    const who = session ? whoOf(session) : null;
    const doc = await frontDocument(platform);
    let answer = doc ? await platform.docs.view(doc.id, who, { page: "", anyone: true }) : null;
    let row = answer?.file != null ? doc : null;
    if (!row) {
      // None yet, or one that's gone: made (or found) afresh.
      const made = await landingPage(platform);
      if (!made) return startPage(platform, session);
      answer = await platform.docs.view(made.doc.id, who, { page: "", anyone: true });
      row = answer?.file != null ? made.doc : null;
    }
    if (!row || !answer || answer.file == null || answer.ver == null) return nothing();
    d = { id: row.id, owner: row.owner, slug: row.slug, title: row.title, role: answer.role, ver: answer.ver, file: answer.file, canonical: "" };
    if (answer.quiet && key && row.id == home) keepDecision(platform, key, d);
  }
  return render(platform, request, session, d, true);
}

/** What the editor's menu on your avatar needs to know that the document doesn't: the links it offers. */
const accountMeta = (session: Session, admin: boolean, deploy: boolean) => {
  const links = { docs: link("/docs", session), settings: link("/settings", session), ...(deploy ? { deploy: link("/deploy", session) } : {}), ...(admin ? { admin: link("/admin", session) } : {}), signOut: "/auth/logout" };
  return `<meta name="erga-account" content="${esc(JSON.stringify(links))}">`;
};

/** A short digest of text, for the page's ETag. */
async function digestOf(text: string): Promise<string> {
  return base64url((await sha256(text)).slice(0, 16));
}

/**
 * The page: the band, the controls, the document's page in its frame on its pages origin (with the token that opens its
 * files there: an editor's says so, and its pages come with what the editor needs). For whoever may edit, what the
 * editor needs too (the document's host, the account's links); opened with ?edit, the editor from the first response.
 */
async function render(platform: Platform, request: Request, session: Session | null, d: Decision, landing: boolean): Promise<Response> {
  const url = new URL(request.url);
  const dir = platform.directory;
  const canEdit = !!session && !session.agent && roleMay(d.role, "edit");
  const editing = canEdit && url.searchParams.has("edit");
  const [admin, deploy] = await Promise.all([session ? dir.users.isAdmin(whoOf(session)) : false, mayDeploy(dir, session)]);
  // On a server for admins alone (staging), the token names the admin.
  const by = platform.adminsOnly && session ? session.login : null;
  const token = await pagesToken(platform.secret, d.owner, d.id, url.origin, undefined, { ...(by ? { by } : {}), ...(canEdit ? { edit: true } : {}) });
  const origin = pagesOrigin(d.owner, d.id, url, platform);
  const files = `${origin}/t/${token}/`;
  const address = `/${d.owner}/${d.slug}`;
  const clone = cloneButton(link(`/new?from=${landing ? "landing" : d.id}`, session));
  const here = pageAddress(d.file) ? `${address}/${pageAddress(d.file).split("/").map(encodeURIComponent).join("/")}` : address;
  const edit = canEdit ? editButton(withEdit(link(here, session)), false) : "";
  const canShare = canEdit && !!session && !session.test && roleMay(d.role, "share");
  const meta = `<meta name="erga-address" content="${esc(address)}"><meta name="erga-page" content="${esc(d.file)}"><meta name="erga-pages" content="${esc(files)}">` + (canEdit && session
    ? `<meta name="erga-base" content="/d/${d.id}">${canShare ? `<meta name="erga-share" content="${esc(link("/docs/share", session))}">` : ""}${accountMeta(session, admin && !session.agent, deploy)}`
    : "");
  // The page's own address there: its file, under the token.
  const src = files + d.file.split("/").map(encodeURIComponent).join("/");
  // The files view, for whoever signed in may view the document; on the front page (everyone's), for whoever may edit it.
  const filesLink = session && !session.agent && (!landing || canEdit) ? filesButton(link(`${address}?files`, session)) : "";
  const shell = viewerPage({ title: d.title, docId: d.id, pages: origin, src, meta, session, editable: canEdit, editing, landing, clone, edit, files: filesLink });
  const corner = accountHtml(accountOf(session, admin, deploy), url.pathname + url.search);
  const before = shell.before, after = shell.after + corner;
  const build = await pageBuild(before + after);
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache", "Referrer-Policy": "no-referrer",
    [BUILD_HEADER]: build, [OWN_ACCOUNT]: "1", Vary: "Cookie",
    // The page's origin, connected to as early as can be (an early hint, where the edge sends them).
    Link: `<${origin}>; rel=preconnect`,
  });
  // live.js asking whether the page's code changed: the build alone.
  if (request.headers.get(CHECK_HEADER) == "build") return new Response(null, { status: 204, headers });
  const live = `<meta name="erga-build" content="${build}">${scriptTag("live.js")}`;
  const body = before + after + live + "\n</body>\n</html>";
  const etag = `"${await digestOf(body)}"`;
  headers.set("ETag", etag);
  if (request.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") == etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method == "HEAD" ? null : body, { headers });
}
