// Brings the page on screen to a new version of its HTML in place, the way a
// collaborator's edit shows in a shared document: only the elements that
// changed are touched, everything else (its scroll, its images, the caret,
// what the page's own scripts did to it) stays as it is.
//
// It compares the HTML the page was rendered from (`from`) with the new HTML
// (`to`), both parsed but never run, and applies the difference to the live
// document, which must still match `from` wherever they differ. Nodes equal
// in both are kept (with their unit numbers updated: data-erga-id counts the
// text blocks, so a block added near the top renumbers all below it). It
// plans first and changes nothing until the whole plan is known to work, so
// a page it can't bring up to date is left untouched for a full render.
//
// It gives up (null) when a script would change, appear or go (only a fresh
// render runs scripts as the page expects), and when the live page no longer
// has the shape of `from` where a change falls (the page's own script built
// that part).

const ID = / data-erga-id="\d+"/g;
/** How much of a list of children it lines up exactly (a pair of lists past this lines up greedily). */
const LCS_MAX = 250_000;

type Op =
  | { kind: "attrs"; live: Element; set: [string, string][]; remove: string[] }
  | { kind: "text"; live: Node; value: string }
  | { kind: "remove"; live: Node }
  | { kind: "insert"; parent: Node; before: Node | null; node: Node }
  | { kind: "ids"; live: Element; ids: string[] };

/** Plans the change from `from` to `to` on `live`; null if it can't be done in place. Run the plan with `applyMorph`. */
export function planMorph(live: Document, from: string, to: string): Op[] | null {
  if (from == to) return [];
  const parser = new DOMParser();
  const a = parser.parseFromString(from, "text/html"), b = parser.parseFromString(to, "text/html");
  const ops: Op[] = [];
  const ok = attrs(live.documentElement, a.documentElement, b.documentElement, ops)
    && pair(live.head, a.head, b.head, ops)
    && pair(live.body, a.body, b.body, ops);
  return ok ? ops : null;
}

/** Carries out a plan from `planMorph`. */
export function applyMorph(live: Document, ops: Op[]): void {
  for (const op of ops) {
    if (op.kind == "attrs") {
      for (const name of op.remove) op.live.removeAttribute(name);
      for (const [name, value] of op.set) op.live.setAttribute(name, value);
    } else if (op.kind == "text") op.live.nodeValue = op.value;
    else if (op.kind == "remove") (op.live as ChildNode).remove();
    else if (op.kind == "insert") op.parent.insertBefore(live.importNode(op.node, true), op.before);
    else {
      const els = [...(op.live.hasAttribute("data-erga-id") ? [op.live] : []), ...op.live.querySelectorAll("[data-erga-id]")];
      els.forEach((el, i) => el.setAttribute("data-erga-id", op.ids[i]));
    }
  }
}

/**
 * The editor's own additions to the page, which morphing leaves be: the authors' colours, the layers of marks and carets
 * (editor.ts, caret.ts), and whatever else of Erga's is in it (data-erga: what the pages origin puts first in its head,
 * pages/reader.ts, the editor's styles and frames).
 */
const editors = (n: Node) => n.nodeType == 1 && ((n as Element).id == "erga-authors" || (n as Element).hasAttribute("data-erga-caret") || (n as Element).hasAttribute("data-erga") || (n as Element).localName.startsWith("erga-"));
const key = (n: Node) => n.nodeType == 1 ? (n as Element).outerHTML.replace(ID, "") : `${n.nodeType}:${n.nodeValue}`;
const isScript = (n: Node) => n.nodeType == 1 && ((n as Element).localName == "script" || !!(n as Element).querySelector("script"));
const ids = (n: Element) => [...(n.hasAttribute("data-erga-id") ? [n] : []), ...n.querySelectorAll("[data-erga-id]")].map((e) => e.getAttribute("data-erga-id")!);

/** Plans `live` (which is `a` on the page) into `b`, where a and b are similar nodes. */
function pair(live: Node | null, a: Node | null, b: Node | null, ops: Op[]): boolean {
  if (!a || !b || !live) return !a && !b;
  if (a.nodeType != 1) {
    if (a.nodeValue != b.nodeValue) ops.push({ kind: "text", live, value: b.nodeValue ?? "" });
    return true;
  }
  if ((a as Element).outerHTML == (b as Element).outerHTML) return true;
  return attrs(live as Element, a as Element, b as Element, ops) && children(live, a, b, ops);
}

