import { describe, expect, test } from "bun:test";
import {
  analyzeHtml,
  runPos,
  runOffset,
  unitAt,
  inlineStackAt,
  closeTags,
  openTags,
  balanced,
  decodeText,
  basicDecoder,
  adjacent,
  textStart,
  textEnd,
  duplicateIds,
  editRuns,
  type ElementNode,
  type Splice,
  type Unit,
} from "../shared/manuscript";

const doc = `<!doctype html>
<html>
<head><title>T</title><style>p { color: red }</style></head>
<body>
  <h1 class="big">Hello</h1>
  <p>Build <em>cool</em> things &amp; more</p>
  <div class="card">
    <p>Nested</p>
    <div>Leaf div with <span>span</span></div>
  </div>
  <ul><li>one<li>two</ul>
  <pre>
code &lt;here&gt;</pre>
  <div id="chart"><svg><text>label</text></svg></div>
  <p>Press <button>Go</button> now</p>
  <script>document.title = "x"</script>
  <section><h2>Sub</h2><p>Para</p></section>
</body>
</html>`;

describe("analyzeHtml", () => {
  const { units } = analyzeHtml(doc);
  const byTag = (tag: string) => units.filter((u) => u.tag == tag);

  test("finds the leaf blocks with text, in order", () => {
    expect(units.map((u) => u.tag)).toEqual(["h1", "p", "p", "div", "li", "li", "pre", "p", "h2", "p"]);
    expect(units.every((u, i) => u.id == i)).toBe(true);
  });

  test("runs are the DOM text nodes, decoded", () => {
    const p = byTag("p")[0];
    expect(p.runs.map((r) => r.text)).toEqual(["Build ", "cool", " things & more"]);
    expect(doc.slice(p.runs[2].from, p.runs[2].to)).toBe(" things &amp; more");
    expect(p.runs[2].map).not.toBeNull();
    // Offsets around the entity map to its start and end.
    const r = p.runs[2];
    const amp = r.text.indexOf("&");
    expect(doc.slice(runPos(r, amp), runPos(r, amp + 1))).toBe("&amp;");
    expect(runOffset(r, runPos(r, amp + 1))).toBe(amp + 1);
    expect(runOffset(r, runPos(r, amp) + 2)).toBe(amp + 1); // inside the entity snaps forward
  });

  test("implied end tags and containers", () => {
    const [one, two] = byTag("li");
    expect(one.runs[0].text).toBe("one");
    expect(doc.slice(one.from, one.to)).toBe("<li>one");
    expect(two.runs[0].text).toBe("two");
    expect(byTag("div").length).toBe(1); // the card is a container; #chart holds only an svg
    expect(byTag("div")[0].runs.map((r) => r.text)).toEqual(["Leaf div with ", "span"]);
  });

  test("pre drops its leading newline", () => {
    const pre = byTag("pre")[0];
    expect(pre.runs[0].text).toBe("code <here>");
    expect(runPos(pre.runs[0], 0)).toBe(pre.contentFrom + 1);
  });

  test("text inside atomic elements is a non-editable run", () => {
    const p = byTag("p")[2];
    expect(p.runs.map((r) => [r.text, r.editable])).toEqual([["Press ", true], ["Go", false], [" now", true]]);
  });

  test("each run is a text node of the parse", () => {
    for (const u of units) for (const r of u.runs) expect([r.node.kind, r.node.from, r.node.to]).toEqual(["text", r.from, r.to]);
  });

  test("unitAt and text bounds", () => {
    const p = byTag("p")[0];
    expect(unitAt(units, p.contentFrom)).toBe(p);
    expect(unitAt(units, p.contentTo)).toBe(p);
    expect(unitAt(units, p.from)).toBeNull();
    const pre = byTag("pre")[0];
    expect(doc.slice(textStart(pre), textEnd(pre))).toBe("code &lt;here&gt;");
    expect(adjacent(doc, byTag("li")[0], byTag("li")[1])).toBe(true);
    expect(adjacent(doc, byTag("p")[1], byTag("div")[0])).toBe(true);
    expect(adjacent(doc, byTag("div")[0], byTag("li")[0])).toBe(false);
  });

  test("inline stack at a position", () => {
    const p = byTag("p")[0];
    const inEm = p.runs[1].from + 2;
    const stack = inlineStackAt(doc, p, inEm);
    expect(stack).toEqual([{ tag: "em", open: "<em>" }]);
    expect(closeTags(stack) + openTags(stack)).toBe("</em><em>");
    expect(inlineStackAt(doc, p, p.runs[0].from + 1)).toEqual([]);
  });

  test("balanced slices", () => {
    expect(balanced("a <em>b</em> c", 0, 14)).toBe(true);
    expect(balanced("a <em>b</em> c", 0, 7)).toBe(false);
    expect(balanced("x<br>y<img src=a>", 0, 17)).toBe(true);
  });
});

