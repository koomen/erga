// A click shows its result at once, before the server answers: a new title, a deleted page. When the server refuses,
// the old state comes back, with the server's words in the same place.
import type { Page, Route } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { act, menuItem, multi, openCard, openTreeEditor, paths, js } from "./tree";

await servers.main();

/** Holds each call of a tool until `refuse` (the server says no) or `pass`. */
async function hold(page: Page, tool: string) {
  const held: Route[] = [];
  await page.route(`**/api/tools/${tool}*`, (r) => void held.push(r));
  const next = async () => {
    await expect.poll(() => held.length).toBeGreaterThan(0);
    return held.shift()!;
  };
  return {
    refuse: async (error: string) =>
      (await next()).fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error }) }),
    pass: async () => (await next()).continue(),
  };
}

const title = (page: Page) => js(page, `document.getElementById("doc-title-text").textContent`);
const naming = (page: Page) =>
  js(
    page,
    `document.getElementById("naming").hidden ? null : [document.getElementById("naming-title").value, document.getElementById("naming-status").textContent]`
  );

test("a new title shows at once; refused, the old one is back, and the card says why with what was typed", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  // (The refused call is an error in the console.)
  tab.strict = false;
  const was = await title(page);
  const rename = await hold(page, "rename_document");
  const typeTitle = async (text: string) => {
    await openCard(page);
    await act(page, "index.html", "rename");
    await expect.poll(async () => (await naming(page)) != null).toBe(true);
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  await typeTitle("Field notes");
  // Before any answer: the title, and the card closed.
  await expect.poll(() => title(page)).toBe("Field notes");
  expect(await naming(page)).toBeNull();
  await rename.refuse("That title is taken.");
  await expect.poll(() => title(page)).toBe(was);
  await expect.poll(() => naming(page)).toEqual(["Field notes", "That title is taken."]);
  // Saved again, and the server agrees: it stays.
  await page.keyboard.press("Enter");
  await expect.poll(() => title(page)).toBe("Field notes");
  await rename.pass();
  await expect
    .poll(async () => ((await (await fetch(`${doc.base}/api/doc`)).json()) as { docName: { title: string } }).docName.title)
    .toBe("Field notes");
  expect(await title(page)).toBe("Field notes");
});

test("a deleted page's row goes at once; refused, it is back, and the tree says why", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await doc.agentTool("new", { path: "ideas" });
  await openTreeEditor(tab, doc.base);
  tab.strict = false;
  await openCard(page);
  await expect.poll(() => paths(page, "#pages")).toContain("ideas.html");
  const rm = await hold(page, "rm");
  await act(page, "ideas.html", "more");
  await menuItem(page, "Delete page");
  await expect.poll(() => paths(page, "#pages")).not.toContain("ideas.html");
  await rm.refuse("Someone is editing that page.");
  await expect.poll(() => paths(page, "#pages")).toContain("ideas.html");
  await expect.poll(() => js(page, `document.querySelector("#pages")?.textContent ?? ""`)).toContain("Someone is editing that page.");
  expect(await doc.tree()).toContain("ideas.html");
});

test("a person added to Share shows at once; refused, they go again, and the card says why", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  tab.strict = false;
  const people = () =>
    js(page, `[...document.querySelectorAll("#sharing-list li")].map((li) => li.textContent.replace(/Can .*/, "").trim().slice(1))`);
  await page.locator("#btn-share").click();
  await expect
    .poll(() => js(page, `!document.getElementById("sharing").hidden && document.getElementById("sharing-status").textContent == ""`))
    .toBe(true);
  const before = await people();
  const share = await hold(page, "share_document");
  await page.keyboard.type("grace");
  await page.keyboard.press("Enter");
  await expect.poll(people).toEqual([...before, "grace"]);
  await share.refuse("There's no user grace.");
  await expect.poll(people).toEqual(before);
  expect(await js(page, `document.getElementById("sharing-status").textContent`)).toBe("There's no user grace.");
});
