// The header of every page Erga serves: two glass bars at the top (client/inline/bars.css), the same on a document's
// page (the viewer and the editor), the homepage, Documents, Settings, the admin pages, sign-in and the error pages.
// Upper left the breadcrumbs (erga › where you are); upper right the page's quick actions, then your avatar and its
// menu. The editor draws its own copy in the same places (client/editor.html).

import { WORDMARK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { esc } from "../../shared/html.ts";
import { appPage, type Crumb, link } from "./chrome.ts";
import { html, NO_STORE } from "../http.ts";
import { inlineScript, inlineStyle } from "./inline.ts";
import { ACCOUNT_SLOT } from "./account-menu.ts";
import { NEW_DOC_STYLE, newDocButton, newDocMenu } from "./templates.ts";
import { agentPanel } from "./agent.ts";

/** Share with an agent's icon, as the editor's (client/editor.html, #btn-agent-share). */
export const AGENT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.12) translate(-12 -11.5)" stroke-width="1.4"><rect x="3.5" y="9" width="10.5" height="8.5" rx="3"/><path d="M8.75 9V6.5"/><circle cx="8.75" cy="5.5" r="1"/><circle cx="6.75" cy="13.25" r=".9" fill="currentColor" stroke="none"/><circle cx="10.75" cy="13.25" r=".9" fill="currentColor" stroke="none"/><path d="M2 12.5v1.5M15.5 12.5v1.5"/><path d="M18.75 3.5v6M15.75 6.5h6"/></g></svg>`;

/** Share with an agent, as the editor's (client/editor.html, #btn-agent-share): its menu (client/common/agent-menu.ts): the MCP prompt for anyone who can read the page, and a prompt with a token for someone signed in. */
export const AGENT_SHARE_BUTTON = `<button type="button" class="erga-view-button erga-agent-share" aria-label="Share with an agent" data-tip="Share with an agent">${AGENT_ICON}</button>`;

/** Documents, as the editor's (client/editor.html, #btn-docs), at `href`: for someone signed in who has documents. */
export const docsButton = (href: string) =>
  `<a href="${esc(href)}" class="erga-view-button erga-docs-button" draggable="false" aria-label="Documents" data-tip="Documents"><svg viewBox="0 0 24 24" aria-hidden="true"><g stroke-width="1.5"><rect x="4.75" y="4.75" width="5.75" height="5.75" rx="1.25"/><rect x="13.5" y="4.75" width="5.75" height="5.75" rx="1.25"/><rect x="4.75" y="13.5" width="5.75" height="5.75" rx="1.25"/><rect x="13.5" y="13.5" width="5.75" height="5.75" rx="1.25"/></g></svg></a>`;

/** The homepage (the homepage project at /_home: document/names.ts), at `href`: on Documents, in the Documents button's place, where / is for someone signed in. */
export const homeButton = (href: string) =>
  `<a href="${esc(href)}" class="erga-view-button erga-home-button" draggable="false" aria-label="Home page" data-tip="Home page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 10.5 12 4.75l7.25 5.75v8a1 1 0 0 1-1 1h-4v-5.5h-4.5v5.5h-4a1 1 0 0 1-1-1z"/></svg></a>`;

/** The bars' look (client/inline/bars.css). */
export const BARS_STYLE = `<style>${inlineStyle("bars")}</style>`;

/**
 * The breadcrumbs' bar: the wordmark, then each step (`steps`, made already). The wordmark goes to your documents at
 * `home` (a test person, who has none, or someone signed out: to its homepage).
 */
const crumbsBar = (session: Session | null, home: string, steps: string) =>
  `<nav class="erga-crumbs erga-bar erga-bar-l" aria-label="Breadcrumbs"><a class="erga-brand" href="${esc(link(`${home}${session && !session.test ? "/docs" : "/"}`, session))}" draggable="false"><span>${WORDMARK}</span></a>${steps}</nav>`;

/** The buttons' bar: the quick actions (on a phone, they open out of the avatar), then who you are (`corner`). */
const buttonsBar = (actions: string, corner: string) =>
  `<div class="erga-view-buttons erga-bar erga-bar-r"><div class="quick"><div class="quick-inner">${actions}</div></div><div class="me-slot">${corner}</div></div>`;

/**
 * A document's two bars, in the viewer and on the homepage, as the editor's and in the same places: erga › Documents ›
 * the document (signed out: erga › the document; the homepage: erga), and the buttons with who you are (`corner`).
 * Full screen only where there's a frame to fill the screen (`full`). The editor's own actions (Share, Document
 * settings) are folded into the pencil here; Clone is the New menu's last item. A project's title opens its pages
 * (the card after the bars: client/inline/viewer-tree.ts). A test person has no Documents; an agent sees no breadcrumbs.
 */
