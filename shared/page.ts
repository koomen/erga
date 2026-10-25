// A document's page as its pages origin serves it (server/documents/pages-origin.ts), to readers and editors alike:
// its own HTML with the source marks the editor needs (data-erga-id on each text block: manuscript.ts's stamp), and
// first in its <head> the viewer's script (server/pages/reader.ts), with, for whoever may edit, the scripts below. The
// page loads once: going into the editor loads the editor's half into it (client/frame.ts), which finds the text
// blocks by their marks and checks the page was made from the text it has (sourceDigest). Pure: the server makes the
// page with it, and the editor reads it back.
//
// Each script here goes in as a <script data-erga>: the editor's additions, which its morph (client/morph.ts) leaves be.

import { analyzeHtml, stamp } from "./manuscript";

/** What the script needs: the viewer's origin, where the document's files are (with the token), and its text's digest. */
export interface ReaderConfig {
  /** The viewer's origin (the token names it): the only one it talks to. */
  shell: string;
  /** The path the document's files are under on this origin: /t/<token>/. */
  prefix: string;
  /** The digest of the text the page was made from (shared/page.ts, sourceDigest): the editor checks it has the same. */
  src: string;
  /** For whoever may edit: the editor's half (frame.js), its chunks and their integrity. */
  editor?: { src: string; integrity: string; preload: string[]; map: Record<string, string> };
}

/** The page's HTML, its text blocks marked (data-erga-id), as the editor's own analysis of the same text numbers them. */
export const markPage = (src: string): string => stamp(src, analyzeHtml(src).units);

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

/**
 * Catches the page's script errors and files that fail to load, from before its first script, and hands them to the
 * editor once it's there (`__ergaReport`).
 */
export const PROBLEM_WATCH = `(function(){var q=window.__ergaProblems=[];function r(p){window.__ergaReport?window.__ergaReport(p):q.push(p)}addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&t.tagName){var u=t.getAttribute("src")||t.getAttribute("href");if(u)r({kind:"resource",tag:t.tagName.toLowerCase(),url:u})}else r({kind:"script",message:String(e.message||"Script error"),file:e.filename||"",line:e.lineno||0})},true);addEventListener("unhandledrejection",function(e){r({kind:"script",message:"Unhandled promise rejection: "+String(e.reason&&e.reason.message||e.reason),file:"",line:0})})})();`;

/**
 * `ergaEditor`, for the page's own script: whether the editor is on it now (`editing`, and data-erga-editing on its
 * <html>, which the editor sets and takes off: client/frame.ts), with the event erga-editing on the window as it
 * changes, and `apply(edits)` for its custom edits (editor-agent/PROMPT.md, "Custom edits"), which waits for the editor.
 */
export const EDITING_API = `(function(){var q=[];window.__ergaApplyQueue=q;window.ergaEditor=Object.freeze({get editing(){return document.documentElement.hasAttribute("data-erga-editing")},apply:function(ops){return new Promise(function(done){window.__ergaApply?done(window.__ergaApply(ops)):q.push([ops,done])})}})})();`;

/** Where a press is the editor's: in a text block (data-erga-id) that takes edits, not in a widget or a form field. */
export const GUARD_TEXT = "[data-erga-id]";
export const GUARD_NOT_TEXT = '.erga-locked, [data-erga-noedit], [contenteditable="false"], input, textarea, select, button';
/** What keeps the browser's own press (a link, a form field, an editable part the page made itself, a video's controls). */
const GUARD_INTERACTIVE = 'a[href], button, input, textarea, select, label, summary, video, audio, iframe, [tabindex], [draggable="true"], [contenteditable]:not([contenteditable="false"])';
/** The cursors that say a drag here moves the page. */
const GUARD_GRAB = "^(grab|grabbing|move|all-scroll)$";
/** The press, its moves and its release, for the mouse, a pen and a touch. */
export const GUARD_DOWN = ["pointerdown", "mousedown", "touchstart"];
export const GUARD_MOVE = ["pointermove", "mousemove", "touchmove"];
export const GUARD_UP = ["pointerup", "pointercancel", "mouseup", "touchend", "touchcancel"];
/** The release that ends a press: a mouse's (a pen's and a tap's come as mouse events too, last), or a touch's. */
const GUARD_END = ["mouseup", "touchend", "touchcancel"];

/**
 * The text guard (client/text-guard.ts says what it does), while the editor is on the page (data-erga-editing):
 * first, so its listeners on the window, in the capture phase, run before any of the page's.
 */
export const TEXT_GUARD = `(function(TEXT,NOT_TEXT,INTERACTIVE,GRAB,DOWN,MOVE,UP,END){
var own=window.__ergaOwn={},pressed=false,opts={capture:true,passive:false},grab=new RegExp(GRAB),root=document.documentElement;
function on(){return root.hasAttribute("data-erga-editing")}
function elOf(e){var t=e.target;return t&&(t.nodeType==1?t:t.parentElement)}
function onText(e){var el=elOf(e);return !!(el&&el.closest&&el.closest(TEXT))&&!el.closest(NOT_TEXT)}
function pans(e){var el=elOf(e);if(!el||!el.closest||el.closest(INTERACTIVE))return false;if(grab.test(getComputedStyle(el).cursor))return true;for(var a=el;a;a=a.parentElement)if(getComputedStyle(a).touchAction=="none")return true;return false}
function take(e){var fs=(own[e.type]||[]).slice();for(var i=0;i<fs.length;i++){try{fs[i](e)}catch(x){setTimeout(function(){throw x})}}e.stopImmediatePropagation()}
DOWN.forEach(function(type){addEventListener(type,function(e){if(e.button||!on()){pressed=false;return}pressed=onText(e);if(pressed)take(e);else if(type=="mousedown"&&pans(e))e.preventDefault()},opts)});
MOVE.forEach(function(type){addEventListener(type,function(e){if(pressed)take(e)},opts)});
UP.forEach(function(type){addEventListener(type,function(e){if(!pressed)return;if(END.indexOf(type)>=0)pressed=false;take(e)},opts)});
})(${[GUARD_TEXT, GUARD_NOT_TEXT, GUARD_INTERACTIVE, GUARD_GRAB, GUARD_DOWN, GUARD_MOVE, GUARD_UP, GUARD_END].map((v) => JSON.stringify(v)).join(",")});`;
