// Archive (server/operations/documents.ts: archive_document, unarchive_document): a row's Archive on /docs moves it to
// /docs/archived, whose Unarchive moves it back. The buttons show only while the mouse is over the row. An agent's
// archive moves the rows of open tabs too (live pages, server/news/). The archive is each person's own.
import type { Page } from "playwright-core";
import { expect, settle, test, until } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

/** The titles the list shows, and its count, as the person sees them. */
const shown = (page: Page) =>
  page.evaluate<string>(
    `[document.getElementById("docs-count")].filter((c) => c.checkVisibility()).map((c) => c.innerText).concat([...document.querySelectorAll("ol.rows > li[data-live] .title")].filter((t) => t.checkVisibility()).map((t) => t.innerText)).join(" | ")`
  );

/** How visible a row's button is (its opacity), by its label. */
const opacity = (page: Page, label: string) =>
  page.evaluate<string>(`getComputedStyle(document.querySelector('button[aria-label=${JSON.stringify(label)}]')).opacity`);

/** The middle of an element on screen (a live row can be replaced as it's read: until it holds). */
const middle = (page: Page, selector: string) =>
  until(
    async () => {
      const r = await page.locator(selector).first().boundingBox();
      return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    5000,
    `${selector} is on the screen`
  ) as Promise<{ x: number; y: number }>;

/** Moves the mouse to an element and clicks it, as a person does. */
async function click(page: Page, selector: string) {
  const { x, y } = await middle(page, selector);
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.click(x, y);
}

test("Archive shows only while the mouse is over a row; it moves the row to /docs/archived, whose Unarchive moves it back", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const page = tab.page;
  tab.strict = true;
  const agent = tools(p.base, await p.token("Archive test"));
  await agent.call("create_document", { title: "Garden plan" });
  await agent.call("create_document", { title: "Tax notes" });
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await page.evaluate(`window.sameLoad = true`);
  expect(await shown(page)).toBe("2 documents | Tax notes | Garden plan");

  // Away from the rows, Archive is hidden; over its row, it shows.
  await page.mouse.move(5, 5);
  await settle(page);
  await expect.poll(() => opacity(page, "Archive Tax notes")).toBe("0");
  const row = await middle(page, 'li[data-live] a.doc:has-text("Tax notes")');
  await page.mouse.move(row.x + 200, row.y, { steps: 4 });
  await expect.poll(() => opacity(page, "Archive Tax notes")).toBe("1");
  expect(await opacity(page, "Archive Garden plan")).toBe("0");

  await click(page, 'button[aria-label="Archive Tax notes"]');
  await settle(page);
  await expect.poll(() => shown(page)).toBe("1 document | Garden plan");

  // The small link after the heading goes to the archive, and back.
  await click(page, "a.other-list");
  await page.waitForURL(/\/docs\/archived$/);
  expect(await page.evaluate<string>(`document.querySelector("h1").innerText`)).toBe("Archived");
  expect(await shown(page)).toBe("1 document | Tax notes");
  const archivedRow = await middle(page, 'li[data-live] a.doc:has-text("Tax notes")');
  await page.mouse.move(archivedRow.x + 200, archivedRow.y, { steps: 4 });
  await expect.poll(() => opacity(page, "Unarchive Tax notes")).toBe("1");
  await click(page, 'button[aria-label="Unarchive Tax notes"]');
  await expect.poll(() => shown(page)).toBe("");
  expect(await page.evaluate<string>(`document.querySelector("p.empty").innerText`)).toContain("No archived documents");

  await click(page, "a.other-list");
  await page.waitForURL(/\/docs$/);
  expect(await shown(page)).toBe("2 documents | Tax notes | Garden plan");
});

test("an agent's archive and unarchive (the documents tool) move the rows of open tabs, with no reload", async ({ tab }) => {
  const p = await person(await servers.script());
  const page = tab.page;
  tab.strict = true;
  const agent = tools(p.base, await p.token("Archive test agent"));
  const made = (await agent.call("create_document", { title: "Old minutes" })).data as { id: string };
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  const archive = await page.context().newPage();
  await archive.goto(`${p.base}/docs/archived`);
  await page.bringToFront();
  await page.evaluate(`window.sameLoad = true`);
  await archive.evaluate(`window.sameLoad = true`);
  expect(await shown(page)).toBe("1 document | Old minutes");
  expect(await shown(archive)).toBe("");

  expect((await agent.call("documents", { op: "archive_document", document: made.id })).status).toBe(200);
  await expect.poll(() => shown(page)).toBe("");
  await archive.bringToFront();
  await expect.poll(() => shown(archive)).toBe("1 document | Old minutes");
  // The agent finds it in the archive, and not on the list.
  const listed = async (args = {}) => (await p.tool<{ id: string }[]>("list_documents", args)).result!.map((d) => d.id);
  expect(await listed()).not.toContain(made.id);
  expect(await listed({ archived: true })).toEqual([made.id]);
  // Its page still opens by its address.
  expect((await p.get(`/d/${made.id}`)).status).toBeLessThan(400);

  expect((await agent.call("documents", { op: "unarchive_document", document: made.id })).status).toBe(200);
  await expect.poll(() => shown(archive)).toBe("");
  await page.bringToFront();
  await expect.poll(() => shown(page)).toBe("1 document | Old minutes");
  expect(await page.evaluate<boolean>(`window.sameLoad`)).toBe(true);
  expect(await archive.evaluate<boolean>(`window.sameLoad`)).toBe(true);
  await archive.close();
});

test("on /docs/archived the owner deletes a document, after a question; a document shared with them has Unarchive but no Delete", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const bo = await person(await servers.script());
  const page = tab.page;
  tab.strict = true;
  const agent = tools(p.base, await p.token("Archive delete test"));
  const mine = (await agent.call("create_document", { title: "Draft to delete" })).data as { id: string };
  const theirs = await bo.make();
  await bo.share(theirs, p.login, "viewer");
  for (const id of [mine.id, theirs]) expect((await p.tool("archive_document", { document: id })).status).toBe(200);
  // The archive is theirs only: bo's own list still has it.
  expect(await bo.docs()).toContain(`data-live="doc:${theirs}"`);

  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs/archived`);
  expect(await shown(page)).toBe("2 documents | Untitled | Draft to delete");
  expect(
    await page.locator('li[data-live] a.doc:has-text("Untitled")').locator("xpath=ancestor::li").locator("button.delete").count()
  ).toBe(0);

  // The runner answers the browser's own dialogs: the page's confirm says its question here, and takes our answer.
  const confirmWith = (yes: boolean) =>
    page.evaluate((yes) => {
      const w = window as unknown as { asked: string[] };
      w.asked = [];
      window.confirm = (q) => (w.asked.push(String(q)), yes);
    }, yes);
  await confirmWith(false);
  const row = await middle(page, 'li[data-live] a.doc:has-text("Draft to delete")');
  await page.mouse.move(row.x + 200, row.y, { steps: 4 });
  await click(page, 'button[aria-label="Delete Draft to delete"]');
  expect(await page.evaluate<string[]>(`window.asked`)).toEqual(["Delete “Draft to delete”? This can't be undone."]);
  await settle(page);
  expect(await shown(page)).toBe("2 documents | Untitled | Draft to delete");

  await confirmWith(true);
  await click(page, 'button[aria-label="Delete Draft to delete"]');
  await expect.poll(() => shown(page)).toBe("1 document | Untitled");
  expect(await p.exists(mine.id)).toBe(false);
});
