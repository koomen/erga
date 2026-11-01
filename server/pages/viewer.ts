// The viewer's scripts and styles (documents/view.ts puts them on the page): the band
// above the document, the editor's boot, the steps, the glass bars and their buttons.
//
// The document's page is in the viewer's frame (#frame), on the document's own pages
// origin (pages/reader.ts tells this page what it needs from inside it), for readers and
// editors alike. Going into the editor loads the editor's half into that same page
// (editBoot, client/shell/main.ts, client/shell/remote.ts): the page loads once. Every script here
// hears the frame through `ergaFrames` (framesScript).

import { FAVICON_LINK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { asset, assetScripts, editorShell } from "./assets.ts";
import { inlineCall, inlineScript, inlineStyle } from "./inline.ts";
import { crumbsFont, link, viewCrumbs } from "./chrome.ts";
import { esc } from "../../shared/html.ts";
import { EDITOR_ALLOW, PAGE_ALLOW, PAGE_SANDBOX } from "./reader.ts";
import { NEW_DOC_STYLE, newDocButton, newDocMenu } from "./templates.ts";


/** The viewer's pencil (Edit, the editor at `href`), blue while editing: also the homepage's. */
export const editButton = (href: string, editing: boolean) => `<a href="${esc(href)}" class="erga-view-button erga-edit-button" aria-label="Edit" aria-pressed="${editing}" data-tip="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0512) translate(-11.885 -13.365)" stroke-width="1.5221"><g transform="translate(0 1.25)"><path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/></g></g></svg></a>`;

/** Share with an agent, as the editor's (client/editor.html, #btn-agent-share): it copies a one-line prompt (client/inline/viewer-bars.ts). For anyone who can read the page. */
export const AGENT_SHARE_BUTTON = `<button type="button" class="erga-view-button erga-agent-share" aria-label="Share with an agent: copy a prompt for it" data-tip="Share with an agent"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.12) translate(-12 -11.5)" stroke-width="1.4"><rect x="3.5" y="9" width="10.5" height="8.5" rx="3"/><path d="M8.75 9V6.5"/><circle cx="8.75" cy="5.5" r="1"/><circle cx="6.75" cy="13.25" r=".9" fill="currentColor" stroke="none"/><circle cx="10.75" cy="13.25" r=".9" fill="currentColor" stroke="none"/><path d="M2 12.5v1.5M15.5 12.5v1.5"/><path d="M18.75 3.5v6M15.75 6.5h6"/></g></svg></button>`;

/** Documents, as the editor's (client/editor.html, #btn-docs), at `href`: for someone signed in who has documents. */
export const docsButton = (href: string) =>
  `<a href="${esc(href)}" class="erga-view-button erga-docs-button" draggable="false" aria-label="Documents" data-tip="Documents"><svg viewBox="0 0 24 24" aria-hidden="true"><g stroke-width="1.5"><rect x="4.75" y="4.75" width="5.75" height="5.75" rx="1.25"/><rect x="13.5" y="4.75" width="5.75" height="5.75" rx="1.25"/><rect x="4.75" y="13.5" width="5.75" height="5.75" rx="1.25"/><rect x="13.5" y="13.5" width="5.75" height="5.75" rx="1.25"/></g></svg></a>`;

/** The viewer's Full screen button, as the editor's (client/editor.html, #btn-full): the page's frame fills the screen (client/inline/viewer-full.ts), where it can (viewer.css). */
export const FULL_BUTTON = `<button type="button" class="erga-view-button erga-full-button" aria-label="Full screen" data-tip="Full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 9.25v-3.5a1 1 0 0 1 1-1h3.5M14.75 4.75h3.5a1 1 0 0 1 1 1v3.5M19.25 14.75v3.5a1 1 0 0 1-1 1h-3.5M9.25 19.25h-3.5a1 1 0 0 1-1-1v-3.5"/></svg></button>`;

/**
 * The two glass bars (client/inline/bars.css), on a document's page and on the homepage, as the editor's and in the same
 * places: the breadcrumbs, and the buttons with who you are (`corner`, server/pages/account-menu.ts). Full screen only
 * where there's a frame to fill the screen (`full`). The editor's own actions (Pause, Share, Document settings) are folded
 * into the pencil here; Clone is the New menu's last item.
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
  const docs = s && !s.agent && !s.test ? docsButton(link("/docs", s)) : "";
  return `${viewCrumbs(s, o.title, o.project, true)}<div class="erga-view-buttons erga-bar erga-bar-r"><div class="quick"><div class="quick-inner">${newDocButton("erga-view-button")}${o.full ? FULL_BUTTON : ""}${o.edit}${AGENT_SHARE_BUTTON}${docs}</div></div><div class="me-slot">${o.corner}</div></div>`;
}

/** What a page kept for its reload (client/live/restore.ts, RESTORE_KEY: the same, which tests/restore-key.test.ts checks). */
export const RESTORE_KEY = "erga:live:restore";

/** The editor's shell, inert in the page until someone edits: its styles, then its controls. */
export const shellTemplate = () => {
  const s = editorShell();
  return `<template id="erga-shell"><style>${s.style}</style>${s.body}</template>`;
};

/** For whoever may edit, at the top of a document's page: the editor's start, at ?edit as the page parses (client/inline/viewer-editing-head.ts). */
export const editingHead = () => inlineCall("viewer-editing-head", assetScripts("page.js"), RESTORE_KEY);

/** The editor's layout as this browser keeps it, as the page's body starts (client/inline/viewer-layout-early.ts). */
export const LAYOUT_EARLY = inlineCall("viewer-layout-early");

/** ... and as its body starts: editing from the first frame, with the editor's controls and layout (client/inline/viewer-editing-body.ts). */
export const EDITING_BODY = inlineCall("viewer-editing-body");

/** The frame's address, with the page's place (#3), and opened with ?edit the editor's half (client/inline/viewer-frame-src.ts). */
export const frameSrc = (editing: boolean) => inlineCall("viewer-frame-src", editing);

/** The document's frame and the address with ?edit or without, for every script on the page (client/inline/viewer-frames.ts). */
export const framesScript = (pages: string) => inlineCall("viewer-frames", pages);

/** Which of the document's pages is shown: the address bar follows the frame (client/inline/viewer-nav.ts). */
export const NAV_SCRIPT = inlineCall("viewer-nav");

/**
 * The band at the top of a document's page (viewDocument), where the
 * controls are: the document's frame starts below it, so they never cover
 * the document, and it takes the document's own background, so it reads as
 * part of the page: its colour, and over that its gradient or image
 * (.erga-canvas, which has the frame's box; BAND_BOOT paints it). --band-h is the controls' row
 * (34px, at max(12px, the notch)) and a 10px gap; the editor's client/styles/editor.css
 * keeps the frame there too. Until the frame says (BAND_BOOT), the colour
 * is the one this document had last time on this browser, and the
 * controls' tone (light or dark text) with it.
 */
export const BAND_STYLE = inlineStyle("viewer-band");

/** Sets the band's colour (ergaBand(id, colour)), or the one remembered for document `id` (ergaBand(id)): client/inline/viewer-band-head.ts. */
export const BAND_HEAD = inlineCall("viewer-band-head");

/** The band's colour and the page's canvas, as the page tells them (client/inline/viewer-band.ts). */
export const BAND_BOOT = inlineCall("viewer-band");

/** Going into the editor and back, for those who may (client/inline/viewer-edit-boot.ts). */
export const editBoot = () =>
  inlineCall("viewer-edit-boot", assetScripts("page.js"), { "editor.html": asset("editor.html"), "frame.js": asset("frame.js") });

/** A presentation's steps, on a document's page, viewing and editing alike (client/inline/viewer-steps.ts). */
export const STEPS_BOOT = inlineCall("viewer-steps");

/** The steps' bar and panel (client/inline/viewer-steps.css). */
export const STEPS_STYLE = `<style>${inlineStyle("viewer-steps")}</style>`;

/** Full screen: the page's frame, from the button in the viewer and the editor (client/inline/viewer-full.ts). */
export const FULL_BOOT = inlineCall("viewer-full");

/** The glass bars' look, the viewer's and the editor's (client/inline/bars.css). */
export const BARS_STYLE = `<style>${inlineStyle("bars")}</style>`;

/** The bars' quick actions on a phone, and Share with an agent (client/inline/viewer-bars.ts). */
export const BARS_BOOT = inlineCall("viewer-bars");

/** The controls and the breadcrumbs on the band (client/inline/viewer.css). */
export const VIEW_STYLE = `<style>${inlineStyle("viewer")}</style>`;

/**
 * The viewer's page around a document's frame (documents/view.ts decides what goes in: who may edit, the frame's address
 * with its token, the metas), in two parts: `before` ends with the frame, `after` before </body>. The document shows in
 * the frame, on its pages origin; editing is loaded into it (editBoot) only when someone goes into it, by the pencil or
 * at ?edit (`editing`: opened so).
 */
export function viewerPage(o: {
  title: string;
  docId: string;
  pages: string;
  meta: string;
  session: Session | null;
  editable: boolean;
  editing: boolean;
  landing: boolean;
  /** Your own copy's address: the New menu's last item. */
  clone: string;
  /** The pencil, for whoever may edit (editButton), else nothing. */
  edit: string;
  /** Who you are (server/pages/account-menu.ts, accountHtml): at the right of the buttons' bar. */
  corner: string;
  /** The version the page shows, for someone signed in: it follows each change (client/inline/viewer-live.ts). */
  live?: string;
  /** A project's address, for someone signed in: its crumb opens its tree (client/inline/viewer-tree.ts). */
  project?: string;
}): { before: string; after: string } {
  // Opened with ?edit, for whoever may edit: the page is the editor's from its first moment (editingHead, EDITING_BODY),
  // the page in the frame starts on its half of the editor at once (frameSrc), and the editor's files are fetched as the
  // page parses, rather than one after another once its script runs (editBoot).
  const opening = o.editable ? `${shellTemplate()}<script>${editingHead()}</script>` : "";
  // The page on its own origin, connected to from the start; it may play media only on the editor's say (EDITOR_ALLOW).
  const editing = o.editable && o.editing;
  const frame = `<iframe id="frame" class="erga-view" title="${esc(o.title)}" sandbox="${PAGE_SANDBOX}" allow="${editing ? EDITOR_ALLOW : PAGE_ALLOW}"></iframe>`;
  // The band above the document (and, editing, the room the agent opens) takes the page's background: remembered from this
  // document's last visit, before anything has loaded, then as the frame tells it (BAND_BOOT). With none remembered, the
  // page waits for its own (BAND_WAIT).
  const backdrop = `<script>${BAND_HEAD}ergaBand(${JSON.stringify(o.docId)});${BAND_WAIT}</script>`;
  const session = o.session;
  const before = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${esc(o.title)}</title>
${FAVICON_LINK}
<link rel="preconnect" href="${esc(o.pages)}">
<meta name="erga-doc" content="${esc(o.docId)}">
${o.meta}<script>${framesScript(o.pages)}</script>${backdrop}${crumbsFont(session, true)}<style>${BAND_STYLE}</style>${opening}
<body>${o.editable ? `<script>${EDITING_BODY}</script>` : ""}
<div class="erga-canvas" aria-hidden="true"><div></div></div>${frame}<script>${frameSrc(editing)}</script>`;
  const bars = barsHtml({ session, title: o.landing ? null : o.title, project: !!o.project, full: true, edit: o.edit, corner: o.corner });
  const after = `
${bars}${newDocMenu((path) => link(path, session), o.clone)}${VIEW_STYLE}${NEW_DOC_STYLE}${BARS_STYLE}${inlineScript("new-doc")}<script>${BARS_BOOT}</script><script>${NAV_SCRIPT}</script><script>${BAND_BOOT}</script><script>${FULL_BOOT}</script>${STEPS_STYLE}<script>${STEPS_BOOT}</script>${o.editable ? `<script>${editBoot()}</script>` : ""}${o.live ? `<script>${inlineCall("viewer-live", `/d/${o.docId}`, o.live)}</script>` : ""}${o.project && session && !o.landing ? `<script>${inlineCall("viewer-tree", asset("pages-tree.js"), o.docId, o.project, o.title, session.as ? `?user=${encodeURIComponent(session.as)}` : "")}</script>` : ""}
`;
  return { before, after };
}

/** With no colour remembered for the document, its page waits out of sight for the band's own (client/inline/viewer-band-wait.ts). */
export const BAND_WAIT = inlineCall("viewer-band-wait");
