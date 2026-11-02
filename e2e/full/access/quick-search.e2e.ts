// ⌘K, the quick search (client/common/quick-search.ts): on every page for someone signed in, it finds documents and
// Erga's own pages, the admin ones only for an admin. In a document it opens from inside the page too, and the editor's
// link moved to ⌘⇧K.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";
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
  await expect
    .poll(() => ed.eval<boolean>(`!document.getElementById("fmt").hidden && !document.getElementById("fmt-link").hidden`))
    .toBe(true);
  expect(await pane(page)).toBeNull();
  // Viewing: the page's own frame passes it on.
  await openViewer(page, ed.address);
  await page.mouse.click(650, 500);
  await page.keyboard.press("ControlOrMeta+k");
  await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
});
