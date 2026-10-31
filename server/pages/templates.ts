// What a new document can start from: the templates the + button offers
// (the viewer's, the homepage's, the editor's and the documents page's New), and /new?template=<id>
// makes. One registry, so a new template is one entry in TEMPLATES (its
// starting files in assets/templates/<name>/, index.html and text files
// beside it, which the Worker reads as text). No server code: the editor's
// bundle reads it too.

import { asset } from "./assets.ts";
import type { DocKind } from "../../document/pages.ts";
import { esc } from "../../shared/html.ts";
import { inlineStyle } from "./inline.ts";

/** A template: what the picker shows, and the files a new document starts with. */
export interface Template {
  /** Its name in /new?template=<id>: lowercase letters, digits and dashes. Never changes once it's out (links name it). */
  id: string;
  /** What the picker calls it. */
  name: string;
  /** A line under its name. */
  description: string;
  /**
   * The starting document: a folder of the repo, assets/templates/<name>, copied
   * whole (text files only), whose page is its index.html.
   */
  files: `assets/templates/${string}`;
  /** What it makes: a project (pages) from the start; else a document, or what its files make it. */
  kind?: DocKind;
}

/** The templates, in the picker's order. The first is what /new makes when no template is named. */
export const TEMPLATES: Template[] = [
  { id: "page", name: "Document", description: "A blank page.", files: "assets/templates/doc" },
  { id: "slides", name: "Slides", description: "16:9 slides you step through.", files: "assets/templates/slides" },
  {
    id: "canvas",
    name: "Canvas",
    description: "Frames on one big canvas; each step glides to the next.",
    files: "assets/templates/canvas",
  },
  {
    id: "project",
    name: "Project",
    description: "Pages, each at its own address. It starts with two that link to each other.",
    files: "assets/templates/project",
    kind: "project",
  },
];

export const templateById = (id: string | null | undefined): Template | undefined => TEMPLATES.find((t) => t.id == id);


const PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 12) scale(1.1538) translate(-12 -12)" stroke-width="1.3867"><path d="M12 5.5v13M5.5 12h13"/></g></svg>`;

/**
 * The + button: `cls` gives it the look of the controls it sits with (the viewer's erga-view-button, the editor's icon-btn,
 * the documents page's pill), and `label` a word beside the + (the documents page's "New").
 */
export const newDocButton = (cls: string, label = "") =>
  `<button type="button" class="${cls} erga-new-btn" aria-label="New document"${label ? "" : ` data-tip="New document"`} aria-haspopup="menu" aria-expanded="false" aria-controls="erga-new-menu">${PLUS}${esc(label)}</button>`;

/**
 * The picker, one on each page (or shadow root) whatever + buttons it has:
 * each template a link to /new?template=<id> (`href` adds what the page's
 * links keep, ?user=). /new asks someone signed out to sign in first, and
 * comes back to make it.
 */
export function newDocMenu(href: (path: string) => string): string {
  const item = (t: Template) =>
    `<a role="menuitem" href="${esc(href(`/new?template=${encodeURIComponent(t.id)}`))}" data-template="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.description)}</span></a>`;
  return `<div class="erga-new-menu" id="erga-new-menu" role="menu" aria-label="New document" data-fonts="${esc(asset("inter.css"))}" hidden><p class="erga-new-title">New document</p>${TEMPLATES.map(item).join("")}</div>`;
}

/** The menu's look (client/inline/new-doc.css). */
export const NEW_DOC_STYLE = `<style>${inlineStyle("new-doc")}</style>`;
