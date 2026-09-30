import { describe, expect, test } from "bun:test";
import { analyzeHtml, stamp, runPos, runOffset, unitAt, inlineStackAt, closeTags, openTags, balanced, decodeText, basicDecoder, adjacent, textStart, textEnd } from "../src/page/manuscript";

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

  test("stamping inserts ids into open tags only", () => {
    const html = stamp(doc, units);
    expect(html).toContain('<h1 class="big" data-sw-id="0">Hello</h1>');
    expect(html).toContain('<li data-sw-id="4">one<li data-sw-id="5">two');
    expect(html.replace(/ data-sw-id="\d+"/g, "")).toBe(doc);
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
