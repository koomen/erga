// An admin renames the homepage project (/_home) as any other document: its title in the editor, and rename_document.
// The pages dropdown and the title card give its address as /_home, never its row's owner and slug (/-home/home).
import { expect, servers, test } from "../../helpers/fixtures";
import { act, clickOn, js, openCard, openTreeEditor, press } from "../tree/tree";
import { runTool } from "../../helpers/tools";
import { fresh, resetLanding } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

/** The title as the breadcrumb shows it. */
const title = (page: Parameters<typeof js>[0]) => js(page, `document.getElementById("doc-title-text").textContent`);

test("an admin renames the homepage in the breadcrumb: the title stays after a reload, and the dropdown gives /_home", async ({ tab }) => {
  const server = await servers.short();
  await fresh(server);
  const page = tab.page;
  await page.setViewportSize({ width: 1200, height: 800 });
  await openTreeEditor(tab, `${server.root}/_home`);
  await openCard(page);
  // index.html is the page at /_home.
  expect(await js(page, `document.querySelector('#pages .et-row[data-path="index.html"] .et-name').getAttribute("href")`)).toBe(
    "/_home?edit"
  );
  await act(page, "index.html", "rename");
  await expect.poll(() => js(page, `!document.getElementById("naming").hidden && document.activeElement.id == "naming-title"`)).toBe(true);
  // The address is /_home, and it doesn't change: no slug to type in.
  expect(await js(page, `document.getElementById("naming-prefix").textContent`)).toBe("/_home");
  expect(await js(page, `document.getElementById("naming-slug").getBoundingClientRect().width`)).toBe(0);
  await page.keyboard.type("Our homepage");
  await press(page, "Enter");
  await expect.poll(() => js(page, `document.getElementById("naming").hidden`)).toBe(true);
  expect(await js(page, `document.getElementById("naming-status").textContent`)).not.toMatch(/can't/);
  await expect.poll(() => title(page)).toBe("Our homepage");
  expect(new URL(page.url()).pathname).toBe("/_home");
  await page.reload();
  await expect.poll(() => title(page)).toBe("Our homepage");
  await clickOn(page, "#doc-title");
  await expect
    .poll(() => js(page, `document.querySelector('#pages .et-row[data-path="index.html"] .et-name')?.textContent`))
    .toBe("Our homepage");
});

test("rename_document renames the homepage project for an admin, and refuses a new address", async () => {
  const server = await servers.short();
  const { id } = await fresh(server);
  const r = await runTool(server.root, "rename_document", { document: id, title: "Home, renamed" });
  expect(r.error).toBeUndefined();
  expect(r.result).toMatchObject({ title: "Home, renamed", address: "/_home" });
  const listed = (await runTool(server.root, "list_documents", { query: "Home, renamed" })).result as { address: string; url?: string }[];
  expect(listed.map((d) => [d.address, d.url && new URL(d.url).pathname])).toEqual([["/_home", "/_home"]]);
  const slug = await runTool(server.root, "rename_document", { document: id, slug: "other" });
  expect(slug.error).toMatch(/\/_home/);
});
