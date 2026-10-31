// The check that the page shows its HTML: the live page's body, walked together with a parse of the HTML it should
// show, and the first place where they differ. The tests run it after every change (a difference fails the test); see
// docs/design/view.md.
//
// What it leaves out: the editor's own nodes and attributes (its layers, contenteditable, spellcheck, its erga-
// classes); text that is only whitespace (the page shows none of it); the inside of a script, style or template
// (the browser runs them, and the editor never patches them); parts the page made its own (`skip`: a part that
// differed when the editor started, as the page's script built it, or a text block the editor locked); elements of
// others in the page (`foreign`: an extension's element, which the editor never drew, and which is looked through
// where it holds nodes the editor drew: `bound`); and attributes that others changed (`theirs`: a slide's class, a
// <details> a click opened, a pan's transform).

/** The editor's own nodes in the page: its layers, its style, its authors' colours. */
export const editors = (n: Node) =>
  n.nodeType == 1 &&
  ((n as Element).id == "erga-authors" ||
    (n as Element).hasAttribute("data-erga-caret") ||
    (n as Element).hasAttribute("data-erga") ||
    (n as Element).localName.startsWith("erga-"));

const OPAQUE = new Set(["script", "style", "template", "noscript", "iframe"]);
/** Attributes the editor puts on the page's elements while it edits. */
const EDITOR_ATTRS = new Set(["contenteditable", "spellcheck", "data-erga-text"]);

const shown = (n: Node) => (n.nodeType == 1 ? !editors(n) : n.nodeType == 3 && /\S/.test(n.nodeValue!));
const norm = (s: string) => s.replace(/ /g, " ");

/** Whose an element's attribute is: an attribute others changed is the page's state, not its HTML. */
export type Theirs = (e: Element, name: string) => boolean;

function attrs(e: Element, theirs: Theirs, live: Element): string {
  const out: string[] = [];
  for (const a of e.attributes) {
    if (EDITOR_ATTRS.has(a.name) || theirs(live, a.name)) continue;
    let v = a.value;
    if (a.name == "class") {
      v = v
        .split(/\s+/)
        .filter((c) => c && !c.startsWith("erga-"))
        .join(" ");
      if (!v) continue;
    }
    out.push(`${a.name}=${JSON.stringify(v)}`);
  }
  return out.sort().join(" ");
}

/** Where a node is, for a message: its path of tags from the body, and its text. */
function where(n: Node): string {
  const path: string[] = [];
  for (let e = n.nodeType == 1 ? (n as Element) : n.parentElement; e && e.localName != "body"; e = e.parentElement) {
    const i = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName == e!.localName).indexOf(e) : 0;
    path.unshift(`${e.localName}[${i}]`);
  }
  const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
  return `body>${path.join(">")}${text ? ` “${text.length > 40 ? text.slice(0, 37) + "…" : text}”` : ""}`;
}

/**
 * The first difference between the live element `live` and the parsed element `want`, or null if the page shows it.
 * `skip(liveNode)`: a part not to check. `foreign(liveEl)`: an element the editor never drew, passed over. `bound(node)`:
 * a node the editor drew (mirror.ts), its own wherever others moved it. A difference is `at` the node the page has and
 * the HTML doesn't, else at the element whose content differs.
 */
