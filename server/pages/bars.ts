// The header of every page Erga serves: two glass bars at the top (client/inline/bars.css), the same on a document's
// page (the viewer and the editor), the homepage, Documents, Settings, the admin pages, sign-in and the error pages.
// Upper left the breadcrumbs (erga › where you are); upper right the page's quick actions, then your avatar and its
// menu. Each bar is one element, viewing and editing: the editor's own parts of it are in it for whoever may edit, out
// of sight until they edit (client/inline/viewer.css).

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

/** The caret between two steps: outside both, so a step's hover, focus ring and click are its word's alone. */
const SEP = `<span class="erga-sep" aria-hidden="true">›</span>`;
/** A caret that shows only while someone edits (client/inline/viewer.css, .edit-only). */
const SEP_EDIT = `<span class="erga-sep edit-only" aria-hidden="true">›</span>`;

/**
 * The breadcrumbs' bar: the wordmark, then each step (`steps`, made already), a caret before each. The wordmark goes
 * to your documents at `home` (someone signed out: to its homepage). There is one bar, viewing and editing (.chrome,
 * .chrome-nav and the ids: the editor's names for it and its parts). `editor`: with the editor's own title too.
 */
const crumbsBar = (session: Session | null, home: string, steps: string[], editor = false, editOnly = false) =>
  `<nav class="erga-crumbs erga-bar erga-bar-l${editor ? ' chrome chrome-nav" id="nav-docs' : ""}" aria-label="Breadcrumbs"><a class="erga-brand${editor ? ' nav-brand" id="nav-brand' : ""}" href="${esc(link(`${home}${session ? "/docs" : "/"}`, session))}" draggable="false"><span>${WORDMARK}</span></a>${steps.map((s) => (editOnly ? SEP_EDIT : SEP) + s).join("")}${editor ? (editOnly ? SEP_EDIT : "") + EDITOR_TITLE : ""}</nav>`;

/**
 * The editor's title, in the place of the page's own while someone edits (client/inline/viewer.css): it opens the
 * document's pages, where the document is renamed too (client/shell/naming.ts).
 */
const EDITOR_TITLE = `<button type="button" class="nav-title" id="doc-title" aria-haspopup="dialog" aria-expanded="false" aria-controls="pages" hidden><span id="doc-title-text"></span><svg class="nav-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>`;

/**
 * The buttons' bar: the quick actions (on a phone, they open out of the avatar), then who you are (`corner`). There is
 * one bar, viewing and editing (.chrome, .chrome-top: the editor's names for it, client/style.css). `editor`: the
 * editor's own parts of it, for whoever may edit, out of sight until they edit (client/inline/viewer.css): who else is
 * here, left of the bar, and their own avatar's slot, which the editor fills (client/shell/people.ts).
 */
const buttonsBar = (actions: string, corner: string, editor = false) =>
  `<div class="erga-view-buttons erga-bar erga-bar-r chrome chrome-top">${editor ? `<div class="people" id="people" aria-label="Who's here"></div>` : ""}<div class="quick" id="quick"><div class="quick-inner">${actions}</div></div><div class="me-slot">${corner}</div>${editor ? `<div class="me-slot" id="me" aria-label="You"></div>` : ""}</div>`;

/** The page's zoom, while it isn't 100%: a click goes back to 100%, as ⌘0 does (client/shell/main.ts, zoom). The editor's. */
const ZOOM_BUTTON = `<button type="button" class="icon-btn zoom-btn" id="btn-zoom" hidden></button>`;

