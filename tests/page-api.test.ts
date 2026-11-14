// A page's own API (document/page-api.ts): its module, run in the sandbox, answers operations on elements named by CSS
// selector; Erga makes them one change to the source, or refuses them, saying why.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { applyPageEdit, describePageApi } from "../document/page-api";
import { apiPathOf, applyChanges, planPageOps } from "../shared/page-ops";
import { keys } from "./helpers/page-keys";
import { testSandbox } from "./helpers/sandbox";

const page = `<body>
  <ul class="branch">
    <li>
      <div class="view"><h3>Front</h3></div>
    </li>
    <li>
      <div class="view"><h3>Docs</h3></div>
    </li>
  </ul>
  <p id="note">Note</p><img src="a.png">
</body>`;
const LI1 = "ul > li:nth-child(1)",
  LI2 = "ul > li:nth-child(2)";

/** Plans operations on `src`; the new source, or the error. Checks CodeMirror applies the changes the same way. */
function run(ops: unknown, src = page): string {
  const plan = planPageOps(src, ops);
  if ("error" in plan) return `ERROR: ${plan.error}`;
  const out = applyChanges(src, plan.changes);
  const state = EditorState.create({ doc: src });
  expect(state.update({ changes: state.changes(plan.changes) }).state.doc.toString()).toBe(out);
  return out;
}
const NEW = `<li>\n<div class="view"><h3>New</h3></div>\n</li>`;