export function differ(
  live: Element,
  want: Element,
  skip: (n: Node) => boolean,
  foreign: (n: Node) => boolean,
  theirs: Theirs,
  bound: (n: Node) => boolean
): { at: Node; message: string } | null {
  if (skip(live)) return null;
  const at = (message: string, n: Node = live) => ({ at: n, message });
  if (live.localName != want.localName) return at(`<${live.localName}> where the HTML has <${want.localName}>: ${where(live)}`);
  if (live.localName != "body") {
    const a = attrs(live, theirs, live),
      b = attrs(want, theirs, live);
    if (a != b) return at(`attributes [${a}] where the HTML has [${b}]: ${where(live)}`);
  }
  if (OPAQUE.has(live.localName)) return null;
  // (Text that others added, as the page's script does, is passed over; their elements, where they are. An element of
  // theirs around nodes the editor drew, an extension's <span> around a word, is looked through.)
  const others = (n: Node) => foreign(n) && !bound(n);
  const holds = (n: Node): boolean => [...n.childNodes].some((c) => bound(c) || holds(c));
  const kids = (n: Node): Node[] => [...n.childNodes].flatMap((c) => (c.nodeType == 1 && others(c) && holds(c) ? kids(c) : [c]));
  const lc = kids(live).filter((n) => shown(n) && !(n.nodeType == 3 && others(n))),
    wc = [...want.childNodes].filter(shown);
  let i = 0;
  for (const w of wc) {
    // Elements of others before it are passed over.
    while (i < lc.length && lc[i].nodeType == 1 && lc[i].nodeName != w.nodeName && others(lc[i])) i++;
    const l = lc[i++];
    // A part the page owns keeps its place; what is in it is not checked.
    if (l && skip(l)) continue;
    if (!l)
      return at(
        `missing ${w.nodeType == 1 ? `<${(w as Element).localName}>` : `text “${w.nodeValue!.trim().slice(0, 40)}”`} at the end of ${where(live)}`
      );
    if (l.nodeType != w.nodeType || l.nodeName != w.nodeName)
      return at(
        `${l.nodeType == 1 ? `<${(l as Element).localName}>` : "text"} where the HTML has ${w.nodeType == 1 ? `<${(w as Element).localName}>` : `text “${w.nodeValue!.trim().slice(0, 40)}”`}: ${where(l)}`,
        live
      );
    if (l.nodeType == 3) {
      if (norm(l.nodeValue!).replace(/\s+/g, " ") != norm(w.nodeValue!).replace(/\s+/g, " "))
        return at(`text “${l.nodeValue!.trim().slice(0, 40)}” where the HTML has “${w.nodeValue!.trim().slice(0, 40)}”: ${where(l)}`, l);
    } else {
      const d = differ(l as Element, w as Element, skip, foreign, theirs, bound);
      if (d) return d;
    }
  }
  for (; i < lc.length; i++)
    if (!skip(lc[i]) && (lc[i].nodeType != 1 || !others(lc[i])))
      return at(
        `${lc[i].nodeType == 1 ? `<${(lc[i] as Element).localName}>` : `text “${lc[i].nodeValue!.trim().slice(0, 40)}”`} that the HTML does not have: ${where(lc[i])}`,
        lc[i]
      );
  return null;
}

/**
 * Watches a page for the check: the elements others added since the editor started (an extension's, the page
 * script's), and the attributes they changed. The editor takes the records of its own changes at once (`mine`), so
 * the records delivered later are others'. An element in the page when the editor started is the page's.
 */
export class Ownership {
  private added = new WeakSet<Node>();
  private changedBy = new WeakMap<Element, Set<string>>();
  private observer: MutationObserver;
  /** Parts of the page that differed from the HTML when the editor started (the page's script built them). */
  readonly owned = new WeakSet<Node>();

  constructor(doc: Document) {
    this.observer = new (doc.defaultView as Window & typeof globalThis).MutationObserver((records) => this.others(records));
    this.observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
  }

  /** The changes since the last call were the editor's own (it moves others' nodes, and they stay theirs). */
  mine(): void {
    this.observer.takeRecords();
  }

  private others(records: MutationRecord[]): void {
    for (const r of records)
      if (r.type == "childList") for (const n of r.addedNodes) this.added.add(n);
      else if (r.attributeName) {
        const t = r.target as Element;
        const set = this.changedBy.get(t) ?? new Set<string>();
        set.add(r.attributeName);
        this.changedBy.set(t, set);
      }
  }

  foreign = (n: Node) => this.added.has(n);
  theirs: Theirs = (e, name) => !!this.changedBy.get(e)?.has(name);

  stop(): void {
    this.observer.disconnect();
  }
}
