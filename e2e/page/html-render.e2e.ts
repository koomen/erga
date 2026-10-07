// The editor on an HTML page: what is editable, and what isn't ("HTML page").
import { expect, servers, settle, test } from "../fixtures";
import { F, openEditor } from "../editor";

await servers.main();

test("the page renders as units; a widget's button is a plain button; the units are the editing hosts; svg text isn't editable", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  expect(await ed.count("[data-erga-id]")).toBeGreaterThanOrEqual(9);
  expect(await ed.frame<boolean>(`!${F}.getElementById("bump").closest("[contenteditable]")`)).toBe(true);
  expect(await ed.frame<boolean>(`${F}.body.getAttribute("contenteditable") == null && ${F}.querySelector("h1").getAttribute("contenteditable") == "true"`)).toBe(true);
  expect(await ed.frame<boolean>(`!${F}.querySelector("svg text").closest("[data-erga-id]")`)).toBe(true);
});

test("the shell's canvas follows the page's background", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.frame(`${F}.body.style.background = "rgb(243, 236, 220)"`);
  await expect.poll(() => ed.eval<string>(`getComputedStyle(document.documentElement).backgroundColor`)).toBe("rgb(243, 236, 220)");
  expect(await ed.eval<boolean>(`document.documentElement.classList.contains("page-light")`)).toBe(true);
});

test("clicking a widget area focuses nothing and leaves the selection alone", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const before = await ed.eval<string>("JSON.stringify(ergaPage.state.selection.main)");
  const box = await ed.rectOf("#stats", 0.9);
  await ed.click(box.x, box.y);
  await settle(tab.page);
  expect(await ed.frame<boolean>(`!${F}.activeElement || ${F}.activeElement == ${F}.body`)).toBe(true);
  expect(await ed.eval<string>("JSON.stringify(ergaPage.state.selection.main)")).toBe(before);
});

test("a widget's button works inside the editor", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const r = await ed.rectOf("#bump");
  await ed.click(r.x, r.y);
  await expect.poll(() => ed.textOf("#count")).toBe("1");
});
