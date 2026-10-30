// What the clipboard carries in and out of the page editor: text with its
// basic formatting, and nothing of the page or the app it came from.
//
// One allow-list both ways. Blocks: paragraphs, headings, bulleted and
// numbered lists (nested), quotes, code blocks, rules and (from Markdown) tables. Inline: bold, italic,
// struck text, code, links (http, https, mailto and #id only) and line breaks; a copy adds
// pictures. Everything else goes: fonts, sizes, colours, classes, styles,
// spans, widgets.
//
// A copy writes that HTML ("rich text" on the web: browsers write no RTF),
// which Gmail and Google Docs map onto their own styles, and Markdown as the
// plain text. Its links and pictures work where they go: a link to another
// page of the document goes to its public address (the viewer's), and a
// picture of the document is in the HTML itself (a data: URL).
//
// Apps write formatting in their own ways, and the reader takes each of them:
// Google Docs gives bold and italic as inline styles (font-weight:700) inside
// a <b style="font-weight:normal"> wrapper that is not bold, and nests lists
// by aria-level; Word gives lists as paragraphs with mso-list styles and a
// marker to drop; Slack nests lists by data-indent; Pages and TextEdit give
// bold and italic by classes in a <style> block. The HTML is read as a list
// of lines (a paragraph, a heading, a list item with its depth) and the lines
// are then nested into blocks, so each of those becomes the same structure.
//
// Uses the DOM (DOMParser): runs in the browser only.

import { pageUrl } from "../../document/pages";

