// Tab and Shift+Tab at the start of a Markdown list item (tests/page.ts, "Tab in a list").
import { expect, servers, test } from "../fixtures";
import { F, openEditor, type Editor } from "../editor";

test.beforeAll(async () => { await servers.main(); });

const list = async (ed: Editor) => (await ed.source()).match(/- Water[\s\S]*?\n(?=\n)/)?.[0] ?? "";
const start = async (ed: Editor, selector: string) => { await ed.clickEnd(selector); await ed.press("Home"); await ed.idle(); };
const L1 = "- Water the plants\n  - Call *Sam* back\n";
const L2 = "- Water the plants\n  - Call *Sam* back\n  - Write it down\n";
const L3 = "- Water the plants\n  - Call *Sam* back\n    - Write it down\n";

/** The last item nested under the first, and a third item after it at the same level (L2). */
async function twoLevels(ed: Editor) {
  await start(ed, "li:last-child p");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(L1);
  await ed.idle();
  await ed.clickEnd("li li p");
  await ed.press("Enter");
  await ed.type("Write it down");
  await expect.poll(() => list(ed)).toBe(L2);
  await ed.idle();
}

test("Tab at the start of an item nests it under the one before, on the page too, with the caret still at the start of its text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await start(ed, "li:last-child p");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(L1);
  await ed.idle();
  await expect.poll(() => ed.frame<string[]>(`[...${F}.querySelectorAll("li li")].map((li) => li.textContent.trim())`)).toEqual(["Call Sam back"]);
  await expect.poll(async () => (await ed.source()).indexOf("Call *Sam*") == (await ed.selection()).head).toBe(true);
});

test("Enter after a nested item starts the next at the same level; Tab in the middle of the text changes nothing", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await twoLevels(ed);
  await ed.press("Tab");
  await ed.settle();
  expect(await list(ed)).toBe(L2);
});

test("Tab again nests one more level, three on the page; Shift+Tab takes it one level back out", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await twoLevels(ed);
  await start(ed, "li li:last-child p");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(L3);
  await ed.idle();
  expect(await ed.count("li li li")).toBe(1);
  await ed.press("Shift+Tab");
  await expect.poll(() => list(ed)).toBe(L2);
  await ed.idle();
});

test("Shift+Tab on a nested item takes it out, with what comes after nested under it, and the caret stays at its start", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await twoLevels(ed);
  await start(ed, "li li:first-child p");
  await ed.press("Shift+Tab");
  await expect.poll(() => list(ed)).toBe("- Water the plants\n- Call *Sam* back\n  - Write it down\n");
  await ed.idle();
  await ed.type("Now ");
  await expect.poll(() => list(ed)).toContain("\n- Now Call *Sam* back\n");
});

test("the first item, and a top-level item with Shift+Tab, stay where they are", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  const before = await ed.source();
  await start(ed, "li:first-child p");
  await ed.press("Tab");
  await ed.press("Shift+Tab");
  await ed.settle();
  expect(await ed.source()).toBe(before);
});

test("a list nested with Tab reaches the disk, and undo takes the indent back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "md");
  await twoLevels(ed);
  await start(ed, "li li:first-child p");
  await ed.press("Shift+Tab");
  await expect.poll(() => list(ed)).toBe("- Water the plants\n- Call *Sam* back\n  - Write it down\n");
  await ed.idle();
  await start(ed, "li:last-child p");
  await ed.press("Tab");
  await expect.poll(() => list(ed)).toBe(L3);
  await ed.idle();
  await expect.poll(() => ed.disk()).toContain("  - Call *Sam* back\n    - Write it down\n");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => list(ed)).toBe("- Water the plants\n- Call *Sam* back\n  - Write it down\n");
  await ed.idle();
});
