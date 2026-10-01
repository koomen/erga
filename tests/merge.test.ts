import { expect, test } from "bun:test";
import { changesBetween, rebase } from "../src/page/merge";

const apply = (doc: string, cs: ReturnType<typeof changesBetween>) => cs.apply(Text.of(doc.split("\n"))).toString();
import { Text } from "@codemirror/state";

test("changesBetween turns a into b with small changes", () => {
  const a = "<p>The quick brown fox jumps.</p>\n<p>Second paragraph stays.</p>";
  const b = "<p>The quick red fox leaps.</p>\n<p>Second paragraph stays.</p>";
  const cs = changesBetween(a, b);
  expect(apply(a, cs)).toBe(b);
  let touched = 0;
  cs.iterChanges((fa, ta) => { touched += ta - fa; });
  expect(touched).toBeLessThan(12);
});

test("changesBetween handles empty and identical texts", () => {
  expect(changesBetween("same", "same").empty).toBe(true);
  expect(apply("", changesBetween("", "new"))).toBe("new");
  expect(apply("old", changesBetween("old", ""))).toBe("");
});

test("rebase keeps unsaved edits and the incoming edit", () => {
  const base = "# Title\n\nFirst para.\n\nSecond para.\n";
  const current = "# Title, edited\n\nFirst para.\n\nSecond para.\n";
  const incoming = "# Title\n\nFirst para.\n\nSecond paragraph, rewritten.\n";
  expect(apply(current, rebase(base, current, incoming))).toBe("# Title, edited\n\nFirst para.\n\nSecond paragraph, rewritten.\n");
});

test("rebase with nothing unsaved is the incoming edit", () => {
  expect(apply("a b c", rebase("a b c", "a b c", "a x c"))).toBe("a x c");
});

test("hunks are tidied to whole words", () => {
  const a = "<h1>Launch notes</h1>\n<p>Things &amp; more.</p>\n<figcaption>Where the leads go.</figcaption>";
  const b = "<h1>Launch notes for spring</h1>\n<p>Things and more.</p>\n<figcaption>Where leads go.</figcaption>";
  const cs = changesBetween(a, b);
  expect(apply(a, cs)).toBe(b);
  const hunks: string[] = [];
  cs.iterChanges((fa, ta, _fb, _tb, ins) => hunks.push(`${a.slice(fa, ta)}->${ins}`));
  expect(hunks).toEqual(["-> for spring", "&amp;->and", " the->"]);
});

test("a changed word is replaced whole, not from mid-word", () => {
  const cs = changesBetween("the quick fox", "the quack fox");
  const hunks: string[] = [];
  cs.iterChanges((fa, ta, _fb, _tb, ins) => hunks.push(`${"the quick fox".slice(fa, ta)}->${ins}`));
  expect(hunks).toEqual(["quick->quack"]);
});

test("tidied changes still apply exactly, on random edits", () => {
  const words = ["the", "a", "fox", "<b>", "</b>", " ", "  ", "\n", "&amp;", "ee", "e", "quick", "."];
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const make = () => Array.from({ length: 4 + rnd(30) }, () => words[rnd(words.length)]).join("");
  for (let i = 0; i < 3000; i++) {
    const a = make();
    const b = rnd(2) ? make() : a.slice(0, rnd(a.length + 1)) + make().slice(0, rnd(6)) + a.slice(rnd(a.length + 1));
    expect(apply(a, changesBetween(a, b))).toBe(b);
  }
});

test("adding or removing letters in a word marks just those letters", () => {
  const hunks = (a: string, b: string) => { const out: string[] = []; changesBetween(a, b).iterChanges((fa, ta, _fb, _tb, ins) => out.push(`${a.slice(fa, ta)}->${ins}`)); return out; };
  expect(hunks("<p>one word here</p>", "<p>one words here</p>")).toEqual(["->s"]);
  expect(hunks("<p>one words here</p>", "<p>one word here</p>")).toEqual(["s->"]);
  expect(hunks("<p>undo it</p>", "<p>redo undo it</p>")).toEqual(["->redo "]);
  expect(hunks("<p>do it</p>", "<p>undo it</p>")).toEqual(["->un"]);
});

test("an insertion already at a word boundary stays exactly where it was made", () => {
  // Sliding it along repeated characters (here the "⟧") would put it inside
  // the neighbouring text: same result on its own, but a concurrent deletion
  // of that neighbour, once merged, would cut a piece off the insertion.
  const at = (a: string, b: string) => { let out = -1; changesBetween(a, b).iterChanges((fa) => { out = fa; }); return out; };
  expect(at("cod⟦p1.36⟧e", "cod⟦p1.36⟧⟦pub.87⟧e")).toBe("cod⟦p1.36⟧".length);
  expect(at("a (one) b", "a (one)(two) b")).toBe("a (one)".length);
  // Mid-word it still moves to a boundary.
  expect(at("<p>undo it</p>", "<p>redo undo it</p>")).toBe(3);
});
