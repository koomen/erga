// Custom edits: a document defines its own edits, beyond typing
// (agents/document/PROMPT.md, "Custom edits"). In the editor, the page gets
// `window.ergaEditor`; its own controls (buttons it draws) call
// `ergaEditor.apply(edits)` with a list of custom edits to its elements: insert HTML before, after or into one, remove one,
// move one, replace one, set or remove an attribute. The page names the
// elements it sees on screen; the editor finds each in the source
// and this module turns the list into one change to the source, or refuses
// it whole, saying why. What it checks, so a page can't break itself:
//
// - every element named is in the source, closed by its own end tag (or a
//   void element), and not the page's html, head or body;
// - new HTML is well-formed (every tag closed, no stray end tag) and has no
//   script, no on* attribute and none of the editor's own (data-erga-*);
// - all edits refer to the source as it is before the call, and none falls
//   inside what another removes or replaces;
// - the result has no more unclosed elements than before.
//
// New HTML is indented to match the code around it. This module is pure and
// runs in the browser and under bun.

import * as M from "../../../shared/manuscript";

/** Where new or moved HTML goes, by an element of the page. */
export type Where<R> = { before: R } | { after: R } | { into: R } | { prepend: R };

/** One custom edit, as the page writes it; R is how it names elements (DOM elements in the page, source elements here). */
export type CustomEdit<R> =
  | ({ op: "insert"; html: string } & Where<R>)
  | ({ op: "move"; el: R } & Where<R>)
  | { op: "remove"; el: R }
  | { op: "replace"; el: R; html: string }
  | { op: "attr"; el: R; name: string; value: string | null };