export function barsHtml(o: {
  session: Session | null;
  title: string | null;
  project: boolean;
  full: boolean;
  edit: string;
  corner: string;
}): string {
  const s = o.session;
  const mine = !!s && !s.agent && !s.test;
  const tree = o.project && !!s && o.title != null;
  const crumb = tree
    ? `<button type="button" class="erga-here erga-tree-btn" aria-expanded="false" aria-controls="erga-tree" aria-label="${esc(o.title ?? "")}: its pages"><span>${esc(o.title ?? "")}</span><svg class="erga-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>`
    : `<span class="erga-here" aria-current="page"><span>${esc(o.title ?? "")}</span></span>`;
  const steps = o.title == null ? "" : `${mine ? `<a class="erga-crumb" href="${esc(link("/docs", s))}">Documents</a>` : ""}${crumb}`;
  const card = tree ? `<div id="erga-tree" class="erga-tree-card" role="dialog" aria-label="Pages" hidden></div>` : "";
  const actions = `${newDocButton("erga-view-button")}${o.full ? FULL_BUTTON : ""}${o.edit}${AGENT_SHARE_BUTTON}${mine ? docsButton(link("/docs", s)) : ""}`;
  return `${s?.agent ? "" : crumbsBar(s, "", steps)}${card}${buttonsBar(actions, o.corner)}`;
}

/** The viewer's Full screen button, as the editor's (client/editor.html, #btn-full): the page's frame fills the screen (client/inline/viewer-full.ts), where it can. */
export const FULL_BUTTON = `<button type="button" class="erga-view-button erga-full-button" aria-label="Full screen" data-tip="Full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 9.25v-3.5a1 1 0 0 1 1-1h3.5M14.75 4.75h3.5a1 1 0 0 1 1 1v3.5M19.25 14.75v3.5a1 1 0 0 1-1 1h-3.5M9.25 19.25h-3.5a1 1 0 0 1-1-1v-3.5"/></svg></button>`;

/**
 * The header of the app's own pages (appPage: Documents, Settings, the admin pages, the start page, sign-in, the error
 * pages): erga › each step of `trail` (the last is this page, in a `here` tag: the admin
 * pages' is their <h1>), and the quick actions: New document, the page's own (`actions`), Documents (`docs` puts
 * another button in its place: Documents itself has Home page there), then who you are. Share with an agent is on every page, before
 * Documents (`share`: a page's own, as the admin pages' with its admin token). The account corner goes in `corner`, or where the
 * Worker puts it (ACCOUNT_SLOT: withAccount). Your agent comes with them (server/pages/agent.ts).
 */
export function pageBars(
  session: Session | null,
  trail: Crumb[],
  o: { here?: string; actions?: string; share?: string; docs?: string; corner?: string } = {}
): string {
  const here = o.here ?? "span";
  const steps = trail
    .map((c) =>
      c.href
        ? `<a class="erga-crumb" href="${esc(link(c.href, session))}">${esc(c.label)}</a>`
        : `<${here} class="erga-here" aria-current="page"><span>${esc(c.label)}</span></${here}>`
    )
    .join("");
  const mine = !!session && !session.agent && !session.test;
  const at = (path: string) => link(path, session);
  const actions = `${session?.agent ? "" : newDocButton("erga-view-button")}${o.actions ?? ""}${o.share ?? AGENT_SHARE_BUTTON}${mine ? (o.docs ?? docsButton(at("/docs"))) : ""}`;
  return `<script>${PAGE_TONE}</script>${crumbsBar(session, "", steps)}${buttonsBar(actions, o.corner ?? ACCOUNT_SLOT)}${session?.agent ? "" : newDocMenu(at)}${NEW_DOC_STYLE}${BARS_STYLE}${session?.agent ? "" : inlineScript("new-doc")}${inlineScript("page-bars")}${agentPanel(session)}`;
}

/**
 * The app's pages follow the system's light or dark mode (client/style.css): the bars and the agent take that tone, as
 * they take a document's (client/inline/viewer-band-head.ts), before they paint, and again when the mode changes. Light,
 * the app's pages are white (--bg): their glass is the editor's on a white document (page-white).
 */
const PAGE_TONE = `(()=>{const m=matchMedia("(prefers-color-scheme: dark)"),tone=()=>{const c=document.documentElement.classList;c.toggle("page-dark",m.matches);c.toggle("page-light",!m.matches);c.toggle("page-white",!m.matches)};tone();m.addEventListener("change",tone)})();`;

/** The plain page's HTML: the app's look and bars (erga › its title; who you are, as the Worker adds it), a title and a few lines. */
const plainPage = (title: string, body: string) =>
  appPage(title, inlineStyle("plain"), `${pageBars(null, [{ label: title }])}<main class="plain"><h1>${title}</h1><p>${body}</p></main>`);

/**
 * A small page for when there's nothing to show, or something about signing in goes wrong: the app's look (its type and
 * colours, light or dark with the system), a title and a few lines, in a column. It needs no session: the stylesheet and
 * the typeface are the app's own files (pages/assets.ts).
 */
export const page = (title: string, body: string, status: number) => html(plainPage(title, body), status, NO_STORE);

/**
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button class="new">${esc(button)}</button></form>`, 200);
