// The Ops page's feature branches (control/source/features.ts): a push of another branch shows as a row above the git
// log, with how far it is from staging and that it merges cleanly; Merge opens the dialog with the squash message,
// and its commit lands on staging as one row of the log; Delete drops a branch. All with no reload. The dialog closes
// at once, and the branch's row says what runs, then how it ended (another page open, and a reload, show it too).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";

const own = () => servers.of("source-branches", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } });
await own();
test("a feature branch shows above the git log; Merge squashes it onto staging, Delete drops one", { timeout: 60_000 }, async ({ tab }) => {
  const server = await own(),
    { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const token = (await newToken(server.root, { label: "Feature branches", scope: "admin" })).token;
  const repo = join(server.scratch, `source-branches-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remote = `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`;
  git("init", "-q", "-b", "staging");
  git("commit", "-q", "--allow-empty", "-m", "Base on staging");
  git("push", "-q", remote, "HEAD:staging");

  await page.goto(`${server.root}/admin/ops`);
  await expect.poll(() => text("#feature-list"), { timeout: 10_000 }).toContain("No feature branches");

  // Two pushes of feature branches: rows come with no reload.
  git("checkout", "-q", "-b", "work");
  const step = (file: string, message: string) => {
    writeFileSync(join(repo, file), `${message}\n`);
    git("add", file);
    git("commit", "-q", "-m", message);
  };
  step("one.txt", "First step of the work");
  step("two.txt", "Second step of the work");
  git("push", "-q", remote, "HEAD:big-work");
  git("push", "-q", remote, "HEAD~1:refs/heads/throwaway");
  const row = (name: string) => `#feature-list .feature[data-branch="${name}"]`;
  await expect.poll(() => text(row("big-work")), { timeout: 10_000 }).toContain("Merges cleanly");
  expect(await text(row("big-work"))).toContain("2 commits ahead · 0 behind staging");
  expect(await text(row("big-work"))).toContain("Second step of the work");

  // Merge: the dialog holds the branch's message; the admin writes their own.
  const other = await page.context().newPage();
  await other.goto(`${server.root}/admin/ops`);
  await expect
    .poll(() => other.evaluate((s) => document.querySelector(s)?.textContent ?? "", row("big-work")), { timeout: 10_000 })
    .toContain("Merges cleanly");
  await page.click(`${row("big-work")} button[data-feature-merge]`);
  await expect.poll(() => page.evaluate(() => (document.getElementById("feature-dlg") as HTMLDialogElement).open)).toBe(true);
  expect(await page.inputValue("#feature-message")).toBe(
    "Second step of the work\n\nThe branch big-work, 2 commits:\n- Second step of the work\n- First step of the work"
  );
  await page.fill("#feature-message", "The big work, as one commit");
  // The merge takes seconds on the real server: the call waits here until the test lets it go.
  let letGo = () => {};
  const held = new Promise<void>((ok) => (letGo = ok));
  await page.route("**/api/tools/merge_feature_branch", async (route) => {
    await held;
    await route.continue();
  });
  await page.click("#feature-go");
  // At once: the dialog is gone, and the row says the merge runs.
  expect(await page.evaluate(() => (document.getElementById("feature-dlg") as HTMLDialogElement).open)).toBe(false);
  expect(await text(row("big-work"))).toContain("Merging into staging");
  expect(await page.locator(`${row("big-work")} button[data-feature-merge]`).isDisabled()).toBe(true);
  letGo();
  // Then the row says where the commit is, on this page and on another one open.
  await expect.poll(() => text(row("big-work")), { timeout: 10_000 }).toMatch(/Merged into staging as [0-9a-f]{7}/);
  await expect.poll(() => text("#grid .row"), { timeout: 10_000 }).toContain("The big work, as one commit");
  const merged = /as ([0-9a-f]{7})/.exec(await text(row("big-work")))![1];
  expect(await text("#grid")).toContain(merged);
  await expect
    .poll(() => other.evaluate((s) => document.querySelector(s)?.textContent ?? "", row("big-work")), { timeout: 10_000 })
    .toContain(`Merged into staging as ${merged}`);
  // A reload keeps it.
  await page.reload();
  await expect.poll(() => text(row("big-work")), { timeout: 10_000 }).toContain(`Merged into staging as ${merged}`);
  // The log holds one commit for the branch, not its two.
  expect(await text("#grid")).not.toContain("First step of the work");

  // A merge that fails says why in its row, and Merge is there again.
  git("push", "-q", remote, "HEAD:again");
  await expect.poll(() => text(row("again")), { timeout: 10_000 }).toContain("Merges cleanly");
  await page.route("**/api/tools/merge_feature_branch", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Staging moved: try again." }) })
  );
  await page.click(`${row("again")} button[data-feature-merge]`);
  await page.click("#feature-go");
  expect(await page.evaluate(() => (document.getElementById("feature-dlg") as HTMLDialogElement).open)).toBe(false);
  await expect.poll(() => text(row("again"))).toContain("Couldn't merge: Staging moved: try again.");
  expect(await page.locator(`${row("again")} button[data-feature-merge]`).isDisabled()).toBe(false);
  await page.unroute("**/api/tools/merge_feature_branch");

  // Delete: the row says so at once, then the branch goes.
  let letDelete = () => {};
  const deleting = new Promise<void>((ok) => (letDelete = ok));
  await page.route("**/api/tools/delete_feature_branch", async (route) => {
    await deleting;
    await route.continue();
  });
  await page.click(`${row("throwaway")} button[data-feature-delete]`);
  expect(await text(row("throwaway"))).toContain("Deleting");
  letDelete();
  await expect.poll(() => text(row("throwaway")), { timeout: 10_000 }).toContain("Deleted. It was at");
  expect(git("ls-remote", remote, "refs/heads/throwaway")).toBe("");
});
