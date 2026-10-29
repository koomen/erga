// The Ops page fixes a dead Cloudflare credential in place: with no grant, a push waits and the Cloudflare card offers
// Connect Cloudflare; with a grant Cloudflare refuses (its refresh answered 400), the card shows Cloudflare's own words
// and the failed deploy offers Retry. Connect Cloudflare runs the pretend consent in a popup, the card turns connected,
// and Retry deploys staging, all on the same page: no navigation, no reload, no link to /install.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { postForm } from "../../helpers/form-post";

const own = () => servers.of("ops-credential", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging", CLOUDFLARE_OAUTH_CLIENT_ID: "mock-client" } });
await own();
test("a dead credential: Connect Cloudflare in a popup, then Retry, on the Ops page itself", { timeout: 90_000 }, async ({ tab }) => {
  const server = await own(), { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const shown = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s);
      return !!el && !el.hidden && el.offsetParent != null;
    }, sel);
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(
    (await postForm(server.root, "/tokens/new", { label: "Ops credential", scope: "admin" })).page
  )?.[1];
  expect(token).toBeTruthy();
  const repo = join(server.scratch, `ops-credential-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "staging");
  git("commit", "-q", "--allow-empty", "-m", "A commit that waits for Cloudflare");
  git("push", "-q", `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`, "HEAD:staging");
  const sha = git("rev-parse", "HEAD");

  // No grant at all: the push waits, and the card offers Connect Cloudflare.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${server.root}/admin/ops`);
  await expect.poll(() => text("#env-staging .st"), { timeout: 15_000 }).toContain(`waiting to deploy ${sha.slice(0, 7)}`);
  await expect.poll(() => shown("#cloudflare-connect")).toBe(true);
  expect(await text("#cloudflare-connect")).toBe("Connect Cloudflare");
  expect(await page.evaluate(() => document.querySelector('#env-cloudflare a[href*="install"]'))).toBeNull();
  // A marker that a navigation or a reload would lose.
  await page.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });
  const at = page.url();

  // A grant Cloudflare refuses (as one revoked on its dashboard): the waiting deploy goes, its refresh is refused, and
  // the card says so in Cloudflare's words, with the button; staging's card offers Retry.
  const start = await fetch(`${server.root}/install/start?popup=1`, { redirect: "manual" });
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const dead = await fetch(`${server.root}/install/callback?code=mock-code-dead&state=${state}`, { headers: { cookie } });
  expect(dead.status).toBe(200);
  await expect.poll(() => text("#cloudflare-why"), { timeout: 20_000 }).toBe("Cloudflare said: 400 invalid_grant: refresh token revoked or unknown");
  expect(await text("#cloudflare-state")).toBe("Nothing deploys: Cloudflare refused the grant.");
  expect(await text("#cloudflare-connect")).toBe("Connect Cloudflare again");
  await expect.poll(() => text("#env-staging .st")).toContain("failed");
  await expect.poll(() => shown('#env-staging button[data-retry="staging"]')).toBe(true);

  // Connect Cloudflare: the pretend consent in a popup; the popup tells the page and closes; the card turns connected.
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#cloudflare-connect")]);
  await expect.poll(() => text("#cloudflare-note")).toContain("Waiting for Cloudflare");
  await popup.waitForSelector("#authorize");
  await popup.click("#authorize");
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => text("#cloudflare-note"), { timeout: 10_000 }).toContain("Connected.");
  await expect.poll(() => text("#cloudflare-state")).toBe("connected by tester");
  expect(await shown("#cloudflare-connect")).toBe(false);
  expect(await shown("#cloudflare-why")).toBe(false);

  // Retry, in staging's card: it deploys, and staging is live on the commit.
  await page.click('#env-staging button[data-retry="staging"]');
  await expect.poll(() => text("#env-staging .st"), { timeout: 30_000 }).toContain("live");
  expect(await text("#env-staging .env-commit")).toBe(sha.slice(0, 7));
  expect(await shown('#env-staging button[data-retry="staging"]')).toBe(false);

  // All on the same page: no navigation, no reload.
  expect(page.url()).toBe(at);
  expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1);
});
