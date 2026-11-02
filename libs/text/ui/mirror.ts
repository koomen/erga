// The binding between a parse of the page's HTML (shared/manuscript.ts, parseHtml) and the live page the browser made
// from it: each element and text node of the HTML's body that the page shows is tied to its live node, by object. A
// change to the HTML (a CodeMirror ChangeSet) then becomes the exact change to the page: the smallest element that holds
// the change is brought to its new content, and only it (reconcile). See docs/design/view.md.
//
// A node is the same node after a change when its start is untouched and maps to the new node's start: an element by
// its open tag (its content can change), a text node by its first character. A node the same in all of its range is
// kept whole, with its subtree, its state, and what the page's script did to it. Nodes of others in the page (an
// extension's element, the editor's layers) are not bound, and stay where they are.

import type { ChangeSet } from "@codemirror/state";
import * as M from "../../../shared/manuscript";

/** Elements a change in which makes the page load again: the browser runs them, an edit in place would not. */
const RUN = new Set(["script", "style"]);
/** Elements whose children the browser builds its own way (a <tbody> it adds, SVG's namespace): made from HTML, never in parts. */
const WHOLE = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup", "svg", "math", "select", "template", "noscript"]);
/** Elements whose content the binding does not go into. */
const OPAQUE = new Set(["svg", "math", "select", "template", "noscript", "textarea", "title"]);
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;

type Range = { fa: number; ta: number };

export class Mirror {
  /** Source node to live node. */
  private dom = new Map<M.SourceNode, Node>();
  /** Live node to source node. */
  private live = new WeakMap<Node, M.SourceNode>();

  private constructor(
    readonly doc: Document,
    readonly root: M.ElementNode,
    readonly body: M.ElementNode
  ) {}

  /** Binds a parse of `src` to the page in `doc`; null if the page has no body. */
  static bind(doc: Document, root: M.ElementNode, src: string): Mirror | null {
    const body = findBody(root);
    if (!doc.body) return null;
    const m = new Mirror(doc, root, body);
    // The <html> and the <head> too, where the source has them: their attributes, its styles and title change in place.
    const html = root.children.find((c): c is M.ElementNode => c.kind == "element" && c.tag == "html");
    const head = (html ?? root).children.find((c): c is M.ElementNode => c.kind == "element" && c.tag == "head");
    if (html) m.set(html, doc.documentElement);
    if (head && doc.head) {
      m.set(head, doc.head);
      m.bindChildren(head, doc.head, src);
    }
    m.set(body, doc.body);
    m.bindChildren(body, doc.body, src);
    return m;
  }

  nodeOf(n: M.SourceNode): Node | undefined {
    return this.dom.get(n);
  }

  sourceOf(n: Node): M.SourceNode | undefined {
    return this.live.get(n);
  }

  /**
   * Draws a bound element's content again from the HTML, keeping none of it: what others put in it goes too (their
   * nodes in place of ours). The source nodes stay the same objects, bound to the new live nodes.
   */
  redraw(s: M.ElementNode, src: string, decode: M.EntityDecoder): void {
    const el = this.dom.get(s);
    if (!el) return;
    const unbind = (n: M.ElementNode) => {
      for (const c of n.children) {
        const l = this.dom.get(c);
        this.dom.delete(c);
        if (l) this.live.delete(l);
        if (c.kind == "element") unbind(c);
      }
    };
    unbind(s);
    (el as Element).replaceChildren();
    s.children = this.build(s.children, s, el, src, new Map(), new Map(), decode);
    for (const k of s.children) if (k.kind == "element") k.parent = s;
  }

  private set(s: M.SourceNode, n: Node): void {
    this.dom.set(s, n);
    this.live.set(n, s);
    ours.add(n);
  }

  /** Binds the children of a source element to those of its live element, in order, passing over nodes of others. */
  private bindChildren(s: M.ElementNode, el: Node, src: string): void {
    if (OPAQUE.has(s.tag)) return;
    let cur = el.firstChild;
    for (const c of s.children) {
      if (c.kind == "text") {
        // Past the elements of others to the text; a text of only whitespace the browser can drop has no live node.
        if (/\S/.test(src.slice(c.from, c.to))) while (cur && cur.nodeType != 3) cur = cur.nextSibling;
        if (cur?.nodeType == 3) {
          this.set(c, cur);
          cur = cur.nextSibling;
        }
        continue;
      }
      if (c.tag == "#comment" || c.tag.startsWith("!")) continue;
      // Past the nodes of others (an extension's element) to the element of this name.
      // A row of a table whose HTML has no <tbody> is in the one the browser adds.
      let at = cur;
      while (at && !(at.nodeType == 1 && (at as Element).localName == c.tag))
        at = c.tag == "tr" && at.nodeName == "TBODY" && s.tag == "table" ? at.firstChild : at.nextSibling;
      // Not in the page here (an element the browser put in the head: a page with no <body> tag): left unbound.
      if (!at) continue;
      this.set(c, at);
      this.bindChildren(c, at, src);
      cur = at.nextSibling;
    }
  }

