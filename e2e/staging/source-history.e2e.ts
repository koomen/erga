// Deploy history ("Deploy history"): a push while a deploy runs cancels it; a build that fails; each
// deploy with what started it and when, one live; a past deploy's log; the page shows each beside its commit, a past
// badge opens its log, and a redeploy of a commit shows once, the newest; the badges are plain text.
import { expect, servers, test, until } from "../fixtures";
import { logText, openSource, sourceState } from "./source-page";
import { admin, commit, DEPLOY_MS, level, must, settled, target } from "./staging";

await servers.staging();

type Deploy = { id: string; commit: string; state: string; trigger: string; replacedBy?: string; live: boolean; started: number; ended: number };
const history = async (root: string, q = "") => ((await (await fetch(`${root}/api/deploys/staging/history${q}`)).json()) as { deploys: Deploy[] }).deploys;

test("a push while a deploy runs cancels it, the newer one fails to build; the history, a past log, and the page's badges", { timeout: 4 * DEPLOY_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.staging(), a = await admin(s), page = tab.page;
  const { head: good, dir } = await level(s, a, "Last good deploy");
  await settled(s, "staging");
  const superseded = commit(dir, "app.ts", `export const x = "${crypto.randomUUID()}";\n`, "Superseded");
  must(dir, "push", "-q", "origin", "HEAD:staging");
  await until(async () => { const t = await target(s, "staging"); return t.commit == superseded && ["building", "deploying"].includes(t.state); }, DEPLOY_MS, "its deploy starts");
  const failing = commit(dir, "app.ts", `export const x = "${crypto.randomUUID()}";\n`, "Newer [mock-fail]");
  must(dir, "push", "-q", "origin", "HEAD:staging");
  await until(async () => { const t = await target(s, "staging"); return t.commit == failing && t.state == "failed"; }, DEPLOY_MS, "the newer one runs, and fails to build");
  const [failed, cancelled] = await history(s.root, "?limit=50");
  expect([failed.commit, failed.state, cancelled.commit, cancelled.state, cancelled.replacedBy]).toEqual([failing, "failed", superseded, "cancelled", failed.id]);
  expect(cancelled.trigger).toBe("push by tester, via a shared agent (Git)");
  expect(cancelled.ended).toBeGreaterThanOrEqual(cancelled.started);
  const all = await history(s.root, "?limit=50");
  expect(all.filter((d) => d.live).map((d) => d.commit), "one live: the last that worked").toEqual([good]);
  const past = (await (await fetch(`${s.root}/api/deploys/staging/log?deploy=${cancelled.id}`)).json()) as { deployId: string; state: string; lines: { text: string }[] };
  expect([past.deployId, past.state]).toEqual([cancelled.id, "cancelled"]);
  expect(past.lines.some((l) => l.text.startsWith("cancelled:"))).toBe(true);
  expect((await fetch(`${s.root}/api/deploys/staging/log?deploy=nope`)).status).toBe(404);
  const some = (await (await fetch(`${s.root}/api/deploys?history=3`)).json()) as { targets: { name: string; history: unknown[] }[] };
  expect(some.targets.every((t) => Array.isArray(t.history) && t.history.length <= 3)).toBe(true);
  expect(some.targets.find((t) => t.name == "production")!.history.length).toBeGreaterThan(0);

  tab.strict = true;
  await openSource(page, s.root);
  await expect.poll(async () => { const r = (await sourceState(page)).rows; return [r.find((x) => x.sha == superseded)?.live[0], r.find((x) => x.sha == failing)?.live[0]]; }).toEqual(["cancelled", "failed"]);
  await page.locator(`#grid .row[data-sha="${superseded}"] button.dep`).click();
  await expect.poll(() => logText(page)).toContain("cancelled:");
  expect(await page.locator("#log-meta").textContent()).toContain("cancelled");
  await page.locator("#log-close").click();

  // Two deploys of one commit: the page shows one, the newest (the history keeps both).
  await fetch(`${s.root}/api/deploys/staging`, { method: "POST", headers: { Origin: s.root } });
  await until(async () => (await target(s, "staging")).state == "failed" && (await history(s.root)).filter((d) => d.commit == failing).length == 2, DEPLOY_MS, "a redeploy of the same commit");
  const newest = (await history(s.root))[0].id;
  await expect.poll(() => page.evaluate(({ failing, newest }) => { const b = document.querySelectorAll(`#grid .row[data-sha="${failing}"] .deps[data-target=staging] .dep`); return b.length == 1 && (b[0] as HTMLElement).dataset.deploy == newest; }, { failing, newest })).toBe(true);
  // Plain text: no pills; only the live deploy has a background, a small-radius rectangle.
  const looks = await page.evaluate(() => [...document.querySelectorAll("#grid .dep")].map((d) => { const c = getComputedStyle(d); return { state: d.className, radius: c.borderTopLeftRadius, bg: c.backgroundColor, border: c.borderTopStyle }; }));
  expect(looks.every((l) => parseFloat(l.radius) <= 6 && l.border == "none"), JSON.stringify(looks)).toBe(true);
  expect(looks.every((l) => l.state.includes("live") == (l.bg != "rgba(0, 0, 0, 0)")), JSON.stringify(looks)).toBe(true);
  expect(await page.evaluate(() => !!document.querySelector("#grid .more, #grid .sub")), "no counts, nothing to open").toBe(false);
});