/** The editor's own page actions (Share, Document settings, the shortcut card #help, which ⌘/ opens too): they open out of the pencil when editing starts, and close back into it. */
const EDIT_GROUP = `<div class="edit-group" id="edit-group"><div class="edit-group-inner"><button type="button" class="icon-btn" id="btn-share" aria-label="Share this page" data-tip="Share" aria-haspopup="dialog" aria-expanded="false" aria-controls="sharing"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0714) translate(-12.5 -13.5)" stroke-width="1.4933"><g transform="translate(0 1.5)"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M18.5 8v6M15.5 11h6"/></g></g></svg></button><button type="button" class="icon-btn" id="btn-settings" aria-label="Document settings" data-tip="Document settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="doc-settings"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(0.8523) translate(-12 -11.55)" stroke-width="1.8773"><path d="M12.22 2.75h-.44a1.75 1.75 0 0 0-1.75 1.75v.16a1.75 1.75 0 0 1-.88 1.51l-.38.22a1.75 1.75 0 0 1-1.75 0l-.13-.07a1.75 1.75 0 0 0-2.39.64l-.22.38a1.75 1.75 0 0 0 .64 2.39l.13.09a1.75 1.75 0 0 1 .88 1.5v.45a1.75 1.75 0 0 1-.88 1.52l-.13.08a1.75 1.75 0 0 0-.64 2.39l.22.38a1.75 1.75 0 0 0 2.39.64l.13-.07a1.75 1.75 0 0 1 1.75 0l.38.22a1.75 1.75 0 0 1 .88 1.51v.16a1.75 1.75 0 0 0 1.75 1.75h.44a1.75 1.75 0 0 0 1.75-1.75v-.16a1.75 1.75 0 0 1 .88-1.51l.38-.22a1.75 1.75 0 0 1 1.75 0l.13.07a1.75 1.75 0 0 0 2.39-.64l.22-.39a1.75 1.75 0 0 0-.64-2.39l-.13-.07a1.75 1.75 0 0 1-.88-1.52v-.44a1.75 1.75 0 0 1 .88-1.52l.13-.08a1.75 1.75 0 0 0 .64-2.39l-.22-.38a1.75 1.75 0 0 0-2.39-.64l-.13.07a1.75 1.75 0 0 1-1.75 0l-.38-.22a1.75 1.75 0 0 1-.88-1.51V4.5a1.75 1.75 0 0 0-1.75-1.75Z"/><circle cx="12" cy="12" r="2.75"/></g></svg></button><button type="button" class="icon-btn" id="btn-help" aria-label="Keyboard shortcuts" data-tip="Shortcuts  ⌘/" aria-haspopup="dialog" aria-expanded="false" aria-controls="help"><svg viewBox="0 0 24 24" aria-hidden="true"><g stroke-width="1.5"><circle cx="12" cy="12" r="7.75"/><path d="M9.6 9.7a2.5 2.5 0 1 1 3.6 2.2c-.8.45-1.2.95-1.2 1.85"/><circle cx="12" cy="16.4" r=".55" fill="currentColor" stroke="none"/></g></svg></button></div></div>`;

/**
 * A document's two bars, in the viewer and on the homepage, as the editor's and in the same places: erga › Documents ›
 * the document (signed out: erga › the document; the homepage: erga), and the buttons with who you are (`corner`).
 * Full screen only where there's a frame to fill the screen (`full`). The editor's own actions (Share, Document
 * settings) are folded into the pencil until someone edits; Clone is the New menu's last item. A project's title opens its pages
 * (the card after the bars: client/inline/viewer-tree.ts). An agent sees no breadcrumbs.
 */
export function barsHtml(o: {
  session: Session | null;
  title: string | null;
  project: boolean;
  full: boolean;
  edit: string;
  corner: string;
  /** The editor can open in this page: the bar has its parts too. */
  editor?: boolean;
}): string {
  const s = o.session;
  const mine = !!s && !s.agent;
  const tree = o.project && !!s && o.title != null;
  const crumb = tree
    ? `<button type="button" class="erga-here erga-tree-btn" aria-expanded="false" aria-controls="erga-tree" aria-label="${esc(o.title ?? "")}: its pages"><span>${esc(o.title ?? "")}</span><svg class="erga-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>`
    : `<span class="erga-here" aria-current="page"><span>${esc(o.title ?? "")}</span></span>`;
  const documents = (only = "") =>
    `<a class="erga-crumb${o.editor ? ` nav-back${only}" id="nav-back` : ""}" href="${esc(link("/docs", s))}">${o.editor ? "<span>Documents</span>" : "Documents"}</a>`;
  // (The homepage has no steps while viewing; editing, the editor's own: Documents and its title, .edit-only.)
  const steps = o.title != null ? [...(mine ? [documents()] : []), crumb] : o.editor ? [documents(" edit-only")] : [];
  const card = tree ? `<div id="erga-tree" class="erga-tree-card" role="dialog" aria-label="Pages" hidden></div>` : "";
  const editor = !!o.editor;
  // On a document's page each button has the id the editor knows it by (client/shell/), and its class there too
  // (.icon-btn, client/style.css): editing, it takes the editor's focus ring and its look while its menu is open.
  const id = (button: string, name: string) =>
    button.replace(/^<(button|a) /, `<$1 id="${name}" `).replace('class="erga-view-button', 'class="erga-view-button icon-btn');
  const actions = `${editor ? ZOOM_BUTTON : ""}${id(newDocButton("erga-view-button"), "btn-new")}${o.full ? id(FULL_BUTTON, "btn-full") : ""}${editor ? EDIT_GROUP : ""}${o.edit.replace('class="erga-view-button', 'class="erga-view-button icon-btn')}${id(AGENT_SHARE_BUTTON, "btn-agent-share")}${mine ? id(docsButton(link("/docs", s)), "btn-docs") : ""}`;
  return `${s?.agent ? "" : crumbsBar(s, "", steps, editor, o.title == null)}${card}${buttonsBar(actions, o.corner, editor)}`;
}

