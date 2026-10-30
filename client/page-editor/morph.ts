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

/**
 * Carries out a plan from `planMorph`. Returns what it changed: `at`, nodes whose content changed (text, a parent that
 * lost a child), and `whole`, elements that are new or have new attributes, with everything in them.
 */
export function applyMorph(live: Document, ops: Op[]): { at: Node[]; whole: Node[] } {
  const at: Node[] = [],
    whole: Node[] = [];
  for (const op of ops) {
    if (op.kind == "attrs") {
      for (const name of op.remove) op.live.removeAttribute(name);
      for (const [name, value] of op.set) op.live.setAttribute(name, value);
      whole.push(op.live);
    } else if (op.kind == "text") {
      op.live.nodeValue = op.value;
      at.push(op.live);
    } else if (op.kind == "remove") {
      if (op.live.parentNode) at.push(op.live.parentNode);
      (op.live as ChildNode).remove();
    } else if (op.kind == "insert") whole.push(op.parent.insertBefore(live.importNode(op.node, true), op.before));
    else {
      const els = [...(op.live.hasAttribute("data-erga-id") ? [op.live] : []), ...op.live.querySelectorAll("[data-erga-id]")];
      els.forEach((el, i) => el.setAttribute("data-erga-id", op.ids[i]));
    }
  }
  return { at, whole };
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
  if (a.isEqualNode(b)) return true;
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

/**
 * The live nodes that are `a`'s children, in order; null if the page no longer has them all. An element the page has
 * and its HTML doesn't (an extension's <div> or <grammarly-desktop-integration>, a password manager's button) is
 * passed over and left be: counted, it made every morph of its parent fail. An element of `a` is the live one of its
 * name that holds as many text blocks.
 */
function liveOf(live: Node, a: Node): Node[] | null {
  const lc = [...live.childNodes].filter((n) => !editors(n)),
    out: Node[] = [];
  let k = 0;
  for (const n of a.childNodes) {
    const fits = (l: Node) => l.nodeName == n.nodeName && (n.nodeType != 1 || ids(l as Element).length == ids(n as Element).length);
    while (k < lc.length && !fits(lc[k])) {
      if (lc[k].nodeType != 1) return null;
      k++;
    }
    if (k == lc.length) return null;
    out.push(lc[k++]);
  }
  for (; k < lc.length; k++) if (lc[k].nodeType != 1) return null;
  return out;
}

function children(live: Node, a: Node, b: Node, ops: Op[]): boolean {
  const ac = [...a.childNodes],
    bc = [...b.childNodes];
  // The page must still be what it was rendered from here, node for node (but for elements of its own, see liveOf).
  const lc = liveOf(live, a);
  if (!lc) return false;
  // What goes in at the end goes after the last of them, not after an extension's element.
  const end = lc.length ? lc[lc.length - 1].nextSibling : live.firstChild;
  const matches = lineUpNodes(ac, bc);
  matches.push([ac.length, bc.length]);
  let i = 0, j = 0;
  for (const [mi, mj] of matches) {
    // The gap before this match: old nodes [i, mi), new nodes [j, mj). Similar ones are morphed into each other, in order.
    const pairs = lineUp(ac.slice(i, mi).map(shape), bc.slice(j, mj).map(shape)).map(([x, y]) => [x + i, y + j] as [number, number]);
    pairs.push([mi, mj]);
    for (const [pi, pj] of pairs) {
      const before = pi < lc.length ? lc[pi] : end;
      for (; i < pi; i++) { if (isScript(ac[i])) return false; ops.push({ kind: "remove", live: lc[i] }); }
      for (; j < pj; j++) { if (isScript(bc[j])) return false; ops.push({ kind: "insert", parent: live, before, node: bc[j] }); }
      if (pi == mi) break;
      if (!pair(lc[pi], ac[pi], bc[pj], ops)) return false;
      i++; j++;
    }
    if (mi == ac.length) break;
    // Equal but for their unit numbers.
    if (ac[mi].nodeType == 1 && !ac[mi].isEqualNode(bc[mj])) {
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

/**
 * lineUp for nodes, equal but for their unit numbers. The common ends are compared node to node first (natively, with
 * no HTML made), so a change in a long page costs about the nodes around it, not the page.
 */
function lineUpNodes(a: Node[], b: Node[]): [number, number][] {
  const same = (x: Node, y: Node) => x.isEqualNode(y) || sameButIds(x, y);
  let s = 0;
  while (s < a.length && s < b.length && same(a[s], b[s])) s++;
  let ea = a.length,
    eb = b.length;
  while (ea > s && eb > s && same(a[ea - 1], b[eb - 1])) {
    ea--;
    eb--;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < s; i++) out.push([i, i]);
  for (const [x, y] of lineUp(a.slice(s, ea).map(key), b.slice(s, eb).map(key))) out.push([x + s, y + s]);
  for (let i = 0; i < a.length - ea; i++) out.push([ea + i, eb + i]);
  return out;
}

/** Whether two nodes are equal but for their unit numbers (key(x) == key(y), with no HTML made: it stops at the first difference). */
function sameButIds(x: Node, y: Node): boolean {
  if (x.nodeType != y.nodeType || x.nodeName != y.nodeName) return false;
  if (x.nodeType != 1) return x.nodeValue == y.nodeValue;
  const ex = x as Element,
    ey = y as Element;
  const at = (e: Element) => [...e.attributes].filter((a) => a.name != "data-erga-id");
  const ax = at(ex),
    ay = at(ey);
  if (ax.length != ay.length || ax.some((a, i) => a.name != ay[i].name || a.value != ay[i].value)) return false;
  let cx = x.firstChild,
    cy = y.firstChild;
  for (; cx && cy; cx = cx.nextSibling, cy = cy.nextSibling) if (!cx.isEqualNode(cy) && !sameButIds(cx, cy)) return false;
  return !cx && !cy;
}

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
