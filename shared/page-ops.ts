// A page's own edits, as operations (document/page-api.ts has the module and its sandbox): the page names a module of its
// own files (<meta name="erga-api" content="api.js">) whose `apply(html, edit, input)` answers a list of operations on
// the page's elements, named by CSS selector as the source has them: insert HTML before, after or into one, remove one,
// move one, replace one, set or remove an attribute, and where the person's caret goes after it. Or { refused: why }.
// This turns them into one change to the
// source, or refuses them whole, saying why (planPageOps). The server runs it on the sandbox's answer (an agent's
// call_edit), and the page's editor on the module's answer in the page (ergaEditor.call: libs/text/ui/page-edits.ts).
// What it checks, so a page can't break itself:
//
// - every selector names one element of the source, closed by its own end tag (or a void element), and not the page's
//   html, head or body;
// - new HTML is well-formed (every tag closed, no stray end tag) and has no script, no on* attribute and none of the
//   editor's own (data-erga-*);
// - all operations refer to the source as it is before the call, and none falls inside what another removes or
//   replaces;
// - the result has no more unclosed elements than before.
//
// New HTML is indented to match the code around it. All of it is pure.

import * as M from "./manuscript";
import { selectInSource } from "./source-select";

/** Where new or moved HTML goes, by an element of the page. */
export type Where<R> = { before: R } | { after: R } | { into: R } | { prepend: R };

/** One operation, as a page's API answers it (R: a CSS selector), or as it's planned (R: the source element it names). */
export type PageOp<R = string> =
  | ({ op: "insert"; html: string } & Where<R>)
  | ({ op: "move"; el: R } & Where<R>)
  | { op: "remove"; el: R }
  | { op: "replace"; el: R; html: string }
  | { op: "attr"; el: R; name: string; value: string | null }
  | { op: "caret"; el: R; select?: boolean };

export type Change = { from: number; to: number; insert: string };
/** Where the person's caret goes after the change (in the text after it): in the first text block at or after `at`. */
export type Caret = { at: number; select: boolean };
/** A page's edit, planned: its change to the source, and the caret's place if the edit names one. */
export type Planned = { changes: Change[]; caret?: Caret };

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "keygen",
]);
const FRAME = new Set(["html", "head", "body", "#root"]);
const ATTR_NAME = /^[a-z_:][-a-z0-9_:.]*$/i;

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};

const elements = (e: M.ElementNode) => e.children.filter((c): c is M.ElementNode => c.kind == "element");
/** Closed by its own end tag, or void. */
const closedIn = (src: string, e: M.ElementNode) =>
  VOID.has(e.tag) ||
  e.selfClosing ||
  (src.slice(e.closeFrom, e.closeFrom + 2 + e.tag.length).toLowerCase() == `</${e.tag}` && e.to > e.closeFrom);
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
        if (name.startsWith("data-erga") && name != "data-erga-noedit")
          refuse(`new HTML can't have ${name}: the editor owns data-erga attributes`);
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
  let out = "",
    pos = 0;
  for (const line of text.split("\n")) {
    const lead = /^[ \t]*/.exec(line)![0].length,
      at = pos + lead;
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
    const ind = M.lineIndent(src, ref.from),
      own = ownLine(src, ref);
    const text = reindent(block, "", own ? ind : "");
    if ("after" in where) return { from: ref.to, to: ref.to, insert: own ? "\n" + ind + text : text };
    return { from: ref.from, to: ref.from, insert: own ? text + "\n" + ind : text };
  }
  const parent = "into" in where ? where.into : where.prepend;
  if (VOID.has(parent.tag) || parent.selfClosing || ["script", "style", "template", "textarea", "title"].includes(parent.tag))
    refuse(`can't insert into a <${parent.tag}>`);
  const kids = elements(parent);
  const near = "into" in where ? kids.at(-1) : kids[0];
  if (near) return place(src, "into" in where ? { after: near } : { before: near }, block);
  const ind = M.lineIndent(src, parent.from),
    inner = ind + "  ";
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

