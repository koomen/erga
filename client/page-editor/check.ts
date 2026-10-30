// The check that the page shows its HTML: the live page's body, walked together with a parse of the HTML it should
// show, and the first place where they differ. The tests run it after every change (a difference fails the test); see
// docs/design/view.md.
//
// What it leaves out: the editor's own nodes and attributes (its layers, contenteditable, spellcheck, its erga-
// classes); text that is only whitespace (the page shows none of it); the inside of a script, style or template
// (the browser runs them, and the editor never patches them); parts the page made its own (`skip`: a part that
// differed when the editor started, as the page's script built it, or a text block the editor locked); elements of
// others in the page (`foreign`: an extension's element, which the editor never drew); and attributes that others
// changed (`theirs`: a slide's class, a <details> a click opened, a pan's transform).

/** The editor's own nodes in the page: its layers, its style, its authors' colours. */
export const editors = (n: Node) =>
  n.nodeType == 1 &&
  ((n as Element).id == "erga-authors" ||
    (n as Element).hasAttribute("data-erga-caret") ||
    (n as Element).hasAttribute("data-erga") ||
    (n as Element).localName.startsWith("erga-"));

const OPAQUE = new Set(["script", "style", "template", "noscript", "iframe"]);
/** Attributes the editor puts on the page's elements while it edits. */
const EDITOR_ATTRS = new Set(["contenteditable", "spellcheck", "data-erga-id"]);

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
 * `skip(liveEl)`: a part not to check. `foreign(liveEl)`: an element the editor never drew, passed over.
 */
export function differ(
  live: Element,
  want: Element,
  skip: (e: Element) => boolean,
  foreign: (e: Element) => boolean,
  theirs: Theirs
): { at: Element; message: string } | null {
  if (skip(live)) return null;
  const at = (message: string, n: Node = live) => ({ at: n.nodeType == 1 ? (n as Element) : (n.parentElement ?? live), message });
  if (live.localName != want.localName) return at(`<${live.localName}> where the HTML has <${want.localName}>: ${where(live)}`);
  if (live.localName != "body") {
    const a = attrs(live, theirs, live),
      b = attrs(want, theirs, live);
    if (a != b) return at(`attributes [${a}] where the HTML has [${b}]: ${where(live)}`);
  }
  if (OPAQUE.has(live.localName)) return null;
  const lc = [...live.childNodes].filter(shown),
    wc = [...want.childNodes].filter(shown);
  let i = 0;
  for (const w of wc) {
    // Elements of others before it are passed over.
    while (i < lc.length && lc[i].nodeType == 1 && lc[i].nodeName != w.nodeName && foreign(lc[i] as Element)) i++;
    const l = lc[i++];
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
      const d = differ(l as Element, w as Element, skip, foreign, theirs);
      if (d) return d;
    }
  }
  for (; i < lc.length; i++)
    if (lc[i].nodeType != 1 || !foreign(lc[i] as Element))
      return at(
        `${lc[i].nodeType == 1 ? `<${(lc[i] as Element).localName}>` : `text “${lc[i].nodeValue!.trim().slice(0, 40)}”`} that the HTML does not have: ${where(lc[i])}`,
        live
      );
  return null;
}

/**
 * Watches a page for the check: the elements the editor made (`mine`, taken as it makes them) and those that came
 * from others since the editor started (an extension's). An element in the page when the editor started is the page's.
 */
export class Ownership {
  private ours = new WeakSet<Node>();
  private changedBy = new WeakMap<Element, Set<string>>();
  private observer: MutationObserver;
  /** Parts of the page that differed from the HTML when the editor started (the page's script built them). */
  readonly owned = new WeakSet<Element>();

  constructor(doc: Document) {
    for (const e of doc.body.querySelectorAll("*")) this.ours.add(e);
    // Delivered later, so made by others (the editor takes its own at once: mine): their attributes are theirs.
    this.observer = new (doc.defaultView as Window & typeof globalThis).MutationObserver((records) => this.others(records));
    this.observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
  }

  /** The nodes added since the last call were the editor's own. */
  mine(): void {
    for (const r of this.observer.takeRecords())
      for (const n of r.addedNodes)
        if (n.nodeType == 1) {
          this.ours.add(n);
          for (const e of (n as Element).querySelectorAll("*")) this.ours.add(e);
        }
  }

  /** What others changed: the elements they added stay foreign (not ours), and the attributes they set are theirs. */
  private others(records: MutationRecord[]): void {
    for (const r of records)
      if (r.type == "attributes" && r.attributeName) {
        const t = r.target as Element;
        const set = this.changedBy.get(t) ?? new Set<string>();
        set.add(r.attributeName);
        this.changedBy.set(t, set);
      }
  }

  foreign = (e: Element) => !this.ours.has(e);
  theirs: Theirs = (e, name) => !!this.changedBy.get(e)?.has(name);

  stop(): void {
    this.observer.disconnect();
  }
}
