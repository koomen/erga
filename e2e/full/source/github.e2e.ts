// GitHub on the Ops page, end to end against the pretend GitHub the dev server serves (dev/github-mock.ts): the
// card says nothing is connected; Connect GitHub opens GitHub's authorize page in a popup, then the App's install page; Install comes back
// through the callback, the popup tells the page and closes, and the card turns connected, in place. A push to the
// repository on GitHub comes back through the webhook: the log shows the commit, the card says who pushed. Sync
// now, then Disconnect, in place too. The page's screenshot, for the report: ERGA_SHOTS names the folder.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";

const own = () => servers.of("ops-github", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging", ERGA_GITHUB_REPOS: "ada/erga" } });
await own();
test("Connect GitHub in a popup, a push on GitHub synced back, Sync now and Disconnect, all on the Ops page", { timeout: 90_000 }, async ({ tab }) => {
  const server = await own(), { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const shown = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s);
      return !!el && !el.hidden && el.offsetParent != null;
    }, sel);
  const token = (await newToken(server.root, { label: "Ops GitHub", scope: "admin" })).token;
  expect(token).toBeTruthy();
  const gitIn = (dir: string) => (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // Erga's repository: two commits on staging and main.
  const repo = join(server.scratch, `ops-github-${Date.now()}`); mkdirSync(repo);
  const g = gitIn(repo);
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n"); g("add", "."); g("commit", "-qm", "First");
  writeFileSync(join(repo, "b.txt"), "two\n"); g("add", "."); g("commit", "-qm", "Second");
  const erga = `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`;
  g("push", "-q", erga, "HEAD:staging", "HEAD:main");

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${server.root}/admin/ops`);
  await expect.poll(() => text("#grid .row"), { timeout: 15_000 }).toContain("Second");
  // Nothing connected: the card says so, with Connect GitHub, and no link to another page.
  await expect.poll(() => text("#github-state")).toBe("not connected");
  expect(await shown("#github-connect")).toBe(true);
  expect(await text("#github-connect")).toBe("Connect GitHub");
  expect(await text("#github-why")).toContain("Connect a repository on GitHub");
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#env-github a[href]")].filter((a) => !a.hidden).length)).toBe(0);
  await page.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });

  // Connect: the pretend GitHub's authorize page in a popup, then its install page (no installation yet); Install; the
  // popup tells the page and closes; the card turns connected.
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#github-connect")]);
  await popup.waitForLoadState();
  await expect.poll(() => popup.evaluate(() => document.body.innerText)).toContain("Authorize erga-editor");
  await popup.click("#authorize");
  await expect.poll(() => popup.evaluate(() => document.querySelector("h1")?.textContent ?? "")).toContain("Install erga-editor");
  expect(await popup.evaluate(() => [...document.querySelectorAll("label")].map((l) => l.textContent?.trim()))).toContain("ada/erga");
  await popup.click("#install");
  // The popup's last page tells the page and closes; if it doesn't, its text says why (an error stays, with Try again).
  const closed = await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true).then(() => true, () => false);
  if (!closed) throw new Error(`the popup stayed open: ${await popup.evaluate(() => document.body.innerText).catch(() => "?")}\n${server.output().split("\n").slice(-30).join("\n")}`);
  await expect.poll(() => text("#github-note"), { timeout: 15_000 }).toContain("Connected to ada/erga.");
  await expect.poll(() => text("#github-state"), { timeout: 15_000 }).toContain("in sync");
  expect(await text("#github-repo")).toBe("ada/erga");
  expect(await shown("#github-connect")).toBe(false);
  expect(await shown("#github-sync")).toBe(true);
  expect(await shown("#github-disconnect")).toBe(true);
  // Still the same page.
  expect(await page.evaluate(() => (window as unknown as { kept: number }).kept)).toBe(1);
  // GitHub has staging and main.
  const github = `${server.root.replace("://", "://x-access-token:erga-dev-github-token@")}/__github/ada/erga.git`;
  expect(g("ls-remote", github, "refs/heads/staging").split("\t")[0]).toBe(g("rev-parse", "HEAD"));

  // A push on GitHub's staging comes back through the webhook: the log shows it, the card says who pushed.
  const gh = join(server.scratch, `gh-${Date.now()}`); mkdirSync(gh);
  const h = gitIn(gh);
  h("clone", "-q", github, ".");
  h("checkout", "-q", "-b", "staging", "origin/staging");
  writeFileSync(join(gh, "c.txt"), "from GitHub\n"); h("add", "."); h("commit", "-qm", "Third, pushed on GitHub");
  h("push", "-q", "origin", "staging:staging");
  await expect.poll(() => text("#grid .row"), { timeout: 20_000 }).toContain("Third, pushed on GitHub");
  await expect.poll(() => text("#github-state"), { timeout: 15_000 }).toContain("via a push on GitHub");
  expect(g("ls-remote", erga, "refs/heads/staging").split("\t")[0]).toBe(h("rev-parse", "HEAD"));
  const shots = process.env.ERGA_SHOTS;
  if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, "github-ops.png"), fullPage: true }); }

  // Sync now: in place.
  await page.click("#github-sync");
  await expect.poll(() => text("#github-note"), { timeout: 15_000 }).toBe("In sync.");

  // Disconnect, two clicks: the card is back to not connected, with Connect GitHub; the page is still the same.
  await page.click("#github-disconnect");
  expect(await text("#github-disconnect")).toBe("Click again to disconnect");
  await page.click("#github-disconnect");
  await expect.poll(() => text("#github-state"), { timeout: 15_000 }).toBe("not connected");
  expect(await text("#github-note")).toContain("Disconnected");
  expect(await shown("#github-connect")).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { kept: number }).kept)).toBe(1);
});
