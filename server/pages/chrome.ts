// What every page of the site's own shares: escaping, the plain page, the app page's
// shell and style, the breadcrumbs, the icons, and the small helpers around redirects.

import { inlineCall, inlineStyle } from "./inline.ts";
import { FAVICON_LINK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { fontTags, styleTag } from "./assets.ts";
import { esc } from "../../shared/html.ts";
import { redirect } from "../http.ts";

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
export const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** An address with ?edit (its query kept): the editor on it. */
export const withEdit = (href: string) => href + (href.includes("?") ? "&" : "?") + "edit";


/** The footer at the foot of Erga's own pages (not the editor's, nor a document's): the copyright, this year. */
export const siteFooter = () => `<footer class="site-foot">© ${new Date().getUTCFullYear()} Erga</footer>`;

/** One step of the breadcrumbs: a page above this one (with its address), or this page (without). */
export interface Crumb { label: string; href?: string }

/** The breadcrumbs' type (Inter, as the editor's), for a page that shows them (viewCrumbs) but has none of the app's style: its rules only, which wait for nothing. Signed out, only where they show (`signedOut`). */
export const crumbsFont = (session: Session | null, signedOut = false) => ((session ? !session.agent : signedOut) ? fontTags() : "");

/** Every <time datetime> in the reader's own language and zone (client/inline/times.ts): a statement, inside a page's script. */
export const TIMES_SCRIPT = inlineCall("times");

export const ICON = {
  delete: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M18.5 8v6M15.5 11h6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="4" rx="1"/><path d="M5.5 9v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M10 13h4"/></svg>`,
  unarchive: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="4" rx="1"/><path d="M5.5 9v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M12 17v-5M9.5 14.5 12 12l2.5 2.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.75 7.5 4.5 4.5-4.5 4.5"/></svg>`,
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
 * / sends someone signed in to their documents, however they came; the homepage project is at /_home for them. Not an
 * agent's token; signed out, always the homepage.
 */
export const homeGoesToDocs = (session: Session | null) => !!session && !session.agent;


export const signInFirst = (next: string) => redirect(`/auth/sign-in?next=${encodeURIComponent(safeNext(next))}`);

