// erga.dev (/) for someone signed in: a visit that starts outside Erga (a typed address, a bookmark, another site's
// link) goes to /docs; the erga logo still opens the landing page. Signed out, / is always the landing page.
import { expect, servers, test } from "../../helpers/fixtures";
import { get } from "./home";

await servers.main();

test("signed in, a typed address of / opens /docs; the erga logo there opens the landing page; signed out, / stays", async ({ tab }) => {
  const server = await servers.main();
  const page = tab.page;
  await page.goto(`${server.root}/`);
  expect(new URL(page.url()).pathname).toBe("/docs");
  await Promise.all([page.waitForURL((u) => u.pathname == "/"), page.click("a.erga-brand")]);
  expect(new URL(page.url()).pathname).toBe("/");
  await page.goto(`${server.root}/auth/logout`);
  await page.goto(`${server.root}/`);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("what the browser says decides: another site's link or a bookmark goes to /docs; same-origin, or no header, the landing page", async () => {
  const server = await servers.main();
  const at = async (site?: string, more: Record<string, string> = {}) => {
    const r = await get(server, "/?user=Ada", { headers: { ...(site ? { "Sec-Fetch-Site": site } : {}), ...more } });
    return r.status == 302 ? r.headers.get("location") : r.status;
  };
  for (const site of ["none", "cross-site", "same-site"]) expect(await at(site), site).toBe("/docs?user=Ada");
  expect(await at("same-origin")).toBe(200);
  expect(await at()).toBe(200);
});