function attrs(live: Element, a: Element, b: Element, ops: Op[]): boolean {
  if (live.localName != a.localName) return false;
  const set: [string, string][] = [], remove: string[] = [];
  for (const at of a.attributes) if (!b.hasAttribute(at.name)) remove.push(at.name);
  for (const at of b.attributes) if (a.getAttribute(at.name) != at.value) set.push([at.name, at.value]);
  if (set.length || remove.length) ops.push({ kind: "attrs", live, set, remove });
  return true;
}

function children(live: Node, a: Node, b: Node, ops: Op[]): boolean {
  const lc = [...live.childNodes].filter((n) => !editors(n)), ac = [...a.childNodes], bc = [...b.childNodes];
  // The page must still be what it was rendered from here, node for node.
  if (lc.length != ac.length || lc.some((n, i) => n.nodeName != ac[i].nodeName)) return false;
  const ak = ac.map(key), bk = bc.map(key);
  const matches = lineUp(ak, bk);
  matches.push([ac.length, bc.length]);
  let i = 0, j = 0;
  for (const [mi, mj] of matches) {
    // The gap before this match: old nodes [i, mi), new nodes [j, mj). Similar ones are morphed into each other, in order.
    const pairs = lineUp(ac.slice(i, mi).map(shape), bc.slice(j, mj).map(shape)).map(([x, y]) => [x + i, y + j] as [number, number]);
    pairs.push([mi, mj]);
    for (const [pi, pj] of pairs) {
      const before = pi < lc.length ? lc[pi] : null;
      for (; i < pi; i++) { if (isScript(ac[i])) return false; ops.push({ kind: "remove", live: lc[i] }); }
      for (; j < pj; j++) { if (isScript(bc[j])) return false; ops.push({ kind: "insert", parent: live, before, node: bc[j] }); }
      if (pi == mi) break;
      if (!pair(lc[pi], ac[pi], bc[pj], ops)) return false;
      i++; j++;
    }
    if (mi == ac.length) break;
    // Equal but for their unit numbers.
    if (ac[mi].nodeType == 1 && (ac[mi] as Element).outerHTML != (bc[mj] as Element).outerHTML) {
      const want = ids(bc[mj] as Element), have = lc[mi] as Element;
      if (ids(have).length != want.length) return false;
      ops.push({ kind: "ids", live: have, ids: want });
    }
    i = mi + 1; j = mj + 1;
  }
  return true;
}

/**
 * What a node is, for pairing a changed one with its new version: an element of the same name, text with text. A
 * script pairs with nothing (it would not run again), nor does a template (its content isn't among its children).
 */
let unique = 0;
const shape = (n: Node) => n.nodeType != 1 ? String(n.nodeType) : /^(script|template)$/.test((n as Element).localName) ? `#${unique++}` : `<${(n as Element).localName}`;

/** The longest run of equal items the two lists share, as index pairs in order (common ends first; past LCS_MAX, greedily). */
function lineUp(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] == b[s]) { out.push([s, s]); s++; }
  let ea = a.length, eb = b.length;
  const tail: [number, number][] = [];
  while (ea > s && eb > s && a[ea - 1] == b[eb - 1]) { ea--; eb--; tail.push([ea, eb]); }
  const n = ea - s, m = eb - s;
  if (n && m) {
    if (n * m <= LCS_MAX) {
      // Table of LCS lengths of the suffixes, then walk it.
      const t = new Uint32Array((n + 1) * (m + 1));
      for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--)
        t[x * (m + 1) + y] = a[s + x] == b[s + y] ? t[(x + 1) * (m + 1) + y + 1] + 1 : Math.max(t[(x + 1) * (m + 1) + y], t[x * (m + 1) + y + 1]);
      for (let x = 0, y = 0; x < n && y < m;) {
        if (a[s + x] == b[s + y]) { out.push([s + x, s + y]); x++; y++; }
        else if (t[(x + 1) * (m + 1) + y] >= t[x * (m + 1) + y + 1]) x++;
        else y++;
      }
    } else {
      const at = new Map<string, number[]>();
      for (let x = n - 1; x >= 0; x--) { const l = at.get(a[s + x]); if (l) l.push(s + x); else at.set(a[s + x], [s + x]); }
      let last = s - 1;
      for (let y = s; y < eb; y++) {
        const l = at.get(b[y]);
        while (l?.length && l[l.length - 1] <= last) l.pop();
        if (l?.length) { last = l.pop()!; out.push([last, y]); }
      }
    }
  }
  return out.concat(tail.reverse());
}
