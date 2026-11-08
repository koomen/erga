// The visible snapshot: the page as a person sees it in the editor, as text, read off the rendered page (the layout and
// the computed styles, not the source). One line for each line the page shows; a list item has its marker as the page
// draws it ("•", "◦", "▪", "3.", "☐", "☑"), and one indent step (4 spaces) for each distinct left edge of the list
// items on the page; a heading starts with "#"s for its level. "|" marks the caret, "[" and "]" a selection, "{" and "}"
// a comment's highlight (libs/text/ui/comments.ts: CSS highlights, drawn over the text). An empty
// line stands for a gap between two lines of more than half a line (a paragraph's margin), so uneven spacing shows.
//
//   Groceries
//
//   • Milk
//   • Eg|gs
//       ◦ Brown
//
//   1. First
//
// A block's text wrapped across lines is still one line; a <br> starts a new one, under the text of the line before.
// No pixels and no fonts: the same page gives the same text on any machine.

/** In the page's frame: the snapshot of its body. */
function snapshot(): string {
  const doc = document;
  const sel = doc.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  // Stand-ins for the caret and the selection's ends while the text collapses: control characters no page has.
  const CARET = "\x01",
    START = "\x02",
    END = "\x03",
    LIT = "\x04",
    UNLIT = "\x05";
  // The comments' highlights: where each starts and ends.
  const lit = new Map<Node, { at: number; mark: string }[]>();
  const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
  for (const name of ["erga-comment", "erga-comment-on"])
    for (const r of registry?.get(name) ?? []) {
      for (const [node, at, mark] of [
        [r.startContainer, r.startOffset, LIT],
        [r.endContainer, r.endOffset, UNLIT],
      ] as const)
        lit.set(node, [...(lit.get(node) ?? []), { at, mark }]);
    }
  const litAt = (node: Node, offset: number, mark: string) =>
    (lit.get(node) ?? [])
      .filter((m) => m.at == offset && m.mark == mark)
      .map((m) => m.mark)
      .join("");
  /** The marks to put at a point of the DOM (node, offset), if the selection starts or ends there. */
  const at = (node: Node, offset: number) => litAt(node, offset, UNLIT) + selectionAt(node, offset) + litAt(node, offset, LIT);
  const selectionAt = (node: Node, offset: number) => {
    if (!range) return "";
    if (range.collapsed) return range.startContainer == node && range.startOffset == offset ? CARET : "";
    return (
      (range.startContainer == node && range.startOffset == offset ? START : "") +
      (range.endContainer == node && range.endOffset == offset ? END : "")
    );
  };
  const shown = (el: Element) => {
    const s = getComputedStyle(el);
    return (
      s.display != "none" &&
      s.visibility != "hidden" &&
      !el.tagName.startsWith("ERGA-") &&
      !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD)$/.test(el.tagName)
    );
  };
  const inline = (el: Element) => /^(inline|inline-block|inline-flex|contents)$/.test(getComputedStyle(el).display) || el.tagName == "BR";

  /** A line: its text (a <br> as "\n"), the block it is in, and where it is drawn, top to bottom. */
  type Line = { text: string; owner: Element; top: number; bottom: number };
  const lines: Line[] = [];
  let run = "";
  let hasContent = false;
  /** The nodes of the run that take room on the page. */
  let drawn: (Text | Element)[] = [];
  const flush = (owner: Element, force: boolean) => {
    if (hasContent || /[\x01-\x05]/.test(run) || force) {
      let text = run.replace(/[ \t\r\f]*\n[ \t\r\f]*/g, "\n").replace(/[ \t\r\f]+/g, " ");
      text = text.replace(/^ +| +$/gm, "");
      // A <br> at the end of a block draws no line of its own (an empty block shows one empty line).
      if (text.endsWith("\n")) text = text.slice(0, -1);
      const rects = drawn
        .flatMap((n) => {
          if (n instanceof Element) return [n.getBoundingClientRect()];
          const r = doc.createRange();
          r.selectNodeContents(n);
          return [...r.getClientRects()];
        })
        .filter((r) => r.height > 0);
      if (!rects.length) rects.push(owner.getBoundingClientRect());
      lines.push({ text, owner, top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) });
    }
    run = "";
    hasContent = false;
    drawn = [];
  };
  /** Walks a block: its inline content in runs, each child block after the run before it. */
  const block = (el: Element) => {
    const before = lines.length;
    const walk = (node: Node) => {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        run += at(node, i);
        const k = kids[i];
        if (k.nodeType == 3) {
          const t = (k as Text).data;
          for (let j = 0; j < t.length; j++) run += at(k, j) + t[j].replace(/\s/, " ");
          run += at(k, t.length);
          if (/\S/.test(t)) {
            hasContent = true;
            drawn.push(k as Text);
          }
        } else if (k.nodeType == 1) {
          const e = k as Element;
          if (!shown(e)) continue;
          if (e.tagName == "BR") {
            run += "\n";
            hasContent = true;
          } else if (e instanceof HTMLInputElement && e.type == "checkbox") {
            run += e.checked ? "☑ " : "☐ ";
            hasContent = true;
            drawn.push(e);
          } else if (e.tagName == "IMG") {
            run += "▣";
            hasContent = true;
            drawn.push(e);
          } else if (inline(e)) walk(e);
          else {
            flush(el, false);
            block(e);
          }
        }
      }
      run += at(node, kids.length);
    };
    walk(el);
    // An empty block that takes room still shows one line (an empty item has its marker).
    flush(el, lines.length == before && (el.tagName == "LI" || (!el.children.length && el.getBoundingClientRect().height > 0)));
  };
  block(doc.body);

  // The list items' levels: their left edges on the page, nearest first.
  const itemOf = (el: Element) => el.closest("li");
  const lefts: number[] = [];
  for (const l of lines) {
    const li = itemOf(l.owner);
    if (!li) continue;
    const x = li.getBoundingClientRect().left;
    if (!lefts.some((y) => Math.abs(y - x) < 4)) lefts.push(x);
  }
  lefts.sort((a, b) => a - b);
  const level = (li: Element) => lefts.findIndex((y) => Math.abs(y - li.getBoundingClientRect().left) < 4);

  const BULLET: Record<string, string> = { disc: "•", circle: "◦", square: "▪" };
  const ordinal = (li: HTMLLIElement): number => {
    if (li.hasAttribute("value")) return li.value;
    let prev = li.previousElementSibling;
    while (prev && !(prev instanceof HTMLLIElement && getComputedStyle(prev).display == "list-item")) prev = prev.previousElementSibling;
    if (prev) return ordinal(prev as HTMLLIElement) + 1;
    const list = li.parentElement;
    return list instanceof HTMLOListElement ? list.start : 1;
  };
  const marker = (li: HTMLLIElement) => {
    const s = getComputedStyle(li);
    if (s.display != "list-item" || s.listStyleType == "none") return "";
    if (BULLET[s.listStyleType]) return BULLET[s.listStyleType];
    const n = ordinal(li);
    if (s.listStyleType == "lower-alpha" || s.listStyleType == "lower-latin") return `${String.fromCharCode(96 + n)}.`;
    if (s.listStyleType == "upper-alpha" || s.listStyleType == "upper-latin") return `${String.fromCharCode(64 + n)}.`;
    return `${n}.`;
  };
  /** Half a line of the block's text, in pixels. */
  const halfLine = (el: Element) => {
    const s = getComputedStyle(el);
    return (s.lineHeight == "normal" ? parseFloat(s.fontSize) * 1.2 : parseFloat(s.lineHeight)) / 2;
  };

  const out: string[] = [];
  const marked = new Set<Element>();
  lines.forEach((l, n) => {
    if (n && l.top - lines[n - 1].bottom > halfLine(l.owner)) out.push("");
    const li = itemOf(l.owner) as HTMLLIElement | null;
    const head = /^H([1-6])$/.exec(l.owner.tagName);
    let first = "",
      rest = "";
    if (li) {
      const pad = "    ".repeat(Math.max(0, level(li)));
      const m = marked.has(li) ? "" : marker(li);
      marked.add(li);
      first = pad + (m ? `${m} ` : "");
      rest = pad + " ".repeat(m ? m.length + 1 : 0);
    } else if (head) {
      first = `${"#".repeat(Number(head[1]))} `;
      rest = " ".repeat(first.length);
    }
    l.text.split("\n").forEach((t, i) => out.push(((i ? rest : first) + t).trimEnd()));
  });
  return out.join("\n").replaceAll(CARET, "|").replaceAll(START, "[").replaceAll(END, "]").replaceAll(LIT, "{").replaceAll(UNLIT, "}");
}

/** The snapshot, as an expression to evaluate in the page's frame. */
export const VISIBLE = `(${snapshot.toString()})()`;
