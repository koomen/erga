// The viewer's scripts and styles (documents/view.ts puts them on the page): the band
// above the document, the editor's boot, the steps, the fade, the buttons.
//
// The document's page is in the viewer's frame (#frame), on the document's own pages
// origin (pages/reader.ts tells this page what it needs from inside it), for readers and
// editors alike. Going into the editor loads the editor's half into that same page
// (editBoot, client/shell/main.ts, client/shell/remote.ts): the page loads once. Every script here
// hears the frame through `ergaFrames` (framesScript).

import { FAVICON_LINK } from "../../assets/logo/logo.ts";
import type { Session } from "../platform.ts";
import { asset, assetScripts, editorShell } from "./assets.ts";
import { inlineCall, inlineFunction } from "./inline.ts";
import { crumbsFont, esc, link, viewCrumbs } from "./chrome.ts";
import { EDITOR_ALLOW, PAGE_ALLOW, PAGE_SANDBOX } from "./reader.ts";
import { NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu } from "./templates.ts";
import { FAST_CLICK_DEFINE } from "../../shared/fast-click.ts";

/** The viewer's Clone button (a copy of your own, at `href`): also the homepage's. */
export const cloneButton = (href: string) => `<a href="${esc(href)}" class="erga-view-button erga-clone-button" aria-label="Clone: make your own copy" data-tip="Clone"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0345) translate(-12 -13.25)" stroke-width="1.5467"><g transform="translate(0 1.25)"><rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2"/><path d="M15.25 8.75V6.5a1.75 1.75 0 0 0-1.75-1.75H6.5A1.75 1.75 0 0 0 4.75 6.5v7c0 .97.78 1.75 1.75 1.75h2.25"/></g></g></svg></a>`;

/** The viewer's Files button: the document's files view (/<owner>/<slug>?files), for whoever may view it. */
export const filesButton = (href: string) => `<a href="${esc(href)}" class="erga-view-button erga-files-button" aria-label="Files" data-tip="Files"><svg viewBox="0 0 24 24" aria-hidden="true"><g stroke-width="1.5"><path d="M3.75 7.25a2 2 0 0 1 2-2h3.6l2 2h6.9a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-12.5a2 2 0 0 1-2-2z"/></g></svg></a>`;

/** The viewer's pencil (Edit, the editor at `href`), blue while editing: also the homepage's. */
export const editButton = (href: string, editing: boolean) => `<a href="${esc(href)}" class="erga-view-button erga-edit-button" aria-label="Edit" aria-pressed="${editing}" data-tip="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.0512) translate(-11.885 -13.365)" stroke-width="1.5221"><g transform="translate(0 1.25)"><path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/></g></g></svg></a>`;

/** What a page kept for its reload (client/live/restore.ts, RESTORE_KEY: the same, which tests/restore-key.test.ts checks). */
export const RESTORE_KEY = "erga:live:restore";

/** The editor's script and the chunks it imports first (page.js, a module): the only files it fetches (its shell is in the page). */
export const editorScripts = () => JSON.stringify(assetScripts("page.js"));

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

/** The frame's address, opened with ?edit (client/inline/viewer-frame-src.ts). */
export const FRAME_SRC = inlineCall("viewer-frame-src");

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
 * (34px, at max(12px, the notch)) and a 10px gap; the editor's client/editor.html
 * keeps the frame there too. Until the frame says (BAND_BOOT), the colour
 * is the one this document had last time on this browser, and the
 * controls' tone (light or dark text) with it.
 */
export const BAND_STYLE = `:root { --band-h: calc(max(12px, env(safe-area-inset-top)) + 44px); }
html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; }
html { background: var(--page-bg, var(--band, #fff)); }
#frame { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); border: 0; display: block; background: transparent; }
html.erga-band-wait #frame { opacity: 0; }
.erga-canvas { position: fixed; left: 0; top: var(--band-h); width: 100%; height: calc(100% - var(--band-h)); pointer-events: none; }
.erga-canvas > div { position: absolute; left: 0; top: 0; }
.erga-canvas :is(i, b) { position: absolute; display: block; }
.erga-canvas b { overflow: hidden; }
.erga-canvas i { box-sizing: content-box; background-origin: content-box; }`;

/** Sets the band's colour (ergaBand(id, colour)), or the one remembered for document `id` (ergaBand(id)): client/inline/viewer-band-head.ts. */
export const BAND_HEAD = inlineCall("viewer-band-head");