describe("data-erga-noedit", () => {
  const src = `<body>
  <p>Editable</p>
  <section data-erga-noedit><h2>Fixed</h2><p>Also fixed</p></section>
  <p data-erga-noedit>Fixed para</p>
  <p data-erga-noedit="">Fixed too</p>
  <div><p data-erga-noedit>Fixed child</p><p>Free child</p></div>
  <p>Total: <span data-erga-noedit>42 <b>items</b></span> today</p>
  <p data-erga-noeditable>Not the attribute</p>
  <p class="x" DATA-ERGA-NOEDIT>Any case</p>
</body>`;
  const { units } = analyzeHtml(src);
  const texts = units.map((u) => u.runs.map((r) => r.text).join(""));

  test("an element with it, and everything inside, is never a unit", () => {
    expect(texts).toEqual(["Editable", "Free child", "Total: 42 items today", "Not the attribute"]);
  });

  test("a block with it still makes its parent a container", () => {
    expect(units.some((u) => u.tag == "div")).toBe(false);
  });

  test("an inline element with it is a non-editable run in its unit", () => {
    const p = units[2];
    expect(p.runs.map((r) => [r.text, r.editable])).toEqual([["Total: ", true], ["42 ", false], ["items", false], [" today", true]]);
  });

  test("a paragraph whose only text is no-edit is still a unit, with nothing editable", () => {
    const [u] = analyzeHtml(`<p><span data-erga-noedit>only</span></p>`).units;
    expect(u.runs.every((r) => !r.editable)).toBe(true);
  });
});

describe("decodeText", () => {
  test("newlines and entities", () => {
    const src = "a\r\nb&#x41;&lt;c";
    const { text, map } = decodeText(src, 0, src.length, false, basicDecoder);
    expect(text).toBe("a\nbA<c");
    expect(map).toEqual([0, 1, 3, 4, 10, 14, 15]);
  });
  test("raw text keeps entities", () => {
    const { text, map } = decodeText("&amp;", 0, 5, true, basicDecoder);
    expect(text).toBe("&amp;");
    expect(map).toBeNull();
  });
});

describe("duplicateIds", () => {
  /** The source with the edit's new text marked [like this], after the ids it would drop are gone. */
  const drop = (marked: string) => {
    const added: [number, number][] = [];
    let src = "";
    for (const part of marked.split(/([[\]])/)) {
      if (part == "[") added.push([src.length, src.length]);
      else if (part == "]") added[added.length - 1][1] = src.length;
      else src += part;
    }
    let out = src;
    for (const d of duplicateIds(src, added).reverse()) out = out.slice(0, d.from) + out.slice(d.to);
    return out;
  };
  test("an added element loses an id the page has; the one that was there keeps it", () => {
    expect(drop(`<p id="a" class="x">one</p>[<p id="a" class="x">two</p>]`)).toBe(`<p id="a" class="x">one</p><p class="x">two</p>`);
    expect(drop(`[<p id='a'>two</p>]<p id=a>one</p>`)).toBe(`<p>two</p><p id=a>one</p>`);
  });
  test("an added element with a new id keeps it, and of two added ones the first does", () => {
    expect(drop(`<p id="a">one</p>[<p id="b">two</p><p id="b">three</p>]`)).toBe(`<p id="a">one</p><p id="b">two</p><p>three</p>`);
  });
  test("a name counts on a link only; other attributes, and text that looks like one, stay", () => {
    expect(drop(`<a name="n">x</a>[<a name="n" href="#n">y</a><input name="n">]`)).toBe(`<a name="n">x</a><a href="#n">y</a><input name="n">`);
    expect(drop(`<p id="a">x</p>[<p data-id="a" title=' id="a"'>id="a"</p>]`)).toBe(`<p id="a">x</p><p data-id="a" title=' id="a"'>id="a"</p>`);
  });
  test("an id in a template isn't in the page", () => {
    expect(drop(`<template><li id="t">x</li></template>[<li id="t">y</li>]`)).toBe(`<template><li id="t">x</li></template><li id="t">y</li>`);
  });
});

