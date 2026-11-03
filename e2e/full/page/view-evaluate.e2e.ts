// eval_in_page, as an agent calls it: an expression in view_page's render, in the server's browser, its result as
// JSON; read-only, with a time limit and a size cap ("Inspecting the page for the agent").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";
import { agentTools } from "./view-page";

await servers.main();

/** The page fixture, open in the editor, and eval_in_page on it: the result's first part, or the error. */
async function open(tab: Parameters<typeof openEditor>[0]) {
  const s = await servers.main();
  const ed = await openEditor(tab, s, "page");
  const { tool, fails } = await agentTools(s, ed.address);
  const ev = async (expression: string, more: object = {}) => (await tool("eval_in_page", { expression, ...more })).text.split("\n\n");
  const evFails = (expression: string, more: object = {}) => fails("eval_in_page", { expression, ...more });
  return { ed, ev, evFails };
}

test("it gives a computed style as the page has it, an element's size, and statements with a return, elements read as tags", async ({ tab }) => {
  const { ed, ev } = await open(tab);
  const h1Size = await ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).fontSize`);
  expect((await ev(`getComputedStyle(document.querySelector("h1")).fontSize`))[0]).toBe(JSON.stringify(h1Size));
  const rect = JSON.parse((await ev(`document.querySelector("figure").getBoundingClientRect()`))[0]);
  expect(rect.width).toBeGreaterThan(100);
  expect(rect.height).toBeGreaterThan(10);
  expect("top" in rect).toBe(true);
  const els = JSON.parse(
    (
      await ev(
        `const all = [...document.querySelectorAll("h1, figure")]; return { all, fonts: [...document.fonts].length, styles: Object.keys(getComputedStyle(document.body)).length };`
      )
    )[0]
  );
  expect(els.all).toEqual(["<h1>", "<figure>"]);
  expect(typeof els.fonts).toBe("number");
});

test("what it changes stays in its throwaway render, and it can't reach the editor around the page", async ({ tab }) => {
  const { ed, ev } = await open(tab);
  const before = await ed.source();
  expect(
    (await ev(`(document.querySelector("h1").textContent = "Changed by evaluate", document.querySelector("h1").textContent)`))[0]
  ).toBe('"Changed by evaluate"');
  await ed.settle();
  expect(await ed.source()).toBe(before);
  expect(await ed.frame<string>(`${F}.querySelector("h1").textContent`)).not.toContain("Changed");
  expect((await ev(`[parent, top, opener, frameElement, window.parent, window.frameElement]`))[0]).toBe("[null,null,null,null,null,null]");
});

test("an expression that never finishes times out; a large result is cut and says so", async ({ tab }) => {
  const { ev, evFails } = await open(tab);
  expect(await evFails(`new Promise(() => {})`, { timeout: 300 })).toMatch(/didn't finish within 300 ms/);
  const [big, note] = await ev(`"x".repeat(100000)`);
  expect(big.length).toBe(20000);
  expect(note).toMatch(/100002 characters/);
});

test("an expression that throws, or doesn't parse, says why; cycles, bigints and functions still make JSON", async ({ tab }) => {
  const { ev, evFails } = await open(tab);
  expect(await evFails(`document.querySelector("#nope").width`)).toMatch(/The expression threw: TypeError/);
  expect(await evFails(`1 +* 2`)).toMatch(/doesn't parse/);
  expect((await ev(`(() => { const a = { n: 1n, f() {}, u: undefined }; a.self = a; return a; })()`))[0]).toBe(
    '{"n":"1n","f":"[function f]","u":null,"self":"[circular]"}'
  );
});