/** The viewer's Full screen button, as the editor's (client/editor.html, #btn-full): the page's frame fills the screen (client/inline/viewer-full.ts), where it can. */
export const FULL_BUTTON = `<button type="button" class="erga-view-button erga-full-button" aria-label="Full screen" data-tip="Full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 9.25v-3.5a1 1 0 0 1 1-1h3.5M14.75 4.75h3.5a1 1 0 0 1 1 1v3.5M19.25 14.75v3.5a1 1 0 0 1-1 1h-3.5M9.25 19.25h-3.5a1 1 0 0 1-1-1v-3.5"/></svg></button>`;

/**
 * The header of the app's own pages (appPage: Documents, Settings, the admin pages, the start page, sign-in, the error
 * pages): erga › each step of `trail` (the last is this page, in a `here` tag: the admin
 * pages' is their <h1>), and the quick actions: New document, the page's own (`actions`), Documents (`docs` puts
 * another button in its place: Documents itself has Home page there), then who you are. Share with an agent is on every page, before
 * Documents (`share`: a page's own, as the admin pages' with its admin token). The account corner goes in `corner`, or where the
 * Worker puts it (ACCOUNT_SLOT: withAccount). Your agent comes with them (server/pages/agent.ts), except where
 * `agent` is false: a page where the person grants access (/tokens/approve), which the agent must not see or act on.
 */
export function pageBars(
  session: Session | null,
  trail: Crumb[],
  o: { here?: string; actions?: string; share?: string; docs?: string; corner?: string; agent?: false } = {}
): string {
  const here = o.here ?? "span";
  const steps = trail
    .map((c) =>
      c.href
        ? `<a class="erga-crumb" href="${esc(link(c.href, session))}">${esc(c.label)}</a>`
        : `<${here} class="erga-here" aria-current="page"><span>${esc(c.label)}</span></${here}>`
  );
  const mine = !!session && !session.agent;
  const at = (path: string) => link(path, session);
  const actions = `${session?.agent ? "" : newDocButton("erga-view-button")}${o.actions ?? ""}${o.share ?? AGENT_SHARE_BUTTON}${mine ? (o.docs ?? docsButton(at("/docs"))) : ""}`;
  return `<script>${PAGE_TONE}</script>${crumbsBar(session, "", steps)}${buttonsBar(actions, o.corner ?? ACCOUNT_SLOT)}${session?.agent ? "" : newDocMenu(at)}${NEW_DOC_STYLE}${BARS_STYLE}${session?.agent ? "" : inlineScript("new-doc")}${inlineScript("page-bars")}${o.agent === false ? "" : agentPanel(session)}`;
}

/**
 * The app's pages follow the system's light or dark mode (client/style.css): the bars and the agent take that tone, as
 * they take a document's (client/inline/viewer-band-head.ts), before they paint, and again when the mode changes. Light,
 * the app's pages are white (--bg): their glass is the editor's on a white document (page-white).
 */
const PAGE_TONE = `(()=>{const m=matchMedia("(prefers-color-scheme: dark)"),tone=()=>{const c=document.documentElement.classList;c.toggle("page-dark",m.matches);c.toggle("page-light",!m.matches);c.toggle("page-white",!m.matches)};tone();m.addEventListener("change",tone)})();`;

/** What a plain page may have besides its title and lines: another heading than the title, and HTML right under it. */
interface Plain {
  heading?: string;
  lead?: string;
}

/** The plain page's HTML: the app's look and bars (erga › its title; who you are, as the Worker adds it), a title and a few lines. */
const plainPage = (title: string, body: string, o: Plain = {}) =>
  appPage(
    title,
    inlineStyle("plain"),
    `${pageBars(null, [{ label: title }])}<main class="plain"><h1>${o.heading ?? title}</h1>${o.lead ?? ""}<p>${body}</p></main>`
  );

/**
 * A small page for when there's nothing to show, or something about signing in goes wrong: the app's look (its type and
 * colours, light or dark with the system), a title and a few lines, in a column. It needs no session: the stylesheet and
 * the typeface are the app's own files (pages/assets.ts).
 */
export const page = (title: string, body: string, status: number, o?: Plain) => html(plainPage(title, body, o), status, NO_STORE);

/**
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button class="new">${esc(button)}</button></form>`, 200);
