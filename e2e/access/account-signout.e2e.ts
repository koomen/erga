// Signing out in the browser (tests/account.ts): locally too it leaves nobody signed in, the corner offers Sign in,
// which comes back to the same page, signed in. Signing out is this browser context's cookie, so the worker's server
// is shared safely.
import { expect, servers, test, until } from "../fixtures";
import { clickOn, corner } from "./access";

test.beforeAll(async () => { await servers.main(); });

test("signed out: a person in a circle whose menu has only Sign in, which comes back to the same page, signed in", async ({ tab }) => {
  const page = tab.page, root = (await servers.main()).root;
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${root}/docs`);
  await clickOn(page, "[data-erga-account] button");
  await clickOn(page, `.erga-account-menu a[href="/auth/logout"]`);
  await until(async () => (await page.evaluate(() => location.pathname)) == "/", 10_000, "signing out goes to the front page");
  await page.goto(`${root}/nobody-here`);
  let c = await corner(page);
  expect(c.state).toBe("out");
  expect(c.label).toBe("Sign in");
  expect(c.img).toBeNull();
  await clickOn(page, "[data-erga-account] button");
  c = await corner(page);
  expect(c.open).toBe(true);
  expect(c.links).toEqual([{ text: "Sign in", href: "/auth/github?next=%2Fnobody-here" }]);
  // Dark, on a phone, it opens too.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${root}/nobody-here`);
  await clickOn(page, "[data-erga-account] button");
  expect((await corner(page)).open).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${root}/nobody-here`);
  await clickOn(page, "[data-erga-account] button");
  await clickOn(page, ".erga-account-github");
  await until(async () => (await corner(page)).state == "in", 10_000, "signed in again");
  expect(await page.evaluate(() => location.pathname)).toBe("/nobody-here");
});
