// Readers' agents (Document settings): someone a document is shared with as a viewer has no agent in its viewer, until its
// owner ticks "Viewers can use the Erga agent". Never on a document anyone with the link may open. Editors always have theirs.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, newDoc, unique } from "./access";

await servers.main();

/** Calls a tool as the owner (the dev server's own person), as their page does. */
async function asOwner(root: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${root}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: (await r.json()) as { result?: { access?: { readerAgent?: boolean } }; error?: string } };
}

/** Whether the viewer at `address` shows `who` their agent's circle. */
async function hasAgent(page: Page, address: string, who: string) {
  await page.goto(`${address}?user=${who}`);
  await page.locator(".erga-view-buttons").waitFor();
  return page.evaluate(() => !!document.getElementById("agent"));
}

test("a reader gets their agent where the owner lets readers use theirs; the owner's switch is in Document settings", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const at = root + made.at,
    id = made.id;
  const address = at.replace(/[?&]edit=?$/, "");
  const reader = unique("reader");
  expect((await asOwner(root, "share_document", { document: id, login: reader, role: "viewer" })).status).toBe(200);
  expect(await hasAgent(page, address, reader), "a reader, before").toBe(false);
  // The owner ticks it in Document settings.
  await page.goto(at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-agent-on").waitFor();
  expect(await page.locator("#ds-agent-on").isChecked()).toBe(false);
  await page.locator("#ds-agent-on").click();
  await expect.poll(async () => (await asOwner(root, "ls", { document: id })).body.result?.access?.readerAgent).toBe(true);
  expect(await hasAgent(page, address, reader), "a reader, after").toBe(true);
});

test("never on a document anyone with the link may open: the switch refuses, is off while it is shared so, and stays off after", async ({
  tab,
}) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const at = root + made.at,
    id = made.id;
  const address = at.replace(/[?&]edit=?$/, "");
  const reader = unique("reader");
  expect((await asOwner(root, "share_document", { document: id, login: reader, role: "viewer" })).status).toBe(200);
  expect((await asOwner(root, "share_document", { document: id, reader_agent: true })).status).toBe(200);
  expect(await hasAgent(page, address, reader)).toBe(true);
  // Shared with anyone with the link: the reader's agent goes, and the switch can't be turned on.
  expect((await asOwner(root, "share_document", { document: id, login: "*", role: "viewer" })).status).toBe(200);
  expect(await hasAgent(page, address, reader)).toBe(false);
  const refused = await asOwner(root, "share_document", { document: id, reader_agent: true });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("Anyone with the link");
  await page.goto(at);
  await until(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready")), 10_000, "the editor is ready");
  await clickOn(page, "#btn-settings");
  await page.locator("#ds-agent-on").waitFor();
  expect(await page.locator("#ds-agent-on").isDisabled()).toBe(true);
  // Not shared with anyone any more: the agent stays off until the owner turns it on again.
  expect((await asOwner(root, "share_document", { document: id, login: "*", role: "none" })).status).toBe(200);
  expect(await hasAgent(page, address, reader)).toBe(false);
  expect((await asOwner(root, "share_document", { document: id, reader_agent: true })).status).toBe(200);
  expect(await hasAgent(page, address, reader)).toBe(true);
});
