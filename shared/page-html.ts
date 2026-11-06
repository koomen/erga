// A document's page as its pages origin serves it (server/documents/pages-origin.ts), to readers and editors alike:
// its own HTML as written, with first in its <head> the viewer's script (server/pages/reader.ts), and, for whoever may
// edit, the scripts below. The page loads once: going into the editor loads the editor's half into it
// (libs/text/ui/frame.ts), which checks the page was made from the text it has (sourceDigest) and ties the page to
// a parse of that text (libs/text/ui/mirror.ts). Pure: the server makes the page with it, and the editor reads it
// back.
//
// Each script here goes in as a <script data-erga>: the editor's additions, which the editor's patch (libs/text/ui/mirror.ts) leaves be.

/** What the script needs: the viewer's origin, where the document's files are (with the token), and its text's digest. */
export interface ReaderConfig {
  /** The viewer's origin (the token names it): the only one it talks to. */
  shell: string;
  /** The path the document's files are under on this origin: /t/<token>/. */
  prefix: string;
  /** The digest of the text the page was made from (shared/page-html.ts, sourceDigest): the editor checks it has the same. */
  src: string;
  /** The document's public address (https://erga.dev/<owner>/<slug>): the viewer says it once the page is up (erga-address). */
  address?: string;
  /**
   * For whoever may edit: the editor (erga/text at its address, /erga/text/editor.js; "" when the page brings its own),
   * its build and chunks to preload, the integrity of every script of Erga's the page may load, and Erga's page tools
   * (tools.js: the agent's view_page and the live page's tools).
   */
  editor?: {
    src: string;
    integrity: string;
    preload: string[];
    map: Record<string, string>;
    tools: { src: string; integrity: string; preload: string[] };
  };
}

/** A digest of a page's text (cyrb53), which the editor compares with its own text's: the page was made from the same. */
export function sourceDigest(src: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ":" + src.length.toString(36);
}

/**
 * `inject` at the top of the page's <head>: just inside its <head> tag, else in a <head> of its own just inside <html>,
 * else after the doctype (so the page keeps its mode), else first. The parser puts it in the head in each case, before
 * anything of the page's own.
 */
export function insertHead(html: string, inject: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + inject + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${inject}</head>` + html.slice(root.index + root[0].length);
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + inject + html.slice(doctype[0].length) : inject + html;
}

/** The mark the editor puts on each text block's element while it edits (libs/text/ui/core.ts). */
export const TEXT_ATTR = "data-erga-text";
/** Where a press is the editor's: in a text block that takes edits, not in a widget or a form field. */
export const GUARD_TEXT = `[${TEXT_ATTR}]`;
export const GUARD_NOT_TEXT = '.erga-locked, [data-erga-noedit], [contenteditable="false"], input, textarea, select, button';
/** What keeps the browser's own press (a link, a form field, an editable part the page made itself, a video's controls). */
export const GUARD_INTERACTIVE =
  'a[href], button, input, textarea, select, label, summary, video, audio, iframe, [tabindex], [draggable="true"], [contenteditable]:not([contenteditable="false"]):not(body)';
/** The cursors that say a drag here moves the page. */
export const GUARD_GRAB = "^(grab|grabbing|move|all-scroll)$";
/** The press, its moves and its release, for the mouse, a pen and a touch. */
export const GUARD_DOWN = ["pointerdown", "mousedown", "touchstart"];
export const GUARD_MOVE = ["pointermove", "mousemove", "touchmove"];
export const GUARD_UP = ["pointerup", "pointercancel", "mouseup", "touchend", "touchcancel"];
/** The release that ends a press: a mouse's (a pen's and a tap's come as mouse events too, last), or a touch's. */
export const GUARD_END = ["mouseup", "touchend", "touchcancel"];


/**
 * A page imports Erga's libraries at erga.dev (https://erga.dev/erga/<name>/editor.js); each server serves its own
 * (serveLibrary), the build its editor runs. So the page loads them from the viewer's origin, `shell`: staging's page
 * loads staging's library, and a local server's its own. The page (server/pages/reader.ts) and the agent's copy of it
 * (client/page-tools/tools.ts) both do. The text the editor reads stays as written.
 */
export const localLibraries = (html: string, shell: string) =>
  html.replace(/(<script\b[^>]*\bsrc\s*=\s*["']?)https:\/\/erga\.dev(\/erga\/[a-z]+\/editor\.js)/gi, `$1${shell}$2`);

/** A document's page as its pages origin serves it: its text, with Erga's `head` first in its <head> (server/pages/reader.ts). */
export const pageOf = (text: string, head: string, shell: string) => insertHead(localLibraries(text, shell), head);

/**
 * Erga's head of a page the pages origin made (what `pageOf` put first in its <head>): its scripts, each a <script
 * data-erga> whose text holds no "</script" (inline.ts, jsonInScript). Null if it has none.
 */
export function headIn(served: string): string | null {
  const head = /<head(\s[^>]*)?>/i.exec(served),
    doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(served);
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
  return /^(?:<script\b[^>]*\bdata-erga\b[^>]*>[\s\S]*?<\/script>)+/i.exec(served.slice(at))?.[0] ?? null;
}

/**
 * The page the pages origin makes from `text`, given Erga's `head` of a page it made from any text of the same document
 * (headIn): the same head, with the new text's digest (the page's editor puts it in the browser's copy, for a reload
 * offline: libs/text/ui/offline-page.ts). Null if the head names no text.
 */
export function pageAgain(head: string, text: string, shell: string): string | null {
  const src = /"src":"[^"]*"/;
  if (!src.test(head)) return null;
  return pageOf(
    text,
    head.replace(src, () => `"src":${JSON.stringify(sourceDigest(text))}`),
    shell
  );
}

/** Whether a page brings its editor: it imports erga/text itself (<script src=".../erga/text/editor.js">), or has its own. */
export const bringsEditor = (html: string) =>
  /<script\b[^>]*\bsrc\s*=\s*["']?[^"'\s>]*\/erga\/text\/editor\.js\b/i.test(html) ||
  /<meta\b(?=[^>]*\bname\s*=\s*["']?erga-editor\b)(?=[^>]*\bcontent\s*=\s*["']?own\b)[^>]*>/i.test(html);