  /**
   * Brings the page to `newSrc`, the HTML after `changes`, in place: the smallest bound element that holds every change
   * gets its new content. The tree (`root`) is the parse of `newSrc` after it. Returns that element, or null, with
   * nothing changed, if the change can't be made in place (a script or style changed, or the change is outside the
   * body): the page must then load again.
   */
  reconcile(changes: ChangeSet, oldSrc: string, newSrc: string, decode: M.EntityDecoder): M.ElementNode | null {
    const ranges: Range[] = [];
    changes.iterChangedRanges((fa, ta) => ranges.push({ fa, ta }));
    if (!ranges.length) return null;
    const lo = ranges[0].fa,
      hi = ranges[ranges.length - 1].ta;
    // The deepest bound element that holds every change, its tags included.
    let t: M.ElementNode | null = null;
    for (let at = this.root; ; ) {
      const c = at.children.find((c): c is M.ElementNode => c.kind == "element" && c.from <= lo && hi <= c.to);
      if (!c) break;
      if (this.dom.has(c)) t = c;
      at = c;
    }
    const live = t && (this.dom.get(t) as Element);
    // Its attributes alone (a theme's class on the <body>, a to-do's style): set in place, those that changed.
    if (t && live && lo > t.from + t.tag.length && hi < t.openTo) {
      const openTo = changes.mapPos(t.openTo, -1);
      const was = this.attrsOf(oldSrc.slice(t.from, t.openTo), t.tag),
        now = this.attrsOf(newSrc.slice(changes.mapPos(t.from, 1), openTo), t.tag);
      if (was && now) {
        mapTree(this.root, changes);
        for (const [name] of was) if (!now.has(name)) live.removeAttribute(name);
        for (const [name, value] of now) if (was.get(name) !== value) live.setAttribute(name, value);
        return t;
      }
    }
    // The text of a style or the title: set in place (a script's: the page loads again).
    if (t && live && (t.tag == "style" || t.tag == "title") && t.openTo <= lo && hi <= t.closeFrom) {
      mapTree(this.root, changes);
      for (const c of t.children) {
        c.from = t.openTo;
        c.to = t.closeFrom;
      }
      const text = newSrc.slice(t.openTo, t.closeFrom);
      live.textContent = t.tag == "title" ? M.decodeText(newSrc, t.openTo, t.closeFrom, false, decode).text : text;
      return t;
    }
    // The region: the deepest bound element whose content holds every change.
    let e = this.body;
    if (!(e.openTo <= lo && hi <= e.closeFrom)) return null;
    for (;;) {
      const c = e.children.find(
        (c): c is M.ElementNode => c.kind == "element" && !c.selfClosing && c.openTo <= lo && hi <= c.closeFrom && c.closeFrom > c.openTo
      );
      if (!c || !this.dom.has(c) || WHOLE.has(c.tag) || RUN.has(c.tag) || M.ATOMIC.has(c.tag) || c.tag == "textarea" || c.tag == "title")
        break;
      e = c;
    }
    /** A change strictly inside [from, to): it overlaps it, or inserts inside it. */
    const touches = (from: number, to: number) =>
      ranges.some((r) => (r.fa < to && r.ta > from) || (r.fa == r.ta && from < r.fa && r.fa < to));
    // Its new content, parsed with its own tags around it: in context, so a tag the change typed that closes the
    // element (Enter in a paragraph: "</p><p>") shows as it does in the page. If the element is no longer one
    // element there, its parent is the region.
    let fresh: M.ElementNode;
    for (;;) {
      if (e == this.body) {
        const openTo = changes.mapPos(e.openTo, -1);
        fresh = M.parseHtml(newSrc.slice(openTo, changes.mapPos(e.closeFrom, 1)));
        shift(fresh, openTo);
        break;
      }
      const from = changes.mapPos(e.from, 1),
        to = changes.mapPos(e.to, -1);
      const alone = M.parseHtml(newSrc.slice(from, to)).children;
      const one = alone.length == 1 && alone[0].kind == "element" ? alone[0] : null;
      if (one && one.tag == e.tag && one.from == 0 && one.to == to - from && one.closeFrom == changes.mapPos(e.closeFrom, 1) - from) {
        fresh = one;
        shift(fresh, from);
        break;
      }
      let up = e.parent;
      while (up && up != this.body && !this.dom.has(up)) up = up.parent;
      if (!up) return null;
      e = up;
    }

    // The old nodes in the region that can be kept, by where their start is now.
    const keep = new Map<number, M.SourceNode[]>();
    const old: M.SourceNode[] = [];
    let runs = false;
    const collect = (n: M.ElementNode) => {
      for (const c of n.children) {
        old.push(c);
        if (c.kind == "text") {
          if (!touches(c.from, c.from + 1) && this.dom.has(c)) add(keep, changes.mapPos(c.from, 1), c);
          continue;
        }
        const whole = !touches(c.from, c.to);
        if (RUN.has(c.tag) && !whole) runs = true;
        if (this.dom.has(c) && !touches(c.from, c.openTo)) add(keep, changes.mapPos(c.from, 1), c);
        collect(c);
      }
    };
    collect(e);
    if (runs) return null;
    // Planned before anything changes: a script or style that would be new is a reason to load the page again.
    const wholeOld = new Map<M.SourceNode, { from: number; to: number }>();
    for (const list of keep.values())
      for (const n of list) if (!touches(n.from, n.to)) wholeOld.set(n, { from: changes.mapPos(n.from, 1), to: changes.mapPos(n.to, -1) });
    const isKept = (n: M.SourceNode) => {
      const o = keep
        .get(n.from)
        ?.find((o) => o.kind == n.kind && (o.kind == "text" || (o as M.ElementNode).tag == (n as M.ElementNode).tag));
      const w = o && wholeOld.get(o);
      return !!w && w.from == n.from && w.to == n.to;
    };
    const plan = (n: M.ElementNode): boolean =>
      n.children.every((c) => c.kind == "text" || (RUN.has(c.tag) ? isKept(c) : isKept(c) || plan(c)));
    if (!plan(fresh)) return null;

    // The tree's positions, outside the region and in what is kept whole, move through the change.
    mapTree(this.root, changes);
    const liveE = this.dom.get(e)!;
    for (const n of old) {
      if (wholeOld.has(n)) continue;
      const l = this.dom.get(n);
      this.dom.delete(n);
      if (l) this.live.delete(l);
    }
    const kids = this.build(fresh.children, e, liveE, newSrc, keep, wholeOld, decode);
    e.children = kids;
    for (const k of kids) if (k.kind == "element") k.parent = e;
    return e;
  }

