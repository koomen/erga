// A deploy that fails at a step (tests/deploy.ts): with a pasted token, on workers.dev; it says at which step and what
// Cloudflare said, offers to try again, and keeps the token for that.
import { expect, test } from "../fixtures";
import { openDeploy, servers } from "./deploy";

test.beforeAll(async () => { await servers.mock(); });

test("a pasted token connects; a failed step says why, plainly, and offers to try again", { timeout: 20_000 /* a deploy against the mock up to its failure: a few seconds, more on a loaded machine */ }, async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root, 1000), page = tab.page;
  await p.click("#token-details summary");
  await p.click("#with-registrar");
  expect(await page.evaluate(() => (document.getElementById("token-link") as HTMLAnchorElement).href)).toContain("registrar");
  await p.fill("token", "mock-fail-worker");
  await p.click("#connect");
  await expect.poll(() => p.current(), { timeout: 10_000 }).toBe("where");
  await p.click("#where-next");
  await p.fill("gh-id", "Ov23liMockClientId");
  await p.fill("gh-secret", "0123456789abcdef0123456789abcdef01234567");
  await p.click("#github-next");
  await p.click("#go");
  await expect.poll(() => p.text("#run-error"), { timeout: 15_000 }).not.toBe("");
  expect(await p.text("#run-error")).toMatch(/^Stopped at “Upload the Worker, with its settings and secrets”\. Cloudflare had a problem on its side while we tried to upload the Worker \(Cloudflare said: An unknown error has occurred \[code 10013\]\)/);
  expect(await page.evaluate(() => (document.querySelector("#progress li.failed") as HTMLElement | null)?.dataset.id == "worker" && !document.getElementById("run-actions")!.hidden)).toBe(true);
  expect((await p.session()).connected, "the token is kept to try again").toBe(true);
});
