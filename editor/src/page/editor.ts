// The page editor: the rendered page is the editing surface. The document's
// source (HTML or Markdown) is the model, an EditorState with the same change
// sets and undo history as the Markdown editor. The page is rendered in an
// iframe; its manuscript elements are found by the deterministic analysis in
// manuscript.ts / markdown.ts, which gives every text node a source range.
//
// Two regimes. Each manuscript unit is its own contenteditable host: click
// into one and it behaves like an editor (caret, selection, typing), and the
// arrow keys carry the caret from one unit to the next so the page still
// reads as one document. Everything else is an ordinary web page: buttons,
// links and widgets work as they would anywhere, and clicking them places no
// caret. Every input event in a unit is cancelled and turned into a
// transaction on the source; the DOM is then patched: text nodes in place,
// a unit's inner HTML when its inline structure changed, sibling elements
// when a paragraph was split or joined, and the whole page only as a last
// resort. IME composition is the one case where the browser edits the DOM
// first; the text is read back into the model when it ends.

import { EditorState, EditorSelection, type SelectionRange, Transaction, MapMode, findClusterBreak, type ChangeSet, type TransactionSpec } from "@codemirror/state";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import * as M from "./manuscript";
import { analyzeMarkdown, escapeMarkdownText } from "./markdown";
import { changesBetween } from "./merge";

export type Kind = "html" | "md";

export interface PageUpdate {
  state: EditorState;
  docChanged: boolean;
  selectionSet: boolean;
  /** The page was rendered again from scratch. */
  rendered: boolean;
  /** What changed in the document, if it did. */
  changes: ChangeSet | null;
  /** The change came from elsewhere (`applyExternal`), not from this editor. */
  remote: boolean;
}

/** Something wrong with the document that the user can see, and how the agent could fix it. */
export interface PageProblem {
  /** Identifies the problem across renders (the same error, the same missing file). */
  key: string;
  message: string;
  /** A prompt asking the agent to fix it. */
  fix: string;
}

/**
 * Put first in the page's <head>: catches the page's script errors and
 * files that fail to load (from the first script on, before the editor can
 * listen), and hands them to the editor once it's there (`__swReport`).
 */
const PROBLEM_WATCH = `<script data-sw>(function(){var q=window.__swProblems=[];function r(p){window.__swReport?window.__swReport(p):q.push(p)}addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&t.tagName){var u=t.getAttribute("src")||t.getAttribute("href");if(u)r({kind:"resource",tag:t.tagName.toLowerCase(),url:u})}else r({kind:"script",message:String(e.message||"Script error"),file:e.filename||"",line:e.lineno||0})},true);addEventListener("unhandledrejection",function(e){r({kind:"script",message:"Unhandled promise rejection: "+String(e.reason&&e.reason.message||e.reason),file:"",line:0})})})()</script>`;

/** Who made a change, for its marks: a name and a colour. */
export interface MarkAuthor { name: string; color: string }

/** Someone else in the document: their caret (and selection) as source positions. */
export interface Peer {
  key: number;
  name: string;
  color: string;
  anchor: number;
  /** The other end of their selection, if they have one. */
  head: number | null;
  agent?: boolean;
  /** What an agent is doing ("editing index.html"), shown on its label. */
  activity?: string | null;
}

export interface PageEditorConfig {
  frame: HTMLIFrameElement;
  kind: Kind;
  state: EditorState;
  /** Where the document's relative URLs resolve, e.g. "/doc/". */
  base: string;
  /** Extra <head> HTML for Markdown documents (the article template's styles). */
  markdownHead?: string;
  onUpdate?: (u: PageUpdate) => void;
  /** Unhandled keydowns inside the page (for app-level shortcuts). */
  onKey?: (e: KeyboardEvent) => boolean;
  /** A pointer moved inside the page. */
  onPointer?: (e: MouseEvent) => void;
  /**
   * Something the user asked for couldn't be done; say why. When the
   * document itself is at fault, `fix` is a prompt that asks the agent to
   * repair it, and the shell offers it as a button.
   */
  onNotice?: (message: string, fix?: string) => void;
  /**
   * The page looks broken without anyone asking: its script threw, or a
   * file it refers to didn't load. Reported once per render per problem.
   */
  onProblem?: (problem: PageProblem) => void;
  /** Whoever is using this editor, for the marks on their own edits while tracking. */
  self?: MarkAuthor;
}

/** Inline styles the editor can apply to a selection. */
export type InlineStyle = "strong" | "em" | "code";

const STYLE_TAGS: Record<InlineStyle, string[]> = { strong: ["strong", "b"], em: ["em", "i"], code: ["code"] };
const STYLE_MARKS: Record<InlineStyle, string> = { strong: "**", em: "*", code: "`" };

interface Analysis { units: M.Unit[]; html: string }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Scales the editor's timed behaviour (how long notes stay, how marks fade).
 * 1 for people; the tests set `window.__swTimescale` lower so they don't sit
 * through real seconds to check what happens after them.
 */
export const ms = (n: number) => n * ((globalThis as { __swTimescale?: number }).__swTimescale ?? 1);
const noHistory = () => Transaction.addToHistory.of(false);

/** The changed region between two texts, placing an ambiguous edit at `preferredPos` (CodeMirror's findDiff). */
function findDiff(a: string, b: string, preferredPos: number): { from: number; toA: number; toB: number } | null {
  const minLen = Math.min(a.length, b.length);
  let from = 0;
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++;
  if (from == minLen && a.length == b.length) return null;
  let toA = a.length, toB = b.length;
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB--; }
  if (toA < from && a.length < b.length) {
    const move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0;
    from -= move; toB = from + (toB - toA); toA = from;
  } else if (toB < from) {
    const move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0;
    from -= move; toA = from + (toA - toB); toB = from;
  }
  return { from, toA, toB };
}
const BLOCK_SPLIT = new Set(["p", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "blockquote", "figcaption", "section", "article", "aside", "header", "footer", "nav", "main", "address", "summary", "span", "label", "legend"]);
const HEADING = /^h[1-6]$/;

/**
 * DOM text equals source text, taking the browser's no-break spaces as
 * spaces: when it types natively, Chrome keeps a trailing space visible by
 * storing it as U+00A0 and turns it back into a space once more text follows.
 */
const norm = (s: string) => s.replace(/\u00a0/g, " ");
const same = (a: string, b: string) => a == b || norm(a) == norm(b);

/**
 * How a unit's text is written into the DOM. Under normal white-space a
 * space at the end of a block, or the second of two spaces, collapses, and
 * the caret has no visible place after it. Browsers solve this in their own
 * editing by storing such spaces as U+00A0; we do the same, in the DOM only.
 * Whitespace next to a newline is the page's pretty-printing and is left
 * alone, so it still collapses to one space as the page intends.
 */
function balanceWhitespace(text: string): string {
  let out = text.replace(/(?<![\s]) {2,}(?![\s])/g, (run) => run.replace(/ ( )/g, " \u00a0"));
  const lead = /^\s+/.exec(out);
  if (lead && lead[0].includes(" ")) out = out.replace(" ", "\u00a0");
  const trail = /\s+$/.exec(out);
  if (trail && trail[0].includes(" ")) {
    const i = out.lastIndexOf(" ");
    out = out.slice(0, i) + "\u00a0" + out.slice(i + 1);
  }
  return out;
}

const PAGE_STYLE = `
[data-sw-id][contenteditable] { caret-color: #3b7cf0; cursor: text; outline: none; }
[data-sw-id].sw-empty { min-height: 1lh; }
[data-sw-id].sw-locked { cursor: default; }
[data-sw-id] [contenteditable="false"] { cursor: default; }
[data-sw-id][contenteditable] a[href] { cursor: text; }
@keyframes sw-flash { from { background-color: rgba(59, 124, 240, 0.24); } to { background-color: rgba(59, 124, 240, 0); } }
[data-sw-id].sw-flash { animation: sw-flash 1.8s ease-out; border-radius: 3px; }
::highlight(sw-add-0) { background-color: rgba(34, 197, 94, 0.3); }
::highlight(sw-add-1) { background-color: rgba(34, 197, 94, 0.24); }
::highlight(sw-add-2) { background-color: rgba(34, 197, 94, 0.18); }
::highlight(sw-add-3) { background-color: rgba(34, 197, 94, 0.12); }
::highlight(sw-add-4) { background-color: rgba(34, 197, 94, 0.07); }
::highlight(sw-add-5) { background-color: rgba(34, 197, 94, 0.03); }
sw-peers { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none; }
sw-peer-sel { all: initial; position: absolute; border-radius: 2px; }
sw-peer { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--sw-peer); border-radius: 1px; }
sw-peer[data-agent] { background: repeating-linear-gradient(to bottom, var(--sw-peer) 0 3px, transparent 3px 5px); }
sw-peer-name {
  all: initial; position: absolute; left: -1px; bottom: 100%; margin-bottom: 1px; white-space: nowrap;
  font: 600 10.5px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff;
  background: var(--sw-peer); border-radius: 3px 3px 3px 0; padding: 0 5px; opacity: 0.92;
}
sw-marks { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
sw-del { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--sw-del, #e5484d); border-radius: 1px; pointer-events: auto; cursor: help; transition: opacity 120ms linear; }
sw-del::before { content: ""; position: absolute; top: -5px; left: -3px; border: 4px solid transparent; border-top-color: var(--sw-del, #e5484d); border-bottom: 0; }
sw-del::after { content: ""; position: absolute; inset: -6px -5px -2px; }
sw-tip {
  all: initial; display: none; position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%);
  font: 500 12px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #b42318;
  background: #fee4e2; border: 1px solid #fecdca; border-radius: 5px; padding: 1px 6px;
  text-decoration: line-through; text-decoration-color: rgba(180, 35, 24, 0.6);
  white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}
sw-del:hover sw-tip { display: block; }
sw-who { all: initial; display: inline-block; font: 600 11px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; margin-right: 6px; text-decoration: none; }
`;

type Mark = ({ kind: "add"; from: number; to: number } | { kind: "del"; pos: number; text: string }) & { level?: number; born?: number; author?: MarkAuthor | null };

/** Fill alphas for an added-text highlight as it fades (level 0 is fresh). */
const FADE = [0.3, 0.24, 0.18, 0.12, 0.07, 0.03];

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The marks for a set of changes: text they add that shows on the page, and
 * text they remove that showed (read from the units before and after, so
 * markup contributes nothing). Changes with neither are `unmarked`.
 */
function marksFor(changes: ChangeSet, oldUnits: M.Unit[], newUnits: M.Unit[], level: number, author: MarkAuthor | null = null) {
  const marks: Mark[] = [];
  const unmarked: { from: number; to: number }[] = [];
  let first: number | null = null;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const gone = toA > fromA ? textIn(oldUnits, fromA, toA).replace(/\s+/g, " ").trim() : "";
    const shown = toB > fromB && /\S/.test(textIn(newUnits, fromB, toB));
    if (shown) marks.push({ kind: "add", from: fromB, to: toB, level, author });
    if (gone) marks.push({ kind: "del", pos: fromB, text: gone, level, author });
    // A typed space (someone else typing, a keystroke at a time) is nothing to point at.
    if (!shown && !gone && toA == fromA && !/\S/.test(inserted.toString())) return;
    if (!shown && !gone) unmarked.push({ from: fromB, to: toB });
    else first ??= fromB;
  });
  return { marks, unmarked, first };
}

