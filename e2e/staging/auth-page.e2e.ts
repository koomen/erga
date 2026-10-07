// The Authentication page in Chrome ("the page"): production working, staging not set up with the
// steps to make its app; a wrong secret changes nothing; the right values set staging's app from production's page.
import { expect, servers, test } from "../fixtures";
import { newApp, PROD_APP, reset, status } from "./auth";

await servers.pair();

test("production's page: production working, staging not set up with its steps; a wrong secret changes nothing; the right values set staging's app", async ({ tab }) => {
  const p = await servers.pair(), P = p.prod.root, S = p.staging.root, page = tab.page;
  await reset(p);
  const app = newApp();
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.goto(`${P}/admin/auth`);
  const card = <T>(server: string, f: string) => page.evaluate(({ server, f }) => new Function("c", `return ${f}`)(document.querySelector(`section.server[data-server="${server}"]`)), { server, f }) as Promise<T>;
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("section.server").length)).toBe(2);
  expect(await card<string>("here", "c.dataset.state")).toBe("working");
  expect(await card<string>("here", `c.querySelector(".client-id").textContent`)).toBe(PROD_APP.clientId);
  expect(await card<string>("here", `c.querySelector(".callback").textContent`)).toBe(`${P}/auth/github/callback`);
  expect(await card<string>("other", "c.dataset.state")).toBe("not_set_up");
  const steps = await card<string | false>("other", `c.querySelector("details.setup").open && c.querySelector("ol.steps").textContent`);
  expect(steps).toContain("https://github.com/settings/applications/new");
  expect(steps).toContain(`${S}/auth/github/callback`);
  expect(steps).toContain("--name erga-staging");
  expect((await page.locator('.admin-side a[aria-current="page"]').textContent())!.trim()).toBe("Authentication");
  const fill = (clientId: string, secret: string) => card("other", `(() => { const f = c.querySelector("form.configure"); f.elements.clientId.value = ${JSON.stringify(clientId)}; f.elements.secret.value = ${JSON.stringify(secret)}; f.querySelector(".save").click(); return true; })()`);
  await fill(app.clientId, `wrong-${app.secret}`);
  await expect.poll(() => card<string>("other", `c.querySelector(".hint").textContent`), { timeout: 10_000 }).toMatch(/The client secret is wrong\. .*Nothing changed\./);
  expect((await status(S)).here.inUse.clientId).toBeNull();
  await fill(app.clientId, app.secret);
  await expect.poll(() => card<string>("other", "c?.dataset.state"), { timeout: 10_000 }).toBe("working");
  expect(await card<string>("other", `c.querySelector(".client-id").textContent`)).toBe(app.clientId);
  const html = await page.content();
  expect(html).not.toContain(app.secret);
  expect(html).not.toContain(PROD_APP.secret);
  const own = (await status(S)).here;
  expect([own.inUse.clientId, own.inUse.source, own.page.updatedBy]).toEqual([app.clientId, "page", "tester"]);
  // No errors on the page, but the wrong secret's answer (400), which Chrome logs.
  expect(tab.errors.filter((e) => !e.includes("Failed to load resource: the server responded with a status of 400"))).toEqual([]);
});
