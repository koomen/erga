// The viewer on a document: the page at /<owner>/<slug> (and the homepage, /), which is
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
// names them (someone signed out, on a public document: nobody). A change of permissions,
// of the readers' options, or of a quiet document, reaches it within that time
// (this isolate forgets a change of permissions at once).
//
// So a second view in a short while asks neither the database nor the document. A first
// one asks for the document's row while the session is found (`locating`), not after. The page
// has an ETag (everything it says); the browser checks it each time (`private, no-cache`),
// and an unchanged page is a 304.
//
// The page is rendered whole here, with the account corner and live.js (what server/app.ts
// adds to the site's other pages, reading them back).

import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { call, ctx, html, redirect } from "../http.ts";
import { pageAddress } from "../../document/pages.ts";
import type { ViewAnswer } from "../../document/view.ts";
import type { PageHead } from "../../shared/page-head.ts";
import { type DocRow, ID, OWNER, roleMay } from "../directory/index.ts";
import type { Role } from "../../document/access.ts";
import type { DocKind } from "../../document/pages.ts";
import { BUILD_HEADER, CHECK_HEADER, pageBuild } from "../live.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { frontDocument, landingPage } from "./landing.ts";
import { pagesOrigin, pagesToken } from "./pages-origin.ts";
import {
  accountHtml,
  accountOf,
  editButton,
  hasAgent,
  inlineScript,
  link,
  OWN_ACCOUNT,
  page,
  scriptTag,
  startPage,
  viewerPage,
  withEdit,
} from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { pageToken } from "../home/index.ts";

const HALF_HOUR = 1_800_000;
import { sha256 } from "../../shared/bytes.ts";
import { addressOf, HOME_OWNER } from "../../document/names.ts";
import { colorFor } from "../../document/content.ts";

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
  /** The document's share counter (document/access.ts): the pass to its files carries it. */
  shares?: number;
  /** A project (pages: its crumb opens its tree), or not; null if its row doesn't say. */
  kind?: DocKind | null;
  /** The page's head's details (shared/page-head.ts): the tab's title and icon, and a link's preview. */
  head?: PageHead;
  /** A scratch document: when it goes (null: never). */
  scratch?: { expires: number | null };
  /** What its readers get, as its owner set it (DocRow.readers). */
  readers: { agent: boolean; bars: boolean };
}

/** Decisions in this isolate: key -> when, and what. */
const decisions = new Map<string, { at: number; d: Decision }>();
/** Documents whose permissions changed, and when: a decision made before (here or kept at the edge) no longer holds. */
const changed = new Map<string, number>();
/** When every decision made before stopped holding (public sharing went on or off). */
let allChanged = 0;
/** Addresses with a decision kept here, and when: `locating` asks for no row that a kept decision makes needless. */
const keptAt = new Map<string, number>();

// (Keys on this site's own origin, at a path nothing serves: the edge's cache holds only its own zone's addresses.)
const addressKey = (url: URL) => `${url.origin}/_erga-cache/view${url.pathname}`;
const decisionKey = (url: URL, who: string) => `${addressKey(url)}?who=${encodeURIComponent(who)}`;

/** Who's asking, as a decision's key names them: everything Directory.decide looks at. */
const whoKey = (session: Session | null) => (session ? JSON.stringify(whoOf(session)) : "");

async function keptDecision(platform: Platform, key: string): Promise<Decision | null> {
  const mine = decisions.get(key);
  if (mine && Date.now() - mine.at < DECISION_MS) return mine.d;
  const hit = await platform.edge.cache?.match(key).catch(() => undefined);
  if (!hit) return null;
  const kept = (await hit.json().catch(() => null)) as { at: number; d: Decision } | null;
  if (!kept || Date.now() - kept.at >= DECISION_MS || kept.at <= Math.max(allChanged, changed.get(kept.d.id) ?? 0)) return null;
  decisions.set(key, kept);
  return kept.d;
}

