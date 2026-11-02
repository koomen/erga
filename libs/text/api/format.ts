// The styles and links on a stretch of the page's text: bold, italic, code and underline, clearing them, and a link.
// Pure: each takes the page as the rules know it (rules.ts, Page) and a range of its HTML, and gives the changes to
// make, or why it can't. The editor's style keys and its style bar call them (libs/text/ui/format.ts), and so does
// the document's object for an agent's edit (edits.ts).

import * as M from "../../../shared/manuscript";
import { ChangeSet, Text } from "@codemirror/state";
import type { Page } from "./rules";
import type { Change } from "./lists";
import { attrOf, escapeAttr, FORMAT_TAGS, linkEnding, setAttr, STYLE_TAGS, textIn, unitsIn, type InlineStyle } from "./source";

export type Segment = { u: M.Unit; from: number; to: number };

/**
 * The stretches of editable text in [from, to) (trimmed of surrounding spaces), so a range may cross inline elements
 * and paragraphs. Or why it can't be styled.
 */
export function styleSegments(page: Page, from: number, to: number): { segments: Segment[]; why: string | null } {
  if (from == to) return { segments: [], why: "Select some text to style first." };
  const segments: Segment[] = [];
  let why: string | null = null;
  for (const u of unitsIn(page.units, from, to)) {
    if (u.tag == "pre") {
      why = "Text in a code block can't be styled.";
      continue;
    }
    if (!page.editable(u)) {
      why = "That text is made by the page's script, so it can't be styled here.";
      continue;
    }
    for (const r of u.runs) {
      if (!r.editable) continue;
      let a = M.runOffset(r, Math.max(from, r.from)),
        b = M.runOffset(r, Math.min(to, r.to));
      while (a < b && /\s/.test(r.text[a])) a++;
      while (b > a && /\s/.test(r.text[b - 1])) b--;
      if (a < b) segments.push({ u, from: M.runPos(r, a), to: M.runPos(r, b) });
    }
  }
  return { segments, why: segments.length ? null : (why ?? "There's no text in the selection to style.") };
}

/** The element of one of `tags` that contains [from, to) of a unit, innermost first. */
export function enclosing(u: M.Unit, tags: string[], from: number, to: number): M.ElementNode | null {
  let node = u.node,
    found: M.ElementNode | null = null;
  while (node) {
    let next: M.ElementNode | undefined;
    for (const c of node.children)
      if (c.kind == "element" && !c.selfClosing && c.openTo <= from && to <= c.closeFrom) {
        next = c;
        break;
      }
    if (!next) break;
    if (tags.includes(next.tag)) found = next;
    node = next;
  }
  return found;
}

