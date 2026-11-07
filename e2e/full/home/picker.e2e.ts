// The Homepage setting on /admin/settings (landing_document): a box that finds any of the server's documents and projects
// as you type (the operation list_documents, with all), each with its owner, address and kind; choosing one saves it, and Reset puts the
// repo's demo page back.
import { expect, servers, test } from "../../helpers/fixtures";
import { adminToken, fresh, home, landingSetting, publish, resetLanding } from "./home";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

test("the Homepage picker finds a document by its title as you type; choosing it saves it; Reset undoes it", async ({ tab }) => {
  const server = await servers.short(),
    { page } = tab;
  await fresh(server);
  const title = `Picker target ${Math.random().toString(36).slice(2, 8)}`;
  const { id } = await publish(
    server,
    await adminToken(server),
    { "index.html": `<!doctype html><title>${title}</title><h1>${title}</h1>` },
    { title }
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${server.root}/admin/settings`);
  const row = 'li.setting[data-key="landing_document"]';
  const text = (sel: string) => page.locator(`${row} ${sel}`).first().textContent();
  expect(await text("label.key")).toBe("Homepage");
  expect(await text(".desc")).toContain("The document or project shown at /");

  // A part of the title, typed: the document shows, with its owner and address, and its kind.
  const find = page.locator(`${row} input.find[role=combobox]`);
  await find.click();
  await find.pressSequentially(title.slice(-10, -1));
  await expect.poll(() => page.locator(`${row} [role=option]`).count()).toBe(1);
  expect(await text("[role=option] .title")).toBe(title);
  expect(await text("[role=option] .badge")).toBe("Document");
  const where = (await text("[role=option] .where"))!;
  expect(where).toMatch(/^\S+ · \/\S+\/\S+$/);
  // The list has the shared admin look: below the box, over the page.
  expect(await page.locator(`${row} .found`).evaluate((el) => getComputedStyle(el).position)).toBe("absolute");

  // Chosen with the keys: saved, and the page shows it.
  await find.press("ArrowDown");
  expect(await page.locator(`${row} [role=option]`).getAttribute("aria-selected")).toBe("true");
  await find.press("Enter");
  await expect
    .poll(() =>
      page
        .locator(`${row} .meta a.open-doc`)
        .textContent()
        .catch(() => null)
    )
    .toBe(title);
  expect(await landingSetting(server)).toBe(where.split(" · ")[1]);
  expect(await home(server, id)).toMatchObject({ isHome: true });

  // Reset: back to the default (none: the repo's demo page).
  await page.click(`${row} .reset`);
  await page.waitForSelector(`${row} .meta a.open-doc`, { state: "detached" });
  expect(await page.locator(`${row} .reset`).count()).toBe(0);
  expect(await landingSetting(server)).toBe("");
});

test("list_documents' all is an admin's: someone else is refused", async () => {
  const server = await servers.short();
  expect((await runTool(server.root, "list_documents", { all: true }, { user: "someone-else" })).status).toBe(403);
  const found = (await runTool<{ address: string; kind: string }[]>(server.root, "list_documents", { all: true })).result!;
  expect(found.length).toBeGreaterThan(0);
  expect(found[0]).toMatchObject({
    address: expect.stringMatching(/^\/[^/]+\/[^/]+$/),
    kind: expect.stringMatching(/^(document|project)$/),
  });
});