describe("a page's operations", () => {
  test("inserts after, before, into and at the start of an element, indented like the code around it", () => {
    expect(run([{ op: "insert", after: LI2, html: NEW }])).toContain(
      `      <div class="view"><h3>Docs</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n  </ul>`
    );
    expect(run([{ op: "insert", before: LI1, html: NEW }])).toContain(
      `<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3></div>\n    </li>\n    <li>\n      <div class="view"><h3>Front</h3></div>`
    );
    expect(run([{ op: "insert", into: "ul", html: NEW }])).toContain(`<h3>New</h3></div>\n    </li>\n  </ul>`);
    expect(run([{ op: "insert", prepend: "ul", html: NEW }])).toContain(
      `<ul class="branch">\n    <li>\n      <div class="view"><h3>New</h3>`
    );
  });

  test("an empty element gets the new HTML on lines of its own; any HTML is indented by its nesting", () => {
    expect(run([{ op: "insert", into: "ul", html: "<li>A</li>" }], `<div>\n  <ul class="x"></ul>\n</div>`)).toBe(
      `<div>\n  <ul class="x">\n    <li>A</li>\n  </ul>\n</div>`
    );
    const html = `<ul class="branch">\n        <li>\n  <div class="view"><h3>Sub</h3></div>\n            </li>\n</ul>`;
    expect(run([{ op: "insert", into: LI1, html }])).toContain(
      `<h3>Front</h3></div>\n      <ul class="branch">\n        <li>\n          <div class="view"><h3>Sub</h3></div>\n        </li>\n      </ul>\n    </li>`
    );
  });

  test("removes, moves and replaces whole elements; sets and removes attributes; several are one change", () => {
    expect(run([{ op: "remove", el: LI1 }])).not.toContain("Front");
    const moved = run([{ op: "move", el: LI2, before: LI1 }]);
    expect(moved.replace("Docs", "X").replace("Front", "Docs").replace("X", "Front")).toBe(page);
    expect(run([{ op: "replace", el: "#note", html: `<p id="note">New <em>note</em></p>` }])).toContain(
      `<p id="note">New <em>note</em></p><img`
    );
    expect(run([{ op: "attr", el: LI1, name: "class", value: `done "now"` }])).toContain(`<li class="done &quot;now&quot;">`);
    expect(run([{ op: "attr", el: "ul", name: "class", value: null }])).toContain(`<ul>`);
    expect(run([{ op: "attr", el: "img", name: "alt", value: "A" }])).toContain(`<img src="a.png" alt="A">`);
    const out = run([
      { op: "remove", el: LI1 },
      { op: "insert", after: LI2, html: NEW },
      { op: "attr", el: "#note", name: "class", value: "x" },
    ]);
    expect(out.indexOf("Docs")).toBeLessThan(out.indexOf("New"));
    expect(out).toContain(`<p id="note" class="x">`);
  });

  test("refuses what would break the page, and says why", () => {
    expect(run([{ op: "remove", el: "#gone" }])).toMatch(/matches 0 elements/);
    expect(run([{ op: "remove", el: "li" }])).toMatch(/matches 2 elements/);
    expect(run([{ op: "remove", el: "li:hover" }])).toMatch(/isn't a selector/);
    expect(run([{ op: "remove", el: "body" }])).toMatch(/page's <body>/);
    expect(run([{ op: "insert", after: LI1, html: "<li>Open" }])).toMatch(/isn't closed/);
    expect(run([{ op: "insert", after: LI1, html: "<li>A</li></ul>" }])).toMatch(/end tag that closes nothing/);
    expect(run([{ op: "insert", after: LI1, html: "<li>A<script>x()</script></li>" }])).toMatch(/<script>/);
    expect(run([{ op: "insert", after: LI1, html: `<li onclick="x()">A</li>` }])).toMatch(/onclick/);
    expect(run([{ op: "insert", after: LI1, html: `<li data-erga-text>A</li>` }])).toMatch(/data-erga-text/);
    expect(run([{ op: "attr", el: LI1, name: "onclick", value: "x()" }])).toMatch(/onclick/);
    expect(run([{ op: "move", el: LI1, into: `${LI1} > div` }])).toMatch(/into itself/);
    expect(
      run([
        { op: "remove", el: LI1 },
        { op: "attr", el: `${LI1} > div`, name: "a", value: "b" },
      ])
    ).toMatch(/same element/);
    expect(run([{ op: "insert", into: "img", html: "<b>x</b>" }])).toMatch(/into a <img>/);
    expect(run([{ op: "explode" }])).toMatch(/unknown op/);
    expect(run([])).toMatch(/list of operations/);
    expect(run([{ op: "remove", el: "p" }], `<div><p>One<div>x</div></div>`)).toMatch(/isn't closed by its own end tag/);
  });
});

describe("the caret an edit names", () => {
  // The slides template's own API (assets/templates/slides/api.js), as the deck's bar calls it in the editor.
  const deck = `<body>
<section class="slide" data-layout="title">
  <h1>One</h1>
</section>
<section class="slide" data-layout="content">
  <h2>Two</h2>
</section>
<section class="slide" data-layout="content">
  <h2>Three</h2>
</section>
</body>`;
  type Api = { apply(html: string, edit: string, input: unknown): unknown };
  const slides = async (): Promise<Api> => (await import("../assets/templates/slides/api.js" as string)).default;
  /** The new source, and the text from the caret on. */
  async function edit(name: string, input: unknown) {
    const plan = planPageOps(deck, (await slides()).apply(deck, name, input));
    if ("error" in plan) throw new Error(plan.error);
    const out = applyChanges(deck, plan.changes);
    return { out, caret: plan.caret && { from: out.slice(plan.caret.at, plan.caret.at + 60), select: plan.caret.select } };
  }

  test("goes to the element where it is after the edit: moved, or past an element removed before it", async () => {
    const down = await edit("move_slide", { slide: 1, to: 2 });
    expect(down.out.indexOf("<h2>Two")).toBeLessThan(down.out.indexOf("<h1>One"));
    expect(down.caret?.select).toBe(false);
    expect(down.caret?.from).toStartWith(`<section class="slide" data-layout="title">\n  <h1>One`);
    const up = await edit("move_slide", { slide: 3, to: 1 });
    expect(up.caret?.from).toStartWith(`<section class="slide" data-layout="content">\n  <h2>Three`);
    const gone = await edit("delete_slide", { slide: 3 });
    expect(gone.out).not.toContain("Three");
    expect(gone.caret?.from).toStartWith(`<section class="slide" data-layout="content">\n  <h2>Two`);
    const first = await edit("delete_slide", { slide: 1 });
    expect(first.caret?.from).toStartWith(`<section class="slide" data-layout="content">\n  <h2>Two`);
    expect((await edit("set_layout", { slide: 2, layout: "title" })).caret?.from).toStartWith(
      `<section class="slide" data-layout="title">\n  <h2>Two`
    );
  });

  test("an edit without one leaves the caret to the editor; a caret in an element the edit removes is refused", async () => {
    expect((await edit("add_slide", { after: 1, layout: "content" })).caret).toBeUndefined();
    const one = planPageOps(deck, [
      { op: "remove", el: "body > section:nth-of-type(2)" },
      { op: "caret", el: "body > section:nth-of-type(2)" },
    ]);
    expect("error" in one && one.error).toMatch(/goes with the edit/);
    const two = planPageOps(deck, [
      { op: "caret", el: "body > section:nth-of-type(1)" },
      { op: "caret", el: "body > section:nth-of-type(2)" },
    ]);
    expect("error" in two && two.error).toMatch(/one caret/);
  });
});

describe("the templates' add_image, which puts a dropped image on the page", () => {
  type Api = { apply(html: string, edit: string, input: unknown): unknown };
  const api = async (template: string): Promise<Api> => (await import(`../assets/templates/${template}/api.js`)).default;
  const made = (html: string, ops: unknown) => {
    const plan = planPageOps(html, ops as never);
    if ("error" in plan) throw new Error(plan.error);
    return applyChanges(html, plan.changes);
  };
  const file = { src: "images/a&b.png", name: "a&b.png", width: 2400, height: 1600 };

  test("slides: on a slide under its text, at a height in cqw; or on a new slide after it, under its name", async () => {
    const deck = `<body>\n<section class="slide" data-layout="content">\n  <h2>Two</h2>\n  <p>Hello</p>\n</section>\n</body>`;
    const slides = await api("slides");
    const img = (h: number) =>
      `<img src="images/a&amp;b.png" width="2400" height="1600" alt="a&amp;b.png" style="height: ${h}cqw; width: auto; max-width: 100%; align-self: flex-start; object-fit: contain">`;
    expect(made(deck, slides.apply(deck, "add_image", { slide: 1, file, height: 30.5 }))).toContain(
      `<p>Hello</p>\n  ${img(30.5)}\n</section>`
    );
    // (No height, as an agent may call it: one that leaves room. Never taller than the slide's space.)
    expect(made(deck, slides.apply(deck, "add_image", { slide: 1, file }))).toContain(img(20));
    expect(made(deck, slides.apply(deck, "add_image", { slide: 1, file, height: 90 }))).toContain(img(52));
    expect(made(deck, slides.apply(deck, "add_image", { slide: 1, file, fresh: true }))).toContain(
      `</section>\n<section class="slide" data-layout="content">\n  <h2>a&amp;b</h2>\n  ${img(36)}\n</section>`
    );
    expect(slides.apply(deck, "add_image", { slide: 2, file })).toEqual({ refused: "There's no slide 2: the deck has slides 1 to 1." });
    expect(slides.apply(deck, "add_image", { slide: 1 })).toEqual({ refused: "file.src is the image's address from the page." });
  });

  test("canvas: at a point of the canvas, or in a frame, which it then moves with; several images step down and right", async () => {
    const page = `<body>\n<div class="stage">\n  <div class="canvas">\n    <section class="frame" style="left: 240px; top: 320px;">\n      <h2>One</h2>\n    </section>\n  </div>\n</div>\n</body>`;
    const canvas = await api("canvas");
    const img = (at: string, width: number) =>
      `<img src="images/a&amp;b.png" width="2400" height="1600" alt="a&amp;b.png" style="position: absolute; ${at}; width: ${width}px; height: auto; border-radius: 6px">`;
    expect(made(page, canvas.apply(page, "add_image", { frame: 0, x: 1290.4, y: 560, width: 480, file }))).toContain(
      `    </section>\n    ${img("left: 1290px; top: 560px", 480)}\n  </div>`
    );
    expect(made(page, canvas.apply(page, "add_image", { frame: 1, x: 439, y: 333, file, index: 2 }))).toContain(
      `      <h2>One</h2>\n      ${img("left: 487px; top: 381px", 240)}\n    </section>`
    );
    expect(canvas.apply(page, "add_image", { frame: 2, x: 0, y: 0, file })).toEqual({
      refused: "frame is a frame's number, 1 to 1, or 0 for the canvas.",
    });
    expect(canvas.apply(page, "add_image", { frame: 0, x: "a", y: 0, file })).toEqual({ refused: "x and y are numbers of px." });
    expect(canvas.apply(page, "move_frame", {})).toEqual({ refused: 'The canvas has no edit "move_frame".' });
  });
});

describe("a page's API module, in the sandbox", () => {
  const code = `export default {
    name: "notes",
    description: "The page's notes.",
    edits: [{ name: "set_note", description: "Sets the note", input: { type: "object", properties: { text: { type: "string" } } } }],
    apply(html, edit, input) {
      if (!html.includes('id="note"')) return { refused: "the page has no note" };
      return [{ op: "replace", el: "#note", html: '<p id="note">' + input.text + "</p>" }];
    },
  };`;

  test("the page names its module; the module describes its edits and answers one with operations", async () => {
    expect(apiPathOf("blog/post.html", `<meta name="erga-api" content="../api.js">`)).toBe("api.js");
    expect(apiPathOf("blog/post.html", `<meta content='api.js' name=erga-api>`)).toBe("blog/api.js");
    expect(apiPathOf("index.html", `<p>No API</p>`)).toBeNull();
    expect(await describePageApi(testSandbox, code)).toEqual({
      name: "notes",
      description: "The page's notes.",
      edits: [{ name: "set_note", description: "Sets the note", input: { type: "object", properties: { text: { type: "string" } } } }],
    });
    const r = await applyPageEdit(testSandbox, code, page, "set_note", { text: "Done" });
    expect("changes" in r && applyChanges(page, r.changes)).toContain(`<p id="note">Done</p><img`);
  });

  test("a refusal, a bad answer or a module that throws comes back as why", async () => {
    expect(await applyPageEdit(testSandbox, code, "<p>x</p>", "set_note", { text: "a" })).toEqual({ refused: "the page has no note" });
    expect(await applyPageEdit(testSandbox, code, page, "set_note", { text: "<b>a" })).toEqual({
      refused: expect.stringMatching(/set_note can't be made: .*isn't closed/),
    });
    await expect(applyPageEdit(testSandbox, `export default { apply() { throw new Error("boom") } }`, page, "x", {})).rejects.toThrow(
      /didn't answer: boom/
    );
    await expect(describePageApi(testSandbox, `export default { name: "x" }`)).rejects.toThrow(/needs edits/);
  });
});

describe("a page's own edit in the editor: an id is unique in the page", () => {
  // The cards' page and its API (e2e/fixtures/unique-ids): each card's Copy and Up buttons call copy_card and move_up.
  const FIXTURE = new URL("../e2e/fixtures/unique-ids/", import.meta.url).pathname;
  const original = readFileSync(`${FIXTURE}index.html`, "utf8");
  type Api = { apply(html: string, edit: string, input: unknown): unknown };
  const ids = (src: string) => [...src.matchAll(/<[a-z0-9]+ [^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const cards = (src: string) => [...src.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);

  test("a page's own edit that copies a card: the copy loses the id, the original keeps it; a move keeps the id; undo brings back the page", async () => {
    const api: Api = (await import(`${FIXTURE}api.js`)).default;
    // The editor on the page, the caret in the first card's heading (where the click on its button leaves it).
    const ed = keys(original.replace("First card", "|First card"));
    const source = () => ed.state.doc.toString();
    /** One of the page's edits, as the editor makes it (ui/render.ts, pageEdit): the API's operations, as one change. */
    const call = (edit: string, input: unknown) => {
      const src = source();
      const plan = planPageOps(src, api.apply(src, edit, input));
      if ("error" in plan) throw new Error(plan.error);
      ed.make(plan.changes, "input.page", plan.caret);
    };
    expect(ids(original)).toEqual(["target", "linked", "link", "card-1", "card-2"]);
    // Copy on the first card: its script sends the card's place, its id and its title.
    call("copy_card", { card: 1, id: "card-1", title: "First card" });
    expect(source()).toContain(`<article class="card">\n      <h3>First card (copy)</h3>\n    </article>`);
    expect(ids(source())).toEqual(["target", "linked", "link", "card-1", "card-2"]);
    // Up on the second card, which is the third now.
    call("move_up", { card: 3 });
    expect(cards(source())).toEqual(["First card", "Second card", "First card (copy)"]);
    expect(ids(source())).toEqual(["target", "linked", "link", "card-1", "card-2"]);
    ed.key("Undo").key("Undo");
    expect(source()).toBe(original);
  });
});
