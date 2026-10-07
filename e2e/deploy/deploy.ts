// Helpers for /deploy's tests (deploy/page.ts, worker/deploy.ts) on a dev server whose Cloudflare is pretend
// (servers.mock: ERGA_DEPLOY_MOCK=1, deploy/mock.ts). Each browser's deploy session, and the mock Cloudflare it talks
// to, is its own (worker/deployer.ts), so each test's fresh browser context starts from nothing.

import { expect, servers, type Page } from "../fixtures";

export { servers };

export function deployPage(page: Page) {
  const p = {
    page,
    /** Sets an input's value as typing would. */
    fill: (id: string, value: string) => page.evaluate(({ id, value }) => { const el = document.getElementById(id) as HTMLInputElement; el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); return true; }, { id, value }),
    click: (selector: string) => page.evaluate((selector) => { const el = document.querySelector(selector) as HTMLElement | null; if (!el) throw new Error("no " + selector); el.click(); return true; }, selector),
    text: (selector: string) => page.evaluate((selector) => document.querySelector(selector)?.textContent ?? "", selector),
    /** The step being worked on. */
    current: () => page.evaluate(() => (document.querySelector(".step.current") as HTMLElement | null)?.dataset.step ?? ""),
    /** What the mock Cloudflare was asked to do. */
    mock: () => page.evaluate(() => fetch("/deploy/api/mock").then((r) => r.json())) as Promise<any>,
    session: () => page.evaluate(() => fetch("/deploy/api/session").then((r) => r.json())) as Promise<any>,
    /** Connects with (pretend) Cloudflare's OAuth: the bounce to its consent page, Authorize, and back, on to where it goes. */
    async oauth() {
      await p.click("#oauth");
      await expect.poll(() => page.evaluate(() => location.pathname == "/deploy/mock/consent" && !!document.getElementById("authorize"))).toBe(true);
      const scopes = await p.text(".scopes");
      await p.click("#authorize");
      await expect.poll(async () => (await page.evaluate(() => location.pathname)) == "/deploy" && await p.current(), { timeout: 10_000 }).toBe("where");
      return scopes;
    },
    /** Searches for `q`, and buys `q`.com after confirming its price: it becomes the app's domain. */
    async buy(q: string) {
      await p.click("#buy summary");
      await p.fill("q", q);
      await p.click("#search");
      await expect.poll(() => page.evaluate(() => document.querySelectorAll("#offers li").length)).toBe(4);
      await p.click("[data-buy='0']");
      await expect.poll(() => page.evaluate(() => (document.getElementById("confirm-buy") as HTMLDialogElement).open)).toBe(true);
      await p.click("#buy-ok");
      await p.click("#buy-go");
      await expect.poll(() => p.text("#offers")).toContain("Registered");
    },
  };
  return p;
}

/** /deploy, signed in as DEV_LOGIN (an admin), in `page`. */
export async function openDeploy(page: Page, root: string, height = 1100) {
  await page.setViewportSize({ width: 1000, height });
  await page.goto(`${root}/auth/github?next=/deploy`);
  await expect.poll(() => page.evaluate(() => location.pathname == "/deploy" && !!document.getElementById("oauth")), { timeout: 10_000 }).toBe(true);
  return deployPage(page);
}

/** A session cookie for `login` on `root`. */
export async function signIn(root: string, login: string) {
  const r = await fetch(`${root}/auth/github?as=${login}&next=/deploy`, { redirect: "manual" });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c))!;
}
