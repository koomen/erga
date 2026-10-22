// The editor's title opens the tree: the project as its root row, its pages, folders and other files under it ("the editor").
import { expect, servers, test, until } from "../../fixtures";
import { focused, multi, openCard, openTreeEditor, rows, js } from "./tree";

await servers.main();

test("the title opens the tree: the document by its title as the root row, marked as the page you're on, its pages under it, folders first; focus goes to the page you're on", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  expect(await js(page, `document.getElementById("pages").hidden`)).toBe(true);
  await openCard(page);
  const r = await rows(page);
  expect(r[0]).toEqual(["index.html", "Field guide", 1, true]);
  // Folders first, then pages, then the project's other files.
  expect(r.slice(1).map((x) => [x[0], x[2]])).toEqual([["assets", 2], ["blog", 2], ["fonts", 2], ["about.html", 2], ["contact.html", 2], ["style.css", 2]]);
  expect(r.find((x) => x[0] == "about.html")?.[1]).toBe("About us");
  expect(await js(page, `document.getElementById("doc-title").getAttribute("aria-expanded") == "true"`)).toBe(true);
  // (openTreeEditor waits for the editor's page to have the focus first: see it, and the race it avoids.)
  await expect.poll(() => focused(page)).toBe("index.html");
});

test("a project's tree shows every file, as the server and an agent (ls, find) do; a file that isn't a page opens in the files view", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  const all = await doc.tree();
  for (const f of ["style.css", "assets", "assets/owl.svg", "fonts", "fonts/field.woff2"]) expect(all).toContain(f);
  const ls = await doc.agentTool("ls"), found = await doc.agentTool("find", { pattern: "**/*" });
  for (const f of ["style.css", "assets/", "fonts/"]) expect(ls).toContain(f);
  for (const f of ["assets/owl.svg", "fonts/field.woff2"]) expect(found).toContain(f);
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await page.evaluate(`document.querySelector('.et-row[data-path="assets"]').click()`);
  await until(async () => (await rows(page)).some((x) => x[0] == "assets/owl.svg"), 5000, "the folder of images opens");
  expect(await js(page, `document.querySelector('.et-row[data-path="assets/owl.svg"] a.et-name').getAttribute("href")`)).toMatch(/\?files=assets%2Fowl\.svg$/);
});
