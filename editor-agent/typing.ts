// How the agent's new text streams in (editor-agent/workspace.ts, paced): cut
// into pieces a few characters long, so others see it arrive as a model's
// streamed answer does. The page stays whole at every step: a tag or an
// entity goes in whole, an element's closing tag goes in with its opening
// one (the text between them streams after), and a script or style goes in
// whole with its contents.

/** One step's part: `insert` goes in at the caret, then the caret moves on by `advance`. */
export interface Piece {
  insert: string;
  advance: number;
  /** Its share of the time: the characters a reader sees (a tag counts as one). */
  weight: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
/** Elements whose contents go in whole with them: a script or style typed in parts would run or style in parts. */
const WHOLE = new Set(["script", "style", "textarea", "title"]);
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<[a-zA-Z/!?][^<>]*>?|&[#a-zA-Z0-9]*;?|[^\s<&]+\s*|\s+|[<&]/g;

/**
 * The pieces of `insert`, in order, for text that goes in after `before`.
 * If `before` ends inside a tag or an entity, the rest of it in `insert`
 * goes in whole, with the first piece.
 */
export function pieces(insert: string, before: string): Piece[] {
  // The rest of a tag or an entity that `before` opened.
  let head = 0;
  const lt = before.lastIndexOf("<");
  if (lt > before.lastIndexOf(">") && /^<[a-zA-Z/!?]/.test(before.slice(lt))) {
    const gt = insert.indexOf(">");
    head = gt < 0 ? insert.length : gt + 1;
  } else if (/&[#a-zA-Z0-9]*$/.test(before)) head = /^[#a-zA-Z0-9]*;?/.exec(insert)![0].length;
  const tokens: string[] = head ? [insert.slice(0, head)] : [];
  for (const m of insert.slice(head).matchAll(TOKEN)) tokens.push(m[0]);

  const out: Piece[] = [];
  const closed = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (closed.has(i)) {
      out.push({ insert: "", advance: tok.length, weight: 0 });
      continue;
    }
    const name = /^<([a-zA-Z][\w-]*)[^>]*>$/.exec(tok)?.[1]?.toLowerCase();
    const close = name && !VOID.has(name) && !tok.endsWith("/>") ? closing(tokens, i, name) : -1;
    if (close < 0) {
      const tag = tok.length > 1 && (tok[0] == "<" || tok[0] == "&");
      out.push({ insert: tok, advance: tok.length, weight: tag ? 1 : tok.length });
    } else if (WHOLE.has(name!)) {
      const all = tokens.slice(i, close + 1).join("");
      out.push({ insert: all, advance: all.length, weight: 1 });
      i = close;
    } else {
      closed.add(close);
      out.push({ insert: tok + tokens[close], advance: tok.length, weight: 1 });
    }
  }
  return out;
}

/** The index of the token that closes the element `tokens[i]` opens, or -1. */
function closing(tokens: string[], i: number, name: string): number {
  let depth = 0;
  const open = new RegExp(`^<${name}(?=[\\s/>])[^>]*>$`, "i"),
    close = new RegExp(`^</${name}\\s*>$`, "i");
  for (let k = i + 1; k < tokens.length; k++) {
    if (open.test(tokens[k]) && !tokens[k].endsWith("/>")) depth++;
    else if (close.test(tokens[k]) && depth-- == 0) return k;
  }
  return -1;
}

type Change = { from: number; to: number; insert: string };

/** Where the tag or entity that position `p` of `text` is inside starts and ends, or null. */
function within(text: string, p: number): { start: number; end: number } | null {
  if (p <= 0) return null;
  const lt = text.lastIndexOf("<", p - 1);
  if (lt >= 0 && lt > text.lastIndexOf(">", p - 1) && /[a-zA-Z/!?]/.test(text[lt + 1] ?? "")) {
    const gt = text.indexOf(">", p);
    return { start: lt, end: gt < 0 ? text.length : gt + 1 };
  }
  const amp = /&[#a-zA-Z0-9]*$/.exec(text.slice(Math.max(0, p - 12), p));
  const rest = /^[#a-zA-Z0-9]*;?/.exec(text.slice(p))![0];
  return amp && rest ? { start: p - amp[0].length, end: p + rest.length } : null;
}

/**
 * Each change of `text` as its smallest one, but never starting or ending
 * inside a tag or an entity, so that each step of it leaves them whole:
 * old and new text's shared ends are trimmed up to a tag's edge, and a
 * change that still cuts into one takes all of it. Changes that come to
 * overlap are joined.
 */
export function aligned(text: string, changes: Change[]): Change[] {
  const out: (Change & { first: Change })[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    const a = align(text, c);
    if (prev && a.from <= prev.to) {
      // Joined from the original changes, which don't overlap.
      const first = { from: prev.first.from, to: c.to, insert: prev.first.insert + text.slice(prev.first.to, c.from) + c.insert };
      out[out.length - 1] = { ...align(text, first), first };
    } else out.push({ ...a, first: c });
  }
  return out.map(({ from, to, insert }) => ({ from, to, insert })).filter((c) => c.from < c.to || c.insert);
}

function align(text: string, { from, to, insert }: Change): Change {
  // The shared start, back to the edge of a tag it ends in.
  let s = 0;
  while (from + s < to && s < insert.length && text[from + s] == insert[s]) s++;
  const head = within(text, from + s);
  if (head && head.start < from + s) s = Math.max(0, head.start - from);
  // The shared end, up to the edge of a tag it starts in.
  let e = 0;
  while (to - e > from + s && insert.length - e > s && text[to - 1 - e] == insert[insert.length - 1 - e]) e++;
  const tail = within(text, to - e);
  if (e && tail && tail.start < to - e) e = Math.max(0, to - tail.end);
  let c = { from: from + s, to: to - e, insert: insert.slice(s, insert.length - e) };
  // Still inside one at either end (the old text itself starts or ends in a tag): take all of it.
  const a = within(text, c.from);
  if (a && a.start < c.from) c = { from: a.start, to: Math.max(c.to, a.start), insert: text.slice(a.start, c.from) + c.insert };
  const b = c.to > c.from || c.insert ? within(text, c.to) : null;
  if (b && b.start < c.to && b.end > c.to) c = { ...c, to: b.end, insert: c.insert + text.slice(c.to, b.end) };
  return c;
}
