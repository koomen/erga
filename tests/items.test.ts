import { describe, expect, test } from "bun:test";
import { analyzeItems, addItem, removeItem, moveItem, indentItem, outdentItem, applyItemEdit, type ItemEdit, type Structure } from "../src/page/items";
import { parseHtml, type ElementNode } from "../src/page/manuscript";

const tree = `<body>
  <ul class="branch" data-erga-list="view">
    <li>
      <div class="view"><h3>Front</h3><p class="url">/</p></div>
    </li>
    <li>
      <div class="view"><h3>Docs</h3><p class="url">/docs</p></div>
      <ul class="branch" data-erga-list="view">
        <li>
          <div class="view"><h3>New</h3><p class="url">/new</p></div>
        </li>
      </ul>
    </li>
    <li>
      <div class="view"><h3>Settings</h3><p class="url">/settings</p></div>
    </li>
  </ul>
  <template data-erga-item="view">
    <li>
      <div class="view"><h3>New view</h3><p class="url">/path</p></div>
    </li>
  </template>
</body>`;

const s = (src: string) => analyzeItems(src, parseHtml(src));
/** The item whose heading is `name`. */
const item = (src: string, st: Structure, name: string): ElementNode =>
  st.lists.flatMap((l) => l.items).filter((i) => src.slice(i.from, i.to).includes(`<h3>${name}</h3>`)).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
/** The headings in order, nesting shown by indentation. */
function outline(src: string): string {
  const st = s(src), out: string[] = [];
  const walk = (l: Structure["lists"][number], depth: number) => {
    for (const i of l.items) {
      out.push("  ".repeat(depth) + /<h3>(.*?)<\/h3>/.exec(src.slice(i.from, i.to))![1]);
      for (const n of st.lists.filter((x) => x.parentItem == i)) walk(n, depth + 1);
    }
  };
  for (const l of st.lists.filter((x) => !x.parentItem)) walk(l, 0);
  return out.join("\n");
}
/** Applies an edit, checks the result still parses into the same kind of structure, and returns it. */
function run(src: string, f: (st: Structure) => ItemEdit | null): string {
  const e = f(s(src));
  expect(e).not.toBeNull();
  const { src: next, at } = applyItemEdit(src, e!);
  expect(next.slice(at, at + 3)).toBe("<li");
  const st = s(next);
  expect(st.problems).toEqual([]);
  return next;
}

