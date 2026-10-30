// One part of a file's source, as the agent names it: an element by a CSS selector (read's `selector`, an edit's
// `selector`), or a CSS rule by its selector (read's `css_rule`, an edit's `cssRule`). Found in the source as written
// (shared/manuscript.ts parseHtml), not in the page as its scripts left it, so the range is the element's own text,
// open tag to close tag. Pure: the edit tool runs it on the server, view_page's preview in the browser.

import { parseHtml, type ElementNode } from "./manuscript";

/** Where a part is: its source range, and its first and last line (from 1). */
export interface Found {
  from: number;
  to: number;
  lines: [number, number];
}

// ------------------------------------------------------------------ selectors

type Attr = { name: string; op?: "=" | "~=" | "^=" | "$=" | "*=" | "|="; value?: string };
type Pseudo = { kind: "first-child" | "last-child" | "only-child" | "first-of-type" | "last-of-type" | "only-of-type" } | { kind: "nth-child" | "nth-of-type"; a: number; b: number };
type Compound = { tag?: string; id?: string; classes: string[]; attrs: Attr[]; pseudos: Pseudo[] };
type Part = { compound: Compound; combinator: " " | ">" | "+" | "~" | null };

const SUPPORTED =
  'It takes tags, *, #id, .class, [attr], [attr="value"] (and ~= ^= $= *= |=), :first-child, :last-child, :only-child, :nth-child(n), :nth-of-type(n), :first-of-type, :last-of-type, :only-of-type, and the combinators space, >, + and ~.';

/** A selector as parts, each a compound and the combinator before it; or why it isn't one this can find. */
export function parseSelector(selector: string): Part[] | string {
  const s = selector.trim();
  const bad = (why: string) => `"${selector}" isn't a selector this can find in the source: ${why}. ${SUPPORTED}`;
  if (!s) return bad("it is empty");
  const parts: Part[] = [];
  let i = 0,
    combinator: Part["combinator"] = null;
  const ident = () => {
    const m = /^-?(?:[_a-zA-Z\u00a0-\uffff]|\\.)(?:[-\w\u00a0-\uffff]|\\.)*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].replace(/\\(.)/g, "$1");
  };
  while (i < s.length) {
    const c: Compound = { classes: [], attrs: [], pseudos: [] };
    let any = false;
    if (s[i] == "*") { i++; any = true; }
    else { const t = ident(); if (t) { c.tag = t.toLowerCase(); any = true; } }
    for (;;) {
      const ch = s[i];
      if (ch == "#" || ch == ".") {
        i++;
        const name = ident();
        if (!name) return bad(`"${ch}" has no name after it`);
        if (ch == "#") c.id = name; else c.classes.push(name);
      } else if (ch == "[") {
        const m = /^\[\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?\s*)?\]/.exec(s.slice(i));
        if (!m) return bad("an attribute selector doesn't parse");
        i += m[0].length;
        c.attrs.push({ name: m[1].toLowerCase(), ...(m[2] ? { op: m[2] as Attr["op"], value: m[3] ?? m[4] ?? m[5] } : {}) });
      } else if (ch == ":") {
        const m = /^:([-\w]+)(?:\(\s*([^)]*?)\s*\))?/.exec(s.slice(i));
        if (!m || s[i + 1] == ":") return bad(`it has ${s.slice(i).split(/[\s>+~]/)[0]}`);
        i += m[0].length;
        const kind = m[1].toLowerCase();
        if (kind == "nth-child" || kind == "nth-of-type") {
          const ab = nth(m[2] ?? "");
          if (!ab) return bad(`:${kind}(${m[2] ?? ""}) takes a number, odd, even or an+b`);
          c.pseudos.push({ kind, ...ab });
        } else if (["first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type"].includes(kind) && m[2] == null)
          c.pseudos.push({ kind } as Pseudo);
        else return bad(`it has :${m[1]}${m[2] != null ? `(${m[2]})` : ""}`);
      } else break;
      any = true;
    }
    if (!any) return bad(`it has "${s[i]}" where an element should be named`);
    parts.push({ compound: c, combinator });
    const ws = /^\s*/.exec(s.slice(i))![0];
    i += ws.length;
    if (i >= s.length) break;
    if (">+~".includes(s[i])) { combinator = s[i] as Part["combinator"]; i++; i += /^\s*/.exec(s.slice(i))![0].length; }
    else if (ws) combinator = " ";
    else return bad(s[i] == "," ? "it is a list (a, b): name one element" : `it has "${s[i]}"`);
  }
  return parts;
}

