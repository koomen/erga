// The Ops page (/admin/ops): the commit log's header row stays in sight as the page scrolls, just under the glass
// bars (--bars-bottom, client/inline/bars.css). Before, it stuck at the window's top, under the bars.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";

const own = () => servers.of("source-sticky", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } });
await own();
test("the commit log's header sticks under the bars, at desktop and phone width", { timeout: 60_000 }, async ({ tab }) => {
  const server = await own(),
    { page } = tab;
  const token = (await newToken(server.root, { label: "Source sticky", scope: "admin" })).token;
  expect(token).toBeTruthy();
  const repo = join(server.scratch, `source-sticky-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "staging");
  for (let i = 1; i <= 30; i++) git("commit", "-q", "--allow-empty", "-m", `Sticky commit ${i}`);
  git("push", "-q", `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`, "HEAD:staging");

  for (const [width, height] of [
    [1200, 460],
    [390, 520],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${server.root}/admin/ops`);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll("#grid .row").length), { timeout: 10_000 }).toBeGreaterThan(12);
    // (The log shows 15 rows and a break when staging is far ahead.) Scroll until its first rows have gone up past the
    // bars: the header must have stuck.
    await page.evaluate(() => {
      const grid = document.getElementById("grid")!;
      window.scrollTo(0, grid.getBoundingClientRect().top + window.scrollY + 200);
    });
    const place = () =>
      page.evaluate(() => {
        const bottom = (el: Element) => el.getBoundingClientRect().bottom;
        const bars = Math.max(...[...document.querySelectorAll(".erga-bar")].map(bottom));
        const head = document.querySelector("#grid > .head")!.getBoundingClientRect();
        const grid = document.getElementById("grid")!.getBoundingClientRect();
        return { bars: Math.round(bars), head: Math.round(head.top), gridGone: grid.top < 0 };
      });
    await expect.poll(async () => (await place()).gridGone).toBe(true);
    const p = await place();
    expect(p.head, `at ${width}px the header's top (${p.head}) is above the bars' bottom (${p.bars})`).toBeGreaterThanOrEqual(p.bars);
    expect(p.head - p.bars, `at ${width}px the header sticks ${p.head - p.bars}px below the bars`).toBeLessThanOrEqual(12);
    if (process.env.ERGA_SHOTS) await page.screenshot({ path: join(process.env.ERGA_SHOTS, `ops-sticky-${width}.png`) });
  }
});
