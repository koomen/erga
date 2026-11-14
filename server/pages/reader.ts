// A document's page, as everyone sees it: one frame on the viewer (pages/viewer.ts), which holds the page on the
// document's own pages origin (documents/pages-origin.ts), served with the source marks the editor needs
// (shared/page-html.ts). It loads once: reading it, and editing it. Going into the editor loads the editor's half into the
// page itself (libs/text/ui/frame.ts, from the app's origin, pinned by its integrity), which finds the text there by its
// marks; going back out stops it, and the page stays as it is, its scripts and media carrying on.
//
// This script goes into the page first (before the page's own), and tells the viewer by postMessage what it needs:
// where the page is scrolled to and where the pointer is (the fade), its background (the band and the canvas around
// the frame), its steps (a presentation), and which of the document's pages it shows. It follows the viewer's asks (a
// step, a step's picture, the editor), and sends links that leave the document to the viewer, which opens them.
//
// What it sends is the page's own word: the page's scripts can send the same (the viewer checks every message as
// coming from the page). It sends nothing secret, and to the viewer's origin only. The page's origin holds nothing but
// this one document: that's the boundary (PAGE_SANDBOX).

import { bringsEditor, pageOf, type ReaderConfig } from "../../shared/page-html.ts";
import { asset, frameScripts, pageFonts } from "./assets.ts";
import { inlineCall } from "./inline.ts";
import { jsonInScript } from "../../shared/html.ts";

/** The page's problems, from before its first script (client/inline/page-problems.ts). */
const PROBLEM_WATCH = inlineCall("page-problems");
/** The text guard, while the editor is on the page (client/inline/page-text-guard.ts). */
const TEXT_GUARD = inlineCall("page-text-guard");
/** ergaEditor, for the page's own script (client/inline/page-editing-api.ts). */
const EDITING_API = inlineCall("page-editing-api");

/**
 * What a document's page may do in its frame, for readers and editors alike.
 *
 * allow-same-origin stays, with allow-scripts: the page keeps its pages origin, which holds nothing but this one
 * document, and the editor's half reaches into it there (typing and carets). So the page's script can remove its own
 * sandbox: Chrome warns about that, rightly, and it changes nothing. The boundary is the origin: the page can't reach
 * the app's origin, its cookies or another document's origin, and the viewer (viewer.ts, client/shell/page-frame.ts) treats every
 * message from it as the page's own. Its own storage is its own, as on any site.
 */
export const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

/** What a reader's page may do beyond its sandbox: nothing. */
export const PAGE_ALLOW = "autoplay 'none'; fullscreen 'none'";

/**
 * What an editor's page may do beyond its sandbox: autoplay, for the agent's page_input (it gives no activation of its
 * own, so the page's media plays on the tab's). Never full screen: the agent can't use it, and a page in full screen
 * could pass for Erga. (The frame is the same one viewing and editing: what it may do is decided as the viewer loads,
 * opened in the editor or not.)
 */
export const EDITOR_ALLOW = "autoplay; fullscreen 'none'";

/** The script, as text (client/inline/reader.ts). */
export const readerScript = (config: ReaderConfig) => inlineCall("reader", config);

/** The live log's watch, from the page's first moment (client/inline/page-live-watch.ts). */
const LIVE_WATCH = inlineCall("page-live-watch");

/**
 * A page of the document as its pages origin serves it: its HTML as written with, first in its
 * <head>, this script; for whoever may edit, before it, the editor's half's integrity (an import map: the browser checks
 * each of its modules against it, and it must come before any module loads), and after it, the scripts the editor needs
 * from the page's first moment (its problems and its live log, the text guard, ergaEditor).
 */
export function readerPage(html: string, o: { shell: string; prefix: string; src: string; editor: boolean }): string {
  // erga/text, unless the page brings its editor: it imports erga/text itself (/erga/text/editor.js), or has its own
  // (<meta name="erga-editor" content="own">). Then the page's editor hears the viewer's word (erga-mode) itself.
  const scripts = o.editor ? frameScripts(o.shell) : undefined;
  const editor = scripts && bringsEditor(html) ? { ...scripts, src: "", preload: [] } : scripts;
  const head =
    (editor ? `<script type="importmap" data-erga>${jsonInScript({ imports: {}, integrity: editor.map })}</script>` : "") +
    `<script data-erga>${readerScript({ shell: o.shell, prefix: o.prefix, src: o.src, ...(editor ? { editor } : {}) })}</script>` +
    // The templates' typefaces, by name, from Erga's own files: a page asks no other site for them.
    (pageFonts(o.shell) ? `<style data-erga>${pageFonts(o.shell)}</style>` : "") +
    (editor
      ? `<script data-erga>${PROBLEM_WATCH}</script><script data-erga>${LIVE_WATCH}</script><script data-erga>${TEXT_GUARD}</script><script data-erga>${EDITING_API}</script>`
      : "");
  return pageOf(html, head, o.shell);
}

/** The version of what the pages origin puts in a page: this script's and the editor's build's (frame.js's address names it). */
export const readerVersion = () =>
  versionOf(
    readerScript({ shell: "", prefix: "", src: "" }) +
      PROBLEM_WATCH +
      TEXT_GUARD +
      EDITING_API +
      LIVE_WATCH +
      asset("frame.js") +
      pageFonts("")
  );

/** A digest of text (FNV-1a), which changes whenever it does. */
const versionOf = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
