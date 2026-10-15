// /deploy, the install page, end to end against the pretend Cloudflare and GitHub (ERGA_DEPLOY_MOCK): Authorize with
// Cloudflare (the consent through /install/callback), where it goes, the GitHub App made by the manifest flow, the
// install itself (the app and its control Worker), and what the page says at the end.
import { expect, servers, test } from "../../fixtures";

const own = () => servers.of("deploy-install", { env: { ERGA_DEPLOY_MOCK: "1" } });
await own();
test("an install from the page: consent, the GitHub App, both Workers, and the next step", { timeout: 90_000 }, async ({ tab }) => {
  const server = await own(), { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  await page.goto(`${server.root}/deploy`);
  await expect.poll(() => text("h1")).toContain("Install your own Erga");
  // Authorize with Cloudflare: the pretend consent page, then back, connected.
  await page.click("#oauth");
  await expect.poll(() => text("h1"), { timeout: 10_000 }).toContain("Pretend Cloudflare");
  await page.click("#authorize");
  await expect.poll(() => text("#sum-connect"), { timeout: 10_000 }).toContain("Connected with Cloudflare's authorization");
  // Where: workers.dev and the shared pages host, as offered.
  await expect.poll(() => page.evaluate(() => document.getElementById("s-where")!.className)).toContain("current");
  await page.click("#where-next");
  await expect.poll(() => text("#sum-where")).toContain("erga.ada-mock.workers.dev · pages on erga-pages.ada-mock.workers.dev · control at erga-control.ada-mock.workers.dev");
  // The GitHub App: off to the pretend GitHub and back, made.
  expect(await page.getAttribute("#gh-make", "href")).toBe("/deploy/github/start?app=erga.ada-mock.workers.dev&ops=erga-control.ada-mock.workers.dev&staging=erga-staging.ada-mock.workers.dev");
  await page.click("#gh-make");
  await expect.poll(() => text("#gh-made"), { timeout: 15_000 }).toContain("Made: Erga at erga.ada-mock.workers.dev (Iv1.mockgithubapp0)");
  expect(await text("#sum-where")).toContain("control at erga-control.ada-mock.workers.dev");
  await page.click("#github-next");
  await expect.poll(() => text("#review")).toContain("GitHub App Erga at erga.ada-mock.workers.dev");
  expect(await text("#review")).toContain("https://erga-control.ada-mock.workers.dev");
  // Install: every step, then the live box with the next step (the control Worker's consent).
  await page.click("#go");
  await expect.poll(() => text("#live h3"), { timeout: 60_000 }).toBe("Your Erga is live");
  const steps = await page.evaluate(() => [...document.querySelectorAll("#progress li")].map((li) => `${li.getAttribute("data-id")}:${li.className}`));
  expect(steps).toEqual(["account:done", "database:done", "migrations:done", "control:done", "assets:done", "worker:done", "address:done", "pages:done", "live:done", "control-live:done"]);
  expect(await text("#live")).toContain("erga-control.ada-mock.workers.dev/install");
  // What the pretend Cloudflare was asked for: both Workers, the control Worker told its upstream and its target.
  const state = await (await fetch(`${server.root}/deploy/api/mock`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).json() as { scripts: Record<string, { metadata: { bindings: { name: string; text?: string; service?: string }[] } }> };
  expect(Object.keys(state.scripts).sort()).toEqual(["erga", "erga-control", "erga-pages"]);
  const control = Object.fromEntries(state.scripts["erga-control"].metadata.bindings.map((b) => [b.name, b]));
  expect(control.UPSTREAM.text).toBe(server.root);
  expect(control.GITHUB_CLIENT_ID.text).toBe("Iv1.mockgithubapp0");
  expect(JSON.parse(control.INSTALL.text!).control.host).toBe("erga-control.ada-mock.workers.dev");
  expect(Object.fromEntries(state.scripts.erga.metadata.bindings.map((b) => [b.name, b])).CONTROL.service).toBe("erga-control");
});
