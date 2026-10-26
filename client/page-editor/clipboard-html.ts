// What the clipboard carries in and out of the page editor: text with its
// basic formatting, and nothing of the page or the app it came from.
//
// One allow-list both ways. Blocks: paragraphs, headings, bulleted and
// numbered lists (nested), quotes and code blocks. Inline: bold, italic,
// code, links (http, https, mailto and #id only) and line breaks. Everything else
// goes: fonts, sizes, colours, classes, styles, spans, pictures, widgets.
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

import { escapeHtmlText } from "../../shared/manuscript";

/** An inline piece of text: what it is, and the formatting it has. */
interface Marks { strong: boolean; em: boolean; code: boolean; href: string | null }
type Run = { text: string; marks: Marks } | { br: true };

/** A paragraph, heading or code block; `html` holds only the inline allow-list, `text` is the same as plain text. */
export interface Leaf { tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre"; html: string; text: string }
export interface List { tag: "ul" | "ol"; items: Item[] }
export interface Quote { tag: "blockquote"; blocks: Block[] }
export type Block = Leaf | List | Quote;
const isList = (b: Block): b is List => b.tag == "ul" || b.tag == "ol";
/** A list item: its text, and the lists nested in it. */
export interface Item { html: string; text: string; lists: List[] }

/** One line of what was read: a leaf block, or a list item with the list types from the outermost list to its own. */
export interface Line { tag: Leaf["tag"] | "li"; list: ("ul" | "ol")[]; quote: boolean; html: string; text: string }

const NONE: Marks = { strong: false, em: false, code: false, href: null };
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

/** The formatting inside an element, from what is outside it. */
function marksOf(el: Element, outer: Marks, rules: Map<string, string>, absolute: boolean): Marks {
  const name = el.localName, m = { ...outer };
  if (name == "b" || name == "strong") m.strong = true;
  if (name == "i" || name == "em") m.em = true;
  if (name == "code" || name == "kbd" || name == "samp" || name == "tt") m.code = true;
  if (name == "a") {
    // A link within the page (#id) stays as it is; others are absolute when copied, so they work where they go.
    const own = el.getAttribute("href")?.trim() ?? "";
    const href = own.startsWith("#") || !absolute ? own : (el as HTMLAnchorElement).href;
    if (LINK.test(href)) m.href = href;
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

const sameMarks = (a: Marks, b: Marks) => a.strong == b.strong && a.em == b.em && a.code == b.code && a.href == b.href;

/**
 * Runs as HTML with only the inline allow-list, and as plain text. Outside a
 * code block, whitespace collapses as the page shows it; spaces at the ends
 * of a line go. In a code block (`pre`) the text stays alone; `noBold`
 * (a heading, already bold) drops bold.
 */
function render(runs: Run[], pre: boolean, noBold: boolean): { html: string; text: string } {
  const out: Run[] = [];
  let space = true;
  const trimEnd = () => {
    const last = out.at(-1);
    if (!last || "br" in last || pre) return;
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
  const tags = (m: Marks) => [m.href ? `a ${m.href}` : "", m.strong ? "strong" : "", m.em ? "em" : "", m.code ? "code" : ""].filter(Boolean);
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
  return { html, text };
}

/** Whether an element is one that gives no text, or one the caller leaves out. */
function dropped(el: Element, d: Record<string, string>, skip?: (el: Element) => boolean): boolean {
  return DROP.test(el.localName) || d.display == "none" || /ignore/.test(d["mso-list"] ?? "") || !!skip?.(el);
}

/**
 * The inline content of a node (a piece of one block the page holds) with
 * only the allow-list: what a copy takes from each block. Links are made
 * absolute; `skip` leaves out the editor's own elements.
 */
export function inline(root: Node, o: { pre: boolean; heading: boolean; skip?: (el: Element) => boolean }): { html: string; text: string } {
  const runs: Run[] = [], rules = new Map<string, string>();
  const walk = (n: Node, marks: Marks) => {
    if (n.nodeType == 3) { runs.push({ text: n.nodeValue!, marks }); return; }
    if (n.nodeType != 1 && n.nodeType != 11) return;
    if (n.nodeType == 1) {
      const el = n as Element;
      if (dropped(el, declarations(el, rules), o.skip)) return;
      if (el.localName == "br") { runs.push({ br: true }); return; }
      marks = marksOf(el, marks, rules, true);
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

/** Reads clipboard HTML into lines (see Line), with only the allow-list. */
export function linesOf(html: string): Line[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rules = classRules(doc);
  const lines: Line[] = [];
  type Ctx = { marks: Marks; tag: Leaf["tag"] | "li"; list: ("ul" | "ol")[]; quote: boolean; item: boolean };
  let cur: { tag: Line["tag"]; list: ("ul" | "ol")[]; quote: boolean; runs: Run[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const r = render(cur.runs, cur.tag == "pre", /^h\d$/.test(cur.tag));
    if (r.text.trim()) lines.push({ tag: cur.tag, list: cur.list, quote: cur.quote, ...r });
    cur = null;
  };
  const start = (ctx: Ctx) => { if (!cur) cur = { tag: ctx.tag, list: ctx.list, quote: ctx.quote, runs: [] }; return cur; };
  const visible = () => !!cur?.runs.some((r) => !("br" in r) && /\S/.test(r.text.replace(/ /g, " ")));
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
    if (dropped(el, d)) return;
    if (name == "br" || el.getAttribute("data-stringify-type") == "paragraph-break") { start(ctx).runs.push({ br: true }); return; }
    const marks = marksOf(el, ctx.marks, rules, false);
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

/**
 * Plain text as lines: a blank line starts a paragraph, a single line break
 * is a line break in it, and lines that start with a bullet ("- ", "* ",
 * "• ") or a number ("1. ") are list items, nested by their indent.
 */
export function textLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    let plain: string[] = [];
    let stack: { indent: number; type: "ul" | "ol" }[] = [];
    const flushPlain = () => {
      if (!plain.length) return;
      lines.push({ tag: "p", list: [], quote: false, html: plain.map(escapeHtmlText).join("<br>"), text: plain.join("\n") });
      plain = [];
    };
    for (const raw of para.split("\n")) {
      const line = raw.replace(/\s+$/, "").replace(/\t/g, "  ");
      if (!line.trim()) continue;
      const m = BULLET.exec(line);
      if (!m) { stack = []; plain.push(line.trim().replace(/\s+/g, " ")); continue; }
      flushPlain();
      const indent = m[1].length, type = /\d/.test(m[2]) ? "ol" : "ul";
      while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
      if (!stack.length || stack.at(-1)!.indent < indent) stack.push({ indent, type });
      else stack[stack.length - 1].type = type;
      const t = m[3].trim().replace(/\s+/g, " ");
      lines.push({ tag: "li", list: stack.map((s) => s.type), quote: false, html: escapeHtmlText(t), text: t });
    }
    flushPlain();
  }
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
      blocks.push({ tag: l.tag as Leaf["tag"], html: l.html, text: l.text });
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
          if (!parent.items.length) parent.items.push({ html: "", text: "", lists: [] });
          parent.items.at(-1)!.lists.push(list);
        }
        open.push(list);
      }
      open.at(-1)!.items.push({ html: l.html, text: l.text, lists: [] });
    }
  }
  return blocks;
}

/** Clipboard HTML in, blocks out (empty when it has no text). */
export const fromHtml = (html: string): Block[] => nest(linesOf(html));
/** Clipboard plain text in, blocks out. */
export const fromText = (text: string): Block[] => nest(textLines(text));

/** Blocks as clipboard HTML: only the allow-list, no attributes but a link's href. */
export function toHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    if (b.tag == "blockquote") return `<blockquote>${toHtml(b.blocks)}</blockquote>`;
    if (isList(b)) return `<${b.tag}>${b.items.map((i) => `<li>${i.html}${toHtml(i.lists)}</li>`).join("")}</${b.tag}>`;
    return `<${b.tag}>${b.html}</${b.tag}>`;
  }).join("");
}

