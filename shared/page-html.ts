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
  /** For whoever may edit: the editor's half (frame.js), its chunks and their integrity. */
  editor?: { src: string; integrity: string; preload: string[]; map: Record<string, string> };
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

