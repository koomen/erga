// A document (one page) and Make a project: in the editor its pages card shows its one page and Make a project
// (which asks once, since it can't be undone), not New page; after it, New page. On Documents a document's row has no
// chevron; a project's has, and says Project.
import { expect, servers, test, until } from "../../fixtures";
import { clickOn, js, openCard, openTreeEditor } from "./tree";

await servers.main();

test("a new document has one page and Make a project; once it's a project it takes new pages, and Documents says so", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const made = (await fetch(`${server.root}/new?template=page`, { redirect: "manual" })).headers.get("location") ?? "";
  const address = made.replace(/[?&]edit=?$/, "");
  const { id } = (await (await fetch(`${server.root}${address}/api/name`)).json()) as { id: string };
  // Documents: no chevron for it.
  await page.goto(`${server.root}/docs`);
  await until(() => page.evaluate(`!!document.querySelector('a.doc[href*="${address}"]')`), 5000, "the document is on the list");
  expect(await js(page, `!!document.querySelector('button.twist[data-id="${id}"]')`)).toBe(false);
  // The editor: its one page, the note, and Make a project (New page and New folder hidden).
  await openTreeEditor(tab, `${server.root}${address}`);
  await openCard(page);
  const foot = () => js(page, `[...document.querySelectorAll("#pages .et-foot .et-add")].filter((b) => !b.hidden).map((b) => b.textContent)`);
  expect(await foot()).toEqual(["Make a project"]);
  expect(await js(page, `document.querySelector("#pages .et-note").textContent`)).toBe("A document has one page. A project has many.");
  // It asks once; the second click makes it a project.
  await clickOn(page, "#pages .et-foot .et-add:not([hidden])");
  expect(await foot()).toEqual(["Make it a project: more pages, for good?"]);
  await clickOn(page, "#pages .et-foot .et-add:not([hidden])");
  await until(async () => JSON.stringify(await foot()) == JSON.stringify(["New page", "New folder"]), 5000, "New page and New folder, once it's a project");
  expect(await js(page, `document.querySelector("#pages .et-banner").textContent`)).toContain("It's a project now");
  // Documents: its chevron, and Project.
  await page.goto(`${server.root}/docs`);
  await until(() => page.evaluate(`!!document.querySelector('button.twist[data-id="${id}"]')`), 5000, "a project's row has its chevron");
  expect(await js(page, `document.querySelector('button.twist[data-id="${id}"]').closest(".name").querySelector(".note.kind").textContent`)).toBe("Project");
});