/** The band's colour and the page's canvas, as the page tells them (client/inline/viewer-band.ts). */
export const BAND_BOOT = inlineCall("viewer-band");

/** Going into the editor and back, for those who may (client/inline/viewer-edit-boot.ts). */
export const editBoot = () =>
  inlineCall("viewer-edit-boot", assetScripts("page.js"), { "editor.html": asset("editor.html"), "frame.js": asset("frame.js") });

/** A presentation's steps, on a document's page, viewing and editing alike (client/inline/viewer-steps.ts). */
export const STEPS_BOOT = inlineCall("viewer-steps");

export const STEPS_STYLE = `
<style>
  .erga-steps, .erga-steps-panel { --st-bg: rgba(255, 255, 255, .95); --st-fg: #3f3f46; --st-soft: #8a8a94; --st-hover: rgba(161, 161, 169, .18);
    position: fixed; z-index: 25; box-sizing: border-box; background: var(--st-bg); color: var(--st-fg);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .06), 0 4px 18px rgba(0, 0, 0, .14); font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  html.page-dark :is(.erga-steps, .erga-steps-panel) { --st-bg: rgba(31, 31, 35, .95); --st-fg: #e4e4e9; --st-soft: #8f8f99; --st-hover: rgba(161, 161, 169, .2);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .08), 0 4px 18px rgba(0, 0, 0, .4); }
  .erga-steps[hidden], .erga-steps-panel[hidden] { display: none; }
  .erga-steps { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; transform: translateX(-50%); }
  .erga-steps button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  .erga-steps button:hover:not(:disabled) { background: var(--st-hover); }
  .erga-steps button:disabled { opacity: .3; cursor: default; }
  :is(.erga-steps button, .erga-step):focus-visible { outline: 2px solid #3b7cf0; outline-offset: -2px; }
  .erga-steps button[aria-expanded="true"] { color: #3b7cf0; }
  .erga-steps svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .erga-steps-at { min-width: 54px; padding: 0 2px; text-align: center; font-variant-numeric: tabular-nums; }
  .erga-steps-panel { display: flex; flex-direction: column; width: min(208px, 55vw); overflow: hidden; border-radius: 12px; }
  .erga-steps-head { flex: none; padding: 10px 12px 2px; color: var(--st-soft); font-size: 12px; font-weight: 600; }
  .erga-steps-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 6px; list-style: none; overflow-y: auto; overscroll-behavior: contain; }
  .erga-step { display: block; width: 100%; padding: 5px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .erga-step:hover { background: var(--st-hover); }
  .erga-step-pic { display: grid; place-items: center; width: 100%; aspect-ratio: var(--ar, 16 / 9); overflow: hidden; border-radius: 5px;
    background: var(--st-hover); color: var(--st-soft); font-size: 22px; font-weight: 600; }
  .erga-step-pic img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .erga-step[aria-current="step"] .erga-step-pic { outline: 2px solid #3b7cf0; outline-offset: 1px; }
  .erga-step-name { display: flex; gap: 6px; margin-top: 6px; font-size: 12px; font-weight: 400; line-height: 1.3; }
  .erga-step-name b { color: var(--st-soft); font-weight: 500; font-variant-numeric: tabular-nums; }
  .erga-step-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .erga-steps-plain .erga-step-pic { display: none; }
  .erga-steps-plain .erga-step-name { margin: 0; }
  .erga-steps-plain .erga-step[aria-current="step"] { color: #3b7cf0; }
  .erga-steps-plain .erga-step[aria-current="step"] b { color: inherit; }
  /* On a phone the agent covers the page: the steps go with it. */
  @media (max-width: 640px) { body.agent-open :is(.erga-steps, .erga-steps-panel) { display: none; } }
</style>`;

/** How near the pointer brings the faded controls back (client/inline/fade.ts, NEAR: the same). */
export const FADE_NEAR = 100;

/** How see-through the faded controls are: faint, but still there to find. */
export const FADED = 0.2;

/** The viewer's controls' fade, for a page script: `ergaFade(target, root)` (client/inline/fade.ts). Also the homepage's. */
export const FADE = `var ergaFade=${inlineFunction("fade")};`;

/** The fade (FADE) on a document's page, from the frame's scroll and pointer (client/inline/viewer-fade.ts). */
export const FADE_BOOT = inlineCall("viewer-fade");