function keepDecision(platform: Platform, key: string, d: Decision): void {
  const kept = { at: Date.now(), d };
  if (decisions.size > 5000) decisions.clear();
  decisions.set(key, kept);
  if (keptAt.size > 5000) keptAt.clear();
  keptAt.set(key.slice(0, key.indexOf("?who=")), kept.at);
  const cache = platform.edge.cache;
  if (cache) platform.edge.background(cache.put(key, Response.json(kept, { headers: { "Cache-Control": `max-age=${Math.ceil(DECISION_MS / 1000)}` } })).catch(() => {}));
}

/**
 * This isolate forgets what it decided for a document (its permissions or its readers' options changed); with no
 * document, all it decided (public sharing went on or off).
 */
export function forgetDecisions(id?: string): void {
  if (id == null) {
    allChanged = Date.now();
    decisions.clear();
    return;
  }
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

/**
 * A document that isn't shared with the person signed in: who owns it, and three ways out. "Ask <owner> for access"
 * sends a request (the operation request_access; `asked`: they did already), which the owner sees on their documents
 * list; "Use another account" signs out; "Your documents" is their list.
 */
const refused = (session: Session, doc: { id: string; owner: string }, asked: boolean) =>
  page(
    "Not shared with you",
    `<b>${esc(doc.owner)}</b> has not shared this document with <b>${esc(session.login)}</b>.</p>
<p class="ways"><button type="button" class="new" id="ask-access" data-doc="${esc(doc.id)}"${asked ? " disabled" : ""}>${asked ? "Asked" : `Ask ${esc(doc.owner)} for access`}</button><a class="way" href="/auth/logout">Use another account</a><a class="way" href="${esc(link("/docs", session))}">Your documents</a></p>
<p id="ask-note" role="status" data-asked="${esc(doc.owner)} sees your request on their documents list.">${asked ? `${esc(doc.owner)} sees your request on their documents list.` : ""}${inlineScript("ask-access")}`,
    403
  );

/** An address under a document's that names a file that isn't a page: its last part has an extension, not .html. */
const FILE = /(?:^|\/)[^/]+\.(?!html?$)[a-z0-9]+$/i;

/** A page's address under its document's, as the address bar has it. */
const suffix = (canonical: string) => (canonical ? `/${canonical.split("/").map(encodeURIComponent).join("/")}` : "");

/** A document's row at /<owner>/<slug>, as Directory.locate finds it. */
type Located = Awaited<ReturnType<Platform["directory"]["locate"]>>;

/**
 * The row of the document at /<first>/<second>, asked for now: the route finds the session meanwhile, so the two
 * questions to the database don't wait for each other. Null where the view needs no row: an id (its host names
 * it), or an address with a decision kept here a moment ago.
 */
export function locating(platform: Platform, url: URL, first: string, second: string): Promise<Located> | null {
  if (first == "d" || !OWNER.test(first) || Date.now() - (keptAt.get(addressKey(url)) ?? 0) < DECISION_MS) return null;
  const row = platform.directory.locate(first, second);
  // Awaited by the view, or (a kept decision after all) by nobody.
  row.catch(() => {});
  return row;
}

/**
 * The viewer at /<first>/<second>[/<page>] (`first` an owner, or "d" with an id): the document's page for whoever
 * it's shared with, at its canonical address (other addresses redirect there). `located`: its row, asked for already.
 */
export const viewAddress = (session: Session, first: string, second: string, wanted: string, located: Promise<Located> | null) =>
  Effect.flatMap(ctx, ({ platform, request }) => call(() => address(platform, request, session, first, second, wanted, located)));

async function address(
  platform: Platform,
  request: Request,
  session: Session,
  first: string,
  second: string,
  wanted: string,
  located: Promise<Located> | null
): Promise<HttpServerResponse.HttpServerResponse> {
  const url = new URL(request.url);
  const key = decisionKey(url, whoKey(session));
  let d = await keptDecision(platform, key);
  let answer: ViewAnswer | null = null;
  if (!d) {
    // The document at the address: by id straight from its host; by slug, the directory finds it.
    let row: DocRow | null = null;
    if (first == "d") {
      if (!ID.test(second)) return nothing();
    } else {
      if (!OWNER.test(first)) return nothing();
      row = (await (located ?? platform.directory.locate(first, second)))?.doc ?? null;
      if (!row) return nothing();
    }
    const id = row?.id ?? second;
    answer = await platform.docs.view(id, whoOf(session), { page: wanted });
    if (!answer) return nothing();
    if (!answer.role) {
      const doc = row ?? (await platform.directory.route(id));
      if (!doc) return nothing();
      return refused(session, { id, owner: doc.owner }, (await platform.directory.requests.state(id, session.login)) != null);
    }
    const name = row ?? answer.name ?? (await platform.directory.get(id));
    if (!name) return nothing();
    // A file that isn't a page (style.css, assets/owl.png: a project's tree links to them) opens as itself, on the
    // document's pages origin, where its scripts can't reach the app; the pages origin answers 404 if it isn't there.
    if (answer.file == null && FILE.test(wanted)) {
      const by = platform.adminsOnly ? session.login : null;
      const token = await pagesToken(platform.secret, name.owner, id, url.origin, undefined, {
        ...(by ? { by } : {}),
        shares: answer.shares,
      });
      return redirect(`${pagesOrigin(name.owner, id, url, platform)}/t/${token}/${wanted}`, 302, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
    }
    if (answer.file == null || answer.ver == null) return noPage(addressOf(name));
    d = {
      id,
      owner: name.owner,
      slug: name.slug,
      title: name.title,
      role: answer.role,
      ver: answer.ver,
      file: answer.file,
      canonical: answer.canonical ?? "",
      shares: answer.shares,
      kind: row?.kind ?? null,
      head: answer.head,
      ...(row?.scratch ? { scratch: { expires: row.expires } } : {}),
      // By id, the page only redirects to the document's address (below), where its row gives the readers' options.
      readers: row?.readers ?? { agent: false, bars: true },
    };
    if (answer.quiet) keepDecision(platform, key, d);
  }
  const canonical = `${addressOf(d)}${suffix(d.canonical)}`;
  if (!samePath(url.pathname, canonical) && !samePath(url.pathname, `${canonical}/`))
    return redirect(canonical + url.search, 302, { "Cache-Control": "no-store" });
  return render(platform, request, session, d, false);
}

/**
 * The viewer for someone who isn't signed in, at /<owner>/<slug>[/<page>]: a document shared with anyone with the link,
 * while the server lets users share content publicly (Directory.isPublic), and the homepage project (/_home). They view it only. Null for any other: they
 * sign in first, as before.
 */
export const viewPublic = (first: string, second: string, wanted: string, located: Promise<Located> | null) =>
  Effect.flatMap(ctx, ({ platform, request }) => call(() => publicView(platform, request, first, second, wanted, located)));

async function publicView(
  platform: Platform,
  request: Request,
  first: string,
  second: string,
  wanted: string,
  located: Promise<Located> | null
): Promise<HttpServerResponse.HttpServerResponse | null> {
  const url = new URL(request.url);
  if (first == "d" || !OWNER.test(first)) return null;
  // Kept as a signed-in person's is: a busy public document asks neither the database nor the document.
  const key = decisionKey(url, "");
  let d = await keptDecision(platform, key);
  if (!d) {
    const row = (await (located ?? platform.directory.locate(first, second)))?.doc ?? null;
    // The homepage project is public, as the homepage is at /.
    if (!row || (row.owner != HOME_OWNER && !(await platform.directory.isPublic(row.id)))) return null;
    const answer = await platform.docs.view(row.id, null, { page: wanted, anyone: true });
    if (!answer || answer.file == null || answer.ver == null) return null;
    d = {
      id: row.id,
      owner: row.owner,
      slug: row.slug,
      title: row.title,
      role: "viewer",
      ver: answer.ver,
      file: answer.file,
      canonical: answer.canonical ?? "",
      shares: answer.shares,
      head: answer.head,
      readers: row.readers,
    };
    if (answer.quiet) keepDecision(platform, key, d);
  }
  const canonical = `${addressOf(d)}${suffix(d.canonical)}`;
  if (!samePath(url.pathname, canonical) && !samePath(url.pathname, `${canonical}/`))
    return redirect(canonical + url.search, 302, { "Cache-Control": "no-store" });
  return render(platform, request, null, d, false);
}

/**
 * The homepage: the viewer on the landing document (the landing_document setting), for anyone, signed in or not.
 * Made from the repo's assets/landing/ if there's none (landing.ts).
 */
export const viewLanding = Effect.gen(function* () {
  const { platform, request } = yield* ctx;
  return yield* call(async () => landingView(platform, request, await platform.sessionOf(request)));
});

async function landingView(platform: Platform, request: Request, session: Session | null): Promise<HttpServerResponse.HttpServerResponse> {
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
    d = {
      id: row.id,
      owner: row.owner,
      slug: row.slug,
      title: row.title,
      role: answer.role,
      ver: answer.ver,
      file: answer.file,
      canonical: "",
      shares: answer.shares,
      head: answer.head,
      readers: row.readers,
    };
    if (answer.quiet && key && row.id == home) keepDecision(platform, key, d);
  }
  return render(platform, request, session, d, true);
}

/** What the editor's menu on your avatar needs to know that the document doesn't: the links it offers. */
const accountMeta = (session: Session, admin: boolean) => {
  const links = {
    docs: link("/docs", session),
    settings: "#settings",
    ...(admin ? { admin: link("/admin", session) } : {}),
    feedback: "#feedback",
    signOut: "/auth/logout",
  };
  return `<meta name="erga-account" content="${esc(JSON.stringify(links))}">`;
};

/** A short digest of text, for the page's ETag. */
async function digestOf(text: string): Promise<string> {
  return Base64Url.encode((await sha256(text)).slice(0, 16));
}

/**
 * The page: the band, the controls, the document's page in its frame on its pages origin (with the token that opens its
 * files there: an editor's says so, and its pages come with what the editor needs). For whoever may edit, what the
 * editor needs too (the document's host, the account's links); opened with ?edit, the editor from the first response.
 */
async function render(
  platform: Platform,
  request: Request,
  session: Session | null,
  d: Decision,
  landing: boolean
): Promise<HttpServerResponse.HttpServerResponse> {
  const url = new URL(request.url);
  const dir = platform.directory;
  const canEdit = !!session && !session.agent && roleMay(d.role, "edit");
  const editing = canEdit && url.searchParams.has("edit");
  // Someone who may comment and not edit: the comments alone, on the page (client/inline/viewer-comment.ts).
  const canComment = !canEdit && !!session && !session.agent && roleMay(d.role, "comment");
  const admin = session ? await dir.users.isAdmin(whoOf(session)) : false;
  // On a server for admins alone (staging), the token names the admin.
  const by = platform.adminsOnly && session ? session.login : null;
  const token = await pagesToken(platform.secret, d.owner, d.id, url.origin, undefined, {
    ...(by ? { by } : {}),
    ...(canEdit || canComment ? { edit: true } : {}),
    shares: d.shares,
  });
  const origin = pagesOrigin(d.owner, d.id, url, platform);
  // A reader's files are at an address with the document's version: the browser keeps them until the version changes
  // (pages-origin.ts). Whoever has the page's editor gets them checked each time: the page changes under it.
  const files = `${origin}/t/${token}/${canEdit || canComment ? "" : `@${d.ver}/`}`;
  const address = addressOf(d);
  const clone = link(`/new?from=${landing ? "landing" : d.id}`, session);
  const here = pageAddress(d.file) ? `${address}/${pageAddress(d.file).split("/").map(encodeURIComponent).join("/")}` : address;
  const edit = canEdit ? editButton(withEdit(link(here, session)), false) : "";
  const canShare = canEdit && !!session && roleMay(d.role, "share");
  // What a reader gets, as the owner set it (share_document: reader_agent, reader_bars): an editor gets all of it. Their agent
  // (signed in, with a role here), and Erga's bars over the page.
  const reader = canEdit ? { agent: true, bars: true } : d.readers;
  const agent = hasAgent(session) && (canEdit || (roleMay(d.role, "open") && reader.agent));
  // Someone signed out: the page's token, for its model where the owner lets all viewers call it (agents/page-llm.ts).
  // Made at the start of a half hour, so the page, and its ETag, stay the same for a while.
  const llmToken = session ? "" : await pageToken(platform.secret, d.id, Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR);
  const meta =
    `<meta name="erga-address" content="${esc(address)}"><meta name="erga-page" content="${esc(d.file)}"><meta name="erga-pages" content="${esc(files)}">` +
    (llmToken ? `<meta name="erga-llm-token" content="${esc(llmToken)}">` : "") +
    (canEdit && session
      ? `<meta name="erga-base" content="/d/${d.id}">${canShare ? `<meta name="erga-share" content="owner">` : ""}${accountMeta(session, admin && !session.agent)}`
    : "");
  const shell = viewerPage({
    title: d.title,
    head: d.head ?? {},
    file: d.file,
    files,
    docId: d.id,
    pages: origin,
    meta,
    session,
    editable: canEdit,
    agent,
    bars: reader.bars,
    editing,
    landing,
    clone,
    edit,
    corner: accountHtml(accountOf(session, admin), url.pathname + url.search),
    // The page follows each change while it's open: for someone signed in in their browser, who may open its room.
    ...(session && !session.agent ? { live: d.ver } : {}),
    ...(session && !session.agent && d.kind == "project" ? { project: address } : {}),
    ...(canComment && session
      ? {
          commenter: {
            user: session.login,
            name: session.name,
            color: colorFor(session.login),
            ...(session.avatar ? { avatar: session.avatar } : {}),
          },
        }
      : {}),
    // A scratch document, for its owner: Save, with how long an unsaved one stays (the setting; none if this one stays).
    ...(canShare && d.scratch
      ? { scratch: { hours: d.scratch.expires == null ? null : await platform.directory.config.get("delete_docs_after_hours") } }
      : {}),
  });
  const before = shell.before,
    after = shell.after;
  const build = await pageBuild(before + after);
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    "Referrer-Policy": "no-referrer",
    [BUILD_HEADER]: build,
    [OWN_ACCOUNT]: "1",
    Vary: "Cookie",
    // The page's origin, connected to as early as can be (an early hint, where the edge sends them).
    Link: `<${origin}>; rel=preconnect`,
  };
  const empty = (status: number) =>
    HttpServerResponse.empty({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
  // live.js asking whether the page's code changed: the build alone.
  if (request.headers.get(CHECK_HEADER) == "build") return empty(204);
  // A view of the document, in the day's counts (server/directory/activity.ts), after the answer; never a prefetch.
  if (!landing && request.method == "GET" && !request.headers.get("sec-purpose")?.includes("prefetch"))
    platform.edge.background(
      dir.activity.add(session?.login ?? null, { view: 1 }).catch((e) => console.log(`couldn't count a view: ${e}`))
    );
  const live = `<meta name="erga-build" content="${build}">${scriptTag("live.js")}`;
  const body = before + after + live + "\n</body>\n</html>";
  const etag = `"${await digestOf(body)}"`;
  headers.ETag = etag;
  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some((t) => t.trim().replace(/^W\//, "") == etag)
  )
    return empty(304);
  return request.method == "HEAD" ? empty(200) : html(body, 200, headers);
}
