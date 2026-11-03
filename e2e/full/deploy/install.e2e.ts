// /deploy, the install page, end to end against the pretend Cloudflare (ERGA_DEPLOY_MOCK): Authorize with Cloudflare
// (the consent through /install/callback), where it goes, sign-in and the agent (nothing to make or paste: Erga's GitHub
// App, through this server), the install itself (the app and its control Worker), the consent handed to the control
// Worker (no second consent), and what the page says at the end. An install that stops goes on with Try again, after
// a reload, with the same fork; with a pasted API token, the control Worker's consent is the one step left.
import type { Page } from "playwright-core";
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
  const steps = await page.evaluate(() =>
    [...document.querySelectorAll("#progress li")].map((li) => `${li.getAttribute("data-id")}:${li.className}`)
  );
  expect(steps).toEqual([
    "account:done",
    "database:done",
    "migrations:done",
    "control:done",
    "assets:done",
    "worker:done",
    "address:done",
    "pages:done",
    "live:done",
    "control-live:done",
    "credential:done",
  ]);
  // Done: no Try again (it showed after every install before: .row's display beat [hidden]).
  expect(await page.isVisible("#retry")).toBe(false);
  // The consent went on to the control Worker: nothing more to do, and the grant isn't given back.
  expect(await text("#kept-up")).toContain("It keeps itself up to date");
  expect(await text("#live")).not.toContain("/install");
  // On workers.dev: the way to a domain of their own, later.
  expect(await text("#own-domain")).toContain("+ Add domain");
  // What the pretend Cloudflare was asked for: both Workers; the control Worker told its upstream, its target and Erga's GitHub App;
  // the app told to sign people in through upstream.
  const state = await mockState(page);
  expect(state.calls).toContain(`PUT /accounts/${state.account.id}/workers/scripts/erga-control/secrets`);
  expect(state.revoked).toBe(0);
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

/** What the pretend Cloudflare of this browser's deploy session was asked to do. */
type Bindings = { metadata: { bindings: { name: string; text?: string; service?: string }[] } };
async function mockState(page: Page) {
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  return (await (await fetch(`${(await own()).root}/deploy/api/mock`, { headers: { cookie } })).json()) as {
    account: { id: string };
    calls: string[];
    revoked: number;
    scripts: Record<string, Bindings>;
    kept: Record<string, { script: Bindings }[]>;
  };
}

test("an install that stops goes on with Try again after a reload; with an API token, one step is left", { timeout: 90_000 }, async ({
  tab,
}) => {
  const server = await own(),
    { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  await page.goto(`${server.root}/deploy`);
  // An API token whose account fails the upload of its files once (mock-once-assets).
  await page.click("#token-details summary");
  await page.fill("#token", "mock-once-assets");
  await page.click("#connect");
  await expect.poll(() => text("#sum-connect"), { timeout: 10_000 }).toContain("Connected with an API token");
  await page.click("#where-next");
  await page.click("#agent-next");
  await page.click("#go");
  await expect.poll(() => text("#run-error"), { timeout: 60_000 }).toContain("Stopped at");
  // A reload keeps the stopped install, and Try again finishes it.
  await page.reload();
  await expect.poll(() => text("#run-error"), { timeout: 10_000 }).toContain("Stopped at");
  await page.click("#retry");
  await expect.poll(() => text("#live h3"), { timeout: 60_000 }).toBe("Your Erga is live");
  // A token can't go on to the control Worker: its consent is the one step left.
  const steps = await page.evaluate(() =>
    [...document.querySelectorAll("#progress li")].map((li) => `${li.getAttribute("data-id")}:${li.className}`)
  );
  expect(steps.at(-1)).toBe("credential:skipped");
  expect(await text("#kept-up")).toContain("One more step");
  // Both tries gave the control Worker the same fork: Try again made no second one.
  const state = await mockState(page);
  const forks = state.kept["erga-control"].map((v) => JSON.parse(v.script.metadata.bindings.find((b) => b.name == "INSTALL")!.text!).fork);
  expect(forks.length).toBeGreaterThan(1);
  expect(new Set(forks).size).toBe(1);
});
