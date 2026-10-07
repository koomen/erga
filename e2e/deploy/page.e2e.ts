// /deploy opens for an admin (tests/deploy.ts): breadcrumbs in the upper left, no notice of the mock; a bad token is
// refused in plain words; Authorize with Cloudflare bounces to its consent page and back, connected.
import { expect, test } from "../fixtures";
import { openDeploy, servers } from "./deploy";

test.beforeAll(async () => { await servers.mock(); });

test("/deploy opens with its breadcrumbs in the upper left, and no experimental or mock notices", async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root);
  tab.strict = true;
  expect(await tab.page.evaluate(() => document.body.innerText)).not.toMatch(/experimental|pretend|mock/i);
  expect([await p.text(".crumbs .brand"), await p.text(".crumbs .here")]).toEqual(["Erga", "Deploy"]);
  const r = await tab.page.evaluate(() => { const r = document.querySelector(".crumbs")!.getBoundingClientRect(); return { top: r.top, left: r.left }; });
  expect(r.top).toBeLessThan(40);
  expect(r.left).toBeLessThan(40);
});

test("a token that isn't one is refused, saying why", async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root);
  await p.click("#token-details summary");
  await p.fill("token", "this-is-not-a-real-token-at-all");
  await p.click("#connect");
  await expect.poll(() => p.text("#connect-error"), { timeout: 10_000 }).toContain("didn't accept the token");
});

test("Authorize with Cloudflare: to its consent page, asking for the deploy's scopes, and back connected", async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root);
  const scopes = await p.oauth();
  expect(scopes).toContain("workers-scripts.write");
  expect(scopes).toContain("d1.write");
  expect(await p.text("#sum-connect")).toContain("Cloudflare's authorization");
  expect(await p.text("#app-wd")).toBe("erga.ada-mock.workers.dev");
});