/** Text as HTML text (the quotes as they are: it goes into the page's source as typed). */
const escapeHtmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string) => escapeHtmlText(text).replace(/"/g, "&quot;");

/** An inline piece of text: what it is, and the formatting it has. */
interface Marks {
  strong: boolean;
  em: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
}
type Run = { text: string; marks: Marks } | { br: true } | { img: string; alt: string };

/**
 * A paragraph, heading, code block, rule or table; `html` holds only the inline allow-list, `text` is the same as plain
 * text, `md` as Markdown. A table has its cells' HTML in `rows`, the first row its header.
 */
export interface Leaf {
  tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "hr" | "table";
  html: string;
  text: string;
  md: string;
  rows?: string[][];
}
export interface List {
  tag: "ul" | "ol";
  items: Item[];
}
export interface Quote {
  tag: "blockquote";
  blocks: Block[];
}
export type Block = Leaf | List | Quote;
const isList = (b: Block): b is List => b.tag == "ul" || b.tag == "ol";
/** A list item: its text, and the lists nested in it. */
export interface Item {
  html: string;
  text: string;
  md: string;
  lists: List[];
}

/** One line of what was read: a leaf block, or a list item with the list types from the outermost list to its own. */
export interface Line {
  tag: Leaf["tag"] | "li";
  list: ("ul" | "ol")[];
  quote: boolean;
  html: string;
  text: string;
  md: string;
  rows?: string[][];
}

/** How a link reads: its address as the result has it, or null for none (its text stays). */
type LinkOf = (a: Element) => string | null;

const NONE: Marks = { strong: false, em: false, strike: false, code: false, href: null };
const BLOCK = /^(p|div|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|table|thead|tbody|tfoot|tr|td|th|caption|section|article|header|footer|main|nav|aside|figure|figcaption|hr|address|details|summary|center|form|fieldset|legend|body|html)$/;
/** Elements that give no text: what isn't text, the document's head, and Word's own elements (<o:p>, <v:shape>). */
const DROP = /^(script|style|template|head|title|meta|link|svg|math|canvas|img|picture|video|audio|iframe|object|embed|button|input|select|textarea|noscript|xml|o:p|v:.*|w:.*)$/;
/** The links a paste keeps: web and mail addresses, and places in the page (#id). */
const LINK = /^(https?:|mailto:|#[^\s#]+$)/i;

// ------------------------------------------------------------------ inline

/** An element's style declarations: the class rules first, then its own style attribute. */
function declarations(el: Element, rules: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (css: string) => {
    for (const d of css.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().toLowerCase();
    }
  };
  if (rules.size) for (const c of el.classList) {
    const r = rules.get(`${el.localName}.${c}`) ?? rules.get(`.${c}`);
    if (r) add(r);
  }
  const style = el.getAttribute("style");
  if (style) add(style);
  return out;
}

/** The formatting inside an element, from what is outside it; `link` says a link's address (else as written). */
function marksOf(el: Element, outer: Marks, rules: Map<string, string>, link?: LinkOf): Marks {
  const name = el.localName, m = { ...outer };
  if (name == "b" || name == "strong") m.strong = true;
  if (name == "i" || name == "em") m.em = true;
  if (name == "s" || name == "del" || name == "strike") m.strike = true;
  if (name == "code" || name == "kbd" || name == "samp" || name == "tt") m.code = true;
  if (name == "a") {
    const href = link ? link(el) : (el.getAttribute("href")?.trim() ?? "");
    if (href && LINK.test(href)) m.href = href;
  }
  const d = declarations(el, rules);
  const weight = d["font-weight"], style = d["font-style"], font = d.font ?? "", family = d["font-family"] ?? "";
  // Google Docs' <b style="font-weight:normal"> is not bold; its <span style="font-weight:700"> is.
  if (weight) m.strong = /bold/.test(weight) || parseInt(weight) >= 600;
  else if (/\bbold\b|\b[6-9]00\b/.test(font) || /bold/.test(family)) m.strong = true;
  if (style) m.em = /italic|oblique/.test(style);
  else if (/italic|oblique/.test(font) || /italic|oblique/.test(family)) m.em = true;
  return m;
}

const sameMarks = (a: Marks, b: Marks) =>
  a.strong == b.strong && a.em == b.em && a.strike == b.strike && a.code == b.code && a.href == b.href;

/**
 * Runs as HTML with only the inline allow-list, and as plain text. Outside a
 * code block, whitespace collapses as the page shows it; spaces at the ends
 * of a line go. In a code block (`pre`) the text stays alone; `noBold`
 * (a heading, already bold) drops bold.
 */
function render(runs: Run[], pre: boolean, noBold: boolean): { html: string; text: string; md: string } {
  const out: Run[] = [];
  let space = true;
  const trimEnd = () => {
    const last = out.at(-1);
    if (!last || !("text" in last) || pre) return;
    last.text = last.text.replace(/ +$/, "");
    if (!last.text) { out.pop(); trimEnd(); }
  };
  for (const r of runs) {
    if ("br" in r) {
      if (pre) { out.push({ text: "\n", marks: NONE }); continue; }
      trimEnd();
      out.push(r);
      space = true;
      continue;
    }
    if ("img" in r) {
      if (!pre) {
        out.push(r);
        space = false;
      }
      continue;
    }
    let t = r.text.replace(/ /g, " ");
    if (!pre) {
      t = t.replace(/\s+/g, " ");
      if (space) t = t.replace(/^ /, "");
      if (!t) continue;
      space = t.endsWith(" ");
    }
    if (t) out.push({ text: t, marks: pre ? NONE : noBold ? { ...r.marks, strong: false } : r.marks });
  }
  trimEnd();
  while (out.length && "br" in out[out.length - 1]) { out.pop(); trimEnd(); }
  while (out.length && "br" in out[0]) out.shift();
  let html = "", text = "";
  const stack: string[] = [];
  const tags = (m: Marks) =>
    [m.href ? `a ${m.href}` : "", m.strong ? "strong" : "", m.em ? "em" : "", m.strike ? "s" : "", m.code ? "code" : ""].filter(Boolean);
  const close = (k: string) => `</${k.split(" ")[0]}>`;
  const open = (k: string) => (k.startsWith("a ") ? `<a href="${k.slice(2).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` : `<${k}>`);
  let prev: Marks | null = null;
  for (const r of out) {
    // A line break ends the formatting around it: a link or bold never holds one.
    if ("br" in r) {
      while (stack.length) html += close(stack.pop()!);
      prev = null;
      html += "<br>"; text += "\n";
      continue;
    }
    if ("img" in r) {
      html += `<img src="${escapeAttr(r.img)}" alt="${escapeAttr(r.alt)}">`;
      continue;
    }
    if (!prev || !sameMarks(prev, r.marks)) {
      const want = tags(r.marks);
      let k = 0;
      while (k < stack.length && k < want.length && stack[k] == want[k]) k++;
      while (stack.length > k) html += close(stack.pop()!);
      for (const w of want.slice(k)) { html += open(w); stack.push(w); }
      prev = r.marks;
    }
    html += escapeHtmlText(r.text);
    text += r.text;
  }
  while (stack.length) html += close(stack.pop()!);
  return { html, text, md: pre ? text : markdown(out) };
}

// ------------------------------------------------------------------ Markdown

/** ASCII punctuation: what a backslash escapes in Markdown. */
const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Text as Markdown text: a backslash before each character that would read as
 * Markdown there, and only there (a "*" between spaces, a "_" inside a word
 * stay as they are), so ordinary text reads as it is.
 */
function escapeMarkdown(t: string): string {
  const brackets = t.includes("[") && t.includes("]");
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i],
      prev = t[i - 1] ?? " ",
      next = t[i + 1] ?? " ";
    const spaced = /\s/.test(prev) && /\s/.test(next);
    const escape =
      c == "\\"
        ? PUNCT.test(next)
        : c == "`"
          ? true
          : c == "*"
            ? !spaced
            : c == "_"
              ? !spaced && !(WORD.test(prev) && WORD.test(next))
              : c == "[" || c == "]"
                ? brackets
                : c == "<"
                  ? /[a-z/!?]/i.test(next)
                  : c == "&"
                    ? /^&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(t.slice(i))
                    : c == "~"
                      ? next == "~" || prev == "~"
                      : false;
    out += escape ? "\\" + c : c;
  }
  return out;
}

