// evaluate_page's run, in the tab: an expression in view_page's render, its result as JSON;
// read-only, with a time limit and a size cap ("Inspecting the page for the agent").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

type Ev = { value?: string; note?: string; error?: string; errors: string[] };
const ev = (ed: Editor, expr: string, more = "") => ed.eval<Ev>(`ergaPage.captureView({ evaluate: ${JSON.stringify(expr)}${more} })`);

test("it gives a computed style as the page has it, an element's size, and statements with a return, elements read as tags", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const h1Size = await ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).fontSize`);
  const style = await ev(ed, `getComputedStyle(document.querySelector("h1")).fontSize`);
  expect(style.error).toBeUndefined();
  expect(style.value).toBe(JSON.stringify(h1Size));
  const rect = JSON.parse((await ev(ed, `document.querySelector("figure").getBoundingClientRect()`)).value ?? "{}");
  expect(rect.width).toBeGreaterThan(100);
  expect(rect.height).toBeGreaterThan(10);
  expect("top" in rect).toBe(true);
  const els = JSON.parse((await ev(ed, `const all = [...document.querySelectorAll("h1, figure")]; return { all, fonts: [...document.fonts].length, styles: Object.keys(getComputedStyle(document.body)).length };`)).value ?? "{}");
  expect(els.all).toEqual(["<h1>", "<figure>"]);
  expect(typeof els.fonts).toBe("number");
});

test("what it changes stays in its throwaway render, and it can't reach the editor around the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const before = await ed.source();
  const changed = await ev(ed, `(document.querySelector("h1").textContent = "Changed by evaluate", document.querySelector("h1").textContent)`);
  expect(changed.value).toBe('"Changed by evaluate"');
  await ed.settle();
  expect(await ed.source()).toBe(before);
  expect(await ed.frame<string>(`${F}.querySelector("h1").textContent`)).not.toContain("Changed");
  expect((await ev(ed, `[parent, top, opener, frameElement, window.parent, window.frameElement]`)).value).toBe("[null,null,null,null,null,null]");
});

test("an expression that never finishes times out; a large result is cut and says so", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const slow = await ev(ed, `new Promise(() => {})`, ", timeout: 300");
  expect(slow.error ?? "").toMatch(/didn't finish within 300 ms/);
  expect(slow.value).toBeUndefined();
  const big = await ev(ed, `"x".repeat(100000)`);
  expect(big.value?.length).toBe(20000);
  expect(big.note ?? "").toMatch(/100002 characters/);
});

test("an expression that throws, or doesn't parse, says why; cycles, bigints and functions still make JSON", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  expect((await ev(ed, `document.querySelector("#nope").width`)).error ?? "").toMatch(/The expression threw: TypeError/);
  expect((await ev(ed, `1 +* 2`)).error ?? "").toMatch(/doesn't parse/);
  expect((await ev(ed, `(() => { const a = { n: 1n, f() {}, u: undefined }; a.self = a; return a; })()`)).value).toBe('{"n":"1n","f":"[function f]","u":null,"self":"[circular]"}');
});
