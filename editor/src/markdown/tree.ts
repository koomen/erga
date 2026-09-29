// A plain syntax tree: named nodes with absolute positions. The navigation
// helpers use the same semantics as Lezer's (which CodeMirror's Markdown
// commands were written against), so those commands port over unchanged.

export class Node {
  parent: Node | null = null;
  index = 0;

  constructor(
    readonly name: string,
    readonly from: number,
    public to: number,
    public children: Node[] = [],
  ) {}

  /** Wire up parent pointers and sibling indexes (called once on the finished tree). */
  link(): this {
    for (let i = 0; i < this.children.length; i++) {
      const ch = this.children[i];
      ch.parent = this;
      ch.index = i;
      ch.link();
    }
    return this;
  }

  get firstChild(): Node | null { return this.children[0] ?? null; }
  get lastChild(): Node | null { return this.children[this.children.length - 1] ?? null; }
  get nextSibling(): Node | null { return this.parent?.children[this.index + 1] ?? null; }
  get prevSibling(): Node | null { return this.parent?.children[this.index - 1] ?? null; }

  /** Last child that starts before `pos`. */
  childBefore(pos: number): Node | null {
    for (let i = this.children.length - 1; i >= 0; i--) if (this.children[i].from < pos) return this.children[i];
    return null;
  }

  /** First child that ends after `pos`. */
  childAfter(pos: number): Node | null {
    for (const ch of this.children) if (ch.to > pos) return ch;
    return null;
  }

  getChildren(type: string, before: string | null = null, after: string | null = null): Node[] {
    const result: Node[] = [];
    let seenBefore = before == null;
    for (const ch of this.children) {
      if (!seenBefore) {
        if (ch.name == before) seenBefore = true;
        continue;
      }
      if (after != null && ch.name == after) break;
      if (ch.name == type) result.push(ch);
    }
    return result;
  }

  getChild(type: string, before: string | null = null, after: string | null = null): Node | null {
    return this.getChildren(type, before, after)[0] ?? null;
  }

  getChildrenNamed(type: string): Node[] { return this.children.filter((c) => c.name == type); }
}

export type Tree = Node;

// Lezer's Side: -2 Before, -1 AtOrBefore, 0 Around, 1 AtOrAfter, 2 After.
function checkSide(side: number, pos: number, from: number, to: number): boolean {
  switch (side) {
    case -2: return from < pos;
    case -1: return to >= pos && from < pos;
    case 0: return from < pos && to > pos;
    case 1: return from <= pos && to > pos;
    case 2: return to > pos;
    default: return true;
  }
}

/** The innermost node at `pos` (Lezer's `resolveInner`). */
export function resolveInner(tree: Tree, pos: number, side = 0): Node {
  let node: Node = tree;
  for (;;) {
    let inner: Node | null = null;
    for (const ch of node.children) {
      if (checkSide(side, pos, ch.from, ch.to)) { inner = ch; break; }
    }
    if (!inner) return node;
    node = inner;
  }
}

/** Visit every node overlapping (or touching) [from, to]. Return false from `enter` to skip children. */
export function iterate(tree: Tree, spec: { from?: number; to?: number; enter: (n: Node) => boolean | void; leave?: (n: Node) => void }) {
  const from = spec.from ?? 0, to = spec.to ?? tree.to;
  const visit = (n: Node) => {
    if (!(n.from <= to && n.to >= from)) return;
    if (spec.enter(n) === false) return;
    for (const ch of n.children) visit(ch);
    spec.leave?.(n);
  };
  visit(tree);
}
