// Custom edits (agents/document/PROMPT.md, "Custom edits"): in the editor a page's script draws buttons, and a click sends
// custom edits (ergaEditor.apply) that the editor makes to the source as one undo step.
import { expect, servers, test } from "../../fixtures";
import { F, W, openEditor, type Editor } from "../../editor";

await servers.main();

const views = (ed: Editor) => ed.frame<string[]>(`[...${F}.querySelectorAll(".map h3")].map((h) => h.textContent)`);
/** Clicks a button (by its class) on the view whose heading is `name`, or the "New view" row of the list it's in. */
async function press(ed: Editor, name: string, button: string) {
  const sel = await ed.frame<string>(`(() => {
    const h = [...${F}.querySelectorAll(".map h3")].find((h) => h.textContent == ${JSON.stringify(name)});
    const li = h.closest("li"), b = ${JSON.stringify(button)} == "add" ? li.parentElement.querySelector(":scope > .add-row button") : li.querySelector(":scope > .view > .ctl button.${button}");
    ${F}.querySelectorAll("[data-test-target]").forEach((x) => x.removeAttribute("data-test-target"));
    b.setAttribute("data-test-target", "");
    return "[data-test-target]";
  })()`);
  const at = await ed.rectOf(sel);
  await ed.click(at.x, at.y);
  await ed.settle();
}

test("the page's buttons edit its source: add, delete, move, add under; each is one undo; the buttons take no caret", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "custom-edits");
  expect(await views(ed)).toEqual(["Front page", "Documents", "New document", "Document", "Page", "Editor", "Settings", "Admin"]);
  expect(await ed.frame<boolean>(`${F}.documentElement.hasAttribute("data-erga-editing") && ${W}.ergaEditor.editing`)).toBe(true);

  // A button is a button: clicking one that has nothing to do (the first view can't move up) puts no caret in the text.
  await press(ed, "Front page", "up");
  expect(await ed.frame<boolean>(`!!${F}.activeElement?.closest?.("[data-erga-id]")`)).toBe(false);

  await press(ed, "Admin", "add");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Documents", "New document", "Document", "Page", "Editor", "Settings", "Admin", "New view"]);
  // The new view's name is selected, to type over.
  await ed.type("Billing");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Documents", "New document", "Document", "Page", "Editor", "Settings", "Admin", "Billing"]);
  expect(await ed.source()).toContain(`<h3>Admin</h3><p class="url">/admin</p></div>\n        </div>\n      </li>\n      <li>\n        <div class="view">\n          <div class="view-head"><h3>Billing</h3><p class="url">/path</p></div>\n        </div>\n      </li>\n    </ul>`);

  await press(ed, "Settings", "del");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Documents", "New document", "Document", "Page", "Editor", "Admin", "Billing"]);
  await press(ed, "Admin", "up");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "Editor", "Billing"]);
  await press(ed, "Page", "child");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "New view", "Editor", "Billing"]);
  expect(await ed.source()).toMatch(/<h3>Page<\/h3>[^]*?<\/div>\n {16}<ul class="branch">\n {18}<li>\n {20}<div class="view">\n {22}<div class="view-head"><h3>New view<\/h3>/);

  await ed.press("ControlOrMeta+z");
  await expect.poll(() => views(ed)).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "Editor", "Billing"]);
});

test("a page can't make custom edits when nobody clicked: as it loads, say", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "custom-edits-load");
  await expect.poll(() => ed.frame<{ ok: boolean; error: string } | undefined>(`${W}.result`)).toBeTruthy();
  const r = await ed.frame<{ ok: boolean; error: string }>(`${W}.result`);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/just clicked or pressed a key/);
  expect(await ed.source()).toContain(`<p id="note">Nobody clicked.</p>`);
});
