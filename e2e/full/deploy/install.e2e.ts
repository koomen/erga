// /deploy, the install page, end to end against the pretend Cloudflare (ERGA_DEPLOY_MOCK): Authorize with Cloudflare
// (the consent through /install/callback), where it goes, sign-in and the agent (nothing to make or paste: Erga's GitHub
// App, through this server), the install itself (the app and its control Worker), and what the page says at the end.
import { expect, servers, test } from "../../helpers/fixtures";

const own = () => servers.of("deploy-install", { env: { ERGA_DEPLOY_MOCK: "1" } });
await own();
test("an install from the page: consent, where, the agent, both Workers, and the next step", { timeout: 90_000 }, async ({ tab }) => {
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
  await expect.poll(() => text("#sum-where")).toContain("erga.ada-mock.workers.dev · pages on erga-pages.ada-mock.workers.dev · control at erga-control.ada-mock.workers.dev · staging at erga-staging.ada-mock.workers.dev");
  // Sign-in needs nothing (Erga's GitHub App); the agent's key is optional.
  await expect.poll(() => page.evaluate(() => document.getElementById("s-agent")!.className)).toContain("current");
  expect(await text("#s-agent")).toContain("through Erga's own GitHub App");
  await page.click("#agent-next");
  await expect.poll(() => text("#review")).toContain("GitHub, through Erga's GitHub App");
  expect(await text("#review")).toContain("https://erga-control.ada-mock.workers.dev");
  // Install: every step, then the live box with the next step (the control Worker's consent).
  await page.click("#go");
  await expect.poll(() => text("#live h3"), { timeout: 60_000 }).toBe("Your Erga is live");
  const steps = await page.evaluate(() => [...document.querySelectorAll("#progress li")].map((li) => `${li.getAttribute("data-id")}:${li.className}`));
  expect(steps).toEqual(["account:done", "database:done", "migrations:done", "control:done", "assets:done", "worker:done", "address:done", "pages:done", "live:done", "control-live:done"]);
  expect(await text("#live")).toContain("erga-control.ada-mock.workers.dev/install");
  // What the pretend Cloudflare was asked for: both Workers; the control Worker told its upstream, its target and Erga's GitHub App;
  // the app told to sign people in through upstream.
  const state = await (await fetch(`${server.root}/deploy/api/mock`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).json() as { scripts: Record<string, { metadata: { bindings: { name: string; text?: string; service?: string }[] } }> };
  expect(Object.keys(state.scripts).sort()).toEqual(["erga", "erga-control", "erga-pages"]);
  const control = Object.fromEntries(state.scripts["erga-control"].metadata.bindings.map((b) => [b.name, b]));
  expect(control.UPSTREAM.text).toBe(server.root);
  expect(control.GITHUB_APP_CLIENT_ID.text).toBe("Iv1.mockgithubapp0");
  expect(control.GITHUB_APP_SLUG.text).toBe("erga-editor");
  expect(control.GITHUB_CLIENT_SECRET).toBeUndefined();
  expect(JSON.parse(control.INSTALL.text!).control.host).toBe("erga-control.ada-mock.workers.dev");
  const app = Object.fromEntries(state.scripts.erga.metadata.bindings.map((b) => [b.name, b]));
  expect(app.CONTROL.service).toBe("erga-control");
  expect(app.GITHUB_CLIENT_ID.text).toBe("Iv1.mockgithubapp0");
  expect(app.SIGN_IN_RELAY.text).toBe(server.root);
});