/**
 * The source with every text block cut out and whitespace collapsed: what
 * patching the text blocks can't update. Two versions of a document with the
 * same skeleton differ only in their text, which the page can show in place.
 */
function skeleton(src: string, units: M.Unit[]): string {
  let out = "", pos = 0;
  for (const u of units) { out += src.slice(pos, u.from) + "\u0000"; pos = u.to; }
  // Runs of blocks count as one, so adding a paragraph among paragraphs (which patching handles) isn't a change.
  return (out + src.slice(pos)).replace(/\s+/g, " ").replace(/\u0000( ?\u0000)+/g, "\u0000");
}

/** The rendered text of [from, to) of the source, as the units hold it (markup contributes nothing). */
function textIn(units: M.Unit[], from: number, to: number): string {
  let out = "";
  for (const u of units) {
    if (u.contentTo < from || u.contentFrom > to) continue;
    let unitText = "";
    for (const r of u.runs) {
      const s = Math.max(from, r.from), e = Math.min(to, r.to);
      if (s < e) unitText += r.text.slice(M.runOffset(r, s), M.runOffset(r, e));
    }
    if (unitText) out += (out ? " " : "") + unitText;
  }
  return out;
}

type RawProblem = { kind: "resource"; tag: string; url: string } | { kind: "script"; message: string; file: string; line: number };

/** A problem the page reported, in words, with a prompt for the agent to fix it. */
function describeProblem(raw: RawProblem, base: string): PageProblem | null {
  const local = (u: string) => { try { const url = new URL(u, location.origin + base); return url.origin == location.origin && url.pathname.startsWith(base) ? decodeURIComponent(url.pathname.slice(base.length)) : u; } catch { return u; } };
  if (raw.kind == "resource") {
    const what = raw.tag == "link" ? "stylesheet" : raw.tag == "script" ? "script" : raw.tag == "img" ? "image" : `file`;
    const name = local(raw.url);
    return {
      key: `resource:${name}`,
      message: `The page's ${what} “${name}” didn't load, so the page may not look or work as it should.`,
      fix: `The page refers to the ${what} “${name}”, but it fails to load in the browser. Find out why (a wrong path, a missing file) and fix it.`,
    };
  }
  if (/^Script error\.?$/.test(raw.message) && !raw.file) return null; // cross-origin, nothing to go on
  const where = raw.file && !/srcdoc/.test(raw.file) ? ` (${local(raw.file)}${raw.line ? `, line ${raw.line}` : ""})` : raw.line ? ` (the page's inline script, line ${raw.line})` : "";
  return {
    key: `script:${raw.message}`,
    message: `The page's script hit an error: ${raw.message}${where}. Parts of the page may not work.`,
    fix: `The page's script throws an error in the browser: “${raw.message}”${where}. Find the cause and fix it.`,
  };
}

export class PageEditor {
  state: EditorState;
  readonly kind: Kind;
  private frame: HTMLIFrameElement;
  private units: M.Unit[] = [];
  private els: (Element | undefined)[] = [];
  private doc: Document | null = null;
  private cleanup: (() => void)[] = [];
  private composing = false;
  private writingSelection = false;
  private renderToken = 0;
  private decoderCache = new Map<string, string>();
  private decoderBox = document.createElement("textarea");
  private listeners: ((u: PageUpdate) => void)[] = [];
  /** Set while a full render is in flight; edits wait for it. */
  private rendering = false;
  /** Source ranges to flash once the render in flight is done. */
  private pendingFlash: { from: number; to: number }[] = [];
  /**
   * What changed, drawn over the page without touching its text: added text
   * gets a green highlight, removed text a red notch (hover it for the text).
   * With tracking off, edits from elsewhere are marked briefly and fade
   * (`level` counts up the fade); with tracking on, the marks are a diff of
   * the document against `tracking.baseline`, whoever made the changes.
   */
  private marks: Mark[] = [];
  /**
   * While tracking, who wrote what: every insertion and deletion since it
   * started, with its author, mapped through later changes. The tracked diff
   * is computed from the text alone; its marks take their authors from here.
   */
  private tracking: { baseline: string; units: M.Unit[]; adds: { from: number; to: number; author: MarkAuthor | null }[]; dels: { pos: number; author: MarkAuthor | null }[] } | null = null;
  private overlay: HTMLElement | null = null;
  /** Other people's carets and selections, drawn over the page like the marks. */
  private peers: Peer[] = [];
  private peerLayer: HTMLElement | null = null;
  /** Highlight names registered for each author colour. */
  private authorStyles = new Map<string, number>();
  private markObserver: ResizeObserver | null = null;
  private paintQueued = false;
  private diffQueued = false;
  private fadeTimer = 0;
  /**
   * Set when an edit from elsewhere changed something outside the text
   * blocks (a diagram, a script, the page's structure) that patching can't
   * show; the shell decides when to render again (see `stale`).
   */
  private staleSince: string | null = null;
  /** Why each locked unit (see `verify`) can't be edited, for when someone clicks it. */
  private lockReasons = new WeakMap<Element, { message: string; fix?: string }>();
  private revealPending: number | null = null;

  constructor(readonly config: PageEditorConfig) {
    this.state = config.state;
    this.kind = config.kind;
    this.frame = config.frame;
    if (config.onUpdate) this.listeners.push(config.onUpdate);
    this.render();
  }

  // ------------------------------------------------------------ analysis

  private decoder: M.EntityDecoder = (ref) => {
    let v = this.decoderCache.get(ref);
    if (v == null) {
      this.decoderBox.innerHTML = ref;
      v = this.decoderBox.value;
      this.decoderCache.set(ref, v);
    }
    return v;
  };

  private analyze(src: string): Analysis {
    if (this.kind == "html") {
      const a = M.analyzeHtml(src, this.decoder);
      return { units: a.units, html: this.injectHead(M.stamp(src, a.units)) };
    }
    const a = analyzeMarkdown(src, this.state.selection.main.head);
    const head = `${PROBLEM_WATCH}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="${this.config.base}">${this.config.markdownHead ?? ""}<style>${PAGE_STYLE}</style>`;
    return { units: a.units, html: `<!doctype html><html><head>${head}</head><body><article class="prose" id="sw-article">${a.html}</article></body></html>` };
  }

  private injectHead(html: string): string {
    const inject = `${PROBLEM_WATCH}<base href="${this.config.base}"><style data-sw>${PAGE_STYLE}</style>`;
    const m = /<head(\s[^>]*)?>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + inject + html.slice(m.index + m[0].length);
    const h = /<html(\s[^>]*)?>/i.exec(html);
    if (h) return html.slice(0, h.index + h[0].length) + `<head>${inject}</head>` + html.slice(h.index + h[0].length);
    return `<head>${inject}</head>` + html;
  }

  /** The whole page as it renders now, latest edits included (for view_page's capture). */
  renderedHtml(): string { return this.analyze(this.state.doc.toString()).html; }

  /** The page's title: its <title>, else its first heading. */
  title(): string {
    const t = this.doc?.title?.trim();
    if (t) return t;
    for (const u of this.units) if (HEADING.test(u.tag) || u.tag == "p") { const s = u.runs.filter((r) => r.editable).map((r) => r.text).join("").trim(); if (s) return s; }
    return "";
  }

  // ------------------------------------------------------------ rendering

  /** Renders the whole page from the current source. */
  render(): void {
    this.staleSince = null;
    // A render must not take focus from elsewhere (the agent's input, say); it puts the caret back only if the page had it.
    const hadFocus = this.hasFocus;
    const token = ++this.renderToken;
    this.rendering = true;
    this.unbind();
    const src = this.state.doc.toString();
    const a = this.analyze(src);
    this.units = a.units;
    const onLoad = () => {
      if (token != this.renderToken) return;
      this.frame.removeEventListener("load", onLoad);
      this.doc = this.frame.contentDocument!;
      this.watchProblems();
      this.collectEls();
      this.bind();
      this.rendering = false;
      for (const el of this.els) if (el) this.prepareUnit(el);
      // Verified, never guessed: a unit whose DOM text doesn't match the
      // source is locked now, not when someone tries to type into it.
      for (const u of this.units) this.verify(u);
      this.updateEmpty();
      // Edits that arrived while the page loaded (someone else typing) are patched in now.
      const now = this.state.doc.toString();
      if (now != src) this.applyChanges({ changes: changesBetween(src, now) }, this.units, src);
      // Start with the caret in the manuscript, like a document that opens ready to type.
      const head = this.state.selection.main.head;
      const first = this.units.find((u) => u.runs.some((r) => r.editable && /\S/.test(r.text))) ?? this.units[0];
      if (first && !M.unitAt(this.units, head)) {
        this.state = this.state.update({ selection: { anchor: M.textStart(first) }, annotations: noHistory() }).state;
      }
      if (hadFocus) this.syncDOMSelection(true);
      this.notify({ docChanged: false, selectionSet: false, rendered: true, changes: null, remote: false });
      if (this.pendingFlash.length) { this.flash(this.pendingFlash); this.pendingFlash = []; }
      this.markObserver?.disconnect();
      // The old document's layers are gone with it (though they'd still say isConnected).
      this.overlay = null;
      this.peerLayer = null;
      const RO = (this.frame.contentWindow as (Window & typeof globalThis) | null)?.ResizeObserver;
      if (RO) { this.markObserver = new RO(() => this.queuePaint()); this.markObserver.observe(this.doc.documentElement); }
      this.paintMarks();
    };
    this.frame.addEventListener("load", onLoad);
    this.frame.srcdoc = a.html;
  }

  /** Hands the page's problems (see PROBLEM_WATCH) to the shell, as they happen. */
  private watchProblems(): void {
    const win = this.frame.contentWindow as (Window & { __swProblems?: RawProblem[]; __swReport?: (p: RawProblem) => void }) | null;
    if (!win) return;
    const seen = new Set<string>();
    const report = (raw: RawProblem) => {
      const p = describeProblem(raw, this.config.base);
      if (!p || seen.has(p.key)) return;
      seen.add(p.key);
      this.config.onProblem?.(p);
    };
    win.__swReport = report;
    for (const raw of win.__swProblems ?? []) report(raw);
  }

  private collectEls(): void {
    const doc = this.doc!;
    this.els = [];
    for (const u of this.units) this.els[u.id] = doc.querySelector(`[data-sw-id="${u.id}"]`) ?? undefined;
  }

  /** A unit element is its own editing host; anything atomic inside it stays a normal widget. */
  private prepareUnit(el: Element): void {
    if (!el.classList.contains("sw-locked")) el.setAttribute("contenteditable", "true");
    // No spellcheck: these are technical documents, full of names a dictionary flags.
    el.setAttribute("spellcheck", "false");
    for (const atom of el.querySelectorAll("*")) if (M.ATOMIC.has(atom.localName)) atom.setAttribute("contenteditable", "false");
  }

