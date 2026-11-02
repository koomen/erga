// Readers' bars (Document settings): someone who views a document and can't edit it sees Erga's bars over it, until its
// owner unticks "Readers see Erga's bars". Then the page fills the window, from its top. Editors always see the bars.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, newDoc, unique } from "./access";

/** Calls a tool as the owner (the dev server's own person), as their page does. */
async function asOwner(root: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${root}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: (await r.json()) as { result?: { readerBars?: boolean } } };
}

/** What `who` sees at `address`: whether the buttons' bar shows, and where the page's frame starts. */
async function view(page: Page, address: string, who: string) {
  await page.goto(`${address}?user=${who}`);
  await page.locator("#frame").waitFor();
  return page.evaluate(() => ({
    bars: !!document.querySelector(".erga-view-buttons")?.getClientRects().length,
    top: document.getElementById("frame")!.getBoundingClientRect().top,
  }));
}

test("the owner hides Erga's bars from readers in Document settings; editors keep them", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const at = root + made.at,
    id = made.id;
  const address = at.replace(/[?&]edit=?$/, "");
  const reader = unique("reader"),
    editor = unique("editor");
  expect((await asOwner(root, "share_document", { document: id, login: reader, role: "viewer" })).status).toBe(200);
  expect((await asOwner(root, "share_document", { document: id, login: editor, role: "editor" })).status).toBe(200);
  expect((await view(page, address, reader)).bars, "a reader, before").toBe(true);
  // The owner unticks it in Document settings.
  await page.goto(at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-bars-on").waitFor();
  expect(await page.locator("#ds-bars-on").isChecked()).toBe(true);
  await page.locator("#ds-bars-on").click();
  await expect.poll(async () => (await asOwner(root, "document_access", { document: id })).body.result?.readerBars).toBe(false);
  expect(await view(page, address, reader), "a reader, after").toEqual({ bars: false, top: 0 });
  expect((await view(page, address, editor)).bars, "an editor").toBe(true);
  // On again: the reader has the bars back.
  expect((await asOwner(root, "set_reader_bars", { document: id, on: true })).status).toBe(200);
  expect((await view(page, address, reader)).bars, "a reader, on again").toBe(true);
});
