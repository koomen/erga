// The root row's pencil renames the document; Escape closes the tree, back on the title (tests/tree.ts, "the editor").
import { expect, servers, test } from "../fixtures";
import { act, multi, openCard, openTreeEditor, press, js } from "./tree";

test.beforeAll(async () => { await servers.main(); });

test("the root row's pencil opens the title and address card", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await act(page, "index.html", "rename");
  await expect.poll(() => js(page, `!document.getElementById("naming").hidden && document.getElementById("pages").hidden && document.activeElement.id == "naming-title"`)).toBe(true);
  await press(page, "Escape");
  await expect.poll(() => js(page, `document.getElementById("naming").hidden`)).toBe(true);
});

test("Escape closes the tree, the focus back on the title", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await press(page, "Escape");
  await expect.poll(() => js(page, `document.getElementById("pages").hidden && document.activeElement.id == "doc-title"`)).toBe(true);
});
