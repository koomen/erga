// Rename in place (F2, or the menu); the server's refusal in its own words ("the editor": rename).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { act, menuItem, multi, openCard, openTreeEditor, press, row, type, js } from "./tree";

await servers.main();

test("F2 renames a page in place: its readable name, no .html; Enter renames it on disk", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await page.evaluate(`document.querySelector(${JSON.stringify(row("contact.html"))}).focus()`);
  await press(page, "F2");
  await expect.poll(() => js(page, `document.activeElement?.value`)).toBe("Contact");
  await page.evaluate(`document.activeElement.select()`);
  await type(page, "write-to-us");
  await press(page, "Enter");
  await until(async () => { const t = await doc.tree(); return t.includes("write-to-us.html") && !t.includes("contact.html"); }, 5000, "renamed");
});

test("a folder's name the server refuses (a # in it): its words show in place, and nothing changes", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await doc.agentTool("new", { path: "notes/ideas" });
  await openTreeEditor(tab, doc.base);
  // The refusal is a 400, which the browser logs as an error: that one only.
  tab.strict = false;
  await openCard(page);
  await expect.poll(() => js(page, `!!document.querySelector(${JSON.stringify(row("notes"))})`)).toBe(true);
  await act(page, "notes", "more");
  await menuItem(page, "Rename folder");
  await page.evaluate(`document.activeElement.select()`);
  await type(page, "notes#1");
  await press(page, "Enter");
  await expect.poll(() => js(page, `document.querySelector(".et-msg.error")?.textContent ?? ""`)).toMatch(/can't contain/);
  await press(page, "Escape");
  expect(await doc.tree()).toContain("notes");
  expect(tab.errors.filter((e) => !/Failed to load resource: the server responded with a status of 400/.test(e))).toEqual([]);
});