  private updateEmpty(changed?: Set<number>): void {
    for (const u of this.units) {
      if (changed && !changed.has(u.id)) continue;
      const el = this.els[u.id];
      if (!el) continue;
      const empty = !u.runs.some((r) => r.editable && /\S/.test(r.text)) && !el.querySelector("img,svg,video,canvas,input");
      el.classList.toggle("sw-empty", empty);
    }
  }

  // ------------------------------------------------------------ DOM <-> positions

  private textNodes(el: Element): Text[] {
    const out: Text[] = [];
    const w = this.doc!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  }

  /** The unit's DOM text still matches the source; otherwise lock it. */
  private verify(unit: M.Unit): boolean {
    const el = this.els[unit.id];
    if (!el || el.classList.contains("sw-locked")) return false;
    const nodes = this.textNodes(el);
    const ok = nodes.length == unit.runs.length && nodes.every((n, i) => same(n.nodeValue!, unit.runs[i].text));
    if (!ok) {
      el.classList.add("sw-locked");
      el.setAttribute("contenteditable", "false");
      this.lockReasons.set(el, this.whyLocked(unit));
    }
    return ok;
  }

  /**
   * Why a unit's text can't be mapped to the source, in words someone can
   * act on, and when the document is at fault, a prompt for the agent to
   * fix it. Worked out from the unit's own source, so it names the actual
   * problem (the stray tag, the line).
   */
  private whyLocked(unit: M.Unit): { message: string; fix?: string } {
    const src = this.state.doc.sliceString(unit.contentFrom, unit.contentTo);
    const what = unit.tag == "p" ? "paragraph" : HEADING.test(unit.tag) ? "heading" : unit.tag == "li" ? "list item" : `<${unit.tag}>`;
    const text = unit.runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
    const quote = text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text;
    const line = this.state.doc.lineAt(unit.from).number;
    // An end tag with nothing open to close: the browser drops it, so the
    // page's text no longer lines up with the file's.
    const open: string[] = [];
    for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
      const [, close, name, selfClose] = m, tag = name.toLowerCase();
      if (selfClose || /^(br|img|wbr|hr|input|meta|link|source|area|col|embed|track)$/.test(tag)) continue;
      if (!close) open.push(tag);
      else if (open.at(-1) == tag) open.pop();
      else return {
        message: `This ${what} can't be edited: its HTML has a stray </${tag}> that the browser ignores, so the page's text no longer lines up with the file.`,
        fix: `The ${what} “${quote}” (line ${line}) has a stray </${tag}> in its HTML, which the browser ignores, so I can't edit it on the page. Fix the markup so it's well-formed, keeping its text exactly as it is.`,
      };
    }
    return { message: `This text was changed by the page's script after it loaded, so it can't be edited here.` };
  }

  private unitOf(node: Node): M.Unit | null {
    const el = (node.nodeType == 1 ? (node as Element) : node.parentElement)?.closest("[data-sw-id]");
    if (!el) return null;
    const u = this.units[+el.getAttribute("data-sw-id")!];
    return u && this.els[u.id] == el ? u : null;
  }

  /** Source position for a DOM point inside a unit, or null. */
  posFromDOM(node: Node, offset: number): number | null {
    const u = this.unitOf(node);
    if (!u) return null;
    const el = this.els[u.id]!;
    const nodes = this.textNodes(el);
    if (nodes.length != u.runs.length) return null;
    if (node.nodeType == 3) {
      const i = nodes.indexOf(node as Text);
      if (i < 0) return null;
      return M.runPos(u.runs[i], offset);
    }
    const range = this.doc!.createRange();
    range.setStart(el, 0);
    try { range.setEnd(node, offset); } catch { return u.contentFrom; }
    let len = range.toString().length;
    for (let i = 0; i < nodes.length; i++) {
      const l = nodes[i].nodeValue!.length;
      if (len <= l) return M.runPos(u.runs[i], len);
      len -= l;
    }
    return u.runs.length ? u.runs[u.runs.length - 1].to : u.contentTo;
  }

  /**
   * Whether two carets are the same spot on the page: only markup between
   * them. The DOM can't put a caret after a closing tag at the end of a line
   * (it lands inside the bold text instead), so when the model's caret is
   * deliberately outside, as after a Markdown shortcut, the model's wins.
   */
  private sameSpot(a: SelectionRange, b: SelectionRange): boolean {
    if (!a.empty || !b.empty || a.head == b.head) return false;
    const from = Math.min(a.head, b.head), to = Math.max(a.head, b.head);
    const u = M.unitAt(this.units, from);
    if (!u || u != M.unitAt(this.units, to)) return false;
    const between = this.state.doc.sliceString(from, to);
    return !/\n|<br|<img/i.test(between) && textIn([u], from, to) == "";
  }

  /** A DOM point for a source position (side < 0 prefers the text before a boundary). */
  domAtPos(pos: number, side = 1): { node: Node; offset: number } | null {
    const u = M.unitAt(this.units, pos);
    if (!u) return null;
    const el = this.els[u.id];
    if (!el) return null;
    const nodes = this.textNodes(el);
    if (!u.runs.length || nodes.length != u.runs.length) return { node: el, offset: 0 };
    let i = M.runAt(u, pos, side < 0);
    if (i < 0) {
      i = u.runs.findIndex((r) => r.from >= pos);
      if (i < 0) { const last = u.runs.length - 1; return { node: nodes[last], offset: nodes[last].nodeValue!.length }; }
      return { node: nodes[i], offset: 0 };
    }
    return { node: nodes[i], offset: M.runOffset(u.runs[i], pos) };
  }

  /** The DOM selection as a model selection, if it lies in manuscript. */
  readSelection(): EditorSelection | null {
    const sel = this.doc?.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    const anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    const head = this.posFromDOM(sel.focusNode, sel.focusOffset);
    if (anchor == null || head == null) return null;
    return EditorSelection.single(anchor, head);
  }

  /** The unit element that has focus, if any. */
  private get activeUnit(): Element | null {
    const el = this.doc?.activeElement;
    return el && el.hasAttribute("data-sw-id") ? el : null;
  }

  /** Makes the DOM selection match the model's, focusing the unit that holds it. */
  syncDOMSelection(force = false): void {
    const doc = this.doc;
    if (!doc || this.composing) return;
    if (!force && !this.activeUnit) return;
    const main = this.state.selection.main;
    const anchor = this.domAtPos(main.anchor, main.empty ? main.assoc || 1 : main.anchor < main.head ? 1 : -1);
    if (!anchor) return;
    const head = main.empty ? anchor : this.domAtPos(main.head, main.head > main.anchor ? -1 : 1) ?? anchor;
    const sel = doc.getSelection();
    if (!sel) return;
    const host = (anchor.node.nodeType == 1 ? (anchor.node as Element) : anchor.node.parentElement)?.closest("[data-sw-id]") as HTMLElement | null;
    this.writingSelection = true;
    try {
      if (host && host != doc.activeElement) host.focus({ preventScroll: true });
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch { /* ignore */ }
    this.writingSelection = false;
  }

  focus(): void {
    this.frame.contentWindow?.focus();
    this.syncDOMSelection(true);
  }

  get hasFocus(): boolean {
    return !!this.doc && this.doc.hasFocus() && !!this.activeUnit;
  }

  /** Screen rectangle (in the frame's coordinates) of the caret at a position. */
  coordsAtPos(pos: number, side = 1): DOMRect | null {
    const at = this.domAtPos(pos, side);
    if (!at) return null;
    const range = this.doc!.createRange();
    try {
      range.setStart(at.node, at.offset);
      range.setEnd(at.node, at.offset);
    } catch { return null; }
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    return (at.node.nodeType == 1 ? (at.node as Element) : at.node.parentElement!).getBoundingClientRect();
  }

  // ------------------------------------------------------------ events

  private bind(): void {
    const doc = this.doc!;
    const on = <K extends keyof DocumentEventMap>(type: K, f: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      doc.addEventListener(type, f as EventListener, opts);
      this.cleanup.push(() => doc.removeEventListener(type, f as EventListener, opts));
    };
    on("beforeinput", (e) => this.beforeinput(e as InputEvent));
    on("keydown", (e) => this.keydown(e));
    on("compositionstart", (e) => { if (this.ours(e)) this.composing = true; });
    on("compositionend", (e) => { if (this.ours(e)) this.compositionend(); });
    on("selectionchange", () => this.selectionchange());
    on("paste", (e) => { if (this.ours(e)) this.paste(e); });
    on("cut", (e) => { if (this.ours(e)) this.cut(e); });
    on("dragstart", (e) => { if (this.ours(e)) e.preventDefault(); });
    on("drop", (e) => { if (this.ours(e)) e.preventDefault(); });
    on("mousedown", (e) => this.mousedown(e));
    on("mousemove", (e) => this.config.onPointer?.(e), { passive: true });
  }

  private unbind(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
  }

  destroy(): void {
    this.renderToken++;
    this.unbind();
  }

  private notify(u: Omit<PageUpdate, "state">): void {
    for (const l of this.listeners) l({ state: this.state, ...u });
  }

  /** Whether an event comes from manuscript rather than from a widget, input or plain page. */
  private ours(e: Event): boolean {
    const t = e.target as Node | null;
    if (!t) return false;
    const el = t.nodeType == 1 ? (t as Element) : t.parentElement;
    if (!el) return false;
    if (el.closest('[contenteditable="false"], input, textarea, select')) return false;
    return !!el.closest("[data-sw-id]");
  }

  private mousedown(e: MouseEvent): void {
    // A locked unit takes no caret; say why instead of doing nothing.
    const locked = (e.target as Element).closest?.(".sw-locked");
    if (locked && !(e.target as Element).closest('button, a[href], input, textarea, select, [contenteditable="true"]')) {
      const why = this.lockReasons.get(locked);
      if (why) this.config.onNotice?.(why.message, why.fix);
    }
    // Inside manuscript the browser doesn't follow links; Cmd-click does.
    if (!this.ours(e)) return;
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      window.open(a.href, "_blank", "noopener");
    }
  }

  private selectionchange(): void {
    if (this.writingSelection || this.composing || !this.doc) return;
    const sel = this.readSelection();
    if (!sel) return;
    const main = this.state.selection.main;
    if (sel.main.anchor == main.anchor && sel.main.head == main.head) return;
    if (this.sameSpot(sel.main, main)) return;
    this.state = this.state.update({ selection: sel, userEvent: "select" }).state;
    this.notify({ docChanged: false, selectionSet: true, rendered: false, changes: null, remote: false });
  }

  private keydown(e: KeyboardEvent): void {
    if (this.composing || e.isComposing) return;
    // App shortcuts work anywhere in the page; editing keys only in manuscript.
    if (this.config.onKey?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!this.activeUnit || !this.ours(e)) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let handled = false;
    if (key == "enter" && !mod && !e.altKey) handled = this.enter(e.shiftKey);
    else if (key.startsWith("arrow")) handled = this.arrow(e);
    else if (mod && !e.altKey && key == "z") handled = e.shiftKey ? this.redo() : this.undo();
    else if (mod && !e.altKey && !e.shiftKey && key == "y" && !isMac) handled = this.redo();
    else if (mod && !e.altKey && !e.shiftKey && key == "b") handled = this.styleKey("strong");
    else if (mod && !e.altKey && !e.shiftKey && key == "i") handled = this.styleKey("em");
    else if (mod && !e.altKey && !e.shiftKey && key == "e") handled = this.styleKey("code");
    else if (mod && !e.altKey && !e.shiftKey && key == "a") handled = this.selectAll();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Arrow keys at a unit's edge move the caret into the neighbouring unit, keeping the column. */
  private arrow(e: KeyboardEvent): boolean {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    const sel = this.currentSelection();
    if (!sel.empty) return false;
    const u = M.unitAt(this.units, sel.head);
    if (!u) return false;
    const src = this.state.doc.toString();
    const first = (x: M.Unit) => (x.runs.length ? x.runs[0].from : x.contentFrom);
    const last = (x: M.Unit) => (x.runs.length ? x.runs[x.runs.length - 1].to : x.contentTo);
    const blank = (a: number, b: number) => /^\s*$/.test(src.slice(Math.min(a, b), Math.max(a, b)));
    const go = (pos: number) => { this.dispatch({ selection: { anchor: pos }, userEvent: "select", scrollIntoView: true }); return true; };
    if (e.key == "ArrowRight" || e.key == "ArrowLeft") {
      const forward = e.key == "ArrowRight";
      if (!blank(sel.head, forward ? last(u) : first(u))) return false;
      const next = this.units[u.id + (forward ? 1 : -1)];
      if (!next) return false;
      return go(forward ? first(next) : last(next));
    }
    const down = e.key == "ArrowDown";
    const caret = this.coordsAtPos(sel.head), el = this.els[u.id];
    if (!caret || !el) return false;
    const r = el.getBoundingClientRect(), cs = this.doc!.defaultView!.getComputedStyle(el);
    const h = caret.height || 16;
    const onEdge = down ? caret.bottom + h * 0.6 >= r.bottom - parseFloat(cs.paddingBottom) : caret.top - h * 0.6 <= r.top + parseFloat(cs.paddingTop);
    if (!onEdge) return false;
    const next = this.units[u.id + (down ? 1 : -1)], nel = next && this.els[next.id];
    if (!next || !nel) return false;
    const nr = nel.getBoundingClientRect(), ncs = this.doc!.defaultView!.getComputedStyle(nel);
    const y = down ? nr.top + parseFloat(ncs.paddingTop) + h / 2 : nr.bottom - parseFloat(ncs.paddingBottom) - h / 2;
    const range = this.doc!.caretRangeFromPoint?.(caret.left, y);
    let pos: number | null = null;
    if (range && nel.contains(range.startContainer)) pos = this.posFromDOM(range.startContainer, range.startOffset);
    return go(pos ?? (down ? first(next) : last(next)));
  }

  private beforeinput(e: InputEvent): void {
    if (!this.ours(e)) return;
    const type = e.inputType;
    if (type == "insertCompositionText" || (this.composing && e.isComposing)) return;
    if (this.rendering) { e.preventDefault(); return; }
    // Never fall back to the model's caret when the browser's can't be
    // mapped: that caret is somewhere else, maybe the top of the page, and
    // the edit would land there.
    if (!type.startsWith("history") && !this.readSelection()) {
      e.preventDefault();
      const u = this.unitOf(e.target as Node);
      const el = u ? this.els[u.id] : null;
      const why = el ? this.lockReasons.get(el) : undefined;
      if (u && el && !this.verify(u)) this.config.onNotice?.(why?.message ?? "This text can't be edited here.", why?.fix);
      else this.config.onNotice?.("Can't tell where the caret is in the file, so that wasn't typed. Click into the text again.");
      return;
    }
    switch (type) {
      case "historyUndo": e.preventDefault(); this.undo(); return;
      case "historyRedo": e.preventDefault(); this.redo(); return;
      case "insertText":
      case "insertReplacementText":
      case "insertFromYank": {
        e.preventDefault();
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        this.insertText(text, this.targetRange(e));
        return;
      }
      case "insertParagraph": e.preventDefault(); this.enter(false); return;
      case "insertLineBreak": e.preventDefault(); this.enter(true); return;
      case "deleteContentBackward": e.preventDefault(); this.deleteChar(false); return;
      case "deleteContentForward": e.preventDefault(); this.deleteChar(true); return;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
      case "deleteEntireSoftLine":
      case "deleteContent":
      case "deleteByCut": {
        e.preventDefault();
        const r = this.targetRange(e);
        if (r && r.from < r.to) this.replaceRange(r.from, r.to, "", /Forward/.test(type) ? "delete.forward" : "delete.backward");
        else this.deleteChar(/Forward/.test(type));
        return;
      }
      default:
        e.preventDefault();
    }
  }

  /** The browser's target range for an input event, mapped to source, clamped to one run. */
  private targetRange(e: InputEvent): { from: number; to: number } | null {
    const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
    if (!ranges.length) return null;
    const r = ranges[0];
    const from = this.posFromDOM(r.startContainer, r.startOffset);
    const to = this.posFromDOM(r.endContainer, r.endOffset);
    if (from == null || to == null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  private compositionend(): void {
    this.composing = false;
    const node = this.doc?.getSelection()?.anchorNode;
    const u = node ? this.unitOf(node) : null;
    if (u) this.readBack(u, "input.type.compose");
  }

  /** Folds what the browser changed in a unit's text into the model. */
  private readBack(u: M.Unit, userEvent: string): void {
    const el = this.els[u.id];
    if (!el) return;
    const nodes = this.textNodes(el);
    if (nodes.length != u.runs.length) { this.render(); return; }
    const before = u.runs.map((r) => r.text).join("");
    const after = norm(nodes.map((n) => n.nodeValue!).join(""));
    // Offsets in the concatenated text -> source positions.
    const starts: number[] = [];
    let acc = 0;
    for (const r of u.runs) { starts.push(acc); acc += r.text.length; }
    const toPos = (k: number) => {
      let i = u.runs.length - 1;
      while (i > 0 && starts[i] > k) i--;
      return i < 0 ? u.contentFrom : M.runPos(u.runs[i], k - starts[i]);
    };
    const hint = this.state.selection.main.from;
    let hintK = 0;
    for (let i = 0; i < u.runs.length; i++) if (u.runs[i].from <= hint && hint <= u.runs[i].to) hintK = starts[i] + M.runOffset(u.runs[i], hint);
    const diff = findDiff(norm(before), after, hintK);
    if (!diff) { this.syncDOMSelection(true); return; }
    const from = toPos(diff.from), to = toPos(diff.toA);
    const insert = this.escape(u, from, after.slice(diff.from, diff.toB));
    this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent });
  }

  private paste(e: ClipboardEvent): void {
    e.preventDefault();
    let text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    text = text.replace(/\r\n?/g, "\n");
    const sel = this.currentSelection();
    const u = sel ? M.unitAt(this.units, sel.from) : null;
    if (u && u.tag != "pre") text = text.replace(/\s*\n\s*/g, " ");
    this.insertText(text, null, "input.paste");
  }

  private cut(e: ClipboardEvent): void {
    e.preventDefault();
    const sel = this.currentSelection();
    if (!sel || sel.empty) return;
    const text = this.doc!.getSelection()?.toString() ?? "";
    e.clipboardData?.setData("text/plain", text);
    this.replaceRange(sel.from, sel.to, "", "delete.cut");
  }

  // ------------------------------------------------------------ editing

  /**
   * The selection an edit applies to: the DOM's, which is ahead of the model
   * until selectionchange fires. Recording it first keeps the undo history's
   * grouping right (a caret move separates two typing runs).
   */
  private currentSelection() {
    const fromDOM = this.readSelection();
    if (!fromDOM) return this.state.selection.main;
    const main = this.state.selection.main;
    if (this.sameSpot(fromDOM.main, main)) return main;
    if (fromDOM.main.anchor != main.anchor || fromDOM.main.head != main.head) {
      this.state = this.state.update({ selection: fromDOM, userEvent: "select" }).state;
    }
    return fromDOM.main;
  }

  private dispatch(spec: TransactionSpec | Transaction): void {
    const tr = spec instanceof Transaction ? spec : this.state.update(spec);
    const oldUnits = this.units, oldSrc = this.state.doc.toString();
    this.state = tr.state;
    if (tr.docChanged) {
      this.mapMarks(tr.changes);
      this.recordAuthorship(tr.changes, this.config.self ?? null);
      this.applyChanges(tr, oldUnits, oldSrc);
      if (this.tracking) this.queueDiff();
      else this.paintMarks();
    }
    this.syncDOMSelection(true);
    if (tr.docChanged || tr.scrollIntoView) this.scrollCaretIntoView();
    this.notify({ docChanged: tr.docChanged, selectionSet: !!tr.selection, rendered: false, changes: tr.docChanged ? tr.changes : null, remote: false });
  }

  private scrollCaretIntoView(): void {
    const win = this.frame.contentWindow;
    if (!win) return;
    const r = this.coordsAtPos(this.state.selection.main.head);
    if (!r) return;
    const margin = Math.round(win.innerHeight * 0.25);
    if (r.top < 80) win.scrollBy(0, r.top - 80);
    else if (r.bottom > win.innerHeight - margin) win.scrollBy(0, r.bottom - (win.innerHeight - margin));
  }

  /** Text typed into the source at `pos`, escaped for the format. */
  private escape(u: M.Unit, pos: number, text: string): string {
    if (this.kind == "html") return u.tag == "pre" || u.tag == "textarea" ? M.escapeHtmlText(text) : M.escapeHtmlText(text);
    if (u.tag == "pre") return text;
    const src = this.state.doc.toString();
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1 == pos || pos == u.contentFrom;
    return escapeMarkdownText(text, lineStart, u.tag == "td" || u.tag == "th");
  }

  private editableAt(u: M.Unit, pos: number): boolean {
    const i = M.runAt(u, pos);
    return i < 0 || u.runs[i].editable;
  }

  insertText(text: string, range: { from: number; to: number } | null, userEvent = "input.type"): boolean {
    const sel = this.currentSelection();
    // The browser's target range is a DOM caret; if it's the same spot as the model's, the model's wins (see sameSpot).
    if (range && range.from == range.to && this.sameSpot(EditorSelection.cursor(range.from), sel)) range = null;
    const from = range ? range.from : sel.from, to = range ? range.to : sel.to;
    const done = this.replaceRange(from, to, text, userEvent);
    if (done && userEvent == "input.type" && (text == "*" || text == "_" || text == "`")) this.inputRule(this.state.selection.main.head);
    if (done && userEvent == "input.type" && text == " ") this.blockRule(this.state.selection.main.head);
    return done;
  }

  /**
   * Replaces [from, to) of the manuscript with typed text. Within one unit
   * that is a splice; across units the inline elements open at each end are
   * closed and reopened so the joined paragraph stays well-formed, and the
   * join only happens when nothing but whitespace separates the units.
   */
  replaceRange(from: number, to: number, text: string, userEvent: string): boolean {
    const a = M.unitAt(this.units, from), b = M.unitAt(this.units, to);
    if (!a || !b || !this.verify(a) || (a != b && !this.verify(b))) return false;
    if (!this.editableAt(a, from) || (text && !this.editableAt(a, from))) return false;
    const src = this.state.doc.toString();
    const insert = text ? this.escape(a, from, text) : "";
    if (a == b) {
      this.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true });
      return true;
    }
    // Across units.
    const joinable = this.units.slice(a.id, b.id).every((u, i) => M.adjacent(src, u, this.units[a.id + i + 1]));
    if (!joinable) {
      // Delete only the text inside the two end units; the middle stays.
      const changes = [{ from, to: M.textEnd(a), insert }, { from: M.textStart(b), to }];
      this.dispatch({ changes, selection: { anchor: from + insert.length }, userEvent, scrollIntoView: true });
      return true;
    }
    let glue = "";
    if (this.kind == "html") {
      glue = M.closeTags(M.inlineStackAt(src, a, from)) + M.openTags(M.inlineStackAt(src, b, to));
    }
    const head = this.kind == "html" ? M.closeTags(M.inlineStackAt(src, a, from)) : "";
    this.dispatch({ changes: { from, to, insert: head + insert + glue.slice(head.length) }, selection: { anchor: from + head.length + insert.length }, userEvent, scrollIntoView: true });
    return true;
  }

  /** Backspace / Delete with a caret. */
  private deleteChar(forward: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty) return this.replaceRange(sel.from, sel.to, "", forward ? "delete.forward" : "delete.backward");
    const pos = sel.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return false;
    const src = this.state.doc.toString();
    if (this.kind == "md" && !forward && deleteMarkupBackward(this.target())) return true;
    if (!forward && pos <= M.textStart(u)) return this.join(u.id - 1, u.id);
    if (forward && pos >= M.textEnd(u)) return this.join(u.id, u.id + 1);
    // One grapheme within the unit's text, skipping inline tag boundaries.
    let i = M.runAt(u, pos, !forward);
    if (i < 0) return false;
    let run = u.runs[i], k = M.runOffset(run, pos);
    if (!forward && k == 0) {
      do { i--; } while (i >= 0 && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i < 0) return false;
      run = u.runs[i];
      k = run.text.length;
    } else if (forward && k >= run.text.length) {
      do { i++; } while (i < u.runs.length && (!u.runs[i].text.length || !u.runs[i].editable));
      if (i >= u.runs.length) return false;
      run = u.runs[i];
      k = 0;
    }
    if (!run.editable) return false;
    const other = findClusterBreak(run.text, k, forward);
    const from = M.runPos(run, Math.min(k, other)), to = M.runPos(run, Math.max(k, other));
    if (from == to) return false;
    void src;
    this.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true });
    return true;
  }

  /** Joins two adjacent units: the source between their contents goes away. */
  private join(prevId: number, nextId: number): boolean {
    const prev = this.units[prevId], next = this.units[nextId];
    if (!prev || !next) return false;
    const src = this.state.doc.toString();
    if (this.kind == "html") {
      if (!M.adjacent(src, prev, next)) return false;
      if (!this.verify(prev) || !this.verify(next)) return false;
      const from = prev.contentTo, to = next.contentFrom;
      this.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.backward", scrollIntoView: true });
      return true;
    }
    // Markdown: the blank line (or list marker) between the blocks.
    const from = prev.contentTo, to = next.contentFrom;
    if (from >= to) return false;
    const between = src.slice(from, to);
    if (!/^[\s>*+-]*(\d+[.)])?\s*$/.test(between)) return false;
    this.dispatch({ changes: { from, to, insert: /\s$/.test(src.slice(from - 1, from)) ? "" : " " }, selection: { anchor: from }, userEvent: "delete.backward", scrollIntoView: true });
    return true;
  }

  /** Enter: split the block (Shift: a line break). */
  private enter(shift: boolean): boolean {
    const sel = this.currentSelection();
    if (!sel.empty && !this.replaceRange(sel.from, sel.to, "", "delete")) return false;
    const pos = this.state.selection.main.from;
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u) || !this.editableAt(u, pos)) return false;
    const src = this.state.doc.toString();
    const insertAt = (insert: string, caret: number) =>
      this.dispatch({ changes: { from: pos, insert }, selection: { anchor: caret }, userEvent: "input", scrollIntoView: true });
    if (u.tag == "pre") { insertAt("\n", pos + 1); return true; }
    if (this.kind == "md") {
      if (shift) { insertAt("  \n", pos + 3); return true; }
      if (u.tag == "td" || u.tag == "th") return false;
      // In a quote, a new paragraph needs a blank quoted line between.
      const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
      const quote = /^(\s*>\s?)+/.exec(src.slice(lineStart, pos));
      if (quote && !/^(\s*>\s?)+\s*([-+*]|\d+[.)])\s/.test(src.slice(lineStart, pos))) {
        const prefix = quote[0];
        const insert = "\n" + prefix.trimEnd() + "\n" + prefix;
        this.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: "input", scrollIntoView: true });
        return true;
      }
      if (insertNewlineContinueMarkup(this.target())) return true;
      // Drop trailing spaces before the break, like the Markdown command does.
      let from = pos;
      while (from > u.contentFrom && src[from - 1] == " ") from--;
      this.dispatch({ changes: { from, to: pos, insert: "\n\n" }, selection: { anchor: from + 2 }, userEvent: "input", scrollIntoView: true });
      return true;
    }
    if (shift || !BLOCK_SPLIT.has(u.tag)) { insertAt("<br>", pos + 4); return true; }
    // Enter in an empty last list item leaves the list: the item becomes a paragraph after it.
    const list = u.node?.parent;
    if (u.tag == "li" && list && (list.tag == "ul" || list.tag == "ol") && !/\S/.test(textIn([u], u.contentFrom, u.contentTo))
      && !list.children.some((c) => c.kind == "element" && c.from > u.from)) {
      const indent = M.lineIndent(src, list.from);
      const before = src.slice(0, u.from).replace(/\s*$/, "").length;
      const para = `\n${indent}<p></p>`;
      this.dispatch({ changes: [{ from: before, to: u.to }, { from: list.to, insert: para }], selection: { anchor: before + (list.to - u.to) + para.length - 4 }, userEvent: "input", scrollIntoView: true });
      return true;
    }
    const stack = M.inlineStackAt(src, u, pos);
    const atEnd = pos >= M.textEnd(u);
    const openTag = HEADING.test(u.tag) && atEnd ? "<p>" : src.slice(u.openFrom, u.openTo);
    const newTag = HEADING.test(u.tag) && atEnd ? "p" : u.tag;
    const indent = M.lineIndent(src, u.openFrom);
    if (newTag != u.tag) {
      // The end of a heading: close it as it was written and start a new, empty paragraph.
      const head = src.slice(pos, u.contentTo) + src.slice(u.contentTo, u.to) + `\n${indent}<${newTag}>`;
      this.dispatch({ changes: { from: pos, to: u.to, insert: head + `</${newTag}>` }, selection: { anchor: pos + head.length }, userEvent: "input", scrollIntoView: true });
      return true;
    }
    const insert = M.closeTags(stack) + `</${u.tag}>\n${indent}` + openTag + M.openTags(stack);
    insertAt(insert, pos + insert.length);
    return true;
  }

  /** A style shortcut: always handled, so the browser never applies its own; if it can't apply, say why. */
  private styleKey(style: InlineStyle): boolean {
    const why = this.toggleStyle(style);
    if (why) this.config.onNotice?.(why);
    return true;
  }

  /**
   * The selection as styleable stretches of text: one per text node it
   * covers (trimmed of surrounding spaces), so a selection may cross inline
   * elements and paragraphs. Or why it can't be styled.
   */
  private styleSegments(): { segments: { u: M.Unit; from: number; to: number }[]; why: string | null } {
    const sel = this.currentSelection();
    if (sel.empty) return { segments: [], why: "Select some text to style first." };
    const segments: { u: M.Unit; from: number; to: number }[] = [];
    let why: string | null = null;
    for (const u of this.units) {
      if (u.contentTo < sel.from || u.contentFrom > sel.to) continue;
      if (u.tag == "pre") { why = "Text in a code block can't be styled."; continue; }
      if (!this.verify(u)) { why = "That text is made by the page's script, so it can't be styled here."; continue; }
      for (const r of u.runs) {
        if (!r.editable) continue;
        let a = M.runOffset(r, Math.max(sel.from, r.from)), b = M.runOffset(r, Math.min(sel.to, r.to));
        while (a < b && /\s/.test(r.text[a])) a++;
        while (b > a && /\s/.test(r.text[b - 1])) b--;
        if (a < b) segments.push({ u, from: M.runPos(r, a), to: M.runPos(r, b) });
      }
    }
    return { segments, why: segments.length ? null : why ?? "There's no text in the selection to style." };
  }

  /** The element of one of `tags` that contains [from, to) of a unit, innermost first. */
  private enclosing(u: M.Unit, tags: string[], from: number, to: number): M.ElementNode | null {
    let node = u.node, found: M.ElementNode | null = null;
    while (node) {
      let next: M.ElementNode | undefined;
      for (const c of node.children) if (c.kind == "element" && !c.selfClosing && c.openTo <= from && to <= c.closeFrom) { next = c; break; }
      if (!next) break;
      if (tags.includes(next.tag)) found = next;
      node = next;
    }
    return found;
  }

  /** Why the selection can't be styled, or null if it can (for the toolbar's disabled state). */
  styleBlocker(): string | null { return this.styleSegments().why; }

  /** Whether the whole selection already has the style (for the toolbar's pressed state). */
  hasStyle(style: InlineStyle): boolean {
    const { segments } = this.styleSegments();
    if (!segments.length) return false;
    const src = this.state.doc.toString();
    if (this.kind == "md") {
      const m = STYLE_MARKS[style];
      return segments.every((g) => src.slice(g.from - m.length, g.from) == m && src.slice(g.to, g.to + m.length) == m && (style != "em" || (src[g.from - 2] != "*" && src[g.to + 1] != "*")));
    }
    return segments.every((g) => !!this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
  }

  /**
   * Bold, italic or code on the selection: removes the style if all of the
   * selection has it, else adds it to every stretch of text in the selection.
   * In HTML, removing it from part of an element splits the element. Returns
   * null when done, or why it couldn't be done.
   */
  toggleStyle(style: InlineStyle): string | null {
    const { segments, why } = this.styleSegments();
    if (why) return why;
    const src = this.state.doc.toString();
    const sel = this.state.selection.main;
    const changes: { from: number; to?: number; insert?: string }[] = [];
    const remove = this.hasStyle(style);
    if (this.kind == "md") {
      const m = STYLE_MARKS[style];
      for (const g of segments) {
        if (remove) changes.push({ from: g.from - m.length, to: g.from }, { from: g.to, to: g.to + m.length });
        else changes.push({ from: g.from, insert: m }, { from: g.to, insert: m });
      }
    } else if (remove) {
      // Group the stretches by the element that styles them, then take each element off them.
      const byEl = new Map<M.ElementNode, { from: number; to: number }>();
      for (const g of segments) {
        const el = this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to)!;
        const r = byEl.get(el);
        byEl.set(el, r ? { from: Math.min(r.from, g.from), to: Math.max(r.to, g.to) } : { from: g.from, to: g.to });
      }
      for (const [el, r] of byEl) {
        const open = src.slice(el.from, el.openTo), close = src.slice(el.closeFrom, el.to);
        const atStart = !/\S/.test(src.slice(el.openTo, r.from)), atEnd = !/\S/.test(src.slice(r.to, el.closeFrom));
        if (atStart && atEnd) changes.push({ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to });
        else if (atStart) changes.push({ from: el.from, to: el.openTo }, { from: r.to, insert: open });
        else if (atEnd) changes.push({ from: r.from, insert: close }, { from: el.closeFrom, to: el.to });
        else changes.push({ from: r.from, insert: close }, { from: r.to, insert: open });
      }
    } else {
      // One wrapper when the selection is a single well-formed stretch with
      // none of the style inside, else one per stretch that lacks it.
      const tag = STYLE_TAGS[style][0];
      const first = segments[0], last = segments[segments.length - 1];
      const lacking = segments.filter((g) => !this.enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
      const inside = new RegExp(`<(${STYLE_TAGS[style].join("|")})[\\s>]`, "i");
      if (first.u == last.u && lacking.length == segments.length && M.balanced(src, first.from, last.to) && !inside.test(src.slice(first.from, last.to))) {
        changes.push({ from: first.from, insert: `<${tag}>` }, { from: last.to, insert: `</${tag}>` });
      } else for (const g of lacking) changes.push({ from: g.from, insert: `<${tag}>` }, { from: g.to, insert: `</${tag}>` });
    }
    const set = this.state.changes(changes);
    this.dispatch({ changes: set, selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)), userEvent: "input.format" });
    return null;
  }

  /** The link the selection is in, if any (for the toolbar). */
  linkAt(): string | null {
    const sel = this.state.selection.main;
    const u = M.unitAt(this.units, sel.from);
    if (!u) return null;
    if (this.kind == "md") {
      const src = this.state.doc.toString();
      const m = /^\]\(([^)\s]*)\)/.exec(src.slice(sel.to));
      return m && src[sel.from - 1] == "[" ? m[1] : null;
    }
    const el = this.enclosing(u, ["a"], sel.from, sel.to);
    if (!el) return null;
    return /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(this.state.doc.sliceString(el.from, el.openTo))?.slice(1).find((x) => x != null) ?? "";
  }

  /** Links the selection to a URL, or unlinks it when the URL is empty. Returns null when done, or why not. */
  setLink(url: string): string | null {
    const { segments, why } = this.styleSegments();
    if (why) return why;
    const first = segments[0], last = segments[segments.length - 1];
    if (first.u != last.u) return "A link can't span paragraphs; select text within one.";
    const src = this.state.doc.toString();
    const sel = this.state.selection.main;
    let changes: { from: number; to?: number; insert?: string }[];
    if (this.kind == "md") {
      const linked = src[first.from - 1] == "[" && /^\]\([^)]*\)/.exec(src.slice(last.to));
      if (linked) changes = [{ from: first.from - 1, to: first.from }, { from: last.to, to: last.to + linked[0].length, insert: url ? `](${url})` : "" }];
      else if (!url) return null;
      else changes = [{ from: first.from, insert: "[" }, { from: last.to, insert: `](${url})` }];
    } else {
      const el = this.enclosing(first.u, ["a"], first.from, last.to);
      const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      if (el) {
        const open = src.slice(el.from, el.openTo);
        changes = url ? [{ from: el.from, to: el.openTo, insert: /href\s*=/i.test(open) ? open.replace(/href\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i, `href="${href}"`) : `<a href="${href}">` }]
          : [{ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to }];
      } else if (!url) return null;
      else if (!M.balanced(src, first.from, last.to)) return "That selection crosses other styling; select text inside it, or around all of it.";
      else changes = [{ from: first.from, insert: `<a href="${href}">` }, { from: last.to, insert: "</a>" }];
    }
    const set = this.state.changes(changes);
    this.dispatch({ changes: set, selection: EditorSelection.single(set.mapPos(sel.from, 1), set.mapPos(sel.to, -1)), userEvent: "input.format" });
    return null;
  }

  /** The selection's rectangle in the frame's coordinates, if there is a non-empty one in the page. */
  selectionRect(): DOMRect | null {
    const sel = this.doc?.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || this.state.selection.main.empty) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  /**
   * Markdown at the start of a paragraph: `# ` to `###### ` makes a heading
   * (or changes a heading's level), `- ` / `* ` a bullet list, `1. ` a
   * numbered list, `> ` a quote. In an HTML file the paragraph's element is
   * replaced; in Markdown the marks become real. Its own undo step, like the
   * inline shortcuts.
   */
  private blockRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || !this.verify(u)) return;
    const typed = textIn([u], u.contentFrom, pos).replace(/^\s+/, "");
    const m = /^(#{1,6}|[-*+]|\d{1,9}[.)]|>) $/.exec(typed);
    if (!m) return;
    const mark = m[1];
    const kind = mark[0] == "#" ? "heading" : mark == ">" ? "quote" : /\d/.test(mark) ? "ol" : "ul";
    const heading = /^h[1-6]$/.test(u.tag);
    if (u.tag != "p" && !(heading && kind == "heading")) return;
    const src = this.state.doc.toString();
    let change: { from: number; to: number; insert: string }, caret: number;
    if (this.kind == "md") {
      if (heading) return;
      const insert = kind == "heading" ? mark + " " : kind == "ul" ? "- " : kind == "quote" ? "> " : mark + " ";
      change = { from: u.contentFrom, to: pos, insert };
      caret = u.contentFrom + insert.length;
    } else {
      const rest = src.slice(pos, u.contentTo);
      const indent = M.lineIndent(src, u.from);
      let open: string, close: string;
      if (kind == "heading") { open = `<h${mark.length}>`; close = `</h${mark.length}>`; }
      else if (kind == "quote") { open = `<blockquote>\n${indent}  <p>`; close = `</p>\n${indent}</blockquote>`; }
      else {
        const list = kind == "ol" ? "ol" : "ul";
        const start = kind == "ol" && parseInt(mark) != 1 ? ` start="${parseInt(mark)}"` : "";
        open = `<${list}${start}>\n${indent}  <li>`; close = `</li>\n${indent}</${list}>`;
      }
      change = { from: u.from, to: u.to, insert: open + rest + close };
      caret = u.from + open.length;
    }
    this.dispatch({ changes: change, selection: { anchor: caret }, annotations: isolateHistory.of("full"), userEvent: "input.format", scrollIntoView: true });
  }

  /**
   * Markdown as you type: closing `**bold**`, `*italic*`, `_italic_` or
   * `` `code` `` turns the text into that style and the marks disappear
   * (in Markdown source they become real marks; in HTML, tags). It is its own
   * undo step, so ⌘Z brings back the literal characters.
   */
  private inputRule(pos: number): void {
    const u = M.unitAt(this.units, pos);
    if (!u || u.tag == "pre" || !this.verify(u)) return;
    const i = M.runAt(u, pos, true);
    if (i < 0 || !u.runs[i].editable) return;
    const run = u.runs[i], before = run.text.slice(0, M.runOffset(run, pos));
    const src = this.state.doc.toString();
    if (this.kind == "html" && M.inlineStackAt(src, u, pos).some((t) => t.tag == "code")) return;
    const rules: [RegExp, InlineStyle, number][] = [
      [/(^|[^*\\])\*\*(?=\S)([^*]*?\S)\*\*$/, "strong", 2],
      [/(^|[^_\\\p{L}\p{N}])__(?=\S)([^_]*?\S)__$/u, "strong", 2],
      [/(^|[^`\\])`([^`]+)`$/, "code", 1],
      [/(^|[^*\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*$/, "em", 1],
      [/(^|[^_\\\p{L}\p{N}])_(?=[^\s_])([^_]*?[^\s_\\])_$/u, "em", 1],
    ];
    for (const [re, style, n] of rules) {
      const m = re.exec(before);
      if (!m) continue;
      const open = m.index + m[1].length;
      const from = M.runPos(run, open);
      const inner = src.slice(M.runPos(run, open + n), M.runPos(run, open + n + m[2].length));
      const tag = STYLE_TAGS[style][0];
      const insert = this.kind == "md"
        ? (style == "code" ? `\`${m[2]}\`` : `${STYLE_MARKS[style]}${inner}${STYLE_MARKS[style]}`)
        : `<${tag}>${inner}</${tag}>`;
      this.dispatch({ changes: { from, to: pos, insert }, selection: { anchor: from + insert.length }, annotations: isolateHistory.of("full"), userEvent: "input.format" });
      return;
    }
  }

  private findInline(u: M.Unit, tag: string, pos: number): M.ElementNode | null {
    let node = u.node, found: M.ElementNode | null = null;
    while (node) {
      let next: M.ElementNode | undefined;
      for (const c of node.children) if (c.kind == "element" && !c.selfClosing && c.openTo <= pos && pos <= c.closeFrom) { next = c; break; }
      if (!next) break;
      if (next.tag == tag) found = next;
      node = next;
    }
    return found;
  }

  private selectAll(): boolean {
    const sel = this.currentSelection();
    const u = M.unitAt(this.units, sel.from);
    if (!u) return false;
    const whole = M.textStart(u) == sel.from && M.textEnd(u) == sel.to;
    const editable = this.units.filter((x) => x.runs.some((r) => r.editable && r.text));
    if (!editable.length) return true;
    const range = whole ? EditorSelection.single(M.textStart(editable[0]), M.textEnd(editable[editable.length - 1])) : EditorSelection.single(M.textStart(u), M.textEnd(u));
    this.dispatch({ selection: range, userEvent: "select" });
    return true;
  }

  undo(): boolean { return undo(this.target()); }
  redo(): boolean { return redo(this.target()); }

  /** Replaces the whole document (an edit made on disk); not undoable. */
  replaceAll(text: string): void {
    if (text == this.state.doc.toString()) return;
    this.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, annotations: noHistory(), userEvent: "external" });
  }

  /**
   * Applies changes made elsewhere (a collaborator, an agent, an edit on
   * disk) on top of the current document, and marks them (see `marks`) in
   * their author's colour; a change with no visible text (markup only)
   * flashes its paragraph instead. The caret stays where it was, and focus
   * stays wherever it is. They stay out of this editor's undo history, which
   * is mapped over them: ⌘Z only ever undoes your own edits.
   */
  applyExternal(changes: ChangeSet, author: MarkAuthor | null = null): void {
    if (changes.empty) return;
    const tr = this.state.update({ changes, annotations: noHistory(), userEvent: "external" });
    const oldUnits = this.units, oldSrc = this.state.doc.toString();
    this.state = tr.state;
    this.mapMarks(changes);
    this.recordAuthorship(changes, author);
    this.applyChanges(tr, oldUnits, oldSrc);
    if (this.hasFocus) this.syncDOMSelection(true);
    this.notify({ docChanged: true, selectionSet: false, rendered: false, changes, remote: true });
    if (this.staleSince == null && skeleton(oldSrc, oldUnits) != skeleton(this.state.doc.toString(), this.units)) this.staleSince = oldSrc;
    const found = marksFor(changes, oldUnits, this.units, 0, author);
    this.revealPending = found.first;
    if (!this.tracking) {
      this.marks.push(...found.marks);
      this.startFade();
    }
    if (this.rendering) { this.pendingFlash = found.unmarked; return; }
    if (found.unmarked.length) this.flash(found.unmarked, found.first == null);
    if (this.tracking) this.queueDiff();
    else this.paintMarks();
  }

  get isTracking(): boolean { return !!this.tracking; }

  /** Whether the page shows an older version of something outside the text blocks; render() fixes it. */
  get stale(): boolean { return this.staleSince != null; }

  /**
   * Track changes: on, every change from now on (yours, the agent's) stays
   * marked, as a diff against the document as it is now; off, the marks go.
   */
  setTracking(on: boolean): void {
    if (on == !!this.tracking) return;
    this.marks = [];
    this.tracking = on ? { baseline: this.state.doc.toString(), units: this.units, adds: [], dels: [] } : null;
    this.paintMarks();
  }

  /**
   * Records who made a change, while tracking (see `tracking`). The page's
   * own edits and `applyExternal`'s are recorded here; the shell records
   * the ones made in the source view.
   */
  recordAuthorship(changes: ChangeSet, author: MarkAuthor | null): void {
    const t = this.tracking;
    if (!t) return;
    t.adds = t.adds.flatMap((a) => {
      const from = changes.mapPos(a.from, 1), to = changes.mapPos(a.to, -1);
      return to > from ? [{ ...a, from, to }] : [];
    });
    for (const d of t.dels) d.pos = changes.mapPos(d.pos, -1);
    changes.iterChanges((fromA, toA, fromB, toB) => {
      if (toB > fromB) t.adds.push({ from: fromB, to: toB, author });
      if (toA > fromA) t.dels.push({ pos: fromB, author });
    });
    if (t.adds.length > 2000) t.adds.splice(0, t.adds.length - 2000);
    if (t.dels.length > 2000) t.dels.splice(0, t.dels.length - 2000);
  }

  /** The author of a tracked mark: whoever wrote most of an addition, or deleted nearest a deletion. */
  private trackedAuthor(m: Mark): MarkAuthor | null {
    const t = this.tracking!;
    if (m.kind == "add") {
      let best: MarkAuthor | null = null, most = 0;
      for (const a of t.adds) {
        const overlap = Math.min(a.to, m.to) - Math.max(a.from, m.from);
        if (overlap > most) { most = overlap; best = a.author; }
      }
      return best;
    }
    let best: MarkAuthor | null = null, dist = Infinity;
    for (let i = t.dels.length - 1; i >= 0; i--) {
      const d = Math.abs(t.dels[i].pos - m.pos);
      if (d < dist) { dist = d; best = t.dels[i].author; }
    }
    return dist <= Math.max(8, m.text.length) ? best : null;
  }

  private mapMarks(changes: ChangeSet): void {
    if (this.tracking || !this.marks.length) return;
    this.marks = this.marks.flatMap((m): Mark[] => {
      if (m.kind == "del") return [{ ...m, pos: changes.mapPos(m.pos, -1) }];
      const from = changes.mapPos(m.from, 1), to = changes.mapPos(m.to, -1);
      return to > from ? [{ ...m, from, to }] : [];
    });
  }

  /** Recomputes the tracked diff (coalesced to one per frame: it runs on every keystroke). */
  private queueDiff(): void {
    if (this.diffQueued) return;
    this.diffQueued = true;
    requestAnimationFrame(() => {
      this.diffQueued = false;
      if (!this.tracking) return;
      this.marks = marksFor(changesBetween(this.tracking.baseline, this.state.doc.toString()), this.tracking.units, this.units, 0).marks;
      for (const m of this.marks) m.author = this.trackedAuthor(m);
      this.paintMarks();
    });
  }

  /** Brief marks hold for a moment, then fade out step by step. */
  private startFade(): void {
    const HOLD = ms(2200), STEP = ms(110), LEVELS = 6;
    const born = performance.now();
    for (const m of this.marks) m.born ??= born;
    if (this.fadeTimer) return;
    this.fadeTimer = window.setInterval(() => {
      const now = performance.now();
      this.marks = this.marks.filter((m) => now - m.born! < HOLD + LEVELS * STEP);
      for (const m of this.marks) m.level = Math.max(0, Math.min(LEVELS - 1, Math.floor((now - m.born! - HOLD) / STEP) + 1));
      if (!this.marks.length || this.tracking) { clearInterval(this.fadeTimer); this.fadeTimer = 0; }
      this.paintMarks();
    }, 60);
  }

  private queuePaint(): void {
    if (this.paintQueued || (!this.marks.length && !this.overlay && !this.peers.length && !this.peerLayer)) return;
    this.paintQueued = true;
    requestAnimationFrame(() => { this.paintQueued = false; this.paintMarks(); });
  }

  /** Draws the marks: CSS highlights over added text (the DOM is untouched), notches in an overlay for removed text. */
  private paintMarks(): void {
    const doc = this.doc, win = this.frame.contentWindow as (Window & typeof globalThis & { Highlight?: new (...r: Range[]) => unknown }) | null;
    if (!doc || !win || this.rendering) return;
    const registry = (win.CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    // One highlight per author colour and fade level: "sw-add-<level>" for
    // unattributed changes (green), "sw-a<n>-<level>" for each author's.
    const groups = new Map<string, Range[]>();
    for (const m of this.marks) {
      if (m.kind != "add") continue;
      const name = m.author ? `sw-a${this.authorStyle(m.author.color)}-${m.level ?? 0}` : `sw-add-${m.level ?? 0}`;
      let ranges = groups.get(name);
      if (!ranges) groups.set(name, (ranges = []));
      ranges.push(...this.rangesIn(m.from, m.to));
    }
    if (registry && win.Highlight) {
      for (const name of [...registry.keys()]) if (/^sw-(add|a\d+)-\d$/.test(name) && !groups.has(name)) registry.delete(name);
      for (const [name, ranges] of groups) registry.set(name, new win.Highlight!(...ranges));
    }

    const dels = this.marks.filter((m): m is Mark & { kind: "del" } => m.kind == "del");
    if (!dels.length) {
      this.overlay?.remove();
      this.overlay = null;
    } else {
      if (!this.overlay || !this.overlay.isConnected) {
        this.overlay = doc.createElement("sw-marks");
        doc.documentElement.append(this.overlay);
      }
      this.overlay.textContent = "";
      for (const m of dels) {
        const at = this.anchorAt(m.pos);
        if (!at) continue;
        const notch = doc.createElement("sw-del");
        notch.style.cssText = `left:${at.rect.left + win.scrollX}px;top:${at.rect.top + win.scrollY}px;height:${at.inline ? at.rect.height : 18}px;opacity:${1 - (m.level ?? 0) / 6}`;
        if (m.author) notch.style.setProperty("--sw-del", m.author.color);
        notch.setAttribute("aria-label", `Deleted${m.author ? ` by ${m.author.name}` : ""}: ${m.text}`);
        const tip = doc.createElement("sw-tip");
        if (m.author) { const who = doc.createElement("sw-who"); who.textContent = m.author.name; who.style.color = m.author.color; tip.append(who); }
        tip.append(m.text.length > 160 ? m.text.slice(0, 160) + "…" : m.text);
        notch.append(tip);
        this.overlay.append(notch);
      }
    }

    this.paintPeers();

    if (this.revealPending != null) {
      const at = this.anchorAt(this.revealPending);
      this.revealPending = null;
      if (at && (at.rect.bottom < 0 || at.rect.top > win.innerHeight)) win.scrollBy({ top: at.rect.top - win.innerHeight / 2, behavior: "smooth" });
    }
  }

  /** DOM ranges over the page text of source [from, to), one per text node it touches. */
  private rangesIn(from: number, to: number): Range[] {
    const out: Range[] = [];
    for (const u of this.units) {
      if (u.contentTo < from || u.contentFrom > to) continue;
      const el = this.els[u.id];
      if (!el) continue;
      const nodes = this.textNodes(el);
      if (nodes.length != u.runs.length) continue;
      u.runs.forEach((run, i) => {
        const s = Math.max(from, run.from), e = Math.min(to, run.to);
        if (s >= e) return;
        const range = this.doc!.createRange();
        try { range.setStart(nodes[i], M.runOffset(run, s)); range.setEnd(nodes[i], M.runOffset(run, e)); } catch { return; }
        out.push(range);
      });
    }
    return out;
  }

  /** The index of an author colour's highlights, writing their styles into the page the first time. */
  private authorStyle(color: string): number {
    let n = this.authorStyles.get(color);
    if (n == null) this.authorStyles.set(color, (n = this.authorStyles.size));
    const doc = this.doc!;
    let style = doc.getElementById("sw-authors");
    if (!style || style.dataset.count != String(this.authorStyles.size)) {
      style ??= doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "sw-authors" }));
      style.dataset.count = String(this.authorStyles.size);
      style.textContent = [...this.authorStyles].map(([c, i]) => FADE.map((a, level) => `::highlight(sw-a${i}-${level}) { background-color: ${rgba(c, a * 0.9)}; }`).join("\n")).join("\n");
    }
    return n;
  }

  /** Scrolls a source position into view, if it's off screen (to find someone's caret). */
  reveal(pos: number): void {
    const win = this.frame.contentWindow;
    const at = this.anchorAt(pos);
    if (win && at && (at.rect.bottom < 0 || at.rect.top > win.innerHeight)) win.scrollBy({ top: at.rect.top - win.innerHeight / 2, behavior: "smooth" });
  }

  /** Shows other people's carets and selections (positions in the current source). */
  setPeers(peers: Peer[]): void {
    this.peers = peers;
    this.paintPeers();
  }

  private paintPeers(): void {
    const doc = this.doc, win = this.frame.contentWindow;
    if (!doc || !win || this.rendering) return;
    if (!this.peers.length) { this.peerLayer?.remove(); this.peerLayer = null; return; }
    if (!this.peerLayer || !this.peerLayer.isConnected) {
      this.peerLayer = doc.createElement("sw-peers");
      doc.documentElement.append(this.peerLayer);
    }
    const layer = this.peerLayer;
    layer.textContent = "";
    const len = this.state.doc.length;
    for (const p of this.peers) {
      const anchor = Math.min(p.anchor, len);
      if (p.head != null && p.head != anchor) {
        const from = Math.min(anchor, p.head), to = Math.min(len, Math.max(anchor, p.head));
        for (const r of this.rangesIn(from, to)) for (const rect of r.getClientRects()) {
          const box = doc.createElement("sw-peer-sel");
          box.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;width:${rect.width}px;height:${rect.height}px;background:${rgba(p.color, 0.18)}`;
          layer.append(box);
        }
      }
      // An agent's caret can sit between blocks (after an edit to the markup):
      // show it at the end of the text before, or the start of the text after.
      let caretAt = Math.min(p.head ?? anchor, len);
      if (!M.unitAt(this.units, caretAt)) {
        const prev = [...this.units].reverse().find((u) => u.to <= caretAt && this.els[u.id]);
        const near = prev ?? this.units.find((u) => u.from >= caretAt && this.els[u.id]);
        if (!near) continue;
        caretAt = near == prev ? M.textEnd(near) : M.textStart(near);
      }
      const rect = this.coordsAtPos(Math.min(caretAt, len), -1);
      if (!rect || (!rect.height && !rect.width && !rect.top)) continue;
      const caret = doc.createElement("sw-peer");
      caret.style.cssText = `left:${rect.left + win.scrollX}px;top:${rect.top + win.scrollY}px;height:${rect.height || 18}px;--sw-peer:${p.color}`;
      if (p.agent) caret.setAttribute("data-agent", "");
      const label = doc.createElement("sw-peer-name");
      label.textContent = p.activity ? `${p.name} · ${p.activity}` : p.name;
      caret.append(label);
      layer.append(caret);
    }
  }

  /** Where a source position is on the page: inside text (a caret rect), or else at the start of the next paragraph. */
  private anchorAt(pos: number): { rect: DOMRect; inline: boolean } | null {
    const u = M.unitAt(this.units, pos);
    if (u && this.els[u.id]) {
      const rect = this.coordsAtPos(pos, -1);
      if (rect) return { rect, inline: true };
    }
    const next = this.units.find((x) => x.from >= pos && this.els[x.id]) ?? [...this.units].reverse().find((x) => this.els[x.id]);
    if (!next) return null;
    const r = this.els[next.id]!.getBoundingClientRect();
    return { rect: new DOMRect(r.left, next.from >= pos ? r.top : r.bottom - 18, 0, 0), inline: false };
  }

  /** Highlights the units that overlap the ranges, scrolling the first into view if it is off screen. */
  private flash(ranges: { from: number; to: number }[], reveal = true): void {
    const win = this.frame.contentWindow;
    let first: Element | null = null;
    for (const u of this.units) {
      if (!ranges.some((r) => r.from <= u.to && r.to >= u.from)) continue;
      const el = this.els[u.id];
      if (!el) continue;
      el.classList.remove("sw-flash");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("sw-flash");
      el.addEventListener("animationend", () => el.classList.remove("sw-flash"), { once: true });
      first ??= el;
    }
    if (first && win && reveal) {
      const r = first.getBoundingClientRect();
      if (r.bottom < 0 || r.top > win.innerHeight) first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  /** Adopts a state edited elsewhere (the source view) and re-renders. */
  setState(state: EditorState): void {
    if (state == this.state) return;
    this.state = state;
    if (this.tracking) this.queueDiff();
    else this.marks = [];
    this.render();
  }

  /** What CodeMirror's state commands (undo, the Markdown commands) dispatch through. */
  private target() {
    return { state: this.state, dispatch: (tr: Transaction) => this.dispatch(tr) };
  }

  // ------------------------------------------------------------ patching the DOM

  private shape(u: M.Unit, src: string): string {
    // Markup only: text between (or outside) tags removed.
    if (this.kind == "md") return u.tag + "|" + (u.innerHtml ?? "").replace(/[^<>]+(?=<|$)/g, "");
    let out = "", pos = u.contentFrom;
    for (const r of u.runs) { out += src.slice(pos, r.from); pos = r.to; }
    return u.tag + "|" + out + src.slice(pos, u.contentTo);
  }

  private applyChanges(tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): void {
    if (!this.doc || this.rendering) return;
    if (this.patch(tr, oldUnits, oldSrc)) this.recheck(tr.changes);
  }

  /**
   * Re-verifies the units a change touched: a change can break a unit (a
   * stray tag typed into it) or mend a locked one (the agent fixing it), and
   * either has to show without a full render.
   */
  private recheck(changes: ChangeSet): void {
    const ranges: [number, number][] = [];
    changes.iterChangedRanges((_fa, _ta, fromB, toB) => ranges.push([fromB, toB]));
    for (const u of this.units) {
      if (!ranges.some(([f, t]) => f <= u.to && t >= u.from)) continue;
      const el = this.els[u.id];
      if (!el) continue;
      if (el.classList.contains("sw-locked")) {
        el.classList.remove("sw-locked");
        this.lockReasons.delete(el);
        this.prepareUnit(el);
      }
      this.verify(u);
    }
  }

  /** Patches the DOM to the new source; false if it had to render the page afresh instead. */
  private patch(tr: { changes: ChangeSet }, oldUnits: M.Unit[], oldSrc: string): boolean {
    if (!this.doc) return false;
    const src = this.state.doc.toString();
    const a = this.analyze(src);
    const newUnits = a.units;
    const byStart = new Map<number, M.Unit>();
    for (const u of newUnits) byStart.set(u.openFrom, u);
    const matched = new Map<number, { el: Element; old: M.Unit }>();
    const oldEls = this.els;
    for (const old of oldUnits) {
      const el = oldEls[old.id];
      if (!el) continue;
      const p = tr.changes.mapPos(old.openFrom, -1, MapMode.TrackDel);
      if (p == null) continue;
      const nu = byStart.get(p);
      if (nu && nu.tag == old.tag && !matched.has(nu.id)) matched.set(nu.id, { el, old });
    }
    this.units = newUnits;
    const structural = matched.size != newUnits.length || matched.size != oldUnits.length;
    const changed = new Set<number>();
    try {
      if (!structural) {
        this.els = [];
        for (const u of newUnits) {
          const { el, old } = matched.get(u.id)!;
          this.els[u.id] = el;
          if (this.patchUnit(el, old, oldSrc, u, src)) changed.add(u.id);
        }
        this.updateEmpty(changed);
        return true;
      }
      if (this.kind == "md") {
        const article = this.doc.getElementById("sw-article");
        if (!article) throw new Error("no article");
        article.innerHTML = a.html;
        this.collectEls();
        for (const el of this.els) if (el) this.prepareUnit(el);
        this.updateEmpty();
        return true;
      }
      // HTML: patch matched units, build the new ones, drop the rest. A new
      // unit is built with the largest new element around it (a paragraph
      // turned into a list brings its <ul>), placed next to its nearest
      // sibling already on the page.
      const els: (Element | undefined)[] = [];
      for (const u of newUnits) {
        const m = matched.get(u.id);
        if (m) { els[u.id] = m.el; this.patchUnit(m.el, m.old, oldSrc, u, src); }
      }
      const inserted: [number, number][] = [];
      tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => inserted.push([fromB, toB]));
      const isNew = (n: M.ElementNode) => inserted.some(([f, t]) => f <= n.from && n.to <= t);
      const unitOfNode = new Map<M.ElementNode, M.Unit>();
      for (const u of newUnits) if (u.node) unitOfNode.set(u.node, u);
      for (const u of newUnits) {
        if (els[u.id] || !u.node) continue;
        let top = u.node;
        if (isNew(top)) while (top.parent && top.parent.parent && isNew(top.parent)) top = top.parent;
        const group = newUnits.filter((w) => !els[w.id] && w.from >= top.from && w.to <= top.to);
        const tpl = this.doc.createElement("template");
        tpl.innerHTML = M.stamp(src.slice(top.from, top.to), group.map((w) => ({ ...w, openTo: w.openTo - top.from })));
        const root = tpl.content.firstElementChild;
        if (!root) throw new Error("unit did not render");
        for (const w of group) {
          const el = root.matches(`[data-sw-id="${w.id}"]`) ? root : root.querySelector(`[data-sw-id="${w.id}"]`);
          if (!el) throw new Error("unit did not render");
          this.prepareUnit(el);
          els[w.id] = el;
        }
        // Next to the nearest sibling that's a unit already on the page.
        const sibs = (top.parent?.children ?? []).filter((c): c is M.ElementNode => c.kind == "element");
        const i = sibs.indexOf(top);
        const placedEl = (n: M.ElementNode | undefined) => { const w = n && unitOfNode.get(n); return w && els[w.id] && !group.includes(w) ? els[w.id] : undefined; };
        let done = false;
        for (let j = i - 1; j >= 0 && !done; j--) { const el = placedEl(sibs[j]); if (el) { el.after(root); done = true; } }
        for (let j = i + 1; j < sibs.length && !done; j++) { const el = placedEl(sibs[j]); if (el) { el.before(root); done = true; } }
        if (!done) throw new Error("no place for the new unit");
      }
      const keep = new Set(els);
      for (const el of oldEls) if (el && !keep.has(el)) el.remove();
      this.els = els;
      for (const u of newUnits) els[u.id]!.setAttribute("data-sw-id", String(u.id));
      this.updateEmpty();
      return true;
    } catch {
      this.render();
      return false;
    }
  }

  /** The unit's run texts as the DOM should hold them (see balanceWhitespace). */
  private domTexts(u: M.Unit): string[] {
    const whole = balanceWhitespace(u.runs.map((r) => r.text).join(""));
    const out: string[] = [];
    let pos = 0;
    for (const r of u.runs) { out.push(whole.slice(pos, pos + r.text.length)); pos += r.text.length; }
    return out;
  }

  /** Patches one unit's element; returns true if anything changed. */
  private patchUnit(el: Element, old: M.Unit, oldSrc: string, u: M.Unit, src: string): boolean {
    if (this.shape(old, oldSrc) == this.shape(u, src)) {
      const nodes = this.textNodes(el);
      if (nodes.length == u.runs.length) {
        const texts = this.domTexts(u);
        let changed = false;
        nodes.forEach((n, i) => { if (!same(n.nodeValue!, u.runs[i].text) || (n.nodeValue != texts[i] && n.nodeValue == u.runs[i].text)) { n.nodeValue = texts[i]; changed = true; } });
        return changed;
      }
    }
    el.innerHTML = this.kind == "md" ? u.innerHtml ?? "" : src.slice(u.contentFrom, u.contentTo);
    this.prepareUnit(el);
    // Same whitespace treatment as a text patch, so a trailing space stays visible (and holds the caret).
    const nodes = this.textNodes(el);
    if (nodes.length == u.runs.length) this.domTexts(u).forEach((t, i) => { if (nodes[i].nodeValue != t) nodes[i].nodeValue = t; });
    return true;
  }
}
