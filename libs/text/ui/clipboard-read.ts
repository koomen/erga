// What the clipboard brings in from HTML, and the copy of a page's selection: the parts of the clipboard (../api/clipboard.ts) that
// read the DOM (DOMParser, a page's selection and pictures). They run in the browser only.

import { publicHref, type Place } from "../../../client/common/link-target";
import { escapeAttr, escapeHtmlText } from "../../../shared/html";
import {
  BLOCK,
  clipboardOf,
  DROP,
  LINK,
  nest,
  NONE,
  render,
  RULE,
  type Block,
  type Leaf,
  type Line,
  type Marks,
  type Run,
} from "../api/clipboard";

type LinkOf = (a: Element) => string | null;

// ------------------------------------------------------------------ inline

/** An element's style declarations: the class rules first, then its own style attribute. */
function declarations(el: Element, rules: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (css: string) => {
    for (const d of css.split(";")) {
      const i = d.indexOf(":");
      if (i > 0)
        out[d.slice(0, i).trim().toLowerCase()] = d
          .slice(i + 1)
          .trim()
          .toLowerCase();
    }
  };
  if (rules.size)
    for (const c of el.classList) {
      const r = rules.get(`${el.localName}.${c}`) ?? rules.get(`.${c}`);
      if (r) add(r);
    }
  const style = el.getAttribute("style");
  if (style) add(style);
  return out;
}

/** The formatting inside an element, from what is outside it; `link` says a link's address (else as written). */
function marksOf(el: Element, outer: Marks, rules: Map<string, string>, link?: LinkOf): Marks {
  const name = el.localName,
    m = { ...outer };
  if (name == "b" || name == "strong") m.strong = true;
  if (name == "i" || name == "em") m.em = true;
  if (name == "s" || name == "del" || name == "strike") m.strike = true;
  if (name == "code" || name == "kbd" || name == "samp" || name == "tt") m.code = true;
  if (name == "a") {
    const href = link ? link(el) : (el.getAttribute("href")?.trim() ?? "");
    if (href && LINK.test(href)) m.href = href;
  }
  const d = declarations(el, rules);
  const weight = d["font-weight"],
    style = d["font-style"],
    font = d.font ?? "",
    family = d["font-family"] ?? "";
  // Google Docs' <b style="font-weight:normal"> is not bold; its <span style="font-weight:700"> is.
  if (weight) m.strong = /bold/.test(weight) || parseInt(weight) >= 600;
  else if (/\bbold\b|\b[6-9]00\b/.test(font) || /bold/.test(family)) m.strong = true;
  if (style) m.em = /italic|oblique/.test(style);
  else if (/italic|oblique/.test(font) || /italic|oblique/.test(family)) m.em = true;
  return m;
}
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
  const start = (ctx: Ctx) => {
    if (!cur) cur = { tag: ctx.tag, list: ctx.list, quote: ctx.quote, runs: [] };
    return cur;
  };
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
    const el = n as Element,
      name = el.localName,
      d = declarations(el, rules);
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
      const marker =
        [...el.querySelectorAll("[style]")].find((m) => /mso-list:\s*ignore/i.test(m.getAttribute("style")!))?.textContent ?? "";
      const type = /^\s*(\d+|[a-z]|[ivxlc]+)[.)]/i.test(marker) ? "ol" : "ul";
      flush();
      const inner = { ...ctx, marks, tag: "li" as const, list: depthPath([], Number(word[1]), type), item: true };
      start(inner);
      kids(el, inner);
      flush();
      return;
    }
    if (!BLOCK.test(name)) {
      kids(el, { ...ctx, marks });
      return;
    }
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
      inner.list =
        Number.isFinite(level) && level > 0 ? depthPath(ctx.list, level, type) : depthPath(ctx.list, Math.max(1, ctx.list.length), type);
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
export const fromHtml = (html: string, link?: LinkOf): Block[] => nest(linesOf(html, { link }));

// ------------------------------------------------------------------ copying

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
