// Documents: each document's chevron opens its pages beneath its row and closes them, always saying which; what's open is kept for the tab.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../fixtures";
import { clickOn, multi } from "./tree";

await servers.main();

type State = { expanded: string | null; turned: boolean; shown: boolean; rows: number; text: string };
/** What a document's row shows: whether the chevron says open, it's turned, and its pages show (and how). */
const state = (page: Page, id: string) => page.evaluate(`(() => {
  const b = document.querySelector('button.twist[data-id="${id}"]'), sub = document.getElementById("pages-${id}");
  return { expanded: b.getAttribute("aria-expanded"), turned: getComputedStyle(b.querySelector("svg")).transform != "none",
    shown: !!sub && sub.getClientRects().length > 0 && sub.offsetHeight > 0,
    rows: sub ? sub.querySelectorAll(".et-row[data-path]").length : 0, text: sub?.textContent ?? "" };
})()`) as Promise<State>;
const isOpen = (page: Page, id: string, ready: (s: State) => boolean) =>
  expect.poll(async () => { const s = await state(page, id); return s.expanded == "true" && s.turned && s.shown && ready(s); }).toBe(true);
const isClosed = (page: Page, id: string) =>
  expect.poll(async () => { const s = await state(page, id); return s.expanded == "false" && !s.turned && !s.shown; }).toBe(true);
const twist = (page: Page, id: string) => clickOn(page, `button.twist[data-id="${id}"]`);

/** A new document from the Page template: no other pages yet. */
async function empty(root: string) {
  const made = (await fetch(`${root}/new?template=page`, { redirect: "manual" })).headers.get("location") ?? "";
  expect(made).toMatch(/#edit$/);
  return ((await (await fetch(`${root}${made.replace(/#edit$/, "")}/api/name`)).json()) as { id: string }).id;
}
const hasRows = (s: State) => s.rows > 0;
const nonePlaceholder = (s: State) => /No other pages yet\./.test(s.text) && /New page/.test(s.text) && /New folder/.test(s.text);

for (const [what, make, ready] of [
  ["a document with pages", async (_root: string) => (await multi(await servers.main())).id, hasRows],
  ["a document with no other pages yet (No other pages yet., with New page and New folder)", empty, nonePlaceholder],
] as const) {
  test(`${what}: the chevron opens and closes its pages, twice, and shows which`, async ({ tab }) => {
    const page = tab.page;
    tab.strict = true;
    const server = await servers.main();
    const id = await make(server.root);
    await page.goto(`${server.root}/docs`);
    for (let i = 0; i < 2; i++) {
      await isClosed(page, id);
      await twist(page, id);
      await isOpen(page, id, ready);
      await twist(page, id);
    }
    await isClosed(page, id);
  });
}

test("what's open is kept for the tab across a reload, and still closes; the others stay closed", async ({ tab }) => {
  const page = tab.page;
  tab.strict = true;
  const server = await servers.main();
  const full = (await multi(server)).id, none = await empty(server.root);
  await page.goto(`${server.root}/docs`);
  await twist(page, none);
  await isOpen(page, none, () => true);
  await page.reload();
  await isOpen(page, none, (s) => /No other pages yet\./.test(s.text));
  await isClosed(page, full);
  await twist(page, none);
  await isClosed(page, none);
});