export const VIEW_STYLE = `
<style>
  /* The editor's look (client/style.css, .icon-btn): small icons. Right of them is who you are. Upper left, for
     someone signed in, the breadcrumbs (viewCrumbs), where the editor's are (client/editor.html, .chrome-nav) and as they look. */
  :is(.erga-view-buttons, .erga-crumbs) { --chrome: #a1a1a9; --chrome-hover: #3f3f46; --fg: #1c1c1f; --fg-strong: #0d0d0f; --soft: #6b6b73;
    position: fixed; top: max(12px, env(safe-area-inset-top)); z-index: 1000; display: flex; align-items: center;
    font: 500 13px/1 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .erga-view-buttons { right: max(56px, calc(env(safe-area-inset-right) + 40px)); gap: 2px; }
  .erga-crumbs { left: max(14px, env(safe-area-inset-left)); height: 34px; min-width: 0; max-width: calc(100vw - 200px); margin: 0; font-size: 13.5px; }
  /* Each step's box and arrow as the editor's, so going into the editor and out moves nothing. */
  .erga-crumbs, .erga-crumbs > * { align-items: baseline; line-height: 34px; }
  .erga-crumbs > * { display: flex; height: 34px; text-decoration: none; }
  .erga-crumbs > :not(:last-child)::after { content: "›"; color: var(--chrome); opacity: 0.55; font-size: 13.5px; font-weight: 400; letter-spacing: normal; }
  .erga-brand { flex: none; padding: 0 6px; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--fg-strong); }
  .erga-brand::after { margin: 0 -6px 0 10px; }
  .erga-crumbs a.erga-crumb { flex: none; padding: 0 10px; color: var(--soft); }
  .erga-crumb::after { margin: 0 -6px 0 12px; }
  .erga-crumbs .erga-here { padding: 0 8px; }
  .erga-crumbs a:hover { opacity: 0.7; }
  .erga-crumbs a:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 1px; border-radius: 8px; }
  .erga-crumbs .erga-here { min-width: 0; color: var(--fg); }
  .erga-crumbs .erga-here span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 520px) { .erga-crumbs a.erga-crumb { display: none; } .erga-crumbs .erga-here { padding: 0 6px; } }
  /* On the band (BAND_STYLE), in the document's own colour: light or dark text to suit it, whatever the system's mode. */
  html.page-dark :is(.erga-view-buttons, .erga-crumbs) { --chrome: #8a8a94; --chrome-hover: #e4e4e9; --fg: #ececf1; --fg-strong: #ececf1; --soft: #a1a1aa; }
  html.page-light .erga-account { --acc-bg: #fff; --acc-fg: #1c1c1f; --acc-soft: #6b6b73; --acc-chrome: #a1a1a9; --acc-ring: #e6e6ea; --acc-hover: rgba(161, 161, 169, .14); }
  html.page-dark .erga-account { --acc-bg: #1f1f23; --acc-fg: #ececf1; --acc-soft: #8f8f99; --acc-chrome: #8a8a94; --acc-ring: #2f2f35; --acc-hover: rgba(161, 161, 169, .16); }
  html:is(.page-dark, .page-light) .erga-account-btn:not(.erga-account-out) { box-shadow: 0 0 0 2px var(--band, var(--acc-bg)); }
  .erga-view-button { position: relative; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--chrome);
    transition: color 150ms ease, background-color 150ms ease; }
  .erga-view-button:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  /* Editing (or on the way into it), the pencil is blue, as the editor's own is. */
  .erga-view-button[aria-pressed="true"] { color: #3b7cf0; }
  /* On the way into the editor the first time, while its code arrives, the pencil breathes (only if that takes a moment). */
  body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: erga-edit-wait 700ms ease-in-out 250ms infinite alternate; }
  @keyframes erga-edit-wait { to { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { body.erga-editing:not(.erga-editor-ready) .erga-view-button[aria-pressed] svg { animation: none; opacity: 0.6; } }
  .erga-view-button svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .erga-view-button::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); white-space: pre; font-size: 12px;
    font-weight: 400; line-height: 1.3; letter-spacing: .01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .erga-view-button:hover::after { opacity: 1; } }
  /* Into the editor and out (editBoot): the controls you're going to are there at once, whole, and the ones you're leaving fade
     out; so those in both (the pencil, your avatar, the breadcrumbs) never go see-through. */
  #erga-editor { opacity: 0; transition: opacity 200ms ease; }
  body.erga-editing.erga-editor-ready #erga-editor { opacity: 1; transition: none; }
  body:not(.erga-editing) #nav-docs { visibility: hidden; }
  .erga-view-buttons, .erga-account, .erga-crumbs { transition: none; }
  /* Editing, the editor's own breadcrumbs, just under the viewer's while those fade, take the clicks. */
  body.erga-editing .erga-crumbs { pointer-events: none; }
  body.erga-editing.erga-editor-ready :is(.erga-view-buttons, .erga-account, .erga-crumbs) { opacity: 0; visibility: hidden; transition: opacity 200ms ease, visibility 0s 200ms; }
  /* Faded once the page is scrolled (FADE): the controls themselves, not the band behind them nor your open menu. Quick and
     smooth, and with no motion at all for those who ask for less: just the change. */
  .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: opacity 180ms ease, color 150ms ease, background-color 150ms ease; }
  html.erga-faded :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  :host(.erga-faded) :is(.erga-view-buttons > *, .erga-account-btn, .erga-crumbs > *) { opacity: ${FADED}; }
  @media (prefers-reduced-motion: reduce) { .erga-view-buttons > *, .erga-account-btn, .erga-crumbs > * { transition: color 150ms ease, background-color 150ms ease; } }
  /* On a phone they'd sit over the text the whole way down: they stay at the top instead. */
  @media (max-width: 640px), (max-height: 480px) {
    .erga-view-buttons, .erga-crumbs { position: absolute; }
  }
</style>`;

