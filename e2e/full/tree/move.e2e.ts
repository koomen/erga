// Move to…, and drag and drop, with the warning about relative links; the tree says page, not document ("the editor": move).
import { expect, servers, test, until } from "../../helpers/fixtures";
import { act, menuItem, menuItems, multi, openCard, openTreeEditor, rows, js } from "./tree";

await servers.main();

test("a page's menu says page (never document); Move page to… moves it into a folder", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await doc.agentTool("new_page", { path: "notes/ideas" });
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await act(page, "contact.html", "more");
  expect(await menuItems(page)).toEqual(["Open in a new tab", "Rename page", "Move page to…", "Delete page"]);
  const words = await page.evaluate(`document.getElementById("pages").textContent + " " + [...document.querySelectorAll("#pages [aria-label], #pages [placeholder], #pages [title]")].map((e) => (e.getAttribute("aria-label") ?? "") + " " + (e.getAttribute("placeholder") ?? "") + " " + (e.getAttribute("title") ?? "")).join(" ")`) as string;
  expect(words).toContain("New page");
  // Only index.html's row renames the document.
  expect(words.replace(/Rename this document, or change its address/g, "")).not.toMatch(/\bdocuments?\b/i);
  await menuItem(page, "Move page to…");
  await menuItem(page, "notes");
  await until(async () => (await doc.tree()).includes("notes/contact.html"), 5000, "Move to… moves it into the folder");
});

test("dropping a page on a folder moves it there: the folder lights up under it, the page keeps its title, and a note warns its relative links may break", async ({ tab }) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  const shown = await page.evaluate(`(() => {
    const from = document.querySelector('.et-row[data-path="about.html"]'), to = document.querySelector('.et-row[data-path="blog"]');
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const lit = to.classList.contains("drop");
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return lit;
  })()`);
  expect(shown).toBe(true);
  await until(async () => (await doc.tree()).includes("blog/about.html"), 5000, "dropped on a folder, it moves there");
  await expect.poll(() => js(page, `document.querySelector(".et-banner.note")?.textContent ?? ""`)).toMatch(/Moved\. “About us” finds its styles, images and links by where it was/);
  await expect.poll(async () => (await rows(page)).some((x) => x[0] == "blog/about.html" && x[1] == "About us")).toBe(true);
});
