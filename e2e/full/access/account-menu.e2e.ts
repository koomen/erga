// The account corner in the browser, on the site's own pages: your avatar's menu on /docs, light,
// dark and a phone, and its place on the front page.
import { expect, servers, test, until } from "../../fixtures";
import { clickOn, corner, inPage } from "./access";

await servers.main();

test("on /docs, your avatar in the upper right opens your menu; Escape closes it; without its picture, your initial on your colour", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${(await servers.main()).root}/docs`);
  let c = await corner(page);
  expect(c.state).toBe("in");
  expect(c.initial).toBe("T");
  expect(c.rect!.x + c.rect!.w).toBeGreaterThan(1100 - 24);
  expect(c.rect!.y).toBeLessThan(24);
  await clickOn(page, "[data-erga-account] button");
  c = await corner(page);
  expect(c.open).toBe(true);
  expect(c.who).toContain("tester");
  expect(c.links.map((l) => l.text)).toEqual(["Documents", "Settings", "Deploy your own", "Admin settings", "Sign out"]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await corner(page)).open).toBe(false);
  await page.evaluate(() => document.querySelector("[data-erga-account] img")?.dispatchEvent(new Event("error")));
  c = await corner(page);
  expect(c.img).toBeNull();
  expect(c.initial).toBe("T");
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-erga-account] button")!).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(tab.errors).toEqual([]);
});

test("dark, it opens; at phone width it fits clear of the page's header, and its menu stays on screen", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${root}/admin`);
  await clickOn(page, "[data-erga-account] button");
  expect((await corner(page)).open).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${root}/docs`);
  const c = await corner(page);
  expect(c.rect!.x + c.rect!.w).toBeLessThanOrEqual(390 - 12);
  expect(await page.evaluate(() => { const a = document.querySelector("[data-erga-account] button")!.getBoundingClientRect(); return [...document.querySelectorAll("main header > *")].some((e) => { const b = e.getBoundingClientRect(); return b.right > a.left && b.left < a.right && b.bottom > a.top && b.top < a.bottom; }); }), "overlaps the header").toBe(false);
  await clickOn(page, "[data-erga-account] button");
  expect(await page.evaluate(() => { const r = document.querySelector(".erga-account-menu")!.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
});

test("on the front page, the avatar sits right of the Edit and Clone buttons, level with them", async ({ tab }) => {
  const page = tab.page;
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${(await servers.main()).root}/`);
  // The page itself once deployed (worker/home.ts), its controls in their own shadow root; the viewer's frame before.
  await until(async () => (await page.evaluate(() => document.querySelector("h1")?.textContent ?? "")) == "Erga" || (await inPage<string>(page, `document.querySelector("h1")?.textContent ?? ""`)).includes("Erga"), 10_000, "the landing page renders");
  expect(await page.evaluate(() => {
    const r = document.querySelector("erga-controls")?.shadowRoot ?? document;
    const a = r.querySelector("[data-erga-account] button")!.getBoundingClientRect(), e = r.querySelector(".erga-view-buttons")!.getBoundingClientRect();
    return e.right <= a.left - 4 && Math.abs((e.top + e.bottom) / 2 - (a.top + a.bottom) / 2) < 3;
  })).toBe(true);
});
