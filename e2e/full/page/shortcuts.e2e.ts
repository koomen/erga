// The shortcut card (client/editor.html, #help): the "?" button in the editor's bar opens it, as ⌘/ does; it lists the
// keys that work, the Markdown you can type among them. ⌘⇧E opens and closes the editor, and the pencil's tip says so.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";

await servers.main();

test("the ? button opens the shortcut card; it lists the Markdown, the comment and the editor's key; ⌘⇧E closes and opens the editor", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  const page = ed.page;
  // One of the keys it lists: "# " makes a heading.
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("# Plan");
  await ed.shows(`
    # Plan|
  `);
  const open = () => ed.eval<boolean>(`!document.getElementById("help").hidden`);
  expect(await open()).toBe(false);
  await page.click("#btn-help");
  await expect.poll(open).toBe(true);
  const rows = await ed.eval<string[]>(
    `[...document.querySelectorAll("#help dt")].map((d) => d.textContent + ": " + d.nextElementSibling.textContent.replace(/\\s+/g, " ").trim())`
  );
  expect(rows).toEqual([
    "Bold: ⌘B",
    "Italic: ⌘I",
    "Code: ⌘E",
    "Link: ⌘⇧K",
    "Clear formatting: ⌘\\",
    "Comment: ⌘⌥M",
    "Insert a block: /",
    "Heading: # to ######",
    "List: - or 1.",
    "To-do: [ ]",
    "Quote: >",
    "Code block: ``` Enter",
    "Divider: --- Enter",
    "Indent a list item: Tab / ⇧Tab",
    "New paragraph: Enter",
    "Line break: ⇧Enter",
    "Undo / redo: ⌘Z / ⌘⇧Z",
    "Leave text: Esc",
    "Open or close the editor: ⌘⇧E",
    "Page / source: ⌘⇧P",
    "Agent: ⌘J",
    "Go to a document or page: ⌘K",
    "Zoom: ⌘+ ⌘− ⌘0",
    "Print: ⌘P",
    "This list: ⌘/",
  ]);
  // (Nothing marks the others' edits: the card no longer says so.)
  expect(await ed.eval<string>(`document.getElementById("help").innerText`)).not.toContain("marked in their colour");
  await until(() => ed.eval<boolean>(`document.getElementById("help").getAnimations().length == 0`), 3000, "the card is drawn");
  await page.screenshot({ path: ".e2e/shots/shortcuts-card.png" });
  // The button closes it too; ⌘/ still opens it.
  await page.click("#btn-help");
  await expect.poll(open).toBe(false);
  await page.keyboard.press("ControlOrMeta+/");
  await expect.poll(open).toBe(true);
  await page.keyboard.press("Escape");

  // ⌘⇧E, pressed in the page, leaves the editor; pressed in the viewer, it comes back.
  await page.mouse.click(600, 500);
  await ed.clickEnd("h1");
  const editing = () =>
    ed.eval<boolean>(`document.body.classList.contains("erga-editing") && !document.body.classList.contains("erga-closing")`);
  expect(await editing()).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await until(async () => !(await editing()), 5000, "⌘⇧E in the page closes the editor");
  expect(await page.locator(".erga-edit-button").getAttribute("data-tip")).toBe("Edit  ⌘⇧E");
  // From the viewer's own bar too.
  await page.locator(".erga-crumbs").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await until(editing, 5000, "⌘⇧E in the viewer opens the editor");
});
