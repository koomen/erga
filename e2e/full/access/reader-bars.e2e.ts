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
  return { status: r.status, body: (await r.json()) as { result?: { access?: { readerBars?: boolean } } } };
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
  await expect.poll(async () => (await asOwner(root, "ls", { document: id })).body.result?.access?.readerBars).toBe(false);
  expect(await view(page, address, reader), "a reader, after").toEqual({ bars: false, top: 0 });
  expect((await view(page, address, editor)).bars, "an editor").toBe(true);
  // On again: the reader has the bars back.
  expect((await asOwner(root, "share_document", { document: id, reader_bars: true })).status).toBe(200);
  expect((await view(page, address, reader)).bars, "a reader, on again").toBe(true);
});

test("an editor who isn't the owner changes the readers' options in Document settings, and doesn't see who it's shared with", async ({
  tab,
}) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const address = (root + made.at).replace(/[?&]edit=?$/, "");
  const reader = unique("reader"),
    editor = unique("editor");
  expect((await asOwner(root, "share_document", { document: made.id, login: reader, role: "viewer" })).status).toBe(200);
  expect((await asOwner(root, "share_document", { document: made.id, login: editor, role: "editor" })).status).toBe(200);
  // The editor, in their own editor: the Readers switches are theirs to change.
  await page.goto(`${address}?user=${editor}&edit`);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-bars-on").waitFor();
  expect(await page.locator("#ds-bars-on").isDisabled()).toBe(false);
  await page.locator("#ds-bars-on").click();
  await expect.poll(async () => (await asOwner(root, "ls", { document: made.id })).body.result?.access?.readerBars).toBe(false);
  expect(await page.locator("#ds-agent-error").textContent()).toBe("");
  expect(await view(page, address, reader), "a reader").toEqual({ bars: false, top: 0 });
  // The tool says the same: the options, and not who has access.
  const r = await fetch(`${root}/api/tools/share_document?user=${editor}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify({ document: made.id, reader_bars: true }),
  });
  const body = (await r.json()) as { result: Record<string, unknown> };
  expect([r.status, body.result.readerBars, body.result.permissions]).toEqual([200, true, undefined]);
  // Sharing itself stays the owner's.
  const share = await fetch(`${root}/api/tools/share_document?user=${editor}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify({ document: made.id, login: unique("cy"), role: "viewer" }),
  });
  expect(share.status).toBe(403);
});

test("an admin changes the readers' options on the homepage project (/_home), which has no owner", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  // (The first / makes the homepage project, if there isn't one yet.)
  await fetch(`${root}/`, { headers: { Cookie: `erga_signed_out_${new URL(root).port}=1` } });
  await page.goto(`${root}/_home?edit`);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-llm-on").waitFor();
  const was = await page.locator("#ds-llm-on").isChecked();
  await page.locator("#ds-llm-on").click();
  await expect
    .poll(
      async () => ((await asOwner(root, "ls", { document: "/_home" })).body.result?.access as { pageLlm?: { on: boolean } })?.pageLlm?.on
    )
    .toBe(!was);
  expect(await page.locator("#ds-agent-error").textContent()).toBe("");
  // Back as it was.
  expect((await asOwner(root, "share_document", { document: "/_home", page_llm: was })).status).toBe(200);
});
