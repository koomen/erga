// The agent pane going in and out of the editor ("Agent, empty message").
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.agent();

const paneOpen = (ed: Editor) => ed.eval<boolean>(`document.body.classList.contains("agent-open") && !document.getElementById("agent").inert`);
/** Out of the editor or back in, done when the shell says so. */
async function toggleEditing(ed: Editor) {
  const was = await ed.eval<boolean>(`document.body.classList.contains("erga-editing")`);
  await ed.eval(`(document.querySelector("body.erga-editing #btn-edit") ?? document.querySelector(".erga-edit-button")).click()`);
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("erga-editing")`)).toBe(!was);
  await ed.settle();
}

test("your agent is the page's: out of the editor and back in, the pane stays as it was, closed or open", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page");
  expect(await paneOpen(ed)).toBe(false);
  await toggleEditing(ed);
  await toggleEditing(ed);
  await expect.poll(() => paneOpen(ed)).toBe(false);
  await ed.press("ControlOrMeta+j");
  await expect.poll(() => paneOpen(ed)).toBe(true);
  await toggleEditing(ed);
  await expect.poll(() => paneOpen(ed)).toBe(true);
  await toggleEditing(ed);
  await expect.poll(() => paneOpen(ed)).toBe(true);
});

test("coming into the editor for the first time, the pane opens by itself", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.agent(), "page", { agent: true });
  await expect.poll(() => paneOpen(ed)).toBe(true);
});
