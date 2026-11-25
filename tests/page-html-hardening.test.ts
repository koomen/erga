// Hardening tests for opening-tag attribute scanning (libs/text/api/source.ts),
// page-edit API timeouts (libs/text/ui/page-edits.ts), and ergaEditor.cleanClone (client/inline/page-editing-api.ts).

import { describe, expect, test } from "bun:test";
import { attrOf, setAttr } from "../libs/text/api/source";
import { runPageEdit } from "../libs/text/ui/page-edits";
import pageEditingApi from "../client/inline/page-editing-api";

describe("opening-tag attribute scanning", () => {
  test("never matches an attribute name inside another attribute's quoted value", () => {
    expect(attrOf(`<div data-note="class=foo">`, "class")).toBeNull();
    expect(attrOf(`<div data-note="a class=foo">`, "class")).toBeNull();
    expect(attrOf(`<div data-note='a class="foo"' class="real">`, "class")).toBe("real");
    expect(attrOf(`<div data-note="a>b" class="real">`, "class")).toBe("real");
    expect(attrOf(`<ol reversed>`, "reversed")).toBe("");
    expect(attrOf(`<a HREF="https://example.com?a=1&amp;b=2">`, "href")).toBe("https://example.com?a=1&b=2");
  });

  test("sets, replaces and removes attributes without corrupting quoted attribute values", () => {
    expect(setAttr(`<div data-note="a class=foo">`, "class", "bar")).toBe(`<div data-note="a class=foo" class="bar">`);
    expect(setAttr(`<div data-note="a class=foo">`, "class", null)).toBe(`<div data-note="a class=foo">`);
    expect(setAttr(`<div data-note="a class=foo" class="old">`, "class", "new")).toBe(`<div data-note="a class=foo" class="new">`);
    expect(setAttr(`<div data-note="a class=foo" class="old">`, "class", null)).toBe(`<div data-note="a class=foo">`);
    expect(setAttr(`<div data-note="a>b" id="x">`, "id", "y")).toBe(`<div data-note="a>b" id="y">`);
    expect(setAttr(`<ol reversed>`, "reversed", null)).toBe(`<ol>`);
    expect(setAttr(`<img src="a.png"/>`, "alt", "pic")).toBe(`<img src="a.png" alt="pic"/>`);
  });
});

describe("runPageEdit timeout", () => {
  const html = `<body><p id="note">Before</p></body>`;

  test("fails cleanly when api.apply never settles", async () => {
    const hung = `export default { apply() { return new Promise(() => {}); } };`;
    const r = await runPageEdit(hung, html, "hang", {}, 20);
    expect("error" in r && r.error).toMatch(/timed out after 20 ms/);
  });

  test("resolves sync and async api.apply calls normally", async () => {
    const sync = `export default { apply() { return [{ op: "replace", el: "#note", html: '<p id="note">Sync</p>' }]; } };`;
    const asyncCode = `export default { async apply() { return [{ op: "replace", el: "#note", html: '<p id="note">Async</p>' }]; } };`;
    expect("changes" in (await runPageEdit(sync, html, "go", {}, 200))).toBe(true);
    expect("changes" in (await runPageEdit(asyncCode, html, "go", {}, 200))).toBe(true);
  });
});

describe("ergaEditor.cleanClone", () => {
  test("clones an element and strips erga-* elements, data-erga* attributes, and contenteditable", () => {
    type FakeEl = {
      localName: string;
      attrs: Map<string, string>;
      children: FakeEl[];
      parent: FakeEl | null;
      readonly attributes: { name: string; value: string }[];
      removeAttribute(name: string): void;
      remove(): void;
      querySelectorAll(sel: string): FakeEl[];
      cloneNode(deep: boolean): FakeEl;
    };
    const makeEl = (localName: string, attrs: Record<string, string>, children: FakeEl[] = []): FakeEl => {
      const map = new Map(Object.entries(attrs));
      const el: FakeEl = {
        localName,
        attrs: map,
        children,
        parent: null,
        get attributes() {
          return [...map.entries()].map(([name, value]) => ({ name, value }));
        },
        removeAttribute: (name) => {
          map.delete(name);
        },
        remove: () => {
          if (!el.parent) return;
          el.parent.children = el.parent.children.filter((c) => c != el);
          el.parent = null;
        },
        querySelectorAll: () => {
          const out: FakeEl[] = [];
          const walk = (n: FakeEl) => {
            for (const c of n.children) {
              out.push(c);
              walk(c);
            }
          };
          walk(el);
          return out;
        },
        cloneNode: (deep) => makeEl(localName, Object.fromEntries(map), deep ? el.children.map((c) => c.cloneNode(true)) : []),
      };
      for (const c of children) c.parent = el;
      return el;
    };

    const g = globalThis as Record<string, unknown>;
    const prevWin = g.window,
      prevDoc = g.document;
    const fakeWin: Record<string, unknown> = {};
    g.window = fakeWin;
    g.document = { documentElement: { hasAttribute: () => true } };
    try {
      pageEditingApi();
      const editor = fakeWin.ergaEditor as { editing: boolean; cleanClone<T>(el: T): T };
      expect(editor.editing).toBe(true);
      const slide = makeEl("section", { class: "slide", hidden: "", "data-erga-editing": "", contenteditable: "true" }, [
        makeEl("h1", { "data-erga-text": "", contenteditable: "true", class: "title" }),
        makeEl("erga-caret", { "data-erga": "" }),
        makeEl("p", { "data-erga-noedit": "", id: "keep" }, [makeEl("erga-peer", {})]),
      ]);
      const copy = editor.cleanClone(slide);
      expect(copy).not.toBe(slide);
      // Original is untouched.
      expect(slide.attrs.has("contenteditable")).toBe(true);
      expect(slide.children.map((c) => c.localName)).toEqual(["h1", "erga-caret", "p"]);
      // Clone strips erga-* descendants, data-erga*, and contenteditable, keeping page attributes like hidden/class/id.
      expect([...copy.attrs.keys()].sort()).toEqual(["class", "hidden"]);
      expect(copy.children.map((c) => c.localName)).toEqual(["h1", "p"]);
      expect([...copy.children[0].attrs.keys()]).toEqual(["class"]);
      expect([...copy.children[1].attrs.keys()]).toEqual(["id"]);
      expect(copy.children[1].children).toEqual([]);
    } finally {
      g.window = prevWin;
      g.document = prevDoc;
    }
  });
});
