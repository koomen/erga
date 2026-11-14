// A page's view, which Erga keeps when the page loads again in its place (an edit that needs it, a reload by the
// person): where the window and each element that scrolls are scrolled to, and the page's history.state. The page's
// first script (client/inline/reader.ts) writes it in this tab's storage as it changes, and the page that loads in its
// place (its address says erga-keep) has it before its first paint. The page's place in its address (#3, a canvas's
// camera) goes with the address itself. A view that only the page's script holds (in a variable) is lost: the page
// keeps it in its address (agents/document/PROMPT.md), which Erga and every browser bring back.

/** Where an element is scrolled to: its path from <html> (each step a child's index), its tag, left and top. */
type Scrolled = [path: string, tag: string, left: number, top: number];

export interface View {
  x: number;
  y: number;
  els: Scrolled[];
  /** history.state, when it is plain JSON. */
  state?: unknown;
}

/** At most this many elements' scroll is kept, and a history.state of at most this many characters. */
const MOST = 40,
  STATE_MOST = 100_000;

function pathOf(el: Element): string | null {
  const steps: number[] = [];
  for (let e = el; e.parentElement; e = e.parentElement) steps.unshift([...e.parentElement.children].indexOf(e));
  return el.isConnected ? steps.join("/") : null;
}

function at(d: Document, path: string, tag: string): Element | null {
  let e: Element | undefined = d.documentElement;
  for (const i of path ? path.split("/") : []) e = e?.children[Number(i)];
  return e && e.tagName == tag ? e : null;
}

/**
 * The view now: the window's scroll, and that of each of `scrolled` (the elements that have scrolled; those no longer
 * on the page go from the set) that is not at its start.
 */
export function viewOf(w: Window, scrolled: Set<Element>): View {
  const els: Scrolled[] = [];
  for (const el of scrolled) {
    const path = pathOf(el);
    if (path == null) scrolled.delete(el);
    else if ((el.scrollLeft || el.scrollTop) && els.length < MOST) els.push([path, el.tagName, el.scrollLeft, el.scrollTop]);
  }
  const view: View = { x: w.scrollX, y: w.scrollY, els };
  try {
    const state = w.history.state,
      text = state == null ? "" : JSON.stringify(state);
    if (text && text.length < STATE_MOST) view.state = JSON.parse(text);
  } catch {
    /* not plain JSON: the page keeps it itself */
  }
  return view;
}

/**
 * Scrolls the window and the elements to where `v` says, as far as the page is there yet, and adds the elements to
 * `scrolled`. False while a place is still out of reach (the page's content is still coming).
 */
export function showView(w: Window, v: View, scrolled: Set<Element>): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  if (!near(w.scrollX, v.x) || !near(w.scrollY, v.y)) w.scrollTo(v.x, v.y);
  let there = near(w.scrollX, v.x) && near(w.scrollY, v.y);
  for (const [path, tag, left, top] of v.els) {
    const el = at(w.document, path, tag);
    if (el && (!near(el.scrollLeft, left) || !near(el.scrollTop, top))) el.scrollTo(left, top);
    if (el) scrolled.add(el);
    there &&= !!el && near(el.scrollLeft, left) && near(el.scrollTop, top);
  }
  return there;
}

/** `v` from storage's text, or null if it isn't one. */
export function readView(text: string | null): View | null {
  try {
    const v = JSON.parse(text ?? "null") as View | null;
    const n = (x: unknown) => typeof x == "number" && Number.isFinite(x);
    if (!v || !n(v.x) || !n(v.y) || !Array.isArray(v.els) || v.els.length > MOST) return null;
    if (!v.els.every((e) => Array.isArray(e) && typeof e[0] == "string" && typeof e[1] == "string" && n(e[2]) && n(e[3]))) return null;
    return v;
  } catch {
    return null;
  }
}
