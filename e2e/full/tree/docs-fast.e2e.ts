// Documents, fast: a button acts as the press starts, once (shared/fast-click.ts), and a document is fetched ahead as the
// pointer rests on its row, each document once.
import { expect, servers, test } from "../../helpers/fixtures";
import { js, multi } from "./tree";

await servers.main();

test("the chevron and the account button act on the press, not on its release, and only once; the keyboard still works", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const { id } = await multi(server);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${server.root}/docs`);
  const chevron = `button.twist[data-id="${id}"]`;
  const expanded = () => js(page, `document.querySelector('${chevron}').getAttribute("aria-expanded")`);
  const box = (await page.locator(chevron).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await expanded(), "open on the press").toBe("true");
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await expanded(), "the release's click is dropped").toBe("true");
  await page.mouse.down();
  await page.mouse.up();
  expect(await expanded()).toBe("false");
  await page.focus(chevron);
  await page.keyboard.press("Enter");
  expect(await expanded(), "Enter").toBe("true");
  await page.keyboard.press("Space");
  expect(await expanded(), "Space").toBe("false");

  // The account button: its menu opens on the press, and the focus goes to its first link (the press doesn't take it back).
  const acc = (await page.locator("[data-erga-account] button").boundingBox())!;
  await page.mouse.move(acc.x + acc.width / 2, acc.y + acc.height / 2);
  await page.mouse.down();
  expect(await js(page, `!document.querySelector(".erga-account-menu").hidden`)).toBe(true);
  await page.mouse.up();
  expect(await js(page, `!document.querySelector(".erga-account-menu").hidden`)).toBe(true);
  expect(await js(page, `document.activeElement?.textContent`)).toBe("Documents");
  // A click elsewhere closes it, as before.
  await page.mouse.click(10, 400);
  expect(await js(page, `document.querySelector(".erga-account-menu").hidden`)).toBe(true);
  expect(tab.errors).toEqual([]);
});

test("the pointer resting on a document's row fetches its page ahead (speculation rules), once, and the editor's files", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const { id } = await multi(server);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${server.root}/docs`);
  const rules = () => js(page, `[...document.querySelectorAll('script[type="speculationrules"]')].flatMap((s) => JSON.parse(s.textContent).prefetch[0].urls)`) as Promise<string[]>;
  expect(await rules()).toEqual([]);
  const href = await js(page, `document.querySelector('button.twist[data-id="${id}"]').closest("li").querySelector("a.doc").href`);
  const row = (await page.locator(`button.twist[data-id="${id}"]`).boundingBox())!;
  await page.mouse.move(row.x + 300, row.y + row.height / 2);
  await expect.poll(rules).toEqual([href]);
  // (The editor's script: its shell comes in the document's page.)
  expect(await js(page, `[...document.querySelectorAll('link[rel="prefetch"]')].some((l) => /_erga.main-[a-z0-9]+\\.js$/.test(l.href))`)).toBe(true);
  await page.mouse.move(row.x + 300, 700);
  await page.mouse.move(row.x + 300, row.y + row.height / 2);
  await page.waitForTimeout(150);
  expect(await rules()).toEqual([href]);
  // The click opens it, at the address it was fetched for.
  await page.mouse.click(row.x + 300, row.y + row.height / 2);
  await page.waitForURL((u) => u.href == href);
  // ...with the page fetched ahead, not asked for again.
  expect(await js(page, `performance.getEntriesByType("navigation")[0].deliveryType`)).toBe("navigational-prefetch");
});