/** :nth-child's argument as a and b (an+b), or null. */
function nth(arg: string): { a: number; b: number } | null {
  const t = arg.replace(/\s+/g, "").toLowerCase();
  if (t == "odd") return { a: 2, b: 1 };
  if (t == "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(t)) return { a: 0, b: Number(t) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (!m) return null;
  return { a: m[1] == "" || m[1] == "+" ? 1 : m[1] == "-" ? -1 : Number(m[1]), b: Number(m[2] ?? 0) };
}
const nthMatches = (a: number, b: number, k: number) => (a == 0 ? k == b : (k - b) / a >= 0 && (k - b) % a == 0);

/** An element's attributes, from its open tag (names in lower case, values as written, &amp; and &quot; decoded). */
function attrsOf(src: string, el: ElementNode): Map<string, string> {
  const out = new Map<string, string>();
  const open = src.slice(el.from + 1 + el.tag.length, el.openTo);
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(open); m; m = re.exec(open)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, (m[2] ?? m[3] ?? m[4] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
  return out;
}

const elementsOf = (el: ElementNode) => el.children.filter((c): c is ElementNode => c.kind == "element");
const parentOf = (el: ElementNode) => (el.parent && el.parent.tag != "#root" ? el.parent : null);

function compoundMatches(src: string, el: ElementNode, c: Compound): boolean {
  if (c.tag && el.tag != c.tag) return false;
  if (c.id != null || c.classes.length || c.attrs.length) {
    const attrs = attrsOf(src, el);
    if (c.id != null && attrs.get("id") != c.id) return false;
    const classes = (attrs.get("class") ?? "").split(/\s+/);
    if (c.classes.some((k) => !classes.includes(k))) return false;
    for (const a of c.attrs) {
      const v = attrs.get(a.name);
      if (v == null) return false;
      const w = a.value ?? "";
      if (a.op == "=" && v != w) return false;
      if (a.op == "~=" && !v.split(/\s+/).includes(w)) return false;
      if (a.op == "^=" && !(w && v.startsWith(w))) return false;
      if (a.op == "$=" && !(w && v.endsWith(w))) return false;
      if (a.op == "*=" && !(w && v.includes(w))) return false;
      if (a.op == "|=" && v != w && !v.startsWith(w + "-")) return false;
    }
  }
  if (c.pseudos.length) {
    const siblings = el.parent ? elementsOf(el.parent) : [el];
    const same = siblings.filter((x) => x.tag == el.tag);
    const k = siblings.indexOf(el) + 1,
      kt = same.indexOf(el) + 1;
    for (const p of c.pseudos) {
      const ok = "a" in p ? nthMatches(p.a, p.b, p.kind == "nth-child" ? k : kt)
        : p.kind == "first-child" ? k == 1
        : p.kind == "last-child" ? k == siblings.length
        : p.kind == "only-child" ? siblings.length == 1
        : p.kind == "first-of-type" ? kt == 1
        : p.kind == "last-of-type" ? kt == same.length
        : same.length == 1;
      if (!ok) return false;
    }
  }
  return true;
}

function matches(src: string, el: ElementNode, parts: Part[], i: number): boolean {
  if (!compoundMatches(src, el, parts[i].compound)) return false;
  if (i == 0) return true;
  const comb = parts[i].combinator;
  if (comb == ">" || comb == " ") {
    for (let p = parentOf(el); p; p = comb == ">" ? null : parentOf(p)) if (matches(src, p, parts, i - 1)) return true;
    return false;
  }
  const before = el.parent ? elementsOf(el.parent) : [];
  const k = before.indexOf(el);
  if (comb == "+") return k > 0 && matches(src, before[k - 1], parts, i - 1);
  return before.slice(0, k).some((s) => matches(src, s, parts, i - 1));
}

/** Every element of the source the selector matches, in source order; or why the selector isn't one this can find. */
export function selectInSource(src: string, selector: string): ElementNode[] | string {
  const parts = parseSelector(selector);
  if (typeof parts == "string") return parts;
  const out: ElementNode[] = [];
  const walk = (el: ElementNode) => {
    for (const c of elementsOf(el)) {
      if (matches(src, c, parts, parts.length - 1)) out.push(c);
      walk(c);
    }
  };
  walk(parseHtml(src));
  return out;
}

// ------------------------------------------------------------------ CSS rules

/** A selector or an at-rule's prelude, compared without its spacing: ".a  >  b" is ".a>b", "(max-width: 6px)" "(max-width:6px)". */
const normal = (s: string) => {
  const t = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([>+~,{}()])\s*/g, "$1").trim();
  return t.startsWith("@") ? t.replace(/\s*:\s*/g, ":") : t; // (in a selector, a space before ":" is a combinator)
};

/**
 * The rules in CSS `css` (a stylesheet, or a <style>'s text at `base` in its file) whose prelude is `prelude` (a
 * selector, or an at-rule such as "@media (max-width: 600px)"): each from its prelude to its closing brace, and the
 * at-rule it is in, if any.
 */
function rulesIn(css: string, base: number, prelude: string): { from: number; to: number; within?: string }[] {
  const want = normal(prelude);
  const out: { from: number; to: number; within?: string }[] = [];
  const open: { from: number; prelude: string }[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch == "/" && css[i + 1] == "*") { const e = css.indexOf("*/", i + 2); i = e < 0 ? css.length : e + 1; continue; }
    if (ch == '"' || ch == "'") { let j = i + 1; while (j < css.length && css[j] != ch && css[j] != "\n") j += css[j] == "\\" ? 2 : 1; i = j; continue; }
    if (ch == ";") start = i + 1;
    else if (ch == "{") {
      // The prelude's first character: after spaces and comments.
      let from = start;
      for (;;) {
        from += /^\s*/.exec(css.slice(from))![0].length;
        if (css.startsWith("/*", from)) { const e = css.indexOf("*/", from + 2); from = e < 0 ? i : e + 2; } else break;
      }
      open.push({ from, prelude: css.slice(from, i) });
      start = i + 1;
    } else if (ch == "}") {
      const r = open.pop();
      if (r && normal(r.prelude) == want) out.push({ from: base + r.from, to: base + i + 1, ...(open.length ? { within: open[open.length - 1].prelude.replace(/\s+/g, " ").trim() } : {}) });
      start = i + 1;
    }
  }
  return out;
}

