// What every page of the site's own shares: escaping, the plain page, the app page's
// shell and style, the breadcrumbs, the icons, and the small helpers around redirects.

import { inlineCall, inlineStyle } from "./inline.ts";
import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { fontTags, styleTag } from "./assets.ts";
import { esc } from "../../shared/html.ts";
import { html, NO_STORE, redirect } from "../http.ts";

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
export const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** An address with ?edit (its query kept): the editor on it. */
export const withEdit = (href: string) => href + (href.includes("?") ? "&" : "?") + "edit";


/** The footer at the foot of Erga's own pages (not the editor's, nor a document's): the copyright, this year. */
export const siteFooter = () => `<footer class="site-foot">© ${new Date().getUTCFullYear()} Erga</footer>`;

/** One step of the breadcrumbs: a page above this one (with its address), or this page (without). */
export interface Crumb { label: string; href?: string }

/**
 * The breadcrumbs in the upper left of every page for someone signed in: the wordmark (back to the homepage), then
 * the pages above this one, then this one. `here` is the tag of this page's own crumb (the admin pages' is their <h1>).
 */
export function crumbs(session: Session | null, trail: Crumb[], here = "span", home = "/"): string {
  const steps = trail.map((c) => c.href
    ? `<a class="crumb" href="${esc(link(c.href, session))}">${esc(c.label)}</a>`
    : `<${here} class="here" aria-current="page"><span>${esc(c.label)}</span></${here}>`).join("");
  return `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="${esc(link(home, session))}" draggable="false"><span>${WORDMARK}</span></a>${steps}</nav>`;
}

/** The breadcrumbs' type (Inter, as the editor's), for a page that shows them (viewCrumbs) but has none of the app's style: its rules only, which wait for nothing. Signed out, only where they show (`signedOut`). */
export const crumbsFont = (session: Session | null, signedOut = false) => ((session ? !session.agent : signedOut) ? fontTags() : "");

/**
 * The breadcrumbs (VIEW_STYLE): erga › Documents › the document, as the editor's. In the viewer they're in its glass bar
 * (`bar`: client/inline/bars.css), signed out too, as erga › the document. The homepage's are the wordmark alone, and
 * only for someone signed in; a test person's skip Documents, as they have none. An agent sees none.
 */
export function viewCrumbs(session: Session | null, title: string | null, project = false, bar = false): string {
  if (session?.agent || (!session && !bar)) return "";
  const docs = session && !session.test ? `<a class="erga-crumb" href="${esc(link("/docs", session))}">Documents</a>` : "";
  // A project's crumb opens its tree (the card after the crumbs: client/inline/viewer-tree.ts), as the editor's does.
  const tree = project && !!session;
  const crumb = tree
    ? `<button type="button" class="erga-here erga-tree-btn" aria-expanded="false" aria-controls="erga-tree" aria-label="${esc(title ?? "")}: its pages"><span>${esc(title ?? "")}</span><svg class="erga-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>`
    : `<span class="erga-here" aria-current="page"><span>${esc(title ?? "")}</span></span>`;
  const here = title == null ? "" : docs + crumb;
  const card = tree && title != null ? `<div id="erga-tree" class="erga-tree-card" role="dialog" aria-label="Pages" hidden></div>` : "";
  return `<nav class="erga-crumbs${bar ? " erga-bar erga-bar-l" : ""}" aria-label="Breadcrumbs"><a class="erga-brand" href="${esc(link("/", session))}" draggable="false"><span>${WORDMARK}</span></a>${here}</nav>${card}`;
}

/** Every <time datetime> in the reader's own language and zone (client/inline/times.ts): a statement, inside a page's script. */
export const TIMES_SCRIPT = inlineCall("times");

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
${fontTags(true)}
${styleTag()}
<style>${inlineStyle("app")}${style}</style>
${body}
${footer ? siteFooter() : ""}
</html>`;

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
 * A visit that starts outside Erga: a typed address or a bookmark ("none"), or another site's link. The browser says
 * so (Sec-Fetch-Site). A click inside Erga ("same-origin") or a client that doesn't say (a script, a test) doesn't.
 */
export const cameFromOutside = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  return site != null && site != "same-origin";
};

/**
 * / sends someone signed in to their documents when they come from outside Erga; the erga logo, a click inside
 * Erga, still shows the landing page. Not an agent's token, nor a test person; signed out, always the landing page.
 */
export const homeGoesToDocs = (request: Request, session: Session | null) =>
  cameFromOutside(request) && !!session && !session.agent && !session.test;

/**
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button class="new">${esc(button)}</button></form>`, 200);

export const signInFirst = (next: string) => redirect(`/auth/sign-in?next=${encodeURIComponent(safeNext(next))}`);

/** The plain page's HTML: the app's look, a title and a few lines. */
const plainPage = (title: string, body: string) =>
  appPage(title, inlineStyle("plain"), `<main class="plain"><h1>${title}</h1><p>${body}</p></main>`);

/**
 * A small page for when there's nothing to show, or something about signing in goes wrong: the app's look (its type and
 * colours, light or dark with the system), a title and a few lines, in a column. It needs no session: the stylesheet and
 * the typeface are the app's own files (pages/assets.ts), which the control Worker names at the app's origin.
 */
export const page = (title: string, body: string, status: number) => html(plainPage(title, body), status, NO_STORE);

/** The same page as a web Response, for the control Worker's routes (control/), which make web Responses. */
export function webPage(title: string, body: string, status: number): Response {
  return new Response(plainPage(title, body), { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}