/** Whether all of [from, to) has the style. */
export function hasStyle(page: Page, from: number, to: number, style: InlineStyle): boolean {
  const { segments } = styleSegments(page, from, to);
  return segments.length > 0 && segments.every((g) => !!enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
}

/**
 * A style on [from, to): taken off if all of it has the style, else added to every stretch of text in it. Taking it
 * off part of an element splits the element.
 */
export function toggleStyle(page: Page, from: number, to: number, style: InlineStyle): { changes: Change[] } | { why: string } {
  const { segments, why } = styleSegments(page, from, to);
  if (why) return { why };
  const src = page.src;
  const changes: Change[] = [];
  if (hasStyle(page, from, to, style)) {
    // Group the stretches by the element that styles them, then take each element off them.
    const byEl = new Map<M.ElementNode, { from: number; to: number }>();
    for (const g of segments) {
      const el = enclosing(g.u, STYLE_TAGS[style], g.from, g.to)!;
      const r = byEl.get(el);
      byEl.set(el, r ? { from: Math.min(r.from, g.from), to: Math.max(r.to, g.to) } : { from: g.from, to: g.to });
    }
    for (const [el, r] of byEl) {
      const open = src.slice(el.from, el.openTo),
        close = src.slice(el.closeFrom, el.to);
      const atStart = !/\S/.test(src.slice(el.openTo, r.from)),
        atEnd = !/\S/.test(src.slice(r.to, el.closeFrom));
      if (atStart && atEnd) changes.push({ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to });
      else if (atStart) changes.push({ from: el.from, to: el.openTo }, { from: r.to, insert: open });
      else if (atEnd) changes.push({ from: r.from, insert: close }, { from: el.closeFrom, to: el.to });
      else changes.push({ from: r.from, insert: close }, { from: r.to, insert: open });
    }
    return { changes };
  }
  // One wrapper when the range is a single well-formed stretch with none of the style inside, else one per stretch
  // that lacks it.
  const tag = STYLE_TAGS[style][0];
  const first = segments[0],
    last = segments[segments.length - 1];
  const lacking = segments.filter((g) => !enclosing(g.u, STYLE_TAGS[style], g.from, g.to));
  const inside = new RegExp(`<(${STYLE_TAGS[style].join("|")})[\\s>]`, "i");
  if (
    first.u == last.u &&
    lacking.length == segments.length &&
    M.balanced(src, first.from, last.to) &&
    !inside.test(src.slice(first.from, last.to))
  )
    changes.push({ from: first.from, insert: `<${tag}>` }, { from: last.to, insert: `</${tag}>` });
  else for (const g of lacking) changes.push({ from: g.from, insert: `<${tag}>` }, { from: g.to, insert: `</${tag}>` });
  return { changes };
}

/**
 * Clear formatting on [from, to): every inline style (bold, italic, code, links and the other styling elements) off
 * it, splitting the ones it only partly covers, and the headings it touches made paragraphs.
 */
export function clearStyles(page: Page, from: number, to: number): { changes: Change[] } | { why: string } {
  const { segments, why } = styleSegments(page, from, to);
  if (why) return { why };
  const src = page.src;
  // The range within each paragraph it touches.
  const spans = new Map<M.Unit, { from: number; to: number }>();
  for (const g of segments) {
    const r = spans.get(g.u);
    spans.set(g.u, r ? { from: Math.min(r.from, g.from), to: Math.max(r.to, g.to) } : { from: g.from, to: g.to });
  }
  const changes: Change[] = [];
  const inserts: { at: number; insert: string; order: number }[] = [];
  const hasText = (a: number, b: number) => /\S/.test(src.slice(a, b).replace(/<[^>]*>/g, ""));
  for (const [u, s] of spans) {
    const walk = (node: M.ElementNode, depth: number) => {
      for (const c of node.children) {
        if (c.kind != "element" || c.selfClosing || c.closeFrom <= s.from || c.openTo >= s.to) continue;
        if (FORMAT_TAGS.has(c.tag)) {
          // Take the element off the stretch: drop a tag at an end the range reaches, else close or reopen it there.
          const a = Math.max(s.from, c.openTo),
            b = Math.min(s.to, c.closeFrom);
          if (hasText(c.openTo, a)) inserts.push({ at: a, insert: `</${c.tag}>`, order: -depth });
          else changes.push({ from: c.from, to: c.openTo });
          if (hasText(b, c.closeFrom)) inserts.push({ at: b, insert: src.slice(c.from, c.openTo), order: depth });
          else changes.push({ from: c.closeFrom, to: c.to });
        }
        walk(c, depth + 1);
      }
    };
    walk(u.node, 0);
    if (
      /^h[1-6]$/.test(u.tag) &&
      /^<h[1-6]/i.test(src.slice(u.openFrom, u.openFrom + 3)) &&
      /^<\/h[1-6]/i.test(src.slice(u.contentTo, u.contentTo + 4))
    )
      changes.push({ from: u.openFrom + 1, to: u.openFrom + 3, insert: "p" }, { from: u.contentTo + 2, to: u.contentTo + 4, insert: "p" });
  }
  // Tags closed at one place close innermost first; tags reopened open outermost first.
  inserts.sort((a, b) => a.at - b.at || a.order - b.order);
  const all: Change[] = [...changes, ...inserts.map((x) => ({ from: x.at, insert: x.insert }))];
  const set = ChangeSet.of(all, src.length),
    after = set.apply(Text.of(src.split("\n"))).toString();
  for (const u of spans.keys())
    if (!M.balanced(after, set.mapPos(u.from, -1), set.mapPos(u.to, 1)))
      return { why: "That selection crosses other markup; select text inside it, or around all of it." };
  return { changes: all };
}

/**
 * The link a range is about: the one around its text, or, for a caret (from == to), the one it's in or at either end
 * of.
 */
export function linkOf(page: Page, from: number, to: number): { u: M.Unit; el: M.ElementNode } | null {
  if (from == to) {
    const u = M.unitAt(page.units, from);
    const el = u && (enclosing(u, ["a"], from, from) ?? linkEnding(u, from));
    return u && el ? { u, el } : null;
  }
  const { segments } = styleSegments(page, from, to);
  const first = segments[0],
    last = segments[segments.length - 1];
  if (!first || first.u != last.u) return null;
  const el = enclosing(first.u, ["a"], first.from, last.to);
  return el ? { u: first.u, el } : null;
}

/** A link's address, its text, and whether it opens in this tab. */
export function linkInfo(page: Page, at: { u: M.Unit; el: M.ElementNode }): { href: string; text: string; self: boolean } {
  const open = page.src.slice(at.el.from, at.el.openTo);
  return {
    href: attrOf(open, "href") ?? "",
    text: textIn([at.u], at.el.openTo, at.el.closeFrom),
    self: (attrOf(open, "target") ?? "").toLowerCase() == "_self",
  };
}

/** A change to a link: an empty url takes it off; text and self, when given, replace its own. */
export interface LinkChange {
  url: string;
  text?: string;
  self?: boolean;
}

/**
 * Links [from, to), or changes the link it's in (linkOf): its address, its text (when given and different) and
 * whether it opens in this tab (target="_self"; without one, a reader's click opens a new tab). An empty address
 * takes the link off and keeps its text. `text`: where the link's text is after (textFrom, textTo), and whether it
 * was replaced.
 */
export function applyLink(
  page: Page,
  from: number,
  to: number,
  edit: LinkChange
): { changes: Change[]; text: { from: number; to: number; replaced: boolean } } | { why: string } {
  const src = page.src;
  const href = escapeAttr(edit.url);
  const at = linkOf(page, from, to);
  const changes: Change[] = [];
  let textFrom: number, textTo: number;
  if (at) {
    const { u, el } = at;
    if (!page.editable(u)) return { why: "That text is made by the page's script, so it can't be linked here." };
    if (!edit.url) changes.push({ from: el.from, to: el.openTo }, { from: el.closeFrom, to: el.to });
    else {
      let open = setAttr(src.slice(el.from, el.openTo), "href", href);
      if (edit.self != null) open = setAttr(open, "target", edit.self ? "_self" : null);
      changes.push({ from: el.from, to: el.openTo, insert: open });
    }
    [textFrom, textTo] = [el.openTo, el.closeFrom];
  } else {
    const { segments, why } = styleSegments(page, from, to);
    if (why) return { why };
    const first = segments[0],
      last = segments[segments.length - 1];
    if (first.u != last.u) return { why: "A link can't span paragraphs; select text within one." };
    if (!edit.url) return { changes: [], text: { from: first.from, to: last.to, replaced: false } };
    if (!M.balanced(src, first.from, last.to))
      return { why: "That selection crosses other styling; select text inside it, or around all of it." };
    changes.push(
      { from: first.from, insert: `<a href="${href}"${edit.self ? ' target="_self"' : ""}>` },
      { from: last.to, insert: "</a>" }
    );
    [textFrom, textTo] = [first.from, last.to];
  }
  // New text replaces the link's (and any styling inside it).
  const text = edit.text?.replace(/\s+/g, " ").trim();
  const replaced = !!edit.url && !!text && text != textIn(page.units, textFrom, textTo);
  if (replaced) changes.push({ from: textFrom, to: textTo, insert: M.escapeHtmlText(text!) });
  return { changes, text: { from: textFrom, to: textTo, replaced } };
}