/** The module a page names as its API (<meta name="erga-api" content="...">), as written; null if it names none. */
export function apiModuleOf(html: string): string | null {
  const meta = /<meta\b(?=[^>]*\bname\s*=\s*["']?erga-api\b)[^>]*>/i.exec(html)?.[0];
  return meta
    ? /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
        .exec(meta)
        ?.slice(1)
        .find((v) => v != null)
        ?.trim() || null
    : null;
}

/**
 * Turns a page's operations into one change to the source: all of them, in the order given, or none (an error that
 * says why). Each element is named by a CSS selector of the source, which must match one.
 */
export function planPageOps(src: string, ops: unknown): Planned | { error: string } {
  try {
    if (!Array.isArray(ops) || !ops.length) refuse('an edit answers a list of operations, e.g. [{ op: "remove", el: "#old" }]');
    const root = M.parseHtml(src);
    const byStart = new Map<number, M.ElementNode>();
    const index = (e: M.ElementNode) => {
      for (const c of elements(e)) {
        byStart.set(c.from, c);
        index(c);
      }
    };
    index(root);
    const named = (sel: unknown, what: string): M.ElementNode | null => {
      if (typeof sel != "string" || !sel.trim()) return refuse(`${what} is named by a CSS selector (a string)`);
      const found = selectInSource(src, sel);
      if (typeof found == "string") return refuse(`${what}: ${found}`);
      if (found.length != 1) return refuse(`${what}, "${sel}", matches ${found.length} elements of the source: name one`);
      return byStart.get(found[0].from) ?? null;
    };
    const resolved = (ops as Record<string, unknown>[]).map((op, i) => {
      if (!op || typeof op != "object") return op;
      const out: Record<string, unknown> = { ...op };
      for (const k of ["el", "before", "after", "into", "prepend"]) if (k in out) out[k] = named(out[k], `edit ${i + 1}'s ${k}`);
      return out;
    }) as PageOp<M.ElementNode | null>[];
    return plan(src, root, resolved);
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

/** The operations, with their elements found, as one change to the source. */
function plan(src: string, root: M.ElementNode, ops: PageOp<M.ElementNode | null>[]): Planned | { error: string } {
  try {
    const changes: Change[] = [];
    /** Each moved element's new place (the change that puts it there), and the caret the edit asks for. */
    const moved = new Map<M.ElementNode, Change>();
    // (Set in the loop's callback: an object, so the type stays what it is after the loop.)
    const asked: { caret?: { el: M.ElementNode; select: boolean; n: string } } = {};
    /** Ranges that go (removed, replaced, moved away): nothing else may happen inside them. */
    const gone: { from: number; to: number; el: M.ElementNode }[] = [];
    const where = (op: { before?: unknown; after?: unknown; into?: unknown; prepend?: unknown }, i: number): Where<M.ElementNode> => {
      const keys = (["before", "after", "into", "prepend"] as const).filter((k) => k in op);
      if (keys.length != 1) refuse(`edit ${i + 1} needs one place: before, after, into or prepend`);
      return {
        [keys[0]]: checkRef(
          src,
          op[keys[0]] as M.ElementNode | null,
          `the element edit ${i + 1} puts its HTML ${keys[0] == "prepend" ? "at the start of" : keys[0]}`
        ),
      } as Where<M.ElementNode>;
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
        const put = place(src, w, reindent(src.slice(el.from, el.to), M.lineIndent(src, el.from), ""));
        changes.push(put);
        moved.set(el, put);
      } else if (op?.op == "caret") {
        if (asked.caret) refuse(`${n}: an edit has one caret`);
        if (op.select != null && typeof op.select != "boolean") refuse(`${n}: select is true or false`);
        asked.caret = { el: checkRef(src, op.el, `the element ${n} puts the caret in`), select: op.select === true, n };
      } else if (op?.op == "replace") {
        const el = checkRef(src, op.el, `the element ${n} replaces`);
        changes.push({ from: el.from, to: el.to, insert: reindent(checkHtml(op.html), "", M.lineIndent(src, el.from)) });
        gone.push({ from: el.from, to: el.to, el });
      } else if (op?.op == "attr") {
        const el = checkRef(src, op.el, `the element ${n} changes`);
        if (typeof op.name != "string" || !ATTR_NAME.test(op.name)) refuse(`${n}: “${op.name}” isn't an attribute name`);
        const name = op.name.toLowerCase();
        if (name.startsWith("on")) refuse(`${n}: can't set ${name}: handle events in the page's script`);
        if (name.startsWith("data-erga") && name != "data-erga-noedit")
          refuse(`${n}: can't set ${name}: the editor owns data-erga attributes`);
        if (op.value != null && typeof op.value != "string") refuse(`${n}: an attribute's value is a string, or null to remove it`);
        changes.push(setAttr(src, el, name, op.value));
      } else refuse(`edit ${i + 1}: unknown op “${(op as { op?: string })?.op}” (insert, remove, move, replace, attr or caret)`);
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
    const out: Planned = { changes: changes.filter((c) => c.from != c.to || c.insert) };
    if (asked.caret) out.caret = { at: caretAt(src, changes, moved, asked.caret), select: asked.caret.select };
    return out;
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

/**
 * Where the caret's element starts in the source after the changes: at its new place if the edit moves it. Refuses
 * an element the edit removes or replaces.
 */
function caretAt(src: string, changes: Change[], moved: Map<M.ElementNode, Change>, c: { el: M.ElementNode; n: string }): number {
  const order = changes.map((ch, i) => ({ ch, i })).sort((x, y) => x.ch.from - y.ch.from || x.i - y.i);
  /** Where offset `pos` of the source is after the changes: past every change that ends at or before it (in order, up to `upTo`). */
  const map = (pos: number, upTo?: Change) => {
    let d = 0;
    for (const { ch } of order) {
      if (ch == upTo || ch.from > pos) break;
      if (ch.to <= pos) d += ch.insert.length - (ch.to - ch.from);
    }
    return pos + d;
  };
  const put = moved.get(c.el);
  if (put) return map(put.from, put) + Math.max(0, put.insert.indexOf("<"));
  if (changes.some((ch) => ch.to > ch.from && ch.from <= c.el.from && ch.to >= c.el.to))
    refuse(`${c.n}: the caret's element goes with the edit`);
  return map(c.el.from);
}

/** Applies changes (in the original source's offsets; insertions at one place in the order given). */
export function applyChanges(src: string, changes: Change[]): string {
  const order = changes.map((c, i) => ({ c, i })).sort((x, y) => x.c.from - y.c.from || x.i - y.i);
  let out = "",
    pos = 0;
  for (const { c } of order) {
    out += src.slice(pos, Math.max(pos, c.from)) + c.insert;
    pos = Math.max(pos, c.to);
  }
  return out + src.slice(pos);
}

/** Where a page's API module is (relative to the document), from its meta; null if the page names none. */
export function apiPathOf(page: string, html: string): string | null {
  const ref = apiModuleOf(html);
  if (!ref) return null;
  const dir = page.includes("/") ? page.slice(0, page.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const part of (ref.startsWith("/") ? ref.slice(1) : dir + ref).split("/"))
    if (part == "..") parts.pop();
    else if (part && part != ".") parts.push(part);
  return parts.join("/");
}

/** A module's answer to one edit (operations, or { refused }) on the page's HTML: the change to the source, or why not. */
export function changesOf(html: string, edit: string, answer: unknown): Planned | { refused: string } {
  if (answer && typeof answer == "object" && !Array.isArray(answer) && "refused" in answer)
    return { refused: String((answer as { refused: unknown }).refused) };
  const plan = planPageOps(html, answer);
  return "error" in plan ? { refused: `The page's edit ${edit} can't be made: ${plan.error}.` } : plan;
}