  /** An open tag's attributes, as the browser reads them; null if it is not an open tag of `tag`. */
  private attrsOf(open: string, tag: string): Map<string, string> | null {
    const m = new RegExp(`^<${tag}(?=[\\s/>])`, "i").exec(open);
    if (!m) return null;
    const tpl = this.doc.createElement("template");
    tpl.innerHTML = "<span" + open.slice(m[0].length);
    const el = tpl.content.firstElementChild;
    return el ? new Map([...el.attributes].map((a) => [a.name, a.value])) : null;
  }

  /** The new children of a live element, kept or made, in place in it; returns their source nodes. */
  private build(
    nodes: M.SourceNode[],
    owner: M.ElementNode,
    parent: Node,
    src: string,
    keep: Map<number, M.SourceNode[]>,
    wholeOld: Map<M.SourceNode, { from: number; to: number }>,
    decode: M.EntityDecoder
  ): M.SourceNode[] {
    const out: M.SourceNode[] = [],
      liveKids: Node[] = [];
    const take = (n: M.SourceNode) => {
      const list = keep.get(n.from);
      const i =
        list?.findIndex((o) => o.kind == n.kind && (o.kind == "text" || (o as M.ElementNode).tag == (n as M.ElementNode).tag)) ?? -1;
      return i >= 0 ? list!.splice(i, 1)[0] : undefined;
    };
    for (const n of nodes) {
      const o = take(n);
      if (n.kind == "text") {
        const dropNl = (owner.tag == "pre" || owner.tag == "listing") && n.from == owner.openTo;
        const { text } = M.decodeText(src, n.from, n.to, false, decode, dropNl);
        if (!text) continue;
        let l = o && this.dom.get(o);
        if (l && l.nodeValue != text && l.nodeValue!.replace(/ /g, " ") != text) l.nodeValue = text;
        if (!l) l = this.doc.createTextNode(text);
        if (o) this.dom.delete(o);
        this.set(n, l);
        out.push(n);
        liveKids.push(l);
        continue;
      }
      if (n.tag == "#comment" || n.tag.startsWith("!")) {
        out.push(n);
        continue;
      }
      const w = o && wholeOld.get(o);
      // A table, an SVG, a select whose content changed is made again from its HTML, as the browser makes it.
      const o2 = o && WHOLE.has(n.tag) && !(w && w.from == n.from && w.to == n.to) ? undefined : o;
      if (o && !o2) {
        const gone = this.dom.get(o);
        if (gone) this.live.delete(gone);
        this.dom.delete(o);
      }
      if (o2 && w && w.from == n.from && w.to == n.to) {
        // The same in all of its range: kept whole, with its subtree and its binding.
        out.push(o);
        liveKids.push(this.dom.get(o)!);
        continue;
      }
      let l = o2 && (this.dom.get(o2) as Element | undefined);
      if (o2) {
        this.dom.delete(o2);
        for (const k of [...(o2 as M.ElementNode).children]) if (!wholeOld.has(k)) this.dom.delete(k);
      }
      if (!l) {
        const tpl = this.doc.createElement("template");
        if (WHOLE.has(n.tag) || M.ATOMIC.has(n.tag)) {
          // Made from its HTML whole, as the browser makes it, and bound inside the same way as at the start.
          tpl.innerHTML = src.slice(n.from, n.to);
          l = tpl.content.firstElementChild!;
          this.set(n, l);
          this.bindChildren(n, l, src);
          out.push(n);
          liveKids.push(l);
          continue;
        }
        tpl.innerHTML = src.slice(n.from, n.openTo);
        l = tpl.content.firstElementChild!;
        if (!l || l.localName != n.tag) throw new Error(`<${n.tag}> did not parse alone`);
      }
      this.set(n, l);
      if (!VOID.test(n.tag)) {
        const kids = this.build(n.children, n, l, src, keep, wholeOld, decode);
        n.children = kids;
        for (const k of kids) if (k.kind == "element") k.parent = n;
      }
      out.push(n);
      liveKids.push(l);
    }
    this.place(parent, liveKids);
    return out;
  }

