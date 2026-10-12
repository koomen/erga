// The Source page (/admin/source) updates live, with no reload: a push to staging adds its row, and the staging
// column follows its deploy (the mock builder, ERGA_DEPLOY_MOCK); a merge turns the dots green and starts production's
// deploy. The scroll and the open log stay as they were.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../fixtures";

const own = () => servers.of("source-live", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } });
await own();
test("a push, its deploy and a merge show on the open Source page without a reload", { timeout: 60_000 }, async ({ tab }) => {
  const server = await own(), { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const classOf = (sel: string) => page.evaluate((s) => document.querySelector(s)?.className ?? "", sel);
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(await (await fetch(`${server.root}/tokens/new`, { method: "POST", headers: { Origin: server.root }, body: new URLSearchParams({ label: "Source live", scope: "admin" }) })).text())?.[1];
  expect(token).toBeTruthy();
  const repo = join(server.scratch, `source-live-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remote = `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`;
  git("init", "-q", "-b", "staging");
  for (let i = 1; i <= 30; i++) git("commit", "-q", "--allow-empty", "-m", `Older commit ${i}`);
  git("push", "-q", remote, "HEAD:staging");

  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${server.root}/admin/source`);
  await expect.poll(() => text("#grid .row"), { timeout: 10_000 }).toContain("Older commit 30");
  // A marker that a reload would lose, and a scroll that must stay.
  await page.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });
  const scroller = await page.evaluate(() => { const s = document.scrollingElement!; s.scrollTop = 200; return s.scrollTop; });
  expect(scroller).toBeGreaterThan(0);

  // A push: its row comes at the top, and its deploy shows in the staging column, then ends (the mock fails it).
  git("commit", "-q", "--allow-empty", "-m", "Live push [mock-fail]");
  const sha = git("rev-parse", "HEAD");
  git("push", "-q", remote, "HEAD:staging");
  const row = `#grid .row[data-sha="${sha}"]`, stagingDep = `${row} .deps[data-target="staging"] .dep`;
  await expect.poll(() => text(row), { timeout: 10_000 }).toContain("Live push");
  await expect.poll(() => classOf(stagingDep), { timeout: 15_000 }).toContain("failed");
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(scroller);

  // The deploy's log opens, live.
  await page.click(stagingDep);
  await expect.poll(() => text("#log-lines"), { timeout: 10_000 }).toContain("build");
  await page.click("#log-close");

  // A merge (as another tab, or an agent, makes it): the dots turn green, and production's column shows its deploy.
  const merged = await fetch(`${server.root}/api/source/merge`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main" }) });
  expect(merged.status, await merged.clone().text()).toBe(200);
  await expect.poll(() => classOf(`${row} .dot`), { timeout: 10_000 }).toContain("on-main");
  await expect.poll(() => classOf(`${row} .deps[data-target="production"] .dep`), { timeout: 15_000 }).toContain("dep");
  await expect.poll(() => page.evaluate(() => (document.getElementById("merge-row") as HTMLElement).hidden)).toBe(true);

  expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1);
});