describe("item lists", () => {
  test("finds lists, their nesting and the template", () => {
    const st = s(tree);
    expect(st.lists.length).toBe(2);
    expect(st.lists[1].parentItem).toBe(item(tree, st, "Docs"));
    expect(st.templates.get("view")).toContain("<h3>New view</h3>");
    expect(st.problems).toEqual([]);
    expect(outline(tree)).toBe("Front\nDocs\n  New\nSettings");
  });

  test("adds an item at the end, or after one, indented like its neighbours", () => {
    const end = run(tree, (st) => addItem(tree, st, st.lists[0]));
    expect(outline(end)).toBe("Front\nDocs\n  New\nSettings\nNew view");
    expect(end).toContain(`    </li>\n    <li>\n      <div class="view"><h3>New view</h3><p class="url">/path</p></div>\n    </li>\n  </ul>`);
    const after = run(tree, (st) => addItem(tree, st, st.lists[1], item(tree, st, "New")));
    expect(outline(after)).toBe("Front\nDocs\n  New\n  New view\nSettings");
  });

  test("adds to an empty list", () => {
    const src = `<ul data-erga-list="x"></ul><template data-erga-item="x"><li><h3>A</h3></li></template>`;
    const next = run(src, (st) => addItem(src, st, st.lists[0]));
    expect(next).toBe(`<ul data-erga-list="x">\n  <li><h3>A</h3></li>\n</ul><template data-erga-item="x"><li><h3>A</h3></li></template>`);
  });

  test("deletes an item with what's nested in it, and a nested list it empties", () => {
    const st = s(tree);
    const docs = applyItemEdit(tree, removeItem(tree, st, item(tree, st, "Docs"))!).src;
    expect(outline(docs)).toBe("Front\nSettings");
    const leaf = applyItemEdit(tree, removeItem(tree, st, item(tree, st, "New"))!).src;
    expect(outline(leaf)).toBe("Front\nDocs\nSettings");
    expect(leaf).not.toContain(`<ul class="branch" data-erga-list="view">\n      </ul>`);
    expect(s(leaf).lists.length).toBe(1);
  });

  test("moves an item up and down among its siblings", () => {
    const up = run(tree, (st) => moveItem(tree, st, item(tree, st, "Settings"), -1));
    expect(outline(up)).toBe("Front\nSettings\nDocs\n  New");
    const down = run(tree, (st) => moveItem(tree, st, item(tree, st, "Front"), 1));
    expect(outline(down)).toBe("Docs\n  New\nFront\nSettings");
    const st = s(tree);
    expect(moveItem(tree, st, item(tree, st, "Front"), -1)).toBeNull();
    expect(moveItem(tree, st, item(tree, st, "Settings"), 1)).toBeNull();
  });

  test("moves an item in: into the nested list before it, or a new one", () => {
    const into = run(tree, (st) => indentItem(tree, st, item(tree, st, "Settings")));
    expect(outline(into)).toBe("Front\nDocs\n  New\n  Settings");
    const fresh = run(tree, (st) => indentItem(tree, st, item(tree, st, "Docs")));
    expect(outline(fresh)).toBe("Front\n  Docs\n    New\nSettings");
    expect(fresh).toContain(`<h3>Front</h3><p class="url">/</p></div>\n      <ul class="branch" data-erga-list="view">\n        <li>`);
    const st = s(tree);
    expect(indentItem(tree, st, item(tree, st, "Front"))).toBeNull();
  });

  test("moves an item out, after the item it was in", () => {
    const out = run(tree, (st) => outdentItem(tree, st, item(tree, st, "New")));
    expect(outline(out)).toBe("Front\nDocs\nNew\nSettings");
    expect(s(out).lists.length).toBe(1);
    const st = s(tree);
    expect(outdentItem(tree, st, item(tree, st, "Docs"))).toBeNull();
  });

  test("in and out again gives back the same source", () => {
    const into = run(tree, (st) => indentItem(tree, st, item(tree, st, "Settings")));
    const back = run(into, (st) => outdentItem(into, st, item(into, st, "Settings")));
    expect(back).toBe(tree);
    const fresh = run(tree, (st) => indentItem(tree, st, item(tree, st, "Docs")));
    expect(run(fresh, (st) => outdentItem(fresh, st, item(fresh, st, "Docs")))).toBe(tree);
  });

  test("an item of plain text gets a <p> when something nests in it", () => {
    const src = `<ul data-erga-list="t">\n  <li><h3>A</h3></li>\n  <li><h3>B</h3></li>\n</ul>\n<template data-erga-item="t"><li><h3>N</h3></li></template>`;
    const plain = src.replace("<li><h3>A</h3></li>", "<li>A <em>x</em></li>").replace("<li><h3>B</h3></li>", "<li><h3>B</h3></li>");
    const st = s(plain);
    const e = indentItem(plain, st, st.lists[0].items[1])!;
    const next = applyItemEdit(plain, e).src;
    expect(next).toContain(`<li><p>A <em>x</em></p>\n    <ul data-erga-list="t">\n      <li><h3>B</h3></li>\n    </ul>\n  </li>`);
  });

  test("reports what it can't work with", () => {
    expect(s(`<ul data-erga-list="v"><li>a</li></ul>`).problems.map((p) => p.key)).toEqual(["items:template:v"]);
    expect(s(`<ul data-erga-list="v"><li>a</li></ul><template data-erga-item="v"><li>a</li><li>b</li></template>`).problems.map((p) => p.key)).toEqual(["items:template:v"]);
    const broken = s(`<div data-erga-list="v"><div>a</div><template data-erga-item="v"><div>n</div></template>`);
    expect(broken.lists[0].broken).toBe(true);
    expect(addItem("", broken, broken.lists[0])).toBeNull();
  });
});
