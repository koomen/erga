// New folder and New page, at the top level and in a folder, named in place (tests/tree.ts, "the editor": New folder, New page).
import { expect, servers, test, until } from "../fixtures";
import { act, clickOn, focused, menuItem, multi, openCard, openTreeEditor, press, rows, type, js } from "./tree";

await servers.main();

test("New folder (the foot) asks for its name in place and makes it; its + menu's New page makes a page in it, named without .html, then .html on disk", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, ".et-foot .et-add:nth-child(2)");
  await expect.poll(() => focused(page)).toBe("input");
  await type(page, "notes");
  await press(page, "Enter");
  await until(async () => (await doc.tree()).includes("notes"), 5000, "the folder is made");
  await expect.poll(() => focused(page)).toBe("notes");
  await act(page, "notes", "add");
  await menuItem(page, "New page");
  await type(page, "Ideas");
  // No .html anywhere: they're pages, not files.
  expect(await js(page, `document.getElementById("pages").textContent`)).not.toContain(".html");
  await press(page, "Enter");
  await until(async () => (await doc.tree()).includes("notes/ideas.html"), 5000, "the page is made: its name as an address, then .html");
  // Inside the folder, which opened, by its name.
  await expect.poll(async () => (await rows(page)).some((x) => x[0] == "notes/ideas.html" && x[1] == "Ideas" && x[2] == 3)).toBe(true);
});

test("a taken name says so, in place, before it goes anywhere; Escape drops it", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await clickOn(page, ".et-foot .et-add:nth-child(1)");
  await type(page, "about");
  await press(page, "Enter");
  await expect.poll(() => js(page, `document.querySelector(".et-msg.error")?.textContent ?? ""`)).toMatch(/already a page called “About”/);
  await press(page, "Escape");
  await expect.poll(() => js(page, `!!document.querySelector(".et-input")`)).toBe(false);
});