/** The start of a line that would read as a block's (a heading, a quote, a list item, a rule), with its backslash. */
const escapeLineStart = (line: string) =>
  line.replace(/^(\s*)(#{1,6}(?=\s|$)|[-+>=](?=\s|$)|-{2,}\s*$|={2,}\s*$)/, "$1\\$2").replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, "$1\\$2");

/** Code as a Markdown code span: in more backticks than any run in it. */
function codeSpan(t: string): string {
  const fence = "`".repeat(Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = /^`|`$/.test(t) || /^ .*\S.* $/.test(t) ? " " : "";
  return fence + pad + t + pad + fence;
}

/** A code block's fence: three backticks, or more than any run in it. */
const codeFence = (t: string) => "`".repeat(Math.max(3, ...(t.match(/`+/g) ?? []).map((r) => r.length + 1)));

/** An address in a Markdown link: no space or bracket in it to end it. */
const markdownUrl = (url: string) => url.replace(/[\s()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));

/**
 * Runs (as render keeps them: whitespace collapsed) as Markdown: **bold**,
 * *italic*, `code`, [links](url), a line break as two spaces at the end of
 * the line; a picture at a web address as ![alt](url), others left out.
 * Bold and italic never start or end with a space (Markdown would not read them).
 */
function markdown(runs: Run[]): string {
  let md = "";
  const stack: string[] = [];
  const delim = (k: string, closing: boolean) =>
    k == "strong" ? "**" : k == "em" ? "*" : k == "s" ? "~~" : closing ? `](${markdownUrl(k.slice(2))})` : "[";
  // A span closes before the spaces at its end, and opens after those at its start.
  const close = () => {
    const space = /\s*$/.exec(md)![0];
    md = md.slice(0, md.length - space.length) + delim(stack.pop()!, true) + space;
  };
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if ("br" in r) {
      while (stack.length) close();
      md += "  \n";
      continue;
    }
    if ("img" in r) {
      if (/^https?:/i.test(r.img)) md += `![${escapeMarkdown(r.alt)}](${markdownUrl(r.img)})`;
      continue;
    }
    // The spans open stay open while the text keeps their formatting (Markdown nests them in any order).
    const want = [
      r.marks.href ? `a ${r.marks.href}` : "",
      r.marks.strong ? "strong" : "",
      r.marks.em ? "em" : "",
      r.marks.strike ? "s" : "",
    ].filter(Boolean);
    let k = 0;
    while (k < stack.length && want.includes(stack[k])) k++;
    while (stack.length > k) close();
    let text = r.text;
    // Code: one span for the code runs together (render splits them where the formatting outside changes).
    while (r.marks.code && i + 1 < runs.length) {
      const n = runs[i + 1];
      if (!("text" in n) || !sameMarks(n.marks, r.marks)) break;
      text += n.text;
      i++;
    }
    if (want.length > stack.length) {
      const space = /^\s*/.exec(text)![0];
      md += space;
      text = text.slice(space.length);
      for (const w of want)
        if (!stack.includes(w)) {
          md += delim(w, false);
          stack.push(w);
        }
    }
    md += r.marks.code ? codeSpan(text) : escapeMarkdown(text);
  }
  while (stack.length) close();
  return md.split("\n").map(escapeLineStart).join("\n");
}

/** Whether an element is one that gives no text, or one the caller leaves out. */
function dropped(el: Element, d: Record<string, string>, skip?: (el: Element) => boolean): boolean {
  return DROP.test(el.localName) || d.display == "none" || /ignore/.test(d["mso-list"] ?? "") || !!skip?.(el);
}

/**
 * The inline content of a node (a piece of one block the page holds) with
 * only the allow-list: what a copy takes from each block. `link` and `image`
 * say the address a link and a picture have where the copy goes (null: the
 * link's text alone, no picture); `skip` leaves out the editor's own elements.
 */
export function inline(
  root: Node,
  o: { pre: boolean; heading: boolean; link: LinkOf; image: (img: HTMLImageElement) => string | null; skip?: (el: Element) => boolean }
): { html: string; text: string; md: string } {
  const runs: Run[] = [],
    rules = new Map<string, string>();
  const walk = (n: Node, marks: Marks) => {
    if (n.nodeType == 3) {
      runs.push({ text: n.nodeValue!, marks });
      return;
    }
    if (n.nodeType != 1 && n.nodeType != 11) return;
    if (n.nodeType == 1) {
      const el = n as Element;
      // A picture is atomic in the editor (contenteditable="false"), but the page's own.
      if (el.localName == "img" && !el.hasAttribute("data-erga")) {
        const src = o.image(el as HTMLImageElement);
        if (src) runs.push({ img: src, alt: el.getAttribute("alt") ?? "" });
        return;
      }
      if (dropped(el, declarations(el, rules), o.skip)) return;
      if (el.localName == "br") {
        runs.push({ br: true });
        return;
      }
      marks = marksOf(el, marks, rules, o.link);
    }
    n.childNodes.forEach((c) => walk(c, marks));
  };
  walk(root, NONE);
  return render(runs, o.pre, o.heading);
}

// ------------------------------------------------------------------ reading HTML

/** Simple class rules in a document's <style> blocks (`.s1 {…}`, `span.s1 {…}`), as Pages and TextEdit write formatting. */
function classRules(doc: Document): Map<string, string> {
  const rules = new Map<string, string>();
  for (const s of doc.querySelectorAll("style")) {
    for (const m of (s.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const sel of m[1].split(",")) {
        const k = /^\s*([a-z0-9]*\.[\w-]+)\s*$/i.exec(sel);
        if (k) rules.set(k[1].toLowerCase(), (rules.get(k[1].toLowerCase()) ?? "") + ";" + m[2]);
      }
    }
  }
  return rules;
}

/** The list type a list item or a Word marker says it is, if it says. */
function listType(d: Record<string, string>): "ul" | "ol" | null {
  const t = d["list-style-type"];
  if (!t) return null;
  return /disc|circle|square|none/.test(t) ? "ul" : "ol";
}

/**
 * Reads clipboard HTML into lines (see Line), with only the allow-list.
 * `link` says a link's address (else as written); with `images`, pictures at
 * a web address or in a data: URL stay.
 */
export function linesOf(html: string, o: { link?: LinkOf; images?: boolean } = {}): Line[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rules = classRules(doc);
  const lines: Line[] = [];
  type Ctx = { marks: Marks; tag: Leaf["tag"] | "li"; list: ("ul" | "ol")[]; quote: boolean; item: boolean };
  let cur: { tag: Line["tag"]; list: ("ul" | "ol")[]; quote: boolean; runs: Run[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const r = render(cur.runs, cur.tag == "pre", /^h\d$/.test(cur.tag));
    if (r.text.trim() || r.html.includes("<img")) lines.push({ tag: cur.tag, list: cur.list, quote: cur.quote, ...r });
    cur = null;
  };
  const start = (ctx: Ctx) => { if (!cur) cur = { tag: ctx.tag, list: ctx.list, quote: ctx.quote, runs: [] }; return cur; };
  const visible = () => !!cur?.runs.some((r) => "img" in r || ("text" in r && /\S/.test(r.text.replace(/ /g, " "))));
  const depthPath = (list: ("ul" | "ol")[], depth: number, type: "ul" | "ol") => {
    const path = list.slice(0, depth);
    while (path.length < depth) path.push(path.at(-1) ?? type);
    path[depth - 1] = type;
    return path;
  };
  const kids = (n: Node, ctx: Ctx) => n.childNodes.forEach((c) => walk(c, ctx));
  const walk = (n: Node, ctx: Ctx) => {
    if (n.nodeType == 3) {
      if (!cur && ctx.tag != "pre" && !/\S/.test(n.nodeValue!.replace(/ /g, " "))) return;
      start(ctx).runs.push({ text: n.nodeValue!, marks: ctx.marks });
      return;
    }
    if (n.nodeType != 1) return;
    const el = n as Element, name = el.localName, d = declarations(el, rules);
    if (name == "img" && o.images) {
      const src = el.getAttribute("src") ?? "";
      if (/^(https?:|data:image\/)/i.test(src)) start(ctx).runs.push({ img: src, alt: el.getAttribute("alt") ?? "" });
      return;
    }
    if (dropped(el, d)) return;
    if (name == "br" || el.getAttribute("data-stringify-type") == "paragraph-break") {
      start(ctx).runs.push({ br: true });
      return;
    }
    if (name == "hr" && !ctx.item) {
      flush();
      lines.push({ ...RULE, quote: ctx.quote });
      return;
    }
    const marks = marksOf(el, ctx.marks, rules, o.link);
    // Word's list paragraphs: <p style="mso-list:l0 level2 lfo1"> with a marker (dropped as mso-list:Ignore) that says the type.
    const word = /level(\d+)/.exec(d["mso-list"] ?? "");
    if (word && !ctx.item) {
      const marker = [...el.querySelectorAll("[style]")].find((m) => /mso-list:\s*ignore/i.test(m.getAttribute("style")!))?.textContent ?? "";
      const type = /^\s*(\d+|[a-z]|[ivxlc]+)[.)]/i.test(marker) ? "ol" : "ul";
      flush();
      const inner = { ...ctx, marks, tag: "li" as const, list: depthPath([], Number(word[1]), type), item: true };
      start(inner);
      kids(el, inner);
      flush();
      return;
    }
    if (!BLOCK.test(name)) { kids(el, { ...ctx, marks }); return; }
    const inner: Ctx = { ...ctx, marks };
    if (name == "ul" || name == "ol") {
      flush();
      // Slack nests lists by data-indent, not by putting one in another.
      const indent = Number(el.getAttribute("data-indent") ?? NaN);
      inner.list = Number.isFinite(indent) ? depthPath(ctx.list, indent + 1, name) : [...ctx.list, name];
      kids(el, inner);
      flush();
      return;
    }
    if (name == "li") {
      flush();
      // Google Docs says the depth by aria-level; a list-style-type says the type.
      const level = Number(el.getAttribute("aria-level") ?? NaN);
      const type = listType(d) ?? ctx.list.at(-1) ?? "ul";
      inner.list = Number.isFinite(level) && level > 0 ? depthPath(ctx.list, level, type) : depthPath(ctx.list, Math.max(1, ctx.list.length), type);
      inner.tag = "li";
      inner.item = true;
      start(inner);
      kids(el, inner);
      flush();
      return;
    }
    if (ctx.item && cur?.tag == "li") {
      // A paragraph in a list item (Google Docs' <li><p>…</p></li>) is the item's text; a second one is a line break.
      if (visible()) cur.runs.push({ br: true });
      kids(el, inner);
      return;
    }
    flush();
    if (name == "blockquote") inner.quote = true;
    else if (name == "pre") inner.tag = "pre";
    else if (/^h[1-6]$/.test(name) && !ctx.item) inner.tag = name as Leaf["tag"];
    else if (ctx.tag != "pre" && !ctx.item) inner.tag = "p";
    kids(el, inner);
    flush();
  };
  walk(doc.body, { marks: NONE, tag: "p", list: [], quote: false, item: false });
  flush();
  return lines;
}

// ------------------------------------------------------------------ reading plain text

const BULLET = /^([ \t]*)([-*+•◦▪]|\d{1,3}[.)])[ \t]+(.*)$/;
/** A horizontal rule, as a line. */
const RULE: Line = { tag: "hr", list: [], quote: false, html: "", text: "", md: "---" };
/** The line under a Markdown table's header: "| --- | :---: |". */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A Markdown table's row as its cells' Markdown: between the pipes, "\|" a pipe in a cell. */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(^|[^\\])\|$/, "$1")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());

/**
 * Where the span that `delim` opened closes (searching from `from`), or -1: a
 * run of the same character not after a space (nor before a letter, for "_").
 * A run of two closes bold, not italic (it is bold inside it); the outer span
 * takes the end of a longer run ("***" closes bold and italic).
 */
function closer(s: string, from: number, delim: string): number {
  const c = delim[0];
  for (let j = s.indexOf(c, from); j >= 0; ) {
    let e = j;
    while (s[e] == c) e++;
    const len = e - j;
    if (s[j - 1] != "\\" && !/\s/.test(s[j - 1] ?? " ") && (len == delim.length || len >= 3) && !(c == "_" && WORD.test(s[e] ?? "")))
      return e - delim.length;
    j = s.indexOf(c, e);
  }
  return -1;
}

/**
 * Markdown's inline formatting as runs: **bold** and __bold__, *italic* and
 * _italic_, ~~struck~~, `code`, [links](url) (to the addresses a paste keeps) and
 * backslash escapes. Anything else is text as it is.
 */
function markdownRuns(s: string, marks: Marks, out: Run[]): void {
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, marks });
    buf = "";
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c == "\\" && PUNCT.test(s[i + 1] ?? "")) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c == "`") {
      const fence = /^`+/.exec(s.slice(i))![0];
      let end = -1;
      for (let j = s.indexOf(fence, i + fence.length); j >= 0; j = s.indexOf(fence, j + 1)) {
        if (s[j - 1] != "`" && s[j + fence.length] != "`") {
          end = j;
          break;
        }
      }
      if (end < 0) {
        buf += fence;
        i += fence.length;
        continue;
      }
      let code = s.slice(i + fence.length, end);
      if (/^ .*\S.* $/.test(code)) code = code.slice(1, -1);
      flush();
      out.push({ text: code, marks: { ...marks, code: true } });
      i = end + fence.length;
      continue;
    }
    if (c == "[") {
      // [text](url): the text up to its "]" (brackets in it in pairs), then the address in brackets.
      let depth = 0,
        j = i;
      for (; j < s.length; j++) {
        if (s[j] == "\\") {
          j++;
          continue;
        }
        if (s[j] == "[") depth++;
        else if (s[j] == "]" && --depth == 0) break;
      }
      const m = j < s.length ? /^\(\s*<?([^\s<>()]*)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(j + 1)) : null;
      if (m) {
        flush();
        const href = m[1].trim();
        markdownRuns(s.slice(i + 1, j), LINK.test(href) ? { ...marks, href } : marks, out);
        i = j + 1 + m[0].length;
        continue;
      }
    }
    if (c == "~" && s[i + 1] == "~" && s[i + 2] != "~" && !/\s/.test(s[i + 2] ?? " ")) {
      const at = closer(s, i + 3, "~~");
      if (at >= 0) {
        flush();
        markdownRuns(s.slice(i + 2, at), { ...marks, strike: true }, out);
        i = at + 2;
        continue;
      }
    }
    if (c == "*" || c == "_") {
      const run = (c == "*" ? /^\*+/ : /^_+/).exec(s.slice(i))![0];
      const opens = !/\s/.test(s[i + run.length] ?? " ") && !(c == "_" && WORD.test(s[i - 1] ?? ""));
      // "***" is bold and italic; "**" bold; "*" italic. Delimiters that close nothing are text.
      let at = -1,
        n = Math.min(run.length, 3);
      for (; opens && n > 0 && at < 0; n--) at = closer(s, i + n + 1, c.repeat(n));
      if (at < 0) {
        buf += run;
        i += run.length;
        continue;
      }
      n++;
      flush();
      markdownRuns(s.slice(i + n, at), { ...marks, strong: marks.strong || n >= 2, em: marks.em || n != 2 }, out);
      i = at + n;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
}

/** Lines of Markdown text (one block: a paragraph, an item, a heading) in, with line breaks between them. */
function markdownBlock(raw: string[], heading: boolean): { html: string; text: string; md: string } {
  const runs: Run[] = [];
  raw.forEach((line, k) => {
    if (k) runs.push({ br: true });
    // A line break written as Markdown's ("\" or two spaces at the end) is one as any other.
    markdownRuns(line.replace(/\\$/, "").trim(), NONE, runs);
  });
  return render(runs, false, heading);
}

/**
 * Plain text as lines, read as Markdown: a blank line starts a paragraph,
 * and a single line break is a line break in it. Lines that start with a
 * bullet ("- ", "* ", "• ") or a number ("1. ") are list items, nested by
 * their indent; an indented line after one goes on in it. "# " starts a
 * heading, "> " a quote, ``` a code block, "---" a rule, and lines of
 * "| a | b |" with a "| --- | --- |" line under the first a table; inline,
 * **bold**, *italic*, ~~struck~~, `code` and [links](url) are what they say.
 */
export function textLines(text: string, quote = false): Line[] {
  const lines: Line[] = [];
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  let cur: { tag: Line["tag"]; list: ("ul" | "ol")[]; raw: string[] } | null = null;
  let stack: { indent: number; type: "ul" | "ol" }[] = [];
  const flush = () => {
    if (cur) lines.push({ tag: cur.tag, list: cur.list, quote, ...markdownBlock(cur.raw, /^h\d$/.test(cur.tag)) });
    cur = null;
  };
  for (let i = 0; i < all.length; i++) {
    const line = all[i].replace(/\t/g, "  ").replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      stack = [];
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      stack = [];
      const body: string[] = [];
      for (i++; i < all.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(all[i]); i++) body.push(all[i]);
      const code = body.join("\n");
      lines.push({ tag: "pre", list: [], quote, html: escapeHtmlText(code), text: code, md: code });
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}$/.test(line)) {
      flush();
      stack = [];
      lines.push({ ...RULE, quote });
      continue;
    }
    if (line.includes("|") && TABLE_RULE.test(all[i + 1] ?? "")) {
      flush();
      stack = [];
      const rows = [cells(line)];
      for (i += 2; i < all.length && all[i].includes("|") && all[i].trim(); i++) rows.push(cells(all[i]));
      i--;
      const width = rows[0].length;
      const md = rows.map((r) => r.slice(0, width).concat(Array(Math.max(0, width - r.length)).fill("")));
      const read = md.map((r) => r.map((c) => markdownBlock([c], false)));
      const text = read.map((r) => r.map((c) => c.text).join("\t")).join("\n");
      lines.push({
        tag: "table",
        list: [],
        quote,
        html: "",
        text,
        md: all.slice(i - rows.length, i + 1).join("\n"),
        rows: read.map((r) => r.map((c) => c.html)),
      });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      flush();
      stack = [];
      const inner: string[] = [];
      for (; i < all.length && /^ {0,3}>/.test(all[i]); i++) inner.push(all[i].replace(/^ {0,3}> ?/, ""));
      i--;
      lines.push(...textLines(inner.join("\n"), true));
      continue;
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?$/.exec(line);
    if (h) {
      flush();
      stack = [];
      cur = { tag: `h${h[1].length}` as Line["tag"], list: [], raw: [h[2]] };
      flush();
      continue;
    }
    const m = BULLET.exec(line);
    if (!m) {
      // An indented line after a list item goes on in it; any other is a paragraph's.
      if (cur?.tag == "li" && /^\s{2}/.test(line)) {
        cur.raw.push(line);
        continue;
      }
      if (cur?.tag != "p") {
        flush();
        stack = [];
        cur = { tag: "p", list: [], raw: [] };
      }
      cur!.raw.push(line);
      continue;
    }
    flush();
    const indent = m[1].length,
      type = /\d/.test(m[2]) ? "ol" : "ul";
    while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
    if (!stack.length || stack.at(-1)!.indent < indent) stack.push({ indent, type });
    else stack[stack.length - 1].type = type;
    cur = { tag: "li", list: stack.map((s) => s.type), raw: [m[3]] };
  }
  flush();
  return lines;
}

// ------------------------------------------------------------------ blocks

/** Nests lines into blocks: list items into lists by their depth, quoted lines into quotes. */
export function nest(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].quote) {
      let j = i;
      while (j < lines.length && lines[j].quote) j++;
      blocks.push({ tag: "blockquote", blocks: nest(lines.slice(i, j).map((l) => ({ ...l, quote: false }))) });
      i = j;
      continue;
    }
    if (lines[i].tag != "li") {
      const l = lines[i++];
      blocks.push({ tag: l.tag as Leaf["tag"], html: l.html, text: l.text, md: l.md, ...(l.rows && { rows: l.rows }) });
      continue;
    }
    // A run of list items: one list open at each depth.
    const open: List[] = [];
    for (; i < lines.length && lines[i].tag == "li" && !lines[i].quote; i++) {
      const l = lines[i], depth = Math.max(1, l.list.length);
      while (open.length > depth || (open.length && open.length == depth && open.at(-1)!.tag != (l.list[depth - 1] ?? "ul"))) open.pop();
      while (open.length < depth) {
        const list: List = { tag: l.list[open.length] ?? "ul", items: [] };
        const parent = open.at(-1);
        if (!parent) blocks.push(list);
        else {
          if (!parent.items.length) parent.items.push({ html: "", text: "", md: "", lists: [] });
          parent.items.at(-1)!.lists.push(list);
        }
        open.push(list);
      }
      open.at(-1)!.items.push({ html: l.html, text: l.text, md: l.md, lists: [] });
    }
  }
  return blocks;
}

/** Clipboard HTML in, blocks out (empty when it has no text); `link` says a link's address (else as written). */
export const fromHtml = (html: string, link?: LinkOf): Block[] => nest(linesOf(html, { link }));
/** Clipboard plain text in, blocks out. */
export const fromText = (text: string): Block[] => nest(textLines(text));

/** Blocks as clipboard HTML: only the allow-list, no attributes but a link's href. */
export function toHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    if (b.tag == "blockquote") return `<blockquote>${toHtml(b.blocks)}</blockquote>`;
    if (isList(b)) return `<${b.tag}>${b.items.map((i) => `<li>${i.html}${toHtml(i.lists)}</li>`).join("")}</${b.tag}>`;
    if (b.tag == "hr") return "<hr>";
    if (b.rows) return tableSource(b.rows, "", "");
    return `<${b.tag}>${b.html}</${b.tag}>`;
  }).join("");
}

