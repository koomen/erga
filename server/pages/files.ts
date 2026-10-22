// The files view: /<owner>/<slug>?files, beside the viewer and the editor
// (server/documents/view.ts sends it there). Every file of the document or
// project, of any kind, as a tree on the left, and the selected file on the
// right, read-only, as the browser shows it: a PDF in its PDF viewer, an
// image or a video as it is, text as text. Whoever may edit adds files (a
// drop anywhere on the window, into the selected folder), and moves,
// renames and deletes them. The page's script is its own (client/files.ts,
// files.js), loaded only here.

import type { Session } from "../platform.ts";
import { appPage, crumbs, esc } from "./chrome.ts";
import { scriptTag } from "./assets.ts";

export interface FilesPageOptions {
  session: Session;
  /** The document's title and address (/<owner>/<slug>). */
  title: string;
  address: string;
  docId: string;
  /** Where its files are read from: its pages origin, with the token that opens them (/t/<token>/). */
  pages: string;
  canEdit: boolean;
}

export function filesPage(o: FilesPageOptions): string {
  const meta = `<meta name="erga-doc" content="${esc(o.docId)}"><meta name="erga-base" content="/d/${esc(o.docId)}"><meta name="erga-address" content="${esc(o.address)}"><meta name="erga-pages" content="${esc(o.pages)}"><meta name="erga-can-edit" content="${o.canEdit ? "1" : ""}">`;
  const trail = [{ label: "Documents", href: "/docs" }, { label: o.title, href: o.address }, { label: "Files" }];
  return appPage(`Files · ${o.title}`, STYLE, `${meta}${crumbs(o.session, o.session.test ? trail.slice(1) : trail)}
<main class="files" aria-busy="true">
  <section class="tree-pane" aria-label="Files">
    <h1 class="visually-hidden">Files of ${esc(o.title)}</h1>
    <p class="status" role="status" aria-live="polite"></p>
    <ul class="uploads" aria-label="Uploads"></ul>
    <ul class="tree" role="tree" aria-label="Files of ${esc(o.title)}"></ul>
    ${o.canEdit ? `<p class="hint">Drop files or folders anywhere on this page to add them to the selected folder. A file with the same name is replaced; the old one stays in the versions.</p>` : ""}
  </section>
  <section class="view-pane" aria-label="The selected file"><p class="nothing">Select a file to see it here.</p></section>
  <div class="drop" hidden><p>Drop to add to <b class="drop-to"></b></p></div>
</main>
${scriptTag("files.js")}`, false);
}

const STYLE = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  /* Below the breadcrumbs (the app's: absolute, at the top), the tree and the file side by side, as high as the window. */
  main.files { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 440px) minmax(0, 1fr); gap: 0; padding: 0; max-width: none; margin: 58px 0 0; border-top: 1px solid var(--rule); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .tree-pane { min-height: 0; overflow: auto; padding: 12px 12px 40px 16px; border-right: 1px solid var(--rule); }
  .status { min-height: 18px; margin: 0 0 6px; font-size: 13px; color: var(--fg); }
  .status.error { color: #c2410c; }
  .hint { margin: 18px 0 0; font-size: 12.5px; color: var(--soft); line-height: 1.45; }
  ul.tree, ul.tree ul, ul.uploads { list-style: none; margin: 0; padding: 0; }
  ul.tree ul { padding-left: 16px; }
  .row { display: grid; grid-template-columns: 18px 18px minmax(0, 1fr) auto auto auto; align-items: center; gap: 6px; min-height: 30px; padding: 0 4px 0 2px; border-radius: 6px; cursor: default; user-select: none; }
  .row:hover { background: color-mix(in srgb, var(--chrome) 9%, transparent); }
  .row[aria-selected="true"] { background: color-mix(in srgb, var(--link) 13%, transparent); }
  .row.target { outline: 2px solid var(--link); outline-offset: -2px; }
  .row .twist { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; background: none; color: var(--chrome); cursor: pointer; }
  .row .twist svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform 120ms ease; }
  .row .twist[aria-expanded="true"] svg { transform: rotate(90deg); }
  .row .icon svg { width: 16px; height: 16px; fill: none; stroke: var(--soft); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; display: block; }
  .row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); font-size: 14px; }
  .row .name input { width: 100%; font: inherit; padding: 2px 4px; border: 1px solid var(--link); border-radius: 4px; }
  .row .size, .row time { font-size: 12px; color: var(--soft); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .row .acts { display: flex; gap: 0; opacity: 0; }
  .row:hover .acts, .row:focus-within .acts, .row[aria-selected="true"] .acts { opacity: 1; }
  .row .acts button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--chrome); cursor: pointer; }
  .row .acts button:hover { color: var(--fg-strong); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
  .row .acts svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 2px 0 6px 40px; font-size: 13px; color: var(--fg); }
  .confirm button { font: inherit; font-size: 12.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--rule); background: none; cursor: pointer; }
  .confirm button.danger { border-color: #c2410c; color: #c2410c; }
  .row-error { margin: 0 0 4px 40px; font-size: 12.5px; color: #c2410c; }
  ul.uploads li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; margin: 0 0 8px; font-size: 12.5px; color: var(--fg); }
  ul.uploads li .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul.uploads li .pct { color: var(--soft); font-variant-numeric: tabular-nums; }
  ul.uploads li progress { grid-column: 1 / -1; width: 100%; height: 4px; }
  ul.uploads li.failed { color: #c2410c; }
  .view-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .view-pane .nothing { margin: auto; color: var(--soft); font-size: 14px; }
  .view-head { display: flex; align-items: baseline; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--rule); }
  .view-head h2 { margin: 0; font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .view-head .about { font-size: 12.5px; color: var(--soft); white-space: nowrap; }
  .view-head a { margin-left: auto; font-size: 13px; white-space: nowrap; }
  .view-body { flex: 1; min-height: 0; overflow: auto; display: flex; }
  .view-body iframe { flex: 1; border: 0; width: 100%; height: 100%; background: #fff; }
  .view-body img, .view-body video { max-width: 100%; max-height: 100%; margin: auto; object-fit: contain; }
  .view-body audio { margin: auto; }
  .view-body pre { flex: 1; margin: 0; padding: 16px 20px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: var(--fg-strong); }
  .view-body .other { margin: auto; text-align: center; color: var(--fg); font-size: 14px; }
  .drop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: color-mix(in srgb, var(--link) 12%, transparent); border: 3px dashed var(--link); pointer-events: none; }
  .drop[hidden] { display: none; }
  .drop p { padding: 12px 18px; border-radius: 10px; background: var(--bg, #fff); font-size: 15px; color: var(--fg-strong); box-shadow: 0 4px 24px rgb(0 0 0 / 12%); }
  @media (max-width: 760px) {
    main.files { grid-template-columns: 1fr; grid-template-rows: auto minmax(60vh, 1fr); }
    .tree-pane { border-right: 0; border-bottom: 1px solid var(--rule); max-height: 50vh; }
  }
`;
