// The Ops page's Git Repository cards (Clone and push; Branches and releases): at Pete's desktop width (920) and
// at phone width (390), Merge and Cut release stay inside their card, and the clone address shows whole or scrolls
// inside its box. The state line comes before the buttons, and Merge (the main action) comes first.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";

const own = () => servers.of("source-repo-tools", { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } });
await own();
test("Merge and Cut release stay inside their card at 920 and 390 px", { timeout: 60_000 }, async ({ tab }) => {
  const server = await own(),
    { page } = tab;
  const token = (await newToken(server.root, { label: "Repo tools", scope: "admin" })).token;
  const repo = join(server.scratch, `repo-tools-${Date.now()}`);
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const remote = `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`;
  const tool = async (name: string, body: object) => {
    const r = await fetch(`${server.root}/api/tools/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };
  git("init", "-q", "-b", "staging");
  git("commit", "-q", "--allow-empty", "-m", "First");
  git("push", "-q", remote, "HEAD:staging");
  await tool("deploy_production", {});
  await tool("cut_release", { version: "v0.1.0", notes: "First" });

  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  /** Each visible button's and code box's overflow out of the card, in px (0 when inside), and the order of the parts. */
  const layout = () =>
    page.evaluate(() => {
      const card = document.querySelector("#repo .box.actions")!.getBoundingClientRect();
      const out = (el: Element) => {
        const r = el.getBoundingClientRect();
        return Math.max(0, Math.round(r.right - card.right), Math.round(card.left - r.left));
      };
      const pre = document.querySelector("#clone pre") as HTMLElement,
        clone = document.getElementById("clone")!.getBoundingClientRect();
      const top = (id: string) => document.getElementById(id)!.getBoundingClientRect().top;
      const left = (id: string) => document.getElementById(id)!.getBoundingClientRect().left;
      return {
        merge: out(document.getElementById("merge")!),
        release: out(document.getElementById("release-pill")!),
        // The clone box stays inside its card; its lines scroll inside it (or wrap).
        pre: Math.max(0, Math.round(pre.getBoundingClientRect().right - clone.right)),
        scrolls: pre.scrollWidth <= pre.clientWidth || getComputedStyle(pre).overflowX == "auto",
        stateAbove: top("ahead") < top("merge"),
        mergeFirst: left("merge") < left("release-pill") || top("merge") < top("release-pill"),
      };
    });
  const want = { merge: 0, release: 0, pre: 0, scrolls: true, stateAbove: true, mergeFirst: true };

  await page.setViewportSize({ width: 920, height: 900 });
  await page.goto(`${server.root}/admin/ops`);
  // The agent's panel closed, as Pete has it: the page takes the window's width.
  await page.evaluate(() => (window as unknown as { ergaAgent?: { show(open: boolean): void } }).ergaAgent?.show(false));
  await expect.poll(() => text("#ahead"), { timeout: 10_000 }).toBe("staging and production are the same");
  await expect.poll(() => text("#release-state")).toBe("Stable release: v0.1.0");
  expect(await layout()).toEqual(want);
  // Merge has nothing to do: it is off, and its tip says why.
  expect(
    await page.evaluate(() => {
      const b = document.getElementById("merge") as HTMLButtonElement;
      return { off: b.disabled, tip: b.title };
    })
  ).toEqual({ off: true, tip: expect.stringContaining("Nothing to merge") });
  // The clone address can be copied whole.
  expect(await page.evaluate(() => document.querySelector<HTMLElement>("#clone [data-copy]")?.dataset.copy ?? "")).toContain(
    `${server.root.replace(/\/$/, "")}/git/erga.git`
  );

  // A push: staging is one commit ahead, and Merge comes on.
  git("commit", "-q", "--allow-empty", "-m", "Second");
  git("push", "-q", remote, "HEAD:staging");
  await expect.poll(() => text("#ahead"), { timeout: 10_000 }).toBe("staging is 1 commit ahead of production");
  expect(await page.evaluate(() => (document.getElementById("merge") as HTMLButtonElement).disabled)).toBe(false);
  expect(await layout()).toEqual(want);

  // 1000: the two cards side by side, at their narrowest. 390: a phone.
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(layout).toEqual(want);
  }
});