export type Change = { from: number; to: number; insert: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
const FRAME = new Set(["html", "head", "body", "#root"]);
const ATTR_NAME = /^[a-z_:][-a-z0-9_:.]*$/i;

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

const elements = (e: M.ElementNode) => e.children.filter((c): c is M.ElementNode => c.kind == "element");
/** Closed by its own end tag, or void. */
const closedIn = (src: string, e: M.ElementNode) =>
  VOID.has(e.tag) || e.selfClosing || (src.slice(e.closeFrom, e.closeFrom + 2 + e.tag.length).toLowerCase() == `</${e.tag}` && e.to > e.closeFrom);
const describe = (src: string, e: M.ElementNode) => {
  const open = src.slice(e.from, e.openTo);
  return open.length > 60 ? open.slice(0, 57) + "…" : open;
};

/** Every element in a tree that isn't closed by its own end tag. */
function unclosed(src: string, root: M.ElementNode): number {
  let n = 0;
  const walk = (e: M.ElementNode) => {
    for (const c of elements(e)) {
      if (!closedIn(src, c)) n++;
      walk(c);
    }
  };
  walk(root);
  return n;
}

/** Checks new HTML from the page; returns it trimmed, its lines after the first without common indentation. */
export function checkHtml(html: string): string {
  if (typeof html != "string") refuse("the html of an insert or replace must be a string");
  const text = html.trim();
  if (!text) refuse("the html is empty");
  const root = M.parseHtml(text);
  let ends = 0;
  const walk = (e: M.ElementNode) => {
    for (const c of elements(e)) {
      const open = text.slice(c.from, c.openTo);
      if (c.tag == "script") refuse("new HTML can't hold a <script>: the page's own script handles its controls");
      if (c.tag.startsWith("erga-")) refuse(`new HTML can't hold <${c.tag}>: the editor's own elements stay out of documents`);
      for (const m of open.matchAll(/\s([^\s"'=<>/]+)(?=\s*=|[\s/>])/g)) {
        const name = m[1].toLowerCase();
        if (name.startsWith("on")) refuse(`new HTML can't have an ${name} attribute: handle clicks in the page's script`);
        if (name.startsWith("data-erga") && name != "data-erga-noedit") refuse(`new HTML can't have ${name}: the editor owns data-erga attributes`);
      }
      if (!closedIn(text, c)) refuse(`the new HTML's ${open} isn't closed: close every tag`);
      if (!VOID.has(c.tag) && !c.selfClosing) ends++;
      if (c.tag != "template") walk(c);
      else ends += (text.slice(c.openTo, c.closeFrom).match(/<\/[a-z]/gi) ?? []).length;
    }
  };
  walk(root);
  if ((text.match(/<\/[a-z]/gi) ?? []).length != ends) refuse("the new HTML has an end tag that closes nothing");
  return indentByNesting(text, root);
}

/**
 * Lines indented two spaces for each element they're in, whatever the page's
 * script wrote, so new code reads like the code around it. Not where
 * whitespace shows (pre, textarea): there the lines stay as they are.
 */
function indentByNesting(text: string, root: M.ElementNode): string {
  if (!text.includes("\n")) return text;
  const open: { from: number; to: number; keep: boolean }[] = [];
  const walk = (e: M.ElementNode) => {
    for (const c of elements(e)) {
      open.push({ from: c.openTo, to: c.closeFrom, keep: c.tag == "pre" || c.tag == "textarea" || c.tag == "template" });
      walk(c);
    }
  };
  walk(root);
  let out = "", pos = 0;
  for (const line of text.split("\n")) {
    const lead = /^[ \t]*/.exec(line)![0].length, at = pos + lead;
    const keep = pos > 0 && open.some((o) => o.keep && o.from < pos && pos <= o.to);
    const depth = open.filter((o) => o.from <= at && at < o.to).length;
    out += (pos ? "\n" : "") + (keep || pos == 0 ? line : line.trim() ? "  ".repeat(depth) + line.slice(lead) : "");
    pos += line.length + 1;
  }
  return out;
}

/** Lines after the first move from indentation `from` to `to`. */
function reindent(text: string, from: string, to: string): string {
  return text.replace(/\n([ \t]*)/g, (_, w: string) => "\n" + (w.startsWith(from) ? to + w.slice(from.length) : to + w.trimStart()));
}

/** Whether an element is the first thing on its line. */
const ownLine = (src: string, e: M.ElementNode) => /(^|\n)[ \t]*$/.test(src.slice(Math.max(0, e.from - 200), e.from));

/** Where an element's removal starts: back to the line break before it, if it's the first thing on its line. */
function spanFrom(src: string, e: M.ElementNode): number {
  const m = /\n[ \t]*$/.exec(src.slice(0, e.from));
  return m ? m.index : e.from;
}

/** The text that puts `block` (indentation taken off) at a place, and where. */
function place(src: string, where: Where<M.ElementNode>, block: string): Change {
  if ("after" in where || "before" in where) {
    const ref = "after" in where ? where.after : where.before;
    if (FRAME.has(ref.tag)) refuse(`can't insert beside the page's <${ref.tag}>`);
    const ind = M.lineIndent(src, ref.from), own = ownLine(src, ref);
    const text = reindent(block, "", own ? ind : "");
    if ("after" in where) return { from: ref.to, to: ref.to, insert: own ? "\n" + ind + text : text };
    return { from: ref.from, to: ref.from, insert: own ? text + "\n" + ind : text };
  }
  const parent = "into" in where ? where.into : where.prepend;
  if (VOID.has(parent.tag) || parent.selfClosing || ["script", "style", "template", "textarea", "title"].includes(parent.tag)) refuse(`can't insert into a <${parent.tag}>`);
  const kids = elements(parent);
  const near = "into" in where ? kids.at(-1) : kids[0];
  if (near) return place(src, "into" in where ? { after: near } : { before: near }, block);
  const ind = M.lineIndent(src, parent.from), inner = ind + "  ";
  const content = src.slice(parent.openTo, parent.closeFrom);
  if (!content.trim()) return { from: parent.openTo, to: parent.closeFrom, insert: "\n" + inner + reindent(block, "", inner) + "\n" + ind };
  const at = "into" in where ? parent.closeFrom : parent.openTo;
  return { from: at, to: at, insert: block };
}

/** The element a Where names. */
const target = (w: Where<M.ElementNode>) => ("before" in w ? w.before : "after" in w ? w.after : "into" in w ? w.into : w.prepend);
/** Whether `inner` is `outer` or inside it. */
const within = (inner: M.ElementNode, outer: M.ElementNode) => inner.from >= outer.from && inner.to <= outer.to;

/** A source element's open tag with an attribute set (value) or removed (null). */
function setAttr(src: string, el: M.ElementNode, name: string, value: string | null): Change {
  const open = src.slice(el.from, el.openTo);
  const re = new RegExp(`(\\s+)${name.replace(/[.:]/g, "\\$&")}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=[\\s/>])`, "i");
  const m = re.exec(open);
  const written = value == null ? "" : ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  if (m) return { from: el.from + m.index, to: el.from + m.index + m[0].length, insert: written };
  if (value == null) return { from: el.from, to: el.from, insert: "" };
  const end = open.endsWith("/>") ? el.openTo - 2 : el.openTo - 1;
  return { from: end, to: end, insert: written };
}

/** Checks an element a page named: in the source, closed, not the page's frame. */
function checkRef(src: string, el: M.ElementNode | null | undefined, what: string): M.ElementNode {
  if (!el) return refuse(`${what} isn't an element of the page's source (the page's script made it, or it's gone)`);
  if (FRAME.has(el.tag)) refuse(`${what} is the page's <${el.tag}>, which can't be edited this way`);
  if (!closedIn(src, el)) refuse(`${what}, ${describe(src, el)}, isn't closed by its own end tag in the source`);
  return el;
}

/**
 * Turns a page's custom edits into one change to the source: all of them, in the
 * order given, or none (an error that says why).
 */
export function planCustomEdits(src: string, root: M.ElementNode, ops: CustomEdit<M.ElementNode | null>[]): { changes: Change[] } | { error: string } {
  try {
    if (!Array.isArray(ops) || !ops.length) refuse("apply takes a list of edits, e.g. [{ op: \"remove\", el }]");
    const changes: Change[] = [];
    /** Ranges that go (removed, replaced, moved away): nothing else may happen inside them. */
    const gone: { from: number; to: number; el: M.ElementNode }[] = [];
    const where = (op: { before?: unknown; after?: unknown; into?: unknown; prepend?: unknown }, i: number): Where<M.ElementNode> => {
      const keys = (["before", "after", "into", "prepend"] as const).filter((k) => k in op);
      if (keys.length != 1) refuse(`edit ${i + 1} needs one place: before, after, into or prepend`);
      return { [keys[0]]: checkRef(src, op[keys[0]] as M.ElementNode | null, `the element edit ${i + 1} puts its HTML ${keys[0] == "prepend" ? "at the start of" : keys[0]}`) } as Where<M.ElementNode>;
    };
    ops.forEach((op, i) => {
      const n = `edit ${i + 1} (${(op as { op?: string })?.op ?? "?"})`;
      if (op?.op == "insert") {
        changes.push(place(src, where(op, i), checkHtml(op.html)));
      } else if (op?.op == "remove") {
        const el = checkRef(src, op.el, `the element ${n} removes`);
        const from = ownLine(src, el) ? spanFrom(src, el) : el.from;
        changes.push({ from, to: el.to, insert: "" });
        gone.push({ from, to: el.to, el });
      } else if (op?.op == "move") {
        const el = checkRef(src, op.el, `the element ${n} moves`);
        const w = where(op, i);
        if (within(target(w), el)) refuse(`${n} would move an element into itself`);
        const from = ownLine(src, el) ? spanFrom(src, el) : el.from;
        changes.push({ from, to: el.to, insert: "" });
        gone.push({ from, to: el.to, el });
        changes.push(place(src, w, reindent(src.slice(el.from, el.to), M.lineIndent(src, el.from), "")));
      } else if (op?.op == "replace") {
        const el = checkRef(src, op.el, `the element ${n} replaces`);
        changes.push({ from: el.from, to: el.to, insert: reindent(checkHtml(op.html), "", M.lineIndent(src, el.from)) });
        gone.push({ from: el.from, to: el.to, el });
      } else if (op?.op == "attr") {
        const el = checkRef(src, op.el, `the element ${n} changes`);
        if (typeof op.name != "string" || !ATTR_NAME.test(op.name)) refuse(`${n}: “${op.name}” isn't an attribute name`);
        const name = op.name.toLowerCase();
        if (name.startsWith("on")) refuse(`${n}: can't set ${name}: handle events in the page's script`);
        if (name.startsWith("data-erga") && name != "data-erga-noedit") refuse(`${n}: can't set ${name}: the editor owns data-erga attributes`);
        if (op.value != null && typeof op.value != "string") refuse(`${n}: an attribute's value is a string, or null to remove it`);
        changes.push(setAttr(src, el, name, op.value));
      } else refuse(`edit ${i + 1}: unknown op “${(op as { op?: string })?.op}” (insert, remove, move, replace or attr)`);
    });
    // Each edit refers to the source before the call: none may land inside what another takes away, or overlap another.
    for (const c of changes) {
      for (const g of gone) {
        const same = c.from == g.from && c.to == g.to;
        if (same) continue;
        const inside = c.from == c.to ? c.from > g.from && c.from < g.to : c.from < g.to && c.to > g.from;
        if (inside) refuse(`two edits touch the same element (${describe(src, g.el)}): one removes, moves or replaces it`);
      }
    }
    const sorted = [...changes].filter((c) => c.to > c.from).sort((a, b) => a.from - b.from);
    for (let k = 1; k < sorted.length; k++) if (sorted[k].from < sorted[k - 1].to) refuse("two edits change the same part of the source");
    const next = applyChanges(src, changes);
    if (unclosed(next, M.parseHtml(next)) > unclosed(src, root)) refuse("the edits would leave an element unclosed");
    return { changes: changes.filter((c) => c.from != c.to || c.insert) };
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

/** Applies changes (in the original source's offsets; insertions at one place in the order given). */
export function applyChanges(src: string, changes: Change[]): string {
  const order = changes.map((c, i) => ({ c, i })).sort((x, y) => x.c.from - y.c.from || x.i - y.i);
  let out = "", pos = 0;
  for (const { c } of order) {
    out += src.slice(pos, Math.max(pos, c.from)) + c.insert;
    pos = Math.max(pos, c.to);
  }
  return out + src.slice(pos);
}
