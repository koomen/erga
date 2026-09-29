// Small DOM helpers shared by the view modules.

export interface Rect { left: number; right: number; top: number; bottom: number }

export function flattenRect(rect: Rect, toLeft: boolean): Rect {
  const x = toLeft ? rect.left : rect.right;
  return { left: x, right: x, top: rect.top, bottom: rect.bottom };
}

export function textRange(node: Text, from: number, to = from): Range {
  const range = document.createRange();
  range.setEnd(node, to);
  range.setStart(node, from);
  return range;
}

export function isHiddenText(node: globalThis.Node): boolean {
  const parent = node.parentNode as HTMLElement | null;
  return !!parent && parent.nodeType == 1 && parent.classList.contains("md-hidden");
}

/** Text nodes of a line element in order, with their offsets in the line. */
export function lineTextNodes(line: HTMLElement): { node: Text; start: number; end: number; hidden: boolean }[] {
  const out: { node: Text; start: number; end: number; hidden: boolean }[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.nodeValue!.length;
    out.push({ node: n, start: pos, end: pos + len, hidden: isHiddenText(n) });
    pos += len;
  }
  return out;
}

export const isMac = typeof navigator != "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