/**
 * The viewer's page around a document's frame (documents/view.ts decides what goes in: who may edit, the frame's address
 * with its token, the metas), in two parts: `before` ends with the frame, `after` before </body>. The document shows in
 * the frame, on its pages origin; editing is loaded into it (editBoot) only when someone goes into it, by the pencil or
 * at ?edit (`editing`: opened so).
 */
export function viewerPage(o: { title: string; docId: string; pages: string; src: string; meta: string; session: Session | null; editable: boolean; editing: boolean; landing: boolean; clone: string; edit: string; files?: string }): { before: string; after: string } {
  // Opened with ?edit, for whoever may edit: the page is the editor's from its first moment (editingHead, EDITING_BODY),
  // the page in the frame starts on its half of the editor at once (FRAME_SRC), and the editor's files are fetched as the
  // page parses, rather than one after another once its script runs (editBoot).
  // (And the buttons that act as the press starts, for the editor's modules: shared/fast-click.ts.)
  const opening = o.editable
    ? `${shellTemplate()}<script>${editingHead()}
${FAST_CLICK_DEFINE}</script>`
    : "";
  // The page on its own origin, connected to from the start; it may play media only on the editor's say (EDITOR_ALLOW).
  const editing = o.editable && o.editing;
  const frame = `<iframe id="frame" class="erga-view" ${editing ? `data-src="${esc(o.src)}"` : `src="${esc(o.src)}"`} title="${esc(o.title)}" sandbox="${PAGE_SANDBOX}" allow="${editing ? EDITOR_ALLOW : PAGE_ALLOW}"></iframe>`;
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
${o.meta}<script>${framesScript(o.pages)}</script>${backdrop}${crumbsFont(session)}<style>${BAND_STYLE}</style>${opening}
<body>${o.editable ? `<script>${EDITING_BODY}</script>` : ""}
<div class="erga-canvas" aria-hidden="true"><div></div></div>${frame}${editing ? `<script>${FRAME_SRC}</script>` : ""}`;
  const after = `
${viewCrumbs(session, o.landing ? null : o.title)}<div class="erga-view-buttons">${newDocButton("erga-view-button")}${o.clone}${o.files ?? ""}${o.edit}</div>${newDocMenu((path) => link(path, session), !!session && !session.test && !session.agent)}${VIEW_STYLE}${NEW_DOC_STYLE}<script>${NEW_DOC_SCRIPT}ergaNewDoc(document);</script><script>${NAV_SCRIPT}</script><script>${BAND_BOOT}</script><script>${FADE_BOOT}</script>${STEPS_STYLE}<script>${STEPS_BOOT}</script>${o.editable ? `<script>${editBoot()}</script>` : ""}
`;
  return { before, after };
}

/** With no colour remembered for the document, its page waits out of sight for the band's own (client/inline/viewer-band-wait.ts). */
export const BAND_WAIT = inlineCall("viewer-band-wait");
