// ⌘K, the quick search (client/common/quick-search.ts): on every page for someone signed in, it finds the pages of the
// project you're in, documents and Erga's own pages, the admin ones only for an admin. In a document it opens from inside
// the page too, and the editor's link moved to ⌘⇧K. The avatar's menu has it too: Go to…, with the key.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";
import { runTool } from "../../helpers/tools";
import { clickOn } from "./access";
import { openViewer } from "../viewer/viewer";

await servers.main();

/** The pane as a person sees it: its groups, its rows (label and address) and the row chosen; null while it's closed. */
const pane = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector<HTMLElement>(".erga-qs");
    if (!r || r.hidden) return null;
    return {
      groups: [...r.querySelectorAll(".erga-qs-group")].map((g) => g.textContent),
      rows: [...r.querySelectorAll(".erga-qs-item")].map((i) => i.textContent),
      picked: r.querySelector('[aria-selected="true"] b')?.textContent ?? null,
    };
  });

test("on /docs, ⌘K opens it with Erga's pages and, for an admin, the admin ones; typing narrows it, ↓ and Enter open one, Escape closes it", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await servers.main()).root;
  await page.goto(`${root}/docs`);
  await page.keyboard.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toEqual(expect.arrayContaining(["Pages", "Admin"]));
  expect((await pane(page))!.rows).toEqual(expect.arrayContaining(["Settings#settings", "Users/admin/users"]));
  await page.keyboard.type("admin");
  await expect.poll(async () => (await pane(page))?.groups).toEqual(["Admin"]);
  await page.keyboard.type(" au");
  await expect.poll(async () => (await pane(page))?.rows).toEqual(["Authentication/admin/auth"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await pane(page))?.rows.length).toBe(7);
  await page.keyboard.press("ArrowDown");
  expect((await pane(page))!.picked).toBe("API keys");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${root}/admin/api-keys`);
  await page.keyboard.press("ControlOrMeta+k");
  await expect.poll(() => pane(page)).not.toBeNull();
  await page.keyboard.press("Escape");
  await expect.poll(() => pane(page)).toBeNull();
  expect(tab.errors).toEqual([]);
});

test("for someone who isn't an admin, it has no admin pages", async ({ tab }) => {
  const page = tab.page,
    root = (await servers.main()).root;
  await page.goto(`${root}/docs?user=Bo`);
  await page.keyboard.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
  const p = (await pane(page))!;
  expect(p.groups).not.toContain("Admin");
  expect(p.rows.some((r) => r!.includes("/admin"))).toBe(false);
  await page.keyboard.type("users");
  await expect.poll(async () => (await pane(page))?.rows).toEqual([]);
});

test("in a document, ⌘K opens it from inside the page, viewing and editing; in the editor ⌘⇧K is the link", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const page = tab.page;
  // Editing: the key goes from the page to the shell.
  const at = await ed.charAt("h1", 2);
  await ed.click(at.x, at.y);
  await ed.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
  await page.keyboard.press("Escape");
  await expect.poll(() => pane(page)).toBeNull();
  await ed.selectChars("h1", 6);
  await ed.press("ControlOrMeta+Shift+k");
  await expect.poll(() => ed.controls<boolean>(`!C.getElementById("fmt").hidden && !C.getElementById("link").hidden`)).toBe(true);
  expect(await pane(page)).toBeNull();
  // Viewing: the page's own frame passes it on.
  await openViewer(page, ed.address);
  await page.mouse.click(650, 500);
  await page.keyboard.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
});

/** A new document of the dev server's person, made as the pages make one: its address. */
async function made(root: string, args: Record<string, unknown>): Promise<string> {
  const r = await runTool<{ address: string }>(root, "create_document", args);
  expect(r.error ?? "").toBe("");
  return r.result!.address;
}

test("in a project, Go to… in the avatar's menu shows the key and opens it, the project's pages first; typing and Enter open a page", async ({
  tab,
}) => {
  const page = tab.page,
    root = (await servers.main()).root;
  const at = await made(root, {
    title: "Quick project",
    kind: "project",
    files: { "index.html": "<h1>Home</h1>", "plans/roadmap.html": "<title>Road map</title><h1>Road map</h1>" },
  });
  await openViewer(page, root + at);
  await clickOn(page, "[data-erga-account] button");
  expect(await page.evaluate(() => document.querySelector(".erga-account-go")?.textContent)).toBe(
    `Go to…${process.platform == "darwin" ? "⌘K" : "Ctrl K"}`
  );
  await page.screenshot({ path: ".e2e/shots/quick-search-menu.png" });
  await clickOn(page, ".erga-account-go");
  await expect.poll(async () => (await pane(page))?.groups[0]).toBe("Pages of Quick project");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".erga-account-menu")!.hidden), "the menu closed").toBe(true);
  expect((await pane(page))!.rows.slice(0, 2)).toEqual([`Home${at}`, `Road map${at}/plans/roadmap`]);
  await page.screenshot({ path: ".e2e/shots/quick-search-project.png" });
  await page.keyboard.type("road");
  await expect.poll(async () => (await pane(page))?.rows).toEqual([`Road map${at}/plans/roadmap`]);
  await page.keyboard.press("Enter");
  await page.waitForURL(`${root}${at}/plans/roadmap`);
  expect(tab.errors).toEqual([]);
});

test("in the editor, ⌘K finds a document made since it last opened, never a scratch one; Enter opens it; the editor's Go to… opens it too", async ({
  tab,
}) => {
  const root = (await servers.main()).root;
  const ed = await openEditor(tab, await servers.main(), "page");
  const page = tab.page;
  const at = await ed.charAt("h1", 2);
  await ed.click(at.x, at.y);
  await ed.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Documents");
  await page.keyboard.press("Escape");
  await expect.poll(() => pane(page)).toBeNull();
  // Made while the editor is open: the next ⌘K reads the list again.
  const fresh = await made(root, { title: "Zebra crossing notes" });
  const scratch = await made(root, { title: "Zebra scratch", scratch: true });
  await ed.press("ControlOrMeta+k");
  await page.keyboard.type("zebra");
  await expect.poll(async () => (await pane(page))?.rows).toEqual([`Zebra crossing notes${fresh}`]);
  expect((await pane(page))!.rows.join(" ")).not.toContain(scratch);
  await page.screenshot({ path: ".e2e/shots/quick-search-editor.png" });
  // The editor keeps its text: none of the keys reached it.
  expect(await ed.source()).not.toContain("zebra");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${root}${fresh}`);
  // The editor's own avatar menu (client/editor.html, #account).
  const ed2 = await openEditor(tab, await servers.main(), "page");
  await ed2.loaded();
  await clickOn(page, "#me .avatar");
  await clickOn(page, "#account-go");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Documents");
  expect(await page.evaluate(() => document.getElementById("account")!.hidden), "the menu closed").toBe(true);
});
