// The Ops page (/admin/ops) shows the git log and the statuses at once, whatever else is slow: its live updates
// hold none of the browser's six HTTP/1.1 connections to the host (they come over WebSockets), and a slow request
// (the releases, the domains) holds nothing else back. Before, with a few admin tabs open, each with two event
// streams, the page's own requests waited minutes for a free connection, and the columns said "not set up".
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { postForm } from "../../helpers/form-post";

const own = () => servers.of("source-first", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } });
await own();
test("the Ops page shows the log and statuses in a second, with five connections held, no events and slow requests", {
  timeout: 60_000,
}, async ({ tab }) => {
  const server = await own(),
    { page } = tab;
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(
    (await postForm(server.root, "/tokens/new", { label: "First render", scope: "admin" })).page
  )?.[1];
  expect(token).toBeTruthy();
  const repo = join(server.scratch, `source-first-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "staging");
  for (let i = 1; i <= 3; i++) git("commit", "-q", "--allow-empty", "-m", `First render ${i}`);
  git("push", "-q", `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`, "HEAD:staging");

  // Another tab of the same browser holds five of the six connections to the host (event streams that stay open).
  const other = await page.context().newPage();
  await other.goto(`${server.root}/robots.txt`);
  await other.evaluate(() => Promise.all(Array.from({ length: 5 }, () => new Promise((ok) => { new EventSource("/api/events").onopen = ok; }))));
  // The events never come, and two of the page's requests are slow: the first render waits on none of them.
  await page.routeWebSocket("**/api/events", () => {});
  for (const slow of ["**/api/releases", "**/api/domains"]) await page.route(slow, async (route) => { await new Promise((ok) => setTimeout(ok, 10_000)); await route.continue().catch(() => {}); });

  await page.setViewportSize({ width: 1200, height: 700 });
  const started = Date.now();
  await page.goto(`${server.root}/admin/ops`, { waitUntil: "commit" });
  const shown = () => page.evaluate(() => ({
    rows: document.querySelectorAll("#grid .row").length,
    staging: document.querySelector("#target-staging .st span")?.textContent ?? "",
  }));
  // Until the statuses come, the column says it is loading ("…"), never "not set up".
  await expect.poll(async () => { const s = await shown(); return s.rows > 0 && !["", "…", "not set up"].includes(s.staging); }, { timeout: 3_000, interval: 50 }).toBe(true);
  const took = Date.now() - started;
  expect(took, `the log and statuses took ${took} ms`).toBeLessThan(2_500);

  // The open Ops page (and its agent panel) holds no connection: the sixth is still free for the other tab.
  const answer = await other.evaluate(async () => {
    const r = await fetch("/api/deploys", { signal: AbortSignal.timeout(3_000) }).catch(() => null);
    return r?.status ?? "no answer in 3 s";
  });
  expect(answer).toBe(200);
  await other.close();
});