describe("editRuns", () => {
  /** A tree, or units, as plain data: what a fresh parse and an edited one must agree on. */
  const plainTree = (el: ElementNode): unknown => ({ ...el, parent: null, children: el.children.map((c) => c.kind == "text" ? c : plainTree(c)) });
  const plainUnits = (units: Unit[]) => units.map((u) => ({ ...u, node: undefined }));
  const rootOf = (units: Unit[]) => { let n = units[0].node!; while (n.parent) n = n.parent; return n; };
  type Edit = Splice & { insert: string };
  const apply = (src: string, edits: Edit[]) => {
    let out = "", pos = 0;
    for (const s of edits) { out += src.slice(pos, s.from) + s.insert; pos = s.to; }
    return out + src.slice(pos);
  };
  const edit = (from: number, to: number, insert: string): Edit => ({ from, to, length: insert.length, insert });
  /** Edits `src`: true if editRuns took the edit, and then its analysis matches a fresh one; false if it left it alone. */
  const check = (src: string, edits: Edit[]) => {
    const a = analyzeHtml(src);
    const next = apply(src, edits);
    const changed = editRuns(a.units, src, next, edits);
    if (!changed) {
      expect(plainUnits(a.units)).toEqual(plainUnits(analyzeHtml(src).units));
      return false;
    }
    const fresh = analyzeHtml(next);
    expect(plainUnits(a.units)).toEqual(plainUnits(fresh.units));
    expect(plainTree(rootOf(a.units))).toEqual(plainTree(fresh.tree));
    return true;
  };
  const at = (needle: string, offset = 0) => doc.indexOf(needle) + offset;

  test("typing, deleting and replacing text inside a run match a fresh parse", () => {
    expect(check(doc, [edit(at("Hello", 5), at("Hello", 5), "!")])).toBe(true);
    expect(check(doc, [edit(at("Hello"), at("Hello"), "Oh")])).toBe(true);
    expect(check(doc, [edit(at("things"), at("things", 6), "stuff")])).toBe(true);
    expect(check(doc, [edit(at("Nested", 1), at("Nested", 3), "")])).toBe(true);
    expect(check(doc, [edit(at("one", 3), at("one", 3), " & 1")])).toBe(true);
    expect(check(doc, [edit(at("cool", 4), at("cool", 4), "&amp;")])).toBe(true);
    expect(check(doc, [edit(at("Sub", 3), at("Sub", 3), "x")])).toBe(true);
    expect(check(doc, [edit(at("here&gt;", 8), at("here&gt;", 8), " ok")])).toBe(true);
    // Right after an inline element's open tag: the text is the element's.
    expect(check(doc, [edit(at("<em>", 4), at("<em>", 4), "x")])).toBe(true);
  });
  test("several changes at once", () => {
    expect(check(doc, [edit(at("Hello", 5), at("Hello", 5), "!"), edit(at("things"), at("things", 6), "x"), edit(at("Para", 4), at("Para", 4), "abc")])).toBe(true);
  });
  test("a change that can be more than text is left to a fresh parse", () => {
    expect(check(doc, [edit(at("Hello", 5), at("Hello", 5), "<b>")])).toBe(false);
    expect(check(doc, [edit(at("Hello"), at("Hello", 5), "")])).toBe(false);
    expect(check(doc, [edit(at("<em>", 1), at("<em>", 1), "x")])).toBe(false);
    expect(check(doc, [edit(at("<pre>", 5), at("<pre>", 5), "x")])).toBe(false);
    expect(check(`<p>a <b>x</b></p>`, [edit(3, 4, " ")])).toBe(false);
    expect(check(`<div>a <b>x</b></div>`, [edit(6, 7, "")])).toBe(true);
    expect(check(`<div> <b>x</b></div>`, [edit(5, 6, "")])).toBe(false);
  });
  test("random typing and deleting in a long page", () => {
    let src = doc.repeat(3);
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let took = 0;
    for (let k = 0; k < 300; k++) {
      const runs = analyzeHtml(src).units.flatMap((u) => u.runs.filter((r) => r.editable));
      const r = runs[rnd(runs.length)];
      const from = r.from + rnd(r.to - r.from + 1);
      const del = rnd(3) == 0 ? Math.min(r.to - from, rnd(3)) : 0;
      const e = edit(from, from + del, ["a", " ", "&", "&amp;", "é", "\n", "x y", ";", "\r\n"][rnd(9)]);
      if (check(src, [e])) took++;
      src = apply(src, [e]);
    }
    expect(took).toBeGreaterThan(200);
  });
});