/**
 * Blocks as Markdown: a blank line between blocks, "#" for headings, "> " for
 * quotes, code blocks fenced, list items as "- " and "1. ", nested four spaces
 * in (CommonMark's readers and the older ones that want four alike).
 */
export function toMarkdown(blocks: Block[]): string {
  const list = (l: List, indent: string): string =>
    l.items
      .map((it, n) => {
        const pad = indent + "    ";
        const own = it.md ? indent + (l.tag == "ol" ? `${n + 1}. ` : "- ") + it.md.replace(/\n/g, "\n" + pad) : "";
        return [own, ...it.lists.map((s) => list(s, it.md ? pad : indent))].filter(Boolean).join("\n");
      })
      .join("\n");
  return blocks
    .map((b) => {
      if (b.tag == "blockquote") return toMarkdown(b.blocks).replace(/^/gm, "> ").replace(/^> $/gm, ">");
      if (isList(b)) return list(b, "");
      if (b.tag == "pre") return `${codeFence(b.text)}\n${b.text}\n${codeFence(b.text)}`;
      if (b.tag == "hr" || b.tag == "table") return b.md;
      if (b.tag != "p" && b.md) return "#".repeat(Number(b.tag[1])) + " " + b.md;
      return b.md;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Blocks as list items, for a paste into a list: each leaf an item, a list's items as they are. */
export function items(blocks: Block[]): Item[] {
  return blocks.flatMap((b): Item[] => {
    if (b.tag == "blockquote") return items(b.blocks);
    if (isList(b)) return b.items;
    if (b.tag == "hr") return [];
    if (b.rows) return b.rows.map((r) => ({ html: r.filter(Boolean).join(" "), text: r.join(" "), md: r.join(" "), lists: [] }));
    return [{ html: b.tag == "pre" ? b.html.replace(/\n/g, "<br>") : b.html, text: b.text, md: b.md, lists: [] }];
  });
}

/** Every item's inline HTML, nested items too, in order: for a paste into a block that can't split (a table cell). */
export function flatHtml(blocks: Block[]): string[] {
  const walk = (its: Item[]): string[] => its.flatMap((i) => [i.html, ...i.lists.flatMap((l) => walk(l.items))].filter(Boolean));
  return walk(items(blocks));
}

/**
 * Blocks as page source, starting at a line indented by `indent`: one block
 * on each line, lists with one item on each line. An item with a list in it
 * has its text beside the list, as Tab writes it (that text is a unit of its
 * own: shared/manuscript.ts, headOf).
 */
export function toSource(blocks: Block[], indent: string): string {
  const sep = "\n" + indent;
  return blocks.map((b) => {
    if (b.tag == "blockquote") return `<blockquote>${sep}  ${toSource(b.blocks, indent + "  ")}${sep}</blockquote>`;
    if (isList(b)) return `<${b.tag}>${b.items.map((i) => `${sep}  ${itemSource(i, indent + "  ")}`).join("")}${sep}</${b.tag}>`;
    if (b.tag == "hr") return "<hr>";
    if (b.rows) return tableSource(b.rows, sep, "  ");
    return `<${b.tag}>${b.html}</${b.tag}>`;
  }).join(sep);
}

/** A table's rows (cells' HTML, the first row the header) as source, each row on a line after `sep`, nested by `step`. */
function tableSource(rows: string[][], sep: string, step: string): string {
  const row = (r: string[], cell: string) => `${sep}${step}${step}<tr>${r.map((c) => `<${cell}>${c}</${cell}>`).join("")}</tr>`;
  const head = `${sep}${step}<thead>${row(rows[0], "th")}${sep}${step}</thead>`;
  const body =
    rows.length > 1
      ? `${sep}${step}<tbody>${rows
          .slice(1)
          .map((r) => row(r, "td"))
          .join("")}${sep}${step}</tbody>`
      : "";
  return `<table>${head}${body}${sep}</table>`;
}

/** One list item as page source (see toSource). */
export function itemSource(i: Item, indent: string): string {
  if (!i.lists.length) return `<li>${i.html}</li>`;
  return `<li>${i.html}${i.lists.map((l) => `\n${indent}  ${toSource([l], indent + "  ")}`).join("")}\n${indent}</li>`;
}

// ------------------------------------------------------------------ copying

/**
 * Where a page is: its origin, the path its document's files are under there
 * (/t/<token>/), its own path in the document, and the document's public
 * address, once the viewer has said it (client/inline/reader.ts).
 */
export interface Place {
  origin: string;
  prefix: string;
  page: string;
  address: string | null;
}

/** Where the page in `win` is, from the viewer's script's config; null outside a document's page. */
export function placeOf(win: Window, config: { prefix: string; address?: string } | undefined): Place | null {
  const path = win.location.pathname;
  if (!config || !path.startsWith(config.prefix)) return null;
  let page = path.slice(config.prefix.length);
  try {
    page = decodeURIComponent(page);
  } catch {
    /* as it is */
  }
  return {
    origin: win.location.origin,
    prefix: config.prefix,
    page: !page || page.endsWith("/") ? page + "index.html" : page,
    address: config.address ?? null,
  };
}

/**
 * A link's address where a copy goes. The document's files have their
 * address under a token, which opens the document to whoever has it: a link
 * to a page goes to its public address instead (a place in it, #id, too),
 * and a link to any other file of the document goes. Before the viewer has
 * said the address, a place in this page stays #id, and links to other pages
 * go.
 */
export function publicHref(a: Element, p: Place | null): string | null {
  const own = a.getAttribute("href")?.trim() ?? "";
  if (!own) return null;
  let url: URL;
  try {
    url = new URL(own, a.ownerDocument.baseURI);
  } catch {
    return null;
  }
  if (!p || url.origin != p.origin) return own.startsWith("#") ? own : url.href;
  if (!url.pathname.startsWith(p.prefix)) return null;
  let path = url.pathname.slice(p.prefix.length);
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || path.endsWith("/")) path += "index.html";
  if (!p.address) return path == p.page && url.hash ? url.hash : null;
  return /\.html$/i.test(path) ? pageUrl(p.address, path) + url.hash : null;
}

/** A picture in a copy is at most this wide and high: the copy holds the picture itself. */
const IMAGE_MAX = 1600;

/**
 * The address a picture has in a copy. The document's own pictures are under
 * the token's address, which stops working in a week and opens the document
 * to whoever has it: the copy holds the picture itself, as a data: URL (PNG,
 * or JPEG when a PNG would be large). Another site's picture keeps its
 * address. Null for a picture that hasn't loaded.
 */
export function imageSrc(img: HTMLImageElement): string | null {
  const src = img.currentSrc || img.src;
  if (!src || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (/^https?:$/.test(url.protocol) && url.origin != img.ownerDocument.location.origin) return src;
  const scale = Math.min(1, IMAGE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = img.ownerDocument.createElement("canvas");
  const w = (canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))),
    h = (canvas.height = Math.max(1, Math.round(img.naturalHeight * scale)));
  const g = canvas.getContext("2d");
  if (!g) return null;
  try {
    g.drawImage(img, 0, 0, w, h);
    const png = canvas.toDataURL("image/png");
    if (png.length < 2_000_000 && !/\.jpe?g$/i.test(url.pathname)) return png;
    // JPEG has no transparency: white under the picture.
    g.globalCompositeOperation = "destination-over";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** Copied lines as the clipboard's HTML and text: one line alone as its text (Markdown if it has formatting), else blocks. */
export function clipboardOf(lines: Line[]): { html: string; text: string } | null {
  if (!lines.length) return null;
  if (lines.length == 1 && lines[0].tag != "pre")
    return { html: lines[0].html, text: lines[0].html.includes("<") ? lines[0].md : lines[0].text };
  // The shallowest item copied is at the top level.
  const top = Math.min(...lines.filter((l) => l.tag == "li").map((l) => l.list.length));
  for (const l of lines) if (l.tag == "li") l.list = l.list.slice(top - 1);
  const blocks = nest(lines);
  return { html: toHtml(blocks), text: toMarkdown(blocks) };
}

/**
 * The selection in a page (any page, not the editor's) as HTML that linesOf
 * reads: what shows of it, each element without its attributes but a link's
 * address and a picture's (as publicHref and imageSrc give them), and bold
 * and italic that the page's style sheet gives as the element's own style.
 */
function selectedHtml(range: Range, p: Place | null): string {
  const win = range.startContainer.ownerDocument!.defaultView!;
  const walk = (n: Node, outer: CSSStyleDeclaration | null): string => {
    if (!range.intersectsNode(n)) return "";
    if (n.nodeType == 3) {
      const t = n.nodeValue!;
      return escapeHtmlText(
        t.slice(n == range.startContainer ? range.startOffset : 0, n == range.endContainer ? range.endOffset : t.length)
      );
    }
    if (n.nodeType != 1) return "";
    const el = n as Element,
      name = el.localName;
    if (el.hasAttribute("data-erga")) return "";
    const cs = win.getComputedStyle(el);
    if (cs.display == "none") return "";
    if (name == "img") {
      const src = cs.visibility == "hidden" ? null : imageSrc(el as HTMLImageElement);
      return src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(el.getAttribute("alt") ?? "")}">` : "";
    }
    if (name == "br") return "<br>";
    if (DROP.test(name)) return "";
    let attrs = "";
    if (name == "a") {
      const href = publicHref(el, p);
      if (href) attrs += ` href="${escapeAttr(href)}"`;
    }
    if (outer && (cs.fontWeight != outer.fontWeight || cs.fontStyle != outer.fontStyle))
      attrs += ` style="font-weight:${cs.fontWeight};font-style:${cs.fontStyle}"`;
    let inner = "";
    for (const c of el.childNodes) inner += walk(c, cs);
    return `<${name}${attrs}>${inner}</${name}>`;
  };
  let top: Node = range.commonAncestorContainer;
  if (top.nodeType != 1) top = top.parentNode!;
  const parent = (top as Element).parentElement;
  return walk(top, parent ? win.getComputedStyle(parent) : null);
}

/** A copy of the selection in a page that isn't in the editor (the reader's): as the editor's copy writes it. */
export function copyOf(win: Window, p: Place | null): { html: string; text: string } | null {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  return clipboardOf(linesOf(selectedHtml(sel.getRangeAt(0), p), { images: true }));
}