  /** Puts `kids` in `parent` in this order, the bound nodes no longer there out, others' nodes where they are. */
  private place(parent: Node, kids: Node[]): void {
    const want = new Set(kids);
    let cur = parent.firstChild;
    for (const k of kids) {
      while (cur && cur != k && !want.has(cur) && !this.live.has(cur) && !wasOurs(cur)) cur = cur.nextSibling;
      if (cur == k) {
        cur = cur.nextSibling;
        continue;
      }
      parent.insertBefore(k, cur);
    }
    for (let n = parent.firstChild; n; ) {
      const next = n.nextSibling;
      if (!want.has(n) && wasOurs(n)) n.parentNode!.removeChild(n);
      n = next;
    }
  }
}

/** Whether a live node was drawn from the HTML (it was bound, or is a text node: others' text is rare). */
function wasOurs(n: Node): boolean {
  return (
    n.nodeType == 3 ||
    (n.nodeType == 1 && !(n as Element).localName.startsWith("erga-") && !(n as Element).hasAttribute("data-erga") && ours.has(n))
  );
}
/** Every live node the mirror ever bound (a WeakSet: a node unbound by a change is still ours to remove). */
const ours = new WeakSet<Node>();

function add(map: Map<number, M.SourceNode[]>, at: number, n: M.SourceNode): void {
  const list = map.get(at);
  if (list) list.push(n);
  else map.set(at, [n]);
}

/** The source's <body>; with no <body> tag, the element the page's content is in (the <html>, or the whole source). */
function findBody(root: M.ElementNode): M.ElementNode {
  for (const c of root.children) {
    if (c.kind != "element") continue;
    if (c.tag == "body") return c;
    if (c.tag == "html") return findBody(c);
  }
  return root;
}

function shift(n: M.ElementNode, by: number): void {
  for (const c of n.children) {
    c.from += by;
    c.to += by;
    if (c.kind == "element") {
      c.openTo += by;
      c.closeFrom += by;
      shift(c, by);
    }
  }
}

/** Moves every position in the tree through `changes`: an insertion at an element's edge goes outside it, at its content's edge inside. */
function mapTree(n: M.ElementNode, changes: ChangeSet): void {
  n.from = changes.mapPos(n.from, 1);
  n.openTo = changes.mapPos(n.openTo, -1);
  n.closeFrom = changes.mapPos(n.closeFrom, 1);
  n.to = changes.mapPos(n.to, -1);
  for (const c of n.children) {
    if (c.kind == "text") {
      c.from = changes.mapPos(c.from, 1);
      c.to = changes.mapPos(c.to, -1);
    } else mapTree(c, changes);
  }
}
