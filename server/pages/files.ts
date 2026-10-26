// The files view: /<owner>/<slug>?files, beside the viewer and the editor
// (server/documents/view.ts sends it there). Every file of the document or
// project, of any kind, as a tree on the left, and the selected file on the
// right, read-only, as the browser shows it: a PDF in its PDF viewer, an
// image or a video as it is, text as text. Whoever may edit adds files (a
// drop anywhere on the window, into the selected folder), and moves,
// renames and deletes them. The page's script is its own (client/pages/files.ts,
// files.js), loaded only here.

import type { Session } from "../platform.ts";
import { appPage, crumbs } from "./chrome.ts";
import { esc } from "../../shared/html.ts";
import { scriptTag } from "./assets.ts";
import { inlineStyle } from "./inline.ts";

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
  return appPage(`Files · ${o.title}`, inlineStyle("files"), `${meta}${crumbs(o.session, o.session.test ? trail.slice(1) : trail)}
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

