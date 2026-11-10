// What an agent's edit broke in a page's HTML, said in its tool's answer: the two faults Erga tells agents to avoid
// (server/operations/documents.ts). An element with no end tag: the browser then puts what follows inside it. Text
// beside blocks: it is in no unit (shared/manuscript.ts), so nobody can edit it by hand. Only the faults the edit made
// (the file's old ones are not its), and only those that are sure: a false warning teaches agents to ignore them all.
// Pure.

import * as M from "../../shared/manuscript";

/** Elements whose end tag HTML lets a page leave out: the browser closes them where the page means it to. */
const MAY_OMIT = new Set("html head body p li dt dd tr td th thead tbody tfoot colgroup caption option optgroup rt rp".split(" "));
/** How many faults an answer lists. */
const MOST = 5;

interface Fault {
  at: number;
  key: string;
  says: string;
}

const block = (n: M.SourceNode): n is M.ElementNode =>
  n.kind == "element" && n.tag != "br" && !M.INLINE.has(n.tag) && !M.ATOMIC.has(n.tag) && !M.TRANSPARENT.has(n.tag);

function faults(src: string): Fault[] {
  const out: Fault[] = [];
  const visit = (el: M.ElementNode, text: boolean) => {
    const first = el.children.find(block);
    for (const c of el.children) {
      if (c.kind == "element") {
        if (!c.selfClosing && c.to == c.closeFrom && !MAY_OMIT.has(c.tag))
          out.push({ at: c.from, key: `open ${c.tag}`, says: `<${c.tag}> is not closed` });
        // Text in app logic or in a part marked as not editable is nobody's to edit by hand.
        visit(c, text && !M.ATOMIC.has(c.tag) && !M.noEdit(src, c));
        continue;
      }
      // (A list item's text before its nested list is a unit of its own.)
      if (!text || c.raw || !first || (el.tag == "li" && c.from < first.from)) continue;
      const words = src.slice(c.from, c.to).trim().replace(/\s+/g, " ");
      if (!words) continue;
      const quote = words.length > 30 ? words.slice(0, 29).trimEnd() + "…" : words;
      out.push({
        at: c.from + src.slice(c.from, c.to).search(/\S/),
        key: `loose ${words}`,
        says: `loose text "${quote}" beside <${first.tag}>: nobody can edit it by hand`,
      });
    }
  };
  visit(M.parseHtml(src), true);
  return out.sort((a, b) => a.at - b.at);
}

/** What a change to a file broke, as lines for the tool's answer after its first; "" if nothing, or the file isn't HTML. */
export function broke(path: string, before: string, after: string): string {
  if (!/\.html?$/i.test(path)) return "";
  const had = new Map<string, number>();
  for (const f of faults(before)) had.set(f.key, (had.get(f.key) ?? 0) + 1);
  const made = faults(after).filter((f) => {
    const n = had.get(f.key) ?? 0;
    if (n) had.set(f.key, n - 1);
    return !n;
  });
  if (!made.length) return "";
  const line = (at: number) => after.slice(0, at).split("\n").length;
  const one = made.length == 1;
  return [
    `${made.length} problem${one ? "" : "s"} in its HTML:`,
    ...made.slice(0, MOST).map((f) => ` line ${line(f.at)}: ${f.says}`),
    ...(made.length > MOST ? [` and ${made.length - MOST} more`] : []),
    `Fix ${one ? "it" : "them"} now, or restore the last version.`,
  ].join("\n");
}
