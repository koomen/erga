// Delete: a page at once, a folder after a question in its row; the root document stays (tests/tree.ts, "the editor": delete).
import { expect, servers, test, until } from "../fixtures";
import { act, clickOn, menuItem, multi, openCard, openTreeEditor, press, row, js } from "./tree";

await servers.main();

test("Delete page deletes it at once; Delete folder asks first, in its row; Escape keeps it; the Delete key and the confirm button delete it and what's in it", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await doc.agentTool("new_page", { path: "notes/ideas" });
  await doc.agentTool("new_page", { path: "notes/more" });
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, row("notes"));
  await act(page, "notes/ideas.html", "more");
  await menuItem(page, "Delete page");
  await until(async () => !(await doc.tree()).includes("notes/ideas.html"), 5000, "a page is deleted");
  await act(page, "notes", "more");
  await menuItem(page, "Delete folder");
  await expect.poll(() => js(page, `document.querySelector(".et-row.confirm")?.textContent ?? ""`)).toMatch(/Delete the folder “notes” and the page in it\?/);
  await press(page, "Escape");
  await expect.poll(() => js(page, `!!document.querySelector(".et-row.confirm")`)).toBe(false);
  expect(await doc.tree()).toContain("notes");
  await page.evaluate(`document.querySelector(${JSON.stringify(row("notes"))}).focus()`);
  await press(page, "Delete");
  await clickOn(page, ".et-row.confirm .et-btn.danger");
  await until(async () => !(await doc.tree()).some((x) => x.startsWith("notes")), 5000, "Delete, confirmed, deletes it and what's in it");
});

test("the root document can't be deleted or moved: its row has no menu", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  expect(await js(page, `!!document.querySelector('${row("index.html")} [data-act="more"]')`)).toBe(false);
});
