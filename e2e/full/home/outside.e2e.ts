// erga.dev (/) for someone signed in is their documents, however they come (a typed address, a bookmark, a link in
// Erga); the erga logo on every page goes there too. /docs has a Home page button: the homepage project at /_home.
// Signed out, / is always the homepage, and the logo goes to /.
import { expect, servers, test } from "../../helpers/fixtures";
import { get, signedOut } from "./home";

await servers.main();

test("signed in, / opens /docs; its Home page button opens the homepage project; the logo there goes back; signed out, / stays", async ({
  tab,
}) => {
  const server = await servers.main();
  const page = tab.page;
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${server.root}/`);
  expect(new URL(page.url()).pathname).toBe("/docs");
  // The Home page button sits just left of the quick actions (New first among them).
  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".erga-view-buttons .quick-inner > *")].map((e) => e.getAttribute("aria-label") ?? e.className)
  );
  expect(order[0]).toBe("Home page");
  expect(order.length).toBeGreaterThan(1);
  await Promise.all([page.waitForURL((u) => u.pathname == "/_home"), page.click(".erga-home-button")]);
  await expect.poll(() => page.evaluate(() => document.querySelector(".erga-crumbs .erga-here")?.textContent ?? "")).toBe("Erga Homepage");
  await Promise.all([page.waitForURL((u) => u.pathname == "/docs"), page.click(".erga-crumbs .erga-brand")]);
  // The logo on /docs itself goes to /docs too.
  expect(await page.getAttribute(".erga-crumbs .erga-brand", "href")).toBe("/docs");
  await page.goto(`${server.root}/auth/logout`);
  await page.goto(`${server.root}/`);
  expect(new URL(page.url()).pathname).toBe("/");
  // Signed out, /_home is the homepage project too, to view.
  await page.goto(`${server.root}/_home`);
  expect(new URL(page.url()).pathname).toBe("/_home");
  expect(await page.getAttribute(".erga-crumbs .erga-brand", "href")).toBe("/");
});

test("however the browser came (Sec-Fetch-Site or none), someone signed in goes to /docs; signed out, / is the homepage", async () => {
  const server = await servers.main();
  const at = async (headers: Record<string, string>) => {
    const r = await get(server, "/?user=Ada", { headers });
    return r.status == 302 ? r.headers.get("location") : r.status;
  };
  for (const site of ["none", "cross-site", "same-site", "same-origin"])
    expect(await at({ "Sec-Fetch-Site": site }), site).toBe("/docs?user=Ada");
  expect(await at({})).toBe("/docs?user=Ada");
  expect((await get(server, "/", { headers: signedOut(server) })).status).toBe(200);
});
