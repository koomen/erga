import { expect, test } from "bun:test";
import { changesBetween, rebase, rebaseOnce } from "../document/merge";

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

// (the old multiplayer fuzz, seed 186029: the publish's token went inside a person's, which then read as lost.)
test("rebase puts the incoming edit in its place beside an unsaved delete of a mark that starts as the next one does", () => {
  const base = `<title>Notes</title> <meta ch⟦p1.49⟧arset⟦p1.51⟧="utf-8"> <p>End</p>`;
  const current = `<title>My notes</title> <meta charset⟦p1.51⟧="utf-8"> <p>The end</p>`;
  const incoming = base.replace("arset", "ar⟦pub.145⟧set");
  expect(apply(current, rebase(base, current, incoming))).toBe(
    `<title>My notes</title> <meta char⟦pub.145⟧set⟦p1.51⟧="utf-8"> <p>The end</p>`
  );
  // The room's own edit there is one deletion, of the mark.
  const hunks: string[] = [];
  changesBetween(base, current).iterChanges((fa, ta, _fb, _tb, ins) => hunks.push(`${base.slice(fa, ta)}->${ins}`));
  expect(hunks).toEqual(["Notes->My notes", "⟦p1.49⟧->", "End->The end"]);
});

// (A publish between two marks took the next mark's "⟦"; a person who deleted that mark elsewhere left "pub.3⟧⟦".)
test("an insertion or a deletion between brackets is the whole bracketed text, with no bracket of a neighbour's", () => {
  const hunks = (a: string, b: string) => {
    const out: string[] = [];
    changesBetween(a, b).iterChanges((fa, ta, _fb, _tb, ins) => out.push(`${fa}: ${a.slice(fa, ta)}->${ins}`));
    return out;
  };
  for (const [a, b, hunk] of [
    ["x ⟦a.1⟧⟦b.2⟧ y", "x ⟦a.1⟧⟦pub.3⟧⟦b.2⟧ y", "7: ->⟦pub.3⟧"],
    ["<ul><li>a</li><li>c</li></ul>", "<ul><li>a</li><li>b</li><li>c</li></ul>", "14: -><li>b</li>"],
  ]) {
    expect(hunks(a, b)).toEqual([hunk]);
    expect(hunks(b, a)).toEqual([hunk.replace(/: ->(.*)/, ": $1->")]);
  }
  // A person off the network deletes the mark before, or the one after: the publish's mark stays whole.
  const base = "x ⟦a.1⟧⟦b.2⟧ y",
    incoming = "x ⟦a.1⟧⟦pub.3⟧⟦b.2⟧ y";
  expect(apply("x ⟦b.2⟧ y", rebase(base, "x ⟦b.2⟧ y", incoming))).toBe("x ⟦pub.3⟧⟦b.2⟧ y");
  expect(apply("x ⟦a.1⟧ y", rebase(base, "x ⟦a.1⟧ y", incoming))).toBe("x ⟦a.1⟧⟦pub.3⟧ y");
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

test("a rewrite stays fast when the clock stands still, as on Workers", () => {
  // Two long texts with little in common: the worst case for the word diff.
  const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => `w${(i * seed) % 9973}`).join(" ");
  const a = `<p>${words(7, 12000)}</p>`, b = `<div>${words(13, 9000)}</div>`;
  const now = Date.now;
  const frozen = now();
  Date.now = () => frozen;
  try {
    const t0 = performance.now();
    const cs = changesBetween(a, b);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(apply(a, cs)).toBe(b);
  } finally {
    Date.now = now;
  }
});

// A room that lost its history takes a kept replica's text as edits (libs/text/ui/collab.ts, adopt): `base` is the text
// that the old room last confirmed to the replica, `room` the text of the files, `ours` the replica's.
const page = (h1: string, p = "A page.") => `<body>\n<h1>${h1}</h1>\n<p>${p}</p>\n</body>\n`;
const adopt = (base: string, room: string, ours: string) => apply(room, rebaseOnce(base, room, ours));

// (e2e/sync/restart.e2e.ts, 2 runs of 30 on a busy machine: "Launch notes offline, twice unsent lost, twice".)
test("an edit that the room stored, but did not confirm before it lost its history, arrives one time", () => {
  const base = page("Launch notes offline");
  // A viewer's replica got ", twice" from the room after its last confirmation; the room stored it, and lost its history.
  const viewer = page("Launch notes offline, twice");
  expect(adopt(base, viewer, viewer)).toBe(viewer);
  // The same, after the pages put in what their people typed meanwhile.
  const later = page("Launch notes offline, twice unsent lost");
  expect(adopt(base, later, viewer)).toBe(later);
  // The replica of the person who typed it, with more that never reached the room.
  expect(adopt(base, viewer, page("Launch notes offline, twice unsent"))).toBe(page("Launch notes offline, twice unsent"));
  // The room stored a part of what they typed there, and they typed on, also in the middle of it.
  expect(adopt(base, page("Launch notes offline, twi"), page("Launch notes offline, twice unsent"))).toBe(
    page("Launch notes offline, twice unsent")
  );
  expect(adopt(page("Launch"), page("Launch nots, shrt"), page("Launch notes, short"))).toBe(page("Launch notes, short"));
  // A viewer that missed the room's last edits, at two places.
  expect(adopt(page("Launch"), page("Launch big notes, short"), page("Launch notes"))).toBe(page("Launch big notes, short"));
  // A word that they replaced, and a paragraph that they deleted.
  expect(adopt(page("Launch notes"), page("Launch plans"), page("Launch plans today"))).toBe(page("Launch plans today"));
  const two = page("Launch notes").replace("</p>", "</p>\n<p>Second.</p>");
  expect(adopt(two, page("Launch notes"), page("Launch notes, short"))).toBe(page("Launch notes, short"));
});

test("an edit that the room did not store arrives one time, beside what the room has", () => {
  const base = page("Launch notes offline, twice");
  expect(adopt(base, base, page("Launch notes offline, twice unsent"))).toBe(page("Launch notes offline, twice unsent"));
  // Another replica's text went in first, at the same place: both are there.
  expect(adopt(base, page("Launch notes offline, twice lost"), page("Launch notes offline, twice unsent"))).toBe(
    page("Launch notes offline, twice lost unsent")
  );
  // Stored and not confirmed in the heading, not stored in the paragraph, and someone else's edit that this replica never got.
  expect(adopt(page("Launch notes"), page("Launch notes offline", "A page. Theirs."), page("Launch notes offline", "Mine. A page."))).toBe(
    page("Launch notes offline", "Mine. A page. Theirs.")
  );
  // A deletion beside text that only the room has: the word goes, the room's text stays.
  expect(adopt(page("Launch notes"), page("Launch notes of Bo"), page("Launch"))).toBe(page("Launch of Bo"));
  // Two people's different text at one place is never one: all of both stays.
  expect(adopt(page("Launch"), page("Launch notes"), page("Launch plans"))).toBe(page("Launch notes plans"));
  expect(adopt(page("Launch"), page("Launch the dog"), page("Launch the cat"))).toBe(page("Launch the dog the cat"));
});
