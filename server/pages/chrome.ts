// What every page of the site's own shares: escaping, the plain page, the app page's
// shell and style, the breadcrumbs, the icons, and the small helpers around redirects.

import { inlineCall } from "./inline.ts";
import { FAVICON_LINK, WORDMARK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { fontTags, styleTag } from "./assets.ts";

/** A link on this site, keeping the name a local tab gave (?user=) if it gave one. */
export const link = (path: string, session: Session | null) =>
  session?.as ? `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(session.as)}` : path;

/** An address with ?edit (its query kept): the editor on it. */
export const withEdit = (href: string) => href + (href.includes("?") ? "&" : "?") + "edit";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The look the app's own pages share (/docs, /admin): the editor's type and
 * colours, light or dark with the system, a column of rows, small
 * icon buttons that show on hover, and dialogs as small cards.
 */
export const APP_STYLE = `
  body { font-size: 15px; line-height: 1.5; background: var(--bg); -webkit-font-smoothing: antialiased; }
  /* The page fills the window, so the footer (siteFooter) sits at its foot. */
  body { min-height: 100vh; margin: 0; display: flex; flex-direction: column; }
  .site-foot { padding: 24px 16px 32px; text-align: center; font-size: 12.5px; color: var(--chrome); }
  main { flex: 1; width: 100%; min-height: 0; box-sizing: border-box; max-width: 1080px; margin: 0 auto; padding: 120px 24px 96px; display: flex; flex-direction: column; }
  /* The breadcrumbs (crumbs): the wordmark, then where you are, upper left, on the line of the account corner upper right
     (server/account-menu.ts). The viewer's (VIEW_STYLE) and the editor's (client/editor.html) look the same, in the same place. */
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; margin: 0; min-width: 0; max-width: calc(100vw - 140px); }
  .brand { flex: none; display: flex; align-items: center; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); text-decoration: none; }
  .brand:hover { opacity: 0.7; }
  .crumbs > :not(.brand)::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  .crumbs a.crumb { flex: none; display: flex; align-items: center; color: var(--soft); text-decoration: none; font-size: 13.5px; font-weight: 500; }
  .crumbs a.crumb:hover { color: var(--fg-strong); }
  .crumbs .here { display: flex; align-items: center; min-width: 0; margin: 0; font-size: 13.5px; line-height: inherit; font-weight: 500; letter-spacing: normal; color: var(--fg); }
  .crumbs .here span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 36px; }
  h1 { margin: 0; font-size: 30px; line-height: 1.15; font-weight: 650; letter-spacing: -0.025em; color: var(--fg-strong); }
  .sub { margin: 6px 0 0; font-size: 14px; color: var(--soft); }
  .new, .pill { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 8px;
    font: inherit; font-size: 13.5px; font-weight: 550; line-height: 1; text-decoration: none; white-space: nowrap; cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease; }
  .new { border: 1px solid var(--fg-strong); background: var(--fg-strong); color: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
  .new:hover { opacity: 0.86; }
  .new svg, .pill svg { width: 15px; height: 15px; margin-left: -3px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .pill { border: 1px solid var(--rule); background: var(--bg); color: var(--fg-strong); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
  .pill:hover:not(:disabled) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
  .pill:disabled { color: var(--chrome); cursor: default; box-shadow: none; }
  :is(.new, .doc, .act, .brand, .crumb, dialog button, .pill, select):focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; border-radius: 8px; }
  ol.rows { list-style: none; margin: 0; padding: 0; }
  ol.rows > li { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--rule); }
  ol.rows > li:first-child { border-top: 1px solid var(--rule); }
  .doc { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 13px 4px; color: inherit; text-decoration: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--fg-strong); }
  .note { flex: none; font-size: 12.5px; color: var(--chrome); }
  time { flex: none; margin-left: auto; font-size: 13px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; }
  form { margin: 0; }
  .act { flex: none; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--chrome); cursor: pointer; opacity: 0; transition: opacity 150ms ease, color 150ms ease, background-color 150ms ease; }
  .act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  li:hover .act, .act:focus-visible, .act.on { opacity: 1; }
  .act:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
  .act:disabled { cursor: default; opacity: 0 !important; }
  @media (hover: none) { .act { opacity: 1; } }
  .input { box-sizing: border-box; min-width: 0; height: 34px; padding: 0 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--fg-strong); font: inherit; font-size: 14px; transition: border-color 150ms ease; }
  .input::placeholder { color: var(--chrome); }
  .input:hover:not(:disabled) { border-color: color-mix(in srgb, var(--chrome) 55%, var(--rule)); }
  .input:focus-visible { outline: 2px solid color-mix(in srgb, var(--caret) 35%, transparent); outline-offset: 0; border-color: var(--caret); }
  .input:disabled { color: var(--soft); background: color-mix(in srgb, var(--chrome) 6%, transparent); }
  select { padding: 5px 26px 5px 10px; border: 1px solid var(--rule); border-radius: 7px; color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; appearance: none;
    background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1a9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E") no-repeat right 7px center / 14px; }
  select:disabled { color: var(--soft); cursor: default; background-image: none; padding-right: 10px; }
  select option { color: initial; }
  .badge { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .badge.strong { color: var(--bg); background: var(--fg-strong); }
  dialog { width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px; border: 1px solid var(--panel-border); border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font-size: 14px; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.18); }
  dialog h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: var(--fg-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog label { display: block; margin: 0 0 4px; font-size: 12.5px; color: var(--soft); }
  dialog .field { display: flex; align-items: center; margin-bottom: 12px; border: 1px solid var(--rule); border-radius: 8px; background: color-mix(in srgb, var(--chrome) 6%, transparent); padding: 0 10px; }
  dialog .field:focus-within { border-color: var(--caret); }
  dialog .field span { color: var(--soft); white-space: nowrap; }
  dialog input { flex: 1; min-width: 0; padding: 8px 0; border: 0; outline: 0; background: transparent; color: var(--fg-strong); font: inherit; }
  .hint { margin: -6px 0 12px; font-size: 12px; color: var(--soft); min-height: 1em; }
  .hint:empty { display: none; }
  .hint.error { color: #c2410c; }
  dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  dialog button { font: 550 13px var(--font-text); height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
  dialog button.primary { border-color: var(--fg-strong); background: var(--fg-strong); color: var(--bg); }
  dialog button.act { height: 30px; padding: 0; border: 0; }
  @media (pointer: coarse) { dialog input, .input { font-size: 16px; } }
  .empty { margin: 0; padding: 48px 24px; border: 1px dashed var(--rule); border-radius: 12px; text-align: center; color: var(--soft); }
  @media (max-width: 520px) { .note { display: none; } main { padding: 88px 16px 64px; } h1 { font-size: 26px; } }
  /* Touch: room for a finger. */
  @media (pointer: coarse) { .new, .pill, .input { height: 40px; } .act { width: 40px; height: 40px; } }
`;

/** The footer at the foot of Erga's own pages (not the editor's, nor a document's): the copyright, this year. */
export const siteFooter = () => `<footer class="site-foot">© ${new Date().getUTCFullYear()} Erga</footer>`;

/** One step of the breadcrumbs: a page above this one (with its address), or this page (without). */
export interface Crumb { label: string; href?: string }

/**
 * The breadcrumbs in the upper left of every page for someone signed in: the wordmark (back to the front page), then
 * the pages above this one, then this one. `here` is the tag of this page's own crumb (the admin pages' is their <h1>).
 */
export function crumbs(session: Session | null, trail: Crumb[], here = "span", home = "/"): string {
  const steps = trail.map((c) => c.href
    ? `<a class="crumb" href="${esc(link(c.href, session))}">${esc(c.label)}</a>`
    : `<${here} class="here" aria-current="page"><span>${esc(c.label)}</span></${here}>`).join("");
  return `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="${esc(link(home, session))}" draggable="false"><span>${WORDMARK}</span></a>${steps}</nav>`;
}

/**
 * The viewer's breadcrumbs (VIEW_STYLE), for someone signed in: Erga › Documents › the document, as the editor's
 *. The front page's are the wordmark alone; a test person's skip Documents, as they have none. An agent sees none.
 */
/** The breadcrumbs' type (Inter, as the editor's), for a page that shows them (viewCrumbs) but has none of the app's style: its rules only, which wait for nothing. */
export const crumbsFont = (session: Session | null) => session && !session.agent ? fontTags() : "";

export function viewCrumbs(session: Session | null, title: string | null): string {
  if (!session || session.agent) return "";
  const docs = session.test ? "" : `<a class="erga-crumb" href="${esc(link("/docs", session))}">Documents</a>`;
  const here = title == null ? "" : `${docs}<span class="erga-here" aria-current="page"><span>${esc(title)}</span></span>`;
  return `<nav class="erga-crumbs" aria-label="Breadcrumbs"><a class="erga-brand" href="${esc(link("/", session))}"><span>${WORDMARK}</span></a>${here}</nav>`;
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
<style>${APP_STYLE}${style}</style>
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
 * For an action another site may not take on someone's behalf: asks them to
 * confirm it with a button, which posts back from this site.
 */
export const confirmAction = (title: string, button: string, action: string) =>
  page(title, `<form method="post" action="${esc(action)}"><button class="new">${esc(button)}</button></form>`, 200);

export const signInFirst = (next: string) => new Response(null, { status: 302, headers: { Location: `/auth/sign-in?next=${encodeURIComponent(safeNext(next))}` } });

/**
 * A small page for when there's nothing to show, or something about signing in goes wrong: the app's look (its type and
 * colours, light or dark with the system), a title and a few lines, in a column. It needs no session: the stylesheet and
 * the typeface are the app's own files (pages/assets.ts), which the control Worker names at the app's origin.
 */
export function page(title: string, html: string, status: number): Response {
  return new Response(appPage(title, PLAIN_STYLE, `<main class="plain"><h1>${title}</h1><p>${html}</p></main>`), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const PLAIN_STYLE = `
  main.plain { max-width: 560px; padding: max(18vh, 96px) 24px 96px; }
  main.plain h1 { font-size: 24px; margin-bottom: 14px; }
  main.plain p { margin: 0 0 14px; color: var(--fg); }
  /* Not the buttons (.new, .provider): their own colours. */
  main.plain a:not(.new, .provider) { color: var(--fg-strong); }
  main.plain b { color: var(--fg-strong); }
  main.plain .new { margin-top: 6px; }
  /* The sign-in page's buttons (server/identity/sign-in.ts), each as its provider's brand rules say. */
  main.plain .providers { display: flex; flex-direction: column; gap: 10px; max-width: 320px; margin-top: 6px; }
  .provider { box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 10px; height: 40px; padding: 0 16px; border: 1px solid; border-radius: 8px;
    font: 500 14px/1 "Roboto", var(--font-text); text-decoration: none; white-space: nowrap; transition: background-color 150ms ease; }
  .provider svg { flex: none; width: 18px; height: 18px; }
  .provider:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
  .provider.google { color: #1f1f1f; background: #fff; border-color: #747775; }
  .provider.google:hover { background: #f2f2f2; }
  .provider.github { color: #fff; background: #24292f; border-color: #24292f; }
  .provider.github:hover { background: #32383f; }
  @media (prefers-color-scheme: dark) {
    .provider.google { color: #e3e3e3; background: #131314; border-color: #8e918f; }
    .provider.google:hover { background: #222224; }
    .provider.github { border-color: #6e7681; }
  }
  @media (max-width: 520px) { main.plain { padding: 72px 16px 64px; } main.plain h1 { font-size: 22px; } }
`;