/** The CSS rules in a file whose prelude is `prelude`: in a stylesheet (.css) its whole text, else each <style>'s. */
export function cssRulesInSource(src: string, path: string, prelude: string): { from: number; to: number; within?: string }[] {
  if (/\.css$/i.test(path)) return rulesIn(src, 0, prelude);
  const out: { from: number; to: number; within?: string }[] = [];
  const walk = (el: ElementNode) => {
    for (const c of elementsOf(el)) {
      if (c.tag == "style") out.push(...rulesIn(src.slice(c.openTo, c.closeFrom), c.openTo, prelude));
      else walk(c);
    }
  };
  walk(parseHtml(src));
  return out;
}

// ------------------------------------------------------------------ either

const lineAt = (src: string, pos: number) => src.slice(0, pos).split("\n").length;
const lines = (src: string, r: { from: number; to: number }): [number, number] => [lineAt(src, r.from), lineAt(src, Math.max(r.from, r.to - 1))];
const where = (src: string, r: { from: number; to: number }) => { const [a, b] = lines(src, r); return a == b ? `line ${a}` : `lines ${a}-${b}`; };

/**
 * The one part of `src` (the file at `path`) that `selector` (an element) or `cssRule` (a CSS rule's selector) names;
 * or why there is none, or more than one, in words for the agent.
 */
export function findInSource(src: string, path: string, at: { selector?: string; cssRule?: string }): Found | string {
  if ((at.selector == null) == (at.cssRule == null)) return "Name one part: a selector (an element) or a CSS rule's selector, not both.";
  if (at.selector != null) {
    if (/\.css$/i.test(path)) return `${path} is a stylesheet: name a rule in it by its selector (css_rule), not an element.`;
    const els = selectInSource(src, at.selector);
    if (typeof els == "string") return els;
    if (els.length != 1)
      return `"${at.selector}" matches ${els.length} elements in ${path}${els.length ? ` (at ${els.slice(0, 10).map((e) => where(src, e)).join(", ")}${els.length > 10 ? ", ..." : ""})` : ""}, as written in the source (not as the page's scripts change it). Make it match one: add a class, an id, :nth-of-type(n) or a parent.`;
    return { from: els[0].from, to: els[0].to, lines: lines(src, els[0]) };
  }
  const rules = cssRulesInSource(src, path, at.cssRule!);
  if (rules.length != 1)
    return `The CSS rule "${at.cssRule}" is ${rules.length ? `in ${path} ${rules.length} times (${rules.map((r) => `${where(src, r)}${r.within ? ` in ${r.within}` : ""}`).join(", ")}): edit the one you mean by its text (oldText)` : `not in ${path}${/\.css$/i.test(path) ? "" : "'s <style> elements"}: give its selector as written (spaces don't matter), or an at-rule's prelude ("@media (max-width: 600px)")`}.`;
  return { from: rules[0].from, to: rules[0].to, lines: lines(src, rules[0]) };
}