/** Blocks as plain text: paragraphs apart by a blank line, list items as "- " and "1. ", nested by indent, quotes as "> ". */
export function toText(blocks: Block[]): string {
  const list = (l: List, indent: string): string =>
    l.items.map((it, n) => {
      const marker = l.tag == "ol" ? `${n + 1}. ` : "- ";
      const pad = indent + " ".repeat(marker.length);
      const own = it.text ? indent + marker + it.text.replace(/\n/g, "\n" + pad) : "";
      return [own, ...it.lists.map((s) => list(s, it.text ? pad : indent))].filter(Boolean).join("\n");
    }).join("\n");
  return blocks.map((b) => {
    if (b.tag == "blockquote") return toText(b.blocks).replace(/^/gm, "> ");
    if (isList(b)) return list(b, "");
    return b.text;
  }).join("\n\n");
}

/** Blocks as list items, for a paste into a list: each leaf an item, a list's items as they are. */
export function items(blocks: Block[]): Item[] {
  return blocks.flatMap((b): Item[] => {
    if (b.tag == "blockquote") return items(b.blocks);
    if (isList(b)) return b.items;
    return [{ html: b.tag == "pre" ? b.html.replace(/\n/g, "<br>") : b.html, text: b.text, lists: [] }];
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
 * keeps its text in a <p>, as the editor writes it (text beside a list is
 * not a unit, and can't be edited).
 */
export function toSource(blocks: Block[], indent: string): string {
  const sep = "\n" + indent;
  return blocks.map((b) => {
    if (b.tag == "blockquote") return `<blockquote>${sep}  ${toSource(b.blocks, indent + "  ")}${sep}</blockquote>`;
    if (isList(b)) return `<${b.tag}>${b.items.map((i) => `${sep}  ${itemSource(i, indent + "  ")}`).join("")}${sep}</${b.tag}>`;
    return `<${b.tag}>${b.html}</${b.tag}>`;
  }).join(sep);
}

/** One list item as page source (see toSource). */
export function itemSource(i: Item, indent: string): string {
  if (!i.lists.length) return `<li>${i.html}</li>`;
  const text = i.html ? `<p>${i.html}</p>` : "";
  return `<li>${text}${i.lists.map((l) => `\n${indent}  ${toSource([l], indent + "  ")}`).join("")}\n${indent}</li>`;
}
